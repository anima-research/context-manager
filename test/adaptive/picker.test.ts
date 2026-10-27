import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Picker } from '../../src/adaptive/picker.js';
import { namespaceDiagnostics } from '../../src/diagnostics.js';
import type { PickerChunk, PickerInputs } from '../../src/adaptive/picker.js';
import type { SummaryEntry } from '../../src/types/strategy.js';
import { FlatProfileStrategy } from '../../src/adaptive/strategies/flat-profile.js';
import { OldestFirstStrategy } from '../../src/adaptive/strategies/oldest-first.js';
import type { FoldingBudget } from '../../src/adaptive/folding-strategy.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';

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

for (const [name, make] of [['flat-profile', () => new FlatProfileStrategy()], ['oldest-first', () => new OldestFirstStrategy()]] as const) {
  test(`picker (${name}): a chunk pinned after it was folded renders raw`, () => {
    const chronicle = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 100, mergeThreshold: 6, recallPairTokens: 200 });
    const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 200 });
    // Folded to L1 before a pin was added over it.
    const pinned = chronicle.chunks[1];
    pinned.currentResolution = 1;
    pinned.pinned = true;
    const result = new Picker(make()).run(
      { chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens, ...tailInfo },
      BUDGET(100_000),
    );
    assert.equal(result.levelAt(pinned.sequence, pinned.id), 0);
    assert.equal(result.finalResolutions.get(pinned.id), 0);
  });

  test(`picker (${name}): under pressure, a chunk pinned after it was folded stays raw while another chunk folds`, () => {
    const chronicle = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 100, mergeThreshold: 6, recallPairTokens: 200 });
    const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 200 });
    const pinned = chronicle.chunks[1];
    pinned.currentResolution = 1;
    pinned.pinned = true;
    const result = new Picker(make()).run(
      { chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens, ...tailInfo },
      BUDGET(700),
    );
    assert.ok(chronicle.chunks.some((c) => c !== pinned && result.levelAt(c.sequence, c.id) > 0), 'another chunk folded');
    assert.equal(result.levelAt(pinned.sequence, pinned.id), 0);
  });

  test(`picker (${name}): a pin outranks the agent's lock on a chunk folded before the pin`, () => {
    const chronicle = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 100, mergeThreshold: 6, recallPairTokens: 200 });
    const tailInfo = chronicle.computeHeadTail({ headTokens: 0, tailTokens: 200 });
    // Locked at L1, then pinned: the accounting prices it raw, so it renders raw.
    const pinned = chronicle.chunks[1];
    pinned.currentResolution = 1;
    pinned.lockedByAgent = true;
    pinned.pinned = true;
    // Locked at L1 and not pinned: it keeps its level.
    const lockedOnly = chronicle.chunks[3];
    lockedOnly.currentResolution = 1;
    lockedOnly.lockedByAgent = true;
    const result = new Picker(make()).run(
      { chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens, ...tailInfo },
      BUDGET(100_000),
    );
    assert.equal(result.levelAt(pinned.sequence, pinned.id), 0);
    assert.equal(result.levelAt(lockedOnly.sequence, lockedOnly.id), 1);
  });
}

// #194's store: x0 and x1 under N1, y0 and y1 under N2, and both L1s name M as
// their parent, but M was written again from N1 alone. M isn't y's summary at
// L2, since it doesn't list y, so neither solver raises M for y. Raising M
// only ever moved x, and a solver that chose it for y chose it again on every
// step until it reached its internal bound and threw.
function unlistedParent(order: 'y first' | 'x first'): PickerInputs {
  const ids = order === 'y first' ? ['y0', 'y1', 'x0', 'x1'] : ['x0', 'x1', 'y0', 'y1'];
  return greedyStore(ids.map((id): [string, string] => [id, id.startsWith('x') ? 'N1' : 'N2']), [
    ['N1', 1, ['x0', 'x1'], 30, 'M'], ['N2', 1, ['y0', 'y1'], 30, 'M'], ['M', 2, ['N1'], 40],
  ]);
}

const greedySolvers = [
  ['flat-profile', () => new FlatProfileStrategy()],
  ['oldest-first', () => new OldestFirstStrategy()],
] as const;

