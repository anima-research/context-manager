/**
 * Tests for V2 dynamic pins — pin-at-level-k and pin-max-level
 * (`docs/best-fit-frontier-resolution.md` §7). These extend the classic
 * pin-as-raw with a fold-depth bound honored by the KV-stable controller:
 *
 *  - `fixedLevels` (ProtectedRange.level): the chunk is fixed at EXACTLY level k
 *    — neither un-folded shallower (even under generous budget) nor folded
 *    deeper (even under budget pressure);
 *  - `pinCaps` (ProtectedRange.maxLevel): a HARD cap on fold depth — the chunk
 *    may render raw..k but never deeper, enforced in normal AND emergency
 *    shedding, and a carried resolution deeper than the cap is un-folded to it;
 *  - level clamps to the deepest produced level (can't render at a missing L_k);
 *  - the KvStableStrategy walks the picker to a pin-at-k target.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { Picker } from '../../src/adaptive/picker.js';
import { KvStableStrategy } from '../../src/adaptive/strategies/kv-stable.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

// 90 chunks × 1000t = 90k raw; mergeThreshold 6 → 15 L1s → 2 L2s (max level 2).
// c-0000 has an L1 and an L2 ancestor.
function session(): { ch: MockChronicle; inputs: PickerInputs; tree: SummaryTree } {
  const ch = buildChronicleWithChain({ chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  return { ch, inputs, tree: new SummaryTree(inputs) };
}

const NOW = 89;

test('pin-at-level-k: fixed at exactly k under BOTH generous and tight budgets', () => {
  const { tree, inputs } = session();
  const pinned = 'c-0000';
  // Group-consistent pin: the whole L2 node covering c-0000 is fixed at L2 (an
  // L2 recall pair is atomic over its range — this is what the strategy expands
  // a single-chunk pin-at-k into).
  const node = tree.ancestorAt(pinned, 2)!;
  const fixedLevels = new Map(node.leafChunkIds.map((id) => [id, 2] as const));
  const outside = 'c-0040'; // in the OTHER L2 group → free to move
  assert.ok(!node.leafChunkIds.includes(outside), 'neighbor is outside the pinned node');

  // Generous budget → the controller un-folds everything toward raw to use
  // headroom. The pinned node must stay at L2 (NOT un-folded to raw).
  const loose = planControlledFrontier(inputs, tree, {
    previous: new Map(fixedLevels),
    foldAtTokens: 200_000, expandAtTokens: 200_000, targetTokens: 200_000,
    windowTokens: 200_000, rawZone: new Set(), fixedLevels, now: NOW, mergeThreshold: 6,
  });
  assert.equal(loose.resolutions.get(pinned), 2, 'pinned held at L2 under generous budget (not un-folded)');
  assert.equal(loose.resolutions.get(outside), 0, 'un-pinned old chunk un-folds to raw');

  // Tight budget → the controller folds the middle deep. The pinned node must
  // still be EXACTLY L2 (not folded deeper — no L3 exists — and not shallower).
  const tight = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 12_000, expandAtTokens: 0, targetTokens: 12_000,
    windowTokens: 90_000, rawZone: new Set(), fixedLevels, now: NOW, mergeThreshold: 6,
  });
  assert.equal(tight.resolutions.get(pinned), 2, 'pinned fixed at L2 under tight budget');
});

test('pin-at-level clamps to the deepest produced level (no phantom L_k)', () => {
  const { tree, inputs } = session();
  const pinned = 'c-0000';
  // Ask for L5, which does not exist (max is L2) → clamp to L2.
  const r = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 12_000, expandAtTokens: 0, targetTokens: 12_000,
    windowTokens: 90_000, rawZone: new Set(), fixedLevels: new Map([[pinned, 5]]),
    now: NOW, mergeThreshold: 6,
  });
  assert.equal(r.resolutions.get(pinned), 2, 'clamped to the deepest available level (L2)');
});

test('pin-max-level: a HARD fold-depth cap, enforced even under the W emergency', () => {
  const { tree, inputs } = session();
  const capped = 'c-0006'; // in the second L1 group (L1-1 → L2-0)
  const pinCaps = new Map([[capped, 1]]); // never fold deeper than L1

  // Very tight target: folding everything to L1 (15 groups × 200 = 3000t) does
  // NOT fit, so the controller must fold to L2 — forcing the deepest available
  // level. The capped chunk must still never exceed L1 (a pin is hard-protected).
  const r = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 1_500, expandAtTokens: 0, targetTokens: 1_200,
    windowTokens: 2_000, rawZone: new Set(), pinCaps, now: NOW, mergeThreshold: 6,
  });
  assert.ok((r.resolutions.get(capped) ?? 0) <= 1, `capped chunk never folds past L1 (got L${r.resolutions.get(capped)})`);
  // An un-capped neighbor in a DIFFERENT L2 group is free to fold to L2 under
  // the same pressure (a chunk sharing the capped chunk's L2 node would be held
  // by group-consistency, which is correct — so pick one outside it).
  assert.ok((r.resolutions.get('c-0040') ?? 0) >= 2, 'un-capped neighbor folds deeper');
});

test('pin-max-level un-folds a carried resolution deeper than the cap (on pin-add)', () => {
  const { tree, inputs } = session();
  const capped = 'c-0006';
  // F_prev has the capped chunk's whole L2 node folded deep at L2 — a VALID
  // tree cut (a lone leaf carried at L2 would be projected toward raw by the
  // group-consistency pass from the 2026-07-25 oscillation fix, e82f284,
  // because rendering a group's recall pair alongside raw siblings would
  // double-represent them). Adding maxLevel:1 must un-fold the capped chunk
  // to EXACTLY the cap immediately, even though the render is comfortably
  // under budget (dead band) — the intended divergence cost of tightening
  // a pin.
  const node = tree.ancestorAt(capped, 2)!;
  const previous = new Map(node.leafChunkIds.map((id) => [id, 2] as const));
  const r = planControlledFrontier(inputs, tree, {
    previous,
    foldAtTokens: 200_000, expandAtTokens: 0, targetTokens: 200_000,
    windowTokens: 200_000, rawZone: new Set(), pinCaps: new Map([[capped, 1]]),
    now: NOW, mergeThreshold: 6,
  });
  assert.equal(r.resolutions.get(capped), 1, 'carried L2 clamped down to the L1 cap at plan start');
  // The clamp must never overshoot past the cap to raw, and the rest of the
  // carried node must settle on a valid cut at or below its carried depth.
  for (const id of node.leafChunkIds) {
    const lvl = r.resolutions.get(id) ?? 0;
    assert.ok(lvl >= 1 && lvl <= 2, `carried node leaf ${id} stays folded on a valid cut (got L${lvl})`);
  }
});

test('KvStableStrategy walks the picker to a pin-at-level-k target', () => {
  const { ch, inputs } = session();
  // Pin c-0000 at L2 via the PickerChunk field the strategy reads.
  const target = ch.chunks.find((c) => c.id === 'c-0000')!;
  target.pinLevel = 2;
  target.currentResolution = 0; // starts raw → must be raised to L2

  const picker = new Picker(new KvStableStrategy(inputs));
  const result = picker.run(inputs, { totalBudget: 12_000, targetBudget: 10_000, slack: 0 });
  assert.equal(result.finalResolutions.get('c-0000'), 2, 'picker walked the pinned chunk to exactly L2');
});

test('pinned-at-level render survives a full budget sweep (no oscillation)', () => {
  const { tree, inputs } = session();
  const pinned = 'c-0000';
  const l1 = tree.ancestorAt(pinned, 1)!;
  const fixedLevels = new Map(l1.leafChunkIds.map((id) => [id, 1] as const));
  let prev = new Map<string, number>();
  for (const budget of [12_000, 40_000, 90_000, 40_000, 12_000]) {
    const r = planControlledFrontier(inputs, tree, {
      previous: prev,
      foldAtTokens: budget, expandAtTokens: budget * 0.9, targetTokens: budget * 0.9,
      windowTokens: 90_000, rawZone: new Set(), fixedLevels, now: NOW, mergeThreshold: 6,
    });
    assert.equal(r.resolutions.get(pinned), 1, `pinned held at L1 at budget ${budget}`);
    prev = r.resolutions;
  }
});
