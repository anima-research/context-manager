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

// ── Persisted form (#148) ──────────────────────────────────────────────────

import {
  encodeLeafRuns,
  decodeLeafRuns,
  MAX_DECODED_LEAVES,
  type LeafRun,
  type SerializedReceiptChainV1,
} from '../../src/adaptive/kv-unified-receipts.js';
import type { PresentedLeaf } from '../../src/adaptive/kv-unified-policy.js';

const leaf = (repHash: string, level: number, lastChangedSeq = 1): PresentedLeaf => ({ repHash, level, lastChangedSeq });

test('leaf runs are lossless for every id shape and keep presentation order', () => {
  const entries: Array<[string, PresentedLeaf | null]> = [
    ['10', leaf('summary:L2-1', 2)],
    ['11', leaf('summary:L2-1', 2)],
    ['12', leaf('summary:L2-1', 2)],
    ['14', leaf('summary:L2-1', 2)],       // gap: 13 is not a chunk
    ['007', leaf('summary:L2-1', 2)],      // non-canonical decimal stays verbatim
    ['8', leaf('summary:L2-1', 2)],        // not 007+1 — no range across it
    ['9', leaf('summary:L2-1', 2)],
    ['a', leaf('summary:L2-1', 2)],
    ['b', leaf('summary:L2-1', 2)],
    ['20', leaf('raw:20', 0)],
    ['21', leaf('raw:21', 0)],             // raw with the same clock: one raw run, hashes derived
    ['22', null],
    ['23', null],
    ['24', leaf('raw:24', 0, 1)],          // raw run of one
    ['25', leaf('raw:24', 0, 2)],          // another id's raw hash: literal, its own run
    ['1', leaf('x', 1)],
    ['2', leaf('x', 1)],
    ['3', leaf('x', 1)],
  ];
  const runs = encodeLeafRuns(entries);
  assert.deepEqual(JSON.parse(JSON.stringify(decodeLeafRuns(runs))), entries);
  assert.deepEqual(runs[0].ids, ['10', -2, 2, '007', '8', -1, 'a', 'b']);
  assert.deepEqual(runs.map((r) => (r.value === null ? null : 'repHash' in r.value ? r.value.repHash : 'raw')), [
    'summary:L2-1', 'raw', null, 'raw', 'raw:24', 'x',
  ]);
  assert.deepEqual(runs[1], { value: { raw: true, level: 0, lastChangedSeq: 1 }, ids: ['20', -1] });
  assert.deepEqual(runs[runs.length - 1].ids, ['1', -2]);
  assert.deepEqual(encodeLeafRuns([]), []);
  // Out-of-order ids inside a run are literals, never negative gaps.
  const back = encodeLeafRuns([['5', leaf('x', 1)], ['3', leaf('x', 1)], ['4', leaf('x', 1)]]);
  assert.deepEqual(back[0].ids, ['5', '3', -1]);
  assert.throws(() => decodeLeafRuns([{ value: null, ids: [2] }]), /malformed gap-coded leaf id/);
  // Ids beyond the safe-integer range are never ranged.
  const huge = encodeLeafRuns([['9007199254740993', leaf('x', 1)], ['9007199254740994', leaf('x', 1)]]);
  assert.deepEqual(huge[0].ids, ['9007199254740993', '9007199254740994']);
});

