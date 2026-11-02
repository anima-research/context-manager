import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ExactKvUnifiedPolicySolver, type AcceptedPresentationReference, type PresentedLeaf } from '../../src/adaptive/kv-unified-policy.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { KvUnifiedStrategy, type KvUnifiedOptions } from '../../src/adaptive/strategies/kv-unified.js';
import { MockChronicle } from './harness.js';

const GRID = { tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10, labelCeiling: 10_000 };

/** c0..c5 at 100 raw tokens each, one L1 per pair at 30 recall tokens: 600 raw, 90 at every L1. */
function store(): { chronicle: MockChronicle; inputs: () => PickerInputs } {
  const chronicle = new MockChronicle({ recallPairTokens: 30 });
  for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
  for (let i = 0; i < 6; i += 2) chronicle.produceL1([`c${i}`, `c${i + 1}`]);
  return {
    chronicle,
    inputs: () => ({
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    }),
  };
}

type Frontier = ReadonlyMap<string, number>;

/** Continuity so heavy that only the budget can outweigh keeping a presentation. */
const HOLD = { alpha: 1, budgetLowRatio: 0, budgetHighRatio: 1, budgetUnderLambda: 0, budgetOverLambda: 0, cacheLambda: 0, continuityLambda: 1e6, continuityScale: 1 };

/** The presentation a host's acceptance of `frontier` leaves for the next
 * compile. The receipt chain starts a new sequence when the accepted layout's
 * hash changes; here, where these tests can't change a layout without changing
 * a leaf, that's when some leaf's representation changes. */
function accepted(inputs: PickerInputs, frontier: Frontier, previous?: AcceptedPresentationReference): AcceptedPresentationReference {
  const forest = new CanonicalSummaryForest(inputs);
  const shown = forest.orderedLeaves().map((leaf) => {
    const level = frontier.get(leaf.id) ?? 0;
    const repHash = level === 0
      ? `raw:${leaf.id}`
      : `summary:${leaf.summaryIds.find((id) => forest.summary(id)!.level === level)}`;
    const before = previous?.leaves.get(leaf.id);
    return { id: leaf.id, level, repHash, before, changed: !before || before.level !== level || before.repHash !== repHash };
  });
  const changed = !previous || previous.leaves.size !== shown.length || shown.some((leaf) => leaf.changed);
  const currentSeq = (previous?.currentSeq ?? 0) + (changed ? 1 : 0);
  const leaves = new Map<string, PresentedLeaf>(shown.map((leaf) => [
    leaf.id, { level: leaf.level, repHash: leaf.repHash, lastChangedSeq: leaf.changed ? currentSeq : leaf.before!.lastChangedSeq },
  ]));
  return { currentSeq, leaves };
}

function solve(inputs: PickerInputs, wall: number, options: KvUnifiedOptions): Frontier {
  const solution = new KvUnifiedStrategy({ ...GRID, ...options }).solve(inputs, { totalBudget: wall, targetBudget: wall, slack: 0 });
  assert.equal(solution.exhausted ?? false, false, `premise: a cut fits ${wall}`);
  return new Map(solution.frontier);
}

const tokens = (inputs: PickerInputs, frontier: Frontier): number => new CanonicalSummaryForest(inputs).tokensForFrontier(frontier);
const levels = (frontier: Frontier): string => [...frontier].sort(([a], [b]) => a.localeCompare(b)).map(([id, level]) => `${id}:${level}`).join(' ');

test('a cut no deviation pays for is held: the accepted presentation plus the appended message', () => {
  const { chronicle, inputs } = store();
  // The accepted cut folds c0 and c1, which with room to spare no solve would
  // choose; continuity makes every deviation from it cost more than it gains.
  const first = new Map([['c0', 1], ['c1', 1], ['c2', 0], ['c3', 0], ['c4', 0], ['c5', 0]]);
  const presentation = accepted(inputs(), first);
  chronicle.addChunk({ id: 'c6', rawTokens: 100 });
  const expected = new Map([...first, ['c6', 0]]);
  assert.notEqual(levels(solve(inputs(), 1000, { policy: HOLD })), levels(expected), 'premise: without the presentation, another cut is best');
  assert.equal(levels(solve(inputs(), 1000, { policy: HOLD, presentation })), levels(expected));
});

