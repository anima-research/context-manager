import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import { CanonicalSummaryForest, SparseLabelCeilingError } from '../../src/adaptive/kv-unified.js';
import { ParetoKvUnifiedPolicySolver, type ParetoSolveOptions } from '../../src/adaptive/kv-unified-pareto.js';
import type { KvUnifiedReuse } from '../../src/adaptive/kv-unified-reuse.js';
import { ExactKvUnifiedPolicySolver, type ExactPolicyCandidate } from '../../src/adaptive/kv-unified-policy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

const metrics = (candidates: readonly ExactPolicyCandidate[]) => candidates
  .map((c) => [c.renderedTokens, c.fidelityLoss, c.continuityLoss, c.cacheChurn, c.score].map((v) => Math.round(v * 1e6) / 1e6).join('/'))
  .sort();

function inputsOf(chronicle: MockChronicle, extra: Partial<PickerInputs> = {}): PickerInputs {
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(), ...extra,
  };
}

/** A chained forest (L1 pairs, L2 quads, L3 octets) with a few ownerless
 * leaves appended, randomized sizes, salience and recall costs; every third
 * run is the packed test's interleaved ownership (gap-bearing summaries),
 * and every fourth pins a leaf inside a summary (an internal hole). */
function randomForest(random: () => number, run: number): { chronicle: MockChronicle; inputs: PickerInputs } {
  const chronicle = run % 3 === 0 ? new MockChronicle({ recallPairTokens: 30 }) :
    buildChronicleWithChain({ chunkCount: 8, tokensPerChunk: 70, mergeThreshold: 2, recallPairTokens: 30 });
  if (run % 3 === 0) {
    for (let i = 0; i < 9; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70 });
    const a = chronicle.produceL1(['c0', 'c3', 'c6']);
    const b = chronicle.produceL1(['c1', 'c4', 'c7']);
    chronicle.produceL1(['c2', 'c5', 'c8']);
    chronicle.produceUpper(2, [a.id, b.id]);
  }
  for (let i = 0; i < run % 3; i++) chronicle.addChunk({ id: `tail-${i}`, rawTokens: 70, pinned: run % 5 === 0 && i === 0 });
  for (const chunk of chronicle.chunks) {
    chunk.rawTokens = 10 + Math.floor(random() * 200) + (run % 4 === 0 ? random() : 0);
    chunk.salience = random();
  }
  if (run % 4 === 0) chronicle.chunks[2].pinned = true;
  for (const [id] of chronicle.recallPairTokens) chronicle.recallPairTokens.set(id, 10 + random() * 50);
  const inputs = inputsOf(chronicle, { headTokens: run % 7, tailTokens: run % 13 });
  return { chronicle, inputs };
}

const FOREST_OPTIONS = { preserveGapBearingSummaries: true };

