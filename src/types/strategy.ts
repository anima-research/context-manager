import type { JsStore } from '@animalabs/chronicle';
import type { Membrane } from '@animalabs/membrane';
import type { StoredMessage, MessageId, Sequence } from './message.js';
import type { ContextEntry, TokenBudget, PendingWork } from './context.js';

/**
 * Read-only view of the message store for strategies.
 */
export interface MessageStoreView {
  /** Get all messages */
  getAll(): StoredMessage[];
  /** Get a specific message */
  get(id: MessageId): StoredMessage | null;
  /** Get messages from a specific index */
  getFrom(index: number): StoredMessage[];
  /** Get the last N messages */
  getTail(count: number): StoredMessage[];
  /** Get total message count */
  length(): number;
  /** Estimate tokens for a message */
  estimateTokens(message: StoredMessage): number;
}

/**
 * Read-only view of the context log for strategies.
 */
export interface ContextLogView {
  /** Get all entries */
  getAll(): ContextEntry[];
  /** Get entries from a specific index */
  getFrom(index: number): ContextEntry[];
  /** Get the last N entries */
  getTail(count: number): ContextEntry[];
  /** Get total entry count */
  length(): number;
  /** Estimate tokens for an entry */
  estimateTokens(entry: ContextEntry): number;
}

/**
 * Context provided to strategy methods.
 */
export interface StrategyContext {
  /** Read-only view of message store */
  messageStore: MessageStoreView;
  /** Read-only view of context log */
  contextLog: ContextLogView;
  /** Membrane instance for LLM calls (compression) */
  membrane?: Membrane;
  /** Current sequence number */
  currentSequence: Sequence;
  /**
   * Underlying Chronicle store. Strategies may register their own state slots
   * (via `store.registerState`) for durable strategy state that needs to
   * survive process restart and follow Chronicle branches.
   *
   * State IDs should be scoped under `namespace` to avoid collisions with
   * other strategies or with the message/context-log states.
   */
  store: JsStore;
  /**
   * Namespace under which this strategy should scope its state IDs.
   * Use as a prefix: e.g. `${namespace}/autobio:summaries`. Always defined;
   * defaults to a stable per-manager value when no caller-supplied namespace
   * exists, so strategies never need to handle the unscoped case.
   */
  namespace: string;
}

/**
 * Result of readiness check.
 */
export interface ReadinessState {
  /** Whether compile() can proceed immediately */
  ready: boolean;
  /** Promise that resolves when ready (if not ready) */
  pendingWork?: Promise<void>;
  /** Description of pending work */
  description?: string;
}

/**
 * Pluggable strategy for context management.
 * Strategies control how context is selected, compressed, and maintained.
 */
export interface ContextStrategy {
  /** Strategy name for identification */
  readonly name: string;

  /** Maximum tokens per individual message. Used by the framework to truncate
   *  tool results in-flight (yielding stream) and at storage time.
   *  0 or undefined = no limit. */
  readonly maxMessageTokens?: number;

  /**
   * Initialize the strategy with context.
   * Called when strategy is set on ContextManager.
   */
  initialize?(ctx: StrategyContext): Promise<void>;

  /**
   * Periodic background maintenance.
   * Called by application to trigger compression, indexing, etc.
   */
  tick?(ctx: StrategyContext): Promise<void>;

  /**
   * React to new messages.
   * Called after a message is added to the store.
   */
  onNewMessage?(message: StoredMessage, ctx: StrategyContext): Promise<void>;

  /**
   * Check if strategy is ready to compile.
   * Returns pending work info if not ready.
   */
  checkReadiness(): ReadinessState;

