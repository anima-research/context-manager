import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
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
  first.reportKvUnifiedAccepted({ submissionId: 's1', acceptedAt: 123 });
  assert.equal(receipts(first).head?.sequence, 1);
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
