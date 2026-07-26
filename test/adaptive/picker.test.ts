import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import { FlatProfileStrategy } from '../../src/adaptive/strategies/flat-profile.js';
import { OldestFirstStrategy } from '../../src/adaptive/strategies/oldest-first.js';
import type { FoldingBudget } from '../../src/adaptive/folding-strategy.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

const BUDGET = (totalBudget: number, slack = 0.1): FoldingBudget => ({
  totalBudget,
  targetBudget: totalBudget * (1 - slack),
  slack,
});

test('picker: under budget — no folds', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 300 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(100_000)
  );
  assert.equal(result.moves, 0);
  assert.equal(result.budgetMet, true);
});

test('picker: over budget — flat-profile raises oldest group at L0', () => {
  // 12 chunks × 100 tokens = 1200 raw. mergeThreshold=6 → 2 L1 groups (no L2 produced).
  // With budget 700 / target 630, two L1 folds bring us to ~600 → budget met.
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 200 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(700)
  );
  assert.ok(result.moves > 0, 'should have applied at least one fold');
  // Greedy solvers are monotonic: nothing may end shallower than it started.
  for (const c of chronicle.chunks) {
    assert.ok(
      (result.finalResolutions.get(c.id) ?? 0) >= c.currentResolution,
      `chunk ${c.id} was lowered by a monotonic solver`,
    );
  }
  assert.equal(result.budgetMet, true);
});

test('picker: over budget without L2 available — emits produce op', () => {
  // 12 chunks × 100, 2 L1 groups, no L2. Budget 400 forces deeper folding.
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 200,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 200 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(400)
  );
  // Should have applied L1 folds AND requested L2 production.
  assert.ok(result.moves > 0);
  assert.ok(result.produced.length > 0, 'should have emitted produce request for L2');
  assert.equal(result.produced[0].level, 2);
});

test('picker: group-fold semantics — raising one chunk to L1 raises all siblings under same L1', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  // Force pressure such that exactly one L1 group is folded.
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(1000)
  );
  // After folding, count how many chunks at L1 vs L0.
  const l1Chunks: string[] = [];
  for (const [id, level] of result.finalResolutions) {
    if (level === 1) l1Chunks.push(id);
  }
  // L1 chunks should come in multiples of 6 (one group at a time).
  assert.equal(l1Chunks.length % 6, 0, `L1 chunk count ${l1Chunks.length} should be multiple of 6`);
  // And they should be contiguous from the oldest.
  l1Chunks.sort();
  for (let i = 0; i < l1Chunks.length; i++) {
    assert.equal(l1Chunks[i], `c-${i.toString().padStart(4, '0')}`);
  }
});

test('picker: oldest-first strategy raises chronologically', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new OldestFirstStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(900)
  );
  // Folding proceeds chronologically: the oldest chunk folds first, and no
  // younger chunk may sit deeper than an older one.
  if (result.moves > 0) {
    assert.ok((result.finalResolutions.get('c-0000') ?? 0) >= 1, 'oldest chunk should fold first');
    let prev = Number.POSITIVE_INFINITY;
    for (const c of chronicle.chunks) {
      const lvl = result.finalResolutions.get(c.id) ?? 0;
      assert.ok(lvl <= prev, `chunk ${c.id} deeper than an older chunk`);
      prev = lvl;
    }
  }
});

test('picker: monotonicity — re-running with same state does not lower anything', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 18,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new FlatProfileStrategy());

  // First run
  const r1 = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(800)
  );
  chronicle.applyResolutions(r1.finalResolutions);

  // Second run with same inputs — should not change anything.
  const r2 = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(800)
  );
  assert.equal(r2.moves, 0, 'second run with no pressure change should not apply folds');
  // All chunks' resolutions stable
  for (const c of chronicle.chunks) {
    const r1Val = r1.finalResolutions.get(c.id);
    const r2Val = r2.finalResolutions.get(c.id);
    assert.equal(r2Val, r1Val);
  }
});

test('picker: locked chunks survive partial group fold', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  // Lock chunk c-0003 (in the first L1 group).
  chronicle.chunks[3].lockedByAgent = true;
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
  // After folding the first L1 group, c-0003 should still be at L0.
  // Other chunks in that group should be at L1.
  if (result.finalResolutions.get('c-0000') === 1) {
    assert.equal(result.finalResolutions.get('c-0003'), 0, 'locked chunk should not be raised');
    assert.equal(result.finalResolutions.get('c-0001'), 1);
    assert.equal(result.finalResolutions.get('c-0002'), 1);
    assert.equal(result.finalResolutions.get('c-0004'), 1);
    assert.equal(result.finalResolutions.get('c-0005'), 1);
  }
});

