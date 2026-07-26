/**
 * End-to-end: KvStableStrategy driven through the real Picker.run loop.
 *
 * Asserts the controller policy works as a drop-in FoldingStrategy: the picker
 * walks to exactly the planned frontier, the result fits the budget, pins/locks
 * are honored, and the same `planControlledFrontier` the replay harness measures
 * is what the picker reaches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import type { FoldingBudget, ChunkId } from '../../src/adaptive/folding-strategy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { KvStableStrategy } from '../../src/adaptive/strategies/kv-stable.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

const BUDGET = (totalBudget: number, slack = 0.1): FoldingBudget => ({
  totalBudget,
  targetBudget: totalBudget * (1 - slack),
  slack,
});

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

function sameMap(a: ReadonlyMap<ChunkId, number>, b: ReadonlyMap<ChunkId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

test('kv-stable strategy: picker walks to exactly the planned frontier and fits budget', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 48, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const budget = BUDGET(15_000); // targetBudget 13_500

  // Independent reference plan (same policy the strategy uses internally).
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(), foldAtTokens: budget.totalBudget, expandAtTokens: budget.targetBudget,
    targetTokens: budget.targetBudget, windowTokens: budget.totalBudget, rawZone: new Set(), now, mergeThreshold: 6,
  });

  const strategy = new KvStableStrategy({});
  const result = new Picker(strategy).run(inputs, budget);

  assert.ok(sameMap(result.finalResolutions, plan.resolutions), 'picker reaches the planned frontier');
  assert.ok(result.finalTokens <= budget.totalBudget, `fits hard wall: ${result.finalTokens} ≤ 15000`);
  assert.equal(renderLayout(inputs, tree, result.finalResolutions).totalTokens, result.finalTokens);
});

test('kv-stable strategy: converges to null and leaves a small budget untouched', () => {
  const ch = buildChronicleWithChain({ chunkCount: 8, tokensPerChunk: 500, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch); // 4k raw
  const result = new Picker(new KvStableStrategy({})).run(inputs, BUDGET(100_000));
  for (const c of inputs.chunks) {
    assert.equal(result.finalResolutions.get(c.id), 0, 'nothing folded under a generous budget');
  }
});

test('kv-stable strategy: pinned chunks stay raw, locked chunks keep their resolution', () => {
  const ch = buildChronicleWithChain({ chunkCount: 48, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  ch.chunks[2].pinned = true;                                   // old → would otherwise fold
  ch.chunks[5].lockedByAgent = true; ch.chunks[5].currentResolution = 1; // frozen at L1
  const inputs = inputsOf(ch);
  const result = new Picker(new KvStableStrategy({})).run(inputs, BUDGET(15_000));

  assert.equal(result.finalResolutions.get(ch.chunks[2].id), 0, 'pinned chunk stays raw');
  assert.equal(result.finalResolutions.get(ch.chunks[5].id), 1, 'locked chunk keeps its resolution');
});

test('kv-stable strategy: a tighter reach cap holds the deep prefix raw (shallower divergence)', () => {
  const ch = buildChronicleWithChain({ chunkCount: 60, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const budget = BUDGET(20_000);

  const tight = new Picker(new KvStableStrategy({ reachTokens: 8_000 })).run(inputs, budget);
  const wide = new Picker(new KvStableStrategy({ reachTokens: 60_000 })).run(inputs, budget);

  // Deepest level among the oldest third of chunks: a tight reach can't fold
  // that far back, so the deep prefix stays shallower (more raw) than with wide.
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const oldThird = ordered.slice(0, 20);
  const deepest = (r: typeof tight) => Math.max(...oldThird.map((c) => r.finalResolutions.get(c.id) ?? 0));
  assert.ok(deepest(tight) <= deepest(wide), `tight reach keeps the deep prefix shallower (${deepest(tight)} ≤ ${deepest(wide)})`);
});

test('kv-stable exhausted semantics: a dead-band hold above the soft target is NOT exhausted', () => {
  // 38 chunks × 1000 raw = 38k. Budget 40k / target 36k: fold quanta are
  // whole L1 groups (6k raw → 200), so the closest realizable points to the
  // target are 32.2k and 38k — the solve rests at 38k, inside the (36k, 40k]
  // band: above the soft target, under the wall.
  const ch = buildChronicleWithChain({
    chunkCount: 38, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const result = new Picker(new KvStableStrategy({})).run(inputs, BUDGET(40_000));

  assert.ok(result.finalTokens <= 40_000, 'fits the hard wall');
  assert.ok(result.finalTokens > 36_000, 'test premise: resting above the soft target (dead band)');
  assert.equal(result.budgetMet, false, 'above soft target, so budgetMet=false');
  assert.equal(
    result.exhausted,
    false,
    'a dead-band hold is kv-stable\'s designed resting state — pre-change the generic ' +
      'formula flagged every healthy hold as exhausted',
  );
});

test('kv-stable exhausted semantics: true only when even full folding exceeds the hard wall (escalated)', () => {
  // Deepest available fold is one L2 recall pair (200 tokens) covering all
  // 36 chunks; a 100-token wall is infeasible even fully folded.
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const strategy = new KvStableStrategy({});
  const result = new Picker(strategy).run(inputs, BUDGET(100));

  assert.equal(strategy.lastPlan()?.escalated, true, 'plan reports escalation');
  assert.equal(result.exhausted, true, 'over-the-wall is the one true exhausted state');
  assert.ok(result.finalTokens > 100, 'and the tokens confirm it');
});
