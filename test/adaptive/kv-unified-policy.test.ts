import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExactKvUnifiedPolicySolver,
  KvUnifiedPolicyError,
  type AcceptedPresentationReference,
  type ExactPolicyCandidate,
} from '../../src/adaptive/kv-unified-policy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { KvUnifiedStrategy } from '../../src/adaptive/strategies/kv-unified.js';
import { Picker } from '../../src/adaptive/picker.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

function fixture(): { chronicle: MockChronicle; inputs: PickerInputs } {
  const chronicle = buildChronicleWithChain({
    chunkCount: 4,
    tokensPerChunk: 90,
    mergeThreshold: 2,
    recallPairTokens: 55,
  });
  return {
    chronicle,
    inputs: {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0,
      tailTokens: 0,
      headChunkIds: new Set(),
      tailChunkIds: new Set(),
    },
  };
}

function rawPresentation(inputs: PickerInputs): AcceptedPresentationReference {
  return {
    currentSeq: 0,
    leaves: new Map(
      inputs.chunks.map((chunk) => [
        chunk.id,
        { repHash: `raw:${chunk.id}`, level: 0, lastChangedSeq: 0 },
      ]),
    ),
  };
}

function isOnlyFolded(candidate: ExactPolicyCandidate, ids: readonly string[]): boolean {
  const wanted = new Set(ids);
  return [...candidate.frontier].every(([id, level]) =>
    wanted.has(id) ? level === 1 : level === 0,
  );
}

test('kv-unified exact policy applies the nonlinear occupancy comfort band', () => {
  const { inputs } = fixture();
  const result = new ExactKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 400,
    policy: {
      alpha: 0,
      budgetLowRatio: 0.5,
      budgetHighRatio: 0.75,
      budgetUnderLambda: 1_000,
      budgetOverLambda: 1_000,
      cacheLambda: 0,
      continuityLambda: 0,
    },
  });

  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.selected.renderedTokens, 235, 'one L1 fold lands inside the flat band');
  const raw = result.candidates.find((candidate) => candidate.renderedTokens === 360)!;
  assert.equal(raw.fidelityLoss, 0);
  assert.ok(raw.budgetPenalty > 0, 'near-wall raw cut pays the upper hinge');
  assert.equal(result.selected.budgetPenalty, 0);
});

test('kv-unified ranks producible higher-level summaries by conservative welfare gain', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  for (let index = 0; index < 4; index++) {
    const id = `latent-${index}`;
    chronicle.addChunk({ id, rawTokens: 100 });
    chronicle.produceL1([id]);
  }
  const inputs: PickerInputs = {
    chunks: chronicle.chunks,
    summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
  const strategy = new KvUnifiedStrategy({
    policy: {
      alpha: 0,
      budgetLowRatio: 0,
      budgetHighRatio: 0.5,
      budgetUnderLambda: 0,
      budgetOverLambda: 100_000,
      cacheLambda: 0,
      continuityLambda: 0,
    },
    tokenBucketSize: 10,
    continuityBucketSize: 10,
    fidelityBucketSize: 10,
    labelCeiling: 10_000,
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4 },
  });
  const result = strategy.solve(inputs, { totalBudget: 300, targetBudget: 270, slack: 0.1 });
  assert.equal(result.exhausted, false);
  assert.equal(strategy.lastDemandEvaluations.length, 2);
  assert.ok(strategy.lastDemandEvaluations.every((item) => item.conservativeRecallTokens === 30));
  assert.ok(strategy.lastDemandEvaluations.every((item) => item.conservativeImprovement > 0));
  assert.deepEqual(result.produced.map((request) => request.level), [2, 2]);
});

test('kv-unified continuity weights an equivalent recent rewrite more than an old rewrite', () => {
  const { inputs } = fixture();
  const result = new ExactKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 0,
      continuityLambda: 10_000,
      continuityScale: 100,
      continuityRecencyHalfLifeTokens: 90,
      continuityRecencyFloor: 0.1,
      continuityStableFloor: 1,
    },
  });

  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  const oldFold = result.candidates.find((candidate) =>
    isOnlyFolded(candidate, ['c-0000', 'c-0001']),
  )!;
  const recentFold = result.candidates.find((candidate) =>
    isOnlyFolded(candidate, ['c-0002', 'c-0003']),
  )!;
  assert.ok(recentFold.continuityLoss > oldFold.continuityLoss);
  assert.ok(isOnlyFolded(result.selected, ['c-0000', 'c-0001']));
});

test('kv-unified warm-cache pricing can prefer the later fold', () => {
  const { inputs } = fixture();
  const rawLayout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const result = new ExactKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    cache: {
      immutablePrefixHash: 'tools-v1',
      layout: rawLayout,
      markers: [
        { unitIndex: 2, offset: 180 },
        { unitIndex: 4, offset: 360 },
      ],
    },
    currentImmutablePrefixHash: 'tools-v1',
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 10_000,
      cacheScale: 100,
      continuityLambda: 0,
    },
  });

  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  const oldFold = result.candidates.find((candidate) =>
    isOnlyFolded(candidate, ['c-0000', 'c-0001']),
  )!;
  const recentFold = result.candidates.find((candidate) =>
    isOnlyFolded(candidate, ['c-0002', 'c-0003']),
  )!;
  assert.ok(recentFold.cacheChurn < oldFold.cacheChurn);
  assert.ok(isOnlyFolded(result.selected, ['c-0002', 'c-0003']));
});

test('kv-unified immutable-prefix mismatch disables K without disabling continuity', () => {
  const { inputs } = fixture();
  const rawLayout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const result = new ExactKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    cache: {
      immutablePrefixHash: 'tools-v1',
      layout: rawLayout,
      markers: [{ unitIndex: 4, offset: 360 }],
    },
    currentImmutablePrefixHash: 'tools-v2',
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 10_000,
      continuityLambda: 10_000,
      continuityScale: 100,
      continuityRecencyHalfLifeTokens: 90,
      continuityRecencyFloor: 0.1,
      continuityStableFloor: 1,
    },
  });

  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.cacheRelevant, false);
  assert.ok(result.candidates.every((candidate) => candidate.cacheChurn === 0));
  assert.ok(result.candidates.some((candidate) => candidate.continuityLoss > 0));
  assert.ok(isOnlyFolded(result.selected, ['c-0000', 'c-0001']));
});

test('kv-unified forced continuity floor removes the unavoidable rewrite charge', () => {
  const { inputs } = fixture();
  const result = new ExactKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 60,
    presentation: rawPresentation(inputs),
    policy: {
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 0,
      continuityLambda: 10_000,
      continuityScale: 100,
    },
  });

  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.candidates.length, 1);
  assert.equal(result.selected.renderedTokens, 55);
  assert.equal(result.selected.continuityLoss, result.continuityFloor);
  assert.equal(result.selected.continuityExcess, 0);
});

