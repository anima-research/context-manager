/**
 * kv-unified's forest owns a leaf through a summary only where each summary
 * on its chain lists the one below, so it owns a leaf at a level only where
 * SummaryTree.ancestorAt, and so the renderer's layout, renders it there
 * (#253). Its ownership followed parent pointers alone, so an L2 written again
 * without one of its L1s, whose pointer still named it, kept that L1's
 * leaves: every kv-unified engine planned them at the L2 and priced them at
 * its recall, while renderLayout rendered them raw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalForestError, CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { KvUnifiedStrategy } from '../../src/adaptive/strategies/kv-unified.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { accountFrontier, type PickerChunk, type PickerInputs } from '../../src/adaptive/picker.js';
import type { SummaryEntry } from '../../src/types/strategy.js';
import { MockChronicle } from './harness.js';

/** Six chunks of 100 tokens, L1s over pairs, an L2 over the three L1s, every recall pair 50. */
function sixUnderAnL2(): { inputs: PickerInputs; l1s: SummaryEntry[]; l2: SummaryEntry } {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 100 });
  const l1s = [['c0', 'c1'], ['c2', 'c3'], ['c4', 'c5']].map((ids) => chronicle.produceL1(ids));
  const l2 = chronicle.produceUpper(2, l1s.map((s) => s.id));
  return {
    inputs: {
      chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    },
    l1s,
    l2,
  };
}

test("an L1 its L2 no longer lists is a root, and kv-unified plans its leaves where they render", () => {
  const { inputs, l1s, l2 } = sixUnderAnL2();
  l2.sourceIds = [l1s[0]!.id, l1s[1]!.id];
  assert.equal(l1s[2]!.parentId, l2.id, "premise: the L1's pointer still names the L2");
  const forest = new CanonicalSummaryForest(inputs);
  assert.deepEqual(forest.summary(l2.id)?.leafIds, ['c0', 'c1', 'c2', 'c3'], 'the L2 owns what it lists');
  assert.equal(forest.summary(l1s[2]!.id)?.parentId, undefined, 'the unlisted L1 has no parent in the forest');
  assert.ok(forest.roots.some((root) => root.id === l1s[2]!.id), 'and is a root');
  assert.deepEqual(forest.leaf('c4')?.availableLevels, [0, 1], 'its leaves reach L1, not L2');

  const tree = new SummaryTree(inputs);
  for (const budget of [60, 120]) {
    const plan = new KvUnifiedStrategy().solve(inputs, { totalBudget: budget, targetBudget: budget, slack: 0 });
    for (const id of ['c4', 'c5']) assert.ok((plan.frontier.get(id) ?? 0) <= 1, `at ${budget}, ${id} is planned at L1 or raw`);
    assert.equal(
      accountFrontier(inputs, plan.frontier).tokens,
      renderLayout(inputs, tree, plan.frontier).totalTokens,
      `at ${budget}, the plan's tokens are the rendered layout's`,
    );
  }
});

test('a chunk its L1 does not list is ownerless', () => {
  const { inputs, l1s, l2 } = sixUnderAnL2();
  l1s[2]!.sourceIds = ['c4'];
  assert.equal(inputs.chunks.find((c) => c.id === 'c5')?.l1Id, l1s[2]!.id, "premise: the chunk's link still names the L1");
  const forest = new CanonicalSummaryForest(inputs);
  assert.deepEqual(forest.leaf('c5')?.availableLevels, [0], 'the chunk renders only raw');
  assert.deepEqual(forest.summary(l1s[2]!.id)?.leafIds, ['c4'], 'the L1 owns what it lists');
  assert.deepEqual(forest.summary(l2.id)?.leafIds, ['c0', 'c1', 'c2', 'c3', 'c4'], 'and the L2 what its L1s own');
});

test("a root L1 that doesn't list its first chunk leaves that chunk ownerless and still owns the next", () => {
  const chronicle = new MockChronicle({ recallPairTokens: 50 });
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `r${i}`, rawTokens: 100 });
  const first = chronicle.produceL1(['r0', 'r1']);
  chronicle.produceL1(['r2', 'r3']);
  first.sourceIds = ['r1'];
  const inputs: PickerInputs = {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  assert.equal(inputs.chunks[0]!.l1Id, first.id, "premise: the first chunk's link still names the L1");
  const forest = new CanonicalSummaryForest(inputs);
  assert.deepEqual(forest.leaf('r0')?.availableLevels, [0]);
  assert.deepEqual(forest.leaf('r1')?.availableLevels, [0, 1], 'the next chunk, which it lists, is still its');
});

