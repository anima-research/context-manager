import type {
  FoldingBudget,
  FoldingSolution,
  FoldingSolver,
  ProduceRequest,
  ChunkId,
} from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { CanonicalSummaryForest, SparseLabelCeilingError } from '../kv-unified.js';
import { getSummaryParentId, type SummaryEntry } from '../../types/strategy.js';
import {
  ParetoKvUnifiedPolicySolver,
  type ParetoPolicySolveResult,
  type ParetoSolveOptions,
} from '../kv-unified-pareto.js';
import { ExactKvUnifiedPolicySolver, frontierSignature, normalizeContinuityMultiplier, normalizePolicy, policyScore, type KvUnifiedWelfarePolicy } from '../kv-unified-policy.js';

import type { KvUnifiedReuse } from '../kv-unified-reuse.js';
import type { SubtreeSolveStats } from '../kv-unified-subtree.js';
export type { KvUnifiedReuse } from '../kv-unified-reuse.js';

export interface KvUnifiedOptions extends Omit<ParetoSolveOptions, 'maxTokens'> {
  /** Live adapter refuses missing policy/grid fields when true. */
  requireExplicitPolicy?: boolean;
  treeifyNonContiguousSummaries?: boolean;
  preserveGapBearingSummaries?: boolean;
  latentDemand?: {
    mergeThreshold: number;
    fallbackRecallTokens: number;
    maxCandidates: number;
    /** How producible merges are measured against the live cut.
     * `individual` (absent): one conservative what-if solve per candidate,
     * each gain measured on its own, plus an expected-cost solve to order
     * the demanded ones (the v1 marginal rule of `unified-solve-design.md`
     * §8). `joint`: one what-if solve with every candidate present at its
     * conservative cost; the merges the pool's best cut in the shared frame
     * uses are demanded when that cut beats the live one by more than
     * `adoptEpsilon`, in the order of their estimated token reduction (the
     * hysteresis selection may be the carried layout kept within epsilon of
     * that cut, and is not the cut read). A compile with a merge backlog
     * then pays one extra solve instead of two per candidate, and the gain
     * is the set's, measured once, instead of per-candidate differences at
     * the approximation's noise floor. The strategy built from a recipe
     * fills in `joint` unless `latentDemandMode` says otherwise. */
    mode?: 'individual' | 'joint';
    /** Source sets whose merge the host would refuse to build (a merge in
     * its quarantine). Such a candidate never enters a what-if forest: a
     * cut that used it would attribute its gain to a merge that cannot be
     * made, and in joint mode hide the alternative the cut left out. */
    blocked?: (sourceIds: readonly string[]) => boolean;
  };
  /** Called when the live solve exceeds the label ceiling and the compile
   * takes the minimum-token cut instead (#252), so a host can tell whoever
   * sets the recipe. */
  onCeilingFallback?: (hit: KvUnifiedCeilingHit) => void;
}

export interface KvUnifiedTimings {
  readonly forestMs: number;
  readonly forestDerived: boolean;
  readonly certificateMs: number;
  readonly baseSolveMs: number;
  readonly demandMs: number;
  readonly demandSolves: number;
  /** Delta sets the base solve computed and reused, when the subtree
   * engine ran it (see kv-unified-subtree.ts). */
  readonly subtree?: SubtreeSolveStats;
  /** What the label ceiling stopped in this compile, when it stopped
   * anything (#252). */
  readonly ceiling?: KvUnifiedCeilingReport;
}

/** A search the label ceiling stopped: the ceiling, the labels it had made
 * when it stopped (at one state, or in all for the `leaf` engine), and the
 * engine whose search that was. Asked for no engine, the solve runs the
 * subtree engine and, past the ceiling, the packed one, so a hit there is
 * the packed engine's: `packed, after subtree`. */
export interface KvUnifiedCeilingHit {
  readonly ceiling: number;
  readonly labels: number;
  readonly engine: string;
}

/** What the label ceiling stopped in one compile. The ceiling bounds a
 * search; it doesn't fail the compile. */
export interface KvUnifiedCeilingReport {
  /** The live solve exceeded it, so the compile took the minimum-token cut
   * and demanded nothing. */
  readonly live?: KvUnifiedCeilingHit;
  /** Individual latent-demand what-ifs it stopped, in this compile or, under
   * the same inputs, an earlier one. A stopped conservative what-if leaves
   * its candidate undemanded; a stopped re-solve without the certificate
   * leaves the certified gain standing, and a stopped expected-cost solve
   * leaves the conservative gain to order the request. */
  readonly whatIfs: number;
  /** The base solve without the certificate exceeded it, so no merge was
   * demanded: a gate that passes against the certified base is decided
   * against that solve. */
  readonly gate: boolean;
  /** The joint latent-demand forest's solve exceeded it, in this compile or,
   * under the same inputs, an earlier one, so the candidates were ranked one
   * at a time. */
  readonly joint: boolean;
}

export interface LatentDemandEvaluation {
  readonly request: ProduceRequest;
  readonly sourceIds: readonly string[];
  readonly expectedRecallTokens: number;
  readonly conservativeRecallTokens: number;
  readonly expectedImprovement: number;
  readonly conservativeImprovement: number;
  readonly approximate: boolean;
}
/**
 * FoldingSolver adapter for kv-unified. It is intentionally not in the live
 * config union yet: callers must supply receipt/policy inputs explicitly.
 */
export class KvUnifiedStrategy implements FoldingSolver {
  readonly name = 'kv-unified';
  private last: ParetoPolicySolveResult | null = null;
  private demandEvaluations: LatentDemandEvaluation[] = [];
  private timings: KvUnifiedTimings | null = null;
  private requests: ProduceRequest[] = [];
  private demandSolves = 0;
  private ceilingWhatIfs = 0;
  private ceilingGate = false;
  private ceilingJoint = false;
  private signature: string | undefined;

  constructor(private readonly options: KvUnifiedOptions = {}) {}

  get lastResult(): ParetoPolicySolveResult | null {
    return this.last;
  }

  get lastDemandEvaluations(): readonly LatentDemandEvaluation[] {
    return this.demandEvaluations;
  }

  get lastTimings(): KvUnifiedTimings | null {
    return this.timings;
  }

