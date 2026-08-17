/**
 * placeCacheMarkers — measured-stable-prefix placement (2026-08-16).
 *
 * Load-bearing properties:
 *  - first compile (no previous) degrades to seam placement: {head, historyEnd, end};
 *  - append-only compile keeps the seam marker (stable prefix = whole previous window);
 *  - a fold rotation that rewrites the middle drops the marker to the last
 *    byte-surviving entry, NOT the seam — the seam assumption is the measured
 *    failure (mythos llm-calls 2026-08-13..17: ~1.4 deep rewrites/hour);
 *  - total rewrite places no stable-prefix marker and does not crash;
 *  - never more than 3 message-level markers (Anthropic 4-block limit incl. system).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { ContextEntry } from '../src/types/context.js';

class Exposed extends AutobiographicalStrategy {
  place(entries: ContextEntry[], head: Set<string>, tail: Set<string>): void {
    this.placeCacheMarkers(entries, head, tail);
  }
}

function entry(id: string, text: string): ContextEntry {
  return {
    sourceMessageId: id,
    participant: 'p',
    content: [{ type: 'text', text }],
  } as ContextEntry;
}
const marksOf = (es: ContextEntry[]) =>
  es.map((e, i) => (e.cacheMarker ? i : -1)).filter((i) => i >= 0);

function fixture() {
  // head: h0..h1, middle (folded): m0..m5, tail: t0..t2
  const es = [
    entry('h0', 'sys-a'), entry('h1', 'sys-b'),
    entry('m0', 'fold-0'), entry('m1', 'fold-1'), entry('m2', 'fold-2'),
    entry('m3', 'fold-3'), entry('m4', 'fold-4'), entry('m5', 'fold-5'),
    entry('t0', 'raw-0'), entry('t1', 'raw-1'), entry('t2', 'raw-2'),
  ];
  const head = new Set(['h0', 'h1']);
  const tail = new Set(['t0', 't1', 't2']);
  return { es, head, tail };
}

test('first compile: seam placement {head, historyEnd, end}', () => {
  const s = new Exposed({});
  const { es, head, tail } = fixture();
  s.place(es, head, tail);
  assert.deepEqual(marksOf(es), [1, 7, 10]); // lastHead=1, historyEnd=7, end=10
});

test('append-only compile keeps the seam marker', () => {
  const s = new Exposed({});
  const a = fixture();
  s.place(a.es, a.head, a.tail);
  const b = fixture();
  b.es.push(entry('t3', 'raw-3'));
  b.tail.add('t3');
  s.place(b.es, b.head, b.tail);
  assert.deepEqual(marksOf(b.es), [1, 7, 11]);
});

test('rotation drops the marker to the surviving prefix, not the seam', () => {
  const s = new Exposed({});
  const a = fixture();
  s.place(a.es, a.head, a.tail);
  const b = fixture();
  b.es[4] = entry('m2b', 'fold-2-REWRITTEN'); // divergence at index 4
  s.place(b.es, b.head, b.tail);
  assert.deepEqual(marksOf(b.es), [1, 3, 10]); // stableEnd = 3, not seam 7
});

test('total rewrite: no stable-prefix marker, no crash', () => {
  const s = new Exposed({});
  const a = fixture();
  s.place(a.es, a.head, a.tail);
  const b = fixture();
  for (let i = 0; i < b.es.length; i++) b.es[i] = entry(`x${i}`, `new-${i}`);
  s.place(b.es, new Set(), new Set());
  assert.deepEqual(marksOf(b.es), [b.es.length - 1]); // end only
});

test('never more than 3 message-level markers', () => {
  const s = new Exposed({});
  for (let round = 0; round < 4; round++) {
    const { es, head, tail } = fixture();
    if (round % 2) es[3] = entry(`m1-${round}`, `churn-${round}`);
    s.place(es, head, tail);
    assert.ok(marksOf(es).length <= 3, `round ${round}: ${marksOf(es)}`);
  }
});
