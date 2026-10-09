import { createHash } from 'node:crypto';
import type { ChunkId } from './folding-strategy.js';
import type { PresentedLeaf, ProviderCacheReference } from './kv-unified-policy.js';

export interface PendingPresentationSubmission {
  submissionId: string;
  requestHash: string;
  layoutHash: string;
  leaves: ReadonlyMap<ChunkId, PresentedLeaf>;
}

export interface PresentationDelta {
  leafId: ChunkId;
  value: PresentedLeaf | null;
}

export interface PresentationReceipt {
  sequence: number;
  receiptHash: string;
  parentReceiptHash: string | null;
  submissionId: string;
  requestHash: string;
  layoutHash: string;
  acceptedAt: number;
  changes: readonly PresentationDelta[];
}

export interface ReceiptChainSnapshot {
  head: PresentationReceipt | null;
  leaves: ReadonlyMap<ChunkId, PresentedLeaf>;
  cache: ProviderCacheReference | null;
  wireReceipt?: ObservedCacheWireReceipt | null;
}

export interface ObservedCacheWireReceipt {
  requestHash: string;
  acceptedAt: number;
  markers: Array<{ ordinal: number; prefixHash: string; estimatedOffset: number }>;
}

/** A run of raw (unfolded) leaves. A raw leaf's `repHash` is exactly
 * `raw:<its id>`, so it is derived from the id on decode instead of being
 * stored per leaf; a `repHash` that merely looks like one but does not
 * match the id stays a literal `PresentedLeaf`. */
export interface RawLeafRun {
  raw: true;
  level: number;
  lastChangedSeq: number;
}

/** One run of the run-length encoded leaf table: consecutive leaves (in
 * presentation order) that share the same `PresentedLeaf`, or that are all
 * raw with the same `level` and `lastChangedSeq`. Every chunk folded under
 * one summary shares its representative, so a 23k-leaf table from a
 * six-week session is a few dozen runs (#148).
 *
 * `ids` is the run's leaf ids, gap-coded: a string is a literal id; a positive
 * integer `k` is "the previous id plus k"; a negative integer `-n` is "the next
 * n ids, each the previous plus one". Only canonical-decimal ids (no sign, no
 * leading zeros, safe-integer range) take part in the arithmetic, so the
 * exact id strings and their order survive a round trip; any other id
 * (`"007"`, `"a"`) is kept verbatim and restarts the arithmetic. */
export interface LeafRun {
  value: PresentedLeaf | RawLeafRun | null;
  ids: Array<ChunkId | number>;
}

/** Upper bound on the leaves one persisted table (or change list) may expand
 * to, checked from the gap codes BEFORE any expansion so a corrupt `-n`
 * cannot allocate without limit. Two orders of magnitude above the longest
 * session seen (23k leaves after six weeks). */
export const MAX_DECODED_LEAVES = 2_097_152;

export interface SerializedReceiptHead extends Omit<PresentationReceipt, 'changes'> {
  changeRuns: LeafRun[];
}

/** The persisted form before #148: one `[id, leaf]` pair per presented leaf,
 * so every write cost O(messages) bytes and the record log grew as
 * O(accepted calls × messages). Still accepted by `deserialize`; never
 * written. */
export interface SerializedReceiptChainV1 {
  head: PresentationReceipt | null;
  leaves: Array<[ChunkId, PresentedLeaf]>;
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
}

export interface SerializedReceiptChainV2 {
  format: 2;
  head: SerializedReceiptHead | null;
  leafRuns: LeafRun[];
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
}

export type SerializedReceiptChain = SerializedReceiptChainV1 | SerializedReceiptChainV2;

/** Settled submission ids are only consulted to make a late accept/fail for
 * an already-settled flight a no-op; the persisted form always carried the
 * last 256, this bounds the in-memory set the same way. */
const SETTLED_RETAINED = 256;

/** Pure single-flight receipt state machine. Persistence is layered on its
 * serializable snapshots by the strategy. Identical-layout keepalives update
 * cache state but deliberately do not advance presentation continuity. */
