/**
 * KvStableStrategy — the KV-stable context controller as a folding SOLVER
 * (the rev 5.0 single-path solve; see `docs/adaptive-resolution-design.md`
 * §13. `docs/kv-stable-context-control.md` is the historical "why" and the
 * measurement harness).
 *
 * One `solve` call computes the complete target frontier with
 * `planControlledFrontier` (the *same* policy the replay harness measures)
 * and returns it for the picker to apply directly.
 *
 * It minimizes real prefix churn: it holds the flat zone (head/tail/pinned)
 * raw, never folds locked chunks, honors V2 leveled pins (`pinLevel` /
 * `pinMaxLevel`) as fixed levels / hard fold-depth caps, and reconciles a
 * from-scratch relevance-ideal cut against the carried frontier under a
 * perturbation TRUST REGION P (exact kvCost, not a spatial gate) — adopting
 * the ideal within P, amortizing bigger repairs via suffix adoption, and
 * exceeding P only with a recorded override. There is no emergency path.
 *
 * It does not SPECULATIVELY emit produce requests — deeper folding than has
 * been produced is the speculative pre-producer's job; the controller only
 * targets levels whose summaries already exist. The one exception is DEMAND
 * under escalation (issue #56): when even full folding exceeds the hard wall
 * W while foldable chunks have no L1 coverage at all, production is the only
 * remaining lever, and the caller's demand path (`handleProducedOps` →
 * `enqueueL1ForRange` → the L1-holdback exemption) is reachable only through
 * produce ops — so the solve emits L1 requests for the uncovered ranges.
 * Deterministic.
 *
 * History: this used to walk the plan into the picker one group-atomic
 * raise/lower op at a time. Group ops cannot express a frontier that cuts
 * through a group — which leveled pins legitimately require — so the walk
 * oscillated (the 2026-07-25 Mythos outage; the `raise:L4-936` wedge) and
 * silently rendered "nearest realizable" frontiers that diverged from the
 * plan while plan-vs-actual reported zero drift. The walk is gone; the plan
 * IS the frontier.
 */

import type {
  FoldingSolver,
  FoldingSolution,
  FoldingBudget,
  ChunkId,
  ProduceRequest,
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

export class KvStableStrategy implements FoldingSolver {
  readonly name = 'kv-stable';

  private readonly opts: KvStableOptions;
  private _lastPlan: ControlPlan | null = null;
  private _lastTarget: Map<ChunkId, number> | null = null;

  constructor(opts: KvStableOptions = {}) {
    this.opts = opts;
  }

  /** Target frontier of the most recent solve (null before the first). */
  targetFrontier(): ReadonlyMap<ChunkId, number> | null {
    return this._lastTarget;
  }

  /** The full control plan behind the target (perturbation, override) — for
   *  observability at the call site (`[kv-escalation]` logging). Null before
   *  the first `solve`. */
  lastPlan(): ControlPlan | null {
    return this._lastPlan;
  }

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    const tree = new SummaryTree(inputs);
    const fPrev = new Map(inputs.chunks.map((c) => [c.id, c.currentResolution]));

    // Flat zone (forced raw, never folded): head, tail, classic pins. Frozen
    // (kept at their carried resolution, never touched): locked. V2 dynamic pins
    // (`pinLevel` / `pinMaxLevel`) are honored as a fixed level or a hard fold-
    // depth cap — see `planControlledFrontier`.
    const rawZone = new Set<ChunkId>();
    const frozen = new Set<ChunkId>();
    const fixedLevels = new Map<ChunkId, number>();
    const pinCaps = new Map<ChunkId, number>();
    const fixedPins: Array<{ id: ChunkId; level: number }> = [];
    let now = 0;
    for (const c of inputs.chunks) {
      if (c.sequence > now) now = c.sequence;
      if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id) || c.pinned) {
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
    // single sub-chunk while its siblings render raw is an unrenderable
    // frontier. Clamp k to the deepest produced level for the chunk; if none
    // exists, fall back to fixing just the chunk (the controller clamps it
    // further). Skip leaves already forced raw (head/tail/classic pin).
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

    const plan = planControlledFrontier(inputs, tree, {
      previous: fPrev,
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
    this._lastTarget = plan.resolutions;

    // DEMAND-SIDE PRODUCTION (issue #56). Speculative pre-production stays the
    // pre-producer's job — but when even full folding exceeds the hard wall W
    // (plan.escalated) while foldable chunks have no L1 at all, producing
    // those L1s is the only lever left, and the caller's demand path
    // (`handleProducedOps` → `enqueueL1ForRange` → `_demandedL1Chunks`) fires
    // only on produce ops. Emitting none wedged tight operating points
    // PERMANENTLY: the L1 holdback filter kept the newest closed chunk(s) out
    // of the speculative queue, demand could never be raised to override the
    // holdback, and every compile re-escalated infeasible (the L1-holdback
    // deadlock — external repro at budgets 14–26k). Contiguous uncovered runs
    // coalesce into one request each; the consumer maps message ranges back
    // onto closed chunks and dedupes against its queue, so re-emission on
    // subsequent escalated compiles is convergent, and a range covering only
    // the unclosed trailing span (not yet a chunk) is skipped harmlessly.
    const produced: ProduceRequest[] = [];
    if (plan.escalated) {
      const bySequence = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
      let run: { first: ChunkId; last: ChunkId } | null = null;
      const flush = (): void => {
        if (run) produced.push({ level: 1, range: { firstChunkId: run.first, lastChunkId: run.last } });
        run = null;
      };
      for (const c of bySequence) {
        // Uncovered AND foldable: no L1 lineage, not force-raw (head/tail/
        // pins — incl. pin-at-k clamped to raw for lack of summaries, which
        // lands in rawZone above), not frozen (locked keeps its resolution,
        // so a produced L1 could never be rendered anyway).
        const uncovered = !c.l1Id && !rawZone.has(c.id) && !frozen.has(c.id);
        if (!uncovered) { flush(); continue; }
        if (run) run.last = c.id;
        else run = { first: c.id, last: c.id };
      }
      flush();
    }

    return {
      frontier: plan.resolutions,
      produced,
      // Kv-stable exhaustion is the ESCALATED state only: even full folding
      // exceeds the hard wall W. A dead-band hold above the soft target is
      // the designed steady state, not exhaustion — see
      // FoldingSolution.exhausted for why the semantics are solver-owned.
      exhausted: plan.escalated,
    };
  }
}
