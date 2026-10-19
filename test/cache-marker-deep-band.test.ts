/**
 * placeCacheMarkers — deep-band first slot (the three-slot strategies;
 * kv-unified keeps its thirds).
 *
 * The first message-level marker sits at the end of the leading run of
 * recall pairs rendered at the deepest emitted level (the band, which nothing
 * that arrives rewrites), not at the last head message. Properties:
 *  - no summaries → placement byte-identical to the legacy {head, …} layout;
 *  - band present → first marker at the band's last answer entry; ≤3
 *    markers; the end marker unchanged, and the measured one too except as
 *    the bullet on the first slot's moves says;
 *  - the run stops at the first raw entry or shallower pair, and at a keyless
 *    entry no deepest answer follows; a shallower pair BEFORE the deepest
 *    level leaves no band (first marker = head);
 *  - a repair stub enforceToolPairing generated right after the head is
 *    passed over; an entry merely shaped like one, an empty one, or a
 *    genuine result moved next to its call isn't;
 *  - when the first slot moves, with a band before or after, the measured
 *    slot marks the furthest entry the previous request marked that is still
 *    unchanged (such as the head when a fold forms the band right after it,
 *    the old band end on a deepen or when the band goes, or a later marker of
 *    the previous request when the change comes after it), or the stable
 *    prefix when that entry is the new first slot;
 *  - kv-unified ignores the band and keeps its thirds.
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
  repair(entries: ContextEntry[]): void {
    this.enforceToolPairing(entries);
  }
  /** The cache-marker baseline: the field select saves and puts back by identity. */
  get baseline(): string[] | undefined {
    return this._prevCacheKeys;
  }
  set baseline(keys: string[] | undefined) {
    this._prevCacheKeys = keys;
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

test('legacy: the compile in which the band forms marks the head beside the new band end', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const head = new Set(['h0', 'h1']);
  const before = [raw('h0'), raw('h1'), raw('m0'), raw('m1'), raw('m2'), raw('t0'), raw('t1')];
  s.place(before, head, new Set(['t0', 't1']));
  assert.deepEqual(marksOf(before), [1, 4, 6]);
  // The middle folds into a band, so nothing after the head is unchanged.
  const formed = [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'), question(), answer('L2-a'),
    raw('m2'), raw('t0'), raw('t1'),
  ];
  s.place(formed, head, new Set(['t0', 't1']));
  // The head (1), which the previous request marked first, beside the band end (5) and the end.
  assert.deepEqual(marksOf(formed), [1, 5, 10]);
});

test('legacy: when the group after the band deepens to its level, the old band end stays marked', () => {
  const s = new Exposed({}).withSummaries({ 'L3-a': 3, 'L3-b': 3, 'L3-c': 3, 'L2-a': 2 });
  const head = new Set(['h0', 'h1']);
  const before = [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'), question(), answer('L2-a'),
    raw('m4'), raw('t0'),
  ];
  s.place(before, head, new Set(['t0']));
  assert.deepEqual(marksOf(before), [5, 8, 9]);
  // L2-a deepens to L3-c: the band now ends at 7, and the bytes first differ there.
  const deepened = [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'), question(), answer('L3-c'),
    raw('m4'), raw('t0'), raw('t1'),
  ];
  s.place(deepened, head, new Set(['t0', 't1']));
  // The old band end (5), which the previous request marked first, beside the new one (7) and the end.
  assert.deepEqual(marksOf(deepened), [5, 7, 10]);
});

/** A head whose last message is a tool call no result follows. */
const unansweredCall = (): ContextEntry =>
  ({ sourceMessageId: 'h1', participant: 'agent', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] } as unknown as ContextEntry);
const bandAfterCall = (): ContextEntry[] => [
  raw('h0'), unansweredCall(),
  question(), answer('L3-a'), question(), answer('L3-b'),
  raw('m2'), raw('t0'),
];

test('legacy: a repair stub after a head that ends in an unanswered tool call is passed over', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const es = bandAfterCall();
  s.repair(es);
  assert.equal(es[2]!.content[0]!.type, 'tool_result', 'fixture: enforceToolPairing answered the call right after the head');
  s.place(es, new Set(['h0', 'h1']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [6, 7, 8]); // band end, historyEnd (first compile), end
});

