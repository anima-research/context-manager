import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExactKvUnifiedPolicySolver,
  KvUnifiedPolicyError,
  MAX_AGE_BAND_STEPS,
  bandedAge,
  continuityLeafBase,
  fidelityLeafBase,
  normalizePolicy,
  type AcceptedPresentationReference,
  type ExactPolicyCandidate,
} from '../../src/adaptive/kv-unified-policy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { ParetoKvUnifiedPolicySolver, type ParetoSolveOptions } from '../../src/adaptive/kv-unified-pareto.js';
import { CanonicalSummaryForest, SparseLabelCeilingError } from '../../src/adaptive/kv-unified.js';
import { KvUnifiedStrategy, type KvUnifiedReuse } from '../../src/adaptive/strategies/kv-unified.js';
import { Picker } from '../../src/adaptive/picker.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

/** Each engine that solves on a grid: the subtree engine `auto` runs, the
 * packed DAG engine `auto` falls back to and `engine: 'dag'` pins, and the
 * object DAG engine, the diagnostic reference (`storage: 'objects'`). */
const GRID_ENGINES = [
  { name: 'subtree', options: { engine: 'subtree' } },
  { name: 'packed', options: { engine: 'dag' } },
  { name: 'objects', options: { storage: 'objects' } },
] as const;

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
    assert.equal(exact.feasible, true, `exact case ${caseIndex}`);
    if (!exact.feasible) continue;
    for (const engine of GRID_ENGINES) {
      const approximate = new ParetoKvUnifiedPolicySolver(inputs).solve({
        ...options,
        ...engine.options,
        tokenBucketSize: 80,
        continuityBucketSize: 100,
        fidelityBucketSize: 100,
      });
      assert.equal(approximate.feasible, true, `approximate case ${caseIndex} (${engine.name})`);
      if (!approximate.feasible) continue;
      const regret = approximate.selected.score - exact.selected.score;
      const bound = approximate.propagation?.approximationScoreErrorBound ?? -1;
      assert.ok(regret <= bound + 1e-9, `case ${caseIndex} (${engine.name}): regret ${regret} > bound ${bound}`);
    }
  }
});

test('the DAG engines\' bound covers a cut whose heavier representative crosses the wall (#254)', () => {
  // Four 30-token leaves, two 55-token L1s and a 100-token L2, then an
  // ownerless 100-token leaf, under a 210-token wall on a coarse grid. After
  // the first four leaves the raw (120), L1 (110) and L2 (100) cuts share a
  // bucket, where the raw cut is the best-fidelity representative and the L1
  // cut is cheapest to stand in for by it. The last leaf takes the raw cut
  // over the wall (220) where the L1 cut fits (210). Charged to the raw cut,
  // the L1 cut's error left with it, and the surviving L2 cut carried none,
  // so the bound read 0 beside the worse cut. The oracle's answer is the L1
  // cut. The DAG engines still select a worse one, and their reported bound
  // has to cover the difference, as every engine's does.
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 30 });
  const a = chronicle.produceL1(['c0', 'c1']);
  const b = chronicle.produceL1(['c2', 'c3']);
  const parent = chronicle.produceUpper(2, [a.id, b.id]);
  chronicle.recallPairTokens.set(parent.id, 100);
  chronicle.addChunk({ id: 'last', rawTokens: 100 });
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const forest = new CanonicalSummaryForest(inputs);
  const options = {
    maxTokens: 210, tokenBucketSize: 200, continuityBucketSize: 100, fidelityBucketSize: 1000, labelCeiling: 100_000,
    policy: { continuityLambda: 0, cacheLambda: 0, budgetUnderLambda: 0, budgetOverLambda: 0 },
  };
  const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
  assert.ok(oracle.feasible);
  assert.equal(oracle.selected.frontier.get('c0'), 1, 'the oracle takes the L1 cut');
  assert.equal(oracle.selected.renderedTokens, 210, 'which fits the wall exactly');
  const results = GRID_ENGINES.map((engine) => {
    const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, ...engine.options });
    assert.ok(result.feasible, engine.name);
    return { name: engine.name, score: result.selected.score, bound: result.propagation!.approximationScoreErrorBound };
  });
  for (const { name, score } of results.filter((result) => result.name !== 'subtree')) {
    assert.ok(score > oracle.selected.score + 1e-6, `premise: ${name} selects a worse cut than the oracle, so its bound has a regret to cover (${score} vs ${oracle.selected.score})`);
  }
  const over = results.filter(({ score, bound }) => score > oracle.selected.score + bound + 1e-6)
    .map(({ name, score, bound }) => `${name}: ${score} vs oracle ${oracle.selected.score} + bound ${bound}`);
  assert.deepEqual(over, [], 'every engine selects within its reported bound of the oracle');
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

test('latent demand is re-ranked on every solve: appended messages and policy changes reach it on the same roots', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 20 });
  for (let i = 0; i < 8; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 60 });
  const l1s = [['c0', 'c1'], ['c2', 'c3'], ['c4', 'c5']].map((ids) => chronicle.produceL1(ids));
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const leaves = new Map(inputs.chunks.map((chunk, i) => [chunk.id, {
    level: i < 6 ? 1 : 0, repHash: i < 6 ? `summary:${l1s[Math.floor(i / 2)].id}` : `raw:${chunk.id}`, lastChangedSeq: 1,
  }]));
  // The carried layout (3 recall pairs + 2 raw = 180 tokens) sits above the
  // high band with a steep over-budget price, so a merge that shrinks the
  // render strictly improves the score and is demanded.
  const policy = { alpha: 0.7, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 1_000_000,
    cacheLambda: 0, continuityLambda: 0 };
  // One options object shared across solves, as the host shares its config.
  const shared = {
    policy, tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000, adoptEpsilon: 1,
    presentation: { currentSeq: 9, leaves }, hysteresisCertificate: true,
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4 },
  };
  const budget = { totalBudget: 300, targetBudget: 270, slack: 0.1 };
  const rank = (options: typeof shared, turnInputs: PickerInputs) => {
    const strategy = new KvUnifiedStrategy(options as never);
    const result = strategy.solve(turnInputs, budget);
    return { produced: result.produced, evaluations: strategy.lastDemandEvaluations };
  };
  const fresh = (turnInputs: PickerInputs, override: Partial<typeof policy> = {}) =>
    rank(structuredClone({ ...shared, policy: { ...policy, ...override } }), turnInputs);

  const first = rank(shared, inputs);
  // A certified what-if would return the carried layout and score every merge at 0 improvement.
  assert.ok(first.evaluations.some((e) => e.expectedImprovement > 0), 'what-if measured a real improvement');
  assert.ok(first.produced.length > 0, 'the improving merge is demanded');

  // Same summary roots, one appended raw message: the scores move with it.
  chronicle.addChunk({ id: 'c8', rawTokens: 60 });
  const appended = { ...inputs, chunks: chronicle.chunks };
  const second = rank(shared, appended);
  assert.deepEqual(second.evaluations, fresh(appended).evaluations);
  assert.notDeepEqual(second.evaluations.map((e) => e.conservativeImprovement),
    first.evaluations.map((e) => e.conservativeImprovement), 'the append changed the what-if scores');

  // Same roots and budget, over-budget price removed: nothing is demanded any more.
  shared.policy = { ...policy, budgetOverLambda: 0 };
  const third = rank(shared, appended);
  assert.deepEqual(third.produced, fresh(appended, { budgetOverLambda: 0 }).produced);
  assert.equal(third.produced.length, 0);
});

