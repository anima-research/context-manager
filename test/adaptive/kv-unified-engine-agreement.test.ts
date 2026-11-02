import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParetoKvUnifiedPolicySolver, type ParetoPolicySolveResult } from '../../src/adaptive/kv-unified-pareto.js';
import type { KvUnifiedReuse } from '../../src/adaptive/kv-unified-reuse.js';
import { ExactKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-policy.js';
import { seededPolicyFixture, candidateMetrics } from './harness.js';

type Fixture = ReturnType<typeof seededPolicyFixture>;

function assertSameResult(actual: ParetoPolicySolveResult, expected: ParetoPolicySolveResult, label: string) {
  assert.ok(actual.feasible && expected.feasible, label);
  assert.deepEqual(actual.selected, expected.selected, `${label}: selected`);
  assert.deepEqual(actual.candidates, expected.candidates, `${label}: candidates`);
}

function solvePackedAndObjects({ inputs, forest, options }: Fixture) {
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const reference = solver.solve({ ...options, storage: 'objects' });
  const packed = solver.solve({ ...options, engine: 'dag' });
  assert.ok(packed.feasible && reference.feasible);
  return { packed, reference };
}

function assertSameBounds(actual: ParetoPolicySolveResult, expected: ParetoPolicySolveResult) {
  assert.ok(actual.feasible && expected.feasible);
  for (const [key, value] of Object.entries(expected.propagation!)) {
    if (key.startsWith('approximation')) assert.equal((actual.propagation as unknown as Record<string, unknown>)[key], value, key);
  }
}

function assertPackedMatchesObjects({ packed, reference }: ReturnType<typeof solvePackedAndObjects>) {
  assertSameResult(packed, reference, 'packed');
  assertSameBounds(packed, reference);
}

const receiptApplies = ({ options }: Fixture) => options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
const pinned = ({ inputs }: Fixture, id: string) => inputs.chunks.find((chunk) => chunk.id === id)!.pinned;
const onlyAHoleAccepted = (fixture: Fixture) => [...fixture.forest.allSummaries()].some((summary) =>
  summary.leafIds.some((id) => pinned(fixture, id) && fixture.options.presentation?.leaves.has(id)) &&
  summary.leafIds.some((id) => !pinned(fixture, id)) &&
  summary.leafIds.every((id) => pinned(fixture, id) || !fixture.options.presentation?.leaves.has(id)));
const divergence = ({ options }: Fixture, layout: { units: ReadonlyArray<{ kind: string; key: string }> }) => {
  const receipt = options.cache.layout.units;
  const at = receipt.findIndex((unit, i) => layout.units[i]?.kind !== unit.kind || layout.units[i]?.key !== unit.key);
  return at < 0 ? null : at;
};
const markersReached = ({ options }: Fixture, at: number) => options.cache.markers.filter((marker) => marker.unitIndex <= at).length;

const metrics = (result: ParetoPolicySolveResult) => result.feasible ? candidateMetrics(result.candidates) : [];

function assertSubtreeMatchesObjects({ inputs, forest, options }: Fixture) {
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const reference = solver.solve({ ...options, storage: 'objects' });
  const subtree = solver.solve({ ...options, engine: 'subtree', reuse: {} });
  assert.ok(reference.feasible && subtree.feasible);
  assert.ok(solver.lastSubtreeStats, 'the subtree engine ran');
  assert.deepEqual(subtree.selected.frontier, reference.selected.frontier);
  assert.equal(subtree.selected.score, reference.selected.score);
  assert.deepEqual(metrics(subtree), metrics(reference));
}

function solveWarmAndCold({ inputs, forest, options }: Fixture, next: Fixture['options']) {
  const reuse: KvUnifiedReuse = {};
  new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree', reuse });
  assert.ok(reuse.subtree && reuse.subtree.size > 0, 'the first solve kept its sets');
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const warm = solver.solve({ ...next, engine: 'subtree', reuse });
  const reused = solver.lastSubtreeStats!.summariesReused;
  const cold = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...next, engine: 'subtree', reuse: {} });
  assert.ok(warm.feasible && cold.feasible);
  return { warm, cold, reused };
}

function assertWarmMatchesCold({ warm, cold }: ReturnType<typeof solveWarmAndCold>) {
  assert.ok(warm.feasible && cold.feasible);
  assert.deepEqual(metrics(warm), metrics(cold));
  assert.deepEqual(warm.selected.frontier, cold.selected.frontier);
  assert.equal(warm.selected.score, cold.selected.score);
}

test('the packed engine flushes emissions buffered around protected holes as object storage does', () => {
  const fixture = seededPolicyFixture(101);
  assert.ok(fixture.forest.hasInternalProtectedHoles());
  assert.ok(receiptApplies(fixture));
  assertPackedMatchesObjects(solvePackedAndObjects(fixture));
});

