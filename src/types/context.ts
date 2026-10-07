import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import type { MessageId, StoredContentBlock, StoredMessage } from './message.js';

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
  /**
   * The summaries this entry renders, for a `derived` entry that stands for
   * folded history (both halves of a recall pair carry it; a combined recall
   * answer names every summary it concatenates). Strategies that report
   * their rendered layout (`ContextStrategy.reportsRenderedLayout`) must set
   * it on every entry that represents history through a summary: the
   * compile's layout derives each message's rendered form from it.
   */
  summaries?: Array<{ id: string; level: number; partial?: true }>;
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
   */
  systemInjections: ContentBlock[];

  /**
   * What each compiled message is a copy of, and the rendered layout this
   * compile produced. Always set by `ContextManager.compile`; optional in the
   * type so callers that build a CompileResult by hand (test doubles) still
   * typecheck. Hand the whole object back to `ContextManager.acceptRound`
   * once a provider round that carried these messages has succeeded.
   */
  provenance?: CompileProvenance;

  /**
   * The stored messages behind every raw body in `provenance`, as this
   * compile's view held them: each body's head and, for a sharded body,
   * every shard. The view may merge auxiliary stores (another namespace's
   * slot), whose messages `getMessage` cannot resolve, so callers that need a
   * body's metadata or content read it here. The map is bound to this compile:
   * a later edit doesn't show through it. It's transient and isn't part of
   * the persisted provenance.
   */
  rawSources?: ReadonlyMap<MessageId, StoredMessage>;
}

/** A branch as a compile or receipt saw it: native id, name, creation time. */
export interface BranchRef {
  id: string;
  name: string;
  /** Chronicle's creation timestamp; with `id`, the branch's identity. */
  created: number;
}

/**
 * A stored body a compiled message carries as a raw copy. For a body stored
 * as shards (bodyGroupId), `messageId` is the first shard's id — the id
 * `addMessage` returned — and the body is described as a whole.
 */
export interface RawBodySource {
  messageId: MessageId;
  sequence: number;
  /**
   * True only when the whole stored body is in this request unaltered:
   * every shard present, nothing truncated, no image stripped, no block
   * removed by a structural repair. A group that declared its size
   * (StoredMessage.shardCount) must also hold all of its declared shards,
   * so one an interrupted write left short is missing `shards`.
   *
   * For a group without a declaration (written before sizes were recorded),
   * `complete` is weaker and relative to this view: every member the view
   * holds was carried unaltered. It does not show that the group was ever
   * written whole; an interrupted write can leave such a group short with
   * nothing to tell it apart.
   */
  complete: boolean;
  /** Why the copy is not complete (absent when complete). */
  missing?: Array<'shards' | 'content'>;
}

/** What one compiled message stands for. */
export type CompiledMessageSources =
  | { kind: 'raw'; bodies: RawBodySource[] }
  | { kind: 'summary'; summaries: Array<{ id: string; level: number; partial?: true }> }
  | { kind: 'injection'; namespace: string }
  | { kind: 'other' };

/**
 * One compile's provenance: the per-message sources (parallel to
 * `CompileResult.messages`) and the rendered layout. Immutable once
 * returned — callers carry it with the request it describes.
 */
export interface CompileProvenance {
  /** Unique per compile. */
  compileId: string;
  /** The context manager's namespace (its agent's state scope). */
  namespace: string;
  /** The branch this compile read. Acceptance binds to it. */
  branch: BranchRef;
  /** Parallel to `CompileResult.messages`. */
  messages: CompiledMessageSources[];
  /**
   * The rendered layout, or null when the strategy does not report one
   * (see `ContextStrategy.renderedForms`). Opaque to callers.
   */
  layout: RenderedLayout | null;
  /** The active strategy's name. */
  strategy: string;
}

/**
 * A rendered layout: the forms every message of the strategy's view took in
 * one compile, as ordered units. Raw messages are individual units; summary
 * and omitted spans are ranges. Token estimates are base estimates (before
 * the store's calibration multiplier), so they compare across compiles.
 */
export interface RenderedLayout {
  v: 1;
  units: LayoutUnit[];
  /** Base-estimate tokens of everything this compile rendered. */
  totalTokens: number;
  /** The store calibration multiplier when the compile ran. */
  calibration: number;
  /** Why the strategy says this compile's layout changed, when it knows. */
  cause?: string;
}

/** One unit of a rendered layout. Field names are short: layouts persist. */
export type LayoutUnit =
  /** A message rendered raw. `p` is set when the copy was partial. */
  | { k: 'r'; s: number; id: string; t: number; p?: 1 }
  /**
   * A run of view messages rendered through these summaries, each as
   * `[id, level, method, partial]` (partial 1 when the summary's text was
   * cut), sorted by id. `t` is the summaries' rendered tokens, attributed to
   * the first unit each summary appears in. `a`/`b` are the first and last
   * member; `m` is the exact membership (see MemberRun).
   */
  | { k: 's'; a: number; ai: string; b: number; bi: string; m: MemberRun[]; sm: Array<[string, number, string, 0 | 1]>; t: number }
  /** A run of view messages not rendered at all; `m` is its exact membership. */
  | { k: 'o'; a: number; ai: string; b: number; bi: string; m: MemberRun[] };

/**
 * `[firstSequence, firstId, lastSequence, lastId]`: every integer sequence
 * from first to last is a member. A range unit's members are exactly the
 * union of its runs, so a message the view lacked (removed, filtered out)
 * is never counted as part of a range just because it lies between the
 * range's endpoints.
 */
export type MemberRun = [number, string, number, string];

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
