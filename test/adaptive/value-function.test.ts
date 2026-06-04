/**
 * Tests for the best-fit value function (recency × salience weighting).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { ValueFunction } from '../../src/adaptive/value-function.js';
import { MockChronicle, buildChronicleWithChain } from './harness.js';

const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

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

test('value: newest weight is 1, decays by half-life, floored by minWeight', () => {
  const vf = new ValueFunction(10, { recencyHalfLifeChunks: 5, minWeight: 0.01 });
  assert.ok(approx(vf.weight(10), 1), 'newest (age 0) → 1');
  assert.ok(approx(vf.weight(5), 0.5), 'age 5 = one half-life → 0.5');
  assert.ok(approx(vf.weight(0), 0.25), 'age 10 = two half-lives → 0.25');

  const floored = new ValueFunction(10, { recencyHalfLifeChunks: 5, minWeight: 0.3 });
  assert.ok(approx(floored.weight(0), 0.3), 'floored at minWeight');
});

test('value: salience hook multiplies the recency weight', () => {
  const vf = new ValueFunction(10, {
    recencyHalfLifeChunks: 50,
    salience: (seq) => (seq === 5 ? 10 : 1),
  });
  // seq 5 is older than seq 6, but its 10× salience must dominate.
  assert.ok(vf.weight(5) > vf.weight(6), 'salience can outweigh recency');
  assert.ok(approx(vf.weight(5), Math.pow(0.5, 5 / 50) * 10), 'weight = recency × salience');
  assert.ok(approx(vf.weight(6), Math.pow(0.5, 4 / 50) * 1), 'unsalient chunk = recency only');
});

test('value: nodeValue = weight × rendered tokens; summary uses mean leaf weight', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 6, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const tree = new SummaryTree(inputsOf(ch));
  const vf = new ValueFunction(5, { recencyHalfLifeChunks: 8 });

  const leaf = tree.leaf('c-0005')!; // newest leaf
  assert.ok(approx(vf.nodeValue(leaf, tree), vf.weight(5) * 1000));

  const l1 = tree.summary('L1-0')!; // covers c0..c5
  let meanW = 0;
  for (let s = 0; s <= 5; s++) meanW += vf.weight(s);
  meanW /= 6;
  assert.ok(approx(vf.nodeValue(l1, tree), meanW * 200), 'summary value = mean leaf weight × recall tokens');
});

test('value: default half-life scales with history — old content is not floored', () => {
  // No explicit half-life → fraction 0.25 of history. The oldest chunk's weight
  // is history-INDEPENDENT and well above the floor (0.5^(1/0.25) = 0.0625), so
  // the solver still values un-folding old content and surplus budget can fill.
  const short = new ValueFunction(99); // 100-chunk history
  const long = new ValueFunction(9999); // 10000-chunk history
  assert.ok(approx(short.weight(0), 0.0625, 1e-6), 'oldest weight = 0.5^4');
  assert.ok(approx(long.weight(0), 0.0625, 1e-6), 'same regardless of history length');
  assert.ok(short.weight(0) > 0.01, 'not floored to minWeight');

  // The absolute override keeps the old (floor-prone) behavior for callers that
  // ask for it — an absolute 50-chunk half-life floors very old content.
  const abs = new ValueFunction(9999, { recencyHalfLifeChunks: 50, minWeight: 0.01 });
  assert.ok(abs.weight(0) <= 0.01 + 1e-9, 'absolute half-life floors old content on a long history');
});
