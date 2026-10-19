/**
 * describeFoldDiff / formatFoldDiff: pure diff of two frontiers over the same
 * picker inputs — runs grouped in source order by (from → to) rendered level,
 * with where the request first changed as the strategy measured it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
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

test('fold-diff: identical frontiers → no moves, and the measured divergence is carried as given', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const f = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), f, f, { offset: 7_000, suffixTokens: 3_000 });
  assert.equal(d.moves, 0);
  assert.deepEqual(d.runs, []);
  assert.equal(d.runsTotal, 0);
  assert.equal(d.divergenceOffset, 7_000);
  assert.equal(d.suffixTokens, 3_000);
  assert.equal(formatFoldDiff(d), '[fold-diff] moves=0 (deepened=0 raised=0) divergence@7k suffix=3k');
});

test('fold-diff: with no earlier compile, the divergence is unknown and the line says so', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const next = new Map<ChunkId, number>(ids(ch, 0, 6).map((id) => [id, 1]));
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), new Map(), next, null);
  assert.equal(d.moves, 6);
  assert.equal(d.divergenceOffset, null);
  assert.equal(d.suffixTokens, null);
  assert.equal(
    formatFoldDiff(d),
    `[fold-diff] moves=6 (deepened=6 raised=0) no earlier compile to compare runs=1: L0→L1×6[${ch.chunks[0].id}..${ch.chunks[5].id}]`,
  );
});

test('fold-diff: runs are grouped by (from→to) in source order', () => {
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

  const d = describeFoldDiff(inputs, tree, prev, next, { offset: 0, suffixTokens: 9_400 });
  assert.equal(d.moves, 24);
  assert.equal(d.deepened, 24);
  assert.equal(d.raised, 0);
  assert.equal(d.runsTotal, 3);
  assert.deepEqual(
    d.runs.map((r) => [r.from, r.to, r.count, r.firstChunkId, r.lastChunkId]),
    [
      [1, 2, 12, ch.chunks[0].id, ch.chunks[11].id],
      [0, 1, 6, ch.chunks[12].id, ch.chunks[17].id],
      [0, 1, 6, ch.chunks[30].id, ch.chunks[35].id],
    ],
  );
  assert.equal(
    formatFoldDiff(d),
    '[fold-diff] moves=24 (deepened=24 raised=0) divergence@0k suffix=9k runs=3: ' +
      `L1→L2×12[${ch.chunks[0].id}..${ch.chunks[11].id}] ` +
      `L0→L1×6[${ch.chunks[12].id}..${ch.chunks[17].id}] ` +
      `L0→L1×6[${ch.chunks[30].id}..${ch.chunks[35].id}]`,
  );
});

test('fold-diff: head and tail chunks never count, even when a map moves them', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const head = ids(ch, 0, 2);
  const tail = ids(ch, 30, 36);
  const inputs = inputsOf(ch, head, tail);
  const next = new Map<ChunkId, number>();
  next.set(head[0], 1);
  next.set(tail[0], 1);
  for (const id of ids(ch, 24, 30)) next.set(id, 1);
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), new Map(), next, null);
  assert.equal(d.moves, 6);
  assert.deepEqual(d.runs.map((r) => [r.firstChunkId, r.lastChunkId]), [[ch.chunks[24].id, ch.chunks[29].id]]);
});

test('fold-diff: raised chunks are counted, and the record keeps the first eight runs of all it counts', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const prev = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const next = new Map<ChunkId, number>(prev);
  // Alternate single chunks raw/L1 to create 18 runs.
  for (let i = 0; i < 36; i += 2) next.set(ch.chunks[i].id, 0);
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), prev, next, null);
  assert.equal(d.moves, 18);
  assert.equal(d.raised, 18);
  assert.equal(d.deepened, 0);
  assert.equal(d.runsTotal, 18);
  assert.deepEqual(d.runs.map((r) => r.firstChunkId), [0, 2, 4, 6, 8, 10, 12, 14].map((i) => ch.chunks[i].id));
  const line = formatFoldDiff(d);
  assert.match(line, /raised=18/);
  assert.match(line, /runs=18: /);
  assert.match(line, new RegExp(`L1→L0×1\\[${ch.chunks[14].id}\\] \\+10 more runs$`));
});

/** The same chronicle's inputs with some chunks pinned and/or locked. */
function withFlags(
  inputs: PickerInputs,
  flags: { pinned?: ChunkId[]; locked?: ChunkId[] },
): PickerInputs {
  const pinned = new Set(flags.pinned ?? []);
  const locked = new Set(flags.locked ?? []);
  return {
    ...inputs,
    chunks: inputs.chunks.map((c) => ({
      ...c,
      pinned: c.pinned || pinned.has(c.id),
      lockedByAgent: c.lockedByAgent || locked.has(c.id),
    })),
  };
}

test('fold-diff: a pinned chunk carried at L1 that the solver puts at 0 is not a move (review repro)', () => {
  // The review's line: `moves=1 (deepened=0 raised=1) … layout unchanged
  // runs=1: L1→L0×1@0k[c-0008]`. The pinned chunk renders raw on both sides,
  // so from and to are both the level it renders at, 0.
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const pinnedId = ch.chunks[8].id;
  const inputs = withFlags(inputsOf(ch), { pinned: [pinnedId] });
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), new Map([[pinnedId, 1]]), new Map(), null);
  assert.equal(d.moves, 0);
  assert.equal(d.raised, 0);
  assert.deepEqual(d.runs, []);
  assert.doesNotMatch(formatFoldDiff(d), new RegExp(pinnedId));
});

test('fold-diff: a level whose summary is missing renders raw and is not a move', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const orphan = ch.chunks[6].id;
  assert.equal(tree.ancestorAt(orphan, 5), null, 'fixture: no L5 exists');
  const d = describeFoldDiff(inputs, tree, new Map(), new Map([[orphan, 5]]), null);
  assert.equal(d.moves, 0);
});

test('fold-diff: locked chunks are skipped in counts and runs, as the commit loop skips them', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const lockedId = ch.chunks[2].id;
  const inputs = withFlags(inputsOf(ch), { locked: [lockedId] });
  // Everything raw → everything at L1. The locked chunk "moves" too in the
  // solver's map, but its carried level is never committed.
  const next = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), new Map(), next, null);
  assert.equal(d.moves, 11);
  assert.deepEqual(
    d.runs.map((r) => [r.firstChunkId, r.lastChunkId, r.count]),
    [
      [ch.chunks[0].id, ch.chunks[1].id, 2],
      [ch.chunks[3].id, ch.chunks[11].id, 9],
    ],
    'the locked chunk splits the run and is not counted',
  );
});

test('fold-diff: a pinned AND locked chunk never reports a phantom move', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const id = ch.chunks[8].id;
  const inputs = withFlags(inputsOf(ch), { pinned: [id], locked: [id] });
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), new Map([[id, 1]]), new Map(), null);
  assert.equal(d.moves, 0);
  assert.deepEqual(d.runs, []);
});