test('latent demand gates a certified base solve against the unrestricted best cut', () => {
  // Four raw leaves under two L1s. The accepted raw layout certifies under a
  // wide adoptEpsilon, so the base solve exposes only that layout, scored up
  // to epsilon above the best cut. A merge compared with that score alone
  // would look worth more than epsilon; against the best cut it is not.
  const build = (hysteresisCertificate: boolean) => {
    const chronicle = new MockChronicle({ recallPairTokens: 100 });
    for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
    for (const chunk of chronicle.chunks) chunk.salience = 0.2;
    chronicle.produceL1(['c0', 'c1']);
    chronicle.produceL1(['c2', 'c3']);
    // Earlier L2 costs elsewhere in the history: the merge's expected (p50)
    // recall cost then differs from its conservative (p80) one.
    for (const [k, tokens] of [10, 20, 30, 40].entries()) {
      const id = `L2-seen-${k}`;
      chronicle.summaries.set(id, {
        id, level: 2, content: 'seen', tokens, sourceLevel: 1, sourceIds: [],
        sourceRange: { first: 'none', last: 'none' }, created: 0,
      });
      chronicle.recallPairTokens.set(id, tokens);
    }
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const leaves = new Map(chronicle.chunks.map((chunk) => [chunk.id, { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 1 }]));
    const strategy = new KvUnifiedStrategy({
      policy: {
        alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.125, budgetUnderLambda: 0, budgetOverLambda: 1600,
        cacheLambda: 0, continuityLambda: 0,
      },
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      adoptEpsilon: 1300, hysteresisCertificate,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4 },
      presentation: { currentSeq: 1, leaves },
    });
    const result = strategy.solve(inputs, { totalBudget: 400, targetBudget: 400, slack: 0 });
    return { strategy, result };
  };
  const certified = build(true);
  const unrestricted = build(false);
  assert.ok(certified.strategy.lastResult?.certificate, 'the base solve certifies the accepted layout');
  assert.equal(unrestricted.strategy.lastResult?.certificate, undefined);
  assert.deepEqual(certified.result.produced, unrestricted.result.produced);
  assert.deepEqual(
    certified.strategy.lastDemandEvaluations.map((e) => [e.request.level, Math.round(e.conservativeImprovement)]),
    unrestricted.strategy.lastDemandEvaluations.map((e) => [e.request.level, Math.round(e.conservativeImprovement)]),
  );
  const candidate = certified.strategy.lastDemandEvaluations[0]!;
  assert.notEqual(candidate.expectedRecallTokens, candidate.conservativeRecallTokens);
  // One conservative what-if each; the certified run adds the unrestricted
  // base solve and nothing else: the expected-cost solve waits for the final
  // gate, which neither run passes.
  assert.equal(unrestricted.strategy.lastTimings?.demandSolves, 1);
  assert.equal(certified.strategy.lastTimings?.demandSolves, 2);
});

test('latent demand decides a certified what-if solve against its unrestricted solve', () => {
  // Eight leaves under four L1s; the accepted presentation covers c0/c1 at
  // their L1, the rest are new. The base solve is unrestricted; the what-if
  // for c4..c7 certifies its carried layout, whose pool understates the
  // merge by up to the certificate's slack, which here spans the gate.
  const raw = [50, 50, 200, 100, 100, 200, 50, 200];
  const salience = [0.2, 0.5, 1, 1, 0.5, 1, 0.5, 1];
  const build = (hysteresisCertificate: boolean) => {
    const chronicle = new MockChronicle({ recallPairTokens: 150 });
    for (let i = 0; i < 8; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: raw[i] });
    chronicle.chunks.forEach((chunk, i) => { chunk.salience = salience[i]; });
    const l1s = [];
    for (let i = 0; i < 8; i += 2) l1s.push(chronicle.produceL1([`c${i}`, `c${i + 1}`]));
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const leaves = new Map([
      ['c0', { level: 1, repHash: `summary:${l1s[0].id}`, lastChangedSeq: 1 }],
      ['c1', { level: 1, repHash: `summary:${l1s[0].id}`, lastChangedSeq: 1 }],
    ]);
    const strategy = new KvUnifiedStrategy({
      policy: {
        alpha: 0, budgetLowRatio: 0.2, budgetHighRatio: 0.5, budgetUnderLambda: 4000, budgetOverLambda: 4000,
        cacheLambda: 0, continuityLambda: 0,
      },
      tokenBucketSize: 1, continuityBucketSize: 1, fidelityBucketSize: 1, labelCeiling: 100_000,
      adoptEpsilon: 200, hysteresisCertificate,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 8 },
      presentation: { currentSeq: 1, leaves },
    });
    const result = strategy.solve(inputs, { totalBudget: 800, targetBudget: 800, slack: 0 });
    return { strategy, result };
  };
  const certified = build(true);
  const unrestricted = build(false);
  assert.equal(certified.strategy.lastResult?.certificate, undefined, 'the base solve is unrestricted');
  const describe = (s: KvUnifiedStrategy) => s.lastDemandEvaluations.map((e) =>
    [`L${e.request.level} ${e.request.range.firstChunkId}..${e.request.range.lastChunkId}`, Math.round(e.conservativeImprovement)]);
  assert.deepEqual(describe(certified.strategy), describe(unrestricted.strategy));
  assert.deepEqual(certified.result.produced, unrestricted.result.produced);
  assert.ok(unrestricted.result.produced.some((r) => r.range.firstChunkId === 'c4'), 'the c4..c7 merge is worth more than epsilon');
});

/** Eight leaves under four L1s, with earlier L2 costs elsewhere in the
 * history so a merge's expected (p50) recall cost differs from its
 * conservative (p80) one. `covered` leaves are presented at their L1. */
function certifiedWhatIfFixture(o: {
  raw: number[]; salience: number[]; pairTokens: number; seenL2: number[]; covered: number;
  budget: number; adoptEpsilon: number; hysteresisCertificate: boolean;
  /** Cross-compile holder, and ownerless raw leaves appended after the eight. */
  reuse?: KvUnifiedReuse; appended?: number;
  /** All three bucket sizes; 1 (the default) makes the uncertified solve exact. */
  bucket?: number;
  mode?: 'individual' | 'joint';
  maxCandidates?: number;
}) {
  const chronicle = new MockChronicle({ recallPairTokens: o.pairTokens });
  for (let i = 0; i < 8; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: o.raw[i] });
  chronicle.chunks.forEach((chunk, i) => { chunk.salience = o.salience[i]; });
  const l1s: Array<{ id: string }> = [];
  for (let i = 0; i < 8; i += 2) l1s.push(chronicle.produceL1([`c${i}`, `c${i + 1}`]));
  for (let i = 0; i < (o.appended ?? 0); i++) chronicle.addChunk({ id: `n${i}`, rawTokens: 40 });
  for (const [k, tokens] of o.seenL2.entries()) {
    const id = `L2-seen-${k}`;
    chronicle.summaries.set(id, {
      id, level: 2, content: 'seen', tokens, sourceLevel: 1, sourceIds: [],
      sourceRange: { first: 'none', last: 'none' }, created: 0,
    });
    chronicle.recallPairTokens.set(id, tokens);
  }
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const leaves = new Map(Array.from({ length: o.covered }, (_, i) =>
    [`c${i}`, { level: 1, repHash: `summary:${l1s[i >> 1].id}`, lastChangedSeq: 1 }] as const));
  const strategy = new KvUnifiedStrategy({
    policy: {
      alpha: 0, budgetLowRatio: 0.2, budgetHighRatio: 0.5, budgetUnderLambda: 4000, budgetOverLambda: 4000,
      cacheLambda: 0, continuityLambda: 0,
    },
    tokenBucketSize: o.bucket ?? 1, continuityBucketSize: o.bucket ?? 1, fidelityBucketSize: o.bucket ?? 1,
    labelCeiling: 100_000,
    adoptEpsilon: o.adoptEpsilon, hysteresisCertificate: o.hysteresisCertificate,
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: o.maxCandidates ?? 8, ...(o.mode ? { mode: o.mode } : {}) },
    presentation: { currentSeq: 1, leaves },
    ...(o.reuse ? { reuse: o.reuse } : {}),
  });
  const result = strategy.solve(inputs, { totalBudget: o.budget, targetBudget: o.budget, slack: 0 });
  return { strategy, result };
}