function presentationFor(inputs: PickerInputs, random: () => number, coveredFraction: number, lastChangedSeq: number) {
  const forest = new CanonicalSummaryForest(inputs, FOREST_OPTIONS);
  const cuts = forest.enumerateExactCuts().candidates;
  const cut = cuts[Math.floor(random() * cuts.length)];
  const layout = renderLayout(inputs, new SummaryTree(inputs), cut.frontier);
  const covered = Math.floor(inputs.chunks.length * coveredFraction);
  const leaves = new Map(inputs.chunks.slice(0, covered).map((chunk) => {
    const level = cut.frontier.get(chunk.id) ?? 0;
    const id = forest.leaf(chunk.id)!.summaryIds.find((sid) => forest.summary(sid)!.level === level);
    return [chunk.id, { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${id}`, lastChangedSeq }];
  }));
  return { layout, leaves };
}

test('the subtree engine matches the object engine exactly without a grid, warm and cold', () => {
  let state = 4242;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let compared = 0;
  for (let run = 0; run < 90; run++) {
    const { inputs } = randomForest(random, run);
    const { layout, leaves } = presentationFor(inputs, random, run % 2 ? 1 : 0.5, run % 3);
    const forest = new CanonicalSummaryForest(inputs, FOREST_OPTIONS);
    const floor = forest.minimumTokens();
    assert.ok(floor.feasible);
    const options: ParetoSolveOptions = {
      maxTokens: floor.floorTokens + 1 + random() * 500, adoptEpsilon: run % 2 ? 20 : 0,
      ...(run % 5 ? { presentation: { currentSeq: 7, leaves } } : {}),
      cache: { immutablePrefixHash: 'same', layout, markers: [
        { unitIndex: Math.max(1, Math.floor(layout.units.length / 2)), offset: 100 },
        { unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: run % 6 ? 'same' : 'changed',
      labelCeiling: 1_000_000,
      policy: { continuityLambda: 50 + run, cacheLambda: 100 + run, continuityScale: 100, cacheScale: 100, ageBandSteps: run % 2 ? 0 : 4 },
    };
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const reference = solver.solve({ ...options, storage: 'objects' });
    const subtree = solver.solve({ ...options, engine: 'subtree' });
    assert.ok(reference.feasible && subtree.feasible);
    assert.ok(solver.lastSubtreeStats, 'the subtree engine ran');
    assert.deepEqual(subtree.selected.frontier, reference.selected.frontier, `selected run ${run}`);
    assert.equal(subtree.selected.score, reference.selected.score);
    assert.equal(subtree.cacheFloor, reference.cacheFloor);
    assert.equal(subtree.continuityFloor, reference.continuityFloor);
    assert.deepEqual(metrics(subtree.candidates), metrics(reference.candidates), `candidates run ${run}`);
    assert.equal(subtree.propagation?.approximationScoreErrorBound, reference.propagation?.approximationScoreErrorBound);
    compared++;
  }
  assert.equal(compared, 90);
});

test('the subtree engine stays within the reported bound of the oracle on a grid', () => {
  let state = 9001;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 60; run++) {
    const { inputs } = randomForest(random, run);
    const { layout, leaves } = presentationFor(inputs, random, 1, 1);
    const forest = new CanonicalSummaryForest(inputs, FOREST_OPTIONS);
    const floor = forest.minimumTokens();
    assert.ok(floor.feasible);
    const options: ParetoSolveOptions = {
      maxTokens: floor.floorTokens + 1 + random() * 500,
      presentation: { currentSeq: 3, leaves },
      cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: run % 2 ? 'p' : 'q',
      tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100, labelCeiling: 1_000_000,
      policy: { continuityLambda: 50 + run, cacheLambda: 100 + run, continuityScale: 100, cacheScale: 100, ageBandSteps: 4 },
    };
    const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
    const subtree = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree' });
    assert.ok(oracle.feasible && subtree.feasible);
    const bound = subtree.propagation!.approximationScoreErrorBound;
    assert.ok(subtree.selected.score <= oracle.selected.score + bound + 1e-6,
      `run ${run}: subtree ${subtree.selected.score} vs oracle ${oracle.selected.score} + bound ${bound}`);
  }
});

test('the subtree engine reuses the deltas of unchanged summaries across compiles and matches a cold solve', () => {
  // 32 leaves of 100 tokens in a chain to L3 octets, one band per doubling:
  // after one append, every leaf older than 16 keeps its fidelity band and
  // every token midpoint older than 1024 keeps its recency band, so the
  // oldest octets are reused while the youngest subtrees are solved again.
  const chronicle = buildChronicleWithChain({ chunkCount: 32, tokensPerChunk: 100, mergeThreshold: 2, recallPairTokens: 40 });
  const first = inputsOf(chronicle);
  const policy = { continuityLambda: 10, cacheLambda: 10, continuityScale: 1000, cacheScale: 1000, ageBandSteps: 1 };
  // The accepted presentation is a cut this engine selected with no receipt.
  const blank = new ParetoKvUnifiedPolicySolver(first, new CanonicalSummaryForest(first)).solve({
    maxTokens: 1600, tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100, labelCeiling: 1_000_000, policy, engine: 'subtree',
  });
  assert.ok(blank.feasible);
  const layout = renderLayout(first, new SummaryTree(first), blank.selected.frontier);
  const accepted = new CanonicalSummaryForest(first);
  const leaves = new Map(first.chunks.map((chunk) => {
    const level = blank.selected.frontier.get(chunk.id) ?? 0;
    const id = accepted.leaf(chunk.id)!.summaryIds.find((sid) => accepted.summary(sid)!.level === level);
    return [chunk.id, { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${id}`, lastChangedSeq: 0 }];
  }));
  const base: ParetoSolveOptions = {
    maxTokens: 1600, presentation: { currentSeq: 40, leaves },
    cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'p',
    tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100, labelCeiling: 1_000_000, policy,
    engine: 'subtree',
  };
  const reuse: KvUnifiedReuse = {};
  const forestA = new CanonicalSummaryForest(first);
  const solverA = new ParetoKvUnifiedPolicySolver(first, forestA);
  const a = solverA.solve({ ...base, reuse });
  assert.ok(a.feasible);
  assert.ok(solverA.lastSubtreeStats!.summariesSolved > 0);
  assert.equal(solverA.lastSubtreeStats!.summariesReused, 0, 'a cold solve reuses nothing');
  assert.ok(reuse.subtree && reuse.subtree.size > 0, 'the holder keeps the sets');
  // The same inputs again: everything is reused.
  const solverA2 = new ParetoKvUnifiedPolicySolver(first, forestA);
  const a2 = solverA2.solve({ ...base, reuse });
  assert.ok(a2.feasible);
  assert.equal(solverA2.lastSubtreeStats!.summariesSolved, 0, 'nothing changed: nothing is solved');
  assert.deepEqual(a2.selected.frontier, a.selected.frontier);

  chronicle.addChunk({ id: 'appended', rawTokens: 100 });
  const second = inputsOf(chronicle);
  const forestB = CanonicalSummaryForest.derive(forestA, second)!;
  assert.ok(forestB, 'an append derives');
  const options = { ...base, presentation: { currentSeq: 41, leaves } };
  const solverB = new ParetoKvUnifiedPolicySolver(second, forestB);
  const warm = solverB.solve({ ...options, reuse });
  assert.ok(warm.feasible);
  const stats = solverB.lastSubtreeStats!;
  assert.ok(stats.summariesReused > 0, `old subtrees are reused (${JSON.stringify(stats)})`);
  assert.ok(stats.summariesSolved > 0, 'the subtrees the append moved across a band are solved again');
  // A fresh holder has nothing memoized: a cold solve of the same inputs.
  const solverC = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second));
  const cold = solverC.solve({ ...options, reuse: {} });
  assert.ok(cold.feasible);
  assert.equal(solverC.lastSubtreeStats!.summariesReused, 0);
  assert.deepEqual(warm.selected.frontier, cold.selected.frontier, 'the warm solve is the cold solve');
  assert.equal(warm.selected.score, cold.selected.score);
  assert.deepEqual(metrics(warm.candidates), metrics(cold.candidates));
  assert.deepEqual(warm.propagation, cold.propagation, 'reuse charges what the cold solve counts, its peaks included');
  // A reused set is held to the solve's ceiling as a fresh one would be.
  const ceiling = cold.propagation!.maxLabelsPerState - 1;
  assert.throws(() => new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second)).solve({ ...options, reuse: {}, labelCeiling: ceiling }), SparseLabelCeilingError);
  assert.throws(() => new ParetoKvUnifiedPolicySolver(second, forestB).solve({ ...options, reuse, labelCeiling: ceiling }), SparseLabelCeilingError, 'a warm solve under a lower ceiling fails like the cold one');
  // A full rebuild (new summary objects, the same ids and structure) still
  // reads the holder's sets: the entries rebind to the new objects.
  const solverD = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second));
  const rebuilt = solverD.solve({ ...options, reuse });
  assert.ok(rebuilt.feasible);
  assert.equal(solverD.lastSubtreeStats!.summariesSolved, 0, 'a rebuild changes no set');
  assert.ok(solverD.lastSubtreeStats!.summariesReused > 0);
  assert.deepEqual(rebuilt.selected.frontier, warm.selected.frontier);
  // A summary that changed (a new parent over two fresh L1s) is solved
  // again with its chain; the rest is read from the holder.
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `fresh-${i}`, rawTokens: 100 });
  const l1a = chronicle.produceL1(['fresh-0', 'fresh-1']);
  const l1b = chronicle.produceL1(['fresh-2', 'fresh-3']);
  new ParetoKvUnifiedPolicySolver(inputsOf(chronicle), new CanonicalSummaryForest(inputsOf(chronicle))).solve({ ...options, reuse });
  chronicle.produceUpper(2, [l1a.id, l1b.id]);
  const third = inputsOf(chronicle);
  const solverE = new ParetoKvUnifiedPolicySolver(third, new CanonicalSummaryForest(third));
  const merged = solverE.solve({ ...options, reuse });
  assert.ok(merged.feasible);
  const after = solverE.lastSubtreeStats!;
  assert.ok(after.summariesSolved > 0 && after.summariesReused > 0, `the merge re-solves its chain only (${JSON.stringify(after)})`);
  const solverF = new ParetoKvUnifiedPolicySolver(third, new CanonicalSummaryForest(third));
  const mergedCold = solverF.solve({ ...options, reuse: {} });
  assert.ok(mergedCold.feasible);
  assert.deepEqual(merged.selected.frontier, mergedCold.selected.frontier);
  assert.deepEqual(metrics(merged.candidates), metrics(mergedCold.candidates));
});