test('a link to a missing L1, to a summary that is no L1, or to a parent not above it is still reported', () => {
  const issueCodes = (mutate: (inputs: PickerInputs, l1s: SummaryEntry[], l2: SummaryEntry) => void): string[] => {
    const { inputs, l1s, l2 } = sixUnderAnL2();
    mutate(inputs, l1s, l2);
    try {
      new CanonicalSummaryForest(inputs);
      return [];
    } catch (error) {
      assert.ok(error instanceof CanonicalForestError);
      return error.issues.map((issue) => issue.code);
    }
  };
  assert.ok(issueCodes((inputs) => { inputs.chunks[0]!.l1Id = 'ghost'; }).includes('missing-l1'));
  assert.ok(issueCodes((inputs, _l1s, l2) => { inputs.chunks[0]!.l1Id = l2.id; }).includes('invalid-l1-level'),
    'a chunk linking the L2, which lists no chunk');
  assert.ok(issueCodes((_inputs, l1s) => { l1s[0]!.parentId = l1s[1]!.id; }).includes('non-increasing-level'),
    'an L1 pointing at another L1, which does not list it');
});

test('a parent that stops listing a child inside its span leaves a hole the forest refuses', () => {
  const { inputs, l1s, l2 } = sixUnderAnL2();
  l2.sourceIds = [l1s[0]!.id, l1s[2]!.id];
  assert.throws(
    () => new CanonicalSummaryForest(inputs),
    (error: unknown) => error instanceof CanonicalForestError &&
      error.issues.some((issue) => issue.code === 'non-contiguous-ownership' && issue.summaryIds.includes(l2.id)),
  );
});

// ---- the forest's ownership against SummaryTree.ancestorAt, over damaged lineages ----

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A nested tree over 3 to 12 chunks with one or two of the damages store
 *  surgery leaves: an L1 detached from the L2 that still lists it, an L1
 *  pointed at an L2 that doesn't list it, an L2 that no longer lists one of
 *  its L1s, a chunk linked to an extra L1 over it and its neighbour, an L1
 *  that no longer lists one of its chunks, or a chunk linked to a new L1
 *  that points at its old L1's parent, which doesn't list the new one. */
function damaged(rng: () => number): { inputs: PickerInputs; unlisted: boolean } {
  const n = 3 + Math.floor(rng() * 10);
  const chunks: PickerChunk[] = Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, sequence: i, rawTokens: 40 + Math.floor(rng() * 120), currentResolution: 0, lockedByAgent: false, pinned: false,
  }));
  const summary = (id: string, level: number, sourceIds: string[]): SummaryEntry => ({
    id, level, sourceLevel: level - 1, sourceIds, tokens: 10 + Math.floor(rng() * 40), content: id, created: 0,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! },
  });
  const levels: SummaryEntry[][] = [[]];
  for (let i = 0; i < n;) {
    const run = chunks.slice(i, i + 1 + Math.floor(rng() * 3));
    i += run.length;
    if (rng() < 0.1) continue;
    const s = summary(`L1-${levels[0]!.length}`, 1, run.map((c) => c.id));
    for (const c of run) c.l1Id = s.id;
    levels[0]!.push(s);
  }
  for (let level = 2; level <= 3 && levels[level - 2]!.length >= 2; level++) {
    const here: SummaryEntry[] = [];
    const below = levels[level - 2]!;
    for (let j = 0; j < below.length;) {
      const kids = below.slice(j, j + 2 + Math.floor(rng() * 2));
      j += kids.length;
      if (kids.length < 2 || rng() < 0.2) continue;
      const s = summary(`L${level}-${here.length}`, level, kids.map((k) => k.id));
      for (const k of kids) k.parentId = s.id;
      here.push(s);
    }
    levels.push(here);
  }
  const all = levels.flat();
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
  for (let c = 1 + Math.floor(rng() * 2); c > 0; c--) {
    const merged = levels[0]!.filter((s) => s.parentId);
    const kind = Math.floor(rng() * 6);
    if (kind === 0 && merged.length > 0) {
      delete pick(merged).parentId;
    } else if (kind === 1 && merged.length > 0 && (levels[1]?.length ?? 0) >= 2) {
      const s = pick(merged);
      s.parentId = pick(levels[1]!.filter((p) => p.id !== s.parentId)).id;
    } else if (kind === 2 && (levels[1]?.length ?? 0) > 0) {
      const p = pick(levels[1]!);
      p.sourceIds = p.sourceIds.slice(0, -1);
    } else if (kind === 3) {
      const at = Math.floor(rng() * (n - 1));
      const s = summary(`R-${c}`, 1, [chunks[at]!.id, chunks[at + 1]!.id]);
      chunks[at]!.l1Id = s.id;
      all.push(s);
    } else if (kind === 4 && levels[0]!.some((s) => s.sourceIds.length > 0)) {
      const s = pick(levels[0]!.filter((x) => x.sourceIds.length > 0));
      const drop = pick(s.sourceIds);
      s.sourceIds = s.sourceIds.filter((id) => id !== drop);
    } else if (kind === 5 && merged.some((s) => s.sourceIds.length > 0)) {
      const old = pick(merged.filter((x) => x.sourceIds.length > 0));
      const listed = pick(old.sourceIds);
      const chunk = chunks.find((ch) => ch.id === listed)!;
      const s = summary(`N-${c}`, 1, [chunk.id]);
      s.parentId = old.parentId;
      chunk.l1Id = s.id;
      all.push(s);
    }
  }
  const byId = new Map(all.map((s) => [s.id, s] as const));
  const unlisted = all.some((s) => {
    const parent = s.parentId === undefined ? undefined : byId.get(s.parentId);
    return parent !== undefined && !parent.sourceIds.includes(s.id);
  });
  return {
    inputs: { chunks, summaries: byId, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() },
    unlisted,
  };
}

