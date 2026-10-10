/**
 * Phase C un-folds by youngest POSITION, not deepest level.
 *
 * Reproduces the flap measured on Fable (fold-diff, 2026-10-07..09): after
 * the budget-forced fold, the old walk spent the remaining headroom by raising
 * the youngest DEEP group (right after the deep band — a ~300k-token front
 * edit) before any L1 at the seam. Now headroom is spent at the seam: the
 * deep groups are intact and the only raw content is the youngest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

// 216 chunks = 6 L3 / 36 L2 / 216 L1 groups-of-6 (harness chain). 50 raw
// tokens per chunk, 100 per recall pair: a raw group costs 300, its L1 100
// (un-fold quantum +200 at the seam); an L2 over 36 chunks costs 100 against
// six L1s at 600 (un-fold quantum +500 at the deep end) — both quanta fit the
// headroom, as on Fable (L3→L2 ≈ +14k, L1→raw ≈ +12k, headroom ≈ 38k).
function setup() {
  const ch = buildChronicleWithChain({ chunkCount: 216, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const tail = new Set(ch.chunks.slice(210).map((c) => c.id)); // raw tail: last 6
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  const ids = (a: number, b: number): ChunkId[] => ch.chunks.slice(a, b).map((c) => c.id);
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  return { ch, inputs, tree, ids, now, tail };
}

function plan(s: ReturnType<typeof setup>, target: number, W: number) {
  return planControlledFrontier(s.inputs, s.tree, {
    previous: new Map(), foldAtTokens: W, expandAtTokens: target, targetTokens: target,
    windowTokens: W, rawZone: s.tail, now: s.now, mergeThreshold: 6,
  });
}

const histogram = (F: ReadonlyMap<ChunkId, number>, ids: ChunkId[]): Record<number, number> => {
  const h: Record<number, number> = {};
  for (const id of ids) { const l = F.get(id) ?? 0; h[l] = (h[l] ?? 0) + 1; }
  return h;
};

test('phase C spends headroom at the seam: deep groups intact, youngest foldable group raw', () => {
  const s = setup();
  // All 35 foldable L1 groups = 3500 + tail 300 = 3800 > target 3650, so the
  // cut deepens the oldest L2 group (−500) → 3300. Headroom 350: the old walk
  // raised that L2 group first (+500 → 3800, closer than 3300, accepted) — the
  // front edit. By position, two seam groups open instead (+200, +200 → 3700)
  // and the L2 group is never touched.
  const p = plan(s, 3650, 4200);
  const middle = s.ids(0, 210);
  const h = histogram(p.resolutions, middle);
  assert.equal(h[2], 36, `the deep L2 group is intact: ${JSON.stringify(h)}`);
  assert.ok(s.ids(198, 210).every((id) => (p.resolutions.get(id) ?? 0) === 0), 'two youngest foldable groups are raw');
  assert.ok(s.ids(0, 198).every((id) => (p.resolutions.get(id) ?? 0) >= 1), 'nothing older than the seam is raw');
  assert.equal(p.tokens, 3700);
  assert.equal(renderLayout(s.inputs, s.tree, p.resolutions).totalTokens, p.tokens);
});

test('phase C takes the seam quantum that fits and leaves the deep group alone', () => {
  const s = setup();
  // Same fold state (3300); headroom 250 fits exactly one seam un-fold
  // (3500, 50 short) — a second (3700) or the deep one (3800) would overshoot.
  const p = plan(s, 3550, 4200);
  const h = histogram(p.resolutions, s.ids(0, 210));
  assert.equal(h[2], 36, `the deep L2 group is intact: ${JSON.stringify(h)}`);
  assert.ok(s.ids(204, 210).every((id) => (p.resolutions.get(id) ?? 0) === 0), 'youngest foldable group raw');
  assert.ok(s.ids(0, 204).every((id) => (p.resolutions.get(id) ?? 0) >= 1), 'nothing older is raw');
  assert.equal(p.tokens, 3500);
});