test('the subtree engine walks internal holes and gap-bearing ownership like the object engine, and `dag` still asks for the packed engine', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 30 });
  for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70, pinned: i === 1 });
  chronicle.produceL1(['c0', 'c1', 'c2']);
  chronicle.produceL1(['c3', 'c4', 'c5']);
  const inputs = inputsOf(chronicle);
  const forest = new CanonicalSummaryForest(inputs);
  assert.ok(forest.hasInternalProtectedHoles());
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const reference = solver.solve({ maxTokens: 400, storage: 'objects', labelCeiling: 100_000 });
  const subtree = solver.solve({ maxTokens: 400, labelCeiling: 100_000 });
  assert.ok(reference.feasible && subtree.feasible);
  assert.ok(solver.lastSubtreeStats, 'auto runs the subtree engine on a buffered forest');
  assert.deepEqual(subtree.selected.frontier, reference.selected.frontier);
  assert.deepEqual(metrics(subtree.candidates), metrics(reference.candidates));
  const packed = solver.solve({ maxTokens: 400, engine: 'dag', labelCeiling: 100_000 });
  assert.ok(packed.feasible);
  assert.equal(solver.lastSubtreeStats, null);
  assert.equal(packed.propagation?.storageMode, 'packed');
});

test('a child whose recall cost changed invalidates the sets of its ancestors after a rebuild', () => {
  // Two L1 pairs under an L2. A rebuild with one L1 priced at 300 instead
  // of 30 makes new objects for every summary; the L2's own structure is
  // unchanged, but its sets were composed from the child's old ones.
  const chronicle = buildChronicleWithChain({ chunkCount: 4, tokensPerChunk: 30, mergeThreshold: 2, recallPairTokens: 30 });
  const l1 = [...chronicle.summaries.values()].filter((summary) => summary.level === 1);
  assert.equal(l1.length, 2);
  assert.ok([...chronicle.summaries.values()].some((summary) => summary.level === 2));
  const options: ParetoSolveOptions = { maxTokens: 130, labelCeiling: 100_000, engine: 'subtree' };
  const reuse: KvUnifiedReuse = {};
  const first = inputsOf(chronicle);
  const before = new ParetoKvUnifiedPolicySolver(first, new CanonicalSummaryForest(first)).solve({ ...options, reuse });
  assert.ok(before.feasible);
  chronicle.recallPairTokens.set(l1[1].id, 300);
  const second = inputsOf(chronicle);
  const warm = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second)).solve({ ...options, reuse });
  const cold = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second)).solve({ ...options, reuse: {} });
  assert.ok(warm.feasible && cold.feasible);
  assert.ok(warm.selected.renderedTokens <= 130, `the warm cut fits the wall (${warm.selected.renderedTokens})`);
  assert.deepEqual(warm.selected.frontier, cold.selected.frontier);
  assert.deepEqual(metrics(warm.candidates), metrics(cold.candidates));
});

