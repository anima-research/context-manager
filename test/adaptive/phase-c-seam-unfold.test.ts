/**
 * Phase C un-folds by youngest POSITION, not deepest level.
 *
 * Reproduces the flap measured on Fable (fold-diff, 2026-10-07..09): after
 * the budget-forced fold, the old walk spent the remaining headroom by raising
 * the youngest DEEP group (right after the deep band — a ~300k-token front
 * edit) before any L1 at the seam. Now headroom is spent at the seam: the
 * deep groups are intact and the only raw content is the youngest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout, kvCost } from '../../src/adaptive/render-offsets.js';
import { listedCounts, planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

// 216 chunks = 1 L3 / 6 L2 / 36 L1 (groups of 6, harness chain). 50 raw
// tokens per chunk, 100 per recall pair: a raw group costs 300, its L1 100
// (un-fold quantum +200 at the seam); an L2 over 36 chunks costs 100 against
// six L1s at 600 (un-fold quantum +500 at the deep end) — both quanta fit the
// headroom, as on Fable (L3→L2 ≈ +14k, L1→raw ≈ +12k, headroom ≈ 38k).
function setup() {
  const ch = buildChronicleWithChain({ chunkCount: 216, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const tail = new Set(ch.chunks.slice(210).map((c) => c.id)); // raw tail: last 6
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  const ids = (a: number, b: number): ChunkId[] => ch.chunks.slice(a, b).map((c) => c.id);
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  return { ch, inputs, tree, ids, now, tail };
}

function plan(s: ReturnType<typeof setup>, target: number, W: number) {
  return planControlledFrontier(s.inputs, s.tree, {
    previous: new Map(), foldAtTokens: W, expandAtTokens: target, targetTokens: target,
    windowTokens: W, rawZone: s.tail, now: s.now, mergeThreshold: 6,
  });
}

const histogram = (F: ReadonlyMap<ChunkId, number>, ids: ChunkId[]): Record<number, number> => {
  const h: Record<number, number> = {};
  for (const id of ids) { const l = F.get(id) ?? 0; h[l] = (h[l] ?? 0) + 1; }
  return h;
};

test('phase C spends headroom at the seam: deep groups intact, youngest foldable group raw', () => {
  const s = setup();
  // All 35 foldable L1 groups = 3500 + tail 300 = 3800 > target 3650, so the
  // cut deepens the oldest L2 group (−500) → 3300. Headroom 350: the old walk
  // raised that L2 group first (+500 → 3800, closer than 3300, accepted) — the
  // front edit. By position, two seam groups open instead (+200, +200 → 3700)
  // and the L2 group is never touched.
  const p = plan(s, 3650, 4200);
  const middle = s.ids(0, 210);
  const h = histogram(p.resolutions, middle);
  assert.equal(h[2], 36, `the deep L2 group is intact: ${JSON.stringify(h)}`);
  assert.ok(s.ids(198, 210).every((id) => (p.resolutions.get(id) ?? 0) === 0), 'two youngest foldable groups are raw');
  assert.ok(s.ids(0, 198).every((id) => (p.resolutions.get(id) ?? 0) >= 1), 'nothing older than the seam is raw');
  assert.equal(p.tokens, 3700);
  assert.equal(renderLayout(s.inputs, s.tree, p.resolutions).totalTokens, p.tokens);
});

test('phase C takes the seam quantum that fits and leaves the deep group alone', () => {
  const s = setup();
  // Same fold state (3300), target 3600. The old walk tried the deep L2
  // un-fold first: 3300 → 3800 is 200 from target, closer than 300, so it was
  // accepted and the band moved. By position the seam quantum lands at 3500
  // (100 from target); a second seam un-fold would reach 3700 — not closer —
  // and is reverted, and the deep one (3800) likewise. (At 3550 both walks
  // happened to agree: 3800 and 3300 are equally far, so the old walk also
  // fell through to the seam — #156 review.)
  const p = plan(s, 3600, 4200);
  const h = histogram(p.resolutions, s.ids(0, 210));
  assert.equal(h[2], 36, `the deep L2 group is intact: ${JSON.stringify(h)}`);
  assert.ok(s.ids(204, 210).every((id) => (p.resolutions.get(id) ?? 0) === 0), 'youngest foldable group raw');
  assert.ok(s.ids(0, 204).every((id) => (p.resolutions.get(id) ?? 0) >= 1), 'nothing older is raw');
  assert.equal(p.tokens, 3500);
});

/**
 * Excision shape from the #156 review: a 72-leaf base-6 chain where leaves
 * 36..70 were removed by store surgery, leaving the younger L2 (L2-1) with a
 * single live member (leaf 71) that renders at 300 raw tokens with salience
 * 0.1 while its L2 pair costs 50. Six protected 1-token tail leaves follow.
 * Carried-less bootstrap, target 506 / W 806. Fold state before phase C is
 * 156 (L2-0 at 100 + L2-1 at 50 + tail 6). The youngest survivor's L2→L1 is
 * +50; its L1→raw is +200; the older L2-0's L2→L1 is +500. Walking on after
 * the first accept let L2-0 take the headroom (→706, survivor stuck at L1);
 * restarting after each accept gives 156 → 206 → 406 with the survivor raw
 * and the older group folded.
 */
