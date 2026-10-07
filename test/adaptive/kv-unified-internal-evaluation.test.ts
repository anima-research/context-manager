import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { TerminalPolicyEvaluator } from '../../src/adaptive/kv-unified-terminal.js';
import { PackedTraceArena } from '../../src/adaptive/kv-unified-packed-storage.js';
import { ExactKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-policy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

function fixture() {
  const chronicle = new MockChronicle({ recallPairTokens: 30 });
  chronicle.addChunk({ id: 'a', rawTokens: 90 });
  chronicle.addChunk({ id: 'b', rawTokens: 90 });
  chronicle.produceL1(['a', 'b']);
  const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set() };
  const forest = new CanonicalSummaryForest(inputs);
  const options = { maxTokens: 1000 };
  return { inputs, forest, options, evaluator: new TerminalPolicyEvaluator(inputs, forest, options) };
}

// Invalid numeric levels below exercise cache-key identity only, not scoring.
const compiler = (evaluator: TerminalPolicyEvaluator) => evaluator as unknown as {
  compileAction(ids: readonly string[], level: number): unknown;
};

test('action cache preserves SameValueZero keys, multiple levels and distinct array identities', () => {
  for (const first of [0, NaN]) {
    const cache = compiler(fixture().evaluator), ids = ['a', 'b'];
    const expected = new Map<number, unknown>();
    const keys = [first, 0, -0, 1, 2, NaN, Infinity, -Infinity, 1.5];
    for (const level of [...keys, ...keys.slice().reverse(), ...keys]) {
      const action = cache.compileAction(ids, level);
      if (expected.has(level)) assert.strictEqual(action, expected.get(level));
      else expected.set(level, action);
    }
    assert.notStrictEqual(cache.compileAction([...ids], first), expected.get(first));
  }
});

test('action cache retries iterator exceptions and preserves nested iterator evaluation values', () => {
  const cache = compiler(fixture().evaluator), clean = compiler(fixture().evaluator);
  const ids = ['a', 'b'], marker = new Error('iterator sentinel');
  const throwing = Object.assign([...ids], { [Symbol.iterator](): IterableIterator<string> { throw marker; } });
  assert.throws(() => cache.compileAction(throwing, 1), error => error === marker);
  Object.defineProperty(throwing, Symbol.iterator, { value: Array.prototype[Symbol.iterator] });
  assert.deepEqual(cache.compileAction(throwing, 1), clean.compileAction(ids, 1));
  const nested = [...ids]; let entered = false;
  nested[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
    if (!entered) { entered = true; cache.compileAction(nested, 1); }
    yield* ids;
    return undefined;
  };
  assert.deepEqual(cache.compileAction(nested, 0), clean.compileAction(ids, 0));
  Object.defineProperty(nested, Symbol.iterator, { value: Array.prototype[Symbol.iterator] });
  assert.deepEqual(cache.compileAction(nested, 1), clean.compileAction(ids, 1));
  assert.deepEqual(cache.compileAction(nested, 0), clean.compileAction(ids, 0));
});

test('shared trace references match an independent parent/action oracle before and after page growth', () => {
  const arena = new PackedTraceArena(), ids = [['a'], ['b'], ['c']];
  const actions = ids.map((value, level) => arena.action(value, level));
  const nodes: Array<{ parent: number; action: number } | null> = [null];
  const retained: Array<{ id: number; reference: ReturnType<PackedTraceArena['evaluationReference']> }> = [];
  const oracle = (id: number) => {
    const values: Array<[readonly string[], number]> = [];
    while (id) { const node = nodes[id]!; values.push([ids[node.action], node.action]); id = node.parent; }
    return values;
  };
  const values = (reference: ReturnType<PackedTraceArena['evaluationReference']>) => {
    const result: Array<[readonly string[], number]> = [];
    reference.forEachAssignment((value, level) => { assert.strictEqual(value, ids[level]); result.push([value, level]); });
    return result;
  };
  let state = 15923;
  for (let i = 0; i < 4096; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const parent = state % nodes.length, action = i % 3;
    const id = arena.append(parent, actions[action]); nodes.push({ parent, action });
    if (i % 7 === 0) retained.push({ id, reference: arena.evaluationReference(id) });
  }
  for (const item of retained) assert.deepEqual(values(item.reference), oracle(item.id));
  let tip = nodes.length - 1;
  while (arena.nodes < (1 << 18) + 3) {
    const action = arena.nodes % 3, parent = tip;
    tip = arena.append(parent, actions[action]); nodes.push({ parent, action });
  }
  assert.deepEqual(values(arena.evaluationReference(tip)), oracle(tip));
  for (const item of retained) assert.deepEqual(values(item.reference), oracle(item.id));
  assert.equal(new Set(retained.map(x => x.reference.forEachAssignment)).size, 1,
    'internal references reuse the visitor function while retaining independent ancestry');
});