test('kv-unified continuity relaxation changes only the C term', () => {
  const { inputs } = fixture();
  const solver = new ExactKvUnifiedPolicySolver(inputs);
  const base = {
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 0,
      continuityLambda: 10_000,
      continuityScale: 100,
      continuityRecencyHalfLifeTokens: 90,
      continuityRecencyFloor: 0.1,
      continuityStableFloor: 1,
    },
  } as const;
  const normal = solver.solve({ ...base, continuityMultiplier: 1 });
  const surgery = solver.solve({ ...base, continuityMultiplier: 0 });
  assert.equal(normal.feasible, true);
  assert.equal(surgery.feasible, true);
  if (!normal.feasible || !surgery.feasible) return;

  const normalRecent = normal.candidates.find((candidate) =>
    isOnlyFolded(candidate, ['c-0002', 'c-0003']),
  )!;
  const surgeryRecent = surgery.candidates.find((candidate) =>
    isOnlyFolded(candidate, ['c-0002', 'c-0003']),
  )!;
  assert.equal(normalRecent.continuityLoss, surgeryRecent.continuityLoss);
  assert.equal(normalRecent.cacheChurn, surgeryRecent.cacheChurn);
  assert.ok(normalRecent.score > surgeryRecent.score);
});

test('kv-unified malformed relaxation fails closed and invalid bands fail loudly', () => {
  const { inputs } = fixture();
  const solver = new ExactKvUnifiedPolicySolver(inputs);
  const common = {
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 0,
      continuityLambda: 10_000,
      continuityScale: 100,
    },
  };
  const normal = solver.solve({ ...common, continuityMultiplier: 1 });
  const malformed = solver.solve({ ...common, continuityMultiplier: Number.NaN });
  assert.equal(normal.feasible, true);
  assert.equal(malformed.feasible, true);
  if (normal.feasible && malformed.feasible) {
    assert.equal(malformed.selected.score, normal.selected.score);
  }

  assert.throws(
    () =>
      solver.solve({
        maxTokens: 250,
        policy: { budgetLowRatio: 0.9, budgetHighRatio: 0.5 },
      }),
    KvUnifiedPolicyError,
  );
});

test('kv-unified left-to-right labels agree with recursive oracle on full welfare selection', () => {
  const { inputs } = fixture();
  const rawLayout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const solver = new ExactKvUnifiedPolicySolver(inputs);
  const options = {
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    cache: {
      immutablePrefixHash: 'tools-v1',
      layout: rawLayout,
      markers: [
        { unitIndex: 2, offset: 180 },
        { unitIndex: 4, offset: 360 },
      ],
    },
    currentImmutablePrefixHash: 'tools-v1',
    policy: {
      alpha: 0,
      budgetUnderLambda: 100,
      budgetOverLambda: 200,
      cacheLambda: 500,
      cacheScale: 100,
      continuityLambda: 700,
      continuityScale: 100,
      continuityRecencyHalfLifeTokens: 90,
      continuityRecencyFloor: 0.1,
      continuityStableFloor: 1,
    },
  } as const;
  const recursive = solver.solve({ ...options, candidateSource: 'recursive' });
  const labels = solver.solve({ ...options, candidateSource: 'labels' });
  assert.equal(recursive.feasible, true);
  assert.equal(labels.feasible, true);
  if (!recursive.feasible || !labels.feasible) return;
  const signature = (candidate: ExactPolicyCandidate): string =>
    inputs.chunks.map((chunk) => `${chunk.id}:${candidate.frontier.get(chunk.id) ?? 0}`).join('|');
  assert.equal(signature(labels.selected), signature(recursive.selected));
  assert.equal(labels.selected.score, recursive.selected.score);
  assert.deepEqual(
    labels.candidates.map((candidate) => [signature(candidate), candidate.score]),
    recursive.candidates.map((candidate) => [signature(candidate), candidate.score]),
  );
});

test('kv-unified partial-metric Pareto propagation agrees with the exhaustive oracle', () => {
  const { inputs } = fixture();
  const rawLayout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const options = {
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    cache: {
      immutablePrefixHash: 'tools-v1',
      layout: rawLayout,
      markers: [{ unitIndex: 2, offset: 180 }, { unitIndex: 4, offset: 360 }],
    },
    currentImmutablePrefixHash: 'tools-v1',
    policy: {
      alpha: 0,
      budgetUnderLambda: 100,
      budgetOverLambda: 200,
      cacheLambda: 500,
      cacheScale: 100,
      continuityLambda: 700,
      continuityScale: 100,
      continuityRecencyHalfLifeTokens: 90,
      continuityRecencyFloor: 0.1,
      continuityStableFloor: 1,
    },
  } as const;
  const oracle = new ExactKvUnifiedPolicySolver(inputs).solve(options);
  const pareto = new ParetoKvUnifiedPolicySolver(inputs).solve(options);
  const leafPareto = new ParetoKvUnifiedPolicySolver(inputs).solve({ ...options, engine: 'leaf' });
  assert.equal(oracle.feasible, true);
  assert.equal(pareto.feasible, true);
  assert.equal(leafPareto.feasible, true);
  if (!oracle.feasible || !pareto.feasible || !leafPareto.feasible) return;
  const signature = (candidate: ExactPolicyCandidate): string =>
    inputs.chunks.map((chunk) => `${chunk.id}:${candidate.frontier.get(chunk.id) ?? 0}`).join('|');
  assert.equal(signature(pareto.selected), signature(oracle.selected));
  assert.equal(pareto.selected.score, oracle.selected.score);
  assert.equal(signature(pareto.selected), signature(leafPareto.selected));
  assert.ok((pareto.propagation?.labelsDominated ?? 0) >= 0);
});

test('kv-unified emits preserved gap-bearing ownership in chronological leaf order', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'a', rawTokens: 100, pinned: true });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.addChunk({ id: 'c', rawTokens: 100, pinned: true });
  chronicle.addChunk({ id: 'd', rawTokens: 100 });
  chronicle.produceL1(['a', 'c']);
  const recall = chronicle.produceL1(['b', 'd']);
  const inputs: PickerInputs = {
    chunks: chronicle.chunks,
    summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
  const forest = new CanonicalSummaryForest(inputs, {
    preserveGapBearingSummaries: true,
  });
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const expectedFrontier = new Map([
    ['a', 0], ['b', 1], ['c', 0], ['d', 1],
  ]);
  const expectedLayout = renderLayout(inputs, new SummaryTree(inputs), expectedFrontier);
  const result = solver.solve({
    maxTokens: 250,
    cache: {
      immutablePrefixHash: 'same',
      layout: expectedLayout,
      markers: [{ unitIndex: 3, offset: 250 }],
    },
    currentImmutablePrefixHash: 'same',
  });
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.deepEqual(
    result.selected.layout.units.map((unit) => `${unit.kind}:${unit.key}`),
    ['raw:a', `recall:${recall.id}`, 'raw:c'],
  );
  assert.equal(result.selected.renderedTokens, 250);
  assert.equal(result.selected.cacheChurn, 0, 'buffered DAG emission retains the full warm prefix');
  const leaf = solver.solve({
    maxTokens: 250,
    engine: 'leaf',
    cache: {
      immutablePrefixHash: 'same',
      layout: expectedLayout,
      markers: [{ unitIndex: 3, offset: 250 }],
    },
    currentImmutablePrefixHash: 'same',
  });
  assert.equal(leaf.feasible, true);
  if (!leaf.feasible) return;
  for (const chunk of inputs.chunks) {
    assert.equal(result.selected.frontier.get(chunk.id), leaf.selected.frontier.get(chunk.id));
  }
  assert.equal(result.selected.cacheChurn, leaf.selected.cacheChurn);
});

