/**
 * What a change of layout costs under kv-unified: the rewrite it causes,
 * priced linearly (`policy.rewriteLambda`), and a cost that is the same for
 * every change (`KvUnifiedOptions.changePenalty`, which the memory strategy
 * sets from the thinking a binding model would drop). Latent demand is
 * decided without either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExactKvUnifiedPolicySolver,
  KvUnifiedPolicyError,
  cacheCost,
  normalizePolicy,
  type AcceptedPresentationReference,
  type ExactPolicyCandidate,
  type ExactPolicySolveOptions,
} from '../../src/adaptive/kv-unified-policy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { ParetoKvUnifiedPolicySolver, type ParetoSolveOptions } from '../../src/adaptive/kv-unified-pareto.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { certifyCarriedLayout } from '../../src/adaptive/kv-unified-certificate.js';
import { KvUnifiedStrategy } from '../../src/adaptive/strategies/kv-unified.js';
import { buildChronicleWithChain, MockChronicle, seededPolicyFixture } from './harness.js';

const ENGINES = [
  { name: 'subtree', options: { engine: 'subtree' } },
  { name: 'packed', options: { engine: 'dag' } },
  { name: 'objects', options: { storage: 'objects' } },
  { name: 'leaf', options: { engine: 'leaf' } },
] as const satisfies readonly { name: string; options: Partial<ParetoSolveOptions> }[];

/** Four 90-token chunks, an L1 over each pair (55 tokens) and an L2 over both. */
function fixture(): PickerInputs {
  const chronicle = buildChronicleWithChain({ chunkCount: 4, tokensPerChunk: 90, mergeThreshold: 2, recallPairTokens: 55 });
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

function rawPresentation(inputs: PickerInputs): AcceptedPresentationReference {
  return {
    currentSeq: 0,
    leaves: new Map(inputs.chunks.map((chunk) => [chunk.id, { repHash: `raw:${chunk.id}`, level: 0, lastChangedSeq: 0 }])),
  };
}

/** The receipt of the all-raw layout, with a breakpoint after the second
 * chunk and one at the end. */
function rawReceipt(inputs: PickerInputs): Pick<ExactPolicySolveOptions, 'presentation' | 'cache' | 'currentImmutablePrefixHash'> {
  return {
    presentation: rawPresentation(inputs),
    cache: {
      immutablePrefixHash: 'head-1',
      layout: renderLayout(inputs, new SummaryTree(inputs), new Map()),
      markers: [{ unitIndex: 2, offset: 180 }, { unitIndex: 4, offset: 360 }],
    },
    currentImmutablePrefixHash: 'head-1',
  };
}

const foldedAtL1 = (candidate: ExactPolicyCandidate): string[] =>
  [...candidate.frontier].filter(([, level]) => level === 1).map(([id]) => id).sort();
const isRaw = (candidate: ExactPolicyCandidate): boolean => [...candidate.frontier].every(([, level]) => level === 0);

const OLD = ['c-0000', 'c-0001'];
const RECENT = ['c-0002', 'c-0003'];
/** Prices that make the churn easy to read: 1.15 per token rewritten. */
const PRICES = { cacheReadPrice: 0.1, cacheWritePrice: 1.25, cacheScale: 100 };

test('rewriteLambda is 0 unless set, must be finite and non-negative, and prices churn linearly from zero', () => {
  assert.equal(normalizePolicy(undefined).rewriteLambda, 0);
  assert.equal(normalizePolicy({ rewriteLambda: 7 }).rewriteLambda, 7);
  for (const bad of [-1, Number.NaN, Infinity]) {
    assert.throws(() => normalizePolicy({ rewriteLambda: bad }), KvUnifiedPolicyError);
  }
  const linear = normalizePolicy({ rewriteLambda: 10, cacheScale: 100, cacheLambda: 5 });
  assert.equal(cacheCost(300, 0, linear), 30);
  assert.equal(cacheCost(300, 250, linear), 30, 'the floor decides nothing in a linear term');
  assert.equal(cacheCost(0, 0, linear), 0);
  const quadratic = normalizePolicy({ rewriteLambda: 0, cacheScale: 100, cacheLambda: 5 });
  assert.equal(cacheCost(300, 100, quadratic), 5 * 2 ** 2, 'without it, the quadratic term above the floor');
});

test('with the rewrite priced linearly, a forced change keeps the breakpoint it can, unless old history is worth the rewrite', () => {
  const inputs = fixture();
  // The wall forces one pair to fold. Older chunks lose less fidelity
  // (alpha), so the fold of the old pair is the better layout taken alone:
  // 75.8 against 145.4. It rewrites the whole request (270.25 of churn);
  // folding the recent pair keeps the first breakpoint (63.25).
  const base = {
    maxTokens: 250, ...rawReceipt(inputs),
    policy: { alpha: 0.7, budgetUnderLambda: 0, budgetOverLambda: 0, cacheLambda: 0, continuityLambda: 0, ...PRICES },
  } satisfies ExactPolicySolveOptions;
  const solve = (rewriteLambda: number, engine?: Partial<ParetoSolveOptions>) => {
    const options = { ...base, policy: { ...base.policy, rewriteLambda } };
    const result = engine
      ? new ParetoKvUnifiedPolicySolver(inputs).solve({ ...options, ...engine })
      : new ExactKvUnifiedPolicySolver(inputs).solve(options);
    assert.ok(result.feasible);
    return result;
  };
  for (const engine of [undefined, ...ENGINES.map((e) => e.options)]) {
    const label = JSON.stringify(engine ?? 'exact');
    assert.deepEqual(foldedAtL1(solve(0, engine).selected), OLD, `${label}: unpriced, the better layout wins`);
    const priced = solve(100, engine);
    assert.deepEqual(foldedAtL1(priced.selected), RECENT, `${label}: priced, the change that keeps the breakpoint wins`);
    const old = priced.candidates.find((candidate) => foldedAtL1(candidate).join() === OLD.join() && candidate.renderedTokens === 235)!;
    assert.ok(Math.abs(old.cacheChurn - 270.25) < 1e-9 && Math.abs(priced.selected.cacheChurn - 63.25) < 1e-9, label);
    assert.ok(Math.abs(priced.selected.score - (priced.selected.fidelityLoss + 63.25)) < 1e-9, `${label}: churn × 100 / 100`);
    assert.deepEqual(foldedAtL1(solve(10, engine).selected), OLD,
      `${label}: at a tenth of the price the old pair's fidelity is worth its rewrite`);
  }
});

test('with the rewrite priced linearly, the carried layout is kept until a change is worth its whole rewrite', () => {
  const inputs = fixture();
  // Nothing is forced: raw (360) fits under the wall and pays 360 for being
  // over the comfort band. With no tolerance at all, the carried layout
  // competes on its score alone.
  const base = {
    maxTokens: 400, adoptEpsilon: 0, ...rawReceipt(inputs),
    policy: {
      alpha: 0.7, budgetHighRatio: 0.75, budgetUnderLambda: 0, budgetOverLambda: 1_000,
      cacheLambda: 0, continuityLambda: 0, ...PRICES,
    },
  } satisfies ExactPolicySolveOptions;
  for (const engine of [undefined, ...ENGINES.map((e) => e.options)]) {
    const label = JSON.stringify(engine ?? 'exact');
    const solve = (rewriteLambda: number) => {
      const options = { ...base, policy: { ...base.policy, rewriteLambda } };
      const result = engine
        ? new ParetoKvUnifiedPolicySolver(inputs).solve({ ...options, ...engine })
        : new ExactKvUnifiedPolicySolver(inputs).solve(options);
      assert.ok(result.feasible);
      return result.selected;
    };
    assert.deepEqual(foldedAtL1(solve(0)), OLD, `${label}: unpriced, any gain moves the layout`);
    assert.deepEqual(foldedAtL1(solve(100)), RECENT, `${label}: 145.4 + 63.25 beats staying at 360`);
    assert.ok(isRaw(solve(400)), `${label}: 145.4 + 253 doesn't`);
    assert.equal(solve(400).cacheChurn, 0, label);
  }
});

test('the engines select alike with the rewrite priced linearly, and as the exhaustive oracle does', () => {
  let compared = 0;
  let warm = 0;
  let oracles = 0;
  for (let seed = 1; seed <= 240; seed++) {
    // Every third forest has head and tail chunks. There the exhaustive
    // oracle prices the tail as one unit where the engines price it per
    // message, and the leaf engine keeps fewer cuts, as both do without the
    // option; the object engine is the reference, as in the engines' own
    // agreement tests.
    const external = seed % 3 === 0;
    const { inputs, forest, options } = seededPolicyFixture(seed, external);
    const priced = {
      ...options, tokenBucketSize: 0, continuityBucketSize: 0, fidelityBucketSize: 0,
      policy: { ...options.policy, rewriteLambda: 20 + (seed % 9) * 60 },
    };
    const reference = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...priced, storage: 'objects' });
    if (!reference.feasible) continue;
    if (reference.cacheRelevant) warm++;
    if (!external) {
      const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(priced);
      assert.ok(oracle.feasible);
      assert.equal(reference.selected.score, oracle.selected.score, `seed ${seed}: the oracle's score`);
      assert.deepEqual(reference.selected.frontier, oracle.selected.frontier, `seed ${seed}: the oracle's frontier`);
      oracles++;
    }
    for (const engine of ENGINES) {
      if (external && engine.name === 'leaf') continue;
      const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...priced, ...engine.options, reuse: {} });
      assert.ok(result.feasible, `seed ${seed} ${engine.name}`);
      assert.equal(result.selected.score, reference.selected.score, `seed ${seed} ${engine.name}: score`);
      assert.deepEqual(result.selected.frontier, reference.selected.frontier, `seed ${seed} ${engine.name}: frontier`);
    }
    compared++;
  }
  assert.ok(compared > 200 && warm > 100 && oracles > 100,
    `${compared} forests compared, ${warm} with a receipt that applies, ${oracles} against the oracle`);
});