test('a forced shed is held under a continuity-dominant policy once the wall is restored', () => {
  const { inputs } = store();
  const a = solve(inputs(), 1000, { policy: HOLD });
  assert.equal(tokens(inputs(), a), 600, 'premise: with room, every message is raw');
  const shedFrom = accepted(inputs(), a);
  const b = solve(inputs(), 300, { policy: HOLD, presentation: shedFrom });
  assert.ok(tokens(inputs(), b) <= 300, 'the shed fits the lowered wall');
  const restored = solve(inputs(), 1000, { policy: HOLD, presentation: accepted(inputs(), b, shedFrom) });
  assert.equal(levels(solve(inputs(), 1000, { policy: HOLD })), levels(a), 'premise: without the presentation the cut would be A again');
  assert.equal(levels(restored), levels(b));
});

test('a cut far below the low edge refills once under-fill and fidelity outweigh keeping it', () => {
  const { inputs } = store();
  const folded = new Map([0, 1, 2, 3, 4, 5].map((i) => [`c${i}`, 1] as const));
  const presentation = accepted(inputs(), folded);
  // Under-fill below the low edge at 500, with fidelity, outweighs the
  // continuity cost of refilling.
  const policy = { alpha: 0, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 1e4, budgetOverLambda: 0, cacheLambda: 0, continuityLambda: 1, continuityScale: 100 };
  const next = solve(inputs(), 1000, { policy, presentation });
  assert.ok(tokens(inputs(), next) >= 500, `refilled to ${tokens(inputs(), next)} tokens, ${levels(next)}`);
});

test('hysteresis never keeps an accepted cut over a lowered wall when a smaller cut fits', () => {
  const { inputs } = store();
  const raw = new Map([0, 1, 2, 3, 4, 5].map((i) => [`c${i}`, 0] as const));
  const presentation = accepted(inputs(), raw);
  for (const hysteresisCertificate of [false, true]) {
    const next = solve(inputs(), 400, { policy: HOLD, presentation, adoptEpsilon: 1e12, hysteresisCertificate });
    assert.ok(tokens(inputs(), next) <= 400, `certificate ${hysteresisCertificate}: ${tokens(inputs(), next)} tokens`);
  }
});

test('once a cut diverges from the cached prefix, the improvements right of the divergence land with it', () => {
  // c4 and c5 count half as much fidelity as the rest, so folding them is an
  // improvement the cache holds back. A level pin on c2 then forces c2 and c3
  // to fold, which breaks the cache from there anyway, and c4 and c5 fold too:
  // with the pin, that's the best cut even without a cache.
  const { chronicle, inputs } = store();
  for (const chunk of chronicle.chunks) if (chunk.id === 'c4' || chunk.id === 'c5') chunk.salience = 0.5;
  const rawLayout = renderLayout(inputs(), new SummaryTree(inputs()), new Map());
  const cache = {
    immutablePrefixHash: 'tools-v1', layout: rawLayout,
    markers: rawLayout.units.map((_, index) => ({ unitIndex: index + 1, offset: (index + 1) * 100 })),
  };
  const policy = {
    alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.4, budgetUnderLambda: 0, budgetOverLambda: 90_000,
    cacheLambda: 2000, cacheScale: 10, continuityLambda: 0,
  };
  const solve = (withCache: boolean) => {
    const result = new ExactKvUnifiedPolicySolver(inputs()).solve({
      maxTokens: 1000, presentation: accepted(inputs(), new Map([0, 1, 2, 3, 4, 5].map((i) => [`c${i}`, 0] as const))), policy,
      ...(withCache ? { cache, currentImmutablePrefixHash: 'tools-v1' } : {}),
    });
    assert.equal(result.feasible, true);
    if (!result.feasible) throw new Error('infeasible');
    return result;
  };
  const folded = (ids: readonly string[]) => levels(new Map([0, 1, 2, 3, 4, 5].map((i) => [`c${i}`, ids.includes(`c${i}`) ? 1 : 0] as const)));
  const score = (result: ReturnType<typeof solve>, ids: readonly string[]) =>
    result.candidates.find((candidate) => levels(candidate.frontier) === folded(ids))!.score;
  const free = solve(false);
  assert.ok(score(free, ['c4', 'c5']) < score(free, []), 'premise: without a cache, folding c4 and c5 scores below the raw cut');
  assert.equal(levels(solve(true).selected.frontier), folded([]), 'premise: the cache holds the raw cut');
  chronicle.chunks.find((chunk) => chunk.id === 'c2')!.pinLevel = 1;
  assert.equal(levels(solve(false).selected.frontier), folded(['c2', 'c3', 'c4', 'c5']), 'premise: with the pin and no cache, c4 and c5 fold too');
  assert.equal(levels(solve(true).selected.frontier), folded(['c2', 'c3', 'c4', 'c5']));
});
