import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { ExactKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-policy.js';
import { TerminalPolicyEvaluator, type FrontierTrace } from '../../src/adaptive/kv-unified-terminal.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle, buildChronicleWithChain } from './harness.js';
import { PackedLabels, PackedBuckets, PackedTraceArena, LABEL_STRIDE, LabelField } from '../../src/adaptive/kv-unified-packed-storage.js';

test('packed label growth, reuse, and branching preserve immutable trace ancestry', () => {
  const labels = new PackedLabels();
  const root = labels.initial(true, ['external']);
  labels.data[root * LABEL_STRIDE + LabelField.Tokens] = 123.5;
  const action = labels.traces.action(['a'], 1);
  labels.assign(root, action, 1.5, 2.25);
  const copies = Array.from({ length: 3000 }, () => labels.clone(root));
  const trace = labels.traces.reference(labels.finishTrace(copies[0]));
  for (const id of copies) {
    assert.equal(labels.data[id * LABEL_STRIDE + LabelField.Tokens], 123.5);
    assert.equal(labels.data[id * LABEL_STRIDE + LabelField.Continuity], 2.25);
    labels.release(id);
  }
  const reused = labels.clone(root);
  labels.assign(reused, labels.traces.action(['b'], 2), 9, 7);
  const original: Array<[readonly string[], number]> = [];
  trace.forEachAssignment((ids, level) => original.push([ids, level]));
  assert.deepEqual(original, [[['a'], 1], [['external'], 0]]);
  const fork: Array<[readonly string[], number]> = [];
  labels.traces.reference(labels.finishTrace(reused)).forEachAssignment((ids, level) => fork.push([ids, level]));
  assert.deepEqual(fork, [[['b'], 2], [['a'], 1], [['external'], 0]]);
  assert.equal(labels.slots, 3001, 'freed slots are reused');
});

test('reusable buckets keep numeric/string identities separate and reset each generation', () => {
  const buckets = new PackedBuckets(100);
  for (let pass = 0; pass < 100; pass++) {
    buckets.begin(2500);
    const numeric = buckets.group(17);
    const text = buckets.group('17');
    assert.notEqual(text, numeric, 'a string key is not its number');
    assert.equal(buckets.group(17), numeric, 'a repeat lookup is the same group');
    const negative = buckets.group(-1);
    assert.ok(negative !== numeric && negative !== text);
    for (let i = 1000; i < 3500; i++) buckets.group(i);
    assert.equal(buckets.count, 3 + 2500, 'one group per distinct key of this generation');
  }
});

test('a numeric key outside the dense range is not the string of its digits', () => {
  const buckets = new PackedBuckets(100);
  buckets.begin(10);
  for (const key of [250, -1, 2.5]) {
    const numeric = buckets.group(key);
    const text = buckets.group(String(key));
    assert.notEqual(text, numeric, `${key} and '${key}'`);
    assert.equal(buckets.group(key), numeric);
    assert.equal(buckets.group(String(key)), text);
  }
});

test('delayed exact evaluation retains captured budgets and partial traces retain default-raw semantics', () => {
  const chronicle = buildChronicleWithChain({ chunkCount: 4, tokensPerChunk: 90, mergeThreshold: 2, recallPairTokens: 55 });
  const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set() };
  const forest = new CanonicalSummaryForest(inputs);
  const options = { maxTokens: 400 };
  const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
  let trace: FrontierTrace | null = null;
  for (const chunk of inputs.chunks) trace = { parent: trace, ids: [chunk.id], level: 0 };
  const expected = evaluator.candidate(trace, 360);
  const estimated = evaluator.estimate(trace, 360);
  options.maxTokens = 100;
  for (const chunk of inputs.chunks) chunk.rawTokens *= 10;
  assert.deepEqual(estimated.exact(), expected);
  const partial = evaluator.estimate(null, 360);
  assert.deepEqual(partial.exact(), expected);

  const accepted = buildChronicleWithChain({ chunkCount: 4, tokensPerChunk: 90, mergeThreshold: 2, recallPairTokens: 55 });
  const acceptedInputs: PickerInputs = { chunks: accepted.chunks, summaries: accepted.summaries,
    recallPairTokens: accepted.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set() };
  const acceptedForest = new CanonicalSummaryForest(acceptedInputs);
  const leaves = new Map(acceptedForest.orderedLeaves().map((leaf) => [leaf.id,
    { level: 1, repHash: leaf.repHashes[leaf.availableLevels.indexOf(1)], lastChangedSeq: 0 }]));
  const presented = new TerminalPolicyEvaluator(acceptedInputs, acceptedForest,
    { maxTokens: 400, presentation: { currentSeq: 10, leaves } });
  const first = acceptedInputs.chunks[0].id;
  const estimate = presented.estimate({ parent: null, ids: [first], level: 0 }, 360);
  const exact = estimate.exact();
  assert.ok(exact.continuityLoss > 0);
  assert.ok(estimate.continuity.lower <= exact.continuityLoss && exact.continuityLoss <= estimate.continuity.upper,
    `continuity ${JSON.stringify(estimate.continuity)} against the default-raw cut's ${exact.continuityLoss}`);
  assert.ok(estimate.fidelity.lower <= exact.fidelityLoss && exact.fidelityLoss <= estimate.fidelity.upper);
  assert.equal(estimate.matchesPresentation, exact.matchesPresentation);
});

