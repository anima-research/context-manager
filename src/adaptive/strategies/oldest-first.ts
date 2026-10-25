/**
 * Oldest-first folding solver.
 *
 * Always raise the chronologically-oldest raisable chunk's group, regardless
 * of level distribution. This is the "memory fades chronologically" policy
 * — the simplest possible monotonic policy and the one originally proposed
 * in rev 1 of the design doc. A chunk with no summary above it is passed
 * over, so it can stay shallower than younger chunks. Like flat-profile, it
 * never lowers a chunk within a solve, a pinned chunk is seeded raw, and a
 * chunk carried at a level where it has no summary starts at the next level
 * down where it has one (greedy-fold.ts).
 *
 * Kept for comparison against FlatProfileStrategy and as a fallback during
 * early rollout.
 *
 * See `docs/adaptive-resolution-design.md` §3.5.
 */

import type { FoldingSolver, FoldingSolution, FoldingBudget } from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { runGreedy, type GreedyState, type GreedyOp, type GreedyStep } from '../greedy-fold.js';
import type { SummaryNode } from '../summary-tree.js';

export class OldestFirstStrategy implements FoldingSolver {
  readonly name = 'oldest-first';

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    return runGreedy(inputs, budget, [passingOver, oldestOnly]);
  }
}

/** The step's rule: pass over a chunk with no summary above it. Where a
 *  solve that passes over ends over the hard budget, the solve that takes
 *  only the oldest chunk, this solver's rule before, is tried (runGreedy). */
const passingOver: GreedyStep = (state, budget) => oldestFirstStep(state, budget, true);
const oldestOnly: GreedyStep = (state, budget) => oldestFirstStep(state, budget, false);

function oldestFirstStep(state: GreedyState, budget: FoldingBudget, passOver: boolean): GreedyOp | null {
  if (state.tokenCount() <= budget.targetBudget) return null;

  const middle = state.foldableMiddle();
  if (middle.length === 0) return null;

  // Raise the oldest chunk that can rise through its next summary up. With
  // `passOver`, a chunk with no summary above it is passed over for the next
  // one, as in flat-profile, so a summary no merge can take as the store
  // stands doesn't stop every raise behind it; without it, only the oldest
  // chunk is tried, the rule a solve falls back on (runGreedy). With none
  // above the chunks tried, ask for one at the next level over the oldest
  // chunk's group.
  const oldest = middle[0];
  let parent: SummaryNode | null = null;
  for (const chunk of middle) {
    parent = state.nextAncestor(chunk);
    if (parent || !passOver) break;
  }
  if (!parent) {
    const targetLevel = oldest.currentResolution + 1;
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
