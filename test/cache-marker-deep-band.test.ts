/**
 * placeCacheMarkers — deep-band first slot.
 *
 * The first message-level marker sits at the end of the leading run of
 * recall pairs rendered at the deepest emitted level (the band nothing can
 * arrive to change), not at the last head message. Properties:
 *  - no summaries → placement byte-identical to the legacy {head, …} layout;
 *  - band present → first marker at the band's last answer entry; the
 *    measured-stable-prefix and end markers unchanged; ≤3 markers;
 *  - the run stops at the first raw entry or shallower pair; a shallower
 *    pair BEFORE the deepest level leaves no band (first marker = head);
 *  - kv-unified: band → {bandEnd, token-midpoint(band..historyEnd), historyEnd, tailEnd};
 *    no band → the 33/66/100 thirds as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { ContextEntry } from '../src/types/context.js';
import type { SummaryEntry } from '../src/types/strategy.js';

class Exposed extends AutobiographicalStrategy {
  place(entries: ContextEntry[], head: Set<string>, tail: Set<string>): void {
    this.placeCacheMarkers(entries, head, tail);
  }
  withSummaries(levels: Record<string, number>): this {
    this.summaries = Object.entries(levels).map(([id, level]) => ({
      id, level, content: 'x', tokens: 10, sourceLevel: level - 1, sourceIds: [],
      sourceRange: { first: 'a', last: 'b' }, created: 0,
    } as unknown as SummaryEntry));
    return this;
  }
}

const raw = (id: string, text = 'raw'): ContextEntry =>
  ({ sourceMessageId: id, participant: 'p', content: [{ type: 'text', text }] } as ContextEntry);
const question = (): ContextEntry =>
  ({ participant: 'Context Manager', content: [{ type: 'text', text: 'What do you remember?' }], sourceRelation: 'derived' } as ContextEntry);
const answer = (summaryId: string, text = `summary ${summaryId}`): ContextEntry =>
  ({ participant: 'agent', content: [{ type: 'text', text }], sourceRelation: 'derived', cacheLayoutKey: summaryId } as ContextEntry);
const marksOf = (es: ContextEntry[]) => es.map((e, i) => (e.cacheMarker ? i : -1)).filter((i) => i >= 0);

/** head(2) | L3 L3 | L2 L2 | L1 | raw | tail(3) — answers at 3,5,7,9,11; raw middle 12. */
function banded() {
  const es = [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'),
    question(), answer('L2-a'), question(), answer('L2-b'),
    question(), answer('L1-a'),
    raw('m0'),
    raw('t0'), raw('t1'), raw('t2'),
  ];
  return { es, head: new Set(['h0', 'h1']), tail: new Set(['t0', 't1', 't2']) };
}
const LEVELS = { 'L3-a': 3, 'L3-b': 3, 'L2-a': 2, 'L2-b': 2, 'L1-a': 1 };

test('legacy: no summaries → first marker stays at the last head entry', () => {
  const s = new Exposed({});
  const es = [raw('h0'), raw('h1'), raw('m0'), raw('m1'), raw('t0'), raw('t1')];
  s.place(es, new Set(['h0', 'h1']), new Set(['t0', 't1']));
  assert.deepEqual(marksOf(es), [1, 3, 5]); // lastHead, historyEnd (first compile), end
});

test('legacy: first marker moves to the end of the deep band; measured/end unchanged', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const { es, head, tail } = banded();
  s.place(es, head, tail);
  // deepBandEnd = 5 (answer L3-b); first compile → historyEnd = 12; end = 15.
  assert.deepEqual(marksOf(es), [5, 12, 15]);
  assert.ok(marksOf(es).length <= 3);

  // Append-only next compile: band marker stands, previous endpoint kept.
  const b = banded();
  b.es.push(raw('t3')); b.tail.add('t3');
  s.place(b.es, b.head, b.tail);
  assert.deepEqual(marksOf(b.es), [5, 15, 16]);
});

test('legacy: the band is the LEADING run only — a shallower pair in front leaves no band', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const es = [
    raw('h0'),
    question(), answer('L2-a'),            // shallower first
    question(), answer('L3-a'), question(), answer('L3-b'),
    raw('t0'), raw('t1'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0', 't1']));
  assert.deepEqual(marksOf(es), [0, 6, 8]); // head, historyEnd, end — unchanged from legacy
});

test('legacy: a raw middle entry ends the band; a merged raw shard with a layout key is raw', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const es = [
    raw('h0'),
    question(), answer('L3-a'),
    { ...raw('m0'), cacheLayoutKey: 'm0' } as ContextEntry, // merged body shard: key is a message id
    question(), answer('L3-b'),
    raw('t0'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [2, 5, 6]);
});

test('legacy: divergence inside the band keeps both the band and the measured marker', () => {
  const s = new Exposed({}).withSummaries({ ...LEVELS, 'L4-a': 4 });
  const a = banded();
  s.place(a.es, a.head, a.tail);
  // An L4 landed over the first L3: bytes change at index 3 (inside the band).
  const b = banded();
  b.es[3] = answer('L4-a');
  b.es.splice(4, 2); // L3-b absorbed
  s.place(b.es, b.head, b.tail);
  // Band now = the single L4 pair (deepest level), end 3; measured stable prefix = index 2
  // (the question before the changed answer), which is ≤ lastHead? no: lastHead=1, so 2 qualifies.
  assert.deepEqual(marksOf(b.es), [2, 3, b.es.length - 1]);
});

test('kv-unified: band → {bandEnd, midpoint, historyEnd, tailEnd}; no band → thirds', () => {
  const s = new Exposed({ foldingStrategy: 'kv-unified' } as never).withSummaries(LEVELS);
  const { es, head, tail } = banded();
  s.place(es, head, tail);
  const marks = marksOf(es);
  assert.equal(marks.length, 4);
  assert.equal(marks[0], 5, 'first slot = deep band end');
  assert.equal(marks[2], 12, 'historyEnd');
  assert.equal(marks[3], 15, 'tail end');
  assert.ok(marks[1] > 5 && marks[1] < 12, `mid marker between band and historyEnd: ${marks[1]}`);

  const t = new Exposed({ foldingStrategy: 'kv-unified' } as never);
  const es2 = Array.from({ length: 12 }, (_, i) => raw(`m${i}`, 'x'.repeat(i === 2 ? 400 : 40)));
  t.place(es2, new Set(['m0']), new Set(['m9', 'm10', 'm11']));
  assert.deepEqual(marksOf(es2), [1, 2, 8, 11]); // unchanged thirds contract
});
