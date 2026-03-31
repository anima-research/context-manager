import type { Membrane, NormalizedRequest, ContentBlock, CompleteOptions } from 'membrane';
import { NativeFormatter } from 'membrane';
import type {
  ContextStrategy,
  ResettableStrategy,
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
 * Surrogate-safe string slice. Avoids cutting between a UTF-16 surrogate pair
 * which would produce invalid JSON ("no low surrogate in string" API errors).
 */
function safeSlice(str: string, start: number, end: number): string {
  if (end >= str.length) return str.slice(start);
  const code = str.charCodeAt(end);
  if (code >= 0xDC00 && code <= 0xDFFF) {
    return str.slice(start, end - 1);
  }
  return str.slice(start, end);
}

/**
 * Chunk of messages to be compressed.
 */
export interface Chunk {
  /** Index in the chunk list */
  index: number;
  /** Starting index in the compressible message array (inclusive).
   *  Note: this is an index into getCompressibleMessages(), not store.getAll(). */
  startIndex: number;
  /** Ending index in the compressible message array (exclusive).
   *  Note: this is an index into getCompressibleMessages(), not store.getAll(). */
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
  /** Phase type tag (set by KnowledgeStrategy for semantic chunking) */
  phaseType?: string;
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
export class AutobiographicalStrategy implements ResettableStrategy {
  readonly name: string = 'autobiographical';

  get maxMessageTokens(): number { return this.config.maxMessageTokens; }

  protected config: AutobiographicalConfig;
  protected chunks: Chunk[] = [];
  protected pendingCompression: Promise<void> | null = null;
  protected compressionQueue: number[] = [];
  protected _compressionCount = 0;

  // Hierarchical state
  protected summaries: SummaryEntry[] = [];
  protected summaryIdCounter = 0;
  protected mergeQueue: Array<{ level: SummaryLevel; sourceIds: string[] }> = [];
  protected nativeFormatter = new NativeFormatter();

  /** Message ID from which the head window starts. null = start from message 0. */
  protected headWindowStartId: string | null = null;
  /** Cached result of getHeadWindowStartIndex to avoid repeated linear scans. */
  private _cachedHeadStartIndex: { id: string | null; msgCount: number; result: number } | null = null;

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

  async initialize(ctx: StrategyContext): Promise<void> {
    // Restore headWindowStartId from last topic transition message
    const messages = ctx.messageStore.getAll();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (this.isTopicTransitionMessage(messages[i])) {
        this.headWindowStartId = messages[i].id;
        break;
      }
    }
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
  getStats(): {
    chunksTotal: number; chunksCompressed: number; compressionCount: number;
    l1: number; l2: number; l3: number; pendingMerges: number;
  } {
    return {
      chunksTotal: this.chunks.length,
      chunksCompressed: this.chunks.filter(c => c.compressed).length,
      compressionCount: this._compressionCount,
      l1: this.summaries.filter(s => s.level === 1 && !s.mergedInto).length,
      l2: this.summaries.filter(s => s.level === 2 && !s.mergedInto).length,
      l3: this.summaries.filter(s => s.level === 3 && !s.mergedInto).length,
      pendingMerges: this.mergeQueue.length,
    };
  }

  // ============================================================================
  // Legacy (single-level) path
  // ============================================================================

  protected selectLegacy(
    store: MessageStoreView,
    _log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[] {
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    let totalTokens = 0;
    const messages = store.getAll();
    const msgCap = this.config.maxMessageTokens;

    // 1. Head window: preserved verbatim as raw copies
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
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
    const rawRecentStart = this.getRecentWindowStart(store);
    // Track which message IDs are covered by chunks
    const coveredByChunks = new Set<string>();

    for (const chunk of this.chunks) {
      for (const m of chunk.messages) coveredByChunks.add(m.id);

      if (chunk.compressed && chunk.diary) {
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
    }

    // Emit gap messages in the compressible zone not covered by any chunk.
    // Compressible zone: [0, headStart) ∪ [headEnd, rawRecentStart)
    for (let i = 0; i < rawRecentStart && i < messages.length; i++) {
      // Skip head window messages (already emitted verbatim above)
      if (i >= headStart && i < headEnd) continue;
      if (coveredByChunks.has(messages[i].id)) continue;
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

    // 3. Recent uncompressed messages (skip those already in head window)
    const recentStart = Math.max(this.getRecentWindowStart(store), headEnd);

    for (let i = recentStart; i < messages.length; i++) {
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

    this.trimOrphanedToolUse(entries);
    return entries;
  }

  protected async compressChunkLegacy(chunk: Chunk, ctx: StrategyContext): Promise<void> {
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

  protected buildPriorContextLegacy(chunk: Chunk, ctx: StrategyContext): Array<{
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

    // Find the actual position of this chunk's first message in the full array
    const messages = ctx.messageStore.getAll();
    const firstMsgId = chunk.messages[0]?.id;
    const chunkAbsStart = firstMsgId
      ? messages.findIndex(m => m.id === firstMsgId)
      : -1;

    if (chunkAbsStart > 0) {
      const precedingStart = Math.max(0, chunkAbsStart - 50);
      let tokens = 0;

      for (let i = chunkAbsStart - 1; i >= precedingStart && tokens < 15000; i--) {
        const msg = messages[i];
        if (!msg) break;

        tokens += ctx.messageStore.estimateTokens(msg);
        context.unshift({
          participant: msg.participant,
          content: msg.content,
        });
      }
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
  protected getAntiRedundantSummaries(excludeMessageIds?: Set<string>): {
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
  protected async compressChunkHierarchical(chunk: Chunk, ctx: StrategyContext): Promise<void> {
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
    const instruction = this.getCompressionInstruction(chunk, targetTokens);
    llmMessages.push({
      participant: 'Context Manager',
      content: [{
        type: 'text',
        text: `[Context Manager] We are ready to form a long-term memory. Here is the conversation to remember:\n\n${chunkContent}\n\n${instruction}`,
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
        phaseType: chunk.phaseType,
      };

      this.summaries.push(entry);
      chunk.compressed = true;
      chunk.summaryId = entry.id;
      this._compressionCount++;

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
  protected checkMergeThreshold(): void {
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
  protected async executeMerge(
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
    const mergeInstruction = this.getMergeInstruction(targetLevel, sources, targetTokens);
    llmMessages.push({
      participant: 'Context Manager',
      content: [{
        type: 'text',
        text: `[Context Manager] ${mergeInstruction}`,
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
  protected selectHierarchical(store: MessageStoreView, budget: TokenBudget): ContextEntry[] {
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    const messages = store.getAll();
    const msgCap = this.config.maxMessageTokens;

    let totalTokens = 0;

    // Phase 0: Head window — preserved verbatim (from headStart, not necessarily 0)
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
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

    // Compute recent window exclusion set (also exclude head window messages)
    const recentStart = this.getRecentWindowStart(store);
    const excludeIds = new Set<string>();
    for (let i = headStart; i < headEnd; i++) excludeIds.add(messages[i].id);
    for (let i = recentStart; i < messages.length; i++) excludeIds.add(messages[i].id);

    // Get anti-redundant summaries
    const { shownL3, shownL2, shownL1 } = this.getAntiRedundantSummaries(excludeIds);

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
      if (totalTokens + totalSummaryTokens + s.tokens > maxTokens) break;
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
      if (totalTokens + totalSummaryTokens + s.tokens > maxTokens) break;
      selectedSummaries.push(s);
      l2Used += s.tokens;
      totalSummaryTokens += s.tokens;
    }
    const l2Carryover = l2Effective - l2Used;

    // Phase 3: L1 within (L1 budget + carryover)
    const l1Effective = l1Budget + l2Carryover;
    const l1Remaining = maxTokens - totalTokens - totalSummaryTokens;
    const { selected: l1Selected, tokensUsed: l1Used } = this.selectL1Summaries(
      shownL1, l1Effective, l1Remaining
    );
    selectedSummaries.push(...l1Selected);
    totalSummaryTokens += l1Used;

    // Emit summaries as a single Q&A pair
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
      totalTokens += pairTokens;
    }

    // Phase 4: Recent uncompressed messages (skip head window overlap)
    const effectiveRecentStart = Math.max(recentStart, headEnd);
    for (let i = effectiveRecentStart; i < messages.length; i++) {
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

    this.trimOrphanedToolUse(entries);
    return entries;
  }

  // ============================================================================
  // Overridable hooks (for subclass customization)
  // ============================================================================

  /**
   * Build the compression instruction for an L1 chunk.
   * Override in subclasses for phase-aware prompts.
   */
  protected getCompressionInstruction(chunk: Chunk, targetTokens: number): string {
    return `Starting from my last message, please describe everything that has happened. Aim for about ${targetTokens} tokens. Describe it as you would to yourself, as if you are remembering what has happened.`;
  }

  /**
   * Build the merge instruction for combining summaries into a higher level.
   * Override in subclasses for domain-specific merge prompts.
   */
  protected getMergeInstruction(
    targetLevel: SummaryLevel,
    sources: SummaryEntry[],
    targetTokens: number
  ): string {
    return `Please consolidate the memories since my last message into a single cohesive memory. Aim for about ${targetTokens} tokens. Write as you would to yourself — this is your autobiography, capturing the arc of what happened.`;
  }

  /**
   * Select L1 summaries within a budget. Returns selected summaries and tokens used.
   * Override in subclasses for asymmetric budget allocation (e.g., cap research, prioritize synthesis).
   */
  protected selectL1Summaries(
    shownL1: SummaryEntry[],
    budget: number,
    maxTokens: number
  ): { selected: SummaryEntry[]; tokensUsed: number } {
    const selected: SummaryEntry[] = [];
    let used = 0;
    for (const s of shownL1) {
      if (used + s.tokens > budget) break;
      if (used + s.tokens > maxTokens) break;
      selected.push(s);
      used += s.tokens;
    }
    return { selected, tokensUsed: used };
  }

  // ============================================================================
  // Head window reset / topic transition
  // ============================================================================

  /**
   * Reset the head window to start from a new message ID.
   * Old head window messages become compressible on the next chunk rebuild.
   */
  resetHeadWindow(newStartId: string | null): void {
    this.headWindowStartId = newStartId;
    this._cachedHeadStartIndex = null;
  }

  /**
   * Generate a transition summary from the current head window + top summaries.
   * Used when `/newtopic` is called without explicit context.
   */
  async generateTransitionSummary(ctx: StrategyContext): Promise<string> {
    if (!ctx.membrane) {
      throw new Error('No membrane instance for transition summary generation');
    }

    const messages = ctx.messageStore.getAll();
    const headStart = this.getHeadWindowStartIndex(ctx.messageStore);
    const headEnd = this.getHeadWindowEnd(ctx.messageStore);
    const headMessages = messages.slice(headStart, headEnd);

    // Format head content, truncated to ~2000 tokens (~8000 chars)
    const MAX_HEAD_CHARS = 8000;
    let headContent = '';
    for (const m of headMessages) {
      const entry = `${m.participant}: ${this.extractText(m.content)}`;
      if (headContent.length + entry.length > MAX_HEAD_CHARS) {
        headContent += '\n\n[...truncated...]';
        break;
      }
      headContent += (headContent ? '\n\n' : '') + entry;
    }

    // Gather top summaries for broader context
    const topSummaries = this.summaries
      .filter(s => s.level >= 2)
      .slice(-3)
      .map(s => s.content)
      .join('\n\n---\n\n');

    const instruction = [
      'Summarize the prior conversation context in 2-3 paragraphs, focusing on:',
      '- What was the original objective and what was accomplished',
      '- Key findings, decisions, and unresolved questions',
      '- Any cross-references or context that may be relevant going forward',
      '',
      'Prior context:',
      '',
      headContent,
      topSummaries ? `\nHigher-level summaries:\n${topSummaries}` : '',
      '',
      'Write a concise transition summary.',
    ].join('\n');

    const request: NormalizedRequest = {
      messages: [{ participant: 'Context Manager', content: [{ type: 'text', text: instruction }] }],
      system: 'You are forming a transition summary between conversation topics. Write concisely.',
      config: {
        model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
        maxTokens: 1500,
        temperature: 0,
      },
    };

    const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
    return response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }

  /**
   * Check if a message is a topic transition marker.
   */
  protected isTopicTransitionMessage(message: StoredMessage): boolean {
    return message.participant === 'Context Manager' &&
      message.content.some(b =>
        b.type === 'text' && (b as { type: 'text'; text: string }).text.startsWith('[Topic Transition]')
      );
  }

  /**
   * Extract plain text from content blocks.
   */
  protected extractText(content: ContentBlock[]): string {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }

  // ============================================================================
  // Shared utilities
  // ============================================================================

  /**
   * Get messages in the compressible zone: outside both head window and recent window.
   * Returns messages from [0, headStart) ∪ [headEnd, recentStart).
   */
  protected getCompressibleMessages(store: MessageStoreView): StoredMessage[] {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);
    return messages.slice(0, recentStart)
      .filter((_, i) => i < headStart || i >= headEnd);
  }

  /**
   * Rebuild chunk boundaries based on current messages.
   */
  protected rebuildChunks(store: MessageStoreView): void {
    const messagesToChunk = this.getCompressibleMessages(store);

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
    // Track start position in the filtered array for chunk boundary metadata
    let chunkFilteredStart = 0;

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
          chunkFilteredStart,
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
        chunkFilteredStart = i + 1;
      }
    }

    if (currentChunk.length >= 4) {
      const chunk = this.createChunk(
        this.chunks.length,
        chunkFilteredStart,
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

  protected createChunk(
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

  protected chunkKey(chunk: Chunk): string {
    return chunk.messages.map((m) => m.id).join(':');
  }

  protected getRecentWindowStart(store: MessageStoreView): number {
    const messages = store.getAll();
    let tokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > this.config.recentWindowTokens) {
        let boundary = i + 1;
        // Don't split a tool_use/tool_result pair: if the message at the boundary
        // is a tool_result, include the preceding tool_use with it (retreat by 1).
        if (boundary > 0 && boundary < messages.length && this.hasToolResult(messages[boundary])) {
          boundary--;
        }
        return boundary;
      }
    }

    return 0;
  }

  /**
   * Index of the first message in the head window.
   * When headWindowStartId is set, the head window starts from that message
   * instead of message 0 — old messages before it become compressible.
   */
  protected getHeadWindowStartIndex(store: MessageStoreView): number {
    if (!this.headWindowStartId) return 0;
    const messages = store.getAll();
    // Cache to avoid repeated O(n) scans within the same select/rebuild pass
    if (this._cachedHeadStartIndex
      && this._cachedHeadStartIndex.id === this.headWindowStartId
      && this._cachedHeadStartIndex.msgCount === messages.length) {
      return this._cachedHeadStartIndex.result;
    }
    const idx = messages.findIndex(m => m.id === this.headWindowStartId);
    const result = idx >= 0 ? idx : 0;
    this._cachedHeadStartIndex = { id: this.headWindowStartId, msgCount: messages.length, result };
    return result;
  }

  /**
   * Index of the first message AFTER the head window.
   * Messages [headStart, headEnd) are preserved verbatim.
   */
  protected getHeadWindowEnd(store: MessageStoreView): number {
    if (this.config.headWindowTokens <= 0) return 0;

    const messages = store.getAll();
    const startIdx = this.getHeadWindowStartIndex(store);
    let tokens = 0;

    for (let i = startIdx; i < messages.length; i++) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > this.config.headWindowTokens) {
        let boundary = i;
        // Don't split a tool_use/tool_result pair: if the boundary message's
        // predecessor has tool_use, pull back by one so the pair stays together.
        if (boundary > startIdx && this.hasToolUse(messages[boundary - 1])) {
          boundary--;
        }
        return boundary;
      }
    }

    return messages.length;
  }

  protected hasToolUse(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_use');
  }

  protected hasToolResult(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_result');
  }

  /**
   * Remove trailing entries that contain tool_use without a following tool_result.
   * This prevents orphaned tool_use blocks when a budget break cuts between
   * a tool_use message and its tool_result response.
   */
  private trimOrphanedToolUse(entries: ContextEntry[]): void {
    while (entries.length > 0) {
      const last = entries[entries.length - 1];
      const hasUse = last.content.some(b => b.type === 'tool_use');
      const hasResult = last.content.some(b => b.type === 'tool_result');
      if (hasUse && !hasResult) {
        entries.pop();
      } else {
        break;
      }
    }
  }

  protected isChunkOldEnough(chunk: Chunk): boolean {
    return true;
  }

  protected formatChunkForCompression(chunk: Chunk): string {
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
  protected collapseConsecutiveMessages(
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

  protected estimateTextOnlyTokens(msg: StoredMessage): number {
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

  protected estimateTokens(content: ContentBlock[]): number {
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
   */
  protected truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
    if (maxTokens <= 0) return content;
    const est = this.estimateTextOnlyTokens({ content } as StoredMessage);
    if (est <= maxTokens) return content;

    const maxChars = maxTokens * 4;
    const result: ContentBlock[] = [];
    let remaining = maxChars;

    for (const block of content) {
      if (block.type === 'text') {
        if (remaining <= 0) continue;
        if (block.text.length <= remaining) {
          result.push(block);
          remaining -= block.text.length;
        } else {
          result.push({
            type: 'text',
            text: safeSlice(block.text, 0, remaining) + '\n\n[truncated — original was ' +
              Math.ceil(block.text.length / 4) + ' tokens]',
          });
          remaining = 0;
        }
      } else if (block.type === 'tool_result') {
        // tool_result blocks MUST always be included — the Anthropic API requires
        // every tool_use to have a matching tool_result.  Dropping one causes a 400.
        if (typeof (block as any).content === 'string') {
          const text = (block as any).content as string;
          if (remaining <= 0) {
            // Budget exhausted — include with minimal content to preserve pairing
            result.push({
              ...block,
              content: '[content omitted — context budget exceeded]',
            } as ContentBlock);
          } else if (text.length > remaining) {
            result.push({
              ...block,
              content: safeSlice(text, 0, remaining) + '\n\n[truncated — original was ' +
                Math.ceil(text.length / 4) + ' tokens]',
            } as ContentBlock);
            remaining = 0;
          } else {
            result.push(block);
            remaining -= text.length;
          }
        } else {
          result.push(block);
        }
      } else {
        result.push(block);
      }
    }

    return result;
  }
}
