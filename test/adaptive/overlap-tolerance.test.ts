/**
 * Overlap tolerance + fold→project fixpoint (2026-08-03, opus4 regression).
 *
 * After store surgery a summary "tree" can be NON-NESTED: a group's
 * leafChunkIds may include a leaf whose own l1Id lineage tops out below the
 * group's level or climbs through a different family (e.g. a re-minted L1
 * with different boundaries overlapping an old lineage).
 *
 * Old behavior: foldPass marked such leaves at the group's level anyway; the
 * final validity projection (monotone-lowering) then un-folded the WHOLE
 * group around the one disagreeing leaf — on opus4, 615 leaves cascaded
 * (+24k tokens), the solve returned an over-W frontier, and a produced L4/L5
 * layer sat unused ("deepest fold level=L3" with L4s present).
 *
 * New behavior: disagreeing leaves are skipped by folds and exempted from
 * unanimity (they render through their own lineage, or raw, beside the recall:
 * the renderer's existing ownership-wins semantics), and the solve iterates
 * fold→project until the render fits under W.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier, replayControlled, reportOverlap, type ControlPlanParams, type ControlResult } from '../../src/adaptive/kv-control.js';
import { renderLayout, kvCost, type RenderLayout } from '../../src/adaptive/render-offsets.js';
import { Picker } from '../../src/adaptive/picker.js';
import { KvStableStrategy } from '../../src/adaptive/strategies/kv-stable.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';
import type { PickerChunk, PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import type { SummaryEntry } from '../../src/types/strategy.js';
import { getSummaryParentId } from '../../src/types/strategy.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

/** 90 chunks × 1000t, base-6 chain, then one ROGUE overlapping L1:
 *  c-0007's own lineage is re-pointed at an unmerged L1-R (sourceIds
 *  c-0007..c-0008, different boundaries) while the original L1/L2 lineage
 *  still lists c-0007 among its leaves — a non-nested tree. */
function corruptedSession(): { inputs: PickerInputs; tree: SummaryTree } {
  const ch = buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const template = ch.summaries.values().next().value as SummaryEntry;
  const rogue: SummaryEntry = {
    ...template,
    id: 'L1-ROGUE',
    level: 1,
    sourceLevel: 0,
    sourceIds: ['c-0007', 'c-0008'],
    sourceRange: { first: 'c-0007', last: 'c-0008' },
  };
  delete (rogue as { mergedInto?: string }).mergedInto;
  delete (rogue as { parentId?: string }).parentId; // harness entries carry parentId; the rogue is unmerged
  ch.summaries.set(rogue.id, rogue);
  ch.recallPairTokens.set(rogue.id, 200);
  const c7 = ch.chunks.find((c) => c.id === 'c-0007')!;
  c7.l1Id = 'L1-ROGUE';
  const inputs = inputsOf(ch);
  return { inputs, tree: new SummaryTree(inputs) };
}

test('a lineage-disagreeing leaf does not un-fold its group (overlap tolerance)', () => {
  const { inputs, tree } = corruptedSession();
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 2_000, expandAtTokens: 1_000, targetTokens: 1_000,
    windowTokens: 2_000, rawZone: new Set(), now: 89, mergeThreshold: 6,
  });

  // The physics hold: W is the only wall. (Old code: the projection avalanche
  // lowered the whole L2 group and the returned render busted W.)
  assert.ok(plan.tokens <= 2_000, `render fits under W (${plan.tokens})`);

  // The first L2 group (c-0000..0035) folds to 2 despite the rogue member —
  // the avalanche would have lowered all 36 to L1.
  let atL2 = 0;
  for (let i = 0; i < 36; i++) {
    const id = `c-${String(i).padStart(4, '0')}`;
    if (id === 'c-0007') continue;
    if ((plan.resolutions.get(id) ?? 0) === 2) atL2++;
  }
  assert.ok(atL2 >= 30, `L2 group survives the disagreeing member (${atL2}/35 at L2)`);

  // The rogue leaf itself is never marked at a level its lineage can't render.
  const rogueLevel = plan.resolutions.get('c-0007') ?? 0;
  assert.ok(rogueLevel <= 1, `disagreeing leaf stays at its own lineage depth (L${rogueLevel})`);
});

// ---------------------------------------------------------------------------
// The next compile keeps the exemption. A leaf that a summary lists, but whose
// own lineage at the summary's level is another summary or none, renders
// through its own lineage beside the summary. The validity projection leaves
// such a leaf out of the summary's unanimity for the carried frontier and for
// each suffix candidate, as for the ideal cut. When only the ideal cut's
// projection left it out, the next compile un-folded the summary around it.

function summary(id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): SummaryEntry {
  return {
    id, level, sourceLevel: level - 1, sourceIds, tokens, content: `summary ${id}`, created: 0,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
    ...(parentId ? { parentId } : {}),
  };
}

function message(id: string, sequence: number, rawTokens: number, l1Id?: string): PickerChunk {
  return { id, sequence, rawTokens, currentResolution: 0, lockedByAgent: false, pinned: false, ...(l1Id ? { l1Id } : {}) };
}

function store(chunks: PickerChunk[], summaries: SummaryEntry[]): { inputs: PickerInputs; tree: SummaryTree } {
  const inputs: PickerInputs = {
    chunks, summaries: new Map(summaries.map((s) => [s.id, s])),
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  return { inputs, tree: new SummaryTree(inputs) };
}

const unitsOf = (layout: RenderLayout): string[] => layout.units.map((u) => `${u.kind}:${u.key}`);

/** The summary a leaf's lineage reaches at a level, walking the inputs' links
 *  as the renderer does: the leaf's L1, then each parent above it. */
function lineageAt(inputs: PickerInputs, id: ChunkId, level: number): SummaryEntry | undefined {
  const chunk = inputs.chunks.find((c) => c.id === id);
  let cur = chunk?.l1Id === undefined ? undefined : inputs.summaries.get(chunk.l1Id);
  while (cur && cur.level < level) {
    const parentId = getSummaryParentId(cur);
    const parent = parentId === undefined ? undefined : inputs.summaries.get(parentId);
    if (!parent || parent.level <= cur.level) return undefined;
    cur = parent;
  }
  return cur?.level === level ? cur : undefined;
}

/** Whether a summary lists a message, through its sources. */
function listsLeaf(inputs: PickerInputs, s: SummaryEntry, id: ChunkId, seen = new Set<string>()): boolean {
  if (seen.has(s.id)) return false;
  seen.add(s.id);
  if (s.sourceLevel === 0) return s.sourceIds.includes(id);
  return s.sourceIds.some((child) => {
    const entry = inputs.summaries.get(child);
    return entry !== undefined && listsLeaf(inputs, entry, id, seen);
  });
}

/** The summary a leaf renders through at a level, read from the inputs: the
 *  one its lineage reaches there, when that summary lists the leaf. */
function rendersThrough(inputs: PickerInputs, id: ChunkId, level: number): SummaryEntry | undefined {
  const s = level > 0 ? lineageAt(inputs, id, level) : undefined;
  return s && listsLeaf(inputs, s, id) ? s : undefined;
}

/** A plan's overlap when nothing it renders disagrees with a leaf. */
const NO_OVERLAP: readonly ChunkId[] = [];

/** The [kv-overlap] lines logged while `fn` runs, caught rather than printed. */
function overlapLines(fn: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('[kv-overlap]')) lines.push(String(args[0]));
    else original(...args);
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/** m1's L1 A has no parent, but L2 G's sources are A, B and C, so G lists m1
 *  while m1's own lineage stops at A. Fully folded, the window is A beside G
 *  (70 tokens); with G un-folded around m1, it is A, B and C (90). */
function disagreeingTrio(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('A', 1, ['m1'], 30),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
}

/** As the trio, but A's parent is L2 H, which doesn't list A: m1's own
 *  lineage reaches level 2 through H, not G. H covers m0 alone. Fully folded,
 *  the window is H, A beside G (110 tokens). */
function crossParentedTrio(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m0', 0, 100, 'D'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('D', 1, ['m0'], 30, 'H'),
      summary('H', 2, ['D'], 40),
      summary('A', 1, ['m1'], 30, 'H'),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
}

/** Two L2s list A: its own parent P, with C, and Q, with B. A pin caps C at
 *  L1, so P can't fold, and A stays at L1 beside Q. */
function twoParentsOneCapped(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('A', 1, ['m1'], 30, 'P'),
      summary('B', 1, ['m2'], 30, 'Q'),
      summary('C', 1, ['m3'], 30, 'P'),
      summary('P', 2, ['A', 'C'], 40),
      summary('Q', 2, ['A', 'B'], 40),
    ],
  );
}

