import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CanonicalForestError,
  CanonicalSummaryForest,
  ExactEnumerationLimitError,
  SparseLabelCeilingError,
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
  assert.deepEqual(dag.roots, ['summary:L2-0']);
  assert.deepEqual(dag.nodes.get('summary:L2-0')?.expandKeys, [
    'summary:L1-0',
    'summary:L1-1',
  ]);
  assert.deepEqual(dag.nodes.get('summary:L1-0')?.expandKeys, ['leaf:c-0000', 'leaf:c-0001']);
  assert.deepEqual(dag.nodes.get('summary:L2-0')?.select?.participantLeafIds, [
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