  /**
   * Select and order context entries for compilation.
   * This is the core method that determines what goes in the context window.
   */
  select(
    store: MessageStoreView,
    log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[];
}

/**
 * Strategy that supports resetting the head window for topic transitions.
 * Implemented by AutobiographicalStrategy and its subclasses.
 */
export interface ResettableStrategy extends ContextStrategy {
  /** Reset the head window to start from a new message ID. */
  resetHeadWindow(newStartId: string | null): void;
  /** Generate a transition summary from the current head window + summaries. */
  generateTransitionSummary(ctx: StrategyContext): Promise<string>;
}

/**
 * Type guard for strategies that support head window reset.
 */
export function isResettableStrategy(s: ContextStrategy): s is ResettableStrategy {
  return 'resetHeadWindow' in s && typeof (s as ResettableStrategy).resetHeadWindow === 'function';
}

/**
 * Strategy that supports protected ranges (pins + documents).
 * Pinned ranges are excluded from compression and render raw at their
 * original chronological position. Implemented by AutobiographicalStrategy.
 */
export interface PinnableStrategy extends ContextStrategy {
  pinRange(firstMessageId: string, lastMessageId: string, opts?: { name?: string }): string;
  markDocument(messageId: string, opts?: { name?: string }): string;
  unpin(pinId: string): boolean;
  listPins(): ReadonlyArray<ProtectedRange>;
}

/** Type guard for strategies that support pins / documents. */
export function isPinnableStrategy(s: ContextStrategy): s is PinnableStrategy {
  return (
    'pinRange' in s &&
    typeof (s as PinnableStrategy).pinRange === 'function' &&
    'unpin' in s &&
    typeof (s as PinnableStrategy).unpin === 'function'
  );
}

/**
 * Query for `searchSummaries`. At least one of `text` or `regex` should be
 * provided to constrain results; otherwise all summaries pass.
 */
export interface SearchQuery {
  /** Case-insensitive substring match against summary content. */
  text?: string;
  /** Regex match against summary content (overrides `text` if both set). */
  regex?: RegExp;
  /** Filter by summary level(s). Default: all levels. */
  levels?: SummaryLevel[];
  /** Maximum number of results to return. Default: 50. */
  limit?: number;
  /**
   * Include summaries that have been merged into a higher-level summary.
   * Default: false (only "live" unmerged summaries are returned).
   */
  includeMerged?: boolean;
}

/** Result of a single search match. */
export interface SearchResult {
  summary: SummaryEntry;
  /** Number of times the query pattern matched in the summary content. */
  matches: number;
}

/**
 * Strategy that supports searching its summary archive. Implemented by
 * AutobiographicalStrategy.
 */
export interface SearchableStrategy extends ContextStrategy {
  searchSummaries(query: SearchQuery): SearchResult[];
  getSummary(id: string): SummaryEntry | null;
}

/** Type guard for strategies that support search. */
export function isSearchableStrategy(s: ContextStrategy): s is SearchableStrategy {
  return (
    'searchSummaries' in s &&
    typeof (s as SearchableStrategy).searchSummaries === 'function' &&
    'getSummary' in s &&
    typeof (s as SearchableStrategy).getSummary === 'function'
  );
}

/**
 * Per-render observability stats from a strategy. Counts and token sums for
 * head / tail / summaries / pending work, suitable for TUIs and dashboards
 * that want to display "how much of the context is folded vs raw" at a
 * glance. Token sums use the strategy's own estimates so they line up with
 * the numbers `select()` uses for budget math.
 */
export interface RenderStats {
  head: { messages: number; tokens: number };
  tail: { messages: number; tokens: number };
  summaries: {
    l1: { count: number; tokens: number };
    l2: { count: number; tokens: number };
    l3: { count: number; tokens: number };
  };
  pending: { chunks: number; merges: number };
}

/**
 * Strategy that can produce render-time observability stats. Implemented by
 * AutobiographicalStrategy. Optional capability — strategies that don't
 * implement it simply have `ContextManager.getRenderStats()` return `null`.
 */
export interface RenderStatsCapableStrategy extends ContextStrategy {
  getRenderStats(store: MessageStoreView): RenderStats;
}

/** Type guard for strategies that produce render stats. */
export function isRenderStatsCapable(s: ContextStrategy): s is RenderStatsCapableStrategy {
  return (
    'getRenderStats' in s &&
    typeof (s as RenderStatsCapableStrategy).getRenderStats === 'function'
  );
}

/**
 * Configuration for the Autobiographical strategy.
 */
export interface AutobiographicalConfig {
  /** Target tokens per chunk (~3000) */
  targetChunkTokens: number;
  /** Recent tokens to keep uncompressed (~30000) */
  recentWindowTokens: number;
  /** Tokens at the head of the conversation to preserve verbatim (default: 0).
   *  Messages within this window are never chunked or compressed — they survive
   *  as raw copies so initial instructions retain full granularity. */
  headWindowTokens: number;
  /** Always break at message boundaries */
  chunkOnMessageBoundary: boolean;
  /** Don't count attachment tokens toward chunk size */
  attachmentsIgnoreSize: boolean;
  /** When true, onNewMessage() fires tick() as a background promise so compression
   *  runs automatically without the framework calling tick() explicitly. */
  autoTickOnNewMessage: boolean;
  /** System prompt for summarization */
  summarySystemPrompt?: string;
  /** User prompt template for summarization. Use {content} for the transcript. */
  summaryUserPrompt?: string;
  /** Label shown before summaries in compiled context */
  summaryContextLabel?: string;
  /** Participant name for the summary (defaults to "Summary") */
  summaryParticipant?: string;
  /** Model to use for compression (defaults to claude-sonnet) */
  compressionModel?: string;
  /** Maximum tokens per individual message in compiled output. Messages exceeding
   *  this limit have their text/tool_result content truncated. 0 = no limit. */
  maxMessageTokens: number;