test('a delta representative that crosses the wall with the prefix leaves no feasible cut uncovered', () => {
  // Four 30-token leaves, two 55-token L1s, a 100-token L2, a 100-token
  // head and a 210-token wall on a coarse grid: the subtree's raw (120),
  // L1 (110) and L2 (100) cuts share a bucket, and the raw cut, which
  // covers the L1 cut's error, crosses the wall once the head is added.
  // The L1 cut is the oracle's answer; the reported bound has to cover it.
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 30 });
  const a = chronicle.produceL1(['c0', 'c1']);
  const b = chronicle.produceL1(['c2', 'c3']);
  const parent = chronicle.produceUpper(2, [a.id, b.id]);
  chronicle.recallPairTokens.set(parent.id, 100);
  const inputs = inputsOf(chronicle, { headTokens: 100 });
  const forest = new CanonicalSummaryForest(inputs);
  const options: ParetoSolveOptions = {
    maxTokens: 210, tokenBucketSize: 200, continuityBucketSize: 100, fidelityBucketSize: 1000, labelCeiling: 100_000,
    policy: { continuityLambda: 0, cacheLambda: 0, budgetUnderLambda: 0, budgetOverLambda: 0 },
  };
  const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
  const subtree = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree' });
  assert.ok(oracle.feasible && subtree.feasible);
  const bound = subtree.propagation!.approximationScoreErrorBound;
  assert.ok(subtree.selected.score <= oracle.selected.score + bound + 1e-6,
    `subtree ${subtree.selected.score} vs oracle ${oracle.selected.score} + bound ${bound}`);
});

test('an accepted leaf that is a protected hole keeps its summary from counting as new material', () => {
  // The only presented leaf is pinned inside an L1: the DAG engines and the
  // terminal evaluator decide new material over every leaf the summary
  // owns, so recalling that L1 is a re-rendering, not an extension.
  const chronicle = new MockChronicle({ recallPairTokens: 30 });
  for (let i = 0; i < 8; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70, pinned: i === 1 });
  chronicle.produceL1(['c0', 'c1', 'c2', 'c3']);
  chronicle.produceL1(['c4', 'c5', 'c6', 'c7']);
  const inputs = inputsOf(chronicle);
  const forest = new CanonicalSummaryForest(inputs);
  assert.ok(forest.hasInternalProtectedHoles());
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map(inputs.chunks.map((chunk) => [chunk.id, 0])));
  const options: ParetoSolveOptions = {
    maxTokens: 400, labelCeiling: 100_000,
    presentation: { currentSeq: 2, leaves: new Map([['c1', { level: 0, repHash: 'raw:c1', lastChangedSeq: 1 }]]) },
    cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'p',
    policy: { continuityLambda: 50, cacheLambda: 100, continuityScale: 100, cacheScale: 100 },
  };
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const reference = solver.solve({ ...options, storage: 'objects' });
  const subtree = solver.solve({ ...options, engine: 'subtree' });
  assert.ok(reference.feasible && subtree.feasible);
  assert.equal(subtree.selected.score, reference.selected.score);
  assert.deepEqual(subtree.selected.frontier, reference.selected.frontier);
  assert.deepEqual(metrics(subtree.candidates), metrics(reference.candidates));
});

