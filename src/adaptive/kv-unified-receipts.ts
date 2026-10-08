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

/** Persisted shape, one `[id, leaf]` entry per leaf (~69 bytes each: 5 MB
 * for a 75k-leaf history, rewritten on every accepted turn). Read forever;
 * written when `receiptEncoding` is `'v1'`. */
export interface SerializedReceiptChain {
  head: PresentationReceipt | null;
  leaves: Array<[ChunkId, PresentedLeaf]>;
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
}

/** Columnar persisted shape: the leaf ids in map order, then `runs` of
 * `rep, level, lastChangedSeq, count` over that order. `rep` 0 is the raw
 * hash `raw:<id>`; `rep` k > 0 is `reps[k - 1]`. Consecutive leaves under
 * one summary share rep, level and sequence, so a history is a few hundred
 * runs. A decimal integer id is written as a number. Still JSON, so the
 * Chronicle view renders it unchanged. */
export interface SerializedReceiptChainV2 {
  v: 2;
  head: PresentationReceipt | null;
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
  ids: Array<ChunkId | number>;
  reps: string[];
  runs: number[];
}

export type ReceiptEncoding = 'v1' | 'v2';

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

  /** Reads every shape ever written; the writer is `serialize(encoding)`. */
  static deserialize(value: SerializedReceiptChain | SerializedReceiptChainV2): KvUnifiedReceiptChain {
    let leaves: Map<ChunkId, PresentedLeaf>;
    if (!('v' in value)) leaves = new Map(value.leaves);
    else if (value.v === 2) leaves = decodeLeaves(value);
    else throw new Error(`kv-unified receipt encoding v${String((value as { v: unknown }).v)} is unknown`);
    const chain = new KvUnifiedReceiptChain({ head: value.head, leaves, cache: value.cache, wireReceipt: value.wireReceipt });
    chain.settled = new Set(value.settledSubmissionIds);
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
      this.settled.add(superseded);
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
    this.settled.add(submissionId);
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
    this.settled.add(submissionId);
  }

  snapshot(): ReceiptChainSnapshot {
    return {
      head: this.headValue,
      leaves: new Map(this.leavesValue),
      cache: this.cacheValue,
      wireReceipt: this.wireReceiptValue,
    };
  }

  serialize(): SerializedReceiptChain;
  serialize(encoding: 'v1'): SerializedReceiptChain;
  serialize(encoding: 'v2'): SerializedReceiptChainV2;
  serialize(encoding: ReceiptEncoding): SerializedReceiptChain | SerializedReceiptChainV2;
  serialize(encoding: ReceiptEncoding = 'v1'): SerializedReceiptChain | SerializedReceiptChainV2 {
    if (encoding === 'v1') {
      return {
        head: this.headValue,
        leaves: [...this.leavesValue],
        cache: this.cacheValue,
        settledSubmissionIds: [...this.settled].slice(-256),
        wireReceipt: this.wireReceiptValue,
      };
    }
    return {
      v: 2,
      head: this.headValue,
      cache: this.cacheValue,
      settledSubmissionIds: [...this.settled].slice(-256),
      wireReceipt: this.wireReceiptValue,
      ...encodeLeaves(this.leavesValue),
    };
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
  for (const leafId of [...ids].sort()) {
    const before = previous.get(leafId);
    const after = next.get(leafId);
    if (sameLeaf(before, after)) continue;
    changes.push({ leafId, value: after ?? null });
  }
  return changes;
}

function sameLeaf(a: PresentedLeaf | undefined, b: PresentedLeaf | undefined): boolean {
  return a?.repHash === b?.repHash && a?.level === b?.level && a?.lastChangedSeq === b?.lastChangedSeq;
}