test('packed/full and packed/selective agree with object storage, including every retained candidate and error envelope', () => {
  let state = 73418;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 90; run++) {
    const chronicle = run % 3 === 0 ? new MockChronicle({ recallPairTokens: 30 }) :
      buildChronicleWithChain({ chunkCount: 8, tokensPerChunk: 70, mergeThreshold: 2, recallPairTokens: 30 });
    if (run % 3 === 0) {
      for (let i = 0; i < 9; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70 });
      const a = chronicle.produceL1(['c0', 'c3', 'c6']);
      const b = chronicle.produceL1(['c1', 'c4', 'c7']);
      chronicle.produceL1(['c2', 'c5', 'c8']);
      chronicle.produceUpper(2, [a.id, b.id]);
    }
    for (const chunk of chronicle.chunks) {
      chunk.rawTokens = 10 + Math.floor(random() * 200) + (run % 4 === 0 ? random() : 0);
      chunk.salience = random();
    }
    for (const [id] of chronicle.recallPairTokens) chronicle.recallPairTokens.set(id, 10 + random() * 50);
    const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens, headTokens: run % 7, tailTokens: run % 13,
      headChunkIds: new Set(), tailChunkIds: new Set() };
    const before = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const cuts = before.enumerateExactCuts().candidates;
    const previousCut = cuts[Math.floor(random() * cuts.length)];
    const layout = renderLayout(inputs, new SummaryTree(inputs), previousCut.frontier);
    const previous = new Map(inputs.chunks.slice(0, run % 2 ? inputs.chunks.length : Math.floor(inputs.chunks.length / 2)).map((chunk) => {
      const level = previousCut.frontier.get(chunk.id) ?? 0;
      const id = before.leaf(chunk.id)!.summaryIds.find((id) => before.summary(id)!.level === level);
      return [chunk.id, { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${id}`, lastChangedSeq: run % 3 }];
    }));
    if (run % 4 === 0) inputs.chunks[2].pinned = true;
    if (run % 5 === 0) { (inputs.headChunkIds as Set<string>).add(inputs.chunks[0].id); inputs.headTokens += 100; }
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const floor = forest.minimumTokens();
    assert.ok(floor.feasible);
    const options = {
      maxTokens: floor.floorTokens + 1 + random() * 500, adoptEpsilon: run % 2 ? 20 : 0,
      presentation: { currentSeq: 7, leaves: previous },
      cache: { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: Math.max(1, Math.floor(layout.units.length / 2)), offset: 100 },
        { unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: run % 6 ? 'same' : 'changed',
      tokenBucketSize: run % 7 ? 50 : 0, continuityBucketSize: run % 7 ? 30 : 0, fidelityBucketSize: run % 7 ? 100 : 0,
      policy: { continuityLambda: 50 + run, cacheLambda: 100 + run, continuityScale: 100, cacheScale: 100 },
    };
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const reference = solver.solve({ ...options, storage: 'objects' });
    assert.ok(reference.feasible);
    for (const terminalEvaluation of ['full', 'selective'] as const) {
      const packed = solver.solve({ ...options, terminalEvaluation, engine: 'dag' });
      assert.ok(packed.feasible);
      assert.deepEqual(packed.selected, reference.selected, `selected run ${run}/${terminalEvaluation}`);
      assert.equal(packed.cacheFloor, reference.cacheFloor);
      assert.equal(packed.continuityFloor, reference.continuityFloor);
      assert.deepEqual(packed.candidates, reference.candidates, `candidates run ${run}/${terminalEvaluation}`);
      for (const [key, value] of Object.entries(reference.propagation!)) {
        assert.equal((packed.propagation as unknown as Record<string, unknown>)[key], value, `stat ${key} run ${run}`);
      }
    }
    // Check the bounds themselves against every exact candidate, not only the
    // eventual winner; also verify chronological cache corrections exactly.
    const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
    for (const cut of forest.enumerateExactCuts({ maxTokens: options.maxTokens }).candidates) {
      let trace: FrontierTrace | null = null;
      const groups = new Map<number, string[]>();
      for (const [id, level] of cut.frontier) { const ids = groups.get(level); if (ids) ids.push(id); else groups.set(level, [id]); }
      for (const [level, ids] of groups) trace = { parent: trace, ids, level };
      const estimate = evaluator.estimate(trace, cut.renderedTokens);
      const exact = estimate.exact();
      assert.ok(estimate.fidelity.lower <= exact.fidelityLoss && exact.fidelityLoss <= estimate.fidelity.upper);
      assert.ok(estimate.continuity.lower <= exact.continuityLoss && exact.continuityLoss <= estimate.continuity.upper);
      assert.equal(estimate.cacheChurn, exact.cacheChurn);
      assert.equal(estimate.matchesPresentation, exact.matchesPresentation);
    }
  }
});

test('trace ancestry survives the 2^18 trace page boundary', () => {
  const arena = new PackedTraceArena();
  const actions = [arena.action(['a'], 0), arena.action(['b'], 1), arena.action(['c'], 2)];
  let node = 0;
  const expected: string[] = [];
  // Three actions: 2^18 is not a multiple of 3, so reading the wrong page shows.
  for (let i = 0; i < (1 << 18) + 2; i++) {
    node = arena.append(node, actions[i % 3]);
    expected.push(['a', 'b', 'c'][i % 3]);
  }
  assert.equal(arena.nodes, (1 << 18) + 2);
  const visited: string[] = [];
  arena.reference(node).forEachAssignment((ids, level) => {
    assert.equal(level, ['a', 'b', 'c'].indexOf(ids[0]));
    visited.push(ids[0]);
  });
  assert.deepEqual(visited, expected.reverse());
});

test('a gridded packed solve over fully tied cuts returns the same candidates on every solve', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 40 });
  for (const id of ['a', 'b', 'c', 'd']) chronicle.addChunk({ id, rawTokens: 100 });
  chronicle.produceL1(['a', 'b']);
  chronicle.produceL1(['c', 'd']);
  const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set() };
  const forest = new CanonicalSummaryForest(inputs);
  const options = { maxTokens: 300, engine: 'dag' as const, policy: { alpha: 0 },
    tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100 };
  const exact = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
  assert.ok(exact.feasible);
  const holding = (a: number, c: number) => exact.candidates.find((candidate) =>
    ['a', 'b'].every((id) => (candidate.frontier.get(id) ?? 0) === a) && ['c', 'd'].every((id) => (candidate.frontier.get(id) ?? 0) === c));
  const [first, second] = [holding(1, 0), holding(0, 1)];
  assert.ok(first && second, 'both cuts holding one L1 are candidates');
  assert.equal(first.score, second.score, 'the two cuts tie');
  assert.equal(first.renderedTokens, second.renderedTokens);
  assert.equal(first.fidelityLoss, second.fidelityLoss);
  const solved = new ParetoKvUnifiedPolicySolver(inputs, forest).solve(options);
  assert.ok(solved.feasible);
  for (let run = 0; run < 20; run++) {
    const again = new ParetoKvUnifiedPolicySolver(inputs, forest).solve(options);
    assert.ok(again.feasible);
    assert.deepEqual(again.candidates, solved.candidates, `solve ${run}`);
  }
});