test('without a grid the engine prunes by dominance across values, as the packed engine does', () => {
  // 24 leaves in 12 L1 pairs and no buckets: every distinct continuity or
  // fidelity value kept its own survivor once, and the search exceeded a
  // ceiling of 1,000 labels where the DAG engines peak at a dozen.
  const chronicle = new MockChronicle({ recallPairTokens: 40 });
  for (let i = 0; i < 24; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
  for (let i = 0; i < 24; i += 2) chronicle.produceL1([`c${i}`, `c${i + 1}`]);
  const inputs = inputsOf(chronicle);
  for (let i = 0; i < inputs.chunks.length; i++) inputs.chunks[i].salience = 0.3 + (i % 7) / 10;
  const forest = new CanonicalSummaryForest(inputs);
  const options: ParetoSolveOptions = {
    maxTokens: 1500, labelCeiling: 1000,
    policy: { continuityLambda: 50, cacheLambda: 100, continuityScale: 100, cacheScale: 100 },
  };
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const reference = solver.solve({ ...options, storage: 'objects' });
  const subtree = solver.solve({ ...options, engine: 'subtree' });
  assert.ok(reference.feasible && subtree.feasible);
  assert.deepEqual(subtree.selected.frontier, reference.selected.frontier);
  assert.deepEqual(metrics(subtree.candidates), metrics(reference.candidates));
  assert.ok(subtree.propagation!.maxLabelsPerState <= 4 * reference.propagation!.maxLabelsPerState,
    `peak ${subtree.propagation!.maxLabelsPerState} vs ${reference.propagation!.maxLabelsPerState}`);
});

test('an exact search whose one step expands past any argument list still completes under the ceiling', () => {
  // 52 L1 pairs under one L2 with a pinned hole, leaves of varied size and
  // salience, a matching receipt and no buckets: the walk through the L2
  // expands one label into ~160,000, more than a call can take as spread
  // arguments (about 125,000 on node 22 and 24), and below the ceiling. The
  // expansion is appended label by label, so the search reaches its ceiling
  // and not a RangeError.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pairs = 52;
  const chronicle = new MockChronicle({ recallPairTokens: 40 });
  for (let i = 0; i < pairs * 2; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 60 + Math.floor(random() * 80), pinned: i === 1 });
  const l1s = [];
  for (let i = 0; i < pairs * 2; i += 2) l1s.push(chronicle.produceL1([`c${i}`, `c${i + 1}`]));
  chronicle.produceUpper(2, l1s.map((summary) => summary.id));
  const inputs = inputsOf(chronicle);
  for (let i = 0; i < inputs.chunks.length; i++) inputs.chunks[i].salience = 0.2 + random() * 0.7;
  const forest = new CanonicalSummaryForest(inputs);
  assert.ok(forest.hasInternalProtectedHoles(), 'premise: the hole takes every label through the walk');
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map(inputs.chunks.map((chunk) => [chunk.id, 0])));
  const options: ParetoSolveOptions = {
    maxTokens: 300 * pairs, labelCeiling: 1_000_000,
    presentation: {
      currentSeq: 2,
      leaves: new Map(inputs.chunks.map((chunk) => [chunk.id, { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 1 }])),
    },
    cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'p',
    policy: { continuityLambda: 50, cacheLambda: 100, continuityScale: 100, cacheScale: 100 },
  };
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const subtree = solver.solve({ ...options, engine: 'subtree' });
  assert.ok(subtree.feasible);
  assert.ok(subtree.propagation!.maxLabelsPerState > 130_000, `premise: ${subtree.propagation!.maxLabelsPerState} labels in one step`);
  assert.throws(() => solver.solve({ ...options, engine: 'subtree', labelCeiling: 100_000 }), SparseLabelCeilingError,
    'the ceiling, not the call, bounds the step');
});

