/**
 * The fold journal: an append-only record of when a resident's rendered
 * context changed resolution, written at accepted provider rounds.
 *
 * A compile produces a rendered layout (see compile-provenance.ts). When the
 * host confirms that a provider round carrying that compile succeeded, it
 * hands the compile's provenance back (`ContextManager.acceptRound`). The
 * journal compares the layout with the last layout accepted on the same
 * branch, only over messages present in both, and appends one receipt when
 * any of them changed form: raw to summary, one summary to another, summary
 * to raw, rendered to omitted, omitted to rendered, or a raw copy becoming
 * partial or complete. Messages that arrived since the last accepted round
 * are arrivals, not folds. The first accepted round on a branch the journal
 * has never recorded writes a baseline receipt that says history before it
 * is unknown.
 *
 * Storage is Chronicle typed records, not branch state: typed records are
 * enumerable from any branch and survive branch deletion, so every branch's
 * receipts stay queryable and a round can be accepted onto the branch it was
 * compiled on even after another branch was selected. Two record types:
 *
 * - `context-manager/store-identity`: minted once per store; names the
 *   store in every receipt.
 * - `context-manager/accepted-layout`: one per accepted compile, holding the
 *   branch's new last accepted layout (a snapshot, or a delta on the
 *   previous record; an unchanged layout is an empty delta) AND the fold
 *   receipt that acceptance produced, if any. One record is one commit: a
 *   receipt can never exist without the layout it was compared into, or the
 *   reverse, so a crash or a failed append between the two cannot duplicate
 *   or lose a receipt. Diffs read only these persisted units, never the live
 *   message view.
 *
 * The records are the journal's only truth; what a journal keeps in memory
 * is a cache it checks against them. Every acceptance compares with the
 * branch's newest record in the store, whichever journal on the store wrote
 * it. A compile is accepted once: a retry finds the record its first
 * acceptance wrote, whether that acceptance reported success, reported
 * failure after landing, ran in another journal, or ran before a reopen.
 *
 * Records that name messages or summaries assert state committed in branch
 * slots, which Chronicle buffers until sync, so every write syncs first.
 */

import { randomUUID } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import type { BranchRef, CompileProvenance, LayoutUnit, RenderedLayout } from './types/index.js';

export const STORE_IDENTITY_RECORD = 'context-manager/store-identity';
export const ACCEPTED_LAYOUT_RECORD = 'context-manager/accepted-layout';

/** A delta chain longer than this is replaced by a fresh snapshot. */
const SNAPSHOT_EVERY = 64;
/** history--folds' limit bounds. */
export const FOLD_QUERY_DEFAULT_LIMIT = 10;
export const FOLD_QUERY_MAX_LIMIT = 100;

