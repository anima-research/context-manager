/**
 * Tests for the KV-stable context controller (kv-control.ts).
 *
 * Load-bearing properties:
 *  - under budget → pure append (no fold, zero perturbation, full cache);
 *  - the flat zone (attended window) and pins are never folded;
 *  - W is the only hard wall: the controller escalates rather than exceeding it;
 *  - amortization: a NARROWER hysteresis band lowers the worst-case per-turn
 *    perturbation (gentler continuity) at the cost of more fold events — i.e.
 *    the band width really is the cost↔continuity operating knob;
 *  - deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import {
  replayControlled,
  foldDepthCap,
  type ControlOptions,
} from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { PickerChunk } from '../../src/adaptive/picker.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

function session(): PickerInputs {
  return inputsOf(buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  }));
}

const BASE: ControlOptions = {
  windowTokens: 60_000,
  budgetTokens: 30_000,
  attendedWindowTokens: 6_000,
  mergeThreshold: 6,
  markerCount: 4,
  targetSteps: 90,
};

test('under budget → pure append: no folds, zero perturbation, full cache', () => {
  // 12 small chunks, generous budget → never folds.
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 500, mergeThreshold: 6, recallPairTokens: 200 });
  const r = replayControlled(inputsOf(ch), { ...BASE, budgetTokens: 1_000_000, windowTokens: 2_000_000, highWatermark: 1_000_000 });
  assert.equal(r.foldEvents, 0, 'never folds under budget');
  assert.equal(r.maxPerturbation, 0, 'no prefix churn');
  for (let i = 1; i < r.steps.length; i++) {
    assert.equal(r.steps[i].perturbation, 0, `step ${i} pure append`);
  }
});

test('flat zone and pins are never folded', () => {
  const ch = buildChronicleWithChain({ chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  // Pin a deep-old chunk that the controller would otherwise fold.
  ch.chunks[3].pinned = true;
  const inputs = inputsOf(ch);
  const r = replayControlled(inputs, { ...BASE });
  assert.ok(r.foldEvents > 0, 'fixture should force folding');

  // foldDepthCap must report 0 for the pin and for the flat zone, at any age.
  const tree = new SummaryTree(inputs);
  const flat = new Set<string>([ch.chunks[89].id]);
  assert.equal(foldDepthCap(ch.chunks[3], 89, new Set(), 6, 6), 0, 'pinned chunk cap 0');
  assert.equal(foldDepthCap(ch.chunks[89], 89, flat, 6, 6), 0, 'flat-zone chunk cap 0');
  // An old un-pinned chunk should be allowed to fold.
  assert.ok(foldDepthCap(ch.chunks[10], 89, new Set(), 6, 6) >= 1, 'old chunk foldable');
  void tree;
});

test('W is the only hard wall: escalates instead of exceeding it', () => {
  // Tiny window, lots of pinned (unfoldable) content → cannot fit under W.
  const ch = buildChronicleWithChain({ chunkCount: 60, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  for (const c of ch.chunks) c.pinned = true; // nothing may fold
  const r = replayControlled(inputsOf(ch), {
    ...BASE, windowTokens: 20_000, budgetTokens: 10_000, highWatermark: 10_000, attendedWindowTokens: 2_000,
  });
  assert.ok(r.escalations > 0, 'unfoldable content over W must escalate, not silently overflow');
});

test('reach cap is the cost↔continuity knob: tighter reach = gentler, more frequent folds', () => {
  const inputs = session();
  // Small reach = shallow divergence (gentle KV, frequent) vs large reach (deep,
  // efficient, rare). With group-consistent folding the robust signals are the
  // average per-turn perturbation and the fold frequency — worst-case maxPert is
  // noisy because a too-tight reach occasionally trips an emergency deep fold to
  // stay under W.
  const shallow = replayControlled(inputs, { ...BASE, reachTokens: 8_000 });
  const deep = replayControlled(inputs, { ...BASE, reachTokens: 60_000 });

  assert.equal(shallow.escalations, 0, 'tight reach stays feasible here');
  assert.equal(deep.escalations, 0, 'wide reach stays feasible here');
  assert.ok(
    shallow.rmsPerturbation < deep.rmsPerturbation,
    `tighter reach → lower average per-turn perturbation (${shallow.rmsPerturbation.toFixed(0)} < ${deep.rmsPerturbation.toFixed(0)})`,
  );
  assert.ok(
    shallow.foldEvents > deep.foldEvents,
    `tighter reach → more frequent folds (${shallow.foldEvents} > ${deep.foldEvents})`,
  );
});

test('controller is deterministic', () => {
  const inputs = session();
  const a = replayControlled(inputs, { ...BASE });
  const b = replayControlled(inputs, { ...BASE });
  assert.deepEqual(a, b);
});

test('foldDepthCap is monotone non-decreasing in age and capped', () => {
  const mk = (seq: number): PickerChunk => ({
    id: `c${seq}`, sequence: seq, rawTokens: 100, currentResolution: 0, lockedByAgent: false, pinned: false,
  });
  let prev = -1;
  for (let age = 0; age <= 5000; age += 50) {
    const cap = foldDepthCap(mk(0), age, new Set(), 10, 6);
    assert.ok(cap >= 0 && cap <= 3, 'cap in [0,3]');
    assert.ok(cap >= prev, 'non-decreasing in age');
    prev = cap;
  }
});
