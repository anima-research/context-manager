/**
 * Oldest-first folding strategy.
 *
 * Always raise the chronologically-oldest raisable chunk's group, regardless
 * of level distribution. This is the "memory fades chronologically" policy
 * — the simplest possible monotonic strategy and the one originally proposed
 * in rev 1 of the design doc.
 *
 * Kept for comparison against FlatProfileStrategy and as a fallback during
 * early rollout.
 *
 * See `docs/adaptive-resolution-design.md` §3.5.
 */

import type {
  FoldingStrategy,
  FoldingState,
  FoldingBudget,
  FoldOp,
} from '../folding-strategy.js';

export class OldestFirstStrategy implements FoldingStrategy {
  readonly name = 'oldest-first';

  selectNextFold(state: FoldingState, budget: FoldingBudget): FoldOp | null {
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
      return { kind: 'produce', level: targetLevel, range };
    }

    return { kind: 'raise', groupRoot: parent.id };
  }
}