/** Whether the chunk's pointer chain, up to `level`, has a link that the
 *  summary it names doesn't list: the chunk's L1 not listing the chunk, or a
 *  parent not listing the summary below it. */
function unlistedLinkBelow(inputs: PickerInputs, chunk: PickerChunk, level: number): boolean {
  let s = chunk.l1Id === undefined ? undefined : inputs.summaries.get(chunk.l1Id);
  if (!s) return false;
  if (!s.sourceIds.includes(chunk.id)) return true;
  while (s.level < level) {
    const parent: SummaryEntry | undefined = s.parentId === undefined ? undefined : inputs.summaries.get(s.parentId);
    if (!parent) return false;
    if (!parent.sourceIds.includes(s.id)) return true;
    s = parent;
  }
  return false;
}

test("the forest owns a leaf at a level only where SummaryTree.ancestorAt renders it, and fewer only below an unlisted link", () => {
  // preserveGapBearingSummaries, so the forest accepts the holes the damage
  // leaves instead of refusing them.
  const rng = mulberry32(253);
  let withUnlisted = 0, withFewer = 0;
  const beyond: string[] = [];
  const unexplained: string[] = [];
  for (let t = 0; t < 400; t++) {
    const { inputs, unlisted } = damaged(rng);
    if (unlisted) withUnlisted++;
    const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
    const tree = new SummaryTree(inputs);
    let fewer = false;
    for (const chunk of inputs.chunks) {
      const owned = new Map<number, string>();
      for (const id of forest.leaf(chunk.id)?.summaryIds ?? []) owned.set(inputs.summaries.get(id)!.level, id);
      for (let level = 1; level <= 3; level++) {
        const renders = tree.ancestorAt(chunk.id, level)?.id ?? null;
        const own = owned.get(level) ?? null;
        if (own === renders) continue;
        const at = `tree ${t}, ${chunk.id} at L${level}: forest ${own}, tree ${renders}`;
        if (own !== null) beyond.push(at);
        else if (unlistedLinkBelow(inputs, chunk, level)) fewer = true;
        else unexplained.push(at);
      }
    }
    if (fewer) withFewer++;
  }
  assert.ok(withUnlisted >= 50, `premise: ${withUnlisted} of 400 trees have a parent that doesn't list its child`);
  assert.ok(withFewer >= 10, `premise: in ${withFewer} of 400 trees the forest owns fewer levels than SummaryTree renders`);
  assert.deepEqual(beyond.slice(0, 5), [], `${beyond.length} levels the forest owns that SummaryTree doesn't render`);
  assert.deepEqual(unexplained.slice(0, 5), [], `${unexplained.length} levels the forest leaves out with no unlisted link below`);
});
