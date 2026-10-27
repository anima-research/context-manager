/**
 * General-purpose repair planner for crossed summary ownership.
 *
 * A summary is crossed when its leaves are not contiguous among owned
 * messages (chunk-record members ∪ chunk-linked L1 sources) in store order:
 * another live representation sits inside its span. The load-time audit
 * (`topologyPolicy`) refuses such a store. Known causes: issue #122 (the head
 * ratchet minted late L1s over opening messages that merged with the
 * frontier by chunk-record order), issue #95 (demand-path merges folded across
 * an unlanded neighbour), restore/branch interleavings, hand surgery.
 *
 * The plan is structural and regenerates nothing:
 * - level ≥ 2: the summary keeps the run of children carrying the most
 *   leaves and detaches the rest (`lossless`, the default: fragments become
 *   roots and keep their prose; an ancestor left with a hole is repaired the
 *   same way on the next pass, so the pyramid unravels around the fragment).
 *   In `compact` mode a summary whose holes are owned, one level down, by
 *   roots adopts them instead (the #95 shape), and detached fragments are
 *   re-homed under an adjacent summary at the same level; the pyramid keeps
 *   its depth, but the adopting prose never covered the moved content.
 *   Regenerating the affected merges with the summarizer is the path that is
 *   both compact and faithful; this planner does not make model calls.
 * - level 1: the L1 keeps its largest contiguous run; the other messages are
 *   released from it and its chunk record, so the chunker re-owns them.
 * - a parent left with fewer than two sources is dissolved (its child becomes
 *   a root; the grandparent shrinks and may dissolve in turn).
 * - touched ancestors get their `sourceRange` recomputed; kv-stable
 *   resolutions deeper than the leaf's remaining chain are clamped.
 * - `releaseHead`: detached L1s (and uncompressed records) that form a prefix
 *   of the store's owned messages are removed with their records, so the head
 *   window takes those messages back verbatim (CM ≥ #123 anchors the head to
 *   coverage; the extension is bounded at 2× `headWindowTokens`).
 *
 * Pure: takes and returns plain state; the caller writes it.
 */

import { isDeepStrictEqual } from 'node:util';
import { mergeRecordHoldsIn, mergeRunsByLevel, placeOf, queuedMergeRuns, runGroups, strandedIn, type LevelRuns, type Placed } from '../strategies/merge-runs.js';
import {
  loadedChunkRecords, releaseUnsummarizedRecords, settleRepairLine, settleStoredSummaries, settlingRepaired,
} from '../strategies/settle-summaries.js';
import type { LoadRepairDropReason } from '../types/strategy.js';

export interface RepairSummary {
  id: string;
  level: number;
  sourceLevel?: number;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  mergedInto?: string;
  parentId?: string;
  [key: string]: unknown;
}
export interface RepairRecord {
  id: string;
  sourceIds: string[];
  compressed: boolean;
  summaryId?: string;
  [key: string]: unknown;
}
export interface RepairInputs {
  summaries: RepairSummary[];
  records: RepairRecord[];
  /** Store listing in store order (ids; timestamps only for a date cutoff). */
  messages: ReadonlyArray<{ id: string; timestamp?: number | string | Date }>;
  resolutions?: Record<string, number> | null;
  /**
   * The persisted merge queue (`autobio:mergeQueue`). The strategy loads its
   * valid entries at open and runs them in turn as it ticks, so a queued
   * entry's sources are in no run, and the summary it will write is work
   * that fills its place (merge-runs.ts).
   */
  mergeQueue?: ReadonlyArray<{ level: number; sourceIds: string[] }> | null;
  /**
   * The persisted merge-quarantine records (`autobio:merge-quarantine`). A
   * record holds its sources out of merges as the strategy's
   * mergeRecordHolds says (merge-runs.ts mergeRecordHoldsIn). An entry the
   * strategy's loader can't read (no string key, or sources that aren't a
   * list of ids) holds nothing, as the loader leaves it out; so does a queue
   * entry whose sources aren't a list of ids.
   */
  mergeQuarantine?: ReadonlyArray<{ key: string; level: number; sourceIds: string[]; lastOutcome?: string }> | null;
  /**
   * The ids of the chunk records an active compression quarantine record
   * names (the strategy's compressionQuarantineHolds, over the ids of each
   * record's messages that still stand in the store, as the strategy builds
   * and hashes the chunk). The rebuild projects every other uncompressed record as an
   * L1 to come, since a drain compresses it before it picks merges, unless an
   * L1 already holds a message of it; a named one stands as the quarantine
   * leaves it, with no L1 there.
   */
  compressionQuarantined?: readonly string[] | null;
}
/**
 * The run rule's settings that a resident's config holds and its store
 * doesn't, defaulted as the strategy defaults them for an adaptive resident.
 */
export interface RepairRunsConfig {
  mergeThreshold: number;
  mergeMaxSourceSpanMessages: number;
  mergeHoldSummaryIds: string[];
  /** Whether the merge check reads every level (speculative production) or L1 and L2 only. */
  speculativeProduction: boolean;
}
export const DEFAULT_RUNS_CONFIG: RepairRunsConfig = { mergeThreshold: 6, mergeMaxSourceSpanMessages: 1500, mergeHoldSummaryIds: [], speculativeProduction: true };

