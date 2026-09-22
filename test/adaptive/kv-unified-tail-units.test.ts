import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ExactKvUnifiedPolicySolver, type AcceptedPresentationReference } from '../../src/adaptive/kv-unified-policy.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout, tailUnits } from '../../src/adaptive/render-offsets.js';
import { evaluateCacheHit } from '../../src/adaptive/kv-cache-sim.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

// The raw tail renders as one unit per message (2026-09-21). Before, the tail
// was one opaque unit, so every append shifted it and the end-of-tail marker
// fell outside the identical prefix: an unchanged layout was priced as the
// whole tail recomputed although the wire bytes were identical.

function inputsFor(chronicle: MockChronicle, tail: string[], tailTokens?: number): PickerInputs {
  const tailChunkIds = new Set(tail);
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, headChunkIds: new Set(), tailChunkIds,
    tailTokens: tailTokens ?? chronicle.chunks.filter((c) => tailChunkIds.has(c.id)).reduce((sum, c) => sum + c.rawTokens, 0),
  };
}

test('tail chunks render as per-message raw units summing to tailTokens; only unattributed tokens stay opaque', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 20 });
  for (let i = 0; i < 5; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 + i });
  const inputs = inputsFor(chronicle, ['c3', 'c4']);
  assert.deepEqual(tailUnits(inputs), [
    { kind: 'raw', key: 'c3', tokens: 103, chunkId: 'c3' }, { kind: 'raw', key: 'c4', tokens: 104, chunkId: 'c4' },
  ]);
  const layout = renderLayout(inputs, new SummaryTree(inputs), new Map());
  assert.deepEqual(layout.units.map((u) => `${u.kind}:${u.key}`), ['raw:c0', 'raw:c1', 'raw:c2', 'raw:c3', 'raw:c4']);
  assert.equal(layout.totalTokens, 100 + 101 + 102 + 103 + 104);
  // synthetic inputs whose tailTokens exceed the chunk sum keep the old block for the remainder
  const residual = inputsFor(chronicle, ['c4'], 150);
  assert.deepEqual(tailUnits(residual).map((u) => [u.kind, u.tokens]), [['raw', 104], ['tail', 46]]);
  assert.equal(renderLayout(residual, new SummaryTree(residual), new Map()).totalTokens, 100 + 101 + 102 + 103 + 150);
  // no tail chunks at all: unchanged legacy behaviour
  assert.deepEqual(tailUnits(inputsFor(chronicle, [], 70)), [{ kind: 'tail', key: 'tail', tokens: 70 }]);
});

test('a message sliding out of the tail keeps its identity: unchanged layout has zero churn, only the append is recomputed', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 20 });
  for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
  chronicle.produceL1(['c0', 'c1']);
  // turn N: tail = c3,c4 (c5 does not exist yet)
  const before = inputsFor({ ...chronicle, chunks: chronicle.chunks.filter((c) => c.id !== 'c5') } as MockChronicle, ['c3', 'c4']);
  const frontier = new Map([['c0', 1], ['c1', 1]]);
  const accepted = renderLayout(before, new SummaryTree(before), frontier);
  const markers = [1, 2, accepted.units.length].map((unitIndex) => ({
    unitIndex, offset: unitIndex >= accepted.units.length ? accepted.totalTokens : accepted.units[unitIndex].offset,
  }));
  // turn N+1: c5 appended; c3 slid out of the tail into the middle, still raw
  const after = inputsFor(chronicle, ['c4', 'c5']);
  const next = renderLayout(after, new SummaryTree(after), frontier);
  const hit = evaluateCacheHit(accepted, markers, next);
  assert.equal(hit.recomputedTokens, 100, 'only the appended message is recomputed');

  const leaves = new Map(before.chunks.map((chunk) => [chunk.id, {
    level: frontier.get(chunk.id) ?? 0,
    repHash: frontier.get(chunk.id) ? `summary:${chronicle.summaries.keys().next().value}` : `raw:${chunk.id}`,
    lastChangedSeq: 1,
  }]));
  const presentation: AcceptedPresentationReference = { currentSeq: 6, leaves };
  const options = {
    maxTokens: 10_000, adoptEpsilon: 10, presentation,
    cache: { immutablePrefixHash: 'same', layout: accepted, markers }, currentImmutablePrefixHash: 'same',
    policy: { continuityLambda: 500, continuityScale: 50, cacheLambda: 100, cacheScale: 50 },
  };
  const forest = new CanonicalSummaryForest(after, { preserveGapBearingSummaries: true });
  for (const storage of ['objects', 'packed'] as const) {
    const result = new ParetoKvUnifiedPolicySolver(after, forest).solve({ ...options, storage });
    assert.ok(result.feasible);
    for (const chunk of after.chunks) assert.equal(result.selected.frontier.get(chunk.id) ?? 0, frontier.get(chunk.id) ?? 0, `${storage}: ${chunk.id} unchanged`);
    assert.equal(result.selected.cacheChurn, 0, `${storage}: no churn for an unchanged layout`);
    assert.equal(result.cacheFloor, 0, `${storage}: churn floor is zero`);
    assert.equal(result.selected.continuityLoss, 0);
  }
  const exact = new ExactKvUnifiedPolicySolver(after, forest).solve(options);
  assert.ok(exact.feasible);
  assert.equal(exact.selected.cacheChurn, 0);
  const l1 = [...chronicle.summaries.keys()][0];
  assert.deepEqual(exact.selected.layout.units.map((u) => `${u.kind}:${u.key}`), [`recall:${l1}`, 'raw:c2', 'raw:c3', 'raw:c4', 'raw:c5']);
  assert.deepEqual(next.units.map((u) => `${u.kind}:${u.key}`), [`recall:${l1}`, 'raw:c2', 'raw:c3', 'raw:c4', 'raw:c5']);
});
