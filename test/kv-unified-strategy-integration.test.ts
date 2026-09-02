import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContextEntry } from '../src/types/index.js';
import type { KvUnifiedReceiptChain } from '../src/adaptive/kv-unified-receipts.js';

const STORE = './test-kv-unified-integration-store';

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
});

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    headWindowTokens: 0,
    recentWindowTokens: 100,
    kvUnified: {
      policy: {
        alpha: 0.7,
        budgetLowRatio: 0.5,
        budgetHighRatio: 0.9,
        budgetUnderLambda: 10,
        budgetOverLambda: 10,
        cacheLambda: 1,
        cacheScale: 1000,
        cacheReadPrice: 0.1,
        cacheWritePrice: 1.25,
        continuityLambda: 1,
        continuityScale: 1000,
        continuityRecencyHalfLifeTokens: 1000,
        continuityRecencyFloor: 0.2,
        continuityStableHalfLife: 10,
        continuityStableFloor: 0.25,
      },
      tokenBucketSize: 100,
      continuityBucketSize: 100,
      fidelityBucketSize: 100,
      labelCeiling: 10_000,
      adoptEpsilon: 0,
      treeifyNonContiguousSummaries: false,
    },
  });
}

function receipts(strategy: AutobiographicalStrategy): KvUnifiedReceiptChain {
  return (strategy as unknown as { kvUnifiedReceipts: KvUnifiedReceiptChain }).kvUnifiedReceipts;
}