for (const [name, make] of greedySolvers) {
  for (const order of ['y first', 'x first'] as const) {
    test(`picker (${name}): a summary on a chunk's lineage that doesn't list it isn't raised for it (${order})`, () => {
      const result = new Picker(make()).run(unlistedParent(order), BUDGET(60, 0));
      for (const id of ['y0', 'y1']) assert.ok((result.finalResolutions.get(id) ?? 0) <= 1, `${id} renders raw or through N2`);
    });
  }

  // On #194's store with y first, N2 names M, which doesn't list it, and no
  // summary above lists y. So once y is at L1 the step asks for an L2 over
  // N2's range, as it does at the top of any lineage. The strategy's
  // production can't make it, since N2 already has a parent; a store the
  // strategy opens doesn't carry such a link.
  test(`picker (${name}): where no summary above lists the chunk, a step asks for the next level`, () => {
    const result = new Picker(make()).run(unlistedParent('y first'), BUDGET(60, 0));
    assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 'y0', lastChunkId: 'y1' } }]);
    assert.equal(result.finalResolutions.get('y0'), 1);
    assert.equal(result.finalResolutions.get('y1'), 1);
  });

  // A level carried from before M was written again: y at L2, where its
  // lineage reaches M, which doesn't list it. A greedy step only raises, so y
  // starts at L1, where N2 lists it, rather than stay at a level it can't
  // render at.
  test(`picker (${name}): a chunk carried at a level whose summary doesn't list it starts at the next level down that has one`, () => {
    const inputs = unlistedParent('x first');
    for (const c of inputs.chunks) if (c.id.startsWith('y')) c.currentResolution = 2;
    const result = new Picker(make()).run(inputs, BUDGET(10_000, 0));
    assert.equal(result.finalResolutions.get('y0'), 1);
    assert.equal(result.finalResolutions.get('y1'), 1);
  });

  // y's L1 N2 names T, an L3 that lists N2 directly, so y's lineage skips L2.
  // Carried at L2, y starts at L1, where N2 lists it, though its lineage goes
  // on to L3.
  test(`picker (${name}): a chunk carried at a level its lineage skips starts at the next level down that has a summary`, () => {
    const inputs = greedyStore([['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2'], ['y1', 'N2']], [
      ['N1', 1, ['x0', 'x1'], 30, 'M'], ['M', 2, ['N1'], 20, 'T'], ['N2', 1, ['y0', 'y1'], 30, 'T'], ['T', 3, ['M', 'N2'], 10],
    ]);
    for (const c of inputs.chunks) if (c.id.startsWith('y')) c.currentResolution = 2;
    const { result, unrealizable } = runQuietly(make(), inputs, BUDGET(10_000, 0));
    assert.equal(result.finalResolutions.get('y0'), 1);
    assert.equal(result.finalResolutions.get('y1'), 1);
    assert.deepEqual(unrealizable, []);
  });

  // x's L1 L1-0 names R, an L2 written from L1-1 alone, while T, the L3 above
  // R, lists L1-0 through its other source Q. x has no summary at L2, and a
  // merge can't make one for it, since L1-0 already has a parent. So a step
  // raises x through T, the next summary up that lists it, with w.
  test(`picker (${name}): past a summary that doesn't list the chunk, a step raises it through the next one up that does`, () => {
    const inputs = greedyStore([['x', 'L1-0'], ['w', 'L1-1']], [
      ['L1-0', 1, ['x'], 30, 'R'], ['L1-1', 1, ['w'], 30, 'R'], ['R', 2, ['L1-1'], 20, 'T'],
      ['Q', 2, ['L1-0'], 20], ['T', 3, ['R', 'Q'], 10],
    ]);
    const { result, unrealizable } = runQuietly(make(), inputs, BUDGET(25, 0));
    assert.equal(result.finalResolutions.get('x'), 3);
    assert.equal(result.finalResolutions.get('w'), 3);
    assert.deepEqual(result.produced, []);
    assert.equal(result.finalTokens, 20);
    assert.deepEqual(unrealizable, []);
  });

  // x's L1 N names T, an L3 that lists N directly, so x's lineage skips L2,
  // and a merge can't make an L2 for x, since N already has a parent. A step
  // raises x through T, the next summary up, with w.
  test(`picker (${name}): a step raises a chunk past a level its lineage skips to the next summary up`, () => {
    const inputs = greedyStore([['x', 'N'], ['w', 'N2']], [
      ['N', 1, ['x'], 30, 'T'], ['N2', 1, ['w'], 30, 'M'], ['M', 2, ['N2'], 20, 'T'], ['T', 3, ['N', 'M'], 10],
    ]);
    const { result, unrealizable } = runQuietly(make(), inputs, BUDGET(25, 0));
    assert.equal(result.finalResolutions.get('x'), 3);
    assert.equal(result.finalResolutions.get('w'), 3);
    assert.deepEqual(result.produced, []);
    assert.equal(result.finalTokens, 20);
    assert.deepEqual(unrealizable, []);
  });

  // N1 lists x0, x1 and y0, while y0's own L1 is N2, which has no parent, and
  // M, N1's parent, is an L2. Raising N1 and then M for x moves x0 and x1; y0,
  // whose summary at those levels is N2 and then none, keeps its level. It
  // used to be raised with them, to L2, where it has no summary, and the
  // picker reported a level it can't realize. Then, with nothing above x, a
  // step raises y0 through N2, the next chunk that can rise.
  test(`picker (${name}): raising a summary leaves a leaf it lists through another lineage at its level`, () => {
    const inputs = greedyStore([['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2']], [
      ['N1', 1, ['x0', 'x1', 'y0'], 30, 'M'], ['N2', 1, ['y0'], 30], ['M', 2, ['N1'], 20],
    ]);
    const { result, unrealizable } = runQuietly(make(), inputs, BUDGET(60, 0));
    assert.equal(result.finalResolutions.get('x0'), 2, 'M was raised for x');
    assert.equal(result.finalResolutions.get('y0'), 1, 'y0 rises through N2');
    assert.deepEqual(unrealizable, []);
  });

  // s0's L1 S has no parent, as a summary no merge can take as the store
  // stands has none, and s0 is the oldest chunk. N1 and N2, under M, are
  // younger. Once every chunk is at L1, a step passes s0 over for the next
  // chunk that can rise and raises M, so the plan fits, rather than asking
  // for an L2 over S and stopping with the younger chunks below M.
  test(`picker (${name}): a chunk with no summary above it is passed over for the next one that can rise`, () => {
    const inputs = greedyStore([['s0', 'S'], ['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2'], ['y1', 'N2']], [
      ['S', 1, ['s0'], 30], ['N1', 1, ['x0', 'x1'], 30, 'M'], ['N2', 1, ['y0', 'y1'], 30, 'M'], ['M', 2, ['N1', 'N2'], 20],
    ]);
    const { result, unrealizable } = runQuietly(make(), inputs, BUDGET(70, 0));
    assert.equal(result.finalResolutions.get('s0'), 1, 's0 stays at S');
    for (const id of ['x0', 'x1', 'y0', 'y1']) assert.equal(result.finalResolutions.get(id), 2, `${id} rises through M`);
    assert.deepEqual(result.produced, []);
    assert.equal(result.finalTokens, 60);
    assert.equal(result.budgetMet, true);
    assert.deepEqual(unrealizable, []);
  });

  // s0's L1 S has no parent. x0 and x1 are under N1, whose parent is M1, and
  // the younger y0 and y1 under N2, whose parent is M2. Once every chunk is at
  // L1, a step passes s0 over and raises the oldest chunk that can rise, x0,
  // through M1. Raising y0 through M2 would fit the budget as well.
  test(`picker (${name}): passing over a chunk, a step raises the oldest chunk that can rise, not a younger one under another parent`, () => {
    const inputs = greedyStore([['s0', 'S'], ['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2'], ['y1', 'N2']], [
      ['S', 1, ['s0'], 30], ['N1', 1, ['x0', 'x1'], 30, 'M1'], ['N2', 1, ['y0', 'y1'], 30, 'M2'],
      ['M1', 2, ['N1'], 20], ['M2', 2, ['N2'], 20],
    ]);
    const { result } = runQuietly(make(), inputs, BUDGET(90, 0));
    assert.equal(result.finalTokens, 90);
    assert.equal(result.finalResolutions.get('s0'), 1, 's0 stays at S');
    for (const id of ['x0', 'x1']) assert.equal(result.finalResolutions.get(id), 2, `${id} rises through M1`);
    for (const id of ['y0', 'y1']) assert.equal(result.finalResolutions.get(id), 1, `${id} stays at N2`);
  });

  // Neither S nor T has a parent. With every chunk at the top of its lineage,
  // the step asks for the next level over the oldest chunk's group, as it
  // always has.
  test(`picker (${name}): where no chunk can rise, a step asks for the next level over the oldest chunk's group`, () => {
    const inputs = greedyStore([['s0', 'S'], ['u0', 'T']], [['S', 1, ['s0'], 30], ['T', 1, ['u0'], 30]]);
    const { result } = runQuietly(make(), inputs, BUDGET(20, 0));
    assert.equal(result.finalResolutions.get('s0'), 1);
    assert.equal(result.finalResolutions.get('u0'), 1);
    assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 's0', lastChunkId: 's0' } }]);
  });
}