test('latent demand orders emitted merges the same with the certificate as an exact solve without it', () => {
  // Two merges pass the gate with equal conservative gains, so the expected
  // (p50) gain orders them. A certified expected solve understates its gain
  // by up to the certificate's slack, which here is enough to hide the lead
  // of c4..c7 and let the weaker request be summarized first. Bucket size 1
  // makes the uncertified solve exact.
  const build = (hysteresisCertificate: boolean) => certifiedWhatIfFixture({
    raw: [150, 150, 50, 100, 100, 100, 50, 150], salience: [1, 0.2, 1, 0.2, 0.5, 1, 0.5, 0.5],
    pairTokens: 100, seenL2: [10, 30, 100, 150], covered: 4, budget: 500, adoptEpsilon: 50, hysteresisCertificate,
  });
  const certified = build(true);
  const unrestricted = build(false);
  const order = (r: typeof certified) => r.result.produced.map((p) => p.range.firstChunkId);
  assert.ok(order(unrestricted).length >= 2, 'two merges are requested');
  assert.deepEqual(order(certified), order(unrestricted));
  assert.deepEqual(
    certified.strategy.lastDemandEvaluations.map((e) => Math.round(e.expectedImprovement)),
    unrestricted.strategy.lastDemandEvaluations.map((e) => Math.round(e.expectedImprovement)),
  );
});

test('latent demand keeps a certified what-if pool that its pruned re-solve does not beat', () => {
  // Both certified what-ifs overlap, so both are solved again without the
  // certificate. With bucket size 1000 that solve prunes and comes back
  // worse than the certified pools, which are real layouts: taking it would
  // lower c0..c3 from 350 to 222.5 and drop c4..c7 (202.5) below the gate.
  const base = {
    raw: [30, 50, 100, 100, 150, 100, 200, 30], salience: [1, 1, 0.2, 0.2, 0.2, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 0, budget: 800, adoptEpsilon: 200,
  };
  const certified = certifiedWhatIfFixture({ ...base, hysteresisCertificate: true, bucket: 1000 });
  const exact = certifiedWhatIfFixture({ ...base, hysteresisCertificate: false });
  const gains = (r: typeof certified) =>
    r.strategy.lastDemandEvaluations.map((e) => [e.request.range.firstChunkId, e.conservativeImprovement]);
  assert.deepEqual(gains(certified), [['c0', 350], ['c4', 202.5]]);
  assert.deepEqual(gains(certified), gains(exact));
  assert.deepEqual(certified.result.produced, exact.result.produced);
});

test('latent demand runs each expected-cost solve once when a certified what-if is decided late', () => {
  // The c4..c7 what-if certifies and its slack spans the gate, so it is
  // solved again without the certificate. The expected (p50) solve of the
  // already-decided c0..c3 merge must not run a second time for that.
  const { strategy, result } = certifiedWhatIfFixture({
    raw: [50, 50, 200, 100, 100, 200, 50, 200], salience: [0.2, 0.5, 1, 1, 0.5, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 2, budget: 800, adoptEpsilon: 200, hysteresisCertificate: true,
  });
  assert.equal(result.produced.length, 2);
  // Two conservative what-ifs, the unrestricted c4..c7 one, one p50 each.
  assert.equal(strategy.lastTimings?.demandSolves, 5);
});

// The recall cost of the latent candidate a what-if solve measures, or
// undefined for a solve without one (the live solve, or the base re-solve).
const latentRecall = (solver: ParetoKvUnifiedPolicySolver): number | undefined => {
  const inputs = (solver as unknown as { inputs: PickerInputs }).inputs;
  for (const id of inputs.summaries.keys()) if (id.startsWith('__latent:')) return inputs.recallPairTokens?.get(id);
  return undefined;
};

test('a certified what-if whose re-solve the label ceiling stops stands at its certified gain, at every compile', (t) => {
  // The fixture of the test that keeps a certified pool its pruned re-solve
  // does not beat: both certified what-ifs overlap, so both are solved again
  // without the certificate, and here the ceiling stops both re-solves
  // (#252). Each certified pool is a real layout, so each stands at its
  // certified gain, as when its re-solve scores worse, and both still pass
  // the gate. The next compile on the same inputs solves the certified
  // what-ifs again and skips only the re-solves the ceiling stopped.
  const base = {
    raw: [30, 50, 100, 100, 150, 100, 200, 30], salience: [1, 1, 0.2, 0.2, 0.2, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 0, budget: 800, adoptEpsilon: 200,
    hysteresisCertificate: true, bucket: 1000,
  };
  // There the re-solves run and score worse than the certified pools.
  const scoredWorse = certifiedWhatIfFixture(base);
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  let whatIfs: string[] = [];
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    if (latentRecall(this) !== undefined) {
      whatIfs.push(options.hysteresisCertificate ? 'certified' : 'uncertified');
      if (!options.hysteresisCertificate) throw new SparseLabelCeilingError(100_000, 100_001);
    }
    return original.call(this, options);
  });
  const reuse: KvUnifiedReuse = {};
  const gains = (r: ReturnType<typeof certifiedWhatIfFixture>) =>
    r.strategy.lastDemandEvaluations.map((e) => [e.request.range.firstChunkId, e.conservativeImprovement]);
  const first = certifiedWhatIfFixture({ ...base, reuse });
  assert.equal(whatIfs.filter((solve) => solve === 'uncertified').length, 2, 'premise: both re-solves ran and were stopped');
  assert.deepEqual(gains(first), [['c0', 350], ['c4', 202.5]], 'each stands at its certified gain');
  assert.equal(first.result.produced.length, 2, 'and both pass the gate');
  assert.deepEqual(first.strategy.lastDemandEvaluations, scoredWorse.strategy.lastDemandEvaluations, 'as when its re-solve scores worse');
  assert.deepEqual(first.result.produced, scoredWorse.result.produced);
  assert.deepEqual(first.strategy.lastTimings?.ceiling, { whatIfs: 2, gate: false, joint: false });
  whatIfs = [];
  const second = certifiedWhatIfFixture({ ...base, reuse });
  assert.deepEqual(gains(second), gains(first), 'the next compile on the same inputs ranks the same');
  assert.deepEqual(second.result.produced, first.result.produced);
  assert.ok(whatIfs.includes('certified'), 'solving the certified what-ifs again');
  assert.ok(!whatIfs.includes('uncertified'), 'and not the re-solves the ceiling stopped');
});

test('an expected-cost solve the label ceiling stops leaves the conservative gain to order its request', (t) => {
  // The fixture of the test that runs each expected-cost solve once: both
  // merges pass the gate, and their expected (p50: 20, against a p80 of 30)
  // solves only order them. The ceiling stops both (#252), so the
  // conservative gains order them and both are still demanded.
  const base = {
    raw: [50, 50, 200, 100, 100, 200, 50, 200], salience: [0.2, 0.5, 1, 1, 0.5, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 2, budget: 800, adoptEpsilon: 200, hysteresisCertificate: true,
  };
  const ranges = (r: ReturnType<typeof certifiedWhatIfFixture>) => r.result.produced.map((request) => request.range.firstChunkId).sort();
  const free = certifiedWhatIfFixture(base);
  assert.equal(free.result.produced.length, 2, 'premise: two merges are demanded');
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  let stopped = 0;
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    if (latentRecall(this) === 20) {
      stopped++;
      throw new SparseLabelCeilingError(100_000, 100_001);
    }
    return original.call(this, options);
  });
  const held = certifiedWhatIfFixture(base);
  assert.equal(stopped, 2, 'premise: both expected-cost solves ran and were stopped');
  assert.deepEqual(ranges(held), ranges(free), 'both merges are still demanded');
  assert.equal(held.strategy.lastDemandEvaluations.length, 2);
  for (const evaluation of held.strategy.lastDemandEvaluations) {
    assert.equal(evaluation.expectedImprovement, evaluation.conservativeImprovement, 'ordered by the conservative gain');
  }
  assert.deepEqual(held.strategy.lastTimings?.ceiling, { whatIfs: 2, gate: false, joint: false });
});