test('raw leaves become a derived run only when the hash is exactly raw:<id>', () => {
  const entries: Array<[string, PresentedLeaf | null]> = [
    ['10', leaf('raw:10', 0, 3)],
    ['11', leaf('raw:11', 0, 3)],
    ['007', leaf('raw:007', 0, 3)],        // leading zeros: literal id, hash still derivable
    ['12', leaf('raw:11', 0, 3)],          // hash of another id: kept verbatim
    ['13', leaf('raw:13 ', 0, 3)],         // trailing space: kept verbatim
    ['14', leaf('raw:14', 0, 4)],          // different clock: its own raw run
    ['a', leaf('raw:a', 1, 4)],
  ];
  const runs = encodeLeafRuns(entries);
  assert.deepEqual(runs, [
    { value: { raw: true, level: 0, lastChangedSeq: 3 }, ids: ['10', -1, '007'] },
    { value: { repHash: 'raw:11', level: 0, lastChangedSeq: 3 }, ids: ['12'] },
    { value: { repHash: 'raw:13 ', level: 0, lastChangedSeq: 3 }, ids: ['13'] },
    { value: { raw: true, level: 0, lastChangedSeq: 4 }, ids: ['14'] },
    { value: { raw: true, level: 1, lastChangedSeq: 4 }, ids: ['a'] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(decodeLeafRuns(runs))), entries);
  // An all-raw history is one run per clock value, not one per leaf.
  const allRaw: Array<[string, PresentedLeaf]> = [];
  for (let i = 0; i < 5000; i++) allRaw.push([String(i), leaf(`raw:${i}`, 0, 7)]);
  const raw = encodeLeafRuns(allRaw);
  assert.equal(raw.length, 1);
  assert.ok(JSON.stringify(raw).length < 100, `all-raw table is O(1): ${JSON.stringify(raw).length}`);
});

test('decoding validates persisted runs before expanding them', () => {
  const ok = (runs: LeafRun[]) => decodeLeafRuns(runs);
  const bad = (runs: unknown, re: RegExp) => assert.throws(() => decodeLeafRuns(runs as LeafRun[]), re);
  assert.deepEqual(ok([{ value: leaf('x', 1), ids: ['1', -2] }]).map(([id]) => id), ['1', '2', '3']);
  bad('nope', /not an array/);
  bad([null], /malformed leaf run 0/);
  bad([{ value: leaf('x', 1) }], /malformed leaf run 0/);
  bad([{ value: { repHash: 'x', level: -1, lastChangedSeq: 0 }, ids: ['1'] }], /malformed leaf value in run 0/);
  bad([{ value: { repHash: 'x', level: 1.5, lastChangedSeq: 0 }, ids: ['1'] }], /malformed leaf value/);
  bad([{ value: { repHash: '', level: 1, lastChangedSeq: 0 }, ids: ['1'] }], /malformed leaf value/);
  bad([{ value: { raw: true, level: 0 }, ids: ['1'] }], /malformed leaf value/);
  bad([{ value: 'x', ids: ['1'] }], /malformed leaf value/);
  bad([{ value: null, ids: [''] }], /empty leaf id/);
  bad([{ value: null, ids: [1] }], /malformed gap-coded leaf id 1 in run 0/);           // gap before any literal
  bad([{ value: null, ids: ['a', 1] }], /malformed gap-coded/);                          // gap after a non-decimal literal
  bad([{ value: null, ids: ['1', 0] }], /malformed gap-coded/);
  bad([{ value: null, ids: ['1', 1.5] }], /malformed gap-coded/);
  bad([{ value: null, ids: ['1', Number.MAX_SAFE_INTEGER] }], /malformed gap-coded/);  // reconstructed id leaves the safe range
  bad([{ value: null, ids: ['1', -Number.MAX_SAFE_INTEGER] }], /malformed gap-coded/);
  bad([{ value: null, ids: ['1', -(MAX_DECODED_LEAVES + 1)] }], /expand to more than/);
  bad([{ value: null, ids: ['1', -1_000_000] }, { value: null, ids: ['5000000', -1_100_000] }], /expand to more than/);
  // The bound counts literal ids too, and is checked before anything is expanded.
  assert.equal(decodeLeafRuns([{ value: null, ids: ['a', 'b', 'c'] }], 3).length, 3);
  assert.throws(() => decodeLeafRuns([{ value: null, ids: ['a', 'b', 'c', 'd'] }], 3), /expand to more than 3 leaves/);
  assert.throws(() => decodeLeafRuns([{ value: null, ids: ['1', -2] }, { value: null, ids: ['x'] }], 3), /expand to more than 3 leaves/);
  assert.throws(() => decodeLeafRuns([{ value: null, ids: ['x'] }, { value: null, ids: ['1', 5, -2] }], 3), /expand to more than 3 leaves/);
  bad([{ value: null, ids: ['1', '1'] }], /duplicate leaf id 1/);
  bad([{ value: null, ids: ['2', -1] }, { value: leaf('x', 1), ids: ['3'] }], /duplicate leaf id 3/);
});

test('kv-unified receipt deserialize refuses unknown shapes instead of restoring an empty baseline', () => {
  const bad = (value: unknown, re: RegExp) => assert.throws(() => KvUnifiedReceiptChain.deserialize(value as never), re);
  bad(null, /not an object/);
  bad([], /not an object/);
  bad({}, /unknown persisted shape$/);
  bad({ v: 2, ids: [], reps: [], runs: [] }, /unknown persisted shape \(format 2\)/);
  bad({ format: 3, leafRuns: [] }, /unknown persisted shape \(format 3\)/);
  bad({ format: 2 }, /without a leafRuns array/);
  bad({ format: 2, leafRuns: [{ value: null, ids: ['1'] }] }, /null leaf 1 in the leaf table/);
  bad({ format: 2, leafRuns: [], head: { sequence: 1 } }, /malformed head receipt/);
  bad({ format: 2, leafRuns: [], head: { sequence: 1, receiptHash: 'h', parentReceiptHash: null, submissionId: 's', requestHash: 'r', layoutHash: 'l', acceptedAt: 1, changeRuns: [{ value: null, ids: ['1', '1'] }] } }, /duplicate leaf id/);
  // Minimal valid shapes of both generations.
  assert.equal(KvUnifiedReceiptChain.deserialize({ format: 2, leafRuns: [], head: null, cache: null, settledSubmissionIds: [], wireReceipt: null }).leaves.size, 0);
  assert.equal(KvUnifiedReceiptChain.deserialize({ head: null, leaves: [['a', leaf('x', 1)]], cache: null, settledSubmissionIds: [], wireReceipt: null }).leaves.get('a')?.repHash, 'x');
});

test('the next acceptance after a reload sees unchanged leaves as unchanged', () => {
  const table = new Map<string, PresentedLeaf>();
  for (let i = 0; i < 300; i++) table.set(String(i), leaf(i < 280 ? 'summary:L3-1' : `raw:${i}`, i < 280 ? 3 : 0, 1));
  const live = new KvUnifiedReceiptChain();
  live.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: table });
  live.accept('s1', 100, null);
  const reloaded = KvUnifiedReceiptChain.deserialize(JSON.parse(JSON.stringify(live.serialize())));
  // Same leaves, new layout: a new receipt with zero changes, identical on both chains.
  for (const chain of [live, reloaded]) {
    chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: table });
    assert.equal(chain.accept('s2', 200, null).presentationAdvanced, true);
    assert.deepEqual(chain.head?.changes, []);
  }
  assert.equal(reloaded.head?.receiptHash, live.head?.receiptHash);
  assert.equal(reloaded.head?.parentReceiptHash, live.head?.parentReceiptHash);
  // A fold after the reload is reported against the restored baseline: 20 raws into one summary, one chunk gone.
  const folded = new Map(table);
  for (let i = 280; i < 300; i++) folded.set(String(i), leaf('summary:L1-9', 1, 3));
  folded.delete('0');
  reloaded.begin({ submissionId: 's3', requestHash: 'r3', layoutHash: 'l3', leaves: folded });
  reloaded.accept('s3', 300, null);
  assert.equal(reloaded.head?.changes.length, 21);
  assert.deepEqual(reloaded.head?.changes[0], { leafId: '0', value: null });
  assert.equal(reloaded.leaves.get('0'), undefined);
  assert.equal(reloaded.leaves.get('299')?.repHash, 'summary:L1-9');
});

