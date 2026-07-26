/**
 * Oldest-first folding solver.
 *
 * Always raise the chronologically-oldest raisable chunk's group, regardless
 * of level distribution. This is the "memory fades chronologically" policy
 * — the simplest possible monotonic policy and the one originally proposed
 * in rev 1 of the design doc.
 *
 * Kept for comparison against FlatProfileStrategy and as a fallback during
 * early rollout.
 *
 * See `docs/adaptive-resolution-design.md` §3.5.
 */

import type { FoldingSolver, FoldingSolution, FoldingBudget } from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { runGreedy, type GreedyState, type GreedyOp } from '../greedy-fold.js';

export class OldestFirstStrategy implements FoldingSolver {
  readonly name = 'oldest-first';

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    return runGreedy(inputs, budget, oldestFirstStep);
  }
}

function oldestFirstStep(state: GreedyState, budget: FoldingBudget): GreedyOp | null {
  if (state.tokenCount() <= budget.targetBudget) return null;

  const middle = state.foldableMiddle();
  if (middle.length === 0) return null;

  // Find the oldest raisable chunk.
  const oldest = middle[0];
  const targetLevel = oldest.currentResolution + 1;
  const parent = oldest.ancestorAt(targetLevel);
  if (!parent) {
    const lkAncestor = oldest.currentResolution === 0 ? null : oldest.ancestorAt(oldest.currentResolution);
    const range = lkAncestor
      ? {
          firstChunkId: lkAncestor.sourceRange.first,
          lastChunkId: lkAncestor.sourceRange.last,
        }
      : { firstChunkId: oldest.id, lastChunkId: oldest.id };
    return { kind: 'produce', request: { level: targetLevel, range } };
  }

  return { kind: 'raise', groupRoot: parent.id };
}