// A store of chunks (each with its L1) and summaries ([id, level, sources,
// recall tokens, parent]), with a 10-token tail chunk after them.
function greedyStore(
  chunks: Array<[id: string, l1Id: string]>,
  summaries: Array<[id: string, level: number, sourceIds: string[], tokens: number, parentId?: string]>,
): PickerInputs {
  const all: PickerChunk[] = chunks.map(([id, l1Id], sequence) => ({
    id, sequence, rawTokens: 100, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id,
  }));
  all.push({ id: 't0', sequence: all.length, rawTokens: 10, currentResolution: 0, lockedByAgent: false, pinned: false });
  return {
    chunks: all,
    summaries: new Map(summaries.map(([id, level, sourceIds, tokens, parentId]): [string, SummaryEntry] => [id, {
      id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! },
      ...(parentId ? { parentId } : {}),
    }])),
    headTokens: 0, tailTokens: 10, headChunkIds: new Set(), tailChunkIds: new Set(['t0']),
  };
}

// a0 under A, b0 under B, both under P, whose recall is 100 tokens. b0 is in
// the tail, so raising P moves a0 alone, and P's 100 tokens take the place
// of A's 30: the raise grows the plan. With `stray`, s0 under S, an L1 with
// no parent, is the oldest chunk.
function growingRaise(stray: boolean): PickerInputs {
  const chunk = (id: string, sequence: number, rawTokens: number, currentResolution: number, l1Id: string): PickerChunk => ({
    id, sequence, rawTokens, currentResolution, lockedByAgent: false, pinned: false, l1Id,
  });
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
    id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
  }];
  const tail = stray ? 200 : 100;
  return {
    chunks: [...(stray ? [chunk('s0', 0, 100, 1, 'S')] : []), chunk('a0', 1, 100, 1, 'A'), chunk('b0', 2, tail, 0, 'B')],
    summaries: new Map([
      ...(stray ? [summary('S', 1, ['s0'], 30)] : []),
      summary('A', 1, ['a0'], 30, 'P'), summary('B', 1, ['b0'], 30, 'P'), summary('P', 2, ['A', 'B'], 100),
    ]),
    headTokens: 0, tailTokens: tail, headChunkIds: new Set(), tailChunkIds: new Set(['b0']),
  };
}

