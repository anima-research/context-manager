import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import { ParetoKvUnifiedPolicySolver, type ParetoSolveOptions } from '../../src/adaptive/kv-unified-pareto.js';
import { normalizePolicy, policyScore, withBestScoreUnder, type ExactPolicyCandidate } from '../../src/adaptive/kv-unified-policy.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { KvUnifiedStrategy, type KvUnifiedReuse } from '../../src/adaptive/strategies/kv-unified.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { MockChronicle } from './harness.js';

const POLICY = { alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10, cacheLambda: 0, continuityLambda: 0 };
const GRID = { tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10 };

function inputsOf(chronicle: MockChronicle): PickerInputs {
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

test('over the wall, L1s are asked for around a raw-pinned and a locked message, never for them', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  chronicle.addChunk({ id: 'c0', rawTokens: 100 });
  chronicle.addChunk({ id: 'c1', rawTokens: 100, pinned: true });
  chronicle.addChunk({ id: 'c2', rawTokens: 100, lockedByAgent: true });
  chronicle.addChunk({ id: 'c3', rawTokens: 100 });
  const solution = new KvUnifiedStrategy({ policy: POLICY, ...GRID, labelCeiling: 10_000 })
    .solve(inputsOf(chronicle), { totalBudget: 200, targetBudget: 180, slack: 0.1 });
  assert.equal(solution.exhausted, true, 'premise: no cut fits the wall');
  assert.deepEqual(solution.produced.map((request) => [request.level, request.range.firstChunkId, request.range.lastChunkId]), [
    [1, 'c0', 'c0'],
    [1, 'c3', 'c3'],
  ]);
});

// Latent demand: merges the strategy could ask for, each measured by a what-if
// solve. The evaluations say which merges were measured and at what cost.
const WIDE = { totalBudget: 4000, targetBudget: 3600, slack: 0.1 };

/** x0..x3 under two L1s and one existing L2 (its recall cost `existingL2`),
 * then y0..y3, each under its own L1 with the recall costs given: the L2
 * merges of neighbouring y-L1s are the candidates. */
function latentFixture(yRecall: readonly number[], existingL2: number): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `x${i}`, rawTokens: 100 });
  const a = chronicle.produceL1(['x0', 'x1']);
  const b = chronicle.produceL1(['x2', 'x3']);
  const upper = chronicle.produceUpper(2, [a.id, b.id]);
  chronicle.recallPairTokens.set(upper.id, existingL2);
  yRecall.forEach((recall, i) => {
    chronicle.addChunk({ id: `y${i}`, rawTokens: 120 });
    chronicle.recallPairTokens.set(chronicle.produceL1([`y${i}`]).id, recall);
  });
  return inputsOf(chronicle);
}

function demand(inputs: PickerInputs, latent: { mergeThreshold?: number; maxCandidates?: number } = {}) {
  const strategy = new KvUnifiedStrategy({
    policy: POLICY, ...GRID, labelCeiling: 10_000,
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 8, mode: 'individual', ...latent },
  });
  strategy.solve(inputs, WIDE);
  return strategy.lastDemandEvaluations.map((evaluation) => ({
    first: evaluation.request.range.firstChunkId,
    last: evaluation.request.range.lastChunkId,
    sources: evaluation.sourceIds.length,
    expected: evaluation.expectedRecallTokens,
  }));
}

test('a merge threshold below 2 is taken as 2, so no merge has a single source', () => {
  const evaluations = demand(latentFixture([100, 100, 100, 100], 33), { mergeThreshold: 1 });
  assert.ok(evaluations.length > 0, 'premise: merges were measured');
  assert.deepEqual(evaluations.map((evaluation) => evaluation.sources), evaluations.map(() => 2));
});

