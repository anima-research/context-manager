import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CanonicalForestError,
  CanonicalSummaryForest,
  ExactEnumerationLimitError,
  SparseLabelCeilingError,
  heldLevelPin,
  type CanonicalLeafConstraint,
} from '../../src/adaptive/kv-unified.js';
import { accountFrontier, type PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle, buildChronicleWithChain } from './harness.js';

function inputsOf(
  chronicle: MockChronicle,
  overrides: Partial<PickerInputs> = {},
): PickerInputs {
  return {
    chunks: chronicle.chunks,
    summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
    ...overrides,
  };
}

test('kv-unified canonical forest follows ownership chains and finds the exact token floor', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 36,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(chronicle);
  const forest = new CanonicalSummaryForest(inputs);

  assert.equal(forest.roots.length, 1);
  assert.equal(forest.roots[0].kind, 'summary');
  assert.equal(forest.allSummaries().length, 7);
  assert.deepEqual(forest.leaf('c-0000')?.availableLevels, [0, 1, 2]);

  const result = forest.minimumTokens(10_000);
  assert.equal(result.feasible, true);
  assert.equal(result.floorTokens, 200);
  if (!result.feasible) return;
  assert.ok([...result.frontier.values()].every((level) => level === 2));
  assert.equal(accountFrontier(inputs, result.frontier).tokens, result.floorTokens);
});

test('kv-unified canonical forest rejects a missing ownership link loudly', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  const l1 = chronicle.produceL1(['a']);
  l1.parentId = 'missing-L2';

  assert.throws(
    () => new CanonicalSummaryForest(inputsOf(chronicle)),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalForestError);
      assert.ok(error.issues.some((issue) => issue.code === 'missing-parent'));
      return true;
    },
  );
});

test('kv-unified canonical forest rejects ownership cycles', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50, mergeThreshold: 1 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  const l1 = chronicle.produceL1(['a']);
  const l2 = chronicle.produceUpper(2, [l1.id]);
  l2.parentId = l1.id;
  // Ownership climbs only to a parent that lists the summary, so the cycle
  // needs the L1 to list its L2 as well.
  l1.sourceIds = [...l1.sourceIds, l2.id];

  assert.throws(
    () => new CanonicalSummaryForest(inputsOf(chronicle)),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalForestError);
      assert.ok(error.issues.some((issue) => issue.code === 'ownership-cycle'));
      return true;
    },
  );
});

test('kv-unified canonical forest rejects interleaved root ownership', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.addChunk({ id: 'c', rawTokens: 100 });
  chronicle.produceL1(['a', 'c']);
  chronicle.produceL1(['b']);

  assert.throws(
    () => new CanonicalSummaryForest(inputsOf(chronicle)),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalForestError);
      assert.ok(error.issues.some((issue) => issue.code === 'non-contiguous-ownership'));
      return true;
    },
  );
});

test('kv-unified can explicitly treeify non-contiguous summaries', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.addChunk({ id: 'c', rawTokens: 100 });
  const scar = chronicle.produceL1(['a', 'c']);
  chronicle.produceL1(['b']);

  const forest = new CanonicalSummaryForest(inputsOf(chronicle), {
    treeifyNonContiguousSummaries: true,
  });
  assert.deepEqual(forest.treeifiedSummaryIds, [scar.id]);
  assert.deepEqual(forest.leaf('a')?.availableLevels, [0]);
  assert.deepEqual(forest.leaf('c')?.availableLevels, [0]);
  assert.deepEqual(forest.leaf('b')?.availableLevels, [0, 1]);
  const floor = forest.minimumTokens();
  assert.equal(floor.feasible, true);
  assert.equal(floor.floorTokens, 250, 'scar leaves raw; healthy L1 remains selectable');
});

