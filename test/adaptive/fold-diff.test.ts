/**
 * describeFoldDiff / formatFoldDiff: pure diff of two frontiers over the same
 * picker inputs — runs grouped in source order by (from → to), positioned by
 * the carried layout, divergence priced like kvCost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout, kvCost } from '../../src/adaptive/render-offsets.js';
import { describeFoldDiff, formatFoldDiff } from '../../src/adaptive/fold-diff.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

function inputsOf(ch: MockChronicle, head: ChunkId[] = [], tail: ChunkId[] = []): PickerInputs {
  const headSet = new Set(head);
  const tailSet = new Set(tail);
  const tok = (ids: Set<ChunkId>) =>
    ch.chunks.filter((c) => ids.has(c.id)).reduce((a, c) => a + c.rawTokens, 0);
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: tok(headSet), tailTokens: tok(tailSet), headChunkIds: headSet, tailChunkIds: tailSet,
  };
}

const ids = (ch: MockChronicle, from: number, to: number): ChunkId[] =>
  ch.chunks.slice(from, to).map((c) => c.id);

test('fold-diff: identical frontiers → no moves, no divergence', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const f = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), f, f);
  assert.equal(d.moves, 0);
  assert.equal(d.runs.length, 0);
  assert.equal(d.divergenceOffset, null);
  assert.equal(d.suffixTokens, 0);
  assert.match(formatFoldDiff(d), /moves=0 .*layout unchanged/);
});

test('fold-diff: runs are grouped by (from→to) in source order and priced by the carried layout', () => {
  // 36 chunks: L1s over each 6, L2s over each 36 (chain produced by the harness).
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>();
  const next = new Map<ChunkId, number>();
  // Carried: first 12 chunks at L1 (two recall pairs), the rest raw.
  for (const id of ids(ch, 0, 12)) prev.set(id, 1);
  // Next: first 12 deepen to L2 (one pair), chunks 12..18 fold raw→L1, 30..36 raw→L1.
  for (const id of ids(ch, 0, 12)) next.set(id, 2);
  for (const id of ids(ch, 12, 18)) next.set(id, 1);
  for (const id of ids(ch, 30, 36)) next.set(id, 1);

  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 24);
  assert.equal(d.deepened, 24);
  assert.equal(d.raised, 0);
  assert.deepEqual(
    d.runs.map((r) => [r.from, r.to, r.count, r.firstChunkId, r.lastChunkId]),
    [
      [1, 2, 12, ch.chunks[0].id, ch.chunks[11].id],
      [0, 1, 6, ch.chunks[12].id, ch.chunks[17].id],
      [0, 1, 6, ch.chunks[30].id, ch.chunks[35].id],
    ],
  );
  // Positions come from the CARRIED layout: pair(200) + pair(200) + 24 raw.
  assert.equal(d.runs[0].offsetBefore, 0);
  assert.equal(d.runs[1].offsetBefore, 400);
  assert.equal(d.runs[2].offsetBefore, 400 + 18 * 1000);

  // Divergence/suffix agree with kvCost over the same layouts.
  const prevLayout = renderLayout(inputs, tree, prev);
  const nextLayout = renderLayout(inputs, tree, next);
  assert.equal(d.previousTokens, prevLayout.totalTokens);
  assert.equal(d.nextTokens, nextLayout.totalTokens);
  assert.equal(d.divergenceOffset, 0); // the first unit itself changed (L1 pair → L2 pair)
  assert.equal(d.suffixTokens, kvCost(prevLayout, nextLayout));

  const line = formatFoldDiff(d);
  assert.match(line, /^\[fold-diff\] moves=24 \(deepened=24 raised=0\)/);
  assert.match(line, /runs=3: L1→L2×12@0k\[/);
  assert.match(line, /L0→L1×6@18k\[/);
});

test('fold-diff: a change past a stable prefix prices only the suffix; head/tail never count', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const head = ids(ch, 0, 2);
  const tail = ids(ch, 30, 36);
  const inputs = inputsOf(ch, head, tail);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>();
  const next = new Map<ChunkId, number>();
  // A move inside the head/tail must be ignored even if a map claims it.
  next.set(head[0], 1);
  next.set(tail[0], 1);
  // Real change: chunks 24..30 fold raw→L1 while 2..24 stay raw.
  for (const id of ids(ch, 24, 30)) next.set(id, 1);

  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 6);
  assert.equal(d.runs.length, 1);
  // Carried layout: head(2000) + 22 raw middle chunks → run starts at 24k.
  assert.equal(d.runs[0].offsetBefore, 2000 + 22 * 1000);
  assert.equal(d.divergenceOffset, 2000 + 22 * 1000);
  // Suffix = one recall pair + the 6-chunk raw tail.
  assert.equal(d.suffixTokens, 200 + 6 * 1000);
  assert.equal(d.suffixTokens, kvCost(renderLayout(inputs, tree, prev), renderLayout(inputs, tree, next)));
});

test('fold-diff: raised chunks are counted and formatted; run listing is capped', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const next = new Map<ChunkId, number>(prev);
  // Alternate single chunks raw/L1 to create many runs.
  for (let i = 0; i < 36; i += 2) next.set(ch.chunks[i].id, 0);
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.raised, 18);
  assert.equal(d.deepened, 0);
  assert.equal(d.runs.length, 18);
  const line = formatFoldDiff(d, 4);
  assert.match(line, /raised=18/);
  assert.match(line, /\+14 more runs/);
});
