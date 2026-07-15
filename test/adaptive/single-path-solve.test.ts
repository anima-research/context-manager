/**
 * Rev 5.0 single-path solve (design §13) — regression tests.
 *
 * Load-bearing properties:
 *  - a bootstrap solve (no carried frontier) produces an age-monotone
 *    resolution gradient — the 2026-07-12 mythos inversion (old fine / recent
 *    deep) is unconstructible from scratch;
 *  - an INVERTED carried profile sitting comfortably in the dead band is
 *    detected as a quality gap and self-heals (override 'quality-gap') instead
 *    of fossilizing;
 *  - low-salience chunks fold before equally-aged high-salience ones;
 *  - when the trust region P binds, the solver adopts the ideal's newest
 *    changes only (suffix adoption) with perturbation ≤ P and no override.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

/** 90 chunks × 1000t, base-6 chain (15 L1s, 2 L2s over c-0000..0071). */
function session(): { ch: MockChronicle; inputs: PickerInputs; tree: SummaryTree } {
  const ch = buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  return { ch, inputs, tree: new SummaryTree(inputs) };
}

/** Newest `n` chunk ids (the flat zone / attended tail). */
function tailZone(inputs: PickerInputs, n: number): Set<ChunkId> {
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  return new Set(ordered.slice(-n).map((c) => c.id));
}

/** Assert resolution levels are non-increasing with recency (older ≥ newer). */
function assertAgeMonotone(
  resolutions: ReadonlyMap<ChunkId, number>,
  inputs: PickerInputs,
  skip: ReadonlySet<ChunkId>,
): void {
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  let prevLevel = Number.POSITIVE_INFINITY;
  for (const c of ordered) {
    if (skip.has(c.id)) continue;
    const lvl = resolutions.get(c.id) ?? 0;
    assert.ok(
      lvl <= prevLevel,
      `age-monotone violated at ${c.id}: L${lvl} deeper than older neighbor's L${prevLevel}`,
    );
    prevLevel = lvl;
  }
}

test('bootstrap solve is age-monotone — the inversion is unconstructible from scratch', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 12);
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 30_000, expandAtTokens: 24_000, targetTokens: 24_000,
    windowTokens: 60_000, rawZone, now: 89, mergeThreshold: 6,
  });
  assert.equal(plan.override, 'bootstrap', 'empty F_prev → bootstrap override');
  assert.ok(plan.tokens <= 30_000, `fits the operating band (${plan.tokens})`);
  assertAgeMonotone(plan.resolutions, inputs, rawZone);
  // The gradient actually folds something (this fixture is 90k raw vs 24k target).
  const deepest = Math.max(...[...plan.resolutions.values()]);
  assert.ok(deepest >= 1, 'bootstrap under pressure folds');
});

test('inverted carried profile in the dead band self-heals (quality-gap override)', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 18); // c-0072..0089 attended
  // The mythos shape: NEWER middle (c-0036..0071, the second L2 group) crushed
  // to L2 while the OLDEST middle (c-0000..0035) sits raw. Group-consistent by
  // construction. Renders ≈ 36k(old raw) + 200(L2 recall) + 18k(tail) ≈ 54k.
  const inverted = new Map<ChunkId, number>();
  for (const c of inputs.chunks) {
    const seq = c.sequence;
    inverted.set(c.id, seq >= 36 && seq <= 71 ? 2 : 0);
  }
  // Band chosen so the inverted profile is comfortably feasible and in-band:
  // the OLD solver would hold it forever (dead band → zero perturbation).
  const band = {
    foldAtTokens: 55_000, expandAtTokens: 20_000, targetTokens: 40_000,
    windowTokens: 60_000, rawZone, now: 89, mergeThreshold: 6,
  } as const;

  // Default trust region (= W): the misallocation is detected THROUGH the dead
  // band and repaired within P — no override needed, real perturbation paid.
  const plan = planControlledFrontier(inputs, tree, { previous: inverted, ...band });
  assert.equal(plan.override, undefined, 'repair fits the default trust region');
  assertAgeMonotone(plan.resolutions, inputs, rawZone);
  assert.ok(plan.perturbation > 0, 'self-heal pays a real (reported) perturbation');
  assert.ok(plan.tokens <= 55_000, 'result stays inside the band');

  // Tiny trust region: no useful suffix fits under P, and holding the inverted
  // profile is certifiably bad → the quality-gap override fires and the ideal
  // is adopted anyway. This is the anti-fossilization property.
  const tiny = planControlledFrontier(inputs, tree, {
    previous: inverted, ...band, reachTokens: 1_000,
  });
  assert.equal(tiny.override, 'quality-gap', 'P priced out by the quality gap');
  assertAgeMonotone(tiny.resolutions, inputs, rawZone);
});