function runsConfigOf(runs: Partial<RepairRunsConfig> = {}): RepairRunsConfig {
  const given = Object.fromEntries(Object.entries(runs).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_RUNS_CONFIG, ...given };
}
export interface RepairOptions {
  /**
   * Remove prefix records (and their L1s) so the head window takes the
   * messages back: `'moved'` releases uncompressed prefix records and L1s this
   * plan detached or re-homed; `'all'` also releases pre-existing unparented
   * root L1s at the prefix. `true` means `'moved'`.
   */
  releaseHead?: boolean | 'moved' | 'all';
  /** With releaseHead, stop the prefix walk before releasing more than this many messages. */
  releaseHeadLimit?: number;
  /**
   * `lossless` (default): only detach; fragments become roots and keep their
   * prose, but every ancestor whose span they sit inside is detached in turn
   * (the pyramid unravels there — more tokens until the merge ladder folds
   * it again; `depthLostLeaves` counts the leaves that lose a fold level).
   * `compact`: also adopt unparented hole owners and re-home fragments under
   * adjacent summaries, which keeps the pyramid's depth at the price of
   * prose that does not cover the moved content (`proseGapLeaves`).
   * `rebuild`: dissolve every summary above L1 whose span touches a crossed
   * region, and their ancestors, back to unparented L1s (`dissolvedForRebuild`,
   * `exposedL1Leaves`); the merge ladder then re-folds the region bottom-up
   * with real summarizer calls — run `drain-autobiographical` on the stopped
   * store before restarting, or the resident pays the token spike live. It
   * also gives a partner to each summary the plan would leave alone at its
   * level (`partnered`, `strandedLeft`), on a store with nothing crossed too.
   */
  mode?: 'lossless' | 'compact' | 'rebuild';
  /**
   * rebuild only: crossed summaries whose span starts at or after this
   * message (an id, or an ISO date resolved to the first message at or after
   * it) are rebuilt; older ones get the compact treatment, and no tower
   * starting before it is dissolved to give a summary a partner, so regions
   * that were repaired by hand are not re-summarized.
   */
  rebuildSince?: string;
  maxIterations?: number;
  /** rebuild: the resident's run settings, for the stray rule (DEFAULT_RUNS_CONFIG where left out). */
  runs?: Partial<RepairRunsConfig>;
}
export interface Crossed {
  id: string;
  level: number;
  leafCount: number;
  holes: number;
  span: { first: string; last: string };
}
export interface RepairPlan {
  iterations: number;
  before: Crossed[];
  /** Roots taken into a crossed summary whose hole they owned (prose does not cover them). */
  adopted: Array<{ id: string; level: number; into: string; leaves: number }>;
  detached: Array<{ id: string; level: number; from: string; leaves: number }>;
  /** Detached fragments placed under an adjacent sibling so no ancestor is left with a hole. */
  rehomed: Array<{ id: string; from: string; into: string; leaves: number }>;
  splitL1: Array<{ id: string; kept: number; released: string[] }>;
  dissolved: Array<{ id: string; level: number; child: string }>;
  released: Array<{ record: string; summaryId?: string; leaves: string[] }>;
  rangeChanges: Array<{ id: string; from: { first: string; last: string }; to: { first: string; last: string } }>;
  resolutionsClamped: number;
  resolutionsCleared: number;
  /** Leaves now under a summary whose prose never covered them (adopted + re-homed). */
  proseGapLeaves: number;
  /** Leaves whose deepest available fold level dropped (ancestors unravelled). */
  depthLostLeaves: number;
  /** rebuild: summaries dissolved so the ladder re-folds their regions (≈ merges to regenerate). */
  dissolvedForRebuild: Array<{ id: string; level: number; leaves: number }>;
  /** rebuild: leaves now exposed at L1 until the ladder re-folds them. */
  exposedL1Leaves: number;
  /**
   * rebuild: what the plan gave a partner, each a summary the store as the
   * plan leaves it, once the ladder has re-folded it, would hold alone at its
   * level by the strategy's run rule: one already stranded or a crossed
   * summary's child (`stranded`), a run of the messages a crossed L1 releases
   * (`released`, `id` the L1), which the chunker re-chunks where it stands,
   * a chunk recorded and not yet compressed (`pending`, `id` its record), or
   * a summary the re-fold makes (`refolded`, `id` its span), such as a
   * dissolved tower's top made again. `dissolved` names the lowest summary of
   * the tower dissolved for it.
   */
  partnered: Array<{ kind: 'stranded' | 'released' | 'pending' | 'refolded'; id: string; level: number; leaves: number; span: { first: string; last: string }; dissolved: string }>;
  /**
   * rebuild: what the plan leaves alone at its level, of the same kinds,
   * each with why: it starts before `rebuildSince`; the only towers that
   * could free a neighbour start before it; nothing of its level beside it
   * can be freed to partner it (the store's edge, a message no summary
   * covers, a lower-level summary, a summary with no stored parent, one whose
   * parent isn't in the store, or one that stays held, too wide or queued
   * once freed); the compact repair of crossed summaries before
   * `rebuildSince`, which runs after the stray pass, left it alone (`left by
   * the compact repair`); the run settings' mergeThreshold is below 2, where
   * the ladder forms no merge it can write (#285), so freeing a neighbour
   * would partner nothing; a side that would partner it has a tower
   * holding a stale generation, an L1 no chunk record names over messages a
   * record naming another L1 holds (`stale` names them); or it is a stale
   * generation itself (`stale` names it).
   */
  strandedLeft: Array<{ kind: 'stranded' | 'released' | 'pending' | 'refolded'; id: string; level: number; leaves: number; span: { first: string; last: string }; reason: 'before rebuildSince' | 'neighbours before rebuildSince' | 'no neighbour to free' | 'left by the compact repair' | 'no merge forms below a threshold of 2' | 'a neighbour\'s tower holds a stale generation' | 'a stale generation'; stale?: string[] }>;
  /** rebuild with rebuildSince: where the cutoff landed and how the crossed set split. */
  rebuildSince?: { id: string; position: number; rebuilt: number; compacted: number };
  /** Crossed summaries the plan could not resolve (empty on success). */
  remaining: Crossed[];
  /**
   * What the loader's settling repaired in the stored state before the plan
   * read it (settle-summaries.ts). The plan reads, and the apply writes, the
   * store as the loader keeps it, so the apply stores these repairs, as the
   * loader would at its next open. `line` is the loader's own line for them,
   * absent when nothing was repaired; `dropped` is each summary dropped with
   * text in it, with why; `storedIds` is every summary id the stored state
   * held, dropped ones included, which the summary-id counter must stay past
   * (summaryIdCounterPast); `releasedRecords` counts the compressed chunk
   * records made compressible again, since the L1 they named was dropped.
   */
  settled: {
    line?: string;
    dropped: Array<{ id: string; level: number | null; tokens: number | null; reason: LoadRepairDropReason }>;
    storedIds: string[];
    /** Chunk records the loader leaves out: no id, or no list of message ids. */
    filteredRecords: number;
    releasedRecords: number;
  };
  /**
   * What settling the plan's own store once more changed (`line` as the
   * loader logs it; chunk records the loader would leave out or release):
   * nothing, unless the planner wrote something the loader repairs, a
   * planner fault the script prints.
   */
  resettled: { line?: string; filteredRecords: number; releasedRecords: number };
  /** The store the apply writes: the plan's, as the loader keeps it (resettled), one summary per id, with its chunk records and resolutions. */
  result: { summaries: RepairSummary[]; records: RepairRecord[]; resolutions: Record<string, number> };
}

interface View {
  byId: Map<string, RepairSummary>;
  liveL1: Set<string>;
  position: Map<string, number>;
  byPosition: string[];
  leaves: (s: RepairSummary) => string[];
}

const parentOf = (s: RepairSummary): string | undefined => s.mergedInto ?? s.parentId;
const setParent = (s: RepairSummary, id: string | undefined): void => {
  if (id === undefined) { delete s.mergedInto; delete s.parentId; return; }
  if ('parentId' in s && s.mergedInto === undefined) s.parentId = id; else s.mergedInto = id;
};

export function listedPositions(inputs: Pick<RepairInputs, 'messages'>): Map<string, number> {
  return new Map(inputs.messages.map((m, i) => [String(m.id), i] as const));
}

type Projected = RepairSummary & { projected?: true };

const isIdList = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.length > 0);

