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
import { planControlledFrontier, type ControlPlan } from '../kv-control.js';

export interface KvStableOptions {
  /** Trust region P on per-turn perturbation, in tokens the provider would
   *  re-read (exact kvCost — see design §13.4). Within it the solver adopts
   *  the relevance-ideal cut; beyond it it amortizes via suffix adoption or
   *  overrides with cause. Default: the hard budget (never binds). */
  reachTokens?: number;
  /** Quality-gap override threshold (design §13.4). Default 0.35. */
  qualityGapRatio?: number;
  /** Base-k summary grouping (matches the strategy's mergeThreshold). Default 6. */
  mergeThreshold?: number;
  /** Future high/low watermark pair. The live FoldingBudget remains the hard
   * wall while the controller walks toward these smaller values. */
  goalTotalTokens?: number;
  goalTargetTokens?: number;
  /** Enforce reach as a hard transition pace instead of allowing quality overrides. */
  strictReach?: boolean;
}

export class KvStableStrategy implements FoldingStrategy {
  readonly name = 'kv-stable';

  private readonly inputs: PickerInputs;
  private readonly opts: KvStableOptions;
  private readonly fPrev: Map<ChunkId, number>;
  private target: Map<ChunkId, number> | null = null;
  private _lastPlan: ControlPlan | null = null;

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

  /** The full control plan behind the target (perturbation, override) — for
   *  observability at the call site (`[kv-escalation]` logging). Null before
   *  the first `selectNextFold`. */
  lastPlan(): ControlPlan | null {
    return this._lastPlan;
  }

  private solve(budget: FoldingBudget): Map<ChunkId, number> {
    const tree = new SummaryTree(this.inputs);

    // Flat zone (forced raw, never folded): head, tail, classic pins. Frozen
    // (kept at their carried resolution, never folded): locked. V2 dynamic pins
    // (`pinLevel` / `pinMaxLevel`) are honored as a fixed level or a hard fold-
    // depth cap — see `planControlledFrontier`.
    const rawZone = new Set<ChunkId>();
    const frozen = new Set<ChunkId>();
    const fixedLevels = new Map<ChunkId, number>();
    const pinCaps = new Map<ChunkId, number>();
    const fixedPins: Array<{ id: ChunkId; level: number }> = [];
    let now = 0;
    for (const c of this.inputs.chunks) {
      if (c.sequence > now) now = c.sequence;
      if (this.inputs.headChunkIds.has(c.id) || this.inputs.tailChunkIds.has(c.id) || c.pinned) {
        rawZone.add(c.id);
      } else if (c.pinLevel !== undefined) {
        // Pin-at-level-k: fix exactly at k (0 = raw). k=0 is equivalent to a
        // classic raw pin, so route it through the raw zone; k>0 is resolved to
        // its whole L_k node below (group-consistent — see the loop after).
        if (c.pinLevel <= 0) rawZone.add(c.id);
        else fixedPins.push({ id: c.id, level: c.pinLevel });
      } else if (c.pinMaxLevel !== undefined) {
        // Pin-max-level: a hard fold-depth cap. maxLevel 0 ≡ classic raw pin.
        if (c.pinMaxLevel <= 0) rawZone.add(c.id);
        else pinCaps.set(c.id, c.pinMaxLevel);
        if (c.lockedByAgent) frozen.add(c.id);
      } else if (c.lockedByAgent) {
        frozen.add(c.id);
      }
    }

    // Group-consistency for pin-at-level-k: an L_k recall pair is atomic over
    // its whole covered range, so "cut through the L_k node" (design §7) fixes
    // EVERY leaf under that node at k — not just the addressed chunk. Fixing a
    // single sub-chunk while its siblings render raw is an unrenderable (and
    // non-converging) frontier. Clamp k to the deepest produced level for the
    // chunk; if none exists, fall back to fixing just the chunk (the controller
    // clamps it further). Skip leaves already forced raw (head/tail/classic pin).
    for (const { id, level } of fixedPins) {
      const eff = Math.min(level, tree.maxLevel(id));
      if (eff <= 0) { rawZone.add(id); continue; }
      const node = tree.ancestorAt(id, eff);
      if (!node) { fixedLevels.set(id, eff); continue; }
      for (const leaf of node.leafChunkIds) {
        if (rawZone.has(leaf)) continue;
        // Finest requirement wins if two pins overlap a leaf.
        const prev = fixedLevels.get(leaf);
        fixedLevels.set(leaf, prev === undefined ? eff : Math.min(prev, eff));
      }
    }

    const plan = planControlledFrontier(this.inputs, tree, {
      previous: this.fPrev,
      // Single-path solve (design §13.4): the [targetBudget, totalBudget] band
      // is the quiet dead band; the trust region and overrides do the rest.
      foldAtTokens: this.opts.goalTotalTokens ?? budget.totalBudget,
      expandAtTokens: this.opts.goalTargetTokens ?? budget.targetBudget,
      targetTokens: this.opts.goalTargetTokens ?? budget.targetBudget,
      windowTokens: budget.totalBudget,
      reachTokens: this.opts.reachTokens,
      strictReach: this.opts.strictReach,
      qualityGapRatio: this.opts.qualityGapRatio,
      rawZone,
      frozen,
      fixedLevels,
      pinCaps,
      now,
      mergeThreshold: this.opts.mergeThreshold,
    });
    this._lastPlan = plan;
    return plan.resolutions;
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