test('kv-unified presentation commits only after acceptance and survives restart', async () => {
  const first = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: first });
  manager.addMessage('user', [{ type: 'text', text: 'hello continuity' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  assert.equal(receipts(first).head, null, 'compile creates a draft only');
  first.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  assert.equal(receipts(first).head, null, 'submission is not acceptance');
  const markerCount = (
    first as unknown as { kvUnifiedPendingMarkerUnitIndices: number[] }
  ).kvUnifiedPendingMarkerUnitIndices.length;
  first.reportKvUnifiedAccepted({
    submissionId: 's1',
    acceptedAt: 123,
    wireReceipt: {
      requestHash: 'wire1',
      markers: Array.from({ length: markerCount }, (_, ordinal) => ({
        ordinal,
        prefixHash: `prefix-${ordinal}`,
        estimatedOffset: ordinal + 1,
      })),
    },
  });
  assert.equal(receipts(first).head?.sequence, 1);
  assert.equal(receipts(first).cache?.immutablePrefixHash, 'immutable-v1');
  manager.close();

  const second = strategy();
  const reopened = await ContextManager.open({ path: STORE, strategy: second });
  assert.equal(receipts(second).head?.sequence, 1);
  assert.ok(receipts(second).leaves.size > 0);
  reopened.close();
});

test('kv-unified failed submission clears single flight without committing', async () => {
  const selected = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  manager.addMessage('user', [{ type: 'text', text: 'not accepted' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  selected.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  selected.reportKvUnifiedFailed('s1');
  assert.equal(receipts(selected).head, null);
  assert.equal(receipts(selected).inFlightSubmissionId, null);
  manager.close();
});

test('kv-unified places token-weighted 33/66/100 history markers plus tail', () => {
  const selected = strategy();
  const entries = Array.from({ length: 12 }, (_, index) => ({
    index,
    sourceMessageId: `m${index}`,
    sourceRelation: 'copy' as const,
    participant: 'user',
    content: [{ type: 'text' as const, text: 'x'.repeat(index === 2 ? 400 : 40) }],
  }));
  (
    selected as unknown as {
      placeCacheMarkers: (
        entries: ContextEntry[],
        head: ReadonlySet<string>,
        tail: ReadonlySet<string>,
      ) => void;
    }
  ).placeCacheMarkers(entries as ContextEntry[], new Set(['m0']), new Set(['m9', 'm10', 'm11']));
  assert.deepEqual(
    entries.flatMap((entry, index) =>
      (entry as { cacheMarker?: boolean }).cacheMarker ? [index] : []),
    [1, 2, 8, 11],
  );
});

test('kv-unified reconciles folded, composite, and tail markers to atomic layout units', () => {
  const selected = strategy() as unknown as {
    reconcileKvUnifiedMarkerIndices: (
      entries: ContextEntry[],
      layout: { units: Array<{ kind: 'head' | 'raw' | 'recall' | 'tail'; key: string; tokens: number; offset: number }>; totalTokens: number },
      head: ReadonlySet<string>,
      tail: ReadonlySet<string>,
    ) => number[];
  };
  const entries: ContextEntry[] = [
    {
      index: 0,
      participant: 'user',
      content: [{ type: 'text', text: 'head' }],
      sourceMessageId: 'h',
      sourceRelation: 'copy',
      cacheMarker: true,
    },
    {
      index: 1,
      participant: 'user',
      content: [{ type: 'text', text: 'composite' }],
      sourceMessageIds: ['a', 'b'],
      cacheLayoutKey: 'b',
      sourceRelation: 'copy',
      cacheMarker: true,
    },
    {
      index: 2,
      participant: 'Context Manager',
      content: [{ type: 'text', text: 'recall' }],
      sourceRelation: 'derived',
    },
    {
      index: 3,
      participant: 'resident',
      content: [{ type: 'text', text: 'summary' }],
      cacheLayoutKey: 'L2-7',
      sourceRelation: 'derived',
      cacheMarker: true,
    },
    {
      index: 4,
      participant: 'user',
      content: [{ type: 'text', text: 'tail' }],
      sourceMessageId: 't',
      sourceRelation: 'copy',
      cacheMarker: true,
    },
  ];
  const layout = {
    units: [
      { kind: 'head' as const, key: 'head', tokens: 10, offset: 0 },
      { kind: 'raw' as const, key: 'a', tokens: 10, offset: 10 },
      { kind: 'raw' as const, key: 'b', tokens: 10, offset: 20 },
      { kind: 'recall' as const, key: 'L2-7', tokens: 10, offset: 30 },
      { kind: 'tail' as const, key: 'tail', tokens: 10, offset: 40 },
    ],
    totalTokens: 50,
  };
  assert.deepEqual(
    selected.reconcileKvUnifiedMarkerIndices(entries, layout, new Set(['h']), new Set(['t'])),
    [1, 3, 4, 5],
  );
});

test('kv-unified fails closed when the treeification policy is omitted', async () => {
  const configured = strategy() as unknown as {
    config: { kvUnified?: { treeifyNonContiguousSummaries?: boolean } };
  };
  delete configured.config.kvUnified!.treeifyNonContiguousSummaries;
  const manager = await ContextManager.open({ path: STORE, strategy: configured as unknown as AutobiographicalStrategy });
  manager.addMessage('user', [{ type: 'text', text: 'fail closed' }]);
  await assert.rejects(
    manager.compile({ maxTokens: 10_000, reserveForResponse: 0 }),
    /requires an explicit treeifyNonContiguousSummaries boolean/,
  );
  manager.close();
});

test('kv-unified continuity relaxation is audited, expiring, and fail-closed', () => {
  const selected = strategy() as unknown as {
    kvUnifiedContinuityMultiplier: (value?: {
      reason: 'surgery' | 'budget-transition' | 'infrastructure';
      multiplier: number;
      expiresAt: number;
    }) => number;
  };
  assert.equal(selected.kvUnifiedContinuityMultiplier(), 1);
  assert.equal(selected.kvUnifiedContinuityMultiplier({
    reason: 'surgery',
    multiplier: 0.25,
    expiresAt: Date.now() + 60_000,
  }), 0.25);
  assert.equal(selected.kvUnifiedContinuityMultiplier({
    reason: 'budget-transition',
    multiplier: 0,
    expiresAt: Date.now() - 1,
  }), 1);
  assert.equal(selected.kvUnifiedContinuityMultiplier({
    reason: 'infrastructure',
    multiplier: Number.NaN,
    expiresAt: Date.now() + 60_000,
  }), 1);
});