function encodeLeaves(leaves: ReadonlyMap<ChunkId, PresentedLeaf>): Pick<SerializedReceiptChainV2, 'ids' | 'reps' | 'runs'> {
  const ids: Array<ChunkId | number> = [];
  const reps: string[] = [];
  const repCodes = new Map<string, number>();
  const runs: number[] = [];
  let rep = -1, level = -1, seq = -1, count = 0;
  let lastHash = '', lastCode = 0;
  for (const [id, leaf] of leaves) {
    const n = decimalInteger(id);
    ids.push(n >= 0 ? n : id);
    let code = 0;
    if (leaf.repHash === lastHash) code = lastCode;
    else if (!isRawHash(leaf.repHash, id)) {
      code = repCodes.get(leaf.repHash) ?? 0;
      if (code === 0) { code = reps.push(leaf.repHash); repCodes.set(leaf.repHash, code); }
      lastHash = leaf.repHash; lastCode = code;
    }
    if (code === rep && leaf.level === level && leaf.lastChangedSeq === seq) { count++; continue; }
    if (count > 0) runs.push(rep, level, seq, count);
    rep = code; level = leaf.level; seq = leaf.lastChangedSeq; count = 1;
  }
  if (count > 0) runs.push(rep, level, seq, count);
  return { ids, reps, runs };
}

/** The value of `id` when it is a plain decimal integer whose `String()` is
 * `id` again (no sign, no leading zero, within safe-integer range), else -1. */
function decimalInteger(id: string): number {
  const length = id.length;
  if (length === 0 || length > 15 || (length > 1 && id.charCodeAt(0) === 48)) return -1;
  let n = 0;
  for (let i = 0; i < length; i++) {
    const digit = id.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return -1;
    n = n * 10 + digit;
  }
  return n;
}

function decodeLeaves(value: SerializedReceiptChainV2): Map<ChunkId, PresentedLeaf> {
  const { ids, reps, runs } = value;
  if (!Array.isArray(ids) || !Array.isArray(reps) || !Array.isArray(runs) || runs.length % 4 !== 0) {
    throw new Error('kv-unified receipt v2 has invalid columns or run length');
  }
  const leaves = new Map<ChunkId, PresentedLeaf>();
  let i = 0;
  for (let r = 0; r < runs.length; r += 4) {
    const [rep, level, lastChangedSeq, count] = [runs[r], runs[r + 1], runs[r + 2], runs[r + 3]];
    if (
      !Number.isSafeInteger(rep) || rep < 0 || rep > reps.length ||
      (rep > 0 && typeof reps[rep - 1] !== 'string') ||
      !Number.isSafeInteger(level) || level < 0 ||
      !Number.isSafeInteger(lastChangedSeq) || lastChangedSeq < 0 ||
      !Number.isSafeInteger(count) || count <= 0 || count > ids.length - i
    ) {
      throw new Error(`kv-unified receipt v2 has invalid run at ${r / 4}`);
    }
    // The leaves of one run are the same readonly record: one object serves them all.
    const shared = rep > 0 ? { repHash: reps[rep - 1], level, lastChangedSeq } : null;
    for (const end = i + count; i < end; i++) {
      const encodedId = ids[i];
      if (typeof encodedId !== 'string' && (!Number.isSafeInteger(encodedId) || encodedId < 0)) {
        throw new Error(`kv-unified receipt v2 has invalid leaf id at ${i}`);
      }
      const id = String(encodedId);
      if (leaves.has(id)) throw new Error(`kv-unified receipt v2 has duplicate leaf id at ${i}`);
      leaves.set(id, shared ?? { repHash: `raw:${id}`, level, lastChangedSeq });
    }
  }
  if (i !== ids.length) throw new Error(`kv-unified receipt runs cover ${i} of ${ids.length} leaves`);
  return leaves;
}

/** `repHash === \`raw:${id}\`` without building the string for every leaf. */
function isRawHash(repHash: string, id: ChunkId): boolean {
  return repHash.length === id.length + 4 && repHash.startsWith('raw:') && repHash.endsWith(id);
}