test('phase C: a singleton group after excision steps all the way down before an older group is touched', () => {
  const ch = buildChronicleWithChain({ chunkCount: 72, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const survivor = ch.chunks[71]!;
  survivor.rawTokens = 300;
  survivor.salience = 0.1;
  // Price the younger L2 at 50 so the survivor's L2→L1 step is +50.
  const l2ids = [...ch.summaries.values()].filter((s) => s.level === 2).map((s) => s.id).sort();
  ch.recallPairTokens.set(l2ids[1]!, 50);
  const removed = new Set(ch.chunks.slice(36, 71).map((c) => c.id));
  const tailIds: ChunkId[] = [];
  for (let i = 0; i < 6; i++) {
    const c = ch.addChunk({ id: `tail-${i}`, rawTokens: 1 });
    // Far ahead in sequence, so the survivor's log-age cap allows L2 and
    // phase A folds it there (the probe's 156 pre-C state); with the tail
    // adjacent its cap is L1 and the case degenerates to a one-step un-fold.
    c.sequence = 200 + i;
    tailIds.push(c.id);
  }
  const chunks = ch.chunks.filter((c) => !removed.has(c.id));
  const tail = new Set(tailIds);
  const inputs: PickerInputs = {
    chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 6, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  let now = 0; for (const c of chunks) if (c.sequence > now) now = c.sequence;
  const p = planControlledFrontier(inputs, tree, {
    previous: new Map(), foldAtTokens: 806, expandAtTokens: 506, targetTokens: 506,
    windowTokens: 806, rawZone: tail, now, mergeThreshold: 6,
  });
  assert.equal(p.resolutions.get(survivor.id) ?? 0, 0, 'youngest survivor is raw');
  for (const id of ch.chunks.slice(0, 36).map((c) => c.id)) {
    assert.equal(p.resolutions.get(id), 2, `${id}: older group stays folded`);
  }
  assert.equal(p.tokens, 406);
});

/**
 * Carried-growth replay (shape from the #156 review): a base-6 chain at 50
 * raw / 100 recall, the last six leaves protected, one appended leaf per
 * turn, a summary every six leaves (upper levels pre-produced), every
 * returned frontier carried into the next solve. Crosses W repeatedly.
 * With the carried-seeded ideal no deep (L3) group is ever raised and the
 * total re-read is well below the from-scratch cut's.
 */
function growthReplay(opts: {
  seedFromCarried?: boolean; turns: number; pinCaps?: ReadonlyMap<ChunkId, number>;
  target?: number; window?: number;
  /** A turn to re-plan on unchanged inputs, after its own plan. */
  replanAt?: number;
  /** List the oldest L1 directly under its L4, dropped from its L2, so its
   *  lineage skips L2 and L3: a store the load repair keeps, since the
   *  pointer names a summary above that lists it (R4-2). */
  oldestL1UnderL4?: boolean;
}) {
  const ch = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 100 });
  let n = 0;
  const add = () => { ch.addChunk({ id: `c-${String(n).padStart(5, '0')}`, rawTokens: 50 }); n++; };
  const produce = () => {
    for (let i = 0; i + 6 <= ch.chunks.length; i += 6) {
      if (!ch.chunks[i]!.l1Id) ch.produceL1(ch.chunks.slice(i, i + 6).map((c) => c.id));
    }
    ch.preProduceUpperLevels();
  };
  for (let i = 0; i < 1296; i++) add();
  produce();
  if (opts.oldestL1UnderL4) {
    const l1 = ch.summaries.get(ch.chunks[0]!.l1Id!)!;
    const l2 = ch.summaries.get(l1.parentId!)!;
    const l4 = ch.summaries.get(ch.summaries.get(l2.parentId!)!.parentId!)!;
    l2.sourceIds = l2.sourceIds.filter((id) => id !== l1.id);
    l4.sourceIds = [...l4.sourceIds, l1.id];
    l1.parentId = l4.id;
  }
  const TARGET = opts.target ?? 1600, W = opts.window ?? 2150;
  let previous = new Map<ChunkId, number>();
  let prevLayout: ReturnType<typeof renderLayout> | null = null;
  let totalPert = 0, deepRaises = 0, folds = 0, releases = 0;
  let replan: { moved: boolean; levels: string } | undefined;
  for (let t = 0; t < opts.turns; t++) {
    add(); produce();
    const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
    const inputs: PickerInputs = {
      chunks: ch.chunks.map((c) => ({ ...c, currentResolution: previous.get(c.id) ?? 0 })),
      summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
      headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
    };
    const tree = new SummaryTree(inputs);
    if (opts.oldestL1UnderL4 && t === 0) {
      const levels = [1, 2, 3, 4].map((k) => tree.ancestorAt('c-00000', k)?.level ?? null);
      assert.deepEqual(levels, [1, null, null, 4], 'premise: the oldest chunk\'s lineage skips L2 and L3');
    }
    let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
    const params = (prev: ReadonlyMap<ChunkId, number>) => ({
      previous: prev, foldAtTokens: W, expandAtTokens: TARGET, targetTokens: TARGET, windowTokens: W,
      rawZone: tail, now, mergeThreshold: 6,
      ...(opts.seedFromCarried === undefined ? {} : { seedFromCarried: opts.seedFromCarried }),
      ...(opts.pinCaps ? { pinCaps: opts.pinCaps } : {}),
    });
    const plan = planControlledFrontier(inputs, tree, params(previous));
    if (t === opts.replanAt) {
      const again = planControlledFrontier(inputs, tree, params(plan.resolutions));
      const levels = (F: ReadonlyMap<ChunkId, number>) => ch.chunks.map((c) => F.get(c.id) ?? 0).join('');
      replan = { moved: levels(again.resolutions) !== levels(plan.resolutions), levels: levels(plan.resolutions) };
    }
    const layout = renderLayout(inputs, tree, plan.resolutions);
    if (prevLayout) totalPert += kvCost(prevLayout, layout);
    for (const c of inputs.chunks) {
      const before = previous.get(c.id) ?? 0, after = plan.resolutions.get(c.id) ?? 0;
      if (before >= 3 && after < before) deepRaises++; // any raise from L3 or deeper (plans reach L4)
    }
    if (t > 0 && plan.folded) folds++; // the bootstrap compile reports `folded` too; count real crossings only
    if (plan.seedingReleased) releases++;
    previous = plan.resolutions; prevLayout = layout;
  }
  return { totalPert, deepRaises, folds, releases, replan };
}

test('carried growth: the seeded ideal never raises a deep group across repeated W crossings', () => {
  // The option is NOT passed: this pins the default (`seedFromCarried ?? true`).
  const seeded = growthReplay({ turns: 120 });
  assert.ok(seeded.folds >= 2, `crossed W at least twice (folds=${seeded.folds})`);
  assert.equal(seeded.deepRaises, 0, 'no L3 leaf was ever raised');
  // The budgets never change here, so the hysteresis is never released: a
  // shed past the fold threshold doesn't weigh the from-scratch cut (R3-3).
  assert.equal(seeded.releases, 0, `the from-scratch cut was taken on ${seeded.releases} turns`);
  const scratch = growthReplay({ seedFromCarried: false, turns: 120 });
  assert.ok(scratch.deepRaises > 0, `the from-scratch ideal does raise deep groups here (${scratch.deepRaises} leaves)`);
  // Both totals include the same pure-append baseline (one 50-token leaf per
  // turn) and the same seam folds; the difference is the band-boundary flap.
  // Measured 20,000 vs 25,900 at 120 turns (this replay's seam folds land
  // right after the deep band, so they are expensive here too); the deep
  // raises above are the load-bearing assertion.
  assert.ok(seeded.totalPert < scratch.totalPert * 0.9,
    `re-read: seeded ${seeded.totalPert} vs from-scratch ${scratch.totalPert}`);
});

/**
 * R3-5: the same replay over 400 turns with chunk 40 pinned at a max level
 * of 2. Its group can fold no deeper than L2, so an older chunk at L2 there
 * is at the deepest level its group can render at, and no evidence that a
 * younger, deeper chunk is inverted (R2-1). Read as evidence, it lowered the
 * deep band again on the turns that followed.
 */
test('carried growth with a pin-max-level: the seeded ideal never raises a deep group', () => {
  const pinned = growthReplay({ turns: 400, pinCaps: new Map([['c-00040', 2]]) });
  assert.ok(pinned.folds >= 2, `premise: crossed W at least twice (folds=${pinned.folds})`);
  assert.equal(pinned.deepRaises, 0, `${pinned.deepRaises} leaves were raised from L3 or deeper`);
});

/**
 * R4-2: an older chunk is weighed only against younger chunks at or above the
 * next level it can fold to. The oldest L1 here is listed directly by its L4,
 * so it can't fold to L2 or L3. Weighed against every younger L2 and L3, it
 * lowered the whole younger band on every seeded compile, and when the hold's
 * quality-gap check failed the plan took that ideal and raised the youngest
 * L3 group: 432 leaves over 400 turns. Without that, the store re-reads what
 * the same stream does on a clean store.
 */
test('carried growth: an L1 whose lineage skips to its L4 lowers nothing younger, so the replay re-reads what a clean store does (R4-2)', () => {
  const skip = growthReplay({ turns: 400, oldestL1UnderL4: true });
  const clean = growthReplay({ turns: 400 });
  assert.ok(skip.folds >= 2, `premise: crossed W at least twice (folds=${skip.folds})`);
  assert.equal(skip.deepRaises, 0, `${skip.deepRaises} leaves were raised from L3 or deeper`);
  assert.equal(skip.totalPert, clean.totalPert, `re-read: ${skip.totalPert} on the skipping store, ${clean.totalPert} on the clean one`);
});

/**
 * R3-4: a boundary-cut fold settles. On the replay at target 3650 / W 4200,
 * turn 180 leaves the L1 group of chunks 1470 to 1475 straddling the raw
 * tail, and the plan folds its one non-tail member, chunk 1470, with older
 * chunks beside it raw. Re-planned on unchanged inputs, the seeded plan keeps
 * that fold: the member's group holds tail chunks, so it isn't read as an
 * inversion to lower.
 */
test('carried growth: a boundary-cut fold at the raw tail settles on unchanged inputs', () => {
  const { replan } = growthReplay({ turns: 181, target: 3650, window: 4200, replanAt: 180 });
  assert.ok(replan, 'turn 180 was re-planned');
  // The premise: the straddling group's non-tail member is folded, and a chunk of the group before it is raw.
  assert.ok(Number(replan.levels[1470]) > 0, `chunk 1470 is folded: ${replan.levels.slice(1458)}`);
  assert.ok(replan.levels.slice(1464, 1470).includes('0'), `a chunk before it is raw: ${replan.levels.slice(1458)}`);
  assert.equal(replan.moved, false, 'the plan re-planned on unchanged inputs moved');
});

/**
 * Past the trust region, a release's cut goes through step 5 as any ideal
 * does (review I3). A 36-leaf chain carried at a tight budget and raised: the
 * seeded plan would pay the whole from-scratch re-read, so seeding is
 * released. With a trust region of 100 tokens, no changed suffix of the
 * from-scratch cut fits, and holding the deep carried profile is certifiably
 * worse, so the quality-gap override adopts the whole cut.
 */
test('seeded ideal: past a small trust region, the quality-gap override adopts a release\'s cut whole', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  const solve = (previous: ReadonlyMap<ChunkId, number>, target: number, W: number, extra: { seedFromCarried?: boolean; reachTokens?: number } = {}) =>
    planControlledFrontier(inputs, tree, {
      previous, foldAtTokens: W, expandAtTokens: target, targetTokens: target, windowTokens: W,
      rawZone: tail, now, mergeThreshold: 6, ...extra,
    });
  const levels = (F: ReadonlyMap<ChunkId, number>) => ch.chunks.map((c) => F.get(c.id) ?? 0).join('');
  const tight = solve(new Map(), 400, 450);
  // The whole from-scratch cut: no seeding, and a trust region it fits in.
  const scratch = solve(tight.resolutions, 1700, 2000, { seedFromCarried: false, reachTokens: 1_000_000 });
  const raised = solve(tight.resolutions, 1700, 2000, { reachTokens: 100 });
  assert.equal(raised.seedingReleased, true, 'premise: the raise releases seeding');
  assert.ok(raised.perturbation > 100, `premise: the cut re-reads past the trust region (${raised.perturbation})`);
  assert.equal(raised.override, 'quality-gap');
  assert.equal(levels(raised.resolutions), levels(scratch.resolutions), 'the whole from-scratch cut, chunk by chunk');
});

