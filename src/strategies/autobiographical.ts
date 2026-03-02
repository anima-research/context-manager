import type { Membrane, NormalizedRequest, ContentBlock } from 'membrane';
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
  /** The diary entry if compressed */
  diary?: string;
}

/**
 * Autobiographical chunking strategy.
 * Compresses old conversation chunks into "diary entries" - summaries in the model's own words.
 * Recent context stays untouched.
 */
export class AutobiographicalStrategy implements ContextStrategy {
  readonly name = 'autobiographical';

  get maxMessageTokens(): number { return this.config.maxMessageTokens; }

  private config: AutobiographicalConfig;
  private chunks: Chunk[] = [];
  private pendingCompression: Promise<void> | null = null;
  private compressionQueue: number[] = [];
  private _compressionCount = 0;

  constructor(config: Partial<AutobiographicalConfig> = {}) {
    this.config = { ...DEFAULT_AUTOBIOGRAPHICAL_CONFIG, ...config };
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

    // Check if any chunks need compression
    const needsCompression = this.chunks.some(
      (c) => !c.compressed && this.isChunkOldEnough(c)
    );

    if (needsCompression && this.compressionQueue.length > 0) {
      return {
        ready: false,
        description: `${this.compressionQueue.length} chunks pending compression`,
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
    if (this.pendingCompression || this.compressionQueue.length === 0) {
      return;
    }

    if (!ctx.membrane) {
      console.warn('AutobiographicalStrategy: No membrane instance for compression');
      return;
    }

    const chunkIndex = this.compressionQueue.shift()!;
    const chunk = this.chunks[chunkIndex];

    if (!chunk || chunk.compressed) {
      return;
    }

    this.pendingCompression = this.compressChunk(chunk, ctx);

    try {
      await this.pendingCompression;
    } finally {
      this.pendingCompression = null;
    }
  }

  select(
    store: MessageStoreView,
    _log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[] {
    this.rebuildChunks(store);

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

  /**
   * Rebuild chunk boundaries based on current messages.
   */
  private rebuildChunks(store: MessageStoreView): void {
    const messages = store.getAll();
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);
    // Only chunk messages between head window and recent window
    const chunkStart = Math.min(headEnd, recentStart);
    const messagesToChunk = messages.slice(chunkStart, recentStart);

    // Preserve existing compressed chunks
    const existingCompressed = new Map<string, Chunk>();
    for (const chunk of this.chunks) {
      if (chunk.compressed && chunk.diary) {
        const key = this.chunkKey(chunk);
        existingCompressed.set(key, chunk);
      }
    }

    // Rebuild chunks
    this.chunks = [];
    this.compressionQueue = [];

    let currentChunk: StoredMessage[] = [];
    let currentTokens = 0;
    // Absolute index into the full messages array
    let chunkStartAbsolute = chunkStart;

    for (let i = 0; i < messagesToChunk.length; i++) {
      const msg = messagesToChunk[i];
      let msgTokens = store.estimateTokens(msg);

      // Ignore attachment size if configured
      if (this.config.attachmentsIgnoreSize) {
        msgTokens = this.estimateTextOnlyTokens(msg);
      }

      currentChunk.push(msg);
      currentTokens += msgTokens;

      // Check if we should close this chunk
      const shouldClose =
        currentTokens >= this.config.targetChunkTokens &&
        currentChunk.length >= 4; // Minimum messages per chunk

      if (shouldClose) {
        const chunk = this.createChunk(
          this.chunks.length,
          chunkStartAbsolute,
          chunkStart + i + 1,
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
        chunkStartAbsolute = chunkStart + i + 1;
      }
    }

    // Handle remaining messages (add to last chunk or create new one)
    if (currentChunk.length >= 4) {
      const chunk = this.createChunk(
        this.chunks.length,
        chunkStartAbsolute,
        chunkStart + messagesToChunk.length,
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

    // Check if we have an existing compressed version
    const key = this.chunkKey(chunk);
    const existing = existingCompressed.get(key);
    if (existing) {
      chunk.compressed = true;
      chunk.diary = existing.diary;
    }

    return chunk;
  }

  private chunkKey(chunk: Chunk): string {
    // Key based on message IDs for stability
    return chunk.messages.map((m) => m.id).join(':');
  }

  private getRecentWindowStart(store: MessageStoreView): number {
    const messages = store.getAll();
    let tokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > this.config.recentWindowTokens) {
        let boundary = i + 1;
        // Don't split tool_use/tool_result pairs: if the first message in the
        // recent window is a tool_result, pull the boundary back to include
        // the preceding tool_use message with it.
        while (boundary > 0 && boundary < messages.length && this.hasToolResult(messages[boundary])) {
          boundary--;
        }
        return boundary;
      }
    }

    return 0;
  }

  /**
   * Index of the first message AFTER the head window.
   * Messages [0, headEnd) are preserved verbatim.
   */
  private getHeadWindowEnd(store: MessageStoreView): number {
    if (this.config.headWindowTokens <= 0) return 0;

    const messages = store.getAll();
    let tokens = 0;

    for (let i = 0; i < messages.length; i++) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > this.config.headWindowTokens) {
        let boundary = i;
        // Don't split tool_use/tool_result pairs: if the last message in the
        // head window contains tool_use blocks, pull the boundary back so the
        // tool_use and its tool_result fall outside the head window together.
        while (boundary > 0 && this.hasToolUse(messages[boundary - 1])) {
          boundary--;
        }
        return boundary;
      }
    }

    return messages.length;
  }

  private hasToolUse(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_use');
  }

  private hasToolResult(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_result');
  }

  private isChunkOldEnough(chunk: Chunk): boolean {
    // A chunk should be compressed if it's outside the recent window
    // This is already handled by rebuildChunks, but we check here for safety
    return true;
  }

  private async compressChunk(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    if (!ctx.membrane) {
      throw new Error('No membrane instance for compression');
    }

    // Build the compression request
    // Include prior context (previous compressed chunks + preceding messages)
    const priorContext = this.buildPriorContext(chunk, ctx);

    // Build the chunk content to summarize
    const chunkContent = this.formatChunkForCompression(chunk);

    // Support legacy config names, fall back to new defaults
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

  private buildPriorContext(chunk: Chunk, ctx: StrategyContext): Array<{
    participant: string;
    content: ContentBlock[];
  }> {
    const context: Array<{ participant: string; content: ContentBlock[] }> = [];

    // Add previous compressed chunks as diary pairs
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

    // Add some preceding messages for context (up to ~15k tokens)
    const messages = ctx.messageStore.getAll();
    const precedingStart = Math.max(0, chunk.startIndex - 50); // Rough estimate
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
      // Ignore image, document, audio, video
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