  // Legacy aliases (deprecated, use summary* instead)
  /** @deprecated Use summarySystemPrompt */
  diarySystemPrompt?: string;
  /** @deprecated Use summaryUserPrompt */
  diaryUserPrompt?: string;

  // --- Hierarchical compression (L1/L2/L3 pyramid) ---

  /** Enable hierarchical 3-level compression. Set to false for single-level legacy compression. */
  hierarchical?: boolean;
  /** Number of unmerged summaries before merging to the next level (default: 6) */
  mergeThreshold?: number;
  /** Token target for each summary at any level (default: 2000) */
  summaryTargetTokens?: number;
  /** Token budget for L3 summaries in select() (default: 30000) */
  l3BudgetTokens?: number;
  /** Token budget for L2 summaries in select() (default: 30000) */
  l2BudgetTokens?: number;
  /** Token budget for L1 summaries in select() (default: 30000) */
  l1BudgetTokens?: number;

  /**
   * When true (default), each selected summary emits as its own positioned
   * Q/A recall pair, sorted chronologically by source range. When false,
   * all selected summaries are concatenated into one Q/A pair between head
   * and tail (legacy behavior pre-2026-05-10).
   *
   * Per-region positioning is the spec-faithful behavior: it lets the agent
   * see each memory in its temporal place rather than as a wall of unrelated
   * recollections from another speaker. Without it, hierarchical compression
   * is structurally similar to the dual-recall corruption pattern that
   * caused Lena's context degradation on Hermes.
   */
  positionedRecallPairs?: boolean;

  /**
   * Template for the per-pair recall question header. Substitutions:
   *   {id}    — summary id (e.g. "L1-3")
   *   {level} — summary level (1, 2, or 3)
   *   {first} — first source message id
   *   {last}  — last source message id
   * Default: '[Recall {id}]'.
   *
   * Only used when `positionedRecallPairs` is true.
   */
  recallHeaderTemplate?: string;

  /**
   * Per-tool retention limit: keep at most the last N `tool_result` blocks
   * for each tool name. Older results get their content replaced with a
   * brief marker referencing the tool name and how many newer results exist.
   *
   * Two shapes accepted:
   *  - `number`: applies as a global default across all tools.
   *  - `Record<toolName, number>`: per-tool limit; tools not listed are
   *    unlimited.
   *
   * Default: undefined (no pruning). Use a small number (1–5) for tools
   * that produce verbose, mostly-stale output (e.g. file listings, http
   * fetches, log queries).
   */
  toolResultMaxLastN?: number | Record<string, number>;