test('a WELL-allocated in-band profile still holds (dead band preserved)', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 18);
  // First get a sane profile from the solver itself…
  const first = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 55_000, expandAtTokens: 20_000, targetTokens: 40_000,
    windowTokens: 60_000, rawZone, now: 89, mergeThreshold: 6,
  });
  // …then feed it back: nothing should move, zero perturbation.
  const second = planControlledFrontier(inputs, tree, {
    previous: first.resolutions,
    foldAtTokens: 55_000, expandAtTokens: 20_000, targetTokens: 40_000,
    windowTokens: 60_000, rawZone, now: 89, mergeThreshold: 6,
  });
  assert.equal(second.perturbation, 0, 'quiet turn: zero perturbation');
  assert.ok(!second.folded && !second.expanded, 'quiet turn: no movement');
  assert.equal(second.override, undefined, 'no override on a quiet turn');
});

test('low-salience chunks fold before equally-aged high-salience ones', () => {
  const { ch, inputs, tree } = session();
  // Mark ONE L1 group (c-0060..0065 — among the youngest with L1 coverage)
  // as fold-cheap; everything else default salience.
  for (const c of ch.chunks) {
    if (c.sequence >= 60 && c.sequence <= 65) c.salience = 0.1;
  }
  const rawZone = tailZone(inputs, 12);
  // Target trims just a little: only the cheapest information should fold.
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 85_000, expandAtTokens: 84_500, targetTokens: 84_500,
    windowTokens: 200_000, rawZone, now: 89, mergeThreshold: 6,
  });
  const lowSalLevel = plan.resolutions.get('c-0060') ?? 0;
  const oldHighSalLevel = plan.resolutions.get('c-0000') ?? 0;
  assert.ok(lowSalLevel >= 1, `fold-cheap group folded first (got L${lowSalLevel})`);
  assert.equal(oldHighSalLevel, 0, 'older but salient content stays raw');
});

test('trust region binds → suffix adoption: newest changes only, perturbation ≤ P', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 12);
  // Carried = everything raw (a real F_prev: non-empty, all zeros), over foldAt.
  const carried = new Map<ChunkId, number>(inputs.chunks.map((c) => [c.id, 0]));
  // P above the physical floor but below the full repair (≈26.2k here). Note
  // the floor is HIGH relative to the repair: rev-5.0 folds oldest-first, so
  // the ideal's changes cluster at the OLD end and even the newest-changes
  // suffix invalidates most of the render — the trust region's amortization
  // value on shed turns is structurally thin (it matters most for tail-near
  // rebalances). The pack phase's approach-target acceptance (2026-07-12)
  // raised the floor further by keeping the newest group raw in the ideal.
  const P = 26_000;
  const plan = planControlledFrontier(inputs, tree, {
    previous: carried,
    foldAtTokens: 30_000, expandAtTokens: 24_000, targetTokens: 24_000,
    windowTokens: 200_000, reachTokens: P, rawZone, now: 89, mergeThreshold: 6,
  });
  assert.equal(plan.override, undefined, 'trust region honored — no override');
  assert.ok(plan.perturbation <= P, `perturbation ${plan.perturbation} ≤ P ${P}`);
  assert.ok(plan.folded, 'made progress toward the ideal');
  assert.ok(plan.tokens < 90_000, 'render shrank');
  // Receding horizon: iterating converges (overrides allowed when the
  // remaining old-end changes can't fit any suffix under P).
  let prev = plan.resolutions;
  let tokens = plan.tokens;
  for (let i = 0; i < 40 && tokens > 30_000; i++) {
    const next = planControlledFrontier(inputs, tree, {
      previous: prev,
      foldAtTokens: 30_000, expandAtTokens: 24_000, targetTokens: 24_000,
      windowTokens: 200_000, reachTokens: P, rawZone, now: 89, mergeThreshold: 6,
    });
    assert.ok(
      next.override !== undefined || next.perturbation <= P,
      `iteration ${i}: perturbation ${next.perturbation} ≤ P unless overridden`,
    );
    prev = next.resolutions;
    tokens = next.tokens;
  }
  assert.ok(tokens <= 30_000, `converged into the band over turns (${tokens})`);
});

