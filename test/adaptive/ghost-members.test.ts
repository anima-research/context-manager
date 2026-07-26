/**
 * Regression: store surgery (redaction / excision) removes chunks whose ids
 * remain in summary sourceIds. Such GHOST members must not appear in
 * SummaryTree.leafChunkIds — groupEligible() reads a missing leaf as
 * `caps.get(id) ?? 0` → cap 0, which vetoes the group-atomic raise of every
 * live member at every level in phase A.
 *
 * Field case (mythos 2026-07-26): one ghost froze a 3,637-member L4 group at
 * L3 forever; 19 ghosts across two groups inverted the whole compression
 * curve (older eras LESS folded than newer ones) and drove the solver to
 * `budgetMet=false exhausted moves=0` churn. Specimen preserved at
 * mythos box ~/specimens/mythos-inverted-curve-20260726.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

/** Surgical excision: the chunk disappears; summary sourceIds keep its id. */
function excise(ch: MockChronicle, chunkId: string): void {
  const i = ch.chunks.findIndex((c) => c.id === chunkId);
  assert.ok(i >= 0, `fixture: chunk ${chunkId} exists before excision`);
  ch.chunks.splice(i, 1);
}

test('ghost members are dropped from leafChunkIds', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const victim = ch.chunks[5].id;
  excise(ch, victim);

  const tree = new SummaryTree(inputsOf(ch));
  for (const node of tree.allSummaries()) {
    assert.ok(
      !node.leafChunkIds.includes(victim),
      `${node.id} still lists ghost ${victim} in leafChunkIds`,
    );
  }
});

test('a ghost member does not veto the group-atomic raise (phase A)', () => {
  // W is generous so phase B (ignoreShapeCaps) never runs — pre-fix, the
  // poisoned group was ineligible at EVERY level in phase A and its live
  // members stayed raw while the rest of the chronicle folded to target.
  const ch = buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const victim = ch.chunks[5].id; // deep-old member of the first L1 group
  excise(ch, victim);
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);

  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 8_000,
    expandAtTokens: 8_000,
    targetTokens: 8_000,
    windowTokens: 1_000_000,
    rawZone: new Set(),
    now: 89,
    mergeThreshold: 6,
  });

  // Every live sibling of the ghost (and every other deep-old chunk) must
  // fold: a single stranded-raw old chunk is the mythos signature.
  const oldLive = ch.chunks.filter((c) => c.sequence <= 30);
  for (const c of oldLive) {
    const lvl = plan.resolutions.get(c.id) ?? 0;
    assert.ok(lvl >= 1, `old live chunk ${c.id} stranded raw (ghost veto)`);
  }
});