  /**
   * Truncate `tool_use` block inputs whose serialized JSON exceeds this
   * many tokens. The truncated input becomes `{ "_truncated": true,
   * "_originalTokens": N }` plus a head slice of the original input
   * keys for context. Default: 0 (no truncation).
   */
  toolUseInputMaxTokens?: number;

  /**
   * Cap on the number of speculative L1 summaries the strategy will hold
   * (queued + unmerged). When `count(unmerged L1s) + count(queued chunks)`
   * exceeds this cap, `onNewMessage`'s auto-tick is held back. Chunks
   * still form and queue, but compression is deferred until a manual
   * `tick()` or `compile()` triggers it.
   *
   * Default: undefined (no cap; compression fires eagerly on every
   * new message when `autoTickOnNewMessage` is true).
   */
  maxSpeculativeL1s?: number;

  /**
   * When false, the rendering pipeline emits the full ideal context (head
   * window + all selected summaries + all recent messages) without
   * truncating to fit `budget.maxTokens`. The caller's API will reject if
   * the result exceeds the model's context window — the philosophy is
   * "surface the overage rather than silently lose content."
   *
   * Default: true (legacy budget-aware truncation: stops emitting recall
   * pairs and recent messages when the running total exceeds maxTokens).
   *
   * Recommended setting for long-lived agents on large-context models
   * (e.g. opus-4-7 with 1M context): false. The window is generous enough
   * that overflow is rare, and when it does happen you want to know.
   */
  enforceBudget?: boolean;
}

/**
 * Compression level in the hierarchical pyramid.
 *
 * Historically constrained to 1 | 2 | 3. As of the adaptive-resolution design
 * (`docs/adaptive-resolution-design.md`), levels are unbounded: the picker
 * can recursively produce L4, L5, ... as needed. The narrower literal type
 * is kept as `LegacySummaryLevel` for code that still assumes the old shape.
 */
export type SummaryLevel = number;

/**
 * The narrow level type used by pre-adaptive-resolution code paths.
 * Prefer `SummaryLevel` for new code.
 */
export type LegacySummaryLevel = 1 | 2 | 3;

/**
 * A summary entry in the hierarchical memory pyramid.
 * L1: compressed from raw message chunks.
 * L_{k>1}: merged from mergeThreshold L_{k-1}s.
 */
export interface SummaryEntry {
  /** Unique ID (e.g., "L1-0", "L2-3") */
  id: string;
  /** Compression level (1, 2, 3, ... — unbounded in the adaptive-resolution design) */
  level: SummaryLevel;
  /** The summary text */
  content: string;
  /** Estimated token count (content.length / 4 or tokenizer-cached) */
  tokens: number;
  /**
   * Level of the sources: 0 = raw messages, k = L_k summaries.
   * Pre-adaptive code uses 0 | 1 | 2; new code may produce higher values.
   */
  sourceLevel: number;
  /** IDs of source items (message IDs for L1, summary IDs for L_{k>1}) */
  sourceIds: string[];
  /** Range of original message IDs covered */
  sourceRange: { first: string; last: string };
  /**
   * The L_{level+1} summary this one is a source for, if produced.
   * Pure archive metadata in the adaptive-resolution design — display
   * decisions live on per-chunk `currentResolution`, not here.
   */
  parentId?: string;
  /**
   * @deprecated Renamed to `parentId` in the adaptive-resolution design.
   * Kept for read compatibility with chronicles produced by the old
   * threshold-driven path. New writes should set `parentId` only.
   */
  mergedInto?: string;
  /** Creation timestamp */
  created: number;
  /** Phase type tag (used by KnowledgeStrategy for asymmetric budget) */
  phaseType?: string;
}

/**
 * Helper: read the parent pointer from a summary, accepting either the
 * new `parentId` field or the deprecated `mergedInto` alias.
 */
export function getSummaryParentId(s: SummaryEntry): string | undefined {
  return s.parentId ?? s.mergedInto;
}

/**
 * A range of messages protected from compression. Pins keep a span of raw
 * messages visible at their original position in the rendered context.
 *
 * - `kind: 'pin'` — generic protected range (any first/last span).
 * - `kind: 'document'` — typically a single message containing a body of
 *   information the agent wants to retain in full; semantically identical
 *   to a single-message pin, distinguished by metadata for tooling.
 */
export interface ProtectedRange {
  /** Stable id assigned at pin time. */
  id: string;
  /** First message id of the protected range (inclusive). */
  firstMessageId: string;
  /** Last message id of the protected range (inclusive). */
  lastMessageId: string;
  kind: 'pin' | 'document';
  /** Optional human-readable label. */
  name?: string;
  /** Creation timestamp (ms since epoch). */
  created: number;
}

/**
 * Phase type for knowledge extraction workflows.
 */
export type PhaseType = 'research' | 'synthesis' | 'lesson' | 'subagent';

/**
 * Configuration for the Knowledge strategy.
 * Extends AutobiographicalConfig with phase-aware compression settings.
 */
export interface KnowledgeConfig extends AutobiographicalConfig {
  /** Tool name prefixes that indicate research/retrieval activity.
   *  Default: ['mcpl:', 'zulip:'] */
  researchToolPrefixes?: string[];
  /** Tool name prefixes that indicate subagent coordination.
   *  Default: ['subagent:'] */
  subagentToolPrefixes?: string[];
  /** Exact tool names that indicate lesson capture.
   *  Default: ['lessons:create', 'lessons:update'] */
  lessonToolNames?: string[];

