import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ExactKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-policy.js';
import { TerminalPolicyEvaluator, type FrontierTrace } from '../../src/adaptive/kv-unified-terminal.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

// Four leaves under two L1s.
function fixture(): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 });
  chronicle.produceL1(['c0', 'c1']);
  chronicle.produceL1(['c2', 'c3']);
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

function traceFor(frontier: ReadonlyMap<string, number>): FrontierTrace | null {
  let trace: FrontierTrace | null = null;
  for (const [id, level] of frontier) trace = { parent: trace, ids: [id], level };
  return trace;
}

const options = { maxTokens: 1000, policy: { alpha: 0.7 } };

test('a chunk replaced inside the same inputs object after the build is not builtFrom, and scoring sees it', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  assert.equal(forest.builtFrom(inputs), true);
  inputs.chunks[0] = { ...inputs.chunks[0], salience: 0.2 };
  assert.equal(forest.builtFrom(inputs), false);
  const enumeration = forest.enumerateExactCuts();
  const folded = enumeration.candidates.find((c) => [...c.frontier.values()].every((level) => level === 1))!;
  const stale = new ExactKvUnifiedPolicySolver(inputs, forest).scoreCandidates([folded], options, enumeration.stats);
  const fresh = new ExactKvUnifiedPolicySolver(inputs, new CanonicalSummaryForest(inputs)).scoreCandidates([folded], options, enumeration.stats);
  assert.ok(stale.feasible && fresh.feasible);
  assert.equal(stale.selected.fidelityLoss, fresh.selected.fidelityLoss);
  const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
  assert.equal(evaluator.candidate(traceFor(folded.frontier), folded.renderedTokens).fidelityLoss, fresh.selected.fidelityLoss);
});

test('a different inputs object with the same chunks takes the sorting path and matches the oracle', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const other: PickerInputs = { ...inputs };
  assert.equal(forest.builtFrom(other), false);
  const enumeration = forest.enumerateExactCuts();
  const evaluator = new TerminalPolicyEvaluator(other, forest, options);
  const oracle = new ExactKvUnifiedPolicySolver(other, forest);
  for (const candidate of enumeration.candidates) {
    const exact = oracle.scoreCandidates([candidate], options, enumeration.stats);
    assert.ok(exact.feasible);
    const prepared = evaluator.candidate(traceFor(candidate.frontier), candidate.renderedTokens);
    assert.equal(prepared.fidelityLoss, exact.selected.fidelityLoss);
  }
});

test('a levels vector prices like the frontier map and must cover every leaf', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const enumeration = forest.enumerateExactCuts();
  const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
  const leaves = forest.orderedLeaves();
  for (const candidate of enumeration.candidates) {
    const levels = Uint32Array.from(leaves, (leaf) => candidate.frontier.get(leaf.id) ?? 0);
    assert.equal(forest.tokensForLevels(levels), forest.tokensForFrontier(candidate.frontier));
    const byTrace = evaluator.candidate(traceFor(candidate.frontier), candidate.renderedTokens);
    const byLevels = evaluator.candidate({ levels }, candidate.renderedTokens);
    assert.equal(byLevels.fidelityLoss, byTrace.fidelityLoss);
    assert.deepEqual(byLevels.frontier, byTrace.frontier);
  }
  assert.throws(() => evaluator.candidate({ levels: new Uint32Array(2) }, 0), /levels vector has 2 entries for 4 leaves/);
});
