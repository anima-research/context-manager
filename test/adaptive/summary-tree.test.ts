/**
 * Tests for SummaryTree — the structural view the V2 best-fit DP walks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
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
