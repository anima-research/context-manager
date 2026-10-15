import type {
  FoldingBudget,
  FoldingSolution,
  FoldingSolver,
  ProduceRequest,
  ChunkId,
} from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { CanonicalSummaryForest } from '../kv-unified.js';
import type { SummaryEntry } from '../../types/strategy.js';
import {
  ParetoKvUnifiedPolicySolver,
  type ParetoPolicySolveResult,
  type ParetoSolveOptions,
} from '../kv-unified-pareto.js';
import { normalizeContinuityMultiplier, normalizePolicy, policyScore } from '../kv-unified-policy.js';

import type { KvUnifiedReuse } from '../kv-unified-reuse.js';
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
  };
}

export interface KvUnifiedTimings {
  readonly forestMs: number;
  readonly forestDerived: boolean;
  readonly certificateMs: number;
  readonly baseSolveMs: number;
  readonly demandMs: number;
  readonly demandSolves: number;
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
    const result = solver.solve({
      ...this.options,
      maxTokens: budget.totalBudget,
    });
    const t2 = performance.now();
    this.last = result;
    this.demandEvaluations = [];
    this.requests = [];
    this.demandSolves = 0;
    this.timings = { forestMs: t1 - t0, forestDerived: forest.derived, certificateMs: solver.lastCertificateMs, baseSolveMs: t2 - t1, demandMs: 0, demandSolves: 0 };
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
    const produced = this.options.latentDemand
      ? this.rankLatentDemand(inputs, forest, solver, result, budget)
      : [];
    this.requests = produced;
    this.timings = { ...this.timings, demandMs: performance.now() - t2, demandSolves: this.demandSolves };
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
    // Pass 1: one conservative (p80 recall-cost) what-if solve per candidate.
    const solved = candidates.flatMap((candidate) => {
      const conservative = solveWithLatentCandidate(
        inputs, whatIf, candidate, candidate.conservativeRecallTokens, this.options, budget.totalBudget,
      );
      this.demandSolves++;
      return conservative.feasible ? [{ candidate, conservative }] : [];
    });
    const policy = normalizePolicy(this.options.policy);
    const multiplier = normalizeContinuityMultiplier(this.options.continuityMultiplier);
    // Certified entries whose uncertified re-solve scored worse than the
    // certified pool: they stand at the gain that pool proves.
    const proven = new Set<object>();
    // Merges worth less than adoptEpsilon are not demanded; that is the
    // hysteresis policy's own tolerance, applied here to best-vs-best.
    const epsilon = Number.isFinite(this.options.adoptEpsilon) && (this.options.adoptEpsilon ?? 0) > 0
      ? this.options.adoptEpsilon!
      : 0;
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
      // certified pool and order differently.
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
          const full = solveWithLatentCandidate(
            inputs, whatIf, entry.candidate, entry.candidate.conservativeRecallTokens,
            { ...this.options, hysteresisCertificate: false }, budget.totalBudget,
          );
          this.demandSolves++;
          // The certified pool is a real layout, so its gain is a floor. The
          // uncertified solve prunes and can come back worse: keep the better.
          if (!full.feasible) solved.splice(solved.indexOf(entry), 1);
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
          const expected = solveWithLatentCandidate(
            inputs, whatIf, candidate, candidate.expectedRecallTokens,
            tied ? { ...this.options, hysteresisCertificate: false } : this.options, budget.totalBudget,
          );
          this.demandSolves++;
          if (!expected.feasible) continue;
          expectedImprovement = baseBest - best(expected);
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
      const unrestricted = solver.solve({ ...this.options, maxTokens: budget.totalBudget, hysteresisCertificate: false });
      this.demandSolves++;
      if (unrestricted.feasible) base = unrestricted;
    }
    const evaluations = rank(base, true);
    this.demandEvaluations = evaluations;
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
  const summaries = new Map(inputs.summaries);
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
  const recallPairTokens = new Map(inputs.recallPairTokens ?? []);
  recallPairTokens.set(candidate.id, recallTokens);
  const candidateInputs: PickerInputs = { ...inputs, summaries, recallPairTokens };
  // The what-if forest is the base forest plus one parent over existing
  // summaries, which is what a merge arriving between compiles looks like:
  // derive it the same way instead of building every leaf again.
  const forestOptions = {
    treeifyNonContiguousSummaries: options.treeifyNonContiguousSummaries,
    preserveGapBearingSummaries: options.preserveGapBearingSummaries,
  };
  // The same candidate comes back on every compile until its merge exists,
  // so its forest and certificate graph are kept like the live ones: derived
  // from last compile's what-if when only leaves were appended since. The
  // first what-if borrows unchanged nodes from the live certificate graph.
  const key = `${candidate.id}\0${recallTokens}`;
  const holder: KvUnifiedReuse = whatIf.kept?.get(key) ?? whatIf.carried?.get(key) ??
    { certificate: whatIf.live?.certificate };
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
