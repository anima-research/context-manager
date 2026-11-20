
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
  /** The summaries `excluded` names for a span too wide for the level, each at its place. */
  wide: Placed<S>[];
}

/** A stretch of the listing where work that is held up could still land a summary of `level` (0: a chunk's L1). */
export interface RunHole {
  first: number;
  last: number;
  level: number;
}

/** The unparented summaries by the position each starts and ends at; one without a level reads as above every level. */
export interface FrontierEnds {
  from: ReadonlyMap<number, { to: number; level: number }>;
  to: ReadonlyMap<number, { from: number; level: number }>;
}

/** What `projectLadder` projects, in the order it would happen. `as` names the summary a step makes in the steps after it. */
export type LadderStep =
  | { kind: 'carry'; id: string; fromLevel: number; toLevel: number; as: string }
  | {
      kind: 'merge';
      level: number;
      sourceIds: string[];
      /** The sources' tokens together, less those of the `unwritten` ones. */
      sourceTokens: number;
      as: string;
      /** How many sources an earlier listed merge writes: their tokens aren't known, and aren't counted. */
      unwritten?: number;
      /** The store's queue held this merge already. */
      alreadyQueued?: true;
    };

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
  const wide: Placed<S>[] = [];
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
      // Source messages pruned or hidden: the candidate can't merge while
      // their positions don't resolve, for good after a removal, and until a
      // filter shows them again.
      // This was a silent drop (rev-5 review: "frontier debt, no log").
      excluded.push({
        id: s.id,
        detail: `L${s.level ?? 1} ${s.id}: source position unresolved (pruned or hidden source messages?) — unmergeable while its source positions don't resolve, frontier debt`,
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
      wide.push({ s, first: at[0], last: at[1] });
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
  return { runs, excluded, wide };
}

export function strandedIn<S>(runs: readonly MergeRun<S>[]): Placed<S>[] {
  return runs.filter((r) => r.members.length === 1 && !r.newest && !r.waiting).map((r) => r.members[0]!);
}

/**
 * Whether `s` is an entry that carries a summary up a level unchanged
 * (`carriedFrom`, the strategy's `carryStrandedSummaries`): one whose one
 * source is still the summary it was written to carry. A repair can give
 * such an entry another source (an adoption, a re-homed fragment) and leave
 * the mark on it; from then it is a summary of its level over every source
 * it lists, as any summary a repair adds a source to.
 */
export function carriesItsSource(s: { sourceIds?: readonly string[] | null; carriedFrom?: string }): boolean {
  return s.carriedFrom !== undefined && s.sourceIds?.length === 1 && s.sourceIds[0] === s.carriedFrom;
}

export function frontierEnds<S extends RunSummary>(input: Pick<StoreRunsInput<S>, 'summaries' | 'parentOf' | 'position'>): FrontierEnds {
  const from = new Map<number, { to: number; level: number }>();
  const to = new Map<number, { from: number; level: number }>();
  for (const s of input.summaries) {
    if (input.parentOf(s)) continue;
    const at = placeOf(s, input.position);
    if (!at) continue;
    const level = typeof s.level === 'number' ? s.level : Number.POSITIVE_INFINITY;
    from.set(at[0], { to: at[1], level });
    to.set(at[1], { from: at[0], level });
  }
  return { from, to };
}

/**
 * The holes of `level` or below that part a summary at [first, last] from the
 * summaries beside it, looking past lower-level unparented summaries on each
 * side: every hole that stands at the first place on a side holding any.
 */
export function holesBeside<H extends RunHole>(
  ends: FrontierEnds,
  holes: readonly H[],
  level: number,
  first: number,
  last: number,
): Array<{ hole: H; side: 'before' | 'after' }> {
  const walk = (start: number, step: 1 | -1): Array<{ hole: H; side: 'before' | 'after' }> => {
    let at = start;
    for (;;) {
      const here = holes.filter((h) => h.level <= level && h.first <= at && at <= h.last);
      if (here.length > 0) return here.map((hole) => ({ hole, side: step === 1 ? 'after' : 'before' }));
      const lower = step === 1 ? ends.from.get(at) : ends.to.get(at);
      if (!lower || lower.level >= level) return [];
      at = (step === 1 ? (lower as { to: number }).to : (lower as { from: number }).from) + step;
    }
  };
  return [...walk(first - 1, -1), ...walk(last + 1, 1)];
}

/** Whether `leaves` are every listed message from `first` to `last`, and none outside. One the listing lacks has no place and isn't counted. */
export function fillsSpan(leaves: Iterable<string>, position: ReadonlyMap<string, number>, first: number, last: number): boolean {
  const seen = new Set<number>();
  for (const id of leaves) {
    const at = position.get(id);
    if (at === undefined) continue;
    if (at < first || at > last) return false;
    seen.add(at);
  }
  return seen.size === last - first + 1;
}

/**
 * The summaries of `level` the carry rule (`carryStrandedSummaries`) takes up
 * a level as the store stands, in store order. Each is one no merge at its
 * level can take: alone in a run that is neither the newest nor waiting
 * (strandedIn), or left out of the runs as too wide for the level. And each
 * - stands strictly beside an unparented summary of a higher level, so the
 *   level it climbs toward is one a summary beside it already holds;
 * - has no hole beside it that held-up work could still fill (holesBeside);
 * - is the one form of every listed message from its first to its last
 *   (`leaves`: the messages it stands for). A summary with another's
 *   messages inside its span is what the wide-span limit keeps out of
 *   merges, and a level up that limit no longer would.
 * None below a merge threshold of 2 (`mergeK`), where no merge lands and a
 * carry would lead nowhere.
 */
export function carriesAtLevel<S extends RunSummary>(
  input: StoreRunsInput<S>,
  level: number,
  holes: readonly RunHole[],
  leaves: (s: S) => Iterable<string>,
  found: LevelRuns<S> = runsAtLevel(input, level),
): Placed<S>[] {
  const alone = [...strandedIn(found.runs), ...found.wide];
  if (alone.length === 0 || !(input.mergeK >= 2)) return [];
  const ends = frontierEnds(input);
  const higher = (beside: { level: number } | undefined): boolean =>
    beside !== undefined && Number.isFinite(beside.level) && beside.level > level;
  return alone
    .filter(({ s, first, last }) =>
      (higher(ends.to.get(first - 1)) || higher(ends.from.get(last + 1))) &&
      holesBeside(ends, holes, level, first, last).length === 0 &&
      fillsSpan(leaves(s), input.position, first, last))
    .sort((a, b) => a.first - b.first);
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
    return `sources are not adjacent in store order (the strategy's view: the window's order once a host presents): ` +
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

interface Rung<S> extends RunSummary {
  parent?: string;
  /** Unknown for a summary a projected merge writes. */
  tokens?: number;
  stored?: S;
  under: Rung<S>[];
}

/**
 * What the merge check would do from the store as `input` reads it, with no
 * call failing and nothing new arriving: the check, then each queued merge
 * landing in turn with the check after it, as tick runs them. Each carry the
 * rule makes (`carry`) and each merge that lands is listed in order.
 * `input.planning` reads the store, and takes its picks, as a drain does
 * (landsAsPlanned): one group at a time, the lowest level first. `queue` is
 * the stored queue's entries that can still run; `everyLevel` whether the
 * check reads every level (speculative production) or L1 and L2 only.
 * It changes nothing it is given.
 */
export function projectLadder<S extends RunSummary & { tokens?: number }>(
  input: StoreRunsInput<S>,
  options: {
    threshold: number;
    everyLevel: boolean;
    carry: boolean;
    holes: readonly RunHole[];
    leaves: (s: S) => Iterable<string>;
    queue: ReadonlyArray<{ level: number; sourceIds: readonly string[] }>;
  },
): LadderStep[] {
  const all: Rung<S>[] = input.summaries.map((s) => ({
    id: s.id, level: s.level, sourceRange: s.sourceRange, parent: input.parentOf(s) || undefined, tokens: s.tokens ?? 0, stored: s, under: [],
  }));
  const byId = new Map(all.map((rung) => [rung.id, rung] as const));
  const queue = options.queue.map((m) => ({ level: m.level, sourceIds: [...m.sourceIds], stored: true }));
  const steps: LadderStep[] = [];
  const leaves = (rung: Rung<S>): string[] => (rung.stored ? [...options.leaves(rung.stored)] : rung.under.flatMap(leaves));
  const state = (): StoreRunsInput<Rung<S>> => ({
    position: input.position, held: input.held, pending: input.pending, spanBase: input.spanBase, mergeK: input.mergeK, planning: input.planning,
    summaries: all, parentOf: (rung) => rung.parent, queued: new Set(queue.flatMap((m) => m.sourceIds)),
  });
  let merges = 0;
  const land = (level: number, under: Rung<S>[], id: string, tokens: number | undefined): Rung<S> => {
    const rung: Rung<S> = {
      id, level, tokens, under,
      sourceRange: { first: under[0]!.sourceRange!.first, last: under[under.length - 1]!.sourceRange!.last },
    };
    all.push(rung);
    byId.set(id, rung);
    for (const source of under) source.parent = id;
    return rung;
  };
  const check = (): void => {
    if (input.planning && queue.length > 0) return;
    let top = 2;
    if (options.everyLevel) for (const rung of all) top = Math.max(top, rung.level ?? 1);
    for (let level = 1; level <= top; level++) {
      if (options.carry && (options.everyLevel || level < 2)) {
        for (let picked = carriesAtLevel(state(), level, options.holes, leaves); picked.length > 0; picked = carriesAtLevel(state(), level, options.holes, leaves)) {
          for (const { s } of picked) {
            const carried = land(level + 1, [s], `${s.id.replace(/\^\d+$/, '')}^${level + 1}`, s.tokens);
            steps.push({ kind: 'carry', id: s.id, fromLevel: level, toLevel: level + 1, as: carried.id });
          }
        }
      }
      if (!(options.threshold >= 2)) continue;
      for (const run of runsAtLevel(state(), level).runs) {
        const [group] = runGroups(run, options.threshold);
        if (!group) continue;
        queue.push({ level: level + 1, sourceIds: group.map((rung) => rung.id), stored: false });
        break;
      }
      if (input.planning && queue.length > 0) return;
    }
  };
  check();
  for (let merge = queue.shift(); merge; merge = queue.shift()) {
    const under = merge.sourceIds.map((id) => byId.get(id));
    // A stored entry an earlier merge took a source of is dropped at its turn, with no call.
    if (under.every((rung): rung is Rung<S> => rung !== undefined && !rung.parent)) {
      const unwritten = under.filter((rung) => rung.tokens === undefined).length;
      const made = land(merge.level, under, `merge#${++merges}`, undefined);
      steps.push({
        kind: 'merge', level: merge.level, sourceIds: merge.sourceIds, as: made.id,
        sourceTokens: under.reduce((sum, rung) => sum + (rung.tokens ?? 0), 0),
        ...(unwritten > 0 ? { unwritten } : {}),
        ...(merge.stored ? { alreadyQueued: true as const } : {}),
      });
    }
    check();
  }
  return steps;
}