/** Provider usage of the round that confirmed a layout, as reported. */
export interface RoundUsage {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Deployment facts the host supplies; recorded in every receipt as written. */
export interface ReceiptSource {
  runtime?: string;
  dataDirectory?: string;
  agent?: string;
}

export type FoldForm =
  | { form: 'raw'; partial?: true }
  | { form: 'summary'; level: number; summaries: Array<{ id: string; level: number; method: string; partial?: true }> }
  | { form: 'omitted' };

export interface FoldSpanBound {
  sequence: number;
  messageId: string;
}

/** One run of messages whose form changed, as rendered before and after. */
export interface FoldChange {
  first: FoldSpanBound;
  last: FoldSpanBound;
  /** How many messages the run holds (exact: present in both layouts). */
  messages?: number;
  before: FoldForm;
  after: FoldForm;
  /** Estimated rendered tokens of the run in each form (a summary is counted
   *  once per receipt side, in the first run it appears in). */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

/** One run of a baseline's layout, as rendered then. */
export interface FoldLayoutRun {
  first: FoldSpanBound;
  last: FoldSpanBound;
  messages?: number;
  form: FoldForm;
  estimatedTokens: number;
}

export interface FoldReceiptSource {
  runtime: string;
  storeId: string;
  agent: string;
  namespace: string;
  dataDirectory: string;
  branch: BranchRef;
}

export interface FoldReceipt {
  v: 1;
  /** The journal record's id: stable, ordered, usable as `since`. */
  id: string;
  kind: 'baseline' | 'change';
  /** When the confirming round was accepted. Context only, never identity. */
  acceptedAt: string;
  /** The log these sequences and ids belong to. */
  source: FoldReceiptSource;
  compileId: string;
  strategy: string;
  /** 'change': the runs whose form changed. */
  changes?: FoldChange[];
  /** 'baseline': the whole layout as rendered then; history before it is unknown. */
  layout?: FoldLayoutRun[];
  historyBefore?: 'unknown';
  renderedTokens: { before: number | 'unknown'; after: number };
  cause: string;
  /** The confirming round's usage. It belongs to the whole round: no part of
   *  it is the cost of the fold. */
  usage: { input: number | 'unknown'; cacheRead: number | 'unknown'; cacheWrite: number | 'unknown'; scope: 'round' };
  /**
   * How the confirming round carried this compile, as its producer reported:
   * `verbatim` (every consumer message carried as compiled), `altered` (some
   * consumer content was not carried verbatim), or `unknown` (the producer
   * could not establish it, or did not report). The layout is the compile's;
   * only `verbatim` makes it exactly what the resident was shown.
   */
  presentation: Presentation;
  /** Estimates use the store's calibration at acceptance. */
  estimate: { calibration: number };
}

export type Presentation = 'verbatim' | 'altered' | 'unknown';

export interface FoldQuery {
  /** A receipt id (receipts after it) or an ISO time (accepted at or after). */
  since?: string;
  limit?: number;
  /** Branch name; the selected branch when omitted. */
  branch?: string;
}

export interface FoldQueryResult {
  branch: BranchRef | null;
  receipts: FoldReceipt[];
  /** Newest receipt id on that branch, if any. */
  latestId: string | null;
  /** Explains an empty or unknown answer (unknown branch, no layout reporting). */
  note?: string;
}

interface AcceptedLayoutRecord {
  v: 1;
  ns: string;
  branch: BranchRef;
  compileId: string;
  kind: 'snapshot' | 'delta';
  units?: LayoutUnit[];
  prev?: string;
  p?: number;
  drop?: number;
  ins?: LayoutUnit[];
  app?: LayoutUnit[];
  totalTokens: number;
  chain: number;
  /** The receipt this acceptance produced; its id is the record's id. */
  receipt?: Omit<FoldReceipt, 'id'>;
}

interface LatestLayout {
  recordId: string;
  /** The receipt this record embedded, if any (its id is the record id). */
  receipt?: FoldReceipt;
  units: LayoutUnit[];
  totalTokens: number;
  chain: number;
}

const storeIdentityCache = new WeakMap<JsStore, string>();

/** The store's id, minted once (as a typed record) on first use. */
export function storeIdentity(store: JsStore): string {
  const cached = storeIdentityCache.get(store);
  if (cached) return cached;
  const ids = store.getRecordIdsByType(STORE_IDENTITY_RECORD);
  for (const id of ids) {
    const parsed = readRecord<{ storeId?: unknown }>(store, id);
    if (parsed && typeof parsed.storeId === 'string' && parsed.storeId) {
      storeIdentityCache.set(store, parsed.storeId);
      return parsed.storeId;
    }
  }
  const storeId = randomUUID();
  store.appendJson(STORE_IDENTITY_RECORD, { v: 1, storeId, mintedAt: new Date().toISOString() });
  store.sync();
  storeIdentityCache.set(store, storeId);
  return storeId;
}

export function branchRefOf(store: JsStore): BranchRef {
  const b = store.currentBranch();
  return { id: b.id, name: b.name, created: b.created };
}

export function branchKey(branch: BranchRef): string {
  return `${branch.id}@${branch.created}`;
}

function readRecord<T>(store: JsStore, id: string): T | null {
  const record = store.getRecord(id);
  if (!record) return null;
  try {
    return JSON.parse(record.payload.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export class FoldJournal {
  private source: ReceiptSource = {};
  /** Each branch's last accepted layout as this journal last read or wrote
   *  it; checked against the store before every use. */
  private readonly latest = new Map<string, LatestLayout>();
  private readonly listeners = new Set<(receipt: FoldReceipt) => void>();
  /** Receipt ids this journal has announced to its listeners. */
  private readonly notified = new Set<string>();
  /** Parsed receipts of this namespace by record id, and how far the global
   *  receipt list has been read. */
  private readonly receipts = new Map<string, FoldReceipt>();
  private receiptIdsSeen = 0;

  constructor(
    private readonly store: JsStore,
    private readonly namespace: string,
  ) {}

  setSource(source: ReceiptSource): void {
    this.source = { ...this.source, ...source };
  }

  onReceipt(listener: (receipt: FoldReceipt) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Accept the layout of a compile whose provider round succeeded. Writes a
   * receipt when the layout changed form relative to the last accepted layout
   * on the compile's branch (or a baseline when that branch has none), and
   * records the layout as the branch's last accepted one. Idempotent per
   * compile. Returns the receipt written, if any.
   */
  accept(
    provenance: CompileProvenance,
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation = 'unknown',
  ): FoldReceipt | null {
    const layout = provenance.layout;
    if (!layout || provenance.namespace !== this.namespace) return null;
    const ids = this.store.getRecordIdsByType(ACCEPTED_LAYOUT_RECORD);
    const key = branchKey(provenance.branch);
    const prev = this.loadLatest(key, ids);
    // The branch's latest committed record may hold a receipt this journal
    // never announced: its write reported failure after landing, in this
    // stream or the turn before, or another journal wrote it. Announce it now,
    // whatever this compile turns out to be, so listeners (a projection)
    // converge on the canonical record.
    if (prev?.receipt) this.announce(prev.receipt);
    if (this.alreadyAccepted(provenance, layout, ids)) return null;

    let draft: Omit<FoldReceipt, 'id'> | null = null;
    if (!prev) {
      draft = this.baselineReceipt(provenance, layout, acceptedAt, usage, presentation);
    } else {
      const changes = diffLayouts(prev.units, layout.units, layout.calibration);
      if (changes.length > 0) draft = this.changeReceipt(provenance, layout, prev, changes, acceptedAt, usage, presentation);
    }
    const receipt = this.commit(provenance, layout, prev, draft);
    if (receipt) this.announce(receipt);
    return receipt;
  }

  /**
   * Whether a record of this namespace already accepted this compile. Every
   * message a layout names was stored before its compile ran, and Chronicle
   * gives every record a larger id than all before it, so the compile's own
   * acceptance can only be newer than the newest message its layout names:
   * the search reads only those records (all of them for a layout that
   * names none). Chronicle reissues ids only after truncating a torn tail on
   * open; a compile from before that crash can name lost messages whose ids
   * now belong to newer records, so after such a recovery the search reads
   * every record.
   */
  private alreadyAccepted(provenance: CompileProvenance, layout: RenderedLayout, ids: readonly string[]): boolean {
    const floor = this.store.recovery() ? -1 : newestNamed(layout.units);
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = Number(ids[i]);
      if (Number.isSafeInteger(id) && id <= floor) break;
      const record = readRecord<AcceptedLayoutRecord>(this.store, ids[i]!);
      if (record && record.v === 1 && record.ns === this.namespace && record.compileId === provenance.compileId) return true;
    }
    return false;
  }

  /** Tell listeners about a receipt, once per receipt per journal. */
  private announce(receipt: FoldReceipt): void {
    if (this.notified.has(receipt.id)) return;
    this.notified.add(receipt.id);
    this.receipts.set(receipt.id, receipt);
    for (const listener of this.listeners) {
      try {
        listener(receipt);
      } catch (err) {
        console.error('[fold-journal] receipt listener failed:', err);
      }
    }
  }

  /** Receipts of one branch, newest first, filtered per `query`. */
  query(query: FoldQuery = {}): FoldQueryResult {
    const branch = this.resolveBranch(query.branch);
    if (!branch) {
      return {
        branch: null,
        receipts: [],
        latestId: null,
        note: `No branch named ${JSON.stringify(query.branch)} exists in this store.`,
      };
    }
    const limit = clampLimit(query.limit);
    const all = this.receiptsFor(branch);
    const latestId = all.length > 0 ? all[all.length - 1]!.id : null;
    let selected = all;
    if (query.since !== undefined) {
      selected = filterSince(all, query.since);
    }
    const newestFirst = [...selected].reverse().slice(0, limit);
    return { branch, receipts: newestFirst, latestId };
  }

  /** Every receipt of a branch, oldest first: what a projection writes. */
  receiptsFor(branch: BranchRef): FoldReceipt[] {
    this.refreshReceipts();
    const key = branchKey(branch);
    const out: FoldReceipt[] = [];
    for (const receipt of this.receipts.values()) {
      if (branchKey(receipt.source.branch) === key) out.push(receipt);
    }
    out.sort((a, b) => Number(a.id) - Number(b.id));
    return out;
  }

  /** The store's id (minted on first use). */
  storeId(): string {
    return storeIdentity(this.store);
  }

  // --------------------------------------------------------------------------

  private resolveBranch(name: string | undefined): BranchRef | null {
    if (name === undefined) return branchRefOf(this.store);
    const match = this.store.listBranches().find((b) => b.name === name);
    if (match) return { id: match.id, name: match.name, created: match.created };
    // A deleted branch's receipts remain in the journal: find it there.
    this.refreshReceipts();
    let found: BranchRef | null = null;
    for (const receipt of this.receipts.values()) {
      if (receipt.source.branch.name === name) found = receipt.source.branch;
    }
    return found;
  }

  private refreshReceipts(): void {
    const ids = this.store.getRecordIdsByType(ACCEPTED_LAYOUT_RECORD);
    for (let i = this.receiptIdsSeen; i < ids.length; i++) {
      const id = ids[i]!;
      const record = readRecord<AcceptedLayoutRecord>(this.store, id);
      if (!record || record.v !== 1 || record.ns !== this.namespace || !record.receipt) continue;
      this.receipts.set(id, { ...record.receipt, id } as FoldReceipt);
    }
    this.receiptIdsSeen = ids.length;
  }

  private sourceFor(provenance: CompileProvenance): FoldReceiptSource {
    return {
      runtime: this.source.runtime ?? 'unknown',
      storeId: this.storeId(),
      agent: this.source.agent ?? 'unknown',
      namespace: this.namespace,
      dataDirectory: this.source.dataDirectory ?? 'unknown',
      branch: provenance.branch,
    };
  }

  private common(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation,
  ) {
    return {
      v: 1 as const,
      acceptedAt: new Date(acceptedAt).toISOString(),
      source: this.sourceFor(provenance),
      compileId: provenance.compileId,
      strategy: provenance.strategy,
      cause: layout.cause ?? 'unknown',
      usage: {
        input: knownOrUnknown(usage?.inputTokens),
        cacheRead: knownOrUnknown(usage?.cacheReadTokens),
        cacheWrite: knownOrUnknown(usage?.cacheCreationTokens),
        scope: 'round' as const,
      },
      estimate: { calibration: layout.calibration },
      presentation,
    };
  }

  private baselineReceipt(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation,
  ): Omit<FoldReceipt, 'id'> {
    return {
      ...this.common(provenance, layout, acceptedAt, usage, presentation),
      kind: 'baseline',
      historyBefore: 'unknown',
      layout: layoutRuns(layout.units, layout.calibration),
      renderedTokens: { before: 'unknown', after: calibrated(layout.totalTokens, layout.calibration) },
    };
  }

  private changeReceipt(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    prev: LatestLayout,
    changes: FoldChange[],
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation,
  ): Omit<FoldReceipt, 'id'> {
    return {
      ...this.common(provenance, layout, acceptedAt, usage, presentation),
      kind: 'change',
      changes,
      renderedTokens: {
        before: calibrated(prev.totalTokens, layout.calibration),
        after: calibrated(layout.totalTokens, layout.calibration),
      },
    };
  }

  /**
   * Commit one acceptance: the branch's new last accepted layout together
   * with its receipt (if any), as ONE record. Returns the receipt.
   *
   * Every acceptance writes its record, an unchanged layout included (an
   * empty delta), so a retry of any accepted compile finds it. A failed
   * append may or may not have landed, so the branch's cached latest layout
   * is dropped: the next acceptance rereads the records, and finds this
   * compile already accepted if its record did land, instead of writing a
   * second receipt.
   */
  private commit(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    prev: LatestLayout | null,
    draft: Omit<FoldReceipt, 'id'> | null,
  ): FoldReceipt | null {
    const key = branchKey(provenance.branch);
    const base = {
      v: 1 as const,
      ns: this.namespace,
      branch: provenance.branch,
      compileId: provenance.compileId,
      totalTokens: layout.totalTokens,
    };
    const delta = prev && prev.chain < SNAPSHOT_EVERY ? layoutDelta(prev.units, layout.units) : null;
    const record: AcceptedLayoutRecord = prev && delta
      ? { ...base, kind: 'delta', prev: prev.recordId, ...delta, chain: prev.chain + 1 }
      : { ...base, kind: 'snapshot', units: layout.units, chain: 0 };
    if (draft) record.receipt = draft;

    let written: { id: string };
    try {
      // The record names state committed in branch slots (messages,
      // summaries): make that state durable before asserting it.
      this.store.sync();
      written = this.store.appendJson(ACCEPTED_LAYOUT_RECORD, record);
    } catch (err) {
      this.latest.delete(key);
      throw err;
    }
    const receipt = draft ? ({ ...draft, id: written.id } as FoldReceipt) : undefined;
    this.latest.set(key, {
      recordId: written.id,
      ...(receipt ? { receipt } : {}),
      units: layout.units,
      totalTokens: layout.totalTokens,
      chain: record.chain,
    });
    if (!receipt) return null;
    this.receipts.set(written.id, receipt);
    return receipt;
  }

  /**
   * The last accepted layout of a branch: the newest record of this
   * namespace and branch in the store, whichever journal on the store wrote
   * it. `ids` are the store's accepted-layout record ids, oldest first. The
   * cached layout stands when no record of the branch is newer than it, so
   * only the records appended since it are read.
   */
  private loadLatest(key: string, ids: readonly string[]): LatestLayout | null {
    const cached = this.latest.get(key);
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!;
      if (cached && id === cached.recordId) return cached;
      const record = readRecord<AcceptedLayoutRecord>(this.store, id);
      if (!record || record.v !== 1 || record.ns !== this.namespace || branchKey(record.branch) !== key) continue;
      const units = this.reconstruct(id, record);
      if (!units) break;
      const latest: LatestLayout = {
        recordId: id,
        ...(record.receipt ? { receipt: { ...record.receipt, id } as FoldReceipt } : {}),
        units,
        totalTokens: record.totalTokens,
        chain: record.chain,
      };
      this.latest.set(key, latest);
      return latest;
    }
    this.latest.delete(key);
    return null;
  }

  private reconstruct(id: string, record: AcceptedLayoutRecord): LayoutUnit[] | null {
    const chain: AcceptedLayoutRecord[] = [];
    let current: AcceptedLayoutRecord | null = record;
    let currentId = id;
    while (current && current.kind === 'delta') {
      chain.push(current);
      if (!current.prev) return null;
      currentId = current.prev;
      current = readRecord<AcceptedLayoutRecord>(this.store, currentId);
    }
    if (!current || !current.units) {
      console.error(`[fold-journal] accepted-layout chain from record ${id} is broken; treating the branch as unrecorded`);
      return null;
    }
    let units = current.units;
    for (let i = chain.length - 1; i >= 0; i--) units = applyDelta(units, chain[i]!);
    return units;
  }
}

function knownOrUnknown(value: number | undefined): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

function calibrated(base: number, calibration: number): number {
  return Math.round(base * (Number.isFinite(calibration) && calibration > 0 ? calibration : 1));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return FOLD_QUERY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer (got ${String(limit)})`);
  }
  return Math.min(limit, FOLD_QUERY_MAX_LIMIT);
}

function filterSince(receipts: FoldReceipt[], since: string): FoldReceipt[] {
  if (/^\d+$/.test(since)) {
    const pivot = Number(since);
    return receipts.filter((r) => Number(r.id) > pivot);
  }
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) {
    throw new Error(`since must be a receipt id or an ISO time (got ${JSON.stringify(since)})`);
  }
  return receipts.filter((r) => Date.parse(r.acceptedAt) >= ms);
}

// ============================================================================
// Layout comparison (persisted units only)
// ============================================================================

function startOf(u: LayoutUnit): number { return u.k === 'r' ? u.s : u.a; }
function endOf(u: LayoutUnit): number { return u.k === 'r' ? u.s : u.b; }
function startIdOf(u: LayoutUnit): string { return u.k === 'r' ? u.id : u.ai; }
function endIdOf(u: LayoutUnit): string { return u.k === 'r' ? u.id : u.bi; }

/** How many messages a unit holds: exact, from its membership runs. */
function memberCount(u: LayoutUnit): number {
  if (u.k === 'r') return 1;
  let n = 0;
  for (const [first, , last] of u.m) n += last - first + 1;
  return n;
}

function formKey(u: LayoutUnit): string {
  if (u.k === 'r') return u.p ? 'r:p' : 'r';
  if (u.k === 's') return `s:${u.sm.map((s) => `${s[0]}${s[3] ? '~' : ''}`).join(',')}`;
  return 'o';
}

function formOf(u: LayoutUnit): FoldForm {
  if (u.k === 'r') return u.p ? { form: 'raw', partial: true } : { form: 'raw' };
  if (u.k === 's') {
    return {
      form: 'summary',
      level: Math.max(...u.sm.map((s) => s[1])),
      summaries: u.sm.map(([id, level, method, partial]) => (partial ? { id, level, method, partial: true as const } : { id, level, method })),
    };
  }
  return { form: 'omitted' };
}

/** A contiguous run of member sequences of one unit. */
interface Segment {
  start: number;
  startId: string;
  end: number;
  endId: string;
  unit: number;
}

/** Every unit's exact membership, as runs in sequence order. */
function segmentsOf(units: readonly LayoutUnit[]): Segment[] {
  const out: Segment[] = [];
  units.forEach((u, unit) => {
    if (u.k === 'r') {
      out.push({ start: u.s, startId: u.id, end: u.s, endId: u.id, unit });
    } else {
      for (const [start, startId, end, endId] of u.m) out.push({ start, startId, end, endId, unit });
    }
  });
  return out;
}

/**
 * Compare two layouts over exactly the messages present in both. Each
 * layout's membership is a list of runs of consecutive sequences; the walk
 * intersects runs, so a message one view lacked (removed, filtered out)
 * never counts, even when it lies between a range's endpoints. Each
 * intersection whose forms differ is a change, and adjacent changes with the
 * same before/after forms merge into one run. Boundaries, ids and message
 * counts are exact; tokens count each raw message once, and each summary
 * once per side, in the first changed run that names it.
 */
export function diffLayouts(before: readonly LayoutUnit[], after: readonly LayoutUnit[], calibration: number): FoldChange[] {
  const changes: FoldChange[] = [];
  const countedBefore = new Set<string>();
  const countedAfter = new Set<string>();
  let open: (FoldChange & { key: string }) | null = null;
  const flush = () => {
    if (!open) return;
    const { key: _key, ...change } = open;
    changes.push(change);
    open = null;
  };

  const A = segmentsOf(before);
  const B = segmentsOf(after);
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const a = A[i]!;
    const b = B[j]!;
    if (a.end < b.start) { i++; continue; }
    if (b.end < a.start) { j++; continue; }
    const lo = Math.max(a.start, b.start);
    const hi = Math.min(a.end, b.end);
    const loId = a.start >= b.start ? a.startId : b.startId;
    const hiId = a.end <= b.end ? a.endId : b.endId;
    const u = before[a.unit]!;
    const v = after[b.unit]!;
    const keyBefore = formKey(u);
    const keyAfter = formKey(v);

    if (keyBefore === keyAfter) {
      flush();
    } else {
      const tokensBefore = unitTokens(u, countedBefore);
      const tokensAfter = unitTokens(v, countedAfter);
      const key = `${keyBefore}>${keyAfter}`;
      const count = hi - lo + 1;
      if (open && open.key === key) {
        open.last = { sequence: hi, messageId: hiId };
        open.estimatedTokensBefore += tokensBefore;
        open.estimatedTokensAfter += tokensAfter;
        open.messages = (open.messages ?? 0) + count;
      } else {
        flush();
        open = {
          key,
          first: { sequence: lo, messageId: loId },
          last: { sequence: hi, messageId: hiId },
          messages: count,
          before: formOf(u),
          after: formOf(v),
          estimatedTokensBefore: tokensBefore,
          estimatedTokensAfter: tokensAfter,
        };
      }
    }

    if (a.end < b.end) i++;
    else if (b.end < a.end) j++;
    else { i++; j++; }
  }
  flush();
  for (const change of changes) {
    change.estimatedTokensBefore = calibrated(change.estimatedTokensBefore, calibration);
    change.estimatedTokensAfter = calibrated(change.estimatedTokensAfter, calibration);
  }
  return changes;
}

/**
 * A unit's rendered tokens on one side of a comparison: a raw message's own
 * (a raw unit is one message, met once per side), and each summary's the
 * first time that side meets it. `counted` holds the summaries met so far.
 */
function unitTokens(u: LayoutUnit, counted: Set<string>): number {
  if (u.k === 'r') return u.t;
  if (u.k === 'o') return 0;
  let tokens = 0;
  for (const [id, , , , t] of u.sm) {
    if (counted.has(id)) continue;
    counted.add(id);
    tokens += t;
  }
  return tokens;
}

/**
 * A baseline's layout as runs: consecutive raw units grouped. Each summary's
 * tokens count once, in the first run that names it.
 */
export function layoutRuns(units: readonly LayoutUnit[], calibration: number): FoldLayoutRun[] {
  const runs: FoldLayoutRun[] = [];
  const counted = new Set<string>();
  for (const u of units) {
    const last = runs[runs.length - 1];
    if (u.k === 'r' && last && last.form.form === 'raw' && Boolean(last.form.partial) === Boolean(u.p)) {
      last.last = { sequence: u.s, messageId: u.id };
      last.messages = (last.messages ?? 0) + 1;
      last.estimatedTokens += u.t;
      continue;
    }
    runs.push({
      first: { sequence: startOf(u), messageId: startIdOf(u) },
      last: { sequence: endOf(u), messageId: endIdOf(u) },
      messages: memberCount(u),
      form: formOf(u),
      estimatedTokens: unitTokens(u, counted),
    });
  }
  for (const run of runs) run.estimatedTokens = calibrated(run.estimatedTokens, calibration);
  return runs;
}

/**
 * The newest record id a layout names (-1 when it names none): its raw
 * messages and the first and last member of each range's runs. Every one of
 * them was stored before the layout's compile ran.
 */
function newestNamed(units: readonly LayoutUnit[]): number {
  let newest = -1;
  const see = (id: string): void => {
    const n = Number(id);
    if (Number.isSafeInteger(n) && n > newest) newest = n;
  };
  for (const u of units) {
    if (u.k === 'r') {
      see(u.id);
      continue;
    }
    for (const [, firstId, , lastId] of u.m) {
      see(firstId);
      see(lastId);
    }
  }
  return newest;
}

// ============================================================================
// Layout deltas
// ============================================================================

function unitEqual(a: LayoutUnit, b: LayoutUnit): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Express `next` as an edit of `prev`: keep a common prefix of `p` units,
 * drop `drop` units, insert `ins`, keep the rest of `prev`, then append
 * `app`. Arrivals become `app`; a fold in the middle becomes drop/ins. Null
 * when `prev`'s last unit is not in `next` (a snapshot is simpler then).
 */
export function layoutDelta(prev: readonly LayoutUnit[], next: readonly LayoutUnit[]): { p: number; drop: number; ins: LayoutUnit[]; app: LayoutUnit[] } | null {
  let p = 0;
  while (p < prev.length && p < next.length && unitEqual(prev[p]!, next[p]!)) p++;
  if (p === prev.length) return { p, drop: 0, ins: [], app: next.slice(p) };
  const lastPrev = prev[prev.length - 1]!;
  let j = -1;
  for (let k = next.length - 1; k >= p; k--) {
    if (unitEqual(next[k]!, lastPrev)) { j = k; break; }
  }
  if (j < 0) return null;
  let r = 0;
  while (
    prev.length - 1 - r >= p &&
    j - r >= p &&
    unitEqual(prev[prev.length - 1 - r]!, next[j - r]!)
  ) r++;
  return {
    p,
    drop: prev.length - r - p,
    ins: next.slice(p, j + 1 - r),
    app: next.slice(j + 1),
  };
}

function applyDelta(prev: readonly LayoutUnit[], record: AcceptedLayoutRecord): LayoutUnit[] {
  const p = record.p ?? 0;
  const drop = record.drop ?? 0;
  return [...prev.slice(0, p), ...(record.ins ?? []), ...prev.slice(p + drop), ...(record.app ?? [])];
}