export class KvUnifiedReceiptChain {
  private headValue: PresentationReceipt | null;
  private leavesValue: Map<ChunkId, PresentedLeaf>;
  private cacheValue: ProviderCacheReference | null;
  private wireReceiptValue: ObservedCacheWireReceipt | null;
  private pending: PendingPresentationSubmission | null = null;
  private settled = new Set<string>();

  constructor(snapshot?: ReceiptChainSnapshot) {
    this.headValue = snapshot?.head ?? null;
    this.leavesValue = new Map(snapshot?.leaves ?? []);
    this.cacheValue = snapshot?.cache ?? null;
    this.wireReceiptValue = snapshot?.wireReceipt ?? null;
  }

  /** Restore a persisted chain. Accepts the current shape (`format: 2`) and
   * the pre-#148 one (a `leaves` array of pairs). Anything else throws: a
   * receipt that silently restored as an empty leaf table would make the
   * next presentation measure continuity against nothing and treat every
   * leaf as changed (#97), which is worse than a loud failure at load. */
  static deserialize(value: SerializedReceiptChain): KvUnifiedReceiptChain {
    if (!isRecord(value)) {
      throw new Error('kv-unified receipt: persisted value is not an object');
    }
    let chain: KvUnifiedReceiptChain;
    if (isSerializedV2(value)) {
      if (!Array.isArray(value.leafRuns)) {
        throw new Error('kv-unified receipt: format 2 without a leafRuns array');
      }
      chain = new KvUnifiedReceiptChain({
        head: value.head == null ? null : deserializeHead(value.head),
        leaves: decodeLeafTable(value.leafRuns),
        cache: value.cache ?? null,
        wireReceipt: value.wireReceipt ?? null,
      });
    } else if (Array.isArray((value as SerializedReceiptChainV1).leaves)) {
      const legacy = value as SerializedReceiptChainV1;
      chain = new KvUnifiedReceiptChain({
        head: legacy.head ?? null,
        leaves: new Map(legacy.leaves),
        cache: legacy.cache ?? null,
        wireReceipt: legacy.wireReceipt ?? null,
      });
    } else {
      const format = (value as { format?: unknown; v?: unknown }).format ?? (value as { v?: unknown }).v;
      throw new Error(
        `kv-unified receipt: unknown persisted shape${format === undefined ? '' : ` (format ${String(format)})`}`,
      );
    }
    const settled = Array.isArray(value.settledSubmissionIds) ? value.settledSubmissionIds : [];
    chain.settled = new Set(settled.filter((id): id is string => typeof id === 'string').slice(-SETTLED_RETAINED));
    return chain;
  }

  get head(): PresentationReceipt | null { return this.headValue; }
  get leaves(): ReadonlyMap<ChunkId, PresentedLeaf> { return this.leavesValue; }
  get cache(): ProviderCacheReference | null { return this.cacheValue; }
  get wireReceipt(): ObservedCacheWireReceipt | null { return this.wireReceiptValue; }
  get inFlightSubmissionId(): string | null { return this.pending?.submissionId ?? null; }

  /** Bind a new provider submission. An unsettled earlier flight is
   * superseded, not defended: the caller composes a new request only after
   * the previous one is dead (transport error before any usage event, a
   * provider or framework retry, a restart), and `accept` requires the
   * matching in-flight id, so nothing could ever settle it. Throwing here
   * turned every such transient into a second, self-inflicted failure of the
   * retry ("… is still in flight", devops agent 2026-09-16). The superseded
   * id is returned so the strategy can log it; a late accept/fail for it is a
   * duplicate no-op, never a state change. */
  begin(submission: PendingPresentationSubmission): { superseded: string | null } {
    if (!submission.submissionId) throw new Error('kv-unified submissionId must be non-empty');
    let superseded: string | null = null;
    if (this.pending) {
      superseded = this.pending.submissionId;
      this.markSettled(superseded);
      this.pending = null;
    }
    this.pending = { ...submission, leaves: new Map(submission.leaves) };
    return { superseded };
  }