test("a unit that leaves the receipt ends the packed engine's intact cache prefix as object storage's", () => {
  const fixture = seededPolicyFixture(342);
  assert.ok(receiptApplies(fixture));
  const solved = solvePackedAndObjects(fixture);
  assert.ok(solved.reference.feasible && solved.reference.candidates.some((candidate) => divergence(fixture, candidate.layout) !== null),
    'a candidate leaves the receipt');
  assertPackedMatchesObjects(solved);
});

test('a receipt whose immutable prefix changed prices no cache in the packed engine, as in object storage', () => {
  const fixture = seededPolicyFixture(11);
  assert.ok(!receiptApplies(fixture));
  const solved = solvePackedAndObjects(fixture);
  assertPackedMatchesObjects(solved);
  assert.ok(solved.packed.feasible && solved.packed.candidates.every((candidate) => candidate.cacheChurn === 0), 'no candidate is charged cache');
});

test('the packed engine keys a broken cache prefix by the marker it reached, as object storage does', () => {
  const fixture = seededPolicyFixture(30);
  assert.ok(receiptApplies(fixture));
  assert.ok(fixture.options.cache.markers.length < fixture.options.cache.layout.units.length, 'markers leave units uncovered');
  const solved = solvePackedAndObjects(fixture);
  assert.ok(solved.reference.feasible);
  const reached = new Set(solved.reference.candidates.map((candidate) => divergence(fixture, candidate.layout))
    .filter((at): at is number => at !== null).map((at) => markersReached(fixture, at)));
  assert.ok(reached.size >= 2, 'broken prefixes reach different markers');
  assertPackedMatchesObjects(solved);
});

test("the packed engine decides a summary's new material over all its leaves, protected holes included", () => {
  const fixture = seededPolicyFixture(27);
  assert.ok(onlyAHoleAccepted(fixture), 'a summary whose only accepted leaves are protected holes');
  assertPackedMatchesObjects(solvePackedAndObjects(fixture));
});

test("the packed engine's fidelity error bound comes from its assignments' losses, as object storage's", () => {
  const fixture = seededPolicyFixture(21);
  const { tokenBucketSize, continuityBucketSize, fidelityBucketSize } = fixture.options;
  assert.ok(tokenBucketSize > 0 && continuityBucketSize > 0 && fidelityBucketSize > 0, 'the solve is gridded');
  const solved = solvePackedAndObjects(fixture);
  assert.ok(solved.reference.feasible && solved.reference.propagation!.approximationFidelityErrorBound > 0, 'the grid merged fidelities');
  assertPackedMatchesObjects(solved);
});

test('without a grid, the subtree engine flushes emissions buffered around protected holes as object storage does', () => {
  const fixture = seededPolicyFixture(445);
  assert.ok(fixture.forest.hasInternalProtectedHoles());
  assert.ok(receiptApplies(fixture));
  assert.equal(fixture.options.tokenBucketSize, 0);
  assertSubtreeMatchesObjects(fixture);
});

test("a warm subtree solve after an accepted entry's representation changes at its level matches a cold one", () => {
  const fixture = seededPolicyFixture(53);
  const presentation = fixture.options.presentation;
  assert.ok(presentation && presentation.leaves.size > 0);
  const [first] = presentation.leaves.keys();
  assert.notEqual(presentation.leaves.get(first)!.repHash, 'summary:regenerated', "the entry's representation changes");
  const leaves = new Map(presentation.leaves);
  leaves.set(first, { ...leaves.get(first)!, repHash: 'summary:regenerated' });
  const solved = solveWarmAndCold(fixture, { ...fixture.options, presentation: { ...presentation, leaves } });
  assert.ok(solved.reused > 0, 'the warm solve reused sets');
  assertWarmMatchesCold(solved);
});

test('a subtree solve after the wall rises reuses no set pruned at the old wall', () => {
  const fixture = seededPolicyFixture(2);
  const solved = solveWarmAndCold(fixture, { ...fixture.options, maxTokens: fixture.options.maxTokens + 150 });
  assertWarmMatchesCold(solved);
  assert.equal(solved.reused, 0, 'the warm solve reused no set');
});

test("the subtree engine's diagnostics leave its result as it is without them", () => {
  const { inputs, forest, options } = seededPolicyFixture(26);
  assert.ok(options.tokenBucketSize > 0, 'the solve is gridded');
  const previous = process.env.KVU_SUBTREE_DIAG, report = console.error;
  const printed: string[] = [];
  let plain: ParetoPolicySolveResult, diagnosed: ParetoPolicySolveResult;
  try {
    delete process.env.KVU_SUBTREE_DIAG;
    plain = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree', reuse: {} });
    process.env.KVU_SUBTREE_DIAG = '1';
    console.error = (...args: unknown[]) => { printed.push(args.join(' ')); };
    diagnosed = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree', reuse: {} });
  } finally {
    if (previous === undefined) delete process.env.KVU_SUBTREE_DIAG; else process.env.KVU_SUBTREE_DIAG = previous;
    console.error = report;
  }
  assert.ok(printed.some((line) => line.startsWith('[kvu-subtree]')), 'the diagnostics ran');
  assertSameResult(diagnosed, plain, 'diagnosed');
  assertSameBounds(diagnosed, plain);
});