test('picker: pinned chunks always render raw, never folded', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 12,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  chronicle.chunks[5].pinned = true; // Pin chunk in first L1 group
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
  // Pinned chunk is not in foldableMiddle, so it isn't raised.
  assert.equal(result.finalResolutions.get('c-0005'), 0);
});

test('picker: deep folding cascades through levels (L1 → L2 → L3 → …)', () => {
  // Many chunks → deep tree. With aggressive budget, picker should fold to higher levels.
  const chronicle = buildChronicleWithChain({
    chunkCount: 36, // 36 / 6 = 6 L1s; 6 L1s = 1 L2; need more to test L2 → L3
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 50,
  });
  // 36 chunks × 100 tokens = 3600. With budget 200 and recallPair 50, force deep folding.
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(300)
  );
  assert.equal(result.budgetMet, true);
  // Should have raised to at least L1 for the middle, possibly higher.
  const maxLevel = Math.max(...Array.from(result.finalResolutions.values()));
  assert.ok(maxLevel >= 1, `expected max level >= 1, got ${maxLevel}`);
});

test('picker: produce op emitted when L_{k+1} missing', () => {
  // Build chronicle WITHOUT producing the full chain — only L1s.
  const chronicle = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 50 });
  for (let i = 0; i < 18; i++) {
    chronicle.addChunk({ id: `c-${i.toString().padStart(4, '0')}`, rawTokens: 100 });
  }
  // Only L1 chain — no L2 yet.
  for (let i = 0; i < 18; i += 6) {
    chronicle.produceL1(chronicle.chunks.slice(i, i + 6).map((c) => c.id));
  }
  // Manually raise all chunks to L1 to simulate prior fold state.
  for (const c of chronicle.chunks) c.currentResolution = 1;

  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(120)
  );
  // The picker should ask for an L2 to be produced.
  assert.ok(result.produced.length > 0, 'should have requested L2 production');
  assert.equal(result.produced[0].level, 2);
});

test('picker: head and tail chunks are never folded', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 18,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 200, tailTokens: 200 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(500)
  );
  // Head chunks (first 2 = 200 tokens) and tail chunks (last 2 = 200 tokens) stay at L0.
  for (const id of tailInfo.headChunkIds) {
    assert.equal(result.finalResolutions.get(id), 0, `head chunk ${id} should remain L0`);
  }
  for (const id of tailInfo.tailChunkIds) {
    assert.equal(result.finalResolutions.get(id), 0, `tail chunk ${id} should remain L0`);
  }
});

test('picker: 500K-token doc scenario — folds dramatically without exhausting', () => {
  // Simulate a single 500K-token doc as 125 shards of ~4K tokens each.
  const SHARD_TOKENS = 4000;
  const SHARD_COUNT = 125;
  const RECALL_PAIR_TOKENS = 200;
  const chronicle = buildChronicleWithChain({
    chunkCount: SHARD_COUNT,
    tokensPerChunk: SHARD_TOKENS,
    mergeThreshold: 6,
    recallPairTokens: RECALL_PAIR_TOKENS,
  });
  // Assign all shards the same bodyGroupId.
  for (const c of chronicle.chunks) c.bodyGroupId = 'doc-1';

  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 0 });

  // Budget 100K — doc can't fit at L0 (500K) or even at L1 (~125 × 200 = 25K, fits!).
  // Try budget 30K — at L1 it's tight, picker should fold further.
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

  // Picker should converge — either budget met or further produce requests pending.
  assert.ok(
    result.budgetMet || result.produced.length > 0,
    `picker should converge: budgetMet=${result.budgetMet}, produced=${result.produced.length}`
  );
  // Most shards should not be at L0 anymore.
  const l0Count = Array.from(result.finalResolutions.values()).filter((v) => v === 0).length;
  assert.ok(l0Count < SHARD_COUNT / 2, `expected most shards folded, but ${l0Count} of ${SHARD_COUNT} still at L0`);
});

test('picker: hits soft target with slack-bounded room', () => {
  const chronicle = buildChronicleWithChain({
    chunkCount: 30,
    tokensPerChunk: 100,
    mergeThreshold: 6,
    recallPairTokens: 100,
  });
  const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 100 });
  const picker = new Picker(new FlatProfileStrategy());
  const result = picker.run(
    {
      chunks: chronicle.chunks,
      summaries: chronicle.summaries,
      recallPairTokens: chronicle.recallPairTokens,
      ...tailInfo,
    },
    BUDGET(2000, 0.1) // budget 2000, target 1800
  );
  assert.ok(result.budgetMet);
  assert.ok(result.finalTokens <= 1800, `finalTokens ${result.finalTokens} should be ≤ targetBudget 1800`);
});
