import type { Membrane } from 'membrane';
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
}

/**
 * Compression level in the hierarchical pyramid.
 */
export type SummaryLevel = 1 | 2 | 3;

/**
 * A summary entry in the hierarchical memory pyramid.
 * L1: compressed from raw message chunks.
 * L2: merged from mergeThreshold L1s.
 * L3: merged from mergeThreshold L2s.
 */
export interface SummaryEntry {
  /** Unique ID (e.g., "L1-0", "L2-3") */
  id: string;
  /** Compression level */
  level: SummaryLevel;
  /** The summary text */
  content: string;
  /** Estimated token count (content.length / 4) */
  tokens: number;
  /** Level of the sources: 0 = raw messages, 1 = L1s, 2 = L2s */
  sourceLevel: 0 | 1 | 2;
  /** IDs of source items (message IDs for L1, summary IDs for L2/L3) */
  sourceIds: string[];
  /** Range of original message IDs covered */
  sourceRange: { first: string; last: string };
  /** If merged into a higher-level summary, that summary's ID */
  mergedInto?: string;
  /** Creation timestamp */
  created: number;
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
};