test('legacy: a keyless entry that is not a generated stub ends the run, even one shaped like a stub', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const repaired = bandAfterCall();
  s.repair(repaired);
  // The same bytes as the generated stub, but not the object enforceToolPairing made.
  const es = bandAfterCall();
  es.splice(2, 0, structuredClone(repaired[2]!));
  s.place(es, new Set(['h0', 'h1']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [1, 7, 8]); // no band: head, historyEnd, end
  // An entry with no content at all passes no stub check either.
  const empty = bandAfterCall();
  empty.splice(2, 0, { participant: 'user', sourceRelation: 'derived', content: [] } as unknown as ContextEntry);
  new Exposed({}).withSummaries(LEVELS).place(empty, new Set(['h0', 'h1']), new Set(['t0']));
  assert.deepEqual(marksOf(empty), [1, 7, 8]);
});

test('legacy: a genuine result moved next to its call ends the stub pass, so there is no band', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  // The call's result arrives a few entries down, within enforceToolPairing's look-ahead.
  const result = {
    sourceMessageId: 'r1', participant: 'user',
    content: [{ type: 'tool_result', toolUseId: 'c1', content: 'file contents' }],
  } as unknown as ContextEntry;
  const es = [
    raw('h0'), unansweredCall(),
    question(), answer('L3-a'), question(), answer('L3-b'),
    result, raw('m2'), raw('t0'),
  ];
  s.repair(es);
  assert.equal((es[2]!.content[0] as { content?: unknown }).content, 'file contents', 'fixture: the genuine result moved up next to its call');
  s.place(es, new Set(['h0', 'h1']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [1, 8, 9]); // no band: head, historyEnd (first compile), end
});

test('legacy: an entry holding a moved genuine result beside a generated stub ends the stub pass, so there is no band', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  // The head ends in two parallel calls: c1's result arrives a few entries down, within
  // enforceToolPairing's look-ahead, and c2's never does. Repair puts both answers into the one
  // entry after the head: c1's genuine result, moved up, and a generated stub for c2.
  const twoCalls = {
    sourceMessageId: 'h1', participant: 'agent',
    content: [
      { type: 'tool_use', id: 'c1', name: 'read', input: {} },
      { type: 'tool_use', id: 'c2', name: 'read', input: {} },
    ],
  } as unknown as ContextEntry;
  const result = {
    sourceMessageId: 'r1', participant: 'user',
    content: [{ type: 'tool_result', toolUseId: 'c1', content: 'file contents' }],
  } as unknown as ContextEntry;
  const es = [
    raw('h0'), twoCalls,
    question(), answer('L3-a'), question(), answer('L3-b'),
    result, raw('m2'), raw('t0'),
  ];
  s.repair(es);
  const answers = es[2]!.content as { toolUseId?: string; content?: unknown }[];
  assert.deepEqual(answers.map((b) => b.toolUseId), ['c1', 'c2'], 'fixture: both answers in the entry after the head');
  assert.equal(answers[0]!.content, 'file contents', 'fixture: c1\'s genuine result moved up');
  assert.notEqual(answers[1]!.content, 'file contents', 'fixture: c2 answered by a stub');
  s.place(es, new Set(['h0', 'h1']), new Set(['t0']));
  // Not stubs alone, so the entry's bytes changed when the result moved in: no band, head first.
  assert.deepEqual(marksOf(es), [1, 8, 9]); // head, historyEnd (first compile), end
});

test('legacy: a raw entry right before a deepest answer ends the run', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const es = [
    raw('h0'),
    question(), answer('L3-a'),
    raw('m0'), answer('L3-b'),
    raw('m1'),
    raw('t0'),
  ];
  s.place(es, new Set(['h0']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [2, 5, 6]); // band end, historyEnd, end
});

test('legacy: a band that forms behind an unchanged repair stub still marks the head', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const head = new Set(['h0', 'h1']);
  const before = [raw('h0'), unansweredCall(), raw('m2'), raw('m3'), raw('m4'), raw('t0')];
  s.repair(before);
  s.place(before, head, new Set(['t0']));
  assert.deepEqual(marksOf(before), [1, 5, 6]); // head, historyEnd (first compile), end
  const formed = [raw('h0'), unansweredCall(), question(), answer('L3-a'), question(), answer('L3-b'), raw('m4'), raw('t0')];
  s.repair(formed);
  s.place(formed, head, new Set(['t0']));
  // The stub (2) is unchanged, so the head the previous request marked first is still readable.
  assert.deepEqual(marksOf(formed), [1, 6, 8]);
});

