/**
 * End-to-end: BestFitStrategy driven through the real Picker.run loop.
 *
 * Asserts the strategy walks the picker to exactly the solver's target frontier
 * (no picker change), the result fits the budget, and a second compile at a
 * larger budget self-adjusts (un-folds) through the picker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import type { FoldingBudget, ChunkId } from '../../src/adaptive/folding-strategy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { ValueFunction } from '../../src/adaptive/value-function.js';
import { solveStableFrontier } from '../../src/adaptive/stable-frontier.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { BestFitStrategy } from '../../src/adaptive/strategies/best-fit.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

const BUDGET = (totalBudget: number, slack = 0.1): FoldingBudget => ({
  totalBudget,
  targetBudget: totalBudget * (1 - slack),
  slack,
});

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks,
    summaries: ch.summaries,
    recallPairTokens: ch.recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
}

function sameMap(a: ReadonlyMap<ChunkId, number>, b: ReadonlyMap<ChunkId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

test('best-fit strategy: picker walks to exactly the solver target', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const value = new ValueFunction(35, { recencyHalfLifeChunks: 8 });
  const budget = BUDGET(12_000); // targetBudget 10_800

  // Independent reference target.
  const target = solveStableFrontier(inputs, tree, {
    previous: new Map(), // F_prev = all raw (chunks start at resolution 0)
    budgetTokens: budget.targetBudget,
    value,
    lambda: 0.01,
  }).resolutions;

  const strategy = new BestFitStrategy(inputs, { value, lambda: 0.01 });
  const result = new Picker(strategy).run(inputs, budget);

  assert.ok(sameMap(result.finalResolutions, target), 'picker reaches the solver target');
  assert.ok(result.finalTokens <= budget.targetBudget, `fits budget: ${result.finalTokens} ≤ 10800`);
  // Picker's own token count matches the render-offset model for that frontier.
  assert.equal(renderLayout(inputs, tree, result.finalResolutions).totalTokens, result.finalTokens);
});

test('best-fit strategy: second compile at a larger budget un-folds (self-adjust)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const value = new ValueFunction(35, { recencyHalfLifeChunks: 8 });

  // Compile 1: tight budget → folds down.
  const r1 = new Picker(new BestFitStrategy(inputs, { value, lambda: 0.01 })).run(inputs, BUDGET(6_000));
  ch.applyResolutions(r1.finalResolutions); // commit, as a real host would

  // Compile 2: much larger budget, F_prev = committed r1 → should grow.
  const r2 = new Picker(new BestFitStrategy(inputs, { value, lambda: 0.01 })).run(inputs, BUDGET(30_000));

  assert.ok(r2.finalTokens > r1.finalTokens, `self-adjust up: ${r2.finalTokens} > ${r1.finalTokens}`);
  assert.ok(r2.finalTokens <= BUDGET(30_000).targetBudget, 'within the larger budget');
});

test('best-fit strategy: budget ≥ all-raw leaves everything raw (no needless folding)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const value = new ValueFunction(11, { recencyHalfLifeChunks: 8 });
  const result = new Picker(new BestFitStrategy(inputs, { value, lambda: 0.01 })).run(inputs, BUDGET(1_000_000));

  assert.ok([...result.finalResolutions.values()].every((lvl) => lvl === 0), 'all raw');
  assert.equal(result.applied.length, 0, 'no ops needed');
});