test('kv-unified grid mode stays hard-feasible and reports an a-posteriori score-error bound', () => {
  const { inputs } = fixture();
  const options = {
    maxTokens: 250,
    tokenBucketSize: 100,
    continuityBucketSize: 100,
    fidelityBucketSize: 100,
  } as const;
  const result = new ParetoKvUnifiedPolicySolver(inputs).solve(options);
  const exact = new ParetoKvUnifiedPolicySolver(inputs).solve({
    ...options,
    tokenBucketSize: 0,
    continuityBucketSize: 0,
    fidelityBucketSize: 0,
  });
  assert.equal(result.feasible, true);
  assert.equal(exact.feasible, true);
  if (!result.feasible || !exact.feasible) return;
  assert.ok(result.selected.renderedTokens <= 250);
  assert.equal(result.propagation?.approximationBounded, true);
  assert.ok(
    result.selected.score - exact.selected.score <=
      (result.propagation?.approximationScoreErrorBound ?? -1) + 1e-9,
  );
  assert.ok((result.propagation?.approximationTokenErrorBound ?? -1) >= 0);
  assert.ok((result.propagation?.approximationContinuityErrorBound ?? -1) >= 0);
  assert.ok((result.propagation?.approximationFidelityErrorBound ?? -1) >= 0);
  assert.equal(result.propagation?.tokenBucketSize, 100);
  assert.ok(result.candidates.some((candidate) => candidate.renderedTokens === 55));
});

test('kv-unified a-posteriori bound covers exact welfare regret on varied small forests', () => {
  for (let caseIndex = 0; caseIndex < 20; caseIndex++) {
    const chronicle = buildChronicleWithChain({
      chunkCount: 6,
      tokensPerChunk: 70,
      mergeThreshold: 2,
      recallPairTokens: 35,
    });
    const inputs: PickerInputs = {
      chunks: chronicle.chunks.map((chunk, index) => ({
        ...chunk,
        rawTokens: 55 + ((index * 29 + caseIndex * 17) % 70),
        salience: 0.2 + (((index * 13 + caseIndex * 7) % 9) / 10),
      })),
      summaries: chronicle.summaries,
      recallPairTokens: new Map(
        [...chronicle.recallPairTokens].map(([id, tokens], index) => [
          id,
          tokens + ((index * 11 + caseIndex * 5) % 30),
        ]),
      ),
      headTokens: 0,
      tailTokens: 0,
      headChunkIds: new Set(),
      tailChunkIds: new Set(),
    };
    const rawLayout = renderLayout(inputs, new SummaryTree(inputs), new Map());
    const cacheOptions = caseIndex % 2 === 0
      ? {
          cache: {
            immutablePrefixHash: 'stable-tools',
            layout: rawLayout,
            markers: [
              { unitIndex: 2, offset: rawLayout.units[2]?.offset ?? 0 },
              { unitIndex: 4, offset: rawLayout.units[4]?.offset ?? rawLayout.totalTokens },
            ],
          },
          currentImmutablePrefixHash: 'stable-tools',
        }
      : {};
    const options = {
      maxTokens: 260 + (caseIndex % 4) * 20,
      presentation: rawPresentation(inputs),
      ...cacheOptions,
      policy: {
        alpha: 0.4 + (caseIndex % 4) * 0.2,
        budgetLowRatio: 0.5,
        budgetHighRatio: 0.8,
        budgetUnderLambda: 300 + caseIndex * 10,
        budgetOverLambda: 700 + caseIndex * 20,
        cacheLambda: 400 + caseIndex * 10,
        cacheScale: 200,
        continuityLambda: 500 + caseIndex * 15,
        continuityScale: 200,
        continuityRecencyHalfLifeTokens: 150,
        continuityRecencyFloor: 0.2,
        continuityStableFloor: 1,
      },
    } as const;
    const exact = new ExactKvUnifiedPolicySolver(inputs).solve(options);
    const approximate = new ParetoKvUnifiedPolicySolver(inputs).solve({
      ...options,
      tokenBucketSize: 80,
      continuityBucketSize: 100,
      fidelityBucketSize: 100,
    });
    assert.equal(exact.feasible, true, `exact case ${caseIndex}`);
    assert.equal(approximate.feasible, true, `approximate case ${caseIndex}`);
    if (!exact.feasible || !approximate.feasible) continue;
    const regret = approximate.selected.score - exact.selected.score;
    const bound = approximate.propagation?.approximationScoreErrorBound ?? -1;
    assert.ok(regret <= bound + 1e-9, `case ${caseIndex}: regret ${regret} > bound ${bound}`);
  }
});

test('kv-unified grid mode retains cache and continuity floor witnesses', () => {
  const { inputs } = fixture();
  const rawLayout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const options = {
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    cache: {
      immutablePrefixHash: 'tools',
      layout: rawLayout,
      markers: [{ unitIndex: 2, offset: 180 }, { unitIndex: 4, offset: 360 }],
    },
    currentImmutablePrefixHash: 'tools',
  } as const;
  const exact = new ExactKvUnifiedPolicySolver(inputs).solve(options);
  const grid = new ParetoKvUnifiedPolicySolver(inputs).solve({
    ...options,
    tokenBucketSize: 100,
    continuityBucketSize: 100,
    fidelityBucketSize: 100,
  });
  assert.equal(exact.feasible, true);
  assert.equal(grid.feasible, true);
  if (!exact.feasible || !grid.feasible) return;
  assert.equal(grid.cacheFloor, exact.cacheFloor);
  assert.equal(grid.continuityFloor, exact.continuityFloor);
});

test('kv-unified FoldingSolver adapter applies the selected feasible frontier', () => {
  const { inputs } = fixture();
  const strategy = new KvUnifiedStrategy({
    tokenBucketSize: 100,
    continuityBucketSize: 100,
    fidelityBucketSize: 100,
    policy: { budgetUnderLambda: 0, budgetOverLambda: 0 },
  });
  const result = new Picker(strategy).run(inputs, {
    totalBudget: 250,
    targetBudget: 250,
    slack: 0,
  });
  assert.ok(result.finalTokens <= 250);
  assert.equal(result.unrealizable, 0);
  assert.equal(strategy.lastResult?.feasible, true);
});

test('kv-unified live adapter fails closed without every explicit policy field', () => {
  const { inputs } = fixture();
  const strategy = new KvUnifiedStrategy({ requireExplicitPolicy: true });
  assert.throws(
    () => new Picker(strategy).run(inputs, { totalBudget: 250, targetBudget: 250, slack: 0 }),
    /requires an explicit policy/,
  );
});