test('legacy: a band that forms on unchanged entries still marks the head', () => {
  const s = new Exposed({}).withSummaries({ 'L2-a': 2, 'L2-b': 2, 'L3-x': 3, 'L2-x': 2 });
  const head = new Set(['h0', 'h1']);
  const before = [
    raw('h0'), raw('h1'),
    question(), answer('L2-a'), question(), answer('L2-b'),
    raw('m0'), question(), answer('L3-x'),
    raw('t0'),
  ];
  s.place(before, head, new Set(['t0']));
  // The deeper L3-x after the leading L2 run leaves no band.
  assert.deepEqual(marksOf(before), [1, 8, 9]);
  // L3-x is re-cut to L2-x, so the leading L2 run, unchanged, becomes the band.
  const after = [
    raw('h0'), raw('h1'),
    question(), answer('L2-a'), question(), answer('L2-b'),
    raw('m0'), question(), answer('L2-x'),
    raw('t0'), raw('t1'),
  ];
  s.place(after, head, new Set(['t0', 't1']));
  assert.deepEqual(marksOf(after), [1, 5, 10]);
});

test('legacy: when the band goes, its old end stays marked while it is unchanged', () => {
  const s = new Exposed({}).withSummaries({ 'L3-a': 3, 'L3-b': 3, 'L2-x': 2, 'L4-x': 4 });
  const head = new Set(['h0', 'h1']);
  const before = [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'),
    raw('m0'), question(), answer('L2-x'),
    raw('t0'),
  ];
  s.place(before, head, new Set(['t0']));
  assert.deepEqual(marksOf(before), [5, 8, 9]);
  // A deeper summary lands after the band, so the leading L3 run is no longer a band.
  const after = [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'),
    raw('m0'), question(), answer('L4-x'),
    raw('t0'), raw('t1'),
  ];
  s.place(after, head, new Set(['t0', 't1']));
  // The head as the first slot, the old band end (5) the previous request marked first, and the end.
  assert.deepEqual(marksOf(after), [1, 5, 10]);
});

/** Two leading L2 pairs, then raw m0 and m1 and a deeper pair (8, 9) that leaves no band until it's re-cut to L2. */
const laterChange = (m1: string, deeper: string) => [
  raw('h0'), raw('h1'),
  question(), answer('L2-a'), question(), answer('L2-b'),
  raw('m0'), raw('m1', m1), question(), answer(deeper),
];
const LATER = { 'L2-a': 2, 'L2-b': 2, 'L3-x': 3, 'L2-x': 2 };

test('legacy: a band that forms marks the previous request\'s measured marker when the change comes after it', () => {
  const s = new Exposed({}).withSummaries(LATER);
  const head = new Set(['h0', 'h1']);
  const first = [...laterChange('raw', 'L3-x'), raw('t0')];
  s.place(first, head, new Set(['t0']));
  assert.deepEqual(marksOf(first), [1, 9, 10]); // no band: head, historyEnd (first compile), end
  const edited = [...laterChange('edited', 'L3-x'), raw('t0'), raw('t1')];
  s.place(edited, head, new Set(['t0', 't1']));
  assert.deepEqual(marksOf(edited), [1, 6, 11]); // m1 changed: the measured stable prefix ends at m0 (6)
  // L3-x is re-cut to L2-x, so the leading L2 run becomes the band and the bytes first differ at 9.
  const formed = [...laterChange('edited', 'L2-x'), raw('t0'), raw('t1'), raw('t2')];
  s.place(formed, head, new Set(['t0', 't1', 't2']));
  // The band end (5), m0 (6), the furthest entry the previous request marked that is unchanged, and the end.
  assert.deepEqual(marksOf(formed), [5, 6, 12]);
});

