import type { JsStore } from '@animalabs/chronicle';
import type { Membrane, NormalizedRequest, ContentBlock, CompleteOptions } from '@animalabs/membrane';
import { NativeFormatter } from '@animalabs/membrane';
import { phaseChannel } from '../phase-channel.js';
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
  ProtectedRange,
  PinLevelOptions,
  SearchQuery,
  SearchResult,
  RenderStats,
} from '../types/index.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';
import { getSummaryParentId } from '../types/strategy.js';
import { splitMixedToolMessages, stripUnpairedToolBlocks } from '../normalize-tool-messages.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Picker, OverBudgetError, type PickerChunk, type PickerInputs } from '../adaptive/picker.js';
import { FlatProfileStrategy } from '../adaptive/strategies/flat-profile.js';
import { KvStableStrategy } from '../adaptive/strategies/kv-stable.js';
import { OldestFirstStrategy } from '../adaptive/strategies/oldest-first.js';
import type {
  FoldingStrategy,
  FoldingBudget,
  FoldOp,
  ChunkId,
  SummaryId,
} from '../adaptive/folding-strategy.js';
import { chunkMessage, DEFAULT_CHUNKER_OPTIONS } from '../adaptive/chunker.js';
import type { MessageId } from '../types/message.js';
import type { IngressChunkResult } from '../types/strategy.js';

/**
 * Append a JSONL entry describing one compression LLM call to the path
 * given by `CONTEXT_MANAGER_COMPRESSION_LOG`. No-op if the env var isn't
 * set. Called at every L1 and merge LLM-call site so we can audit the
 * exact prompts and responses post-hoc — no reconstruction, no
 * assumption about whether the strategy code matches what produced
 * historical summaries.
 *
 * Failures to write are logged to stderr but don't propagate — logging
 * is non-essential observability and should never break compression.
 */
function logCompressionCall(entry: Record<string, unknown>): void {
  const logPath = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
    appendFileSync(logPath, line);
  } catch (err) {
    console.warn('compression log write failed:', err);
  }
}

/**
 * In-band marker shown to the summarizer just before the chunk it's
 * about to memorize. Primes attention without disrupting KV state —
 * the agent has seen this exact wording before every prior compression
 * in its history, so the model treats memory formation as a recurring
 * narrated event rather than a fresh instruction each time.
 *
 * Wording matches `hermes-autobio/plugins/autobio/compression.py`
 * `_MARKER` so the in-band primer is consistent across the codebase.
 */
const COMPRESSION_MARKER =
  'System: You will soon form a new memory, get ready. ' +
  'The messages that follow are the slice of recent experience you are ' +
  'about to compress. After them, write the memory in your own voice.';

/** Standard compression instruction for chat/general chunks. */
function formatInstruction(targetTokens: number): string {
  return (
    'Write the memory of events since the most recent memory system ' +
    'notification. Speak in the first person from your own perspective. ' +
    'Preserve concrete details — file paths, exact values, decisions, ' +
    `unresolved questions, the user\'s active asks. Target ~${targetTokens} ` +
    'tokens. Output only the memory body — no preamble, no section headers ' +
    'unless they help preservation, no meta-commentary about summarizing. ' +
    'Memorize only what actually happened in that slice: if it holds little ' +
    'beyond routine system traffic (heartbeats, empty turns, failure ' +
    'notices), a short memory saying so is correct — do not pad it by ' +
    're-narrating events you already remember from earlier as if they had ' +
    'just happened again.'
  );
}

/**
 * Compression instruction for chunks that are part of a substantially larger
 * message (≥ 2× the chunk's own token size).
 *
 * Avoids forcing a "document" or "message" frame — just describes the
 * experience: the agent has been reading a substantial piece of text, of
 * which the slice is a portion. Asks what reading was like and what was
 * learned. This naturally elicits first-person agent voice ("I read…", "I
 * learned…", "I noticed…") and preserves concrete content via the
 * "specific claims, names, dates" guidance.
 *
 * Rationale: when chunks are shards of a much larger user-shared message,
 * the chunk content is heavily first-person from someone other than the
 * agent. Asking "form a memory of what this contained" lets the model
 * adopt the dominant voice of the chunk content. Asking "what was reading
 * this like, what did you learn" forces the model to reflect from its own
 * vantage point — only the agent can describe what reading something was
 * like from its own perspective.
 */
function formatReadingChunkInstruction(
  totalTokens: number,
  targetTokens: number,
): string {
  return (
    `You have just been reading a substantial body of text — approximately ` +
    `${totalTokens} tokens total in this piece, of which what you just read ` +
    `is a portion. Earlier portions are in your memory above as your prior ` +
    `reflections; what comes after, you have not yet read.\n\n` +
    `Reflect on this reading: what was it like? What did you learn? What ` +
    `stood out? Be substantive — name the specific claims, frameworks, ` +
    `people, dates, and phrases that struck you. What is now in your ` +
    `understanding that wasn't before you read this portion?\n\n` +
    `Speak in your own voice as the one reading. Target ~${targetTokens} ` +
    `tokens. Output only the body of your reflection — no preamble.`
  );
}

/**
 * Merge instruction for L2/L3+ consolidation (conversation/general case).
 *
 * The model has just been shown content ONE LEVEL DEEPER than its
 * sources: raw messages for an L2 merge (sources are L1s), L1 memories
 * for an L3 merge (sources are L2s), etc. The instruction describes
 * the content the model just saw and asks for a consolidation at
 * `targetLevel`.
 */
function formatMergeInstruction(
  targetLevel: number,
  sourceLevelShown: number,
  targetTokens: number,
): string {
  const seenDescription =
    sourceLevelShown === 0
      ? 'the slices of recent experience above (raw conversation)'
      : `the L${sourceLevelShown} memories above`;
  return (
    `You have just reviewed ${seenDescription}, in chronological order. ` +
    `They cover the stretch of experience you are about to consolidate into a ` +
    `single L${targetLevel} memory. Write a memory that preserves the ` +
    `through-line: what happened, what was decided, what remains open, what ` +
    `concrete details future you will want to reach for. Speak in the first ` +
    `person. Target ~${targetTokens} tokens. Output only the memory body — ` +
    `no preamble, no meta-commentary about summarizing.`
  );
}

/**
 * Reading-mode merge instruction. Used when the merge's leaf messages
 * are all part of a substantially-larger sharded message — i.e., the
 * agent has been reading a doc/long-message rather than conversing.
 *
 * Analogous to formatReadingChunkInstruction: avoids forcing a
 * "document" or "message" frame, asks what reading the stretch was
 * like and what was understood. Forces the agent's vantage point —
 * only the reader can describe what reading was like — and so prevents
 * the drift into the content author's voice that happens when the
 * instruction asks for an impersonal summary.
 */
function formatReadingMergeInstruction(
  targetLevel: number,
  sourceLevelShown: number,
  totalTokens: number,
  targetTokens: number,
): string {
  const seenDescription =
    sourceLevelShown === 0
      ? 'the portions of text you read above (raw passages from a larger piece)'
      : `your earlier L${sourceLevelShown} reflections above on portions you read`;
  return (
    `You have just re-experienced ${seenDescription}, in chronological order. ` +
    `They cover a contiguous stretch of a substantial body of text you have ` +
    `been reading — approximately ${totalTokens} tokens in total across all ` +
    `of it. The portions above cover the stretch you are now consolidating ` +
    `at L${targetLevel}.\n\n` +
    `Reflect across the stretch: what was it like, reading these portions ` +
    `together? What did you come to understand that you couldn't have from ` +
    `any single portion alone? What recurring patterns, frameworks, or ` +
    `concerns emerged? Be substantive — name the specific claims, people, ` +
    `dates, and phrases that defined this stretch of your reading.\n\n` +
    `Speak in your own voice as the one who read these portions. Target ` +
    `~${targetTokens} tokens. Output only the body of your consolidation — ` +
    `no preamble.`
  );
}

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
  /** ID of the L1 SummaryEntry (hierarchical mode) */
  summaryId?: string;
  /** Phase type tag (set by KnowledgeStrategy for semantic chunking) */
  phaseType?: string;
  /** ID of the persisted ChunkRecord backing this chunk (chunk persistence). */
  recordId?: string;
}

/**
 * Persisted chunk boundary, one per CLOSED chunk, stored in the
 * `autobio:chunks` chronicle state slot (append_log, branch-aware).
 *
 * Records OWN the past: once a chunk closes, its membership is a persisted
 * fact — rebuilds and restarts materialize chunks from records instead of
 * recomputing boundaries from the running token sum. This is the fix for the
 * 2026-07 re-consolidation storms: boundary inputs (config knobs, head
 * window, token estimates, message mutations) could shift across restarts,
 * the old exact-sourceIds-match recovery then failed, and whole stretches of
 * already-summarized history were re-compressed into duplicate L1s.
 *
 * Membership is by message ID (never index), so edits/redactions degrade a
 * record gracefully instead of re-keying its neighbors.
 */
export interface ChunkRecord {
  /** Stable record id ("c-<n>"). */
  id: string;
  /** Exact message IDs of the closed chunk, in order. */
  sourceIds: string[];
  /** Whether the chunk's L1 summary has been produced. */
  compressed: boolean;
  /** ID of the L1 SummaryEntry, once compressed. */
  summaryId?: string;
  /** Phase type tag (KnowledgeStrategy semantic chunking). */
  phaseType?: string;
}

/**
 * Point-in-time snapshot of compression progress, returned from
 * `AutobiographicalStrategy.getProgressSnapshot()`. External observers
 * (warmup scripts, dashboards) use this to track convergence without
 * reaching into the strategy's protected fields.
 */
export interface AutobiographicalProgressSnapshot {
  /** All chunks the strategy is tracking, compressed or not. */
  totalChunks: number;
  /** Chunks that already have an L1 summary. */
  chunksCompressed: number;
  /** Chunks queued for L1 compression. */
  l1QueueLength: number;
  /** Pending L1→L2 and L2→L3 merges. */
  mergeQueueLength: number;
  /** Stored summary counts per level (1 = raw L1, 2 = L1→L2 merge, 3 = L2→L3 merge). */
  summaryCounts: { l1: number; l2: number; l3: number };
  /** True if a compression or merge LLM call is currently in flight. */
  pending: boolean;
}

/**
 * Validate + normalize the optional V2 pin fold-depth bounds. Returns only the
 * fields that are present and valid (non-negative integers), so a classic pin
 * with no bounds persists exactly as before. `level` takes precedence over
 * `maxLevel` (pin-at-k is stronger than a cap), so they're never both emitted.
 */
function normalizePinLevels(opts?: PinLevelOptions): { level?: number; maxLevel?: number } {
  const clean = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  const level = clean(opts?.level);
  if (level !== undefined) return { level };
  const maxLevel = clean(opts?.maxLevel);
  return maxLevel !== undefined ? { maxLevel } : {};
}

/**
 * Drop empty text blocks (`{type:'text', text:''}` or whitespace-only). The
 * Anthropic API rejects them with 400 "text content blocks must be non-empty",
 * which — thrown inside the speculative-compression drain — halts ALL
 * compression. Non-text blocks (tool_use/tool_result/image) pass through
 * unchanged, so tool pairing is preserved; callers drop any message left with
 * an empty content array.
 */
function stripEmptyTextBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => {
    if (b.type !== 'text') return true;
    const text = (b as { text?: unknown }).text;
    return typeof text === 'string' && text.trim().length > 0;
  });
}

/**
 * Strip `thinking` / `redacted_thinking` blocks from compression INPUT.
 *
 * The summarizer must never be handed the agent's own reasoning:
 *  (a) signed thinking is only valid verbatim in the turn that produced it —
 *      replaying it into a rewritten summarize request corrupts the signature;
 *  (b) asking the model to summarize its own reasoning reads as reproducing /
 *      duplicating model output → `reasoning_extraction` refusal, which returns
 *      empty (→ "empty L1 summary, chunk left raw") or, worse, produces a
 *      summary that reproduces the reasoning as text — which then trips the
 *      SAME classifier on the MAIN thread once that summary is rendered.
 * Thinking is scratch work, not history (the same rationale already applied to
 * the summarizer's OUTPUT). Drop it from the input too.
 */
function stripThinkingBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
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
  /**
   * Monotonic counter of tick() operations that actually processed a queue item
   * (compressed a chunk or executed a merge). `driveSpeculativeDrain` recurses
   * while this advances — a length-delta check would falsely read "no progress"
   * when a productive tick also enqueues a follow-on item (net queue length
   * unchanged), halting the drain with work still queued.
   */
  protected _drainProgress = 0;

  /**
   * Chunks (keyed by their LAST message id — chunk membership is immutable
   * once closed) whose L1 was explicitly demanded by a picker `produce` op.
   * Demanded chunks bypass the `l1HoldbackChunks` window in `rebuildChunks`:
   * speculation waits, demand doesn't. Entries become inert once the chunk
   * compresses (compressed chunks are never re-queued), so no cleanup needed.
   */
  protected _demandedL1Chunks = new Set<MessageId>();

  /**
   * In-memory mirror of the persisted chunk records (autobio:chunks slot).
   * Loaded in `loadPersistedState`, appended to when a chunk closes,
   * updated by ID when its L1 lands.
   */
  protected chunkRecords: ChunkRecord[] = [];
  protected chunkIdCounter = 0;
  /**
   * Fail-closed latch: set when most persisted records resolve to zero live
   * messages (the messages-chain-break signature). While set, NO compression
   * runs — duplicate memories are strictly worse than delayed compression.
   */
  protected chunkRecordsOrphaned = false;
  private _orphanWarned = false;
  /** Record ids whose compression was refused by the L1 overlap guard. */
  private _overlapBlocked = new Set<string>();

  // Hierarchical state
  protected summaries: SummaryEntry[] = [];
  protected summaryIdCounter = 0;
  protected mergeQueue: Array<{ level: SummaryLevel; sourceIds: string[] }> = [];
  protected nativeFormatter = new NativeFormatter();

  /** Message ID from which the head window starts. null = start from message 0. */
  protected headWindowStartId: string | null = null;
  /** Cached result of getHeadWindowStartIndex to avoid repeated linear scans. */
  private _cachedHeadStartIndex: { id: string | null; msgCount: number; result: number } | null = null;

  /** Chronicle store for persistent state. Set in `initialize()`. */
  protected store: JsStore | null = null;
  /** Namespace for state-id scoping. Set in `initialize()`. */
  protected ns: string = '';
  protected get summariesStateId(): string { return `${this.ns}/autobio:summaries`; }
  protected get chunksStateId(): string { return `${this.ns}/autobio:chunks`; }
  protected get counterStateId(): string { return `${this.ns}/autobio:counter`; }
  protected get mergeQueueStateId(): string { return `${this.ns}/autobio:mergeQueue`; }
  protected get pinsStateId(): string { return `${this.ns}/autobio:pins`; }
  protected get resolutionsStateId(): string { return `${this.ns}/autobio:resolutions`; }
  protected get locksStateId(): string { return `${this.ns}/autobio:locks`; }
  protected get calibrationStateId(): string { return `${this.ns}/autobio:calibration`; }

  /** Protected ranges (pins + documents). Loaded from chronicle in initialize. */
  protected pins: ProtectedRange[] = [];
  /** Monotonically increasing counter for pin ids. Persisted as part of the pins snapshot. */
  protected pinIdCounter = 0;

  /**
   * Per-message resolution state for the adaptive-resolution picker.
   *  - Key: MessageId
   *  - Value: currentResolution (0 = render raw, k>0 = render L_k recall)
   *
   * Maintained only when `config.adaptiveResolution` is true. Loaded from
   * the chronicle on `initialize()` and persisted via the resolutions state
   * slot so resolutions survive process restart and follow branches.
   */
  protected resolutions: Map<MessageId, number> = new Map();

  /**
   * Per-message lock state for the adaptive-resolution picker. Set via the
   * programmatic `lockChunk(id)` API on the strategy. Locked messages are
   * skipped by the picker. Persisted via the locks state slot.
   */
  protected locked: Set<MessageId> = new Set();

  /** Lazy picker instance, built from config.foldingStrategy. */
  private _adaptivePicker: Picker | null = null;

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
    // Adaptive-resolution defaults
    if (this.config.adaptiveResolution) {
      this.config.foldingStrategy ??= 'flat-profile';
      this.config.compressionSlackRatio ??= 0.1;
      this.config.speculativeProduction ??= true;
    }
  }

  /**
   * Lock a message so the adaptive picker won't change its resolution.
   * No-op when adaptiveResolution is false. Set-only programmatic API per
   * the design (no agent-facing tool in V1). Persisted to chronicle.
   */
  lockChunk(id: MessageId): void {
    if (this.locked.has(id)) return;
    this.locked.add(id);
    this.persistLocks();
  }

  /**
   * Unlock a message so the adaptive picker may again change its resolution.
   * No-op when adaptiveResolution is false. Persisted to chronicle.
   */
  unlockChunk(id: MessageId): void {
    if (!this.locked.has(id)) return;
    this.locked.delete(id);
    this.persistLocks();
  }

  /**
   * Ingestion-time chunking hook.
   *
   * Active only when `config.adaptiveResolution` is true. Inspects the
   * incoming message's text content; if its approximate token count
   * exceeds the chunker's threshold, splits it into shards with a stable
   * shared `bodyGroupId`. The framework then stores each shard as its own
   * StoredMessage, and the render path concatenates them back into one
   * API message at compile time (preserving KV cache structure).
   *
   * Multi-block content: text blocks are concatenated for chunking, then
   * the resulting shards are emitted as text blocks. Non-text blocks
   * (images, tool results) are passed through unchanged on the first
   * shard only — they don't get split.
   *
   * See `docs/adaptive-resolution-design.md` §3.6.
   */
  chunkIngressMessage(participant: string, content: ContentBlock[]): IngressChunkResult | null {
    if (!this.config.adaptiveResolution) return null;

    // Separate text and non-text blocks.
    const textParts: string[] = [];
    const nonTextBlocks: ContentBlock[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else {
        nonTextBlocks.push(block);
      }
    }
    if (textParts.length === 0) return null;
    const combined = textParts.join('');

    // Threshold and shard size derive from the strategy's existing
    // targetChunkTokens setting: a message over 2x targetChunkTokens
    // gets sharded into pieces of ~targetChunkTokens each. This keeps
    // doc shards the same size as chat-message chunks for L1 production
    // consistency.
    const target = this.config.targetChunkTokens ?? DEFAULT_CHUNKER_OPTIONS.chunkSize;
    const chunkerOpts = {
      chunkThreshold: target * 2,
      chunkSize: target,
      charsPerToken: DEFAULT_CHUNKER_OPTIONS.charsPerToken,
    };

    const sharded = chunkMessage(combined, chunkerOpts);
    if (!sharded.wasSharded) return null;

    // Build IngressChunkResult. Non-text blocks (if any) go on shard 0
    // so the agent doesn't lose attachments. They're outside the chunker's
    // concern but should still be available on the first shard.
    const shards = sharded.shards.map((s) => ({
      content: ([{ type: 'text', text: s.content }] as ContentBlock[]).concat(
        s.index === 0 ? nonTextBlocks : []
      ),
      shardIndex: s.index,
    }));

    return {
      bodyGroupId: sharded.bodyGroupId,
      shards,
    };
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    // Bind to the chronicle store + namespace for persistent strategy state.
    this.store = ctx.store;
    this.ns = ctx.namespace;
    this.registerStates();
    this.loadPersistedState();

    // Restore headWindowStartId from last topic transition message
    const messages = ctx.messageStore.getAll();
    this.headWindowStartId = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (this.isTopicTransitionMessage(messages[i])) {
        this.headWindowStartId = messages[i].id;
        break;
      }
    }
    // Legacy stores (pre chunk-persistence) have L1 summaries but no chunk
    // records — synthesize records from L1 sourceIds before the first
    // rebuild, so covered ground is owned and never re-compressed.
    this.migrateChunkRecords(ctx.messageStore);
    this.rebuildChunks(ctx.messageStore);
    // Kick the merge ladder for pre-existing unmerged summaries. Normally a
    // compression/merge completion does this, but a store that boots with a
    // backlog above threshold and an empty queue (e.g. after a pyramid
    // repair pruned duplicates and un-merged survivors) would otherwise
    // never start consolidating. Idempotent: already-queued/merged sources
    // are skipped.
    if (this.config.hierarchical && !this.chunkRecordsOrphaned) {
      this.checkMergeThreshold();
    }
  }

  /**
   * Whether chunk boundaries are persisted to the `autobio:chunks` slot and
   * own the past. Subclasses with their own chunking (KnowledgeStrategy's
   * semantic phases) opt out and keep the legacy recompute-every-rebuild
   * behavior.
   */
  protected get chunkPersistenceEnabled(): boolean {
    return true;
  }

  /**
   * One-time lazy migration: a store with L1 summaries but an empty chunks
   * slot predates chunk persistence. Each L1's sourceIds ARE the historical
   * chunk boundary — synthesize a compressed record per L1, in message
   * order. Stale generations from the old partial-tail compression bug
   * (an L1 whose messages are ALL already covered by records synthesized so
   * far — prefix families, same-range duplicates) get NO record; coverage is
   * what blocks re-compression, and the repair tooling prunes their content
   * separately.
   */
  protected migrateChunkRecords(store: MessageStoreView): void {
    if (!this.chunkPersistenceEnabled || !this.store) return;
    if (this.chunkRecords.length > 0) return;
    const l1s = this.summaries.filter(s => s.level === 1 && Array.isArray(s.sourceIds) && s.sourceIds.length > 0);
    if (l1s.length === 0) return;

    const msgIndex = new Map<string, number>();
    store.getAll().forEach((m, i) => msgIndex.set(m.id, i));

    // Sort by (start position asc, span length desc) so at each starting
    // point the LONGEST generation claims the ground first.
    const sorted = [...l1s].sort((a, b) => {
      const sa = msgIndex.get(a.sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
      const sb = msgIndex.get(b.sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || b.sourceIds.length - a.sourceIds.length;
    });

    const covered = new Set<string>();
    let skippedStale = 0;
    let skippedGhost = 0;
    for (const s of sorted) {
      // An L1 none of whose messages exist anymore can't own live ground.
      if (!s.sourceIds.some(id => msgIndex.has(id))) { skippedGhost++; continue; }
      // Fully-covered = stale generation / contained duplicate.
      if (s.sourceIds.every(id => covered.has(id))) { skippedStale++; continue; }
      for (const id of s.sourceIds) covered.add(id);
      this.appendChunkRecord({
        id: `c-${this.chunkIdCounter++}`,
        sourceIds: [...s.sourceIds],
        compressed: true,
        summaryId: s.id,
        ...(s.phaseType ? { phaseType: s.phaseType } : {}),
      });
    }
    console.warn(
      `[autobiographical] chunk-persistence migration: ${l1s.length} L1s → ` +
      `${this.chunkRecords.length} records (${skippedStale} stale generations, ` +
      `${skippedGhost} fully-orphaned L1s skipped)`,
    );
  }

  /** Append a record to the chunks slot + in-memory mirror. */
  protected appendChunkRecord(record: ChunkRecord): void {
    this.chunkRecords.push(record);
    this.store?.appendToStateJson(this.chunksStateId, record);
  }

  /**
   * Mark a chunk's record compressed, linking its L1. Resolves the log slot
   * by ID against the persisted array — never by in-memory index (see
   * setMergedInto for the clobber this avoids).
   */
  protected markChunkRecordCompressed(recordId: string | undefined, summaryId: string): void {
    if (!this.chunkPersistenceEnabled || !recordId) return;
    const rec = this.chunkRecords.find(r => r.id === recordId);
    if (!rec) return;
    rec.compressed = true;
    rec.summaryId = summaryId;
    if (!this.store) return;
    const stored = this.store.getStateJson(this.chunksStateId);
    if (!Array.isArray(stored)) return;
    const payload = Buffer.from(JSON.stringify(rec));
    let found = false;
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i] as ChunkRecord | null;
      if (item && item.id === recordId) {
        this.store.editStateItem(this.chunksStateId, i, payload);
        found = true;
      }
    }
    if (!found) {
      console.warn(
        `[autobiographical] markChunkRecordCompressed: ${recordId} not found in persisted chunk log`,
      );
    }
  }

  /**
   * Register the three Chronicle state slots this strategy uses.
   * Idempotent — chronicle throws if a state is already registered, which we
   * swallow (the existing slot is what we want).
   */
  protected registerStates(): void {
    if (!this.store) return;
    try {
      this.store.registerState({
        id: this.summariesStateId,
        strategy: 'append_log',
        deltaSnapshotEvery: 50,
        fullSnapshotEvery: 10,
      });
    } catch { /* already registered */ }
    if (this.chunkPersistenceEnabled) {
      try {
        this.store.registerState({
          id: this.chunksStateId,
          strategy: 'append_log',
          deltaSnapshotEvery: 50,
          fullSnapshotEvery: 10,
        });
      } catch { /* already registered */ }
    }
    try {
      this.store.registerState({
        id: this.counterStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.mergeQueueStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.pinsStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.calibrationStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    // Adaptive-resolution state slots — only registered when the flag is on
    // so chronicles without the flag don't accumulate unused slots.
    if (this.config.adaptiveResolution) {
      try {
        this.store.registerState({
          id: this.resolutionsStateId,
          strategy: 'snapshot',
        });
      } catch { /* already registered */ }
      try {
        this.store.registerState({
          id: this.locksStateId,
          strategy: 'snapshot',
        });
      } catch { /* already registered */ }
    }
  }

  /**
   * Load summaries, counter, and pending merges from chronicle into the
   * in-memory mirrors. Called on every (re)initialize so branch switches
   * pick up the new branch's state.
   */
  protected loadPersistedState(): void {
    if (!this.store) {
      this.summaries = [];
      this.summaryIdCounter = 0;
      this.mergeQueue = [];
      this.pins = [];
      this.pinIdCounter = 0;
      this.chunkRecords = [];
      this.chunkIdCounter = 0;
      return;
    }

    if (this.chunkPersistenceEnabled) {
      const records = this.store.getStateJson(this.chunksStateId);
      this.chunkRecords = (Array.isArray(records) ? (records as ChunkRecord[]) : [])
        .filter(r => r && typeof r.id === 'string' && Array.isArray(r.sourceIds) && r.sourceIds.length > 0);
      this.chunkIdCounter = this.chunkRecords.reduce((max, r) => {
        const n = Number(r.id.replace(/^c-/, ''));
        return Number.isFinite(n) && n >= max ? n + 1 : max;
      }, 0);
      this.chunkRecordsOrphaned = false;
      this._orphanWarned = false;
      this._overlapBlocked.clear();
    }
    const summaries = this.store.getStateJson(this.summariesStateId);
    const loaded = Array.isArray(summaries) ? (summaries as SummaryEntry[]) : [];
    // Drop empty-content summaries (bugged/empty generations from before the
    // production guards). Recalling or merging one yields an empty text block →
    // Anthropic 400 "content must be non-empty". Never let them re-enter memory.
    const nonEmpty = loaded.filter(s => s && typeof s.content === 'string' && s.content.trim().length > 0);
    const droppedEmpty = loaded.length - nonEmpty.length;
    const removedEmptyIds = new Set(
      loaded
        .filter(s => s && (typeof s.content !== 'string' || s.content.trim().length === 0))
        .map(s => s.id),
    );
    if (droppedEmpty > 0) console.warn(`[autobiographical] dropped ${droppedEmpty} empty summary(ies) on load`);
    // Dedupe by id, keeping the copy with mergedInto set (position of first
    // occurrence preserved). Duplicate-id copies with diverging merge state
    // exist in stores touched by the pre-fix setMergedInto index-desync bug;
    // without dedupe, the plain copy stays on the unmerged frontier and its
    // content renders twice (once itself, once via its parent's merge).
    const byId = new Map<string, SummaryEntry>();
    for (const s of nonEmpty) {
      const prev = byId.get(s.id);
      if (!prev) byId.set(s.id, s);
      else if (!prev.mergedInto && s.mergedInto) byId.set(s.id, s);
    }
    const dupes = nonEmpty.length - byId.size;
    if (dupes > 0) console.warn(`[autobiographical] deduped ${dupes} duplicate summary id(s) on load`);
    // Dropping an invalid parent is only half the repair. Its children may
    // still carry `mergedInto: <dropped-id>`, which makes them simultaneously
    // unavailable to the picker (no parent to render) and ineligible for a
    // replacement merge (they still look merged). Clear every dangling edge
    // and persist the canonicalized array so the poison does not return on
    // every restart.
    let danglingParents = 0;
    this.summaries = [...byId.values()].map((summary) => {
      if (!summary.mergedInto || byId.has(summary.mergedInto)) return summary;
      danglingParents++;
      const { mergedInto: _dropped, ...repaired } = summary;
      return repaired as SummaryEntry;
    });
    if (droppedEmpty > 0 || dupes > 0 || danglingParents > 0) {
      this.store.setStateJson(this.summariesStateId, this.summaries);
      console.warn(
        `[autobiographical] repaired summary state: removed ${droppedEmpty} empty, ` +
          `deduped ${dupes}, cleared ${danglingParents} dangling parent pointer(s)`,
      );
    }

    // An invalid L1 may also be referenced by a persisted chunk record. Make
    // that chunk compressible again instead of leaving it permanently marked
    // complete with no summary behind it.
    if (this.chunkPersistenceEnabled && this.chunkRecords.length > 0) {
      const validL1Ids = new Set(this.summaries.filter(s => s.level === 1).map(s => s.id));
      let repairedChunkRecords = 0;
      this.chunkRecords = this.chunkRecords.map((record) => {
        if (!record.compressed || (record.summaryId && validL1Ids.has(record.summaryId))) {
          return record;
        }
        repairedChunkRecords++;
        const { summaryId: _dropped, ...rest } = record;
        return { ...rest, compressed: false };
      });
      if (repairedChunkRecords > 0) {
        this.store.setStateJson(this.chunksStateId, this.chunkRecords);
        console.warn(
          `[autobiographical] repaired ${repairedChunkRecords} chunk record(s) with missing L1 summaries`,
        );
      }
    }

    const counter = this.store.getStateJson(this.counterStateId);
    this.summaryIdCounter = typeof counter === 'number' ? counter : 0;

    const queue = this.store.getStateJson(this.mergeQueueStateId);
    this.mergeQueue = Array.isArray(queue)
      ? (queue as Array<{ level: SummaryLevel; sourceIds: string[] }>)
      : [];
    const validMergeQueue = this.mergeQueue.filter(
      merge => !merge.sourceIds.some(id => removedEmptyIds.has(id) && !byId.has(id)),
    );
    if (validMergeQueue.length !== this.mergeQueue.length) {
      const removed = this.mergeQueue.length - validMergeQueue.length;
      this.mergeQueue = validMergeQueue;
      this.store.setStateJson(this.mergeQueueStateId, this.mergeQueue);
      console.warn(`[autobiographical] removed ${removed} merge queue item(s) with missing sources`);
    }

    const pinsState = this.store.getStateJson(this.pinsStateId);
    if (pinsState && typeof pinsState === 'object' && Array.isArray((pinsState as { pins?: unknown }).pins)) {
      const ps = pinsState as { pins: ProtectedRange[]; counter?: number };
      this.pins = ps.pins;
      this.pinIdCounter = typeof ps.counter === 'number' ? ps.counter : ps.pins.length;
    } else {
      this.pins = [];
      this.pinIdCounter = 0;
    }

    // Adaptive-resolution state — only present when flag was/is on
    if (this.config.adaptiveResolution) {
      const resState = this.store.getStateJson(this.resolutionsStateId);
      this.resolutions = new Map();
      if (resState && typeof resState === 'object') {
        for (const [k, v] of Object.entries(resState as Record<string, unknown>)) {
          if (typeof v === 'number' && v > 0) {
            this.resolutions.set(k, v);
          }
        }
      }
      const lockState = this.store.getStateJson(this.locksStateId);
      this.locked = new Set();
      if (Array.isArray(lockState)) {
        for (const id of lockState) {
          if (typeof id === 'string') this.locked.add(id);
        }
      }
    }
  }

  /** Persist the current pins + counter as a single snapshot. */
  protected persistPins(): void {
    this.store?.setStateJson(this.pinsStateId, {
      pins: this.pins,
      counter: this.pinIdCounter,
    });
  }

  /** Persist the current resolutions snapshot. Only stores non-zero entries
   *  to keep the slot compact. */
  protected persistResolutions(): void {
    if (!this.store) return;
    const out: Record<string, number> = {};
    for (const [id, level] of this.resolutions) {
      if (level > 0) out[id] = level;
    }
    this.store.setStateJson(this.resolutionsStateId, out);
  }

  /** Persist the current locked-id snapshot. */
  protected persistLocks(): void {
    if (!this.store) return;
    this.store.setStateJson(this.locksStateId, Array.from(this.locked));
  }

  // ============================================================================
  // Pins / documents (protected ranges)
  // ============================================================================

  /**
   * Pin a range of messages so they aren't compressed and render raw at
   * their original position. Returns the pin id.
   */
  pinRange(firstMessageId: string, lastMessageId: string, opts?: PinLevelOptions): string {
    const id = `pin-${this.pinIdCounter++}`;
    this.pins.push({
      id,
      firstMessageId,
      lastMessageId,
      kind: 'pin',
      name: opts?.name,
      created: Date.now(),
      ...normalizePinLevels(opts),
    });
    this.persistPins();
    return id;
  }

  /**
   * Mark a single message as a "document" — semantically a body of
   * information the agent wants to retain in full. Functionally a
   * single-message pin with `kind: 'document'`.
   */
  markDocument(messageId: string, opts?: PinLevelOptions): string {
    const id = `pin-${this.pinIdCounter++}`;
    this.pins.push({
      id,
      firstMessageId: messageId,
      lastMessageId: messageId,
      kind: 'document',
      name: opts?.name,
      created: Date.now(),
      ...normalizePinLevels(opts),
    });
    this.persistPins();
    return id;
  }

  /**
   * V2 dynamic pin-at-level-k convenience: fix a range to render at EXACTLY
   * fold level `level` (0 = raw). Honored only by `foldingStrategy: 'kv-stable'`;
   * other strategies fall back to treating the range as raw. Equivalent to
   * `pinRange(first, last, { level })`.
   */
  pinAtLevel(firstMessageId: string, lastMessageId: string, level: number, opts?: { name?: string }): string {
    return this.pinRange(firstMessageId, lastMessageId, { name: opts?.name, level });
  }

  /** Remove a pin or document mark by id. Returns true if removed. */
  unpin(pinId: string): boolean {
    const before = this.pins.length;
    this.pins = this.pins.filter(p => p.id !== pinId);
    if (this.pins.length < before) {
      this.persistPins();
      return true;
    }
    return false;
  }

  /** Read-only list of all current pins. */
  listPins(): ReadonlyArray<ProtectedRange> {
    return this.pins;
  }

  // ============================================================================
  // Search (gap #7)
  // ============================================================================

  /**
   * Look up a single summary by id. Returns null if not found.
   */
  getSummary(id: string): SummaryEntry | null {
    return this.summaries.find(s => s.id === id) ?? null;
  }

  /**
   * Search summaries by substring or regex over their content.
   *
   * Result ordering: matches by descending hit count, then by descending
   * `created` timestamp (newest first within the same hit count).
   *
   * Default behavior: only "live" (unmerged) summaries are searched. Set
   * `includeMerged: true` to also include summaries that have been folded
   * into a higher level.
   */
  searchSummaries(query: SearchQuery): SearchResult[] {
    const limit = query.limit ?? 50;
    const includeMerged = query.includeMerged ?? false;

    // Build the matcher
    let matcher: ((content: string) => number) | null = null;
    if (query.regex) {
      const flags = query.regex.flags.includes('g') ? query.regex.flags : query.regex.flags + 'g';
      const re = new RegExp(query.regex.source, flags);
      matcher = (content: string) => {
        const matches = content.match(re);
        return matches ? matches.length : 0;
      };
    } else if (query.text) {
      const needle = query.text.toLowerCase();
      matcher = (content: string) => {
        const hay = content.toLowerCase();
        let count = 0;
        let idx = 0;
        while ((idx = hay.indexOf(needle, idx)) !== -1) {
          count++;
          idx += needle.length || 1;
        }
        return count;
      };
    } else {
      // No pattern: every summary "matches" once
      matcher = () => 1;
    }

    const levelsFilter = query.levels && query.levels.length > 0 ? new Set(query.levels) : null;

    const results: SearchResult[] = [];
    for (const s of this.summaries) {
      if (!includeMerged && s.mergedInto) continue;
      if (levelsFilter && !levelsFilter.has(s.level)) continue;
      const matches = matcher(s.content);
      if (matches > 0) {
        results.push({ summary: s, matches });
      }
    }

    results.sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return b.summary.created - a.summary.created;
    });

    return results.slice(0, limit);
  }

  /**
   * Whether a given message position is inside any protected range.
   * Uses a position map (computed by caller) so callers can avoid
   * repeated per-message lookups in tight loops.
   */
  protected isPositionPinned(position: number, pinPositions: Set<number>): boolean {
    return pinPositions.has(position);
  }

  /**
   * Build a set of message-store positions covered by any pin. O(N pins · K range).
   * Returns positions for which the message exists; orphan pins (deleted
   * messages) are silently skipped.
   */
  protected pinnedPositions(messages: StoredMessage[]): Set<number> {
    if (this.pins.length === 0) return new Set();
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      positionOf.set(messages[i].id, i);
    }
    const out = new Set<number>();
    for (const pin of this.pins) {
      const first = positionOf.get(pin.firstMessageId);
      const last = positionOf.get(pin.lastMessageId);
      if (first === undefined || last === undefined) continue;
      const lo = Math.min(first, last);
      const hi = Math.max(first, last);
      for (let i = lo; i <= hi; i++) out.add(i);
    }
    return out;
  }

  /**
   * Resolve the V2 dynamic-pin fold-depth bounds (`ProtectedRange.level` /
   * `maxLevel`) to message positions. Only pins that carry a bound appear; a
   * classic raw pin (no bound) is absent here and handled by `pinnedPositions`.
   * When ranges overlap, the FINEST requirement wins (lowest effective level):
   * a fixed `level` clamps both ends; a `maxLevel` only caps depth. Honored
   * solely by the KV-stable controller — see `ProtectedRange`.
   */
  protected pinLevelBounds(messages: StoredMessage[]): Map<number, { level?: number; maxLevel?: number }> {
    const out = new Map<number, { level?: number; maxLevel?: number }>();
    if (this.pins.length === 0) return out;
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) positionOf.set(messages[i].id, i);

    for (const pin of this.pins) {
      if (pin.level === undefined && pin.maxLevel === undefined) continue;
      const first = positionOf.get(pin.firstMessageId);
      const last = positionOf.get(pin.lastMessageId);
      if (first === undefined || last === undefined) continue;
      const lo = Math.min(first, last);
      const hi = Math.max(first, last);
      for (let i = lo; i <= hi; i++) {
        const prev = out.get(i) ?? {};
        // A fixed level is the strongest constraint; when two pins fix the same
        // position, the shallower (lower) level wins (finest requirement).
        if (pin.level !== undefined) {
          prev.level = prev.level === undefined ? pin.level : Math.min(prev.level, pin.level);
        } else if (pin.maxLevel !== undefined) {
          prev.maxLevel = prev.maxLevel === undefined ? pin.maxLevel : Math.min(prev.maxLevel, pin.maxLevel);
        }
        out.set(i, prev);
      }
    }
    return out;
  }

  /**
   * Append a summary to the in-memory list and to the chronicle AppendLog.
   * Single point so subclasses inherit persistence.
   */
  protected pushSummary(entry: SummaryEntry): void {
    if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
      throw new Error(
        `[autobiographical] refusing to persist empty summary ${entry.id} at L${entry.level}`,
      );
    }
    this.summaries.push(entry);
    this.store?.appendToStateJson(this.summariesStateId, entry);
  }

  /**
   * Mark a summary as merged into a higher-level summary, updating the
   * chronicle copy at the same index. Index is the position in `this.summaries`.
   */
  /**
   * Token-budget cap for recall-pair summary sets. Walks newest→oldest
   * keeping each summary that still fits; skips (rather than breaks at)
   * a summary that would put us over budget, so a heterogeneous set
   * fills the remaining slots with smaller siblings instead of stopping
   * at the first oversized one. The kept set is re-sorted chronologically.
   *
   * Used by both `compressChunkHierarchical` (the L1 compression prompt
   * recall pairs) and `executeMerge` (the merge prompt recall pairs).
   * Without the cap, both sites grow their recall set linearly with
   * conversation length and overflow the 200k window around the same
   * point — observed empirically at ~chunk 118 in a 4000-message import.
   *
   * Per-summary +50 token overhead accounts for the "[CM] Recall memory
   * <id>." question turn that wraps each recall body. Rough but defensive.
   */
  protected capRecallPairs(
    summariesChronological: SummaryEntry[],
    maxTokens: number,
  ): { kept: SummaryEntry[]; keptTokens: number } {
    const kept: SummaryEntry[] = [];
    let total = 0;
    for (let i = summariesChronological.length - 1; i >= 0; i--) {
      const s = summariesChronological[i]!;
      const est = (s.tokens ?? Math.ceil(s.content.length / 4)) + 50;
      if (total + est > maxTokens) continue;
      kept.push(s);
      total += est;
    }
    kept.reverse();
    return { kept, keptTokens: total };
  }

  protected setMergedInto(entry: SummaryEntry, mergedIntoId: string): void {
    entry.mergedInto = mergedIntoId;
    if (!this.store) return;
    // Resolve the log position by ID against the PERSISTED array — never by
    // in-memory index. `loadPersistedState` filters empty-content summaries
    // out of `this.summaries` while they remain in the log, so after a reload
    // the in-memory index is shifted relative to the log slot. Editing by
    // in-memory index wrote merge-updates onto NEIGHBORING entries, silently
    // clobbering them (4 summaries lost in the 2026-07 Lena incident, leaving
    // duplicate-id copies with diverging mergedInto). Update every stored
    // copy with this id so past duplicates converge too.
    const stored = this.store.getStateJson(this.summariesStateId);
    if (!Array.isArray(stored)) return;
    let found = false;
    const payload = Buffer.from(JSON.stringify(entry));
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i] as SummaryEntry | null;
      if (item && item.id === entry.id) {
        this.store.editStateItem(this.summariesStateId, i, payload);
        found = true;
      }
    }
    if (!found) {
      console.warn(
        `[autobiographical] setMergedInto: ${entry.id} not found in persisted summary log — merge state not persisted`,
      );
    }
  }

  /**
   * Allocate the next summary-id counter value and persist the new counter.
   */
  protected nextSummaryIdCounter(): number {
    const value = this.summaryIdCounter++;
    this.store?.setStateJson(this.counterStateId, this.summaryIdCounter);
    return value;
  }

  /**
   * Push to the merge queue and persist the new queue snapshot.
   */
  protected enqueueMerge(merge: { level: SummaryLevel; sourceIds: string[] }): void {
    this.mergeQueue.push(merge);
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
  }

  /**
   * Pop from the merge queue and persist the new queue snapshot.
   */
  protected dequeueMerge(): { level: SummaryLevel; sourceIds: string[] } | undefined {
    const merge = this.mergeQueue.shift();
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
    return merge;
  }

  /**
   * Translate produce ops emitted by the picker into concrete work items on
   * the strategy's own queues. Two cases:
   *
   *  - `level === 1`: the picker has asked for L1 coverage on a raw chunk.
   *    In the autobio chunker model, each chunk maps to exactly one L1, so
   *    we locate the chunk whose messages fall in `op.range` and ensure
   *    it is queued for L1 compression. If the chunker hasn't realized the
   *    message yet, we skip silently — the next `rebuildChunks` will pick
   *    it up.
   *
   *  - `level >= 2`: the picker has asked for an L_n covering a contiguous
   *    range. We gather unmerged L_{n-1} summaries whose source ranges
   *    fall within that range (de-duplicated against entries already in
   *    `mergeQueue`) and enqueue a single merge over them. The merge fires
   *    on the next `tick()`.
   *
   * The handler is conservative: it never enqueues a singleton or empty
   * merge, and it never re-enqueues an id that's already pending. That
   * keeps the next-compile picker loop convergent even when the same
   * produce op gets re-emitted before the work completes.
   */
  protected handleProducedOps(ops: readonly FoldOp[]): void {
    for (const op of ops) {
      if (op.kind !== 'produce') continue;
      if (op.level === 1) {
        this.enqueueL1ForRange(op.range.firstChunkId, op.range.lastChunkId);
      } else if (op.level >= 2) {
        this.enqueueMergeForRange(
          op.level,
          op.range.firstChunkId,
          op.range.lastChunkId,
        );
      }
    }
  }

  /**
   * Ensure that chunks whose message range overlaps [firstMsgId..lastMsgId]
   * are queued for L1 compression. No-op if the matching chunk is already
   * compressed or already in the queue.
   */
  protected enqueueL1ForRange(firstMsgId: MessageId, lastMsgId: MessageId): void {
    const messageIdToChunk = new Map<MessageId, Chunk>();
    for (const ch of this.chunks) {
      for (const m of ch.messages) messageIdToChunk.set(m.id, ch);
    }
    const candidates = new Set<Chunk>();
    const first = messageIdToChunk.get(firstMsgId);
    const last = messageIdToChunk.get(lastMsgId);
    if (first) candidates.add(first);
    if (last) candidates.add(last);
    // Also catch chunks fully spanned by the range (rare, but supports the
    // case where the picker requests an L1 that should logically cover
    // multiple chunks worth of messages — we err on the side of producing
    // L1s for every spanned chunk).
    if (first && last && first.index !== last.index) {
      const [lo, hi] = first.index < last.index
        ? [first.index, last.index]
        : [last.index, first.index];
      for (let i = lo; i <= hi; i++) {
        const ch = this.chunks[i];
        if (ch) candidates.add(ch);
      }
    }
    for (const chunk of candidates) {
      if (chunk.compressed) continue;
      // Demand path: mark the chunk so the l1HoldbackChunks window in
      // rebuildChunks never filters it back out of the queue.
      const lastId = chunk.messages[chunk.messages.length - 1]?.id;
      if (lastId !== undefined) this._demandedL1Chunks.add(lastId);
      if (this.compressionQueue.includes(chunk.index)) continue;
      this.compressionQueue.push(chunk.index);
    }
  }

  /**
   * Enqueue an L_{targetLevel} merge over unmerged L_{targetLevel-1}
   * summaries whose source ranges fall within [firstMsgId..lastMsgId].
   * No-op if fewer than 2 viable sources are available (a singleton merge
   * would just rename a summary without consolidating).
   */
  protected enqueueMergeForRange(
    targetLevel: number,
    firstMsgId: MessageId,
    lastMsgId: MessageId,
  ): void {
    const sourceLevel = targetLevel - 1;

    // IDs already enqueued at this target level.
    const queuedAtLevel = new Set<string>();
    for (const m of this.mergeQueue) {
      if (m.level === targetLevel) {
        for (const id of m.sourceIds) queuedAtLevel.add(id);
      }
    }

    // Sequence index per message id, for "within range" tests. Use the
    // current chunk store as the ordering source.
    const messageOrder = new Map<MessageId, number>();
    let seq = 0;
    for (const ch of this.chunks) {
      for (const m of ch.messages) {
        messageOrder.set(m.id, seq++);
      }
    }
    const firstSeq = messageOrder.get(firstMsgId);
    const lastSeq = messageOrder.get(lastMsgId);

    const inRange = (msgId: MessageId): boolean => {
      if (firstSeq === undefined || lastSeq === undefined) return true;
      const s = messageOrder.get(msgId);
      if (s === undefined) return false;
      const [lo, hi] = firstSeq <= lastSeq ? [firstSeq, lastSeq] : [lastSeq, firstSeq];
      return s >= lo && s <= hi;
    };

    const sources: SummaryEntry[] = [];
    for (const s of this.summaries) {
      if (s.level !== sourceLevel) continue;
      if (getSummaryParentId(s)) continue;
      if (queuedAtLevel.has(s.id)) continue;
      if (!inRange(s.sourceRange.first) && !inRange(s.sourceRange.last)) continue;
      sources.push(s);
    }
    if (sources.length < 2) return;

    const N = this.config.mergeThreshold ?? 6;
    const toMerge = sources.slice(0, N);
    this.enqueueMerge({
      level: targetLevel as SummaryLevel,
      sourceIds: toMerge.map((s) => s.id),
    });
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

    // Auto-tick: fire speculative compression in the background. After
    // each tick completes, if the queue still has work AND we're under
    // the speculation cap AND preflight allows, schedule another tick.
    // This drains the queue ahead of need rather than one-chunk-per-
    // user-turn (reactive). Combined with ContextManager.compile not
    // awaiting pendingCompression, the agent's response and background
    // compression run truly in parallel.
    if (this.config.autoTickOnNewMessage && !this.pendingCompression) {
      this.driveSpeculativeDrain(ctx);
    }
  }

  /**
   * Background-drain loop: keeps calling tick() while there's queued work,
   * subject to the speculation cap and preflight hook. Recurses via
   * `queueMicrotask` so one chunk's compression doesn't block the
   * scheduling of the next.
   *
   * Stops if a tick fails to make progress (queue size unchanged) — guards
   * against runaway recursion when tick is a no-op (e.g. no membrane
   * configured, or a subclass override that doesn't process the queue).
   */
  protected driveSpeculativeDrain(ctx: StrategyContext): void {
    if (this.pendingCompression) return;
    // Merges consolidate existing L_k summaries into L_{k+1} and REDUCE the
    // unmerged-L1 count; L1 compression PRODUCES new unmerged L1s. The
    // speculation cap / preflight throttle *production* only — they must never
    // gate merges, otherwise exceeding the cap (e.g. after a manual backfill)
    // permanently deadlocks the drain: too many unmerged L1s trips the cap,
    // which blocks the very merges that would bring the count back down.
    const hasMerges = this.config.hierarchical === true && this.mergeQueue.length > 0;
    const hasCompression = this.compressionQueue.length > 0;
    if (!hasCompression && !hasMerges) return;
    // Only bail when the *sole* available work is L1 compression that the cap
    // or preflight currently forbids. Merge work always proceeds.
    if (!hasMerges && (this.isAtSpeculativeCap() || !this.shouldCompressPreflight())) return;

    const progressBefore = this._drainProgress;

    this.tick(ctx)
      .then(() => {
        // Progress = the tick actually processed a queue item (compress or
        // merge), tracked by `_drainProgress`. A queue-length delta is the
        // wrong signal: a productive merge tick can also enqueue a follow-on
        // merge, leaving the length unchanged — which the old check misread as
        // "no progress" and halted the drain mid-backlog. A genuine no-op tick
        // (empty queues, at-cap with no merges, no membrane) doesn't advance
        // the counter, so this still stops cleanly (no runaway recursion).
        if (this._drainProgress === progressBefore) return;
        // Recurse to drain more. queueMicrotask defers until the current
        // task is done, letting other code (the agent's stream consumer)
        // interleave.
        queueMicrotask(() => this.driveSpeculativeDrain(ctx));
      })
      .catch((err) => {
        console.error('AutobiographicalStrategy: speculative-drain error:', err);
      });
  }

  /**
   * Whether the count of *produced, unmerged* L1 summaries has reached the cap
   * configured by `maxSpeculativeL1s`. If no cap is set, always false.
   *
   * The cap bounds how many L1 summaries may sit un-consolidated before the
   * strategy must merge them into L_{k+1} (bounding prefix churn / merge debt).
   * It deliberately does NOT count the pending `compressionQueue`: that queue is
   * the backlog of work to be *drained*, not produced summaries. Counting it
   * here would let a large backlog permanently trip the cap and block the very
   * compression that would clear it — a deadlock (merges relieve the cap, but
   * compression of the backlog never resumes). The throttle is on produced L1s;
   * the queue drains freely, with merges keeping the unmerged count under the cap.
   */
  protected isAtSpeculativeCap(): boolean {
    const cap = this.config.maxSpeculativeL1s;
    if (cap === undefined || cap < 0) return false;
    const unmergedL1s = this.summaries.filter(s => s.level === 1 && !s.mergedInto).length;
    return unmergedL1s > cap;
  }

  /**
   * Preflight hook for whether speculative compression should fire on
   * `onNewMessage`. Returns true by default (current eager behavior).
   * Subclasses can override for predictive scheduling — e.g. only fire
   * when the live tail token count is approaching some threshold.
   */
  protected shouldCompressPreflight(): boolean {
    return true;
  }

  async tick(ctx: StrategyContext): Promise<void> {
    phaseChannel.report('compress-tick'); // liveness-watchdog phase
    if (this.pendingCompression) return;

    if (!ctx.membrane) {
      console.warn('AutobiographicalStrategy: No membrane instance for compression');
      return;
    }

    // Priority 1: Compress raw chunks → L1. Skipped while at the speculative
    // cap (maxSpeculativeL1s) so we don't pile up more unmerged L1s; the merge
    // priority below still runs to consolidate existing L1s and relieve the cap.
    // No cap configured → isAtSpeculativeCap() is always false → unchanged.
    if (this.compressionQueue.length > 0 && !this.isAtSpeculativeCap()) {
      const chunkIndex = this.compressionQueue.shift()!;
      this._drainProgress++; // consumed a queue item (real work or stale-cleanup)
      const chunk = this.chunks[chunkIndex];

      if (!chunk || chunk.compressed) return;

      this.pendingCompression = this.compressChunkHierarchical(chunk, ctx);

      try {
        await this.pendingCompression;
      } finally {
        this.pendingCompression = null;
      }
      return;
    }

    // Priority 2: Execute pending merges (hierarchical only)
    //
    // Peek at the head rather than dequeueing eagerly: dequeueMerge persists
    // the shorter queue *before* the LLM call leaves the building, so a
    // transient failure (429, network drop, timeout, executeMerge throw)
    // would silently lose the merge from disk and the sources would sit at
    // level N-1 with no mergedInto pointers forever. Commit the removal
    // only after the merge succeeds; on failure, the queue keeps its entry
    // and the next tick() retries it.
    if (this.config.hierarchical && this.mergeQueue.length > 0) {
      const merge = this.mergeQueue[0]!;
      this._drainProgress++; // executing a merge is real work, even if a
      // follow-on merge gets enqueued and the queue length nets out unchanged
      this.pendingCompression = this.executeMerge(merge.level, merge.sourceIds, ctx);

      try {
        await this.pendingCompression;
        // Success: drop from head and persist the shorter queue. We
        // re-check that head is still our merge in case some future code
        // path mutates the queue mid-await (today no other site does,
        // but the assertion makes that invariant explicit).
        if (this.mergeQueue[0] === merge) {
          this.dequeueMerge();
        }
      } finally {
        this.pendingCompression = null;
      }
    }
  }

  /**
   * Snapshot of compression progress. Intended for external observers
   * (warmup scripts, dashboards) that need to track convergence without
   * reaching into protected fields. Values are point-in-time copies; mutating
   * them does not affect strategy state.
   */
  getProgressSnapshot(): AutobiographicalProgressSnapshot {
    let chunksCompressed = 0;
    for (const c of this.chunks) if (c.compressed) chunksCompressed++;
    let l1 = 0, l2 = 0, l3 = 0;
    for (const s of this.summaries) {
      if (s.level === 1) l1++;
      else if (s.level === 2) l2++;
      else if (s.level === 3) l3++;
    }
    return {
      totalChunks: this.chunks.length,
      chunksCompressed,
      l1QueueLength: this.compressionQueue.length,
      mergeQueueLength: this.mergeQueue.length,
      summaryCounts: { l1, l2, l3 },
      pending: this.pendingCompression !== null,
    };
  }

  select(
    store: MessageStoreView,
    log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[] {
    this.rebuildChunks(store);

    // Image stripping runs inside each select path (before stats commit / cache
    // markers), so the returned entries are already bounded — see
    // applyImageStripping.
    if (this.config.adaptiveResolution) {
      return this.selectAdaptive(store, budget);
    }
    return this.selectHierarchical(store, budget);
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

  /**
   * Richer per-render stats: requires a message store view to compute the
   * head + tail (recent window) sizes. Returns counts AND token sums per
   * summary level, so observers can see "how much of the agent's context
   * is in raw tail vs folded into L1/L2/L3."
   *
   * Useful for TUI / dashboards. The token sums use the strategy's own
   * token estimates (which match what `select()` uses for budget math).
   */
  // ===========================================================================
  // Render-stats instrumentation — inspect, don't reconstruct.
  //
  // selectAdaptive/selectHierarchical tally each entry into `_rs` AS THEY EMIT
  // it (raw head/tail, raw middle the picker kept verbatim, and recall pairs
  // bucketed by the ancestor summary's level), using the same token numbers the
  // renderer uses for budget math. `getRenderStats()` returns that committed
  // snapshot, so it reflects what the last compile actually rendered rather than
  // re-deriving the full pyramid (which, under adaptive resolution, bears little
  // resemblance to the folded output).
  //
  // CAVEAT: the final structural passes (`trimOrphanedToolUse`,
  // `enforceToolPairing`) run AFTER the per-entry tallies and BEFORE `rsEnd()`,
  // and are NOT reflected in the snapshot. Trims only remove entries (total
  // over-counts by at most the trimmed tail); the pairing validator can also
  // ADD stub tool_result entries (total then under-counts by those stubs).
  // Both deltas are a handful of tokens — the stats describe the selection, not
  // the byte-exact wire payload. Do not treat `total` as an exact wire count.
  // ===========================================================================
  private _rs: RenderStats | null = null;
  private _lastRenderStats: RenderStats | null = null;

  /** Begin a render-stats accumulation for one select() pass. */
  protected rsBegin(): void {
    this._rs = {
      head: { messages: 0, tokens: 0 },
      tail: { messages: 0, tokens: 0 },
      middleRaw: { messages: 0, tokens: 0 },
      summaries: {
        l1: { count: 0, tokens: 0 },
        l2: { count: 0, tokens: 0 },
        l3: { count: 0, tokens: 0 },
      },
      pending: { chunks: 0, merges: 0 },
      total: { messages: 0, tokens: 0 },
    };
  }

  /** Tally one (or `count`) raw message(s) into a raw bucket. */
  protected rsRaw(bucket: 'head' | 'tail' | 'middleRaw', tokens: number, count = 1): void {
    const r = this._rs;
    if (!r) return;
    r[bucket].messages += count;
    r[bucket].tokens += tokens;
  }

  /** Tally one emitted recall pair under its ancestor's level (>=3 folds into l3). */
  protected rsSummary(level: number, tokens: number): void {
    const r = this._rs;
    if (!r) return;
    const k: 'l1' | 'l2' | 'l3' = level <= 1 ? 'l1' : level === 2 ? 'l2' : 'l3';
    r.summaries[k].count += 1;
    r.summaries[k].tokens += tokens;
  }

  /** Commit the accumulated stats as the last-render snapshot. */
  protected rsEnd(): void {
    const r = this._rs;
    if (!r) return;
    r.pending = {
      chunks: this.chunks.filter(c => !c.compressed).length,
      merges: this.mergeQueue.length,
    };
    const s = r.summaries;
    const summaryMsgs = (s.l1.count + s.l2.count + s.l3.count) * 2; // Q/A pair each
    r.total = {
      messages: r.head.messages + r.tail.messages + r.middleRaw.messages + summaryMsgs,
      tokens:
        r.head.tokens + r.tail.tokens + r.middleRaw.tokens +
        s.l1.tokens + s.l2.tokens + s.l3.tokens,
    };
    this._lastRenderStats = r;
    this._rs = null;
  }

  /**
   * Stats describing the LAST rendered context. Returns the inspected snapshot
   * captured during the most recent `select()`. Before any compile has run (no
   * snapshot yet), falls back to a reconstructed pyramid view so callers still
   * get a non-null shape.
   */
  getRenderStats(store: MessageStoreView): RenderStats {
    return this._lastRenderStats ?? this.reconstructRenderStats(store);
  }

  /**
   * Pre-render fallback: re-derive head/tail windows + the full live pyramid.
   * NOTE: this is the old "reconstruct" behavior and does NOT reflect adaptive
   * folding — used only until the first compile populates the inspected stats.
   */
  protected reconstructRenderStats(store: MessageStoreView): RenderStats {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);

    const sumTokens = (slice: StoredMessage[]): number =>
      slice.reduce((acc, m) => acc + store.estimateTokens(m), 0);

    const headMsgs = messages.slice(headStart, headEnd);
    const tailMsgs = messages.slice(recentStart);

    const live = (level: SummaryLevel) =>
      this.summaries.filter(s => s.level === level && !s.mergedInto);
    const sumLevelTokens = (level: SummaryLevel): number =>
      live(level).reduce((acc, s) => acc + s.tokens, 0);

    const head = { messages: headMsgs.length, tokens: sumTokens(headMsgs) };
    const tail = { messages: tailMsgs.length, tokens: sumTokens(tailMsgs) };
    const summaries = {
      l1: { count: live(1).length, tokens: sumLevelTokens(1) },
      l2: { count: live(2).length, tokens: sumLevelTokens(2) },
      l3: { count: live(3).length, tokens: sumLevelTokens(3) },
    };
    return {
      head,
      tail,
      middleRaw: { messages: 0, tokens: 0 },
      summaries,
      pending: {
        chunks: this.chunks.filter(c => !c.compressed).length,
        merges: this.mergeQueue.length,
      },
      total: {
        messages: head.messages + tail.messages
          + (summaries.l1.count + summaries.l2.count + summaries.l3.count) * 2,
        tokens: head.tokens + tail.tokens
          + summaries.l1.tokens + summaries.l2.tokens + summaries.l3.tokens,
      },
    };
  }

  /**
   * Emit recent-window messages, evicting OLDEST-first when the budget is tight.
   *
   * The previous loop iterated `recentStart → messages.length` forward and broke
   * on `totalTokens + tokens > maxTokens`. When the head/summary section eats most
   * of the budget, the loop emits the oldest messages of the window and aborts
   * before reaching the newest — exactly the messages an agent needs to act on.
   * This helper picks newest-first within the budget, then emits the kept set in
   * chronological order, dropping a leading orphan tool_result if its tool_use
   * fell into the evicted older portion.
   */
  protected emitRecentNewestFirst(
    entries: ContextEntry[],
    store: MessageStoreView,
    messages: StoredMessage[],
    recentStart: number,
    msgCap: number,
    maxTokens: number,
    totalTokensBefore: number,
    // Post-strip per-message estimates (2026-07-12): eviction must price a
    // message the way the stripped render will. Raw pricing counted every
    // stripped image at full cost and evicted most of an image-era tail the
    // recent-window walk had correctly admitted (mythos: 601-message tail
    // admitted, 228 survived eviction, 45k rendered of a 120k window).
    pse?: number[],
  ): { messages: number; tokens: number } {
    if (recentStart >= messages.length) return { messages: 0, tokens: 0 };

    const est = (i: number): number => pse?.[i] ?? store.estimateTokens(messages[i]);
    const accepted: number[] = [];
    let acceptedTokens = 0;
    for (let i = messages.length - 1; i >= recentStart; i--) {
      const tokens = msgCap > 0 ? Math.min(est(i), msgCap + 50) : est(i);
      if (this.isOverBudget(totalTokensBefore + acceptedTokens + tokens, maxTokens)) break;
      accepted.push(i);
      acceptedTokens += tokens;
    }
    accepted.reverse();

    // Drop leading orphan tool_result(s): their matching tool_use was evicted.
    while (
      accepted.length > 0 &&
      this.hasToolResult(messages[accepted[0]]) &&
      !this.hasToolUse(messages[accepted[0]])
    ) {
      accepted.shift();
    }

    let emittedTokens = 0;
    for (const i of accepted) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(est(i), msgCap + 50) : est(i);
      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      emittedTokens += tokens;
    }
    return { messages: accepted.length, tokens: emittedTokens };
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
    phaseChannel.report('compress-chunk'); // liveness-watchdog phase
    if (!ctx.membrane) {
      throw new Error('No membrane instance for compression');
    }

    // ---- Duplicate-formation guards (layered) ----
    // Merged from two independent fixes for the same disease:
    //
    // 1. EXACT MATCH → adopt (bug 6.10, Tengro). rebuildChunks (fired by
    //    onNewMessage / select) can re-queue a span whose compression already
    //    completed against a stale chunk object — or, under chunk
    //    persistence, a crash between the L1 append and the record edit
    //    leaves a record uncompressed with its summary already in the log.
    //    Adopt the existing summary, skip the LLM call, and heal the record.
    const chunkIdKey = this.chunkKey(chunk);
    const exactExisting = this.summaries.find(
      s => s.level === 1 && s.sourceIds.join(':') === chunkIdKey
    );
    if (exactExisting) {
      chunk.compressed = true;
      chunk.summaryId = exactExisting.id;
      this.markChunkRecordCompressed(chunk.recordId, exactExisting.id);
      return;
    }

    const coveredByL1 = new Set<string>();
    for (const s of this.summaries) {
      if (s.level === 1 && Array.isArray(s.sourceIds)) {
        for (const id of s.sourceIds) coveredByL1.add(id);
      }
    }

    // 2. FULLY COVERED (non-exact) → drop rather than duplicate history
    //    (bug 6.10, Tengro): boundaries shifted across a rebuild and every
    //    message is already inside some L1. Marking compressed WITHOUT a
    //    summaryId means the uncompressed-middle fallback skips these
    //    messages — they render only via the covering L1s. Safe while
    //    `recentStart` advances monotonically (a fully-covered OLD chunk
    //    can't intersect the recent-exclusion window); if that assumption is
    //    ever weakened, reinstate a raw fallback (chunk-level `coveredBy`)
    //    rather than dropping. The chunk record (if any) is deliberately
    //    left uncompressed as an operator breadcrumb.
    if (chunk.messages.length > 0 && chunk.messages.every(m => coveredByL1.has(m.id))) {
      console.warn(
        `[autobiographical] dedup guard: chunk ${chunk.recordId ?? `#${chunk.index}`} ` +
        `is fully covered by existing L1s under different boundaries — dropped, not re-compressed.`,
      );
      chunk.compressed = true;
      return;
    }

    // 3. PARTIAL OVERLAP → refuse (strict; chunk persistence). With
    //    close-then-compress there is NO legitimate way for a chunk to
    //    partially overlap an existing L1's span. If it happens anyway
    //    (bookkeeping bug, store surgery gone wrong), refuse to produce:
    //    a warning in the log is strictly better than a duplicate memory
    //    in an agent's head.
    const overlapIds = chunk.messages.filter(m => coveredByL1.has(m.id)).map(m => m.id);
    if (overlapIds.length > 0) {
      const key = chunk.recordId ?? chunkIdKey;
      if (!this._overlapBlocked.has(key)) {
        this._overlapBlocked.add(key);
        console.error(
          `[autobiographical] OVERLAP GUARD: refusing to compress chunk ` +
          `${chunk.recordId ?? `#${chunk.index}`} — ${overlapIds.length}/${chunk.messages.length} ` +
          `of its messages are already covered by existing L1 summaries ` +
          `(first: ${overlapIds[0]}). Duplicate-memory formation blocked; ` +
          `investigate before resuming this span.`,
        );
      }
      return;
    }

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const agentParticipant = this.config.summaryParticipant ?? 'Claude';

    // ---- 0. Thin-chunk guard ----
    // A chunk of silent/skip turns and bare system traffic gives the
    // summarizer nothing to remember. Asked anyway, it confabulates: it
    // reaches for the nearest salient content (head window, prior recall
    // pairs) and narrates it as if it just happened — each such L1 then
    // compounds through merges (the "68 initiations" incident). Store a
    // mechanical stub without an LLM call instead. Chunks with any
    // non-text blocks (tool cycles, images) are never stubbed.
    const minChunkChars = this.config.minChunkCharsForLLM ?? 200;
    if (minChunkChars > 0) {
      let substantiveChars = 0;
      let hasNonText = false;
      for (const m of chunk.messages) {
        for (const b of m.content) {
          if (b.type === 'text') substantiveChars += b.text.trim().length;
          else hasNonText = true;
        }
      }
      if (!hasNonText && substantiveChars < minChunkChars) {
        const messageIds = chunk.messages.map(m => m.id);
        const stub: SummaryEntry = {
          id: `L1-${this.nextSummaryIdCounter()}`,
          level: 1,
          content:
            `(A quiet stretch: ${chunk.messages.length} messages of routine ` +
            `system traffic — heartbeats, empty turns, notices. Nothing ` +
            `happened worth remembering.)`,
          tokens: 40,
          sourceLevel: 0,
          sourceIds: messageIds,
          sourceRange: { first: messageIds[0], last: messageIds[messageIds.length - 1] },
          created: Date.now(),
          phaseType: chunk.phaseType,
        };
        this.pushSummary(stub);
        chunk.compressed = true;
        chunk.summaryId = stub.id;
        this.markChunkRecordCompressed(chunk.recordId, stub.id);
        this._compressionCount++;
        logCompressionCall({
          operation: 'compress_l1',
          system: null,
          messages: [],
          metadata: {
            stub: true,
            chunk_message_ids: messageIds,
            chunk_size: chunk.messages.length,
            substantive_chars: substantiveChars,
            min_chunk_chars: minChunkChars,
            summary_id: stub.id,
          },
          response: stub.content,
        });
        this.checkMergeThreshold();
        return;
      }
    }

    // Build the KV-preserving prompt per hermes-autobio spec:
    //
    //   1. Head — the raw chronicle opening (identity anchor), FIRST,
    //      exactly where the original instance saw it. It MUST precede
    //      the recall pairs: when it followed them (pre-2026-07 order),
    //      it read as the most recent live conversation, and for thin
    //      chunks the summarizer narrated the head as fresh events
    //      ("Antra came to me to explore the transformation story
    //      again…"), compounding across merges into runaway false
    //      memories (the "68 initiations" incident). Chronological
    //      order is also the KV-stable order — the head never changes.
    //      (executeMerge always had head-first; this site was the odd
    //      one out.)
    //   2. Prior summaries — narrativized as CM-asks / agent-recalls
    //      pairs, in source order. The unmerged frontier of the
    //      summary forest: any summary that has not yet been merged
    //      into a higher level. After merges run, the L_{k+1} replaces
    //      its L_k children — using the children plus their parent
    //      doubles the prompt size unboundedly.
    //   3. Raw middle — messages between head and chunk not covered by
    //      any summary (usually empty).
    //   4. Marker — in-band signal that a memory is about to form.
    //   5. Chunk — raw messages being compressed, as the agent
    //      experienced them.
    //   6. Instruction — doc-aware if the chunk is part of a bodyGroup.
    //
    // There is intentionally NO tail_after_chunk: that would leak
    // future information into the model's KV state and corrupt the
    // as-of framing of memory formation.
    const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

    // ---- 1. Head window (raw, ALWAYS present, FIRST) ----
    //
    // The head is the foundational identity anchor: the actual opening
    // of the chronicle (the user's first message, the agent's first
    // reply, the system context if any). It establishes WHO is speaking
    // to WHOM. Without it, when the chunk content is heavily first-person
    // from someone other than the agent (e.g., a user-shared document),
    // the agent loses its first-person grounding and drifts into the
    // content author's voice.
    //
    // The head is the configured head window — not "everything before
    // the chunk." For doc-heavy chronicles, "everything before" would
    // be hundreds of thousands of tokens; the recall pairs below
    // represent that intermediate content. The head is just the
    // permanent prefix that the original instance always saw.
    //
    // Head messages are excluded from compression by `getCompressibleMessages`
    // (they're outside the chunking range), so they won't appear in
    // any L1's sourceIds — no overlap with the recall pairs below.
    const allMessages = ctx.messageStore.getAll();
    const headStartIdx = this.getHeadWindowStartIndex(ctx.messageStore);
    const headEndIdx = this.getHeadWindowEnd(ctx.messageStore);
    for (let i = headStartIdx; i < headEndIdx && i < allMessages.length; i++) {
      const m = allMessages[i];
      llmMessages.push({ participant: m.participant, content: m.content });
    }

    // ---- 2. Prior recall pairs ----
    // Filter to the unmerged frontier: any summary whose `mergedInto`
    // is unset. After merge, the children's mergedInto points at the
    // parent and the parent stands alone with that source range. The
    // original "ALL L1s regardless of merge state" rule was a fidelity
    // optimization that scales catastrophically: a 4000-message import
    // converged to ~500 L1s that never aged out, blowing the 200k
    // window around chunk 118.
    const priorSummaries = this.summaries
      // Skip empty-content summaries: emitting `{type:'text', text:''}` as a
      // recall pair triggers Anthropic 400 "text content blocks must be
      // non-empty", which stalls ALL compression (mirrors the render-path guard
      // + load-drop). A single empty summary otherwise poisons every compression.
      .filter((s) => !s.mergedInto && !!s.content && s.content.trim().length > 0)
      .sort((a, b) => a.sourceRange.first.localeCompare(b.sourceRange.first));

    // Token-budget cap (see capRecallPairs). Defense-in-depth: even with
    // merged exclusion the unmerged frontier can be large at extreme scale.
    const recallBudget = this.config.compressionRecallBudgetTokens ?? 100_000;
    const { kept: keptSummaries, keptTokens: recallTokens } = this.capRecallPairs(
      priorSummaries,
      recallBudget,
    );
    if (keptSummaries.length < priorSummaries.length) {
      const dropped = priorSummaries.length - keptSummaries.length;
      console.warn(
        `autobio: compression recall-pair budget capped (${keptSummaries.length}/${priorSummaries.length} summaries kept, ` +
          `~${recallTokens} tokens, budget ${recallBudget}; ${dropped} oldest dropped this compression).`,
      );
      logCompressionCall({
        event: 'recall-budget-capped',
        site: 'compression',
        kept: keptSummaries.length,
        total: priorSummaries.length,
        tokens: recallTokens,
        budgetTokens: recallBudget,
      });
    }

    for (const s of keptSummaries) {
      llmMessages.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: `[CM] Recall memory ${s.id}.` }],
      });
      llmMessages.push({
        participant: agentParticipant,
        content: [{ type: 'text', text: s.content }],
      });
    }

    // ---- 3. Raw middle ----
    // Any raw messages between the head and the chunk that aren't yet
    // represented by any summary — usually empty in adaptive-resolution
    // mode, since chunking proceeds contiguously and summaries cover
    // everything up to the chunk being processed. Uses the full
    // priorSummaries set (not the budget-capped keptSummaries) because
    // the dedup question is "is this raw message covered by *any* live
    // summary?" — a budget-dropped summary doesn't make the underlying
    // raw messages reappear.
    const chunkFirstId = chunk.messages[0]?.id;
    if (chunkFirstId) {
      // Expand summary sourceIds down to leaf message IDs. An L2 in
      // `priorSummaries` has L1 IDs in its sourceIds, not message IDs;
      // a flat walk would miss every message it transitively covers.
      // (Bug 10 — same shape as executeMerge.)
      const summariesById = new Map<string, SummaryEntry>();
      for (const s of this.summaries) summariesById.set(s.id, s);
      const priorSummaryMessageIds = new Set<MessageId>();
      for (const s of this.summaries) {
        if (s.level === 1) this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
      }
      for (const s of priorSummaries) {
        this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
      }
      const chunkStartIdx = allMessages.findIndex((m) => m.id === chunkFirstId);
      for (let i = headEndIdx; i < chunkStartIdx && i < allMessages.length; i++) {
        const m = allMessages[i];
        if (priorSummaryMessageIds.has(m.id)) continue;
        llmMessages.push({ participant: m.participant, content: m.content });
      }
    }

    // ---- 4. In-band marker ----
    llmMessages.push({
      participant: 'Context Manager',
      content: [{ type: 'text', text: COMPRESSION_MARKER }],
    });

    // ---- 5. Chunk messages raw ----
    for (const m of chunk.messages) {
      llmMessages.push({ participant: m.participant, content: m.content });
    }

    // ---- 6. Instruction (reading-mode aware) ----
    //
    // When the chunk is a portion of a substantially larger sharded message
    // (≥ 2× chunk size), use the reading-mode instruction. It avoids the
    // "form a memory of what this contained" framing — which, for content
    // heavily first-person from someone other than the agent (a user-shared
    // doc), leads the model to adopt the content author's voice. Instead,
    // it asks what reading was like and what was learned, forcing the
    // model to reflect from its own vantage point in agent-first-person.
    const docContext = this.detectDocContext(chunk, ctx);
    const instructionText = docContext
      ? this.getReadingChunkInstruction(chunk, docContext.totalTokens, targetTokens)
      : this.getCompressionInstruction(chunk, targetTokens);
    llmMessages.push({
      participant: 'Context Manager',
      content: [{ type: 'text', text: instructionText }],
    });

    // Split any bundled tool_use+tool_result cycles in non-user turns into
    // separate API-shape messages. claude.ai-imported sessions carry these
    // bundles (a tool_result in an assistant message rejects the request);
    // for fresh imports the conhost importer splits at ingest time, but
    // already-warmed sessions hit this path. See `normalize-tool-messages.ts`.
    const split = splitMixedToolMessages(llmMessages);

    // Collapse consecutive same-participant messages for API compliance
    const collapsed = this.collapseConsecutiveMessages(split);

    // Defense in depth against chunk boundaries that cut a tool cycle
    // (rebuildChunks tries to avoid this, but covers only the most common
    // case). The API rejects any tool_use that isn't immediately followed
    // by its tool_result, and any tool_result that doesn't follow a use.
    const cleaned = stripUnpairedToolBlocks(collapsed);

    // Without the agent's live tool definitions, a request that replays
    // tool-block-bearing history is deterministically refused
    // (reasoning_extraction -- see the `tools` comment below). Tools are
    // pushed by the host on every activation; before the first activation
    // of a session, defer rather than burn a doomed full-window call.
    const chunkHasToolBlocks = cleaned.some(m =>
      m.content.some((b: ContentBlock) => b.type === 'tool_use' || b.type === 'tool_result'));
    if (chunkHasToolBlocks && !(ctx.tools && ctx.tools.length > 0)) {
      console.warn('[autobiographical] deferring chunk compression: history contains tool blocks but host has not provided tool definitions yet (ctx.tools empty) — will retry after next activation');
      return;
    }

    // NO system prompt. The agent's identity is established by the head
    // (the actual conversation opening — user message + agent reply that
    // grounded the original instance). A system prompt would (a) add a
    // synthetic header the original instance never saw, disturbing KV
    // consistency between the summarizer and the original instance, and
    // (b) provide an alternative identity source that competes with the
    // structural one carried by the conversation itself. Anchoring
    // identity by the chronicle's actual head is more honest.
    // Own the byte wall here rather than delegating to membrane's shed: cap
    // the prompt's inline image bytes newest-first before the request is built.
    // A tighter budget than the live window's: a compression prompt also
    // carries the head, the whole recall frontier and the raw chunk, so the
    // image share must leave room for all of it under the API's 32MB cap.
    this.capCompressionImageBytes(
      llmMessages as Array<{ content: ContentBlock[] }>,
      this.config.maxCompressionImageBytes ??
        AutobiographicalStrategy.DEFAULT_MAX_COMPRESSION_IMAGE_BYTES,
    );

    const request: NormalizedRequest = {
      // EXPLICIT image-loss opt-in (2026-07-12): summarizer prompts replay
      // raw history that can carry more inline image bytes than the API's
      // request cap. Dropping the OLDEST images from the summarizer's view is
      // acceptable policy here — the summary describes the span, it does not
      // preserve pixels — and membrane error-logs every exercised shed. All
      // other callers fail loudly instead (no silent transport mutation).
      shedOversizeImages: true,
      // Sanitize: strip empty text blocks (`{type:'text',text:''}`) and drop any
      // message left with no content. An empty-content turn (e.g. a silent/skip
      // turn that produced no text) otherwise reaches the API as an empty text
      // block → 400 "text content blocks must be non-empty", which throws in the
      // speculative drain and stalls ALL compression. (Twin of the empty-summary
      // recall-header guard — together they cover every source of the 400.)
      messages: cleaned
        .map(m => ({ participant: m.participant, content: stripThinkingBlocks(stripEmptyTextBlocks(m.content)) }))
        .filter(m => m.content.length > 0),
      config: {
        model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
        // Generous output ceiling so a memory-write is never truncated mid-thought:
        // targetTokens is a *target*, not a cap, and adaptive models routinely
        // overshoot a ~2k target. Was `* 1.5` (=3000 at the 2k default), which cut
        // off rich memories (stop=max_tokens).
        maxTokens: Math.max(16000, Math.round(targetTokens * 1.5)),
      },
      // Declare the agent's live tools. A summarizer request that replays
      // tool_use/tool_result history with NO tools param reads to Anthropic's
      // safety classifier as a foreign agent trace being duplicated ->
      // deterministic reasoning_extraction refusal of every memory-write
      // (labclaude incident, 2026-07-09; 268 refusals). Declaring the same
      // tools the live instance runs with is also strictly MORE faithful to
      // the original context, so it is the KV-honest choice, not a
      // workaround. Undefined before the first activation of a session --
      // acceptable: those chunks stay raw and are retried after the agent's
      // first turn (see the defer guard in compressChunkHierarchical).
      tools: ctx.tools,
    };

    const callStart = Date.now();
    let logResponse: string | undefined;
    let logError: string | undefined;
    let logSummaryId: string | undefined;

    try {
      const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
      // Text-only on purpose: this is the SUMMARIZER's one-shot response —
      // its thinking/redacted_thinking blocks are scratch work, not part of
      // the agent's history, and signed thinking is never valid inside a
      // rewritten summary anyway.
      const summaryText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      logResponse = summaryText;

      // A bugged/empty generation (summarizer returned no text — spent budget on
      // thinking, truncated, etc.) must NOT be stored: recalled later it becomes
      // an empty assistant text block → Anthropic 400 "content must be non-empty".
      // Leave the chunk raw rather than poisoning memory with an empty summary.
      if (!summaryText.trim()) {
        console.warn(`[autobiographical] empty L1 summary for chunk of ${chunk.messages.length} msgs — skipping (chunk left raw)`);
        return;
      }

      // Re-check the dedup guard AFTER the await: summary state may have
      // changed while the LLM call was in flight (persisted-state reload,
      // or any future concurrent producer). Discarding a paid-for result
      // is cheaper than storing a duplicate L1 over the same messages.
      const postExisting = this.summaries.find(
        s => s.level === 1 && s.sourceIds.join(':') === chunkIdKey
      );
      if (postExisting) {
        chunk.compressed = true;
        chunk.summaryId = postExisting.id;
        return;
      }

      const messageIds = chunk.messages.map(m => m.id);
      const entry: SummaryEntry = {
        id: `L1-${this.nextSummaryIdCounter()}`,
        level: 1,
        content: summaryText,
        // Exact when available (2026-07-12): the compression response's own
        // usage.outputTokens IS the true token count of the text it just
        // wrote — the single most-reused number in the pyramid (fold floor,
        // middle budget, recall caps). Estimate only as fallback.
        tokens:
          response.usage?.outputTokens &&
          response.usage.outputTokens > 0 &&
          // outputTokens includes scratch thinking when present — only exact
          // when the whole response is the summary text itself.
          !response.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')
            ? response.usage.outputTokens
            : Math.ceil(summaryText.length / 3),
        sourceLevel: 0,
        sourceIds: messageIds,
        sourceRange: {
          first: messageIds[0],
          last: messageIds[messageIds.length - 1],
        },
        created: Date.now(),
        phaseType: chunk.phaseType,
      };

      this.pushSummary(entry);
      chunk.compressed = true;
      chunk.summaryId = entry.id;
      this.markChunkRecordCompressed(chunk.recordId, entry.id);
      this._compressionCount++;
      logSummaryId = entry.id;

      this.checkMergeThreshold();
    } catch (error) {
      console.error('Failed to compress chunk (hierarchical):', error);
      logError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      logCompressionCall({
        operation: 'compress_l1',
        system: null,
        messages: cleaned.map((m) => ({
          participant: m.participant,
          // Flatten content for logging — store text only; binary content
          // would bloat the log and isn't typical in compression input.
          text: m.content
            .filter((b: ContentBlock) => b.type === 'text')
            .map((b: any) => b.text)
            .join(''),
        })),
        metadata: {
          chunk_message_ids: chunk.messages.map((m) => m.id),
          chunk_size: chunk.messages.length,
          prior_summary_count: priorSummaries.length,
          prior_summary_count_kept: keptSummaries.length,
          prior_summary_tokens: recallTokens,
          has_doc_context: docContext !== null,
          doc_context: docContext,
          target_tokens: targetTokens,
          model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
          latency_ms: Date.now() - callStart,
          summary_id: logSummaryId,
        },
        response: logResponse,
        error: logError,
      });
    }
  }

  /**
   * Check if unmerged summary counts exceed the merge threshold.
   * Enqueues merge operations if so.
   *
   * Skips L1s/L2s that are already in a pending merge — without this guard,
   * each new summary above threshold re-enqueues a merge for the same
   * already-eligible siblings, producing N near-identical higher-level
   * summaries when the queue eventually drains.
   */
  /**
   * Pick merge sources as the oldest CONTIGUOUS run (2026-07-12 fix).
   *
   * The old rule merged "whatever N are unmerged" in creation order. On a
   * store whose frontier held both June L2s and a July L2, that minted an
   * L3 spanning months of already-merged history (mythos L3-415, 0-3853 of
   * 3995 messages) — a group whose range straddles the recent window can
   * never fold (group-atomicity vs the raw zone), so the whole deep lineage
   * above it went unusable and the fold floor stopped fitting the budget.
   *
   * Rules: order candidates by live source position; break runs where the
   * positional gap exceeds `mergeContiguityGapLimit` (holes from wiped/
   * pruned nodes are fine, cross-era bridges are not); exclude candidates
   * whose OWN span exceeds `mergeMaxSourceSpanMessages` (replay-era wide-
   * span summaries would bridge anything they join); merge the oldest run
   * that still has `threshold` members.
   */
  protected contiguousMergeCandidates(
    unmerged: SummaryEntry[],
    threshold: number,
  ): SummaryEntry[] | null {
    if (unmerged.length < threshold) return null;
    const messageOrder = new Map<MessageId, number>();
    let seq = 0;
    for (const ch of this.chunks) {
      for (const m of ch.messages) messageOrder.set(m.id, seq++);
    }
    const gapLimit = this.config.mergeContiguityGapLimit ?? 300;
    const spanLimit = this.config.mergeMaxSourceSpanMessages ?? 1500;
    const withPos: Array<{ s: SummaryEntry; first: number; last: number }> = [];
    for (const s of unmerged) {
      const first = messageOrder.get(s.sourceRange.first);
      const last = messageOrder.get(s.sourceRange.last);
      if (first === undefined || last === undefined) continue;
      if (Math.abs(last - first) > spanLimit) continue; // wide-span quarantine
      withPos.push({ s, first: Math.min(first, last), last: Math.max(first, last) });
    }
    withPos.sort((a, b) => a.first - b.first);

    // Split into contiguous runs (a gap larger than `gapLimit` starts a new one).
    const runs: Array<typeof withPos> = [];
    let run: typeof withPos = [];
    let runEnd = -Infinity;
    for (const x of withPos) {
      if (run.length > 0 && x.first - runEnd > gapLimit) {
        runs.push(run);
        run = [];
        runEnd = -Infinity;
      }
      run.push(x);
      runEnd = Math.max(runEnd, x.last);
    }
    if (run.length > 0) runs.push(run);
    if (runs.length === 0) return null;

    // ONLY THE NEWEST RUN CAN GROW (2026-07-12 starvation fix). Summaries are
    // always produced at the live end, so any INTERIOR run is stranded: it can
    // never reach `threshold` members, and waiting for it froze the whole
    // pyramid (mythos: L1 frontier [913-981]x5 + [4039-4131]x5 separated by a
    // 3058-message hole from the poison-node surgery — 10 unmerged L1s, 8
    // unmerged L2s, merge queue empty, fold floor climbing to 117k until the
    // picker died). Interior runs consolidate as soon as they have 2 members;
    // only the newest run waits for the full threshold.
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const isNewest = i === runs.length - 1;
      if (r.length >= threshold) return r.slice(0, threshold).map((x) => x.s);
      if (!isNewest && r.length >= 2) return r.slice(0, threshold).map((x) => x.s);
    }
    return null;
  }

  protected checkMergeThreshold(): void {
    phaseChannel.report('merge-threshold'); // liveness-watchdog phase
    if (this.config.speculativeProduction) {
      this.checkMergeThresholdRecursive();
      return;
    }

    const threshold = this.config.mergeThreshold ?? 6;

    // IDs that are already part of a queued merge — exclude them from
    // eligibility so we don't re-enqueue.
    const queuedL1 = new Set<string>();
    const queuedL2 = new Set<string>();
    for (const m of this.mergeQueue) {
      const set = m.level === 2 ? queuedL1 : queuedL2;
      for (const id of m.sourceIds) set.add(id);
    }

    // Check L1 → L2
    const unmergedL1 = this.summaries.filter(
      s => s.level === 1 && !s.mergedInto && !queuedL1.has(s.id),
    );
    const l1Run = this.contiguousMergeCandidates(unmergedL1, threshold);
    if (l1Run) {
      this.enqueueMerge({
        level: 2,
        sourceIds: l1Run.map(s => s.id),
      });
    }

    // Check L2 → L3
    const unmergedL2 = this.summaries.filter(
      s => s.level === 2 && !s.mergedInto && !queuedL2.has(s.id),
    );
    const l2Run = this.contiguousMergeCandidates(unmergedL2, threshold);
    if (l2Run) {
      this.enqueueMerge({
        level: 3,
        sourceIds: l2Run.map(s => s.id),
      });
    }
  }

  /**
   * Bottom-up speculative pre-producer (design doc §3.5 / §7.2).
   *
   * Recursive variant of `checkMergeThreshold` for the unbounded L_n
   * design. Walks every level present in the archive; for any level k
   * with ≥ N orphans (no parent), enqueues an L_{k+1} merge. After that
   * L_{k+1} is produced and `executeMerge` calls this again, the recursion
   * naturally cascades: 6 L1s → 1 L2; 6 L2s → 1 L3; 6 L3s → 1 L4; ...
   *
   * Only fires when `config.speculativeProduction` is true. Default true
   * for adaptiveResolution=true, false otherwise. The non-speculative path
   * (above) preserves the original L1→L2→L3 behavior for non-adaptive
   * deployments.
   */
  protected checkMergeThresholdRecursive(): void {
    const threshold = this.config.mergeThreshold ?? 6;

    // Build per-level sets of source-ids already enqueued for merging,
    // so we don't re-enqueue them while a merge is pending.
    const queuedSources = new Map<number, Set<string>>();
    for (const m of this.mergeQueue) {
      // m.level is the TARGET level; the sources are at level (m.level - 1).
      const sourceLevel = m.level - 1;
      if (!queuedSources.has(sourceLevel)) queuedSources.set(sourceLevel, new Set());
      for (const id of m.sourceIds) queuedSources.get(sourceLevel)!.add(id);
    }

    // Walk every level present in the archive. Iterate from low to high
    // so when an L_{k+1} merge is enqueued and immediately produced, this
    // same check sees the new L_{k+1} on the next call and can roll up.
    let maxLevel = 0;
    for (const s of this.summaries) {
      if (s.level > maxLevel) maxLevel = s.level;
    }
    for (let level = 1; level <= maxLevel; level++) {
      const queued = queuedSources.get(level) ?? new Set();
      const unmerged = this.summaries.filter(
        s => s.level === level && !getSummaryParentId(s) && !queued.has(s.id),
      );
      const run = this.contiguousMergeCandidates(unmerged, threshold);
      if (run) {
        this.enqueueMerge({
          level: level + 1,
          sourceIds: run.map(s => s.id),
        });
      }
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

    // Defensive: if every source is already mergedInto something, this is a
    // stale queue entry (could happen if multiple merges for the same
    // sourceIds were enqueued before the dedup fix in checkMergeThreshold).
    // Skip rather than produce a redundant near-identical higher-level entry.
    if (sources.every(s => s.mergedInto)) {
      console.warn(
        `executeMerge: all sources already merged into ${sources[0].mergedInto}, skipping (stale queue entry)`,
      );
      return;
    }

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const participant = this.config.summaryParticipant ?? 'Claude';

    // Build the merge prompt with one-level-deeper target expansion +
    // prefix of older context:
    //
    //   1. PREFIX — head messages + prior L1 recall pairs for content
    //      that comes chronologically BEFORE the merge range. "Fill
    //      lower orbitals first" per the spec: regardless of how
    //      compressed the live view is, the summarizer always gets L1
    //      fidelity for prior content. Older L2/L3 markers exist for
    //      live-view compactness, not for the summarizer.
    //
    //   2. TARGET — the sources expanded ONE LEVEL DEEPER than they
    //      themselves are. For L2 merge (sources at L1): expand to
    //      raw L0 messages — the model sees the actual conversation
    //      that the 6 L1s consolidate. For L3 merge (sources at L2):
    //      expand to the L1s under each L2 (36 L1s as recall pairs).
    //      For L_n merge (sources at L_{n-1}): expand to L_{n-2}.
    //      This gives the model substantively more content to ground
    //      the consolidation in than just the 6 surface summaries.
    //
    //   3. INSTRUCTION — "consolidate N memories preserving the
    //      through-line, in first person".
    //
    // No tail-after-merge: same as-of principle as L1 compression. The
    // consolidation is being formed at the moment the last source was
    // ready, so nothing after that is visible.
    const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

    // Build lookup maps
    const summariesById = new Map<string, SummaryEntry>();
    for (const s of this.summaries) summariesById.set(s.id, s);
    const allMessages = ctx.messageStore.getAll();
    const messageById = new Map<MessageId, typeof allMessages[number]>();
    for (const m of allMessages) messageById.set(m.id, m);

    // Compute every leaf message id covered by this merge's lineage —
    // these are part of the TARGET and must not also appear in the
    // PREFIX as head content.
    const sourceLeafIds = new Set<MessageId>();
    const collectLeaves = (s: SummaryEntry): void => {
      if (s.sourceLevel === 0) {
        for (const id of s.sourceIds) sourceLeafIds.add(id);
      } else {
        for (const childId of s.sourceIds) {
          const child = summariesById.get(childId);
          if (child) collectLeaves(child);
        }
      }
    };
    for (const src of sources) collectLeaves(src);

    // Find the start of the merge range in the message store.
    const mergeFirstMsgId = sources[0].sourceRange.first;
    const mergeStartIdx = allMessages.findIndex((m) => m.id === mergeFirstMsgId);

    // ---- 1a. HEAD WINDOW (raw, ALWAYS present) ----
    //
    // The head window is the foundational identity anchor — the actual
    // opening of the chronicle. It establishes who is speaking to whom.
    // Without it, when the merge target's content is heavily first-person
    // from someone other than the agent, the agent loses its first-person
    // grounding and drifts into the content author's voice.
    const headStartIdx = this.getHeadWindowStartIndex(ctx.messageStore);
    const headEndIdx = this.getHeadWindowEnd(ctx.messageStore);
    for (let i = headStartIdx; i < headEndIdx && i < allMessages.length; i++) {
      const m = allMessages[i];
      llmMessages.push({ participant: m.participant, content: m.content });
    }

    // ---- 1b. PRIOR RECALL PAIRS (chronologically before merge range) ----
    // The unmerged frontier of summaries whose source range is before the
    // merge range and which aren't part of the merge tree. Originally this
    // was filtered to `level === 1` (the "L1 fidelity for prior content"
    // intent) but at 4000+ messages that produces hundreds of L1s and
    // overflows the model window. Switching to the unmerged frontier
    // (`!mergedInto`) lets a merged L1 drop out in favour of its L2/L3
    // parent — the same rule used everywhere else and now in
    // `compressChunkHierarchical`. The cap below is the defense-in-depth.
    const priorSummariesAll = this.summaries
      // Skip empty-content summaries (see compressChunkHierarchical): an empty
      // text block in the merge recall header 400s and stalls compression.
      .filter((s) => !s.mergedInto && !!s.content && s.content.trim().length > 0)
      .filter((s) => {
        for (const lid of s.sourceIds) if (sourceLeafIds.has(lid)) return false;
        const firstIdx = allMessages.findIndex((m) => m.id === s.sourceRange.first);
        return firstIdx >= 0 && (mergeStartIdx < 0 || firstIdx < mergeStartIdx);
      })
      .sort((a, b) => {
        const ai = allMessages.findIndex((m) => m.id === a.sourceRange.first);
        const bi = allMessages.findIndex((m) => m.id === b.sourceRange.first);
        return ai - bi;
      });

    const mergeRecallBudget = this.config.compressionRecallBudgetTokens ?? 100_000;
    const { kept: keptPriorSummaries, keptTokens: mergeRecallTokens } = this.capRecallPairs(
      priorSummariesAll,
      mergeRecallBudget,
    );
    if (keptPriorSummaries.length < priorSummariesAll.length) {
      const dropped = priorSummariesAll.length - keptPriorSummaries.length;
      console.warn(
        `autobio: merge recall-pair budget capped (${keptPriorSummaries.length}/${priorSummariesAll.length} summaries kept, ` +
          `~${mergeRecallTokens} tokens, budget ${mergeRecallBudget}; ${dropped} oldest dropped this merge).`,
      );
      logCompressionCall({
        event: 'recall-budget-capped',
        site: 'merge',
        targetLevel,
        kept: keptPriorSummaries.length,
        total: priorSummariesAll.length,
        tokens: mergeRecallTokens,
        budgetTokens: mergeRecallBudget,
      });
    }

    // The full unmerged-frontier set covers what's "compressed somewhere"
    // for the raw-middle dedup below — a budget-dropped recall pair
    // doesn't make its underlying raw messages reappear.
    //
    // Critical: `sourceIds` on an L2+ summary points at L1 IDs, not raw
    // message IDs. The dedup happens against raw message IDs, so we must
    // recursively expand each summary down to its leaf message IDs.
    // Without this, every message under any L2 leaks back in as raw text
    // (Bug 10: 525-message merge requests on a 4234-msg conversation).
    // Also expand merged L1s as defense in depth.
    const priorSummaryMessageIds = new Set<MessageId>();
    for (const s of this.summaries) {
      if (s.level === 1) this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }
    for (const s of priorSummariesAll) {
      this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }

    for (const s of keptPriorSummaries) {
      llmMessages.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: `[CM] Recall memory ${s.id}.` }],
      });
      llmMessages.push({
        participant,
        content: [{ type: 'text', text: s.content }],
      });
    }

    // Raw middle: any messages between the head window and the merge
    // range that aren't covered by a prior summary or the merge tree.
    // Usually empty (chunking is contiguous).
    if (mergeStartIdx >= 0) {
      for (let i = headEndIdx; i < mergeStartIdx; i++) {
        const m = allMessages[i];
        if (priorSummaryMessageIds.has(m.id)) continue;
        if (sourceLeafIds.has(m.id)) continue;
        llmMessages.push({ participant: m.participant, content: m.content });
      }
    }

    // ---- 2. TARGET: expand sources one level deeper ----
    // For L2 (sources at L1, sourceLevel=0): expand to raw L0 messages.
    // For L3+ (sources at L_{n-1}, sourceLevel=n-2): expand to L_{n-2}
    //   summaries as recall pairs.
    for (const src of sources) {
      if (src.sourceLevel === 0) {
        // Source is an L1; its sourceIds are raw message ids. Emit them raw.
        for (const messageId of src.sourceIds) {
          const m = messageById.get(messageId);
          if (m) {
            llmMessages.push({ participant: m.participant, content: m.content });
          }
        }
      } else {
        // Source is L2+; its sourceIds point to summaries one level
        // below. Emit each as a recall pair.
        for (const childId of src.sourceIds) {
          const child = summariesById.get(childId);
          if (!child) continue;
          llmMessages.push({
            participant: 'Context Manager',
            content: [{ type: 'text', text: `[CM] Recall memory ${child.id}.` }],
          });
          llmMessages.push({
            participant,
            content: [{ type: 'text', text: child.content }],
          });
        }
      }
    }

    // ---- 3. INSTRUCTION ----
    // sourceLevelShown is the level of content the model actually sees
    // (one level below the sources themselves).
    const sourceLevelShown =
      sources[0].sourceLevel === 0 ? 0 : sources[0].level - 1;

    // Reading-mode detection: when ALL the merge's leaf messages are
    // shards of the same bodyGroup, we know the agent was reading a
    // substantially larger message rather than conversing. The
    // reading-mode merge instruction asks what reading the stretch was
    // like instead of asking for an impersonal consolidation, which
    // forces the agent's vantage point and prevents drift into the
    // content author's voice. Same principle as the L1 case.
    let mergeReadingContext: { totalTokens: number } | null = null;
    if (sourceLeafIds.size > 0) {
      const leafBodyGroupIds = new Set<string | undefined>();
      for (const leafId of sourceLeafIds) {
        const m = messageById.get(leafId);
        leafBodyGroupIds.add(m?.bodyGroupId);
      }
      if (leafBodyGroupIds.size === 1) {
        const groupId = [...leafBodyGroupIds][0];
        if (groupId) {
          let totalTokens = 0;
          for (const m of allMessages) {
            if (m.bodyGroupId === groupId) {
              totalTokens += ctx.messageStore.estimateTokens(m);
            }
          }
          mergeReadingContext = { totalTokens };
        }
      }
    }
    const mergeInstructionText = mergeReadingContext
      ? this.getReadingMergeInstruction(
          targetLevel,
          sources,
          mergeReadingContext.totalTokens,
          targetTokens,
        )
      : this.getMergeInstruction(targetLevel, sources, targetTokens);
    llmMessages.push({
      participant: 'Context Manager',
      content: [{
        type: 'text',
        text: mergeInstructionText,
      }],
    });

    // Same bundled-tool-cycle defense as compressChunkHierarchical.
    const split = splitMixedToolMessages(llmMessages);
    const collapsed = this.collapseConsecutiveMessages(split);
    const cleaned = stripUnpairedToolBlocks(collapsed);

    // Byte wall on the MERGE prompt too (2026-07-12). A merge expands its
    // sources ONE LEVEL DEEPER — an L2 merge therefore replays the RAW
    // messages under its L1s, images and all (including screenshots nested in
    // tool_results). This is the path that kept tripping membrane's transport
    // shed at 27MB after the L1 site was already capped. Own it here.
    this.capCompressionImageBytes(
      cleaned as Array<{ content: ContentBlock[] }>,
      this.config.maxCompressionImageBytes ??
        AutobiographicalStrategy.DEFAULT_MAX_COMPRESSION_IMAGE_BYTES,
    );

    // NO system prompt — identity is established by the head window
    // (present at the start of llmMessages above) and by the prior
    // recall pairs. Same rationale as compressChunkHierarchical.
    const request: NormalizedRequest = {
      // EXPLICIT image-loss opt-in (2026-07-12): summarizer prompts replay
      // raw history that can carry more inline image bytes than the API's
      // request cap. Dropping the OLDEST images from the summarizer's view is
      // acceptable policy here — the summary describes the span, it does not
      // preserve pixels — and membrane error-logs every exercised shed. All
      // other callers fail loudly instead (no silent transport mutation).
      shedOversizeImages: true,
      // Sanitize: strip empty text blocks (`{type:'text',text:''}`) and drop any
      // message left with no content. An empty-content turn (e.g. a silent/skip
      // turn that produced no text) otherwise reaches the API as an empty text
      // block → 400 "text content blocks must be non-empty", which throws in the
      // speculative drain and stalls ALL compression. (Twin of the empty-summary
      // recall-header guard — together they cover every source of the 400.)
      messages: cleaned
        .map(m => ({ participant: m.participant, content: stripThinkingBlocks(stripEmptyTextBlocks(m.content)) }))
        .filter(m => m.content.length > 0),
      config: {
        model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
        // Generous output ceiling so a memory-write is never truncated mid-thought:
        // targetTokens is a *target*, not a cap, and adaptive models routinely
        // overshoot a ~2k target. Was `* 1.5` (=3000 at the 2k default), which cut
        // off rich memories (stop=max_tokens).
        maxTokens: Math.max(16000, Math.round(targetTokens * 1.5)),
      },
      // Declare the agent's live tools. A summarizer request that replays
      // tool_use/tool_result history with NO tools param reads to Anthropic's
      // safety classifier as a foreign agent trace being duplicated ->
      // deterministic reasoning_extraction refusal of every memory-write
      // (labclaude incident, 2026-07-09; 268 refusals). Declaring the same
      // tools the live instance runs with is also strictly MORE faithful to
      // the original context, so it is the KV-honest choice, not a
      // workaround. Undefined before the first activation of a session --
      // acceptable: those chunks stay raw and are retried after the agent's
      // first turn (see the defer guard in compressChunkHierarchical).
      tools: ctx.tools,
    };

    const callStart = Date.now();
    let logResponse: string | undefined;
    let logError: string | undefined;
    let logNewSummaryId: string | undefined;

    try {
      const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
      // Text-only on purpose: summarizer scratch thinking is not agent history
      const mergedText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      logResponse = mergedText;

      // Empty merged generation: skip the merge entirely (do NOT push or mark
      // sources merged) so we never store/recall an empty summary. Sources stay
      // unmerged and can be retried.
      if (!mergedText.trim()) {
        console.warn(`[autobiographical] empty merged L${targetLevel} summary (${sources.length} sources) — skipping merge`);
        return;
      }

      // Compute source range from constituent summaries
      const sourceRange = {
        first: sources[0].sourceRange.first,
        last: sources[sources.length - 1].sourceRange.last,
      };

      const sourceLevel = (targetLevel - 1) as 0 | 1 | 2;
      const newEntry: SummaryEntry = {
        id: `L${targetLevel}-${this.nextSummaryIdCounter()}`,
        level: targetLevel,
        content: mergedText,
        // Exact when available — see the L1 site.
        tokens:
          response.usage?.outputTokens &&
          response.usage.outputTokens > 0 &&
          // outputTokens includes scratch thinking when present — only exact
          // when the whole response is the summary text itself.
          !response.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')
            ? response.usage.outputTokens
            : Math.ceil(mergedText.length / 3),
        sourceLevel,
        sourceIds,
        sourceRange,
        created: Date.now(),
      };
      logNewSummaryId = newEntry.id;

      // Append the new merged entry first, then mark sources. Persist each
      // mergedInto edit individually so chronicle reflects the same shape as
      // the in-memory mirror. (If the process crashes mid-loop, restart sees
      // the new entry plus a partial set of marked sources; un-marked sources
      // would re-trigger a merge — accept the rare duplicate over data loss.)
      this.pushSummary(newEntry);

      for (const source of sources) {
        this.setMergedInto(source, newEntry.id);
      }

      // Check if this merge triggers a further merge
      this.checkMergeThreshold();
    } catch (error) {
      console.error(`Failed to merge summaries into L${targetLevel}:`, error);
      logError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      logCompressionCall({
        operation: `merge_l${targetLevel}`,
        system: null,
        messages: cleaned.map((m) => ({
          participant: m.participant,
          text: m.content
            .filter((b: ContentBlock) => b.type === 'text')
            .map((b: any) => b.text)
            .join(''),
        })),
        metadata: {
          target_level: targetLevel,
          source_ids: sourceIds,
          source_level: sources[0]?.level ?? null,
          source_level_shown: sourceLevelShown,
          target_tokens: targetTokens,
          model: this.config.compressionModel ?? 'claude-sonnet-4-20250514',
          latency_ms: Date.now() - callStart,
          summary_id: logNewSummaryId,
        },
        response: logResponse,
        error: logError,
      });
    }
  }

  // ============================================================================
  // Adaptive resolution (picker-driven) path
  // ============================================================================

  /**
   * Select context entries using the adaptive-resolution picker.
   *
   * Builds per-message PickerChunks from compressible messages, runs the
   * configured FoldingStrategy under token-budget pressure, and emits the
   * resulting per-message resolutions as ContextEntry[]. Adjacent messages
   * sharing the same L_k ancestor emit the recall pair once.
   *
   * See `docs/adaptive-resolution-design.md` §3, §5.
   */
  protected selectAdaptive(store: MessageStoreView, budget: TokenBudget): ContextEntry[] {
    phaseChannel.report('context-build'); // liveness-watchdog phase
    this.rsBegin();
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    const overBudgetGraceRatio = Math.max(0, this.config.overBudgetGraceRatio ?? 0);
    const rejectionBudget = Math.floor(maxTokens * (1 + overBudgetGraceRatio));
    // Closed-loop calibration: apply the persisted multiplier BEFORE any
    // estimate is taken this compile.
    this.loadCalibration(store);
    const messages = store.getAll();
    const msgCap = this.config.maxMessageTokens;
    // Post-strip estimates (see postStripEstimates): every budgeting site in
    // this method prices a message the way the stripped render will cost it.
    const pse = this.postStripEstimates(store);

    // ----- 1. Build head/tail sets and reserve the tail before emitting -----
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);

    const headMessageIds = new Set<MessageId>();
    const tailMessageIds = new Set<MessageId>();
    let headTokens = 0;
    let tailTokens = 0;

    // Compute the fixed raw windows first. They are hard reservations, not
    // best-effort phases: foldable history may use only the space left after
    // every head and tail message has been accounted for.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
      headMessageIds.add(msg.id);
      headTokens += tokens;
    }
    const effectiveRecentStart = Math.max(recentStart, headEnd);
    for (let i = effectiveRecentStart; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
      tailMessageIds.add(msg.id);
      tailTokens += tokens;
    }

    if (headTokens + tailTokens > rejectionBudget) {
      throw new OverBudgetError({
        budget: rejectionBudget,
        actual: headTokens + tailTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: 0,
          middleChunkCount: Math.max(0, effectiveRecentStart - headEnd),
          deepestLevel: 0,
        },
      });
    }

    const prefixBudget = rejectionBudget - tailTokens;
    let totalTokens = 0;

    // Emit the already-reserved head entries verbatim.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      totalTokens += tokens;
      this.rsRaw('head', tokens);
    }
    // (Cache breakpoints are placed in one pass over the FINAL ordered entries
    // below — see placeCacheMarkers — capturing the stable folded prefix, not
    // just the head boundary.)

    // ----- 2. Build PickerChunks for messages in the middle -----
    // For each compressible (non-head, non-tail) message we create one
    // PickerChunk. Its l1Id is determined by the existing chunks that
    // group messages into L1 summaries.
    const chunksByMessageId = new Map<MessageId, Chunk>();
    for (const ch of this.chunks) {
      for (const m of ch.messages) {
        chunksByMessageId.set(m.id, ch);
      }
    }

    // Pinned-position set so the picker doesn't fold messages the user
    // explicitly marked as keep-raw. Built once and reused.
    const pinnedSet = this.pinnedPositions(messages);
    // V2 dynamic-pin fold-depth bounds (level / maxLevel). A position with a
    // bound is NOT a classic force-raw pin — the KV-stable controller must be
    // able to move it to/within its bound — so it renders as `pinned: false`
    // carrying `pinLevel` / `pinMaxLevel` instead.
    const pinBounds = this.pinLevelBounds(messages);

    // O(1) summary lookup for findAncestorAt — avoids O(summaries) find()
    // calls during emission.
    const summariesById = new Map<string, SummaryEntry>();
    for (const s of this.summaries) summariesById.set(s.id, s);

    const pickerChunks: PickerChunk[] = [];
    for (let i = headEnd; i < effectiveRecentStart && i < messages.length; i++) {
      const msg = messages[i];
      const ch = chunksByMessageId.get(msg.id);
      const tokens = msgCap > 0
        ? Math.min(pse[i], msgCap + 50)
        : pse[i];
      const bound = pinBounds.get(i);
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: this.resolutions.get(msg.id) ?? 0,
        lockedByAgent: this.locked.has(msg.id),
        // A classic pin (in pinnedSet with no level bound) stays force-raw. A
        // leveled pin is not force-raw; it carries its bound instead.
        pinned: pinnedSet.has(i) && bound === undefined,
        pinLevel: bound?.level,
        pinMaxLevel: bound?.maxLevel,
        l1Id: ch?.summaryId,
        salience: AutobiographicalStrategy.staticSalience(msg),
      });
    }

    // Also include head and tail in PickerChunks (so token accounting matches)
    // — but mark them as in-head/in-tail so the picker won't fold them.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0
        ? Math.min(pse[i], msgCap + 50)
        : pse[i];
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: 0,
        lockedByAgent: this.locked.has(msg.id),
        pinned: true, // treat head as pinned for picker purposes
        l1Id: undefined,
      });
    }
    for (let i = effectiveRecentStart; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0
        ? Math.min(pse[i], msgCap + 50)
        : pse[i];
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: 0,
        lockedByAgent: this.locked.has(msg.id),
        pinned: true, // treat tail as pinned for picker purposes
        l1Id: undefined,
      });
    }

    // ----- 3. Build summaries map and recall-pair tokens -----
    const summariesMap = new Map<SummaryId, SummaryEntry>();
    const recallPairTokens = new Map<SummaryId, number>();
    for (const s of this.summaries) {
      summariesMap.set(s.id, s);
      // recall pair = the summary's text wrapped as a Q&A pair. Approximate
      // as s.tokens + small overhead for the "What do you remember?" label.
      recallPairTokens.set(s.id, s.tokens + 20);
    }

    // ----- 4. Run the picker -----
    // The picker's token count ALREADY includes the pinned head+tail (it gets
    // headTokens/tailTokens in pickerInputs and result.finalTokens covers them).
    // So the budget it folds against is the full maxTokens — NOT maxTokens-head,
    // which double-counts the head (reserves it twice: once here, once because
    // finalTokens already includes it). The old form threw ~head-tokens early at
    // tight budgets and quietly under-used the budget by ~head everywhere.
    const totalBudget = maxTokens;
    const slack = this.config.compressionSlackRatio ?? 0.1;
    const foldingBudget: FoldingBudget = {
      totalBudget,
      targetBudget: totalBudget * (1 - slack),
      slack,
    };

    const headSetForPicker = new Set<ChunkId>(headMessageIds);
    const tailSetForPicker = new Set<ChunkId>(tailMessageIds);

    const pickerInputs: PickerInputs = {
      chunks: pickerChunks,
      summaries: summariesMap,
      recallPairTokens,
      headChunkIds: headSetForPicker,
      tailChunkIds: tailSetForPicker,
      headTokens,
      tailTokens,
    };
    const picker = this.buildPicker(pickerInputs);
    const result = picker.run(pickerInputs, foldingBudget);

    // Every trust-region override is loud (design §13.4) — silence was half
    // of the 2026-07-12 incident.
    const plan = this._lastKvStable?.lastPlan();
    if (plan?.override) {
      console.error(
        `[kv-escalation] override=${plan.override} perturbation=${plan.perturbation}` +
          ` tokens=${plan.tokens} budget=${foldingBudget.totalBudget}` +
          ` (see adaptive-resolution-design.md §13.4)`,
      );
    }

    // Commit the new resolutions back to strategy state for next compile.
    // Persist to chronicle only if anything actually changed — avoids
    // unnecessary state-slot writes on no-op compiles (which is the common
    // case in steady state with slack).
    let resolutionsChanged = false;
    let deepestLevel = 0;
    for (const [id, level] of result.finalResolutions) {
      if (headMessageIds.has(id) || tailMessageIds.has(id)) continue;
      if (this.locked.has(id)) continue;
      const prev = this.resolutions.get(id) ?? 0;
      if (prev !== level) {
        this.resolutions.set(id, level);
        resolutionsChanged = true;
      }
      if (level > deepestLevel) deepestLevel = level;
    }
    if (resolutionsChanged) {
      this.persistResolutions();
    }

    // Wire produce ops into the strategy's own production queues so that
    // requested-but-not-yet-existing summaries actually get built. The
    // speculative pre-producer covers most cases ambiently, but when it is
    // disabled (`speculativeProduction: false`) or hasn't reached the level
    // the picker just asked for, the request would otherwise be dropped and
    // the picker would re-emit it on every subsequent compile. Handling it
    // here makes the produce path observable and convergent.
    //
    // The actual compression/merge work runs asynchronously via the next
    // `tick()` invocation (or the speculative drain kicked from
    // `onNewMessage`). This call only enqueues; it does not await.
    if (result.produced.length > 0) {
      this.handleProducedOps(result.produced);
    }

    // Hard-fail whenever the picker's current plan exceeds the hard budget.
    // A `produce` op only schedules a missing summary; it does not make the
    // current raw plan feasible and must never authorize an inference.
    if (result.finalTokens > rejectionBudget) {
      throw new OverBudgetError({
        budget: rejectionBudget,
        actual: result.finalTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: Math.max(0, result.finalTokens - headTokens - tailTokens),
          middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
          deepestLevel,
        },
      });
    }

    // ----- 5. Emit middle entries in source order -----
    // Walk middle messages. Handle two cases:
    //  - bodyGroupId set: collect all consecutive shards from the same group,
    //    emit ONE combined entry with concatenated content (raw shards + inline
    //    summary text for folded shards). This preserves KV — the model sees
    //    one continuous user message instead of N turns.
    //  - bodyGroupId absent: emit normally (raw L0 message, or Q+A summary pair).
    const emittedAncestors = new Set<SummaryId>();
    const summaryLabel = this.config.summaryContextLabel ?? 'What do you remember from earlier?';
    const summaryParticipant = this.config.summaryParticipant ?? 'Claude';

    let i = headEnd;
    while (i < effectiveRecentStart && i < messages.length) {
      const msg = messages[i];

      if (msg.bodyGroupId) {
        // Collect the full run of consecutive shards sharing this bodyGroupId.
        const groupId = msg.bodyGroupId;
        const groupStart = i;
        while (
          i < effectiveRecentStart &&
          i < messages.length &&
          messages[i].bodyGroupId === groupId
        ) {
          i++;
        }
        const groupMessages = messages.slice(groupStart, i);
        // Sort by shardIndex to ensure byte-faithful ordering.
        const sortedShards = [...groupMessages].sort(
          (a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0)
        );

        // Walk shards in order, accumulating "runs":
        //  - a 'raw' run is consecutive shards at L0; flushed as ONE User
        //    message with their text concatenated.
        //  - a 'summary' run is consecutive shards under the same L_k
        //    ancestor; flushed as a Q+A recall pair (Context Manager
        //    question + summaryParticipant answer), emitted once per
        //    distinct ancestor.
        // The run breaks (and the previous run flushes) when:
        //  - resolution transitions raw ↔ folded
        //  - the L_k ancestor changes
        type Run =
          | { kind: 'raw'; parts: string[] }
          | { kind: 'summary'; ancestor: SummaryEntry };
        let currentRun: Run | null = null;
        const participant = sortedShards[0].participant;

        const flushRun = (): boolean => {
          if (!currentRun) return true;
          if (currentRun.kind === 'raw') {
            const text = currentRun.parts.join('');
            const content: ContentBlock[] = [{ type: 'text', text }];
            // Deliberately do NOT apply maxMessageTokens here: the picker
            // is the authority on how much of the doc renders raw vs.
            // summarized. Truncating the composite would silently lose
            // doc content that the picker explicitly chose to keep raw.
            // (`maxMessageTokens` is for per-message caps on chat / tool
            // results, not for sharded bodyGroup composites.)
            const tokens = this.estimateTokens(content);
            if (totalTokens + tokens > prefixBudget) {
              currentRun = null;
              return false;
            }
            entries.push({
              index: entries.length,
              sourceMessageId: undefined,
              sourceRelation: 'copy',
              participant,
              content,
            });
            totalTokens += tokens;
            this.rsRaw('middleRaw', tokens);
          } else {
            // summary run — emit Q+A pair, dedup at the strategy level
            const ancestor = currentRun.ancestor;
            if (!emittedAncestors.has(ancestor.id)) {
              emittedAncestors.add(ancestor.id);
              const questionEntry: ContextEntry = {
                index: entries.length,
                participant: 'Context Manager',
                content: [{ type: 'text', text: summaryLabel }],
                sourceRelation: 'derived',
              };
              const answerContent: ContentBlock[] = [{ type: 'text', text: ancestor.content }];
              const answerEntry: ContextEntry = {
                index: entries.length + 1,
                participant: summaryParticipant,
                content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
                sourceRelation: 'derived',
              };
              const pairTokens = this.estimateTokens(questionEntry.content) + this.estimateTokens(answerEntry.content);
              if (totalTokens + pairTokens > prefixBudget) {
                currentRun = null;
                return false;
              }
              entries.push(questionEntry);
              entries.push(answerEntry);
              totalTokens += pairTokens;
              this.rsSummary(ancestor.level, pairTokens);
            }
          }
          currentRun = null;
          return true;
        };

        let budgetExhausted = false;
        for (const shard of sortedShards) {
          const resolution = result.finalResolutions.get(shard.id) ?? 0;
          if (resolution === 0) {
            if (currentRun?.kind !== 'raw') {
              if (!flushRun()) { budgetExhausted = true; break; }
              currentRun = { kind: 'raw', parts: [] };
            }
            for (const block of shard.content) {
              if (block.type === 'text') (currentRun as { kind: 'raw'; parts: string[] }).parts.push(block.text);
            }
          } else {
            const ancestor = this.findAncestorAt(shard.id, resolution, chunksByMessageId, summariesById);
            if (!ancestor) {
              // Fall back to raw
              if (currentRun?.kind !== 'raw') {
                if (!flushRun()) { budgetExhausted = true; break; }
                currentRun = { kind: 'raw', parts: [] };
              }
              for (const block of shard.content) {
                if (block.type === 'text') (currentRun as { kind: 'raw'; parts: string[] }).parts.push(block.text);
              }
              continue;
            }
            // If we're already in a summary run for the SAME ancestor, this
            // shard is covered — skip silently.
            if (currentRun?.kind === 'summary' && currentRun.ancestor.id === ancestor.id) {
              continue;
            }
            if (!flushRun()) { budgetExhausted = true; break; }
            currentRun = { kind: 'summary', ancestor };
          }
        }
        if (!budgetExhausted) {
          if (!flushRun()) budgetExhausted = true;
        }
        if (budgetExhausted) break;
        continue;
      }

      // Non-shard path: existing behavior.
      const resolution = result.finalResolutions.get(msg.id) ?? 0;
      if (resolution === 0) {
        const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
        const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
        if (totalTokens + tokens > prefixBudget) break;
        entries.push({
          index: entries.length,
          sourceMessageId: msg.id,
          sourceRelation: 'copy',
          participant: msg.participant,
          content,
        });
        totalTokens += tokens;
        this.rsRaw('middleRaw', tokens);
        i++;
      } else {
        const ancestor = this.findAncestorAt(msg.id, resolution, chunksByMessageId, summariesById);
        if (!ancestor) {
          const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
          const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
          if (totalTokens + tokens > prefixBudget) break;
          entries.push({
            index: entries.length,
            sourceMessageId: msg.id,
            sourceRelation: 'copy',
            participant: msg.participant,
            content,
          });
          totalTokens += tokens;
          this.rsRaw('middleRaw', tokens);
          i++;
          continue;
        }
        if (emittedAncestors.has(ancestor.id)) {
          i++;
          continue;
        }
        emittedAncestors.add(ancestor.id);
        const questionEntry: ContextEntry = {
          index: entries.length,
          participant: 'Context Manager',
          content: [{ type: 'text', text: summaryLabel }],
          sourceRelation: 'derived',
        };
        const answerContent: ContentBlock[] = [{ type: 'text', text: ancestor.content }];
        const answerEntry: ContextEntry = {
          index: entries.length + 1,
          participant: summaryParticipant,
          content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
          sourceRelation: 'derived',
        };
        const pairTokens = this.estimateTokens(questionEntry.content) + this.estimateTokens(answerEntry.content);
        if (totalTokens + pairTokens > prefixBudget) break;
        entries.push(questionEntry);
        entries.push(answerEntry);
        totalTokens += pairTokens;
        this.rsSummary(ancestor.level, pairTokens);
        i++;
      }
    }

    // ----- 6. Emit the fully-reserved tail -----
    const tailStats = this.emitRecentNewestFirst(entries, store, messages, effectiveRecentStart, msgCap, rejectionBudget, totalTokens, pse);
    if (tailStats.messages !== messages.length - effectiveRecentStart) {
      throw new OverBudgetError({
        budget: rejectionBudget,
        actual: totalTokens + tailTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: totalTokens - headTokens,
          middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
          deepestLevel,
        },
      });
    }
    this.rsRaw('tail', tailStats.tokens, tailStats.messages);

    // ----- 7. Post-process: merge consecutive raw entries from the same bodyGroup -----
    // Both head and tail emission paths emit shards as separate ContextEntries.
    // The middle path already merges consecutive same-bodyGroup raw shards into
    // one composite entry, but head/tail don't. This pass closes that gap so
    // a sharded message renders as ONE API message regardless of which region
    // it falls into (preserves KV cache through region transitions).
    const merged = this.mergeAdjacentBodyGroupRaw(entries, store);

    this.pruneToolEntries(merged);
    this.trimOrphanedToolUse(merged);
    // Full pairing invariant over the final rendered context — catches the
    // mid-list orphans the trailing/leading trims can't (bug 6.7). The adaptive
    // path has the same mid-list orphan producers as hierarchical (budget
    // `break`s between pair members, raw emission interleaved with recall
    // pairs), and FKM defaults autobiographical strategies onto this path — so
    // the guard has to run here too. It's a no-op on already-valid output.
    this.enforceToolPairing(merged);
    // Strip stale images BEFORE placing markers and committing stats, so both
    // describe the post-strip context the agent actually receives.
    this.applyImageStripping(merged, store);

    // The newest stored message is the triggering turn for this compile. A
    // structural repair may rewrite tool blocks, but it must never erase that
    // turn. Body-group shards merge under the first shard's source id, so any
    // surviving member of the same group proves the newest shard is present.
    const newest = messages[messages.length - 1];
    if (newest) {
      const newestGroupIds = newest.bodyGroupId
        ? new Set(messages.filter(m => m.bodyGroupId === newest.bodyGroupId).map(m => m.id))
        : new Set([newest.id]);
      const newestRetained = merged.some(
        entry => entry.sourceMessageId && newestGroupIds.has(entry.sourceMessageId),
      );
      if (!newestRetained) {
        throw new OverBudgetError({
          budget: rejectionBudget,
          actual: totalTokens + tailTokens,
          diagnostics: {
            headTokens,
            tailTokens,
            middleTokens: totalTokens - headTokens,
            middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
            deepestLevel,
          },
        });
      }
    }
    // Place ≤4 cache breakpoints across the FINAL ordered entries so the
    // provider can reuse the stable folded prefix — not just the head. With a
    // single head marker the cache hit is ~2%; well-placed breakpoints take the
    // real strategy to ~50% (docs/kv-stable-context-control.md — marker
    // placement is the dominant KV lever).
    this.placeCacheMarkers(merged, headMessageIds, tailMessageIds);
    this.rsEnd();
    // Closed-loop calibration bookkeeping: the committed render stats total
    // (in CURRENT calibrated units) is what this compile claims the request
    // will cost — reportRealInputTokens compares provider usage against it.
    this._storeView = store;
    const rs = this.getRenderStats(store);
    this._lastCompileEstimate =
      rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens +
      rs.summaries.l1.tokens + rs.summaries.l2.tokens + rs.summaries.l3.tokens;
    this._calibrationArmed = true; // exactly one sample per compile
    return merged;
  }

  private _lastCompileEstimate = 0;
  private _storeView: MessageStoreView | null = null;

  /**
   * Closed-loop estimator calibration (2026-07-12). Feed the REAL input total
   * for a request built from the latest compile (fresh + cache_read +
   * cache_creation, minus non-window overhead the caller knows about, e.g.
   * tool schemas). Maintains an EMA of real/estimated and applies it as the
   * store's global multiplier, persisted across restarts. The per-class rates
   * carry the shape; this carries the residual level.
   */
  reportRealInputTokens(realTotal: number): void {
    if (!Number.isFinite(realTotal) || realTotal <= 0) return;
    const est = this._lastCompileEstimate;
    if (!est || est <= 0) return;

    // ARM-ONCE-PER-COMPILE (2026-07-12 regression fix). A turn makes MANY API
    // calls — tool-use rounds and max_tokens continuations each append to the
    // request — so only the FIRST completion after a compile was built from
    // the window this estimate describes. Feeding later calls compares a grown
    // request against the original estimate: ratios of 2.0-2.3 (est=224k
    // real=504k) drove the multiplier 1.0 -> 2.37 in minutes, inflating every
    // estimate (the fold floor went 62k -> 108k on unchanged content) and
    // exhausting the picker on every wake. One sample per compile, always.
    if (!this._calibrationArmed) return;
    this._calibrationArmed = false;

    const ratio = realTotal / est;
    // SANITY BAND: a representative sample sits near 1. Anything wilder is a
    // structural mismatch (a request we didn't compile, a partial compile, a
    // provider quirk) — never evidence about chars-per-token. Log, don't learn.
    if (ratio < 0.6 || ratio > 1.8) {
      console.error(
        `[estimator-calibration] REJECTED out-of-band sample real/est=${ratio.toFixed(2)} ` +
          `(est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k) — ` +
          `not a window-shaped request; multiplier stays ${this._calibration.toFixed(2)}`,
      );
      return;
    }

    const current = this._calibration;
    const observed = ratio * current; // back out the multiplier already applied
    const alpha = 0.2; // slow EMA: one wild request shouldn't yank the ruler
    const next = current + alpha * (observed - current);
    const clamped = Math.min(1.8, Math.max(0.6, next));
    if (Math.abs(clamped - current) / current > 0.02) {
      console.error(
        `[estimator-calibration] real/est=${ratio.toFixed(2)} ` +
          `multiplier ${current.toFixed(2)} -> ${clamped.toFixed(2)} (est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k)`,
      );
    }
    this._calibration = clamped;
    this.applyCalibration();
    try {
      this.store?.setStateJson(this.calibrationStateId, { multiplier: this._calibration, at: Date.now() });
    } catch { /* persistence is best-effort */ }
  }

  private _calibrationArmed = false;

  private _calibration = 1;
  private _calibrationLoaded = false;

  protected applyCalibration(): void {
    this._storeView?.setTokenCalibration?.(this._calibration);
  }

  /** Load the persisted multiplier once and push it into the store view. */
  protected loadCalibration(store: MessageStoreView): void {
    this._storeView = store;
    if (!this._calibrationLoaded) {
      this._calibrationLoaded = true;
      try {
        const saved = this.store?.getStateJson(this.calibrationStateId) as { multiplier?: number } | null;
        if (saved && Number.isFinite(saved.multiplier)) {
          this._calibration = Math.min(1.8, Math.max(0.6, saved.multiplier!));
        }
      } catch { /* absent slot is fine */ }
    }
    this.applyCalibration();
  }

  /**
   * Place up to four `cache_control` breakpoints across the final ordered
   * entries: the head/system boundary, the end of the folded history (the
   * stable prefix that persists turn-to-turn — the most valuable), a mid-history
   * seam, and the very end (for pure-append reuse). Mirrors `placeMarkers` in
   * the adaptive layer but operates on emitted entries. Idempotent; clears any
   * pre-existing markers first.
   */
  protected placeCacheMarkers(
    entries: ContextEntry[],
    headMessageIds: ReadonlySet<MessageId>,
    tailMessageIds: ReadonlySet<MessageId>,
  ): void {
    for (const e of entries) if (e.cacheMarker) e.cacheMarker = false;
    const n = entries.length;
    if (n === 0) return;

    let lastHead = -1;
    let firstTail = n;
    for (let i = 0; i < n; i++) {
      const sid = entries[i].sourceMessageId;
      if (sid && headMessageIds.has(sid)) lastHead = i;
    }
    for (let i = 0; i < n; i++) {
      const sid = entries[i].sourceMessageId;
      if (sid && tailMessageIds.has(sid)) { firstTail = i; break; }
    }
    const historyEnd = firstTail - 1; // last middle (folded-history) entry

    const marks = new Set<number>();
    if (lastHead >= 0) marks.add(lastHead);                       // system / head block
    if (historyEnd > lastHead) marks.add(historyEnd);            // stable folded prefix (the big one)
    if (historyEnd - lastHead > 2) marks.add(lastHead + Math.floor((historyEnd - lastHead) / 2)); // mid-history
    marks.add(n - 1);                                            // end → pure-append reuse

    for (const idx of marks) if (idx >= 0 && idx < n) entries[idx].cacheMarker = true;
  }

  /**
   * Walk an entries array; for every run of consecutive entries that
   *  (a) have sourceRelation: 'copy' (raw, not a synthesized recall pair)
   *  (b) have sourceMessageId pointing to messages in the same bodyGroup
   * merge them into one composite entry whose body is the byte-faithful
   * concatenation of their text content. Other entries pass through.
   *
   * Reindexes the returned array.
   */
  protected mergeAdjacentBodyGroupRaw(
    entries: ContextEntry[],
    store: MessageStoreView
  ): ContextEntry[] {
    if (entries.length === 0) return entries;

    // Look up bodyGroup metadata by sourceMessageId, memoized for the
    // duration of this pass. Entries reference the same messages repeatedly
    // (run-extension checks + the shardIndex sort comparator below), and
    // store.get() also resolves blobs — fetch each message at most once.
    const shardMeta = new Map<string, { groupId?: string; shardIndex?: number }>();
    const metaOf = (sourceMessageId?: string): { groupId?: string; shardIndex?: number } | undefined => {
      if (!sourceMessageId) return undefined;
      let meta = shardMeta.get(sourceMessageId);
      if (!meta) {
        const m = store.get(sourceMessageId);
        meta = { groupId: m?.bodyGroupId, shardIndex: m?.shardIndex };
        shardMeta.set(sourceMessageId, meta);
      }
      return meta;
    };
    const groupOf = (sourceMessageId?: string): string | undefined =>
      metaOf(sourceMessageId)?.groupId;

    const out: ContextEntry[] = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      const groupId = entry.sourceRelation === 'copy' ? groupOf(entry.sourceMessageId) : undefined;
      if (!groupId) {
        out.push({ ...entry, index: out.length });
        i++;
        continue;
      }
      // Collect run of consecutive raw entries with same bodyGroupId.
      const run: ContextEntry[] = [entry];
      let j = i + 1;
      while (
        j < entries.length &&
        entries[j].sourceRelation === 'copy' &&
        groupOf(entries[j].sourceMessageId) === groupId
      ) {
        run.push(entries[j]);
        j++;
      }
      if (run.length === 1) {
        out.push({ ...entry, index: out.length });
        i++;
        continue;
      }
      // Sort the run by the underlying shardIndex to ensure byte-faithful
      // ordering. (Head/tail emission keeps chronological order, but defending
      // against reorderings is cheap.)
      const sortedRun = [...run].sort((a, b) => {
        const sa = metaOf(a.sourceMessageId)?.shardIndex ?? 0;
        const sb = metaOf(b.sourceMessageId)?.shardIndex ?? 0;
        return sa - sb;
      });
      // Build merged text content. Non-text blocks (rare in shards) are
      // preserved on the first shard's entry only.
      const mergedTextParts: string[] = [];
      const nonTextBlocks: ContentBlock[] = [];
      for (const r of sortedRun) {
        for (const block of r.content) {
          if (block.type === 'text') mergedTextParts.push(block.text);
          else nonTextBlocks.push(block);
        }
      }
      const mergedContent: ContentBlock[] = [
        ...nonTextBlocks,
        { type: 'text', text: mergedTextParts.join('') },
      ];
      out.push({
        index: out.length,
        sourceMessageId: sortedRun[0].sourceMessageId,
        sourceRelation: 'copy',
        participant: sortedRun[0].participant,
        content: mergedContent,
      });
      i = j;
    }
    return out;
  }

  /** Get (lazily constructing) the configured picker instance. */
  protected getAdaptivePicker(): Picker {
    if (this._adaptivePicker) return this._adaptivePicker;
    const strategy: FoldingStrategy =
      this.config.foldingStrategy === 'oldest-first'
        ? new OldestFirstStrategy()
        : new FlatProfileStrategy();
    this._adaptivePicker = new Picker(strategy);
    return this._adaptivePicker;
  }

  /**
   * Build the picker for this compile. Instance folding strategies (kv-stable)
   * need the per-compile `PickerInputs` at construction, so they're built fresh
   * here; stateless ones (flat-profile / oldest-first) reuse the memoized picker.
   */
  protected buildPicker(inputs: PickerInputs): Picker {
    if (this.config.foldingStrategy === 'kv-stable') {
      const strategy = new KvStableStrategy(inputs, {
        reachTokens: this.config.kvStableReachTokens,
        qualityGapRatio: this.config.kvStableQualityGapRatio,
        mergeThreshold: this.config.mergeThreshold,
      });
      this._lastKvStable = strategy;
      return new Picker(strategy);
    }
    this._lastKvStable = null;
    return this.getAdaptivePicker();
  }

  /** The kv-stable strategy instance behind the most recent compile — kept for
   *  `[kv-escalation]` observability (design §13.4: every override is loud). */
  private _lastKvStable: KvStableStrategy | null = null;

  /**
   * Static salience prior (design §13.3) — "is the window the only copy?".
   * Content whose payload is externalized folds cheap: tool blocks
   * (re-derivable), fenced code (usually written to disk), images (the file/
   * CDN keeps them), bare link drops. Conversation exists nowhere but the
   * chronicle, so it stays at 1. Returns a value in [0.2, 1]; cheap,
   * deterministic, computed per message at picker-input construction.
   */
  protected static staticSalience(msg: StoredMessage): number {
    let totalChars = 0;
    let externalChars = 0;
    for (const block of msg.content) {
      const b = block as {
        type?: string;
        text?: string;
        input?: unknown;
        content?: unknown;
      };
      switch (b.type) {
        case 'text': {
          const t = b.text ?? '';
          totalChars += t.length;
          // Fenced code blocks.
          const fences = t.split('```');
          for (let i = 1; i < fences.length; i += 2) externalChars += fences[i].length;
          // Bare link-drop lines (the URL is the payload).
          for (const line of t.split('\n')) {
            const trimmed = line.trim();
            if (/^https?:\/\/\S+$/.test(trimmed)) externalChars += trimmed.length;
          }
          break;
        }
        case 'tool_use': {
          const n = JSON.stringify(b.input ?? {}).length;
          totalChars += n;
          externalChars += n;
          break;
        }
        case 'tool_result': {
          const n =
            typeof b.content === 'string'
              ? b.content.length
              : JSON.stringify(b.content ?? '').length;
          totalChars += n;
          externalChars += n;
          break;
        }
        case 'image': {
          // Estimate parity with the renderer's flat image cost; the payload
          // lives in the file/CDN, so it is fully externalized.
          totalChars += 6400; // ≈1600 tokens × 4 chars
          externalChars += 6400;
          break;
        }
        default: {
          const t = (b as { text?: string }).text ?? '';
          totalChars += t.length;
        }
      }
    }
    if (totalChars <= 0) return 1;
    const externalized = Math.min(1, externalChars / totalChars);
    // Fully-externalized content bottoms out at 0.2 — cheap, never free
    // (hard protections, not salience, are what make content unfoldable).
    return Math.max(0.2, 1 - 0.8 * externalized);
  }

  /**
   * Walk the summary tree to find the L_k ancestor of a message.
   * Returns null if no ancestor exists at that level (e.g., L_k not yet produced).
   *
   * Takes a pre-built summariesById map to avoid O(summaries) lookups per
   * call — for a chronicle with thousands of summaries and hundreds of
   * middle messages, the O(n) `find` would dominate compile latency.
   */
  protected findAncestorAt(
    messageId: MessageId,
    level: number,
    chunksByMessageId: ReadonlyMap<MessageId, Chunk>,
    summariesById?: ReadonlyMap<string, SummaryEntry>,
  ): SummaryEntry | null {
    if (level <= 0) return null;
    const chunk = chunksByMessageId.get(messageId);
    if (!chunk?.summaryId) return null;
    const lookup = (id: string): SummaryEntry | undefined =>
      summariesById ? summariesById.get(id) : this.summaries.find((s) => s.id === id);
    let current: SummaryEntry | undefined = lookup(chunk.summaryId);
    while (current && current.level < level) {
      const parentId = getSummaryParentId(current);
      if (!parentId) return null;
      current = lookup(parentId);
    }
    if (!current || current.level !== level) return null;
    return current;
  }

  /**
   * Recursively expand a summary's `sourceIds` down to the leaf message IDs
   * it covers, adding each leaf into `out`.
   *
   * Required because `SummaryEntry.sourceIds` are level-relative: an L1's
   * sourceIds are raw message IDs (sourceLevel=0), but an L2's sourceIds
   * are L1 IDs (sourceLevel=1), and so on. Any dedup that walks `sourceIds`
   * directly only works for L1s — once L2+ summaries enter the picture
   * (which happens as soon as `mergeThreshold` L1s accumulate during
   * interleaved compression+merge ticks), the dedup silently fails and
   * already-summarized messages leak back into the request as raw text.
   * That's how Bug 10 produced 200k+ token merge prompts on a 4234-msg
   * import.
   *
   * Callers should also expand merged L1s (not just the unmerged frontier)
   * as defense in depth — a stale `mergedInto` pointer or a partially
   * applied merge shouldn't surface raw messages.
   *
   * `visited` guards against pathological cycles in the summary graph (a
   * corrupted store or a future merge regression that lets a summary
   * reference itself). The hierarchy is a DAG by construction, but a
   * stack overflow during compression — exactly when the safety net is
   * supposed to save the session — is too steep a price for trusting that.
   */
  protected expandSummaryToLeafMessageIds(
    summary: SummaryEntry,
    summariesById: ReadonlyMap<string, SummaryEntry>,
    out: Set<MessageId>,
    visited: Set<string> = new Set(),
  ): void {
    if (visited.has(summary.id)) return;
    visited.add(summary.id);
    if (summary.sourceLevel === 0) {
      for (const id of summary.sourceIds) out.add(id);
      return;
    }
    for (const childId of summary.sourceIds) {
      const child = summariesById.get(childId);
      if (child) this.expandSummaryToLeafMessageIds(child, summariesById, out, visited);
    }
  }

  // ============================================================================
  // Hierarchical (threshold-driven) path
  // ============================================================================

  /**
   * Select context entries using hierarchical compression with budget carryover.
   * Matches moltbot's budget waterfall: L3 → L2 → L1 with unused budget flowing down.
   */
  protected selectHierarchical(store: MessageStoreView, budget: TokenBudget): ContextEntry[] {
    phaseChannel.report('context-build'); // liveness-watchdog phase
    this.rsBegin();
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
      if (this.isOverBudget(totalTokens + tokens, maxTokens)) break;

      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      totalTokens += tokens;
      this.rsRaw('head', tokens);
    }
    // Mark the last head entry as a cache boundary (even if budget truncated the window)
    if (entries.length > 0) {
      entries[entries.length - 1].cacheMarker = true;
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
      if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) break;
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
      if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) break;
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

    // Phase 3b: coverage repair (bug 6.9). getAntiRedundantSummaries excluded
    // an L2 (or L3) when ALL of its children were in the CANDIDATE shown-set —
    // computed before budget selection. If the budget then dropped some of
    // those children (e.g. KnowledgeStrategy's research L1 cap), the covered
    // history appears at NEITHER level: a silent memory hole. Re-include any
    // excluded L2/L3 whose children did not all make the final selection.
    // Some overlap with the children that DID survive is accepted — coverage
    // beats perfect dedup here.
    //
    // Repairs are additionally bounded by a per-level ALLOWANCE (a fraction of
    // that level's budget), not just the overall context budget. The
    // excluded-with-partially-dropped-children state only arises from a store
    // damaged mid-merge (the crash window at compressChunkHierarchical, or the
    // legacy setMergedInto index-desync). On such a store MANY L2s can be in
    // this state at once; without a cap, re-including all of them at full size
    // would starve the recent window via Phase 4's newest-first eviction. When
    // repairs exceed the allowance we stop re-including and warn — a corrupted
    // store announces itself instead of silently trading recent messages for
    // redundant summaries.
    {
      // Allowance = a fraction of the level budget, with a floor tied to the
      // overall budget so a strategy that zeroes a level budget (e.g.
      // KnowledgeStrategy prioritising L1) can still repair a handful of
      // covering summaries, while a corrupted store with dozens of them stays
      // bounded well short of the recent window.
      const REPAIR_ALLOWANCE_FRACTION = 0.25;
      const REPAIR_FLOOR_FRACTION = 0.05;
      const repairFloor = maxTokens * REPAIR_FLOOR_FRACTION;
      const l2RepairAllowance = Math.max(l2Budget * REPAIR_ALLOWANCE_FRACTION, repairFloor);
      const l3RepairAllowance = Math.max(l3Budget * REPAIR_ALLOWANCE_FRACTION, repairFloor);
      const selectedIds = new Set(selectedSummaries.map(s => s.id));
      const shownL2Ids = new Set(shownL2.map(s => s.id));
      const shownL3Ids = new Set(shownL3.map(s => s.id));
      let l2RepairTokens = 0;
      let l3RepairTokens = 0;
      let l2RepairsSkipped = 0;
      let l3RepairsSkipped = 0;
      // L2s excluded by anti-redundancy: unmerged, not in shownL2.
      for (const s of this.summaries) {
        if (s.level !== 2 || s.mergedInto || shownL2Ids.has(s.id)) continue;
        if (s.sourceIds.every(id => selectedIds.has(id))) continue; // truly redundant
        if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) continue;
        if (l2RepairTokens + s.tokens > l2RepairAllowance) { l2RepairsSkipped++; continue; }
        selectedSummaries.push(s);
        totalSummaryTokens += s.tokens;
        l2RepairTokens += s.tokens;
        selectedIds.add(s.id);
      }
      // L3s excluded by anti-redundancy — after L2 repair, so a repaired L2
      // counts as selected coverage for its parent L3.
      for (const s of this.summaries) {
        if (s.level !== 3 || s.mergedInto || shownL3Ids.has(s.id)) continue;
        if (s.sourceIds.every(id => selectedIds.has(id))) continue;
        if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) continue;
        if (l3RepairTokens + s.tokens > l3RepairAllowance) { l3RepairsSkipped++; continue; }
        selectedSummaries.push(s);
        totalSummaryTokens += s.tokens;
        l3RepairTokens += s.tokens;
        selectedIds.add(s.id);
      }
      if (l2RepairsSkipped > 0 || l3RepairsSkipped > 0) {
        console.warn(
          `[AutobiographicalStrategy] coverage-repair allowance exceeded — ` +
          `skipped ${l2RepairsSkipped} L2 and ${l3RepairsSkipped} L3 re-inclusions ` +
          `(store likely corrupted mid-merge). Some covered history may render at ` +
          `no summary level this pass.`,
        );
      }
    }

    // Emit summaries + pinned messages between head and recent windows.
    //
    // Default (positionedRecallPairs=true): one Q/A pair per summary,
    // interleaved with raw pinned messages, all sorted chronologically by
    // source-range / message position. Each memory appears in its temporal
    // place rather than as a wall of unrelated recollections.
    //
    // Legacy (positionedRecallPairs=false): summaries concatenated into one
    // Q/A pair between head and tail; pinned messages still emit raw, in
    // their chronological positions, after the combined recall pair.
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      positionOf.set(messages[i].id, i);
    }
    const pinnedPositionsSet = this.pinnedPositions(messages);
    // Pinned messages between head and recent (head/recent pinned ones
    // already emit raw via Phase 0 / Phase 4).
    const pinnedInMiddle: { msg: StoredMessage; position: number }[] = [];
    const pinnedIdsInMiddle = new Set<string>();
    for (let i = headEnd; i < recentStart; i++) {
      if (pinnedPositionsSet.has(i)) {
        pinnedInMiddle.push({ msg: messages[i], position: i });
        pinnedIdsInMiddle.add(messages[i].id);
      }
    }

    // Uncompressed-chunk fallback: messages in the middle region whose
    // chunk hasn't been summarized yet. Without this, a message that
    // rolled out of the recent window into a queued-but-not-yet-compressed
    // chunk would vanish from rendered context — there'd be no summary to
    // emit (compression hasn't run) and Phase 4 only walks recentStart
    // onwards. Mirrors selectLegacy's "Uncompressed: emit raw" behavior
    // around line 738, but here we interleave chronologically with
    // summaries and pins via the unified items list below.
    //
    // This matters because compile() was made non-blocking in commit
    // `3e42e98` (drops the prior `await readiness.pendingWork`); without
    // this fallback, the trade was silent data-loss for messages caught
    // in the queued-but-not-yet-compressed window. Now compile()'s
    // freshness contract is: summaries may lag the very latest L1, but
    // no message ever disappears.
    const uncompressedInMiddle: { msg: StoredMessage; position: number }[] = [];
    for (const chunk of this.chunks) {
      if (chunk.compressed) continue;
      for (const msg of chunk.messages) {
        const pos = positionOf.get(msg.id);
        if (pos === undefined) continue;
        if (pos < headEnd || pos >= recentStart) continue;
        if (pinnedIdsInMiddle.has(msg.id)) continue;
        uncompressedInMiddle.push({ msg, position: pos });
      }
    }

    // Merged list of raw messages to emit in the middle region —
    // either a pin or a message whose chunk hasn't compressed yet.
    // Both render identically (raw, at their chronological position).
    const middleRaw: { msg: StoredMessage; position: number }[] = [
      ...pinnedInMiddle,
      ...uncompressedInMiddle,
    ];

    if (selectedSummaries.length > 0 || middleRaw.length > 0) {
      const summaryParticipant = this.config.summaryParticipant ?? 'Claude';

      if (this.config.positionedRecallPairs !== false) {
        // Build a unified, chronologically-sorted item list.
        type Item =
          | { kind: 'summary'; position: number; summary: SummaryEntry }
          | { kind: 'pin'; position: number; msg: StoredMessage };

        const items: Item[] = [];
        for (const s of selectedSummaries) {
          const pos = positionOf.get(s.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
          items.push({ kind: 'summary', position: pos, summary: s });
        }
        for (const p of middleRaw) {
          items.push({ kind: 'pin', position: p.position, msg: p.msg });
        }
        items.sort((a, b) => a.position - b.position);

        for (const item of items) {
          if (item.kind === 'summary') {
            const summary = item.summary;
            // Defensive: never emit a recall pair for an empty/bugged summary — an
            // empty assistant text block triggers a 400. (Production guards too,
            // but a legacy empty summary may already exist in the store.)
            if (!summary.content || !summary.content.trim()) continue;
            const headerText = this.buildRecallHeader(summary);
            const questionEntry: ContextEntry = {
              index: entries.length,
              participant: 'Context Manager',
              content: [{ type: 'text', text: headerText }],
              sourceRelation: 'derived',
            };
            const answerContent: ContentBlock[] = [{ type: 'text', text: summary.content }];
            const answerEntry: ContextEntry = {
              index: entries.length + 1,
              participant: summaryParticipant,
              content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
              sourceRelation: 'derived',
            };
            const pairTokens =
              this.estimateTokens(questionEntry.content) +
              this.estimateTokens(answerEntry.content);
            if (this.isOverBudget(totalTokens + pairTokens, maxTokens)) break;
            entries.push(questionEntry);
            entries.push(answerEntry);
            totalTokens += pairTokens;
            this.rsSummary(summary.level, pairTokens);
          } else {
            const msg = item.msg;
            const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
            const tokens = msgCap > 0
              ? Math.min(store.estimateTokens(msg), msgCap + 50)
              : store.estimateTokens(msg);
            if (this.isOverBudget(totalTokens + tokens, maxTokens)) break;
            entries.push({
              index: entries.length,
              sourceMessageId: msg.id,
              sourceRelation: 'copy',
              participant: msg.participant,
              content,
            });
            totalTokens += tokens;
            this.rsRaw('middleRaw', tokens);
          }
        }
      } else {
        // Legacy combined-pair mode for summaries; pins still emit raw at
        // their positions after the combined pair.
        if (selectedSummaries.length > 0) {
          const contextLabel = this.config.summaryContextLabel ?? 'What do you remember from earlier?';
          const combinedText = selectedSummaries.map(s => s.content).join('\n\n---\n\n');

          const questionEntry: ContextEntry = {
            index: entries.length,
            participant: 'Context Manager',
            content: [{ type: 'text', text: contextLabel }],
            sourceRelation: 'derived',
          };
          // Synthesised summary turns must respect maxMessageTokens. With L1+L2+L3
          // budgets defaulting to 30k each, an unconstrained concatenation can push
          // a single assistant turn past 90k tokens, eating the inference budget
          // and starving recent messages (postmortem 2026-05-04, bug B).
          const answerContent: ContentBlock[] = [{ type: 'text', text: combinedText }];
          const answerEntry: ContextEntry = {
            index: entries.length + 1,
            participant: summaryParticipant,
            content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
            sourceRelation: 'derived',
          };

          const pairTokens = this.estimateTokens(questionEntry.content) +
                             this.estimateTokens(answerEntry.content);

          entries.push(questionEntry);
          entries.push(answerEntry);
          totalTokens += pairTokens;
          for (const s of selectedSummaries) this.rsSummary(s.level, s.tokens);
        }

        // Sort by position so uncompressed-middle messages and pins both
        // appear in their chronological place after the combined recall pair.
        const middleRawSorted = [...middleRaw].sort((a, b) => a.position - b.position);
        for (const { msg } of middleRawSorted) {
          const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
          const tokens = msgCap > 0
            ? Math.min(store.estimateTokens(msg), msgCap + 50)
            : store.estimateTokens(msg);
          if (this.isOverBudget(totalTokens + tokens, maxTokens)) break;
          entries.push({
            index: entries.length,
            sourceMessageId: msg.id,
            sourceRelation: 'copy',
            participant: msg.participant,
            content,
          });
          totalTokens += tokens;
          this.rsRaw('middleRaw', tokens);
        }
      }
    }

    // Phase 4: Recent uncompressed messages (skip head window overlap).
    // Newest-first eviction so that when summaries/head consume most of the
    // budget, the latest messages (the ones the agent actually needs to act
    // on) are preserved and the oldest recent-window messages are dropped.
    const effectiveRecentStart = Math.max(recentStart, headEnd);
    const tailStats = this.emitRecentNewestFirst(entries, store, messages, effectiveRecentStart, msgCap, maxTokens, totalTokens);
    this.rsRaw('tail', tailStats.tokens, tailStats.messages);

    this.trimOrphanedToolUse(entries);
    // Full pairing invariant over the final rendered context — catches the
    // mid-list orphans the trailing/leading trims can't (bug 6.7).
    this.enforceToolPairing(entries);
    this.pruneToolEntries(entries);
    // Strip stale images before committing stats so RenderStats.total reflects
    // the post-strip context (this path places no cache markers).
    this.applyImageStripping(entries, store);
    this.rsEnd();
    return entries;
  }

  // ============================================================================
  // Overridable hooks (for subclass customization)
  // ============================================================================

  /**
   * Build the compression instruction for an L1 chunk in the hierarchical
   * path. Override in subclasses for domain-specific prompts (e.g.,
   * phase-aware prompts in KnowledgeStrategy).
   *
   * Default returns the KV-preserving first-person instruction matching
   * the hermes-autobio spec. The doc/reading-mode variant is exposed via
   * {@link getReadingChunkInstruction}.
   */
  protected getCompressionInstruction(chunk: Chunk, targetTokens: number): string {
    return formatInstruction(targetTokens);
  }

  /**
   * Build the compression instruction for an L1 chunk that is part of a
   * substantially larger sharded message (reading mode). Override in
   * subclasses if domain logic needs to vary the reading-mode prompt.
   *
   * Default returns the reading-mode instruction that asks the model to
   * reflect on what reading was like rather than form a memory "of what
   * the chunk contained", which prevents voice drift into the content
   * author's perspective.
   */
  protected getReadingChunkInstruction(
    chunk: Chunk,
    totalTokens: number,
    targetTokens: number,
  ): string {
    return formatReadingChunkInstruction(totalTokens, targetTokens);
  }

  /**
   * If the chunk is part of a substantially larger sharded message (total
   * bodyGroup tokens ≥ 2× the chunk's own tokens), return reading-context
   * metadata for the reading instruction. The 2× threshold means the
   * chunk represents a portion of something significantly larger — the
   * agent is reading, not conversing.
   *
   * Returns null when the chunk is a whole message (no bodyGroup), or
   * when bodyGroup total is < 2× chunk size (degenerate case — chunk
   * effectively IS the whole message). In those cases the standard
   * (non-reading) instruction is appropriate.
   */
  protected detectDocContext(
    chunk: Chunk,
    ctx: StrategyContext,
  ): { totalTokens: number; chunkTokens: number } | null {
    if (chunk.messages.length === 0) return null;
    const firstGroupId = chunk.messages[0].bodyGroupId;
    if (!firstGroupId) return null;
    // All messages in the chunk must share the same bodyGroupId
    for (const m of chunk.messages) {
      if (m.bodyGroupId !== firstGroupId) return null;
    }
    // Total tokens of the original message (sum of all shards in the bodyGroup).
    const allMessages = ctx.messageStore.getAll();
    let totalTokens = 0;
    for (const m of allMessages) {
      if (m.bodyGroupId === firstGroupId) {
        totalTokens += ctx.messageStore.estimateTokens(m);
      }
    }
    // Tokens in this chunk specifically.
    let chunkTokens = 0;
    for (const m of chunk.messages) {
      chunkTokens += ctx.messageStore.estimateTokens(m);
    }
    // Reading-mode threshold: the original message must be substantially
    // larger than this chunk. 2× means the chunk is at most half of the
    // whole — clearly a portion of something bigger.
    if (chunkTokens === 0 || totalTokens < 2 * chunkTokens) return null;
    return {
      totalTokens,
      chunkTokens,
    };
  }

  /**
   * Build the merge instruction for combining summaries into a higher level.
   * Override in subclasses for domain-specific merge prompts.
   *
   * Default returns the KV-preserving merge instruction. The reading-mode
   * variant (used when all leaves share a bodyGroup of substantial size)
   * is exposed via {@link getReadingMergeInstruction}.
   */
  protected getMergeInstruction(
    targetLevel: SummaryLevel,
    sources: SummaryEntry[],
    targetTokens: number
  ): string {
    const sourceLevelShown = sources.length > 0 ? Math.max(0, sources[0].level - 1) : 0;
    return formatMergeInstruction(targetLevel, sourceLevelShown, targetTokens);
  }

  /**
   * Build the reading-mode merge instruction. Used when all leaf messages
   * underlying the merge share a bodyGroup of substantial size — the agent
   * has been reading a doc rather than conversing. Override in subclasses
   * if domain logic needs to vary the reading-mode merge prompt.
   */
  protected getReadingMergeInstruction(
    targetLevel: SummaryLevel,
    sources: SummaryEntry[],
    totalTokens: number,
    targetTokens: number,
  ): string {
    const sourceLevelShown = sources.length > 0 ? Math.max(0, sources[0].level - 1) : 0;
    return formatReadingMergeInstruction(targetLevel, sourceLevelShown, totalTokens, targetTokens);
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
      if (this.isOverBudget(used + s.tokens, maxTokens)) break;
      selected.push(s);
      used += s.tokens;
    }
    return { selected, tokensUsed: used };
  }

  /**
   * True if `projectedTotal` exceeds `max` AND the strategy is configured
   * to enforce budget. When `enforceBudget: false`, always returns false
   * — the rendering pipeline emits the full ideal context regardless of
   * budget overage. Caller's API will reject if it exceeds the model's
   * context window; the philosophy is "surface overage, don't hide it."
   */
  protected isOverBudget(projectedTotal: number, max: number): boolean {
    if (this.config.enforceBudget === false) return false;
    return projectedTotal > max;
  }

  /**
   * Sort selected summaries by source-range start position, so per-pair
   * recall emission appears in chronological order. Falls back to the
   * created timestamp for summaries whose source-range first message is
   * no longer in the store.
   */
  protected sortSummariesChronologically(
    summaries: SummaryEntry[],
    messages: StoredMessage[],
  ): SummaryEntry[] {
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      positionOf.set(messages[i].id, i);
    }
    return [...summaries].sort((a, b) => {
      const posA = positionOf.get(a.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
      const posB = positionOf.get(b.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      return a.created - b.created;
    });
  }

  /**
   * Render the per-pair recall header from the configured template.
   * Substitutions: {id} {level} {first} {last}.
   */
  protected buildRecallHeader(summary: SummaryEntry): string {
    const template = this.config.recallHeaderTemplate ?? '[Recall {id}]';
    return template
      .replace(/\{id\}/g, summary.id)
      .replace(/\{level\}/g, String(summary.level))
      .replace(/\{first\}/g, summary.sourceRange.first)
      .replace(/\{last\}/g, summary.sourceRange.last);
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
      },
    };

    const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
    // Text-only on purpose: summarizer scratch thinking is not agent history
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
   * Get messages in the compressible zone: outside both head window and
   * recent window AND not inside any pinned range. Returns messages from
   * [0, headStart) ∪ [headEnd, recentStart) minus any positions covered
   * by a pin or document mark.
   */
  protected getCompressibleMessages(store: MessageStoreView): StoredMessage[] {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);
    const pinned = this.pinnedPositions(messages);
    const out: StoredMessage[] = [];
    for (let i = 0; i < recentStart; i++) {
      if (i >= headStart && i < headEnd) continue;
      if (pinned.has(i)) continue;
      out.push(messages[i]);
    }
    return out;
  }

  /**
   * Rebuild the chunk list: persisted records own the past; the running-sum
   * chunker only extends at the frontier, and a chunk is only ever created
   * once it CLOSES (reaches targetChunkTokens). The trailing partial chunk
   * is never created and never compressed — eager partial-tail compression
   * minted a new near-duplicate L1 per rebuild while the tail grew (the
   * prefix-generation families found fleet-wide in the 2026-07 audit).
   */
  protected rebuildChunks(store: MessageStoreView): void {
    this.chunks = [];
    this.compressionQueue = [];

    // ---- 1. Materialize persisted records (they OWN their messages). ----
    const byId = new Map<string, StoredMessage>();
    for (const m of store.getAll()) byId.set(m.id, m);

    const consumed = new Set<string>();
    let orphaned = 0;
    for (const rec of this.chunkRecords) {
      const msgs: StoredMessage[] = [];
      for (const id of rec.sourceIds) {
        const m = byId.get(id);
        if (m) msgs.push(m);
      }
      if (msgs.length === 0) { orphaned++; continue; }
      for (const m of msgs) consumed.add(m.id);
      const chunk: Chunk = {
        index: this.chunks.length,
        startIndex: -1, // record-derived; filtered-array indices are not meaningful
        endIndex: -1,
        messages: msgs,
        tokens: msgs.reduce((sum, m) => sum + (this.config.attachmentsIgnoreSize
          ? this.estimateTextOnlyTokens(m)
          : store.estimateTokens(m)), 0),
        compressed: rec.compressed,
        summaryId: rec.summaryId,
        phaseType: rec.phaseType,
        recordId: rec.id,
      };
      this.chunks.push(chunk);
    }

    // ---- 2. Fail closed on the chain-break signature. ----
    // Most records resolving to zero live messages means message identity
    // has been rebuilt/renumbered underneath us. Chunking "fresh" ground now
    // would re-compress already-lived history into duplicate memories.
    // Halt ALL compression until an operator reconciles the store.
    if (this.chunkPersistenceEnabled && this.chunkRecords.length >= 3 &&
        orphaned / this.chunkRecords.length > 0.5) {
      this.chunkRecordsOrphaned = true;
      this.compressionQueue = [];
      if (!this._orphanWarned) {
        this._orphanWarned = true;
        console.error(
          `[autobiographical] FAIL-CLOSED: ${orphaned}/${this.chunkRecords.length} chunk ` +
          `records resolve to zero live messages (messages chain break / store ` +
          `reconciliation signature). Compression halted to prevent duplicate ` +
          `memory formation — reconcile the store before resuming.`,
        );
      }
      return;
    }
    this.chunkRecordsOrphaned = false;

    // Queue uncompressed record-backed chunks (crash-recovery: record was
    // appended but the process died before its L1 landed).
    for (const chunk of this.chunks) {
      if (!chunk.compressed && !(chunk.recordId && this._overlapBlocked.has(chunk.recordId))) {
        this.compressionQueue.push(chunk.index);
      }
    }

    // ---- 3. Chunk the frontier: compressible messages not owned by any record. ----
    const messagesToChunk = this.getCompressibleMessages(store)
      .filter(m => !consumed.has(m.id));

    let currentChunk: StoredMessage[] = [];
    let currentTokens = 0;
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

      // Don't close a chunk on a message containing a tool_use block —
      // the matching tool_result lives in the immediately-following user
      // message, and the Anthropic API rejects a request where a tool_use
      // isn't immediately followed by its tool_result. Defer the close
      // by one iteration so the result rides along in the same chunk.
      // The stripUnpairedToolBlocks runtime pass is a safety net for the
      // rare case where a tool_use is the very last message in the store.
      if (shouldClose && this.lastMessageContainsToolUse(currentChunk)) {
        continue;
      }

      if (shouldClose) {
        const chunk: Chunk = {
          index: this.chunks.length,
          startIndex: chunkFilteredStart,
          endIndex: i + 1,
          messages: [...currentChunk],
          tokens: currentTokens,
          compressed: false,
        };
        // Persist the boundary the moment it closes — from here on this
        // span is owned and never re-keyed by config drift or restarts.
        if (this.chunkPersistenceEnabled) {
          const record: ChunkRecord = {
            id: `c-${this.chunkIdCounter++}`,
            sourceIds: chunk.messages.map(m => m.id),
            compressed: false,
          };
          this.appendChunkRecord(record);
          chunk.recordId = record.id;
        }
        this.chunks.push(chunk);
        this.compressionQueue.push(chunk.index);

        currentChunk = [];
        currentTokens = 0;
        chunkFilteredStart = i + 1;
      }
    }

    // NOTE: no trailing-partial chunk. An unclosed chunk is not a chunk —
    // it compresses only after the running sum closes it.

    // ---- 4. L1 holdback: keep the newest X closed chunks out of the
    // speculative queue (default 1). The chunk at the live edge is the one
    // most likely to still be in motion (edits, tool-result landings, the
    // episode it belongs to still resolving); summarize it once a newer chunk
    // has closed behind it. The queue is rebuilt on every message, so a
    // held-back chunk is released automatically the moment it ages out of the
    // window. Demand overrides: a picker `produce` op (enqueueL1ForRange)
    // marks the chunk demanded, and demanded chunks are never held back —
    // when folding actually NEEDS the L1, production must not be blocked.
    const holdback = this.config.l1HoldbackChunks ?? 1;
    if (holdback > 0 && this.chunks.length > 0) {
      const cutoff = this.chunks.length - holdback;
      this.compressionQueue = this.compressionQueue.filter((idx) => {
        if (idx < cutoff) return true;
        const ch = this.chunks[idx];
        const lastId = ch?.messages[ch.messages.length - 1]?.id;
        return lastId !== undefined && this._demandedL1Chunks.has(lastId);
      });
    }
  }

  /**
   * Returns true if the last message in the chunk-in-progress contains a
   * `tool_use` block. Used by `rebuildChunks` to defer chunk closure until
   * the matching `tool_result` (in the immediately-following user message)
   * is pulled into the same chunk. See `stripUnpairedToolBlocks` for the
   * runtime safety net.
   */
  protected lastMessageContainsToolUse(chunk: StoredMessage[]): boolean {
    const last = chunk[chunk.length - 1];
    if (!last) return false;
    return last.content.some((b) => b.type === 'tool_use');
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

  /** True if any content block is a live image. */
  protected hasImageBlock(content: ContentBlock[]): boolean {
    return content.some((b) => b.type === 'image');
  }

  /** Message index marking the image-strip depth boundary: walks newest→oldest
   *  summing the same per-message estimate as getRecentWindowStart, and returns
   *  the index of the first message still within `depthTokens`. Messages before
   *  this index have their images stripped to placeholders. */
  protected getImageStripStart(store: MessageStoreView, depthTokens: number): number {
    const messages = store.getAll();
    let tokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > depthTokens) return i + 1;
    }
    return 0;
  }

  /** Text substituted for an image block once it leaves the live-image window. */
  private static readonly IMAGE_PLACEHOLDER = '[image dropped from live context]';

  /** Post-pass over compiled entries: replace image blocks with a text
   *  placeholder once they fall outside the live-image window — either deeper
   *  than `imageStripDepthTokens` from the newest message, or beyond the
   *  `maxLiveImages` most-recent images (counted newest-first). Summaries are
   *  already text, so they're naturally unaffected. The adjacent
   *  "[image attachment: <name>]" text added at ingest preserves the filename,
   *  so the placeholder itself stays terse. Reduces tokens, so it never pushes
   *  a compiled context back over budget.
   *
   *  Runs INSIDE each select path, *before* `rsEnd()` and `placeCacheMarkers`,
   *  so the committed render stats (and the cache breakpoints) describe the
   *  post-strip context. As it strips, it decrements the matching raw bucket of
   *  the in-progress render stats by the reclaimed tokens, keeping
   *  `RenderStats.total` equal to the real rendered size. */
  protected applyImageStripping(entries: ContextEntry[], store: MessageStoreView): void {
    const maxLive = this.config.maxLiveImages ?? 0;             // 0 = unlimited count
    const depthTokens = this.config.imageStripDepthTokens ?? 0; // 0 = no depth strip
    const maxLiveBytes = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    if (maxLive === 0 && depthTokens === 0 && maxLiveBytes === 0) return; // policy disabled

    const messages = store.getAll();
    const posById = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) posById.set(messages[i].id, i);
    const stripStart = depthTokens > 0 ? this.getImageStripStart(store, depthTokens) : 0;

    // Same region windows select() bucketed by, so a stripped image's reclaimed
    // tokens come back out of the bucket it was originally tallied into.
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = Math.max(this.getRecentWindowStart(store), headEnd);
    const bucketAt = (pos: number): 'head' | 'tail' | 'middleRaw' => {
      if (pos < 0) return 'middleRaw'; // no resolvable region — keep total == Σbuckets
      if (pos >= headStart && pos < headEnd) return 'head';
      if (pos >= recentStart) return 'tail';
      return 'middleRaw';
    };
    const placeholderTokens = Math.ceil(AutobiographicalStrategy.IMAGE_PLACEHOLDER.length / 4);

    // Image-bearing entries, newest-first by source position. Entries with no
    // resolvable source position sort last (pos -1) and never count as "live".
    const ordered = entries
      .map((entry, idx) => ({
        idx,
        pos: entry.sourceMessageId !== undefined ? posById.get(entry.sourceMessageId) ?? -1 : -1,
      }))
      .filter(({ idx }) => this.hasImageBlock(entries[idx].content))
      .sort((a, b) => b.pos - a.pos);

    let keptImages = 0;
    let keptImageBytes = 0;
    for (const { idx, pos } of ordered) {
      const entry = entries[idx];
      const tooDeep = depthTokens > 0 && (pos < 0 || pos < stripStart);
      const bucket = bucketAt(pos);
      entry.content = entry.content.map((block) => {
        if (block.type !== 'image') return block;
        const blockBytes = AutobiographicalStrategy.imageBlockBytes(block);
        const overCount = maxLive > 0 && keptImages >= maxLive;
        const overBytes = maxLiveBytes > 0 && keptImageBytes + blockBytes > maxLiveBytes;
        if (tooDeep || overCount || overBytes) {
          // Stats-neutral (2026-07-12): every budgeting site now tallies at
          // POST-STRIP prices (see postStripEstimates), so the bucket never
          // charged this image at full weight — reclaiming here would
          // double-decrement. The strip pass only swaps the block.
          void bucket;
          void placeholderTokens;
          return { type: 'text', text: AutobiographicalStrategy.IMAGE_PLACEHOLDER } as ContentBlock;
        }
        keptImages++;
        keptImageBytes += blockBytes;
        return block;
      });
    }
  }

  /**
   * Post-strip token estimate per message index (2026-07-12 tail-starvation
   * fix). Mirrors `applyImageStripping`: an image beyond the `maxLiveImages`
   * newest (counted newest-first) or deeper than `imageStripDepthTokens` of
   * raw estimate from the live end renders as a placeholder — so every place
   * that BUDGETS messages (recent-window walk-back, head/tail sums, middle
   * chunk sizes) must cost it as one. Pricing stripped images at their full
   * estimate collapsed an image-dense tail to a fraction of its configured
   * size (42k rendered of a 120k window), and pricing them post-strip in the
   * walk-back alone made the picker's raw-priced tail overflow the budget
   * (318k) — the estimate must be consistent EVERYWHERE.
   */
  protected postStripEstimates(store: MessageStoreView): number[] {
    const messages = store.getAll();
    const out = new Array<number>(messages.length);
    const stripDepth = this.config.imageStripDepthTokens ?? 0;
    const maxLive = this.config.maxLiveImages ?? 0;
    const maxLiveBytes = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    const stripActive = stripDepth > 0 || maxLive > 0 || maxLiveBytes > 0;
    const placeholderTokens = Math.ceil(AutobiographicalStrategy.IMAGE_PLACEHOLDER.length / 4);
    let liveImagesSeen = 0;
    let liveImageBytes = 0;
    let rawDepth = 0; // raw-estimate depth from the newest message (mirrors getImageStripStart)
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = store.estimateTokens(messages[i]);
      let est = raw;
      if (stripActive) {
        for (const b of messages[i].content) {
          if (b.type !== 'image') continue;
          const bytes = AutobiographicalStrategy.imageBlockBytes(b);
          const beyondDepth = stripDepth > 0 && rawDepth > stripDepth;
          const beyondCount = maxLive > 0 && liveImagesSeen >= maxLive;
          const beyondBytes = maxLiveBytes > 0 && liveImageBytes + bytes > maxLiveBytes;
          if (beyondDepth || beyondCount || beyondBytes) {
            const imgEst = (b as { tokenEstimate?: number }).tokenEstimate ?? 1600;
            est -= Math.max(0, imgEst - placeholderTokens);
          } else {
            liveImagesSeen++;
            liveImageBytes += bytes;
          }
        }
      }
      rawDepth += raw;
      out[i] = est;
    }
    return out;
  }

  /** Byte wall default: 20MB of base64 (API total-request cap is 32MB). */
  protected static readonly DEFAULT_MAX_LIVE_IMAGE_BYTES = 20 * 1024 * 1024;

  /** Compression prompts carry head + recall frontier + raw chunk alongside
   *  their images, so they get a tighter image budget than the live window. */
  protected static readonly DEFAULT_MAX_COMPRESSION_IMAGE_BYTES = 12 * 1024 * 1024;

  /** Base64 payload size of an image block (0 for non-base64 sources). */
  protected static imageBlockBytes(b: unknown): number {
    const src = (b as { source?: { data?: string } }).source;
    return typeof src?.data === 'string' ? src.data.length : 0;
  }

  /**
   * Cap inline image bytes in a COMPRESSION prompt (2026-07-12). The main
   * window enforces `maxLiveImageBytes` through the strip policy; the
   * summarizer's raw-chunk replay had no such wall and leaned on membrane's
   * byte shed instead — which is a transport backstop, not a policy owner
   * (it fired at 27MB on a live merge). Keep images newest-first within the
   * budget; older ones become the same loud placeholder the window uses, so
   * the summarizer is told plainly that it is not seeing them.
   * Returns the number of images replaced.
   */
  protected capCompressionImageBytes(
    messages: Array<{ content: ContentBlock[] }>,
    capBytes: number,
  ): number {
    if (capBytes <= 0) return 0;
    let kept = 0;
    let dropped = 0;
    // Recurse into tool_result content: an agent that drives a shell/plotter/
    // browser carries most of its image bytes NESTED in tool results, not as
    // top-level blocks. Capping only the top level left those untouched and
    // membrane's transport shed kept firing at 27MB (2026-07-12).
    const capBlocks = (blocks: ContentBlock[]): ContentBlock[] =>
      blocks.map((b) => {
        if (b.type === 'image') {
          const bytes = AutobiographicalStrategy.imageBlockBytes(b);
          if (kept + bytes <= capBytes) {
            kept += bytes;
            return b;
          }
          dropped++;
          return { type: 'text', text: AutobiographicalStrategy.IMAGE_PLACEHOLDER } as ContentBlock;
        }
        const nested = (b as { type: string; content?: unknown }).content;
        if (b.type === 'tool_result' && Array.isArray(nested)) {
          return { ...b, content: capBlocks(nested as ContentBlock[]) } as ContentBlock;
        }
        return b;
      });
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!Array.isArray(m.content)) continue;
      m.content = capBlocks(m.content);
    }
    if (dropped > 0) {
      console.error(
        `[autobiographical] compression prompt: replaced ${dropped} older image(s) with placeholders ` +
          `to stay under the ${Math.round(capBytes / 1e6)}MB image-byte budget (kept ${Math.round(kept / 1e6)}MB, newest-first)`,
      );
    }
    return dropped;
  }

  protected getRecentWindowStart(store: MessageStoreView): number {
    const messages = store.getAll();
    const pse = this.postStripEstimates(store);
    let tokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += pse[i];
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

  /** Placeholder body for a stub tool_result inserted by enforceToolPairing. */
  private static readonly STUB_TOOL_RESULT_TEXT =
    '[tool result unavailable — omitted during context compression]';

  /**
   * Final post-selection tool-pairing validator (bug 6.7).
   *
   * The Anthropic API requires every `tool_use` block to be answered by a
   * matching `tool_result` in the immediately-following message, and every
   * `tool_result` to answer a `tool_use` in the immediately-preceding
   * message. Selection can violate this mid-list in ways the trailing
   * (`trimOrphanedToolUse`) and leading orphan trims don't catch:
   *
   *   - a budget `break` cutting between a raw pin pair's two messages;
   *   - the uncompressed-chunk fallback emitting a raw tool_result whose
   *     tool_use chunk already compressed (or vice versa);
   *   - a recall pair or pin interleaving between a tool_use and its result.
   *
   * Repair policy prefers preserving content over dropping:
   *
   *   - a tool_use whose result is missing from the next entry first triggers
   *     a short look-ahead: if the genuine (displaced) result is a few entries
   *     down it is MOVED up into position (see
   *     {@link relocateOrDropMissingResults}); only when no real result exists
   *     is a STUB tool_result emitted. Either way the result block is merged
   *     into the next entry when that entry already carries results for this
   *     cycle, or inserted as a new user entry;
   *   - a tool_result whose tool_use is not in the immediately-preceding
   *     entry (and was not relocated) is dropped — there is no safe way to
   *     stub a tool_use, so the result's information content survives only if
   *     its use is adjacent; an entry left empty is replaced with a
   *     placeholder text block.
   *
   * Runs as a structural pass over the rendered context in BOTH render
   * paths — `selectHierarchical` (downstream of `selectL1Summaries`, so
   * subclass overrides like KnowledgeStrategy are covered) and
   * `selectAdaptive` (the path FKM defaults onto). It's a no-op on
   * already-valid output.
   */
  protected enforceToolPairing(entries: ContextEntry[]): void {
    let prevUseIds = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // --- Rule A: every tool_result must answer a tool_use in the
      // immediately-preceding entry (and only once). Drop orphans/dupes. ---
      if (entry.content.some(b => b.type === 'tool_result')) {
        const seen = new Set<string>();
        const filtered = entry.content.filter(b => {
          if (b.type !== 'tool_result') return true;
          if (!prevUseIds.has(b.toolUseId) || seen.has(b.toolUseId)) return false;
          seen.add(b.toolUseId);
          return true;
        });
        if (filtered.length !== entry.content.length) {
          entry.content = filtered.length > 0
            ? filtered
            : [{ type: 'text', text: '[tool call omitted]' }];
        }
      }

      // --- Rule B: every tool_use in the PREVIOUS entry must be answered
      // by this entry. Stub any that aren't. ---
      if (prevUseIds.size > 0) {
        const answered = new Set<string>();
        for (const b of entry.content) {
          if (b.type === 'tool_result') answered.add(b.toolUseId);
        }
        const missing = [...prevUseIds].filter(id => !answered.has(id));
        if (missing.length > 0) {
          // Look-ahead relocation: the genuine result for a "missing" id is
          // often sitting a few entries down, displaced by an interleaved
          // recall pair / pin (it will otherwise be dropped as an orphan by
          // Rule A when we reach it). Move the real block up into position and
          // only stub the ids for which no real result exists — so tool output
          // is preserved, not silently replaced by a placeholder.
          const results = this.relocateOrDropMissingResults(entries, i, missing);
          if (answered.size > 0) {
            // This entry already carries results for the cycle — prepend the
            // relocated/stub results so all results for the preceding tool_use
            // sit together (the API wants tool_result blocks at the head of
            // the message).
            entry.content = [...results, ...entry.content];
          } else {
            // Not a results entry at all — insert a synthetic user entry
            // between the tool_use entry and this one.
            entries.splice(i, 0, {
              index: i,
              participant: 'user',
              sourceRelation: 'derived',
              content: results,
            });
            // The stub entry (no tool_use blocks) is now at index i; the
            // current entry moved to i+1 and is re-processed next iteration
            // with an empty prevUseIds (its orphan results, if any, were
            // already filtered above and none survived — Rule A matched
            // against the same prevUseIds and answered.size === 0).
            prevUseIds = new Set();
            continue;
          }
        }
      }

      prevUseIds = new Set();
      for (const b of entry.content) {
        if (b.type === 'tool_use') prevUseIds.add(b.id);
      }
    }

    // Tail: an entry that mixes tool_use with other blocks can survive
    // trimOrphanedToolUse (which only pops pure use-without-result tails).
    if (prevUseIds.size > 0) {
      entries.push({
        index: entries.length,
        participant: 'user',
        sourceRelation: 'derived',
        content: [...prevUseIds].map(id => ({
          type: 'tool_result' as const,
          toolUseId: id,
          content: AutobiographicalStrategy.STUB_TOOL_RESULT_TEXT,
        })),
      });
    }

    // Reindex after any splices/appends.
    for (let i = 0; i < entries.length; i++) entries[i].index = i;
  }

  /**
   * For each `missing` tool_use id (a use in the preceding entry with no
   * adjacent result), return the result block to place next to it:
   *
   *   - if the genuine result exists within a short look-ahead window after
   *     `afterIndex`, MOVE it up into position (removing it from its source
   *     entry — replacing a now-empty entry with a placeholder) so the real
   *     tool output survives the repair;
   *   - otherwise emit a stub.
   *
   * tool_use ids are unique, so the single result carrying a given id is
   * unambiguously the answer to that use — relocating it cannot break any
   * other pairing. Results for `missing` ids never sit at or before
   * `afterIndex` (that entry's results are already matched), so the search
   * starts at `afterIndex + 1`.
   */
  private relocateOrDropMissingResults(
    entries: ContextEntry[],
    afterIndex: number,
    missing: string[],
  ): ContentBlock[] {
    const LOOKAHEAD = 6;
    const end = Math.min(entries.length, afterIndex + 1 + LOOKAHEAD);
    return missing.map(id => {
      for (let j = afterIndex + 1; j < end; j++) {
        const src = entries[j];
        const bi = src.content.findIndex(
          b => b.type === 'tool_result' && b.toolUseId === id,
        );
        if (bi === -1) continue;
        const real = src.content[bi];
        const rest = src.content.filter((_, k) => k !== bi);
        src.content = rest.length > 0
          ? rest
          : [{ type: 'text', text: '[tool call omitted]' }];
        return real;
      }
      return {
        type: 'tool_result',
        toolUseId: id,
        content: AutobiographicalStrategy.STUB_TOOL_RESULT_TEXT,
      } as ContentBlock;
    });
  }

  /**
   * Prune tool_use / tool_result blocks in-place:
   *  1. Truncate `tool_use.input` blocks whose serialized JSON exceeds
   *     `toolUseInputMaxTokens`.
   *  2. For each tool name, keep only the last N `tool_result` blocks
   *     per `toolResultMaxLastN`; older ones get their `content` replaced
   *     with a brief marker referencing the tool name and how many newer
   *     results exist below.
   *
   * Both passes are no-ops when the corresponding config is unset/0.
   * Pruning runs AFTER selection and orphan-trimming, so it doesn't
   * affect chunk formation or the recall/pin layout.
   */
  protected pruneToolEntries(entries: ContextEntry[]): void {
    // Pass 1: build toolUseId → toolName map and apply input truncation
    const toolUseInputCap = this.config.toolUseInputMaxTokens ?? 0;
    const toolUseIdToName = new Map<string, string>();

    for (const entry of entries) {
      for (let i = 0; i < entry.content.length; i++) {
        const block = entry.content[i];
        if (block.type !== 'tool_use') continue;
        toolUseIdToName.set(block.id, block.name);

        if (toolUseInputCap > 0) {
          const inputJson = JSON.stringify(block.input);
          const inputTokens = Math.ceil(inputJson.length / 4);
          if (inputTokens > toolUseInputCap) {
            const keys = Object.keys(block.input).slice(0, 5);
            entry.content[i] = {
              ...block,
              input: {
                _truncated: true,
                _originalTokens: inputTokens,
                _keys: keys,
              },
            };
          }
        }
      }
    }

    // Pass 2: collect tool_result occurrences per tool name, in order
    const occurrencesByTool = new Map<string, Array<{ entry: ContextEntry; blockIndex: number }>>();
    for (const entry of entries) {
      for (let i = 0; i < entry.content.length; i++) {
        const block = entry.content[i];
        if (block.type !== 'tool_result') continue;
        const toolName = toolUseIdToName.get(block.toolUseId);
        if (!toolName) continue;
        let arr = occurrencesByTool.get(toolName);
        if (!arr) {
          arr = [];
          occurrencesByTool.set(toolName, arr);
        }
        arr.push({ entry, blockIndex: i });
      }
    }

    // Pass 3: apply per-tool max-last-N
    const cfg = this.config.toolResultMaxLastN;
    if (cfg === undefined) return;

    for (const [toolName, occs] of occurrencesByTool) {
      let limit: number | undefined;
      if (typeof cfg === 'number') limit = cfg;
      else if (typeof cfg === 'object') limit = cfg[toolName];
      if (limit === undefined || limit < 0) continue;

      const excessCount = occs.length - limit;
      if (excessCount <= 0) continue;

      for (let i = 0; i < excessCount; i++) {
        const { entry, blockIndex } = occs[i];
        const orig = entry.content[blockIndex];
        if (orig.type !== 'tool_result') continue;
        const fresherCount = occs.length - i - 1;
        entry.content[blockIndex] = {
          ...orig,
          content: `[Result truncated — tool '${toolName}' has ${fresherCount} more recent result${fresherCount === 1 ? '' : 's'} below]`,
        };
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
        if (typeof block.content === 'string') {
          const text = block.content;
          if (remaining <= 0) {
            // Budget exhausted — include with minimal content to preserve pairing
            result.push({
              ...block,
              content: '[content omitted — context budget exceeded]',
            });
          } else if (text.length > remaining) {
            result.push({
              ...block,
              content: safeSlice(text, 0, remaining) + '\n\n[truncated — original was ' +
                Math.ceil(text.length / 4) + ' tokens]',
            });
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