test('P below the physical floor cannot stall: no-progress partial is overridden', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 12);
  const carried = new Map<ChunkId, number>(inputs.chunks.map((c) => [c.id, 0]));
  // P far below the smallest meaningful fold's invalidation (~19k): the only
  // suffix within P is "adopt nothing", which must NOT be accepted while a
  // shed is required — the solver overrides instead of stalling over budget.
  const plan = planControlledFrontier(inputs, tree, {
    previous: carried,
    foldAtTokens: 30_000, expandAtTokens: 24_000, targetTokens: 24_000,
    windowTokens: 200_000, reachTokens: 2_000, rawZone, now: 89, mergeThreshold: 6,
  });
  assert.ok(plan.override !== undefined, 'no-progress plan is overridden');
  assert.ok(plan.tokens <= 30_000, `sheds to the band anyway (${plan.tokens})`);
});

test('strict transition pace below the physical floor blocks instead of jumping', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 12);
  const carried = new Map<ChunkId, number>(inputs.chunks.map((c) => [c.id, 0]));
  const plan = planControlledFrontier(inputs, tree, {
    previous: carried,
    foldAtTokens: 30_000,
    expandAtTokens: 24_000,
    targetTokens: 24_000,
    windowTokens: 200_000,
    reachTokens: 2_000,
    strictReach: true,
    rawZone,
    now: 89,
    mergeThreshold: 6,
  });
  assert.equal(plan.override, undefined, 'strict transition never overrides for quality');
  assert.equal(plan.blocked, 'reach-floor');
  assert.equal(plan.perturbation, 0);
  assert.equal(plan.tokens, 90_000, 'keeps the currently valid live frontier');
});

test('strict transition reports when the protected raw floor exceeds the target window', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 12); // protected floor is 12k
  const carried = new Map<ChunkId, number>(inputs.chunks.map((c) => [c.id, 0]));
  const plan = planControlledFrontier(inputs, tree, {
    previous: carried,
    foldAtTokens: 10_000,
    expandAtTokens: 9_000,
    targetTokens: 9_000,
    windowTokens: 200_000,
    reachTokens: 200_000,
    strictReach: true,
    rawZone,
    now: 89,
    mergeThreshold: 6,
  });
  assert.equal(plan.blocked, 'target-floor');
  assert.ok(plan.tokens > 10_000);
});

test('infeasible within P → override, feasibility beats the trust region', () => {
  const { inputs, tree } = session();
  const rawZone = tailZone(inputs, 6);
  const carried = new Map<ChunkId, number>(inputs.chunks.map((c) => [c.id, 0]));
  // W below the raw size: something MUST fold beyond what a tiny P allows.
  const plan = planControlledFrontier(inputs, tree, {
    previous: carried,
    foldAtTokens: 40_000, expandAtTokens: 30_000, targetTokens: 30_000,
    windowTokens: 50_000, reachTokens: 1_000, rawZone, now: 89, mergeThreshold: 6,
  });
  assert.ok(
    plan.override === 'infeasible' || plan.override === 'quality-gap',
    `P priced out (got ${plan.override ?? 'none'})`,
  );
  assert.ok(plan.tokens <= 50_000, 'fits under W');
});