test('legacy: when the previous request marked the new band end, the measured slot marks the stable prefix', () => {
  const s = new Exposed({}).withSummaries(LATER);
  const head = new Set(['h0', 'h1']);
  const first = [...laterChange('raw', 'L3-x'), raw('t0')];
  s.place(first, head, new Set(['t0']));
  // m0 changes, so the measured stable prefix ends at the second L2 answer (5).
  const edited = first.slice(0, -1);
  edited[6] = raw('m0', 'edited');
  edited.push(raw('t0'), raw('t1'));
  s.place(edited, head, new Set(['t0', 't1']));
  assert.deepEqual(marksOf(edited), [1, 5, 11]);
  const formed = edited.slice(0, 9).concat(answer('L2-x'), raw('t0'), raw('t1'), raw('t2'));
  s.place(formed, head, new Set(['t0', 't1', 't2']));
  // 5 is now the band end, the first slot, so the measured slot marks the stable prefix (8).
  assert.deepEqual(marksOf(formed), [5, 8, 12]);
});

test('legacy: while the band stands, a change after it leaves the measured slot at the stable prefix', () => {
  const s = new Exposed({}).withSummaries({ ...LEVELS, 'L2-c': 2, 'L1-b': 1 });
  const a = banded();
  s.place(a.es, a.head, a.tail);
  assert.deepEqual(marksOf(a.es), [5, 12, 15]);
  const b = banded();
  b.es[9] = answer('L2-c');
  s.place(b.es, b.head, b.tail);
  assert.deepEqual(marksOf(b.es), [5, 8, 15]); // the measured stable prefix ends at 8
  const c = banded();
  c.es[9] = answer('L2-c');
  c.es[11] = answer('L1-b');
  s.place(c.es, c.head, c.tail);
  // The band end (5) stands, so the measured slot marks the stable prefix (10), not 8.
  assert.deepEqual(marksOf(c.es), [5, 10, 15]);
});

test('legacy: with no band before or after, a moved head window leaves the measured slot as main places it', () => {
  const s = new Exposed({});
  const es = [raw('h0'), raw('h1'), raw('m0'), raw('m1'), raw('m2'), raw('m3'), raw('t0')];
  s.place(es, new Set(['h0', 'h1']), new Set(['t0']));
  assert.deepEqual(marksOf(es), [1, 5, 6]);
  // The head grows to m0 and m3 changes, so the furthest entry the previous
  // request marked that is unchanged is its head (1), not the stable prefix.
  const grown = [raw('h0'), raw('h1'), raw('m0'), raw('m1'), raw('m2'), raw('m3', 'edited'), raw('t0'), raw('t1')];
  s.place(grown, new Set(['h0', 'h1', 'm0']), new Set(['t0', 't1']));
  // The new head (2), the stable prefix (4) as main places it, and the end.
  assert.deepEqual(marksOf(grown), [2, 4, 7]);
});

test('legacy: the previous request\'s markers are the ones placed for the baseline select puts back', () => {
  const s = new Exposed({}).withSummaries(LEVELS);
  const head = new Set(['h0', 'h1']);
  const raws = () => [raw('h0'), raw('h1'), raw('m0'), raw('m1'), raw('m2'), raw('t0'), raw('t1')];
  const formed = () => [
    raw('h0'), raw('h1'),
    question(), answer('L3-a'), question(), answer('L3-b'), question(), answer('L2-a'),
    raw('m2'), raw('t0'), raw('t1'),
  ];
  s.place(raws(), head, new Set(['t0', 't1']));
  const returned = s.baseline;
  // A dry run places markers of its own, then select puts the returned request's baseline back.
  s.place(formed(), head, new Set(['t0', 't1']));
  s.baseline = returned;
  const es = formed();
  s.place(es, head, new Set(['t0', 't1']));
  assert.deepEqual(marksOf(es), [1, 5, 10]); // as after the returned request alone
});

test('kv-unified: a deep band changes nothing, so the entries get the thirds they get without summaries', () => {
  // A heavy first band answer puts the thirds at 1 and 3, away from the band end.
  const weighted = () => {
    const b = banded();
    b.es[3] = answer('L3-a', 'x'.repeat(4000));
    return b;
  };
  const withBand = weighted();
  new Exposed({ foldingStrategy: 'kv-unified' } as never).withSummaries(LEVELS).place(withBand.es, withBand.head, withBand.tail);
  const plain = weighted();
  new Exposed({ foldingStrategy: 'kv-unified' } as never).place(plain.es, plain.head, plain.tail);
  assert.deepEqual(marksOf(withBand.es), marksOf(plain.es));
  assert.ok(!marksOf(withBand.es).includes(5), 'fixture: the band end (5) is not one of the thirds');
});