test('a what-if holder carried to the next compile reads the live memo as it is now', () => {
  // The holder's copy of the subtree memo is taken when the holder is made;
  // on the next compile the live solve has replaced the entries an append
  // touched, and a copy still pointing at the old ones would compute those
  // subtrees again inside every what-if. A carried holder starts from the
  // live map and keeps only its own ids.
  const base = {
    raw: [50, 50, 200, 100, 100, 200, 50, 200], salience: [0.2, 0.5, 1, 1, 0.5, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 2, budget: 800, adoptEpsilon: 200, hysteresisCertificate: false,
  };
  const reuse: KvUnifiedReuse = {};
  for (const appended of [0, 1, 2]) {
    certifiedWhatIfFixture({ ...base, appended, reuse });
    assert.ok(reuse.subtree && reuse.subtree.size > 0 && reuse.whatIf && reuse.whatIf.size > 0, `appended=${appended}`);
    for (const [key, holder] of reuse.whatIf) {
      assert.ok(holder.subtree, key);
      // The candidate's sources read their leaves' allowed levels, which the
      // candidate changes, so their sets are the what-if's own.
      const sources = new Set(key.split('\0')[0].split(':').at(-1)!.split('+'));
      for (const [id, entry] of reuse.subtree) {
        if (sources.has(id)) continue;
        assert.equal(holder.subtree.get(id), entry, `appended=${appended}: ${key} shares the live entry for ${id}`);
      }
      assert.ok([...holder.subtree.keys()].some((id) => !reuse.subtree!.has(id)), `${key} keeps its own candidate's entry`);
    }
  }
});

test('latent demand what-if solves reuse their own forests across compiles without changing the ranking', () => {
  const base = {
    raw: [50, 50, 200, 100, 100, 200, 50, 200], salience: [0.2, 0.5, 1, 1, 0.5, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 2, budget: 800, adoptEpsilon: 200, hysteresisCertificate: true,
  };
  const describe = (r: ReturnType<typeof certifiedWhatIfFixture>) => ({
    produced: r.result.produced,
    evaluations: r.strategy.lastDemandEvaluations.map((e) => [e.request, e.conservativeImprovement, e.expectedImprovement]),
    frontier: [...r.result.frontier],
  });
  const reuse: KvUnifiedReuse = {};
  // Each compile builds its own inputs, as the host does; only `reuse` lives on.
  for (const appended of [0, 0, 1, 2]) {
    const before = new Map(reuse.whatIf ?? []);
    const held = certifiedWhatIfFixture({ ...base, appended, reuse });
    assert.deepEqual(describe(held), describe(certifiedWhatIfFixture({ ...base, appended })), `appended=${appended}`);
    assert.ok(reuse.whatIf && reuse.whatIf.size > 0, 'what-if holders are kept for the next compile');
    // A candidate scored again keeps its holder, and with it the forest to derive from.
    if (before.size > 0) {
      const carried = [...reuse.whatIf.entries()].filter(([key, holder]) => before.get(key) === holder);
      assert.ok(carried.length > 0, `appended=${appended}`);
      for (const [, holder] of carried) assert.equal(holder.forest?.derived, true, `appended=${appended}`);
    }
    // The live entries belong to the live solve alone.
    for (const holder of reuse.whatIf.values()) {
      assert.notEqual(holder.forest, reuse.forest);
      assert.ok(holder.certificate === undefined || holder.certificate !== reuse.certificate);
    }
  }
});

test('bandedAge reads an age at the lower edge of its geometric band', () => {
  for (const age of [0, 0.5, 1, 2, 3, 7, 8, 1000.5]) assert.equal(bandedAge(age, 0), age, 'steps 0 is exact');
  for (const age of [0, 0.5]) assert.equal(bandedAge(age, 4), age, 'ages below 1 are not banded');
  assert.deepEqual([1, 2, 3, 4, 7, 8, 15, 16, 17].map((age) => bandedAge(age, 1)), [1, 2, 2, 4, 4, 8, 8, 16, 16]);
  const steps = 4;
  const ratio = 2 ** (1 / steps);
  let previous = 0;
  for (let age = 1; age < 5000; age += 0.37) {
    const edge = bandedAge(age, steps);
    assert.ok(edge <= age && age < edge * ratio, `age ${age} sits in [${edge}, ${edge * ratio})`);
    assert.ok(edge >= previous, 'bands do not run backwards');
    previous = edge;
  }
  for (let power = 0; power < 20; power++) {
    const age = 2 ** power;
    assert.equal(bandedAge(age, steps), age, 'an age on a doubling is its own edge');
    if (power > 0) {
      // 2^p / 2^(1/4) and 2^(p-1) * 2^(3/4) name the same edge but land an
      // ulp apart under some Math.pow implementations (node 24 vs 22).
      const below = bandedAge(age - 1e-9, steps);
      assert.ok(Math.abs(below - age / ratio) <= 4 * Number.EPSILON * age, `just below ${age} is the band under it, got ${below}`);
    }
  }
  assert.equal(bandedAge(2 ** 0.75 * 1.0000001, 4), 2 ** 0.75, 'just above an edge is that edge');
  for (const s of [1, 4, 64]) {
    const top = bandedAge(Number.MAX_VALUE, s);
    assert.ok(Number.isFinite(top) && top <= Number.MAX_VALUE, `steps ${s}: the top of the range stays finite (${top})`);
  }
});

test('banded ages move a weight only when the age crosses a band edge', () => {
  const chunk = { id: 'c', sequence: 100, rawTokens: 1000, currentResolution: 0, pinned: false, lockedByAgent: false };
  const banded = normalizePolicy({ ageBandSteps: 1 });
  const exact = normalizePolicy({ ageBandSteps: 0 });
  // Ages 8..15 share a band at one step per doubling; 16 starts the next.
  const fidelity = (newest: number, policy = banded) => fidelityLeafBase(chunk, newest, policy);
  assert.equal(fidelity(100 + 7), fidelity(100 + 14), 'ages 8 and 15 price alike');
  assert.notEqual(fidelity(100 + 14), fidelity(100 + 15), 'age 16 is the next band');
  assert.equal(fidelity(100 + 7), fidelity(100 + 7, exact), 'an edge prices as the exact age does');
  assert.notEqual(fidelity(100 + 14), fidelity(100 + 14, exact));
  const previous = { repHash: 'raw:c', level: 0, lastChangedSeq: 100 };
  const continuity = (midpointTokens: number, currentSeq: number, policy = banded) =>
    continuityLeafBase(chunk, previous, currentSeq, midpointTokens, policy);
  // Recency 8192..16383 tokens and stability 8..15 turns are one band each.
  assert.equal(continuity(8_192, 108), continuity(16_383, 115), 'recency and stability share bands too');
  assert.notEqual(continuity(8_192, 108), continuity(16_384, 108));
  assert.notEqual(continuity(8_192, 108), continuity(8_192, 116));
  assert.equal(continuity(8_192, 108), continuity(8_192, 108, exact));
  assert.equal(normalizePolicy({}).ageBandSteps, 0, 'the solver-level default is exact');
  assert.throws(() => normalizePolicy({ ageBandSteps: -1 }), KvUnifiedPolicyError);
  assert.throws(() => normalizePolicy({ ageBandSteps: Number.NaN }), KvUnifiedPolicyError);
  assert.throws(() => normalizePolicy({ ageBandSteps: 0.5 }), KvUnifiedPolicyError, 'a band count is an integer');
  assert.equal(normalizePolicy({ ageBandSteps: MAX_AGE_BAND_STEPS }).ageBandSteps, MAX_AGE_BAND_STEPS);
  assert.throws(() => normalizePolicy({ ageBandSteps: MAX_AGE_BAND_STEPS + 1 }), KvUnifiedPolicyError, 'a band count is bounded');
});

test('banded continuity holds stability, reads it at doublings, and saturates recency', () => {
  const chunk = { id: 'c', sequence: 100, rawTokens: 1000, currentResolution: 0, pinned: false, lockedByAgent: false };
  const banded = normalizePolicy({ ageBandSteps: 4 });
  const exact = normalizePolicy({ ageBandSteps: 0 });
  const previous = { repHash: 'raw:c', level: 0, lastChangedSeq: 100 };
  const continuity = (midpointTokens: number, currentSeq: number, policy = banded) =>
    continuityLeafBase(chunk, previous, currentSeq, midpointTokens, policy);
  const moved = 100;
  const stableHalfLife = banded.continuityStableHalfLife;
  // Stability is 1 for the first half of a half-life after a move, whatever
  // the band count; exact ages decay from the first turn.
  const hold = Math.ceil(stableHalfLife / 2) - 1;
  assert.equal(continuity(1, moved), continuity(1, moved + hold), 'held for half a half-life');
  assert.notEqual(continuity(1, moved), continuity(1, moved + hold + 1), 'then it decays');
  assert.notEqual(continuity(1, moved, exact), continuity(1, moved + 1, exact), 'exact decays at once');
  // From there it is read at whole doublings, not at the 4 bands per doubling
  // the other ages use.
  const doubling = 2 ** Math.ceil(Math.log2(Math.max(1, stableHalfLife / 2)));
  assert.equal(continuity(1, moved + doubling), continuity(1, moved + 2 * doubling - 1), 'one band per doubling');
  assert.notEqual(continuity(1, moved + doubling), continuity(1, moved + 2 * doubling), 'the doubling is the edge');
  assert.notEqual(continuity(1, moved + doubling, exact), continuity(1, moved + doubling + 1, exact));
  // Recency is at its floor from eight half-lives out; exact ages keep decaying.
  const halfLife = banded.continuityRecencyHalfLifeTokens;
  assert.equal(continuity(8 * halfLife, moved), continuity(16 * halfLife, moved), 'saturated at eight half-lives');
  assert.equal(continuity(8 * halfLife, moved), continuity(64 * halfLife, moved));
  assert.notEqual(continuity(4 * halfLife, moved), continuity(8 * halfLife, moved), 'not before');
  assert.notEqual(continuity(8 * halfLife, moved, exact), continuity(16 * halfLife, moved, exact));
});

function latentFixture(): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  for (let index = 0; index < 4; index++) {
    const id = `latent-${index}`;
    chronicle.addChunk({ id, rawTokens: 100 });
    chronicle.produceL1([id]);
  }
  return {
    chunks: chronicle.chunks,
    summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
}

const latentPolicy = (budgetHighRatio: number) => ({
  alpha: 0, budgetLowRatio: 0, budgetHighRatio, budgetUnderLambda: 0, budgetOverLambda: 100_000,
  cacheLambda: 0, continuityLambda: 0,
});

test('joint latent demand measures the candidate set in one solve and demands the merges its cut uses', () => {
  // Four L1s of 60 over 100-token leaves, hard wall 300, upper hinge at 75:
  // the all-L1 cut (240) pays the hinge, one merge (150) still does, both
  // merges (60) clear it. One what-if solve holds both candidates; its cut
  // uses both, so both are demanded at the set's gain.
  const build = (mode: 'individual' | 'joint') => {
    const strategy = new KvUnifiedStrategy({
      policy: latentPolicy(0.25),
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode },
    });
    const result = strategy.solve(latentFixture(), { totalBudget: 300, targetBudget: 270, slack: 0.1 });
    return { strategy, result };
  };
  const joint = build('joint');
  const individual = build('individual');
  assert.deepEqual(joint.result.produced, individual.result.produced);
  assert.deepEqual(joint.result.produced.map((request) => request.level), [2, 2]);
  assert.equal(joint.strategy.lastTimings?.demandSolves, 1, 'the set is measured once');
  assert.equal(individual.strategy.lastTimings?.demandSolves, 2);
  const gains = joint.strategy.lastDemandEvaluations.map((e) => e.conservativeImprovement);
  assert.equal(gains.length, 2);
  assert.ok(gains[0] > 0 && gains[0] === gains[1], 'both carry the gain of the cut that uses them');
  assert.ok(joint.strategy.lastDemandEvaluations.every((e) => e.expectedImprovement === e.conservativeImprovement));
});

test('joint latent demand leaves a merge the joint cut does not use undemanded', () => {
  // Upper hinge at 150: one merge lands the cut exactly on the hinge at a
  // lower fidelity loss than two, so the joint cut uses one candidate. Each
  // candidate alone clears the hinge too, so the individual ranking demands
  // both, and the second merge would be produced and never selected.
  const build = (mode: 'individual' | 'joint') => {
    const strategy = new KvUnifiedStrategy({
      policy: latentPolicy(0.5),
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode },
    });
    const result = strategy.solve(latentFixture(), { totalBudget: 300, targetBudget: 270, slack: 0.1 });
    return { strategy, result };
  };
  const joint = build('joint');
  const individual = build('individual');
  assert.equal(individual.result.produced.length, 2);
  assert.equal(joint.result.produced.length, 1);
  assert.equal(joint.result.produced[0].level, 2);
  const evaluations = joint.strategy.lastDemandEvaluations;
  assert.equal(evaluations.length, 2, 'every candidate is reported');
  const used = evaluations.filter((e) => e.conservativeImprovement > 0);
  assert.equal(used.length, 1);
  assert.deepEqual(used[0].request, joint.result.produced[0]);
  assert.ok(evaluations.some((e) => e.conservativeImprovement === 0 && e.expectedImprovement === 0));
});

