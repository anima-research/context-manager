/**
 * Flat-profile folding solver: keep visible-item counts roughly equal across levels.
 *
 * Greedy: while over the soft target, find the level with the most *rendered
 * items* (distinct ancestors among chunks at that resolution), pick the oldest
 * raisable group at that level, raise it. Tiebreak on level: lower level wins
 * (fold finer detail before consolidating coarser regions).
 *
 * Monotonic within a solve (never lowers). Memory-fading by construction: a
 * given chunk's resolution only ever increases within a solve, and the carried
 * resolutions seed the next one, except that a pinned chunk is seeded raw and
 * a chunk carried at a level where it has no summary starts at the next level
 * down where it has one (greedy-fold.ts).
 *
 * See `docs/adaptive-resolution-design.md` §3.7.
 */

import type {
  FoldingSolver,
  FoldingSolution,
  FoldingBudget,
  ChunkId,
  SummaryId,
} from '../folding-strategy.js';
import type { PickerInputs } from '../picker.js';
import { runGreedy, type GreedyState, type GreedyOp } from '../greedy-fold.js';

export class FlatProfileStrategy implements FoldingSolver {
  readonly name = 'flat-profile';

  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution {
    return runGreedy(inputs, budget, flatProfileStep);
  }
}

function flatProfileStep(state: GreedyState, budget: FoldingBudget): GreedyOp | null {
  if (state.tokenCount() <= budget.targetBudget) return null;

  const middle = state.foldableMiddle();
  if (middle.length === 0) return null;

  // Count rendered items at each level.
  // A "rendered item" at level k > 0 is a distinct L_k ancestor.
  // At level 0, each raw chunk is its own item.
  const visibleAtLevel = new Map<number, Set<SummaryId | ChunkId>>();
  for (const chunk of middle) {
    const k = chunk.currentResolution;
    if (!visibleAtLevel.has(k)) visibleAtLevel.set(k, new Set());
    if (k === 0) {
      visibleAtLevel.get(k)!.add(chunk.id);
    } else {
      const ancestor = chunk.ancestorAt(k);
      if (ancestor) visibleAtLevel.get(k)!.add(ancestor.id);
    }
  }

  // Rank levels most-populous first; tiebreak: lower wins.
  const rankedLevels = [...visibleAtLevel.entries()]
    .sort(([la, a], [lb, b]) => (b.size - a.size) || (la - lb))
    .map(([level]) => level);

  // Prefer a RAISE at the best-ranked level that has one; fall back to the
  // best-ranked PRODUCE only when no level offers a raise.
  //
  // A produce stops the solve ("record and stop; caller enqueues, next
  // compile retries" — single-path solve), so returning one while raisable
  // groups exist elsewhere refuses a compile that could have fit by raising.
  // Worse, a produce aimed at chunkless frontier messages (a chunk only
  // closes at targetChunkTokens AND >= 4 messages, so the newest span may be
  // permanently unchunked) can NEVER be satisfied: every compile re-demands
  // it and refuses — a livelock (found via deep-levels #4, 2026-07-26).
  // Produce is for building genuinely missing summaries when nothing else
  // can shrink the plan, not the first resort.
  let fallbackProduce: GreedyOp | null = null;
  for (const bestLevel of rankedLevels) {
    // Raise the group of the oldest chunk at this level: the chunks sharing
    // its next summary up, its L_{k+1} ancestor, or, past a level where it
    // has none (one its lineage skips, or one whose summary doesn't list it),
    // the next one up where it has one. The group is raised all the way to
    // that summary. Younger chunks at the level aren't tried.
    const oldestChunk = middle.find((c) => c.currentResolution === bestLevel);
    if (!oldestChunk) continue;

    const parentLevel = bestLevel + 1;
    const parentSummary = state.nextAncestor(oldestChunk);
    if (!parentSummary) {
      // No summary above lists this chunk: request L_{k+1} for its group, but
      // only if no other level can raise. The strategy makes it only on the
      // terms GreedyState.nextAncestor names, so for a chunk whose summary
      // links upward to one that doesn't list it, the request comes back on
      // the next compile.
      //
      // Range semantics differ by level:
      //  - bestLevel === 0: the caller is asking for an L1 covering this
      //    raw chunk. In the autobio chunker model the chunk-to-L1 mapping
      //    is 1:1 — a chunk's message span IS the L1's source range — so
      //    a single-chunk range is the correct request. (Solvers that
      //    bundle N raw chunks into one L1 would override this.)
      //  - bestLevel > 0: the caller is asking for an L_{k+1} merge. We
      //    use the chunk's existing L_k ancestor's range as a request
      //    hint; the consumer expands it to cover the full sibling set
      //    at L_k that should consolidate into the missing L_{k+1}.
      if (!fallbackProduce) {
        const lkAncestor = bestLevel === 0 ? null : oldestChunk.ancestorAt(bestLevel);
        const range = lkAncestor
          ? {
              firstChunkId: lkAncestor.sourceRange.first,
              lastChunkId: lkAncestor.sourceRange.last,
            }
          : { firstChunkId: oldestChunk.id, lastChunkId: oldestChunk.id };
        fallbackProduce = { kind: 'produce', request: { level: parentLevel, range } };
      }
      continue;
    }

    return { kind: 'raise', groupRoot: parentSummary.id };
  }

  return fallbackProduce;
}