test('kv-unified can preserve gap-bearing summaries as disjoint ownership actions', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.addChunk({ id: 'c', rawTokens: 100 });
  chronicle.addChunk({ id: 'd', rawTokens: 100 });
  const left = chronicle.produceL1(['a', 'c']);
  const right = chronicle.produceL1(['b', 'd']);

  const forest = new CanonicalSummaryForest(inputsOf(chronicle), {
    preserveGapBearingSummaries: true,
  });
  assert.deepEqual(forest.treeifiedSummaryIds, []);
  assert.deepEqual(forest.gapBearingSummaryIds, [left.id, right.id].sort());
  assert.deepEqual(forest.leaf('a')?.availableLevels, [0, 1]);
  assert.deepEqual(forest.leaf('b')?.availableLevels, [0, 1]);

  const floor = forest.minimumTokens();
  assert.equal(floor.feasible, true);
  assert.equal(floor.floorTokens, 100, 'both interleaved recalls remain selectable');
  if (!floor.feasible) return;
  assert.equal(accountFrontier(inputsOf(chronicle), floor.frontier).tokens, 100);

  const labels = forest.propagateExactLabels();
  assert.ok(labels.candidates.some((candidate) => candidate.renderedTokens === 100));
});

test('gap preservation and destructive treeification cannot both be enabled', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });

  assert.throws(
    () => new CanonicalSummaryForest(inputsOf(chronicle), {
      treeifyNonContiguousSummaries: true,
      preserveGapBearingSummaries: true,
    }),
    /mutually exclusive/,
  );
});

test('kv-unified intersects locks and pins instead of choosing precedence', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  const chunk = chronicle.addChunk({ id: 'a', rawTokens: 100, lockedByAgent: true });
  chronicle.produceL1(['a']);
  chunk.currentResolution = 0;
  chunk.pinLevel = 1;

  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.deepEqual(forest.leaf('a')?.allowedLevels, []);
  const result = forest.minimumTokens(1_000);
  assert.equal(result.feasible, false);
  if (result.feasible) return;
  assert.equal(result.certificate.reason, 'constraint-conflict');
  assert.deepEqual(
    result.certificate.bindingLeaves[0].constraints.map((constraint) => constraint.source),
    ['lockedByAgent', 'pin-level'],
  );
});

test("a constraint conflict's certificate names every leaf that conflicts, not only the first", () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  for (const id of ['a', 'b']) {
    const chunk = chronicle.addChunk({ id, rawTokens: 100, lockedByAgent: true });
    chronicle.produceL1([id]);
    chunk.currentResolution = 0;
    chunk.pinLevel = 1;
  }

  const result = new CanonicalSummaryForest(inputsOf(chronicle)).minimumTokens(1_000);
  assert.equal(result.feasible, false);
  if (result.feasible) return;
  assert.equal(result.certificate.reason, 'constraint-conflict');
  assert.deepEqual(result.certificate.bindingLeaves.map((conflict) => conflict.leafId), ['a', 'b']);
});