/** A lists m0 and m1, and its parent is L2 P, which doesn't list A: P's one
 *  source is C, which lists m2 and also m1. So m1 folds to L2 through P,
 *  above A, while P doesn't cover m0. L2 Q lists A and D. Fully folded, the
 *  window is A, P and Q beside raw m4 (170 tokens); with A un-folded because
 *  m1 sits above it, m0 renders raw (240). */
function ownLeafFoldedAbove(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m0', 0, 100, 'A'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'C'), message('m3', 3, 100, 'D'), message('m4', 4, 100)],
    [
      summary('A', 1, ['m0', 'm1'], 30, 'P'),
      summary('C', 1, ['m2', 'm1'], 30, 'P'),
      summary('D', 1, ['m3'], 30, 'Q'),
      summary('P', 2, ['C'], 20),
      summary('Q', 2, ['A', 'D'], 20),
    ],
  );
}

const trio = { targetTokens: 50, windowTokens: 1_000, reachTokens: 1_000, rawZone: new Set<ChunkId>(), now: 1_000 };

for (const [kind, build, foldAtTokens, folded, pinCaps] of [
  ['whose own lineage stops below the summary', disagreeingTrio, 100, ['recall:A', 'recall:G'], undefined],
  ['whose own lineage runs through another summary at its level', crossParentedTrio, 150, ['recall:H', 'recall:A', 'recall:G'], undefined],
  ['whose own parent is held back by a pin', twoParentsOneCapped, 150, ['recall:A', 'recall:Q', 'recall:C'], new Map([['m3', 1]])],
  ['of its own that is folded above it', ownLeafFoldedAbove, 250, ['recall:A', 'recall:P', 'recall:Q', 'raw:m4'], undefined],
] as const) {
  test(`a held plan keeps the summary beside a leaf ${kind}`, () => {
    const { inputs, tree } = build();
    const params = { ...trio, foldAtTokens, ...(pinCaps ? { pinCaps } : {}) };
    const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
    const second = planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions });
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, first.resolutions)), folded);
    // The fullest fold is inside the [50, foldAt] band, so the second compile holds.
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, second.resolutions)), folded);
    assert.equal(second.perturbation, 0);
    assert.ok(!second.folded && !second.expanded);
  });
}

test('a compile above foldAt that adopts the frontier it carried reports no fold and no perturbation', () => {
  const { inputs, tree } = disagreeingTrio();
  // The fullest fold is 70 tokens, above foldAt, so nothing holds: each
  // compile adopts the ideal cut, which is the frontier it carried.
  const params = { ...trio, foldAtTokens: 60 };
  const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
  const second = planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, second.resolutions)), unitsOf(renderLayout(inputs, tree, first.resolutions)));
  assert.equal(second.perturbation, 0);
  assert.ok(!second.folded && !second.expanded);
});

