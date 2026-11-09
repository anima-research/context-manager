import type { LoadRepairDropReason } from '../types/strategy.js';

export interface StoredSummary {
  id: string;
  level: number;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  content?: unknown;
  parentId?: string | null;
  mergedInto?: string | null;
}

export interface SettleChunkRecord {
  compressed?: boolean;
  summaryId?: string;
  sourceIds?: unknown;
}

export interface SettledSummaries<S extends StoredSummary> {
  summaries: S[];
  storedIds: string[];
  malformed: number;
  dupes: number;
  emptyIds: string[];
  unreadableIds: string[];
  ancestorIds: string[];
  misplacedIds: string[];
  notParentIds: string[];
  rebuiltIds: string[];
  reparentedIds: string[];
  clearedIds: string[];
  textDrops: Map<string, { summary: S; reason: LoadRepairDropReason }>;
}

/**
 * Sources as readers iterate them: a non-empty list of ids. Every index is
 * read, since `every` skips an empty slot of a sparse array, which the store
 * can't write.
 */
export function isIdList(ids: unknown): ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  for (let i = 0; i < ids.length; i++) {
    const id: unknown = ids[i];
    if (typeof id !== 'string' || id.length === 0) return false;
  }
  return true;
}

/** A range as readers dereference it: its first and last message ids. */
export function isReadableRange(range: unknown): range is { first: string; last: string } {
  const ends = range as { first?: unknown; last?: unknown } | null | undefined;
  const first = ends?.first;
  const last = ends?.last;
  return typeof first === 'string' && first.length > 0 && typeof last === 'string' && last.length > 0;
}

/** Text a recall or a merge can carry. */
export function hasSummaryText(summary: { content?: unknown }): boolean {
  return typeof summary.content === 'string' && summary.content.trim().length > 0;
}