test('a wall one token under the floor is infeasible, and the floor itself is feasible', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  for (const id of ['a', 'b', 'c']) chronicle.addChunk({ id, rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  const unbounded = forest.minimumTokens();
  assert.equal(unbounded.feasible, true);
  if (!unbounded.feasible) return;
  const floor = unbounded.floorTokens;
  assert.equal(floor, 150, "premise: the floor is a and b's L1 (50) and c raw (100)");
  assert.equal(forest.minimumTokens(floor).feasible, true, 'a wall at the floor fits');
  const under = forest.minimumTokens(floor - 1);
  assert.equal(under.feasible, false, 'a wall one token under the floor does not');
  if (under.feasible) return;
  assert.equal(under.certificate.reason, 'over-budget');
});

test('kv-unified holds a level pin at the deepest level its chain supplies until the pinned one exists (#193)', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  const a = chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  const c = chronicle.addChunk({ id: 'c', rawTokens: 100 });
  const d = chronicle.addChunk({ id: 'd', rawTokens: 100 });
  const ab = chronicle.produceL1(['a', 'b']);
  const cOnly = chronicle.produceL1(['c']);
  a.pinLevel = 2;
  c.pinLevel = 2;
  d.pinLevel = 2;

  // Held: a and c at their L1, d (no summary) raw; nothing conflicts.
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.deepEqual(forest.constraintConflicts, []);
  assert.deepEqual(forest.leaf('a')?.allowedLevels, [1]);
  assert.deepEqual(forest.leaf('c')?.allowedLevels, [1]);
  assert.deepEqual(forest.leaf('d')?.allowedLevels, [0]);
  assert.deepEqual(heldLevelPin(forest.leaf('a')!), { level: 2, heldAt: 1 });
  assert.deepEqual(heldLevelPin(forest.leaf('d')!), { level: 2, heldAt: 0 });
  assert.equal(heldLevelPin(forest.leaf('b')!), null, 'no pin, no hold');
  assert.ok(forest.minimumTokens(1_000).feasible);

  // The L2 arrives. The next compile derives the forest, and the extension
  // rebuilds the leaves whose chain changed: the pin is at its level.
  const l2 = chronicle.produceUpper(2, [ab.id, cOnly.id]);
  const merged = CanonicalSummaryForest.derive(forest, inputsOf(chronicle));
  assert.ok(merged, 'setup: a merge extends the previous forest');
  assert.deepEqual(merged.leaf('a')?.allowedLevels, [2]);
  assert.deepEqual(merged.leaf('c')?.allowedLevels, [2]);
  assert.equal(heldLevelPin(merged.leaf('a')!), null);
  assert.deepEqual(heldLevelPin(merged.leaf('d')!), { level: 2, heldAt: 0 });

  // A level a summary no longer supplies is held again.
  chronicle.summaries.delete(l2.id);
  chronicle.recallPairTokens.delete(l2.id);
  delete ab.parentId;
  delete cOnly.parentId;
  const dropped = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.deepEqual(dropped.leaf('a')?.allowedLevels, [1]);
  assert.deepEqual(dropped.constraintConflicts, []);

  // A lock stays strict, judged against the pinned level whether or not it
  // exists: locked at its carried L0, or at the L1 the pin would be held at,
  // the pin isn't held, the leaf has no level, and the conflict names the
  // missing L2.
  a.lockedByAgent = true;
  for (const carried of [0, 1]) {
    a.currentResolution = carried;
    const locked = new CanonicalSummaryForest(inputsOf(chronicle));
    assert.deepEqual(locked.leaf('a')?.allowedLevels, [], `locked at L${carried}`);
    assert.equal(heldLevelPin(locked.leaf('a')!), null, `locked at L${carried}: a contradicted pin isn't held`);
    assert.deepEqual(
      locked.constraintConflicts.map((conflict) => [
        conflict.leafId,
        conflict.constraints.map((constraint) => constraint.source),
        conflict.requestedMissingLevels,
      ]),
      [['a', ['lockedByAgent', 'pin-level'], [2]]],
      `locked at L${carried}`,
    );
  }
  // Locked at the pinned level once it exists, the two agree.
  chronicle.produceUpper(2, [ab.id, cOnly.id]);
  a.currentResolution = 2;
  const agreeing = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.deepEqual(agreeing.leaf('a')?.allowedLevels, [2]);
  assert.deepEqual(agreeing.constraintConflicts, []);
});