test("a merge's expected recall cost is read from the level's recall costs, not its summaries' own sizes", () => {
  const evaluations = demand(latentFixture([100, 100, 100, 100], 33));
  assert.ok(evaluations.length > 0, 'premise: merges were measured');
  // The one existing L2's summary is 60 tokens; its recall pair costs 33.
  for (const evaluation of evaluations) assert.equal(evaluation.expected, 33);
});

test('the merges that would save the most are the ones measured first', () => {
  const evaluations = demand(latentFixture([40, 40, 100, 100], 33), { maxCandidates: 1 });
  assert.deepEqual(evaluations.map((evaluation) => [evaluation.first, evaluation.last]), [['y2', 'y3']]);
});

/** Four existing L2s, x0..x3's, recalled at 10, 10, 500 and 500: a new L2's
 * expected recall cost is 10 and its conservative one 500. */
function fourL2s(): MockChronicle {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  [10, 10, 500, 500].forEach((cost, n) => {
    const ids = [0, 1, 2, 3].map((i) => `x${n}-${i}`);
    for (const id of ids) chronicle.addChunk({ id, rawTokens: 100 });
    const a = chronicle.produceL1(ids.slice(0, 2));
    const b = chronicle.produceL1(ids.slice(2));
    chronicle.recallPairTokens.set(chronicle.produceUpper(2, [a.id, b.id]).id, cost);
  });
  return chronicle;
}

test('a merge is weighed at its conservative recall cost, so one that saves nothing at that cost is not measured', () => {
  // The expected cost of a new L2 is 10 and the conservative one 500, more
  // than y0+y1's 200.
  const chronicle = fourL2s();
  for (let i = 0; i < 2; i++) {
    chronicle.addChunk({ id: `y${i}`, rawTokens: 120 });
    chronicle.recallPairTokens.set(chronicle.produceL1([`y${i}`]).id, 100);
  }
  const evaluations = demand(inputsOf(chronicle));
  assert.ok(evaluations.length > 0, 'premise: other merges were measured');
  assert.ok(!evaluations.some((evaluation) => evaluation.first === 'y0'), JSON.stringify(evaluations));
});

// The gain of a merge is a difference of two pools' best scores, scored in one
// frame: the lowest cache and continuity floors any pool reached. These cases
// stand in each what-if solve's pool, so the floors and losses that decide the
// gain are set here; the base pool keeps the live solve's cut and stands in its
// candidates. Each stood-in pool scores its candidates in whatever frame its
// caller passes, as a solver's pool does. With these weights a candidate scores
// its budget penalty + (cache above the frame's floor / 10)^2 + (continuity
// above it / 10)^2.
const FRAMED = { ...POLICY, cacheLambda: 1, cacheScale: 10, continuityLambda: 1, continuityScale: 10 };

interface Stand { cacheChurn?: number; continuityLoss?: number; budgetPenalty?: number; frontier?: ReadonlyMap<string, number> }
function standIn(entries: readonly Stand[], extra: Record<string, unknown> = {}) {
  const candidates = entries.map((entry) => ({
    frontier: entry.frontier ?? new Map(), renderedTokens: 100, cacheChurn: entry.cacheChurn ?? 0, continuityLoss: entry.continuityLoss ?? 0,
    fidelityLoss: 0, budgetPenalty: entry.budgetPenalty ?? 0, cacheExcess: 0, continuityExcess: 0, score: 0,
  })) as unknown as ExactPolicyCandidate[];
  const policy = normalizePolicy(FRAMED);
  const inFrame = (c: ExactPolicyCandidate, kf: number, cf: number) =>
    policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss, kf, cf, policy, 1);
  const bestUnder = (kf: number, cf: number) =>
    candidates.reduce((best, c) => (inFrame(c, kf, cf) < inFrame(best, kf, cf) ? c : best));
  return withBestScoreUnder({
    feasible: true, selected: candidates[0], candidates, cacheRelevant: true,
    cacheFloor: Math.min(...candidates.map((candidate) => candidate.cacheChurn)),
    continuityFloor: Math.min(...candidates.map((candidate) => candidate.continuityLoss)),
    enumeration: { statesVisited: 0, candidatesGenerated: candidates.length, maxCandidatesAtState: 1, terminalCandidates: candidates.length },
    ...extra,
  }, (kf, cf) => inFrame(bestUnder(kf, cf), kf, cf), bestUnder);
}

