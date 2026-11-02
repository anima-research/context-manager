import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExactKvUnifiedPolicySolver,
  type AcceptedPresentationReference,
  type ExactPolicyCandidate,
} from '../../src/adaptive/kv-unified-policy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { KvUnifiedStrategy } from '../../src/adaptive/strategies/kv-unified.js';
import { MockChronicle } from './harness.js';

function inputsOf(chronicle: MockChronicle): PickerInputs {
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

const levels = (frontier: ReadonlyMap<string, number>): string =>
  [...frontier].sort(([a], [b]) => a.localeCompare(b)).map(([id, level]) => `${id}:${level}`).join(' ');

function find(candidates: readonly ExactPolicyCandidate[], cut: string): ExactPolicyCandidate {
  const found = candidates.find((candidate) => levels(candidate.frontier) === cut);
  assert.ok(found, `premise: ${cut} is a candidate`);
  return found;
}

/** c0..c5 at 100 raw tokens each, one L1 per pair at 30 tokens, and a warm
 * cache of the raw layout: a marker after every message. */
function cachedSix() {
  const chronicle = new MockChronicle({ recallPairTokens: 30 });
  for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
  const l1s = [0, 2, 4].map((i) => chronicle.produceL1([`c${i}`, `c${i + 1}`]));
  const inputs = inputsOf(chronicle);
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  let offset = 0;
  const markers = layout.units.map((unit, index) => ({ unitIndex: index + 1, offset: (offset += unit.tokens) }));
  return { inputs, l1s, cache: { immutablePrefixHash: 'tools-v1', layout, markers }, currentImmutablePrefixHash: 'tools-v1' };
}

test('of two cuts with the same score, the one with fewer tokens comes first', () => {
  // a and b are the same size, and alpha 0 takes their ages out of fidelity,
  // so folding either costs the same; each fold lands inside the budget band.
  // a's summary is 10 tokens and b's 40.
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a']);
  chronicle.recallPairTokens.set(chronicle.produceL1(['b']).id, 40);
  const result = new ExactKvUnifiedPolicySolver(inputsOf(chronicle)).solve({
    maxTokens: 300,
    policy: { alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 9000, cacheLambda: 0, continuityLambda: 0 },
  });
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  const foldA = find(result.candidates, 'a:1 b:0');
  const foldB = find(result.candidates, 'a:0 b:1');
  assert.equal(foldA.score, foldB.score, 'premise: the two folds tie');
  assert.ok(foldA.renderedTokens < foldB.renderedTokens, 'premise: folding a renders fewer tokens');
  assert.ok(result.candidates.every((candidate) => candidate.score >= foldA.score), 'premise: the two folds are the best score');
  assert.equal(levels(result.selected.frontier), 'a:1 b:0');
});

test('the continuity multiplier scales the continuity term and leaves the cache term whole', () => {
  // c4 and c5 were accepted folded: that cut costs cache and no continuity,
  // and the raw cut costs continuity and no cache.
  const { inputs, l1s, cache, currentImmutablePrefixHash } = cachedSix();
  const presentation: AcceptedPresentationReference = {
    currentSeq: 1,
    leaves: new Map(inputs.chunks.map((chunk) => [chunk.id, chunk.id === 'c4' || chunk.id === 'c5'
      ? { level: 1, repHash: `summary:${l1s[2].id}`, lastChangedSeq: 1 }
      : { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 1 }] as const)),
  };
  const solve = (continuityMultiplier: number, cacheLambda = 1) => {
    const result = new ExactKvUnifiedPolicySolver(inputs).solve({
      maxTokens: 1000, presentation, cache, currentImmutablePrefixHash, continuityMultiplier,
      policy: { alpha: 0, budgetLowRatio: 0, budgetHighRatio: 1, budgetUnderLambda: 0, budgetOverLambda: 0, cacheLambda, cacheScale: 10, continuityLambda: 1, continuityScale: 100 },
    });
    assert.equal(result.feasible, true);
    if (!result.feasible) throw new Error('infeasible');
    return { held: find(result.candidates, 'c0:0 c1:0 c2:0 c3:0 c4:1 c5:1'), raw: find(result.candidates, 'c0:0 c1:0 c2:0 c3:0 c4:0 c5:0') };
  };
  const whole = solve(1);
  const half = solve(0.5);
  assert.ok(whole.held.cacheChurn > 0 && whole.held.continuityLoss === 0, 'premise: the accepted cut costs only cache');
  assert.ok(whole.raw.continuityLoss > 0 && whole.raw.cacheChurn === 0, 'premise: the raw cut costs only continuity');
  assert.ok(whole.held.score > solve(1, 0).held.score, 'premise: the cache term counts in the accepted cut\'s score');
  assert.ok(whole.raw.score > 0, 'premise: the continuity term counts in the raw cut\'s score');
  assert.equal(half.held.score, whole.held.score, 'the cache term is whole under a multiplier of 0.5');
  assert.ok(Math.abs(half.raw.score - whole.raw.score / 2) < 1e-9, `the continuity term halves: ${whole.raw.score} to ${half.raw.score}`);
});

test('under-fill is measured against the low target, not the wall', () => {
  // One message, accepted folded at 10 tokens under a wall of 1000 and a low
  // target of 500. Refilling costs continuity (300); staying folded costs
  // fidelity (100) and the larger under-fill, which only measuring against the
  // low target makes worth the continuity.
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  const l1 = chronicle.produceL1(['a']);
  const result = new ExactKvUnifiedPolicySolver(inputsOf(chronicle)).solve({
    maxTokens: 1000, adoptEpsilon: 0,
    presentation: { currentSeq: 1, leaves: new Map([['a', { level: 1, repHash: `summary:${l1.id}`, lastChangedSeq: 1 }]]) },
    policy: { alpha: 0, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 1000, budgetOverLambda: 0, cacheLambda: 0, continuityLambda: 300, continuityScale: 100 },
  });
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(levels(result.selected.frontier), 'a:0');
});

test('a changed representation at the same level costs continuity', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  const l1 = chronicle.produceL1(['a']);
  chronicle.produceL1(['b']);
  const inputs = inputsOf(chronicle);
  const foldedA = (repHash: string) => {
    const result = new ExactKvUnifiedPolicySolver(inputs).solve({
      maxTokens: 1000,
      presentation: { currentSeq: 1, leaves: new Map([['a', { level: 1, repHash, lastChangedSeq: 1 }], ['b', { level: 0, repHash: 'raw:b', lastChangedSeq: 1 }]]) },
      policy: { alpha: 0, budgetLowRatio: 0, budgetHighRatio: 1, budgetUnderLambda: 0, budgetOverLambda: 0, cacheLambda: 0, continuityLambda: 1, continuityScale: 100 },
    });
    assert.equal(result.feasible, true);
    if (!result.feasible) throw new Error('infeasible');
    return find(result.candidates, 'a:1 b:0');
  };
  assert.equal(foldedA(`summary:${l1.id}`).continuityLoss, 0, 'the same representation costs nothing');
  assert.ok(foldedA('summary:rewritten').continuityLoss > 0);
  const chosen = (repHash: string) => Object.fromEntries((['default', 'dag'] as const).map((engine) => [engine, levels(new Map(new KvUnifiedStrategy({
    tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
    ...(engine === 'dag' ? { engine } : {}),
    presentation: { currentSeq: 1, leaves: new Map([['a', { level: 1, repHash, lastChangedSeq: 1 }], ['b', { level: 0, repHash: 'raw:b', lastChangedSeq: 1 }]]) },
    policy: { alpha: 0, budgetLowRatio: 0, budgetHighRatio: 1, budgetUnderLambda: 0, budgetOverLambda: 0, cacheLambda: 0, continuityLambda: 1e6, continuityScale: 100 },
  }).solve(inputs, { totalBudget: 1000, targetBudget: 1000, slack: 0 }).frontier))]));
  assert.deepEqual(chosen(`summary:${l1.id}`), { default: 'a:1 b:0', dag: 'a:1 b:0' }, 'premise: on each engine the presented representation is held');
  assert.deepEqual(chosen('summary:rewritten'), { default: 'a:0 b:0', dag: 'a:0 b:0' }, 'on each engine a stale representation costs what unfolding does, so fidelity decides');
});

test('the cache term charges only the cache loss above the frame floor', () => {
  // A forced shed: the wall (450) is below the raw layout (600), so every cut
  // breaks the cache somewhere and the pool's cache floor is above zero. With
  // fidelity weighted by age, folding c2 and c3 costs less fidelity than folding
  // c4 and c5 but more cache; charged above the floor, its cache costs less than
  // the fidelity it saves. Charged whole, the floor would weigh against it too.
  const { inputs, cache, currentImmutablePrefixHash } = cachedSix();
  const result = new ExactKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 450, cache, currentImmutablePrefixHash,
    policy: { alpha: 1, budgetLowRatio: 0, budgetHighRatio: 1, budgetUnderLambda: 0, budgetOverLambda: 0, cacheLambda: 15, cacheScale: 100, continuityLambda: 0 },
  });
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.ok(result.cacheFloor > 0, `premise: the cache floor is above zero (${result.cacheFloor})`);
  assert.equal(levels(result.selected.frontier), 'c0:0 c1:0 c2:1 c3:1 c4:0 c5:0');
});
