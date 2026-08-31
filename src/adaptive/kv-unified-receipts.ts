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

export interface SerializedReceiptChain {
  head: PresentationReceipt | null;
  leaves: Array<[ChunkId, PresentedLeaf]>;
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
}

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

  static deserialize(value: SerializedReceiptChain): KvUnifiedReceiptChain {
    const chain = new KvUnifiedReceiptChain({
      head: value.head,
      leaves: new Map(value.leaves),
      cache: value.cache,
      wireReceipt: value.wireReceipt,
    });
    chain.settled = new Set(value.settledSubmissionIds);
    return chain;
  }

  get head(): PresentationReceipt | null { return this.headValue; }
  get leaves(): ReadonlyMap<ChunkId, PresentedLeaf> { return this.leavesValue; }
  get cache(): ProviderCacheReference | null { return this.cacheValue; }
  get wireReceipt(): ObservedCacheWireReceipt | null { return this.wireReceiptValue; }
  get inFlightSubmissionId(): string | null { return this.pending?.submissionId ?? null; }

  begin(submission: PendingPresentationSubmission): void {
    if (this.pending) throw new Error(`kv-unified submission ${this.pending.submissionId} is still in flight`);
    if (!submission.submissionId) throw new Error('kv-unified submissionId must be non-empty');
    this.pending = { ...submission, leaves: new Map(submission.leaves) };
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

  serialize(): SerializedReceiptChain {
    return {
      head: this.headValue,
      leaves: [...this.leavesValue],
      cache: this.cacheValue,
      settledSubmissionIds: [...this.settled].slice(-256),
      wireReceipt: this.wireReceiptValue,
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
