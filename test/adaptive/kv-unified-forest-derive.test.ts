import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import type { PickerInputs, PickerChunk } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

// Ten leaves: c0..c5 under two L1s and one L2, c6..c9 ownerless. c8, c9 in the tail.
function fixture(): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 10; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 + i });
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  const b = chronicle.produceL1(['c3', 'c4', 'c5']);
  chronicle.produceUpper(2, [a.id, b.id]);
  for (const chunk of chronicle.chunks) if (chunk.id === 'c8' || chunk.id === 'c9') chunk.pinned = true;
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(['c8', 'c9']),
  };
}

// A new compile builds fresh objects every time; copy everything.
function nextCompile(inputs: PickerInputs): PickerInputs {
  return {
    chunks: inputs.chunks.map((chunk) => ({ ...chunk })),
    summaries: new Map([...inputs.summaries].map(([id, entry]) => [id, { ...entry }])),
    recallPairTokens: new Map(inputs.recallPairTokens ?? []),
    headTokens: inputs.headTokens, tailTokens: inputs.tailTokens,
    headChunkIds: new Set(inputs.headChunkIds), tailChunkIds: new Set(inputs.tailChunkIds),
  };
}

function shape(forest: CanonicalSummaryForest) {
  return {
    leaves: forest.orderedLeaves(),
    summaries: [...forest.allSummaries()].sort((a, b) => a.id.localeCompare(b.id)),
    roots: forest.roots,
    conflicts: forest.constraintConflicts,
    treeified: forest.treeifiedSummaryIds,
    gapBearing: forest.gapBearingSummaryIds,
    fixedTokens: forest.fixedTokens,
  };
}

const options = { preserveGapBearingSummaries: true };

test('derive matches a fresh build when nothing changed', () => {
  const first = new CanonicalSummaryForest(fixture(), options);
  const next = nextCompile(fixture());
  const derived = CanonicalSummaryForest.derive(first, next, options);
  assert.ok(derived);
  assert.equal(derived.derived, true);
  assert.deepEqual(shape(derived), shape(new CanonicalSummaryForest(next, options)));
});

test('derive handles appended ownerless leaves, a sliding tail, and per-leaf changes', () => {
  const first = new CanonicalSummaryForest(fixture(), options);
  const next = nextCompile(fixture());
  // Two new tail messages, c8 leaves the tail and is no longer pinned, c3 gets locked, c6 pin-capped.
  const tail = next.tailChunkIds as Set<string>;
  tail.delete('c8'); tail.add('c10'); tail.add('c11');
  for (const chunk of next.chunks) {
    if (chunk.id === 'c8') chunk.pinned = false;
    if (chunk.id === 'c3') { chunk.lockedByAgent = true; chunk.currentResolution = 1; }
    if (chunk.id === 'c6') chunk.pinMaxLevel = 0;
    if (chunk.id === 'c9') chunk.rawTokens = 400;
  }
  const appended: PickerChunk[] = [10, 11].map((i) => ({
    id: `c${i}`, sequence: i, rawTokens: 50 + i, currentResolution: 0, lockedByAgent: false, pinned: true, l1Id: undefined,
  }));
  next.chunks.push(...appended);
  next.tailTokens = 123;
  // The derived forest takes the previous leaf map over, so capture the
  // objects to compare against before deriving.
  const oldC0 = first.leaf('c0'), oldC8 = first.leaf('c8');
  const derived = CanonicalSummaryForest.derive(first, next, options);
  assert.ok(derived);
  const fresh = new CanonicalSummaryForest(next, options);
  assert.deepEqual(shape(derived), shape(fresh));
  // Unchanged leaves are shared, changed ones are new objects.
  assert.equal(derived.leaf('c0'), oldC0);
  assert.notEqual(derived.leaf('c8'), oldC8);
  assert.equal(derived.summary(first.roots.find((root) => root.kind === 'summary')!.id), first.summary(first.roots.find((root) => root.kind === 'summary')!.id));
  // Chained derivation keeps working.
  const third = nextCompile(next);
  third.chunks.push({ id: 'c12', sequence: 12, rawTokens: 7, currentResolution: 0, lockedByAgent: false, pinned: true, l1Id: undefined });
  const again = CanonicalSummaryForest.derive(derived, third, options);
  assert.ok(again);
  assert.deepEqual(shape(again), shape(new CanonicalSummaryForest(third, options)));
});

test('derive declines every ownership change and option change', () => {
  const first = new CanonicalSummaryForest(fixture(), options);
  const l1 = (next: PickerInputs) => {
    const chunk = next.chunks.find((c) => c.id === 'c6')!;
    const entry = [...next.summaries.values()].find((s) => s.level === 1)!;
    chunk.l1Id = entry.id; // c6 gains an owner
  };
  const cases: Array<[string, (next: PickerInputs) => void]> = [
    ['new L1 link', l1],
    ['summary parent change', (next) => { const entry = [...next.summaries.values()].find((s) => s.level === 1)!; (entry as { parentId?: string }).parentId = undefined; }],
    ['recall cost change', (next) => { (next.recallPairTokens as Map<string, number>).set([...next.summaries.keys()][0], 1); }],
    ['summary removed', (next) => { (next.summaries as Map<string, unknown>).delete([...next.summaries.keys()][0]); }],
    ['appended leaf with owner', (next) => { next.chunks.push({ id: 'c10', sequence: 10, rawTokens: 5, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: [...next.summaries.keys()][0] }); }],
    ['leaf removed', (next) => { next.chunks.pop(); }],
  ];
  for (const [name, mutate] of cases) {
    const next = nextCompile(fixture());
    mutate(next);
    assert.equal(CanonicalSummaryForest.derive(first, next, options), null, name);
  }
  assert.equal(CanonicalSummaryForest.derive(first, nextCompile(fixture()), { treeifyNonContiguousSummaries: true }), null, 'option change');
  assert.equal(CanonicalSummaryForest.derive(first, nextCompile(fixture()), { ...options, overlapExempt: new Set(['c0']) }), null, 'overlap exempt');
});

test('deriving twice from one forest leaves every forest coherent', () => {
  const base: PickerInputs = {
    chunks: [{ id: 'z', sequence: 0, rawTokens: 100, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: undefined }],
    summaries: new Map(), recallPairTokens: new Map(), headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const first = new CanonicalSummaryForest(base, options);
  const grown = nextCompile(base);
  grown.chunks[0].rawTokens = 500;
  grown.chunks.push({ id: 'y', sequence: 1, rawTokens: 7, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: undefined });
  const sibling = CanonicalSummaryForest.derive(first, grown, options);
  assert.ok(sibling);
  const again = CanonicalSummaryForest.derive(first, nextCompile(base), options);
  assert.ok(again);
  for (const forest of [first, again]) {
    assert.equal(forest.leaf('z')!.rawTokens, 100);
    assert.equal(forest.leaf('z'), forest.orderedLeaves()[0]);
    assert.equal(forest.leaf('y'), null);
    const floor = forest.minimumTokens(150);
    assert.ok(floor.feasible);
    assert.equal(floor.floorTokens, 100);
  }
  assert.equal(sibling.leaf('z')!.rawTokens, 500);
  assert.equal(sibling.leaf('y'), sibling.orderedLeaves()[1]);
});
