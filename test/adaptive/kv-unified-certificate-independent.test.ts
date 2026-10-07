import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { certifyCarriedLayout } from '../../src/adaptive/kv-unified-certificate.js';
import { ExactKvUnifiedPolicySolver, type AcceptedPresentationReference, type ExactPolicySolveOptions } from '../../src/adaptive/kv-unified-policy.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';

const key = (f: ReadonlyMap<string, number>) => JSON.stringify([...f].sort());
const inputsFor = (c: MockChronicle): PickerInputs => ({ chunks: c.chunks, summaries: c.summaries,
  recallPairTokens: c.recallPairTokens, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() });

// Cartesian leaf assignments + global atomic-coverage predicate. No canonical
// select/expand recurrence, forest navigation, enumerator or minimum-token pass.
function independentCuts(inputs: PickerInputs) {
  assert.ok(inputs.chunks.length <= 10);
  const chains = new Map(inputs.chunks.map(c => {
    const chain: string[] = []; let id = c.l1Id;
    while (id) { assert.ok(!chain.includes(id)); chain.push(id); id = inputs.summaries.get(id)!.parentId; }
    return [c.id, chain];
  }));
  const external = (id: string) => inputs.headChunkIds.has(id) || inputs.tailChunkIds.has(id);
  const allowed = new Map(inputs.chunks.map(c => [c.id, [0, ...chains.get(c.id)!.map(id => inputs.summaries.get(id)!.level)]
    .filter(level => (!(external(c.id) || c.pinned) || level === 0) &&
      (!c.lockedByAgent || level === c.currentResolution) &&
      (c.pinLevel === undefined || level === c.pinLevel) &&
      (c.pinMaxLevel === undefined || level <= c.pinMaxLevel))]));
  const result: Array<{ frontier: Map<string, number>; renderedTokens: number }> = [];
  const assignment = new Map<string, number>();
  const visit = (index: number) => {
    if (index < inputs.chunks.length) {
      const c = inputs.chunks[index];
      for (const level of allowed.get(c.id)!) { assignment.set(c.id, level); visit(index + 1); }
      return;
    }
    const selected = new Set<string>();
    let tokens = inputs.headTokens + inputs.tailTokens;
    for (const c of inputs.chunks) {
      const level = assignment.get(c.id)!;
      if (level === 0) { if (!external(c.id)) tokens += c.rawTokens; }
      else selected.add(chains.get(c.id)!.find(id => inputs.summaries.get(id)!.level === level)!);
    }
    for (const id of selected) {
      const summary = inputs.summaries.get(id)!;
      // Every eligible descendant participates unless a selected ancestor
      // already owns it. An unconstrained raw sibling cannot become a hole.
      if (inputs.chunks.some(c => chains.get(c.id)!.includes(id) &&
        allowed.get(c.id)!.includes(summary.level) && assignment.get(c.id)! < summary.level)) return;
      tokens += inputs.recallPairTokens?.get(id) ?? summary.tokens;
    }
    result.push({ frontier: new Map(assignment), renderedTokens: tokens });
  };
  visit(0); return result;
}

function presentation(inputs: PickerInputs, frontier: ReadonlyMap<string, number>, seq = 1): AcceptedPresentationReference {
  const tree = new SummaryTree(inputs);
  return { currentSeq: seq, leaves: new Map(inputs.chunks.map(c => {
    const level = frontier.get(c.id) ?? 0;
    return [c.id, { level, repHash: level ? `summary:${tree.ancestorAt(c.id, level)!.id}` : `raw:${c.id}`, lastChangedSeq: seq }];
  })) };
}