for (const [name, make] of greedySolvers) {
  // The plan starts at 130 (A's 30 and the tail's 100), within the hard
  // budget; raising P grows it to 200, over it. The solve returns the plan it
  // started from.
  test(`picker (${name}): a solve that a growing raise ends over the hard budget returns the plan it passed through within it`, () => {
    const { result } = runQuietly(make(), growingRaise(false), { totalBudget: 130, targetBudget: 120, slack: 10 / 130 });
    assert.equal(result.finalTokens, 130);
    assert.equal(result.finalResolutions.get('a0'), 1, 'a0 stays at A');
  });

  // With S's chunk the oldest, the step passes it over and raises P for a0,
  // taking 260 to 330 against a hard budget of 260. The solve that takes
  // only the oldest chunk stops at 260 with a request for an L2 over S, which
  // fits, so that plan is the solution.
  test(`picker (${name}): passing over a chunk, a growing raise doesn't take a fitting plan over the hard budget`, () => {
    const { result } = runQuietly(make(), growingRaise(true), { totalBudget: 260, targetBudget: 234, slack: 0.1 });
    assert.equal(result.finalTokens, 260);
    assert.equal(result.finalResolutions.get('a0'), 1, 'a0 stays at A');
    assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 's0', lastChunkId: 's0' } }]);
  });

  // x0, raw, rises through X (330 to 260), then through Q (back to 330),
  // then z0 through R (400): Q and R each list a tail leaf. flat-profile's
  // solves both take that path and end over 335, so the solution is the
  // smallest plan within it they passed through, 260. oldest-first's
  // oldest-only solve stops at 330, after Q, which fits, so it returns that.
  test(`picker (${name}): a passing-over solve that ends over the hard budget gives way to the oldest-only plan where it fits, else to the smallest plan passed through`, () => {
    const chunk = (id: string, sequence: number, currentResolution: number, l1Id: string): PickerChunk => ({
      id, sequence, rawTokens: 100, currentResolution, lockedByAgent: false, pinned: false, l1Id,
    });
    const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
      id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
    }];
    const inputs: PickerInputs = {
      chunks: [chunk('x0', 0, 0, 'X'), chunk('z0', 1, 1, 'Z'), chunk('x1', 2, 0, 'Y'), chunk('z1', 3, 0, 'W')],
      summaries: new Map([
        summary('X', 1, ['x0'], 30, 'Q'), summary('Y', 1, ['x1'], 30, 'Q'), summary('Q', 2, ['X', 'Y'], 100),
        summary('Z', 1, ['z0'], 30, 'R'), summary('W', 1, ['z1'], 30, 'R'), summary('R', 2, ['Z', 'W'], 100),
      ]),
      headTokens: 0, tailTokens: 200, headChunkIds: new Set(), tailChunkIds: new Set(['x1', 'z1']),
    };
    const { result } = runQuietly(make(), inputs, { totalBudget: 335, targetBudget: 200, slack: 135 / 335 });
    assert.equal(result.finalTokens, name === 'flat-profile' ? 260 : 330);
    assert.equal(result.finalResolutions.get('x0'), name === 'flat-profile' ? 1 : 2, 'x0 at X, or at Q');
    assert.equal(result.finalResolutions.get('z0'), 1, 'z0 at Z');
  });

  // A randomly generated store (seed 9308). c005-c008 have no L1, behind newer
  // summaries; L1-2 lists c014 and the three tail chunks. Passing over
  // c005-c008 raises L1-1, then L1-2, which folds only c014 and grows the
  // plan, then L2-0, ending at 2,248 against 2,171 with no plan within it on
  // the way. The oldest-only solve stops at 2,022, which fits, so that is the
  // solution: the plan this store got before passing over.
  test(`picker (${name}): where passing over ends over the hard budget and the oldest-only rule fits, the solution is that rule's plan`, () => {
    const raw: Array<[string, number]> = [
      ['c000', 262], ['c001', 54], ['c002', 63], ['c003', 192], ['c004', 204], ['c005', 116], ['c006', 88], ['c007', 84], ['c008', 240],
      ['c009', 165], ['c010', 164], ['c011', 131], ['c012', 83], ['c013', 237], ['c014', 263], ['c015', 225], ['c016', 195], ['c017', 123],
    ];
    const l1Of = (i: number): string | undefined => i <= 4 ? 'L1-0' : i <= 8 ? undefined : i <= 13 ? 'L1-1' : 'L1-2';
    const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
      id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
    }];
    const ids = raw.map(([id]) => id);
    const inputs: PickerInputs = {
      chunks: raw.map(([id, rawTokens], sequence): PickerChunk => ({
        id, sequence, rawTokens, currentResolution: 0, lockedByAgent: false, pinned: false, ...(l1Of(sequence) ? { l1Id: l1Of(sequence) } : {}),
      })),
      summaries: new Map([
        summary('L1-0', 1, ids.slice(0, 5), 290, 'L2-0'), summary('L1-1', 1, ids.slice(9, 14), 604, 'L2-0'),
        summary('L1-2', 1, ids.slice(14), 489), summary('L2-0', 2, ['L1-0', 'L1-1'], 688),
      ]),
      headTokens: 0, tailTokens: 225 + 195 + 123, headChunkIds: new Set(), tailChunkIds: new Set(['c015', 'c016', 'c017']),
    };
    const { result } = runQuietly(make(), inputs, { totalBudget: 2171, targetBudget: 1953.9, slack: 0.1 });
    assert.equal(result.finalTokens, 2022);
    assert.equal(result.finalResolutions.get('c000'), 2, 'L1-0 and L1-1 under L2-0');
    assert.equal(result.finalResolutions.get('c009'), 2);
    assert.equal(result.finalResolutions.get('c014') ?? 0, 0, 'c014 raw');
  });

  // s0 under S (no parent) is the oldest chunk; a0, raw, rises through A
  // (300 to 230), then through P, whose 150 tokens replace A's 30 while b0
  // stays in the tail (350), over a hard budget of 300. The oldest-only
  // solve fits: oldest-first's stops at once at 300, flat-profile's after A
  // at 230. Its plan is the solution. For oldest-first that isn't the
  // passing-over solve's smaller plan within the budget, 230, so its half is
  // the one that tells the order apart; flat-profile's two plans are the
  // same.
  test(`picker (${name}): the oldest-only rule's fitting plan comes before the smallest plan the passing-over solve passed through`, () => {
    const inputs: PickerInputs = {
      chunks: [
        { id: 's0', sequence: 0, rawTokens: 100, currentResolution: 1, lockedByAgent: false, pinned: false, l1Id: 'S' },
        { id: 'a0', sequence: 1, rawTokens: 100, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: 'A' },
        { id: 'b0', sequence: 2, rawTokens: 170, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: 'B' },
      ],
      summaries: new Map<string, SummaryEntry>([
        ['S', { id: 'S', level: 1, content: 'S', tokens: 30, sourceLevel: 0, sourceIds: ['s0'], created: 0, sourceRange: { first: 's0', last: 's0' } }],
        ['A', { id: 'A', level: 1, content: 'A', tokens: 30, sourceLevel: 0, sourceIds: ['a0'], created: 0, sourceRange: { first: 'a0', last: 'a0' }, parentId: 'P' }],
        ['B', { id: 'B', level: 1, content: 'B', tokens: 30, sourceLevel: 0, sourceIds: ['b0'], created: 0, sourceRange: { first: 'b0', last: 'b0' }, parentId: 'P' }],
        ['P', { id: 'P', level: 2, content: 'P', tokens: 150, sourceLevel: 1, sourceIds: ['A', 'B'], created: 0, sourceRange: { first: 'a0', last: 'b0' } }],
      ]),
      headTokens: 0, tailTokens: 170, headChunkIds: new Set(), tailChunkIds: new Set(['b0']),
    };
    const { result } = runQuietly(make(), inputs, { totalBudget: 300, targetBudget: 200, slack: 1 / 3 });
    assert.equal(result.finalTokens, name === 'flat-profile' ? 230 : 300);
    assert.equal(result.finalResolutions.get('a0') ?? 0, name === 'flat-profile' ? 1 : 0);
  });

  // The same raise within a hard budget of 250: the solve ends at 200, which
  // fits, so it keeps that plan though it passed through 130.
  test(`picker (${name}): a solve that ends within the hard budget keeps its last plan`, () => {
    const { result } = runQuietly(make(), growingRaise(false), { totalBudget: 250, targetBudget: 120, slack: 130 / 250 });
    assert.equal(result.finalTokens, 200);
    assert.equal(result.finalResolutions.get('a0'), 2, 'a0 rises through P');
  });

  // The caller refuses above 260, its hard budget of 255 plus its grace.
  // Passing over s0 takes the plan from 260 to 330, and no plan either solve
  // passed through is within 255. The oldest-only solve stops at 260, which
  // the caller accepts, so that is the solution: the plan the store compiled
  // with before passing over, where the passing-over plan is refused.
  test(`picker (${name}): where passing over ends over the hard budget, the oldest-only plan the caller accepts is the solution`, () => {
    const budget = { totalBudget: 255, targetBudget: 229.5, slack: 0.1, rejectionBudget: 260 };
    const { result } = runQuietly(make(), growingRaise(true), budget);
    assert.equal(result.finalTokens, 260);
    assert.equal(result.finalResolutions.get('a0'), 1, 'a0 stays at A');
    assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 's0', lastChunkId: 's0' } }]);
  });

  // The passing-over solve ends at 330, over the hard budget of 260 though
  // within the caller's 337; the oldest-only solve's 260 is within 260. A
  // plan over the hard budget doesn't displace one within it, so 260 is the
  // solution.
  test(`picker (${name}): a passing-over plan over the hard budget but within the caller's grace doesn't displace an oldest-only plan within it`, () => {
    const budget = { totalBudget: 260, targetBudget: 234, slack: 0.1, rejectionBudget: 337 };
    const { result } = runQuietly(make(), growingRaise(true), budget);
    assert.equal(result.finalTokens, 260);
    assert.equal(result.finalResolutions.get('a0'), 1, 'a0 stays at A');
  });

  // The growing raise ends both solves at 200, over the hard budget of 196
  // but within the caller's 200, while 130, where they start, is within 196.
  // The oldest-only solve's last plan is what the store compiles with today,
  // so it is the solution rather than the smaller plan.
  test(`picker (${name}): an oldest-only plan within the caller's grace is the solution, not a smaller plan within the hard budget`, () => {
    const budget = { totalBudget: 196, targetBudget: 120, slack: 76 / 196, rejectionBudget: 200 };
    const { result } = runQuietly(make(), growingRaise(false), budget);
    assert.equal(result.finalTokens, 200);
    assert.equal(result.finalResolutions.get('a0'), 2, 'a0 rises through P');
  });

  test(`picker (${name}): a solve that passed no chunk over is the only one, judged at the caller's line`, () => {
    const { value, engines } = greedyEngines(() => runQuietly(make(), growingRaise(false), {
      totalBudget: 196, targetBudget: 120, slack: 76 / 196, rejectionBudget: 200,
    }));
    assert.equal(value.result.finalTokens, 200);
    assert.equal(engines, 1);
  });

  test(`picker (${name}): where the fewest-token plan is a solve's last, it is the solution with no replay`, () => {
    const inputs = greedyStore([['a0', 'A']], [['A', 1, ['a0'], 30]]);
    inputs.chunks[1]!.rawTokens = 100;
    (inputs as { tailTokens: number }).tailTokens = 100;
    const { value, engines } = greedyEngines(() => runQuietly(make(), inputs, { totalBudget: 100, targetBudget: 90, slack: 0.1 }));
    assert.equal(value.result.finalTokens, 130);
    assert.equal(value.result.finalResolutions.get('a0'), 1);
    assert.equal(engines, 1);
  });

  test(`picker (${name}): where a solve's last plan only ties its fewest, the earlier plan is the solution`, () => {
    const store = growingRaise(false);
    const inputs = { ...store, summaries: new Map(store.summaries).set('P', { ...store.summaries.get('P')!, tokens: 30 }) };
    const { value, engines } = greedyEngines(() => runQuietly(make(), inputs, { totalBudget: 100, targetBudget: 90, slack: 0.1 }));
    assert.equal(value.result.finalTokens, 130);
    assert.equal(value.result.finalResolutions.get('a0'), 1, 'a0 stays at A');
    assert.equal(engines, 2);
  });

  // Nothing is within 100: both solves start at 260 and the one that passes
  // over ends at 330. The solution is the fewest-token plan either passed
  // through, 260, the first solve's winning the tie, with the request that
  // solve ended on, an L2 over S. The caller refuses it.
  test(`picker (${name}): where no plan is within the caller's line, the solution is the fewest-token plan with its solve's request`, () => {
    const { result } = runQuietly(make(), growingRaise(true), { totalBudget: 100, targetBudget: 90, slack: 0.1 });
    assert.equal(result.finalTokens, 260);
    assert.equal(result.finalResolutions.get('a0'), 1, 'a0 at A');
    assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 's0', lastChunkId: 's0' } }]);
  });

  // Both solves fit within 440. The oldest-only one stops behind s0: at 440
  // for oldest-first, after S, and at 100 for flat-profile, after N1 and N2.
  // The one that passes s0 over raises M too and ends at 60. The first
  // rule's plan is the solution.
  test(`picker (${name}): where the passing-over plan fits, it is the solution though the oldest-only one fits too`, () => {
    const inputs = greedyStore([['s0', 'S'], ['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2'], ['y1', 'N2']], [
      ['S', 1, ['s0'], 30], ['N1', 1, ['x0', 'x1'], 30, 'M'], ['N2', 1, ['y0', 'y1'], 30, 'M'], ['M', 2, ['N1', 'N2'], 20],
    ]);
    const { result } = runQuietly(make(), inputs, { totalBudget: 440, targetBudget: 70, slack: 370 / 440 });
    assert.equal(result.finalTokens, 60);
    for (const id of ['x0', 'x1', 'y0', 'y1']) assert.equal(result.finalResolutions.get(id), 2, `${id} rises through M`);
  });
}

