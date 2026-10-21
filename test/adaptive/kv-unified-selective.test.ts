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

test('bestUnder breaks a tie in the caller\'s frame on tokens then signature, not on the pool-frame score', () => {
  // A = (fidelity 300, continuity 10, 100 tokens), B = (0, 20, 200 tokens),
  // continuity lambda and scale 1. The pool's continuity floor is 10, so in
  // the pool's frame B scores 100 to A's 300; under a caller's floor of 0
  // both score 400, and the tie goes to A, the smaller cut, as the
  // selection would break it.
  const a: UnscoredCandidate = { ...row(0, 300, 10), renderedTokens: 100 };
  const b: UnscoredCandidate = { ...row(1, 0, 20), renderedTokens: 200 };
  const options: ExactPolicySolveOptions = { maxTokens: 400, policy: { continuityScale: 1, continuityLambda: 1, cacheLambda: 0 } };
  for (const order of [[a, b], [b, a]]) {
    const result = scoreBoundedCandidates(order.map((value) => bounds(value, new Set())), options, stats, false, ['x']);
    assert.equal(result.continuityFloor, 10);
    assert.equal(result.selected, result.candidates.find((c) => c.renderedTokens === 200), 'premise: B wins in the pool frame');
    assert.ok(result.bestUnder, 'the hooks are present');
    assert.equal(result.bestScoreUnder(0, 0), 400);
    assert.equal(result.bestUnder(0, 0).renderedTokens, 100, 'the tie goes to the smaller cut');
    const reference = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(order, options, stats, false);
    assert.equal(reference.bestUnder!(0, 0).renderedTokens, 100, 'the exact scorer agrees');
    assert.equal(reference.bestScoreUnder!(0, 0), 400);
  }
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

test('a candidate whose lower bound equals the best upper bound is still evaluated', () => {
  // Zero-width bounds: both tie on score, and the signature order must pick x=0
  // even though x=1 comes first in source order.
  const values = [row(1, 1), row(0, 1)];
  const options: ExactPolicySolveOptions = { maxTokens: 200 };
  const reference = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(values, options, stats, false);
  const result = scoreBoundedCandidates(values.map((value) => bounds(value, new Set(), 0)), options, stats, false, ['x']);
  assert.equal(result.selected.frontier.get('x'), 0);
  assert.deepEqual(result.selected, reference.selected);
});

test('exact scoring takes more candidates than a call takes as spread arguments', () => {
  // A full terminal evaluation scores every terminal label, which only the
  // label ceiling bounds: the forest from #231's regression test (52 L1 pairs
  // under an L2 with a pinned hole, no buckets) leaves 205,320 of them. A call
  // takes about 125,000 spread arguments on node 22 and 24, so the scorer's
  // floors are taken in a loop (#255).
  // Each floor is unique, non-zero and away from the first candidate, so a
  // floor that never moved from its start, or read another field, fails.
  const values = Array.from({ length: 200_000 }, (_, index) => row(index, index, 200_000 - index, Math.abs(index - 123_456) + 3));
  // A failure of this premise means the runtime takes more spread arguments,
  // as with a larger stack (`node --stack-size`) or a newer V8, not that the
  // scorer changed: raise the count until the old spread throws again.
  assert.throws(() => Math.min(...values.map((value) => value.continuityLoss)), RangeError,
    'premise: this runtime takes fewer spread arguments than there are candidates');
  const result = new ExactKvUnifiedPolicySolver(inputs).scorePreparedCandidates(values, { maxTokens: 200 }, stats, true);
  assert.equal(result.candidates.length, 200_000);
  assert.equal(result.continuityFloor, 1);
  assert.equal(result.cacheFloor, 3);
});