test('joint latent demand leaves a blocked merge out of the what-if, so the cut demands the alternative', () => {
  // The hinge-at-150 fixture above: one merge is enough and the joint cut
  // uses one candidate. When that merge is one the host would refuse (a
  // quarantined source set), it never enters the what-if forest and the cut
  // demands the other merge instead of hiding it behind a refused request.
  const build = (blocked?: (sourceIds: readonly string[]) => boolean) => {
    const strategy = new KvUnifiedStrategy({
      policy: latentPolicy(0.5),
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode: 'joint', blocked },
    });
    const result = strategy.solve(latentFixture(), { totalBudget: 300, targetBudget: 270, slack: 0.1 });
    return { strategy, result };
  };
  const open = build();
  assert.equal(open.result.produced.length, 1, 'premise: one merge is enough');
  const chosen = open.strategy.lastDemandEvaluations.find((e) => e.conservativeImprovement > 0)!;
  const other = open.strategy.lastDemandEvaluations.find((e) => e.conservativeImprovement === 0)!;
  const seen: string[][] = [];
  const quarantined = build((sourceIds) => {
    seen.push([...sourceIds]);
    return sourceIds.join('+') === chosen.sourceIds.join('+');
  });
  assert.deepEqual(seen.map((ids) => ids.join('+')).sort(), [chosen.sourceIds.join('+'), other.sourceIds.join('+')].sort(),
    'every candidate source set is asked');
  assert.deepEqual(quarantined.result.produced, [other.request], 'the alternative is demanded');
  assert.deepEqual(quarantined.strategy.lastDemandEvaluations.map((e) => e.sourceIds), [other.sourceIds],
    'the blocked candidate is not measured');
  assert.ok(quarantined.strategy.lastDemandEvaluations[0].conservativeImprovement > 0);
  const none = build(() => true);
  assert.deepEqual(none.result.produced, []);
  assert.equal(none.strategy.lastTimings?.demandSolves, 0, 'nothing to measure, nothing solved');
});