  get lastRequests(): readonly ProduceRequest[] {
    return this.requests;
  }

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    if (this.options.requireExplicitPolicy) validateExplicitOptions(this.options);
    const t0 = performance.now();
    const forestOptions = {
      treeifyNonContiguousSummaries: this.options.treeifyNonContiguousSummaries,
      preserveGapBearingSummaries: this.options.preserveGapBearingSummaries,
    };
    const reuse = this.options.reuse;
    const forest =
      (reuse?.forest ? CanonicalSummaryForest.derive(reuse.forest, inputs, forestOptions) : null) ??
      new CanonicalSummaryForest(inputs, forestOptions);
    if (reuse) reuse.forest = forest;
    const t1 = performance.now();
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const options = { ...this.options, maxTokens: budget.totalBudget };
    let result: ParetoPolicySolveResult;
    let live: KvUnifiedCeilingHit | undefined;
    try {
      result = solver.solve(options);
    } catch (error) {
      // The ceiling bounds the search, not the compile (#252). Past it, the
      // compile takes the cut with the fewest tokens, which the solve's
      // feasibility check computes before any search: it fits whenever the
      // wall can be met. It becomes the carried layout, which the next
      // compile's certificate or search judges as any other.
      if (!(error instanceof SparseLabelCeilingError)) throw error;
      live = { ceiling: error.ceiling, labels: error.labelsCreated, engine: engineOf(options) };
      result = minimumTokenCut(inputs, forest, options);
      this.options.onCeilingFallback?.(live);
    }
    const t2 = performance.now();
    this.last = result;
    this.demandEvaluations = [];
    this.requests = [];
    this.demandSolves = 0;
    this.ceilingWhatIfs = 0;
    this.ceilingGate = false;
    this.ceilingJoint = false;
    this.signature = undefined;
    this.timings = {
      forestMs: t1 - t0, forestDerived: forest.derived, certificateMs: solver.lastCertificateMs, baseSolveMs: t2 - t1,
      demandMs: 0, demandSolves: 0, ...(solver.lastSubtreeStats ? { subtree: solver.lastSubtreeStats } : {}),
      ...(live ? { ceiling: { live, whatIfs: 0, gate: false, joint: false } } : {}),
    };
    if (!result.feasible) {
      if (result.feasibility.frontier) {
        return {
          frontier: result.feasibility.frontier,
          produced: demandMissingL1(inputs),
          exhausted: true,
        };
      }
      const conflict = result.feasibility.certificate.bindingLeaves
        .map((binding) => binding.leafId)
        .slice(0, 5)
        .join(', ');
      throw new Error(
        `kv-unified constraints are infeasible` +
          (conflict ? ` for ${conflict}` : '') +
          `: ${result.feasibility.certificate.suggestion}`,
      );
    }
    // Demand is gated against the policy's best cut, which a fallback isn't.
    const produced = this.options.latentDemand && !live
      ? this.rankLatentDemand(inputs, forest, solver, result, budget)
      : [];
    this.requests = produced;
    this.timings = {
      ...this.timings, demandMs: performance.now() - t2, demandSolves: this.demandSolves,
      ...(this.ceilingWhatIfs > 0 || this.ceilingGate || this.ceilingJoint
        ? { ceiling: { whatIfs: this.ceilingWhatIfs, gate: this.ceilingGate, joint: this.ceilingJoint } }
        : {}),
    };
    // The selected cut as a level per leaf; the forest's leaf order is by
    // sequence, so when the sequences are dense (0..n-1) the array is
    // indexed by sequence. The frontier map is built only if someone reads it.
    const selected = result.selected;
    let levelsBySequence: ArrayLike<number> | undefined;
    const levels = selected.levels;
    if (levels) {
      const chunks = forest.orderedChunks();
      let dense = chunks.length === levels.length;
      for (let k = 0; dense && k < chunks.length; k++) if (chunks[k].sequence !== k) dense = false;
      if (dense) levelsBySequence = levels;
    }
    return {
      get frontier() { return selected.frontier; },
      levelsBySequence,
      produced,
      exhausted: false,
    };
  }

  /** Score producible higher-level parents with the same bounded solver used
   * for the live cut. Candidates are prefiltered by token reduction, then
   * ranked by the conservative (p80 recall-cost) welfare improvement. */
  private rankLatentDemand(
    inputs: PickerInputs,
    forest: CanonicalSummaryForest,
    solver: ParetoKvUnifiedPolicySolver,
    baseline: Extract<ParetoPolicySolveResult, { feasible: true }>,
    budget: FoldingBudget,
  ): ProduceRequest[] {
    const config = this.options.latentDemand!;
    // Holders of candidates this compile does not score are dropped: their
    // merge exists now, or is no longer producible.
    const live = this.options.reuse;
    const whatIf: WhatIfReuse = { base: forest, live, carried: live?.whatIf, kept: live ? new Map() : undefined };
    if (live) live.whatIf = whatIf.kept;
    const candidates = latentHigherLevelCandidates(inputs, forest, config)
      .slice(0, Math.max(0, Math.floor(config.maxCandidates)));
    const policy = normalizePolicy(this.options.policy);
    const multiplier = normalizeContinuityMultiplier(this.options.continuityMultiplier);
    // Merges worth less than adoptEpsilon are not demanded; that is the
    // hysteresis policy's own tolerance, applied here to best-vs-best.
    const epsilon = Number.isFinite(this.options.adoptEpsilon) && (this.options.adoptEpsilon ?? 0) > 0
      ? this.options.adoptEpsilon!
      : 0;
    const args = [inputs, whatIf, solver, baseline, budget, candidates, epsilon, policy, multiplier] as const;
    return config.mode === 'joint' ? this.rankJointLatentDemand(...args) : this.rankIndividualLatentDemand(...args);
  }

  /** One what-if solve per candidate (two with the expected cost), each
   * gated and ordered on its own gain against the base. */
  private rankIndividualLatentDemand(
    inputs: PickerInputs,
    whatIf: WhatIfReuse,
    solver: ParetoKvUnifiedPolicySolver,
    baseline: Extract<ParetoPolicySolveResult, { feasible: true }>,
    budget: FoldingBudget,
    candidates: readonly LatentCandidate[],
    epsilon: number,
    policy: KvUnifiedWelfarePolicy,
    multiplier: number,
  ): ProduceRequest[] {
    const failure = this.failureUnder(inputs, budget, policy, multiplier);
    // Pass 1: one conservative (p80 recall-cost) what-if solve per candidate.
    const solved = candidates.flatMap((candidate) => {
      const conservative = this.measure(
        inputs, whatIf, candidate, candidate.conservativeRecallTokens, this.options, budget.totalBudget, failure,
      );
      return conservative?.feasible ? [{ candidate, conservative }] : [];
    });
    // Certified entries whose uncertified re-solve scored worse than the
    // certified pool, or was stopped by the label ceiling: they stand at the
    // gain that pool proves.
    const proven = new Set<object>();
    const rank = (base: Extract<ParetoPolicySolveResult, { feasible: true }>, withExpected: boolean): LatentDemandEvaluation[] => {
      // One frame for the whole compile. Each solve measures its penalties
      // from its own pool's floors, so raw scores from two solves are not
      // comparable: a what-if whose forest reaches a lower continuity floor
      // looks worse, not better. Every what-if forest contains the base forest,
      // so the lowest floors any pool reached are the frame for all of them,
      // and both sides are rescored there before subtracting.
      let cacheFloor = base.cacheFloor;
      let continuityFloor = base.continuityFloor;
      for (const { conservative } of solved) {
        cacheFloor = Math.min(cacheFloor, conservative.cacheFloor);
        continuityFloor = Math.min(continuityFloor, conservative.continuityFloor);
      }
      // The frame is fixed for this pass, so each pool is scanned once.
      const scored = new Map<object, number>();
      const best = (result: Extract<ParetoPolicySolveResult, { feasible: true }>): number => {
        let score = scored.get(result);
        if (score !== undefined) return score;
        if (result.bestScoreUnder) {
          score = result.bestScoreUnder(cacheFloor, continuityFloor);
        } else {
          score = Infinity;
          for (const c of result.candidates) {
            score = Math.min(score, policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss,
              cacheFloor, continuityFloor, policy, multiplier));
          }
        }
        scored.set(result, score);
        return score;
      };
      const baseBest = best(base);
      // A certified what-if exposes only the carried layout and its
      // extensions, up to certificate.maxImprovement above the what-if's
      // best cut, so its improvement is understated by that much. Before any
      // expected-cost solve, no such interval may decide the gate or the
      // order of the requests: a certified what-if is solved again without
      // the certificate when its interval spans the gate, or when it passes
      // the gate and another passing candidate's interval overlaps it.
      // The requests are then ordered by proven gains. That is the order of
      // an exact uncertified solve; a pruned one can score below a
      // certified pool and order differently. A re-solve the label ceiling
      // stops leaves the interval undecided, and the certified gain, a floor,
      // then decides the gate and the order (#252).
      const gain = (entry: (typeof solved)[number]) => baseBest - best(entry.conservative);
      const slack = (entry: (typeof solved)[number]) =>
        proven.has(entry) ? 0 : entry.conservative.certificate?.maxImprovement ?? 0;
      const passing = solved.filter((entry) => gain(entry) + slack(entry) > epsilon);
      const undecided = solved.filter((entry) => {
        if (!entry.conservative.certificate || proven.has(entry)) return false;
        const low = gain(entry);
        const high = low + slack(entry);
        if (low <= epsilon) return high > epsilon;
        return passing.some((other) => other !== entry && gain(other) <= high && gain(other) + slack(other) >= low);
      });
      if (undecided.length > 0) {
        for (const entry of undecided) {
          const full = this.measure(
            inputs, whatIf, entry.candidate, entry.candidate.conservativeRecallTokens,
            { ...this.options, hysteresisCertificate: false }, budget.totalBudget, failure,
          );
          // The certified pool is a real layout, so its gain is a floor. The
          // uncertified solve prunes and can come back worse: keep the better.
          // One the label ceiling stopped leaves the floor standing too (#252).
          if (full === null) proven.add(entry);
          else if (!full.feasible) solved.splice(solved.indexOf(entry), 1);
          else if (best(full) <= best(entry.conservative)) entry.conservative = full;
          else proven.add(entry);
        }
        // The frame may have moved with the new pools; rank everything again
        // (each pass settles or removes a certified entry, so this ends).
        return rank(base, withExpected);
      }
      const evaluations: LatentDemandEvaluation[] = [];
      for (const entry of solved) {
        const { candidate, conservative } = entry;
        const conservativeImprovement = baseBest - best(conservative);
        let expectedImprovement = conservativeImprovement;
        // Pass 2: the expected (p50) solve only orders emitted requests among
        // themselves, so candidates the gate rejects never pay for it, and it
        // runs once, against the base the gate is final on. It decides the
        // order only between requests whose conservative gains tie; those
        // are solved without the certificate, whose slack could hide a lead.
        if (withExpected && conservativeImprovement > epsilon &&
            candidate.expectedRecallTokens !== candidate.conservativeRecallTokens) {
          const tied = passing.some((other) => other !== entry && gain(other) === conservativeImprovement);
          const expected = this.measure(
            inputs, whatIf, candidate, candidate.expectedRecallTokens,
            tied ? { ...this.options, hysteresisCertificate: false } : this.options, budget.totalBudget, failure,
          );
          // One the label ceiling stopped leaves the conservative gain to
          // order the request, as when the two costs are the same (#252).
          if (expected !== null) {
            if (!expected.feasible) continue;
            expectedImprovement = baseBest - best(expected);
          }
        }
        evaluations.push({
          request: candidate.request,
          sourceIds: candidate.sourceIds,
          expectedRecallTokens: candidate.expectedRecallTokens,
          conservativeRecallTokens: candidate.conservativeRecallTokens,
          expectedImprovement,
          conservativeImprovement,
          // Approximate only when pruning could have cost score: a bucket that
          // merged nothing, or an exact engine, reports a zero bound.
          approximate: Boolean(
            conservative.propagation &&
            (
              !conservative.propagation.approximationBounded ||
              conservative.propagation.approximationScoreErrorBound > 0
            ),
          ),
        });
      }
      evaluations.sort((a, b) =>
        b.conservativeImprovement - a.conservativeImprovement ||
        b.expectedImprovement - a.expectedImprovement ||
        a.request.level - b.request.level ||
        a.request.range.firstChunkId.localeCompare(b.request.range.firstChunkId),
      );
      return evaluations;
    };
    let base = baseline;
    // A certified base solve exposes only the carried layout and its
    // extensions, which the certificate allows to score up to adoptEpsilon
    // above the best cut. A merge gated against that score could be worth
    // less than epsilon against the true best. Decide such a merge against
    // the unrestricted base solve; it runs only when a merge would otherwise
    // be requested, which is followed by a summarizer call anyway.
    if (baseline.certificate && rank(baseline, false).some((evaluation) => evaluation.conservativeImprovement > epsilon)) {
      const unrestricted = this.unrestrictedBase(solver, budget);
      if (unrestricted === null) return [];
      if (unrestricted.feasible) base = unrestricted;
    }
    const evaluations = rank(base, true);
    this.demandEvaluations = evaluations;
    return evaluations
      .filter((evaluation) => evaluation.conservativeImprovement > epsilon)
      .map((evaluation) => evaluation.request);
  }

  /** `latentDemand.mode: 'joint'`: every candidate enters one what-if forest
   * at its conservative cost, and one solve measures the set. The candidates
   * the pool's best cut in the shared frame uses are demanded when that cut beats the live one by
   * more than epsilon. The gain is scored in the frame both pools share, as
   * the individual ranking does, and the same certificate rules apply: a
   * certified what-if that cannot decide the gate is solved again without
   * the certificate, and a certified base whose gate passes is replaced by
   * the unrestricted base solve before the gate is final. */
  private rankJointLatentDemand(
    inputs: PickerInputs,
    whatIf: WhatIfReuse,
    solver: ParetoKvUnifiedPolicySolver,
    baseline: Extract<ParetoPolicySolveResult, { feasible: true }>,
    budget: FoldingBudget,
    candidates: readonly LatentCandidate[],
    epsilon: number,
    policy: KvUnifiedWelfarePolicy,
    multiplier: number,
  ): ProduceRequest[] {
    this.demandEvaluations = [];
    if (candidates.length === 0) return [];
    const conservative = candidates.map((candidate) => ({ candidate, recallTokens: candidate.conservativeRecallTokens }));
    const key = whatIfKey(conservative);
    const failure = this.failureUnder(inputs, budget, policy, multiplier);
    // The joint holder remembers which of its solves the ceiling stopped:
    // the first one, or the settling one without the certificate.
    const solveJoint = (options: KvUnifiedOptions): ParetoPolicySolveResult => {
      this.demandSolves++;
      try {
        return solveWithLatentCandidates(inputs, whatIf, conservative, options, budget.totalBudget);
      } catch (error) {
        if (error instanceof SparseLabelCeilingError) {
          const holder = whatIf.kept?.get(key);
          if (holder) holder.ceilingFailure = failure(options);
        }
        throw error;
      }
    };
    // A joint forest that exceeded the ceiling last compile, at either of its
    // solves, with the same candidate set and the same inputs that decide the
    // label count, would exceed it again: its holder says so, and is kept so
    // that it still says so next compile. The digest holds whether the
    // compile uses the certificate, so a stamp without it is the first
    // search's where the compile has none, and the settling search's where
    // it has one.
    const remembered = whatIf.carried?.get(key);
    const stopped = remembered?.ceilingFailure;
    if (stopped !== undefined &&
        (stopped === failure(this.options) || stopped === failure({ ...this.options, hysteresisCertificate: false }))) {
      whatIf.kept?.set(key, remembered!);
      this.ceilingJoint = true;
      return this.rankIndividualLatentDemand(inputs, whatIf, solver, baseline, budget, candidates, epsilon, policy, multiplier);
    }
    try {
      return this.rankJointPool(inputs, whatIf, solver, baseline, budget, candidates, epsilon, policy, multiplier, solveJoint);
    } catch (error) {
      // The joint forest holds every candidate at once and can need more
      // labels than the live solve or any single what-if; the demand is
      // optional, so the compile goes on with the candidates one at a time
      // rather than failing on its account.
      if (!(error instanceof SparseLabelCeilingError)) throw error;
      this.ceilingJoint = true;
      return this.rankIndividualLatentDemand(inputs, whatIf, solver, baseline, budget, candidates, epsilon, policy, multiplier);
    }
  }

  /** The stamp a ceiling failure is remembered under in this compile: the
   * digest of its inputs (ceilingFailureSignature), made the first time a
   * failure is read or written, so a compile that meets no remembered or
   * new failure doesn't hash its inputs, and whether the stopped solve used
   * the certificate, since a holder's certified solve and its re-solve
   * without the certificate are different searches. */
  private failureUnder(
    inputs: PickerInputs, budget: FoldingBudget, policy: KvUnifiedWelfarePolicy, multiplier: number,
  ): (options: KvUnifiedOptions) => string {
    return (options) => {
      this.signature ??= ceilingFailureSignature(inputs, this.options, budget.totalBudget, policy, multiplier);
      return `${this.signature}:${options.hysteresisCertificate ? 'certified' : 'uncertified'}`;
    };
  }

  /** One candidate's what-if solve, or null where the label ceiling stopped
   * it, in this compile or under the same inputs (`failure`) an earlier one
   * remembered (#252). The demand is optional, so the compile goes on
   * without that measurement, and each caller says what stands instead: no
   * gain at all, or the one it already has. The failure is remembered for
   * this solve: the candidate at its recall cost, with or without the
   * certificate. */
  private measure(
    inputs: PickerInputs,
    whatIf: WhatIfReuse,
    candidate: LatentCandidate,
    recallTokens: number,
    options: KvUnifiedOptions,
    maxTokens: number,
    failure: (options: KvUnifiedOptions) => string,
  ): ParetoPolicySolveResult | null {
    const key = whatIfKey([{ candidate, recallTokens }]);
    // This compile's holder first: a joint set of one candidate is this
    // same solve, and may have just failed.
    const remembered = whatIf.kept?.get(key) ?? whatIf.carried?.get(key);
    if (remembered?.ceilingFailure !== undefined && remembered.ceilingFailure === failure(options)) {
      whatIf.kept?.set(key, remembered);
      this.ceilingWhatIfs++;
      return null;
    }
    this.demandSolves++;
    try {
      return solveWithLatentCandidate(inputs, whatIf, candidate, recallTokens, options, maxTokens);
    } catch (error) {
      if (!(error instanceof SparseLabelCeilingError)) throw error;
      const holder = whatIf.kept?.get(key);
      if (holder) holder.ceilingFailure = failure(options);
      this.ceilingWhatIfs++;
      return null;
    }
  }

  /** The base solved without the certificate, which a gate that passes
   * against the certified base is decided against; null where the label
   * ceiling stopped it, and then nothing is demanded this compile (#252). */
  private unrestrictedBase(solver: ParetoKvUnifiedPolicySolver, budget: FoldingBudget): ParetoPolicySolveResult | null {
    this.demandSolves++;
    try {
      return solver.solve({ ...this.options, maxTokens: budget.totalBudget, hysteresisCertificate: false });
    } catch (error) {
      if (!(error instanceof SparseLabelCeilingError)) throw error;
      this.ceilingGate = true;
      return null;
    }
  }

  private rankJointPool(
    inputs: PickerInputs,
    whatIf: WhatIfReuse,
    solver: ParetoKvUnifiedPolicySolver,
    baseline: Extract<ParetoPolicySolveResult, { feasible: true }>,
    budget: FoldingBudget,
    candidates: readonly LatentCandidate[],
    epsilon: number,
    policy: KvUnifiedWelfarePolicy,
    multiplier: number,
    solveJoint: (options: KvUnifiedOptions) => ParetoPolicySolveResult,
  ): ProduceRequest[] {
    type Feasible = Extract<ParetoPolicySolveResult, { feasible: true }>;
    const initial = solveJoint(this.options);
    if (!initial.feasible) return [];
    let joint: Feasible = initial;
    const best = (result: Feasible, cacheFloor: number, continuityFloor: number): number => {
      if (result.bestScoreUnder) return result.bestScoreUnder(cacheFloor, continuityFloor);
      let score = Infinity;
      for (const c of result.candidates) {
        score = Math.min(score, policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss,
          cacheFloor, continuityFloor, policy, multiplier));
      }
      return score;
    };
    // One frame for the whole ranking, as the individual ranking has: the
    // lowest floors any pool reached. A certified pool's floors are zero,
    // and a frame that rose when such a pool was replaced would score the
    // remaining pools from higher floors and report a smaller gain than the
    // one the replacement was decided on.
    let cacheFloor = Math.min(baseline.cacheFloor, joint.cacheFloor);
    let continuityFloor = Math.min(baseline.continuityFloor, joint.continuityFloor);
    const widen = (pool: Feasible): void => {
      cacheFloor = Math.min(cacheFloor, pool.cacheFloor);
      continuityFloor = Math.min(continuityFloor, pool.continuityFloor);
    };
    let base = baseline;
    const gainOf = (): number => best(base, cacheFloor, continuityFloor) - best(joint, cacheFloor, continuityFloor);
    let gain = gainOf();
    // A certified what-if understates the gain by up to its maxImprovement.
    // When that interval spans the gate, solve again without the certificate
    // and keep the better pool (the certified pool is a real layout, so its
    // gain is a floor; the uncertified solve prunes and can come back worse).
    const settle = (): void => {
      const slack = joint.certificate?.maxImprovement ?? 0;
      if (joint.certificate && gain <= epsilon && gain + slack > epsilon) {
        const full = solveJoint({ ...this.options, hysteresisCertificate: false });
        if (full.feasible) {
          // The two pools are compared in the shared frame, which the new
          // pool may lower; the frame never rises again.
          widen(full);
          if (best(full, cacheFloor, continuityFloor) <= best(joint, cacheFloor, continuityFloor)) joint = full;
        }
        gain = gainOf();
      }
    };
    settle();
    // A certified base exposes only the carried layout and its extensions,
    // scored up to epsilon above the best cut; a passing gain is decided
    // against the unrestricted base instead. The joint pool is not
    // certified here: a certified pool's best is within its slack (at most
    // epsilon) of the carried layout, which the certified base scores the
    // same, so its gain cannot have passed the gate. Nothing is left to
    // settle after the base moves.
    if (gain > epsilon && baseline.certificate) {
      const unrestricted = this.unrestrictedBase(solver, budget);
      if (unrestricted === null) return [];
      if (unrestricted.feasible) {
        widen(unrestricted);
        base = unrestricted;
        gain = gainOf();
      }
    }
    // The merges demanded are the ones the cut that supplies the gain uses:
    // the pool's best cut in the shared frame, not the hysteresis selection,
    // which may be the carried layout kept within epsilon of it. A candidate
    // is the only summary at its level over its leaves in the what-if
    // forest, so a cut uses it exactly when it renders some leaf of its
    // sources at that level (a pinned or locked leaf under it is a hole the
    // cut renders through the children).
    const leafIds = inputs.chunks.map((chunk) => chunk.id);
    const frontier = (joint.bestUnder
      ? joint.bestUnder(cacheFloor, continuityFloor)
      : joint.candidates.reduce((winner, c) => {
          const value = policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss, cacheFloor, continuityFloor, policy, multiplier);
          if (value > winner.score) return winner;
          if (value < winner.score) return { score: value, candidate: c };
          // A tie breaks as the selection breaks one: tokens, then signature.
          const tokens = c.renderedTokens - winner.candidate.renderedTokens;
          const after = tokens > 0 || (tokens === 0 &&
            frontierSignature(c.frontier, leafIds).localeCompare(frontierSignature(winner.candidate.frontier, leafIds)) >= 0);
          return after ? winner : { score: value, candidate: c };
        }, { score: Infinity, candidate: joint.selected }).candidate
    ).frontier;
    const used = new Set(candidates.filter((candidate) => candidate.sourceIds.some((sourceId) =>
      whatIf.base.summary(sourceId)?.leafIds.some((leafId) => frontier.get(leafId) === candidate.level))));
    const approximate = Boolean(
      joint.propagation &&
      (!joint.propagation.approximationBounded || joint.propagation.approximationScoreErrorBound > 0),
    );
    const evaluations: LatentDemandEvaluation[] = candidates.map((candidate) => ({
      request: candidate.request,
      sourceIds: candidate.sourceIds,
      expectedRecallTokens: candidate.expectedRecallTokens,
      conservativeRecallTokens: candidate.conservativeRecallTokens,
      // The gain belongs to the set the cut uses; a candidate it leaves out
      // contributed nothing at its conservative cost.
      expectedImprovement: used.has(candidate) ? gain : 0,
      conservativeImprovement: used.has(candidate) ? gain : 0,
      approximate,
    }));
    this.demandEvaluations = evaluations;
    if (gain <= epsilon) return [];
    return evaluations
      .filter((evaluation) => evaluation.conservativeImprovement > epsilon)
      .map((evaluation) => evaluation.request);
  }
}