test('independent atomic coverage validates holes, admissible lower bounds and exact policy', () => {
  let checked = 0;
  for (let seed = 0; seed < 32; seed++) {
    const c = new MockChronicle({ recallPairTokens: 12 + seed });
    for (let i = 0; i < 6; i++) { c.addChunk({ id: `c${i}`, rawTokens: 35 + (seed * 13 + i * 7) % 70 }); c.chunks[i].salience = (i + seed) % 3 / 2; }
    const groups = seed % 2 ? [[0, 2], [1, 3], [4, 5]] : [[0, 1], [2, 3], [4, 5]];
    const l1 = groups.map(g => c.produceL1(g.map(i => `c${i}`)));
    const l2 = c.produceUpper(2, l1.map(s => s.id)); c.produceUpper(3, [l2.id]);
    c.chunks[1].pinned = true; c.chunks[3].pinMaxLevel = seed % 3;
    if (seed % 4 === 0) { c.chunks[4].lockedByAgent = true; c.chunks[4].currentResolution = 1; }
    const inputs = inputsFor(c);
    if (seed % 4 === 1) { inputs.headChunkIds = new Set(['c0']); inputs.headTokens = c.chunks[0].rawTokens; }
    const independent = independentCuts(inputs);
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const canonical = forest.enumerateExactCuts().candidates;
    assert.deepEqual(independent.map(x => [key(x.frontier), x.renderedTokens]).sort(), canonical.map(x => [key(x.frontier), x.renderedTokens]).sort());
    for (const cut of independent) {
      const options = { maxTokens: cut.renderedTokens + 100, adoptEpsilon: 1e6,
        presentation: presentation(inputs, cut.frontier), policy: { alpha: seed % 5 / 4,
          budgetLowRatio: seed % 3 / 4, budgetHighRatio: 0.8, budgetUnderLambda: 1000, budgetOverLambda: 4000 } };
      const full = new ExactKvUnifiedPolicySolver(inputs, forest).scoreCandidates(independent.filter(c => c.renderedTokens <= options.maxTokens), options,
        { statesVisited: 0, candidatesGenerated: independent.length, maxCandidatesAtState: independent.length, terminalCandidates: independent.length });
      const certified = certifyCarriedLayout(inputs, forest, options);
      assert.ok(full.feasible && certified);
      assert.ok(certified.certificate.lowerBound <= Math.min(...full.candidates.map(c => c.fidelityLoss + c.budgetPenalty)));
      assert.equal(key(certified.selected.frontier), key(full.selected.frontier));
      assert.equal(certified.selected.score, full.selected.score); checked++;
    }
  }
  assert.ok(checked > 100); console.log(JSON.stringify({ independentCertificates: checked }));
});

test('certificate context, extension and ownership-depth caps decline conservatively', () => {
  const ext = new MockChronicle({ recallPairTokens: 10 }); ext.addChunk({ id: 'old', rawTokens: 30 });
  const before = presentation(inputsFor(ext), new Map());
  for (let i = 0; i < 8; i++) { ext.addChunk({ id: `a${i}`, rawTokens: 30 }); ext.addChunk({ id: `b${i}`, rawTokens: 30 }); ext.produceL1([`a${i}`, `b${i}`]); }
  let inputs = inputsFor(ext), forest = new CanonicalSummaryForest(inputs);
  const boundary = certifyCarriedLayout(inputs, forest, { maxTokens: 10000, adoptEpsilon: 1e6, presentation: before });
  assert.ok(boundary); assert.equal(boundary.candidates.length, 256, 'exact extension cap is inclusive');
  ext.addChunk({ id: 'a8', rawTokens: 30 }); ext.addChunk({ id: 'b8', rawTokens: 30 }); ext.produceL1(['a8', 'b8']);
  inputs = inputsFor(ext); forest = new CanonicalSummaryForest(inputs);
  assert.equal(certifyCarriedLayout(inputs, forest, { maxTokens: 10000, adoptEpsilon: 1e6, presentation: before }), null, '512 extensions exceed 256 cap');
  const capped = new MockChronicle({ recallPairTokens: 10 });
  for (let i = 0; i < 60; i++) { capped.addChunk({ id: `c${i}`, rawTokens: 30 }); capped.chunks[i].pinLevel = i + 1; }
  let upper = capped.produceL1(capped.chunks.map(c => c.id));
  for (let level = 2; level <= 60; level++) upper = capped.produceUpper(level, [upper.id]);
  inputs = inputsFor(capped); forest = new CanonicalSummaryForest(inputs);
  assert.equal(forest.constraintConflicts.length, 0);
  assert.equal(forest.tokensForFrontier(new Map(capped.chunks.map(c => [c.id, c.pinLevel!]))), 600);
  assert.equal(certifyCarriedLayout(inputs, forest, { maxTokens: 10000, adoptEpsilon: 1e6,
    presentation: presentation(inputs, new Map(capped.chunks.map(c => [c.id, c.pinLevel!]))) }), null, 'quadratic hole contexts exceed cap');
  const deep = new MockChronicle(); deep.addChunk({ id: 'deep', rawTokens: 30 }); upper = deep.produceL1(['deep']);
  for (let level = 2; level <= 257; level++) upper = deep.produceUpper(level, [upper.id]);
  inputs = inputsFor(deep); forest = new CanonicalSummaryForest(inputs);
  assert.equal(certifyCarriedLayout(inputs, forest, { maxTokens: 10000, adoptEpsilon: 1e6, presentation: presentation(inputs, new Map()) }), null);
});