// A, B and C under G, nested. The first compile folds to G; the second caps
// m1 at L1, which no plan can render through G. The provider re-reads from G
// on, but that change is every plan's, so the carried frontier applies it
// first and the plan reports a perturbation of 0: inside the hold band by
// holding, and above foldAt by adopting an ideal cut that equals it.
for (const [path, foldAtTokens] of [['holds', 150], ['adopts the ideal cut above foldAt', 60]] as const) {
  test(`a pin tightened since the last compile is in the carried frontier, so a plan that ${path} leaves it out of perturbation`, () => {
    const { inputs, tree } = store(
      [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
      [
        summary('A', 1, ['m1'], 30, 'G'),
        summary('B', 1, ['m2'], 30, 'G'),
        summary('C', 1, ['m3'], 30, 'G'),
        summary('G', 2, ['A', 'B', 'C'], 40),
      ],
    );
    const params = { ...trio, foldAtTokens };
    const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
    const second = planControlledFrontier(inputs, tree, { ...params, pinCaps: new Map([['m1', 1]]), previous: first.resolutions });
    const before = renderLayout(inputs, tree, first.resolutions);
    const after = renderLayout(inputs, tree, second.resolutions);
    assert.deepEqual(unitsOf(before), ['recall:G']);
    assert.deepEqual(unitsOf(after), ['recall:A', 'recall:B', 'recall:C']);
    assert.ok(kvCost(before, after) > 0, 'the provider re-reads from G on');
    assert.equal(second.perturbation, 0);
  });
}

// A leaf renders at its level through its own lineage there, so a carried
// level holds only where that summary lists the leaf. Here A's parent pointer
// reaches H, which lists only B's leaf, as when summary links change between
// compiles, and m1 was carried at L2. Through H, m1 would be in no recall.
for (const [kind, bParent, m2Level] of [
  ['whose one leaf has no summary at its level', undefined, 1],
  ['whose leaves sit at its level', 'H', 2],
] as const) {
  test(`a carried level is lowered where its summary no longer lists the leaf, beside a summary ${kind}`, () => {
    const { inputs, tree } = store(
      [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B')],
      [
        summary('A', 1, ['m1'], 30, 'H'),
        summary('B', 1, ['m2'], 30, bParent),
        summary('H', 2, ['B'], 40),
      ],
    );
    const previous = new Map<ChunkId, number>([['m1', 2], ['m2', m2Level]]);
    // Inside the hold band either way, so the plan holds the carried frontier.
    const plan = planControlledFrontier(inputs, tree, { ...trio, targetTokens: 30, foldAtTokens: 1_000, previous });
    for (const c of inputs.chunks) {
      const level = plan.resolutions.get(c.id) ?? 0;
      if (level > 0) {
        assert.ok(tree.ancestorAt(c.id, level)?.leafChunkIds.includes(c.id), `${c.id} at L${level} renders through a summary that lists it`);
      }
    }
    assert.equal(plan.resolutions.get('m1'), 1);
  });
}

// The same store with m1 held at L2, locked there or pinned there (or pinned
// at L3). The projection never lowers a held leaf, so the base lowers the held
// level to the next one down where m1's own lineage has a summary, A at L1,
// rather than hold m1 where it can't render for as long as the hold lasts.
for (const [kind, hold] of [
  ['a locked leaf', { frozen: new Set<ChunkId>(['m1']) }],
  ['a pinned leaf', { fixedLevels: new Map<ChunkId, number>([['m1', 2]]) }],
  ['a leaf pinned above its deepest summary', { fixedLevels: new Map<ChunkId, number>([['m1', 3]]) }],
] as const) {
  test(`${kind} is lowered where its summary no longer lists it`, () => {
    const { inputs, tree } = store(
      [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B')],
      [summary('A', 1, ['m1'], 30, 'H'), summary('B', 1, ['m2'], 30), summary('H', 2, ['B'], 40)],
    );
    const previous = new Map<ChunkId, number>([['m1', 2], ['m2', 1]]);
    const plan = planControlledFrontier(inputs, tree, { ...trio, targetTokens: 30, foldAtTokens: 1_000, previous, ...hold });
    assert.equal(plan.resolutions.get('m1'), 1);
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['recall:A', 'recall:B']);
  });
}

// A held level above the top of the leaf's lineage is lowered to the deepest
// summary the lineage has: m1 locked at L2, while its L1 A has no parent,
// renders through A. It used to be kept at L2 and render raw.
test('a locked leaf carried above the top of its lineage is lowered to its deepest summary', () => {
  const { inputs, tree } = store(
    [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B')],
    [summary('A', 1, ['m1'], 30), summary('B', 1, ['m2'], 30)],
  );
  const previous = new Map<ChunkId, number>([['m1', 2], ['m2', 1]]);
  const plan = planControlledFrontier(inputs, tree, { ...trio, targetTokens: 30, foldAtTokens: 1_000, previous, frozen: new Set<ChunkId>(['m1']) });
  assert.equal(plan.resolutions.get('m1'), 1);
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['recall:A', 'recall:B']);
});

// The same lock through KvStableStrategy and the picker: m1, locked by the
// agent at L2 above the top of its lineage, renders through A, and the picker
// reports no level it can't realize. It used to stay at L2 and render raw,
// and the picker reported it; the test catches the picker's log lines.
test('a lock carried above the top of its lineage renders through its deepest summary in a kv-stable compile', () => {
  const chunks = [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B')];
  chunks[0]!.lockedByAgent = true;
  chunks[0]!.currentResolution = 2;
  const { inputs, tree } = store(chunks, [summary('A', 1, ['m1'], 30), summary('B', 1, ['m2'], 30)]);
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  let result;
  try {
    result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 100_000, targetBudget: 90_000, slack: 0.1 });
  } finally {
    console.error = original;
  }
  assert.equal(result.finalResolutions.get('m1'), 1, 'm1 is held at L1, through A');
  assert.ok(unitsOf(renderLayout(inputs, tree, result.finalResolutions)).includes('recall:A'), 'm1 renders in A\'s recall');
  assert.deepEqual(lines.filter((l) => l.includes('[picker-unrealizable]')), []);
});

// kv-stable passes a chunk that is both capped and locked in pinCaps and in
// frozen. The cap is hard, so the base takes the lock's carried level down to
// it: m0, locked at L2 through P with cap 1, renders through its L1 A, and P
// no longer renders over A and B (R1-3).
test('a locked leaf carried deeper than its pin-max-level is lowered to the cap', () => {
  const { inputs, tree } = store(
    [message('m0', 0, 100, 'A'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B')],
    [summary('A', 1, ['m0', 'm1'], 30, 'P'), summary('B', 1, ['m2'], 30, 'P'), summary('P', 2, ['A', 'B'], 40)],
  );
  const previous = new Map<ChunkId, number>([['m0', 2], ['m1', 1], ['m2', 1]]);
  const plan = planControlledFrontier(inputs, tree, {
    ...trio, targetTokens: 60, foldAtTokens: 1_000, previous,
    frozen: new Set<ChunkId>(['m0']), pinCaps: new Map<ChunkId, number>([['m0', 1]]),
  });
  assert.equal(plan.resolutions.get('m0'), 1);
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['recall:A', 'recall:B']);
});

test('suffix adoption takes a summary beside a lineage-disagreeing leaf', () => {
  // The trio after m0, whose own L1 Z has no parent. From an all-raw carried
  // frontier the ideal cut (Z, A and G) rewrites all 100 tokens it renders;
  // P = 75 allows a rewrite from m1 on, which is A and G, 70 tokens.
  const { inputs, tree } = store(
    [message('m0', 0, 100, 'Z'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('Z', 1, ['m0'], 30),
      summary('A', 1, ['m1'], 30),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
  const plan = planControlledFrontier(inputs, tree, {
    ...trio, foldAtTokens: 300, reachTokens: 75,
    previous: new Map(inputs.chunks.map((c) => [c.id, 0])),
  });
  assert.equal(plan.override, undefined);
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['raw:m0', 'recall:A', 'recall:G']);
  assert.equal(plan.perturbation, 70);
});

const levelsOf = (inputs: PickerInputs, F: ReadonlyMap<ChunkId, number>): string =>
  inputs.chunks.map((c) => F.get(c.id) ?? 0).join('');

// The replan property's tree 228 (seed 1). L1-0 lists m0, m1 and m2, and m0 is
// re-pointed at R-1, which lists m0 and m1. Phase C moves the leaves an
// un-fold's summary renders, decided by each leaf's own lineage there, as the
// projection decides: un-folding L1-0 moves m1 with m2, though R-1's fold met
// m1 too. Skipping m1 because some fold had met it left the ledger counting
// L1-0 as rendered, and the plan settled on R-1, m1 and m2, 148 tokens, above
// foldAt on every compile (R1-1).
test('phase C un-folds the leaves of a summary\'s own lineage: tree 228 settles inside the band', () => {
  const { inputs, tree } = store(
    [message('m0', 0, 48, 'R-1'), message('m1', 1, 94, 'L1-0'), message('m2', 2, 41, 'L1-0')],
    [summary('L1-0', 1, ['m0', 'm1', 'm2'], 43), summary('R-1', 1, ['m0', 'm1'], 13)],
  );
  const params = { targetTokens: 80, foldAtTokens: 130, windowTokens: 366, reachTokens: 366, rawZone: new Set<ChunkId>(), now: 3 };
  const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, first.resolutions)), ['raw:m0', 'recall:L1-0']);
  assert.equal(first.tokens, 91);
  const second = planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions });
  assert.equal(levelsOf(inputs, second.resolutions), levelsOf(inputs, first.resolutions));
  assert.equal(second.perturbation, 0);
});

// X lists m0, m1 and m2, but m0 has no L1 of its own, so it renders raw
// whatever X does. Phase C's un-fold of X asks only X's own leaves to sit at
// X's level: m0, raw beside it, doesn't keep X folded, and the plan spends
// the headroom on X, 170 tokens against a target of 150 rather than 70
// (R1-1).
test('phase C un-folds a summary whose listed leaf of another lineage sits at another level', () => {
  const { inputs, tree } = store(
    [message('m0', 0, 50), message('m1', 1, 60, 'X'), message('m2', 2, 60, 'X')],
    [summary('X', 1, ['m0', 'm1', 'm2'], 20)],
  );
  const plan = planControlledFrontier(inputs, tree, {
    ...trio, targetTokens: 150, foldAtTokens: 300, previous: new Map(),
  });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['raw:m0', 'raw:m1', 'raw:m2']);
  assert.equal(plan.tokens, 170);
});

// Greptile's store from its second review of #186: m0 and m1 name A as their
// L1, and m2 names B, but A lists only m1 and B lists m0 and m2. Both name P,
// the L2 that lists A and B. Un-folding P puts m1 in A's recall and m2 in B's,
// and the projection lowers m0 to raw, since A, its own L1, doesn't list it:
// 1,100 tokens against a window of 150. Phase C priced m0 at A's recall, took
// the un-fold at 100 tokens, and every compile ended exhausted. Priced where
// the projection leaves m0, the un-fold is declined, and P holds all three at
// 20 tokens.
const unlistedOwnL1 = (older: PickerChunk[] = [], olderSummaries: SummaryEntry[] = []) => store(
  [
    ...older,
    message('m0', older.length, 1_000, 'A'), message('m1', older.length + 1, 1_000, 'A'),
    message('m2', older.length + 2, 1_000, 'B'),
  ],
  [
    ...olderSummaries,
    summary('A', 1, ['m1'], 50, 'P'), summary('B', 1, ['m0', 'm2'], 50, 'P'), summary('P', 2, ['A', 'B'], 20),
  ],
);

test('phase C prices an un-fold where the projection leaves each leaf, and keeps a summary whose un-fold would render a leaf raw', () => {
  const { inputs, tree } = unlistedOwnL1();
  for (let compile = 1; compile <= 3; compile++) {
    const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 150, targetBudget: 100, slack: 0.1 });
    const layout = renderLayout(inputs, tree, result.finalResolutions);
    assert.deepEqual(unitsOf(layout), ['recall:P'], `compile ${compile}`);
    assert.equal(layout.totalTokens, 20);
    assert.equal(result.exhausted, false);
    for (const c of inputs.chunks) c.currentResolution = result.finalResolutions.get(c.id) ?? 0;
  }
});

