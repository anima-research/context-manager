/**
 * selectKeeperL1s — the ONE keeper coverage sweep shared by
 * AutobiographicalStrategy.migrateChunkRecords and scripts/repair-pyramid.ts.
 *
 * The repair script's hand copy drifted twice; the second drift checked
 * staleness over LIVE sourceIds only, while the strategy checks ALL
 * sourceIds — so an L1 whose live ids were covered but which carried
 * orphaned ids was KEPT by the strategy yet PRUNED by the script. These
 * tests pin the strategy's exact semantics on the shared function, in
 * particular that drift case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectKeeperL1s } from '../src/strategies/keeper-selection.js';

function index(n: number): Map<string, number> {
  return new Map(Array.from({ length: n }, (_, i) => [`m-${i}`, i]));
}

const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);

test('DRIFT CASE: an L1 whose live ids are covered but which has uncovered orphaned ids is KEPT', () => {
  const msgIndex = index(10);
  const l1s = [
    { id: 'A', sourceIds: msgs(0, 4) },                     // keeper, covers m-0..4
    { id: 'B', sourceIds: [...msgs(2, 4), 'ghost-1'] },     // live ids covered, ghost-1 NOT → kept
    { id: 'C', sourceIds: msgs(2, 4) },                     // ALL ids covered → stale
    { id: 'D', sourceIds: ['ghost-2', 'ghost-3'] },         // fully orphaned → skipped
  ];
  const { keepers, skippedStale, skippedGhost } = selectKeeperL1s(l1s, msgIndex);
  assert.deepEqual(keepers.map(k => k.id), ['A', 'B'],
    'B must be kept (strategy semantics: stale = ALL sourceIds covered, dead ids included)');
  assert.equal(skippedStale, 1);
  assert.equal(skippedGhost, 1);
});

test('sweep order: first-source index asc, span desc; longest generation per start wins', () => {
  const msgIndex = index(30);
  const l1s = [
    { id: 'gen-1', sourceIds: msgs(20, 24) },
    { id: 'late', sourceIds: msgs(25, 29) },
    { id: 'gen-3', sourceIds: msgs(20, 29) }, // longest at start 20 — claims first
    { id: 'gen-2', sourceIds: msgs(20, 27) },
    { id: 'early', sourceIds: msgs(0, 19) },
  ];
  const { keepers, skippedStale } = selectKeeperL1s(l1s, msgIndex);
  assert.deepEqual(keepers.map(k => k.id), ['early', 'gen-3'],
    'prefix-generation family collapses to the longest generation; late sibling fully covered by it');
  assert.equal(skippedStale, 3);
});

test('a keeper claims ALL its sourceIds (dead ids included), so identical dead tails do not block staleness', () => {
  const msgIndex = index(10);
  const l1s = [
    { id: 'A', sourceIds: [...msgs(0, 4), 'ghost-1'] },  // keeper — covers m-0..4 AND ghost-1
    { id: 'B', sourceIds: [...msgs(0, 4), 'ghost-1'] },  // exact duplicate incl. dead id → stale
  ];
  const { keepers, skippedStale } = selectKeeperL1s(l1s, msgIndex);
  assert.deepEqual(keepers.map(k => k.id), ['A']);
  assert.equal(skippedStale, 1);
});

test('pre-seeded covered set (record-owned ground) is honored and mutated in place', () => {
  const msgIndex = index(20);
  const covered = new Set(msgs(0, 9)); // owned by chunk records
  const l1s = [
    { id: 'redundant', sourceIds: msgs(0, 9) },   // fully record-covered → stale
    { id: 'fresh', sourceIds: msgs(10, 19) },     // new ground → kept
  ];
  const { keepers, skippedStale } = selectKeeperL1s(l1s, msgIndex, covered);
  assert.deepEqual(keepers.map(k => k.id), ['fresh']);
  assert.equal(skippedStale, 1);
  for (const id of msgs(10, 19)) assert.ok(covered.has(id), `covered gains ${id}`);
});

test('L1s whose first source is unknown sort last but can still claim uncovered live ground', () => {
  const msgIndex = index(10);
  const l1s = [
    { id: 'weird', sourceIds: ['ghost-0', ...msgs(5, 9)] }, // first source dead → sorts last
    { id: 'plain', sourceIds: msgs(0, 4) },
  ];
  const { keepers } = selectKeeperL1s(l1s, msgIndex);
  assert.deepEqual(keepers.map(k => k.id), ['plain', 'weird']);
});
