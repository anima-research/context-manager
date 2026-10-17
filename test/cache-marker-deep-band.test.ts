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
 *    no legal boundary after the band / band reaching historyEnd → {bandEnd, tailEnd};
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
  tok(e: ContextEntry): number {
    return Math.max(1, this.estimateTokens(e.content));
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

test('legacy: a raw middle entry ends the band', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const es = [
    raw('h0'),
    question(), answer('L3-a'),
    raw('m0'),
    question(), answer('L3-b'),
    raw('t0'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [2, 5, 6]);
});

test('legacy: a merged raw shard (no sourceMessageId, layout key = last shard id) is raw and ends the band', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  // A real merged body-group composite: no sourceMessageId, every shard in
  // sourceMessageIds, cacheLayoutKey = the last shard's message id (which
  // resolves to no summary). It sits directly before a max-level answer, so
  // the only clause that keeps it from reading as that answer's question is
  // its cacheLayoutKey.
  const shard = {
    participant: 'p', content: [{ type: 'text', text: 'shard a shard b' }], sourceRelation: 'copy',
    sourceMessageIds: ['m0a', 'm0b'], cacheLayoutKey: 'm0b',
  } as ContextEntry;
  const es = [
    raw('h0'),
    question(), answer('L3-a'),
    shard,
    answer('L3-b'),
    raw('t0'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [2, 4, 5]); // band end 2, historyEnd 4, end 5
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
  // (the question before the changed answer), past lastHead = 1.
  assert.deepEqual(marksOf(b.es), [2, 3, b.es.length - 1]);
});

test('kv-unified: band → {bandEnd, token midpoint, historyEnd, tailEnd}; no band → thirds', () => {
  const s = new Exposed({ foldingStrategy: 'kv-unified' } as never).withSummaries(LEVELS);
  const { es, head, tail } = banded();
  // Weight the stretch after the band so the token midpoint is far from the
  // index midpoint: L2-a is heavy, everything after it light.
  es[7] = answer('L2-a', 'x'.repeat(4000));
  s.place(es, head, tail);
  const marks = marksOf(es);

  // Expected mid: the legal boundary after the band end (5) and up to
  // historyEnd (12) whose cumulative rendered tokens are nearest
  // (cum(bandEnd) + cum(historyEnd)) / 2. Legal = carries a layout key or id.
  const cum: number[] = [0];
  for (let i = 0; i <= 12; i++) cum.push(cum[i]! + s.tok(es[i]!));
  const target = (cum[6]! + cum[13]!) / 2;
  const legalAfterBand = [7, 9, 11, 12];
  const expectedMid = legalAfterBand.reduce((best, i) =>
    Math.abs(cum[i + 1]! - target) < Math.abs(cum[best + 1]! - target) ? i : best);
  assert.equal(expectedMid, 7, 'fixture: the heavy L2-a answer carries the midpoint');
  assert.deepEqual(marks, [5, expectedMid, 12, 15]); // band end, token midpoint, historyEnd, tail end

  const t = new Exposed({ foldingStrategy: 'kv-unified' } as never);
  const es2 = Array.from({ length: 12 }, (_, i) => raw(`m${i}`, 'x'.repeat(i === 2 ? 400 : 40)));
  t.place(es2, new Set(['m0']), new Set(['m9', 'm10', 'm11']));
  assert.deepEqual(marksOf(es2), [1, 2, 8, 11]); // unchanged thirds contract
});

test('kv-unified: band reaching historyEnd → {bandEnd, tailEnd}, no mid, no thirds', () => {
  const s = new Exposed({ foldingStrategy: 'kv-unified' } as never).withSummaries(LEVELS);
  const es = [
    raw('h0'),
    question(), answer('L3-a'), question(), answer('L3-b'), // band = whole middle, ends at historyEnd
    raw('t0'), raw('t1'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0', 't1']));
  assert.deepEqual(marksOf(es), [4, 6]);
});

test('kv-unified: no legal boundary after the band → {bandEnd, tailEnd}', () => {
  const s = new Exposed({ foldingStrategy: 'kv-unified' } as never).withSummaries(LEVELS);
  const es = [
    raw('h0'),
    question(), answer('L3-a'),
    question(), // keyless, no source id: not a legal boundary, and no answer follows
    raw('t0'), raw('t1'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0', 't1']));
  // historyEnd = 3 is not legal, so the last legal history boundary is the band end itself:
  // mid and historyEnd slots collapse onto it.
  assert.deepEqual(marksOf(es), [2, 5]);
});
