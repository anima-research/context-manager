import type { Membrane, NormalizedRequest, ContentBlock, CompleteOptions } from 'membrane';
import { NativeFormatter } from 'membrane';
import type {
  ContextStrategy,
  StrategyContext,
  ReadinessState,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  ContextEntry,
  StoredMessage,
  AutobiographicalConfig,
  SummaryLevel,
  SummaryEntry,
} from '../types/index.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';

/**
 * Chunk of messages to be compressed.
 */
interface Chunk {
  /** Index in the chunk list */
  index: number;
  /** Starting message index (inclusive) */
  startIndex: number;
  /** Ending message index (exclusive) */
  endIndex: number;
  /** Messages in this chunk */
  messages: StoredMessage[];
  /** Estimated token count */
  tokens: number;
  /** Whether this chunk has been compressed */
  compressed: boolean;
  /** The diary entry if compressed (legacy mode) */
  diary?: string;
  /** ID of the L1 SummaryEntry (hierarchical mode) */
  summaryId?: string;
}

/**
 * Autobiographical chunking strategy.
 * Compresses old conversation chunks into summaries in the model's own words.
 * Recent context stays untouched.
 *
 * When `hierarchical` is enabled, uses a 3-level compression pyramid:
 * L1 (raw→summary) → L2 (merge N L1s) → L3 (merge N L2s)
 * with anti-redundancy filtering and budget carryover.
 */
export class AutobiographicalStrategy implements ContextStrategy {
  readonly name = 'autobiographical';

  private config: AutobiographicalConfig;
  private chunks: Chunk[] = [];
  private pendingCompression: Promise<void> | null = null;
  private compressionQueue: number[] = [];
  private _compressionCount = 0;

  // Hierarchical state
  private summaries: SummaryEntry[] = [];
  private summaryIdCounter = 0;
  private mergeQueue: Array<{ level: SummaryLevel; sourceIds: string[] }> = [];
  private nativeFormatter = new NativeFormatter();

  constructor(config: Partial<AutobiographicalConfig> = {}) {
    this.config = { ...DEFAULT_AUTOBIOGRAPHICAL_CONFIG, ...config };
    // Hierarchical is on by default; set hierarchical: false to use legacy single-level
    this.config.hierarchical ??= true;
    if (this.config.hierarchical) {
      this.config.mergeThreshold ??= 6;
      this.config.summaryTargetTokens ??= 2000;
      this.config.l3BudgetTokens ??= 30000;
      this.config.l2BudgetTokens ??= 30000;
      this.config.l1BudgetTokens ??= 30000;
    }
  }

  /** Compression statistics for observability (e.g., TUI display). */
  getStats(): { chunksTotal: number; chunksCompressed: number; compressionCount: number } {
    return {
      chunksTotal: this.chunks.length,
      chunksCompressed: this.chunks.filter(c => c.compressed).length,
      compressionCount: this._compressionCount,
    };
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    this.rebuildChunks(ctx.messageStore);
  }

  checkReadiness(): ReadinessState {
    if (this.pendingCompression) {
      return {
        ready: false,
        pendingWork: this.pendingCompression,
        description: `Compressing chunk ${this.compressionQueue[0] ?? '?'}`,
      };
    }

    const needsCompression = this.chunks.some(
      (c) => !c.compressed && this.isChunkOldEnough(c)
    );
    const needsMerge = this.config.hierarchical && this.mergeQueue.length > 0;

    if ((needsCompression && this.compressionQueue.length > 0) || needsMerge) {
      const parts: string[] = [];
      if (this.compressionQueue.length > 0) parts.push(`${this.compressionQueue.length} chunks`);
      if (needsMerge) parts.push(`${this.mergeQueue.length} merges`);
      return {
        ready: false,
        description: `${parts.join(' + ')} pending`,
      };
    }

    return { ready: true };
  }

  async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
    this.rebuildChunks(ctx.messageStore);

