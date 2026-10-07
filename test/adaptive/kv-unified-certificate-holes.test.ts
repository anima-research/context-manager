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

function fixture(run: number) {
  const c = new MockChronicle({ recallPairTokens: 15 + run % 30 });
  for (let i = 0; i < 8; i++) {
    const chunk = c.addChunk({ id: `c${i}`, rawTokens: 40 + (i * 17 + run * 13) % 70 });
    chunk.salience = run % 5 === 0 ? 0 : (i + 1) / 8;
  }
  const groups = run % 2 ? [[0, 2], [1, 3], [4, 6], [5, 7]] : [[0, 1], [2, 3], [4, 5], [6, 7]];
  const l1 = groups.map(ids => c.produceL1(ids.map(i => `c${i}`)));
  const l2 = [c.produceUpper(2, l1.slice(0, 2).map(s => s.id)), c.produceUpper(2, l1.slice(2).map(s => s.id))];
  c.produceUpper(3, l2.map(s => s.id));
  c.chunks[1].pinned = true;
  c.chunks[3].lockedByAgent = true;
  c.chunks[3].currentResolution = run % 3 === 0 ? 0 : 1;
  c.chunks[4].pinLevel = run % 4 === 0 ? 2 : 1;
  c.chunks[6].pinMaxLevel = 1;
  const external = run % 4 === 1;
  const inputs: PickerInputs = { chunks: c.chunks, summaries: c.summaries, recallPairTokens: c.recallPairTokens,
    headTokens: external ? c.chunks[0].rawTokens : 0, tailTokens: external ? c.chunks[7].rawTokens : 0,
    headChunkIds: new Set(external ? ['c0'] : []), tailChunkIds: new Set(external ? ['c7'] : []) };
  return { c, inputs };
}

function presentation(forest: CanonicalSummaryForest, frontier: Map<string, number>, omit = new Set<string>()): AcceptedPresentationReference {
  return { currentSeq: 9, leaves: new Map(forest.orderedLeaves().filter(l => !omit.has(l.id)).map(l => {
    const level = frontier.get(l.id) ?? 0;
    const summary = l.summaryIds.find(id => forest.summary(id)!.level === level);
    return [l.id, { level, repHash: level ? `summary:${summary}` : `raw:${l.id}`, lastChangedSeq: 1 }];
  })) };
}