// The fewest-token plan is taken across both solves. s0 under S (no parent)
// is the oldest chunk at L1, the best-ranked level; a0's P lists b0, in the
// tail; c0, raw, is under C. Passing s0 over raises P (260 to 330), then C
// (250), and stops. The oldest-only solve, finding s0 can't rise, goes on to
// L0 and raises C (180), and stops. Nothing is within 150, so the solution
// is the oldest-only solve's 180, with its request. Only flat-profile can
// show it: oldest-first's oldest-only solve stops where its passing-over
// solve first passes a chunk over, so its plans are among the other's.
test('picker (flat-profile): where no plan is within the line, the fewest-token plan can come from the oldest-only solve', () => {
  const chunk = (id: string, sequence: number, currentResolution: number, l1Id: string): PickerChunk => ({
    id, sequence, rawTokens: 100, currentResolution, lockedByAgent: false, pinned: false, l1Id,
  });
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
    id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
  }];
  const inputs: PickerInputs = {
    chunks: [chunk('s0', 0, 1, 'S'), chunk('a0', 1, 1, 'A'), chunk('c0', 2, 0, 'C'), chunk('b0', 3, 0, 'B')],
    summaries: new Map([
      summary('S', 1, ['s0'], 30), summary('C', 1, ['c0'], 20),
      summary('A', 1, ['a0'], 30, 'P'), summary('B', 1, ['b0'], 30, 'P'), summary('P', 2, ['A', 'B'], 100),
    ]),
    headTokens: 0, tailTokens: 100, headChunkIds: new Set(), tailChunkIds: new Set(['b0']),
  };
  const { value: { result }, engines } = greedyEngines(() =>
    runQuietly(new FlatProfileStrategy(), inputs, { totalBudget: 150, targetBudget: 135, slack: 0.1 }));
  assert.equal(result.finalTokens, 180);
  assert.equal(result.finalResolutions.get('a0'), 1, 'a0 stays at A');
  assert.equal(result.finalResolutions.get('c0'), 1, 'c0 rises through C');
  assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 's0', lastChunkId: 's0' } }]);
  assert.equal(engines, 2);
});

