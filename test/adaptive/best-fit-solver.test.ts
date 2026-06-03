/**
 * Tests for the best-fit frontier solver (Lagrangian tree-knapsack).
 *
 * Properties asserted:
 *  - budget ≥ all-raw → everything raw (no needless folding);
 *  - tight budget → folds to the top; below the floor → overBudget;
 *  - mid budget folds OLDEST first (recency weighting);
 *  - more budget → fewer tokens folded (bidirectional self-adjust);
 *  - chosen tokens fit the budget and match the render-offset model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { ValueFunction } from '../../src/adaptive/value-function.js';
import { solveFrontier } from '../../src/adaptive/best-fit-solver.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
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

/** 36 chunks @1000t, 6 L1s, 1 L2 (recall 200). minCost = 200, maxCost = 36000. */
function build36(): { inputs: PickerInputs; tree: SummaryTree; value: ValueFunction } {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  return {
    inputs,
    tree: new SummaryTree(inputs),
    value: new ValueFunction(35, { recencyHalfLifeChunks: 8 }),
  };
}

test('solver: budget ≥ all-raw renders everything raw', () => {
  const { tree, value } = build36();
  const r = solveFrontier(tree, { budgetTokens: 1_000_000, value });
  assert.equal(r.overBudget, false);
  assert.equal(r.tokens, 36_000);
  assert.ok([...r.resolutions.values()].every((lvl) => lvl === 0), 'all raw');
});

test('solver: at-floor budget folds to the top; below floor is overBudget', () => {
  const { tree, value } = build36();

  const atFloor = solveFrontier(tree, { budgetTokens: 200, value });
  assert.equal(atFloor.overBudget, false);
  assert.equal(atFloor.tokens, 200, 'one L2 recall');
  assert.ok([...atFloor.resolutions.values()].every((lvl) => lvl === 2), 'all folded to L2');

  const below = solveFrontier(tree, { budgetTokens: 100, value });
  assert.equal(below.overBudget, true, 'cannot fit even fully folded');
});

test('solver: mid budget folds oldest first (recency)', () => {
  const { inputs, tree, value } = build36();
  const r = solveFrontier(tree, { budgetTokens: 12_000, value });

  assert.ok(r.tokens <= 12_000, `tokens ${r.tokens} must fit budget`);
  assert.equal(r.resolutions.get('c-0035'), 0, 'newest stays raw');
  assert.ok((r.resolutions.get('c-0000') ?? 0) > 0, 'oldest is folded');

  // Solver token count must match the render-offset model for this frontier.
  const layout = renderLayout(inputs, tree, r.resolutions);
  assert.equal(layout.totalTokens, r.tokens, 'solver tokens == rendered tokens');
});

test('solver: more budget → finer-or-equal everywhere (bidirectional, no ratchet)', () => {
  const { tree, value } = build36();
  const at = (b: number) => solveFrontier(tree, { budgetTokens: b, value });
  const tight = at(6_000);
  const mid = at(18_000);
  const loose = at(30_000);

  assert.ok(
    tight.tokens <= mid.tokens && mid.tokens <= loose.tokens,
    `monotone fill: ${tight.tokens} ≤ ${mid.tokens} ≤ ${loose.tokens}`,
  );
  assert.ok(tight.tokens <= 6_000 && mid.tokens <= 18_000 && loose.tokens <= 30_000, 'each fits its budget');

  // No ratchet: raising the budget never coarsens any chunk's resolution.
  for (const id of tight.resolutions.keys()) {
    const a = tight.resolutions.get(id)!;
    const b = mid.resolutions.get(id)!;
    const c = loose.resolutions.get(id)!;
    assert.ok(b <= a, `more budget never coarsens ${id}: ${b} ≤ ${a}`);
    assert.ok(c <= b, `more budget never coarsens ${id}: ${c} ≤ ${b}`);
  }
});

test('solver: coarse granularity can under-fill a gap budget (known duality gap)', () => {
  const { tree, value } = build36();
  // With 6-chunk L1s and 200-token recalls, no frontier exists between ~7000
  // (one raw L1 + rest folded) and 200 (the full L2 fold). A 6000 budget falls
  // in that gap, so the solver folds all the way down — it fits, but under-fills.
  // Documents the §11 note: revisit (finer levels / exact bucketized DP) if
  // integration shows this hurting in practice.
  const r = solveFrontier(tree, { budgetTokens: 6_000, value });
  assert.ok(r.tokens <= 6_000, 'still fits the budget');
  assert.ok(r.tokens < 1_000, `gap budget under-fills to ${r.tokens} (≪ 6000)`);
});

test('solver: respects non-foldable chunks (pins stay raw, block collapse)', () => {
  const { tree, value } = build36();
  // Pin the very oldest chunk: even under tight budget it must render raw.
  const pinned: ChunkId = 'c-0000';
  const r = solveFrontier(tree, {
    budgetTokens: 2_000,
    value,
    isFoldable: (id) => id !== pinned,
  });
  assert.equal(r.resolutions.get(pinned), 0, 'pinned oldest chunk stays raw');
});