/**
 * R2-3: the hysteresis is released when it buys nothing. A chain carried at a
 * tight budget and then given a much larger one: the seeded plan would keep
 * the deep allocation while paying ~95% of the from-scratch rewrite anyway,
 * so the from-scratch cut is taken (`seedingReleased`). A modest raise keeps
 * the seeded allocation (deep groups stay; headroom spent at the seam).
 */
test('seeded ideal: a large budget raise takes the from-scratch allocation; a modest one keeps the seeded one', () => {
  const ch = buildChronicleWithChain({ chunkCount: 1296, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  const solve = (previous: ReadonlyMap<ChunkId, number>, target: number, W: number, seedFromCarried?: boolean, reachTokens?: number) =>
    planControlledFrontier(inputs, tree, {
      previous, foldAtTokens: W, expandAtTokens: target, targetTokens: target, windowTokens: W,
      rawZone: tail, now, mergeThreshold: 6, ...(seedFromCarried === undefined ? {} : { seedFromCarried }),
      ...(reachTokens === undefined ? {} : { reachTokens }),
    });
  const hist = (F: ReadonlyMap<ChunkId, number>) => {
    const h: Record<number, number> = {};
    for (const c of ch.chunks) { const l = F.get(c.id) ?? 0; h[l] = (h[l] ?? 0) + 1; }
    return h;
  };
  // Each chunk's level, in chunk order: two plans agree only chunk by chunk.
  const levels = (F: ReadonlyMap<ChunkId, number>) => ch.chunks.map((c) => F.get(c.id) ?? 0).join('');
  const atLevel = (F: ReadonlyMap<ChunkId, number>, level: number) => ch.chunks.filter((c) => (F.get(c.id) ?? 0) === level).map((c) => c.id);
  // Tight: 1,290 foldable leaves must fit in ~1,600 → deep L3s.
  const tight = solve(new Map(), 1600, 2150);
  assert.ok((hist(tight.resolutions)[3] ?? 0) > 0, 'tight budget folds to L3');

  // Large raise (×8): the from-scratch cut opens the deep groups; the seeded
  // plan would have paid nearly the same re-read for a worse allocation.
  const big = solve(tight.resolutions, 12_800, 17_200);
  const bigScratch = solve(tight.resolutions, 12_800, 17_200, false);
  assert.equal(big.seedingReleased, true, 'hysteresis released on a large raise');
  assert.equal(levels(big.resolutions), levels(bigScratch.resolutions), 'the same levels as from scratch, chunk by chunk');

  // The same raise with a trust region between the seeded ideal's re-read
  // (12,300) and the from-scratch cut's (12,800): the release still takes the
  // from-scratch cut, step 5 adopts a suffix of it within the trust region,
  // and the plan reports the release.
  const capped = solve(tight.resolutions, 12_800, 17_200, undefined, 12_500);
  assert.equal(capped.seedingReleased, true, 'the release past the trust region is reported');
  assert.equal(capped.perturbation, 12_200, 'a suffix of the from-scratch cut, within the trust region');
  assert.equal(capped.tokens, 12_300);

  // With a trust region of 1,000, no part of the from-scratch cut fits, so
  // step 5 adopts none of it, and the plan reports no release.
  const none = solve(tight.resolutions, 12_800, 17_200, undefined, 1_000);
  assert.equal(none.perturbation, 0, 'premise: no part of the from-scratch cut fits within 1,000');
  assert.notEqual(none.seedingReleased, true, 'a plan that takes none of the from-scratch cut reports no release');

  // Modest raise (×1.1): headroom goes to the seam; the deep groups stay.
  const small = solve(tight.resolutions, 1760, 2365);
  assert.notEqual(small.seedingReleased, true, 'hysteresis kept on a modest raise');
  assert.deepEqual(atLevel(small.resolutions, 3), atLevel(tight.resolutions, 3), 'the same L3 leaves');
});

/**
 * R4-1: phase C walks only the chunks that can still un-fold. A store carried
 * at L1 and given a budget near raw un-folds its groups youngest first, one
 * per pass. Restarting each pass at the youngest position walked every group
 * already taken raw again, so the walk grew with the square of the groups
 * un-folded: 139,535 visits here. Skipping only the raw run at the young end
 * fixed that case, but a youngest group that stays declined (its un-fold
 * would pass W) pinned the start, and the walk behind it grew the same way.
 * R5-1: a group the accept test declines stayed on the walk, and every
 * accept cleared what had been tried, so each declined group was visited and
 * re-tried once per accept: with every third group declined, 31,247 visits
 * over 143 passes here. A declined group now leaves the walk until an accept
 * moves a leaf its verdict read.
 * Counted rather than timed, so a loaded runner can't flake it: under
 * KV_TIMING the planner logs each phase C's passes and visits.
 */
function phaseCRuns(shape: 'plain' | 'bigYoungGroup' | 'shortThirds') {
  const ch = buildChronicleWithChain({ chunkCount: 1296, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const bigYoungGroup = shape === 'bigYoungGroup';
  // The youngest group before the raw tail: 10,000 tokens a chunk, so its
  // un-fold from L1 would pass W and is declined on every pass.
  if (bigYoungGroup) for (const c of ch.chunks.slice(-12, -6)) c.rawTokens = 10_000;
  // Every third L1 group of six 10-token chunks: raw, it costs less than its
  // 100-token recall, so un-folding it lowers the ledger and is declined.
  const short = shape === 'shortThirds' ? ch.chunks.filter((_, i) => Math.floor(i / 6) % 3 === 1) : [];
  for (const c of short) c.rawTokens = 10;
  const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  const previous = new Map(ch.chunks.filter((c) => !tail.has(c.id)).map((c) => [c.id, 1] as const));
  const lines: string[] = [];
  const diagnostics = { error: (m: string) => { lines.push(m); }, warn: (m: string) => { lines.push(m); } };
  const timing = process.env.KV_TIMING;
  process.env.KV_TIMING = '1';
  let plan;
  try {
    // Every chunk but the big group's raw is 64,500 tokens, and with the big
    // group at L1, 64,600: the target, under W. With the short groups at L1
    // and the rest raw, 144 groups at 300 and 72 at 100: 50,400.
    const target = bigYoungGroup ? 64_600 : shape === 'shortThirds' ? 50_400 : 64_800;
    plan = planControlledFrontier(inputs, tree, {
      previous, foldAtTokens: 70_000, expandAtTokens: target, targetTokens: target, windowTokens: 70_000,
      rawZone: tail, now, mergeThreshold: 6, diagnostics,
    });
  } finally {
    if (timing === undefined) delete process.env.KV_TIMING; else process.env.KV_TIMING = timing;
  }
  const runs = lines.flatMap((l) => {
    const m = /\[kv-timing\] phase-c \d+ms passes=(\d+) visits=(\d+)/.exec(l);
    return m ? [{ passes: Number(m[1]), visits: Number(m[2]) }] : [];
  });
  return { runs, chunks: ch.chunks.length, plan, young: ch.chunks.slice(-12, -6).map((c) => c.id) };
}

test('phase C: a large raise walks each chunk a bounded number of times, not once per un-fold (R4-1)', () => {
  const { runs, chunks } = phaseCRuns('plain');
  assert.ok(runs.some((r) => r.passes >= 200), `premise: phase C un-folded about 215 groups, one per pass (${JSON.stringify(runs)})`);
  for (const r of runs) assert.ok(r.visits <= 3 * chunks, `phase C counted ${r.visits} visits over ${r.passes} passes`);
});

test('phase C: a youngest group that stays declined doesn\'t make the walk rescan the groups behind it (R4-1)', () => {
  const { runs, chunks, plan, young } = phaseCRuns('bigYoungGroup');
  assert.ok(runs.some((r) => r.passes >= 200), `premise: phase C un-folded about 214 groups, one per pass (${JSON.stringify(runs)})`);
  assert.ok(young.every((id) => plan.resolutions.get(id) === 1), 'premise: the big youngest group stays at L1');
  for (const r of runs) assert.ok(r.visits <= 3 * chunks, `phase C counted ${r.visits} visits over ${r.passes} passes`);
});

test('phase C: groups it declines leave the walk, so they aren\'t re-tried after every accept (R5-1)', () => {
  // The plan returned is the release's from-scratch cut. The bound holds for
  // every phase C the plan runs: the seeded one, and the release's
  // from-scratch one, which un-folds nothing here.
  const { runs, chunks, plan } = phaseCRuns('shortThirds');
  assert.ok(runs.some((r) => r.passes >= 140), `premise: phase C un-folded about 143 groups, one per pass (${JSON.stringify(runs)})`);
  assert.equal(plan.seedingReleased, true, 'premise: the release took the from-scratch cut');
  for (const r of runs) assert.ok(r.visits <= 3 * chunks, `phase C counted ${r.visits} visits over ${r.passes} passes`);
});

/**
 * R5-1's other half: a group phase C couldn't take returns to the walk when
 * an accept moves a leaf its verdict read. A damaged store, as the settle
 * check's generator makes them (seed 9, tree 1066), where L1-4 also lists
 * m16, R-1 is a stray L1 over m17 and m18, and L1-5 and L2-3 point at
 * parents that don't list them. Raised eightfold from its bootstrap, L2-3
 * (m14, m15, m16, m18) is ineligible while m16, which L1-4 also lists, sits
 * at L3. L3-0's accept brings m16 to L2, L2-3 goes back on the walk, and its
 * un-fold is accepted. With L2-3 kept off the walk instead, the release
 * doesn't fire and the plan leaves m1, m14, m15 and m18 at L1.
 */
test('phase C: a group it couldn\'t take returns to the walk once an accept moves a leaf it read (R5-1)', () => {
  const chunks = 'm0:45:L1-0 m1:42:L1-1 m2:45 m3:117 m4:137:L1-2 m5:55:L1-2 m6:52:L1-3 m7:100:L1-4 m8:145:L1-5 m9:172:L1-6 m10:91:L1-6 m11:198:L1-6 m12:133:L1-7 m13:90:L1-7 m14:56:L1-8 m15:146:L1-8 m16:106:L1-9 m17:56:R-1 m18:113:L1-10 m19:131:L1-10 m20:73:L1-10'
    .split(' ').map((spec, sequence) => {
      const [id, tokens, l1Id] = spec.split(':');
      return { id, sequence, rawTokens: Number(tokens), currentResolution: 0, lockedByAgent: false, pinned: false, ...(l1Id ? { l1Id } : {}) };
    });
  const summaries = new Map('L1-0:22:m0^L2-0 L1-1:43:m1^L2-0 L1-2:33:m4,m5^L2-1 L1-3:27:m6^L2-1 L1-4:14:m7,m16^L2-1 L1-5:18:m8^L2-0 L1-6:18:m9,m10,m11^L2-2 L1-7:32:m12,m13^L2-2 L1-8:16:m14,m15^L2-3 L1-9:21:m16,m17^L2-3 L1-10:40:m18,m19,m20^L2-3 L2-0:30:L1-0,L1-1^L3-0 L2-1:30:L1-2,L1-3,L1-4^L3-0 L2-2:44:L1-5,L1-6,L1-7^L3-1 L2-3:16:L1-8,L1-9,L1-10^L3-0 L3-0:11:L2-0,L2-1 L3-1:38:L2-2,L2-3 R-1:39:m17,m18'
    .split(' ').map((spec) => {
      const [head, parentId] = spec.split('^');
      const [id, tokens, sources] = head.split(':');
      const level = Number(id.startsWith('R') ? 1 : id[1]);
      const sourceIds = sources.split(',');
      return [id, {
        id, level, sourceLevel: level - 1, sourceIds, tokens: Number(tokens), content: `summary ${id}`, timestamp: 0,
        sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] }, ...(parentId ? { parentId } : {}),
      }] as const;
    }));
  const inputs = { chunks, summaries, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() } as unknown as PickerInputs;
  const tree = new SummaryTree(inputs);
  const common = { rawZone: new Set(['m19', 'm20']), now: 26, mergeThreshold: 2, seedFromCarried: true };
  const levels = (F: ReadonlyMap<ChunkId, number>) => chunks.map((c) => F.get(c.id) ?? 0).join('');
  const boot = planControlledFrontier(inputs, tree, {
    ...common, previous: new Map(), targetTokens: 327, foldAtTokens: 577, windowTokens: 4206, reachTokens: 4206,
  });
  assert.equal(levels(boot.resolutions), '330033331333332231200', 'premise: the bootstrap holds m16 at L3 and m14, m15 and m18 at L2');
  const raised = planControlledFrontier(inputs, tree, {
    ...common, previous: boot.resolutions, targetTokens: 2616, foldAtTokens: 4616, windowTokens: 33648, reachTokens: 33648,
  });
  assert.equal(raised.seedingReleased, true, 'the seeded cut re-read enough for the release');
  assert.equal(levels(raised.resolutions), '0'.repeat(chunks.length), 'every chunk raw, as before R5-1');
});

/**
 * R5-1's landing half: a group's verdict also reads the leaves of each
 * summary its un-fold would land on, so an accept that moves one of those
 * returns it to the walk too. Leaves b, a, c (1,000 raw tokens each); S, an
 * L1 over a and b (100), T over c (80), both pointing at H, an L2 that lists
 * a and c through stray L1s and omits b (60); H points at J, an L3 that
 * lists b through another branch and omits a and c (90). Carried with b at
 * L3 and a and c at L2, at 150 of a target of 190: H's un-fold lands a on S
 * and c on T, 270, and is declined. J's un-fold lands b on S, 160, and is
 * taken. That moves b, which S lists, so H, whose landing S read b, is tried
 * again: a joins b on S and c lands on T, 180. Kept off the walk, H leaves
 * the plan at 160.
 */
test('phase C: a group returns to the walk once an accept moves a leaf of a summary its un-fold would land on (R5-1)', () => {
  const chunks = [{ id: 'b', l1Id: 'S' }, { id: 'a', l1Id: 'S' }, { id: 'c', l1Id: 'T' }]
    .map((c, sequence) => ({ ...c, sequence, rawTokens: 1000, currentResolution: 0, lockedByAgent: false, pinned: false }));
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string) => [id, {
    id, level, sourceLevel: level - 1, sourceIds, tokens, content: `summary ${id}`, timestamp: 0,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] }, ...(parentId ? { parentId } : {}),
  }] as const;
  const summaries = new Map([
    summary('S', 1, ['a', 'b'], 100, 'H'), summary('T', 1, ['c'], 80, 'H'),
    summary('Ra', 1, ['a'], 1), summary('Rc', 1, ['c'], 1), summary('H', 2, ['Ra', 'Rc'], 60, 'J'),
    summary('Bl', 1, ['b'], 1), summary('Bk', 2, ['Bl'], 1), summary('J', 3, ['Bk'], 90),
  ]);
  const inputs = { chunks, summaries, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() } as unknown as PickerInputs;
  const tree = new SummaryTree(inputs);
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map([['b', 3], ['a', 2], ['c', 2]]), targetTokens: 190, foldAtTokens: 100_000, windowTokens: 100_000, reachTokens: 100_000,
    rawZone: new Set(), now: chunks.length, mergeThreshold: 2, seedFromCarried: true,
  });
  assert.deepEqual(Object.fromEntries(chunks.map((c) => [c.id, plan.resolutions.get(c.id) ?? 0])), { b: 1, a: 1, c: 1 });
  assert.equal(plan.tokens, 180);
});