export function settleStoredSummaries<S extends StoredSummary>(
  loaded: readonly unknown[],
  chunkRecords: readonly SettleChunkRecord[],
): SettledSummaries<S> {
  const copiesById = new Map<string, S[]>();
  let malformed = 0;
  for (const summary of loaded) {
    if (!summary || typeof summary !== 'object') { malformed++; continue; }
    const copy = summary as S;
    const copies = copiesById.get(copy.id);
    if (copies) copies.push(copy);
    else copiesById.set(copy.id, [copy]);
  }
  const dupes = loaded.length - malformed - copiesById.size;

  const chunkSources = new Map<string, string[]>();
  for (const record of chunkRecords) {
    if (record.compressed && record.summaryId && isIdList(record.sourceIds) &&
        !chunkSources.has(record.summaryId)) {
      chunkSources.set(record.summaryId, record.sourceIds);
    }
  }
  const byId = new Map<string, S>();
  const emptyIds: string[] = [];
  const unreadableIds: string[] = [];
  const rebuiltIds: string[] = [];
  const textDrops = new Map<string, { summary: S; reason: LoadRepairDropReason }>();
  const namesParent = (copy: S, pointer: unknown): boolean =>
    typeof pointer === 'string' && (copiesById.get(pointer) ?? []).some(
      (parent) => parent.level > copy.level && Array.isArray(parent.sourceIds) && parent.sourceIds.includes(copy.id),
    );
  for (const [id, copies] of copiesById) {
    const withText = copies.filter(hasSummaryText);
    let summary = withText.find((copy) => namesParent(copy, copy.parentId) || namesParent(copy, copy.mergedInto)) ?? withText[0];
    if (!summary) { emptyIds.push(id); continue; }
    if (summary.level === 1) {
      // An L1's own sources, else its compressed chunk record's, else a
      // copy's. Its range is their ends, which every L1 writer sets.
      const ids = [summary.sourceIds, chunkSources.get(id), ...copies.map((copy) => copy.sourceIds)].find(isIdList);
      if (!ids) { unreadableIds.push(id); textDrops.set(id, { summary, reason: 'unreadable' }); continue; }
      const range = summary.sourceRange as { first?: unknown; last?: unknown } | undefined;
      if (ids !== summary.sourceIds || range?.first !== ids[0] || range?.last !== ids[ids.length - 1]) {
        summary = { ...summary, sourceIds: [...ids], sourceRange: { first: ids[0]!, last: ids[ids.length - 1]! } };
        rebuiltIds.push(id);
      }
    } else if (!(isIdList(summary.sourceIds) && isReadableRange(summary.sourceRange))) {
      // Above L1 a range's ends are message ids that the sources don't
      // name, so sources and range come together from one copy.
      const donor = copies.find((copy) => isIdList(copy.sourceIds) && isReadableRange(copy.sourceRange));
      if (!donor) { unreadableIds.push(id); textDrops.set(id, { summary, reason: 'unreadable' }); continue; }
      summary = { ...summary, sourceIds: [...donor.sourceIds], sourceRange: { ...donor.sourceRange } };
      rebuiltIds.push(id);
    }
    byId.set(id, summary);
  }

  // A summary above L1 is kept only while every summary it names is kept
  // and sits below it, whatever removed one and whenever: earlier versions
  // dropped empty summaries without their parents, and a parent naming a
  // missing summary covers messages that are rendered, or compressed again,
  // without it. A merge reads summaries below the one it writes, so a
  // summary that lists one at its own level or above wasn't written from
  // it, and two such summaries can list each other, each covering the
  // other's messages. Repeat to a fixed point. Dropping costs the
  // ancestors' text; their surviving sources merge again.
  // A drop's reason comes from its sources' levels as loaded, so it doesn't
  // depend on which summary the pass reaches first.
  const ancestorIds: string[] = [];
  const misplacedIds: string[] = [];
  const loadedLevel = new Map([...copiesById].map(([id, copies]) => [id, (byId.get(id) ?? copies[0]!).level]));
  const notBelow = (summary: S) =>
    summary.sourceIds.some((sourceId) => (loadedLevel.get(sourceId) ?? 0) >= summary.level);
  const dropMissingAndMisplaced = (): void => {
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, summary] of byId) {
        if (!(summary.level > 1) || (!notBelow(summary) && summary.sourceIds.every((sourceId) => byId.has(sourceId)))) continue;
        byId.delete(id);
        const misplaced = notBelow(summary);
        (misplaced ? misplacedIds : ancestorIds).push(id);
        textDrops.set(id, { summary, reason: misplaced ? 'names-not-below' : 'names-missing' });
        changed = true;
      }
    }
  };
  dropMissingAndMisplaced();

  // A summary has one parent: the first of its own pointers, then its other
  // copies' (`parentId` before the older `mergedInto` in each, as readers
  // take them), that names a kept summary above it listing it among its
  // sources. A parent sits above its summary, so no two summaries can be
  // each other's parent. Without such a pointer, the parent is the kept
  // summary one level up that lists the summary, when exactly one does: a
  // pointer can name a summary further up, such as a grandparent, or
  // nothing, while the parent that covers the summary lists it, and
  // clearing the pointer would render the summary beside that parent.
  // `mergedInto`, which this strategy writes and its frontier reads, is set
  // to the parent, and so is a `parentId` naming anything else, so every
  // reader sees the one parent that renders the summary. With no parent,
  // every pointer that isn't null is cleared, so the summary renders and
  // merges again. A null pointer counts as none.
  //
  // A summary that lists one it isn't the parent of is dropped, and the
  // summaries naming it go with it, as for any dropped summary. A summary
  // above L1 covers the messages of each summary it lists, so a summary two
  // kept summaries list has its messages covered twice, and hierarchical
  // mode, which shows summaries that have no parent, renders both. Two
  // instances on one store each write a merge of the same run where neither
  // sees the other's pointers when it checks, as before merges read the
  // store's summaries, or where a merge stopped between its summary and its
  // pointers: the run's pointers name the merge written last, and the other
  // is dropped. Where a crash split the pointers between the two, each
  // lists a source whose parent is the other, so both are dropped. A
  // summary that two list and whose pointers name neither has no parent, so
  // both are dropped and it merges again. Each summary's parent is chosen
  // before any of these drops, so what is dropped doesn't depend on which
  // summary the pass reaches first. The cost: when the pass drops a
  // summary's chosen parent for listing another summary, the summary's
  // other listers go too, though one of them could have been its parent,
  // and the summary merges again.
  const reparentedIds: string[] = [];
  const clearedIds: string[] = [];
  const notParentIds: string[] = [];
  const covers = (pointer: unknown, summary: S): pointer is string => {
    const parent = typeof pointer === 'string' ? byId.get(pointer) : undefined;
    return !!parent && parent.level > summary.level && parent.sourceIds.includes(summary.id);
  };
  const listedBy = new Map<string, S[]>();
  for (const summary of byId.values()) {
    if (summary.level === 1) continue;
    for (const sourceId of new Set(summary.sourceIds)) {
      const listers = listedBy.get(sourceId);
      if (listers) listers.push(summary);
      else listedBy.set(sourceId, [summary]);
    }
  }
  const parentOf = new Map<string, string | undefined>();
  for (const summary of byId.values()) {
    const pointers = [summary, ...copiesById.get(summary.id)!]
      .flatMap((copy) => [copy.parentId, copy.mergedInto] as unknown[]);
    const listers = (listedBy.get(summary.id) ?? []).filter((lister) => lister.level === summary.level + 1);
    parentOf.set(summary.id, pointers.find((pointer): pointer is string => covers(pointer, summary)) ??
      (listers.length === 1 ? listers[0]!.id : undefined));
  }
  for (const [id, summary] of byId) {
    if (summary.level > 1 && summary.sourceIds.some((sourceId) => parentOf.get(sourceId) !== id)) {
      byId.delete(id);
      notParentIds.push(id);
      textDrops.set(id, { summary, reason: 'names-non-child' });
    }
  }
  dropMissingAndMisplaced();
  const summaries = [...byId.values()].map((summary) => {
    // A parent chosen above is the one kept summary that still lists this
    // one; where the drops took it, nothing kept lists this one.
    const chosen = parentOf.get(summary.id);
    const parent = chosen !== undefined && byId.has(chosen) ? chosen : undefined;
    let repaired = summary;
    const edit = () => (repaired === summary ? (repaired = { ...summary }) : repaired);
    if (parent === undefined) {
      for (const field of ['parentId', 'mergedInto'] as const) {
        const own = summary[field] as unknown;
        if (own === undefined || own === null) continue;
        delete edit()[field];
      }
      if (repaired !== summary) clearedIds.push(summary.id);
      return repaired;
    }
    if (summary.mergedInto !== parent) edit().mergedInto = parent;
    const ownParentId = summary.parentId as unknown;
    if (ownParentId !== undefined && ownParentId !== null && ownParentId !== parent) edit().parentId = parent;
    if (repaired !== summary) reparentedIds.push(summary.id);
    return repaired;
  });
  return {
    summaries,
    storedIds: [...copiesById.keys()],
    malformed,
    dupes,
    emptyIds,
    unreadableIds,
    ancestorIds,
    misplacedIds,
    notParentIds,
    rebuiltIds: rebuiltIds.filter((id) => byId.has(id)),
    reparentedIds,
    clearedIds,
    textDrops,
  };
}

