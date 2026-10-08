import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KvUnifiedReceiptChain } from '../../src/adaptive/kv-unified-receipts.js';

const leaves = (rep: string) => new Map([
  ['a', { repHash: rep, level: rep === 'raw:a' ? 0 : 1, lastChangedSeq: 0 }],
]);

test('kv-unified receipts keep a single flight and advance only on acceptance', () => {
  const chain = new KvUnifiedReceiptChain();
  const first = chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  assert.equal(first.superseded, null);
  assert.equal(chain.inFlightSubmissionId, 's1');
  assert.equal(chain.head?.sequence ?? null, null, 'submission is not acceptance');
  const accepted = chain.accept('s1', 100, null);
  assert.equal(accepted.presentationAdvanced, true);
  assert.equal(chain.head?.sequence, 1);
  assert.equal(chain.leaves.get('a')?.repHash, 'raw:a');
});

test('kv-unified receipts supersede an unsettled flight instead of wedging the next submission', () => {
  // A provider call that died before its usage event (transport error, retry,
  // restart) leaves s1 open; the retry's submission must not fail on it.
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  const second = chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: leaves('summary:L1') });
  assert.equal(second.superseded, 's1');
  assert.equal(chain.inFlightSubmissionId, 's2');
  assert.equal(chain.head?.sequence ?? null, null, 'superseding never advances presentation');
  // Late callbacks for the superseded flight are duplicates, never state changes.
  assert.deepEqual(chain.accept('s1', 50, null), { presentationAdvanced: false, duplicate: true });
  chain.fail('s1');
  assert.equal(chain.inFlightSubmissionId, 's2');
  const accepted = chain.accept('s2', 100, null);
  assert.equal(accepted.presentationAdvanced, true);
  assert.equal(chain.head?.sequence, 1);
  assert.equal(chain.leaves.get('a')?.repHash, 'summary:L1');
  // A superseded id is remembered as settled across persistence too.
  const reloaded = KvUnifiedReceiptChain.deserialize(chain.serialize());
  assert.deepEqual(reloaded.accept('s1', 51, null), { presentationAdvanced: false, duplicate: true });
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

const summarized = (count: number, seq: number) => {
  // Numeric ids in blocks of 1000 under one summary each (two levels), then
  // raw leaves and ids the encoder must keep as strings: a leading zero, a
  // non-number, and a raw leaf whose hash is not derived from its id.
  const out = new Map<string, { repHash: string; level: number; lastChangedSeq: number }>();
  for (let k = 0; k < count; k++) {
    const block = Math.floor(k / 1000);
    const level = block % 2 === 0 ? 2 : 1;
    out.set(String(k), { repHash: `summary:L${level}-${block}`, level, lastChangedSeq: seq });
  }
  out.set(String(count), { repHash: `raw:${count}`, level: 0, lastChangedSeq: seq });
  out.set('007', { repHash: 'raw:007', level: 0, lastChangedSeq: seq });
  out.set('msg-x', { repHash: 'summary:L2-0', level: 2, lastChangedSeq: seq });
  out.set('9', { repHash: 'raw:other', level: 0, lastChangedSeq: seq });
  return out;
};

test('kv-unified receipt v2 encoding round-trips, reads v1, and is far smaller', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: summarized(3_000, 1) });
  chain.accept('s1', 100, null);
  const next = summarized(3_000, 1);
  next.set('msg-x', { repHash: 'raw:msg-x', level: 0, lastChangedSeq: 2 });
  chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: next });
  chain.accept('s2', 200, { immutablePrefixHash: 'tools', layout: { units: [], totalTokens: 0 }, markers: [] }, {
    requestHash: 'wire',
    markers: [{ ordinal: 0, prefixHash: 'prefix', estimatedOffset: 123 }],
  });
  const v1 = JSON.stringify(chain.serialize());
  const v2 = JSON.stringify(chain.serialize('v2'));
  assert.ok(v2.length * 8 < v1.length, `v2 ${v2.length} bytes, v1 ${v1.length} bytes`);
  for (const encoded of [v1, v2]) {
    const restored = KvUnifiedReceiptChain.deserialize(JSON.parse(encoded));
    assert.deepEqual([...restored.leaves], [...chain.leaves]);
    assert.deepEqual(restored.head, chain.head);
    assert.deepEqual(restored.cache, chain.cache);
    assert.deepEqual(restored.wireReceipt, chain.wireReceipt);
    assert.deepEqual(restored.accept('s1', 100, null), { presentationAdvanced: false, duplicate: true });
    assert.deepEqual(restored.serialize(), chain.serialize(), 'the v1 shape is the same from either source');
  }
  assert.throws(
    () => KvUnifiedReceiptChain.deserialize({ ...chain.serialize('v2'), v: 3 } as never),
    /receipt encoding v3 is unknown/,
  );
});
