import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import type { PickerInputs, PickerChunk } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';
import { KvUnifiedStrategy } from '../../src/adaptive/strategies/kv-unified.js';

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

test('derive declines ownership removals and option changes, extends re-parenting', () => {
  const first = new CanonicalSummaryForest(fixture(), options);
  const l1 = (next: PickerInputs) => {
    const chunk = next.chunks.find((c) => c.id === 'c6')!;
    const entry = [...next.summaries.values()].find((s) => s.level === 1)!;
    chunk.l1Id = entry.id; // c6 gains an owner
  };
  const cases: Array<[string, (next: PickerInputs) => void]> = [
    ['new L1 link', l1],
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
  // An L1 leaving its L2 is an ownership change the extension handles.
  const left = nextCompile(fixture());
  const leaving = [...left.summaries.values()].find((s) => s.level === 1)!;
  (leaving as { parentId?: string }).parentId = undefined;
  const extended = CanonicalSummaryForest.derive(first, left, options);
  assert.ok(extended && extended.lineage, 'summary parent change extends');
  assert.deepEqual(shape(extended), shape(new CanonicalSummaryForest(left, options)));
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

// ---- ownership extensions (summaries added, children re-parented) ----

// The chronicle's own objects: entries and chunks it will update in place.
function live(chronicle: MockChronicle, tail: string[] = []): PickerInputs {
  return {
    chunks: [...chronicle.chunks], summaries: new Map(chronicle.summaries),
    recallPairTokens: new Map(chronicle.recallPairTokens), headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(tail),
  };
}

function tenChunks(): MockChronicle {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 10; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 + i });
  return chronicle;
}

test('derive extends ownership when an L1 covers ownerless leaves', () => {
  const chronicle = tenChunks();
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  const b = chronicle.produceL1(['c3', 'c4', 'c5']);
  chronicle.produceUpper(2, [a.id, b.id]);
  const first = new CanonicalSummaryForest(nextCompile(live(chronicle, ['c8', 'c9'])), options);
  const c = chronicle.produceL1(['c6', 'c7']);
  const next = nextCompile(live(chronicle, ['c8', 'c9']));
  const derived = CanonicalSummaryForest.derive(first, next, options);
  assert.ok(derived && derived.lineage);
  assert.equal(derived.derived, true);
  assert.notEqual(derived.ownership, first.ownership);
  assert.equal(derived.lineage.parent, first.ownership);
  assert.deepEqual(shape(derived), shape(new CanonicalSummaryForest(next, options)));
  assert.equal(derived.leaf('c0'), first.leaf('c0'));
  assert.notEqual(derived.leaf('c6'), first.leaf('c6'));
  assert.equal(derived.summary(a.id), first.summary(a.id));
  assert.deepEqual([...derived.lineage.changedLeaves], [6, 7]);
  assert.deepEqual([...derived.lineage.changedSummaryIds], [c.id]);
});

test('derive extends ownership when an upper summary re-parents its children in place', () => {
  const chronicle = tenChunks();
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  const b = chronicle.produceL1(['c3', 'c4', 'c5']);
  // Built on the chronicle's own entry and chunk objects, which the next
  // production updates in place (as the strategy does with mergedInto).
  const first = new CanonicalSummaryForest(live(chronicle), options);
  const upper = chronicle.produceUpper(2, [a.id, b.id]);
  assert.equal(a.parentId, upper.id);
  const next = live(chronicle);
  const derived = CanonicalSummaryForest.derive(first, next, options);
  assert.ok(derived && derived.lineage);
  assert.deepEqual(shape(derived), shape(new CanonicalSummaryForest(next, options)));
  assert.notEqual(derived.summary(a.id), first.summary(a.id));
  assert.notEqual(derived.leaf('c0'), first.leaf('c0'));
  assert.equal(derived.leaf('c6'), first.leaf('c6'));
  assert.deepEqual([...derived.lineage.changedSummaryIds].sort(), [a.id, b.id, upper.id].sort());
  assert.deepEqual([...derived.lineage.changedLeaves], [0, 1, 2, 3, 4, 5]);
  // An L1 produced on the shared chunk objects is seen through the forest's
  // own leaf record, not the updated chunk.
  chronicle.produceL1(['c6', 'c7']);
  const again = CanonicalSummaryForest.derive(derived, live(chronicle), options);
  assert.ok(again && again.lineage);
  assert.deepEqual(shape(again), shape(new CanonicalSummaryForest(live(chronicle), options)));
  assert.deepEqual([...again.lineage.changedLeaves], [6, 7]);
});

test('derive extends through several levels, appended owned leaves, and again from an extension', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 12; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 + i });
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  const b = chronicle.produceL1(['c3', 'c4', 'c5']);
  const c = chronicle.produceL1(['c6', 'c7', 'c8']);
  const x = chronicle.produceUpper(2, [a.id, b.id]);
  const first = new CanonicalSummaryForest(nextCompile(live(chronicle, ['c11'])), options);
  const y = chronicle.produceUpper(2, [c.id]);
  const z = chronicle.produceUpper(3, [x.id, y.id]);
  chronicle.addChunk({ id: 'c12', rawTokens: 30 });
  chronicle.addChunk({ id: 'c13', rawTokens: 31 });
  const d = chronicle.produceL1(['c12', 'c13']);
  const next = nextCompile(live(chronicle, ['c13']));
  const derived = CanonicalSummaryForest.derive(first, next, options);
  assert.ok(derived && derived.lineage);
  assert.deepEqual(shape(derived), shape(new CanonicalSummaryForest(next, options)));
  assert.deepEqual([...derived.lineage.changedSummaryIds].sort(), [a.id, b.id, c.id, x.id, y.id, z.id, d.id].sort());
  assert.deepEqual([...derived.lineage.changedLeaves], [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13]);
  assert.equal(derived.leaf('c9'), first.leaf('c9'));
  chronicle.produceL1(['c9', 'c10']);
  const again = CanonicalSummaryForest.derive(derived, nextCompile(live(chronicle, ['c13'])), options);
  assert.ok(again && again.lineage);
  assert.deepEqual(shape(again), shape(new CanonicalSummaryForest(nextCompile(live(chronicle, ['c13'])), options)));
  assert.equal(again.summary(z.id), derived.summary(z.id));
});

