/**
 * General-purpose topology repair planner (src/repair/topology.ts) and its
 * end-to-end use: a persisted crossed store is repaired and then opens under
 * topologyPolicy 'reject'.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JsStore } from '@animalabs/chronicle';

import { ContextManager, AutobiographicalStrategy, StoreTopologyError, planTopologyRepair } from '../src/index.js';
import { loadedAsWritten, strandedInStore, type RepairRecord, type RepairSummary } from '../src/repair/topology.js';
import type { SummaryEntry } from '../src/types/strategy.js';

const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `m-${from + i}`);
const msgs = (n: number) => ids(0, n - 1).map((id) => ({ id }));
function l1(id: string, first: number, last: number, mergedInto?: string): RepairSummary {
  return { id, level: 1, sourceLevel: 0, content: `s ${id}`, sourceIds: ids(first, last), sourceRange: { first: `m-${first}`, last: `m-${last}` }, ...(mergedInto ? { mergedInto } : {}) };
}
function up(id: string, level: number, src: string[], first: number, last: number, mergedInto?: string): RepairSummary {
  return { id, level, sourceLevel: level - 1, content: `s ${id}`, sourceIds: src, sourceRange: { first: `m-${first}`, last: `m-${last}` }, ...(mergedInto ? { mergedInto } : {}) };
}
function rec(id: string, first: number, last: number, summaryId?: string): RepairRecord {
  return { id, sourceIds: ids(first, last), compressed: summaryId !== undefined, ...(summaryId ? { summaryId } : {}) };
}

function tower(prefix: string, from: number, height: number, branch: number, per = 4) {
  const summaries: RepairSummary[] = [];
  const records: RepairRecord[] = [];
  let at = from;
  const build = (level: number, path: string): RepairSummary => {
    const id = `${prefix}${path}`;
    if (level === 1) {
      const s = l1(id, at, at + per - 1);
      records.push(rec(`c-${id}`, at, at + per - 1, id));
      at += per;
      summaries.push(s);
      return s;
    }
    const children = Array.from({ length: branch }, (_, i) => build(level - 1, `${path}.${i}`));
    const s = up(id, level, children.map((c) => c.id), Number(children[0].sourceRange.first.slice(2)), Number(children[children.length - 1].sourceRange.last.slice(2)));
    for (const c of children) c.mergedInto = id;
    summaries.push(s);
    return s;
  };
  build(height + 1, '');
  return { summaries, records, next: at };
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

  test('the planner finds a crossed summary whose child covers more messages than a call takes as spread arguments (#258)', () => {
    // A call takes about 125,000 spread arguments on node 22 and 24. The
    // planner collects each summary's messages from its children's, so an L3
    // over an L2 of 199,990 messages took them in one spread, which threw. A
    // failure of this premise means the runtime takes more spread arguments,
    // as with a larger stack (`node --stack-size`) or a newer V8, not that the
    // planner changed: raise the count until a spread throws again.
    const count = 200_000;
    assert.throws(() => Math.max(...new Array<number>(count).fill(0)), RangeError,
      'premise: this runtime takes fewer spread arguments than the L2 has messages');
    // The second-last L1 is left out of the L2, so the L2 and the L3 over it
    // are crossed by a 10-message hole.
    const hole = count / 10 - 2;
    const summaries: RepairSummary[] = [];
    const records: RepairRecord[] = [];
    for (let k = 0; k < count / 10; k++) {
      summaries.push(l1(`a${k}`, 10 * k, 10 * k + 9, k === hole ? undefined : 'L2'));
      records.push(rec(`c-${k}`, 10 * k, 10 * k + 9, `a${k}`));
    }
    summaries.push(up('L2', 2, summaries.filter((_, k) => k !== hole).map((s) => s.id), 0, count - 1, 'L3'));
    summaries.push(up('L3', 3, ['L2'], 0, count - 1));
    // Finding them is where the collector runs; no repair iteration is needed
    // for that, and each would rebuild the planner's view of the whole store.
    const plan = planTopologyRepair({ summaries, records, messages: msgs(count) }, { maxIterations: 0 });
    assert.deepEqual(plan.before.map((c) => [c.id, c.leafCount, c.holes]), [['L2', count - 10, 10], ['L3', count - 10, 10]]);
  });

  test('rebuild gives a stranded L2 between an L3 and an L4 partners by dissolving the L3 beside it', () => {
    const A = tower('A', 0, 2, 6);
    const S = tower('S', A.next, 1, 2);
    const B = tower('B', S.next, 3, 6);
    const N = tower('N', B.next, 1, 2);
    const parts = [A, S, B, N];
    const summaries = parts.flatMap((x) => x.summaries);
    const records = parts.flatMap((x) => x.records);
    const plan = planTopologyRepair({ summaries, records, messages: msgs(N.next) }, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered, [{ kind: 'stranded', id: 'S', level: 2, leaves: 8, span: { first: 'm-144', last: 'm-151' }, dissolved: 'A' }]);
    assert.deepEqual(plan.dissolvedForRebuild.map((d) => d.id), ['A']);
    const left = new Map(plan.result.summaries.map((x) => [x.id, x] as const));
    for (const id of ['A.0', 'A.1', 'A.2', 'A.3', 'A.4', 'A.5', 'S']) assert.equal(left.get(id)!.mergedInto, undefined, `${id} is a root`);
    assert.equal(left.get('B.0')!.mergedInto, 'B', 'the larger tower stands');
    assert.deepEqual(plan.strandedLeft, []);
    assert.equal(plan.remaining.length, 0);
  });

  test('rebuild gives a stranded L1 beside a quarantined chunk partners by dissolving the L2 on its other side', () => {
    const P = tower('P', 0, 1, 6);
    const X = tower('X', P.next, 0, 1);
    const hole = rec('c-hole', X.next, X.next + 3);
    const Q = tower('Q', X.next + 4, 2, 6);
    const R = tower('R', Q.next, 2, 6);
    const N = tower('N', R.next, 0, 1);
    const parts = [P, X, Q, R, N];
    const summaries = parts.flatMap((x) => x.summaries);
    const records = [...parts.flatMap((x) => x.records), hole];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(N.next), compressionQuarantined: ['c-hole'] }, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered, [{ kind: 'stranded', id: 'X', level: 1, leaves: 4, span: { first: 'm-24', last: 'm-27' }, dissolved: 'P' }]);
    assert.deepEqual(plan.dissolvedForRebuild.map((d) => d.id), ['P']);
    assert.equal(plan.result.records.find((r) => r.id === 'c-hole')!.compressed, false, 'the refused chunk stays as it was');
  });

  function released() {
    const W = Array.from({ length: 5 }, (_, i) => l1(`W${i}`, i * 10, i * 10 + 9));
    const crossed: RepairSummary = { ...l1('X', 50, 54), sourceIds: [...ids(50, 54), ...ids(75, 79)], sourceRange: { first: 'm-50', last: 'm-79' } };
    const Y = tower('Y', 55, 1, 4, 5);
    const Z = tower('Z', 80, 1, 3, 5);
    const N = tower('N', 95, 0, 1, 5);
    const parts = [Y, Z, N];
    const summaries = [...W, ...parts.flatMap((x) => x.summaries), crossed];
    const records = [
      ...W.map((w, i) => rec(`c-W${i}`, i * 10, i * 10 + 9, w.id)), ...parts.flatMap((x) => x.records),
      { ...rec('c-X', 50, 54, 'X'), sourceIds: crossed.sourceIds },
    ];
    return { summaries, records, messages: msgs(100) };
  }

  test('rebuild gives the messages a crossed L1 releases partners by dissolving the smaller tower beside them', () => {
    const plan = planTopologyRepair(released(), { mode: 'rebuild' });
    assert.deepEqual(plan.splitL1, [{ id: 'X', kept: 5, released: ids(75, 79) }]);
    assert.deepEqual(plan.partnered, [{ kind: 'released', id: 'X', level: 1, leaves: 5, span: { first: 'm-75', last: 'm-79' }, dissolved: 'Z' }]);
    assert.deepEqual(plan.dissolvedForRebuild.map((d) => d.id), ['Z']);
    assert.deepEqual(plan.strandedLeft, []);
    assert.equal(plan.remaining.length, 0);
  });

  test('rebuild-since lists a released run before the cutoff and gives it no partner, while the split still releases it', () => {
    const plan = planTopologyRepair(released(), { mode: 'rebuild', rebuildSince: 'm-80' });
    assert.deepEqual(plan.splitL1, [{ id: 'X', kept: 5, released: ids(75, 79) }]);
    assert.deepEqual(plan.partnered, []);
    assert.deepEqual(plan.dissolvedForRebuild, []);
    assert.deepEqual(plan.strandedLeft, [
      { kind: 'released', id: 'X', level: 1, leaves: 5, span: { first: 'm-75', last: 'm-79' }, reason: 'before rebuildSince' },
    ]);
  });

  test('rebuild-since leaves a stray before the cutoff as it is, and lists it', () => {
    const A = tower('A', 0, 2, 6);
    const S = tower('S', A.next, 1, 2);
    const B = tower('B', S.next, 3, 6);
    const N = tower('N', B.next, 1, 2);
    const parts = [A, S, B, N];
    const plan = planTopologyRepair(
      { summaries: parts.flatMap((x) => x.summaries), records: parts.flatMap((x) => x.records), messages: msgs(N.next) },
      { mode: 'rebuild', rebuildSince: `m-${B.next}` },
    );
    assert.deepEqual(plan.partnered, []);
    assert.deepEqual(plan.dissolvedForRebuild, []);
    assert.deepEqual(plan.strandedLeft, [
      { kind: 'stranded', id: 'S', level: 2, leaves: 8, span: { first: 'm-144', last: 'm-151' }, reason: 'before rebuildSince' },
      { kind: 'stranded', id: 'A', level: 3, leaves: 144, span: { first: 'm-0', last: 'm-143' }, reason: 'before rebuildSince' },
    ]);
  });

  function between(left: ReturnType<typeof tower> | null, middle: RepairSummary[], right: ReturnType<typeof tower>) {
    const parts = [...(left ? [left] : []), right];
    const N = tower('N', right.next, 0, 1);
    const summaries = [...parts.flatMap((x) => x.summaries), ...middle, ...N.summaries];
    const records = [...parts.flatMap((x) => x.records), ...middle.filter((x) => x.level === 1).map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id)), ...N.records];
    return { summaries, records, messages: msgs(N.next) };
  }

  test('rebuild reads two summaries a raw message parts as two runs, as the merge check does', () => {
    const P = tower('P', 0, 1, 6);
    const Q = tower('Q', 33, 1, 6);
    const inputs = between(P, [l1('A', 24, 27), l1('B', 29, 32)], Q);
    assert.deepEqual(strandedInStore(inputs), [{ id: 'A', level: 1 }, { id: 'B', level: 1 }, { id: 'P', level: 2 }], 'A and B each stand alone at L1, and P at L2 beside A');
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered.map((x) => [x.id, x.dissolved]), [['A', 'P'], ['B', 'Q']], 'each gets the tower on its own side, not the other across the message');
  });

  test('rebuild reads a held summary as a hole, never a partner, and frees the other side', () => {
    const P = tower('P', 0, 1, 6);
    const Q = tower('Q', 32, 1, 6);
    const inputs = between(P, [l1('A', 24, 27), l1('H', 28, 31)], Q);
    const runs = { mergeHoldSummaryIds: ['H'] };
    assert.deepEqual(strandedInStore(inputs, runs), [{ id: 'A', level: 1 }, { id: 'P', level: 2 }], 'A stands alone, and so does P beside it; H is held, not stranded');
    assert.deepEqual(strandedInStore(inputs).filter((x) => x.level === 1), [], 'without the hold, A and H are a run');
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', runs });
    assert.deepEqual(plan.partnered.map((x) => [x.id, x.dissolved]), [['A', 'P']]);
  });

  test('rebuild frees no tower that starts before rebuildSince, and lists a stray whose only towers do', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 12, 2, 6);
    const inputs = between(P, [l1('S', 8, 11)], Q);
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', rebuildSince: 'm-8' });
    assert.deepEqual(plan.partnered.map((x) => [x.id, x.dissolved]), [['S', 'Q.0']], 'P is smaller but starts before the cutoff, so Q is freed');
    const held = planTopologyRepair(between(P, [l1('S', 8, 11), l1('H', 12, 15)], tower('Q', 16, 1, 6)), { mode: 'rebuild', rebuildSince: 'm-8', runs: { mergeHoldSummaryIds: ['H'] } });
    assert.deepEqual(held.strandedLeft.map((x) => [x.id, x.reason]), [['S', 'neighbours before rebuildSince'], ['P', 'before rebuildSince']], 'P stands alone at L2 too, beside S');
  });

  test('rebuild lists a stray with no neighbour of its level to free', () => {
    const Q = tower('Q', 8, 1, 6);
    const inputs = between(null, [l1('S', 0, 3), l1('H', 4, 7)], Q);
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeHoldSummaryIds: ['H'] } });
    assert.deepEqual(plan.partnered, []);
    assert.deepEqual(plan.strandedLeft, [{ kind: 'stranded', id: 'S', level: 1, leaves: 4, span: { first: 'm-0', last: 'm-3' }, reason: 'no neighbour to free' }]);
  });

  test('rebuild reads a neighbour whose parent pointer names a summary the store lacks as unparented, as the strategy\'s loader does', () => {
    const ghosts = Array.from({ length: 2 }, (_, i) => l1(`G${i}`, i * 4, i * 4 + 3, 'ghost'));
    const Q = tower('Q', 12, 1, 6);
    const inputs = between(null, [...ghosts, l1('S', 8, 11)], Q);
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered, []);
    assert.deepEqual(plan.strandedLeft, []);
    assert.deepEqual(plan.dissolvedForRebuild, []);
  });

  test('rebuild gives a lone tower top it dissolves a partner too, when its run would re-fold into one summary alone', () => {
    const P = tower('P', 0, 2, 2);
    const T = tower('T', 16, 1, 2);
    const Q = tower('Q', 28, 2, 2);
    const N = tower('N', 44, 0, 1);
    const parts = [P, T, Q, N];
    const summaries = [...parts.flatMap((x) => x.summaries), l1('x', 24, 27)];
    const records = [...parts.flatMap((x) => x.records), rec('c-x', 24, 27, 'x')];
    const inputs = { summaries, records, messages: msgs(48) };
    assert.deepEqual(strandedInStore(inputs).map((x) => x.id), ['x', 'P']);
    assert.deepEqual(strandedInStore(inputs, { speculativeProduction: false }).map((x) => x.id), ['x'], 'without speculative production the merge check reads L1 and L2 only');
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['stranded', 'x', 'T'], ['refolded', 'm-16..m-27', 'P']]);
    assert.deepEqual(plan.strandedLeft, []);
    assert.deepEqual(plan.dissolvedForRebuild.map((d) => d.id).sort(), ['P', 'T']);
    const after = new Map(plan.result.summaries.map((s) => [s.id, s] as const));
    assert.ok(!after.has('T') && !after.has('P'));
    for (const id of ['T.0', 'T.1', 'P.0', 'P.1', 'x']) {
      const s = after.get(id);
      assert.ok(s, `${id} stands`);
      assert.equal(s.mergedInto ?? s.parentId, undefined, `${id} stands unparented`);
    }
    assert.ok(after.has('Q'), 'Q stands');
    assert.equal(after.get('Q')!.mergedInto, undefined, 'Q stands as it was');
  });

  test('rebuild gives a partner to the summary a re-fold makes alone at a threshold of two, where three merge into one', () => {
    const P = tower('P', 0, 2, 2);
    const T = tower('T', 16, 1, 2);
    const Q = tower('Q', 28, 2, 2);
    const N = tower('N', 44, 0, 1);
    const parts = [P, T, Q, N];
    const inputs = { summaries: [...parts.flatMap((x) => x.summaries), l1('x', 24, 27)], records: [...parts.flatMap((x) => x.records), rec('c-x', 24, 27, 'x')], messages: msgs(48) };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 2 } });
    assert.deepEqual(plan.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['stranded', 'x', 'T'], ['refolded', 'm-16..m-27', 'P']]);
    assert.deepEqual(plan.strandedLeft, []);
  });

  test('rebuild gives a partner to a tower top the re-fold makes again when the tower it dissolved was more than one summary tall', () => {
    const P = tower('P', 0, 2, 2);
    const Q = tower('Q', 20, 3, 2);
    const N = tower('N', 52, 0, 1);
    const parts = [P, Q, N];
    const inputs = { summaries: [...parts.flatMap((x) => x.summaries), l1('x', 16, 19)], records: [...parts.flatMap((x) => x.records), rec('c-x', 16, 19, 'x')], messages: msgs(56) };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['stranded', 'x', 'P.1'], ['refolded', 'm-0..m-19', 'Q']]);
    assert.deepEqual(plan.strandedLeft, []);
  });

  test('rebuild looks for the re-folded summary\'s partner beside the whole span it will cover, past the stray it took in', () => {
    const T = tower('T', 0, 1, 2);
    const Q = tower('Q', 12, 2, 2);
    const N = tower('N', 28, 0, 1);
    const parts = [T, Q, N];
    const inputs = { summaries: [...parts.flatMap((x) => x.summaries), l1('x', 8, 11)], records: [...parts.flatMap((x) => x.records), rec('c-x', 8, 11, 'x')], messages: msgs(32) };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['stranded', 'x', 'T'], ['refolded', 'm-0..m-11', 'Q']]);
    assert.deepEqual(plan.strandedLeft, []);
  });

  test('rebuild frees no tower whose summaries, freed, are too wide to merge with the stray, though the stray would then be its level\'s newest', () => {
    const S = l1('S', 0, 3);
    const P = [l1('P.0', 4, 19, 'P'), l1('P.1', 20, 35, 'P'), up('P', 2, ['P.0', 'P.1'], 4, 35)];
    const inputs = { summaries: [S, ...P], records: [rec('c-S', 0, 3, 'S'), rec('c-P.0', 4, 19, 'P.0'), rec('c-P.1', 20, 35, 'P.1')], messages: msgs(36) };
    assert.deepEqual(strandedInStore(inputs, { mergeMaxSourceSpanMessages: 10 }), [], 'premise: the runtime reads S as the newest');
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeMaxSourceSpanMessages: 10 } });
    assert.deepEqual(plan.partnered, []);
    assert.deepEqual(plan.strandedLeft.map((x) => [x.id, x.reason]), [['S', 'no neighbour to free']]);
    assert.deepEqual(plan.dissolvedForRebuild, []);
  });

  test('rebuild reads a side as partnering a stray only where what stands above holds the stray\'s messages, not where a crossed summary\'s range spans them', () => {
    const summaries = [
      l1('c0', 0, 3, 'C'), l1('c1', 20, 23, 'C'), up('C', 2, ['c0', 'c1'], 0, 23),
      l1('p0', 4, 5, 'P'), l1('p1', 6, 7, 'P'), up('P', 2, ['p0', 'p1'], 4, 7),
      l1('S', 8, 11),
      l1('r0', 12, 15, 'R'), l1('r1', 16, 19, 'R'), up('R', 2, ['r0', 'r1'], 12, 19),
      l1('N', 24, 27),
    ];
    const records = summaries.filter((x) => x.level === 1).map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(28) }, { mode: 'rebuild', rebuildSince: 'm-8', runs: { mergeHoldSummaryIds: ['r0'] } });
    assert.ok(plan.before.some((c) => c.id === 'C'), 'premise: C is crossed');
    assert.ok(plan.strandedLeft.some((x) => x.id === 'S'), 'premise: S is a stray the planner tried to partner');
    assert.ok(!plan.dissolvedForRebuild.some((d) => d.id === 'R'), JSON.stringify(plan.dissolvedForRebuild));
    assert.ok(!plan.partnered.some((x) => x.id === 'S'), JSON.stringify(plan.partnered));
  });

  test('rebuild reads no side as partnering a stray that a crossed summary\'s range spans without holding, where freeing it leaves the stray its level\'s newest', () => {
    const summaries = [
      l1('c0', 0, 3, 'C'), l1('h', 4, 7), l1('S', 8, 11),
      l1('r0', 12, 27, 'R'), l1('r1', 28, 43, 'R'), up('R', 2, ['r0', 'r1'], 12, 43),
      l1('c1', 44, 47, 'C'), up('C', 2, ['c0', 'c1'], 0, 47),
    ];
    const records = summaries.filter((x) => x.level === 1).map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(48) }, { mode: 'rebuild', rebuildSince: 'm-8', runs: { mergeHoldSummaryIds: ['h'], mergeMaxSourceSpanMessages: 10 } });
    assert.ok(plan.strandedLeft.some((x) => x.id === 'S'), JSON.stringify([plan.partnered, plan.strandedLeft]));
    assert.ok(!plan.dissolvedForRebuild.some((d) => d.id === 'R'), JSON.stringify(plan.dissolvedForRebuild));
  });

  test('rebuild reads a side as partnering a stray by its run only where the stray\'s own run holds another summary', () => {
    const summaries = [
      l1('y0', 0, 1, 'Y'), l1('y1', 2, 3, 'Y'), up('Y', 2, ['y0', 'y1'], 0, 5),
      l1('s0', 4, 4, 'S'), l1('s1', 5, 5, 'S'), up('S', 2, ['s0', 's1'], 4, 5),
      l1('a0', 6, 13, 'Q0'), l1('a1', 14, 21, 'Q0'), up('Q0', 2, ['a0', 'a1'], 6, 21, 'P'),
      l1('b0', 22, 29, 'Q1'), l1('b1', 30, 37, 'Q1'), up('Q1', 2, ['b0', 'b1'], 22, 37, 'P'),
      up('P', 3, ['Q0', 'Q1'], 6, 37),
    ];
    const records = summaries.filter((x) => x.level === 1).map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(38) }, { mode: 'rebuild', runs: { mergeThreshold: 2, mergeMaxSourceSpanMessages: 10 } });
    assert.ok(plan.strandedLeft.some((x) => x.id === 'S'), 'premise: S is a stray the planner tried to partner');
    assert.ok(!plan.dissolvedForRebuild.some((d) => d.id === 'P'), JSON.stringify(plan.dissolvedForRebuild));
    assert.ok(!plan.partnered.some((x) => x.id === 'S'), JSON.stringify(plan.partnered));
  });

  test('settles its own store before the write, so a record copy naming an L1 it removes is released, and says so', () => {
    const summaries = [l1('L1-4', 0, 3), l1('L1-5', 4, 7), l1('L1-6', 8, 11)];
    const records = [rec('c-7', 0, 3, 'L1-4'), rec('c-7', 0, 3, 'L1-4'), rec('c-8', 4, 7, 'L1-5'), rec('c-9', 8, 11, 'L1-6')];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(12) }, { mode: 'compact', releaseHead: 'all', releaseHeadLimit: 4 });
    assert.ok(!plan.result.summaries.some((x) => x.id === 'L1-4'), 'premise: the head release removes L1-4');
    assert.ok(!plan.result.records.some((r) => r.compressed && r.summaryId === 'L1-4'), JSON.stringify(plan.result.records));
  });

  test('rebuild projects a pending chunk over the messages of its record that still stand, and no pending L1 where a stored L1 holds exactly them', () => {
    const P = tower('P', 0, 1, 2);
    const T = tower('T', 16, 2, 2);
    const N = tower('N', 32, 0, 1);
    const base = { summaries: [...P.summaries, l1('x', 8, 11), ...T.summaries, ...N.summaries], messages: msgs(36) };
    const records = [...P.records, rec('c-x', 8, 11, 'x'), ...T.records, ...N.records];
    const withGone = { ...rec('c-p', 12, 15), sourceIds: ['m-gone', ...ids(12, 15)] };
    const plan = planTopologyRepair({ ...base, records: [...records, withGone] }, { mode: 'rebuild' });
    assert.deepEqual([plan.partnered, plan.dissolvedForRebuild], [[], []], 'x merges with the chunk\'s L1 to come');
    const dup = rec('c-dup', 8, 11);
    const without = planTopologyRepair({ ...base, records }, { mode: 'rebuild' });
    const with_ = planTopologyRepair({ ...base, records: [...records, dup] }, { mode: 'rebuild' });
    assert.deepEqual(with_.partnered, without.partnered);
    assert.deepEqual(with_.strandedLeft, without.strandedLeft);
    assert.ok([...without.partnered, ...without.strandedLeft].some((s) => s.id === 'x'), 'premise: with no pending chunk beside it, x is a stray');
    for (const covered of [rec('c-part', 10, 13), rec('c-sub', 8, 9)]) {
      const plan2 = planTopologyRepair({ ...base, records: [...records, covered] }, { mode: 'rebuild' });
      assert.deepEqual([plan2.partnered, plan2.strandedLeft], [without.partnered, without.strandedLeft], covered.id);
    }
  });

  test('rebuild reads a stray above L1 as partnered by where its leaves stand, though its stored range is narrower', () => {
    const P = tower('P', 0, 2, 2);
    const T = tower('T', 24, 2, 2);
    const N = tower('N', 40, 0, 1);
    const S = [l1('s0', 16, 19, 'S'), l1('s1', 20, 23, 'S'), up('S', 2, ['s0', 's1'], 16, 19)];
    const summaries = [...P.summaries, ...S, ...T.summaries, ...N.summaries];
    const records = [...P.records, rec('c-s0', 16, 19, 's0'), rec('c-s1', 20, 23, 's1'), ...T.records, ...N.records];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(44) }, { mode: 'rebuild' });
    assert.ok(plan.partnered.some((x) => x.id === 'S'), JSON.stringify([plan.partnered, plan.strandedLeft, plan.rangeChanges]));
  });

  test('rebuild projects one L1 where two pending records share a message, as the drain compresses the first and refuses the second', () => {
    const P = tower('P', 0, 1, 2);
    const T = tower('T', 18, 2, 2);
    const N = tower('N', 34, 0, 1);
    const base = { summaries: [...P.summaries, l1('x', 8, 11), ...T.summaries, ...N.summaries], messages: msgs(38) };
    const records = [...P.records, rec('c-x', 8, 11, 'x'), rec('c-p', 12, 15), rec('c-q', 14, 17), ...T.records, ...N.records];
    const both = planTopologyRepair({ ...base, records }, { mode: 'rebuild' });
    const first = planTopologyRepair({ ...base, records: records.filter((r) => r.id !== 'c-q') }, { mode: 'rebuild' });
    assert.deepEqual([both.partnered, both.strandedLeft], [first.partnered, first.strandedLeft]);
  });

  test('rebuild reads a stray as partnered when the summaries above its level hold the messages it holds, though its range spans one it doesn\'t', () => {
    const P = tower('P', 0, 1, 2);
    const T = tower('T', 13, 2, 2);
    const N = tower('N', 29, 0, 1);
    const S: RepairSummary = { ...l1('S', 8, 12), sourceIds: [...ids(8, 9), ...ids(11, 12)] };
    const summaries = [...P.summaries, S, ...T.summaries, ...N.summaries];
    const records = [...P.records, { ...rec('c-S', 8, 12, 'S'), sourceIds: S.sourceIds }, ...T.records, ...N.records];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(33) }, { mode: 'rebuild' });
    assert.equal(plan.partnered.find((x) => x.id === 'S')?.dissolved, 'P', JSON.stringify([plan.partnered, plan.strandedLeft]));
  });

  test('rebuild passes over a side whose freed neighbour stays held, and frees the other', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 12, 1, 3);
    const N = tower('N', 24, 0, 1);
    const parts = [P, Q, N];
    const inputs = { summaries: [...parts.flatMap((x) => x.summaries), l1('x', 8, 11)], records: [...parts.flatMap((x) => x.records), rec('c-x', 8, 11, 'x')], messages: msgs(28) };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeHoldSummaryIds: ['P.1'] } });
    assert.deepEqual(plan.partnered.map((x) => [x.id, x.dissolved]), [['x', 'Q']]);
    assert.deepEqual(plan.strandedLeft, [], 'with Q gone, P is the newest L2, which waits to grow');
  });

  test('rebuild lists every stray it can\'t partner, ten thousand and more', () => {
    const n = 10_002;
    const summaries = Array.from({ length: n }, (_, i) => l1(`s${i}`, 2 * i, 2 * i));
    const plan = planTopologyRepair({ summaries, records: [], messages: msgs(2 * n) }, { mode: 'rebuild' });
    assert.equal(plan.strandedLeft.length, n - 1);
    assert.ok(plan.strandedLeft.every((x) => x.reason === 'no neighbour to free'));
  });

  test('rebuild reads a lone L3 beside L2s that will merge into an L3 next to it as no stray, and dissolves nothing', () => {
    const T = tower('T', 0, 2, 2);
    const R0 = tower('R0', 16, 1, 2);
    const R1 = tower('R1', 24, 1, 2);
    const U = tower('U', 32, 3, 2);
    const N = tower('N', 64, 0, 1);
    const parts = [T, R0, R1, U, N];
    const inputs = { summaries: parts.flatMap((x) => x.summaries), records: parts.flatMap((x) => x.records), messages: msgs(68) };
    assert.deepEqual(strandedInStore(inputs), []);
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(plan.partnered, []);
    assert.deepEqual(plan.dissolvedForRebuild, []);
    const lone = [T, R0, tower('U', 24, 3, 2), tower('N', 56, 0, 1)];
    const loneInputs = { summaries: lone.flatMap((x) => x.summaries), records: lone.flatMap((x) => x.records), messages: msgs(60) };
    assert.deepEqual(strandedInStore(loneInputs), []);
    const lonePlan = planTopologyRepair(loneInputs, { mode: 'rebuild' });
    assert.deepEqual(lonePlan.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['stranded', 'R0', 'T'], ['refolded', 'm-0..m-23', 'U']]);
    assert.deepEqual(lonePlan.strandedLeft, []);
  });

  test('rebuild lists what the compact repair of an older crossed summary leaves alone, and stops listing what it joins', () => {
    const L = (id: string, first: number, parent?: string) => l1(id, first, first + 3, parent);
    const summaries = [
      L('c0', 0, 'C'), L('c1', 4, 'C'), L('d0', 8, 'D'), L('d1', 12, 'D'), L('h', 16), L('c2', 20, 'C'), L('k', 24),
      L('e0', 28, 'E'), L('e1', 32, 'E'), L('n', 36),
      up('C', 2, ['c0', 'c1', 'c2'], 0, 23), up('D', 2, ['d0', 'd1'], 8, 15), up('E', 2, ['e0', 'e1'], 28, 35),
    ];
    const records = summaries.filter((s) => s.level === 1).map((s) => rec(`c-${s.id}`, Number(s.sourceRange.first.slice(2)), Number(s.sourceRange.last.slice(2)), s.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(40) }, { mode: 'rebuild', rebuildSince: 'm-20', runs: { mergeHoldSummaryIds: ['h', 'k'] } });
    assert.deepEqual(plan.detached.map((x) => x.id), ['c2'], 'premise: the compact repair detaches c2');
    assert.deepEqual(plan.strandedLeft.map((x) => [x.id, x.reason]), [['c2', 'left by the compact repair']]);
  });

  test('the planner places no message the listing lacks, as the strategy builds its chunks from the listing', () => {
    const ghost: RepairSummary = { ...l1('g', 0, 0), sourceIds: ['gone'], sourceRange: { first: 'gone', last: 'gone' } };
    const inputs = {
      summaries: [l1('x', 0, 3), ghost],
      records: [rec('c-x', 0, 3, 'x'), { id: 'c-g', sourceIds: ['gone'], compressed: true, summaryId: 'g' }],
      messages: msgs(5),
    };
    assert.deepEqual(strandedInStore(inputs), [], 'g has no place, so it ends no run, and x is the newest');
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual([plan.partnered, plan.strandedLeft], [[], []], 'the planner reads it the same way, and partners nothing');
  });

  test('lists the sources of a stored queued merge with a held source, as the runtime does', () => {
    const P = tower('P', 0, 1, 2);
    const T = tower('T', 16, 2, 2);
    const N = tower('N', 32, 0, 1);
    const inputs = {
      summaries: [...P.summaries, l1('lone', 8, 11), l1('q', 12, 15), ...T.summaries, ...N.summaries],
      records: [...P.records, rec('c-lone', 8, 11, 'lone'), rec('c-q', 12, 15, 'q'), ...T.records, ...N.records],
      messages: msgs(36), mergeQueue: [{ level: 2, sourceIds: ['lone', 'q'] }],
    };
    assert.deepEqual(strandedInStore(inputs, { mergeHoldSummaryIds: ['q'] }), [{ id: 'lone', level: 1 }]);
  });

  test('releases a compressed chunk record whose L1 the settling drops, as the loader does, and says so', () => {
    const P = tower('P', 0, 1, 2);
    const N = tower('N', 12, 0, 1);
    const inputs = { summaries: [...P.summaries, { ...l1('x', 8, 11), content: '' }, ...N.summaries], records: [...P.records, rec('c-x', 8, 11, 'x'), ...N.records], messages: msgs(16) };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.equal(plan.settled.releasedRecords, 1);
    const x = plan.result.records.find((r) => r.id === 'c-x');
    assert.deepEqual([x?.compressed, x?.summaryId], [false, undefined]);
  });

  test('the planner settles summaries over the chunk records the loader reads, skipping one with no id', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 12, 1, 2);
    const N = tower('N', 20, 0, 1);
    const records = [...P.records, rec('c-x', 8, 11, 'x'), ...Q.records, ...N.records];
    const inputs = { summaries: [...P.summaries, l1('x', 8, 11), ...Q.summaries, ...N.summaries], records, messages: msgs(24) };
    const odd = [{ ...rec('c-odd', 0, 3, 'x'), id: undefined }] as unknown as RepairRecord[];
    const sourceless = { ...l1('x', 8, 11) } as Partial<RepairSummary>;
    delete sourceless.sourceIds;
    const withOdd = { ...inputs, summaries: inputs.summaries.map((x) => (x.id === 'x' ? sourceless as RepairSummary : x)), records: [...odd, ...records] };
    assert.deepEqual(strandedInStore(withOdd), strandedInStore(inputs));
    assert.deepEqual(planTopologyRepair(withOdd, { mode: 'rebuild' }).partnered, planTopologyRepair(inputs, { mode: 'rebuild' }).partnered);
  });

  test('the planner reads stored summaries as the loader keeps them, so one it drops is no stray', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 12, 1, 2);
    const N = tower('N', 20, 0, 1);
    const x = { ...l1('x', 8, 11), content: '' };
    const inputs = { summaries: [...P.summaries, x, x, ...Q.summaries, ...N.summaries], records: [...P.records, rec('c-x', 8, 11, 'x'), ...Q.records, ...N.records], messages: msgs(24) };
    assert.deepEqual(strandedInStore(inputs).map((s) => s.id), ['P']);
    const plan = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.ok(![...plan.partnered, ...plan.strandedLeft].some((e) => e.id === 'x'), JSON.stringify(plan.partnered));
    const read = { ...inputs, summaries: [...P.summaries, { ...x, content: 's x' }, ...Q.summaries, ...N.summaries] };
    assert.deepEqual(strandedInStore(read).map((s) => s.id), ['x', 'P']);
    assert.ok(planTopologyRepair(read, { mode: 'rebuild' }).partnered.some((e) => e.id === 'x'));
  });

  test('rebuild lands each queued merge that can still run before it re-folds, and partners what that landing leaves alone', () => {
    const T = tower('T', 0, 2, 2);
    const Q = tower('Q', 24, 2, 2);
    const N = tower('N', 40, 0, 1);
    const parts = [T, Q, N];
    const inputs = {
      summaries: [...parts.flatMap((x) => x.summaries), l1('x0', 16, 19), l1('x1', 20, 23)],
      records: [...parts.flatMap((x) => x.records), rec('c-x0', 16, 19, 'x0'), rec('c-x1', 20, 23, 'x1')],
      messages: msgs(44), mergeQueue: [{ level: 2, sourceIds: ['x0', 'x1'] }],
    };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 2 } });
    assert.deepEqual(plan.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['refolded', 'm-16..m-23', 'T']]);
    assert.deepEqual(plan.strandedLeft, []);
    const held = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 2, mergeHoldSummaryIds: ['x1'] } });
    assert.deepEqual(held.partnered.map((x) => [x.kind, x.id, x.dissolved]), [['stranded', 'x0', 'T.1']]);
  });

  test('rebuild lands the queued merges in queue order, each checked once those before it have landed', () => {
    const T = tower('T', 0, 2, 2);
    const Q = tower('Q', 28, 2, 2);
    const N = tower('N', 44, 0, 1);
    const parts = [T, Q, N];
    const named = (queue: Array<{ level: number; sourceIds: string[] }>) => {
      const plan = planTopologyRepair({
        summaries: [...parts.flatMap((x) => x.summaries), l1('a', 16, 19), l1('b', 20, 23), l1('c', 24, 27)],
        records: [...parts.flatMap((x) => x.records), rec('c-a', 16, 19, 'a'), rec('c-b', 20, 23, 'b'), rec('c-c', 24, 27, 'c')],
        messages: msgs(48), mergeQueue: queue,
      }, { mode: 'rebuild', runs: { mergeThreshold: 2 } });
      return [...plan.partnered, ...plan.strandedLeft].map((x) => x.id);
    };
    const forward = named([{ level: 2, sourceIds: ['a', 'b'] }, { level: 2, sourceIds: ['b', 'c'] }]);
    assert.ok(forward.includes('c') && !forward.includes('a'), `[a, b] lands, and [b, c] can't once b has a parent: c stands alone (${forward})`);
    const reversed = named([{ level: 2, sourceIds: ['b', 'c'] }, { level: 2, sourceIds: ['a', 'b'] }]);
    assert.ok(reversed.includes('a') && !reversed.includes('c'), `[b, c] lands first: a stands alone (${reversed})`);
  });

  test('rebuild ends for a threshold below 2 or given as undefined, which takes the default', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 12, 1, 3);
    const N = tower('N', 24, 0, 1);
    const parts = [P, Q, N];
    const inputs = { summaries: [...parts.flatMap((x) => x.summaries), l1('x', 8, 11)], records: [...parts.flatMap((x) => x.records), rec('c-x', 8, 11, 'x')], messages: msgs(28) };
    const one = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 1 } });
    assert.deepEqual(one.partnered, []);
    assert.deepEqual(one.dissolvedForRebuild, []);
    assert.deepEqual(one.strandedLeft.map((x) => [x.id, x.reason]), [['x', 'no merge forms below a threshold of 2'], ['P', 'no merge forms below a threshold of 2']]);
    const zero = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 0 } });
    assert.deepEqual([zero.partnered, zero.dissolvedForRebuild, zero.strandedLeft.map((x) => x.reason)], [[], [], ['no merge forms below a threshold of 2', 'no merge forms below a threshold of 2']], 'and at 0');
    const given = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: undefined } });
    const defaults = planTopologyRepair(inputs, { mode: 'rebuild' });
    assert.deepEqual(given.partnered, defaults.partnered);
    assert.deepEqual(given.strandedLeft, defaults.strandedLeft);
  });

  test('reads a summary stored without a level as no part of any run, as the merge check offers each level\'s own', () => {
    const s1 = { ...l1('s1', 4, 8) } as Partial<RepairSummary>;
    delete s1.level;
    const inputs = { summaries: [l1('s0', 0, 3), s1 as RepairSummary, l1('s2', 10, 13)], records: [], messages: msgs(14) };
    assert.deepEqual(strandedInStore(inputs), [{ id: 's0', level: 1 }]);
  });

  test('a queued merge below a threshold of 2 still lands in the projection, since tick runs it whatever the threshold', () => {
    const T = tower('T', 0, 2, 2);
    const Q = tower('Q', 24, 2, 2);
    const N = tower('N', 40, 0, 1);
    const parts = [T, Q, N];
    const plan = planTopologyRepair({
      summaries: [...parts.flatMap((x) => x.summaries), l1('x0', 16, 19), l1('x1', 20, 23)],
      records: [...parts.flatMap((x) => x.records), rec('c-x0', 16, 19, 'x0'), rec('c-x1', 20, 23, 'x1')],
      messages: msgs(44), mergeQueue: [{ level: 2, sourceIds: ['x0', 'x1'] }],
    }, { mode: 'rebuild', runs: { mergeThreshold: 1 } });
    assert.deepEqual(plan.strandedLeft.map((x) => [x.kind, x.id, x.reason]), [
      ['refolded', 'm-16..m-23', 'no merge forms below a threshold of 2'], ['stranded', 'T', 'no merge forms below a threshold of 2'],
    ]);
    assert.deepEqual(plan.dissolvedForRebuild, []);
  });

  test('reads the last of the merge-quarantine records stored under one key, as the strategy\'s loader does', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 16, 1, 2);
    const N = tower('N', 24, 0, 1);
    const parts = [P, Q, N];
    const base = { summaries: [...parts.flatMap((x) => x.summaries), l1('S', 8, 11), l1('H', 12, 15)], records: [...parts.flatMap((x) => x.records), rec('c-S', 8, 11, 'S'), rec('c-H', 12, 15, 'H')], messages: msgs(28) };
    const refusal = { key: 'k', level: 2, sourceIds: ['S', 'H'], lastOutcome: 'refusal' };
    const topology = { key: 'k', level: 2, sourceIds: ['S', 'H'], lastOutcome: 'topology_violation' };
    const read = (mergeQuarantine: Array<typeof refusal>) => {
      const plan = planTopologyRepair({ ...base, mergeQuarantine }, { mode: 'rebuild' });
      return { listed: strandedInStore({ ...base, mergeQuarantine }).map((x) => x.id), left: plan.strandedLeft.map((x) => [x.id, x.reason]), partnered: plan.partnered };
    };
    assert.deepEqual(read([topology, refusal]), { listed: ['P'], left: [['P', 'no neighbour to free']], partnered: [] }, 'the refusal, read last, holds S and H, so they never merge beside P');
    assert.deepEqual(read([refusal, topology]), { listed: ['P'], left: [], partnered: [] }, 'the topology record, read last, holds nothing, so S and H merge beside P in the re-fold');
  });

  test('rebuild names the cutoff for a stray only where a side it keeps would have partnered it', () => {
    const P = tower('P', 0, 1, 2);
    const Q = tower('Q', 12, 1, 3);
    const N = tower('N', 24, 0, 1);
    const parts = [P, Q, N];
    const inputs = { summaries: [...parts.flatMap((x) => x.summaries), l1('x', 8, 11)], records: [...parts.flatMap((x) => x.records), rec('c-x', 8, 11, 'x')], messages: msgs(28) };
    const plan = planTopologyRepair(inputs, { mode: 'rebuild', rebuildSince: 'm-4', runs: { mergeHoldSummaryIds: ['P.1', 'Q.0'] } });
    assert.deepEqual(plan.strandedLeft.find((x) => x.id === 'x')?.reason, 'no neighbour to free');
  });

  test('a clean store plans nothing', () => {
    const summaries = [l1('L1-0', 0, 9, 'L2'), l1('L1-1', 10, 19, 'L2'), up('L2', 2, ['L1-0', 'L1-1'], 0, 19)];
    const records = [rec('c-0', 0, 9, 'L1-0'), rec('c-1', 10, 19, 'L1-1')];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(30) });
    assert.equal(plan.before.length, 0);
    assert.equal(plan.detached.length + plan.splitL1.length + plan.dissolved.length + plan.rangeChanges.length, 0);
  });
});

const STRAY_MEMBRANE = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
const STRAY_CFG = { adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false };

async function strayStore(path: string): Promise<string[]> {
  const seed = new AutobiographicalStrategy(STRAY_CFG);
  const manager = await ContextManager.open({ path, strategy: seed, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
  const m: string[] = [];
  for (let i = 0; i < 40; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
  const one = (id: string, at: number, mergedInto?: string): SummaryEntry => ({
    id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds: [m[at]!, m[at + 1]!], sourceRange: { first: m[at]!, last: m[at + 1]! }, created: 1, ...(mergedInto ? { mergedInto } : {}),
  } as SummaryEntry);
  const l1s = [
    ...Array.from({ length: 6 }, (_, i) => one(`p${i}`, i * 2, 'P')), one('S', 12), one('H', 14),
    ...Array.from({ length: 6 }, (_, i) => one(`q${i}`, 16 + i * 2, 'Q')), one('n', 28),
  ];
  const over = (id: string, from: number, to: number, src: string[]): SummaryEntry => ({
    id, level: 2, content: `s ${id}`, tokens: 50, sourceLevel: 1, sourceIds: src, sourceRange: { first: m[from]!, last: m[to]! }, created: 1,
  } as SummaryEntry);
  const summaries = [...l1s, over('P', 0, 11, ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']), over('Q', 16, 27, ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'])];
  const records = l1s.map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id }));
  const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void }; summariesStateId: string; chunksStateId: string };
  internals.store.setStateJson(internals.summariesStateId, summaries);
  internals.store.setStateJson(internals.chunksStateId, records);
  manager.close();
  return m;
}

describe('the repair CLI on a store with a stray and no crossing', () => {
  const STORE = './test-topology-repair-cli-store';
  const CLI = join(process.cwd(), 'dist/scripts/repair-topology.js');
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', ...args], { encoding: 'utf8' });

  test('plans with the run settings it is given, prints them, and applies a rebuild that only partners a stray', async () => {
    const m = await strayStore(STORE);

    assert.match(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout, /--merge-hold <id,id,…>\s+mergeHoldSummaryIds/);

    const clean = cli('--mode', 'rebuild');
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stderr, /store is clean; nothing to do/, 'with no hold, S and H are a run and P waits on it');

    const dry = cli('--mode', 'rebuild', '--merge-hold', 'H');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\nrun settings the stray rule read: mergeThreshold 6, mergeMaxSourceSpanMessages 1500, mergeHoldSummaryIds H, speculativeProduction on /);
    assert.ok(dry.stdout.includes(`\n  partner stranded L1 S (2 leaves ${m[12]}..${m[13]}): dissolve P and what stands above\n`), dry.stdout);
    assert.match(dry.stderr, /DRY RUN/);

    const applied = cli('--mode', 'rebuild', '--merge-hold', 'H', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stderr, /APPLIED \(rebuild\): 1 summaries dissolved/);
    assert.match(applied.stderr, /VERIFIED/);
    const reopened = new AutobiographicalStrategy(STRAY_CFG);
    const after = await ContextManager.open({ path: STORE, strategy: reopened, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
    try {
      const left = (reopened as unknown as { summaries: SummaryEntry[] }).summaries;
      assert.equal(left.find((s) => s.id === 'P'), undefined, 'P is dissolved');
      assert.equal(left.find((s) => s.id === 'p5')!.mergedInto, undefined, 'its L1s stand beside S');
    } finally { after.close(); }
  });
});

describe('a rebuild applied and drained', () => {
  const STORE = './test-topology-repair-drain-store';
  const CLI = join(process.cwd(), 'dist/scripts/repair-topology.js');
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);

  test('leaves listed just the strays its plan said it couldn\'t partner', async () => {
    await strayStore(STORE);
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild', '--merge-hold', 'H', '--json', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const plan = JSON.parse(applied.stdout) as { partnered: unknown[]; strandedLeft: Array<{ level: number; span: { first: string; last: string } }> };
    assert.ok(plan.partnered.length > 0, 'premise: the plan partners a stray');
    const strategy = new AutobiographicalStrategy({ ...STRAY_CFG, mergeHoldSummaryIds: ['H'], compressionModel: 'mock' } as never);
    const manager = await ContextManager.open({ path: STORE, strategy, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
    try {
      const lane = strategy as unknown as { mergeQueue: unknown[]; compressionQueue: unknown[]; summaries: SummaryEntry[] };
      for (let guard = 0; guard < 200 && (lane.mergeQueue.length > 0 || lane.compressionQueue.length > 0); guard++) await manager.tick();
      assert.equal(lane.mergeQueue.length + lane.compressionQueue.length, 0, 'premise: the merge and compression queues drained');
      const spanOf = (level: number, first: string, last: string) => `L${level} ${first}..${last}`;
      const listed = strategy.getStrandedSummaries().summaries!.map((x) => {
        const s = lane.summaries.find((y) => y.id === x.id)!;
        return spanOf(s.level, s.sourceRange.first, s.sourceRange.last);
      });
      assert.deepEqual(listed.sort(), plan.strandedLeft.map((x) => spanOf(x.level, x.span.first, x.span.last)).sort());
    } finally {
      manager.close();
    }
  });
});

async function fixtureStore(path: string, n: number, summaries: readonly RepairSummary[], records: readonly RepairRecord[]): Promise<void> {
  const seed = new AutobiographicalStrategy(STRAY_CFG);
  const manager = await ContextManager.open({ path, strategy: seed, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
  const m: string[] = [];
  for (let i = 0; i < n; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
  const real = (id: string): string => (/^m-\d+$/.test(id) ? m[Number(id.slice(2))]! : id);
  const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void }; summariesStateId: string; chunksStateId: string };
  internals.store.setStateJson(internals.summariesStateId, summaries.map((s) => ({
    ...s, content: `s ${s.id}`, tokens: 50, created: 1, sourceIds: s.sourceIds.map(real),
    sourceRange: { first: real(s.sourceRange.first), last: real(s.sourceRange.last) },
  })));
  internals.store.setStateJson(internals.chunksStateId, records.map((r) => ({ ...r, sourceIds: (r.sourceIds as string[]).map(real) })));
  manager.close();
}

describe('a rebuild drained bottom up', () => {
  const STORE = './test-topology-repair-bottom-up-store';
  const CLI = join(process.cwd(), 'dist/scripts/repair-topology.js');
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);
  class Drain extends AutobiographicalStrategy {
    protected override landsAsPlanned(): boolean { return true; }
  }
  const picksWaiting = (strategy: AutobiographicalStrategy): boolean => {
    const waiting = (strategy as unknown as { mergePicksWaiting: unknown }).mergePicksWaiting;
    assert.equal(typeof waiting, 'boolean', 'premise: the strategy says whether merge picks wait');
    return waiting as boolean;
  };
  type Plan = { partnered: Array<{ kind: string; dissolved: string }>; strandedLeft: unknown[] };

  async function rebuiltAndDrained(threshold: number, strategy: AutobiographicalStrategy, shape: 'narrow' | 'wide' | 'pending' = 'narrow'): Promise<{ first: Plan; second: Plan; listed: string[] }> {
    wipe();
    const wideP = (): ReturnType<typeof tower> => {
      const summaries: RepairSummary[] = [];
      const records: RepairRecord[] = [];
      const l2s = Array.from({ length: 6 }, (_, k) => {
        const kids = [0, 1].map((j) => { const at = k * 2 + j; records.push(rec(`c-P.${k}.${j}`, at, at, `P.${k}.${j}`)); return l1(`P.${k}.${j}`, at, at, `P.${k}`); });
        summaries.push(...kids);
        return up(`P.${k}`, 2, kids.map((c) => c.id), k * 2, k * 2 + 1, 'P');
      });
      summaries.push(...l2s, up('P', 3, l2s.map((c) => c.id), 0, 11));
      return { summaries, records, next: 12 };
    };
    const parts = shape === 'narrow'
      ? [tower('P', 0, 2, 2), tower('T', 16, 1, 2), tower('Q', 28, 2, 2), tower('N', 44, 0, 1)]
      : shape === 'wide'
        ? [wideP(), tower('T', 12, 1, 2), tower('Q', 24, 2, 6, 1), tower('N', 60, 0, 1)]
        : [tower('P', 0, 1, 2), tower('T', 16, 2, 2), tower('N', 32, 0, 1)];
    const xAt = shape === 'narrow' ? 24 : shape === 'wide' ? 20 : 8;
    const pending = shape === 'pending' ? [rec('c-p', 12, 15)] : [];
    await fixtureStore(STORE, shape === 'narrow' ? 48 : shape === 'wide' ? 64 : 36, [...parts.flatMap((x) => x.summaries), l1('x', xAt, xAt + 3)], [...parts.flatMap((x) => x.records), rec('c-x', xAt, xAt + 3, 'x'), ...pending]);
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--merge-threshold', String(threshold), '--mode', 'rebuild', '--json', ...args], { encoding: 'utf8' });
    const applied = cli('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    const manager = await ContextManager.open({ path: STORE, strategy, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
    let listed: string[] = [];
    try {
      const drained = (): boolean => {
        const progress = strategy.getProgressSnapshot();
        const debt = strategy.getCompressionDebt();
        return !progress.pending && progress.l1QueueLength === 0 && progress.mergeQueueLength === 0 && debt.pendingChunks === 0 &&
          debt.error === undefined && !picksWaiting(strategy);
      };
      for (let guard = 0; guard < 200 && !drained(); guard++) await manager.tick();
      assert.ok(drained(), 'premise: drained, by the drain script\'s rule');
    } finally {
      manager.close();
    }
    const resident = new AutobiographicalStrategy(config(threshold));
    const reopened = await ContextManager.open({ path: STORE, strategy: resident, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
    try {
      const read = resident.getStrandedSummaries().summaries;
      assert.ok(read, 'premise: the stray list was read');
      listed = read.map((x) => x.id);
    } finally {
      reopened.close();
    }
    const again = cli();
    assert.equal(again.status, 0, again.stderr);
    return { first: JSON.parse(applied.stdout) as Plan, second: JSON.parse(again.stdout) as Plan, listed };
  }
  const config = (threshold: number) => ({ ...STRAY_CFG, mergeThreshold: threshold, compressionModel: 'mock' } as never);

  test('frees no tower over a stale generation, so the drain leaves a store its resident opens', async () => {
    wipe();
    const summaries = [
      l1('T0', 0, 1), l1('T1.0', 2, 3, 'T1'), l1('T1.1', 4, 5, 'T1'), up('T1', 2, ['T1.0', 'T1.1'], 2, 5),
      l1('T2.0.0', 6, 8, 'T2.0'), l1('T2.0.1', 9, 11, 'T2.0'), up('T2.0', 2, ['T2.0.0', 'T2.0.1'], 6, 11, 'T2'),
      l1('T2.1.0', 12, 14, 'T2.1'), l1('T2.1.1', 15, 17, 'T2.1'), up('T2.1', 2, ['T2.1.0', 'T2.1.1'], 12, 17, 'T2'),
      up('T2', 3, ['T2.0', 'T2.1'], 6, 17),
      l1('s3', 18, 18), l1('s3old', 18, 18, 'Q3'), l1('Q3.0', 19, 19, 'Q3'), up('Q3', 2, ['s3old', 'Q3.0'], 18, 19),
      l1('N', 20, 23),
    ];
    const records = summaries.filter((x) => x.level === 1 && x.id !== 's3old')
      .map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    await fixtureStore(STORE, 24, summaries, records);
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--merge-threshold', '2', '--mode', 'rebuild', '--json', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const plan = JSON.parse(applied.stdout) as { dissolvedForRebuild: Array<{ id: string }>; strandedLeft: Array<{ id: string; reason: string; stale?: string[] }> };
    assert.ok(!plan.dissolvedForRebuild.some((d) => d.id === 'Q3'), JSON.stringify(plan.dissolvedForRebuild));
    const drain = new Drain(config(2));
    const manager = await ContextManager.open({ path: STORE, strategy: drain, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
    try {
      const drained = (): boolean => {
        const progress = drain.getProgressSnapshot();
        const debt = drain.getCompressionDebt();
        return !progress.pending && progress.l1QueueLength === 0 && progress.mergeQueueLength === 0 && debt.pendingChunks === 0 &&
          debt.error === undefined && !picksWaiting(drain);
      };
      for (let guard = 0; guard < 200 && !drained(); guard++) await manager.tick();
      assert.ok(drained(), 'premise: drained, by the drain script\'s rule');
    } finally {
      manager.close();
    }
    const resident = new AutobiographicalStrategy({ ...STRAY_CFG, mergeThreshold: 2, compressionModel: 'mock', topologyPolicy: 'reject' } as never);
    const reopened = await ContextManager.open({ path: STORE, strategy: resident, namespace: 'probe', membrane: STRAY_MEMBRANE as never });
    try {
      assert.deepEqual(resident.getStrandedSummaries().summaries?.map((x) => x.id).sort(), plan.strandedLeft.map((x) => x.id).sort());
    } finally {
      reopened.close();
    }
  });

  test('reads no side as partnering a stray that a stale generation\'s tower covers, where the stray stays listed', () => {
    const summaries = [
      l1('w0', 0, 15, 'W'), l1('w1', 16, 31, 'W'), up('W', 2, ['w0', 'w1'], 0, 31),
      l1('S', 32, 32), l1('s3old', 32, 32, 'Q3'), l1('Q3.0', 33, 33, 'Q3'), up('Q3', 2, ['s3old', 'Q3.0'], 32, 33), l1('N', 34, 37),
    ];
    const records = summaries.filter((x) => x.level === 1 && x.id !== 's3old')
      .map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(38) }, { mode: 'rebuild', runs: { mergeThreshold: 2, mergeMaxSourceSpanMessages: 10 } });
    assert.deepEqual(plan.dissolvedForRebuild, [], JSON.stringify(plan.partnered));
    assert.deepEqual(plan.strandedLeft.find((x) => x.id === 'S')?.stale, ['s3old'], JSON.stringify(plan.strandedLeft));
  });

  test('names the stale generation where the only side that would free a stray holds one', () => {
    const summaries = [l1('s3', 0, 0), l1('s3old', 0, 0, 'Q3'), l1('Q3.0', 1, 1, 'Q3'), up('Q3', 2, ['s3old', 'Q3.0'], 0, 1), l1('N', 2, 5)];
    const records = [rec('c-s3', 0, 0, 's3'), rec('c-Q3.0', 1, 1, 'Q3.0'), rec('c-N', 2, 5, 'N')];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(6) }, { mode: 'rebuild', runs: { mergeThreshold: 2 } });
    assert.deepEqual(plan.dissolvedForRebuild, []);
    const s3 = plan.strandedLeft.find((x) => x.id === 's3');
    assert.deepEqual([s3?.reason, s3?.stale], ['a neighbour\'s tower holds a stale generation', ['s3old']], JSON.stringify(plan.strandedLeft));
  });

  test('gives no partner to a stray that is a stale generation itself', () => {
    const summaries = [l1('s3old', 0, 0), l1('s3', 0, 0, 'Q3'), l1('Q3.0', 1, 1, 'Q3'), up('Q3', 2, ['s3', 'Q3.0'], 0, 1), l1('N', 2, 5)];
    const records = [rec('c-s3', 0, 0, 's3'), rec('c-Q3.0', 1, 1, 'Q3.0'), rec('c-N', 2, 5, 'N')];
    const plan = planTopologyRepair({ summaries, records, messages: msgs(6) }, { mode: 'rebuild', runs: { mergeThreshold: 2 } });
    assert.deepEqual(plan.dissolvedForRebuild, [], JSON.stringify(plan.partnered));
    const old = plan.strandedLeft.find((x) => x.id === 's3old');
    assert.deepEqual([old?.reason, old?.stale], ['a stale generation', ['s3old']], JSON.stringify(plan.strandedLeft));
  });

  test('frees no tower that holds a stale generation further down, where an L2 stray would partner with what it frees', () => {
    const summaries = [
      l1('s0', 0, 4, 'S'), l1('s1', 5, 9, 'S'), up('S', 2, ['s0', 's1'], 0, 9),
      l1('qold', 10, 11, 'Q'), l1('q', 12, 15, 'Q'), up('Q', 2, ['qold', 'q'], 10, 15, 'T'),
      l1('r0', 16, 18, 'R'), l1('r1', 19, 21, 'R'), up('R', 2, ['r0', 'r1'], 16, 21, 'T'),
      up('T', 3, ['Q', 'R'], 10, 21), l1('live', 10, 10), l1('N', 22, 25),
    ];
    const records = summaries.filter((x) => x.level === 1 && x.id !== 'qold')
      .map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(26) }, { mode: 'rebuild', runs: { mergeThreshold: 2, mergeHoldSummaryIds: ['live'] } });
    assert.ok(!plan.dissolvedForRebuild.some((d) => d.id === 'T'), JSON.stringify(plan.dissolvedForRebuild));
    const s = plan.strandedLeft.find((x) => x.id === 'S');
    assert.deepEqual([s?.reason, s?.stale], ['a neighbour\'s tower holds a stale generation', ['qold']], JSON.stringify(plan.strandedLeft));
  });

  test('frees no tower that holds a stale generation in a branch other than the neighbour\'s', () => {
    const summaries = [
      l1('s0', 0, 4, 'S'), l1('s1', 5, 9, 'S'), up('S', 2, ['s0', 's1'], 0, 9),
      l1('q0', 10, 12, 'Q'), l1('q1', 13, 15, 'Q'), up('Q', 2, ['q0', 'q1'], 10, 15, 'T'),
      l1('r', 16, 19, 'R'), l1('rold', 20, 21, 'R'), up('R', 2, ['r', 'rold'], 16, 21, 'T'),
      up('T', 3, ['Q', 'R'], 10, 21), l1('live', 21, 21), l1('N', 22, 25),
    ];
    const records = summaries.filter((x) => x.level === 1 && x.id !== 'rold')
      .map((x) => rec(`c-${x.id}`, Number(x.sourceRange.first.slice(2)), Number(x.sourceRange.last.slice(2)), x.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(26) }, { mode: 'rebuild', runs: { mergeThreshold: 2, mergeHoldSummaryIds: ['live'] } });
    assert.ok(!plan.dissolvedForRebuild.some((d) => d.id === 'T'), JSON.stringify(plan.dissolvedForRebuild));
    const s = plan.strandedLeft.find((x) => x.id === 'S');
    assert.deepEqual([s?.reason, s?.stale], ['a neighbour\'s tower holds a stale generation', ['rold']], JSON.stringify(plan.strandedLeft));
  });

  test('names no stale generation where freeing the tower that holds one would leave the stray alone all the same', () => {
    const summaries = [
      l1('x', 0, 0), l1('q0', 1, 16, 'Q'), l1('qold', 17, 17, 'Q'), up('Q', 2, ['q0', 'qold'], 1, 17), l1('live', 17, 17),
      l1('p0', 18, 19, 'P'), l1('p1', 20, 21, 'P'), up('P', 2, ['p0', 'p1'], 18, 21), l1('N', 22, 25),
    ];
    const records = summaries.filter((y) => y.level === 1 && y.id !== 'qold')
      .map((y) => rec(`c-${y.id}`, Number(y.sourceRange.first.slice(2)), Number(y.sourceRange.last.slice(2)), y.id));
    const plan = planTopologyRepair({ summaries, records, messages: msgs(26) }, { mode: 'rebuild', runs: { mergeThreshold: 2, mergeMaxSourceSpanMessages: 10, mergeHoldSummaryIds: ['live'] } });
    assert.deepEqual(plan.dissolvedForRebuild, []);
    const x = plan.strandedLeft.find((y) => y.id === 'x');
    assert.deepEqual([x?.reason, x?.stale], ['no neighbour to free', undefined], JSON.stringify(plan.strandedLeft));
  });

  for (const [threshold, shape] of [[2, 'narrow'], [6, 'narrow'], [6, 'wide']] as const) {
    test(`lands what the plan projected, so at a threshold of ${threshold}, with P over ${shape === 'wide' ? 'six' : 'two'} L2s, nothing is listed and a second rebuild finds nothing to partner`, async () => {
      const { first, second, listed } = await rebuiltAndDrained(threshold, new Drain(config(threshold)), shape);
      assert.deepEqual(first.partnered.map((x) => [x.kind, x.dissolved]), [['stranded', 'T'], ['refolded', 'P']]);
      assert.deepEqual(first.strandedLeft, []);
      assert.deepEqual(listed, [], 'the drained store lists nothing');
      assert.deepEqual([second.partnered, second.strandedLeft], [[], []]);
    });
  }

  test('projects a chunk recorded and not yet compressed as an L1 to come, so the L1 beside it is no stray: nothing is dissolved, and the drained store lists nothing', async () => {
    const { first, second, listed } = await rebuiltAndDrained(6, new Drain(config(6)), 'pending');
    assert.deepEqual([first.partnered, first.strandedLeft], [[], []], 'no tower is dissolved for x');
    assert.deepEqual(listed, [], 'the drained store lists nothing');
    assert.deepEqual([second.partnered, second.strandedLeft], [[], []]);
  });

  test('at a threshold of 2, a drain that queues every level at once merges P\'s L2s before the re-folded L2 lands, and leaves it alone', async () => {
    const { second } = await rebuiltAndDrained(2, new AutobiographicalStrategy(config(2)));
    const l2 = [...second.partnered, ...second.strandedLeft].filter((x) => (x as { level?: number }).level === 2);
    assert.equal(l2.length, 1, JSON.stringify(second));
  });
});

describe('an apply over a store holding summaries the loader drops', () => {
  const STORE = './test-topology-repair-keeps-store';
  const CLI = join(process.cwd(), 'dist/scripts/repair-topology.js');
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);
  type Stored = { id: string; mergedInto?: string | null; parentId?: string | null };
  const stored = (): Stored[] => {
    const store = JsStore.open({ path: STORE });
    try { return (store.getStateJson('probe/autobio:summaries') as Stored[] | null) ?? []; } finally { store.close(); }
  };

  async function competing(staleCopy: boolean, q = 'Q'): Promise<void> {
    wipe();
    const T = tower('T', 12, 2, 2);
    const N = tower('N', 28, 0, 1);
    const summaries = [
      l1('a', 0, 3, 'P'), l1('b', 4, 7, 'P'), up('P', 2, ['a', 'b'], 0, 7), up(q, 2, ['a', 'b'], 0, 7), l1('S', 8, 11),
      ...T.summaries, ...N.summaries, ...(staleCopy ? [{ ...l1('a', 0, 3), mergedInto: q, content: 's a, stale' }] : []),
    ];
    const records = [rec('c-a', 0, 3, 'a'), rec('c-b', 4, 7, 'b'), rec('c-S', 8, 11, 'S'), ...T.records, ...N.records];
    await fixtureStore(STORE, 32, summaries, records);
  }

  for (const staleCopy of [false, true]) {
    test(`writes the store as the loader keeps it with the plan's changes, so the plan holds after the open${staleCopy ? ', with a stale copy of a summary pointing to the dropped one' : ''}`, async () => {
      await competing(staleCopy);
      assert.equal(stored().filter((x) => x.id === 'Q').length, 1, 'premise: Q is stored');
      const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild', '--apply'], { encoding: 'utf8' });
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      assert.match(applied.stdout, /\n  partner stranded L1 S \(4 leaves [^)]+\): dissolve P and what stands above\n/, applied.stdout);
      assert.doesNotMatch(applied.stderr, /LOADER REPAIR/, applied.stderr);
      const after = stored();
      assert.deepEqual(after.filter((x) => ['P', 'Q'].includes(x.id)), [], 'P is dissolved, and Q, which the loader dropped, is gone');
      assert.deepEqual(after.filter((x) => x.id === 'a').length, 1, 'one copy of a');
      for (const id of ['a', 'b', 'S']) {
        const x = after.find((y) => y.id === id);
        assert.ok(x, `${id} stands`);
        assert.equal(x.mergedInto ?? x.parentId ?? undefined, undefined, `${id} stands unparented, as planned, for the drain to merge`);
      }
    });
  }

  test('writes a store whose only repair is the settling\'s, so --apply stores it and the open changes nothing', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9')]);
    assert.equal(stored().filter((x) => x.id === 'L1-7').length, 2, 'premise: stored twice');
    { const store = JsStore.open({ path: STORE }); try { store.setStateJson('probe/autobio:counter', 10); } finally { store.close(); } }
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /settling the store as the loader does: repaired summary state: removed 0 malformed entr\(ies\) and deduped 1;/, applied.stdout);
    assert.match(applied.stderr, /VERIFIED: .*the open changed nothing the repair wrote/, applied.stderr);
    assert.equal(stored().filter((x) => x.id === 'L1-7').length, 1);
  });

  test('settles its own store before the write, so the open after an apply over a doubled chunk record changes nothing', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-4', 0, 3), l1('L1-5', 4, 7), l1('L1-6', 8, 11)], [rec('c-7', 0, 3, 'L1-4'), rec('c-7', 0, 3, 'L1-4'), rec('c-8', 4, 7, 'L1-5'), rec('c-9', 8, 11, 'L1-6')]);
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--release-head=all', '--release-head-limit', '4', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.ok(!stored().some((x) => x.id === 'L1-4'), 'premise: the head release removed L1-4');
    assert.match(applied.stdout, /PLANNER FAULT: settled again before the write, the plan's own store is repaired 1 chunk record\(s\) with missing L1 summaries/, applied.stdout);
    assert.match(applied.stderr, /VERIFIED: .*the open changed nothing the repair wrote/, applied.stderr);
  });

  test('says in --json what settling the plan\'s own store once more changed', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-4', 0, 3), l1('L1-5', 4, 7), l1('L1-6', 8, 11)], [rec('c-7', 0, 3, 'L1-4'), rec('c-7', 0, 3, 'L1-4'), rec('c-8', 4, 7, 'L1-5'), rec('c-9', 8, 11, 'L1-6')]);
    const dry = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--release-head=all', '--release-head-limit', '4', '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(dry.stdout).resettled.releasedRecords, 1, dry.stdout + dry.stderr);
  });

  test('writes the summary-id counter alone where it trails the stored ids, and nothing else needs repair', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9')]);
    const state = () => { const store = JsStore.open({ path: STORE }); try { return JSON.stringify([store.getStateJson('probe/autobio:summaries'), store.getStateJson('probe/autobio:chunks')]); } finally { store.close(); } };
    const before = state();
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stderr, /VERIFIED/, applied.stderr);
    assert.equal(state(), before, 'the summaries and chunk records as they were');
    const store = JsStore.open({ path: STORE });
    try { assert.equal(store.getStateJson('probe/autobio:counter'), 10); } finally { store.close(); }
  });

  test('writes a store whose only repair is a chunk record the loader leaves out', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9'), { sourceIds: ids(0, 3), compressed: false } as never]);
    { const store = JsStore.open({ path: STORE }); try { store.setStateJson('probe/autobio:counter', 10); } finally { store.close(); } }
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stderr, /VERIFIED/, applied.stderr);
    const store = JsStore.open({ path: STORE });
    try { assert.equal((store.getStateJson('probe/autobio:chunks') as unknown[]).length, 3); } finally { store.close(); }
  });

  test('writes a plan whose only change is to resolutions', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9')]);
    const real = () => { const store = JsStore.open({ path: STORE }); try { return (store.getStateJson('probe/autobio:summaries') as Array<{ sourceIds: string[] }>)[0]!.sourceIds[0]!; } finally { store.close(); } };
    const leaf = real();
    { const store = JsStore.open({ path: STORE }); try { store.setStateJson('probe/autobio:counter', 10); store.setStateJson('probe/autobio:resolutions', { [leaf]: 3 }); } finally { store.close(); } }
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /resolutions 1 clamped/, applied.stdout);
    const store = JsStore.open({ path: STORE });
    try { assert.deepEqual(store.getStateJson('probe/autobio:resolutions'), { [leaf]: 1 }); } finally { store.close(); }
  });

  test('applies a store with L1s and no chunk records, and says the verifying open appended their chunk records', async () => {
    wipe();
    await fixtureStore(STORE, 16, [l1('L1-1', 0, 3), l1('L1-2', 4, 7), l1('L1-3', 8, 11), l1('L1-3', 8, 11)], []);
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stderr, /the open appended 3 chunk record\(s\)\n/, applied.stderr);
    assert.match(applied.stderr, /VERIFIED/, applied.stderr);
  });

  for (const how of ['changes', 'drops', 'rewrites a summary'] as const) {
    test(`fails verification, exit 2, where the open ${how === 'rewrites a summary' ? how : `${how} a chunk record`} the apply wrote`, async () => {
      wipe();
      await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9')]);
      const LOADED = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
const migrate = AutobiographicalStrategy.prototype.migrateChunkRecords;
AutobiographicalStrategy.prototype.migrateChunkRecords = function (store) {
  migrate.call(this, store);
  const how = ${JSON.stringify(how)};
  if (how === 'rewrites a summary') {
    const summaries = this.store.getStateJson(this.summariesStateId);
    this.store.setStateJson(this.summariesStateId, [{ ...summaries[0], content: 'rewritten' }, ...summaries.slice(1)]);
    return;
  }
  const records = this.store.getStateJson(this.chunksStateId);
  this.store.setStateJson(this.chunksStateId, how === 'drops' ? records.slice(1) : [{ ...records[0], compressed: false }, ...records.slice(1)]);
};
`)}`;
      const applied = spawnSync(process.execPath, ['--import', LOADED, CLI, STORE, '--namespace', 'probe', '--mode', 'compact', '--apply'], { encoding: 'utf8' });
      assert.equal(applied.status, 2, applied.stdout + applied.stderr);
      assert.match(applied.stderr, how === 'rewrites a summary' ? /VERIFICATION FAILED: the open changed the summaries the repair wrote/ : /VERIFICATION FAILED: the open changed the chunk records the repair wrote/, applied.stderr);
    });
  }

  test('reads what an open left as written where only the key order differs, and counts the records it appended', () => {
    const written = { summaries: [{ id: 'a', level: 1 }], records: [{ id: 'c-1', sourceIds: ['m'], compressed: true, summaryId: 'a' }] };
    assert.deepEqual(loadedAsWritten(written, { summaries: [{ level: 1, id: 'a' }], records: [{ summaryId: 'a', compressed: true, sourceIds: ['m'], id: 'c-1' }, { id: 'c-2', sourceIds: ['n'], compressed: false }] }),
      { summariesChanged: false, recordsChanged: false, appendedRecords: 1 });
    assert.equal(loadedAsWritten(written, { summaries: written.summaries, records: [] }).recordsChanged, true);
    const two = { summaries: [], records: [{ id: 'c-1', sourceIds: ['m'] }, { id: 'c-2', sourceIds: ['n'] }] };
    assert.equal(loadedAsWritten(two, { summaries: [], records: [two.records[1], two.records[0]] }).recordsChanged, true, 'reordered');
    assert.equal(loadedAsWritten(written, { summaries: [], records: written.records }).summariesChanged, true);
  });

  test('reads a compression-quarantined chunk by the messages of its record that still stand, as the strategy hashes it', async () => {
    wipe();
    const P = tower('P', 0, 1, 2);
    const T = tower('T', 16, 2, 2);
    const N = tower('N', 32, 0, 1);
    const withGone = { ...rec('c-p', 12, 15), sourceIds: ['m-gone', ...ids(12, 15)] };
    await fixtureStore(STORE, 36, [...P.summaries, l1('x', 8, 11), ...T.summaries, ...N.summaries], [...P.records, rec('c-x', 8, 11, 'x'), ...T.records, ...N.records, withGone]);
    const dry = () => spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild'], { encoding: 'utf8' });
    const unquarantined = dry();
    assert.match(unquarantined.stdout, /plan \(/, unquarantined.stdout + unquarantined.stderr);
    assert.doesNotMatch(unquarantined.stdout, /partner stranded L1 x /, 'premise: x merges with the pending chunk\'s L1 to come');
    const store = JsStore.open({ path: STORE });
    try {
      const stored = store.getStateJson('probe/autobio:chunks') as Array<{ id: string; sourceIds: string[] }>;
      const standing = stored.find((r) => r.id === 'c-p')!.sourceIds.filter((id) => id !== 'm-gone');
      store.setStateJson('probe/autobio:compression-refusal-quarantine', [{ key: 'q-p', chunkSourceHash: createHash('sha256').update(JSON.stringify(standing), 'utf8').digest('hex') }]);
    } finally {
      store.close();
    }
    const quarantined = dry();
    assert.match(quarantined.stdout, /partner stranded L1 x /, quarantined.stdout + quarantined.stderr);
  });

  test('says in the dry run how many chunk records the settling leaves out, as the loader does', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9'), { sourceIds: ids(0, 3), compressed: false } as never]);
    const dry = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'compact'], { encoding: 'utf8' });
    assert.match(dry.stdout, /settling the store as the loader does: left out 1 chunk record\(s\) with no id or no message ids/, dry.stdout + dry.stderr);
  });

  test('names a legacy quarantine snapshot passed over beside a ledger that holds no list', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9')]);
    const store = JsStore.open({ path: STORE });
    try {
      store.setStateJson('probe/autobio:compression-refusal-quarantine-events', { not: 'a list' });
      store.setStateJson('probe/autobio:compression-refusal-quarantine', [{ key: 'q-legacy', chunkSourceHash: 'h' }]);
    } finally {
      store.close();
    }
    const dry = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild'], { encoding: 'utf8' });
    assert.match(dry.stderr, /holds what the strategy reads as no entry: entries left out \[q-legacy\]; no list in the ledger;/, dry.stderr);
  });

  test('names what the compression quarantine\'s stored state holds that the strategy reads as no entry, and a summaries state that is no list holds nothing', async () => {
    wipe();
    await fixtureStore(STORE, 12, [l1('L1-7', 0, 3), l1('L1-8', 4, 7), l1('L1-9', 8, 11)], [rec('c-7', 0, 3, 'L1-7'), rec('c-8', 4, 7, 'L1-8'), rec('c-9', 8, 11, 'L1-9')]);
    const write = (id: string, value: unknown) => { const store = JsStore.open({ path: STORE }); try { store.setStateJson(id, value); } finally { store.close(); } };
    write('probe/autobio:compression-refusal-quarantine-events', { not: 'a list' });
    const dry = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild'], { encoding: 'utf8' });
    assert.match(dry.stderr, /the compression quarantine's stored state holds what the strategy reads as no entry: no list in the ledger/, dry.stderr);
    write('probe/autobio:summaries', { not: 'a list' });
    const none = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild'], { encoding: 'utf8' });
    assert.equal(none.status, 1, none.stdout + none.stderr);
    assert.match(none.stderr, /nothing to repair: 12 messages, 0 summaries/);
  });

  test('raises the summary-id counter past the ids it drops before it writes, as the loader does', async () => {
    await competing(false, 'L2-90');
    const counter = (): unknown => { const store = JsStore.open({ path: STORE }); try { return store.getStateJson('probe/autobio:counter'); } finally { store.close(); } };
    assert.ok(!(Number(counter() ?? 0) > 90), 'premise: the counter trails L2-90');
    const applied = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild', '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.ok(!stored().some((x) => x.id === 'L2-90'), 'premise: L2-90 is gone');
    assert.ok(Number(counter()) >= 91, String(counter()));
  });

  test('says in the dry run, in the loader\'s line, what settling the store as the loader does drops, and where each dropped text stays', async () => {
    await competing(false);
    const dry = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild'], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /\n  settling the store as the loader does: repaired summary state: removed 0 malformed entr\(ies\) and deduped 0; .*naming one it isn't the parent of \[Q\];/, dry.stdout);
    assert.match(dry.stdout, /\n  the text of each summary dropped there stays in the store's history, in state probe\/autobio:summaries at sequence [0-9]+ on branch [^:]+: Q \(it names a summary it isn't the parent of, [0-9]+ tokens\)\n/, dry.stdout);
    assert.match(dry.stderr, /DRY RUN/);
    assert.equal(stored().filter((x) => x.id === 'Q').length, 1, 'nothing written');
    const json = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild', '--json'], { encoding: 'utf8' });
    const plan = JSON.parse(json.stdout) as { settled: { dropped: Array<{ id: string; reason: string }>; textAt: { stateId: string; sequence: number } } };
    assert.deepEqual(plan.settled.dropped.map((d) => [d.id, d.reason]), [['Q', 'names-non-child']]);
    assert.equal(plan.settled.textAt.stateId, 'probe/autobio:summaries');
    const at = Number(/ at sequence ([0-9]+) on branch /.exec(dry.stdout)?.[1]);
    const read = JsStore.open({ path: STORE });
    try {
      const then = read.getStateJsonAt('probe/autobio:summaries', at) as Array<{ id?: string; content?: unknown }> | null;
      assert.ok((then ?? []).some((x) => x?.id === 'Q' && typeof x.content === 'string' && x.content.length > 0), 'the printed state at the printed sequence holds Q with its text');
    } finally {
      read.close();
    }
  });
});

describe('a rebuild with --release-head', () => {
  const STORE = './test-topology-repair-release-store';
  const CLI = join(process.cwd(), 'dist/scripts/repair-topology.js');
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);

  test('is refused, by the script and the planner, since it would partner what the release removes', async () => {
    const parts = [tower('P', 0, 2, 2), tower('T', 16, 1, 2), tower('Q', 28, 2, 2), tower('N', 44, 0, 1)];
    const summaries = [...parts.flatMap((x) => x.summaries), l1('x', 24, 27)];
    const records = [...parts.flatMap((x) => x.records), rec('c-x', 24, 27, 'x')];
    await fixtureStore(STORE, 48, summaries, records);
    const state = () => { const store = JsStore.open({ path: STORE }); try { return JSON.stringify([store.getStateJson('probe/autobio:summaries'), store.getStateJson('probe/autobio:chunks')]); } finally { store.close(); } };
    const before = state();
    for (const args of [['--release-head'], ['--release-head=all'], ['--release-head', '--apply']]) {
      const r = spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', '--mode', 'rebuild', ...args], { encoding: 'utf8' });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /--mode rebuild refuses --release-head: .* Release the head in a pass of its own/);
    }
    assert.equal(state(), before, 'nothing written');
    assert.throws(() => planTopologyRepair({ summaries, records, messages: msgs(48) }, { mode: 'rebuild', releaseHead: 'all' }), /releaseHead with mode rebuild/);
  });
});

describe('the repair CLI reads the resident\'s run settings and the stored merge queue and quarantine', () => {
  const STORE = './test-topology-repair-cli-reads';
  const CLI = join(process.cwd(), 'dist/scripts/repair-topology.js');
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, STORE, '--namespace', 'probe', ...args], { encoding: 'utf8' });
  const setState = (id: string, value: unknown): void => {
    const store = JsStore.open({ path: STORE });
    try { store.setStateJson(`probe/autobio:${id}`, value); } finally { store.close(); }
  };

  test('its flags, in either form, change the plan, and a bad number is refused', async () => {
    wipe();
    const m = await strayStore(STORE);
    const held = cli('--mode', 'rebuild', '--merge-hold=H');
    assert.equal(held.status, 0, held.stderr);
    assert.ok(held.stdout.includes(`\n  partner stranded L1 S (2 leaves ${m[12]}..${m[13]}): dissolve P and what stands above\n`), held.stdout);
    const wide = cli('--mode', 'rebuild', '--merge-hold=H', '--merge-max-span=0', '--merge-threshold', '3', '--no-speculative-production');
    assert.equal(wide.status, 0, wide.stderr);
    assert.match(wide.stdout, /\nrun settings the stray rule read: mergeThreshold 3, mergeMaxSourceSpanMessages 0, mergeHoldSummaryIds H, speculativeProduction off /);
    assert.match(wide.stderr, /store is clean; nothing to do/);
    const bad = cli('--mode', 'rebuild', '--merge-threshold=three');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--merge-threshold must be a whole number, got three/);
    const first = spawnSync(process.execPath, [CLI, '--merge-threshold', '3', '--namespace', 'probe', STORE, '--mode', 'rebuild'], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /\nrun settings the stray rule read: mergeThreshold 3, /, first.stdout);
  });

  test('a stored queued merge holds the runs beside it, and a stored merge quarantine holds its group', async () => {
    wipe();
    const m = await strayStore(STORE);
    setState('mergeQueue', [{ level: 2, sourceIds: ['S', 'H'] }]);
    const queued = cli('--mode', 'rebuild');
    assert.equal(queued.status, 0, queued.stderr);
    assert.match(queued.stderr, /store is clean; nothing to do/, queued.stdout);
    const dropped = cli('--mode', 'rebuild', '--merge-hold', 'H');
    assert.equal(dropped.status, 0, dropped.stderr);
    assert.ok(dropped.stdout.includes(`\n  partner stranded L1 S (2 leaves ${m[12]}..${m[13]}): dissolve P and what stands above\n`), dropped.stdout);
    setState('mergeQueue', []);
    setState('merge-quarantine', [{ key: 'k', level: 2, sourceIds: ['S', 'H'], attempts: 3, lastOutcome: 'refusal', quarantinedAt: 1 }]);
    const quarantined = cli('--mode', 'rebuild');
    assert.equal(quarantined.status, 0, quarantined.stderr);
    assert.ok(quarantined.stdout.includes(`\n  STILL STRANDED L2 P (12 leaves ${m[0]}..${m[11]}): no neighbour to free\n`), quarantined.stdout);
    setState('merge-quarantine', [null, { key: 'k', level: 2, sourceIds: 'S' }]);
    setState('mergeQueue', [null, { level: 2 }]);
    const damaged = cli('--mode', 'rebuild');
    assert.equal(damaged.status, 0, damaged.stderr);
    assert.match(damaged.stderr, /store is clean; nothing to do/, 'with no hold, S and H are a run and P waits on it');
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
