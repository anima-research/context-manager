/**
 * Default folding strategy: keep visible-item counts roughly equal across levels.
 *
 * On each call: if we're over the soft target, find the level with the most
 * *rendered items* (distinct ancestors among chunks at that resolution),
 * pick the oldest raisable group at that level, raise it. Tiebreak on level:
 * lower level wins (fold finer detail before consolidating coarser regions).
 *
 * Monotonic (never emits 'lower'). Memory-fading by construction:
 * a given chunk's resolution only ever increases.
 *
 * See `docs/adaptive-resolution-design.md` §3.7.
 */

import type {
  FoldingStrategy,
  FoldingState,
  FoldingBudget,
  FoldOp,
  ChunkId,
  ChunkView,
  SummaryId,
} from '../folding-strategy.js';

export class FlatProfileStrategy implements FoldingStrategy {
  readonly name = 'flat-profile';

  selectNextFold(state: FoldingState, budget: FoldingBudget): FoldOp | null {
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
    // A produce op stops the pick ("record and stop; caller enqueues, next
    // compile retries" — single-path solve), so returning one while raisable
    // groups exist elsewhere refuses a compile that could have fit by raising.
    // Worse, a produce aimed at chunkless frontier messages (a chunk only
    // closes at targetChunkTokens AND >= 4 messages, so the newest span may be
    // permanently unchunked) can NEVER be satisfied: every compile re-demands
    // it and refuses — a livelock (found via deep-levels #4, 2026-07-26).
    // Produce is for building genuinely missing summaries when nothing else
    // can shrink the plan, not the first resort.
    let fallbackProduce: FoldOp | null = null;
    for (const bestLevel of rankedLevels) {
      // Find the oldest raisable group at this level. A "group" at level k is
      // the set of chunks sharing an L_{k+1} ancestor. We want to raise that
      // group all the way to L_{k+1}.
      //
      // The oldest group is the one containing the oldest chunk at level k.
      const oldestChunk = middle.find((c) => c.currentResolution === bestLevel);
      if (!oldestChunk) continue;

      const parentLevel = bestLevel + 1;
      const parentSummary = oldestChunk.ancestorAt(parentLevel);
      if (!parentSummary) {
        // L_{k+1} not produced for this chunk's group yet — request it, but
        // only if no other level can raise.
        //
        // Range semantics differ by level:
        //  - bestLevel === 0: the caller is asking for an L1 covering this
        //    raw chunk. In the autobio chunker model the chunk-to-L1 mapping
        //    is 1:1 — a chunk's message span IS the L1's source range — so
        //    a single-chunk range is the correct request. (Strategies that
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
          fallbackProduce = { kind: 'produce', level: parentLevel, range };
        }
        continue;
      }

      return { kind: 'raise', groupRoot: parentSummary.id };
    }

    return fallbackProduce;
  }
}