for (const [name, depth, width, longId] of [
  ['wide pin chain', 60, 20, false], ['repeated long identifiers', 10, 1, true],
] as const) test(`aggregate context storage bounds ${name} before serializing keys`, () => {
  const chain = (depth: number, width: number, longId = false) => {
    const c = new MockChronicle({ recallPairTokens: 10 });
    for (let level = 1; level <= depth; level++) for (let i = 0; i < width; i++) {
      const id = longId && level === depth ? 'long-'.repeat(2048) : `c${level}-${i}`;
      c.addChunk({ id, rawTokens: 30 }); c.chunks.at(-1)!.pinLevel = level;
    }
    let upper = c.produceL1(c.chunks.map(chunk => chunk.id));
    for (let level = 2; level <= depth; level++) upper = c.produceUpper(level, [upper.id]);
    const inputs = inputsFor(c), forest = new CanonicalSummaryForest(inputs);
    const frontier = new Map(c.chunks.map(chunk => [chunk.id, chunk.pinLevel!]));
    const options = { maxTokens: 10000, adoptEpsilon: 1e12, presentation: presentation(inputs, frontier) };
    assert.equal(forest.constraintConflicts.length, 0);
    assert.equal(forest.tokensForFrontier(frontier), depth * 10);
    return { inputs, forest, options };
  };
  const small = chain(3, 1);
  assert.ok(certifyCarriedLayout(small.inputs, small.forest, small.options), 'ordinary bounded contexts still certify');
  const fixture = chain(depth, width, longId), count = fixture.inputs.chunks.length + fixture.inputs.summaries.size;
  const membershipsLimit = 32 * count + 1024;
  const identifierLimit = 32 * (count + fixture.inputs.chunks.reduce((n, c) => n + c.id.length, 0) +
    [...fixture.inputs.summaries.keys()].reduce((n, id) => n + id.length, 0)) + 1024;
  const stringify = JSON.stringify; let memberships = 0, identifiers = 0;
  // Observe actual context-key inputs and stop the unfixed implementation
  // before it allocates excessive strings. The guard must decline first.
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Array.isArray(value[1])) {
      memberships += value[1].length;
      identifiers += value[0].length + 1 + value[1].reduce((n: number, id: string) => n + id.length + 1, 0);
      assert.ok(memberships <= membershipsLimit && identifiers <= identifierLimit,
        'context serialization exceeded the aggregate storage budget');
    }
    return Reflect.apply(stringify, JSON, [value, ...rest]);
  }) as typeof JSON.stringify;
  try {
    assert.equal(certifyCarriedLayout(fixture.inputs, fixture.forest, fixture.options), null);
  } finally { JSON.stringify = stringify; }
  assert.ok(memberships > 0, 'exercise context construction rather than an earlier precondition decline');
  if (longId) {
    const solver = new ParetoKvUnifiedPolicySolver(fixture.inputs, fixture.forest);
    const ordinary = solver.solve(fixture.options);
    assert.ok(ordinary.feasible);
    assert.deepEqual(solver.solve({ ...fixture.options, hysteresisCertificate: true }), ordinary,
      'storage decline preserves the full solver, candidates, floors and error bounds');
  }
});