export interface KeptChunkRecord {
  id: string;
  sourceIds: string[];
  compressed?: boolean;
  summaryId?: string;
}

export function loadedChunkRecords<R extends KeptChunkRecord>(stored: unknown): R[] {
  return (Array.isArray(stored) ? (stored as R[]) : [])
    .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.sourceIds) && r.sourceIds.length > 0);
}

export function releaseUnsummarizedRecords<R extends KeptChunkRecord>(
  records: readonly R[],
  summaries: readonly StoredSummary[],
): { records: R[]; released: number } {
  const validL1Ids = new Set(summaries.filter((s) => s.level === 1).map((s) => s.id));
  let released = 0;
  const out = records.map((record) => {
    if (!record.compressed || (record.summaryId && validL1Ids.has(record.summaryId))) return record;
    released++;
    const { summaryId: _dropped, ...rest } = record;
    return { ...rest, compressed: false } as R;
  });
  return { records: out, released };
}

export function summaryIdCounterPast(ids: readonly string[]): number {
  return ids.reduce((past, id) => {
    const n = Number(/^L\d+-(\d+)$/.exec(id)?.[1]);
    return Number.isFinite(n) && n >= past ? n + 1 : past;
  }, 0);
}

export function settlingRepaired(settled: SettledSummaries<StoredSummary>): boolean {
  return settled.malformed > 0 || settled.dupes > 0 || settled.storedIds.length > settled.summaries.length ||
    settled.rebuiltIds.length > 0 || settled.reparentedIds.length > 0 || settled.clearedIds.length > 0;
}

export function settleRepairLine(settled: SettledSummaries<StoredSummary>): string {
  return `repaired summary state: removed ${settled.malformed} malformed entr(ies) and deduped ${settled.dupes}; ` +
    `dropped empty [${settled.emptyIds.join(', ')}], with unreadable sources or range [${settled.unreadableIds.join(', ')}], ` +
    `naming a missing summary [${settled.ancestorIds.join(', ')}], naming one not below it [${settled.misplacedIds.join(', ')}], ` +
    `naming one it isn't the parent of [${settled.notParentIds.join(', ')}]; ` +
    `rebuilt sources or range of ` +
    `[${settled.rebuiltIds.join(', ')}]; set the parent of [${settled.reparentedIds.join(', ')}]; cleared ` +
    `the parent pointers of [${settled.clearedIds.join(', ')}], which named no kept parent`;
}

export function releasedRecordsLine(released: number): string {
  return `repaired ${released} chunk record(s) with missing L1 summaries`;
}