/** Stands in the base pool's candidates (`base`) and each what-if's pool
 * (`whatIf`, given the latent summaries' ids and recall costs). */
function standInSolves(
  t: TestContext,
  base: readonly Stand[],
  whatIf: (latent: ReadonlyMap<string, number>) => object,
): void {
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    const inputs = (this as unknown as { inputs: PickerInputs }).inputs;
    const latent = new Map([...inputs.summaries.keys()].filter((id) => id.startsWith('__latent:'))
      .map((id) => [id, inputs.recallPairTokens?.get(id) ?? 0] as const));
    if (latent.size === 0) {
      const live = original.call(this, options);
      assert.equal(live.feasible, true, 'premise: the live solve is feasible');
      if (!live.feasible) return live;
      return standIn(base, { selected: live.selected }) as never;
    }
    return whatIf(latent) as never;
  });
}

/** Each fixture message as accepted raw by the previous compile. */
function rawPresentation(inputs: PickerInputs) {
  return {
    currentSeq: 1,
    leaves: new Map(inputs.chunks.map((chunk) => [chunk.id, { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 1 }] as const)),
  };
}

/** A warm cache: the previous compile's raw layout, one marker per message. */
function rawCache(inputs: PickerInputs) {
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  let offset = 0;
  const markers = layout.units.map((unit, index) => ({ unitIndex: index + 1, offset: (offset += unit.tokens) }));
  return { immutablePrefixHash: 'tools-v1', layout, markers };
}

/** A compile whose wall the presented raw layout no longer fits, so every pool has to move off it: a forced shed,
 * where pools' cache and continuity floors are above zero and can differ. */
function framedDemand(inputs: PickerInputs, mode: 'individual' | 'joint') {
  const raw = inputs.chunks.reduce((sum, chunk) => sum + chunk.rawTokens, 0);
  const wall = Math.floor(raw * 0.8);
  const strategy = new KvUnifiedStrategy({
    policy: FRAMED, ...GRID, labelCeiling: 10_000, presentation: rawPresentation(inputs),
    cache: rawCache(inputs), currentImmutablePrefixHash: 'tools-v1',
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 8, mode },
  });
  const solution = strategy.solve(inputs, { totalBudget: wall, targetBudget: wall, slack: 0 });
  return {
    produced: solution.produced.map((request) => request.range.firstChunkId),
    evaluations: strategy.lastDemandEvaluations.map((evaluation) => ({
      first: evaluation.request.range.firstChunkId,
      conservative: evaluation.conservativeImprovement,
      expected: evaluation.expectedImprovement,
    })),
  };
}

const l1Of = (inputs: PickerInputs, chunkId: string): string => inputs.chunks.find((chunk) => chunk.id === chunkId)!.l1Id!;

test("each merge's gain is scored in one frame, the lowest cache and continuity floors any what-if reached", (t) => {
  // The base pool's floors are 60 (cache) and 50 (continuity); the y0+y1
  // what-if reaches 20 and 10, the y2+y3 one 40 and 30. In the shared frame (20
  // and 10) the base's best scores 16 + 16, the first what-if's 0 and the
  // second's 4 + 4: gains of 32 and 24. Each scored in its own frame with the
  // base, the second would gain only 8; one floor taken for the other would
  // move both gains.
  const inputs = latentFixture([100, 100, 100, 100], 33);
  const y2 = l1Of(inputs, 'y2');
  standInSolves(t, [{ cacheChurn: 60, continuityLoss: 50 }], (latent) => {
    const [[id]] = [...latent];
    return id.includes(y2) ? standIn([{ cacheChurn: 40, continuityLoss: 30 }]) : standIn([{ cacheChurn: 20, continuityLoss: 10 }]);
  });
  const { evaluations, produced } = framedDemand(inputs, 'individual');
  assert.deepEqual(produced, ['y0', 'y2']);
  assert.deepEqual(evaluations.map((evaluation) => [evaluation.first, evaluation.conservative, evaluation.expected]), [
    ['y0', 32, 32],
    ['y2', 24, 24],
  ]);
});

