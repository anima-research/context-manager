import type {
  FoldingBudget,
  FoldingSolution,
  FoldingSolver,
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
          produced: [],
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