test('kv-unified receipt chain round-trips through the run-length form and still loads the pre-#148 form', () => {
  const chain = new KvUnifiedReceiptChain();
  const wide = new Map<string, PresentedLeaf>();
  for (let i = 100; i < 160; i++) wide.set(String(i), leaf('summary:L3-1', 3, 1));
  for (let i = 160; i < 170; i++) wide.set(String(i), leaf(`raw:${i}`, 0, 1));
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: wide });
  chain.accept('s1', 100, null);
  // Second presentation: a fold replaces ten raws with one summary, one chunk disappears.
  const next = new Map(wide);
  for (let i = 160; i < 170; i++) next.set(String(i), leaf('summary:L1-9', 1, 2));
  next.delete('150');
  chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: next });
  chain.accept('s2', 200, { immutablePrefixHash: 'p', layout: { totalTokens: 1, units: [] }, markers: [] } as never);

  const encoded = JSON.parse(JSON.stringify(chain.serialize()));
  assert.equal(encoded.format, 2);
  assert.equal(encoded.leafRuns.length, 2, 'the summary run and the folded run');
  assert.deepEqual(encoded.leafRuns[0].ids, ['100', -49, 2, -8], 'the removed chunk is a gap inside the run, not a new run');
  assert.equal(encoded.head.changeRuns.length, 2, 'one removal, one fold');
  assert.equal('changes' in encoded.head, false);
  assert.equal('leaves' in encoded, false);

  const restored = KvUnifiedReceiptChain.deserialize(encoded);
  assert.deepEqual(restored.head, chain.head, 'head (with its hash and change list) survives verbatim');
  assert.deepEqual([...restored.leaves], [...chain.leaves], 'leaf table and its order survive');
  assert.deepEqual(restored.cache, chain.cache);
  assert.deepEqual(restored.accept('s2', 201, null), { presentationAdvanced: false, duplicate: true });

  // A store written by the previous release still loads.
  const legacy: SerializedReceiptChainV1 = {
    head: chain.head,
    leaves: [...chain.leaves],
    cache: chain.cache,
    settledSubmissionIds: ['s1', 's2'],
    wireReceipt: null,
  };
  const fromLegacy = KvUnifiedReceiptChain.deserialize(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(fromLegacy.head, chain.head);
  assert.deepEqual([...fromLegacy.leaves], [...chain.leaves]);
  assert.deepEqual(fromLegacy.accept('s1', 1, null), { presentationAdvanced: false, duplicate: true });
});