  /** Max chunk tokens for research phases (default: 2x targetChunkTokens) */
  maxResearchChunkTokens?: number;
  /** Max chunk tokens for synthesis phases (default: 1.5x targetChunkTokens) */
  maxSynthesisChunkTokens?: number;
  /** Max chunk tokens for subagent phases (default: 2x targetChunkTokens) */
  maxSubagentChunkTokens?: number;
  /** Max chunk tokens for lesson phases (default: targetChunkTokens) */
  maxLessonChunkTokens?: number;

  /** Maximum fraction of L1 budget for research summaries (default: 0.3) */
  researchL1BudgetCap?: number;
  /** Minimum fraction of L1 budget for synthesis summaries (default: 0.4) */
  synthesisL1BudgetFloor?: number;
  /** Maximum fraction of L1 budget for synthesis summaries (default: 0.7).
   *  Prevents synthesis from starving lessons/subagent/research phases. */
  synthesisL1BudgetCap?: number;
}

/**
 * Default configuration for Autobiographical strategy.
 */
export const DEFAULT_AUTOBIOGRAPHICAL_CONFIG: AutobiographicalConfig = {
  targetChunkTokens: 3000,
  recentWindowTokens: 30000,
  headWindowTokens: 0,
  chunkOnMessageBoundary: true,
  attachmentsIgnoreSize: true,
  autoTickOnNewMessage: false,
  summarySystemPrompt: 'You are forming a memory of an earlier part of this conversation. The context you see is continuous with your experience - what you read is what happened. Write authentically about what occurred.',
  summaryUserPrompt: `What do you recall from this part of the conversation?

{content}

Capture what matters:
- What was discussed or accomplished
- Key decisions, insights, or information exchanged
- Important context that would be needed to continue

Write naturally, as recollection of what you experienced.`,
  summaryContextLabel: 'What do you remember from earlier?',
  summaryParticipant: 'Claude',
  maxMessageTokens: 0,
  positionedRecallPairs: true,
  recallHeaderTemplate: '[Recall {id}]',
};