function leafIds(byId: ReadonlyMap<string, RepairSummary>, s: RepairSummary, trail = new Set<string>()): string[] {
  if ((s.level ?? 1) <= 1) return [...(s.sourceIds ?? [])];
  if (trail.has(s.id)) return [];
  trail.add(s.id);
  const out: string[] = [];
  for (const id of s.sourceIds ?? []) { const c = byId.get(id); if (c) for (const leaf of leafIds(byId, c, trail)) out.push(leaf); }
  return out;
}

function firstListed(position: ReadonlyMap<string, number>, ids: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const id of ids) { const at = position.get(id); if (at !== undefined && (best === undefined || at < position.get(best)!)) best = id; }
  return best;
}

export function strandedInSummaries<S extends RepairSummary>(
  summaries: readonly S[],
  inputs: Pick<RepairInputs, 'mergeQueue' | 'mergeQuarantine'>,
  position: ReadonlyMap<string, number>,
  config: RepairRunsConfig,
  queue: 'stored' | 'drained' = 'stored',
  planning = false,
): Placed<S>[] {
  return [...runsInSummaries(summaries, inputs, position, config, queue, planning).values()].flatMap(({ runs }) => strandedIn(runs));
}

function runsInSummaries<S extends RepairSummary>(
  summaries: readonly S[],
  inputs: Pick<RepairInputs, 'mergeQueue' | 'mergeQuarantine'>,
  position: ReadonlyMap<string, number>,
  config: RepairRunsConfig,
  queue: 'stored' | 'drained',
  planning = false,
): Map<number, LevelRuns<S>> {
  const byId = new Map(summaries.map((s) => [s.id, s] as const));
  const held = heldIn(byId, inputs, position, config);
  const queued = new Set<string>();
  if (queue === 'stored') {
    for (const m of inputs.mergeQueue ?? []) {
      if (m != null && isIdList(m.sourceIds) && queuedMergeRuns<S>(m, byId, (s) => parentOf(s), position, held)) for (const id of m.sourceIds) queued.add(id);
    }
  }
  let top = 2;
  if (config.speculativeProduction) for (const s of summaries) top = Math.max(top, s.level ?? 1);
  return mergeRunsByLevel<S>({
    summaries, parentOf: (s: S) => parentOf(s), queued, position, held, pending: [],
    spanBase: config.mergeMaxSourceSpanMessages, mergeK: config.mergeThreshold, planning,
  }, top);
}

function heldIn<S extends RepairSummary>(
  byId: ReadonlyMap<string, S>,
  inputs: Pick<RepairInputs, 'mergeQuarantine'>,
  position: ReadonlyMap<string, number>,
  config: RepairRunsConfig,
): Set<string> {
  const held = new Set(config.mergeHoldSummaryIds);
  const byKey = new Map<string, NonNullable<RepairInputs['mergeQuarantine']>[number]>();
  for (const record of inputs.mergeQuarantine ?? []) {
    if (record == null || typeof record.key !== 'string' || !isIdList(record.sourceIds)) continue;
    byKey.set(record.key, record);
  }
  for (const record of byKey.values()) {
    if (mergeRecordHoldsIn(record, (id) => byId.get(id), parentOf, position)) for (const id of record.sourceIds) held.add(id);
  }
  return held;
}

export function strandedInStore(inputs: RepairInputs, runs: Partial<RepairRunsConfig> = {}): Array<{ id: string; level: number }> {
  const summaries = settleStoredSummaries<RepairSummary>(inputs.summaries, loadedChunkRecords<RepairRecord>(inputs.records)).summaries;
  return strandedInSummaries(summaries, inputs, listedPositions(inputs), runsConfigOf(runs))
    .map(({ s }) => ({ id: s.id, level: s.level ?? 1 }));
}

function view(summaries: RepairSummary[], records: RepairRecord[], storeOrder: Map<string, number>): View {
  const byId = new Map(summaries.map((s) => [s.id, s] as const));
  const liveL1 = new Set<string>();
  for (const r of records) if (r.summaryId && byId.has(r.summaryId)) liveL1.add(r.summaryId);
  if (liveL1.size === 0) for (const s of summaries) if (s.level === 1) liveL1.add(s.id);
  const owned = new Set<string>();
  for (const r of records) for (const id of r.sourceIds) owned.add(id);
  for (const id of liveL1) for (const leaf of byId.get(id)!.sourceIds) owned.add(leaf);
  const ordered = [...owned].filter((id) => storeOrder.has(id)).sort((a, b) => storeOrder.get(a)! - storeOrder.get(b)!);
  const position = new Map(ordered.map((id, i) => [id, i] as const));
  const cache = new Map<string, string[]>();
  const leaves = (s: RepairSummary): string[] => {
    const hit = cache.get(s.id);
    if (hit) return hit;
    let out: string[];
    if (s.level === 1) out = liveL1.has(s.id) ? [...s.sourceIds] : [];
    else {
      out = [];
      // One by one: a large child's leaves overflow a spread's argument limit.
      for (const childId of s.sourceIds) { const c = byId.get(childId); if (c && c.id !== s.id) for (const leaf of leaves(c)) out.push(leaf); }
    }
    cache.set(s.id, out);
    return out;
  };
  return { byId, liveL1, position, byPosition: ordered, leaves };
}

function positions(v: View, s: RepairSummary): number[] {
  const out: number[] = [];
  for (const id of v.leaves(s)) { const p = v.position.get(id); if (p !== undefined) out.push(p); }
  return [...new Set(out)].sort((a, b) => a - b);
}

function crossedOf(v: View, summaries: RepairSummary[]): Crossed[] {
  const out: Crossed[] = [];
  for (const s of summaries) {
    const ps = positions(v, s);
    if (ps.length < 2) continue;
    const holes = ps[ps.length - 1] - ps[0] + 1 - ps.length;
    if (holes > 0) out.push({ id: s.id, level: s.level, leafCount: ps.length, holes, span: { first: v.byPosition[ps[0]], last: v.byPosition[ps[ps.length - 1]] } });
  }
  return out;
}