test('kv-unified holds a level pin only while every other constraint on its leaf allows both the pinned level and the level held at (#193)', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  const a = chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);
  const c = chronicle.addChunk({ id: 'c', rawTokens: 100 });
  // Each row: the leaf ('a', whose chain supplies L1, or 'c', whose chain
  // supplies no summary), its pinned level, the other constraints on it, then
  // the leaf's allowed levels, the missing levels its conflict names (null: no
  // conflict) and the level it's held at (null: not held).
  const cases: Array<[string, number | undefined, CanonicalLeafConstraint[], number[], number[] | null, number | null]> = [
    ['a', 2, [{ kind: 'max', level: 3, source: 'cap' }], [1], null, 1],
    ['a', 2, [{ kind: 'max', level: 2, source: 'cap' }], [1], null, 1],
    ['a', 2, [{ kind: 'min', level: 1, source: 'floor' }], [1], null, 1],
    ['a', 2, [{ kind: 'raw', source: 'raw' }], [], [2], null],
    ['a', 2, [{ kind: 'max', level: 1, source: 'cap' }], [], [2], null],
    ['a', 2, [{ kind: 'exact', level: 1, source: 'exact' }], [], [2], null],
    ['a', 2, [{ kind: 'min', level: 3, source: 'floor' }], [], [2, 3], null],
    // These floors allow the pinned level but not the L1 it would be held
    // at, so the pin isn't held and its conflict names the pinned level.
    ['a', 2, [{ kind: 'min', level: 2, source: 'floor' }], [], [2], null],
    ['a', 3, [{ kind: 'min', level: 2, source: 'floor' }], [], [2, 3], null],
    // Every other constraint has to allow both levels, not only the first.
    ['a', 2, [{ kind: 'max', level: 3, source: 'cap' }, { kind: 'min', level: 2, source: 'floor' }], [], [2], null],
    // A bound that isn't a non-negative integer allows no level (buildLeaf
    // empties the leaf for it), so the pin isn't held and its conflict names
    // the pinned level.
    ['a', 2, [{ kind: 'min', level: -1, source: 'floor' }], [], [2], null],
    ['a', 2, [{ kind: 'min', level: 0.5, source: 'floor' }], [], [2], null],
    ['a', 2, [{ kind: 'max', level: 2.5, source: 'cap' }], [], [2], null],
    // Where the chain supplies no summary, the pin is held raw, so a floor
    // that excludes raw makes it strict.
    ['c', 2, [{ kind: 'max', level: 2, source: 'cap' }], [0], null, 0],
    ['c', 2, [{ kind: 'min', level: 1, source: 'floor' }], [], [1, 2], null],
    // A pinned level that isn't a non-negative integer is never held:
    // buildLeaf empties the leaf, and its conflict names no level.
    ['a', 1.5, [], [], [], null],
    ['a', -1, [], [], [], null],
    ['a', Number.NaN, [], [], [], null],
    // A caller's exact constraint that carries the pin's label isn't a level
    // pin: only the one made from the chunk's pinLevel is held.
    ['a', undefined, [{ kind: 'exact', level: 2, source: 'pin-level' }], [], [2], null],
  ];
  for (const [id, pinLevel, constraints, allowed, missing, heldAt] of cases) {
    a.pinLevel = undefined;
    c.pinLevel = undefined;
    (id === 'a' ? a : c).pinLevel = pinLevel;
    const forest = new CanonicalSummaryForest(inputsOf(chronicle), { constraints: new Map([[id, constraints]]) });
    const label = `${id} ${pinLevel === undefined ? 'unpinned' : `pinned at L${pinLevel}`} beside ${JSON.stringify(constraints)}`;
    assert.deepEqual(forest.leaf(id)?.allowedLevels, allowed, label);
    assert.deepEqual(forest.constraintConflicts.map((conflict) => conflict.requestedMissingLevels), missing ? [missing] : [], label);
    assert.deepEqual(heldLevelPin(forest.leaf(id)!), heldAt === null ? null : { level: pinLevel, heldAt }, label);
  }
});

test('kv-unified holds a level pin at the deepest level below it, not at a level above it that the chain supplies (#193)', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  const a = chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  const l1 = chronicle.produceL1(['a', 'b']);
  const l2 = chronicle.produceUpper(2, [l1.id]);
  // A lineage that skips a level: the summary over the L2 is an L4.
  (chronicle.produceUpper(3, [l2.id]) as { level: number }).level = 4;
  a.pinLevel = 3;
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.deepEqual(forest.leaf('a')?.availableLevels, [0, 1, 2, 4], 'setup: the chain supplies L1, L2 and L4, and no L3');
  assert.deepEqual(forest.leaf('a')?.allowedLevels, [2]);
  assert.deepEqual(heldLevelPin(forest.leaf('a')!), { level: 3, heldAt: 2 });
});