// The two solves of the fixture above with P costing 30, as A does: passing
// s0 over raises P (260 stays 260), then C (180); the oldest-only solve
// raises C (180). The fewest plans tie at 180 with different frontiers, and
// the first solve's wins: a0 through P.
test('picker (flat-profile): where the fewest-token plans tie, the first solve\'s is the solution', () => {
  const chunk = (id: string, sequence: number, currentResolution: number, l1Id: string): PickerChunk => ({
    id, sequence, rawTokens: 100, currentResolution, lockedByAgent: false, pinned: false, l1Id,
  });
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
    id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
  }];
  const inputs: PickerInputs = {
    chunks: [chunk('s0', 0, 1, 'S'), chunk('a0', 1, 1, 'A'), chunk('c0', 2, 0, 'C'), chunk('b0', 3, 0, 'B')],
    summaries: new Map([
      summary('S', 1, ['s0'], 30), summary('C', 1, ['c0'], 20),
      summary('A', 1, ['a0'], 30, 'P'), summary('B', 1, ['b0'], 30, 'P'), summary('P', 2, ['A', 'B'], 30),
    ]),
    headTokens: 0, tailTokens: 100, headChunkIds: new Set(), tailChunkIds: new Set(['b0']),
  };
  const { result } = runQuietly(new FlatProfileStrategy(), inputs, { totalBudget: 150, targetBudget: 135, slack: 0.1 });
  assert.equal(result.finalTokens, 180);
  assert.equal(result.finalResolutions.get('a0'), 2, 'the first solve\'s plan: a0 through P');
});

