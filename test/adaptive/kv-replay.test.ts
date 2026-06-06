/**
 * Tests for session replay (kv-replay.ts) — the flat-profile BASELINE replay.
 *
 * Load-bearing properties:
 *  - deterministic: same inputs → identical ReplayResult;
 *  - growth is monotonic (visible chunks never shrink) and the cold start has
 *    no cache;
 *  - the availability rule holds: never folds a chunk to a level whose summary
 *    couldn't exist yet (lastSequence > now);
 *  - per-step bounds: 0 ≤ recomputed ≤ rendered, hitRate ∈ [0, 1];
 *  - the controller (replayControlled) is no worse than the flat baseline on
 *    average per-turn perturbation under the same budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { replaySession } from '../../src/adaptive/kv-replay.js';
import { replayControlled } from '../../src/adaptive/kv-control.js';
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
  markerCount: 4,
  rawTailTokens: 4_000,
} as const;

test('replay is deterministic', () => {
  const inputs = session();
  assert.deepEqual(replaySession(inputs, COMMON), replaySession(inputs, COMMON));
});

test('growth is monotonic and the cold start has no cache', () => {
  const r = replaySession(session(), COMMON);
  assert.ok(r.steps.length > 1);
  assert.equal(r.steps[0].cachedTokens, 0, 'first step is a cold cache');
  assert.equal(r.steps[0].recomputedTokens, r.steps[0].renderedTokens);
  for (let i = 1; i < r.steps.length; i++) {
    assert.ok(r.steps[i].numChunks >= r.steps[i - 1].numChunks, 'visible chunks never shrink');
    assert.ok(r.steps[i].now >= r.steps[i - 1].now, 'now advances');
  }
});

test('per-step bounds: 0 ≤ recomputed ≤ rendered, hitRate ∈ [0,1]', () => {
  const r = replaySession(session(), COMMON);
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
  const maxAvailableLevel = (now: number): number => {
    let max = 0;
    for (const s of tree.allSummaries()) {
      if (s.lastSequence >= 0 && s.lastSequence <= now && s.level > max) max = s.level;
    }
    return max;
  };

  const r = replaySession(inputs, COMMON);
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

test('controller (kv-stable) is no worse than the flat baseline on average per-turn perturbation', () => {
  const inputs = session();
  const flat = replaySession(inputs, COMMON);
  const kv = replayControlled(inputs, {
    windowTokens: 60_000,
    budgetTokens: COMMON.budgetTokens,
    attendedWindowTokens: COMMON.rawTailTokens,
    markerCount: COMMON.markerCount,
    targetSteps: 120,
  });
  // Per-turn perturbation for the flat baseline (recompute beyond new content).
  const flatRms = (() => {
    let prevNow = -1, sumsq = 0;
    for (const s of flat.steps) {
      const newContent = inputs.chunks
        .filter((c) => c.sequence > prevNow && c.sequence <= s.now)
        .reduce((a, c) => a + c.rawTokens, 0);
      const p = Math.max(0, s.recomputedTokens - newContent);
      sumsq += p * p; prevNow = s.now;
    }
    return Math.sqrt(sumsq / flat.steps.length);
  })();
  assert.ok(
    kv.rmsPerturbation <= flatRms * 1.05,
    `controller RMS perturbation ${kv.rmsPerturbation.toFixed(0)} ≤ flat ${flatRms.toFixed(0)} (×1.05)`,
  );
});
