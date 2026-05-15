/**
 * Pluggable folding strategy interface for the adaptive-resolution picker.
 *
 * The picker is a generic orchestrator; the policy (which group to raise next,
 * whether to lower, whether to request a missing summary) lives in a strategy
 * object. V1 ships `FlatProfileStrategy` (default, level-equalizing) and
 * `OldestFirstStrategy` (chronological, matches the rev-1 design).
 *
 * See `docs/adaptive-resolution-design.md` §3.5.
 */

import type { MessageId } from '../types/message.js';
import type { SummaryEntry } from '../types/strategy.js';

/** Identifier of a summary in the archive (e.g., "L2-15"). */
export type SummaryId = string;

/** Identifier of a chunk — for now equivalent to a MessageId. */
export type ChunkId = MessageId;

/** Half-open range of chunks, identified by message IDs. */
export interface ChunkRange {
  firstChunkId: ChunkId;
  lastChunkId: ChunkId;
}

/**
 * A view of a single chunk for strategy decisions.
 *
 * Strategies should treat ChunkView as read-only. Use the picker's
 * apply() to commit fold operations rather than mutating fields directly.
 */
export interface ChunkView {
  id: ChunkId;
  /** Position in source order (lower = older). */
  sequence: number;
  /** Approximate tokens of raw content. */
  rawTokens: number;
  /** Current display resolution. 0 = raw, k>0 = L_k summary. */
  currentResolution: number;
  /** Whether the picker is forbidden from changing currentResolution. */
  lockedByAgent: boolean;
  /** If this chunk is a shard of a larger logical message, the group id. */
  bodyGroupId?: string;
  /** True if this chunk is in the head window (kept raw). */
  inHead: boolean;
  /** True if this chunk is in the tail window (kept raw). */
  inTail: boolean;
  /** True if this chunk is pinned. */
  pinned: boolean;
  /**
   * The chunk's ancestor at level k in the summary tree, if one exists.
   * Returns null if the level has not been produced for this chunk's range.
   */
  ancestorAt(level: number): SummaryEntry | null;
  /** The highest level k for which a summary exists covering this chunk. */
  maxAvailableLevel(): number;
}

/**
 * Read-only view passed to a FoldingStrategy.
 */
export interface FoldingState {
  /** All chunks in source order. */
  chunks(): readonly ChunkView[];
  /** Chunks that are foldable — not in head/tail, not pinned, not locked. */
  foldableMiddle(): readonly ChunkView[];
  /** Look up a summary by id. */
  getSummary(id: SummaryId): SummaryEntry | null;
  /** All leaf chunks under a given summary (recursively walks the tree). */
  leavesUnder(groupRoot: SummaryId): readonly ChunkView[];
  /**
   * Estimate of total tokens that would be rendered with the current
   * per-chunk resolutions. Cached; recompute via recomputeTokens() after
   * applying a fold op.
   */
  tokenCount(): number;
}

/** A fold operation returned by FoldingStrategy.selectNextFold. */
export type FoldOp =
  | {
      kind: 'raise';
      /** L_{k+1} summary id that becomes the new visible level for the group. */
      groupRoot: SummaryId;
    }
  | {
      kind: 'lower';
      /** L_k summary id whose group is being lowered to (k-1). V2 only. */
      groupRoot: SummaryId;
    }
  | {
      kind: 'produce';
      /** Level to produce (e.g., 2 for L2). */
      level: number;
      /** Range of chunks the produced summary should cover. */
      range: ChunkRange;
    };

/**
 * Budget context for the strategy.
 */
export interface FoldingBudget {
  /** Hard maximum tokens (model context - response reserve). */
  totalBudget: number;
  /** Soft target tokens (totalBudget * (1 - slack)). Strategies fold until at or below. */
  targetBudget: number;
  /** Slack ratio (e.g., 0.1 for 10%). */
  slack: number;
}

/**
 * Pluggable strategy interface.
 *
 * The picker calls selectNextFold() repeatedly until it returns null. On
 * each call, the strategy inspects current state and returns one operation:
 *  - 'raise' — fold a group up one level (the picker applies it and re-asks)
 *  - 'lower' — refold down one level (V2; default V1 strategies don't emit this)
 *  - 'produce' — request lazy summary production (the picker enqueues it
 *    and stops; the next compile will retry)
 *
 * A strategy MUST converge: it must either eventually return null, or emit
 * a 'produce' op that doesn't loop indefinitely. The picker has its own
 * loop-bound safeguard, but well-behaved strategies make it unnecessary.
 */
export interface FoldingStrategy {
  readonly name: string;
  selectNextFold(state: FoldingState, budget: FoldingBudget): FoldOp | null;
}
