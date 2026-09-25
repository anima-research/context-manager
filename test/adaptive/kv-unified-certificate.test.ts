import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifyCarriedLayout } from '../../src/adaptive/kv-unified-certificate.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ExactKvUnifiedPolicySolver, type AcceptedPresentationReference } from '../../src/adaptive/kv-unified-policy.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

function fixture(gaps = false): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 });
  const a = chronicle.produceL1(gaps ? ['c0', 'c2'] : ['c0', 'c1']);
  const b = chronicle.produceL1(gaps ? ['c1', 'c3'] : ['c2', 'c3']);
  if (!gaps) chronicle.produceUpper(2, [a.id, b.id]);
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

function presentation(forest: CanonicalSummaryForest, frontier = new Map<string, number>()): AcceptedPresentationReference {
  return {
    currentSeq: 3,
    leaves: new Map(forest.orderedLeaves().map((leaf) => {
      const level = frontier.get(leaf.id) ?? 0;
      const id = leaf.summaryIds.find((id) => forest.summary(id)!.level === level);
      return [leaf.id, { level, repHash: level === 0 ? `raw:${leaf.id}` : `summary:${id}`, lastChangedSeq: 1 }];
    })),
  };
}

test('certificate bounds every exhaustive cut and agrees with oracle hysteresis across varied forests', () => {
  let seed = 0x51_11_ca;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let certified = 0;
  let declined = 0;
  for (let run = 0; run < 100; run++) {
    const inputs = fixture(run % 2 === 0);
    for (const chunk of inputs.chunks) {
      chunk.rawTokens = 20 + Math.floor(random() * 150);
      chunk.salience = random();
    }
    for (const id of inputs.summaries.keys()) {
      (inputs.recallPairTokens as Map<string, number>).set(id, 15 + Math.floor(random() * 150));
    }
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const cuts = forest.enumerateExactCuts().candidates;
    for (const cut of cuts) {
      const options = {
        maxTokens: cut.renderedTokens + Math.floor(random() * 200),
        presentation: presentation(forest, new Map(cut.frontier)),
        adoptEpsilon: run % 3 === 0 ? 1_000_000 : 20 + random() * 300,
        policy: {
          alpha: random(), budgetLowRatio: random() * 0.6,
          budgetHighRatio: 0.6 + random() * 0.4,
          budgetUnderLambda: random() * 3000, budgetOverLambda: random() * 3000,
          continuityLambda: random() * 1000, continuityScale: 100,
        },
      };
      const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
      assert.ok(oracle.feasible);
      const result = certifyCarriedLayout(inputs, forest, options);
      if (!result) { declined++; continue; }
      certified++;
      const minimum = Math.min(...oracle.candidates.map((c) => c.fidelityLoss + c.budgetPenalty));
      assert.ok(result.certificate.lowerBound <= minimum + 1e-9,
        `run ${run}: ${result.certificate.lowerBound} exceeds ${minimum}`);
      assert.deepEqual(result.selected.frontier, oracle.selected.frontier);
      assert.equal(result.selected.score, oracle.selected.score);
      assert.equal(result.cacheFloor, oracle.cacheFloor);
      assert.equal(result.continuityFloor, oracle.continuityFloor);
      const existing = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({
        ...options, tokenBucketSize: 100, continuityBucketSize: 50, fidelityBucketSize: 1000,
      });
      assert.ok(existing.feasible);
      assert.deepEqual(result.selected.frontier, existing.selected.frontier);
      assert.equal(result.selected.score, existing.selected.score);
    }
  }
  assert.ok(certified > 100, `only ${certified} certificates`);
  assert.ok(declined > 0, 'exercise unsuccessful proofs as well');
});

test('opt-in certificate bypasses labels and preserves positive continuity pricing', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const options = { maxTokens: 400, presentation: presentation(forest), adoptEpsilon: 2000,
    policy: { continuityLambda: 500, continuityScale: 100 } };
  const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
  const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({
    ...options, hysteresisCertificate: true, labelCeiling: 1,
  });
  assert.ok(result.feasible && oracle.feasible);
  assert.ok(result.certificate);
  assert.equal(result.propagation, undefined);
  assert.deepEqual(result.selected.frontier, oracle.selected.frontier);
});

