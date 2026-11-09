import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

function fixture(): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 10; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 + i });
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  const b = chronicle.produceL1(['c3', 'c4', 'c5']);
  chronicle.produceUpper(2, [a.id, b.id]);
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(['c8', 'c9']),
  };
}
function nextCompile(inputs: PickerInputs): PickerInputs {
  return {
    chunks: inputs.chunks.map((chunk) => ({ ...chunk })),
    summaries: new Map([...inputs.summaries].map(([id, entry]) => [id, { ...entry, sourceIds: [...entry.sourceIds] }])),
    recallPairTokens: new Map(inputs.recallPairTokens ?? []),
    headTokens: inputs.headTokens, tailTokens: inputs.tailTokens,
    headChunkIds: new Set(inputs.headChunkIds), tailChunkIds: new Set(inputs.tailChunkIds),
  };
}
function shape(tree: SummaryTree, inputs: PickerInputs) {
  const frontier = new Map(inputs.chunks.map((c) => [c.id, tree.maxLevel(c.id)]));
  return {
    leaves: tree.orderedLeaves(),
    summaries: tree.allSummaries().sort((a, b) => a.id.localeCompare(b.id)),
    roots: tree.roots().map((n) => (n.kind === 'leaf' ? `leaf:${n.chunkId}` : `summary:${n.id}`)),
    ancestors: inputs.chunks.flatMap((c) => [1, 2, 3].map((level) => `${c.id}@${level}=${tree.ancestorAt(c.id, level)?.id ?? '-'}`)),
    layout: renderLayout(inputs, tree, frontier),
  };
}

test('SummaryTree.derive matches a fresh build across appends, reorders and token changes', () => {
  const first = new SummaryTree(fixture());
  const same = nextCompile(fixture());
  const d0 = SummaryTree.derive(first, same);
  assert.ok(d0);
  assert.deepEqual(shape(d0, same), shape(new SummaryTree(same), same));

  const next = nextCompile(fixture());
  // Tail slid: c8 is now listed before c9's block; two new ownerless leaves; c9 grew.
  const c8 = next.chunks.splice(8, 1)[0]!;
  next.chunks.splice(6, 0, c8);
  for (const c of next.chunks) if (c.id === 'c9') c.rawTokens = 400;
  next.chunks.push(
    { id: 'c10', sequence: 10, rawTokens: 60, currentResolution: 0, lockedByAgent: false, pinned: true, l1Id: undefined },
    { id: 'c11', sequence: 11, rawTokens: 61, currentResolution: 0, lockedByAgent: false, pinned: true, l1Id: undefined },
  );
  const d1 = SummaryTree.derive(first, next);
  assert.ok(d1);
  assert.deepEqual(shape(d1, next), shape(new SummaryTree(next), next));
  assert.equal(d1.summary([...next.summaries.keys()][0]), first.summary([...next.summaries.keys()][0]));

  const third = nextCompile(next);
  third.chunks.push({ id: 'c12', sequence: 12, rawTokens: 5, currentResolution: 0, lockedByAgent: false, pinned: true, l1Id: undefined });
  const d2 = SummaryTree.derive(d1, third);
  assert.ok(d2);
  assert.deepEqual(shape(d2, third), shape(new SummaryTree(third), third));
});

test('SummaryTree.derive declines structural changes and extends ownership additions', () => {
  const first = new SummaryTree(fixture());
  const declined: Array<[string, (next: PickerInputs) => void]> = [
    ['recall change', (next) => { (next.recallPairTokens as Map<string, number>).set([...next.summaries.keys()][0], 1); }],
    ['sourceIds change', (next) => { const e = [...next.summaries.values()].find((s) => s.level === 1)!; e.sourceIds[0] = 'c9'; }],
    ['leaf removed', (next) => { next.chunks.pop(); }],
    ['sequence change', (next) => { next.chunks[0]!.sequence = 99; }],
    ['owner changed', (next) => { next.chunks.find((c) => c.id === 'c0')!.l1Id = [...next.summaries.keys()][1]; }],
  ];
  for (const [name, mutate] of declined) {
    const next = nextCompile(fixture());
    mutate(next);
    assert.equal(SummaryTree.derive(first, next), null, name);
  }
  const extended: Array<[string, (next: PickerInputs) => void]> = [
    ['new L1 link', (next) => { next.chunks.find((c) => c.id === 'c6')!.l1Id = [...next.summaries.keys()][0]; }],
    ['parent change', (next) => { const e = [...next.summaries.values()].find((s) => s.level === 1)!; (e as { parentId?: string }).parentId = undefined; }],
    ['appended with owner', (next) => { next.chunks.push({ id: 'c10', sequence: 10, rawTokens: 5, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: [...next.summaries.keys()][0] }); }],
  ];
  for (const [name, mutate] of extended) {
    const next = nextCompile(fixture());
    mutate(next);
    const derived = SummaryTree.derive(first, next);
    assert.ok(derived, name);
    assert.deepEqual(shape(derived, next), shape(new SummaryTree(next), next), name);
  }
});

