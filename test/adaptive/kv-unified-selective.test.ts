import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonnegativeSumInterval, scoreBoundedCandidates, type BoundedPolicyCandidate } from '../../src/adaptive/kv-unified-selective.js';
import { ExactKvUnifiedPolicySolver, type ExactPolicySolveOptions, type UnscoredCandidate } from '../../src/adaptive/kv-unified-policy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';

const inputs: PickerInputs = { chunks: [{ id: 'x', sequence: 0, rawTokens: 100, currentResolution: 0,
  lockedByAgent: false, pinned: false }], summaries: new Map(), headTokens: 0, tailTokens: 0,
  headChunkIds: new Set(), tailChunkIds: new Set() };
const stats = { statesVisited: 0, candidatesGenerated: 0, maxCandidatesAtState: 0, terminalCandidates: 0 };

function row(index: number, fidelity: number, continuity = 0, cache = 0, matches = false): UnscoredCandidate {
  return { frontier: new Map([['x', index]]), layout: { units: [], totalTokens: 100 }, renderedTokens: 100,
    fidelityLoss: fidelity, continuityLoss: continuity, cacheChurn: cache, budgetPenalty: 0, matchesPresentation: matches };
}
function bounds(value: UnscoredCandidate, refined: Set<UnscoredCandidate>, slack = 1e-8): BoundedPolicyCandidate {
  return { renderedTokens: value.renderedTokens, budgetPenalty: value.budgetPenalty, cacheChurn: value.cacheChurn,
    fidelity: { lower: Math.max(0, value.fidelityLoss - slack), upper: value.fidelityLoss + slack },
    continuity: value.continuityLoss === 0 ? { lower: 0, upper: 0 } :
      { lower: Math.max(0, value.continuityLoss - slack), upper: value.continuityLoss + slack },
    matchesPresentation: value.matchesPresentation!, exact: () => { refined.add(value); return value; } };
}

test('selective scoring refines the winner and carried contender, preserving the complete lazy candidate API', () => {
  const values = Array.from({ length: 2000 }, (_, index) => row(index, index, 0, 0, index === 1));
  const refined = new Set<UnscoredCandidate>();
  const options = { maxTokens: 200, adoptEpsilon: 2, presentation: { currentSeq: 1, leaves: new Map() } };
  const result = scoreBoundedCandidates(values.map((value) => bounds(value, refined)), options, stats, false, ['x']);
  assert.equal(result.selected.frontier.get('x'), 1);
  assert.equal(refined.size, 2, 'losing candidates need no exact evaluation during selection');
  const reference = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(values, options, stats, false);
  assert.deepEqual(result.selected, reference.selected);
  assert.deepEqual(result.candidates, reference.candidates);
  assert.equal(refined.size, 2000, 'candidate-list inspection performs deferred exact work');
  assert.ok(result.candidates.includes(result.selected));
});

test('a welfare loser still establishes an exact normalization floor', () => {
  const values = [row(0, 10, 10, 5), row(1, 12, 4, 8), row(2, 10000, 2, 0)];
  const refined = new Set<UnscoredCandidate>();
  const candidates = values.map((value) => bounds(value, refined, 3));
  const options = { maxTokens: 200, policy: { continuityScale: 1, cacheScale: 1, continuityLambda: 1, cacheLambda: 1 } };
  const reference = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(values, options, stats, true);
  const result = scoreBoundedCandidates(candidates, options, stats, true, ['x']);
  assert.equal(result.continuityFloor, 2);
  assert.equal(result.cacheFloor, 0);
  assert.ok(refined.has(values[2]));
  assert.equal(result.selected.frontier.get('x'), 1);
  assert.equal(result.selected.score, 80);
  assert.deepEqual(result.selected, reference.selected);
});

test('overlapping bounds, exact ties, and the hysteresis boundary follow the original comparison rule', () => {
  const values = [row(2, 1), row(1, 1), row(0, 3, 0, 0, true)];
  for (const adoptEpsilon of [0, 2, 2 - Number.EPSILON, NaN]) {
    const options: ExactPolicySolveOptions = { maxTokens: 200, adoptEpsilon, presentation: { currentSeq: 1, leaves: new Map() } };
    const reference = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(values, options, stats, false);
    const result = scoreBoundedCandidates(values.map((value) => bounds(value, new Set(), 10)), options, stats, false, ['x']);
    assert.deepEqual(result.selected, reference.selected);
    if (adoptEpsilon === 0 || Number.isNaN(adoptEpsilon)) assert.equal(result.selected.frontier.get('x'), 1);
  }
});

test('positive-sum intervals cover differently grouped sums across binary64 magnitudes', () => {
  for (const scale of [Number.MIN_VALUE, 1e-250, 1, 1e100, 1e250]) {
    const terms = Array.from({ length: 2000 }, (_, index) => scale * (index % 13 + 1));
    const forward = terms.reduce((sum, value) => sum + value, 0);
    let grouped = 0;
    for (let i = terms.length; i > 0; i -= 17) grouped += terms.slice(Math.max(0, i - 17), i).reduce((sum, value) => sum + value, 0);
    const bound = nonnegativeSumInterval(grouped, terms.length);
    assert.ok(bound.lower <= forward && forward <= bound.upper, `scale ${scale}`);
  }
  assert.deepEqual(nonnegativeSumInterval(0, 100000), { lower: 0, upper: 0 });
});

test('non-finite score arithmetic uses the complete original sort instead of interval decisions', () => {
  const values = [row(0, 0, 1e308), row(1, 1), row(2, 2)];
  const options = { maxTokens: 200, continuityMultiplier: 0, policy: { continuityScale: 1 } };
  const refined = new Set<UnscoredCandidate>();
  const reference = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(values, options, stats, false);
  const result = scoreBoundedCandidates(values.map((value) => bounds(value, refined)), options, stats, false, ['x']);
  assert.equal(refined.size, values.length);
  assert.deepEqual(result.selected, reference.selected);
  assert.deepEqual(result.candidates, reference.candidates);
});
