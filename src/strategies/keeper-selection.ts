/**
 * Keeper L1 selection — the coverage sweep shared by
 * `AutobiographicalStrategy.migrateChunkRecords` (which mints chunk records
 * for legacy stores) and `scripts/repair-pyramid.ts` (which prunes duplicate
 * L1 generations from contaminated stores).
 *
 * The two call sites previously hand-copied this algorithm and drifted twice
 * (records-only trust in the repair script → mythos 2026-07-12 coverage
 * collapse; then a live-ids-only stale check that pruned L1s the strategy
 * keeps). There must be exactly ONE definition of "which L1s own the ground";
 * both consumers import it from here.
 *
 * Semantics (bit-for-bit the strategy's historical migrateChunkRecords):
 *   - sort by (first-source message index asc, sourceIds.length desc) so at
 *     each starting point the LONGEST generation claims the ground first;
 *     L1s whose first source is unknown sort last;
 *   - skip fully-orphaned L1s (no sourceId resolves to a live message);
 *   - an L1 is stale only if ALL of its sourceIds — including dead ones —
 *     are already covered. An L1 whose live ids are covered but which carries
 *     uncovered orphaned ids is NOT stale and is kept (dead ids enter
 *     `covered` when a keeper claims them, so identical dead tails do not
 *     block staleness of true prefix duplicates);
 *   - a kept L1 adds ALL of its sourceIds to `covered`.
 */

/** Minimal shape the sweep needs; callers keep their richer entry types. */
export interface KeeperCandidate {
  id: string;
  sourceIds: string[];
}

export interface KeeperSweepResult<T extends KeeperCandidate> {
  /** Kept L1s, in sweep order (start asc, span desc). */
  keepers: T[];
  /** Skipped because every sourceId was already covered. */
  skippedStale: number;
  /** Skipped because no sourceId resolves to a live message. */
  skippedGhost: number;
}

/**
 * Run the coverage sweep over `l1s`.
 *
 * @param l1s      Level-1 summaries with non-empty sourceIds.
 * @param msgIndex Live message id → position map.
 * @param covered  Message ids already owned (e.g. by authoritative chunk
 *                 records). MUTATED in place: kept L1s add their sourceIds.
 */
export function selectKeeperL1s<T extends KeeperCandidate>(
  l1s: readonly T[],
  msgIndex: ReadonlyMap<string, number>,
  covered: Set<string> = new Set<string>(),
): KeeperSweepResult<T> {
  const sorted = [...l1s].sort((a, b) => {
    const sa = msgIndex.get(a.sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
    const sb = msgIndex.get(b.sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || b.sourceIds.length - a.sourceIds.length;
  });

  const keepers: T[] = [];
  let skippedStale = 0;
  let skippedGhost = 0;
  for (const s of sorted) {
    // An L1 none of whose messages exist anymore can't own live ground.
    if (!s.sourceIds.some(id => msgIndex.has(id))) { skippedGhost++; continue; }
    // Fully-covered = stale generation / contained duplicate.
    if (s.sourceIds.every(id => covered.has(id))) { skippedStale++; continue; }
    for (const id of s.sourceIds) covered.add(id);
    keepers.push(s);
  }
  return { keepers, skippedStale, skippedGhost };
}
