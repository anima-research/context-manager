/**
 * Integration tests for the adaptive-resolution picker.
 *
 * These simulate realistic scenarios over many turns and verify the
 * design's claimed properties end-to-end:
 *  - 500K-doc ingestion + first compile fits in budget
 *  - 200-turn growth with picker firing only as needed
 *  - Monotonic cache stickiness (a chunk's resolution only ever rises)
 *  - Group-fold operates correctly through chained levels
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import { FlatProfileStrategy } from '../../src/adaptive/strategies/flat-profile.js';
import type { FoldingBudget, ChunkId } from '../../src/adaptive/folding-strategy.js';
import { chunkMessage } from '../../src/adaptive/chunker.js';
import { MockChronicle, DEFAULT_MERGE_THRESHOLD } from './harness.js';
import { lockChunk, unlockChunk, InMemoryLockStore } from '../../src/adaptive/lock-api.js';

const BUDGET = (totalBudget: number, slack = 0.1): FoldingBudget => ({
  totalBudget,
  targetBudget: totalBudget * (1 - slack),
  slack,
});

test('integration: 500K doc ingested as shards + picker folds to fit 30K budget', () => {
  // Synthetic 500K-char body. Real 500K-token doc would be ~2M chars.
  // We use char-equivalent here for test speed; chunker uses charsPerToken=4 by default.
  const synthetic500K = Array.from({ length: 125 }, (_, i) => {
    return `## Section ${i}\n\n` + 'Lorem ipsum dolor sit amet. '.repeat(140); // ~3920 chars per section ≈ 4K chars ≈ 1K tokens
  }).join('\n\n');

  // Chunk
  const sharded = chunkMessage(synthetic500K, { chunkThreshold: 8192, chunkSize: 4096, charsPerToken: 4 });
  assert.equal(sharded.wasSharded, true);
  const shardCount = sharded.shards.length;
  assert.ok(shardCount >= 30, `expected ≥30 shards from 500K-char synthetic doc, got ${shardCount}`);

  // Build chronicle
  const chronicle = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 200 });
  for (const s of sharded.shards) {
    chronicle.addChunk({
      id: `doc-${s.index.toString().padStart(4, '0')}`,
      rawTokens: s.approxTokens,
      bodyGroupId: sharded.bodyGroupId,
    });
  }
  // Pre-produce summaries (mimics the speculative pre-producer running at ingestion)
  for (let i = 0; i < chronicle.chunks.length; i += chronicle.mergeThreshold) {
    chronicle.produceL1(chronicle.chunks.slice(i, i + chronicle.mergeThreshold).map((c) => c.id));
  }
  chronicle.preProduceUpperLevels();

  // Compile with budget 30K
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 0 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(30_000)
  );

  // Should converge with budget met
  assert.equal(result.budgetMet, true, `picker should meet budget; final tokens = ${result.finalTokens}`);
  assert.ok(result.finalTokens <= 27_000, `final tokens ${result.finalTokens} should be ≤ targetBudget 27000`);
});

test('integration: 200-turn conversation growth — picker fires only as needed (steady-state cache)', () => {
  const chronicle = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 200 });
  const picker = new Picker(new FlatProfileStrategy());
  const BUDGET_TOTAL = 5000;

  // Track how many turns invoke the picker (i.e., apply any folds).
  let pickerFiredTurns = 0;
  let totalRaises = 0;

  // Per-chunk resolution history — verify monotonicity.
  const resolutionHistory = new Map<ChunkId, number[]>();

  for (let turn = 0; turn < 200; turn++) {
    // Each turn adds a new "message" chunk of ~50 tokens.
    chronicle.addChunk({ id: `m-${turn.toString().padStart(4, '0')}`, rawTokens: 50 });

    // Periodically produce L1s as the compression queue would (every 6 chunks).
    if (chronicle.chunks.length % 6 === 0) {
      const start = chronicle.chunks.length - 6;
      chronicle.produceL1(chronicle.chunks.slice(start, start + 6).map((c) => c.id));
      chronicle.preProduceUpperLevels();
    }

    // Run picker
    const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 500 });
    const result = picker.run(
      {
        chunks: chronicle.chunks,
        summaries: chronicle.summaries,
        recallPairTokens: chronicle.recallPairTokens,
        ...tailInfo,
      },
      BUDGET(BUDGET_TOTAL)
    );

    if (result.applied.length > 0) {
      pickerFiredTurns++;
      totalRaises += result.applied.length;
    }
    chronicle.applyResolutions(result.finalResolutions);

    // Record resolution per chunk
    for (const c of chronicle.chunks) {
      const arr = resolutionHistory.get(c.id) ?? [];
      arr.push(c.currentResolution);
      resolutionHistory.set(c.id, arr);
    }
  }

  // Monotonicity check: every chunk's resolution sequence should be non-decreasing.
  for (const [id, history] of resolutionHistory) {
    for (let i = 1; i < history.length; i++) {
      assert.ok(
        history[i] >= history[i - 1],
        `chunk ${id} resolution decreased at step ${i}: ${history[i - 1]} → ${history[i]}`
      );
    }
  }

  // Picker should fire on a MINORITY of turns (cache stickiness property).
  assert.ok(
    pickerFiredTurns < 200 * 0.5,
    `picker fired on ${pickerFiredTurns}/200 turns; should fire less than half the time`
  );

  // Most turns are no-ops in steady state.
  const noOpTurns = 200 - pickerFiredTurns;
  assert.ok(noOpTurns > 100, `expected at least 100 no-op turns, got ${noOpTurns}`);
});

test('integration: bodyGroupId chunks fold independently within one doc', () => {
  // Build a doc with 18 shards (3 L1 groups). Force partial folding so some
  // shards are L0 and some are L1, verifying that the per-chunk state allows
  // mixed resolution within a single bodyGroup.
  const chronicle = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 100 });
  for (let i = 0; i < 18; i++) {
    chronicle.addChunk({
      id: `doc-${i.toString().padStart(4, '0')}`,
      rawTokens: 500,
      bodyGroupId: 'doc-1',
    });
  }
  for (let i = 0; i < 18; i += 6) {
    chronicle.produceL1(chronicle.chunks.slice(i, i + 6).map((c) => c.id));
  }
  chronicle.preProduceUpperLevels(); // 3 L1s won't produce L2 (need 6)

  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 500 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(5000) // 17 chunks (excl tail) × 500 = 8500 raw; target 4500
  );
  // Should have folded some chunks (oldest L1 group) but not all.
  let l0Count = 0;
  let l1Count = 0;
  for (const c of chronicle.chunks) {
    const r = result.finalResolutions.get(c.id) ?? c.currentResolution;
    if (r === 0) l0Count++;
    else if (r === 1) l1Count++;
  }
  assert.ok(l0Count > 0 && l1Count > 0, `expected mixed L0+L1 within doc, got L0=${l0Count} L1=${l1Count}`);
});

test('integration: lock API prevents picker from raising a chunk', () => {
  const chronicle = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 200 });
  for (let i = 0; i < 12; i++) {
    chronicle.addChunk({ id: `c-${i.toString().padStart(4, '0')}`, rawTokens: 100 });
  }
  for (let i = 0; i < 12; i += 6) {
    chronicle.produceL1(chronicle.chunks.slice(i, i + 6).map((c) => c.id));
  }

  // Lock chunk c-0002 via the API
  const lockStore = new InMemoryLockStore();
  lockChunk(lockStore, 'c-0002');
  for (const c of chronicle.chunks) {
    if (lockStore.isLocked(c.id)) c.lockedByAgent = true;
  }

  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(900)
  );

  // c-0002 should remain at L0 despite siblings being raised.
  assert.equal(result.finalResolutions.get('c-0002'), 0);
  // Siblings should be at L1 if the picker ran the first group fold.
  if (result.finalResolutions.get('c-0000') === 1) {
    for (const sibling of ['c-0000', 'c-0001', 'c-0003', 'c-0004', 'c-0005']) {
      assert.equal(result.finalResolutions.get(sibling), 1, `${sibling} should be L1`);
    }
  }
  // Verify the lock-store agrees with chunk state.
  assert.equal(lockStore.isLocked('c-0002'), true);

  // Unlock and verify the lock state is cleared.
  unlockChunk(lockStore, 'c-0002');
  assert.equal(lockStore.isLocked('c-0002'), false);
  for (const c of chronicle.chunks) {
    c.lockedByAgent = lockStore.isLocked(c.id);
  }
  chronicle.applyResolutions(result.finalResolutions);

  // Without new pressure, the picker won't refire — that's correct
  // (monotonic, stingy). But under fresh pressure, c-0002 is now eligible.
  // Simulate new pressure by adding many new L0 chunks.
  for (let i = 12; i < 30; i++) {
    chronicle.addChunk({ id: `c-${i.toString().padStart(4, '0')}`, rawTokens: 100 });
  }
  for (let i = 12; i < 30; i += 6) {
    chronicle.produceL1(chronicle.chunks.slice(i, i + 6).map((c) => c.id));
  }
  chronicle.preProduceUpperLevels();

  const tailInfo2 = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const result2 = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo2,
    },
    BUDGET(900)
  );
  // Now under enough pressure that c-0002's group should fully collapse.
  // The L1-0 group covers c-0000..c-0005. With c-0002 unlocked, applyRaise
  // can include it. After enough pressure, c-0002 should be at L1.
  const finalRes = result2.finalResolutions.get('c-0002');
  assert.ok(
    (finalRes ?? 0) >= 1,
    `after unlock + new pressure, c-0002 should be ≥ L1 (got ${finalRes})`
  );
});

test('integration: stress — 1000 chunks, deep recursion via preProduceUpperLevels', () => {
  // Sanity check that the harness scales and the picker doesn't blow up.
  const chronicle = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 200 });
  for (let i = 0; i < 1000; i++) {
    chronicle.addChunk({ id: `c-${i.toString().padStart(4, '0')}`, rawTokens: 100 });
  }
  for (let i = 0; i < 1000; i += 6) {
    const slice = chronicle.chunks.slice(i, Math.min(i + 6, 1000));
    if (slice.length === 6) {
      chronicle.produceL1(slice.map((c) => c.id));
    }
  }
  chronicle.preProduceUpperLevels();
  // Expect summaries at multiple levels: 1000/6 ≈ 167 L1s, 167/6 ≈ 27 L2s, 27/6 = 4 L3s, no L4 yet.
  const levels = new Set<number>();
  for (const s of chronicle.summaries.values()) levels.add(s.level);
  assert.ok(levels.has(1) && levels.has(2) && levels.has(3), `expected L1, L2, L3; got ${Array.from(levels)}`);

  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 500 });
  const picker = new Picker(new FlatProfileStrategy());
  const start = Date.now();
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(10_000)
  );
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 5000, `picker took ${elapsed}ms on 1000 chunks; should be < 5s`);
  assert.ok(result.iterations < 1000, `should converge in fewer than 1000 iterations, got ${result.iterations}`);
  // Budget should be met or production requested
  assert.ok(result.budgetMet || result.produced.length > 0);
});
