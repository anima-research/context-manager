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
  // picker reported a level it can't realize. flat-profile then raises y0
  // through N2; oldest-first, which only ever chooses for the oldest chunk,
  // leaves it raw.
  test(`picker (${name}): raising a summary leaves a leaf it lists through another lineage at its level`, () => {
    const inputs = greedyStore([['x0', 'N1'], ['x1', 'N1'], ['y0', 'N2']], [
      ['N1', 1, ['x0', 'x1', 'y0'], 30, 'M'], ['N2', 1, ['y0'], 30], ['M', 2, ['N1'], 20],
    ]);
    const { result, unrealizable } = runQuietly(make(), inputs, BUDGET(60, 0));
    assert.equal(result.finalResolutions.get('x0'), 2, 'M was raised for x');
    assert.equal(result.finalResolutions.get('y0'), name === 'flat-profile' ? 1 : 0);
    assert.deepEqual(unrealizable, []);
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
