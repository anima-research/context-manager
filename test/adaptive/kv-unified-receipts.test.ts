import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KvUnifiedReceiptChain } from '../../src/adaptive/kv-unified-receipts.js';

const leaves = (rep: string) => new Map([
  ['a', { repHash: rep, level: rep === 'raw:a' ? 0 : 1, lastChangedSeq: 0 }],
]);

test('kv-unified receipts enforce single flight and advance only on acceptance', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  assert.throws(
    () => chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: leaves('summary:L1') }),
    /still in flight/,
  );
  const accepted = chain.accept('s1', 100, null);
  assert.equal(accepted.presentationAdvanced, true);
  assert.equal(chain.head?.sequence, 1);
  assert.equal(chain.leaves.get('a')?.repHash, 'raw:a');
});

test('kv-unified receipts clear single flight on failure without changing baselines', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  chain.fail('s1');
  assert.equal(chain.inFlightSubmissionId, null);
  assert.equal(chain.head, null);
  chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: leaves('summary:L1') });
  assert.equal(chain.inFlightSubmissionId, 's2');
});

test('kv-unified keepalive leaves continuity head unchanged but refreshes cache state', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'same', leaves: leaves('raw:a') });
  chain.accept('s1', 100, null);
  const head = chain.head;
  const cache = {
    immutablePrefixHash: 'tools',
    layout: { units: [], totalTokens: 0 },
    markers: [],
  };
  chain.begin({ submissionId: 's2', requestHash: 'r1', layoutHash: 'same', leaves: leaves('raw:a') });
  const result = chain.accept('s2', 200, cache);
  assert.equal(result.presentationAdvanced, false);
  assert.equal(chain.head, head);
  assert.equal(chain.cache?.immutablePrefixHash, 'tools');
});

test('kv-unified receipt callbacks are idempotent by unique submission id', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'same-content', layoutHash: 'l1', leaves: leaves('raw:a') });
  chain.accept('s1', 100, null);
  assert.deepEqual(chain.accept('s1', 100, null), { presentationAdvanced: false, duplicate: true });
  chain.begin({ submissionId: 's2', requestHash: 'same-content', layoutHash: 'l2', leaves: leaves('summary:L1') });
  chain.accept('s2', 200, null);
  assert.equal(chain.head?.sequence, 2);
  assert.equal(chain.head?.parentReceiptHash?.length, 64);
  assert.notEqual(chain.head?.receiptHash, chain.head?.parentReceiptHash);
});

test('kv-unified receipt state round-trips through a Chronicle-safe JSON shape', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  chain.accept('s1', 100, null, {
    requestHash: 'wire',
    markers: [{ ordinal: 0, prefixHash: 'prefix', estimatedOffset: 123 }],
  });
  const encoded = JSON.parse(JSON.stringify(chain.serialize()));
  const restored = KvUnifiedReceiptChain.deserialize(encoded);
  assert.equal(restored.head?.receiptHash, chain.head?.receiptHash);
  assert.equal(restored.leaves.get('a')?.repHash, 'raw:a');
  assert.equal(restored.wireReceipt?.acceptedAt, 100);
  assert.equal(restored.wireReceipt?.markers[0]?.estimatedOffset, 123);
  assert.deepEqual(restored.accept('s1', 100, null), {
    presentationAdvanced: false,
    duplicate: true,
  });
});
