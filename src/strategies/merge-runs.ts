
export interface RunSummary {
  id: string;
  level?: number;
  sourceRange?: { first: string; last: string } | null;
}

export interface PendingFill {
  first: number;
  last: number;
  level: number;
}

export interface Placed<S> {
  s: S;
  first: number;
  last: number;
}

export interface MergeRun<S> {
  members: Placed<S>[];
  first: number;
  last: number;
  newest: boolean;
  waiting: boolean;
}

export interface LevelRuns<S> {
  runs: MergeRun<S>[];
  excluded: Array<{ id: string; detail: string }>;
}

export interface StoreRunsInput<S extends RunSummary> {
  summaries: readonly S[];
  parentOf(s: S): string | null | undefined;
  queued: ReadonlySet<string>;
  position: ReadonlyMap<string, number>;
  held: ReadonlySet<string>;
  pending: readonly PendingFill[];
  spanBase: number;
  mergeK: number;
  planning?: boolean;
}

export function placeOf(s: RunSummary, position: ReadonlyMap<string, number>): [number, number] | undefined {
  const range = s.sourceRange;
  if (!range) return undefined;
  const a = position.get(range.first);
  const b = position.get(range.last);
  if (a === undefined || b === undefined) return undefined;
  return a <= b ? [a, b] : [b, a];
}

export function cantGrowPast<S extends RunSummary>(input: StoreRunsInput<S>, level: number, end: number): boolean {
  for (const s of input.summaries) {
    if ((s.level ?? 1) <= level) continue;
    const at = placeOf(s, input.position);
    if (at && at[0] > end) return true;
  }
  return false;
}

export function mergeRunsByLevel<S extends RunSummary>(input: StoreRunsInput<S>, upTo: number): Map<number, LevelRuns<S>> {
  const byLevel = new Map<number, S[]>();
  for (const s of input.summaries) {
    const level = s.level;
    if (typeof level !== 'number' || level > upTo || input.parentOf(s) != null || input.queued.has(s.id)) continue;
    let list = byLevel.get(level);
    if (!list) byLevel.set(level, (list = []));
    list.push(s);
  }
  const out = new Map<number, LevelRuns<S>>();
  for (let level = 1; level <= upTo; level++) out.set(level, runsAtLevel(input, level, byLevel.get(level) ?? []));
  return out;
}

