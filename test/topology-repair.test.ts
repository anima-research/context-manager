/**
 * General-purpose topology repair planner (src/repair/topology.ts) and its
 * end-to-end use: a persisted crossed store is repaired and then opens under
 * topologyPolicy 'reject'.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy, StoreTopologyError, planTopologyRepair } from '../src/index.js';
import type { RepairRecord, RepairSummary } from '../src/repair/topology.js';
import type { SummaryEntry } from '../src/types/strategy.js';

const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `m-${from + i}`);
const msgs = (n: number) => ids(0, n - 1).map((id) => ({ id }));
function l1(id: string, first: number, last: number, mergedInto?: string): RepairSummary {
  return { id, level: 1, sourceLevel: 0, sourceIds: ids(first, last), sourceRange: { first: `m-${first}`, last: `m-${last}` }, ...(mergedInto ? { mergedInto } : {}) };
}
function up(id: string, level: number, src: string[], first: number, last: number, mergedInto?: string): RepairSummary {
  return { id, level, sourceLevel: level - 1, sourceIds: src, sourceRange: { first: `m-${first}`, last: `m-${last}` }, ...(mergedInto ? { mergedInto } : {}) };
}
function rec(id: string, first: number, last: number, summaryId?: string): RepairRecord {
  return { id, sourceIds: ids(first, last), compressed: summaryId !== undefined, ...(summaryId ? { summaryId } : {}) };
}

describe('planTopologyRepair', () => {
  test('#122 shape: stray opening L1s are detached from cross-era parents; ranges recomputed; releaseHead frees the prefix', () => {
    // Opening messages 6..11 were peeled into one-message L1s that merged with
    // frontier L2s. 0..5 sit in an uncompressed late record.
    const summaries = [
      l1('L1-s1', 6, 7, 'L2-b'), l1('L1-s2', 8, 8, 'L2-a'), l1('L1-s3', 9, 11, 'L2-a'),
      l1('L1-0', 12, 21, 'L2-0'), l1('L1-1', 22, 31, 'L2-0'), l1('L1-2', 32, 41, 'L2-0'),
      l1('L1-3', 42, 51, 'L2-a'), l1('L1-4', 52, 61, 'L2-a'), l1('L1-5', 62, 71, 'L2-a'),
      l1('L1-6', 72, 81, 'L2-b'), l1('L1-7', 82, 91, 'L2-b'), l1('L1-8', 92, 99, 'L2-b'),
      up('L2-0', 2, ['L1-0', 'L1-1', 'L1-2'], 12, 41, 'L3-0'),
      up('L2-a', 2, ['L1-s2', 'L1-s3', 'L1-3', 'L1-4', 'L1-5'], 8, 71, 'L3-0'),
      up('L2-b', 2, ['L1-s1', 'L1-6', 'L1-7', 'L1-8'], 6, 99, 'L3-0'),
      up('L3-0', 3, ['L2-0', 'L2-a', 'L2-b'], 6, 99),
    ];
    const records = [
      rec('c-0', 12, 21, 'L1-0'), rec('c-1', 22, 31, 'L1-1'), rec('c-2', 32, 41, 'L1-2'), rec('c-3', 42, 51, 'L1-3'), rec('c-4', 52, 61, 'L1-4'),
      rec('c-5', 62, 71, 'L1-5'), rec('c-6', 72, 81, 'L1-6'), rec('c-7', 82, 91, 'L1-7'), rec('c-8', 92, 99, 'L1-8'),
      rec('c-9', 9, 11, 'L1-s3'), rec('c-10', 8, 8, 'L1-s2'), rec('c-11', 6, 7, 'L1-s1'), rec('c-12', 0, 5),
    ];
    const resolutions = Object.fromEntries([...ids(6, 11).map((id) => [id, 3]), ...ids(12, 99).map((id) => [id, 2])]);
    const lossless = planTopologyRepair({ summaries, records, messages: msgs(100), resolutions });
    assert.deepEqual(lossless.detached.map((d) => d.id).sort(), ['L1-s1', 'L1-s2', 'L1-s3']);
    assert.equal(lossless.rehomed.length + lossless.adopted.length, 0, 'lossless never moves content under foreign prose');
    for (const id of ['L1-s1', 'L1-s2', 'L1-s3']) assert.equal(lossless.result.summaries.find((s) => s.id === id)!.mergedInto, undefined);
    assert.equal(lossless.remaining.length, 0);
    assert.equal(lossless.proseGapLeaves, 0);
    assert.equal(lossless.depthLostLeaves, 6, 'the six stray leaves lose their (bogus) L2/L3 depth');
    assert.deepEqual(lossless.result.summaries.find((s) => s.id === 'L3-0')!.sourceRange, { first: 'm-12', last: 'm-99' });

    const plan = planTopologyRepair({ summaries, records, messages: msgs(100), resolutions }, { mode: 'compact' });
    assert.deepEqual(plan.before.map((c) => c.id).sort(), ['L2-a', 'L2-b'], 'the L3 spans 6..99 without a hole: only its L2s are crossed');
    assert.deepEqual(plan.detached.map((d) => d.id).sort(), ['L1-s1', 'L1-s2', 'L1-s3']);
    assert.equal(plan.remaining.length, 0);
    assert.equal(plan.iterations, 1);
    const after = new Map(plan.result.summaries.map((s) => [s.id, s]));
    assert.deepEqual(after.get('L2-a')!.sourceIds, ['L1-3', 'L1-4', 'L1-5']);
    assert.deepEqual(after.get('L2-a')!.sourceRange, { first: 'm-42', last: 'm-71' });
    assert.deepEqual(after.get('L2-b')!.sourceRange, { first: 'm-72', last: 'm-99' });
    // The strays are re-homed under the adjacent era summary (L2-0 spans 12..41),
    // so the L3 keeps no hole and now starts at the opening.
    assert.deepEqual(plan.rehomed.map((r) => `${r.id}>${r.into}`).sort(), ['L1-s1>L2-0', 'L1-s2>L2-0', 'L1-s3>L2-0']);
    assert.deepEqual(after.get('L2-0')!.sourceIds, ['L1-s1', 'L1-s2', 'L1-s3', 'L1-0', 'L1-1', 'L1-2']);
    assert.deepEqual(after.get('L3-0')!.sourceRange, { first: 'm-6', last: 'm-99' });
    assert.equal(plan.iterations, 1, 'no ancestor was left crossed');
    assert.equal(plan.resolutionsClamped, 0);
    assert.equal(plan.released.length, 0, 'no head release without the option');

    assert.equal(plan.proseGapLeaves, 6, 'the six stray leaves now sit under prose that never covered them');
    const released = planTopologyRepair({ summaries, records, messages: msgs(100), resolutions }, { releaseHead: true, mode: 'compact' });
    assert.deepEqual(released.released.map((r) => r.record).sort(), ['c-10', 'c-11', 'c-12', 'c-9']);
    const kept = new Set(released.result.summaries.map((s) => s.id));
    assert.ok(!kept.has('L1-s1') && !kept.has('L1-s2') && !kept.has('L1-s3'));
    assert.deepEqual(released.result.summaries.find((s) => s.id === 'L2-0')!.sourceIds, ['L1-0', 'L1-1', 'L1-2'], 're-homed strays are released, not kept under L2-0');
    assert.deepEqual(released.result.summaries.find((s) => s.id === 'L3-0')!.sourceRange, { first: 'm-12', last: 'm-99' });
    assert.ok(released.result.records.every((r) => !r.sourceIds.some((id) => ids(0, 11).includes(id))), 'messages 0..11 are unowned');
    assert.ok(ids(6, 11).every((id) => !(id in released.result.resolutions)));
    assert.equal(released.remaining.length, 0);
  });

  test('#95 shape: a parent that skipped unlanded neighbours adopts them (roots one level down)', () => {
    const summaries = [
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => l1(`L1-${i}`, i * 10, i * 10 + 9)),
      up('L2-x', 2, ['L1-0', 'L1-2', 'L1-3', 'L1-4', 'L1-6'], 0, 69),
    ];
    for (const id of ['L1-0', 'L1-2', 'L1-3', 'L1-4', 'L1-6']) summaries.find((s) => s.id === id)!.mergedInto = 'L2-x';
    const records = [0, 1, 2, 3, 4, 5, 6].map((i) => rec(`c-${i}`, i * 10, i * 10 + 9, `L1-${i}`));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(70) }, { mode: 'compact' });
    assert.deepEqual(plan.adopted.map((a) => a.id).sort(), ['L1-1', 'L1-5']);
    assert.equal(plan.detached.length, 0);
    const l2 = plan.result.summaries.find((s) => s.id === 'L2-x')!;
    assert.deepEqual(l2.sourceIds, ['L1-0', 'L1-1', 'L1-2', 'L1-3', 'L1-4', 'L1-5', 'L1-6'], 'sources in position order');
    assert.equal(plan.result.summaries.find((s) => s.id === 'L1-5')!.mergedInto, 'L2-x');
    assert.equal(plan.remaining.length, 0);

    const detachOnly = planTopologyRepair({ summaries, records, messages: msgs(70) });
    assert.equal(detachOnly.adopted.length, 0);
    assert.deepEqual(detachOnly.detached.map((d) => d.id).sort(), ['L1-0', 'L1-6']);
    assert.deepEqual(detachOnly.result.summaries.find((s) => s.id === 'L2-x')!.sourceIds, ['L1-2', 'L1-3', 'L1-4']);
    assert.equal(detachOnly.remaining.length, 0);
  });

  test('a small hole deep inside a tower is closed by adopting its owner downward', () => {
    // L3 over L2-a (L1-0..L1-2) and L2-b (L1-4..L1-6); L1-3 is an unmerged root
    // sitting between them. The L3 (and only the L3) is crossed.
    const l1s = [0, 1, 2, 3, 4, 5, 6].map((i) => l1(`L1-${i}`, i * 10, i * 10 + 9));
    const summaries = [...l1s, up('L2-a', 2, ['L1-0', 'L1-1', 'L1-2'], 0, 29, 'L3'), up('L2-b', 2, ['L1-4', 'L1-5', 'L1-6'], 40, 69, 'L3'), up('L3', 3, ['L2-a', 'L2-b'], 0, 69)];
    for (const i of [0, 1, 2]) l1s[i].mergedInto = 'L2-a';
    for (const i of [4, 5, 6]) l1s[i].mergedInto = 'L2-b';
    const records = [0, 1, 2, 3, 4, 5, 6].map((i) => rec(`c-${i}`, i * 10, i * 10 + 9, `L1-${i}`));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(70) }, { mode: 'compact' });
    assert.deepEqual(plan.adopted, [{ id: 'L1-3', level: 1, into: 'L2-a', leaves: 10 }], 'adopted into the adjacent L2, not the L3');
    assert.equal(plan.detached.length, 0);
    assert.equal(plan.depthLostLeaves, 0);
    assert.deepEqual(plan.result.summaries.find((s) => s.id === 'L2-a')!.sourceIds, ['L1-0', 'L1-1', 'L1-2', 'L1-3']);
    assert.deepEqual(plan.result.summaries.find((s) => s.id === 'L2-a')!.sourceRange, { first: 'm-0', last: 'm-39' });
    assert.deepEqual(plan.result.summaries.find((s) => s.id === 'L3')!.sourceRange, { first: 'm-0', last: 'm-69' });
    assert.equal(plan.remaining.length, 0);
  });

  test('a detached fragment is re-homed under the adjacent sibling so the ancestor keeps no hole', () => {
    // L2-a owns L1-0..L1-2 plus the stray L1-9 (leaves 90..99) — stray for L2-a,
    // but adjacent to L2-c (L1-6..L1-8). L3 over a,b,c must stay contiguous.
    const summaries = [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => l1(`L1-${i}`, i * 10, i * 10 + 9)),
      up('L2-a', 2, ['L1-0', 'L1-1', 'L1-2', 'L1-9'], 0, 99, 'L3'), up('L2-b', 2, ['L1-3', 'L1-4', 'L1-5'], 30, 59, 'L3'), up('L2-c', 2, ['L1-6', 'L1-7', 'L1-8'], 60, 89, 'L3'),
      up('L3', 3, ['L2-a', 'L2-b', 'L2-c'], 0, 99),
    ];
    const parent: Record<string, string> = { 'L1-0': 'L2-a', 'L1-1': 'L2-a', 'L1-2': 'L2-a', 'L1-9': 'L2-a', 'L1-3': 'L2-b', 'L1-4': 'L2-b', 'L1-5': 'L2-b', 'L1-6': 'L2-c', 'L1-7': 'L2-c', 'L1-8': 'L2-c' };
    for (const s of summaries) if (parent[s.id]) s.mergedInto = parent[s.id];
    const records = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => rec(`c-${i}`, i * 10, i * 10 + 9, `L1-${i}`));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(100) }, { mode: 'compact' });
    assert.deepEqual(plan.detached.map((d) => d.id), ['L1-9']);
    assert.deepEqual(plan.rehomed, [{ id: 'L1-9', from: 'L2-a', into: 'L2-c', leaves: 10 }]);
    const c = plan.result.summaries.find((s) => s.id === 'L2-c')!;
    assert.deepEqual(c.sourceIds, ['L1-6', 'L1-7', 'L1-8', 'L1-9']);
    assert.deepEqual(c.sourceRange, { first: 'm-60', last: 'm-99' });
    assert.deepEqual(plan.result.summaries.find((s) => s.id === 'L2-a')!.sourceRange, { first: 'm-0', last: 'm-29' });
    assert.equal(plan.iterations, 1, 'the L3 never became crossed');
    assert.equal(plan.resolutionsClamped, 0);
    assert.equal(plan.remaining.length, 0);
  });

  test('rebuild dissolves the crossed summary, everything overlapping its region, and their ancestors', () => {
    // L2-x skipped L1-1 and L1-5 (roots). L2-y (L1-7..L1-9) is clean; both L2s sit under L3.
    const summaries = [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => l1(`L1-${i}`, i * 10, i * 10 + 9)),
      up('L2-x', 2, ['L1-0', 'L1-2', 'L1-3', 'L1-4', 'L1-6'], 0, 69, 'L3'),
      up('L2-y', 2, ['L1-7', 'L1-8', 'L1-9'], 70, 99, 'L3'),
      up('L3', 3, ['L2-x', 'L2-y'], 0, 99),
    ];
    for (const id of ['L1-0', 'L1-2', 'L1-3', 'L1-4', 'L1-6']) summaries.find((s) => s.id === id)!.mergedInto = 'L2-x';
    for (const id of ['L1-7', 'L1-8', 'L1-9']) summaries.find((s) => s.id === id)!.mergedInto = 'L2-y';
    const records = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => rec(`c-${i}`, i * 10, i * 10 + 9, `L1-${i}`));
    const resolutions = Object.fromEntries(ids(0, 99).map((id) => [id, 3]));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(100), resolutions }, { mode: 'rebuild' });
    assert.deepEqual(plan.dissolvedForRebuild.map((d) => d.id).sort(), ['L2-x', 'L3'], 'the crossed L2 and its ancestor; the clean sibling L2-y survives as a root');
    const left = plan.result.summaries;
    assert.ok(!left.some((s) => s.id === 'L2-x' || s.id === 'L3'));
    for (const id of ['L1-0', 'L1-1', 'L1-2', 'L1-3', 'L1-4', 'L1-5', 'L1-6', 'L2-y']) assert.equal(left.find((s) => s.id === id)!.mergedInto, undefined, `${id} is a root`);
    assert.equal(left.find((s) => s.id === 'L1-7')!.mergedInto, 'L2-y');
    assert.equal(plan.exposedL1Leaves, 50, 'the five children of L2-x drop to L1; the two hole owners already were');
    assert.equal(plan.result.resolutions['m-0'], 1, 'a rebuilt region renders at L1');
    assert.equal(plan.result.resolutions['m-70'], 2, 'the surviving L2 keeps its depth');
    assert.equal(plan.remaining.length, 0);
    assert.equal(plan.detached.length + plan.adopted.length + plan.rehomed.length, 0);
  });

  test('rebuild-since rebuilds crossed summaries after the cutoff and compacts the older ones', () => {
    // Two #95-shaped crossed L2s: an old one (0..69) and a recent one (100..169).
    const mk = (base: number, tag: string) => {
      const l1s = [0, 1, 2, 3, 4, 5, 6].map((i) => l1(`L1-${tag}${i}`, base + i * 10, base + i * 10 + 9));
      const l2 = up(`L2-${tag}`, 2, [0, 2, 3, 4, 6].map((i) => `L1-${tag}${i}`), base, base + 69);
      for (const i of [0, 2, 3, 4, 6]) l1s[i].mergedInto = `L2-${tag}`;
      const recs = [0, 1, 2, 3, 4, 5, 6].map((i) => rec(`c-${tag}${i}`, base + i * 10, base + i * 10 + 9, `L1-${tag}${i}`));
      return { l1s, l2, recs };
    };
    const old = mk(0, 'o'), recent = mk(100, 'r');
    const summaries = [...old.l1s, old.l2, ...recent.l1s, recent.l2];
    const records = [...old.recs, ...recent.recs];
    const messages = ids(0, 199).map((id, i) => ({ id, timestamp: Date.UTC(2026, 0, 1) + i * 3600_000 }));
    const byId = planTopologyRepair({ summaries, records, messages }, { mode: 'rebuild', rebuildSince: 'm-100' });
    assert.deepEqual(byId.rebuildSince, { id: 'm-100', position: 100, rebuilt: 1, compacted: 1 });
    assert.deepEqual(byId.dissolvedForRebuild.map((d) => d.id), ['L2-r'], 'only the recent tower is rebuilt');
    assert.deepEqual(byId.adopted.map((a) => a.id).sort(), ['L1-o1', 'L1-o5'], 'the old one adopts its hole owners instead');
    assert.equal(byId.remaining.length, 0);
    const byDate = planTopologyRepair({ summaries, records, messages }, { mode: 'rebuild', rebuildSince: new Date(Date.UTC(2026, 0, 1) + 100 * 3600_000).toISOString() });
    assert.deepEqual(byDate.rebuildSince, byId.rebuildSince, 'an ISO date resolves to the first message at or after it');
    assert.throws(() => planTopologyRepair({ summaries, records, messages }, { mode: 'rebuild', rebuildSince: 'm-999' }), /no message matches/);
  });

  test('a crossed L1 keeps its largest run and releases the stray messages from its record', () => {
    const stray = { ...l1('L1-x', 40, 43), sourceIds: ['m-3', ...ids(40, 43)], sourceRange: { first: 'm-3', last: 'm-43' } };
    const summaries = [l1('L1-0', 4, 19), l1('L1-1', 20, 39), stray];
    const records = [rec('c-0', 4, 19, 'L1-0'), rec('c-1', 20, 39, 'L1-1'), { ...rec('c-2', 40, 43, 'L1-x'), sourceIds: ['m-3', ...ids(40, 43)] }];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(50), resolutions: { 'm-3': 1 } });
    assert.deepEqual(plan.splitL1, [{ id: 'L1-x', kept: 4, released: ['m-3'] }]);
    assert.deepEqual(plan.result.records.find((r) => r.id === 'c-2')!.sourceIds, ids(40, 43));
    assert.deepEqual(plan.result.summaries.find((s) => s.id === 'L1-x')!.sourceRange, { first: 'm-40', last: 'm-43' });
    assert.ok(!('m-3' in plan.result.resolutions));
    assert.equal(plan.remaining.length, 0);
  });

  test('a parent left with one source is dissolved and its grandparent shrinks', () => {
    const summaries = [
      l1('L1-a', 0, 9, 'L2-p'), l1('L1-b', 30, 39, 'L2-p'), l1('L1-c', 10, 19, 'L2-q'), l1('L1-d', 20, 29, 'L2-q'),
      up('L2-p', 2, ['L1-a', 'L1-b'], 0, 39, 'L3-r'), up('L2-q', 2, ['L1-c', 'L1-d'], 10, 29, 'L3-r'),
      up('L3-r', 3, ['L2-p', 'L2-q'], 0, 39),
    ];
    const records = [rec('c-a', 0, 9, 'L1-a'), rec('c-c', 10, 19, 'L1-c'), rec('c-d', 20, 29, 'L1-d'), rec('c-b', 30, 39, 'L1-b')];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(40) }, { mode: 'compact' });
    // L2-p keeps L1-a (tie on leaves → earliest) and loses L1-b, which is
    // re-homed under the adjacent L2-q; L2-p then has one source and
    // dissolves, and L3-r, left with L2-q alone, dissolves too.
    assert.deepEqual(plan.rehomed.map((r) => `${r.id}>${r.into}`), ['L1-b>L2-q']);
    assert.deepEqual(plan.dissolved.map((d) => d.id), ['L2-p', 'L3-r']);
    const left = new Set(plan.result.summaries.map((s) => s.id));
    assert.ok(!left.has('L2-p') && !left.has('L3-r'));
    assert.deepEqual(plan.result.summaries.find((s) => s.id === 'L2-q')!.sourceIds, ['L1-c', 'L1-d', 'L1-b']);
    for (const id of ['L1-a', 'L2-q']) assert.equal(plan.result.summaries.find((s) => s.id === id)!.mergedInto, undefined, `${id} is a root`);
    assert.equal(plan.remaining.length, 0);
  });

  test('a clean store plans nothing', () => {
    const summaries = [l1('L1-0', 0, 9, 'L2'), l1('L1-1', 10, 19, 'L2'), up('L2', 2, ['L1-0', 'L1-1'], 0, 19)];
    const records = [rec('c-0', 0, 9, 'L1-0'), rec('c-1', 10, 19, 'L1-1')];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(30) });
    assert.equal(plan.before.length, 0);
    assert.equal(plan.detached.length + plan.splitL1.length + plan.dissolved.length + plan.rangeChanges.length, 0);
  });
});

describe('repair end to end', () => {
  const STORE = './test-topology-repair-store';
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);

  test('a persisted crossed store is refused, repaired from its states, then opens under reject', async () => {
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const cfg = { adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false };
    const seed = new AutobiographicalStrategy(cfg);
    const manager = await ContextManager.open({ path: STORE, strategy: seed, membrane: membrane as never });
    const m: string[] = [];
    for (let i = 0; i < 40; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
    const s = (a: number, b: number) => m.slice(a, b + 1);
    const mk = (id: string, level: number, src: string[], first: string, last: string, mergedInto?: string): SummaryEntry => ({
      id, level, content: `s ${id}`, tokens: 50, sourceLevel: level - 1, sourceIds: src, sourceRange: { first, last }, created: 1, ...(mergedInto ? { mergedInto } : {}),
    } as SummaryEntry);
    const summaries = [
      mk('L1-stray', 1, s(3, 3), m[3], m[3], 'L2-x'), mk('L1-a', 1, s(4, 13), m[4], m[13]), mk('L1-b', 1, s(14, 23), m[14], m[23]),
      mk('L1-c', 1, s(24, 33), m[24], m[33], 'L2-x'), mk('L1-d', 1, s(34, 39), m[34], m[39], 'L2-x'),
      mk('L2-x', 2, ['L1-stray', 'L1-c', 'L1-d'], m[3], m[39]),
    ];
    const records = [
      { id: 'c-0', sourceIds: s(4, 13), compressed: true, summaryId: 'L1-a' }, { id: 'c-1', sourceIds: s(14, 23), compressed: true, summaryId: 'L1-b' },
      { id: 'c-2', sourceIds: s(24, 33), compressed: true, summaryId: 'L1-c' }, { id: 'c-3', sourceIds: s(34, 39), compressed: true, summaryId: 'L1-d' },
      { id: 'c-4', sourceIds: s(3, 3), compressed: true, summaryId: 'L1-stray' },
    ];
    const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void; getStateJson(id: string): unknown }; summariesStateId: string; chunksStateId: string; resolutionsStateId: string };
    internals.store.setStateJson(internals.summariesStateId, summaries);
    internals.store.setStateJson(internals.chunksStateId, records);
    manager.close();

    await assert.rejects(ContextManager.open({ path: STORE, strategy: new AutobiographicalStrategy(cfg), membrane: membrane as never }), (e: unknown) => e instanceof StoreTopologyError);

    // Repair from the persisted states, as the CLI does.
    const report = new AutobiographicalStrategy({ ...cfg, topologyPolicy: 'report' });
    const opened = await ContextManager.open({ path: STORE, strategy: report, membrane: membrane as never });
    const ri = report as unknown as typeof internals;
    const plan = planTopologyRepair({
      summaries: ri.store.getStateJson(ri.summariesStateId) as RepairSummary[],
      records: ri.store.getStateJson(ri.chunksStateId) as RepairRecord[],
      messages: opened.getAllMessages(),
      resolutions: ri.store.getStateJson(ri.resolutionsStateId) as Record<string, number> | null,
    }, { releaseHead: true });
    assert.deepEqual(plan.detached.map((d) => d.id), ['L1-stray']);
    assert.deepEqual(plan.released.map((r) => r.record), ['c-4'], 'the detached opening L1 is released to the head');
    assert.equal(plan.remaining.length, 0);
    ri.store.setStateJson(ri.summariesStateId, plan.result.summaries);
    ri.store.setStateJson(ri.chunksStateId, plan.result.records);
    ri.store.setStateJson(ri.resolutionsStateId, plan.result.resolutions);
    opened.close();

    const strict = new AutobiographicalStrategy(cfg);
    const reopened = await ContextManager.open({ path: STORE, strategy: strict, membrane: membrane as never });
    try {
      assert.equal(strict.getCompressionDebt().topologyViolations, 0);
      assert.deepEqual(strict.getTopologyViolations(), []);
    } finally { reopened.close(); }
  });
});