test('merges whose conservative gains tie are ranked by their expected gains', (t) => {
  // Each new L2 is measured at 500 (conservative) and at 10 (expected).
  const chronicle = fourL2s();
  for (let i = 0; i < 4; i++) {
    chronicle.addChunk({ id: `y${i}`, rawTokens: 500 });
    chronicle.recallPairTokens.set(chronicle.produceL1([`y${i}`]).id, 400);
  }
  const inputs = inputsOf(chronicle);
  const y2 = l1Of(inputs, 'y2');
  // Every cut costs cache (40) and continuity (at least 10); the cut at the
  // continuity floor sits at the wall, where the over-edge penalty is 10. In
  // the frame of those floors, the base's best is 9, and every conservative
  // what-if's best 4 (gain 5); at the expected cost, the y0+y1 merge's best is
  // 1 (gain 8) and y2+y3's 0 (gain 9).
  const expensive = { cacheChurn: 40, continuityLoss: 10, budgetPenalty: 10 };
  standInSolves(t, [{ cacheChurn: 40, continuityLoss: 40 }, expensive], (latent) => {
    const [[id, recall]] = [...latent];
    if (recall !== 10) return standIn([{ cacheChurn: 40, continuityLoss: 30 }, expensive]);
    return id.includes(y2)
      ? standIn([{ cacheChurn: 40, continuityLoss: 10 }])
      : standIn([{ cacheChurn: 40, continuityLoss: 20 }, expensive]);
  });
  const { evaluations, produced } = framedDemand(inputs, 'individual');
  assert.ok(evaluations.every((evaluation) => evaluation.conservative === 5), JSON.stringify(evaluations));
  assert.deepEqual(produced.slice(0, 2), ['y2', 'y0']);
  assert.deepEqual(evaluations.slice(0, 2).map((evaluation) => [evaluation.first, evaluation.expected]), [['y2', 9], ['y0', 8]]);
});

// Joint mode: one what-if holds every candidate.
const Y01_AT_L2 = new Map([['y0', 2], ['y1', 2]]);

test("a joint gain is scored in the frame of the lowest floors the base and the joint pool reached", (t) => {
  // The base's floors are 60 (cache) and 50 (continuity), the joint pool's 20
  // and 10: in that frame the base's best scores 16 + 16 and the joint's 0.
  standInSolves(t, [{ cacheChurn: 60, continuityLoss: 50 }], () => standIn([{ cacheChurn: 20, continuityLoss: 10, frontier: Y01_AT_L2 }]));
  const { evaluations, produced } = framedDemand(latentFixture([100, 100, 100, 100], 33), 'joint');
  assert.equal(evaluations.find((evaluation) => evaluation.first === 'y0')?.conservative, 32);
  assert.deepEqual(produced, ['y0']);
});

// A run of merge candidates is summaries of one level that follow each other
// with nothing between them. Only a gap-bearing summary (kept whole under
// preserveGapBearingSummaries) lets the two conditions part: a raw message can
// sit inside its span, and a summary inside its holes.
function gapDemand(build: (chronicle: MockChronicle) => void) {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  build(chronicle);
  const strategy = new KvUnifiedStrategy({
    policy: POLICY, ...GRID, labelCeiling: 10_000, preserveGapBearingSummaries: true,
    latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 8, mode: 'individual' },
  });
  strategy.solve(inputsOf(chronicle), WIDE);
  return strategy.lastDemandEvaluations.map((evaluation) => evaluation.sourceIds.length);
}