export function runsAtLevel<S extends RunSummary>(
  input: StoreRunsInput<S>,
  level: number,
  unmerged: readonly S[] = input.summaries.filter((s) => s.level === level && input.parentOf(s) == null && !input.queued.has(s.id)),
): LevelRuns<S> {
  const { position, held, pending, spanBase, mergeK } = input;
  const excluded: LevelRuns<S>['excluded'] = [];
  const placed: Placed<S>[] = [];
    // Held summaries (mergeHeldSourceIds: operator holds, and the sources a
    // merge-quarantine record holds out) leave a hole: the runs split there
    // and merge on each side, while the klaxon names a quarantined merge's
    // record and the debt report lists operator holds. `heldEnd` is the last
    // position a held summary reaches: a run that ends before it can't grow
    // past the hole.
  let heldEnd = -Infinity;
  const heldFirsts: number[] = [];
  for (const s of unmerged) {
    const at = placeOf(s, position);
    if (!at) {
      // Pruned/missing source messages: the candidate can NEVER merge.
      // This was a silent drop (rev-5 review: "frontier debt, no log").
      excluded.push({
        id: s.id,
        detail: `L${s.level ?? 1} ${s.id}: source position unresolved (pruned or hidden source messages?) — permanently unmergeable, frontier debt`,
      });
      continue;
    }
    if (held.has(s.id)) {
      heldEnd = Math.max(heldEnd, at[1]);
      heldFirsts.push(at[0]);
      continue;
    }
    // Wide-span quarantine, scaled by level. Legitimate spans grow ~k× per
    // level, so a FLAT limit silently forbids all consolidation above the
    // level where it matches a healthy node's span: mythos 2026-08 — every
    // L4 spans 3.0k–6.9k messages > 1500, so an L5 was structurally
    // impossible at any store state and the fold floor sat ~23k above
    // where one L5 puts it. The damage signature this guard exists for
    // (replay-era bridge summaries, 2026-07-12) is "wide FOR ITS LEVEL",
    // not absolute width. Limits for L1–L3 are unchanged from the flat
    // default; L4 gets base×k, L5 base×k², …
    const exponent = Math.max(0, level - 3);
    const spanLimit = spanBase * Math.pow(mergeK, exponent);
    const span = at[1] - at[0];
    if (span > spanLimit) {
      excluded.push({
        id: s.id,
        detail: `L${s.level ?? 1} ${s.id}: wide-span quarantine — span ${span} msgs > limit ${spanLimit} (base ${spanBase} × ${mergeK}^${exponent})`,
      });
      continue;
    }
    placed.push({ s, first: at[0], last: at[1] });
  }
  placed.sort((a, b) => a.first - b.first);
  heldFirsts.sort((a, b) => a - b);

  // Split into strictly contiguous live runs. Deleted messages do not occupy
  // positions in `messageOrder`, so this still bridges true tombstones; a
  // run splits wherever a listed message stands between two sources, owned
  // by another summary or by none (mergePositionIndex). A hole that
  // work put back after a failure will fill at this level (pendingRetrySpans)
  // isn't stranded: the run before it waits, as the newest run does. A run
  // can grow only up to the next run or the first held summary after it,
  // whichever comes first, so it waits only for a retry pending before that.
  const waitsFor = (end: number, next: number): boolean => {
    const bound = Math.min(next, heldFirsts.find((p) => p > end) ?? Infinity) - 1;
    return pending.some((p) => p.level <= level && p.first <= bound && p.last >= end + 1);
  };
  const runs: MergeRun<S>[] = [];
  let run: Placed<S>[] = [];
  let runEnd = -Infinity;
  const close = (next: number): void => {
    runs.push({ members: run, first: run[0]!.first, last: runEnd, newest: false, waiting: waitsFor(runEnd, next) });
  };
  for (const x of placed) {
    if (run.length > 0 && x.first !== runEnd + 1) {
      close(x.first);
      run = [];
      runEnd = -Infinity;
    }
    run.push(x);
    runEnd = Math.max(runEnd, x.last);
  }
  if (run.length > 0) {
    const newest = !(heldEnd > runEnd) && !(input.planning && cantGrowPast(input, level, runEnd));
    const last: MergeRun<S> = { members: run, first: run[0]!.first, last: runEnd, newest, waiting: false };
    last.waiting = !last.newest && waitsFor(runEnd, Infinity);
    runs.push(last);
  }
  return { runs, excluded };
}

export function strandedIn<S>(runs: readonly MergeRun<S>[]): Placed<S>[] {
  return runs.filter((r) => r.members.length === 1 && !r.newest && !r.waiting).map((r) => r.members[0]!);
}

export function interiorGroupSize(n: number, threshold: number): number {
  if (n <= threshold) return n;
  let groups = Math.ceil(n / threshold);
  if (n < 2 * groups) groups = Math.floor(n / 2);
  return Math.ceil(n / groups);
}

export function newestGroupSize(n: number, threshold: number): number {
  if (n < threshold) return 0;
  if (n - threshold !== 1) return threshold;
  return threshold - 1 >= 2 ? threshold - 1 : n;
}

export function runGroups<S>(run: MergeRun<S>, threshold: number, rest = false): S[][] {
  const members = run.members.map((m) => m.s);
  const groups: S[][] = [];
  let at = 0;
  if (run.newest || run.waiting) {
    for (let size = newestGroupSize(members.length - at, threshold); size > 0; size = newestGroupSize(members.length - at, threshold)) {
      groups.push(members.slice(at, (at += size)));
    }
    if (rest && members.length - at >= 2) groups.push(members.slice(at));
    return groups;
  }
  while (members.length - at >= 2) {
    const size = interiorGroupSize(members.length - at, threshold);
    groups.push(members.slice(at, (at += size)));
  }
  return groups;
}

