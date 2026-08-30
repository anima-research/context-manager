import type {
  FoldingBudget,
  FoldingSolution,
  FoldingSolver,
} from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import {
  ParetoKvUnifiedPolicySolver,
  type ParetoPolicySolveResult,
  type ParetoSolveOptions,
} from '../kv-unified-pareto.js';

export interface KvUnifiedOptions extends Omit<ParetoSolveOptions, 'maxTokens'> {
  /** Production defaults remain unset until Phase-0 replay chooses them. */
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
    const solver = new ParetoKvUnifiedPolicySolver(inputs);
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