test('kv-unified adoption epsilon holds a feasible presentation but never an over-wall one', () => {
  const { inputs } = fixture();
  const solver = new ExactKvUnifiedPolicySolver(inputs);
  const held = solver.solve({
    maxTokens: 400,
    presentation: rawPresentation(inputs),
    adoptEpsilon: 1_000_000,
    policy: {
      budgetLowRatio: 0,
      budgetHighRatio: 1,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      cacheLambda: 0,
      continuityLambda: 0,
    },
  });
  assert.equal(held.feasible, true);
  if (!held.feasible) return;
  assert.equal(held.selected.renderedTokens, 360);
  assert.ok([...held.selected.frontier.values()].every((level) => level === 0));

  const forced = solver.solve({
    maxTokens: 250,
    presentation: rawPresentation(inputs),
    adoptEpsilon: 1_000_000,
  });
  assert.equal(forced.feasible, true);
  if (forced.feasible) assert.ok(forced.selected.renderedTokens <= 250);
});

test('kv-unified infeasibility demands missing L1s instead of deadlocking', () => {
  const { chronicle, inputs } = fixture();
  chronicle.summaries.clear();
  chronicle.recallPairTokens.clear();
  for (const chunk of inputs.chunks) chunk.l1Id = undefined;
  const solution = new KvUnifiedStrategy().solve(inputs, {
    totalBudget: 100,
    targetBudget: 100,
    slack: 0,
  });
  assert.equal(solution.exhausted, true);
  assert.deepEqual(solution.produced, [{
    level: 1,
    range: { firstChunkId: 'c-0000', lastChunkId: 'c-0003' },
  }]);
});

test('kv-unified label count stays bounded under a stale half-covering presentation (#97)', () => {
  // A presentation receipt that covers only the older half of the live leaves
  // (a kv-stable -> kv-unified switch, a restore, a history import) must not
  // multiply the Pareto label set. Extension tokens are no longer part of the
  // state key. No provider cache is relevant here, so nothing prices them and
  // they are inert in dominance too; keying on them only split labels that
  // should have collapsed. (The relevant-cache case, where extension is a
  // priced dominance dimension, is covered by the two tests below.)
  const chronicle = buildChronicleWithChain({
    chunkCount: 24,
    tokensPerChunk: 100,
    mergeThreshold: 2,
    recallPairTokens: 40,
  });
  const inputs: PickerInputs = {
    chunks: chronicle.chunks.map((chunk, index) => ({ ...chunk, rawTokens: 60 + ((index * 29) % 70) })),
    summaries: chronicle.summaries,
    recallPairTokens: new Map(
      [...chronicle.recallPairTokens].map(([id, tokens], index) => [id, tokens + ((index * 11) % 30)]),
    ),
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const presentationCovering = (count: number): AcceptedPresentationReference => ({
    currentSeq: 1,
    leaves: new Map(
      ordered.slice(0, count).map((chunk) => [
        chunk.id,
        { repHash: `raw:${chunk.id}`, level: 0, lastChangedSeq: 0 },
      ]),
    ),
  });
  const rawTotal = inputs.chunks.reduce((sum, chunk) => sum + chunk.rawTokens, 0);
  const options = {
    maxTokens: Math.floor(rawTotal * 0.75),
    tokenBucketSize: 100,
    continuityBucketSize: 100,
    fidelityBucketSize: 100,
    labelCeiling: 200_000,
  } as const;
  const fresh = new ParetoKvUnifiedPolicySolver(inputs).solve({
    ...options,
    presentation: presentationCovering(ordered.length),
  });
  const halfStale = new ParetoKvUnifiedPolicySolver(inputs).solve({
    ...options,
    presentation: presentationCovering(ordered.length / 2),
  });
  const fullyStale = new ParetoKvUnifiedPolicySolver(inputs).solve({
    ...options,
    presentation: presentationCovering(0),
  });
  assert.equal(fresh.feasible, true);
  assert.equal(halfStale.feasible, true);
  assert.equal(fullyStale.feasible, true);
  if (!fresh.feasible || !halfStale.feasible || !fullyStale.feasible) return;
  const freshLabels = fresh.propagation?.labelsCreated ?? Number.POSITIVE_INFINITY;
  const halfLabels = halfStale.propagation?.labelsCreated ?? Number.POSITIVE_INFINITY;
  const fullLabels = fullyStale.propagation?.labelsCreated ?? Number.POSITIVE_INFINITY;
  // Before the fix: fresh 14,256 / half-stale 60,791 (4.3x) / fully stale 41,714.
  // The residual over fresh is continuity-loss bucketing (the presentation
  // still prices continuity), not extension keys.
  assert.ok(halfLabels <= freshLabels * 2, `half-stale ${halfLabels} vs fresh ${freshLabels}`);
  assert.ok(fullLabels <= freshLabels, `fully stale ${fullLabels} vs fresh ${freshLabels}`);
  assert.ok(halfStale.selected.renderedTokens <= options.maxTokens);
});

test('kv-unified keeps extension as a priced dominance dimension under a relevant cache (#98 review)', () => {
  // Three chronological chunks a, b, c (100 raw tokens, 20-token L1 each).
  // The accepted presentation and the relevant cache cover raw a and b with a
  // marker after b; c is extension. a is constrained to L1, so every cut
  // diverges from the cached layout at unit 0 and the whole render is
  // recomputed; the cache term then differs between cuts only through how
  // much of the recompute is unavoidable extension. [1,0,1] beats [1,1,0] on
  // fidelity and continuity but folds the new chunk (20 extension tokens vs
  // 100), so its cache churn is higher. Dominance that ignores extension
  // prunes [1,1,0] and the solver returns [1,1,1] with a reported zero error.
  const build = () => {
    const chronicle = new MockChronicle({ recallPairTokens: 20 });
    const a = chronicle.addChunk({ id: 'a', rawTokens: 100 });
    const b = chronicle.addChunk({ id: 'b', rawTokens: 100 });
    const c = chronicle.addChunk({ id: 'c', rawTokens: 100 });
    a.salience = 0.2; b.salience = 0.4; c.salience = 0.2;
    a.pinLevel = 1;
    chronicle.produceL1(['a']);
    chronicle.produceL1(['b']);
    chronicle.produceL1(['c']);
    const inputs: PickerInputs = {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0,
      tailTokens: 0,
      headChunkIds: new Set(),
      tailChunkIds: new Set(),
    };
    return inputs;
  };
  const presentation: AcceptedPresentationReference = {
    currentSeq: 1,
    leaves: new Map([
      ['a', { repHash: 'raw:a', level: 0, lastChangedSeq: 0 }],
      ['b', { repHash: 'raw:b', level: 0, lastChangedSeq: 0 }],
    ]),
  };
  const cache = {
    immutablePrefixHash: 'tools-v1',
    layout: {
      units: [
        { kind: 'raw' as const, key: 'a', tokens: 100, offset: 0 },
        { kind: 'raw' as const, key: 'b', tokens: 100, offset: 100 },
      ],
      totalTokens: 200,
    },
    markers: [{ unitIndex: 2, offset: 200 }],
  };
  const base = {
    maxTokens: 140,
    presentation,
    cache,
    currentImmutablePrefixHash: 'tools-v1',
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      continuityLambda: 0,
      cacheLambda: 10_000,
      cacheScale: 100,
    },
  } as const;
  const signature = (candidate: ExactPolicyCandidate): string =>
    ['a', 'b', 'c'].map((id) => `${id}:${candidate.frontier.get(id) ?? 0}`).join('|');
  const oracle = new ExactKvUnifiedPolicySolver(build()).solve({ ...base, candidateSource: 'recursive' });
  assert.equal(oracle.feasible, true);
  if (!oracle.feasible) return;
  assert.equal(signature(oracle.selected), 'a:1|b:1|c:0');
  for (const buckets of [
    { tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100 },
    { tokenBucketSize: 0, continuityBucketSize: 0, fidelityBucketSize: 0 },
  ]) {
    const result = new ParetoKvUnifiedPolicySolver(build()).solve({ ...base, ...buckets });
    assert.equal(result.feasible, true);
    if (!result.feasible) return;
    assert.equal(
      signature(result.selected),
      signature(oracle.selected),
      `buckets ${buckets.tokenBucketSize}: selected ${signature(result.selected)}`,
    );
    assert.equal(result.selected.score, oracle.selected.score);
    assert.ok(
      result.selected.score - oracle.selected.score <=
        (result.propagation?.approximationScoreErrorBound ?? -1) + 1e-9,
    );
  }
});

