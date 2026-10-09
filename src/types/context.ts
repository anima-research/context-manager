import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import type { MessageId, StoredContentBlock } from './message.js';

/**
 * Describes how a context entry relates to its source message.
 * This determines edit propagation behavior.
 */
export type SourceRelation =
  /** Direct copy - edits MUST propagate */
  | 'copy'
  /** Summary/compression - edits MAY be ignored (stale is acceptable) */
  | 'derived'
  /** Just mentions source - edits DON'T propagate */
  | 'referenced';

/**
 * An entry in the context log.
 * The context log is a materialized, editable working set derived from the message store.
 */
export interface ContextEntry {
  /** Index in the context log */
  index: number;
  /** Source message ID (if derived from message store) */
  sourceMessageId?: MessageId;
  /**
   * FULL provenance when this entry stands for more than one message — e.g. a
   * composite produced by merging adjacent body-group shards. `sourceMessageId`
   * names only the first, which made merged shards look unrepresented to the
   * coverage invariant. Populate this wherever N entries collapse into one.
   */
  sourceMessageIds?: MessageId[];
  /** How this entry relates to its source */
  sourceRelation?: SourceRelation;
  /** Participant name */
  participant: string;
  /** Materialized content blocks */
  content: ContentBlock[];
  /** For prompt caching (future) */
  cacheMarker?: boolean;
  /** Internal cache-layout identity when this entry ends one atomic rendered
   * unit. Used to reconcile message markers with accepted solver receipts. */
  cacheLayoutKey?: string;
}

/**
 * Internal representation with blob references for storage.
 */
export interface ContextEntryInternal {
  index: number;
  sourceMessageId?: MessageId;
  sourceRelation?: SourceRelation;
  participant: string;
  content: StoredContentBlock[];
  cacheMarker?: boolean;
  cacheLayoutKey?: string;
}

/**
 * Token budget for context compilation.
 */
export interface TokenBudget {
  /** Total token window, including reserveForResponse. Strategies target maxTokens - reserveForResponse input tokens. */
  maxTokens: number;
  /** Response tokens withheld from maxTokens before fitting the input context. */
  reserveForResponse: number;
}

/**
 * Information about pending background work.
 */
export interface PendingWork {
  /** Human-readable description */
  description: string;
  /** Estimated time to completion in ms */
  estimatedMs?: number;
  /** When the work started */
  started: Date;
}

/**
 * An injection into the compiled context.
 * Source-agnostic: may come from MCPL servers, local strategies, or application code.
 *
 * @deprecated Context injection is deprecated
 * (anima-research/agent-framework#171). Injections are never stored: each
 * `compile()` splices them in fresh, re-anchored to the latest
 * user-participant message, so the rendered prefix changes at every
 * activation and prompt caches stop hitting past that point (head-only
 * hits on OpenAI Responses/Codex). After a mid-activation recompile the
 * anchor can also fall between a tool call and its result. Prefer content
 * that is stored once at its own position — system prompt for durable
 * instructions, ordinary messages for changing state. Still accepted by
 * `compile()` for now.
 */
export interface ContextInjection {
  /** Server-defined namespace (e.g., "memory", "compliance") */
  namespace: string;

  /** Where to inject in the message array */
  position: 'system' | 'beforeUser' | 'afterUser';

  /** Content blocks to inject (multimodal) */
  content: ContentBlock[];

  /** Arbitrary metadata (passed through, not interpreted) */
  metadata?: Record<string, unknown>;
}

/**
 * Result of context compilation.
 * Separates system-position injections from message-level content.
 */
/** Planner/emitter reconciliation for one compile (see rsEnd). */
export interface PlanVsActual {
  /** Picker's projected total after folding. */
  planned: number;
  /** Tokens the emitter actually committed. */
  actual: number;
  /** actual - planned; positive means the emitter overran the plan. */
  delta: number;
  budgetMet: boolean;
  exhausted: boolean;
  /** Chunks whose resolution the applied frontier changed vs the carried
   *  state. (Replaced the op-walk's `iterations` when the walk was retired.) */
  moves: number;
}

export interface CompileResult {
  /** Compiled messages (includes beforeUser/afterUser injections merged in) */
  messages: NormalizedMessage[];

  /**
   * System-position injections, grouped by namespace.
   * Caller should append these to the system prompt.
   * Separated because the system prompt is outside context-manager's scope.
   *
   * @deprecated Only populated by deprecated `system`-position
   * {@link ContextInjection}s; empty when no injections are passed.
   */
  systemInjections: ContentBlock[];
}

/**
 * Branch information.
 */
export interface BranchInfo {
  /** Branch identifier */
  id: string;
  /** Branch name */
  name: string;
  /** Current head sequence */
  head: number;
  /** Parent branch ID */
  parentId?: string;
  /** Sequence at which branch was created */
  branchPoint?: number;
  /** Creation timestamp */
  created: Date;
}