test('joint latent demand demands nothing when the joint cut beats the live one by at most epsilon', () => {
  // Hinge at 150 and one merge worth ~35,800: an epsilon above that gain
  // keeps the merge undemanded while the evaluations still report it.
  const strategy = new KvUnifiedStrategy({
    policy: latentPolicy(0.5),
    tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
    adoptEpsilon: 50_000,
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode: 'joint' },
  });
  const result = strategy.solve(latentFixture(), { totalBudget: 300, targetBudget: 270, slack: 0.1 });
  assert.deepEqual(result.produced, []);
  assert.ok(strategy.lastDemandEvaluations.some((e) => e.conservativeImprovement > 0 && e.conservativeImprovement <= 50_000));
});

test('joint latent demand gates a certified base solve the way the individual ranking does', () => {
  // The fixture of the certified-base test above: the carried raw layout
  // certifies under a wide epsilon and the merge is worth less than epsilon
  // against the unrestricted best cut. Both modes decide the same way from
  // a certified and an unrestricted base.
  const build = (hysteresisCertificate: boolean, mode: 'individual' | 'joint') => {
    const chronicle = new MockChronicle({ recallPairTokens: 100 });
    for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
    for (const chunk of chronicle.chunks) chunk.salience = 0.2;
    chronicle.produceL1(['c0', 'c1']);
    chronicle.produceL1(['c2', 'c3']);
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const leaves = new Map(chronicle.chunks.map((chunk) => [chunk.id, { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 1 }]));
    const strategy = new KvUnifiedStrategy({
      policy: {
        alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.125, budgetUnderLambda: 0, budgetOverLambda: 1600,
        cacheLambda: 0, continuityLambda: 0,
      },
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      adoptEpsilon: 1300, hysteresisCertificate,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode },
      presentation: { currentSeq: 1, leaves },
    });
    const result = strategy.solve(inputs, { totalBudget: 400, targetBudget: 400, slack: 0 });
    return { strategy, result };
  };
  for (const certificate of [true, false]) {
    const joint = build(certificate, 'joint');
    const individual = build(certificate, 'individual');
    assert.equal(Boolean(joint.strategy.lastResult?.certificate), certificate);
    assert.deepEqual(joint.result.produced, individual.result.produced, `certificate ${certificate}`);
    assert.deepEqual(joint.result.produced, []);
    assert.equal(joint.strategy.lastDemandEvaluations.length, 1);
    // One joint solve. With the certificate on, the what-if certifies the
    // carried layout too, and its slack spans the gate: the joint solve runs
    // again without the certificate to decide it. The gate fails either
    // way, so the certified base is never solved unrestricted.
    assert.equal(joint.strategy.lastTimings?.demandSolves, certificate ? 2 : 1);
  }
});

test('a joint settling solve the label ceiling stops is remembered as that solve, not the certified one', (t) => {
  // One candidate, joint, under a wide epsilon: the joint what-if certifies
  // and its slack spans the gate, so it is solved again without the
  // certificate, and here the ceiling stops that (#252). The candidate is then
  // ranked alone: its certified what-if, the same solve the joint ran first,
  // fits and is solved; its re-solve without the certificate, the joint's
  // settling one, is skipped as stopped, so it stands at its certified gain.
  // The next compile on the same inputs skips the joint.
  const base = {
    raw: [30, 50, 100, 100, 150, 100, 200, 30], salience: [1, 1, 0.2, 0.2, 0.2, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 0, budget: 800, adoptEpsilon: 400,
    hysteresisCertificate: true, bucket: 1000, mode: 'joint' as const, maxCandidates: 1,
  };
  const free = certifiedWhatIfFixture(base);
  assert.equal(free.strategy.lastTimings?.demandSolves, 2, 'premise: the joint solve and its settling solve');
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  // The solver's own what-if calls, by whether each has the certificate.
  let whatIfs: string[] = [];
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    if (latentRecall(this) !== undefined) {
      whatIfs.push(options.hysteresisCertificate ? 'certified' : 'uncertified');
      if (!options.hysteresisCertificate) throw new SparseLabelCeilingError(100_000, 100_001);
    }
    return original.call(this, options);
  });
  const reuse: KvUnifiedReuse = {};
  const first = certifiedWhatIfFixture({ ...base, reuse });
  assert.deepEqual(whatIfs, ['certified', 'uncertified', 'certified'], 'the joint solve, its stopped settling solve, and the certified what-if');
  assert.equal(first.strategy.lastTimings?.demandSolves, 3);
  assert.deepEqual(
    first.strategy.lastDemandEvaluations.map((e) => e.conservativeImprovement),
    free.strategy.lastDemandEvaluations.map((e) => e.conservativeImprovement),
    'which stands at its certified gain',
  );
  assert.deepEqual(first.result.produced, free.result.produced);
  assert.deepEqual(first.strategy.lastTimings?.ceiling, { whatIfs: 1, gate: false, joint: true });
  whatIfs = [];
  const second = certifiedWhatIfFixture({ ...base, reuse });
  assert.deepEqual(whatIfs, ['certified'], 'the next compile solves the certified what-if alone');
  assert.equal(second.strategy.lastTimings?.demandSolves, 1);
  assert.deepEqual(second.strategy.lastDemandEvaluations, first.strategy.lastDemandEvaluations);
  assert.deepEqual(second.strategy.lastTimings?.ceiling, { whatIfs: 1, gate: false, joint: true });
});

test('a joint failure remembered from a compile without the certificate is a new question for one with it', (t) => {
  // The fixture of the test above. Without the certificate, the joint's one
  // search is the uncertified one, and the ceiling stops it here; a compile
  // with the certificate on the same inputs runs the joint's own searches,
  // as a fresh one does, since its first search is another.
  const base = {
    raw: [30, 50, 100, 100, 150, 100, 200, 30], salience: [1, 1, 0.2, 0.2, 0.2, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 0, budget: 800, adoptEpsilon: 400,
    hysteresisCertificate: true, bucket: 1000, mode: 'joint' as const, maxCandidates: 1,
  };
  const free = certifiedWhatIfFixture(base);
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  const mocked = t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    if (latentRecall(this) !== undefined) throw new SparseLabelCeilingError(100_000, 100_001);
    return original.call(this, options);
  });
  const reuse: KvUnifiedReuse = {};
  const without = certifiedWhatIfFixture({ ...base, hysteresisCertificate: false, reuse });
  mocked.mock.restore();
  assert.equal(without.strategy.lastTimings?.ceiling?.joint, true, 'premise: the joint search without the certificate stopped');
  assert.ok([...reuse.whatIf!.values()].some((holder) => holder.ceilingFailure !== undefined), 'premise: and is remembered');
  const later = certifiedWhatIfFixture({ ...base, reuse });
  assert.equal(later.strategy.lastTimings?.demandSolves, free.strategy.lastTimings?.demandSolves, "the joint's searches run");
  assert.deepEqual(later.strategy.lastDemandEvaluations, free.strategy.lastDemandEvaluations);
  assert.equal(later.strategy.lastTimings?.ceiling, undefined);
});