interface LatentCandidate {
  readonly id: string;
  readonly level: number;
  readonly sourceIds: readonly string[];
  readonly request: ProduceRequest;
  readonly expectedRecallTokens: number;
  readonly conservativeRecallTokens: number;
  readonly estimatedReduction: number;
}

function latentHigherLevelCandidates(
  inputs: PickerInputs,
  forest: CanonicalSummaryForest,
  config: NonNullable<KvUnifiedOptions['latentDemand']>,
): LatentCandidate[] {
  const threshold = Math.max(2, Math.floor(config.mergeThreshold));
  const runs: Array<Array<NonNullable<ReturnType<CanonicalSummaryForest['summary']>>>> = [];
  let run: Array<NonNullable<ReturnType<CanonicalSummaryForest['summary']>>> = [];
  const flush = (): void => { if (run.length > 0) runs.push(run); run = []; };
  for (const root of forest.roots) {
    if (root.kind !== 'summary') { flush(); continue; }
    const summary = forest.summary(root.id);
    if (!summary) { flush(); continue; }
    // A root whose stored entry still names a parent is one the forest
    // treeified away from a crossed parent; the merge queue skips a source
    // with a parent, so a merge over it would be demanded and never built.
    const stored = inputs.summaries.get(summary.id);
    if (stored && getSummaryParentId(stored)) { flush(); continue; }
    const previous = run.at(-1);
    if (
      previous &&
      (previous.level !== summary.level || previous.lastSequence + 1 !== summary.firstSequence)
    ) flush();
    run.push(summary);
  }
  flush();

  const candidates: LatentCandidate[] = [];
  for (const contiguous of runs) {
    for (let offset = 0; offset + threshold <= contiguous.length; offset += threshold) {
      const sources = contiguous.slice(offset, offset + threshold);
      const level = sources[0]!.level + 1;
      const sourceEntries = sources.map((source) => inputs.summaries.get(source.id)).filter(
        (entry): entry is SummaryEntry => Boolean(entry),
      );
      if (sourceEntries.length !== sources.length) continue;
      const existingCosts = [...inputs.summaries.values()]
        .filter((summary) => summary.level === level)
        .map((summary) => inputs.recallPairTokens?.get(summary.id) ?? summary.tokens)
        .filter((tokens) => Number.isFinite(tokens) && tokens > 0)
        .sort((a, b) => a - b);
      const expectedRecallTokens = quantile(
        existingCosts, 0.5, Math.max(1, config.fallbackRecallTokens),
      );
      const conservativeRecallTokens = quantile(
        existingCosts, 0.8, Math.max(expectedRecallTokens, config.fallbackRecallTokens),
      );
      const childTokens = sources.reduce((sum, source) => sum + source.recallTokens, 0);
      const sourceIds = sources.map((source) => source.id);
      if (config.blocked?.(sourceIds)) continue;
      const firstLeaf = forest.leaf(sources[0]!.leafIds[0]!);
      const lastLeaf = forest.leaf(sources.at(-1)!.leafIds.at(-1)!);
      if (!firstLeaf || !lastLeaf) continue;
      candidates.push({
        id: `__latent:L${level}:${sourceIds.join('+')}`,
        level,
        sourceIds,
        request: {
          level,
          range: { firstChunkId: firstLeaf.id, lastChunkId: lastLeaf.id },
        },
        expectedRecallTokens,
        conservativeRecallTokens,
        estimatedReduction: childTokens - conservativeRecallTokens,
      });
    }
  }
  return candidates
    .filter((candidate) => candidate.estimatedReduction > 0)
    .sort((a, b) =>
      b.estimatedReduction - a.estimatedReduction ||
      a.level - b.level ||
      a.request.range.firstChunkId.localeCompare(b.request.range.firstChunkId),
    );
}

