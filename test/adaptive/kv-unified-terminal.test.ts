import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ExactKvUnifiedPolicySolver, type AcceptedPresentationReference } from '../../src/adaptive/kv-unified-policy.js';
import { TerminalPolicyEvaluator, type FrontierTrace } from '../../src/adaptive/kv-unified-terminal.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle, buildChronicleWithChain } from './harness.js';

function traceFor(frontier: ReadonlyMap<string, number>): FrontierTrace | null {
  let trace: FrontierTrace | null = null;
  for (const [id, level] of frontier) trace = { parent: trace, ids: [id], level };
  return trace;
}

test('prepared terminal metrics exactly match rendering and oracle sums across cache, gaps, holes, and extensions', () => {
  for (let run = 0; run < 120; run++) {
    const chronicle = new MockChronicle({ recallPairTokens: 25 + run % 60 });
    for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 30 + (run * 17 + i * 13) % 80 });
    const gap = run % 2 === 0;
    chronicle.produceL1(gap ? ['c0', 'c2'] : ['c0', 'c1']);
    chronicle.produceL1(gap ? ['c1', 'c3'] : ['c2', 'c3']);
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: run % 7, tailTokens: run % 11,
      headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const previousForest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const priorCuts = previousForest.enumerateExactCuts().candidates;
    const priorCut = priorCuts[run % priorCuts.length];
    const previous: AcceptedPresentationReference = { currentSeq: 5, leaves: new Map() };
    for (const chunk of inputs.chunks) {
      if (run % 3 === 0 && chunk.id === 'c3') continue;
      const level = priorCut.frontier.get(chunk.id) ?? 0;
      const summary = previousForest.leaf(chunk.id)!.summaryIds.find((id) => previousForest.summary(id)!.level === level);
      (previous.leaves as Map<string, { level: number; repHash: string; lastChangedSeq: number }>).set(chunk.id,
        { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${summary}`, lastChangedSeq: 1 });
    }
    const oldLayout = renderLayout(inputs, new SummaryTree(inputs), priorCut.frontier);
    if (run % 4 === 0) inputs.chunks[0].pinned = true;
    if (run % 5 === 0) (inputs.headChunkIds as Set<string>).add('c0');
    if (run % 6 === 0) (inputs.tailChunkIds as Set<string>).add('c3');
    // Receipt costs can differ even when unit identities still match.
    for (const chunk of inputs.chunks) chunk.rawTokens += run % 9;
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const options = {
      maxTokens: 1000, adoptEpsilon: 17,
      presentation: previous,
      cache: { immutablePrefixHash: 'prefix', layout: oldLayout,
        markers: [{ unitIndex: 1, offset: oldLayout.units[1]?.offset ?? oldLayout.totalTokens },
          { unitIndex: oldLayout.units.length, offset: oldLayout.totalTokens }] },
      currentImmutablePrefixHash: run % 10 === 0 ? 'different' : 'prefix',
      policy: { continuityLambda: 500, continuityScale: 50, cacheLambda: 100, cacheScale: 50 },
    };
    const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
    const oracle = new ExactKvUnifiedPolicySolver(inputs, forest);
    const enumeration = forest.enumerateExactCuts();
    const candidates = enumeration.candidates.map((candidate) => {
      const prepared = evaluator.candidate(traceFor(candidate.frontier), candidate.renderedTokens);
      const exact = oracle.scoreCandidates([candidate], options, enumeration.stats);
      assert.ok(exact.feasible);
      assert.equal(prepared.fidelityLoss, exact.selected.fidelityLoss, `F at ${run}`);
      assert.equal(prepared.continuityLoss, exact.selected.continuityLoss, `K at ${run}`);
      assert.equal(prepared.cacheChurn, exact.selected.cacheChurn, `C at ${run}`);
      assert.deepEqual(prepared.layout, exact.selected.layout);
      return prepared;
    });
    const expected = oracle.solve(options);
    const actual = oracle.scorePreparedCandidates(candidates, options, enumeration.stats, evaluator.cacheRelevant);
    assert.ok(expected.feasible);
    assert.deepEqual(actual.selected.frontier, expected.selected.frontier);
    assert.equal(actual.selected.score, expected.selected.score);
    assert.equal(actual.cacheFloor, expected.cacheFloor);
    assert.equal(actual.continuityFloor, expected.continuityFloor);
  }
});

test('general scoring does not reread every source token cost for every candidate', () => {
  const chronicle = buildChronicleWithChain({ chunkCount: 64, tokensPerChunk: 90, mergeThreshold: 2, recallPairTokens: 55 });
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  let tokenReads = 0;
  for (const chunk of inputs.chunks) {
    const tokens = chunk.rawTokens;
    Object.defineProperty(chunk, 'rawTokens', { enumerable: true, get: () => { tokenReads++; return tokens; } });
  }
  const result = new ParetoKvUnifiedPolicySolver(inputs).solve({
    maxTokens: 5000, tokenBucketSize: 100, continuityBucketSize: 50, fidelityBucketSize: 100,
    presentation: { currentSeq: 4, leaves: new Map(inputs.chunks.map((chunk) => [chunk.id,
      { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 0 }])) },
  });
  assert.ok(result.feasible);
  assert.ok(result.candidates.length > 100, `fixture only generated ${result.candidates.length} candidates`);
  assert.ok(tokenReads < inputs.chunks.length * 200,
    `${tokenReads} source-cost reads for ${inputs.chunks.length} leaves / ${result.candidates.length} candidates`);
});

test('lazy candidate layouts remain snapshots when inputs are later recalibrated', () => {
  const chronicle = buildChronicleWithChain({ chunkCount: 4, tokensPerChunk: 90, mergeThreshold: 2, recallPairTokens: 55 });
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 10, tailTokens: 20, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const forest = new CanonicalSummaryForest(inputs);
  const cut = forest.enumerateExactCuts().candidates[0];
  const expected = renderLayout(inputs, new SummaryTree(inputs), cut.frontier);
  const evaluator = new TerminalPolicyEvaluator(inputs, forest, { maxTokens: 500,
    cache: { immutablePrefixHash: 'same', layout: expected, markers: [] }, currentImmutablePrefixHash: 'same' });
  const candidate = evaluator.candidate(traceFor(cut.frontier), cut.renderedTokens);
  for (const chunk of inputs.chunks) chunk.rawTokens *= 2;
  for (const [id, tokens] of chronicle.recallPairTokens) chronicle.recallPairTokens.set(id, tokens * 3);
  inputs.headTokens = 100;
  inputs.tailTokens = 200;
  assert.deepEqual(candidate.layout, expected);
  assert.deepEqual(candidate.frontier, cut.frontier);
});

test('DAG solves nested protected holes and interleaved ownership with exact cache/continuity floors', () => {
  for (let run = 0; run < 80; run++) {
    const chronicle = new MockChronicle({ recallPairTokens: 20 + run % 25 });
    for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70 + (i * 13 + run) % 50 });
    const a = chronicle.produceL1(['c0', 'c3']);
    const b = chronicle.produceL1(['c1', 'c4']);
    const c = chronicle.produceL1(['c2', 'c5']);
    const parent = chronicle.produceUpper(2, [a.id, b.id]);
    if (run % 2) {
      const other = chronicle.produceUpper(2, [c.id]);
      chronicle.produceUpper(3, [parent.id, other.id]);
    }
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const previous = new Map(inputs.chunks.map((chunk) => [chunk.id,
      { level: 0, repHash: `raw:${chunk.id}`, lastChangedSeq: 0 }]));
    const layout = renderLayout(inputs, new SummaryTree(inputs), new Map());
    inputs.chunks[3].pinned = true;
    if (run % 3 === 0) { inputs.chunks[4].lockedByAgent = true; inputs.chunks[4].currentResolution = 1; }
    if (run % 4 === 0) { (inputs.headChunkIds as Set<string>).add('c0'); inputs.headTokens = 100; }
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const floor = forest.minimumTokens();
    assert.ok(floor.feasible);
    const options = {
      maxTokens: floor.floorTokens + 30 + (run * 17) % 200,
      presentation: { currentSeq: 5, leaves: previous },
      cache: { immutablePrefixHash: 'same', layout, markers: [
        { unitIndex: 2, offset: layout.units[2].offset },
        { unitIndex: 4, offset: layout.units[4].offset },
        { unitIndex: 6, offset: layout.totalTokens },
      ] },
      currentImmutablePrefixHash: 'same',
      policy: { continuityScale: 100, continuityLambda: 500, cacheScale: 100, cacheLambda: 500 },
    };
    const exact = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
    const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'dag' });
    assert.ok(exact.feasible && result.feasible, `feasible at ${run}`);
    assert.deepEqual(result.selected.frontier, exact.selected.frontier, `frontier at ${run}`);
    assert.equal(result.selected.score, exact.selected.score, `score at ${run}`);
    assert.equal(result.cacheFloor, exact.cacheFloor, `cache floor at ${run}`);
    assert.equal(result.continuityFloor, exact.continuityFloor, `continuity floor at ${run}`);
  }
});

test('cached continuity distances keep full precision across evaluators', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'x', rawTokens: 100 });
  const l1 = chronicle.produceL1(['x']);
  const upper = chronicle.produceUpper(2, [l1.id]);
  (upper as { level: number }).level = 65_537; // the forest reads the entry's level as given
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const forest = new CanonicalSummaryForest(inputs);
  const presentation: AcceptedPresentationReference = {
    currentSeq: 5, leaves: new Map([['x', { level: 65_537, repHash: `summary:${upper.id}`, lastChangedSeq: 1 }]]),
  };
  const options = { maxTokens: 10_000, presentation };
  const first = new TerminalPolicyEvaluator(inputs, forest, options).candidate({ levels: Uint32Array.of(1) }, 10);
  const second = new TerminalPolicyEvaluator(inputs, forest, options).candidate({ levels: Uint32Array.of(1) }, 10);
  assert.ok(first.continuityLoss > 0);
  assert.equal(second.continuityLoss, first.continuityLoss);
});

test('a presentation map changed between solves is read again', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'x', rawTokens: 100 });
  const l1 = chronicle.produceL1(['x']);
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const forest = new CanonicalSummaryForest(inputs);
  const leaves = new Map([['x', { level: 0, repHash: 'raw:x', lastChangedSeq: 1 }]]);
  const presentation: AcceptedPresentationReference = { currentSeq: 5, leaves };
  const before = new TerminalPolicyEvaluator(inputs, forest, { maxTokens: 10_000, presentation })
    .candidate({ levels: Uint32Array.of(0) }, 100);
  assert.equal(before.continuityLoss, 0);
  leaves.set('x', { level: 1, repHash: `summary:${l1.id}`, lastChangedSeq: 1 });
  // A new solve (new options object) sees the replaced entry.
  const after = new TerminalPolicyEvaluator(inputs, forest, { maxTokens: 10_000, presentation })
    .candidate({ levels: Uint32Array.of(0) }, 100);
  assert.ok(after.continuityLoss > 0);
});

function live(chronicle: MockChronicle): PickerInputs {
  return {
    chunks: chronicle.chunks.map((chunk) => ({ ...chunk })),
    summaries: new Map([...chronicle.summaries].map(([id, entry]) => [id, { ...entry }])),
    recallPairTokens: new Map(chronicle.recallPairTokens), headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

test('an evaluator reuses a kept layout translation only where the structure holds the same leaves', () => {
  for (const [appended, viaLineage] of [[1, false], [1, true], [2, false], [2, true]] as const) {
    const chronicle = new MockChronicle({ recallPairTokens: 10 });
    chronicle.addChunk({ id: 'a', rawTokens: 100 });
    chronicle.addChunk({ id: 'b', rawTokens: 100 });
    const a = chronicle.produceL1(['a']);
    const b = chronicle.produceL1(['b']);
    const p = chronicle.produceUpper(2, [b.id]);
    const baseInputs = live(chronicle);
    const base = new CanonicalSummaryForest(baseInputs);
    // A sibling that appended one or two ownerless leaves writes this
    // ownership's structure (the same length as the forest below, or longer).
    chronicle.addChunk({ id: 'x', rawTokens: 100 });
    if (appended === 2) chronicle.addChunk({ id: 'y', rawTokens: 100 });
    const grownInputs = live(chronicle);
    const grown = CanonicalSummaryForest.derive(base, grownInputs)!;
    assert.ok(grown);
    const layout = renderLayout(grownInputs, new SummaryTree(grownInputs), new Map([['a', 1], ['b', 1], ['x', 0], ['y', 0]]));
    assert.equal(layout.units.length, 2 + appended);
    const options = {
      maxTokens: 150, policy: { cacheLambda: 10000, cacheScale: 100 },
      cache: { immutablePrefixHash: 'same', layout,
        markers: layout.units.map((_, i) => ({ unitIndex: i + 1, offset: layout.units[i + 1]?.offset ?? layout.totalTokens })) },
      currentImmutablePrefixHash: 'same',
    };
    new TerminalPolicyEvaluator(grownInputs, grown, options);
    // Another forest from the same base: one appended leaf under a different
    // id at the sibling's position, with or without an ownership extension.
    const next = live(chronicle);
    next.chunks.splice(2, appended, { ...grownInputs.chunks[2], id: 'z' });
    if (viaLineage) {
      next.summaries.get(a.id)!.parentId = p.id;
      next.summaries.get(p.id)!.sourceIds = [a.id, b.id];
    }
    const derived = CanonicalSummaryForest.derive(base, next)!;
    assert.ok(derived);
    assert.equal(derived.lineage !== undefined, viaLineage);
    const reused = new TerminalPolicyEvaluator(next, derived, options);
    const fresh = new TerminalPolicyEvaluator(next, new CanonicalSummaryForest(next), options);
    for (const candidate of derived.enumerateExactCuts().candidates) {
      const trace = traceFor(candidate.frontier);
      const actual = reused.candidate(trace, candidate.renderedTokens);
      const expected = fresh.candidate(trace, candidate.renderedTokens);
      const at = `${appended} appended, ${viaLineage ? 'lineage' : 'ownership'} ${[...candidate.frontier].join(' ')}`;
      assert.equal(actual.cacheChurn, expected.cacheChurn, `churn at ${at}`);
      assert.equal(actual.fidelityLoss, expected.fidelityLoss, `F at ${at}`);
      assert.equal(actual.continuityLoss, expected.continuityLoss, `K at ${at}`);
      assert.deepEqual(actual.layout, expected.layout, `layout at ${at}`);
    }
  }
});

test('a solve reusing one options object after the presentation map changed reads the new entry', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'x', rawTokens: 100 });
  const l1 = chronicle.produceL1(['x']);
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const leaves = new Map([['x', { level: 0, repHash: 'raw:x', lastChangedSeq: 1 }]]);
  const options = {
    maxTokens: 10_000, adoptEpsilon: 1, hysteresisCertificate: true,
    policy: { continuityLambda: 10_000, continuityScale: 1, budgetLowRatio: 0, budgetHighRatio: 1 },
    presentation: { currentSeq: 5, leaves } as AcceptedPresentationReference,
  };
  const solver = new ParetoKvUnifiedPolicySolver(inputs, new CanonicalSummaryForest(inputs));
  const first = solver.solve(options);
  assert.ok(first.feasible);
  assert.equal(first.selected.frontier.get('x'), 0);
  // The accepted level moves to L1 inside the same map, and the same options
  // object is solved again: it must read the map again, as a fresh one would.
  leaves.set('x', { level: 1, repHash: `summary:${l1.id}`, lastChangedSeq: 1 });
  const reused = solver.solve(options);
  const fresh = new ParetoKvUnifiedPolicySolver(inputs, new CanonicalSummaryForest(inputs)).solve({ ...options });
  assert.ok(reused.feasible && fresh.feasible);
  assert.equal(reused.selected.frontier.get('x'), 1);
  assert.deepEqual([...reused.selected.frontier], [...fresh.selected.frontier]);
  assert.equal(reused.selected.score, fresh.selected.score);
  assert.equal(reused.selected.continuityLoss, fresh.selected.continuityLoss);
});

test('a kept layout translation with an unknown unit is rebuilt once the forest holds that leaf', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  chronicle.addChunk({ id: 'b', rawTokens: 100 });
  chronicle.produceL1(['a']);
  chronicle.produceL1(['b']);
  const baseInputs = live(chronicle);
  const base = new CanonicalSummaryForest(baseInputs);
  chronicle.addChunk({ id: 'x', rawTokens: 100 });
  const grownInputs = live(chronicle);
  // The accepted layout names x; the shorter forest cannot code that unit.
  const layout = renderLayout(grownInputs, new SummaryTree(grownInputs), new Map([['a', 1], ['b', 1], ['x', 0]]));
  assert.equal(layout.units.length, 3);
  const options = {
    maxTokens: 150, policy: { cacheLambda: 10000, cacheScale: 100 },
    cache: { immutablePrefixHash: 'same', layout,
      markers: layout.units.map((_, i) => ({ unitIndex: i + 1, offset: layout.units[i + 1]?.offset ?? layout.totalTokens })) },
    currentImmutablePrefixHash: 'same',
  };
  new TerminalPolicyEvaluator(baseInputs, base, options);
  const grown = CanonicalSummaryForest.derive(base, grownInputs)!;
  assert.ok(grown);
  const reused = new TerminalPolicyEvaluator(grownInputs, grown, options);
  const fresh = new TerminalPolicyEvaluator(grownInputs, new CanonicalSummaryForest(grownInputs), options);
  for (const candidate of grown.enumerateExactCuts().candidates) {
    const trace = traceFor(candidate.frontier);
    const actual = reused.candidate(trace, candidate.renderedTokens);
    const expected = fresh.candidate(trace, candidate.renderedTokens);
    const at = [...candidate.frontier].join(' ');
    assert.equal(actual.cacheChurn, expected.cacheChurn, `churn at ${at}`);
    assert.equal(actual.fidelityLoss, expected.fidelityLoss, `F at ${at}`);
    assert.equal(actual.continuityLoss, expected.continuityLoss, `K at ${at}`);
  }
});