    // Auto-tick: fire compression in the background so it runs without
    // the framework explicitly calling tick(). compile() will await
    // pendingCompression via checkReadiness().
    if (this.config.autoTickOnNewMessage && this.compressionQueue.length > 0 && !this.pendingCompression) {
      this.tick(ctx).catch((err) =>
        console.error('AutobiographicalStrategy: auto-tick error:', err)
      );
    }
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (this.pendingCompression) return;

    if (!ctx.membrane) {
      console.warn('AutobiographicalStrategy: No membrane instance for compression');
      return;
    }

    // Priority 1: Compress raw chunks → L1
    if (this.compressionQueue.length > 0) {
      const chunkIndex = this.compressionQueue.shift()!;
      const chunk = this.chunks[chunkIndex];

      if (!chunk || chunk.compressed) return;

      this.pendingCompression = this.config.hierarchical
        ? this.compressChunkHierarchical(chunk, ctx)
        : this.compressChunkLegacy(chunk, ctx);

      try {
        await this.pendingCompression;
      } finally {
        this.pendingCompression = null;
      }
      return;
    }

    // Priority 2: Execute pending merges (hierarchical only)
    if (this.config.hierarchical && this.mergeQueue.length > 0) {
      const merge = this.mergeQueue.shift()!;
      this.pendingCompression = this.executeMerge(merge.level, merge.sourceIds, ctx);

      try {
        await this.pendingCompression;
      } finally {
        this.pendingCompression = null;
      }
    }
  }

  select(
    store: MessageStoreView,
    log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[] {
    this.rebuildChunks(store);

    return this.config.hierarchical
      ? this.selectHierarchical(store, budget)
      : this.selectLegacy(store, log, budget);
  }

  /**
   * Get summary statistics for observability.
   */
  getStats(): { l1: number; l2: number; l3: number; compressionCount: number; pendingMerges: number } {
    return {
      l1: this.summaries.filter(s => s.level === 1 && !s.mergedInto).length,
      l2: this.summaries.filter(s => s.level === 2 && !s.mergedInto).length,
      l3: this.summaries.filter(s => s.level === 3 && !s.mergedInto).length,
      compressionCount: this.summaries.length,
      pendingMerges: this.mergeQueue.length,
    };
  }

  // ============================================================================
  // Legacy (single-level) path
  // ============================================================================

  private selectLegacy(
    store: MessageStoreView,
    _log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[] {
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    let totalTokens = 0;
    const messages = store.getAll();

    // 1. Head window: preserved verbatim as raw copies
    const headEnd = this.getHeadWindowEnd(store);
    const msgCap = this.config.maxMessageTokens;
    for (let i = 0; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(store.estimateTokens(msg), msgCap + 50) : store.estimateTokens(msg);
      if (totalTokens + tokens > maxTokens) break;

      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      totalTokens += tokens;
    }

    // 2. Middle zone: compressed chunks as diary pairs, uncompressed as raw messages.
    //    Uncompressed chunks arise when compression hasn't run yet (e.g. fresh forks).
    //    Without this fallback, messages in the gap between head and recent windows
    //    would be silently dropped.
    const rawRecentStart = this.getRecentWindowStart(store);
    let middleCoveredUpTo = headEnd; // tracks which gap messages have been emitted

    for (const chunk of this.chunks) {
      if (chunk.compressed && chunk.diary) {
        // Emit as diary pair
        const contextLabel = this.config.summaryContextLabel ?? 'Here is a summary of earlier conversation context:';
        const summaryParticipant = this.config.summaryParticipant ?? 'Summary';

        const questionEntry: ContextEntry = {
          index: entries.length,
          participant: 'Context Manager',
          content: [{ type: 'text', text: contextLabel }],
          sourceRelation: 'derived',
        };

        const answerEntry: ContextEntry = {
          index: entries.length + 1,
          participant: summaryParticipant,
          content: [{ type: 'text', text: chunk.diary }],
          sourceRelation: 'derived',
        };

        const pairTokens = this.estimateTokens(questionEntry.content) +
                           this.estimateTokens(answerEntry.content);

        if (totalTokens + pairTokens > maxTokens) break;

        entries.push(questionEntry);
        entries.push(answerEntry);
        totalTokens += pairTokens;
      } else {
        // Uncompressed: emit raw messages so they aren't lost
        for (const msg of chunk.messages) {
          const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
          const tokens = msgCap > 0 ? Math.min(store.estimateTokens(msg), msgCap + 50) : store.estimateTokens(msg);
          if (totalTokens + tokens > maxTokens) break;

          entries.push({
            index: entries.length,
            sourceMessageId: msg.id,
            sourceRelation: 'copy',
            participant: msg.participant,
            content,
          });
          totalTokens += tokens;
        }
      }
      middleCoveredUpTo = chunk.endIndex;
    }

    // Emit any gap messages not covered by chunks (remainder < 4 messages)
    for (let i = middleCoveredUpTo; i < rawRecentStart && i < messages.length; i++) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(store.estimateTokens(msg), msgCap + 50) : store.estimateTokens(msg);
      if (totalTokens + tokens > maxTokens) break;

      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      totalTokens += tokens;
    }

    // 3. Recent uncompressed messages
    // Guard: skip messages already emitted in the head window
    const recentStart = Math.max(this.getRecentWindowStart(store), headEnd);

    for (let i = recentStart; i < messages.length; i++) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(store.estimateTokens(msg), msgCap + 50) : store.estimateTokens(msg);

      if (totalTokens + tokens > maxTokens) {
        break;
      }

      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });

      totalTokens += tokens;
    }

    return entries;
  }

  private async compressChunkLegacy(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    if (!ctx.membrane) {
      throw new Error('No membrane instance for compression');
    }

    const priorContext = this.buildPriorContextLegacy(chunk, ctx);
    const chunkContent = this.formatChunkForCompression(chunk);

    const prompt = this.config.diaryUserPrompt ?? this.config.summaryUserPrompt!;
    const systemPrompt = this.config.diarySystemPrompt ?? this.config.summarySystemPrompt!;

    const messages = [
      ...priorContext,
      {
        participant: 'Context Manager',
        content: [{ type: 'text' as const, text: prompt.replace('{content}', chunkContent) }],
      },
    ];

    const request: NormalizedRequest = {
      messages: messages.map((m) => ({
        participant: m.participant,
        content: m.content,
      })),
      system: systemPrompt,
      config: {
        model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
        maxTokens: 2000,
        temperature: 0,
      },
    };

    try {
      const response = await ctx.membrane.complete(request);
      const diaryText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      chunk.compressed = true;
      chunk.diary = diaryText;
      this._compressionCount++;
    } catch (error) {
      console.error('Failed to compress chunk:', error);
      throw error;
    }
  }

  private buildPriorContextLegacy(chunk: Chunk, ctx: StrategyContext): Array<{
    participant: string;
    content: ContentBlock[];
  }> {
    const context: Array<{ participant: string; content: ContentBlock[] }> = [];

    for (const prevChunk of this.chunks) {
      if (prevChunk.index >= chunk.index) break;
      if (!prevChunk.compressed || !prevChunk.diary) continue;

      context.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: this.config.summaryContextLabel ?? 'Summary of earlier context:' }],
      });
      context.push({
        participant: this.config.summaryParticipant ?? 'Summary',
        content: [{ type: 'text', text: prevChunk.diary }],
      });
    }

    const messages = ctx.messageStore.getAll();
    const precedingStart = Math.max(0, chunk.startIndex - 50);
    let tokens = 0;

    for (let i = chunk.startIndex - 1; i >= precedingStart && tokens < 15000; i--) {
      const msg = messages[i];
      if (!msg) break;

      tokens += ctx.messageStore.estimateTokens(msg);
      context.unshift({
        participant: msg.participant,
        content: msg.content,
      });
    }

    return context;
  }

  // ============================================================================
  // Hierarchical (L1/L2/L3) path
  // ============================================================================

  /**
   * Anti-redundancy filter: get summaries to show, excluding those whose
   * children are all already visible at a lower level.
   *
   * Matches moltbot's gradient exclusion algorithm (worker.ts:293-447).
   */
  private getAntiRedundantSummaries(excludeMessageIds?: Set<string>): {
    shownL1: SummaryEntry[];
    shownL2: SummaryEntry[];
    shownL3: SummaryEntry[];
  } {
    // Step 1: All unmerged L1s, excluding those whose sourceIds overlap with exclusion set
    let candidateL1 = this.summaries.filter(s => s.level === 1 && !s.mergedInto);
    if (excludeMessageIds && excludeMessageIds.size > 0) {
      candidateL1 = candidateL1.filter(
        s => !s.sourceIds.some(id => excludeMessageIds.has(id))
      );
    }
    const shownL1 = candidateL1;
    const shownL1Ids = new Set(shownL1.map(s => s.id));

    // Step 2: Unmerged L2s, excluding those whose ALL source L1s are shown
    const candidateL2 = this.summaries.filter(s => s.level === 2 && !s.mergedInto);
    const shownL2 = candidateL2.filter(
      s => !s.sourceIds.every(l1Id => shownL1Ids.has(l1Id))
    );
    const shownL2Ids = new Set(shownL2.map(s => s.id));

    // Step 3: Unmerged L3s, excluding those whose ALL source L2s are shown
    const candidateL3 = this.summaries.filter(s => s.level === 3 && !s.mergedInto);
    const shownL3 = candidateL3.filter(
      s => !s.sourceIds.every(l2Id => shownL2Ids.has(l2Id))
    );

    return { shownL1, shownL2, shownL3 };
  }

  /**
   * Compress a raw message chunk into an L1 summary using self-voice framing.
   * No system prompt — framing via message structure only.
   */
  private async compressChunkHierarchical(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    if (!ctx.membrane) {
      throw new Error('No membrane instance for compression');
    }

    const chunkMessageIds = new Set(chunk.messages.map(m => m.id));
    const { shownL3, shownL2, shownL1 } = this.getAntiRedundantSummaries(chunkMessageIds);

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const chunkContent = this.formatChunkForCompression(chunk);

    // Build message array: prior summaries as assistant, then instruction
    const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

    // Prior summaries as agent's own recollections (L3 → L2 → L1 gradient)
    const allPriorSummaries = [...shownL3, ...shownL2, ...shownL1];
    for (const s of allPriorSummaries) {
      llmMessages.push({
        participant: this.config.summaryParticipant ?? 'Claude',
        content: [{ type: 'text', text: s.content }],
      });
    }

    // Context Manager instruction with chunk content
    llmMessages.push({
      participant: 'Context Manager',
      content: [{
        type: 'text',
        text: `[Context Manager] We are ready to form a long-term memory. Here is the conversation to remember:\n\n${chunkContent}\n\nStarting from my last message, please describe everything that has happened. Aim for about ${targetTokens} tokens. Describe it as you would to yourself, as if you are remembering what has happened.`,
      }],
    });

    // Collapse consecutive same-participant messages for API compliance
    const collapsed = this.collapseConsecutiveMessages(llmMessages);

    const request: NormalizedRequest = {
      messages: collapsed.map(m => ({ participant: m.participant, content: m.content })),
      system: 'You are forming autobiographical memories of a conversation.',
      config: {
        model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
        maxTokens: Math.round(targetTokens * 1.5),
        temperature: 0,
      },
    };

    try {
      const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
      const summaryText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const messageIds = chunk.messages.map(m => m.id);
      const entry: SummaryEntry = {
        id: `L1-${this.summaryIdCounter++}`,
        level: 1,
        content: summaryText,
        tokens: Math.ceil(summaryText.length / 4),
        sourceLevel: 0,
        sourceIds: messageIds,
        sourceRange: {
          first: messageIds[0],
          last: messageIds[messageIds.length - 1],
        },
        created: Date.now(),
      };

      this.summaries.push(entry);
      chunk.compressed = true;
      chunk.summaryId = entry.id;

      this.checkMergeThreshold();
    } catch (error) {
      console.error('Failed to compress chunk (hierarchical):', error);
      throw error;
    }
  }

  /**
   * Check if unmerged summary counts exceed the merge threshold.
   * Enqueues merge operations if so.
   */
  private checkMergeThreshold(): void {
    const threshold = this.config.mergeThreshold ?? 6;

    // Check L1 → L2
    const unmergedL1 = this.summaries.filter(s => s.level === 1 && !s.mergedInto);
    if (unmergedL1.length >= threshold) {
      const toMerge = unmergedL1.slice(0, threshold);
      this.mergeQueue.push({
        level: 2,
        sourceIds: toMerge.map(s => s.id),
      });
    }

    // Check L2 → L3
    const unmergedL2 = this.summaries.filter(s => s.level === 2 && !s.mergedInto);
    if (unmergedL2.length >= threshold) {
      const toMerge = unmergedL2.slice(0, threshold);
      this.mergeQueue.push({
        level: 3,
        sourceIds: toMerge.map(s => s.id),
      });
    }
  }

  /**
   * Merge N summaries at one level into a single summary at the next level.
   * Uses self-voice consolidation prompt.
   */
  private async executeMerge(
    targetLevel: SummaryLevel,
    sourceIds: string[],
    ctx: StrategyContext
  ): Promise<void> {
    if (!ctx.membrane) {
      throw new Error('No membrane instance for merge');
    }

    const sources = sourceIds
      .map(id => this.summaries.find(s => s.id === id))
      .filter((s): s is SummaryEntry => s != null);

    if (sources.length !== sourceIds.length) {
      console.warn('executeMerge: some source summaries not found, skipping');
      return;
    }

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const participant = this.config.summaryParticipant ?? 'Claude';

    // Build message array
    const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

    // Higher-level context (anti-redundant)
    if (targetLevel === 2) {
      // For L2 merge: show L3 summaries as context
      const shownL3 = this.summaries.filter(s => s.level === 3 && !s.mergedInto);
      for (const s of shownL3) {
        llmMessages.push({
          participant,
          content: [{ type: 'text', text: s.content }],
        });
      }
    }
    // For L3 merge: no higher context exists

    // The source summaries as agent's own memories
    for (const source of sources) {
      llmMessages.push({
        participant,
        content: [{ type: 'text', text: source.content }],
      });
    }

    // Consolidation instruction
    llmMessages.push({
      participant: 'Context Manager',
      content: [{
        type: 'text',
        text: `[Context Manager] Please consolidate the memories since my last message into a single cohesive memory. Aim for about ${targetTokens} tokens. Write as you would to yourself — this is your autobiography, capturing the arc of what happened.`,
      }],
    });

    const collapsed = this.collapseConsecutiveMessages(llmMessages);

    const request: NormalizedRequest = {
      messages: collapsed.map(m => ({ participant: m.participant, content: m.content })),
      system: 'You are forming autobiographical memories of a conversation.',
      config: {
        model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
        maxTokens: Math.round(targetTokens * 1.5),
        temperature: 0,
      },
    };

    try {
      const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
      const mergedText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      // Compute source range from constituent summaries
      const sourceRange = {
        first: sources[0].sourceRange.first,
        last: sources[sources.length - 1].sourceRange.last,
      };

      const sourceLevel = (targetLevel - 1) as 0 | 1 | 2;
      const newEntry: SummaryEntry = {
        id: `L${targetLevel}-${this.summaryIdCounter++}`,
        level: targetLevel,
        content: mergedText,
        tokens: Math.ceil(mergedText.length / 4),
        sourceLevel,
        sourceIds,
        sourceRange,
        created: Date.now(),
      };

      this.summaries.push(newEntry);

      // Mark sources as merged
      for (const source of sources) {
        source.mergedInto = newEntry.id;
      }

      // Check if this merge triggers a further merge
      this.checkMergeThreshold();
    } catch (error) {
      console.error(`Failed to merge summaries into L${targetLevel}:`, error);
      throw error;
    }
  }

  /**
   * Select context entries using hierarchical compression with budget carryover.
   * Matches moltbot's budget waterfall: L3 → L2 → L1 with unused budget flowing down.
   */
  private selectHierarchical(store: MessageStoreView, budget: TokenBudget): ContextEntry[] {
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;

    // Compute recent window exclusion set
    const messages = store.getAll();
    const recentStart = this.getRecentWindowStart(store);
    const recentMessageIds = new Set(messages.slice(recentStart).map(m => m.id));

    // Get anti-redundant summaries
    const { shownL3, shownL2, shownL1 } = this.getAntiRedundantSummaries(recentMessageIds);

    // Budget carryover: L3 → L2 → L1
    const l3Budget = this.config.l3BudgetTokens ?? 30000;
    const l2Budget = this.config.l2BudgetTokens ?? 30000;
    const l1Budget = this.config.l1BudgetTokens ?? 30000;

    const selectedSummaries: SummaryEntry[] = [];
    let totalSummaryTokens = 0;

    // Phase 1: L3 within L3 budget
    let l3Used = 0;
    for (const s of shownL3) {
      if (l3Used + s.tokens > l3Budget) break;
      if (totalSummaryTokens + s.tokens > maxTokens) break;
      selectedSummaries.push(s);
      l3Used += s.tokens;
      totalSummaryTokens += s.tokens;
    }
    const l3Carryover = l3Budget - l3Used;

    // Phase 2: L2 within (L2 budget + carryover)
    let l2Used = 0;
    const l2Effective = l2Budget + l3Carryover;
    for (const s of shownL2) {
      if (l2Used + s.tokens > l2Effective) break;
      if (totalSummaryTokens + s.tokens > maxTokens) break;
      selectedSummaries.push(s);
      l2Used += s.tokens;
      totalSummaryTokens += s.tokens;
    }
    const l2Carryover = l2Effective - l2Used;

    // Phase 3: L1 within (L1 budget + carryover)
    let l1Used = 0;
    const l1Effective = l1Budget + l2Carryover;
    for (const s of shownL1) {
      if (l1Used + s.tokens > l1Effective) break;
      if (totalSummaryTokens + s.tokens > maxTokens) break;
      selectedSummaries.push(s);
      l1Used += s.tokens;
      totalSummaryTokens += s.tokens;
    }

    // Emit summaries as a single Q&A pair
    let totalTokens = 0;
    if (selectedSummaries.length > 0) {
      const contextLabel = this.config.summaryContextLabel ?? 'What do you remember from earlier?';
      const combinedText = selectedSummaries.map(s => s.content).join('\n\n---\n\n');

      const questionEntry: ContextEntry = {
        index: entries.length,
        participant: 'Context Manager',
        content: [{ type: 'text', text: contextLabel }],
        sourceRelation: 'derived',
      };
      const answerEntry: ContextEntry = {
        index: entries.length + 1,
        participant: this.config.summaryParticipant ?? 'Claude',
        content: [{ type: 'text', text: combinedText }],
        sourceRelation: 'derived',
      };

      const pairTokens = this.estimateTokens(questionEntry.content) +
                         this.estimateTokens(answerEntry.content);

      entries.push(questionEntry);
      entries.push(answerEntry);
      totalTokens = pairTokens;
    }

    // Phase 4: Recent uncompressed messages
    for (let i = recentStart; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = store.estimateTokens(msg);

      if (totalTokens + tokens > maxTokens) break;

      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: msg.content,
      });
      totalTokens += tokens;
    }

    return entries;
  }

  // ============================================================================
  // Shared utilities
  // ============================================================================

  /**
   * Rebuild chunk boundaries based on current messages.
   */
  private rebuildChunks(store: MessageStoreView): void {
    const messages = store.getAll();
    const recentStart = this.getRecentWindowStart(store);
    const messagesToChunk = messages.slice(0, recentStart);

    // Preserve existing compressed chunks (legacy) and summary linkage (hierarchical)
    const existingCompressed = new Map<string, Chunk>();
    for (const chunk of this.chunks) {
      if (chunk.compressed) {
        const key = this.chunkKey(chunk);
        existingCompressed.set(key, chunk);
      }
    }

    // Rebuild chunks
    this.chunks = [];
    this.compressionQueue = [];

    let currentChunk: StoredMessage[] = [];
    let currentTokens = 0;
    let chunkStartIndex = 0;

    for (let i = 0; i < messagesToChunk.length; i++) {
      const msg = messagesToChunk[i];
      let msgTokens = store.estimateTokens(msg);

      if (this.config.attachmentsIgnoreSize) {
        msgTokens = this.estimateTextOnlyTokens(msg);
      }

      currentChunk.push(msg);
      currentTokens += msgTokens;

      const shouldClose =
        currentTokens >= this.config.targetChunkTokens &&
        currentChunk.length >= 4;

      if (shouldClose) {
        const chunk = this.createChunk(
          this.chunks.length,
          chunkStartIndex,
          i + 1,
          currentChunk,
          currentTokens,
          existingCompressed
        );
        this.chunks.push(chunk);

        if (!chunk.compressed) {
          this.compressionQueue.push(chunk.index);
        }

        currentChunk = [];
        currentTokens = 0;
        chunkStartIndex = i + 1;
      }
    }

    if (currentChunk.length >= 4) {
      const chunk = this.createChunk(
        this.chunks.length,
        chunkStartIndex,
        messagesToChunk.length,
        currentChunk,
        currentTokens,
        existingCompressed
      );
      this.chunks.push(chunk);

      if (!chunk.compressed) {
        this.compressionQueue.push(chunk.index);
      }
    }
  }

  private createChunk(
    index: number,
    startIndex: number,
    endIndex: number,
    messages: StoredMessage[],
    tokens: number,
    existingCompressed: Map<string, Chunk>
  ): Chunk {
    const chunk: Chunk = {
      index,
      startIndex,
      endIndex,
      messages: [...messages],
      tokens,
      compressed: false,
    };

    const key = this.chunkKey(chunk);
    const existing = existingCompressed.get(key);
    if (existing) {
      chunk.compressed = true;
      chunk.diary = existing.diary;
      chunk.summaryId = existing.summaryId;
    }

    // In hierarchical mode, also check if a summary exists for this chunk
    if (this.config.hierarchical && !chunk.compressed) {
      const summary = this.summaries.find(
        s => s.level === 1 && s.sourceIds.join(':') === key
      );
      if (summary) {
        chunk.compressed = true;
        chunk.summaryId = summary.id;
      }
    }

    return chunk;
  }

  private chunkKey(chunk: Chunk): string {
    return chunk.messages.map((m) => m.id).join(':');
  }

  private getRecentWindowStart(store: MessageStoreView): number {
    const messages = store.getAll();
    let tokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > this.config.recentWindowTokens) {
        return i + 1;
      }
    }

    return 0;
  }

  private isChunkOldEnough(chunk: Chunk): boolean {
    return true;
  }

  private formatChunkForCompression(chunk: Chunk): string {
    const lines: string[] = ['<earlier_in_conversation>'];

    for (const msg of chunk.messages) {
      lines.push(`# ${msg.participant.toUpperCase()}`);
      for (const block of msg.content) {
        if (block.type === 'text') {
          lines.push(block.text);
        } else if (block.type === 'tool_use') {
          lines.push(`[Tool: ${block.name}]`);
        } else if (block.type === 'tool_result') {
          lines.push(`[Tool Result]`);
        } else if (block.type === 'image') {
          lines.push(`[Image]`);
        }
      }
      lines.push('');
    }

    lines.push('</earlier_in_conversation>');
    return lines.join('\n');
  }

  /**
   * Collapse consecutive messages from the same participant into single messages.
   * Required because Claude API rejects consecutive same-role messages.
   */
  private collapseConsecutiveMessages(
    messages: Array<{ participant: string; content: ContentBlock[] }>
  ): Array<{ participant: string; content: ContentBlock[] }> {
    if (messages.length === 0) return [];

    const result: Array<{ participant: string; content: ContentBlock[] }> = [
      { participant: messages[0].participant, content: [...messages[0].content] },
    ];

    for (let i = 1; i < messages.length; i++) {
      const last = result[result.length - 1];
      if (messages[i].participant === last.participant) {
        // Merge: add separator then content
        last.content.push({ type: 'text', text: '\n\n---\n\n' } as ContentBlock);
        last.content.push(...messages[i].content);
      } else {
        result.push({ participant: messages[i].participant, content: [...messages[i].content] });
      }
    }

    return result;
  }

  private estimateTextOnlyTokens(msg: StoredMessage): number {
    let tokens = 0;
    for (const block of msg.content) {
      if (block.type === 'text') {
        tokens += Math.ceil(block.text.length / 4);
      } else if (block.type === 'thinking') {
        tokens += Math.ceil(block.thinking.length / 4);
      } else if (block.type === 'tool_use') {
        tokens += Math.ceil(JSON.stringify(block.input).length / 4) + 20;
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          tokens += Math.ceil(block.content.length / 4);
        }
      }
    }
    return tokens;
  }

  private estimateTokens(content: ContentBlock[]): number {
    let tokens = 0;
    for (const block of content) {
      if (block.type === 'text') {
        tokens += Math.ceil(block.text.length / 4);
      }
    }
    return tokens;
  }

  /**
   * Truncate a message's content blocks to fit within maxMessageTokens.
   * Returns the original content if no truncation is needed, or a new array
   * with text/tool_result blocks trimmed.
   */
  private truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
    if (maxTokens <= 0) return content;
    const est = this.estimateTextOnlyTokens({ content } as StoredMessage);
    if (est <= maxTokens) return content;

    const maxChars = maxTokens * 4; // inverse of chars/4 estimate
    const result: ContentBlock[] = [];
    let remaining = maxChars;

    for (const block of content) {
      if (block.type === 'text') {
        if (remaining <= 0) {
          continue;
        }
        if (block.text.length <= remaining) {
          result.push(block);
          remaining -= block.text.length;
        } else {
          result.push({
            type: 'text',
            text: block.text.slice(0, remaining) + '\n\n[truncated — original was ' +
              Math.ceil(block.text.length / 4) + ' tokens]',
          });
          remaining = 0;
        }
      } else if (block.type === 'tool_result') {
        if (typeof (block as any).content === 'string') {
          const content = (block as any).content as string;
          if (content.length > remaining && remaining > 0) {
            result.push({
              ...block,
              content: content.slice(0, remaining) + '\n\n[truncated — original was ' +
                Math.ceil(content.length / 4) + ' tokens]',
            } as ContentBlock);
            remaining = 0;
          } else if (remaining > 0) {
            result.push(block);
            remaining -= content.length;
          }
        } else {
          result.push(block);
        }
      } else {
        // tool_use, image, etc — pass through
        result.push(block);
      }
    }

    return result;
  }
}