test('joint latent demand on the default engine takes the cut from the shared-frame hook, not the candidate list', () => {
  // The subtree engine is the default; its result carries both hooks, and
  // the joint ranking reads the used set off `bestUnder` without refining
  // and scoring every terminal candidate of the pool.
  const reads: number[] = [];
  const solve = ParetoKvUnifiedPolicySolver.prototype.solve;
  ParetoKvUnifiedPolicySolver.prototype.solve = function (this: ParetoKvUnifiedPolicySolver, ...args) {
    const result = solve.apply(this, args);
    if (result.feasible) {
      const descriptor = Object.getOwnPropertyDescriptor(result, 'candidates');
      if (descriptor?.get) {
        const get = descriptor.get;
        let count = 0;
        reads.push(0);
        const slot = reads.length - 1;
        Object.defineProperty(result, 'candidates', { get() { reads[slot] = ++count; return get.call(this); }, configurable: true, enumerable: true });
      }
      assert.equal(typeof result.bestScoreUnder, typeof result.bestUnder, 'both hooks or neither');
    }
    return result;
  };
  try {
    const build = (engine: 'auto' | 'dag') => {
      const strategy = new KvUnifiedStrategy({
        policy: latentPolicy(0.5), engine,
        tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
        latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode: 'joint' },
      });
      return { strategy, result: strategy.solve(latentFixture(), { totalBudget: 300, targetBudget: 270, slack: 0.1 }) };
    };
    const auto = build('auto');
    assert.equal(auto.result.produced.length, 1, 'premise: one merge is enough');
    assert.ok(reads.length >= 2, 'premise: the live solve and the joint what-if were scored lazily');
    assert.deepEqual(reads, reads.map(() => 0), 'no result had its candidate list read');
    const dag = build('dag');
    assert.deepEqual(auto.result.produced, dag.result.produced);
    assert.deepEqual(auto.strategy.lastDemandEvaluations, dag.strategy.lastDemandEvaluations);
  } finally {
    ParetoKvUnifiedPolicySolver.prototype.solve = solve;
  }
});

test('a joint forest that exceeded the ceiling is not solved again while the candidate set and ceiling are unchanged', () => {
  const fixture = (): PickerInputs => {
    const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
    const raw = [90, 130, 70, 160, 110, 140];
    const recall = [40, 75, 55, 90, 65, 80];
    for (let index = 0; index < 6; index++) {
      const id = `latent-${index}`;
      chronicle.addChunk({ id, rawTokens: raw[index] });
      chronicle.chunks[index].salience = 0.4 + 0.1 * index;
      const l1 = chronicle.produceL1([id]);
      chronicle.recallPairTokens.set(l1.id, recall[index]);
    }
    return {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
  };
  const build = (mode: 'individual' | 'joint', labelCeiling: number, reuse: KvUnifiedReuse) => {
    const strategy = new KvUnifiedStrategy({
      policy: { alpha: 0.7, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 },
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling, reuse,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode },
    });
    const result = strategy.solve(fixture(), { totalBudget: 500, targetBudget: 450, slack: 0.1 });
    return { strategy, result };
  };
  const individual = build('individual', 40, {});
  const reuse: KvUnifiedReuse = {};
  const first = build('joint', 40, reuse);
  assert.equal(first.strategy.lastTimings?.demandSolves, individual.strategy.lastTimings!.demandSolves + 1, 'premise: the joint attempt failed');
  const holders = [...reuse.whatIf!.values()].filter((holder) => holder.ceilingFailure !== undefined);
  assert.equal(holders.length, 1, 'the joint holder remembers the failure');
  const second = build('joint', 40, reuse);
  assert.deepEqual(second.result.produced, first.result.produced);
  assert.equal(second.strategy.lastTimings?.demandSolves, individual.strategy.lastTimings!.demandSolves, 'no joint attempt');
  assert.ok([...reuse.whatIf!.values()].some((holder) => holder.ceilingFailure !== undefined), 'and still remembers it');
  // A different ceiling is a new question.
  const roomy = build('joint', 10_000, reuse);
  assert.equal(roomy.strategy.lastTimings?.demandSolves, 1, 'measured once with room');
});

test('a remembered joint ceiling failure is forgotten when the wall changes', () => {
  // The six-leaf fixture over a ceiling of 40 at a wall of 500; at 405 the
  // joint forest fits. A holder carried from the failed compile must not
  // keep the ranking individual at the new wall.
  const fixture = (): PickerInputs => {
    const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
    const raw = [90, 130, 70, 160, 110, 140];
    const recall = [40, 75, 55, 90, 65, 80];
    for (let index = 0; index < 6; index++) {
      const id = `latent-${index}`;
      chronicle.addChunk({ id, rawTokens: raw[index] });
      chronicle.chunks[index].salience = 0.4 + 0.1 * index;
      const l1 = chronicle.produceL1([id]);
      chronicle.recallPairTokens.set(l1.id, recall[index]);
    }
    return {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
  };
  const build = (budget: number, reuse: KvUnifiedReuse) => {
    const strategy = new KvUnifiedStrategy({
      policy: { alpha: 0.7, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 },
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 40, adoptEpsilon: 90_000, reuse,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode: 'joint' },
    });
    const result = strategy.solve(fixture(), { totalBudget: budget, targetBudget: budget * 0.9, slack: 0.1 });
    return { strategy, result };
  };
  const reuse: KvUnifiedReuse = {};
  const wide = build(500, reuse);
  assert.ok([...reuse.whatIf!.values()].some((holder) => holder.ceilingFailure !== undefined), 'premise: the joint solve failed at 500');
  assert.ok(wide.strategy.lastTimings!.demandSolves > 1, 'premise: the individual ranking ran');
  const fresh = build(405, {});
  assert.equal(fresh.strategy.lastTimings?.demandSolves, 1, 'premise: at 405 the joint forest fits');
  assert.ok(fresh.result.produced.length > 0, 'premise: and the set is demanded');
  const carried = build(405, reuse);
  assert.equal(carried.strategy.lastTimings?.demandSolves, 1, 'the joint solve is tried again at the new wall');
  assert.deepEqual(carried.result.produced, fresh.result.produced);
  // A pin, a head window, a level bound that only touches the level a
  // candidate would add, or a leaf's size: the signature digests every
  // input the solve reads, so each is a new question.
  const pinned = (budget: number, holder: KvUnifiedReuse, how: 'pin' | 'head' | 'max' | 'tokens' = 'pin') => {
    const inputs = fixture();
    if (how === 'head') { inputs.headChunkIds = new Set(['latent-0']); inputs.headTokens = 90; }
    else if (how === 'max') for (const chunk of inputs.chunks) chunk.pinMaxLevel = 1;
    else if (how === 'tokens') for (const chunk of inputs.chunks) chunk.rawTokens *= 2;
    else inputs.chunks[1].pinned = true;
    const strategy = new KvUnifiedStrategy({
      policy: { alpha: 0.7, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 },
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 40, adoptEpsilon: 90_000, reuse: holder,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode: 'joint' },
    });
    return { strategy, result: strategy.solve(inputs, { totalBudget: budget, targetBudget: budget * 0.9, slack: 0.1 }) };
  };
  const again: KvUnifiedReuse = {};
  const failed = build(500, again);
  assert.ok(failed.strategy.lastTimings!.demandSolves > 1, 'premise: failed at 500');
  const freshPinned = pinned(500, {});
  assert.equal(freshPinned.strategy.lastTimings?.demandSolves, 1, 'premise: with a leaf pinned the joint forest fits at 500');
  const carriedPinned = pinned(500, again);
  assert.equal(carriedPinned.strategy.lastTimings?.demandSolves, 1, 'the joint solve is tried again after the pins');
  assert.deepEqual(carriedPinned.result.produced, freshPinned.result.produced);
  const once: KvUnifiedReuse = {};
  build(500, once);
  const freshHead = pinned(500, {}, 'head');
  assert.equal(freshHead.strategy.lastTimings?.demandSolves, 1, 'premise: with a head leaf the joint forest fits at 500');
  const carriedHead = pinned(500, once, 'head');
  assert.equal(carriedHead.strategy.lastTimings?.demandSolves, 1, 'the joint solve is tried again after the head window');
  assert.deepEqual(carriedHead.result.produced, freshHead.result.produced);
  const bounded: KvUnifiedReuse = {};
  build(500, bounded);
  const freshMax = pinned(500, {}, 'max');
  assert.equal(freshMax.strategy.lastTimings?.demandSolves, 1, 'premise: with every leaf bounded at L1 the joint forest fits at 500');
  const carriedMax = pinned(500, bounded, 'max');
  assert.equal(carriedMax.strategy.lastTimings?.demandSolves, 1, 'the joint solve is tried again after a bound on the proposed level');
  assert.deepEqual(carriedMax.result.produced, freshMax.result.produced);
  // So does a leaf's token estimate.
  const resized: KvUnifiedReuse = {};
  build(500, resized);
  const freshTokens = pinned(500, {}, 'tokens');
  assert.equal(freshTokens.strategy.lastTimings?.demandSolves, 1, 'premise: with the leaves twice the size the joint forest fits at 500');
  const carriedTokens = pinned(500, resized, 'tokens');
  assert.equal(carriedTokens.strategy.lastTimings?.demandSolves, 1, 'the joint solve is tried again after the estimates moved');
  assert.deepEqual(carriedTokens.result.produced, freshTokens.result.produced);
});