test('public trace visitors remain detached-callable with a foreign receiver and empty traces', () => {
  const arena = new PackedTraceArena(), ids = ['a'];
  const id = arena.append(0, arena.action(ids, 1));
  const detached = arena.reference(id).forEachAssignment;
  const actual: Array<[readonly string[], number]> = [];
  detached((value, level) => actual.push([value, level]));
  detached.call({ unrelated: true }, (value, level) => actual.push([value, level]));
  assert.deepEqual(actual, [[ids, 1], [ids, 1]]);
  const empty = arena.reference(0).forEachAssignment;
  empty(() => assert.fail('empty trace must not invoke the visitor'));
});

test('shared visitors preserve exception identity, retry, reentry and ancestry during append', () => {
  const arena = new PackedTraceArena(), a = ['a'], b = ['b'];
  const first = arena.append(0, arena.action(a, 0));
  const tip = arena.append(first, arena.action(b, 1));
  const reference = arena.evaluationReference(tip), marker = new Error('visitor sentinel');
  assert.throws(() => reference.forEachAssignment(() => { throw marker; }), error => error === marker);
  const outer: Array<[readonly string[], number]> = []; let nested = false;
  reference.forEachAssignment((ids, level) => {
    outer.push([ids, level]);
    if (!nested) {
      nested = true;
      const inner: Array<[readonly string[], number]> = [];
      arena.evaluationReference(first).forEachAssignment((value, depth) => inner.push([value, depth]));
      assert.deepEqual(inner, [[a, 0]]);
      arena.append(tip, arena.action(['later'], 2));
    }
  });
  assert.deepEqual(outer, [[b, 1], [a, 0]]);
  const again: Array<[readonly string[], number]> = [];
  reference.forEachAssignment((ids, level) => again.push([ids, level]));
  assert.deepEqual(again, outer);
});

test('combined shared traces and multi-level cache retain delayed exact metrics and lazy layouts', () => {
  const { inputs, forest, options, evaluator } = fixture(), ids = ['a', 'b'];
  const arena = new PackedTraceArena();
  const rawTrace = arena.append(0, arena.action(ids, 0));
  const summaryTrace = arena.append(0, arena.action(ids, 1));
  const oracle = new ExactKvUnifiedPolicySolver(inputs, forest);
  const expected = [0, 1].map(level => {
    const frontier = new Map(ids.map(id => [id, level]));
    const candidate = { frontier, renderedTokens: forest.tokensForFrontier(frontier) };
    const result = oracle.scoreCandidates([candidate], options,
      { statesVisited: 0, candidatesGenerated: 1, maxCandidatesAtState: 1, terminalCandidates: 1 });
    assert.ok(result.feasible);
    void result.selected.frontier; void result.selected.layout;
    return result.selected;
  });
  const lazy = [rawTrace, summaryTrace].map((id, index) =>
    evaluator.estimate(arena.evaluationReference(id), expected[index].renderedTokens));
  evaluator.candidate(arena.evaluationReference(rawTrace), expected[0].renderedTokens);
  options.maxTokens = 1;
  for (const chunk of inputs.chunks) chunk.rawTokens *= 3;
  inputs.headTokens = 100;
  for (const [index, estimate] of lazy.entries()) {
    const actual = estimate.exact(), reference = expected[index];
    assert.deepEqual(actual.frontier, reference.frontier);
    assert.deepEqual(actual.layout, reference.layout);
    for (const key of ['renderedTokens', 'fidelityLoss', 'continuityLoss', 'cacheChurn', 'budgetPenalty'] as const)
      assert.equal(actual[key], reference[key]);
  }
});
