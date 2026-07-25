/**
 * Regression test for the kv-stable fold-walk oscillation (2026-07-25).
 *
 * `nextOp` emits raise/lower ops against a whole GROUP root while the solved
 * target frontier is per-chunk. A group whose leaves carry MIXED targets —
 * which can happen when chunk ownership and the summary tree disagree after
 * store surgery / branch rollback ("head boundary disagrees with chunk
 * ownership") — made the walk ping-pong on the same root forever: raising
 * the group for one leaf overshot its siblings, lowering it for a sibling
 * undid the raise. The picker's iteration bound is max(1000, 10×chunks)
 * with O(chunks) work per step, so a live agent burned hours of CPU on
 * every compile (the mythos wedge: event loop starved, agent down).
 *
 * The fix is a cycle guard in KvStableStrategy.nextOp: the same op key
 * emitted more than 8 times means the walk is cycling, not converging —
 * the chunk is treated as unrealizable and skipped, and the frontier
 * renders at the nearest realizable cut.
 *
 * These tests inject a mixed-target frontier directly (white-box, via the
 * private `target` field) because a group-inconsistent plan is precisely
 * the corrupted-state condition that `solve()` is supposed to never
 * produce — the guard exists for when reality disagrees.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import type { FoldingBudget, ChunkId } from '../../src/adaptive/folding-strategy.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
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

/** Build a strategy whose solved target cuts through one L1 group:
 *  the group's first leaf targets L1 while its siblings target raw. */
function strategyWithMixedTargetGroup(inputs: PickerInputs): {
  strategy: KvStableStrategy;
  groupLeafIds: ChunkId[];
} {
  const tree = new SummaryTree(inputs);
  const strategy = new KvStableStrategy(inputs, {});

  // Find an L1 summary with more than one leaf.
  let groupLeafIds: ChunkId[] | null = null;
  for (const [, summary] of inputs.summaries) {
    if (summary.level !== 1) continue;
    const node = tree.ancestorAt(summary.chunkIds?.[0] ?? inputs.chunks[0].id, 1);
    if (node && node.leafChunkIds.length > 1) {
      groupLeafIds = [...node.leafChunkIds];
      break;
    }
  }
  assert.ok(groupLeafIds && groupLeafIds.length > 1, 'harness produced a multi-leaf L1 group');

  // Mixed targets inside the group: first leaf wants L1, siblings want raw.
  const target = new Map<ChunkId, number>();
  for (const c of inputs.chunks) target.set(c.id, 0);
  target.set(groupLeafIds![0], 1);

  // White-box injection: selectNextFold only solves when target is unset.
  (strategy as unknown as { target: Map<ChunkId, number> }).target = target;

  return { strategy, groupLeafIds: groupLeafIds! };
}

test('cycle guard: mixed-target group terminates instead of oscillating to the iteration bound', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const { strategy } = strategyWithMixedTargetGroup(inputs);

  // Pre-fix behavior: the raise/lower ping-pong on the same group root ran
  // to the iteration bound — max(1000, 10×12) = 1000 iterations — and threw
  // "exceeded iteration bound". With the guard, the walk stops after at
  // most ~8 emissions per op key and the run RETURNS.
  const result = new Picker(strategy).run(inputs, BUDGET(100_000));

  assert.ok(
    result.iterations < 100,
    `walk terminates quickly under the guard (took ${result.iterations} iterations; ` +
      `pre-fix this ran to the 1000-iteration bound and threw)`,
  );
});

test('cycle guard: per-op emissions are bounded and the result stays renderable', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const { strategy } = strategyWithMixedTargetGroup(inputs);

  const result = new Picker(strategy).run(inputs, BUDGET(100_000));

  // No single (kind, groupRoot) op may exceed the guard threshold.
  const emitted = new Map<string, number>();
  for (const op of result.applied) {
    const key = `${op.kind}:${String(op.groupRoot)}`;
    emitted.set(key, (emitted.get(key) ?? 0) + 1);
  }
  for (const [key, n] of emitted) {
    assert.ok(n <= 8, `op ${key} emitted ${n} times — guard threshold is 8`);
  }

  // Every chunk ends at a definite, in-range resolution (renderable frontier).
  for (const c of inputs.chunks) {
    const level = result.finalResolutions.get(c.id);
    assert.ok(
      typeof level === 'number' && level >= 0,
      `chunk ${String(c.id)} has a definite final resolution`,
    );
  }
});

test('no-guard-interference: a consistent frontier still converges exactly (existing behavior)', () => {
  const ch = buildChronicleWithChain({
    chunkCount: 48,
    tokensPerChunk: 1000,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const inputs = inputsOf(ch);
  const strategy = new KvStableStrategy(inputs, {});
  const result = new Picker(strategy).run(inputs, BUDGET(15_000));

  // The guard must be invisible on healthy stores: the picker still reaches
  // the strategy's own solved target exactly.
  const target = strategy.targetFrontier();
  assert.ok(target, 'strategy solved a target');
  for (const [id, level] of target!) {
    const chunk = inputs.chunks.find((c) => c.id === id);
    if (chunk?.pinned || chunk?.lockedByAgent) continue;
    assert.equal(
      result.finalResolutions.get(id),
      level,
      `chunk ${String(id)} reaches its planned level`,
    );
  }
});
