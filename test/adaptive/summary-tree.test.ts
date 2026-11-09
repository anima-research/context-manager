/**
 * Tests for SummaryTree — the structural view the V2 best-fit DP walks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { SummaryEntry } from '../../src/types/strategy.js';
import { SummaryTree, nodeTokens } from '../../src/adaptive/summary-tree.js';
import { MockChronicle, buildChronicleWithChain } from './harness.js';

function inputsOf(chronicle: MockChronicle): PickerInputs {
  const ht = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 0 });
  return {
    chunks: chronicle.chunks,
    summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens,
    ...ht,
  };
}

test('summary-tree: two L1s, no L2 — roots are the L1 summaries', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const tree = new SummaryTree(inputsOf(ch));

  assert.equal(tree.ancestorAt('c-0000', 1)?.id, 'L1-0');
  assert.equal(tree.ancestorAt('c-0000', 2), null, 'no L2 produced');
  assert.equal(tree.maxLevel('c-0000'), 1);
  assert.deepEqual(tree.leavesUnder('L1-0'), [
    'c-0000', 'c-0001', 'c-0002', 'c-0003', 'c-0004', 'c-0005',
  ]);
  assert.equal(tree.recallTokens('L1-0'), 200);

  const roots = tree.roots();
  assert.deepEqual(
    roots.map((r) => (r.kind === 'summary' ? r.id : r.chunkId)),
    ['L1-0', 'L1-1'],
  );

  const l1 = tree.summary('L1-0')!;
  const kids = tree.children(l1);
  assert.equal(kids.length, 6);
  assert.ok(kids.every((k) => k.kind === 'leaf'));
  assert.equal(nodeTokens(l1), 200);
  assert.equal(nodeTokens(kids[0]), 100);
});

test('summary-tree: full L1→L2 chain — single L2 root with summary children', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 36,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const tree = new SummaryTree(inputsOf(ch));

  assert.equal(tree.ancestorAt('c-0000', 1)?.id, 'L1-0');
  assert.equal(tree.ancestorAt('c-0000', 2)?.id, 'L2-0');
  assert.equal(tree.maxLevel('c-0000'), 2);

  const roots = tree.roots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].kind, 'summary');
  assert.equal((roots[0] as { id: string }).id, 'L2-0');
  assert.equal(tree.leavesUnder('L2-0').length, 36);

  const kids = tree.children(tree.summary('L2-0')!);
  assert.equal(kids.length, 6);
  assert.ok(kids.every((k) => k.kind === 'summary'));
});

test('summary-tree: an uncovered leaf is its own root at level 0', () => {
  const ch = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 200 });
  ch.addChunk({ id: 'a', rawTokens: 100 });
  ch.addChunk({ id: 'b', rawTokens: 100 });
  ch.produceL1(['a']); // only 'a' is covered
  const tree = new SummaryTree(inputsOf(ch));

  assert.equal(tree.maxLevel('b'), 0);
  assert.equal(tree.ancestorAt('b', 1), null);

  const rootKeys = tree.roots().map((r) => (r.kind === 'summary' ? r.id : r.chunkId));
  assert.deepEqual(rootKeys, ['L1-0', 'b']); // ordered by source sequence
});

// Hand-built stores: each chunk's L1 and each summary's sources and parent as
// given, as store surgery or a summary written again can leave them.
function handBuilt(chunks: Array<[id: string, l1Id?: string]>, summaries: SummaryEntry[]): SummaryTree {
  return new SummaryTree({
    chunks: chunks.map(([id, l1Id], sequence) => ({
      id, sequence, rawTokens: 100, currentResolution: 0, lockedByAgent: false, pinned: false, ...(l1Id ? { l1Id } : {}),
    })),
    summaries: new Map(summaries.map((s) => [s.id, s])),
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  });
}
function entry(id: string, level: number, sourceIds: string[], parentId?: string): SummaryEntry {
  return {
    id, level, sourceLevel: level - 1, sourceIds, tokens: 10, content: id, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! },
    ...(parentId ? { parentId } : {}),
  };
}

// #194's store: x under N1 and y under N2, and both name M as their parent,
// but M was written again from N1 alone.
test('summary-tree: a summary on a chunk\'s lineage that doesn\'t list the chunk isn\'t its summary there', () => {
  const tree = handBuilt([['x', 'N1'], ['y', 'N2']], [
    entry('N1', 1, ['x'], 'M'), entry('N2', 1, ['y'], 'M'), entry('M', 2, ['N1']),
  ]);
  assert.equal(tree.ancestorAt('x', 2)?.id, 'M');
  assert.equal(tree.ancestorAt('y', 1)?.id, 'N2');
  assert.equal(tree.ancestorAt('y', 2), null, 'M doesn\'t list y');
  assert.equal(tree.maxLevel('y'), 1);
  assert.equal(tree.maxLevel('x'), 2);
});

// v's L1 N lists v, but y's names N too, and N doesn't list y. M, N's parent,
// doesn't list y either.
test('summary-tree: a chunk\'s L1 that doesn\'t list it isn\'t its summary at any level', () => {
  const tree = handBuilt([['y', 'N'], ['v', 'N']], [entry('N', 1, ['v'], 'M'), entry('M', 2, ['N'])]);
  assert.equal(tree.ancestorAt('v', 2)?.id, 'M');
  assert.equal(tree.ancestorAt('y', 1), null);
  assert.equal(tree.ancestorAt('y', 2), null);
  assert.equal(tree.maxLevel('y'), 0);
});

// L1-0 names R, an L2 written from L1-1 alone, while T, the L3 above R,
// lists L1-0 through its other source Q. Past R, x's lineage reaches T, which
// lists x, so x renders at L3 through T, though not at L2 through R.
test('summary-tree: past a summary that doesn\'t list the chunk, its lineage can reach one that does', () => {
  const tree = handBuilt([['x', 'L1-0'], ['w', 'L1-1']], [
    entry('L1-0', 1, ['x'], 'R'), entry('L1-1', 1, ['w'], 'R'), entry('R', 2, ['L1-1'], 'T'),
    entry('Q', 2, ['L1-0']), entry('T', 3, ['R', 'Q']),
  ]);
  assert.equal(tree.ancestorAt('x', 2), null);
  assert.equal(tree.ancestorAt('x', 3)?.id, 'T');
  assert.equal(tree.maxLevel('x'), 3);
  assert.equal(tree.renderableLevel('x', 2), 1);
});

// T is x's L3, and its parent pointer names Q, an L2 that lists T: a parent
// below its summary. A lineage climbs, so x's ends at T. And z's L1 N names A,
// another L1, as its parent, while B, A's parent, lists N: a parent at its
// summary's own level ends z's lineage at N, so B isn't z's L2.
test('summary-tree: a parent that doesn\'t sit above its summary ends the lineage there', () => {
  const tree = handBuilt([['x', 'N']], [
    entry('N', 1, ['x'], 'P'), entry('P', 2, ['N'], 'T'), entry('T', 3, ['P'], 'Q'), entry('Q', 2, ['T']),
  ]);
  assert.equal(tree.ancestorAt('x', 3)?.id, 'T');
  assert.equal(tree.maxLevel('x'), 3);
  const level = handBuilt([['z', 'N']], [entry('N', 1, ['z'], 'A'), entry('A', 1, ['w'], 'B'), entry('B', 2, ['N'])]);
  assert.equal(level.ancestorAt('z', 2), null, 'A, at N\'s own level, isn\'t N\'s parent');
  assert.equal(level.maxLevel('z'), 1);
});

// y's L1 N2 names T, an L3 that lists N2 directly, so y's lineage skips L2.
test('summary-tree: renderableLevel is the highest level at or below the one asked where the chunk has a summary', () => {
  const tree = handBuilt([['x', 'N1'], ['y', 'N2']], [
    entry('N1', 1, ['x'], 'M'), entry('M', 2, ['N1'], 'T'), entry('N2', 1, ['y'], 'T'), entry('T', 3, ['M', 'N2']),
  ]);
  assert.equal(tree.ancestorAt('y', 2), null);
  assert.deepEqual([-1, 0, 1, 2, 3, 9].map((k) => tree.renderableLevel('y', k)), [0, 0, 1, 1, 3, 3]);
  assert.deepEqual([-1, 0, 1, 2, 3, 9].map((k) => tree.renderableLevel('x', k)), [0, 0, 1, 2, 3, 3]);
});
