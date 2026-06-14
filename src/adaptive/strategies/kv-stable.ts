/**
 * KvStableStrategy — the KV-stable context controller plugged into the existing
 * picker (see `docs/kv-stable-context-control.md`).
 *
 * Same "solve-once-then-walk" bridge as `BestFitStrategy`: on the first
 * `selectNextFold` it computes a target frontier with `planControlledFrontier`
 * (the *same* policy the replay harness measures), memoizes it, then emits one
 * `raise`/`lower` op per call to walk the live state toward it, returning `null`
 * once reached. The picker already applies raise/lower — no picker change.
 *
 * Unlike `BestFitStrategy` (which maximizes value − λ·KVcost over a half-life
 * recency model), this minimizes real prefix churn directly: it holds the flat
 * zone (head/tail/pinned) raw, never folds locked chunks, and sheds the foldable
 * middle oldest-first/leveled under a per-turn divergence **reach cap** (the
 * perturbation cap P), bounded by per-chunk log-age saliency caps, yielding the
 * reach cap only as far as needed to stay under the hard wall (`totalBudget`).
 * No λ, no recency half-life.
 *
 * Like `BestFitStrategy`, it does not emit `produce` ops — deeper folding than
 * has been produced is the speculative pre-producer's job; the controller only
 * targets levels whose summaries already exist. Deterministic.
 */

import type {
  FoldingStrategy,
  FoldingState,
  FoldingBudget,
  FoldOp,
  ChunkId,
} from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { SummaryTree } from '../summary-tree.js';
import { planControlledFrontier } from '../kv-control.js';

export interface KvStableOptions {
  /** Per-turn divergence reach — the structural perturbation cap P, in tokens.
   *  Smaller = gentler per-turn KV churn (shallow divergence) but less efficient
   *  compression. Exceeded only to stay under the hard wall. Default: the hard
   *  budget (effectively unbounded within the window). */
  reachTokens?: number;
  /** Base-k summary grouping (matches the strategy's mergeThreshold). Default 6. */
  mergeThreshold?: number;
}

export class KvStableStrategy implements FoldingStrategy {
  readonly name = 'kv-stable';

  private readonly inputs: PickerInputs;
  private readonly opts: KvStableOptions;
  private readonly fPrev: Map<ChunkId, number>;
  private target: Map<ChunkId, number> | null = null;

  constructor(inputs: PickerInputs, opts: KvStableOptions = {}) {
    this.inputs = inputs;
    this.opts = opts;
    this.fPrev = new Map(inputs.chunks.map((c) => [c.id, c.currentResolution]));
  }

  selectNextFold(state: FoldingState, budget: FoldingBudget): FoldOp | null {
    if (!this.target) this.target = this.solve(budget);
    return this.nextOp(state);
  }

  /** Target frontier this run is walking toward (null before the first call). */
  targetFrontier(): ReadonlyMap<ChunkId, number> | null {
    return this.target;
  }

  private solve(budget: FoldingBudget): Map<ChunkId, number> {
    const tree = new SummaryTree(this.inputs);

    // Flat zone (forced raw, never folded): head, tail, pinned. Frozen (kept at
    // their carried resolution, never folded): locked.
    const rawZone = new Set<ChunkId>();
    const frozen = new Set<ChunkId>();
    let now = 0;
    for (const c of this.inputs.chunks) {
      if (c.sequence > now) now = c.sequence;
      if (this.inputs.headChunkIds.has(c.id) || this.inputs.tailChunkIds.has(c.id) || c.pinned) {
        rawZone.add(c.id);
      } else if (c.lockedByAgent) {
        frozen.add(c.id);
      }
    }

    return planControlledFrontier(this.inputs, tree, {
      previous: this.fPrev,
      // Bidirectional within the slack band: fold when over the hard budget,
      // un-fold to use headroom when under the soft target. Both reach-bounded;
      // [targetBudget, totalBudget] is the quiet dead band.
      foldAtTokens: budget.totalBudget,
      expandAtTokens: budget.targetBudget,
      targetTokens: budget.targetBudget,
      windowTokens: budget.totalBudget,
      reachTokens: this.opts.reachTokens,
      rawZone,
      frozen,
      now,
      mergeThreshold: this.opts.mergeThreshold,
    }).resolutions;
  }

  /** Emit one op moving the live state toward the target frontier. */
  private nextOp(state: FoldingState): FoldOp | null {
    const target = this.target!;
    for (const c of state.chunks()) {
      if (c.inHead || c.inTail || c.pinned || c.lockedByAgent) continue;
      const cur = c.currentResolution;
      const tgt = target.get(c.id) ?? 0;
      if (cur === tgt) continue;

      if (cur < tgt) {
        const summary = c.ancestorAt(tgt);
        if (!summary) continue; // unrealizable target (summary not produced) — skip
        return { kind: 'raise', groupRoot: summary.id };
      }
      const summary = c.ancestorAt(cur);
      if (!summary) continue;
      return { kind: 'lower', groupRoot: summary.id };
    }
    return null;
  }
}
