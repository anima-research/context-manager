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

test('SummaryTree.derive declines ownership changes', () => {
  const first = new SummaryTree(fixture());
  const cases: Array<[string, (next: PickerInputs) => void]> = [
    ['new L1 link', (next) => { next.chunks.find((c) => c.id === 'c6')!.l1Id = [...next.summaries.keys()][0]; }],
    ['parent change', (next) => { const e = [...next.summaries.values()].find((s) => s.level === 1)!; (e as { parentId?: string }).parentId = undefined; }],
    ['recall change', (next) => { (next.recallPairTokens as Map<string, number>).set([...next.summaries.keys()][0], 1); }],
    ['sourceIds change', (next) => { const e = [...next.summaries.values()].find((s) => s.level === 1)!; e.sourceIds[0] = 'c9'; }],
    ['leaf removed', (next) => { next.chunks.pop(); }],
    ['sequence change', (next) => { next.chunks[0]!.sequence = 99; }],
    ['appended with owner', (next) => { next.chunks.push({ id: 'c10', sequence: 10, rawTokens: 5, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: [...next.summaries.keys()][0] }); }],
  ];
  for (const [name, mutate] of cases) {
    const next = nextCompile(fixture());
    mutate(next);
    assert.equal(SummaryTree.derive(first, next), null, name);
  }
});