test('derive declines what the full build rejects or does not extend', () => {
  const chronicle = tenChunks();
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  chronicle.produceL1(['c3', 'c4', 'c5']);
  const first = new CanonicalSummaryForest(nextCompile(live(chronicle)), options);
  // A changed level or cost of a placed summary.
  const levelChanged = nextCompile(live(chronicle));
  levelChanged.summaries.get(a.id)!.level = 2;
  assert.equal(CanonicalSummaryForest.derive(first, levelChanged, options), null);
  // A placed summary removed.
  const removed = nextCompile(live(chronicle));
  (removed.summaries as Map<string, unknown>).delete(a.id);
  assert.equal(CanonicalSummaryForest.derive(first, removed, options), null);
  assert.throws(() => new CanonicalSummaryForest(removed, options));
  // A parent link to a missing summary.
  const dangling = nextCompile(live(chronicle));
  dangling.summaries.get(a.id)!.parentId = 'nope';
  assert.equal(CanonicalSummaryForest.derive(first, dangling, options), null);
  assert.throws(() => new CanonicalSummaryForest(dangling, options));
  // A new L1 over non-contiguous leaves: the full build decides (gap-bearing here).
  chronicle.produceL1(['c6', 'c8']);
  const gapped = nextCompile(live(chronicle));
  assert.equal(CanonicalSummaryForest.derive(first, gapped, options), null);
  assert.deepEqual(new CanonicalSummaryForest(gapped, options).gapBearingSummaryIds.length, 1);
});