  accept(
    submissionId: string,
    acceptedAt: number,
    cache: ProviderCacheReference | null,
    wireReceipt?: Omit<ObservedCacheWireReceipt, 'acceptedAt'>,
  ): { presentationAdvanced: boolean; duplicate: boolean } {
    if (this.settled.has(submissionId)) return { presentationAdvanced: false, duplicate: true };
    const pending = this.requirePending(submissionId);
    this.pending = null;
    this.markSettled(submissionId);
    this.cacheValue = cache;
    if (wireReceipt) this.wireReceiptValue = { ...wireReceipt, acceptedAt };
    if (this.headValue?.layoutHash === pending.layoutHash) {
      return { presentationAdvanced: false, duplicate: false };
    }
    const changes = diffLeaves(this.leavesValue, pending.leaves);
    const sequence = (this.headValue?.sequence ?? 0) + 1;
    const parentReceiptHash = this.headValue?.receiptHash ?? null;
    const receiptPayload = {
      sequence,
      parentReceiptHash,
      submissionId,
      requestHash: pending.requestHash,
      layoutHash: pending.layoutHash,
      acceptedAt,
      changes,
    };
    const receiptHash = createHash('sha256').update(JSON.stringify(receiptPayload)).digest('hex');
    this.headValue = { ...receiptPayload, receiptHash };
    this.leavesValue = new Map(pending.leaves);
    return { presentationAdvanced: true, duplicate: false };
  }

  fail(submissionId: string): void {
    if (this.settled.has(submissionId)) return;
    this.requirePending(submissionId);
    this.pending = null;
    this.markSettled(submissionId);
  }

  snapshot(): ReceiptChainSnapshot {
    return {
      head: this.headValue,
      leaves: new Map(this.leavesValue),
      cache: this.cacheValue,
      wireReceipt: this.wireReceiptValue,
    };
  }

  serialize(): SerializedReceiptChainV2 {
    return {
      format: 2,
      head: this.headValue ? serializeHead(this.headValue) : null,
      leafRuns: encodeLeafRuns(this.leavesValue),
      cache: this.cacheValue,
      settledSubmissionIds: [...this.settled].slice(-SETTLED_RETAINED),
      wireReceipt: this.wireReceiptValue,
    };
  }

  private markSettled(submissionId: string): void {
    this.settled.add(submissionId);
    if (this.settled.size > SETTLED_RETAINED) {
      // Insertion order: the first key is the oldest settled id.
      for (const oldest of this.settled) {
        this.settled.delete(oldest);
        break;
      }
    }
  }

  private requirePending(submissionId: string): PendingPresentationSubmission {
    if (!this.pending || this.pending.submissionId !== submissionId) {
      throw new Error(`kv-unified callback ${submissionId} does not match the in-flight submission`);
    }
    return this.pending;
  }
}

function diffLeaves(
  previous: ReadonlyMap<ChunkId, PresentedLeaf>,
  next: ReadonlyMap<ChunkId, PresentedLeaf>,
): PresentationDelta[] {
  const ids = new Set([...previous.keys(), ...next.keys()]);
  const changes: PresentationDelta[] = [];
  for (const leafId of [...ids].sort(compareLeafIds)) {
    const before = previous.get(leafId);
    const after = next.get(leafId);
    if (sameLeaf(before, after)) continue;
    changes.push({ leafId, value: after ?? null });
  }
  return changes;
}

/** Change lists are ordered by id: canonical-decimal ids first, numerically
 * (`"999"` before `"1000"`), then every other id by code point. The two
 * groups never interleave, so the order is total and a receipt's `changes`
 * (and hash) do not depend on `Map` insertion order. Plain string order
 * interleaved ids of different digit counts, which broke the runs and gap
 * codes the persisted form relies on (#148). Only the order of NEW receipts
 * is affected; a persisted receipt keeps the order (and hash) it was
 * written with. */