test('the minimum-token cut is a candidate of a gridded subtree solve whose tail leaf a summary owns', () => {
  const { inputs, forest, options } = seededPolicyFixture(5, true);
  const tail = [...inputs.tailChunkIds];
  assert.ok(tail.some((id) => forest.leaf(id)!.summaryIds.length > 0), 'a summary owns a tail leaf');
  assert.ok(options.tokenBucketSize > 0, 'the solve is gridded');
  const floor = forest.minimumTokens(options.maxTokens);
  assert.ok(floor.feasible);
  const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree', reuse: {} });
  assert.ok(result.feasible);
  assert.ok(result.candidates.some((candidate) => candidate.renderedTokens === floor.floorTokens &&
    [...floor.frontier].every(([id, level]) => candidate.frontier.get(id) === level)));
});

test('the minimum-token cut is a candidate of a gridded packed solve whose tail leaf a summary owns', () => {
  const { inputs, forest, options } = seededPolicyFixture(5, true);
  assert.ok([...inputs.tailChunkIds].some((id) => forest.leaf(id)!.summaryIds.length > 0), 'a summary owns a tail leaf');
  assert.ok(options.tokenBucketSize > 0, 'the solve is gridded');
  const floor = forest.minimumTokens(options.maxTokens);
  assert.ok(floor.feasible);
  const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'dag' });
  assert.ok(result.feasible);
  assert.ok(result.candidates.some((candidate) => candidate.renderedTokens === floor.floorTokens &&
    [...floor.frontier].every(([id, level]) => candidate.frontier.get(id) === level)));
});

test('the score error bound covers hysteresis that keeps a carried layout the grid could not beat', () => {
  const { inputs, forest, options } = seededPolicyFixture(1807, false, true);
  assert.ok(options.tokenBucketSize > 0, 'the solve is gridded');
  const carried = new Map([['c3', 1], ['c4', 1], ['c5', 1], ['c6', 1], ['c8', 1]]);
  const leaves = new Map(inputs.chunks.map((chunk) => {
    const level = carried.get(chunk.id) ?? 0;
    const id = forest.leaf(chunk.id)!.summaryIds.find((sid) => forest.summary(sid)!.level === level);
    return [chunk.id, { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${id}`, lastChangedSeq: 1 }];
  }));
  const base = { ...options, presentation: { currentSeq: 5, leaves }, terminalEvaluation: 'full' as const };
  const exact = new ExactKvUnifiedPolicySolver(inputs, forest).solve({ ...base, adoptEpsilon: 0 });
  const gridded = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...base, adoptEpsilon: 0, reuse: {} });
  assert.ok(exact.feasible && gridded.feasible);
  const incumbent = exact.candidates.find((candidate) => inputs.chunks.every((chunk) =>
    (candidate.frontier.get(chunk.id) ?? 0) === (carried.get(chunk.id) ?? 0)))!;
  assert.ok(incumbent, 'the carried layout is a candidate');
  const lost = gridded.selected.score - exact.selected.score;
  assert.ok(lost > 0, 'the grid lost the exact optimum');
  const adoptEpsilon = incumbent.score - gridded.selected.score + lost / 2;
  const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve({ ...base, adoptEpsilon });
  const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...base, adoptEpsilon, reuse: {} });
  assert.ok(oracle.feasible && result.feasible);
  const isCarried = (frontier: ReadonlyMap<string, number>) => inputs.chunks.every((chunk) => (frontier.get(chunk.id) ?? 0) === (carried.get(chunk.id) ?? 0));
  assert.ok(isCarried(result.selected.frontier), 'hysteresis keeps the carried layout on the grid');
  assert.ok(!isCarried(oracle.selected.frontier), 'the exact solver leaves it');
  assert.ok(Math.abs(result.selected.score - oracle.selected.score) <= result.propagation!.approximationScoreErrorBound);
});

test('a run of ownerless roots after a summary selects in the subtree engine as in object storage', () => {
  const { inputs, forest, options } = seededPolicyFixture(95, true);
  const roots = forest.roots.map((root) => root.kind);
  assert.ok(roots.join(',').includes('summary,leaf,leaf'), 'two ownerless roots in a row after a summary');
  assert.ok(forest.hasInternalProtectedHoles() || forest.gapBearingSummaryIds.length > 0, 'the forest buffers emissions');
  assert.ok(options.cache.immutablePrefixHash === options.currentImmutablePrefixHash, 'the receipt applies');
  const subtree = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree', reuse: {} });
  const objects = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, storage: 'objects' });
  assert.ok(subtree.feasible && objects.feasible);
  assert.deepEqual(subtree.selected.frontier, objects.selected.frontier);
  assert.deepEqual(subtree.candidates.map((c) => [[...c.frontier], c.score]), objects.candidates.map((c) => [[...c.frontier], c.score]));
});