// The same store beside g0 and g1, older, which G folds at L1 for 10 tokens.
// Phase C declines P's un-fold and moves m0 back from raw, where it went. Moved
// back from L1 instead, m0's 1,000 raw tokens stayed in the ledger, which then
// read the plan as past its target, and G was never un-folded.
test('phase C moves a declined un-fold\'s leaves back from the levels they went to, and un-folds the next summary', () => {
  const { inputs, tree } = unlistedOwnL1(
    [message('g0', 0, 30, 'G'), message('g1', 1, 30, 'G')],
    [summary('G', 1, ['g0', 'g1'], 10)],
  );
  const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 150, targetBudget: 100, slack: 0.1 });
  const layout = renderLayout(inputs, tree, result.finalResolutions);
  assert.deepEqual(unitsOf(layout), ['raw:g0', 'raw:g1', 'recall:P']);
  assert.equal(layout.totalTokens, 80);
});

// y's own L1 N names T, an L3, as its parent, so y's lineage skips L2, and T
// lists M and N. Un-folding T leaves x in M's recall and lowers y past L2,
// where its lineage has no summary, to N: 35 tokens against a target of 30.
// Priced at L2 instead, y counted as raw, 115 tokens, past the window of 60,
// so phase C declined the un-fold and the plan stayed at T's 10 tokens.
test('phase C prices a leaf whose lineage skips the level below the summary where the projection leaves it, and takes the un-fold', () => {
  const { inputs, tree } = store(
    [message('x', 0, 100, 'N1'), message('y', 1, 100, 'N')],
    [
      summary('N1', 1, ['x'], 20, 'M'), summary('M', 2, ['N1'], 15, 'T'), summary('N', 1, ['y'], 20, 'T'),
      summary('T', 3, ['M', 'N'], 10),
    ],
  );
  const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 60, targetBudget: 30, slack: 0.1 });
  const layout = renderLayout(inputs, tree, result.finalResolutions);
  assert.deepEqual(unitsOf(layout), ['recall:M', 'recall:N']);
  assert.equal(layout.totalTokens, 35);
});

// From the internal review of the round answering Greptile: N, an L3, lists
// only c. c's own L1 C1 lists d alone, and c's own L2 B lists c through E1 and
// x through A1. x has a pin-max-level of 1, so B can't fold, and the solve
// folds c to N. Un-folding N lands c at B, but x, at L1 below B, vetoes it, so
// the projection lowers c past B, and past C1, which doesn't list it, to raw.
// Priced at B's recall, the un-fold was taken and every compile ended
// exhausted. Priced where the projection puts c, it's declined, and the plan
// spends the headroom on x and d instead.
test('phase C passes a landing summary that a leaf below it vetoes, as the projection does', () => {
  const x = message('x', 0, 100, 'A1');
  x.pinMaxLevel = 1;
  const { inputs, tree } = store(
    [x, message('c', 1, 1_000, 'C1'), message('d', 2, 10, 'C1')],
    [
      summary('A1', 1, ['x'], 10, 'B'), summary('E1', 1, ['c'], 20, 'F2'), summary('C1', 1, ['d'], 5, 'B'),
      summary('B', 2, ['A1', 'E1'], 30, 'N'), summary('F2', 2, ['E1'], 15, 'N'), summary('N', 3, ['F2'], 8),
    ],
  );
  for (let compile = 1; compile <= 2; compile++) {
    const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 150, targetBudget: 100, slack: 0.1 });
    const layout = renderLayout(inputs, tree, result.finalResolutions);
    assert.deepEqual(unitsOf(layout), ['raw:x', 'recall:N', 'raw:d'], `compile ${compile}`);
    assert.equal(layout.totalTokens, 118);
    assert.equal(result.exhausted, false);
    for (const c of inputs.chunks) c.currentResolution = result.finalResolutions.get(c.id) ?? 0;
  }
});

// The same links, with x locked at L1 rather than capped. A lock is
// hard-protected, so x, below B, doesn't veto it, for the projection or for
// phase C: the solve folds c to N, and phase C's un-fold lands c at B, 45
// tokens against a target of 40, where counting x's veto would have sent c to
// raw and kept N. d is 100 tokens, so un-folding C1 never brings the plan
// closer to its target, whatever order phase C tries its un-folds in.
test('phase C doesn\'t count a hard-protected leaf below a landing summary as a veto, as the projection doesn\'t', () => {
  const x = message('x', 0, 100, 'A1');
  x.lockedByAgent = true;
  x.currentResolution = 1;
  const { inputs, tree } = store(
    [x, message('c', 1, 1_000, 'C1'), message('d', 2, 100, 'C1')],
    [
      summary('A1', 1, ['x'], 10, 'B'), summary('E1', 1, ['c'], 20, 'F2'), summary('C1', 1, ['d'], 5, 'B'),
      summary('B', 2, ['A1', 'E1'], 30, 'N'), summary('F2', 2, ['E1'], 15, 'N'), summary('N', 3, ['F2'], 8),
    ],
  );
  const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 150, targetBudget: 40, slack: 0.1 });
  const layout = renderLayout(inputs, tree, result.finalResolutions);
  assert.deepEqual(unitsOf(layout), ['recall:A1', 'recall:B', 'recall:C1']);
  assert.equal(layout.totalTokens, 45);
});

// From the follow-up review: past a vetoed landing summary, phase C lands the
// leaves at the next summary of their own lineage that lists them, and the
// second leaf takes both verdicts from the un-fold's memo. c and e name C2 as
// their L1, which lists both, under B, which lists them and x, held at L1 by
// a pin-max-level of 1. N, an L3, lists c and e. The solve folds both to N,
// and phase C's un-fold passes B, which x vetoes, for C2: 50 tokens against a
// target of 45. Sending the leaves to raw at the veto, or landing e at B on a
// wrong verdict, would decline the un-fold and keep N's 18.
test('phase C lands leaves past a vetoed summary at the next summary of their lineage that lists them', () => {
  const x = message('x', 0, 100, 'A1');
  x.pinMaxLevel = 1;
  const { inputs, tree } = store(
    [x, message('c', 1, 1_000, 'C2'), message('e', 2, 1_000, 'C2')],
    [
      summary('A1', 1, ['x'], 10, 'B'), summary('C2', 1, ['c', 'e'], 40, 'B'),
      summary('B', 2, ['A1', 'C2'], 30, 'N'), summary('F2', 2, ['C2'], 15, 'N'), summary('N', 3, ['F2'], 8),
    ],
  );
  const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 150, targetBudget: 45, slack: 0.1 });
  const layout = renderLayout(inputs, tree, result.finalResolutions);
  assert.deepEqual(unitsOf(layout), ['recall:A1', 'recall:C2']);
  assert.equal(layout.totalTokens, 50);
});