/** A digest of everything a what-if solve reads besides its candidates (the
 * holder's key) and whether that one search uses the certificate (the
 * stamp's suffix): the leaves (sizes, salience, levels, owning L1s, pins,
 * locks, head and tail membership), the summaries (levels, costs, ranges,
 * parents), the presentation and receipt (every cached unit's identity,
 * size and offset, and the markers), the ceiling, the wall, the grid,
 * adoptEpsilon, whether the compile uses the certificate (which decides
 * whether a joint settling search runs at all), the engine, the forest
 * options, the policy and the multiplier. Any of them can change how many
 * labels the solve creates, so a remembered ceiling failure is valid only
 * while all hold; a changed input is a new question, so numbers are
 * digested whole (both words of the double). One pass over the inputs. */
function ceilingFailureSignature(inputs: PickerInputs, options: KvUnifiedOptions, maxTokens: number, policy: KvUnifiedWelfarePolicy, multiplier: number): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const double = new Float64Array(1);
  const words = new Int32Array(double.buffer);
  const num = (value: number | undefined): void => {
    double[0] = value === undefined ? -1.5 : value;
    const low = words[0]!, high = words[1]!;
    a = Math.imul(a ^ low, 16777619) ^ Math.imul(high, 0x85ebca6b);
    b = Math.imul(b ^ Math.imul(high, 0xc2b2ae35), 0x27d4eb2f) ^ low;
  };
  const str = (value: string | null | undefined): void => {
    const text = value ?? '';
    num(text.length);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x01000193 ^ 0x3b) + 1; }
  };
  num(options.labelCeiling); num(maxTokens);
  num(options.tokenBucketSize); num(options.continuityBucketSize); num(options.fidelityBucketSize);
  num(options.adoptEpsilon); num(options.hysteresisCertificate ? 1 : 0); num(multiplier);
  str(options.engine); str(options.storage); str(options.terminalEvaluation);
  num(options.treeifyNonContiguousSummaries ? 1 : 0); num(options.preserveGapBearingSummaries ? 1 : 0);
  for (const key of Object.keys(policy).sort()) num((policy as unknown as Record<string, number>)[key]);
  num(inputs.headTokens); num(inputs.tailTokens);
  for (let i = 0; i < inputs.chunks.length; i++) {
    const chunk = inputs.chunks[i];
    str(chunk.id); num(chunk.sequence); num(chunk.rawTokens); num(chunk.salience); num(chunk.currentResolution); str(chunk.l1Id);
    num((chunk.pinned ? 1 : 0) | (chunk.lockedByAgent ? 2 : 0) | (inputs.headChunkIds.has(chunk.id) ? 4 : 0) | (inputs.tailChunkIds.has(chunk.id) ? 8 : 0));
    num(chunk.pinLevel); num(chunk.pinMaxLevel);
  }
  for (const summary of inputs.summaries.values()) {
    str(summary.id); num(summary.level); num(summary.tokens); num(inputs.recallPairTokens?.get(summary.id));
    str(getSummaryParentId(summary)); str(summary.sourceRange.first); str(summary.sourceRange.last); num(summary.sourceLevel);
    num(summary.sourceIds.length);
    for (const sourceId of summary.sourceIds) str(sourceId);
  }
  const presentation = options.presentation;
  num(presentation ? 1 : 0);
  if (presentation) {
    num(presentation.currentSeq);
    for (const [id, leaf] of presentation.leaves) { str(id); num(leaf.level); num(leaf.lastChangedSeq); str(leaf.repHash); }
  }
  const cache = options.cache;
  num(cache ? cache.markers.length : -1); str(cache?.immutablePrefixHash); str(options.currentImmutablePrefixHash);
  if (cache) {
    num(cache.layout.units.length); num(cache.layout.totalTokens);
    for (const unit of cache.layout.units) { str(unit.kind); str(unit.key); num(unit.tokens); num(unit.offset); }
    for (const marker of cache.markers) { num(marker.unitIndex); num(marker.offset); }
  }
  return `${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

/** The holder key of a what-if over these candidates at these costs. */
function whatIfKey(candidates: readonly { candidate: LatentCandidate; recallTokens: number }[]): string {
  return candidates.map(({ candidate, recallTokens }) => `${candidate.id}\0${recallTokens}`).join('\n');
}

/** What a what-if solve may reuse: the live forest it extends, the holders
 * last compile's what-ifs left (`carried`) and the ones this compile keeps. */
interface WhatIfReuse {
  readonly base: CanonicalSummaryForest;
  readonly live?: KvUnifiedReuse;
  readonly carried?: ReadonlyMap<string, KvUnifiedReuse>;
  readonly kept?: Map<string, KvUnifiedReuse>;
}

function solveWithLatentCandidate(
  inputs: PickerInputs,
  whatIf: WhatIfReuse,
  candidate: LatentCandidate,
  recallTokens: number,
  options: KvUnifiedOptions,
  maxTokens: number,
): ParetoPolicySolveResult {
  return solveWithLatentCandidates(inputs, whatIf, [{ candidate, recallTokens }], options, maxTokens);
}

/** Solve the base inputs with every given candidate present as a summary
 * at the given recall cost. Candidates are disjoint runs of root summaries
 * (see `latentHigherLevelCandidates`), so each re-parents only its own
 * sources. */
function solveWithLatentCandidates(
  inputs: PickerInputs,
  whatIf: WhatIfReuse,
  candidates: readonly { candidate: LatentCandidate; recallTokens: number }[],
  options: KvUnifiedOptions,
  maxTokens: number,
): ParetoPolicySolveResult {
  const summaries = new Map(inputs.summaries);
  const recallPairTokens = new Map(inputs.recallPairTokens ?? []);
  for (const { candidate, recallTokens } of candidates) {
    const sourceEntries = candidate.sourceIds.map((id) => summaries.get(id)!);
    for (const source of sourceEntries) {
      summaries.set(source.id, { ...source, parentId: candidate.id, mergedInto: undefined });
    }
    summaries.set(candidate.id, {
      id: candidate.id,
      level: candidate.level,
      content: '[latent summary candidate]',
      tokens: recallTokens,
      sourceLevel: candidate.level - 1,
      sourceIds: [...candidate.sourceIds],
      sourceRange: {
        first: sourceEntries[0]!.sourceRange.first,
        last: sourceEntries.at(-1)!.sourceRange.last,
      },
      created: 0,
    });
    recallPairTokens.set(candidate.id, recallTokens);
  }
  const candidateInputs: PickerInputs = { ...inputs, summaries, recallPairTokens };
  // The what-if forest is the base forest plus parents over existing
  // summaries, which is what merges arriving between compiles look like:
  // derive it the same way instead of building every leaf again.
  const forestOptions = {
    treeifyNonContiguousSummaries: options.treeifyNonContiguousSummaries,
    preserveGapBearingSummaries: options.preserveGapBearingSummaries,
  };
  // The same candidates come back on every compile until their merges
  // exist, so the forest and certificate graph are kept like the live ones:
  // derived from last compile's what-if when only leaves were appended
  // since. The first what-if borrows unchanged nodes from the live
  // certificate graph.
  const key = whatIfKey(candidates);
  // The what-if starts from a copy of the live memo: it reads the live
  // subtrees' sets and keeps its own candidates', and its copy goes with
  // the holder when the candidates are gone, instead of leaving every merge
  // ever considered in the live map.
  const kept = whatIf.kept?.get(key);
  const carried = kept ?? whatIf.carried?.get(key);
  const holder: KvUnifiedReuse = carried ??
    { certificate: whatIf.live?.certificate, subtree: whatIf.live?.subtree && new Map(whatIf.live.subtree) };
  if (carried && !kept && whatIf.live?.subtree) {
    // A holder from last compile still points at the entries the live map
    // has since replaced; those would fail validation and be computed again
    // inside the what-if. It starts from the live map as it is now and keeps
    // only its own ids (the candidates').
    const seeded = new Map(whatIf.live.subtree);
    if (holder.subtree) for (const [id, entry] of holder.subtree) if (!seeded.has(id)) seeded.set(id, entry);
    holder.subtree = seeded;
  }
  whatIf.kept?.set(key, holder);
  const forest = (holder.forest ? CanonicalSummaryForest.derive(holder.forest, candidateInputs, forestOptions) : null) ??
    CanonicalSummaryForest.derive(whatIf.base, candidateInputs, forestOptions) ??
    new CanonicalSummaryForest(candidateInputs, forestOptions);
  holder.forest = forest;
  // The certificate stays on for what-ifs: a certified solve answers in
  // ~0.4 s instead of a full solve. Its pool is the carried layout and its
  // extensions, which the certificate allows to score up to
  // certificate.maxImprovement above the what-if's best cut, so the merge's
  // improvement is understated by up to that much. That settles a clear
  // rejection; rankLatentDemand solves again without the certificate where
  // the slack could decide the gate or the order of the requests, and keeps
  // whichever of the two pools scores better.
  return new ParetoKvUnifiedPolicySolver(candidateInputs, forest).solve({
    ...options,
    maxTokens,
    reuse: whatIf.kept ? holder : undefined,
  });
}

/** The cut with the fewest tokens, scored as any cut is: what a compile
 * takes when the live solve exceeds the label ceiling (#252). */
function minimumTokenCut(
  inputs: PickerInputs,
  forest: CanonicalSummaryForest,
  options: ParetoSolveOptions,
): ParetoPolicySolveResult {
  const feasibility = forest.minimumTokens(options.maxTokens);
  if (!feasibility.feasible) return { feasible: false, feasibility };
  const stats = { statesVisited: 0, candidatesGenerated: 1, maxCandidatesAtState: 1, terminalCandidates: 1 };
  return new ExactKvUnifiedPolicySolver(inputs, forest).scoreCandidates(
    [{ frontier: feasibility.frontier, renderedTokens: forest.tokensForFrontier(feasibility.frontier) }],
    options, stats, feasibility,
  );
}

/** The engine whose search the ceiling stopped, as the solve's options
 * choose it (kv-unified-pareto.ts): asked for none, the subtree engine runs
 * and, past the ceiling, the packed one, whose error reaches the strategy. */
function engineOf(options: ParetoSolveOptions): string {
  if (options.engine === 'leaf') return 'leaf';
  if (options.storage === 'objects') return 'objects';
  if (options.engine === 'dag') return 'packed';
  if (options.engine === 'subtree') return 'subtree';
  return 'packed, after subtree';
}

/** The `ceiling=` mark of a compile's `[plan-vs-actual]` line and stats:
 * what the label ceiling stopped (`live`, `joint`, `gate`, `whatIfs:N`),
 * joined by `+`, or undefined where it stopped nothing. */
export function ceilingMark(report: KvUnifiedCeilingReport | undefined): string | undefined {
  if (!report) return undefined;
  const parts = [
    report.live ? 'live' : '',
    report.joint ? 'joint' : '',
    report.gate ? 'gate' : '',
    report.whatIfs > 0 ? `whatIfs:${report.whatIfs}` : '',
  ].filter((part) => part !== '');
  return parts.length > 0 ? parts.join('+') : undefined;
}

function quantile(values: readonly number[], q: number, fallback: number): number {
  if (values.length === 0) return fallback;
  return values[Math.floor((values.length - 1) * q)] ?? fallback;
}

function demandMissingL1(inputs: PickerInputs): ProduceRequest[] {
  const produced: ProduceRequest[] = [];
  let run: { first: ChunkId; last: ChunkId } | null = null;
  const flush = (): void => {
    if (run) {
      produced.push({
        level: 1,
        range: { firstChunkId: run.first, lastChunkId: run.last },
      });
    }
    run = null;
  };
  for (const chunk of [...inputs.chunks].sort((a, b) => a.sequence - b.sequence)) {
    const foldable =
      !chunk.l1Id &&
      !chunk.pinned &&
      !chunk.lockedByAgent &&
      !inputs.headChunkIds.has(chunk.id) &&
      !inputs.tailChunkIds.has(chunk.id);
    if (!foldable) { flush(); continue; }
    if (run) run.last = chunk.id;
    else run = { first: chunk.id, last: chunk.id };
  }
  flush();
  return produced;
}

// Kept as a function to avoid making the validation path depend on mutable
// development defaults.
function validateExplicitOptions(options: KvUnifiedOptions): void {
  const requiredPolicy = [
    'alpha', 'budgetLowRatio', 'budgetHighRatio', 'budgetUnderLambda',
    'budgetOverLambda', 'cacheLambda', 'cacheScale', 'cacheReadPrice',
    'cacheWritePrice', 'continuityLambda', 'continuityScale',
    'continuityRecencyHalfLifeTokens', 'continuityRecencyFloor',
    'continuityStableHalfLife', 'continuityStableFloor',
  ] as const;
  if (!options.policy) throw new Error('kv-unified requires an explicit policy');
  for (const key of requiredPolicy) {
    if (options.policy[key] === undefined) throw new Error(`kv-unified policy is missing ${key}`);
  }
  for (const key of ['tokenBucketSize', 'continuityBucketSize', 'fidelityBucketSize', 'labelCeiling'] as const) {
    const value = options[key];
    if (!Number.isFinite(value) || (value ?? 0) <= 0) {
      throw new Error(`kv-unified requires positive ${key}`);
    }
  }
  if (!Number.isFinite(options.adoptEpsilon) || (options.adoptEpsilon ?? -1) < 0) {
    throw new Error('kv-unified requires non-negative adoptEpsilon');
  }
  if (typeof options.treeifyNonContiguousSummaries !== 'boolean') {
    throw new Error('kv-unified requires an explicit treeifyNonContiguousSummaries boolean');
  }
  if (typeof options.preserveGapBearingSummaries !== 'boolean') {
    throw new Error('kv-unified requires an explicit preserveGapBearingSummaries boolean');
  }
  if (options.treeifyNonContiguousSummaries && options.preserveGapBearingSummaries) {
    throw new Error(
      'kv-unified treeifyNonContiguousSummaries and preserveGapBearingSummaries are mutually exclusive',
    );
  }
}