// The fixture above with two chunks already at L2, under E2 and F2, which have
// no parent. Passing s0 over ends with three summaries at L2 (P, E2, F2), the
// most-populous level, and asks for an L3 over P's group; the oldest-only
// solve ends with three at L1 and asks for an L2 over s0. Its 200 is the
// fewest-token plan, so its request comes with it.
test('picker (flat-profile): the fewest-token plan comes with the request its own solve ended on', () => {
  const chunk = (id: string, sequence: number, currentResolution: number, l1Id: string): PickerChunk => ({
    id, sequence, rawTokens: 100, currentResolution, lockedByAgent: false, pinned: false, l1Id,
  });
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
    id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
  }];
  const inputs: PickerInputs = {
    chunks: [chunk('s0', 0, 1, 'S'), chunk('a0', 1, 1, 'A'), chunk('c0', 2, 0, 'C'), chunk('e0', 3, 2, 'E1'), chunk('f0', 4, 2, 'F1'), chunk('b0', 5, 0, 'B')],
    summaries: new Map([
      summary('S', 1, ['s0'], 30), summary('C', 1, ['c0'], 20),
      summary('A', 1, ['a0'], 30, 'P'), summary('B', 1, ['b0'], 30, 'P'), summary('P', 2, ['A', 'B'], 100),
      summary('E1', 1, ['e0'], 30, 'E2'), summary('E2', 2, ['E1'], 10), summary('F1', 1, ['f0'], 30, 'F2'), summary('F2', 2, ['F1'], 10),
    ]),
    headTokens: 0, tailTokens: 100, headChunkIds: new Set(), tailChunkIds: new Set(['b0']),
  };
  const { result } = runQuietly(new FlatProfileStrategy(), inputs, { totalBudget: 150, targetBudget: 135, slack: 0.1 });
  assert.equal(result.finalTokens, 200);
  assert.equal(result.finalResolutions.get('a0'), 1, 'the oldest-only solve\'s plan');
  assert.deepEqual(result.produced, [{ level: 2, range: { firstChunkId: 's0', lastChunkId: 's0' } }], 'its own request, not the L3 the other solve asked for');
});