test('failed certificate leaves forced budget transitions and their floors unchanged', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const options = { maxTokens: 250, presentation: presentation(forest), adoptEpsilon: 2000 };
  assert.equal(certifyCarriedLayout(inputs, forest, options), null);
  assert.deepEqual(solver.solve({ ...options, hysteresisCertificate: true }), solver.solve(options));
});

test('certificates retain zero cache floors and decline nonzero churn even if singleton scoring hides it', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const base = { maxTokens: 400, presentation: presentation(forest), adoptEpsilon: 2000,
    currentImmutablePrefixHash: 'same' };
  const cache = { immutablePrefixHash: 'same', layout,
    markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] };
  const result = certifyCarriedLayout(inputs, forest, { ...base, cache });
  assert.ok(result);
  assert.equal(result.selected.cacheChurn, 0);
  assert.equal(result.cacheFloor, 0);
  assert.equal(certifyCarriedLayout(inputs, forest, { ...base, cache: { ...cache, markers: [] } }), null);
  // A mismatched immutable prefix makes the cache irrelevant by existing policy.
  assert.ok(certifyCarriedLayout(inputs, forest, { ...base, cache: { ...cache, markers: [] },
    currentImmutablePrefixHash: 'changed' }));
});

test('declines changed representation hashes, mixed summary cuts, and absent/disabled hysteresis', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const base = { maxTokens: 400, presentation: presentation(forest), adoptEpsilon: 2000 };
  assert.equal(certifyCarriedLayout(inputs, forest, { ...base, presentation: undefined }), null);
  for (const adoptEpsilon of [0, -1, NaN, Infinity]) {
    assert.equal(certifyCarriedLayout(inputs, forest, { ...base, adoptEpsilon }), null);
  }
  const changed = new Map(base.presentation.leaves);
  changed.set('c0', { level: 0, repHash: 'raw:stale', lastChangedSeq: 0 });
  assert.equal(certifyCarriedLayout(inputs, forest, { ...base,
    presentation: { currentSeq: 3, leaves: changed } }), null);
  const mixed = presentation(forest, new Map([['c0', 1]]));
  assert.equal(certifyCarriedLayout(inputs, forest, { ...base, presentation: mixed }), null);
});

test('new raw-only leaves extend the certificate; a foldable extension is enumerated and scored, not declined', () => {
  const inputs = fixture();
  const before = new CanonicalSummaryForest(inputs);
  const previous = presentation(before);
  inputs.chunks.push({ id: 'extension', sequence: 4, rawTokens: 12,
    currentResolution: 0, lockedByAgent: false, pinned: false });
  const forest = new CanonicalSummaryForest(inputs);
  const options = { maxTokens: 450, presentation: previous, adoptEpsilon: 2000 };
  assert.ok(certifyCarriedLayout(inputs, forest, options));
  // c0 is now "new" and its L1 gives it a fold option: hysteresis keeps the
  // accepted layout under the BEST extension, which the certificate now
  // enumerates exactly and must agree with the oracle on.
  const missing = new Map(previous.leaves);
  missing.delete('c0');
  const ambiguous = { ...options, presentation: { currentSeq: 3, leaves: missing } };
  const result = certifyCarriedLayout(inputs, forest, ambiguous);
  assert.ok(result, 'foldable extension certifies');
  const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(ambiguous);
  assert.ok(oracle.feasible);
  assert.deepEqual(result.selected.frontier, oracle.selected.frontier);
  assert.equal(result.selected.score, oracle.selected.score);
});

test('protected internal holes fall back, while externally accounted holes have exact bounds', () => {
  const inputs = fixture();
  inputs.chunks[0].pinned = true;
  const forest = new CanonicalSummaryForest(inputs);
  const options = { maxTokens: 400, presentation: presentation(forest), adoptEpsilon: 2000 };
  assert.equal(certifyCarriedLayout(inputs, forest, options), null);
  const external = { ...inputs, headTokens: 90, headChunkIds: new Set(['c0']) };
  const externalForest = new CanonicalSummaryForest(external);
  const result = certifyCarriedLayout(external, externalForest, options);
  assert.ok(result);
  const oracle = new ExactKvUnifiedPolicySolver(external, externalForest).solve(options);
  assert.ok(oracle.feasible);
  assert.deepEqual(result.selected.frontier, oracle.selected.frontier);
  assert.ok(result.certificate.lowerBound <= Math.min(...oracle.candidates.map((c) => c.fidelityLoss + c.budgetPenalty)));
});
