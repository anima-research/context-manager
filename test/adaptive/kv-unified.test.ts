import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CanonicalForestError,
  CanonicalSummaryForest,
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