test('kv-unified suggests producing the missing levels only where that clears every conflict', () => {
  const release = 'Release or reconcile the listed constraints.';
  const produce = 'Release or reconcile the listed constraints, or produce the missing levels.';
  type Chunk = ReturnType<MockChronicle['addChunk']>;
  const cases: Array<{ name: string; a?: (chunk: Chunk) => void; b?: (chunk: Chunk) => void;
    constraints?: Record<string, CanonicalLeafConstraint[]>; missing: number[]; suggestion: string }> = [
    { name: 'a lock against a pin at a level that exists', a: (c) => { c.lockedByAgent = true; c.currentResolution = 0; c.pinLevel = 1; }, missing: [], suggestion: release },
    { name: 'a pin at a level that is no integer', a: (c) => { c.pinLevel = 1.5; }, missing: [], suggestion: release },
    { name: 'a raw pin against a pin at a level that exists', a: (c) => { c.pinned = true; c.pinLevel = 1; }, missing: [], suggestion: release },
    { name: 'an exact constraint at a missing level', constraints: { a: [{ kind: 'exact', level: 2, source: 'caller' }] }, missing: [2], suggestion: produce },
    { name: 'a floor above every level supplied', constraints: { a: [{ kind: 'min', level: 2, source: 'caller' }] }, missing: [2], suggestion: produce },
    { name: 'a lock against a pin at a missing level', a: (c) => { c.lockedByAgent = true; c.currentResolution = 0; c.pinLevel = 2; }, missing: [2], suggestion: release },
    { name: 'a raw pin against an exact constraint at a missing level', a: (c) => { c.pinned = true; },
      constraints: { a: [{ kind: 'exact', level: 2, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'a missing level beside a lock against a pin', b: (c) => { c.lockedByAgent = true; c.currentResolution = 0; c.pinLevel = 1; },
      constraints: { a: [{ kind: 'exact', level: 2, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'a cap below an exact constraint at a missing level',
      constraints: { a: [{ kind: 'max', level: 1, source: 'caller' }, { kind: 'exact', level: 2, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'a cap at an exact constraint\'s missing level',
      constraints: { a: [{ kind: 'max', level: 2, source: 'caller' }, { kind: 'exact', level: 2, source: 'caller' }] }, missing: [2], suggestion: produce },
    { name: 'a floor above a cap', constraints: { a: [{ kind: 'min', level: 2, source: 'caller' }, { kind: 'max', level: 1, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'a floor below an exact constraint, with two levels missing',
      constraints: { a: [{ kind: 'min', level: 2, source: 'caller' }, { kind: 'exact', level: 3, source: 'caller' }] }, missing: [2, 3], suggestion: produce },
    { name: 'a missing level beside a floor that is no integer',
      constraints: { a: [{ kind: 'exact', level: 2, source: 'caller' }], b: [{ kind: 'min', level: 0.5, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'a missing level beside a negative floor',
      constraints: { a: [{ kind: 'exact', level: 2, source: 'caller' }], b: [{ kind: 'min', level: -1, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'a lock against a pin beside a missing level', a: (c) => { c.lockedByAgent = true; c.currentResolution = 0; c.pinLevel = 1; },
      constraints: { b: [{ kind: 'exact', level: 2, source: 'caller' }] }, missing: [2], suggestion: release },
    { name: 'missing levels on two leaves that producing clears',
      constraints: { a: [{ kind: 'exact', level: 2, source: 'caller' }], b: [{ kind: 'min', level: 2, source: 'caller' }] }, missing: [2], suggestion: produce },
  ];
  for (const kase of cases) {
    const chronicle = new MockChronicle({ recallPairTokens: 50 });
    const a = chronicle.addChunk({ id: 'a', rawTokens: 100 });
    const b = chronicle.addChunk({ id: 'b', rawTokens: 100 });
    chronicle.produceL1(['a', 'b']);
    kase.a?.(a);
    kase.b?.(b);
    const constraints = new Map(Object.entries(kase.constraints ?? {}));
    const result = new CanonicalSummaryForest(inputsOf(chronicle), { constraints }).minimumTokens(1_000);
    assert.equal(result.feasible, false, kase.name);
    if (result.feasible) continue;
    assert.equal(result.certificate.reason, 'constraint-conflict', kase.name);
    assert.deepEqual(result.certificate.missingLevels, kase.missing, kase.name);
    assert.equal(result.certificate.suggestion, kase.suggestion, kase.name);
  }
});

test('kv-unified exact feasibility prices a protected raw hole beside its recall', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  const protectedChunk = chronicle.addChunk({ id: 'a', rawTokens: 100, pinned: true });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);
  assert.equal(protectedChunk.pinned, true);
  const inputs = inputsOf(chronicle);

  const result = new CanonicalSummaryForest(inputs).minimumTokens(1_000);
  assert.equal(result.feasible, true);
  assert.equal(result.floorTokens, 150, '100 raw hole + one 50-token recall');
  if (!result.feasible) return;
  assert.equal(result.frontier.get('a'), 0);
  assert.equal(result.frontier.get('b'), 1);
  assert.equal(accountFrontier(inputs, result.frontier).tokens, 150);
});

test('kv-unified supports an explicit at-or-coarser constraint', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 6,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 50,
  });
  const constraints = new Map<string, readonly CanonicalLeafConstraint[]>([
    ['c-0000', [{ kind: 'min', level: 1, source: 'forget-at-least-L1' }]],
  ]);
  const forest = new CanonicalSummaryForest(inputsOf(chronicle), { constraints });
  assert.deepEqual(forest.leaf('c-0000')?.allowedLevels, [1]);
  const result = forest.minimumTokens(1_000);
  assert.equal(result.feasible, true);
  assert.equal(result.floorTokens, 50);
});

test('kv-unified reports the exact over-budget floor and required increase', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100, pinned: true });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);

  const result = new CanonicalSummaryForest(inputsOf(chronicle)).minimumTokens(120);
  assert.equal(result.feasible, false);
  if (result.feasible) return;
  assert.equal(result.floorTokens, 150);
  assert.equal(result.certificate.reason, 'over-budget');
  assert.equal(result.certificate.requiredAdditionalTokens, 30);
  assert.equal(result.certificate.suggestion, 'Raise W by at least 30 tokens, or release a binding protection.');
  assert.ok(result.frontier);
});

test('kv-unified does not double-count externally accounted head holes', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);
  const inputs = inputsOf(chronicle, {
    headTokens: 100,
    headChunkIds: new Set(['a']),
  });

  const result = new CanonicalSummaryForest(inputs).minimumTokens(1_000);
  assert.equal(result.feasible, true);
  assert.equal(result.floorTokens, 150, 'fixed head 100 + recall 50');
  if (!result.feasible) return;
  assert.equal(result.frontier.get('a'), 0);
  assert.equal(result.frontier.get('b'), 1);
  assert.equal(accountFrontier(inputs, result.frontier).tokens, 150);
});

test('kv-unified minimum-token pass agrees with brute force on random small forests', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 4,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  const inputs = inputsOf(chronicle);
  let randomState = 0x5eed1234;
  const next = (): number => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const choices: Array<readonly CanonicalLeafConstraint[]> = [
    [],
    [{ kind: 'exact', level: 0, source: 'random-exact-raw' }],
    [{ kind: 'exact', level: 1, source: 'random-exact-l1' }],
    [{ kind: 'exact', level: 2, source: 'random-exact-l2' }],
    [{ kind: 'max', level: 1, source: 'random-max-l1' }],
    [{ kind: 'min', level: 1, source: 'random-min-l1' }],
    [{ kind: 'min', level: 2, source: 'random-min-l2' }],
    [
      { kind: 'max', level: 0, source: 'random-conflict-max' },
      { kind: 'min', level: 1, source: 'random-conflict-min' },
    ],
  ];

  for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
    const constraints = new Map<string, readonly CanonicalLeafConstraint[]>();
    for (const chunk of chronicle.chunks) {
      const selected = choices[next() % choices.length];
      if (selected.length > 0) constraints.set(chunk.id, selected);
    }
    const forest = new CanonicalSummaryForest(inputs, { constraints });
    const result = forest.minimumTokens();
    const leaves = forest.orderedLeaves();
    let bruteFloor = Number.POSITIVE_INFINITY;
    const frontier = new Map<string, number>();
    const enumerate = (index: number): void => {
      if (index === leaves.length) {
        bruteFloor = Math.min(bruteFloor, accountFrontier(inputs, frontier).tokens);
        return;
      }
      const leaf = leaves[index];
      for (const level of leaf.allowedLevels) {
        frontier.set(leaf.id, level);
        enumerate(index + 1);
      }
      frontier.delete(leaf.id);
    };
    enumerate(0);

    if (!Number.isFinite(bruteFloor)) {
      assert.equal(result.feasible, false, `case ${caseIndex} should be constraint-infeasible`);
      if (!result.feasible) assert.equal(result.certificate.reason, 'constraint-conflict');
    } else {
      assert.equal(result.feasible, true, `case ${caseIndex} should have a feasible assignment`);
      assert.equal(result.floorTokens, bruteFloor, `case ${caseIndex} token floor`);
    }
  }
});

test('kv-unified decision DAG is linear and preserves chronological expand edges', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 4,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  const dag = forest.decisionDag();

  assert.equal(dag.nodeCount, 7, '4 leaves + 2 L1s + 1 L2');
  assert.equal(dag.expandEdgeCount, 6, 'one expand edge per ownership-tree edge');
  const node = (key: string) => dag.nodes.get(key)!;
  const kindAndId = (key: string) => [node(key).kind, node(key).id];
  assert.deepEqual(dag.roots.map(kindAndId), [['summary', 'L2-0']]);
  const root = node(dag.roots[0]!);
  assert.deepEqual(root.expandKeys.map(kindAndId), [['summary', 'L1-0'], ['summary', 'L1-1']]);
  assert.deepEqual(node(root.expandKeys[0]!).expandKeys.map(kindAndId), [['leaf', 'c-0000'], ['leaf', 'c-0001']]);
  assert.deepEqual(root.select?.participantLeafIds, [
    'c-0000',
    'c-0001',
    'c-0002',
    'c-0003',
  ]);
});

test('kv-unified exact oracle enumerates the complete cut set and reports growth', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 4,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  const enumeration = forest.enumerateExactCuts();

  assert.equal(enumeration.candidates.length, 5, 'L2 select or four combinations under two L1s');
  assert.deepEqual(
    enumeration.candidates.map((candidate) => candidate.renderedTokens),
    [55, 110, 235, 235, 360],
  );
  assert.equal(enumeration.stats.terminalCandidates, 5);
  assert.ok(enumeration.stats.statesVisited >= 3);
  assert.ok(enumeration.stats.maxCandidatesAtState >= 5);
  const minimum = forest.minimumTokens();
  assert.equal(minimum.feasible, true);
  assert.equal(enumeration.candidates[0].renderedTokens, minimum.floorTokens);
});

test('kv-unified exact oracle enumerates protected-hole select and expand alternatives', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100, pinned: true });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));

  const dag = forest.decisionDag();
  assert.deepEqual(dag.nodes.get('summary:L1-0')?.select?.participantLeafIds, ['b']);
  assert.deepEqual(dag.nodes.get('summary:L1-0')?.select?.protectedHoleLeafIds, ['a']);
  assert.deepEqual(
    forest.enumerateExactCuts().candidates.map((candidate) => candidate.renderedTokens),
    [150, 200],
  );
});

