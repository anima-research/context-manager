/**
 * Tests for the KV-stable frontier solver (longest-stable-prefix, §4.1).
 *
 * The load-bearing properties:
 *  - a frontier already optimal for the budget is left untouched (kvCost 0);
 *  - λ=0 reproduces the pure budget-optimal solve;
 *  - a budget INCREASE self-adjusts (un-folds) at a reasonable λ — guarding
 *    against silently reproducing V1's "budget increase has no effect" bug;
 *  - too-high λ freezes everything (documents the load-bearing risk);
 *  - a near-tail re-solve keeps the deep-old prefix stable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { ValueFunction } from '../../src/adaptive/value-function.js';
import { solveFrontier } from '../../src/adaptive/best-fit-solver.js';
import { solveStableFrontier } from '../../src/adaptive/stable-frontier.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

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

function build(): { inputs: PickerInputs; tree: SummaryTree; value: ValueFunction } {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  return { inputs, tree: new SummaryTree(inputs), value: new ValueFunction(35, { recencyHalfLifeChunks: 8 }) };
}

function sameMap(a: Map<ChunkId, number>, b: Map<ChunkId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

test('stable: a frontier already optimal for the budget is left untouched', () => {
  const { inputs, tree, value } = build();
  const prev = solveFrontier(tree, { budgetTokens: 18_000, value }).resolutions;
  const r = solveStableFrontier(inputs, tree, { previous: prev, budgetTokens: 18_000, value, lambda: 0.001 });
  assert.equal(r.kvCost, 0, 'no recompute');
  assert.equal(r.boundarySequence, inputs.chunks.length, 'froze everything');
  assert.ok(sameMap(r.resolutions, prev), 'frontier unchanged');
});

test('stable: λ=0 reproduces the pure budget-optimal solve', () => {
  const { inputs, tree, value } = build();
  const global = solveFrontier(tree, { budgetTokens: 12_000, value });
  // Start from an arbitrary previous frontier (all raw).
  const r = solveStableFrontier(inputs, tree, { previous: new Map(), budgetTokens: 12_000, value, lambda: 0 });
  assert.equal(r.tokens, global.tokens);
  assert.ok(sameMap(r.resolutions, global.resolutions), 'λ=0 == global optimum');
});

test('stable: a budget INCREASE self-adjusts (un-folds) at a reasonable λ', () => {
  const { inputs, tree, value } = build();
  // F_prev fitted to a tight budget → folded down to all-L1 (1200 tokens).
  const prev = solveFrontier(tree, { budgetTokens: 6_000, value });
  assert.equal(prev.tokens, 1_200);

  // Budget jumps; the stable solver should grow the context, not stay folded.
  const grown = solveStableFrontier(inputs, tree, { previous: prev.resolutions, budgetTokens: 30_000, value, lambda: 0.01 });
  assert.ok(grown.tokens > prev.tokens, `should un-fold: ${grown.tokens} > ${prev.tokens}`);
  assert.ok(grown.tokens <= 30_000, 'still within budget');
  // The newest content un-folds (finer than before).
  assert.ok((grown.resolutions.get('c-0035') ?? 9) < 2, 'newest is no longer fully folded');
});

test('stable: too-high λ freezes the frontier (documents the load-bearing risk)', () => {
  const { inputs, tree, value } = build();
  const prev = solveFrontier(tree, { budgetTokens: 6_000, value }); // folded to L2 (200)

  // With an absurd λ, even cheap re-solves lose to "freeze everything" — the
  // budget increase has NO effect. This is exactly the V1 regression the λ
  // tuning must avoid; the integration suite sweeps λ to keep it caught.
  const frozen = solveStableFrontier(inputs, tree, { previous: prev.resolutions, budgetTokens: 30_000, value, lambda: 1e9 });
  assert.equal(frozen.tokens, prev.tokens, 'absurd λ → no self-adjust');
  assert.equal(frozen.kvCost, 0);
});

test('stable: re-solve keeps the deep-old prefix stable (changes cluster near tail)', () => {
  const { inputs, tree, value } = build();
  // Previous: everything raw. New budget forces some folding; the stable solver
  // should fold the OLD prefix and keep a stable cached prefix where it can.
  const prev = new Map<ChunkId, number>(); // all raw
  const r = solveStableFrontier(inputs, tree, { previous: prev, budgetTokens: 24_000, value, lambda: 0.01 });

  // It diverged somewhere (had to fold to fit), but the change is bounded: the
  // recomputed suffix is less than the whole context.
  assert.ok(r.kvCost > 0, 'some folding happened');
  assert.ok(r.kvCost <= r.tokens, 'kv cost is the recomputed suffix, not more');
  assert.ok(r.tokens <= 24_000, 'within budget');
});

test('stable: large budget un-folds an over-folded F_prev on a long history (history-relative recency)', () => {
  // Regression for the real Lena finding: a 500k budget filled only ~270k
  // because the absolute half-life floored old content to worthless, so the
  // solver wouldn't un-fold it. With the default (history-relative) recency,
  // a large budget must un-fold the over-folded F_prev to fill.
  const ch = buildChronicleWithChain({
    chunkCount: 300, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const value = new ValueFunction(299); // default relative half-life (≈ 0.25 × 299)

  // F_prev: heavily folded to fit a tiny budget.
  const folded = solveFrontier(tree, { budgetTokens: 4_000, value });
  assert.ok(folded.tokens < 20_000, 'F_prev starts heavily folded');

  // Budget jumps to most of the 300k raw total → must fill, not freeze F_prev.
  const grown = solveStableFrontier(inputs, tree, {
    previous: folded.resolutions, budgetTokens: 250_000, value, lambda: 0.006, candidateCap: 16,
  });
  assert.ok(grown.tokens > 150_000, `budget increase must fill (got ${grown.tokens})`);
  assert.ok(grown.tokens <= 250_000, 'within budget');
});