// The overlap a plan reports, which [kv-overlap] logs, reads the frontier the
// plan emits, not which folds the solve made: a hold that keeps R and A, which
// both list m0 and m1, reports each leaf of the other's lineage though the
// ideal cut folds neither, and a hold that renders neither reports nothing
// though the ideal cut folds both (R1-2). m0's lineage is R, m1's is A.
const doubledPair = (): { inputs: PickerInputs; tree: SummaryTree } => {
  const chunks = [message('m0', 0, 100, 'R'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B')];
  chunks[2].salience = 0.1; // folded first
  return store(chunks, [summary('A', 1, ['m0', 'm1'], 20), summary('R', 1, ['m0', 'm1'], 30), summary('B', 1, ['m2'], 20)]);
};
for (const [kind, previousLevels, targetTokens, conflicting, units] of [
  ['a held frontier that renders two summaries over one pair reports both leaves, though the ideal cut folds neither',
    [1, 1, 0], 220, ['m1', 'm0'], ['recall:R', 'recall:A', 'raw:m2']],
  ['a held frontier that renders neither reports nothing, though the ideal cut folds both',
    [0, 0, 1], 60, [], ['raw:m0', 'raw:m1', 'recall:B']],
] as const) {
  test(`a plan's overlap follows the emitted frontier: ${kind}`, () => {
    const { inputs, tree } = doubledPair();
    const previous = new Map<ChunkId, number>(inputs.chunks.map((c, i) => [c.id, previousLevels[i]!]));
    const plan = planControlledFrontier(inputs, tree, {
      ...trio, targetTokens, expandAtTokens: 100, foldAtTokens: 300, previous,
    });
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), [...units]);
    assert.equal(plan.perturbation, 0);
    assert.deepEqual(plan.overlap, [...conflicting]);
  });
}

// M's sources were N1 and N2, but M was written again without N2, while N2
// still names M as its parent: y's own lineage runs through M, which doesn't
// list y, so y has no summary at L2. A held plan that renders M (through x)
// and N2 (y, at L1) has each message in one recall, and reports no overlap.
test('[kv-overlap] stays quiet about a summary on a leaf\'s lineage that doesn\'t list it, which the leaf can\'t render through', () => {
  const { inputs, tree } = store(
    [message('x', 0, 100, 'N1'), message('y', 1, 100, 'N2')],
    [summary('N1', 1, ['x'], 20, 'M'), summary('N2', 1, ['y'], 20, 'M'), summary('M', 2, ['N1'], 15)],
  );
  assert.equal(tree.maxLevel('y'), 1, 'y has no summary above N2');
  const previous = new Map<ChunkId, number>([['x', 2], ['y', 1]]);
  const plan = planControlledFrontier(inputs, tree, {
    ...trio, targetTokens: 30, expandAtTokens: 30, foldAtTokens: 300, previous,
  });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['recall:M', 'recall:N2']);
  assert.equal(plan.perturbation, 0);
  assert.deepEqual(plan.overlap, NO_OVERLAP);
  assert.deepEqual(overlapLines(() => reportOverlap(plan.overlap)), []);
});

// m's own L1 N1 names B as its parent, but B was written from N2 alone, so
// m has no summary at L2. A lists m through N1, one of A's sources. A held
// plan renders m through N1, p through B and q through A, so A lists a leaf
// of another lineage: m is named, once.
test('[kv-overlap] names a leaf that a rendered summary lists while its own lineage\'s summary there doesn\'t', () => {
  const { inputs, tree } = store(
    [message('m', 0, 100, 'N1'), message('p', 1, 100, 'N2'), message('q', 2, 100, 'N3')],
    [
      summary('N1', 1, ['m'], 20, 'B'), summary('N2', 1, ['p'], 20, 'B'), summary('N3', 1, ['q'], 20, 'A'),
      summary('B', 2, ['N2'], 15), summary('A', 2, ['N1', 'N3'], 15),
    ],
  );
  const previous = new Map<ChunkId, number>([['m', 1], ['p', 2], ['q', 2]]);
  const plan = planControlledFrontier(inputs, tree, {
    ...trio, targetTokens: 30, expandAtTokens: 30, foldAtTokens: 300, previous,
  });
  assert.deepEqual(Object.fromEntries(plan.resolutions), { m: 1, p: 2, q: 2 });
  assert.equal(plan.perturbation, 0);
  assert.deepEqual(plan.overlap, ['m']);
  const lines = overlapLines(() => reportOverlap(plan.overlap));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /1 leaf\(s\) with conflicting lineage/);
  assert.match(lines[0]!, /sample=m$/);
});

// replayControlled renders each turn's plan, so it logs each turn's overlap,
// which the planner no longer logs itself. R and A each list m0 and m1, whose
// own L1s are R and A, so every turn whose plan folds a leaf renders a summary
// that lists a leaf of the other's lineage, and logs one line. m2, the newest,
// has no summary and stays raw in the attended window.
test('replayControlled logs [kv-overlap] for each turn whose plan renders a summary that disagrees', () => {
  const { inputs } = store(
    [message('m0', 0, 100, 'R'), message('m1', 1, 100, 'A'), message('m2', 2, 100)],
    [summary('R', 1, ['m0', 'm1'], 30), summary('A', 1, ['m0', 'm1'], 20)],
  );
  let result: ControlResult | undefined;
  const lines = overlapLines(() => {
    result = replayControlled(inputs, { windowTokens: 1_000, budgetTokens: 200, attendedWindowTokens: 100 });
  });
  const folding = result!.steps.filter((step) => step.deepestLevel >= 1).length;
  assert.ok(folding > 0, 'a turn renders R or A');
  assert.equal(lines.length, folding, lines.join('\n'));
  for (const line of lines) assert.match(line, /2 leaf\(s\) with conflicting lineage .*sample=m1,m0$/);
});

// The same links, through the strategy. y is pinned at L2, where its own
// lineage reaches M, which doesn't list it, so y has no summary there. The
// pin holds y at L1 through N2, and M's own leaves stay unpinned, so with
// room to spare x renders raw. Expanding the pin through M used to hold x,
// which nothing pins, at L2 and leave y raw.
test('a pin-at-level held through KvStableStrategy lowers to where its own lineage has a summary', () => {
  const chunks = [message('x', 0, 100, 'N1'), message('y', 1, 100, 'N2'), message('z', 2, 100, 'N3'), message('w', 3, 100, 'N3')];
  const { inputs } = store(chunks, [
    summary('N1', 1, ['x'], 20, 'M'), summary('N2', 1, ['y'], 20, 'M'), summary('N3', 1, ['z', 'w'], 20),
    summary('M', 2, ['N1'], 15),
  ]);
  chunks[1]!.pinLevel = 2;
  const strategy = new KvStableStrategy();
  const result = new Picker(strategy).run(inputs, { totalBudget: 100_000, targetBudget: 90_000, slack: 0.1 });
  assert.equal(result.finalResolutions.get('y'), 1, 'y is held at L1, where N2 lists it');
  assert.equal(result.finalResolutions.get('x') ?? 0, 0, 'x, which nothing pins, renders raw');
  assert.deepEqual(strategy.lastPlan()?.overlap, NO_OVERLAP, 'M is no longer rendered, so nothing disagrees');
});

// The same links with v beside y under N2: the pin holds N2's whole group at
// L1, so v, which nothing pins, is held there with y, and x renders raw.
test('a pin-at-level lowered through KvStableStrategy holds the other leaves of the summary that lists it', () => {
  const chunks = [message('x', 0, 100, 'N1'), message('y', 1, 100, 'N2'), message('v', 2, 100, 'N2'), message('z', 3, 100, 'N3'), message('w', 4, 100, 'N3')];
  const { inputs } = store(chunks, [
    summary('N1', 1, ['x'], 20, 'M'), summary('N2', 1, ['y', 'v'], 20, 'M'), summary('N3', 1, ['z', 'w'], 20),
    summary('M', 2, ['N1'], 15),
  ]);
  chunks[1]!.pinLevel = 2;
  const strategy = new KvStableStrategy();
  const result = new Picker(strategy).run(inputs, { totalBudget: 100_000, targetBudget: 90_000, slack: 0.1 });
  assert.equal(result.finalResolutions.get('y'), 1, 'y is held at L1, where N2 lists it');
  assert.equal(result.finalResolutions.get('v'), 1, 'v is held with y, at N2');
  assert.equal(result.finalResolutions.get('x') ?? 0, 0, 'x, which nothing pins, renders raw');
  assert.deepEqual(strategy.lastPlan()?.overlap, NO_OVERLAP);
});

