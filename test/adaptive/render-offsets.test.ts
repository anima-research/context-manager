/**
 * Tests for render-offsets — the rendered-unit layout + KV-cost accounting.
 *
 * Two things matter:
 *  1. `renderLayout().totalTokens` must equal the picker's own computeTokens
 *     model (parity), so the KV term is computed over the real render.
 *  2. KV cost must be position-aware: a change deep in the old prefix costs far
 *     more than a change near the tail — the whole reason for the term.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import { FlatProfileStrategy } from '../../src/adaptive/strategies/flat-profile.js';
import type { FoldingBudget, ChunkId } from '../../src/adaptive/folding-strategy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import {
  renderLayout,
  kvCost,
  earliestDivergenceIndex,
  type RenderedUnit,
} from '../../src/adaptive/render-offsets.js';
import { MockChronicle, buildChronicleWithChain } from './harness.js';

const BUDGET = (totalBudget: number, slack = 0.1): FoldingBudget => ({
  totalBudget,
  targetBudget: totalBudget * (1 - slack),
  slack,
});

function inputsOf(ch: MockChronicle): PickerInputs {
  // Explicit empty head/tail. (computeHeadTail force-includes one tail chunk
  // even at tailTokens:0, which would add the tail block to the recomputed
  // suffix and muddy the position-aware assertion below.)
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

function frontier(ids: ChunkId[], level: number): Map<ChunkId, number> {
  return new Map(ids.map((id): [ChunkId, number] => [id, level]));
}

test('render-offsets: totalTokens matches the picker computeTokens model (parity)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const result = new Picker(new FlatProfileStrategy()).run(inputs, BUDGET(10_000));
  assert.ok(result.moves > 0, 'expected the picker to fold something');

  const tree = new SummaryTree(inputs);
  const layout = renderLayout(inputs, tree, result.finalResolutions);
  assert.equal(layout.totalTokens, result.finalTokens);
});

test('render-offsets: kvCost is zero for an unchanged frontier', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const layout = renderLayout(inputs, tree, new Map());
  assert.equal(kvCost(layout, layout), 0);
});

test('render-offsets: deep-old change costs more than a near-tail change (position-aware)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);

  const allRaw = renderLayout(inputs, tree, new Map());
  const foldOldest = renderLayout(
    inputs, tree,
    frontier(['c-0000', 'c-0001', 'c-0002', 'c-0003', 'c-0004', 'c-0005'], 1),
  );
  const foldNewest = renderLayout(
    inputs, tree,
    frontier(['c-0030', 'c-0031', 'c-0032', 'c-0033', 'c-0034', 'c-0035'], 1),
  );

  const costOld = kvCost(allRaw, foldOldest);
  const costNew = kvCost(allRaw, foldNewest);
  assert.ok(costNew < costOld, `near-tail (${costNew}) must cost less than deep-old (${costOld})`);
  assert.equal(costNew, 200, 'near-tail fold recomputes only the new recall pair');
});

test('render-offsets: earliestDivergenceIndex + kvCost prefix semantics', () => {
  const u = (kind: RenderedUnit['kind'], key: string, tokens: number, offset: number): RenderedUnit =>
    ({ kind, key, tokens, offset });

  const a = [u('head', 'head', 10, 0), u('raw', 'x', 5, 10), u('raw', 'y', 5, 15)];
  const same = [u('head', 'head', 10, 0), u('raw', 'x', 5, 10), u('raw', 'y', 5, 15)];
  assert.equal(earliestDivergenceIndex(a, same), -1);

  const prefix = [u('head', 'head', 10, 0), u('raw', 'x', 5, 10)]; // strict prefix of a
  assert.equal(earliestDivergenceIndex(a, prefix), 2);
  assert.equal(kvCost({ units: a, totalTokens: 20 }, { units: prefix, totalTokens: 15 }), 0);

  const diff = [u('head', 'head', 10, 0), u('raw', 'z', 5, 10), u('raw', 'y', 5, 15)];
  assert.equal(earliestDivergenceIndex(a, diff), 1);
  assert.equal(kvCost({ units: a, totalTokens: 20 }, { units: diff, totalTokens: 20 }), 10); // 20 − offset@1
});