test('a re-priced summary whose cost collides with the old one on the xor of its float words is not rebound', () => {
  // 30 and 300.00000028591603 have the same xor of their float words, so a
  // structure that folded the cost that way rebound the old sets after a
  // rebuild: the warm cut was both L1s at a claimed 60 tokens under a 130
  // wall, while a cold solve selects the L2. The structure is two lanes
  // with the words whole, and a rebind compares the cost exactly.
  const words = (value: number) => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value); return [view.getUint32(0), view.getUint32(4)]; };
  const [oldHi, oldLo] = words(30), [newHi, newLo] = words(300.00000028591603);
  assert.equal(oldHi ^ oldLo, newHi ^ newLo, 'premise: the costs collide on the xor of their words');
  const build = (cost: number) => {
    const chronicle = new MockChronicle({ recallPairTokens: 30 });
    for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 50 });
    const a = chronicle.produceL1(['c0', 'c1']);
    const b = chronicle.produceL1(['c2', 'c3']);
    chronicle.produceUpper(2, [a.id, b.id]);
    chronicle.recallPairTokens.set(b.id, cost);
    const inputs = inputsOf(chronicle);
    return { inputs, forest: new CanonicalSummaryForest(inputs) };
  };
  const options: ParetoSolveOptions = { maxTokens: 130, labelCeiling: 100_000, policy: { alpha: 0 } };
  const reuse: KvUnifiedReuse = {};
  const first = build(30);
  const before = new ParetoKvUnifiedPolicySolver(first.inputs, first.forest).solve({ ...options, engine: 'subtree', reuse });
  assert.ok(before.feasible);
  assert.equal(before.selected.renderedTokens, 60, 'premise: both L1s fit at 30 each');
  const second = build(300.00000028591603);
  const warm = new ParetoKvUnifiedPolicySolver(second.inputs, second.forest).solve({ ...options, engine: 'subtree', reuse });
  const cold = new ParetoKvUnifiedPolicySolver(second.inputs, second.forest).solve({ ...options, storage: 'objects' });
  assert.ok(warm.feasible && cold.feasible);
  assert.deepEqual(warm.selected.frontier, cold.selected.frontier);
  assert.equal(warm.selected.score, cold.selected.score);
  assert.equal(warm.selected.renderedTokens, 30, 'the L2: both L1s no longer fit');
  assert.deepEqual(metrics(warm.candidates), metrics(cold.candidates));
});

test('a subtree pruned from its own origin that exceeds the ceiling runs again on the packed engine', () => {
  // Twelve L1 pairs (leaves 100+2^i and 100), every L1 and their L2 at 40,
  // a 9,950-token head under a 10,000 wall, no grid: the packed engine
  // prunes against the absolute prefix and peaks at one label, the subtree
  // engine prunes each set from zero and passes a ceiling of 1,000. Asked
  // for no engine in particular, the solve finishes on the packed engine;
  // asked for the subtree engine, it reports the ceiling.
  const chronicle = new MockChronicle({ recallPairTokens: 40 });
  const l1s = [];
  for (let i = 0; i < 12; i++) {
    chronicle.addChunk({ id: `a${i}`, rawTokens: 100 + 2 ** i });
    chronicle.addChunk({ id: `b${i}`, rawTokens: 100 });
    l1s.push(chronicle.produceL1([`a${i}`, `b${i}`]));
  }
  chronicle.produceUpper(2, l1s.map((summary) => summary.id));
  const inputs = inputsOf(chronicle, { headTokens: 9_950 });
  const forest = new CanonicalSummaryForest(inputs);
  const options: ParetoSolveOptions = { maxTokens: 10_000, labelCeiling: 1_000, policy: { alpha: 0 } };
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const packed = solver.solve({ ...options, engine: 'dag' });
  assert.ok(packed.feasible);
  assert.throws(() => solver.solve({ ...options, engine: 'subtree' }), SparseLabelCeilingError, 'premise');
  const auto = solver.solve({ ...options });
  assert.ok(auto.feasible);
  assert.equal(solver.lastSubtreeStats?.ceilingFallback, true, 'the stats say the packed engine finished the solve');
  assert.deepEqual(auto.selected.frontier, packed.selected.frontier);
  assert.equal(auto.selected.score, packed.selected.score);
});