function compareLeafIds(a: ChunkId, b: ChunkId): number {
  const na = canonicalDecimal(a);
  const nb = canonicalDecimal(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameLeaf(a: PresentedLeaf | undefined, b: PresentedLeaf | undefined): boolean {
  return a?.repHash === b?.repHash && a?.level === b?.level && a?.lastChangedSeq === b?.lastChangedSeq;
}

function isSerializedV2(value: SerializedReceiptChain): value is SerializedReceiptChainV2 {
  return 'format' in value && value.format === 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawRun(value: PresentedLeaf | RawLeafRun): value is RawLeafRun {
  return (value as RawLeafRun).raw === true;
}

/** `repHash === \`raw:${id}\`` without building the string per leaf. */
function isRawHash(repHash: string, id: ChunkId): boolean {
  return repHash.length === id.length + 4 && repHash.startsWith('raw:') && repHash.endsWith(id);
}

function sameRunValue(
  a: PresentedLeaf | RawLeafRun | null,
  b: PresentedLeaf | RawLeafRun | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (isRawRun(a) || isRawRun(b)) {
    return isRawRun(a) && isRawRun(b) && a.level === b.level && a.lastChangedSeq === b.lastChangedSeq;
  }
  return sameLeaf(a, b);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateRunValue(value: unknown, where: string): PresentedLeaf | RawLeafRun | null {
  if (value === null) return null;
  if (!isRecord(value) || !isNonNegativeInt(value.level) || !isNonNegativeInt(value.lastChangedSeq)) {
    throw new Error(`kv-unified receipt: malformed leaf value in ${where}`);
  }
  if (value.raw === true) {
    return { raw: true, level: value.level, lastChangedSeq: value.lastChangedSeq };
  }
  if (typeof value.repHash !== 'string' || value.repHash.length === 0) {
    throw new Error(`kv-unified receipt: malformed leaf value in ${where}`);
  }
  return { repHash: value.repHash, level: value.level, lastChangedSeq: value.lastChangedSeq };
}

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,14})$/;

/** The integer an id stands for when it is written as a canonical decimal
 * (no sign, no leading zeros, within the safe-integer range), else null. Only
 * such ids may join a range: `String(n)` must give back the exact id. */
function canonicalDecimal(id: ChunkId): number | null {
  return CANONICAL_DECIMAL.test(id) ? Number(id) : null;
}

/** Run-length encode `[id, value]` entries in the given order. See `LeafRun`. */
export function encodeLeafRuns(
  entries: Iterable<readonly [ChunkId, PresentedLeaf | null]>,
): LeafRun[] {
  const runs: LeafRun[] = [];
  let run: LeafRun | null = null;
  // The integer the previous id in `run` stands for, when it had one.
  let prev: number | null = null;
  for (const [id, leaf] of entries) {
    const value: PresentedLeaf | RawLeafRun | null =
      leaf !== null && isRawHash(leaf.repHash, id)
        ? { raw: true, level: leaf.level, lastChangedSeq: leaf.lastChangedSeq }
        : leaf;
    if (!run || !sameRunValue(run.value, value)) {
      run = { value, ids: [] };
      runs.push(run);
      prev = null;
    }
    const n = canonicalDecimal(id);
    const gap = n !== null && prev !== null ? n - prev : 0;
    if (gap === 1) {
      const last = run.ids[run.ids.length - 1];
      if (typeof last === 'number' && last < 0) run.ids[run.ids.length - 1] = last - 1;
      else run.ids.push(-1);
    } else if (gap > 1) {
      run.ids.push(gap);
    } else {
      // Non-canonical, first in the run, or out of order: literal.
      run.ids.push(id);
    }
    prev = n;
  }
  return runs;
}

/** Inverse of `encodeLeafRuns`: the entries in their original order.
 *
 * The input is persisted state, so it is validated as untrusted before any
 * expansion: run shapes and leaf values, gap tokens (non-zero safe
 * integers that keep every reconstructed id a safe integer, never before a
 * literal), the total expanded count (`MAX_DECODED_LEAVES`), and leaf id
 * uniqueness. A malformed stream throws instead of restoring a table that
 * repeats or drops ids. */
export function decodeLeafRuns(
  runs: readonly LeafRun[],
  maxLeaves: number = MAX_DECODED_LEAVES,
): Array<[ChunkId, PresentedLeaf | null]> {
  if (!Array.isArray(runs)) throw new Error('kv-unified receipt: leaf runs are not an array');
  const overLimit = () => new Error(`kv-unified receipt: leaf runs expand to more than ${maxLeaves} leaves`);
  // Pass 1: validate every token and count the expansion without performing it.
  let total = 0;
  const values: Array<PresentedLeaf | RawLeafRun | null> = [];
  runs.forEach((run, r) => {
    if (!isRecord(run) || !Array.isArray(run.ids)) {
      throw new Error(`kv-unified receipt: malformed leaf run ${r}`);
    }
    values.push(validateRunValue(run.value, `run ${r}`));
    let prev: number | null = null;
    for (const entry of run.ids) {
      if (typeof entry === 'string') {
        if (entry.length === 0) throw new Error(`kv-unified receipt: empty leaf id in run ${r}`);
        prev = canonicalDecimal(entry);
        total += 1;
        if (total > maxLeaves) throw overLimit();
        continue;
      }
      if (
        prev === null ||
        !Number.isSafeInteger(entry) ||
        entry === 0 ||
        !Number.isSafeInteger(prev + Math.abs(entry))
      ) {
        throw new Error(`kv-unified receipt: malformed gap-coded leaf id ${String(entry)} in run ${r}`);
      }
      prev += Math.abs(entry);
      total += entry > 0 ? 1 : -entry;
      if (total > maxLeaves) throw overLimit();
    }
  });
  // Pass 2: expand.
  const out: Array<[ChunkId, PresentedLeaf | null]> = [];
  const seen = new Set<ChunkId>();
  const push = (id: ChunkId, value: PresentedLeaf | RawLeafRun | null): void => {
    if (seen.has(id)) throw new Error(`kv-unified receipt: duplicate leaf id ${id}`);
    seen.add(id);
    out.push([
      id,
      value !== null && isRawRun(value)
        ? { repHash: `raw:${id}`, level: value.level, lastChangedSeq: value.lastChangedSeq }
        : value,
    ]);
  };
  runs.forEach((run, r) => {
    const value = values[r];
    let prev = 0;
    for (const entry of run.ids) {
      if (typeof entry === 'string') {
        push(entry, value);
        prev = canonicalDecimal(entry) ?? 0;
      } else if (entry > 0) {
        prev += entry;
        push(String(prev), value);
      } else {
        for (let k = 0; k < -entry; k++) {
          prev += 1;
          push(String(prev), value);
        }
      }
    }
  });
  return out;
}

function decodeLeafTable(runs: readonly LeafRun[]): Map<ChunkId, PresentedLeaf> {
  const leaves = new Map<ChunkId, PresentedLeaf>();
  for (const [id, value] of decodeLeafRuns(runs)) {
    if (value === null) throw new Error(`kv-unified receipt: null leaf ${id} in the leaf table`);
    leaves.set(id, value);
  }
  return leaves;
}

function serializeHead(head: PresentationReceipt): SerializedReceiptHead {
  const { changes, ...rest } = head;
  return { ...rest, changeRuns: encodeLeafRuns(changes.map((c) => [c.leafId, c.value] as const)) };
}

function deserializeHead(head: SerializedReceiptHead): PresentationReceipt {
  if (
    !isRecord(head) ||
    !isNonNegativeInt(head.sequence) ||
    typeof head.receiptHash !== 'string' ||
    (head.parentReceiptHash !== null && typeof head.parentReceiptHash !== 'string') ||
    typeof head.submissionId !== 'string' ||
    typeof head.requestHash !== 'string' ||
    typeof head.layoutHash !== 'string' ||
    typeof head.acceptedAt !== 'number' ||
    !Array.isArray(head.changeRuns)
  ) {
    throw new Error('kv-unified receipt: malformed head receipt');
  }
  const { changeRuns, ...rest } = head;
  return { ...rest, changes: decodeLeafRuns(changeRuns).map(([leafId, value]) => ({ leafId, value })) };
}
