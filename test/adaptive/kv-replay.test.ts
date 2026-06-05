/**
 * Tests for session replay + KV-stability measurement (kv-replay.ts).
 *
 * Load-bearing properties:
 *  - deterministic: same inputs → identical ReplayResult;
 *  - growth is monotonic (visible chunks never shrink) and the cold start has
 *    no cache;
 *  - the availability rule holds: the replay never folds a chunk to a level
 *    whose summary couldn't exist yet (lastSequence > now);
 *  - per-step bounds: 0 ≤ recomputed ≤ rendered, hitRate ∈ [0, 1];
 *  - the stability claim: under a fixed cap that forces folding, the λ-stable
 *    replay recomputes no more than the naive (λ=0) re-solve, i.e. it preserves
 *    at least as much provider cache.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { replaySession, type ReplayResult } from '../../src/adaptive/kv-replay.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';

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

/** A session big enough that a fixed cap forces folding partway through. */
function session(): PickerInputs {
  const ch = buildChronicleWithChain({
    chunkCount: 72, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  return inputsOf(ch);
}

const COMMON = {
  budgetTokens: 24_000, // 72k raw will blow past this → folding kicks in
  valueOptions: { recencyHalfLifeFraction: 0.3, minWeight: 0.05 },
  markerCount: 4,
  rawTailTokens: 4_000,
  smoothness: 1,
} as const;

test('replay is deterministic', () => {
  const inputs = session();
  const a = replaySession(inputs, { ...COMMON, lambda: 1 });
  const b = replaySession(inputs, { ...COMMON, lambda: 1 });
  assert.deepEqual(a, b);
});

test('growth is monotonic and the cold start has no cache', () => {
  const r = replaySession(session(), { ...COMMON, lambda: 1 });
  assert.ok(r.steps.length > 1);
  assert.equal(r.steps[0].cachedTokens, 0, 'first step is a cold cache');
  assert.equal(r.steps[0].recomputedTokens, r.steps[0].renderedTokens);
  for (let i = 1; i < r.steps.length; i++) {
    assert.ok(r.steps[i].numChunks >= r.steps[i - 1].numChunks, 'visible chunks never shrink');
    assert.ok(r.steps[i].now >= r.steps[i - 1].now, 'now advances');
  }
});

test('per-step bounds: 0 ≤ recomputed ≤ rendered, hitRate ∈ [0,1]', () => {
  const r = replaySession(session(), { ...COMMON, lambda: 1 });
  for (const s of r.steps) {
    assert.ok(s.recomputedTokens >= 0 && s.recomputedTokens <= s.renderedTokens, 'recompute in range');
    assert.ok(s.cachedTokens >= 0, 'cached ≥ 0');
    assert.equal(s.cachedTokens + s.recomputedTokens, s.renderedTokens, 'cached + recompute = rendered');
    assert.ok(s.hitRate >= 0 && s.hitRate <= 1, 'hitRate in [0,1]');
  }
  assert.ok(r.overallHitRate >= 0 && r.overallHitRate <= 1);
});

test('availability rule: never folds to a level that does not exist yet', () => {
  const inputs = session();
  const tree = new SummaryTree(inputs);
  // Max summary level whose youngest covered message is ≤ now.
  const maxAvailableLevel = (now: number): number => {
    let max = 0;
    for (const s of tree.allSummaries()) {
      if (s.lastSequence >= 0 && s.lastSequence <= now && s.level > max) max = s.level;
    }
    return max;
  };

  const r = replaySession(inputs, { ...COMMON, lambda: 1 });
  let sawDeep = false;
  for (const s of r.steps) {
    assert.ok(
      s.deepestLevel <= maxAvailableLevel(s.now),
      `step now=${s.now}: folded to L${s.deepestLevel} but only L${maxAvailableLevel(s.now)} available`,
    );
    if (maxAvailableLevel(s.now) >= 2) sawDeep = true;
  }
  assert.ok(sawDeep, 'fixture should expose L2+ summaries by the end');
});

test('stability claim: λ-stable recomputes ≤ naive (λ=0) and caches at least as much', () => {
  const inputs = session();
  const stable: ReplayResult = replaySession(inputs, { ...COMMON, lambda: 1 });
  const naive: ReplayResult = replaySession(inputs, { ...COMMON, lambda: 0 });

  assert.ok(
    stable.totalRecomputed <= naive.totalRecomputed,
    `stable recompute ${stable.totalRecomputed} ≤ naive ${naive.totalRecomputed}`,
  );
  assert.ok(
    stable.overallHitRate >= naive.overallHitRate,
    `stable hit ${stable.overallHitRate.toFixed(3)} ≥ naive ${naive.overallHitRate.toFixed(3)}`,
  );
});
