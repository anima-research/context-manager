import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { foldDepthCap, planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

const id = (i: number): ChunkId => `c-${i.toString().padStart(4, '0')}`;

function misallocatedCarry() {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  ch.chunks[0].pinned = true;
  ch.chunks[1].pinned = true;
  ch.chunks[28].salience = 0.25;
  ch.chunks[29].salience = 0.25;
  const inputs = inputsOf(ch);
  const rawZone = new Set<ChunkId>([id(0), id(1), ...ch.chunks.slice(30).map((c) => c.id)]);
  const previous = new Map<ChunkId, number>(ch.chunks.map((c, i) => [c.id, i >= 24 && i < 30 ? 1 : 0]));
  const params = {
    previous, rawZone, now: 35, mergeThreshold: 6,
    foldAtTokens: 31_000, expandAtTokens: 29_000, targetTokens: 30_000, windowTokens: 40_000,
  };
  return { inputs, tree: new SummaryTree(inputs), params };
}

test('with no quality-gap ratio given, a carried frontier in the band whose loss exceeds the ideal\'s by 0.5 is not held', () => {
  const { inputs, tree, params } = misallocatedCarry();
  const plan = planControlledFrontier(inputs, tree, params);
  assert.ok(plan.perturbation > 0, `the carried frontier is replaced, not held (perturbation ${plan.perturbation})`);
  assert.equal(plan.resolutions.get(id(28)), 0, 'the chunk folded past its cap is raised to it');
  assert.equal(plan.resolutions.get(id(29)), 0, 'and so is its neighbour');
});

test('while a window is prepared (strictReach), the same misallocated carried frontier in the band is held', () => {
  const { inputs, tree, params } = misallocatedCarry();
  const plan = planControlledFrontier(inputs, tree, { ...params, strictReach: true });
  assert.equal(plan.blocked, undefined, 'held in the band, not at the reach floor');
  assert.equal(plan.perturbation, 0, 'nothing is re-read');
  for (const [chunk, level] of params.previous) {
    assert.equal(plan.resolutions.get(chunk), level, `${chunk} keeps its carried level`);
  }
});

test('an ideal over the fold watermark but under W is not escalated', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const plan = planControlledFrontier(inputs, new SummaryTree(inputs), {
    previous: new Map(), rawZone: new Set(ch.chunks.slice(18).map((c) => c.id)), now: 35, mergeThreshold: 6,
    foldAtTokens: 15_000, targetTokens: 15_000, windowTokens: 40_000,
  });
  assert.ok(plan.tokens > 15_000 && plan.tokens <= 40_000, `over the watermark, under W: ${plan.tokens}`);
  assert.equal(plan.escalated, false, 'escalation is for a plan that can\'t fit under W');
});

function overlappingL1s() {
  const ch = buildChronicleWithChain({ chunkCount: 18, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  ch.produceL1([id(2), id(3), id(4)]);
  for (let i = 6; i < 15; i++) ch.chunks[i].salience = 0.5;
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const first = tree.ancestorAt(id(0), 1)!;
  for (const i of [2, 3, 4]) {
    assert.ok(first.leafChunkIds.includes(id(i)) && tree.ancestorAt(id(i), 1)!.id !== first.id, `two L1s over chunk ${i}`);
  }
  const previous = new Map<ChunkId, number>(ch.chunks.map((c, i) => [c.id, i === 0 || i === 1 || i === 5 ? 1 : 0]));
  const params = {
    previous, rawZone: new Set([id(15), id(16), id(17)]), now: 17, mergeThreshold: 6,
    foldAtTokens: 14_000, targetTokens: 12_000, reachTokens: 1_000_000,
  };
  return { inputs, tree, params };
}

test('a plan\'s token count is what its frontier renders, after the projection raises chunks', () => {
  const { inputs, tree, params } = overlappingL1s();
  const plan = planControlledFrontier(inputs, tree, { ...params, windowTokens: 20_000 });
  assert.equal(plan.tokens, renderLayout(inputs, tree, plan.resolutions).totalTokens);
  assert.equal(plan.tokens, 12_200);
});

test('a plan the projection pushes over W is folded again until it fits, when folding can reach it', () => {
  const { inputs, tree, params } = overlappingL1s();
  const plan = planControlledFrontier(inputs, tree, { ...params, windowTokens: 12_000 });
  const rendered = renderLayout(inputs, tree, plan.resolutions).totalTokens;
  assert.ok(rendered <= 12_000, `its frontier renders under W: ${rendered}`);
  assert.equal(plan.escalated, false);
});

function sixGroups() {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const rawZone = new Set(ch.chunks.slice(30).map((c) => c.id));
  return { ch, inputs: inputsOf(ch), rawZone };
}

test('when the shape prior can\'t reach the target but the plan fits under W, nothing folds past the prior', () => {
  const { ch, inputs, rawZone } = sixGroups();
  const plan = planControlledFrontier(inputs, new SummaryTree(inputs), {
    previous: new Map(), rawZone, now: 35, mergeThreshold: 6,
    foldAtTokens: 5_000, targetTokens: 5_000, windowTokens: 40_000,
  });
  assert.ok(plan.tokens > 5_000 && plan.tokens <= 40_000, `over the target, under W: ${plan.tokens}`);
  for (const c of ch.chunks) {
    const cap = foldDepthCap(c, 35, rawZone, rawZone.size, 6, 2);
    assert.equal(plan.resolutions.get(c.id), cap, `${c.id} folds to its shape cap and no further`);
  }
});

test('a from-scratch solve folds the lower-salience group first, then the oldest', () => {
  const { ch, inputs, rawZone } = sixGroups();
  for (let i = 24; i < 30; i++) ch.chunks[i].salience = 0.5;
  const tree = new SummaryTree(inputs);
  for (const [target, folded] of [[33_000, [24]], [26_000, [24, 0]]] as const) {
    const plan = planControlledFrontier(inputs, tree, {
      previous: new Map(), rawZone, now: 35, mergeThreshold: 6,
      foldAtTokens: target, targetTokens: target, windowTokens: 40_000,
    });
    for (let i = 0; i < 36; i++) {
      const expected = (folded as readonly number[]).includes(i - (i % 6)) ? 1 : 0;
      assert.equal(plan.resolutions.get(id(i)), expected, `target ${target}: ${id(i)} at L${expected}`);
    }
  }
});