test('kv-unified label count stays bounded under a stale presentation with a relevant cache (#97)', () => {
  // Same forest as the no-cache growth test, but every receipt also carries a
  // relevant provider cache, so extension is priced and is a dominance
  // dimension. The comparison is half-stale against FRESH with the cache
  // relevant in both: comparing against a no-cache solve at the same
  // staleness does not discriminate (that ratio was already 1.5 before the
  // fix). The count must stay bounded (representatives per bucket group cap
  // it) and the reported error bound must cover the regret against an
  // unbucketed solve of the same forest.
  const chronicle = buildChronicleWithChain({
    chunkCount: 24,
    tokensPerChunk: 100,
    mergeThreshold: 2,
    recallPairTokens: 40,
  });
  const inputs: PickerInputs = {
    chunks: chronicle.chunks.map((chunk, index) => ({ ...chunk, rawTokens: 60 + ((index * 29) % 70) })),
    summaries: chronicle.summaries,
    recallPairTokens: new Map(
      [...chronicle.recallPairTokens].map(([id, tokens], index) => [id, tokens + ((index * 11) % 30)]),
    ),
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const receiptCovering = (count: number) => {
    const covered = ordered.slice(0, count);
    const presentation: AcceptedPresentationReference = {
      currentSeq: 1,
      leaves: new Map(covered.map((chunk) => [chunk.id, { repHash: `raw:${chunk.id}`, level: 0, lastChangedSeq: 0 }])),
    };
    let offset = 0;
    const units = covered.map((chunk) => {
      const unit = { kind: 'raw' as const, key: chunk.id, tokens: chunk.rawTokens, offset };
      offset += chunk.rawTokens;
      return unit;
    });
    return {
      presentation,
      cache: {
        immutablePrefixHash: 'tools-v1',
        layout: { units, totalTokens: offset },
        markers: [{ unitIndex: units.length, offset }],
      },
      currentImmutablePrefixHash: 'tools-v1',
    };
  };
  const rawTotal = inputs.chunks.reduce((sum, chunk) => sum + chunk.rawTokens, 0);
  const options = {
    maxTokens: Math.floor(rawTotal * 0.75),
    tokenBucketSize: 100,
    continuityBucketSize: 100,
    fidelityBucketSize: 100,
    labelCeiling: 200_000,
  } as const;
  const fresh = new ParetoKvUnifiedPolicySolver(inputs).solve({ ...options, ...receiptCovering(ordered.length) });
  const halfStale = new ParetoKvUnifiedPolicySolver(inputs).solve({ ...options, ...receiptCovering(ordered.length / 2) });
  assert.equal(fresh.feasible, true);
  assert.equal(halfStale.feasible, true);
  if (!fresh.feasible || !halfStale.feasible) return;
  assert.equal(fresh.cacheRelevant, true);
  assert.equal(halfStale.cacheRelevant, true);
  const freshLabels = fresh.propagation?.labelsCreated ?? Number.POSITIVE_INFINITY;
  const halfLabels = halfStale.propagation?.labelsCreated ?? Number.POSITIVE_INFINITY;
  // Before the fix: fresh 29,620 / half-stale 91,356 (3.1x, and growing with
  // the forest). After: 1.44x, flat.
  assert.ok(halfLabels <= freshLabels * 2, `half-stale ${halfLabels} vs fresh ${freshLabels}`);

  // Honesty of the reported bound: an all-zero-bucket solve of the same
  // half-stale forest is exact, so the bucketed selection's regret against it
  // must sit inside the a-posteriori score bound (which includes the cache
  // envelope component).
  const exact = new ParetoKvUnifiedPolicySolver(inputs).solve({
    ...options,
    ...receiptCovering(ordered.length / 2),
    tokenBucketSize: 0,
    continuityBucketSize: 0,
    fidelityBucketSize: 0,
    labelCeiling: 2_000_000,
  });
  assert.equal(exact.feasible, true);
  if (!exact.feasible) return;
  const cacheBound = halfStale.propagation?.approximationCacheErrorBound;
  const scoreBound = halfStale.propagation?.approximationScoreErrorBound;
  assert.ok(cacheBound !== undefined && cacheBound >= 0, `cache bound ${cacheBound}`);
  assert.ok(scoreBound !== undefined && scoreBound >= 0, `score bound ${scoreBound}`);
  const regret = halfStale.selected.score - exact.selected.score;
  assert.ok(regret <= (scoreBound ?? -1) + 1e-9, `regret ${regret} vs bound ${scoreBound}`);
});

// A chain forest with per-seed token and salience variation.
function variedChain(chunkCount: number, seed: number): PickerInputs {
  const chronicle = buildChronicleWithChain({
    chunkCount,
    tokensPerChunk: 100,
    mergeThreshold: 2,
    recallPairTokens: 40,
  });
  return {
    chunks: chronicle.chunks.map((chunk, index) => ({
      ...chunk,
      rawTokens: 60 + ((index * 29 + seed * 13) % 70),
      salience: 0.2 + (((index * 13 + seed * 7) % 9) / 10),
    })),
    summaries: chronicle.summaries,
    recallPairTokens: new Map(
      [...chronicle.recallPairTokens].map(([id, tokens], index) => [
        id,
        tokens + ((index * 11 + seed * 7) % 30),
      ]),
    ),
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
}

// The receipt a live host holds after an accepted call: the presentation and
// the provider-cache layout are the cut that call rendered, with breakpoints
// spread across its units.
function steadyReceipt(
  inputs: PickerInputs,
  frontier: ReadonlyMap<string, number>,
  markerCount: number,
) {
  const forest = new CanonicalSummaryForest(inputs);
  const layout = renderLayout(inputs, new SummaryTree(inputs), frontier);
  const leaves = new Map(inputs.chunks.map((chunk) => {
    const level = frontier.get(chunk.id) ?? 0;
    const repHash = level === 0
      ? `raw:${chunk.id}`
      : `summary:${forest.leaf(chunk.id)!.summaryIds.find((id) => forest.summary(id)!.level === level)}`;
    return [chunk.id, { repHash, level, lastChangedSeq: 0 }] as const;
  }));
  const markers = Array.from({ length: markerCount }, (_, index) => {
    const unitIndex = Math.round((layout.units.length * (index + 1)) / markerCount);
    return { unitIndex, offset: layout.units[unitIndex]?.offset ?? layout.totalTokens };
  });
  return {
    presentation: { currentSeq: 1, leaves } satisfies AcceptedPresentationReference,
    cache: { immutablePrefixHash: 'tools-v1', layout, markers },
  };
}

test('kv-unified label count stays flat under a relevant cache once cuts diverge from it (#105)', () => {
  // Steady state: turn 2 re-solves against the receipt of the cut turn 1
  // rendered, with the provider cache relevant. Candidate cuts diverge from the
  // cached layout at different units. Before the fix the unit a label diverged
  // at stayed in its state key although nothing reads it after the break, so
  // labels that diverged at different units never competed and the
  // relevant-cache label set grew with the forest: over the no-cache count,
  // 1.1x at 12 chunks, 2.1x at 24 and 3.1x at 32 (bucketed); 1.8x at 24
  // (exact). After: 1.1-1.25x at every size.
  const buckets = { tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100 };
  const exact = { tokenBucketSize: 0, continuityBucketSize: 0, fidelityBucketSize: 0 };
  for (const [chunkCount, grid, limit] of [[32, buckets, 1.6], [24, exact, 1.5]] as const) {
    const inputs = variedChain(chunkCount, 0);
    const rawTotal = inputs.chunks.reduce((sum, chunk) => sum + chunk.rawTokens, 0);
    const maxTokens = Math.floor(rawTotal * 0.6);
    const turn1 = new ParetoKvUnifiedPolicySolver(inputs).solve({ maxTokens, ...buckets });
    assert.equal(turn1.feasible, true);
    if (!turn1.feasible) return;
    const receipt = steadyReceipt(inputs, turn1.selected.frontier, 4);
    const solve = (currentImmutablePrefixHash: string) =>
      new ParetoKvUnifiedPolicySolver(inputs).solve({
        maxTokens,
        ...grid,
        ...receipt,
        currentImmutablePrefixHash,
        labelCeiling: 2_000_000,
      });
    const relevant = solve('tools-v1');
    const irrelevant = solve('tools-v2');
    assert.equal(relevant.feasible, true);
    assert.equal(irrelevant.feasible, true);
    if (!relevant.feasible || !irrelevant.feasible) return;
    assert.equal(relevant.cacheRelevant, true);
    assert.equal(irrelevant.cacheRelevant, false);
    const withCache = relevant.propagation?.labelsCreated ?? Number.POSITIVE_INFINITY;
    const withoutCache = irrelevant.propagation?.labelsCreated ?? 0;
    assert.ok(
      withCache <= withoutCache * limit,
      `${chunkCount} chunks, bucket ${grid.tokenBucketSize}: ${withCache} labels with a relevant cache vs ${withoutCache} without`,
    );
  }
});

test('kv-unified relevant-cache selection agrees with the exhaustive oracle across divergence points (#105)', () => {
  // Broad agreement sweep on steady-state receipts whose cache the new cut
  // breaks at varied units: the unbucketed DAG and the leaf engine must select
  // a cut of the exhaustive oracle's score, and the bucketed DAG's regret must
  // sit inside its reported bound. (Small random forests rarely put two broken
  // labels with different warm prefixes in one dominance contest, so this
  // sweep does not catch an over-merged key; the warm-prefix test below does.)
  let diverged = 0;
  for (let caseIndex = 0; caseIndex < 18; caseIndex++) {
    const inputs = variedChain(7 + (caseIndex % 2), caseIndex);
    const rawTotal = inputs.chunks.reduce((sum, chunk) => sum + chunk.rawTokens, 0);
    const turn1 = new ParetoKvUnifiedPolicySolver(inputs).solve({
      maxTokens: Math.floor(rawTotal * (0.9 - (caseIndex % 3) * 0.1)),
    });
    assert.equal(turn1.feasible, true, `turn 1 case ${caseIndex}`);
    if (!turn1.feasible) continue;
    const options = {
      maxTokens: Math.floor(rawTotal * (0.5 + (caseIndex % 4) * 0.08)),
      ...steadyReceipt(inputs, turn1.selected.frontier, 2 + (caseIndex % 3)),
      currentImmutablePrefixHash: 'tools-v1',
      policy: {
        alpha: 0.3 + (caseIndex % 3) * 0.3,
        budgetLowRatio: 0.5,
        budgetHighRatio: 0.9,
        budgetUnderLambda: 200 + caseIndex * 10,
        budgetOverLambda: 600,
        cacheLambda: caseIndex % 2 === 0 ? 10_000 : 800,
        cacheScale: 100,
        continuityLambda: 300 + caseIndex * 20,
        continuityScale: 200,
        continuityRecencyHalfLifeTokens: 150,
        continuityRecencyFloor: 0.2,
        continuityStableFloor: 1,
      },
    } as const;
    const oracle = new ExactKvUnifiedPolicySolver(inputs).solve(options);
    const dag = new ParetoKvUnifiedPolicySolver(inputs).solve(options);
    const leaf = new ParetoKvUnifiedPolicySolver(inputs).solve({ ...options, engine: 'leaf' });
    const grid = new ParetoKvUnifiedPolicySolver(inputs).solve({
      ...options,
      tokenBucketSize: 80,
      continuityBucketSize: 100,
      fidelityBucketSize: 100,
    });
    assert.equal(oracle.feasible, true, `oracle case ${caseIndex}`);
    assert.equal(dag.feasible, true, `dag case ${caseIndex}`);
    assert.equal(leaf.feasible, true, `leaf case ${caseIndex}`);
    assert.equal(grid.feasible, true, `grid case ${caseIndex}`);
    if (!oracle.feasible || !dag.feasible || !leaf.feasible || !grid.feasible) continue;
    assert.equal(oracle.cacheRelevant, true);
    if (oracle.selected.cacheChurn > 0) diverged++;
    assert.ok(
      Math.abs(dag.selected.score - oracle.selected.score) <= 1e-9,
      `case ${caseIndex}: dag ${dag.selected.score} vs oracle ${oracle.selected.score}`,
    );
    assert.ok(
      Math.abs(leaf.selected.score - oracle.selected.score) <= 1e-9,
      `case ${caseIndex}: leaf ${leaf.selected.score} vs oracle ${oracle.selected.score}`,
    );
    const regret = grid.selected.score - oracle.selected.score;
    const bound = grid.propagation?.approximationScoreErrorBound ?? -1;
    assert.ok(regret <= bound + 1e-9, `case ${caseIndex}: regret ${regret} > bound ${bound}`);
  }
  // The receipts must actually make the new cut break the cache somewhere,
  // or this compares nothing the fix touches.
  assert.ok(diverged >= 6, `only ${diverged} cases diverged from the cached layout`);
});

test('kv-unified keeps the warm-prefix length of a cut that broke the cache in its state (#105)', () => {
  // Four chronological chunks, 100 raw tokens each, a 20-token L1 each; c and
  // d are pinned raw. The receipt and the relevant cache are the all-raw
  // layout with a breakpoint after a. One fold is needed. Folding a breaks
  // the cache at unit 0 (nothing warm); folding b breaks it at unit 1, after
  // the breakpoint, so 100 tokens stay warm. Folding a is better on fidelity
  // and continuity (a is older and less salient), so at the point after b the
  // fold-b label is dominated unless the warm-prefix length it keeps is part
  // of its state. Only the unit a broken label diverged at may leave the key;
  // cachedTokens must not.
  const build = () => {
    const chronicle = new MockChronicle({ recallPairTokens: 20 });
    const a = chronicle.addChunk({ id: 'a', rawTokens: 100 });
    const b = chronicle.addChunk({ id: 'b', rawTokens: 100 });
    chronicle.addChunk({ id: 'c', rawTokens: 100, pinned: true });
    chronicle.addChunk({ id: 'd', rawTokens: 100, pinned: true });
    a.salience = 0.2; b.salience = 0.8;
    chronicle.produceL1(['a']);
    chronicle.produceL1(['b']);
    const inputs: PickerInputs = {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0,
      tailTokens: 0,
      headChunkIds: new Set(),
      tailChunkIds: new Set(),
    };
    return inputs;
  };
  const allRaw = new Map(['a', 'b', 'c', 'd'].map((id) => [id, 0]));
  const receipt = steadyReceipt(build(), allRaw, 1);
  const base = {
    maxTokens: 320,
    presentation: receipt.presentation,
    cache: { ...receipt.cache, markers: [{ unitIndex: 1, offset: 100 }] },
    currentImmutablePrefixHash: 'tools-v1',
    policy: {
      alpha: 0.5,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      continuityLambda: 100,
      continuityScale: 100,
      cacheLambda: 10_000,
      cacheScale: 100,
    },
  } as const;
  const signature = (candidate: ExactPolicyCandidate): string =>
    ['a', 'b', 'c', 'd'].map((id) => `${id}:${candidate.frontier.get(id) ?? 0}`).join('|');
  const oracle = new ExactKvUnifiedPolicySolver(build()).solve(base);
  assert.equal(oracle.feasible, true);
  if (!oracle.feasible) return;
  assert.equal(signature(oracle.selected), 'a:0|b:1|c:0|d:0', 'the warm prefix is worth the fidelity');
  for (const [name, extra] of [
    ['exact dag', { tokenBucketSize: 0, continuityBucketSize: 0, fidelityBucketSize: 0 }],
    ['bucketed dag', { tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100 }],
    ['leaf', { engine: 'leaf' as const }],
  ] as const) {
    const result = new ParetoKvUnifiedPolicySolver(build()).solve({ ...base, ...extra });
    assert.equal(result.feasible, true, name);
    if (!result.feasible) return;
    assert.equal(signature(result.selected), signature(oracle.selected), `${name}: selected ${signature(result.selected)}`);
    assert.equal(result.selected.score, oracle.selected.score, name);
  }
});

test('kv-unified resolves a representative tie between broken cuts the way terminal selection does (#105)', () => {
  // Four chronological 100-token chunks of equal salience, a 20-token L1 each
  // for a and b; c and d are pinned raw. The receipt and the relevant cache
  // are the all-raw layout with its only breakpoint at the end, so folding a
  // and folding b both break the cache with nothing warm, at unit 0 and unit
  // 1. With alpha 0 and both continuity floors at 1 the two folds tie on every
  // metric and on score, and terminal selection takes the earlier frontier
  // signature, a:0|b:1. Once the key stops splitting them by divergence unit
  // they share one pool, and under buckets only one representative survives
  // the tie; it must be the same cut, since the two render different layouts
  // and so leave different receipts for the next turn.
  const build = (): PickerInputs => {
    const chronicle = new MockChronicle({ recallPairTokens: 20 });
    chronicle.addChunk({ id: 'a', rawTokens: 100 });
    chronicle.addChunk({ id: 'b', rawTokens: 100 });
    chronicle.addChunk({ id: 'c', rawTokens: 100, pinned: true });
    chronicle.addChunk({ id: 'd', rawTokens: 100, pinned: true });
    chronicle.produceL1(['a']);
    chronicle.produceL1(['b']);
    return {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0,
      tailTokens: 0,
      headChunkIds: new Set(),
      tailChunkIds: new Set(),
    };
  };
  const allRaw = new Map(['a', 'b', 'c', 'd'].map((id) => [id, 0]));
  const receipt = steadyReceipt(build(), allRaw, 1);
  const base = {
    maxTokens: 320,
    presentation: receipt.presentation,
    cache: { ...receipt.cache, markers: [{ unitIndex: 4, offset: 400 }] },
    currentImmutablePrefixHash: 'tools-v1',
    policy: {
      alpha: 0,
      budgetUnderLambda: 0,
      budgetOverLambda: 0,
      continuityRecencyFloor: 1,
      continuityStableFloor: 1,
      continuityLambda: 100,
      continuityScale: 100,
      cacheLambda: 1,
      cacheScale: 100,
    },
  } as const;
  const signature = (candidate: ExactPolicyCandidate): string =>
    ['a', 'b', 'c', 'd'].map((id) => `${id}:${candidate.frontier.get(id) ?? 0}`).join('|');
  const oracle = new ExactKvUnifiedPolicySolver(build()).solve(base);
  assert.equal(oracle.feasible, true);
  if (!oracle.feasible) return;
  const tied = oracle.candidates.filter((candidate) => candidate.score === oracle.selected.score);
  assert.deepEqual(tied.map(signature), ['a:0|b:1|c:0|d:0', 'a:1|b:0|c:0|d:0'], 'the two folds tie on score');
  for (const [name, extra] of [
    ['exact dag', { tokenBucketSize: 0, continuityBucketSize: 0, fidelityBucketSize: 0 }],
    ['bucketed dag', { tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100 }],
  ] as const) for (const storage of ['objects', 'packed'] as const) {
    for (const terminalEvaluation of storage === 'packed' ? ['full', 'selective'] as const : ['full'] as const) {
      const mode = `${name}/${storage}/${terminalEvaluation}`;
      const result = new ParetoKvUnifiedPolicySolver(build()).solve({ ...base, ...extra, storage, terminalEvaluation });
      assert.equal(result.feasible, true, mode);
      if (!result.feasible) return;
      assert.equal(signature(result.selected), signature(oracle.selected), `${mode}: selected ${signature(result.selected)}`);
      assert.equal(result.selected.score, oracle.selected.score, mode);
    }
  }
});

test('bucketed leaf engine keeps the oracle cut when fewer tokens score worse (#109)', () => {
  const build = (pinHole: boolean): PickerInputs => {
    const chronicle = new MockChronicle({ recallPairTokens: 20 });
    for (const id of ['a', 'b', 'c', 'd']) chronicle.addChunk({ id, rawTokens: 100, pinned: id === 'c' });
    chronicle.produceL1(['a']);
    chronicle.recallPairTokens.set(chronicle.produceL1(['b']).id, 30);
    if (pinHole) chronicle.recallPairTokens.set(chronicle.produceL1(['c', 'd']).id, 220);
    return { chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() };
  };
  const allRaw = new Map(['a', 'b', 'c', 'd'].map((id) => [id, 0]));
  const base = build(false);
  const layout = renderLayout(base, new SummaryTree(base), allRaw);
  const leaves = new Map(base.chunks.map((chunk) => [chunk.id, { repHash: `raw:${chunk.id}`, level: 0, lastChangedSeq: 0 }]));
  const policy = { alpha: 0, budgetLowRatio: 1, budgetHighRatio: 1, budgetUnderLambda: 10000, budgetOverLambda: 0,
    continuityRecencyFloor: 1, continuityStableFloor: 1, continuityLambda: 100, continuityScale: 100, cacheLambda: 1, cacheScale: 100 };
  for (const pinHole of [false, true]) {
    for (const prefix of ['tools-v1', 'tools-v2']) {
      const options = { maxTokens: 330, presentation: { currentSeq: 1, leaves }, policy,
        cache: { immutablePrefixHash: 'tools-v1', layout, markers: [{ unitIndex: 4, offset: 400 }] },
        currentImmutablePrefixHash: prefix, tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100 };
      const oracle = new ExactKvUnifiedPolicySolver(build(pinHole)).solve(options);
      assert.ok(oracle.feasible);
      const leaf = new ParetoKvUnifiedPolicySolver(build(pinHole)).solve({ ...options, engine: 'leaf' });
      assert.ok(leaf.feasible);
      assert.equal(leaf.propagation?.approximationScoreErrorBound, 0);
      assert.deepEqual(leaf.selected.frontier, oracle.selected.frontier, `leaf, hole=${pinHole}, prefix=${prefix}`);
      assert.equal(leaf.selected.score, oracle.selected.score);
      const auto = new ParetoKvUnifiedPolicySolver(build(pinHole)).solve(options);
      assert.ok(auto.feasible);
      assert.ok(auto.selected.score - oracle.selected.score <= auto.propagation!.approximationScoreErrorBound + 1e-9,
        `auto regret is covered by its bound, hole=${pinHole}, prefix=${prefix}`);
    }
  }
});

test('packed and object DAG storage both enforce the label ceiling', () => {
  const { inputs } = fixture();
  for (const storage of ['packed', 'objects'] as const) {
    assert.throws(() => new ParetoKvUnifiedPolicySolver(inputs).solve({
      maxTokens: 10_000, engine: 'dag', storage, labelCeiling: 1,
      tokenBucketSize: 0, continuityBucketSize: 0, fidelityBucketSize: 0,
    }), { name: 'SparseLabelCeilingError' }, storage);
  }
});

test('latent-demand evaluations are approximate only when the reported bound is nonzero', () => {
  for (const engine of ['auto', 'leaf'] as const) {
    const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
    for (let index = 0; index < 4; index++) {
      chronicle.addChunk({ id: `latent-${index}`, rawTokens: 100 });
      chronicle.produceL1([`latent-${index}`]);
    }
    const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
      headChunkIds: new Set(), tailChunkIds: new Set() };
    const strategy = new KvUnifiedStrategy({
      policy: { alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0,
        budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 },
      engine, tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4 },
    });
    strategy.solve(inputs, { totalBudget: 300, targetBudget: 270, slack: 0.1 });
    assert.equal(strategy.lastDemandEvaluations.length, 2, engine);
    assert.ok(strategy.lastDemandEvaluations.every((item) => !item.approximate), engine);
  }
});