// N2, y's own L1, was written again from v alone, so it doesn't list y, and
// neither does M above it: y has no summary at any level. The pin lowers to
// raw: y renders raw, and no summary's leaves are held for it, neither M's x
// at L2 nor N2's v at L1.
test('a pin-at-level on a chunk whose L1 doesn\'t list it lowers to raw and holds no summary', () => {
  const chunks = [message('x', 0, 100, 'N1'), message('y', 1, 100, 'N2'), message('v', 2, 100, 'N2'), message('z', 3, 100, 'N3'), message('w', 4, 100, 'N3')];
  const { inputs } = store(chunks, [
    summary('N1', 1, ['x'], 20, 'M'), summary('N2', 1, ['v'], 20, 'M'), summary('N3', 1, ['z', 'w'], 20),
    summary('M', 2, ['N1'], 15),
  ]);
  chunks[1]!.pinLevel = 2;
  const result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 100_000, targetBudget: 90_000, slack: 0.1 });
  for (const id of ['x', 'y', 'v']) assert.equal(result.finalResolutions.get(id) ?? 0, 0, `${id} renders raw`);
});

// y's own L1 N2 names T, an L3, as its parent, and T lists N2 among its
// sources beside M, so y's lineage skips L2. Pinned at L2, y lowers to the
// next level down that has a summary, L1, and renders in N2's recall. It used
// to be held at L2, where its lineage has no summary, and render raw, while
// the picker reported y's level as one it can't realize; the test catches
// the picker's log lines rather than print them.
test('a pin-at-level at a level its own lineage skips holds the chunk at the next level down', () => {
  const chunks = [message('x', 0, 100, 'N1'), message('y', 1, 100, 'N2'), message('z', 2, 100, 'N3'), message('w', 3, 100, 'N3')];
  const { inputs, tree } = store(chunks, [
    summary('N1', 1, ['x'], 20, 'M'), summary('M', 2, ['N1'], 15, 'T'), summary('T', 3, ['M', 'N2'], 10),
    summary('N2', 1, ['y'], 20, 'T'), summary('N3', 1, ['z', 'w'], 20),
  ]);
  assert.equal(tree.ancestorAt('y', 2), null, 'premise: y\'s lineage skips L2');
  assert.equal(tree.ancestorAt('y', 3)?.id, 'T', 'premise: T, which lists N2, is y\'s L3');
  chunks[1]!.pinLevel = 2;
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  let result;
  try {
    result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 100_000, targetBudget: 90_000, slack: 0.1 });
  } finally {
    console.error = original;
  }
  assert.equal(result.finalResolutions.get('y'), 1, 'y is held at L1, through N2');
  assert.ok(unitsOf(renderLayout(inputs, tree, result.finalResolutions)).includes('recall:N2'), 'y renders in N2\'s recall');
  assert.deepEqual(lines.filter((l) => l.includes('[picker-unrealizable]')), []);
  assert.equal(result.finalResolutions.get('x') ?? 0, 0, 'x, which nothing pins, renders raw');
});

// From Greptile's second review of #186: N, the L1 of x and y, names T, an L3,
// as its parent, and T, written from M alone, lists neither, so neither has a
// summary above N. x is pinned at L1, which holds N's leaves there, y among
// them. y is pinned at L2 or L3, which lowers to L1, where N holds y with x,
// in either order. When y's pin came second, it used to hold y at L2,
// replacing x's L1, and y rendered raw beside N's recall: 143 tokens against
// a window of 60, and the picker reported y's level as one it can't realize.
for (const yPin of [2, 3]) {
  for (const order of ['x first', 'y first'] as const) {
    test(`a pin at L${yPin} on y, whose L1's parent doesn't list the L1, holds y at L1 with x's pin (${order})`, () => {
      const x = message('x', 0, 100, 'N'), y = message('y', 1, 100, 'N'), z = message('z', 2, 10, 'Z');
      x.pinLevel = 1;
      y.pinLevel = yPin;
      const chunks = order === 'x first' ? [x, y, z] : [y, x, z];
      chunks.forEach((c, i) => { c.sequence = i; });
      const { inputs, tree } = store(chunks, [
        summary('N', 1, chunks.slice(0, 2).map((c) => c.id), 40, 'T'),
        summary('Z', 1, ['z'], 5, 'M'), summary('M', 2, ['Z'], 4, 'T'), summary('T', 3, ['M'], 3),
      ]);
      const original = console.error;
      const lines: string[] = [];
      console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
      let result;
      try {
        result = new Picker(new KvStableStrategy()).run(inputs, { totalBudget: 60, targetBudget: 55, slack: 0.1 });
      } finally {
        console.error = original;
      }
      assert.equal(result.finalResolutions.get('y'), 1, 'y is held at L1, with x');
      const units = unitsOf(renderLayout(inputs, tree, result.finalResolutions));
      assert.ok(units.includes('recall:N') && !units.includes('raw:y'), `y renders in N's recall: ${units.join(' ')}`);
      assert.equal(result.exhausted, false);
      assert.deepEqual(lines.filter((l) => l.includes('[picker-unrealizable]')), []);
    });
  }
}

// m0 is held at L1, where its own A renders it, and the plan folds m1 and m2
// to their L2 P, which lists m0 too and is m0's own lineage there. So m0 is
// in A's recall and P's. Every summary the plan renders lists exactly the
// leaves whose own lineage runs through it, so the plan reports no overlap and
// [kv-overlap] stays quiet: a hold put m0 beside P, not the tree.
for (const [hold, holds] of [
  ['a locked leaf', { frozen: new Set<ChunkId>(['m0']) }],
  ['a pinned leaf', { fixedLevels: new Map<ChunkId, number>([['m0', 1]]) }],
] as const) {
  test(`[kv-overlap] stays quiet about ${hold} beside a summary of its own lineage that lists it`, () => {
    const { inputs, tree } = store(
      [message('m0', 0, 100, 'A'), message('m1', 1, 100, 'B'), message('m2', 2, 100, 'B')],
      [summary('A', 1, ['m0'], 30, 'P'), summary('B', 1, ['m1', 'm2'], 30, 'P'), summary('P', 2, ['A', 'B'], 20)],
    );
    const plan = planControlledFrontier(inputs, tree, {
      ...trio, targetTokens: 50, foldAtTokens: 200, previous: new Map<ChunkId, number>([['m0', 1]]), ...holds,
    });
    assert.deepEqual([...plan.resolutions.entries()].sort(), [['m0', 1], ['m1', 2], ['m2', 2]]);
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['recall:A', 'recall:P']);
    assert.deepEqual(plan.overlap, NO_OVERLAP);
  });
}

// N lists m1, m2 and z, but z's own L1 is Z: N's fold doesn't move z, which
// renders raw beside N's recall, so z's pin cap of 0 isn't N's to keep. A
// fold judges the leaves it moves, by their own lineage, as phase C and the
// projection do.
test('a listed leaf of another lineage doesn\'t veto a summary\'s fold with its pin cap', () => {
  const { inputs, tree } = store(
    [message('m1', 0, 100, 'N'), message('m2', 1, 100, 'N'), message('z', 2, 100, 'Z')],
    [summary('N', 1, ['m1', 'm2', 'z'], 20), summary('Z', 1, ['z'], 20)],
  );
  const plan = planControlledFrontier(inputs, tree, {
    ...trio, targetTokens: 150, foldAtTokens: 200, pinCaps: new Map([['z', 0]]), previous: new Map(),
  });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['recall:N', 'raw:z']);
});