test('a raw message between two summaries ends their run, though the second follows the first in sequence', () => {
  const addAll = (chronicle: MockChronicle) => { for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `x${i}`, rawTokens: 100 }); };
  assert.deepEqual(gapDemand((chronicle) => {
    addAll(chronicle);
    chronicle.produceL1(['x0', 'x1', 'x2', 'x3']);
    chronicle.produceL1(['x4', 'x5']);
  }), [2], 'premise: the two summaries side by side are a merge');
  // x2 is left out of the first summary, so it is a raw message inside its span.
  assert.deepEqual(gapDemand((chronicle) => {
    addAll(chronicle);
    chronicle.produceL1(['x0', 'x1', 'x3']);
    chronicle.produceL1(['x4', 'x5']);
  }), []);
});

test('two summaries of one level with nothing between them are still no run unless the second follows the first in sequence', () => {
  // The first summary holds x0 and x3, the second its holes x1 and x2, the
  // third x4 and x5: in root order each follows the last, but the second
  // starts before the first ends, and the third after the second's end.
  assert.deepEqual(gapDemand((chronicle) => {
    for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `x${i}`, rawTokens: 100 });
    chronicle.produceL1(['x0', 'x3']);
    chronicle.produceL1(['x1', 'x2']);
    chronicle.produceL1(['x4', 'x5']);
  }), []);
});

// A what-if forest is derived from the holder's last forest, else from the
// live one, rather than built; derived, it must be the forest a build of the
// what-if's inputs would give.
test('every what-if forest, derived from the live forest or the last compile\'s, equals a fresh build of its inputs', (t) => {
  const shape = (forest: CanonicalSummaryForest) => JSON.stringify({
    leaves: forest.orderedLeaves(), roots: forest.roots, fixedTokens: forest.fixedTokens,
    summaries: [...forest.allSummaries()].sort((a, b) => a.id.localeCompare(b.id)),
  });
  const derived = [0, 0];
  let compile = 0, compared = 0;
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    const { inputs, forest } = this as unknown as { inputs: PickerInputs; forest: CanonicalSummaryForest };
    if ([...inputs.summaries.keys()].some((id) => id.startsWith('__latent:'))) {
      compared++;
      if (forest.derived) derived[compile]++;
      assert.equal(shape(forest), shape(new CanonicalSummaryForest(inputs)));
    }
    return original.call(this, options);
  });
  const reuse: KvUnifiedReuse = {};
  for (compile = 0; compile < 2; compile++) {
    // The second compile has a message more, appended raw.
    const inputs = latentFixture([100, 100, 100, 100], 33);
    if (compile === 1) {
      const last = inputs.chunks.at(-1)!;
      (inputs.chunks as unknown as unknown[]).push({ ...last, id: 'y4', sequence: last.sequence + 1, l1Id: undefined, rawTokens: 120 });
    }
    new KvUnifiedStrategy({
      policy: POLICY, ...GRID, labelCeiling: 10_000, reuse,
      latentDemand: { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 8, mode: 'individual' },
    }).solve(inputs, WIDE);
  }
  assert.ok(compared > 0 && derived.every((count) => count > 0), `premise: each compile derived what-if forests (${derived.join(', ')} of ${compared})`);
});

test('constraints no cut can meet are refused naming the conflicting messages, the first five of them', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const chunk = chronicle.addChunk({ id, rawTokens: 100, lockedByAgent: true });
    chronicle.produceL1([id]);
    chunk.currentResolution = 0;
    chunk.pinLevel = 1;
  }
  assert.throws(
    () => new KvUnifiedStrategy({ policy: POLICY, ...GRID, labelCeiling: 10_000 }).solve(inputsOf(chronicle), WIDE),
    (error: Error) => error.message.startsWith('kv-unified constraints are infeasible for a, b, c, d, e: '),
  );
});