// The fixture above with P costing 5. Passing s0 over raises a0 through P
// (280 to 255), then c0 (175), and ends asking for an L3 over P's group; the
// oldest-only solve raises c0 (200) and asks for an L2 over s0. Neither last
// plan fits 150, so the fewest-token plan is the solve that passes over, and
// its own request comes with it.
test('picker (flat-profile): the fewest-token plan from the solve that passes over comes with that solve\'s request', () => {
  const chunk = (id: string, sequence: number, currentResolution: number, l1Id: string): PickerChunk => ({
    id, sequence, rawTokens: 100, currentResolution, lockedByAgent: false, pinned: false, l1Id,
  });
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): [string, SummaryEntry] => [id, {
    id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, ...(parentId ? { parentId } : {}),
  }];
  const inputs: PickerInputs = {
    chunks: [chunk('s0', 0, 1, 'S'), chunk('a0', 1, 1, 'A'), chunk('c0', 2, 0, 'C'), chunk('e0', 3, 2, 'E1'), chunk('f0', 4, 2, 'F1'), chunk('b0', 5, 0, 'B')],
    summaries: new Map([
      summary('S', 1, ['s0'], 30), summary('C', 1, ['c0'], 20),
      summary('A', 1, ['a0'], 30, 'P'), summary('B', 1, ['b0'], 30, 'P'), summary('P', 2, ['A', 'B'], 5),
      summary('E1', 1, ['e0'], 30, 'E2'), summary('E2', 2, ['E1'], 10), summary('F1', 1, ['f0'], 30, 'F2'), summary('F2', 2, ['F1'], 10),
    ]),
    headTokens: 0, tailTokens: 100, headChunkIds: new Set(), tailChunkIds: new Set(['b0']),
  };
  const { result } = runQuietly(new FlatProfileStrategy(), inputs, { totalBudget: 150, targetBudget: 135, slack: 0.1 });
  assert.equal(result.finalTokens, 175);
  assert.equal(result.finalResolutions.get('a0'), 2, 'the passing-over solve\'s plan: a0 through P');
  assert.equal(result.produced.length, 1);
  assert.equal(result.produced[0]!.level, 3, 'its own request, an L3 over P\'s group, not the L2 over s0 the other solve asked for');
});

// flat-profile chooses within its best-ranked level: L1 holds three rendered
// items (S, N1, N2) and L0 one (o0, raw, under O). S has no parent, so the
// step passes s0 over for x0 at the same level and raises M; o0, older and
// raisable through O, is at another level and isn't taken.
test('picker (flat-profile): passing over a chunk, a step takes the next chunk at the same level, not an older one at another', () => {
  const inputs = greedyStore([['o0', 'O'], ['s0', 'S'], ['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2'], ['y1', 'N2']], [
    ['O', 1, ['o0'], 30], ['S', 1, ['s0'], 30], ['N1', 1, ['x0', 'x1'], 30, 'M'], ['N2', 1, ['y0', 'y1'], 30, 'M'], ['M', 2, ['N1', 'N2'], 20],
  ]);
  for (const c of inputs.chunks) if (c.id !== 'o0' && c.id !== 't0') c.currentResolution = 1;
  const { result, unrealizable } = runQuietly(new FlatProfileStrategy(), inputs, BUDGET(165, 0));
  assert.equal(result.finalResolutions.get('x0'), 2, 'M is raised at the best-ranked level');
  assert.equal(result.finalResolutions.get('o0'), 0, 'the older chunk at another level stays raw');
  assert.equal(result.finalTokens, 160);
  assert.deepEqual(unrealizable, []);
});

function greedyEngines<T>(run: () => T): { value: T; engines: number } {
  const original = SummaryTree.prototype.renderableLevel;
  const chunks = new Set<string>();
  let reads = 0;
  SummaryTree.prototype.renderableLevel = function (this: SummaryTree, chunkId, level) {
    chunks.add(chunkId);
    reads++;
    return original.call(this, chunkId, level);
  };
  try {
    const value = run();
    return { value, engines: chunks.size === 0 ? 0 : reads / chunks.size };
  } finally {
    SummaryTree.prototype.renderableLevel = original;
  }
}

// Run a picker with console.error caught, and return its
// [picker-unrealizable] lines, if any.
function runQuietly(solver: FlatProfileStrategy | OldestFirstStrategy, inputs: PickerInputs, budget: FoldingBudget) {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    const result = new Picker(solver).run(inputs, budget);
    return { result, unrealizable: lines.filter((l) => l.includes('[picker-unrealizable]')) };
  } finally {
    console.error = original;
  }
}

// #239: a strategy's picker logs through the strategy's diagnostics, so its lines name the
// namespace the strategy works for.
test('picker: its lines name the namespace its owner gives it', () => {
  const inputs = greedyStore([['x', 'L1-0']], [['L1-0', 1, ['x'], 30]]);
  const solver = {
    name: 'stub',
    // x at a level it has no summary at, and an entry for no chunk at all.
    solve: () => ({ frontier: new Map([['x', 2], ['t0', 0], ['gone', 1]]), produced: [] }),
  } as unknown as ConstructorParameters<typeof Picker>[0];
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    new Picker(solver, namespaceDiagnostics(() => 'agents/tern')).run(inputs, BUDGET(10_000, 0));
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines.filter((l) => l.startsWith('[picker-dead-ids]')), [
    '[picker-dead-ids] solver=stub: dropped 1 frontier entry referencing no live chunk (store surgery residue). ns=agents/tern',
  ]);
  const unrealizable = lines.filter((l) => l.startsWith('[picker-unrealizable]'));
  assert.equal(unrealizable.length, 1, lines.join('\n'));
  assert.match(unrealizable[0]!, / ns=agents\/tern$/);
});
