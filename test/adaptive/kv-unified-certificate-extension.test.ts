import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ParetoKvUnifiedPolicySolver } from '../../src/adaptive/kv-unified-pareto.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { MockChronicle } from './harness.js';

// The certificate used to decline whenever an appended leaf had a non-raw
// option (a freshly minted L1 over new messages). Hysteresis keeps the
// accepted layout under its BEST extension, so the certificate now enumerates
// the valid extensions and scores them exactly; it must select what the full
// solve selects.

test('certificate covers a fresh L1 over appended leaves and agrees with the full solve', () => {
  for (let run = 0; run < 24; run++) {
    const chronicle = new MockChronicle({ recallPairTokens: 20 + run });
    for (let i = 0; i < 8; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 60 + (i * 7 + run * 3) % 40 });
    const old = chronicle.produceL1(['c0', 'c1']);
    chronicle.produceL1(['c2', 'c3']);
    // accepted presentation: c0..c5 known (c0,c1 at L1; rest raw); c6,c7 appended since
    const accepted = new Map<string, number>([['c0', 1], ['c1', 1]]);
    const leaves = new Map(['c0', 'c1', 'c2', 'c3', 'c4', 'c5'].map((id) => [id, {
      level: accepted.get(id) ?? 0, repHash: accepted.get(id) ? `summary:${old.id}` : `raw:${id}`, lastChangedSeq: 1,
    }]));
    const before: PickerInputs = {
      chunks: chronicle.chunks.filter((c) => !['c6', 'c7'].includes(c.id)), summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const layout = renderLayout(before, new SummaryTree(before), accepted);
    // now a fresh L1 covers the appended leaves (run-dependent: sometimes also c5 is still uncovered)
    const fresh = chronicle.produceL1(run % 2 ? ['c6', 'c7'] : ['c5', 'c6', 'c7']);
    if (run % 2 === 0) leaves.delete('c5'); // c5 appended too in that variant
    const inputs: PickerInputs = {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const options = {
      maxTokens: 10_000, adoptEpsilon: 5 + run,
      presentation: { currentSeq: 9, leaves },
      cache: { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: 'same',
      // alpha high → recent raw is cheap to keep; low → folding the fresh L1 wins: both branches get exercised
      policy: { alpha: run % 3 === 0 ? 0.2 : 0.9, continuityLambda: 500, continuityScale: 50, cacheLambda: 100, cacheScale: 50 },
    };
    const full = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, hysteresisCertificate: false });
    const certified = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, hysteresisCertificate: true });
    assert.ok(full.feasible && certified.feasible);
    if (!certified.certificate) continue; // a genuine transition; the certificate correctly declined
    for (const chunk of inputs.chunks) {
      assert.equal(certified.selected.frontier.get(chunk.id) ?? 0, full.selected.frontier.get(chunk.id) ?? 0, `run ${run}: ${chunk.id}`);
    }
    assert.equal(certified.selected.score, full.selected.score, `run ${run}: score`);
    assert.ok(certified.selected.frontier.get('c6') !== undefined || fresh, 'fresh leaves assigned');
  }
});

test('certificate certifies at least one fresh-L1 turn (the extension path is exercised)', () => {
  let certifiedRuns = 0;
  for (let run = 0; run < 24; run++) {
    const chronicle = new MockChronicle({ recallPairTokens: 20 });
    for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 80 });
    const old = chronicle.produceL1(['c0', 'c1']);
    const leaves = new Map(['c0', 'c1', 'c2', 'c3'].map((id) => [id, {
      level: id < 'c2' ? 1 : 0, repHash: id < 'c2' ? `summary:${old.id}` : `raw:${id}`, lastChangedSeq: 1,
    }]));
    const before: PickerInputs = { chunks: chronicle.chunks.slice(0, 4), summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() };
    const layout = renderLayout(before, new SummaryTree(before), new Map([['c0', 1], ['c1', 1]]));
    chronicle.produceL1(['c4', 'c5']);
    const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() };
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({
      maxTokens: 10_000, adoptEpsilon: 50 + run * 10, presentation: { currentSeq: 7, leaves },
      cache: { immutablePrefixHash: 'same', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: 'same', hysteresisCertificate: true,
      policy: { alpha: 0.7, continuityLambda: 500, continuityScale: 50, cacheLambda: 100, cacheScale: 50 },
    });
    if (result.feasible && result.certificate) certifiedRuns++;
  }
  assert.ok(certifiedRuns > 0, 'the fresh-L1 extension path certified at least once');
});