// A level carried far above the tree's top: m0 carried at L8, while its only
// summary is the L1 A. The projection bounds its passes by the deepest level
// in the frontier as well as the tree's, so the first compile takes m0 all
// the way to A, and the next compile renders what this one did. Bounded by
// the tree alone, a strictReach hold emitted L2, which renders raw, and the
// next compile rendered A with a perturbation of 0 (R1-6).
test('a level carried far above the tree is projected to a renderable one in a single compile', () => {
  const { inputs, tree } = store([message('m0', 0, 100, 'A')], [summary('A', 1, ['m0'], 30)]);
  const params = { ...trio, targetTokens: 30, foldAtTokens: 200, strictReach: true };
  const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map<ChunkId, number>([['m0', 8]]) });
  assert.equal(first.resolutions.get('m0'), 1);
  const second = planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, second.resolutions)), unitsOf(renderLayout(inputs, tree, first.resolutions)));
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A nested tree over 3 to 12 messages, with one or two corruptions of the
 *  kinds store surgery leaves: an L1 detached from the L2 that still lists
 *  it, an L1 re-pointed at an L2 that doesn't list it, or a message
 *  re-pointed at an unmerged L1 over it and its neighbour. On some trees the
 *  caller's protections too: a raw zone, pin-max-level caps, pin-at-level
 *  over one summary's leaves, and a locked leaf. */
function randomNonNested(rng: () => number): {
  inputs: PickerInputs; tree: SummaryTree; params: Omit<ControlPlanParams, 'previous'>; corruptions: string[];
} {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  const n = 3 + Math.floor(rng() * 10);
  const chunks = Array.from({ length: n }, (_, i) => message(`m${i}`, i, 40 + Math.floor(rng() * 120)));
  const summaries: SummaryEntry[] = [];
  const levels: SummaryEntry[][] = [[]];
  for (let i = 0; i < n;) {
    const run = chunks.slice(i, i + 1 + Math.floor(rng() * 3));
    i += run.length;
    if (rng() < 0.1) continue; // left uncovered
    const s = summary(`L1-${levels[0].length}`, 1, run.map((c) => c.id), 10 + Math.floor(rng() * 40));
    for (const c of run) c.l1Id = s.id;
    summaries.push(s);
    levels[0].push(s);
  }
  for (let level = 2; level <= 3 && levels[level - 2].length >= 2; level++) {
    const below = levels[level - 2];
    const here: SummaryEntry[] = [];
    for (let j = 0; j < below.length;) {
      const kids = below.slice(j, j + 2 + Math.floor(rng() * 2));
      j += kids.length;
      if (kids.length < 2 || rng() < 0.2) continue;
      const s = summary(`L${level}-${here.length}`, level, kids.map((k) => k.id), 10 + Math.floor(rng() * 40));
      for (const k of kids) k.parentId = s.id;
      summaries.push(s);
      here.push(s);
    }
    levels.push(here);
  }
  const corruptions: string[] = [];
  for (let c = 1 + Math.floor(rng() * 2); c > 0; c--) {
    const kind = Math.floor(rng() * 3);
    const merged = levels[0].filter((s) => s.parentId);
    if (kind === 0 && merged.length > 0) {
      const s = pick(merged);
      delete s.parentId;
      corruptions.push(`${s.id} detached`);
    } else if (kind === 1 && merged.length > 0 && (levels[1]?.length ?? 0) >= 2) {
      const s = pick(merged);
      const other = pick(levels[1].filter((p) => p.id !== s.parentId));
      s.parentId = other.id;
      corruptions.push(`${s.id} re-pointed at ${other.id}`);
    } else if (kind === 2) {
      const at = Math.floor(rng() * (n - 1));
      const s = summary(`R-${c}`, 1, [chunks[at].id, chunks[at + 1].id], 10 + Math.floor(rng() * 40));
      chunks[at].l1Id = s.id;
      summaries.push(s);
      corruptions.push(`${chunks[at].id} re-pointed at ${s.id}`);
    }
  }
  const rawZone = new Set<ChunkId>(rng() < 0.3 ? [chunks[n - 1].id] : []);
  const pinCaps = new Map<ChunkId, number>();
  if (rng() < 0.4) for (let p = 1 + Math.floor(rng() * 2); p > 0; p--) pinCaps.set(pick(chunks).id, Math.floor(rng() * 3));
  const fixedLevels = new Map<ChunkId, number>();
  if (rng() < 0.2 && summaries.length > 0) {
    const s = pick(summaries);
    const byId = new Map(summaries.map((x) => [x.id, x] as const));
    const leavesOf = (x: SummaryEntry): string[] =>
      x.level === 1 ? x.sourceIds : x.sourceIds.flatMap((id) => { const y = byId.get(id); return y ? leavesOf(y) : []; });
    for (const id of leavesOf(s)) if (!rawZone.has(id)) fixedLevels.set(id, s.level);
  }
  const frozen = new Set<ChunkId>();
  if (rng() < 0.2) {
    const c = pick(chunks);
    if (!rawZone.has(c.id) && !fixedLevels.has(c.id)) {
      frozen.add(c.id);
      // A lock keeps the level it was carried at, raw or folded.
      c.currentResolution = Math.floor(rng() * 4);
    }
  }
  const rawTotal = chunks.reduce((total, c) => total + c.rawTokens, 0);
  const targetTokens = Math.max(1, Math.floor(rawTotal * (0.05 + rng() * 0.6)));
  const { inputs, tree } = store(chunks, summaries);
  return {
    inputs, tree, corruptions,
    params: {
      targetTokens, foldAtTokens: Math.floor(targetTokens * (1 + rng())), windowTokens: rawTotal * 2,
      rawZone, pinCaps, fixedLevels, frozen, now: n,
    },
  };
}

// A store's links can change between compiles, as when a summary is written
// again without one of its sources while its children still point at it. On
// each tree: plan, take one source from a summary that has two or more, and
// plan again from the first plan's levels on the changed tree.
test('after a summary loses a source between compiles, every leaf renders through a summary that lists it', () => {
  const rng = mulberry32(2);
  let stale = 0;
  let staleLocked = 0;
  for (let t = 0; t < 300; t++) {
    const { inputs, tree, params, corruptions } = randomNonNested(rng);
    const first = planControlledFrontier(inputs, tree, { ...params, reachTokens: params.windowTokens, previous: new Map() });
    const relinkable = [...inputs.summaries.values()].filter((s) => s.sourceIds.length >= 2);
    if (relinkable.length === 0) continue;
    const s = relinkable[Math.floor(rng() * relinkable.length)];
    const sourceIds = s.sourceIds.slice(0, -1);
    const summaries = new Map(inputs.summaries);
    summaries.set(s.id, { ...s, sourceIds, sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] } });
    const changed: PickerInputs = { ...inputs, summaries };
    const after = new SummaryTree(changed);
    // Lock about a third of the leaves the first plan folded, at its levels.
    const frozen = new Set(params.frozen);
    for (const c of changed.chunks) {
      if ((first.resolutions.get(c.id) ?? 0) > 0 && !params.fixedLevels!.has(c.id) && rng() < 0.34) frozen.add(c.id);
    }
    // The first plan's levels on the changed tree: does one now point through
    // a summary that doesn't list its leaf? (The test needs such trees.)
    const staleIds = changed.chunks.filter((c) => {
      const level = first.resolutions.get(c.id) ?? 0;
      const node = level > 0 ? lineageAt(changed, c.id, level) : undefined;
      return node !== undefined && !listsLeaf(changed, node, c.id);
    }).map((c) => c.id);
    if (staleIds.length > 0) stale++;
    if (staleIds.some((id) => frozen.has(id))) staleLocked++;
    const second = planControlledFrontier(changed, after, { ...params, frozen, reachTokens: params.windowTokens, previous: first.resolutions });
    for (const c of changed.chunks) {
      const level = second.resolutions.get(c.id) ?? 0;
      if (level > 0) {
        assert.ok(rendersThrough(changed, c.id, level),
          `tree ${t} (${corruptions.join('; ')}; ${s.id} lost ${s.sourceIds[s.sourceIds.length - 1]}): ${c.id} at L${level} renders through a summary of its lineage that lists it`);
      }
    }
  }
  assert.ok(stale >= 30, `${stale} of 300 trees carried a level through a summary that no longer lists its leaf`);
  assert.ok(staleLocked >= 10, `${staleLocked} of 300 trees carried a locked leaf's level through such a summary`);
});

