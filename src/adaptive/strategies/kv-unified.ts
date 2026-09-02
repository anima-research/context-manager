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

export interface KvUnifiedOptions extends Omit<ParetoSolveOptions, 'maxTokens'> {
  /** Live adapter refuses missing policy/grid fields when true. */
  requireExplicitPolicy?: boolean;
  treeifyNonContiguousSummaries?: boolean;
  latentDemand?: {
    mergeThreshold: number;
    fallbackRecallTokens: number;
    maxCandidates: number;
  };
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

  constructor(private readonly options: KvUnifiedOptions = {}) {}

  get lastResult(): ParetoPolicySolveResult | null {
    return this.last;
  }

  get lastDemandEvaluations(): readonly LatentDemandEvaluation[] {
    return this.demandEvaluations;
  }

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    if (this.options.requireExplicitPolicy) validateExplicitOptions(this.options);
    const forest = new CanonicalSummaryForest(inputs, {
      treeifyNonContiguousSummaries: this.options.treeifyNonContiguousSummaries,
    });
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const result = solver.solve({
      ...this.options,
      maxTokens: budget.totalBudget,
    });
    this.last = result;
    this.demandEvaluations = [];
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
      ? this.rankLatentDemand(inputs, forest, result, budget)
      : [];
    return {
      frontier: result.selected.frontier,
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
    baseline: Extract<ParetoPolicySolveResult, { feasible: true }>,
    budget: FoldingBudget,
  ): ProduceRequest[] {
    const config = this.options.latentDemand!;
    const candidates = latentHigherLevelCandidates(inputs, forest, config)
      .slice(0, Math.max(0, Math.floor(config.maxCandidates)));
    const evaluations: LatentDemandEvaluation[] = [];
    for (const candidate of candidates) {
      const expected = solveWithLatentCandidate(
        inputs, candidate, candidate.expectedRecallTokens, this.options, budget.totalBudget,
      );
      const conservative = candidate.conservativeRecallTokens === candidate.expectedRecallTokens
        ? expected
        : solveWithLatentCandidate(
            inputs, candidate, candidate.conservativeRecallTokens, this.options, budget.totalBudget,
          );
      if (!expected.feasible || !conservative.feasible) continue;
      evaluations.push({
        request: candidate.request,
        sourceIds: candidate.sourceIds,
        expectedRecallTokens: candidate.expectedRecallTokens,
        conservativeRecallTokens: candidate.conservativeRecallTokens,
        expectedImprovement: baseline.selected.score - expected.selected.score,
        conservativeImprovement: baseline.selected.score - conservative.selected.score,
        approximate: Boolean(
          conservative.propagation &&
          (
            conservative.propagation.tokenBucketSize > 0 ||
            conservative.propagation.continuityBucketSize > 0 ||
            conservative.propagation.fidelityBucketSize > 0
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
    this.demandEvaluations = evaluations;
    return evaluations
      .filter((evaluation) => evaluation.conservativeImprovement > 0)
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

function solveWithLatentCandidate(
  inputs: PickerInputs,
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
  const forest = new CanonicalSummaryForest(candidateInputs, {
    treeifyNonContiguousSummaries: options.treeifyNonContiguousSummaries,
  });
  return new ParetoKvUnifiedPolicySolver(candidateInputs, forest).solve({
    ...options,
    maxTokens,
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
}
