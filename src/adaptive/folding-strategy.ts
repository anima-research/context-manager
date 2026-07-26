/**
 * Folding solver protocol for the adaptive-resolution picker.
 *
 * A folding strategy is a SOLVER: one call produces the complete per-chunk
 * target frontier (plus any requests for summaries that don't exist yet).
 * The picker validates and applies that frontier — there is no op walk.
 *
 * History: through 2026-07 this was an op-walk protocol (`selectNextFold`
 * returning one group-atomic 'raise'/'lower' per call, applied by the picker
 * until convergence). Group-atomic ops cannot express a frontier that
 * legitimately cuts through a summary group — which V2 leveled pins produce
 * by design — so the walk oscillated (raise for one leaf dragging pinned
 * siblings, their lower dragging it back; the 2026-07-25 Mythos outage and
 * the `raise:L4-936` wedge). The walk was also the third place a frontier
 * was derived, silently diverging from the solve it was supposed to realize.
 * It was removed deliberately and is not coming back: solvers own the
 * frontier; the picker owns validation, application, and accounting.
 *
 * See `docs/adaptive-resolution-design.md` §3.5, §13.
 */

import type { MessageId } from '../types/message.js';

/** Identifier of a summary in the archive (e.g., "L2-15"). */
export type SummaryId = string;

/** Identifier of a chunk — for now equivalent to a MessageId. */
export type ChunkId = MessageId;

/** Inclusive range of chunks, identified by message IDs. */
export interface ChunkRange {
  firstChunkId: ChunkId;
  lastChunkId: ChunkId;
}

/**
 * Request to build a summary that does not exist yet. The picker returns
 * these to the caller (which enqueues compression/merge work); the next
 * compile re-solves with the new summary available.
 */
export interface ProduceRequest {
  /** Level to produce (e.g., 2 for L2). */
  level: number;
  /** Range of chunks the produced summary should cover. */
  range: ChunkRange;
}

/**
 * Budget context for the solver.
 */
export interface FoldingBudget {
  /** Hard maximum tokens (model context - response reserve). */
  totalBudget: number;
  /** Soft target tokens (totalBudget * (1 - slack)). Solvers fold until at or below. */
  targetBudget: number;
  /** Slack ratio (e.g., 0.1 for 10%). */
  slack: number;
}

/** The complete result of one solve. */
export interface FoldingSolution {
  /**
   * Target resolution per chunk (0 = raw, k = L_k). Chunks absent from the
   * map are treated as 0. The frontier must be REALIZABLE: every targeted
   * level's ancestor summary exists. The picker verifies this and treats a
   * violation as a loud solver bug (clamped to raw for accounting, never
   * silently absorbed).
   */
  frontier: ReadonlyMap<ChunkId, number>;
  /** Summaries the solver wanted but that don't exist yet. */
  produced: ProduceRequest[];
  /**
   * Solver-owned exhaustion semantics: true when the solver has no further
   * way to shrink the plan and the result is genuinely problematic.
   *
   * The two shipped semantics differ deliberately:
   *  - greedy solvers: above the SOFT target with nothing left to fold or
   *    produce (they fold until they reach the target or run out of moves,
   *    so "still above target" means capacity is exhausted);
   *  - kv-stable: even FULL folding exceeds the HARD wall W
   *    (`ControlPlan.escalated`). Sitting above the soft target inside the
   *    [target, W] dead band is kv-stable's designed resting state — zero
   *    perturbation beats chasing the attractor — and must NOT read as
   *    exhaustion (pre-2026-07 the generic formula flagged every healthy
   *    dead-band hold, so `exhausted=true` was chronic on healthy agents
   *    and indistinguishable from the real over-the-wall state).
   *
   * Optional for stub/test solvers: when absent the picker falls back to
   * the greedy formula over the APPLIED frontier's tokens.
   */
  exhausted?: boolean;
}

/**
 * Pluggable folding solver.
 *
 * `solve` is called once per compile with the full inputs and must return a
 * complete frontier deterministically. Solvers that iterate internally
 * (greedy strategies) do so on their own state — the picker never sees
 * intermediate steps.
 */
export interface FoldingSolver {
  readonly name: string;
  solve(inputs: import('./picker.js').PickerInputs, budget: FoldingBudget): FoldingSolution;
}
