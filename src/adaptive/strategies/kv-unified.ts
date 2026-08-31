import type {
  FoldingBudget,
  FoldingSolution,
  FoldingSolver,
  ProduceRequest,
  ChunkId,
} from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { CanonicalSummaryForest } from '../kv-unified.js';
import {
  ParetoKvUnifiedPolicySolver,
  type ParetoPolicySolveResult,
  type ParetoSolveOptions,
} from '../kv-unified-pareto.js';

export interface KvUnifiedOptions extends Omit<ParetoSolveOptions, 'maxTokens'> {
  /** Live adapter refuses missing policy/grid fields when true. */
  requireExplicitPolicy?: boolean;
  quarantineNonContiguousSummaries?: boolean;
}
/**
 * FoldingSolver adapter for kv-unified. It is intentionally not in the live
 * config union yet: callers must supply receipt/policy inputs explicitly.
 */
export class KvUnifiedStrategy implements FoldingSolver {
  readonly name = 'kv-unified';
  private last: ParetoPolicySolveResult | null = null;

  constructor(private readonly options: KvUnifiedOptions = {}) {}

  get lastResult(): ParetoPolicySolveResult | null {
    return this.last;
  }

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    if (this.options.requireExplicitPolicy) validateExplicitOptions(this.options);
    const forest = new CanonicalSummaryForest(inputs, {
      quarantineNonContiguousSummaries: this.options.quarantineNonContiguousSummaries,
    });
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const result = solver.solve({
      ...this.options,
      maxTokens: budget.totalBudget,
    });
    this.last = result;
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
    return {
      frontier: result.selected.frontier,
      produced: [],
      exhausted: false,
    };
  }
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
}
