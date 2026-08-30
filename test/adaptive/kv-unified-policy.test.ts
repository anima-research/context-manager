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
import { KvUnifiedStrategy } from '../../src/adaptive/strategies/kv-unified.js';
import { Picker } from '../../src/adaptive/picker.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';

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

test('kv-unified grid mode stays hard-feasible and reports a score-error bound', () => {
  const { inputs } = fixture();
  const result = new ParetoKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 250,
    tokenBucketSize: 100,
    continuityBucketSize: 100,
    fidelityBucketSize: 100,
  });
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.ok(result.selected.renderedTokens <= 250);
  assert.equal(result.propagation?.approximationBounded, true);
  assert.ok((result.propagation?.approximationScoreErrorBound ?? 0) > 0);
  assert.equal(result.propagation?.tokenBucketSize, 100);
  assert.ok(result.candidates.some((candidate) => candidate.renderedTokens === 55));
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