test('kv-unified receipt bytes for a long session leaf table stay small', () => {
  // The shape of a long session: thousands of chunks folded under a few
  // hundred summaries, a few dozen raw at the tail.
  const leaves = new Map<string, PresentedLeaf>();
  let id = 1000;
  for (let summary = 0; summary < 150; summary++) {
    for (let k = 0; k < 130; k++) leaves.set(String(id++), leaf(`summary:L4-${summary}`, 4, summary));
    id += 3; // ids of messages that are not chunks
  }
  for (let k = 0; k < 40; k++) leaves.set(String(id++), leaf(`raw:${id}`, 0, 150));
  assert.equal(leaves.size, 150 * 130 + 40);
  const chain = new KvUnifiedReceiptChain({ head: null, leaves, cache: null });
  const bytes = JSON.stringify(chain.serialize()).length;
  const legacyBytes = JSON.stringify({ head: null, leaves: [...leaves], cache: null, settledSubmissionIds: [], wireReceipt: null }).length;
  assert.ok(legacyBytes > 1_000_000, `legacy form is O(leaves): ${legacyBytes}`);
  assert.ok(bytes < 20_000, `run-length form is O(runs): ${bytes}`);
  assert.deepEqual([...KvUnifiedReceiptChain.deserialize(JSON.parse(JSON.stringify(chain.serialize()))).leaves], [...leaves]);
});

test('kv-unified change lists are ordered numerically so a first acceptance stays compact', () => {
  const table = new Map<string, PresentedLeaf>();
  for (let i = 990; i < 1010; i++) table.set(String(i), leaf('summary:L2-1', 2, 1));
  table.set('x', leaf('summary:L2-1', 2, 1));
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: table });
  chain.accept('s1', 100, null);
  assert.deepEqual(chain.head?.changes.map((c) => c.leafId), [...table.keys()], '999 sorts before 1000; non-decimal ids after');
  // The order is total: decimals first, then the rest by code point, whatever the insertion order.
  const shuffled = new Map([...table.entries()].reverse());
  const other = new KvUnifiedReceiptChain();
  other.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: shuffled });
  other.accept('s1', 100, null);
  assert.equal(other.head?.receiptHash, chain.head?.receiptHash, 'same leaves in another insertion order: same receipt');
  const mixed = new Map<string, PresentedLeaf>([['11a', leaf('m', 1)], ['10', leaf('m', 1)], ['2', leaf('m', 1)], ['007', leaf('m', 1)]]);
  const m = new KvUnifiedReceiptChain();
  m.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: mixed });
  m.accept('s1', 100, null);
  assert.deepEqual(m.head?.changes.map((c) => c.leafId), ['2', '10', '007', '11a']);
  const encoded = chain.serialize();
  assert.deepEqual(encoded.head?.changeRuns, [{ value: { repHash: 'summary:L2-1', level: 2, lastChangedSeq: 1 }, ids: ['990', -19, 'x'] }]);
  // A fresh baseline over a wide id range (ids crossing a digit boundary) is one run, not thousands.
  const wide = new Map<string, PresentedLeaf>();
  for (let i = 1000; i < 76000; i++) wide.set(String(i), leaf(`summary:L3-${Math.floor(i / 150)}`, 3, 1));
  const first = new KvUnifiedReceiptChain();
  first.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: wide });
  first.accept('s1', 100, null);
  assert.ok(JSON.stringify(first.serialize()).length < 120_000, 'first acceptance of 75k leaves is O(summaries): 500 summaries in the table and 500 in the change list');
});

test('kv-unified settled submission ids are bounded in memory as they are on disk', () => {
  const chain = new KvUnifiedReceiptChain();
  for (let i = 0; i < 300; i++) {
    chain.begin({ submissionId: `s${i}`, requestHash: 'r', layoutHash: `l${i}`, leaves: leaves('raw:a') });
    chain.accept(`s${i}`, i, null);
  }
  assert.equal(chain.serialize().settledSubmissionIds.length, 256);
  assert.deepEqual(chain.accept('s299', 1, null), { presentationAdvanced: false, duplicate: true }, 'recent ids stay settled');
  assert.throws(() => chain.accept('s0', 1, null), /does not match the in-flight submission/, 'an evicted id is simply unknown');
});