test('on unchanged inputs, each plan reports its change from the last plan, and an adopted ideal cut stays put', () => {
  const sameLevels = (a: ReadonlyMap<ChunkId, number>, b: ReadonlyMap<ChunkId, number>): boolean =>
    a.size === b.size && [...a].every(([id, level]) => (b.get(id) ?? 0) === level);
  const rng = mulberry32(1);
  let withOverlap = 0;
  for (let t = 0; t < 300; t++) {
    const { inputs, tree, params, corruptions } = randomNonNested(rng);
    // From nothing, the first plan adopts the ideal cut. From an all-raw
    // frontier with a small trust region, suffix adoption moves toward it.
    const starts = [
      { reachTokens: params.windowTokens, previous: new Map<ChunkId, number>() },
      { reachTokens: Math.max(1, Math.floor(params.targetTokens / 2)), previous: new Map(inputs.chunks.map((c) => [c.id, 0])) },
    ];
    let ideal: ReadonlyMap<ChunkId, number> | null = null;
    // A held level, lowered to the next level down where the leaf renders
    // through a summary of its lineage, or to raw.
    const renderable = (id: ChunkId, level: number): number => {
      let k = level;
      while (k > 0 && !rendersThrough(inputs, id, k)) k--;
      return k;
    };
    // The level a protection sets, which every plan must keep: the raw zone
    // raw, a pinned leaf at its level and a locked leaf at its carried level,
    // each lowered to where it renders through a summary. A lock's carried
    // level is the one the plan is given, or on a first plan from nothing the
    // chunk's own, as the base reads it.
    const heldLevel = (c: PickerChunk, carried: ReadonlyMap<ChunkId, number>): number | undefined => {
      if (params.rawZone.has(c.id)) return 0;
      const k = params.fixedLevels!.get(c.id);
      if (k !== undefined) return renderable(c.id, k);
      if (params.frozen!.has(c.id)) {
        const level = carried.get(c.id) ?? c.currentResolution;
        const cap = params.pinCaps!.get(c.id);
        return renderable(c.id, cap === undefined ? level : Math.min(level, cap));
      }
      return undefined;
    };
    let overlapped = false;
    for (const start of starts) {
      let previous: ReadonlyMap<ChunkId, number> = start.previous;
      // The first plan's perturbation counts from the carried frontier,
      // which applies those levels to where it starts.
      let before = renderLayout(inputs, tree, new Map(inputs.chunks.map((c) => [c.id, heldLevel(c, previous) ?? previous.get(c.id) ?? 0])));
      for (let turn = 1; turn <= 4; turn++) {
        const plan = planControlledFrontier(inputs, tree, { ...params, reachTokens: start.reachTokens, previous });
        if (plan.overlap.length > 0) overlapped = true;
        const after = renderLayout(inputs, tree, plan.resolutions);
        ideal ??= plan.resolutions;
        const where = `tree ${t} (${corruptions.join('; ')}), turn ${turn}: ${unitsOf(before).join(' ')} → ${unitsOf(after).join(' ')}`;
        assert.equal(plan.perturbation, kvCost(before, after), `perturbation is the change from the last plan's render, ${where}`);
        for (const c of inputs.chunks) {
          const level = plan.resolutions.get(c.id) ?? 0;
          const held = heldLevel(c, previous);
          if (held !== undefined) assert.equal(level, held, `${c.id} keeps its protected level, ${where}`);
          const cap = params.pinCaps!.get(c.id);
          if (cap !== undefined && !params.fixedLevels!.has(c.id)) assert.ok(level <= cap, `${c.id} stays at or below its pin cap, ${where}`);
          // A leaf renders through its own lineage at its level, which has to
          // list it.
          if (level > 0) assert.ok(rendersThrough(inputs, c.id, level), `${c.id} at L${level} renders through a summary of its lineage that lists it, ${where}`);
        }
        if (turn > 1 && sameLevels(previous, ideal)) {
          assert.ok(sameLevels(plan.resolutions, ideal), `the adopted ideal cut stays put, ${where}`);
        }
        if (turn > 1 && sameLevels(previous, plan.resolutions)) {
          assert.ok(!plan.folded && !plan.expanded, `an unchanged plan reports no fold or un-fold, ${where}`);
        }
        previous = plan.resolutions;
        before = after;
      }
    }
    if (overlapped) withOverlap++;
  }
  // The trees exercise the exemption: at least a third of them make some plan
  // report an overlap.
  assert.ok(withOverlap >= 100, `${withOverlap} of 300 trees made some plan report an overlap`);
});

// #194's stream, from #156's review: a base-6 chain at 50 raw / 100 recall,
// one leaf appended per turn, every frontier carried into the next solve, and
// the oldest L1's parent re-pointed at L2-6, an L2 in another L3's subtree,
// which doesn't list it. L2-0, which still lists that L1, and the L3 above it
// render beside its leaves. Every plan renders each leaf through a summary of
// its own lineage that lists it, and re-planned on unchanged inputs it stays
// put.
test('a re-pointed L1 across carried growth: each leaf renders through a summary that lists it, and each plan settles', () => {
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
  ch.summaries.get('L1-0')!.parentId = 'L2-6';
  // Each summary's leaves, through its sources, and the summary a chunk's
  // lineage reaches at a level, as the renderer walks it.
  const leaves = new Map<string, ReadonlySet<string>>();
  const leavesOf = (id: string): ReadonlySet<string> => {
    let set = leaves.get(id);
    if (!set) {
      const s = ch.summaries.get(id)!;
      set = new Set(s.sourceLevel === 0 ? s.sourceIds : s.sourceIds.flatMap((child) => [...leavesOf(child)]));
      leaves.set(id, set);
    }
    return set;
  };
  const lineageAtLevel = (c: PickerChunk, level: number): SummaryEntry | undefined => {
    let cur = c.l1Id === undefined ? undefined : ch.summaries.get(c.l1Id);
    while (cur && cur.level < level) {
      const parentId = getSummaryParentId(cur);
      cur = parentId === undefined ? undefined : ch.summaries.get(parentId);
    }
    return cur?.level === level ? cur : undefined;
  };
  let previous = new Map<ChunkId, number>();
  let folds = 0;
  let overlapped = 0;
  for (let t = 0; t < 120; t++) {
    add(); produce();
    const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
    const inputs: PickerInputs = {
      chunks: ch.chunks.map((c) => ({ ...c, currentResolution: previous.get(c.id) ?? 0 })),
      summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
      headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
    };
    const tree = new SummaryTree(inputs);
    const params = (prev: ReadonlyMap<ChunkId, number>) => ({
      previous: prev, foldAtTokens: 2150, expandAtTokens: 1600, targetTokens: 1600, windowTokens: 2150,
      rawZone: tail, now: n - 1, mergeThreshold: 6,
    });
    const plan = planControlledFrontier(inputs, tree, params(previous));
    for (const c of inputs.chunks) {
      const level = plan.resolutions.get(c.id) ?? 0;
      if (level === 0) continue;
      const s = lineageAtLevel(c, level);
      assert.ok(s && leavesOf(s.id).has(c.id), `turn ${t}: ${c.id} at L${level} renders through ${s?.id ?? 'no summary'}, which lists it`);
    }
    const again = planControlledFrontier(inputs, tree, params(plan.resolutions));
    assert.deepEqual(again.resolutions, plan.resolutions, `turn ${t}: re-planned on unchanged inputs, the plan stays put`);
    if (t > 0 && plan.folded) folds++;
    if (plan.overlap.some((id) => leavesOf('L1-0').has(id))) overlapped++;
    previous = plan.resolutions;
  }
  assert.ok(folds >= 2, `premise: the plans crossed W at least twice (folds=${folds})`);
  assert.ok(overlapped > 0, 'premise: a plan renders a summary over the re-pointed L1\'s leaves beside them');
});