/** Split sorted positions into maximal runs of consecutive integers. */
function runsOf(ps: number[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (const p of ps) {
    if (run.length && p !== run[run.length - 1] + 1) { runs.push(run); run = []; }
    run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

export function loadedAsWritten(
  written: { summaries: readonly unknown[]; records: readonly unknown[] },
  loaded: { summaries: unknown; records: unknown },
): { summariesChanged: boolean; recordsChanged: boolean; appendedRecords: number } {
  const plain = (x: unknown): unknown => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const records = Array.isArray(loaded.records) ? loaded.records : [];
  const head = records.slice(0, written.records.length);
  const recordsChanged = records.length < written.records.length || !isDeepStrictEqual(plain(head), plain(written.records));
  return {
    summariesChanged: !isDeepStrictEqual(plain(loaded.summaries), plain(written.summaries)),
    recordsChanged,
    appendedRecords: recordsChanged ? 0 : records.length - written.records.length,
  };
}

export function planTopologyRepair(inputs: RepairInputs, options: RepairOptions = {}): RepairPlan {
  if (options.mode === 'rebuild' && options.releaseHead) {
    throw new Error('releaseHead with mode rebuild: release the head in a pass of its own (lossless or compact), then rebuild');
  }
  const loaded = loadedChunkRecords<RepairRecord>(structuredClone(inputs.records));
  const settled = settleStoredSummaries<RepairSummary>(structuredClone(inputs.summaries), loaded);
  const summaries: RepairSummary[] = settled.summaries;
  const releasedRecords = releaseUnsummarizedRecords(loaded, summaries);
  let records: RepairRecord[] = releasedRecords.records;
  const resolutions: Record<string, number> = { ...(inputs.resolutions ?? {}) };
  const storeOrder = new Map(inputs.messages.map((m, i) => [String(m.id), i] as const));
  const plan: RepairPlan = {
    iterations: 0, before: [], adopted: [], detached: [], rehomed: [], splitL1: [], dissolved: [], released: [], rangeChanges: [],
    resolutionsClamped: 0, resolutionsCleared: 0, proseGapLeaves: 0, depthLostLeaves: 0, dissolvedForRebuild: [], exposedL1Leaves: 0,
    partnered: [], strandedLeft: [], remaining: [], resettled: { filteredRecords: 0, releasedRecords: 0 }, result: { summaries, records, resolutions },
    settled: {
      ...(settlingRepaired(settled) ? { line: settleRepairLine(settled) } : {}),
      dropped: settled.storedIds.flatMap((id) => {
        const drop = settled.textDrops.get(id);
        if (!drop) return [];
        const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
        return [{ id, level: num(drop.summary.level), tokens: num(drop.summary.tokens), reason: drop.reason }];
      }),
      storedIds: settled.storedIds,
      filteredRecords: inputs.records.length - loaded.length,
      releasedRecords: releasedRecords.released,
    },
  };
  const depthBefore = leafDepths(view(summaries, records, storeOrder));
  const originalRange = new Map(summaries.map((s) => [s.id, { ...s.sourceRange }] as const));
  const touched = new Set<string>();
  const detachedIds = new Set<string>();
  const mode = options.mode ?? 'lossless';
  const rebuild = mode === 'rebuild';
  // A rebuild with a cutoff treats the older crossed summaries compactly.
  const compact = mode === 'compact' || (rebuild && options.rebuildSince !== undefined);
  let cutoffStorePos: number | undefined;
  if (rebuild && options.rebuildSince !== undefined) {
    const since = options.rebuildSince;
    let idx = inputs.messages.findIndex((m) => String(m.id) === since);
    if (idx < 0 && /^\d{4}-\d{2}-\d{2}/.test(since)) {
      const at = Date.parse(since);
      const toMs = (t: number | string | Date | undefined): number => t instanceof Date ? t.getTime() : typeof t === 'string' ? Date.parse(t) : typeof t === 'number' ? (t > 1e14 ? t / 1000 : t) : NaN;
      idx = inputs.messages.findIndex((m) => toMs(m.timestamp) >= at);
    }
    if (idx < 0) throw new Error(`rebuildSince: no message matches ${since}`);
    cutoffStorePos = idx;
  }
  const maxIterations = options.maxIterations ?? 32;

  let v = view(summaries, records, storeOrder);
  plan.before = crossedOf(v, summaries);
  const alive = (): RepairSummary[] => summaries.filter((s) => v.byId.has(s.id));
  const remove = (id: string): void => {
    const at = summaries.findIndex((x) => x.id === id);
    if (at >= 0) summaries.splice(at, 1);
    v.byId.delete(id);
  };
  /** For every owned position, the summary that owns it at each level (via the live L1's chain). */
  const ownerAtLevel = (): Map<number, Map<number, string>> => {
    const out = new Map<number, Map<number, string>>();
    for (const l1Id of v.liveL1) {
      const chain: RepairSummary[] = [];
      let cur = v.byId.get(l1Id); const trail = new Set<string>();
      while (cur && !trail.has(cur.id)) { trail.add(cur.id); chain.push(cur); const p = parentOf(cur); cur = p ? v.byId.get(p) : undefined; }
      for (const leaf of v.byId.get(l1Id)!.sourceIds) {
        const p = v.position.get(leaf);
        if (p === undefined) continue;
        for (const a of chain) { let m = out.get(a.level); if (!m) { m = new Map(); out.set(a.level, m); } m.set(p, a.id); }
      }
    }
    return out;
  };
  const insertChild = (parent: RepairSummary, childId: string): void => {
    parent.sourceIds.push(childId);
    const child = v.byId.get(childId)!;
    setParent(child, parent.id);
    const key = (id: string): number => { const c = v.byId.get(id); const ps = c ? positions(v, c) : []; return ps.length ? ps[0] : Number.MAX_SAFE_INTEGER; };
    parent.sourceIds.sort((a, b) => key(a) - key(b));
    touched.add(parent.id);
  };

  const handled = new Set<string>();
  let finalStrays: (() => void) | undefined;
  if (rebuild) {
    // Dissolve each crossed summary (level ≥ 2) and its ancestors, so its
    // children and the owners of its holes become roots. A child run that is
    // then a lone node with no unparented same-level neighbour would never
    // fold again (the ladder merges adjacent unparented runs only), so the
    // tower over one adjacent neighbour is dissolved down to that neighbour's
    // level as well — the side with fewer leaves. Everything else stands; the
    // ladder re-folds the affected regions bottom-up with real summaries.
    // Crossed L1s are handled by the ordinary split below.
    v = view(summaries, records, storeOrder);
    const allCrossed = crossedOf(v, alive());
    let crossed = allCrossed.filter((c) => c.level >= 2);
    const startsAfter = (first: string): boolean => cutoffStorePos === undefined || (storeOrder.get(first) ?? -1) >= cutoffStorePos;
    if (cutoffStorePos !== undefined) {
      const rebuilt = crossed.filter((c) => startsAfter(c.span.first));
      plan.rebuildSince = { id: String(inputs.messages[cutoffStorePos].id), position: cutoffStorePos, rebuilt: rebuilt.length, compacted: crossed.length - rebuilt.length };
      crossed = rebuilt;
    }
    const dissolve = new Set<string>();
    const closeUp = (id: string): void => {
      let cur = v.byId.get(id);
      const trail = new Set<string>();
      while (cur && !trail.has(cur.id)) { trail.add(cur.id); const p = parentOf(cur); if (!p || !v.byId.has(p)) break; dissolve.add(p); cur = v.byId.get(p); }
    };
    for (const c of crossed) { dissolve.add(c.id); closeUp(c.id); }

    const kept = new Map<string, string[]>();
    const released: Array<RepairSummary & { releasedFrom: string }> = [];
    for (const c of allCrossed.filter((x) => x.level === 1)) {
      const s = v.byId.get(c.id)!;
      const [keep, ...rest] = runsOf(positions(v, s)).sort((a, b) => b.length - a.length || a[0] - b[0]);
      kept.set(s.id, keep.map((p) => v.byPosition[p]));
      rest.forEach((r, i) => {
        const ids = r.map((p) => v.byPosition[p]);
        released.push({ id: `${s.id}#released-${i}`, level: 1, sourceIds: ids, sourceRange: { first: ids[0], last: ids[ids.length - 1] }, releasedFrom: s.id });
      });
    }

    const quarantined = new Set(inputs.compressionQuarantined ?? []);
    const pending = (): Array<RepairSummary & { pendingFrom: string }> => {
      const underL1 = new Set<string>();
      for (const s of alive()) if (s.level === 1 && isIdList(s.sourceIds)) for (const id of s.sourceIds) underL1.add(id);
      const out: Array<RepairSummary & { pendingFrom: string }> = [];
      for (const r of records) {
        if (r.compressed || quarantined.has(r.id) || !isIdList(r.sourceIds)) continue;
        const ids = r.sourceIds.filter((id) => storeOrder.has(id));
        if (ids.length === 0 || ids.some((id) => underL1.has(id))) continue;
        for (const id of ids) underL1.add(id);
        out.push({ id: `${r.id}#pending`, level: 1, sourceIds: ids, sourceRange: { first: ids[0]!, last: ids[ids.length - 1]! }, pendingFrom: r.id });
      }
      return out;
    };

    const planned = (): RepairSummary[] => {
      const out: RepairSummary[] = [];
      for (const s of alive()) {
        if (dissolve.has(s.id)) continue;
        const parent = parentOf(s);
        const keep = kept.get(s.id);
        if ((parent === undefined || !dissolve.has(parent)) && !keep) { out.push(s); continue; }
        const copy: RepairSummary = { ...s, ...(keep ? { sourceIds: keep, sourceRange: { first: keep[0], last: keep[keep.length - 1] } } : {}) };
        if (parent !== undefined && dissolve.has(parent)) { delete copy.mergedInto; delete copy.parentId; }
        out.push(copy);
      }
      return [...out, ...released, ...pending()];
    };
    const runsConfig = runsConfigOf(options.runs);
    const position = listedPositions(inputs);
    const messageAt = (at: number): string => String(inputs.messages[at]?.id);
    const refolded = (state: RepairSummary[]): Projected[] => {
      const out: Projected[] = state.map((s) => ({ ...s }));
      const byId = new Map(out.map((s) => [s.id, s] as const));
      let made = 0;
      const land = (level: number, group: readonly Projected[]): void => {
        const spans = group.map((s) => placeOf(s, position)!);
        const parent: Projected = {
          id: `#refold-${made++}`, level, sourceIds: group.map((s) => s.id), projected: true,
          sourceRange: { first: messageAt(Math.min(...spans.map((x) => x[0]))), last: messageAt(Math.max(...spans.map((x) => x[1]))) },
        };
        out.push(parent);
        byId.set(parent.id, parent);
        for (const s of group) byId.get(s.id)!.mergedInto = parent.id;
      };
      const held = heldIn(byId, inputs, position, runsConfig);
      for (const m of inputs.mergeQueue ?? []) {
        if (m != null && isIdList(m.sourceIds) && queuedMergeRuns(m, byId, parentOf, position, held)) {
          land(m.level, m.sourceIds.map((id) => byId.get(id)!));
        }
      }
      if (!(runsConfig.mergeThreshold >= 2)) return out;
      for (let grew = true; grew;) {
        grew = false;
        for (const [level, { runs }] of runsInSummaries(out, inputs, position, runsConfig, 'drained', true)) {
          for (const run of runs) {
            for (const group of runGroups(run, runsConfig.mergeThreshold)) {
              land(level + 1, group);
              grew = true;
            }
          }
          if (grew) break;
        }
      }
      return out;
    };
    interface Projection { state: Projected[]; byId: Map<string, Projected>; l1At: Map<string, Projected> }
    const project = (): Projection => {
      const state = refolded(planned());
      const byId = new Map(state.map((s) => [s.id, s] as const));
      const l1At = new Map<string, Projected>();
      for (const s of state) if ((s.level ?? 1) === 1) for (const id of s.sourceIds) if (!l1At.has(id)) l1At.set(id, s);
      return { state, byId, l1At };
    };
    const ownerAt = ({ byId, l1At }: Projection, level: number, at: number): Projected | undefined => {
      const id = inputs.messages[at]?.id;
      let cur = id === undefined ? undefined : l1At.get(String(id));
      const trail = new Set<string>();
      while (cur && (cur.level ?? 1) < level && !trail.has(cur.id)) { trail.add(cur.id); const p = parentOf(cur); cur = p ? byId.get(p) : undefined; }
      return cur && (cur.level ?? 1) === level ? cur : undefined;
    };
    const strayKey = (x: Placed<Projected>): string => `${x.s.level ?? 1}:${x.first}:${x.last}`;
    const straysOf = (state: Projected[]): Placed<Projected>[] => strandedInSummaries(state, inputs, position, runsConfig, 'drained', true);
    const staleL1 = new Set<string>();
    {
      const named = new Set<string>();
      const heldBy = new Map<string, string>();
      for (const r of records) {
        if (!r.compressed || !r.summaryId || !isIdList(r.sourceIds)) continue;
        named.add(r.summaryId);
        for (const id of r.sourceIds) heldBy.set(id, r.summaryId);
      }
      for (const s of alive()) {
        if (s.level !== 1 || named.has(s.id) || !isIdList(s.sourceIds)) continue;
        if (s.sourceIds.some((id) => { const by = heldBy.get(id); return by !== undefined && by !== s.id; })) staleL1.add(s.id);
      }
    }
    const partner = (now: Projection, stray: Placed<Projected>): string | 'no neighbour to free' | 'neighbours before rebuildSince' | { stale: string[] } => {
      const level = stray.s.level ?? 1;
      const sides: Array<{ chain: string[]; leaves: number; cut: boolean }> = [];
      const staleSides: Array<{ chain: string[]; stale: string[] }> = [];
      for (const at of [stray.first - 1, stray.last + 1]) {
        const n = ownerAt(now, level, at);
        const chain: string[] = [];
        let cur = n ? now.byId.get(parentOf(n) ?? '') : undefined;
        const trail = new Set<string>();
        while (cur && !cur.projected && !trail.has(cur.id)) { trail.add(cur.id); chain.push(cur.id); cur = now.byId.get(parentOf(cur) ?? ''); }
        if (chain.length === 0) continue;
        const stale: string[] = [];
        const seen = new Set<string>();
        const under = (id: string): void => {
          const s = now.byId.get(id);
          if (!s || seen.has(id)) return;
          seen.add(id);
          if (staleL1.has(id)) stale.push(id);
          for (const c of s.sourceIds ?? []) under(c);
        };
        under(chain[chain.length - 1]!);
        if (stale.length > 0) { staleSides.push({ chain, stale }); continue; }
        const leaves = leafIds(now.byId, now.byId.get(chain[chain.length - 1])!);
        sides.push({ chain, leaves: leaves.length, cut: !startsAfter(firstListed(position, leaves) ?? '') });
      }
      const ownSet = new Set(leafIds(now.byId, stray.s).map((id) => position.get(id)).filter((p): p is number => p !== undefined));
      const own = [...ownSet];
      const ownLo = own.reduce((lo, p) => Math.min(lo, p), Infinity);
      const ownHi = own.reduce((hi, p) => Math.max(hi, p), -Infinity);
      const partners = (chain: readonly string[]): boolean => {
        const added = chain.filter((id) => !dissolve.has(id));
        for (const id of added) dissolve.add(id);
        const state = refolded(planned());
        const byId = new Map(state.map((s) => [s.id, s] as const));
        const covered = new Set<number>();
        for (const s of state) {
          if ((s.level ?? 1) <= level) continue;
          const at = placeOf(s, position);
          if (at && (at[1] < ownLo || at[0] > ownHi)) continue;
          for (const leaf of leafIds(byId, s)) {
            const p = position.get(leaf);
            if (p !== undefined && ownSet.has(p)) covered.add(p);
          }
        }
        let ok = own.length > 0 && own.every((p) => covered.has(p));
        if (!ok) {
          const runs = runsInSummaries(state, inputs, position, runsConfig, 'drained', true).get(level)?.runs ?? [];
          const run = runs.find((r) => r.members.some((m) => m.first === stray.first && m.last === stray.last));
          ok = run !== undefined && run.members.length >= 2;
        }
        if (ok) ok = !straysOf(state).some((x) => strayKey(x) === strayKey(stray));
        for (const id of added) dissolve.delete(id);
        return ok;
      };
      sides.sort((a, b) => a.leaves - b.leaves || a.chain.length - b.chain.length);
      const taken = sides.find((side) => !side.cut && partners(side.chain));
      if (!taken) {
        if (sides.some((side) => side.cut && partners(side.chain))) return 'neighbours before rebuildSince';
        const blocked = staleSides.filter((side) => partners(side.chain));
        return blocked.length > 0 ? { stale: [...new Set(blocked.flatMap((side) => side.stale))] } : 'no neighbour to free';
      }
      for (const id of taken.chain) { dissolve.add(id); closeUp(id); }
      return taken.chain[0]!;
    };
    const entryOf = ({ byId }: Projection, x: Placed<Projected>) => {
      const s = x.s as Projected & { releasedFrom?: string; pendingFrom?: string };
      const span = { first: messageAt(x.first), last: messageAt(x.last) };
      const kind = s.projected ? 'refolded' as const : s.releasedFrom ? 'released' as const : s.pendingFrom ? 'pending' as const : 'stranded' as const;
      const leaves = s.releasedFrom || s.pendingFrom ? s.sourceIds.length : leafIds(byId, s).length;
      return { kind, id: kind === 'refolded' ? `${span.first}..${span.last}` : s.releasedFrom ?? s.pendingFrom ?? s.id, level: s.level ?? 1, leaves, span };
    };
    const leftKeys = new Map<(typeof plan.strandedLeft)[number], string>();
    for (let now = project(), more = true; more;) {
      more = false;
      for (const x of straysOf(now.state)) {
        if (handled.has(strayKey(x))) continue;
        handled.add(strayKey(x));
        const entry = entryOf(now, x);
        const left = (reason: (typeof plan.strandedLeft)[number]['reason']): void => {
          const listed = { ...entry, reason };
          plan.strandedLeft.push(listed);
          leftKeys.set(listed, strayKey(x));
        };
        if (!startsAfter(entry.span.first)) { left('before rebuildSince'); continue; }
        if (!(runsConfig.mergeThreshold >= 2)) { left('no merge forms below a threshold of 2'); continue; }
        if (staleL1.has(x.s.id)) {
          const listed = { ...entry, reason: 'a stale generation' as const, stale: [x.s.id] };
          plan.strandedLeft.push(listed);
          leftKeys.set(listed, strayKey(x));
          continue;
        }
        const freed = partner(now, x);
        if (typeof freed === 'object') {
          const listed = { ...entry, reason: 'a neighbour\'s tower holds a stale generation' as const, stale: freed.stale };
          plan.strandedLeft.push(listed);
          leftKeys.set(listed, strayKey(x));
          continue;
        }
        if (freed === 'no neighbour to free' || freed === 'neighbours before rebuildSince') { left(freed); continue; }
        const taken = { ...entry, dissolved: freed };
        plan.partnered.push(taken);
        now = project();
        more = true;
        break;
      }
    }
    finalStrays = () => {
      const now = project();
      const strays = straysOf(now.state);
      const current = new Set(strays.map(strayKey));
      plan.strandedLeft = plan.strandedLeft.filter((listed) => current.has(leftKeys.get(listed)!));
      const listed = new Set(plan.strandedLeft.map((x) => leftKeys.get(x)!));
      for (const x of strays) {
        if (listed.has(strayKey(x))) continue;
        const entry = entryOf(now, x);
        plan.strandedLeft.push({ ...entry, reason: startsAfter(entry.span.first) ? 'left by the compact repair' : 'before rebuildSince' });
      }
    };
    if (dissolve.size > 0) {
      plan.iterations = 1;
      for (const id of dissolve) {
        const s = v.byId.get(id);
        if (!s) continue;
        const leaves = positions(v, s).length;
        for (const childId of s.sourceIds) { const ch = v.byId.get(childId); if (ch && !dissolve.has(ch.id)) setParent(ch, undefined); }
        const parent = parentOf(s);
        if (parent && !dissolve.has(parent)) { const p = v.byId.get(parent); if (p) { p.sourceIds = p.sourceIds.filter((x) => x !== id); touched.add(p.id); } }
        plan.dissolvedForRebuild.push({ id, level: s.level, leaves });
      }
      for (const id of dissolve) remove(id);
      v = view(summaries, records, storeOrder);
      const depthNow = leafDepths(v);
      for (const [leaf, d] of depthBefore) if (d > 1 && (depthNow.get(leaf) ?? 0) === 1) plan.exposedL1Leaves++;
    }
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    v = view(summaries, records, storeOrder);
    const crossed = crossedOf(v, alive());
    if (crossed.length === 0) break;
    plan.iterations = Math.max(plan.iterations, iteration);
    const level = crossed.reduce((min, c) => Math.min(min, c.level), Infinity);
    for (const c of crossed.filter((x) => x.level === level)) {
      v = view(summaries, records, storeOrder);
      const s = v.byId.get(c.id);
      if (!s) continue;
      const ps = positions(v, s);
      if (ps.length < 2 || ps[ps.length - 1] - ps[0] + 1 === ps.length) continue; // fixed by an earlier move this pass
      if (level === 1) {
        // Keep the largest contiguous run of messages; release the rest.
        const runs = runsOf(ps).sort((a, b) => b.length - a.length || a[0] - b[0]);
        const keep = new Set(runs[0].map((p) => v.byPosition[p]));
        const released = s.sourceIds.filter((id) => v.position.has(id) && !keep.has(id));
        s.sourceIds = s.sourceIds.filter((id) => !released.includes(id));
        for (const r of records) if (r.summaryId === s.id) r.sourceIds = r.sourceIds.filter((id) => !released.includes(id));
        for (const id of released) if (id in resolutions) { delete resolutions[id]; plan.resolutionsCleared++; }
        plan.splitL1.push({ id: s.id, kept: s.sourceIds.length, released });
        touched.add(s.id);
        continue;
      }
      // Children grouped into runs by their leaf spans; the run carrying the
      // most leaves stays, the others are fragments.
      const spans = s.sourceIds.map((childId) => {
        const child = v.byId.get(childId);
        const cps = child ? positions(v, child) : [];
        return { childId, min: cps[0], max: cps[cps.length - 1], count: cps.length };
      });
      const placed = spans.filter((x) => x.count > 0).sort((a, b) => a.min - b.min);
      const groups: Array<typeof placed> = [];
      let group: typeof placed = [];
      let end = -Infinity;
      for (const x of placed) {
        if (group.length && x.min !== end + 1) { groups.push(group); group = []; }
        group.push(x);
        end = Math.max(end, x.max);
      }
      if (group.length) groups.push(group);
      groups.sort((a, b) => b.reduce((n, x) => n + x.count, 0) - a.reduce((n, x) => n + x.count, 0) || a[0].min - b[0].min);
      const keep = new Set(groups[0].map((x) => x.childId));
      const fragments = placed.filter((x) => !keep.has(x.childId));
      const fragmentLeaves = fragments.reduce((n, x) => n + x.count, 0);
      const homeFor = (x: { min: number; max: number }, exclude: Set<string>): RepairSummary | undefined => {
        let best: RepairSummary | undefined;
        const grand = parentOf(s);
        for (const t of alive()) {
          if (t.level !== level || exclude.has(t.id)) continue;
          const tp = positions(v, t);
          if (tp.length === 0) continue;
          if (tp[tp.length - 1] + 1 !== x.min && x.max + 1 !== tp[0]) continue;
          if (!best || (grand !== undefined && parentOf(t) === grand && parentOf(best) !== grand)) best = t;
        }
        return best;
      };
      // Adoption: every hole is owned, one level down, by a root that is not
      // under this summary. The pyramid keeps its depth; the adopting
      // summary's prose does not cover the adopted content. Re-homing a
      // fragment costs the same kind of gap at its new home, so the two are
      // compared by leaves moved — unless some fragment has no home, in which
      // case detaching would unravel every ancestor and adoption wins.
      if (compact) {
        // Every hole must be owned by a root (any level below this summary,
        // not under it). Each such root is adopted DOWNWARD: into the
        // descendant of this summary one level above the root whose span is
        // adjacent to it (the crossed summary itself when the root is one
        // level down). The hole closes where it is; nothing above unravels.
        const allOwners = ownerAtLevel();
        const have = new Set(ps);
        const candidates = new Map<string, RepairSummary>();
        let adoptable = true;
        for (let p = ps[0]; p <= ps[ps.length - 1]; p++) {
          if (have.has(p)) continue;
          let top: RepairSummary | undefined;
          for (let lv = level - 1; lv >= 1 && !top; lv--) {
            const id = allOwners.get(lv)?.get(p);
            const o = id ? v.byId.get(id) : undefined;
            if (o && parentOf(o) === undefined) top = o;
          }
          if (!top || top.id === s.id) { adoptable = false; break; }
          candidates.set(top.id, top);
        }
        // The adopter for a root R at level j: the descendant of S at level j+1
        // whose span is adjacent to R (S itself when j+1 === S.level).
        const adopterFor = (root: RepairSummary): RepairSummary | undefined => {
          const rp = positions(v, root);
          if (rp.length === 0) return undefined;
          const rmin = rp[0], rmax = rp[rp.length - 1];
          let frontier: RepairSummary[] = [s];
          for (let lv = level; lv > root.level + 1; lv--) {
            const next: RepairSummary[] = [];
            for (const f of frontier) for (const cid of f.sourceIds) { const c = v.byId.get(cid); if (c) next.push(c); }
            frontier = next;
          }
          let best: RepairSummary | undefined;
          for (const c of frontier) {
            if (c.level !== root.level + 1) continue;
            if (c.id === s.id) { best = c; break; } // the hole is inside S by definition
            const cp = positions(v, c);
            if (cp.length === 0) continue;
            if (cp[cp.length - 1] + 1 === rmin || rmax + 1 === cp[0]) { best = c; break; }
          }
          return best;
        };
        if (adoptable && candidates.size > 0) {
          const targets = new Map<string, RepairSummary>();
          for (const [id, root] of candidates) { const t = adopterFor(root); if (!t) { adoptable = false; break; } targets.set(id, t); }
          if (adoptable) {
            let adoptedLeaves = 0;
            for (const [, root] of candidates) adoptedLeaves += positions(v, root).length;
            const exclude = new Set([s.id]);
            const allHomeable = fragments.every((x) => homeFor(x, exclude) !== undefined);
            if (adoptedLeaves <= fragmentLeaves || !allHomeable) {
              for (const [id, root] of candidates) {
                const t = targets.get(id)!;
                const leaves = positions(v, root).length;
                insertChild(t, id);
                plan.adopted.push({ id, level: root.level, into: t.id, leaves });
                v = view(summaries, records, storeOrder);
              }
              continue;
            }
          }
        }
      }
      // Detach the fragments, then re-home each under an adjacent summary at
      // this level (preferring the same parent), repeating while progress is
      // made: a fragment becomes homeable once its neighbour fragment is.
      for (const x of fragments) {
        const child = v.byId.get(x.childId)!;
        s.sourceIds = s.sourceIds.filter((id) => id !== x.childId);
        setParent(child, undefined);
        detachedIds.add(child.id);
        plan.detached.push({ id: child.id, level: child.level, from: s.id, leaves: x.count });
      }
      touched.add(s.id);
      let pending = compact ? [...fragments] : [];
      let progress = true;
      while (pending.length && progress) {
        progress = false;
        for (const x of [...pending]) {
          v = view(summaries, records, storeOrder);
          const best = homeFor(x, new Set([s.id]));
          if (!best) continue;
          insertChild(best, x.childId);
          detachedIds.delete(x.childId);
          plan.rehomed.push({ id: x.childId, from: s.id, into: best.id, leaves: x.count });
          pending = pending.filter((y) => y !== x);
          progress = true;
        }
      }
    }
    // Dissolve parents left with a single source, upward.
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of alive()) {
        if (s.level < 2 || s.sourceIds.length >= 2) continue;
        const [childId] = s.sourceIds;
        const child = childId ? v.byId.get(childId) : undefined;
        if (child) setParent(child, undefined);
        const parent = parentOf(s);
        if (parent) {
          const p = v.byId.get(parent);
          if (p) { p.sourceIds = p.sourceIds.filter((id) => id !== s.id); touched.add(p.id); }
        }
        remove(s.id);
        plan.dissolved.push({ id: s.id, level: s.level, child: childId ?? '' });
        changed = true;
      }
    }
  }

  if (options.releaseHead) {
    // Records that form a prefix of the store's owned messages and are either
    // uncompressed or linked to an L1 this plan detached: release them, so
    // the head window takes the messages back.
    v = view(summaries, records, storeOrder);
    const recordOf = new Map<string, RepairRecord>();
    for (const r of records) for (const id of r.sourceIds) recordOf.set(id, r);
    const movedIds = new Set([...detachedIds, ...plan.rehomed.map((r) => r.id)]);
    const all = options.releaseHead === 'all';
    const limit = options.releaseHeadLimit ?? Number.POSITIVE_INFINITY;
    const release = new Set<RepairRecord>();
    let releasedMessages = 0;
    for (const id of v.byPosition) {
      const r = recordOf.get(id);
      if (!r) break; // an L1-only owner (legacy) ends the prefix
      if (release.has(r)) continue;
      const l1 = r.summaryId !== undefined ? v.byId.get(r.summaryId) : undefined;
      // 'all' releases any prefix L1, parented or not: its parent is detached
      // from it and dissolves below if left with a single source.
      const releasable = !r.compressed ||
        (r.summaryId !== undefined && movedIds.has(r.summaryId)) ||
        (all && l1 !== undefined && l1.level === 1);
      if (!releasable) break;
      if (releasedMessages + r.sourceIds.length > limit) break;
      releasedMessages += r.sourceIds.length;
      release.add(r);
    }
    for (const r of release) {
      plan.released.push({ record: r.id, ...(r.summaryId ? { summaryId: r.summaryId } : {}), leaves: [...r.sourceIds] });
      for (const id of r.sourceIds) if (id in resolutions) { delete resolutions[id]; plan.resolutionsCleared++; }
      if (r.summaryId) {
        const s = v.byId.get(r.summaryId);
        const parent = s ? parentOf(s) : undefined;
        if (parent) { const p = v.byId.get(parent); if (p) { p.sourceIds = p.sourceIds.filter((id) => id !== r.summaryId); touched.add(p.id); } }
        remove(r.summaryId);
        plan.rehomed = plan.rehomed.filter((x) => x.id !== r.summaryId);
      }
    }
    records = records.filter((r) => !release.has(r));
    // A parent emptied to a single source by the release dissolves like any other.
    let changed = release.size > 0;
    while (changed) {
      changed = false;
      for (const s of alive()) {
        if (s.level < 2 || s.sourceIds.length >= 2) continue;
        const [childId] = s.sourceIds;
        const child = childId ? v.byId.get(childId) : undefined;
        if (child) setParent(child, undefined);
        const parent = parentOf(s);
        if (parent) { const p = v.byId.get(parent); if (p) { p.sourceIds = p.sourceIds.filter((id) => id !== s.id); touched.add(p.id); } }
        remove(s.id);
        plan.dissolved.push({ id: s.id, level: s.level, child: childId ?? '' });
        changed = true;
      }
    }
  }

  // Recompute sourceRange for touched summaries and their ancestors.
  v = view(summaries, records, storeOrder);
  const span = (s: RepairSummary): { first: string; last: string } | null => {
    const ps = positions(v, s);
    return ps.length ? { first: v.byPosition[ps[0]], last: v.byPosition[ps[ps.length - 1]] } : null;
  };
  const queue = [...touched];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = v.byId.get(id);
    if (!s) continue;
    const to = span(s);
    const from = originalRange.get(id) ?? s.sourceRange;
    if (to && (to.first !== from.first || to.last !== from.last)) { s.sourceRange = to; plan.rangeChanges.push({ id, from, to }); }
    const parent = parentOf(s);
    if (parent) queue.push(parent);
  }

  // Clamp kv-stable resolutions to the leaf's remaining chain depth.
  const depthOfL1 = new Map<string, number>();
  for (const id of v.liveL1) {
    let depth = 1; let cur = v.byId.get(id); const trail = new Set<string>();
    while (cur && parentOf(cur) && !trail.has(cur.id)) { trail.add(cur.id); cur = v.byId.get(parentOf(cur)!); if (cur) depth++; }
    depthOfL1.set(id, depth);
  }
  const l1OfLeaf = new Map<string, string>();
  for (const id of v.liveL1) for (const leaf of v.byId.get(id)!.sourceIds) l1OfLeaf.set(leaf, id);
  for (const [leaf, level] of Object.entries(resolutions)) {
    const l1 = l1OfLeaf.get(leaf);
    const deepest = l1 ? depthOfL1.get(l1)! : 0;
    if (typeof level === 'number' && level > deepest) { if (deepest === 0) delete resolutions[leaf]; else resolutions[leaf] = deepest; plan.resolutionsClamped++; }
  }

  v = view(summaries, records, storeOrder);
  const depthAfter = leafDepths(v);
  for (const [leaf, d] of depthBefore) { const a = depthAfter.get(leaf) ?? 0; if (a < d) plan.depthLostLeaves++; }
  plan.proseGapLeaves = plan.adopted.reduce((n, a) => n + a.leaves, 0) + plan.rehomed.reduce((n, r) => n + r.leaves, 0);
  finalStrays?.();
  const keptRecords = loadedChunkRecords<RepairRecord>(structuredClone(records));
  const again = settleStoredSummaries<RepairSummary>(structuredClone(summaries), keptRecords);
  const againRecords = releaseUnsummarizedRecords(keptRecords, again.summaries);
  const written = view(again.summaries, againRecords.records, storeOrder);
  plan.remaining = crossedOf(written, again.summaries);
  plan.resettled = {
    ...(settlingRepaired(again) ? { line: settleRepairLine(again) } : {}),
    filteredRecords: records.length - keptRecords.length,
    releasedRecords: againRecords.released,
  };
  plan.result = { summaries: again.summaries, records: againRecords.records, resolutions };
  return plan;
}

/** Deepest fold level available to each owned leaf (its live L1's chain length). */
function leafDepths(v: View): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of v.liveL1) {
    let depth = 1; let cur = v.byId.get(id); const trail = new Set<string>();
    while (cur && parentOf(cur) && !trail.has(cur.id)) { trail.add(cur.id); cur = v.byId.get(parentOf(cur)!); if (cur) depth++; }
    for (const leaf of v.byId.get(id)!.sourceIds) out.set(leaf, depth);
  }
  return out;
}