/**
 * R6-1: a cleared key puts its parked chunks back on the walk, each at its
 * place among the chunks still listed. Finding that place by scanning back
 * over every unlisted position took a step per position passed, so one
 * relist per accept behind a long parked run was quadratic. The shape is the
 * round-6 review's second, with a second leaf under each parent so that its
 * un-fold is taken: group i is an L1 K_i over x_i, among the older chunks,
 * and b_i, among the younger. Its parent, the L2 P_i, lists a stray L1 R_i
 * over x_i and an L1 W_i over w_i, but not K_i, so it renders x_i and not
 * b_i. Carried with x_i and w_i at L2 and b_i at L1, K_i can't be taken and
 * parks b_i. Each P_i accept brings x_i to L1, which clears K_i's key and
 * relists b_i behind the parked b_j: with the scan back counted, phase C took
 * 1,502,500 visits here. Under KV_TIMING, phase C counts each step of
 * relist's search as a visit.
 */
test('phase C: a cleared key relists its parked chunks in O(log n) steps each, not by scanning back over the unlisted run (R6-1)', () => {
  const n = 1000;
  const chunks = [
    ...Array.from({ length: n }, (_, i) => [{ id: `x${i}`, l1Id: `K${i}` }, { id: `w${i}`, l1Id: `W${i}` }]).flat(),
    ...Array.from({ length: n }, (_, i) => ({ id: `b${i}`, l1Id: `K${i}` })),
  ].map((c, sequence) => ({ ...c, sequence, rawTokens: 10, currentResolution: 0, lockedByAgent: false, pinned: false }));
  const summary = (id: string, level: number, sourceIds: string[], tokens: number, parentId?: string) => [id, {
    id, level, sourceLevel: level - 1, sourceIds, tokens, content: `summary ${id}`, timestamp: 0,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] }, ...(parentId ? { parentId } : {}),
  }] as const;
  const summaries = new Map(Array.from({ length: n }, (_, i) => [
    summary(`R${i}`, 1, [`x${i}`], 20, `P${i}`),
    summary(`W${i}`, 1, [`w${i}`], 30, `P${i}`),
    summary(`K${i}`, 1, [`x${i}`, `b${i}`], 20, `P${i}`),
    summary(`P${i}`, 2, [`R${i}`, `W${i}`], 10),
  ]).flat());
  const inputs = { chunks, summaries, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() } as unknown as PickerInputs;
  const tree = new SummaryTree(inputs);
  const target = 55_000;
  const lines: string[] = [];
  const diagnostics = { error: (m: string) => { lines.push(m); }, warn: (m: string) => { lines.push(m); } };
  const timing = process.env.KV_TIMING;
  process.env.KV_TIMING = '1';
  try {
    planControlledFrontier(inputs, tree, {
      previous: new Map(chunks.map((c) => [c.id, c.id.startsWith('b') ? 1 : 2] as const)), targetTokens: target, foldAtTokens: 4 * target, windowTokens: 8 * target, reachTokens: 8 * target,
      rawZone: new Set(), now: chunks.length, mergeThreshold: 2, seedFromCarried: true, diagnostics,
    });
  } finally {
    if (timing === undefined) delete process.env.KV_TIMING; else process.env.KV_TIMING = timing;
  }
  const runs = lines.flatMap((l) => {
    const m = /\[kv-timing\] phase-c \d+ms passes=(\d+) visits=(\d+)/.exec(l);
    return m ? [{ passes: Number(m[1]), visits: Number(m[2]) }] : [];
  });
  // Each of the n relists searches with olderThan, whose descent alone takes
  // ⌊log₂ chunks⌋ + 1 steps while an older chunk is listed. Here the walk's
  // own visits come to 4,000 and the searches add the rest, so past
  // n·⌊log₂ chunks⌋ = 11,000 visits a phase C counted the relists' search.
  assert.ok(runs.some((r) => r.visits > n * Math.floor(Math.log2(chunks.length))), `premise: the relists' search steps are counted (${JSON.stringify(runs)})`);
  const bound = 3 * chunks.length * Math.ceil(Math.log2(chunks.length));
  for (const r of runs) assert.ok(r.visits <= bound, `phase C took ${r.visits} steps over ${r.passes} passes, past ${bound}`);
});