test('bucketed leaf engine matches the oracle score on tie-heavy uniform forests (#109)', () => {
  // Equal chunk sizes make fidelity/continuity ties inside one token bucket
  // common, which is what the bucketed token key used to prune wrongly.
  let state = 109;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let checked = 0;
  for (let run = 0; run < 60; run++) {
    const n = 4 + (run % 3);
    const build = (): PickerInputs => {
      const chronicle = new MockChronicle({ recallPairTokens: 20 });
      for (let i = 0; i < n; i++) chronicle.addChunk({ id: `u${i}`, rawTokens: 100, pinned: (run + i) % 4 === 0 });
      for (let i = 0; i < n; i++) chronicle.recallPairTokens.set(chronicle.produceL1([`u${i}`]).id, 10 + ((run * 7 + i * 13) % 50));
      return { chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
        headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() };
    };
    const base = build();
    const floor = new CanonicalSummaryForest(base).minimumTokens();
    assert.ok(floor.feasible);
    const allRaw = new Map(base.chunks.map((chunk) => [chunk.id, 0]));
    const layout = renderLayout(base, new SummaryTree(base), allRaw);
    const leaves = new Map(base.chunks.map((chunk) => [chunk.id, { repHash: `raw:${chunk.id}`, level: 0, lastChangedSeq: 0 }]));
    const options = {
      maxTokens: Math.floor(floor.floorTokens + random() * (n * 100 - floor.floorTokens)),
      presentation: { currentSeq: 1, leaves },
      cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: run % 2 ? 'p' : 'q',
      tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100,
      policy: { alpha: 0, budgetLowRatio: 1, budgetHighRatio: 1, budgetUnderLambda: 10_000, budgetOverLambda: 0,
        continuityRecencyFloor: 1, continuityStableFloor: 1, continuityLambda: run % 3 ? 100 : 0,
        continuityScale: 100, cacheLambda: 1, cacheScale: 100 },
    };
    const oracle = new ExactKvUnifiedPolicySolver(build()).solve(options);
    const leaf = new ParetoKvUnifiedPolicySolver(build()).solve({ ...options, engine: 'leaf' });
    assert.equal(leaf.feasible, oracle.feasible);
    if (!oracle.feasible || !leaf.feasible) continue;
    assert.equal(leaf.propagation?.approximationScoreErrorBound, 0);
    assert.ok(Math.abs(leaf.selected.score - oracle.selected.score) <= 1e-9 * Math.max(1, oracle.selected.score),
      `run ${run}: leaf ${leaf.selected.score} vs oracle ${oracle.selected.score}`);
    checked++;
  }
  assert.ok(checked >= 50);
});