test('kv-unified exact oracle refuses forests above its explicit development limit', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 6,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.throws(() => forest.enumerateExactCuts({ maxLeaves: 5 }), ExactEnumerationLimitError);
});

test('kv-unified left-to-right labels reproduce the recursive exact frontier', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 8,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  const recursive = forest.enumerateExactCuts();
  const labels = forest.propagateExactLabels();
  const signature = (frontier: ReadonlyMap<string, number>): string =>
    chronicle.chunks.map((chunk) => `${chunk.id}:${frontier.get(chunk.id) ?? 0}`).join('|');
  assert.deepEqual(
    labels.candidates.map((candidate) => [candidate.renderedTokens, signature(candidate.frontier)]),
    recursive.candidates.map((candidate) => [candidate.renderedTokens, signature(candidate.frontier)]),
  );
  assert.equal(labels.stats.terminalLabels, recursive.stats.terminalCandidates);
  assert.ok(labels.stats.structuralStates > 1);
  assert.ok(labels.stats.maxLabelsPerState > 0);
});

test('kv-unified exact labels stop loudly at the configured pre-bucketing ceiling', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  const forest = new CanonicalSummaryForest(inputsOf(chronicle));
  assert.throws(
    () => forest.propagateExactLabels({ labelCeiling: 10 }),
    SparseLabelCeilingError,
  );
});
