/**
 * BestFitStrategy — V2 best-fit folding plugged into the existing picker
 * (docs §6, §11 step 6).
 *
 * The picker is a single-op loop; the best-fit solve is global. We bridge them
 * with "global-solve once, then walk": on the first `selectNextFold` the
 * strategy runs `solveStableFrontier` against F_prev (the initial per-chunk
 * resolutions) and memoizes the target frontier; thereafter each call emits one
 * `raise` / `lower` op moving the live state toward that target, returning
 * `null` once reached. No `Picker.run` change is needed — it already applies
 * `raise`/`lower`.
 *
 * Op derivation (frontier → ops diff):
 *  - chunk below its target level  → raise to the target-level summary (folds
 *    the whole group at once; applyRaise only lifts leaves still below it);
 *  - chunk above its target level  → lower its current-level summary by one
 *    (safe: a chunk is only above target when that node is expanded in the
 *    target, so every leaf under it is also above target — no overshoot).
 *
 * The solver only ever targets levels whose summaries already exist (it picks
 * among produced nodes), so a `produce` op is not required here; deeper folding
 * than is produced is the speculative pre-producer's job. Deterministic.
 *
 * Construction takes the same `PickerInputs` the picker will run on, plus the
 * value function and λ — the integration layer instantiates it directly (it
 * carries config the string-keyed strategies don't).
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
import type { ValueFunction } from '../value-function.js';
import { solveStableFrontier } from '../stable-frontier.js';

export interface BestFitOptions {
  value: ValueFunction;
  /** KV-stability weight (value-tokens per recomputed cache-token). */
  lambda: number;
  candidateCap?: number;
  muIterations?: number;
}

export class BestFitStrategy implements FoldingStrategy {
  readonly name = 'best-fit';

  private readonly inputs: PickerInputs;
  private readonly opts: BestFitOptions;
  private readonly fPrev: Map<ChunkId, number>;
  private target: Map<ChunkId, number> | null = null;

  constructor(inputs: PickerInputs, opts: BestFitOptions) {
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
    const fixed = new Set<ChunkId>();
    for (const c of this.inputs.chunks) {
      if (
        c.pinned ||
        c.lockedByAgent ||
        this.inputs.headChunkIds.has(c.id) ||
        this.inputs.tailChunkIds.has(c.id)
      ) {
        fixed.add(c.id);
      }
    }
    const result = solveStableFrontier(this.inputs, tree, {
      previous: this.fPrev,
      budgetTokens: budget.targetBudget,
      value: this.opts.value,
      lambda: this.opts.lambda,
      isFoldable: (id) => !fixed.has(id),
      candidateCap: this.opts.candidateCap,
      muIterations: this.opts.muIterations,
    });
    return result.resolutions;
  }

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
      if (!summary) continue; // rendered at cur but no summary — shouldn't happen
      return { kind: 'lower', groupRoot: summary.id };
    }
    return null;
  }
}