// The chronicle's own objects: entries and chunks it updates in place.
function live(chronicle: MockChronicle, tail: string[] = []): PickerInputs {
  return {
    chunks: [...chronicle.chunks], summaries: new Map(chronicle.summaries),
    recallPairTokens: new Map(chronicle.recallPairTokens), headTokens: 0, tailTokens: 0,
    headChunkIds: new Set(), tailChunkIds: new Set(tail),
  };
}

test('SummaryTree.derive extends for an added L1 and an upper summary re-parenting children in place', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 55 });
  for (let i = 0; i < 10; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 90 + i });
  const a = chronicle.produceL1(['c0', 'c1', 'c2']);
  const b = chronicle.produceL1(['c3', 'c4', 'c5']);
  const first = new SummaryTree(live(chronicle));
  const upper = chronicle.produceUpper(2, [a.id, b.id]);
  assert.equal(a.parentId, upper.id);
  const c = chronicle.produceL1(['c6', 'c7']);
  const next = live(chronicle, ['c9']);
  const derived = SummaryTree.derive(first, next);
  assert.ok(derived);
  assert.deepEqual(shape(derived, next), shape(new SummaryTree(next), next));
  assert.equal(derived.ancestorAt('c6', 1)?.id, c.id);
  assert.equal(derived.ancestorAt('c0', 2)?.id, upper.id);
  chronicle.addChunk({ id: 'c10', rawTokens: 12 });
  chronicle.produceL1(['c8', 'c9', 'c10']);
  const again = SummaryTree.derive(derived, live(chronicle, ['c10']));
  assert.ok(again);
  assert.deepEqual(shape(again, live(chronicle, ['c10'])), shape(new SummaryTree(live(chronicle, ['c10'])), live(chronicle, ['c10'])));
});

test('SummaryTree.derive extensions match a fresh build over random evolutions', () => {
  let seed = 0x2545f491;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (n: number): number => Math.floor(random() * n);
  let derivations = 0;
  for (let round = 0; round < 60; round++) {
    const chronicle = new MockChronicle({ recallPairTokens: 40 + pick(30) });
    let nextId = 0;
    const add = (): void => { chronicle.addChunk({ id: `m${nextId}`, rawTokens: 20 + pick(200) }); nextId++; };
    for (let i = 0, n = 4 + pick(8); i < n; i++) add();
    let tail: string[] = [];
    let previous = new SummaryTree(nextCompile(live(chronicle, tail)));
    for (let step = 0; step < 7; step++) {
      switch (pick(5)) {
        case 0: for (let i = 0, n = 1 + pick(3); i < n; i++) add(); break;
        case 1: {
          const free = chronicle.chunks.filter((chunk) => chunk.l1Id === undefined);
          if (free.length < 2) break;
          const start = pick(free.length - 1);
          chronicle.produceL1(free.slice(start, start + 2 + pick(free.length - start - 1)).map((chunk) => chunk.id));
          break;
        }
        case 2: case 3: {
          const level = 2 + pick(2);
          const orphans = [...chronicle.summaries.values()].filter((s) => s.level === level - 1 && !s.parentId);
          if (orphans.length < 2) break;
          const start = pick(orphans.length - 1);
          chronicle.produceUpper(level, orphans.slice(start, start + 2 + pick(Math.min(2, orphans.length - start - 1))).map((s) => s.id));
          break;
        }
        case 4: { const chunk = chronicle.chunks[pick(chronicle.chunks.length)]; chunk.rawTokens += 1 + pick(50); break; }
      }
      const inputs = nextCompile(live(chronicle, tail));
      const fresh = new SummaryTree(inputs);
      const derived = SummaryTree.derive(previous, inputs);
      if (derived) derivations++;
      const next = derived ?? fresh;
      assert.deepEqual(shape(next, inputs), shape(fresh, inputs), `round ${round} step ${step}`);
      previous = next;
    }
  }
  assert.ok(derivations > 300, `derivations ${derivations}`);
});

// A derived tree is either a fresh build or null.
function freshOrDeclined(derived: SummaryTree | null, inputs: PickerInputs): void {
  if (derived) assert.deepEqual(shape(derived, inputs), shape(new SummaryTree(inputs), inputs));
}

test('SummaryTree.derive does not keep coverage computed while a source was missing', () => {
  // An upper summary whose L1 source arrives after the tree was built.
  const chronicle = new MockChronicle({ recallPairTokens: 10 });
  chronicle.addChunk({ id: 'a', rawTokens: 100 });
  const s = chronicle.produceL1(['a']);
  chronicle.produceUpper(2, [s.id]);
  const after = nextCompile(live(chronicle));
  const before = nextCompile(after);
  (before.summaries as Map<string, unknown>).delete(s.id);
  before.chunks[0].l1Id = undefined;
  freshOrDeclined(SummaryTree.derive(new SummaryTree(before), after), after);
  // An L1 listing a chunk that arrives after the tree was built.
  const other = new MockChronicle({ recallPairTokens: 10 });
  other.addChunk({ id: 'a', rawTokens: 100 });
  other.addChunk({ id: 'b', rawTokens: 100 });
  other.produceL1(['a', 'b']);
  const whole = nextCompile(live(other));
  const missing = nextCompile(whole);
  missing.chunks.pop();
  freshOrDeclined(SummaryTree.derive(new SummaryTree(missing), whole), whole);
});