test('a root the forest treeified away from a crossed parent is not a merge candidate', () => {
  // Six leaves under one L1 each and a stored L2 over c0 and c2 alone: the
  // forest removes the crossed L2, so the L1s of c0 and c2 are roots in it,
  // but their stored entries still name the parent and the merge queue
  // skips a source with one. The candidate runs break at those two (c1
  // alone, then c3..c5), so the only merge demanded is one the queue can
  // build, c3..c4, where before c0..c1 and c2..c3 were demanded and never
  // queued.
  const build = (mode: 'individual' | 'joint') => {
    const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
    const l1s = [];
    for (let i = 0; i < 6; i++) {
      chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
      l1s.push(chronicle.produceL1([`c${i}`]));
    }
    const crossed = chronicle.produceUpper(2, [l1s[0].id, l1s[2].id]);
    assert.ok(chronicle.summaries.get(l1s[0].id)?.parentId === crossed.id, 'premise: the stored L1 names the parent');
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const strategy = new KvUnifiedStrategy({
      policy: latentPolicy(0.25), treeifyNonContiguousSummaries: true,
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode },
    });
    return strategy.solve(inputs, { totalBudget: 400, targetBudget: 360, slack: 0.1 });
  };
  for (const mode of ['joint', 'individual'] as const) {
    const result = build(mode);
    assert.deepEqual(result.produced.map((request) => [request.level, request.range.firstChunkId, request.range.lastChunkId]),
      [[2, 'c3', 'c4']], mode);
  }
});

test('joint latent demand what-if solves reuse their forests across compiles without changing the ranking', () => {
  const base = {
    raw: [50, 50, 200, 100, 100, 200, 50, 200], salience: [0.2, 0.5, 1, 1, 0.5, 1, 0.5, 1],
    pairTokens: 150, seenL2: [10, 20, 30, 40], covered: 2, budget: 800, adoptEpsilon: 200, hysteresisCertificate: true,
    mode: 'joint' as const,
  };
  const describe = (r: ReturnType<typeof certifiedWhatIfFixture>) => ({
    produced: r.result.produced,
    evaluations: r.strategy.lastDemandEvaluations.map((e) => [e.request, e.conservativeImprovement, e.expectedImprovement]),
    frontier: [...r.result.frontier],
  });
  const reuse: KvUnifiedReuse = {};
  let previousKey: string | undefined;
  for (const appended of [0, 0, 1, 2]) {
    const before = new Map(reuse.whatIf ?? []);
    const held = certifiedWhatIfFixture({ ...base, appended, reuse });
    assert.deepEqual(describe(held), describe(certifiedWhatIfFixture({ ...base, appended })), `appended=${appended}`);
    assert.ok(held.result.produced.length > 0, `appended=${appended}: premise, the set is demanded`);
    assert.equal(reuse.whatIf?.size, 1, 'one joint holder for the whole set');
    const [key, holder] = [...reuse.whatIf!.entries()][0];
    if (previousKey !== undefined) assert.equal(key, previousKey, 'the same set keys the same holder');
    previousKey = key;
    if (before.size > 0) {
      assert.equal(before.get(key), holder, `appended=${appended}: the holder is carried`);
      assert.equal(holder.forest?.derived, true, `appended=${appended}: and its forest derived`);
    }
    assert.notEqual(holder.forest, reuse.forest);
  }
  // A candidate gone from the set (its merge exists) keys a different holder.
  const merged = certifiedWhatIfFixture({ ...base, appended: 2, reuse, seenL2: [10, 20, 30, 40] });
  assert.ok(merged.result.produced.length > 0);
});

test('joint latent demand falls back to the individual ranking when the joint forest exceeds the label ceiling', () => {
  // Six L1s of varied size and cost under a ceiling of 40 labels: each
  // what-if fits on its own and the joint forest, which holds every
  // candidate at once, does not. The demand is optional, so the compile
  // goes on with the candidates one at a time instead of failing.
  const fixture = (): PickerInputs => {
    const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
    const raw = [90, 130, 70, 160, 110, 140];
    const recall = [40, 75, 55, 90, 65, 80];
    for (let index = 0; index < 6; index++) {
      const id = `latent-${index}`;
      chronicle.addChunk({ id, rawTokens: raw[index] });
      chronicle.chunks[index].salience = 0.4 + 0.1 * index;
      const l1 = chronicle.produceL1([id]);
      chronicle.recallPairTokens.set(l1.id, recall[index]);
    }
    return {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
  };
  const build = (mode: 'individual' | 'joint', labelCeiling: number) => {
    const strategy = new KvUnifiedStrategy({
      policy: { alpha: 0.7, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 },
      tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode },
    });
    const result = strategy.solve(fixture(), { totalBudget: 500, targetBudget: 450, slack: 0.1 });
    return { strategy, result };
  };
  const individual = build('individual', 40);
  const joint = build('joint', 40);
  assert.ok(individual.result.produced.length > 0);
  assert.deepEqual(joint.result.produced, individual.result.produced, 'the fallback is the individual ranking');
  assert.equal(joint.strategy.lastTimings?.demandSolves, individual.strategy.lastTimings!.demandSolves + 1, 'the joint attempt, then the individual solves');
  assert.equal(build('joint', 10_000).strategy.lastTimings?.demandSolves, 1, 'with room, the set is measured once');
});