test('nested protected holes, ownership gaps, ties and current receipts agree with exhaustive cuts', () => {
  let certificates = 0;
  for (let run = 0; run < 64; run++) {
    const { inputs } = fixture(run);
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const cuts = forest.enumerateExactCuts().candidates;
    assert.ok(cuts.length > 0);
    for (const cut of cuts) {
      const frontier = new Map(cut.frontier);
      const layout = renderLayout(inputs, new SummaryTree(inputs), frontier);
      const options = { maxTokens: cut.renderedTokens + 1 + (run * 31) % 500,
        adoptEpsilon: 1_000_000, presentation: presentation(forest, frontier),
        currentImmutablePrefixHash: 'today',
        cache: { immutablePrefixHash: 'today', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
        policy: { alpha: (run % 8) / 8, budgetLowRatio: (run % 4) / 5, budgetHighRatio: 0.8,
          budgetUnderLambda: 1000, budgetOverLambda: 4000, continuityLambda: 300, cacheLambda: 100 } };
      const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
      const result = certifyCarriedLayout(inputs, forest, options);
      assert.ok(oracle.feasible && result, `run ${run}`);
      certificates++;
      assert.ok(result.certificate.lowerBound <= Math.min(...oracle.candidates.map(c => c.fidelityLoss + c.budgetPenalty)), `bound run ${run}`);
      assert.deepEqual(result.selected.frontier, oracle.selected.frontier);
      assert.equal(result.selected.score, oracle.selected.score);
      assert.equal(result.cacheFloor, oracle.cacheFloor);
      assert.equal(result.continuityFloor, oracle.continuityFloor);
      assert.equal(result.selected.frontier.size, inputs.chunks.length);
      const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
      const full = solver.solve(options);
      assert.ok(full.feasible);
      assert.deepEqual(result.selected.frontier, full.selected.frontier);
      assert.equal(result.selected.score, full.selected.score);
      // With a narrow epsilon, either certify the same policy decision or
      // fall through to precisely the existing full solve, including floors.
      const narrow = { ...options, adoptEpsilon: 0.001 };
      const ordinary = solver.solve(narrow);
      const enabled = solver.solve({ ...narrow, hysteresisCertificate: true });
      assert.ok(ordinary.feasible && enabled.feasible);
      assert.deepEqual(enabled.selected.frontier, ordinary.selected.frontier);
      assert.equal(enabled.selected.score, ordinary.selected.score);
      if (!enabled.certificate) assert.deepEqual(enabled, ordinary);
    }
  }
  assert.ok(certificates > 128);
});

test('a fresh L1 with a raw pin and nested refolding enumerates only canonical carried extensions', () => {
  for (let run = 0; run < 16; run++) {
    const { c, inputs } = fixture(run);
    const before = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const old = before.enumerateExactCuts().candidates[0].frontier;
    const previous = presentation(before, new Map(old));
    const acceptedLayout = renderLayout(inputs, new SummaryTree(inputs), new Map(old));
    c.addChunk({ id: 'new-pin', rawTokens: 65, pinned: true });
    c.addChunk({ id: 'new-free', rawTokens: 90 });
    const fresh = c.produceL1(['new-pin', 'new-free']);
    const root = [...c.summaries.values()].find(s => s.level === 3)!;
    // New upper context changes today's forest; it is never reused from the receipt.
    const freshL2 = c.produceUpper(2, [fresh.id]);
    const freshL3 = c.produceUpper(3, [freshL2.id]);
    c.produceUpper(4, [root.id, freshL3.id]);
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const options = { maxTokens: 3000, adoptEpsilon: 1_000_000, presentation: previous };
    const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
    const result = certifyCarriedLayout(inputs, forest, options);
    assert.ok(oracle.feasible && result);
    const matching = oracle.candidates.filter(c => [...previous.leaves].every(([id, leaf]) => c.frontier.get(id) === leaf.level));
    const key = (frontier: ReadonlyMap<string, number>) => JSON.stringify([...frontier].sort());
    assert.deepEqual(result.candidates.map(c => key(c.frontier)).sort(), matching.map(c => key(c.frontier)).sort());
    assert.deepEqual(result.selected.frontier, oracle.selected.frontier);
    assert.equal(result.selected.score, oracle.selected.score);
    assert.equal(result.selected.frontier.get('new-pin'), 0);
    assert.ok(result.certificate.lowerBound <= Math.min(...oracle.candidates.map(c => c.fidelityLoss + c.budgetPenalty)));
    const withReceipt = { ...options, currentImmutablePrefixHash: 'old-prefix',
      cache: { immutablePrefixHash: 'old-prefix', layout: acceptedLayout,
        markers: [{ unitIndex: acceptedLayout.units.length, offset: acceptedLayout.totalTokens }] } };
    const receiptOracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(withReceipt);
    const receiptResult = certifyCarriedLayout(inputs, forest, withReceipt);
    assert.ok(receiptOracle.feasible);
    const receiptMatching = receiptOracle.candidates.filter(c => [...previous.leaves].every(([id, leaf]) => c.frontier.get(id) === leaf.level));
    if (receiptMatching.some(c => c.cacheChurn !== 0)) {
      assert.equal(receiptResult, null, 'nonzero actual churn cannot prove the zero global floor');
      const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
      assert.deepEqual(solver.solve({ ...withReceipt, hysteresisCertificate: true }), solver.solve(withReceipt));
    } else {
      assert.ok(receiptResult);
      assert.deepEqual(receiptResult.selected.frontier, receiptOracle.selected.frontier);
      assert.equal(receiptResult.selected.score, receiptOracle.selected.score);
    }
  }
});

test('today\'s pins, locks, summary identities and receipt invalidate stale carried proofs', () => {
  const { c, inputs } = fixture(2);
  let forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
  const cut = forest.enumerateExactCuts().candidates.find(c => c.frontier.get('c0') === 3)!;
  assert.ok(cut);
  const previous = presentation(forest, new Map(cut.frontier));
  const options = { maxTokens: 3000, adoptEpsilon: 1_000_000, presentation: previous };
  assert.ok(certifyCarriedLayout(inputs, forest, options));
  const mixed = new Map(cut.frontier); mixed.set('c6', 1); mixed.set('c7', 0);
  assert.ok(Number.isFinite(forest.tokensForFrontier(mixed)), 'legal levels alone admit this malformed cut');
  assert.equal(certifyCarriedLayout(inputs, forest, { ...options, presentation: presentation(forest, mixed) }), null);
  c.chunks[0].pinned = true;
  forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
  assert.equal(certifyCarriedLayout(inputs, forest, options), null);
  c.chunks[0].pinned = false;
  c.chunks[0].lockedByAgent = true; c.chunks[0].currentResolution = 1;
  forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
  assert.equal(certifyCarriedLayout(inputs, forest, options), null);
  c.chunks[0].lockedByAgent = false;
  const root = [...c.summaries.values()].find(s => s.level === 3)!;
  c.summaries.delete(root.id); c.recallPairTokens.delete(root.id);
  for (const summary of c.summaries.values()) if (summary.parentId === root.id) delete summary.parentId;
  forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
  assert.equal(certifyCarriedLayout(inputs, forest, options), null);
  c.chunks[0].pinLevel = 9;
  forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
  assert.ok(forest.constraintConflicts.length);
  assert.equal(certifyCarriedLayout(inputs, forest, options), null);
});
