/**
 * Regression tests for frontiers that CUT THROUGH a summary group —
 * the class of target the retired op walk could never realize.
 *
 * History (2026-07-25/26, the Mythos `raise:L4-936` wedge): V2 leveled pins
 * legitimately fix sub-ranges of a deep group at finer levels, so the solved
 * frontier assigns mixed levels inside one group. The old walk's group-atomic
 * raise/lower ops could not express that: raising for one leaf dragged the
 * pinned siblings past their pins, their lower dragged everyone back — an
 * endless ping-pong that a cycle guard could only truncate, leaving the
 * rendered frontier silently diverged from the plan (over budget, exhausted,
 * surviving on grace) while plan-vs-actual reported zero drift.
 *
 * The walk is gone: the picker applies the solved frontier directly. These
 * tests pin the new invariant — WHAT THE SOLVER PLANS IS WHAT RENDERS,
 * including cuts through groups.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker, type PickerInputs } from '../../src/adaptive/picker.js';
import type {
  FoldingBudget,
  FoldingSolver,
  ChunkId,
} from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { KvStableStrategy } from '../../src/adaptive/strategies/kv-stable.js';
import { buildChronicleWithChain } from './harness.js';

const BUDGET = (totalBudget: number, slack = 0.1): FoldingBudget => ({
  totalBudget,
  targetBudget: totalBudget * (1 - slack),
  slack,
});

function inputsOf(ch: ReturnType<typeof buildChronicleWithChain>): PickerInputs {
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

test('picker applies a frontier that cuts through a group EXACTLY (no walk, no oscillation)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);

  // A multi-leaf L1 group; target its first leaf at L1, siblings at raw —
  // exactly the shape that made the old walk ping-pong forever.
  let groupLeafIds: ChunkId[] | null = null;
  for (const chunk of inputs.chunks) {
    const node = tree.ancestorAt(chunk.id, 1);
    if (node && node.leafChunkIds.length > 1) {
      groupLeafIds = [...node.leafChunkIds];
      break;
    }
  }
  assert.ok(groupLeafIds && groupLeafIds.length > 1, 'harness produced a multi-leaf L1 group');

  const frontier = new Map<ChunkId, number>();
  for (const c of inputs.chunks) frontier.set(c.id, 0);
  frontier.set(groupLeafIds![0], 1);

  const stub: FoldingSolver = {
    name: 'stub-mixed-cut',
    solve: () => ({ frontier, produced: [] }),
  };
  const result = new Picker(stub).run(inputs, BUDGET(100_000));

  // The mixed cut is applied verbatim: one leaf at L1, siblings untouched.
  assert.equal(result.finalResolutions.get(groupLeafIds![0]), 1);
  for (const id of groupLeafIds!.slice(1)) {
    assert.equal(result.finalResolutions.get(id), 0, `sibling ${String(id)} must stay raw`);
  }
  assert.equal(result.moves, 1);
  assert.equal(result.unrealizable, 0);
});

test('leveled pin inside a deep group: kv-stable plans a cut through the group and the picker realizes it (Mythos L4-936 regression)', () => {
  // The exact Mythos shape, scaled down: 36 chunks → 6 L1s → 1 L2 spanning
  // all of them. A pin at level 2 fixes the WHOLE L2 group at 2
  // (group-consistent expansion — Mythos's pin(level:4) over L4-936), and a
  // finer pin at level 1 carves its L1 sub-group out at 1 (finest wins) —
  // a frontier that legitimately cuts through the L2 group. The old walk
  // oscillated raise:L2/lower:L2 forever on this shape.
  const ch = buildChronicleWithChain({
    chunkCount: 36,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);

  inputs.chunks[30].pinLevel = 2; // expands to the whole L2 → all 36 leaves fixed at 2
  const finerChunk = inputs.chunks[2];
  finerChunk.pinLevel = 1; // finest wins: its L1 group renders at 1 inside the L2 era
  const pinnedL1 = tree.ancestorAt(finerChunk.id, 1);
  assert.ok(pinnedL1, 'finer-pinned chunk has an L1');
  const pinnedGroup = new Set(pinnedL1!.leafChunkIds);

  const strategy = new KvStableStrategy({});
  const result = new Picker(strategy).run(inputs, BUDGET(100_000));

  // The plan IS the applied frontier — bit-exact, including the cut.
  const target = strategy.targetFrontier();
  assert.ok(target, 'strategy solved a target');
  for (const [id, level] of target!) {
    if (!result.finalResolutions.has(id)) continue; // dead ids filtered
    assert.equal(
      result.finalResolutions.get(id),
      level,
      `chunk ${String(id)} applied exactly as planned`,
    );
  }

  // The finer-pinned L1 group renders at its pin; the REST of the L2 group
  // holds at 2 — the cut through the group, applied without oscillation.
  for (const id of pinnedGroup) {
    assert.equal(result.finalResolutions.get(id), 1, `finer-pinned leaf ${String(id)} held at L1`);
  }
  let atTwo = 0;
  for (const c of inputs.chunks) {
    if (pinnedGroup.has(c.id)) continue;
    assert.equal(result.finalResolutions.get(c.id), 2, `leaf ${String(c.id)} held at the L2 pin`);
    atTwo++;
  }
  assert.equal(atTwo, 30);
  assert.equal(result.unrealizable, 0);
});

test('consistent frontier: kv-stable plan is applied exactly on a healthy store (existing behavior)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 48,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const strategy = new KvStableStrategy({});
  const result = new Picker(strategy).run(inputs, BUDGET(15_000));

  const target = strategy.targetFrontier();
  assert.ok(target, 'strategy solved a target');
  for (const [id, level] of target!) {
    const chunk = inputs.chunks.find((c) => c.id === id);
    if (chunk?.pinned || chunk?.lockedByAgent) continue;
    if (!result.finalResolutions.has(id)) continue;
    assert.equal(
      result.finalResolutions.get(id),
      level,
      `chunk ${String(id)} reaches its planned level`,
    );
  }
});

test('unrealizable frontier entries are loud, counted, and accounted as raw — never silently skipped', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);

  // Target L3 where the tree only has L1s: a solver-contract violation.
  const frontier = new Map<ChunkId, number>();
  for (const c of inputs.chunks) frontier.set(c.id, 3);

  const stub: FoldingSolver = {
    name: 'stub-unrealizable',
    solve: () => ({ frontier, produced: [] }),
  };
  const result = new Picker(stub).run(inputs, BUDGET(100_000));

  assert.equal(result.unrealizable, 12, 'every impossible target is counted');
  // Accounted as raw: 12 × 1000 tokens.
  assert.equal(result.finalTokens, 12_000);
});

test('frontier entries for dead ids (store-surgery residue) are dropped and counted', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);

  const frontier = new Map<ChunkId, number>();
  for (const c of inputs.chunks) frontier.set(c.id, 0);
  frontier.set('ghost-0001', 1);
  frontier.set('ghost-0002', 2);

  const stub: FoldingSolver = {
    name: 'stub-dead-ids',
    solve: () => ({ frontier, produced: [] }),
  };
  const result = new Picker(stub).run(inputs, BUDGET(100_000));

  assert.equal(result.deadFrontierIds, 2);
  assert.equal(result.finalResolutions.has('ghost-0001'), false, 'dead ids never persisted');
});
