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
  /** How this entry relates to its source */
  sourceRelation?: SourceRelation;
  /** Participant name */
  participant: string;
  /** Materialized content blocks */
  content: ContentBlock[];
  /** For prompt caching (future) */
  cacheMarker?: boolean;
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
}

/**
 * Token budget for context compilation.
 */
export interface TokenBudget {
  /** Maximum tokens for the context window */
  maxTokens: number;
  /** Reserve this many tokens for model response */
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
export interface CompileResult {
  /** Compiled messages (includes beforeUser/afterUser injections merged in) */
  messages: NormalizedMessage[];

  /**
   * System-position injections, grouped by namespace.
   * Caller should append these to the system prompt.
   * Separated because the system prompt is outside context-manager's scope.
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