test('numeric walls, epsilon, zero costs and invalid policy retain their contracts', () => {
  const c = new MockChronicle({ recallPairTokens: 0 }); c.addChunk({ id: 'a', rawTokens: 0 }); c.addChunk({ id: 'b', rawTokens: 0 }); c.produceL1(['a', 'b']);
  const inputs = inputsFor(c), forest = new CanonicalSummaryForest(inputs);
  const base = { maxTokens: 0, adoptEpsilon: 1, presentation: presentation(inputs, new Map()) };
  assert.ok(certifyCarriedLayout(inputs, forest, base));
  for (const value of [NaN, Infinity, -Infinity, -1]) assert.equal(certifyCarriedLayout(inputs, forest, { ...base, maxTokens: value }), null);
  for (const value of [NaN, Infinity, -Infinity, -1, 0]) assert.equal(certifyCarriedLayout(inputs, forest, { ...base, adoptEpsilon: value }), null);
  assert.equal(certifyCarriedLayout(inputs, forest, { ...base, adoptEpsilon: Number.MIN_VALUE }), null, 'roundoff cannot be hidden by tiny epsilon');
  assert.throws(() => certifyCarriedLayout(inputs, forest, { ...base, policy: { alpha: NaN } }), /finite/);
  assert.equal(certifyCarriedLayout(inputs, forest, { ...base, policy: { budgetUnderLambda: Number.MAX_VALUE }, maxTokens: Number.MAX_VALUE }), null);
});

test('evolving accepted history recomputes pins, locks, receipts, fresh L1 and refolds', () => {
  const c = new MockChronicle({ recallPairTokens: 20 });
  for (let i = 0; i < 6; i++) c.addChunk({ id: `c${i}`, rawTokens: 80 });
  const a = c.produceL1(['c0', 'c1']), b = c.produceL1(['c2', 'c3']); c.produceUpper(2, [a.id, b.id]);
  let previous: AcceptedPresentationReference | undefined;
  let cache: ExactPolicySolveOptions['cache'];
  let certificates = 0, fallbacks = 0;
  for (let turn = 0; turn < 8; turn++) {
    if (turn === 1) c.chunks[0].pinned = true;
    if (turn === 2) { c.chunks[0].pinned = false; c.chunks[1].lockedByAgent = true; c.chunks[1].currentResolution = 1; }
    if (turn === 3) { c.chunks[1].lockedByAgent = false; c.addChunk({ id: 'new-pin', rawTokens: 60, pinned: true }); c.addChunk({ id: 'new-free', rawTokens: 90 }); c.produceL1(['new-pin', 'new-free']); }
    if (turn === 4) { const old = [...c.summaries.values()].find(s => s.level === 2)!;
      const fresh = [...c.summaries.values()].find(s => s.level === 1 && s.sourceIds.includes('new-pin'))!;
      const fresh2 = c.produceUpper(2, [fresh.id]); c.produceUpper(3, [old.id, fresh2.id]); }
    const inputs = inputsFor(c), independent = independentCuts(inputs);
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const options = { maxTokens: turn === 6 ? 350 : 1000, adoptEpsilon: turn === 5 ? 0.01 : 1000,
      presentation: previous, cache, currentImmutablePrefixHash: turn === 7 ? 'changed' : 'same',
      policy: { alpha: 0.7, continuityLambda: 100, continuityScale: 50, cacheLambda: 100, cacheScale: 50 } };
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const ordinary = solver.solve(options), enabled = solver.solve({ ...options, hysteresisCertificate: true });
    assert.ok(ordinary.feasible && enabled.feasible);
    const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).scoreCandidates(independent.filter(c => c.renderedTokens <= options.maxTokens), options,
      { statesVisited: 0, candidatesGenerated: independent.length, maxCandidatesAtState: independent.length, terminalCandidates: independent.length });
    assert.ok(oracle.feasible);
    assert.equal(key(enabled.selected.frontier), key(oracle.selected.frontier));
    assert.equal(enabled.selected.score, oracle.selected.score);
    assert.equal(key(enabled.selected.frontier), key(ordinary.selected.frontier));
    assert.equal(enabled.cacheFloor, ordinary.cacheFloor); assert.equal(enabled.continuityFloor, ordinary.continuityFloor);
    if (enabled.certificate) certificates++; else { fallbacks++; assert.deepEqual(enabled, ordinary); }
    const layout = renderLayout(inputs, new SummaryTree(inputs), enabled.selected.frontier);
    previous = presentation(inputs, enabled.selected.frontier, turn + 1);
    cache = { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] };
  }
  assert.ok(certificates && fallbacks); console.log(JSON.stringify({ historyCertificates: certificates, historyFallbacks: fallbacks }));
});