test('a composition whose product would dwarf the ceiling is pruned as it grows', () => {
  // Two L2s over eleven varied L1 pairs each and an L3 over both, with a
  // receipt and no buckets: each L2's set is ~10,000 labels and the L3
  // combines them, a product of ~10^8 labels if formed before pruning. The
  // product is pruned as it grows, so the labels held at once stay within
  // the ceiling plus one expansion, and the cut is the packed engine's.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pairsPerL2 = 11;
  const chronicle = new MockChronicle({ recallPairTokens: 40 });
  const l2s = [];
  for (let group = 0; group < 2; group++) {
    const l1s = [];
    for (let pair = 0; pair < pairsPerL2; pair++) {
      const i = group * pairsPerL2 * 2 + pair * 2;
      chronicle.addChunk({ id: `c${i}`, rawTokens: 60 + Math.floor(random() * 80) });
      chronicle.addChunk({ id: `c${i + 1}`, rawTokens: 60 + Math.floor(random() * 80) });
      l1s.push(chronicle.produceL1([`c${i}`, `c${i + 1}`]));
    }
    l2s.push(chronicle.produceUpper(2, l1s.map((summary) => summary.id)));
  }
  chronicle.produceUpper(3, l2s.map((summary) => summary.id));
  const inputs = inputsOf(chronicle);
  for (let i = 0; i < inputs.chunks.length; i++) inputs.chunks[i].salience = 0.2 + random() * 0.7;
  const forest = new CanonicalSummaryForest(inputs);
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map(inputs.chunks.map((chunk) => [chunk.id, 0])));
  const ceiling = 100_000;
  const options: ParetoSolveOptions = {
    maxTokens: 300 * pairsPerL2 * 2, labelCeiling: ceiling,
    presentation: {
      currentSeq: 2,
      leaves: new Map(inputs.chunks.map((chunk) => [chunk.id, { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 1 }])),
    },
    cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'p',
    policy: { continuityLambda: 50, cacheLambda: 100, continuityScale: 100, cacheScale: 100 },
  };
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const packed = solver.solve({ ...options, engine: 'dag' });
  const subtree = solver.solve({ ...options, engine: 'subtree' });
  assert.ok(packed.feasible && subtree.feasible);
  const peak = subtree.propagation!.maxLabelsPerState;
  assert.ok(peak > 10_000, `premise: the sets are large (${peak})`);
  const stats = solver.lastSubtreeStats!;
  assert.ok(stats.peakTemporaryLabels > peak, `premise: a step grew past its pruned size (${stats.peakTemporaryLabels})`);
  assert.ok(stats.peakTemporaryLabels <= ceiling + peak, `held to the ceiling plus one expansion: ${stats.peakTemporaryLabels}`);
  assert.deepEqual(subtree.selected.frontier, packed.selected.frontier);
  assert.equal(subtree.selected.score, packed.selected.score);
});

test('the ceiling fallback drops departed ids from the memo and reports the work the engine did', () => {
  // The twelve-pair fixture of the fallback test, solved first in a form the
  // subtree engine fits (no head), with a holder; then with the head that
  // sends it over the ceiling, twice. The sets computed before the overflow
  // are reused on the second attempt and the stats say so, and an id that
  // left the forest between the solves is gone from the memo although the
  // engine never reached the end of a solve.
  const build = (head: number, extra: boolean) => {
    const chronicle = new MockChronicle({ recallPairTokens: 40 });
    const l1s = [];
    for (let i = 0; i < 12; i++) {
      chronicle.addChunk({ id: `a${i}`, rawTokens: 100 + 2 ** i });
      chronicle.addChunk({ id: `b${i}`, rawTokens: 100 });
      l1s.push(chronicle.produceL1([`a${i}`, `b${i}`]));
    }
    chronicle.produceUpper(2, l1s.map((summary) => summary.id));
    let departing: string | null = null;
    if (extra) {
      chronicle.addChunk({ id: 'x0', rawTokens: 50 });
      chronicle.addChunk({ id: 'x1', rawTokens: 50 });
      departing = chronicle.produceL1(['x0', 'x1']).id;
    }
    const inputs = inputsOf(chronicle, { headTokens: head });
    return { inputs, forest: new CanonicalSummaryForest(inputs), departing };
  };
  const options: ParetoSolveOptions = { maxTokens: 10_000, labelCeiling: 1_000, policy: { alpha: 0 } };
  const reuse: KvUnifiedReuse = {};
  const roomy = build(0, true);
  new ParetoKvUnifiedPolicySolver(roomy.inputs, roomy.forest).solve({ ...options, labelCeiling: 100_000, reuse });
  assert.ok(reuse.subtree?.has(roomy.departing!), 'premise: the extra L1 has an entry');
  const tight = build(9_950, false);
  const first = new ParetoKvUnifiedPolicySolver(tight.inputs, tight.forest);
  assert.ok(first.solve({ ...options, reuse }).feasible);
  assert.equal(first.lastSubtreeStats?.ceilingFallback, true, 'premise: the packed engine finished it');
  assert.equal(reuse.subtree?.has(roomy.departing!), false, 'the departed id is dropped on the fallback path too');
  const second = new ParetoKvUnifiedPolicySolver(tight.inputs, tight.forest);
  assert.ok(second.solve({ ...options, reuse }).feasible);
  assert.equal(second.lastSubtreeStats?.ceilingFallback, true);
  assert.ok(second.lastSubtreeStats!.summariesReused > 0, `the sets computed before the overflow were reused: ${JSON.stringify(second.lastSubtreeStats)}`);
});