test('derive extensions match a fresh build over random evolutions', () => {
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (n: number): number => Math.floor(random() * n);
  let extensions = 0, fullBuilds = 0;
  for (let round = 0; round < 60; round++) {
    const chronicle = new MockChronicle({ recallPairTokens: 40 + pick(30) });
    let nextId = 0;
    const add = (): void => { chronicle.addChunk({ id: `m${nextId}`, rawTokens: 20 + pick(200) }); nextId++; };
    for (let i = 0, n = 4 + pick(8); i < n; i++) add();
    let tail: string[] = [];
    const inputsNow = (): PickerInputs => nextCompile(live(chronicle, tail));
    let previous = new CanonicalSummaryForest(inputsNow(), options);
    for (let step = 0; step < 7; step++) {
      switch (pick(6)) {
        case 0: for (let i = 0, n = 1 + pick(3); i < n; i++) add(); break;
        case 1: {
          // An L1 over a contiguous run of ownerless chunks.
          const runs: PickerChunk[][] = [];
          let run: PickerChunk[] = [];
          for (const chunk of chronicle.chunks) {
            if (chunk.l1Id === undefined) run.push(chunk);
            else { if (run.length > 0) runs.push(run); run = []; }
          }
          if (run.length > 0) runs.push(run);
          const candidates = runs.filter((r) => r.length >= 2);
          if (candidates.length === 0) break;
          const chosen = candidates[pick(candidates.length)];
          const start = pick(chosen.length - 1);
          const length = 2 + pick(chosen.length - start - 1);
          chronicle.produceL1(chosen.slice(start, start + length).map((chunk) => chunk.id));
          break;
        }
        case 2: case 3: {
          // An upper summary over adjacent parentless summaries of one level.
          const level = 2 + pick(2);
          const orphans = [...chronicle.summaries.values()]
            .filter((s) => s.level === level - 1 && !s.parentId)
            .sort((p, q) => chronicle.chunks.findIndex((c) => c.id === p.sourceRange.first) -
              chronicle.chunks.findIndex((c) => c.id === q.sourceRange.first));
          if (orphans.length < 2) break;
          const start = pick(orphans.length - 1);
          const length = 2 + pick(Math.min(2, orphans.length - start - 1));
          chronicle.produceUpper(level, orphans.slice(start, start + length).map((s) => s.id));
          break;
        }
        case 4: { const chunk = chronicle.chunks[pick(chronicle.chunks.length)]; chunk.pinned = !chunk.pinned; break; }
        case 5: tail = chronicle.chunks.slice(-(1 + pick(2))).map((chunk) => chunk.id); break;
      }
      const inputs = inputsNow();
      const fresh = new CanonicalSummaryForest(inputs, options);
      const derived = CanonicalSummaryForest.derive(previous, inputs, options);
      if (derived?.lineage) extensions++; else if (!derived) fullBuilds++;
      const next = derived ?? fresh;
      assert.deepEqual(shape(next), shape(fresh), `round ${round} step ${step}`);
      previous = next;
    }
  }
  assert.ok(extensions > 50, `extensions ${extensions}, full builds ${fullBuilds}`);
});

test('derive reads leaf fields from its own leaves, not from chunk objects updated in place', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  for (const id of ['a', 'b', 'c']) chronicle.addChunk({ id, rawTokens: 100 });
  chronicle.produceL1(['a']);
  const first = new CanonicalSummaryForest(live(chronicle), options);
  // Same ownership: a pin set on the retained chunk object.
  chronicle.chunks[0].pinned = true;
  const pinned = live(chronicle);
  const derived = CanonicalSummaryForest.derive(first, pinned, options);
  assert.ok(derived);
  assert.deepEqual(shape(derived), shape(new CanonicalSummaryForest(pinned, options)));
  assert.deepEqual(derived.leaf('a')!.allowedLevels, [0]);
  // Extended ownership: leaves off the changed chain edited in place beside a new L1.
  chronicle.chunks[0].pinned = false;
  chronicle.chunks[2].rawTokens = 7;
  chronicle.produceL1(['b']);
  const next = live(chronicle);
  const extended = CanonicalSummaryForest.derive(derived, next, options);
  assert.ok(extended?.lineage);
  assert.deepEqual(shape(extended), shape(new CanonicalSummaryForest(next, options)));
  // Through the strategy: a reused solve agrees with a fresh one after an in-place pin.
  const again = new MockChronicle({ recallPairTokens: 10 });
  again.addChunk({ id: 'a', rawTokens: 100 });
  again.addChunk({ id: 'b', rawTokens: 100 });
  again.produceL1(['a']);
  const strategy = new KvUnifiedStrategy({ reuse: {} });
  strategy.solve(live(again), { totalBudget: 300, targetBudget: 270, slack: 0.1 });
  again.chunks[0].pinned = true;
  again.produceL1(['b']);
  const budget = { totalBudget: 50, targetBudget: 45, slack: 0.1 };
  const reused = strategy.solve(live(again), budget);
  const fresh = new KvUnifiedStrategy().solve(live(again), budget);
  assert.equal(reused.exhausted, fresh.exhausted);
  assert.deepEqual(reused.frontier, fresh.frontier);
});

test('derive declines a placed summary deleted from the same input map', () => {
  const inputs = fixture();
  const forest = new CanonicalSummaryForest(inputs);
  const l1 = [...inputs.summaries.values()].find((entry) => entry.level === 1)!;
  // The caller edits the map the forest was built from, in place; the chunks
  // still name the deleted L1.
  (inputs.summaries as Map<string, unknown>).delete(l1.id);
  assert.equal(CanonicalSummaryForest.derive(forest, inputs), null);
  assert.throws(() => new CanonicalSummaryForest(inputs));
});