/**
 * R7-1: a declined group was tried again after every accept that moved a leaf
 * its summary lists but doesn't render, and each try walked its whole listing
 * and filed its key under every leaf again. The shape is the round-7 review's:
 * an L1 G over six young leaves, whose listing also holds k older leaves z_i,
 * each rendered by an L1 Z_i of its own. Carried at L1, each Z_i's un-fold is
 * taken, while G's, whose six leaves raw cost less than its recall, is
 * declined; each Z_i accept moved z_i, which G lists, so G was tried again:
 * 105,001 visits at k = 1,000. A key is filed only under the leaves its
 * summary renders at that level, so G stays declined.
 */
test('phase C: a declined group isn\'t tried again when an accept moves a leaf its summary lists but doesn\'t render (R7-1)', () => {
  const k = 1000;
  const chunks = [
    ...Array.from({ length: k }, (_, i) => ({ id: `z${i}`, l1Id: `Z${i}`, rawTokens: 50 })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, l1Id: 'G', rawTokens: 10 })),
  ].map((c, sequence) => ({ ...c, sequence, currentResolution: 0, lockedByAgent: false, pinned: false }));
  const summary = (id: string, sourceIds: string[], tokens: number) => [id, {
    id, level: 1, sourceLevel: 0, sourceIds, tokens, content: `summary ${id}`, timestamp: 0,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
  }] as const;
  const summaries = new Map([
    ...Array.from({ length: k }, (_, i) => summary(`Z${i}`, [`z${i}`], 20)),
    summary('G', [...Array.from({ length: k }, (_, i) => `z${i}`), ...Array.from({ length: 6 }, (_, i) => `g${i}`)], 61),
  ]);
  const inputs = { chunks, summaries, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set() } as unknown as PickerInputs;
  const tree = new SummaryTree(inputs);
  // Carried at L1, with a target every z_i can go raw under.
  const target = 20 * k + 61 + 50 * k;
  const lines: string[] = [];
  const diagnostics = { error: (m: string) => { lines.push(m); }, warn: (m: string) => { lines.push(m); } };
  const timing = process.env.KV_TIMING;
  process.env.KV_TIMING = '1';
  try {
    planControlledFrontier(inputs, tree, {
      previous: new Map(chunks.map((c) => [c.id, 1] as const)), targetTokens: target, foldAtTokens: 4 * target, windowTokens: 8 * target, reachTokens: 8 * target,
      rawZone: new Set(), now: chunks.length, mergeThreshold: 2, seedFromCarried: true, diagnostics,
    });
  } finally {
    if (timing === undefined) delete process.env.KV_TIMING; else process.env.KV_TIMING = timing;
  }
  const runs = lines.flatMap((l) => {
    const m = /\[kv-timing\] phase-c \d+ms passes=(\d+) visits=(\d+)/.exec(l);
    return m ? [{ passes: Number(m[1]), visits: Number(m[2]) }] : [];
  });
  // Each Z_i accept ends a pass, and the last pass takes nothing: k + 1 passes only where G is never taken.
  assert.ok(runs.some((r) => r.passes === k + 1), `premise: phase C took the z_i one accept a pass, and G stayed declined (${JSON.stringify(runs)})`);
  for (const r of runs) assert.ok(r.visits <= 3 * chunks.length, `phase C took ${r.visits} visits over ${r.passes} passes, past ${3 * chunks.length}`);
});

test('phase C: the walk list\'s predecessor query gives the next older listed position, as scanning back would', () => {
  let seed = 156;
  const random = (m: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % m; };
  let checked = 0, none = 0;
  for (const n of [1, 2, 3, 7, 8, 9, 64, 300]) {
    const { count, olderThan } = listedCounts(n);
    const listed = new Uint8Array(n);
    for (let op = 0; op < 20 * n; op++) {
      const i = random(n);
      if (random(2) === 1) { if (!listed[i]) { listed[i] = 1; count(i, 1); } } else if (listed[i]) { listed[i] = 0; count(i, -1); }
      const at = random(n);
      let older = at - 1;
      while (older >= 0 && !listed[older]) older--;
      assert.equal(olderThan(at), older, `n=${n}: the listed position before ${at}`);
      checked++;
      if (older === -1) none++;
    }
  }
  assert.ok(none > 0 && none < checked, `premise: some queries have no older listed position and some do (${none} of ${checked})`);
});