export function queuedMergeRuns<S extends RunSummary>(
  merge: { level: number; sourceIds: readonly string[] },
  byId: ReadonlyMap<string, S> | ((id: string) => S | undefined),
  parentOf: (s: S) => string | null | undefined,
  position: ReadonlyMap<string, number>,
  held?: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(merge.sourceIds) || merge.sourceIds.length < 2) return false;
  const get = typeof byId === 'function' ? byId : (id: string) => byId.get(id);
  let previousEnd: number | null = null;
  for (const sourceId of merge.sourceIds) {
    const source = get(sourceId);
    if (!source || source.level !== merge.level - 1 || parentOf(source) != null || held?.has(sourceId)) return false;
    const range = source.sourceRange;
    if (!range) return false;
    const first = position.get(range.first);
    const last = position.get(range.last);
    if (first === undefined || last === undefined || last < first) return false;
    if (previousEnd !== null && first !== previousEnd + 1) return false;
    previousEnd = last;
  }
  return true;
}

export function adjacentRuns<S extends RunSummary>(sources: readonly S[], position: ReadonlyMap<string, number>): S[][] {
  const placed: Placed<S>[] = [];
  for (const s of sources) {
    const at = placeOf(s, position);
    if (at) placed.push({ s, first: at[0], last: at[1] });
  }
  placed.sort((x, y) => x.first - y.first);
  const runs: S[][] = [];
  let run: S[] = [];
  let end = -Infinity;
  for (const p of placed) {
    if (run.length > 0 && p.first !== end + 1) { runs.push(run); run = []; }
    run.push(p.s);
    end = Math.max(end, p.last);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function mergeGroupProblem<S extends RunSummary>(
  targetLevel: number,
  sources: readonly S[],
  position: ReadonlyMap<string, number>,
  runsOf: (sources: readonly S[], position: ReadonlyMap<string, number>) => S[][] = adjacentRuns,
): string | null {
  if (sources.length < 2) return `${sources.length} source(s); a merge needs at least two`;
  const wrongLevel = sources.filter((s) => s.level !== targetLevel - 1);
  if (wrongLevel.length > 0) {
    return `source level mismatch: ${wrongLevel.map((s) => `${s.id}=L${s.level}`).join(',')} for an L${targetLevel} merge`;
  }
  const unplaced = sources.filter((s) => placeOf(s, position) === undefined);
  if (unplaced.length > 0) {
    return `source position unresolved (range endpoints neither in the store listing nor owned by a chunk): ${unplaced.map((s) => s.id).join(',')}`;
  }
  const runs = runsOf(sources, position);
  if (runs.length !== 1) {
    return `sources are not adjacent in store order: ` +
      runs.map((r) => `[${r.map((s) => `${s.id}(${s.sourceRange!.first}..${s.sourceRange!.last})`).join(',')}]`).join(' | ');
  }
  return null;
}

export function mergeRecordHoldsIn<S extends RunSummary>(
  record: { level: number; sourceIds: readonly string[]; lastOutcome?: string },
  byId: (id: string) => S | undefined,
  parentOf: (s: S) => string | null | undefined,
  position: ReadonlyMap<string, number>,
  problem: (level: number, sources: readonly S[], position: ReadonlyMap<string, number>) => string | null = mergeGroupProblem,
): boolean {
  if (record.lastOutcome === 'topology_violation') return false;
  const sources: S[] = [];
  for (const id of record.sourceIds ?? []) {
    const s = byId(id);
    if (!s || parentOf(s) != null) return false;
    sources.push(s);
  }
  return problem(record.level, sources, position) === null;
}
