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
      quarantineNonContiguousSummaries: true,
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

test('kv-unified owns four message-level cache marker slots', () => {
  const selected = strategy();
  const entries = Array.from({ length: 20 }, (_, index) => ({
    index,
    sourceMessageId: `m${index}`,
    sourceRelation: 'copy' as const,
    participant: 'user',
    content: [{ type: 'text' as const, text: `entry-${index} ${'x'.repeat(40)}` }],
  }));
  (
    selected as unknown as {
      placeCacheMarkers: (
        entries: ContextEntry[],
        head: ReadonlySet<string>,
        tail: ReadonlySet<string>,
      ) => void;
    }
  ).placeCacheMarkers(entries as ContextEntry[], new Set(['m0', 'm1']), new Set(['m17', 'm18', 'm19']));
  assert.equal(entries.filter((entry) => (entry as { cacheMarker?: boolean }).cacheMarker).length, 4);
  assert.equal((entries[19] as { cacheMarker?: boolean }).cacheMarker, true, 'end marker retained');
});

test('kv-unified fails closed when the treeification policy is omitted', async () => {
  const configured = strategy() as unknown as {
    config: { kvUnified?: { quarantineNonContiguousSummaries?: boolean } };
  };
  delete configured.config.kvUnified!.quarantineNonContiguousSummaries;
  const manager = await ContextManager.open({ path: STORE, strategy: configured as unknown as AutobiographicalStrategy });
  manager.addMessage('user', [{ type: 'text', text: 'fail closed' }]);
  await assert.rejects(
    manager.compile({ maxTokens: 10_000, reserveForResponse: 0 }),
    /requires an explicit quarantineNonContiguousSummaries boolean/,
  );
  manager.close();
});