test('the memo drops the ids of summaries that left the forest', () => {
  const build = (withParent: boolean) => {
    const chronicle = new MockChronicle({ recallPairTokens: 30 });
    for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 50 });
    const a = chronicle.produceL1(['c0', 'c1']);
    const b = chronicle.produceL1(['c2', 'c3']);
    const parent = withParent ? chronicle.produceUpper(2, [a.id, b.id]) : null;
    const inputs = inputsOf(chronicle);
    return { inputs, forest: new CanonicalSummaryForest(inputs), parent };
  };
  const options: ParetoSolveOptions = { maxTokens: 400, labelCeiling: 100_000, policy: { alpha: 0 } };
  const reuse: KvUnifiedReuse = {};
  const first = build(true);
  new ParetoKvUnifiedPolicySolver(first.inputs, first.forest).solve({ ...options, engine: 'subtree', reuse });
  assert.ok(reuse.subtree?.has(first.parent!.id), 'premise: the L2 has an entry');
  const second = build(false);
  new ParetoKvUnifiedPolicySolver(second.inputs, second.forest).solve({ ...options, engine: 'subtree', reuse });
  assert.equal(reuse.subtree?.has(first.parent!.id), false, 'gone with the summary');
  assert.ok(reuse.subtree?.size === 2, 'the two L1s remain');
});

test('a presentation appearing elsewhere invalidates the sets of a subtree it does not cover', () => {
  // Whether a presentation exists decides what new material is: with none,
  // nothing is an extension; with one that covers other leaves, this
  // subtree's leaves all are. The per-leaf hash is the same in both cases.
  const chronicle = buildChronicleWithChain({ chunkCount: 4, tokensPerChunk: 100, mergeThreshold: 2, recallPairTokens: 40 });
  const inputs = inputsOf(chronicle);
  const forest = new CanonicalSummaryForest(inputs);
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map(inputs.chunks.map((chunk) => [chunk.id, 0])));
  const base: ParetoSolveOptions = {
    maxTokens: 400, labelCeiling: 100_000, engine: 'subtree',
    cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'p',
    policy: { continuityLambda: 50, cacheLambda: 100, continuityScale: 100, cacheScale: 100 },
  };
  const reuse: KvUnifiedReuse = {};
  const blank = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...base, reuse });
  assert.ok(blank.feasible);
  const last = inputs.chunks[inputs.chunks.length - 1];
  const presentation = { currentSeq: 2, leaves: new Map([[last.id, { level: 0, repHash: `raw:${last.id}`, lastChangedSeq: 1 }]]) };
  const warm = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...base, presentation, reuse });
  const cold = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...base, presentation, reuse: {} });
  const reference = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...base, presentation, engine: 'dag', storage: 'objects' });
  assert.ok(warm.feasible && cold.feasible && reference.feasible);
  assert.equal(warm.selected.score, reference.selected.score);
  assert.deepEqual(warm.selected.frontier, reference.selected.frontier);
  assert.deepEqual(metrics(warm.candidates), metrics(cold.candidates));
});

test('a level the bit mask cannot hold still invalidates the memo when its constraint changes', () => {
  // A chain up to an L31: the allowed-level mask holds levels 0 to 30, so
  // a constraint that removes only level 31 from one leaf left the
  // per-leaf hash as it was and the warm solve kept selecting the L31.
  const chronicle = new MockChronicle({ recallPairTokens: 40 });
  chronicle.addChunk({ id: 'c0', rawTokens: 100 });
  chronicle.addChunk({ id: 'c1', rawTokens: 100 });
  let upper = chronicle.produceL1(['c0', 'c1']);
  chronicle.recallPairTokens.set(upper.id, 150);
  for (let level = 2; level <= 31; level++) {
    upper = chronicle.produceUpper(level, [upper.id]);
    chronicle.recallPairTokens.set(upper.id, level === 31 ? 20 : level === 30 ? 90 : 150);
  }
  // Under a wall of 100 only the L30 (90 tokens) and the L31 (20) fit, and
  // a hinge at 50 with a steep over-budget penalty makes the L31 the cut.
  const options: ParetoSolveOptions = {
    maxTokens: 100, labelCeiling: 100_000, engine: 'subtree',
    policy: { alpha: 0, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 },
  };
  const reuse: KvUnifiedReuse = {};
  const first = inputsOf(chronicle);
  const free = new ParetoKvUnifiedPolicySolver(first, new CanonicalSummaryForest(first)).solve({ ...options, reuse });
  assert.ok(free.feasible);
  assert.equal(free.selected.frontier.get('c0'), 31, 'the cut uses the L31');
  // A maximum level of 30 on one leaf removes only the level the mask
  // cannot hold; a stale set would still offer the L31 cut.
  chronicle.chunks[0].pinMaxLevel = 30;
  const second = inputsOf(chronicle);
  const warm = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second)).solve({ ...options, reuse });
  const cold = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second)).solve({ ...options, reuse: {} });
  assert.ok(warm.feasible && cold.feasible);
  assert.equal(cold.selected.frontier.get('c0'), 30, 'the constraint holds');
  assert.deepEqual(warm.selected.frontier, cold.selected.frontier, 'the warm solve sees the constraint');
  assert.deepEqual(metrics(warm.candidates), metrics(cold.candidates));
});