/** The certificate fixture: two L1 pairs under an L2, and a tail chunk the
 * receipt already held. */
function tailFixture(): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 });
  const a = chronicle.produceL1(['c0', 'c1']);
  const b = chronicle.produceL1(['c2', 'c3']);
  chronicle.produceUpper(2, [a.id, b.id]);
  chronicle.addChunk({ id: 't0', rawTokens: 70 });
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 70, headChunkIds: new Set(), tailChunkIds: new Set(['t0']),
  };
}

function presentationOf(forest: CanonicalSummaryForest, frontier: ReadonlyMap<string, number>): AcceptedPresentationReference {
  return {
    currentSeq: 3,
    leaves: new Map(forest.orderedLeaves().map((leaf) => {
      const level = frontier.get(leaf.id) ?? 0;
      const id = leaf.summaryIds.find((summaryId) => forest.summary(summaryId)!.level === level);
      return [leaf.id, { level, repHash: level === 0 ? `raw:${leaf.id}` : `summary:${id}`, lastChangedSeq: 1 }];
    })),
  };
}

test('the certificate counts the least rewrite a change pays, and still selects as the oracle does', () => {
  let seed = 0x7e_57_c0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let certified = 0;
  let onlyWithFloor = 0;
  let declined = 0;
  for (let run = 0; run < 120; run++) {
    const inputs = tailFixture();
    for (const chunk of inputs.chunks) {
      chunk.rawTokens = 20 + Math.floor(random() * 150);
      chunk.salience = random();
    }
    (inputs as { tailTokens: number }).tailTokens = inputs.chunks.find((chunk) => chunk.id === 't0')!.rawTokens;
    for (const id of inputs.summaries.keys()) {
      (inputs.recallPairTokens as Map<string, number>).set(id, 15 + Math.floor(random() * 150));
    }
    const forest = new CanonicalSummaryForest(inputs);
    for (const cut of forest.enumerateExactCuts().candidates) {
      const layout = renderLayout(inputs, new SummaryTree(inputs), cut.frontier);
      const options = {
        maxTokens: cut.renderedTokens + Math.floor(random() * 200),
        presentation: presentationOf(forest, cut.frontier),
        cache: { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
        currentImmutablePrefixHash: 'same',
        adoptEpsilon: 5 + random() * 60,
        policy: {
          alpha: random(), budgetLowRatio: random() * 0.6, budgetHighRatio: 0.6 + random() * 0.4,
          budgetUnderLambda: random() * 3000, budgetOverLambda: random() * 3000,
          continuityLambda: random() * 1000, continuityScale: 100,
          cacheScale: 100, rewriteLambda: 20 + random() * 200,
        },
      } satisfies ExactPolicySolveOptions;
      const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
      assert.ok(oracle.feasible);
      const result = certifyCarriedLayout(inputs, forest, options);
      if (!result) { declined++; continue; }
      certified++;
      assert.deepEqual(result.selected.frontier, oracle.selected.frontier, `run ${run}`);
      assert.equal(result.selected.score, oracle.selected.score, `run ${run}`);
      const floor = result.certificate.rewriteFloor ?? 0;
      const tail = inputs.chunks.find((chunk) => chunk.id === 't0')!.rawTokens;
      assert.ok(Math.abs(floor - options.policy.rewriteLambda * tail * 1.15 / 100) < 1e-6, `run ${run}: the old tail, priced`);
      // No cut outside the carried family scores under the bound and the floor.
      for (const candidate of oracle.candidates) {
        if (candidate.cacheChurn === 0) continue;
        assert.ok(candidate.score >= result.certificate.lowerBound + floor - 1e-6, `run ${run}: a change under the floor`);
      }
      if (result.certificate.maxImprovement > options.adoptEpsilon) {
        onlyWithFloor++;
        assert.equal(certifyCarriedLayout(inputs, forest, { ...options, policy: { ...options.policy, rewriteLambda: 0 } })?.certificate.rewriteFloor,
          undefined, 'unpriced, no floor is reported');
      }
    }
  }
  assert.ok(certified > 100, `only ${certified} certificates`);
  assert.ok(onlyWithFloor > 10, `only ${onlyWithFloor} proofs needed the floor`);
  assert.ok(declined > 0, 'unsuccessful proofs are exercised too');
});

test('a receipt that does not apply gives the certificate no rewrite floor', () => {
  const inputs = tailFixture();
  const forest = new CanonicalSummaryForest(inputs);
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  const options = {
    maxTokens: 1_000, presentation: presentationOf(forest, new Map()), adoptEpsilon: 50,
    cache: { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    policy: { budgetUnderLambda: 0, cacheScale: 100, rewriteLambda: 100 },
  } satisfies ExactPolicySolveOptions;
  assert.ok((certifyCarriedLayout(inputs, forest, { ...options, currentImmutablePrefixHash: 'same' })?.certificate.rewriteFloor ?? 0) > 0);
  assert.equal(certifyCarriedLayout(inputs, forest, { ...options, currentImmutablePrefixHash: 'changed' })?.certificate.rewriteFloor, undefined);
});

const BUDGET = { totalBudget: 400, targetBudget: 360, slack: 0.1 };

test('a change penalty keeps the carried layout that the tolerance alone would give up, with or without the certificate', () => {
  const inputs = fixture();
  const base = {
    adoptEpsilon: 10, ...rawReceipt(inputs),
    policy: {
      alpha: 0.7, budgetHighRatio: 0.75, budgetUnderLambda: 0, budgetOverLambda: 1_000,
      cacheLambda: 0, continuityLambda: 0, ...PRICES,
    },
  };
  for (const hysteresisCertificate of [false, true]) {
    const moved = new KvUnifiedStrategy({ ...base, hysteresisCertificate });
    const levels = (strategy: KvUnifiedStrategy) => [...strategy.solve(inputs, BUDGET).frontier].filter(([, level]) => level > 0).map(([id]) => id).sort();
    assert.deepEqual(levels(moved), OLD, 'staying costs 360, the old fold 75.8: more than 10 better');
    // 360 - 75.8 = 284.2: a penalty under that still moves, one over it holds.
    assert.deepEqual(levels(new KvUnifiedStrategy({ ...base, hysteresisCertificate, changePenalty: 270 })), OLD);
    assert.deepEqual(levels(new KvUnifiedStrategy({ ...base, hysteresisCertificate, changePenalty: 280 })), []);
    // Well over it, the certificate proves the choice without a search (its
    // bound is on a relaxation, so it needs more room than the exact gap).
    const held = new KvUnifiedStrategy({ ...base, hysteresisCertificate, changePenalty: 1_000 });
    assert.deepEqual(levels(held), []);
    assert.equal(Boolean(held.lastResult?.feasible && held.lastResult.certificate), hysteresisCertificate);
    for (const ignored of [0, -5, Number.NaN, Infinity]) {
      assert.deepEqual(levels(new KvUnifiedStrategy({ ...base, hysteresisCertificate, changePenalty: ignored })), OLD, String(ignored));
    }
  }
});

test('latent demand is decided without what a change costs', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  for (let index = 0; index < 4; index++) {
    const id = `latent-${index}`;
    chronicle.addChunk({ id, rawTokens: 100 });
    chronicle.produceL1([id]);
  }
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  // The receipt is of every chunk under its own L1: the layout the wall
  // allows without a merge. A merge would be the better layout.
  const frontier = new Map(inputs.chunks.map((chunk) => [chunk.id, 1]));
  const forest = new CanonicalSummaryForest(inputs);
  const layout = renderLayout(inputs, new SummaryTree(inputs), frontier);
  const base = {
    policy: {
      alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000,
      cacheLambda: 0, continuityLambda: 0, ...PRICES,
    },
    tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000,
    adoptEpsilon: 1,
    presentation: presentationOf(forest, frontier),
    cache: { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'same',
  };
  const budget = { totalBudget: 300, targetBudget: 270, slack: 0.1 };
  for (const mode of ['individual', 'joint'] as const) {
    for (const hysteresisCertificate of [false, true]) {
      const latentDemand = { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4, mode };
      const plain = new KvUnifiedStrategy({ ...base, hysteresisCertificate, latentDemand });
      const plainSolution = plain.solve(inputs, budget);
      assert.ok(plainSolution.produced.length > 0 && plainSolution.produced.every((request) => request.level === 2),
        `${mode}: a merge is worth producing`);
      // Priced so that no change is worth making now: the rewrite alone
      // outweighs any gain, and the penalty does again.
      const priced = new KvUnifiedStrategy({
        ...base, hysteresisCertificate, latentDemand,
        policy: { ...base.policy, rewriteLambda: 1_000_000 }, changePenalty: 1_000_000,
      });
      const pricedSolution = priced.solve(inputs, budget);
      assert.deepEqual([...pricedSolution.frontier], [...frontier], `${mode}: the carried layout stays`);
      assert.deepEqual(pricedSolution.produced, plainSolution.produced, `${mode}: and the same merges are demanded`);
      assert.deepEqual(priced.lastDemandEvaluations, plain.lastDemandEvaluations, mode);
    }
  }
});
