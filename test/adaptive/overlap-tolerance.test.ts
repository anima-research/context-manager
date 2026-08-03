/**
 * Overlap tolerance + fold→project fixpoint (2026-08-03, opus4 regression).
 *
 * After store surgery a summary "tree" can be NON-NESTED: a group's
 * leafChunkIds may include a leaf whose own l1Id lineage tops out below the
 * group's level or climbs through a different family (e.g. a re-minted L1
 * with different boundaries overlapping an old lineage).
 *
 * Old behavior: foldPass marked such leaves at the group's level anyway; the
 * final validity projection (monotone-lowering) then un-folded the WHOLE
 * group around the one disagreeing leaf — on opus4, 615 leaves cascaded
 * (+24k tokens), the solve returned an over-W frontier, and a produced L4/L5
 * layer sat unused ("deepest fold level=L3" with L4s present).
 *
 * New behavior: disagreeing leaves are skipped by folds and exempted from
 * unanimity (they render raw beside the recall — the renderer's existing
 * ownership-wins semantics), and the solve iterates fold→project until the
 * render fits under W.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { SummaryEntry } from '../../src/types/strategy.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

/** 90 chunks × 1000t, base-6 chain, then one ROGUE overlapping L1:
 *  c-0007's own lineage is re-pointed at an unmerged L1-R (sourceIds
 *  c-0007..c-0008, different boundaries) while the original L1/L2 lineage
 *  still lists c-0007 among its leaves — a non-nested tree. */
function corruptedSession(): { inputs: PickerInputs; tree: SummaryTree } {
  const ch = buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const template = ch.summaries.values().next().value as SummaryEntry;
  const rogue: SummaryEntry = {
    ...template,
    id: 'L1-ROGUE',
    level: 1,
    sourceLevel: 0,
    sourceIds: ['c-0007', 'c-0008'],
    sourceRange: { first: 'c-0007', last: 'c-0008' },
  };
  delete (rogue as { mergedInto?: string }).mergedInto;
  delete (rogue as { parentId?: string }).parentId; // harness entries carry parentId; the rogue is unmerged
  ch.summaries.set(rogue.id, rogue);
  ch.recallPairTokens.set(rogue.id, 200);
  const c7 = ch.chunks.find((c) => c.id === 'c-0007')!;
  c7.l1Id = 'L1-ROGUE';
  const inputs = inputsOf(ch);
  return { inputs, tree: new SummaryTree(inputs) };
}

test('a lineage-disagreeing leaf does not un-fold its group (overlap tolerance)', () => {
  const { inputs, tree } = corruptedSession();
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 2_000, expandAtTokens: 1_000, targetTokens: 1_000,
    windowTokens: 2_000, rawZone: new Set(), now: 89, mergeThreshold: 6,
  });

  // The physics hold: W is the only wall. (Old code: the projection avalanche
  // lowered the whole L2 group and the returned render busted W.)
  assert.ok(plan.tokens <= 2_000, `render fits under W (${plan.tokens})`);

  // The first L2 group (c-0000..0035) folds to 2 despite the rogue member —
  // the avalanche would have lowered all 36 to L1.
  let atL2 = 0;
  for (let i = 0; i < 36; i++) {
    const id = `c-${String(i).padStart(4, '0')}`;
    if (id === 'c-0007') continue;
    if ((plan.resolutions.get(id) ?? 0) === 2) atL2++;
  }
  assert.ok(atL2 >= 30, `L2 group survives the disagreeing member (${atL2}/35 at L2)`);

  // The rogue leaf itself is never marked at a level its lineage can't render.
  const rogueLevel = plan.resolutions.get('c-0007') ?? 0;
  assert.ok(rogueLevel <= 1, `disagreeing leaf stays at its own lineage depth (L${rogueLevel})`);
});
