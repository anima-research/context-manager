/**
 * repair-pyramid keeper-logic regression (2026-07-12 backfire).
 *
 * Scenario: a store whose chunk records cover only RECENT history (records
 * exist only since the chunk-persistence fix / lazy migration; branch
 * re-cuts can drop them for older spans). The old records-only keeper logic
 * pruned valid sole-coverage pre-record L1s as "stale", removing all summary
 * coverage from those spans (mythos 2026-07-12: folded floor 126k → 520k,
 * agent down).
 *
 * Asserts:
 *  - record-backed L1s are keepers (records stay authoritative);
 *  - sole-coverage L1s WITHOUT records survive (the fix);
 *  - true stale generations (fully covered by a longer keeper) still prune;
 *  - the coverage invariant holds (no live message loses L1 coverage);
 *  - a hand-broken keeper set (simulated via records pointing at a pruned
 *    span... covered by the guard) — the script exits 4 rather than apply
 *    when coverage would shrink (constructed indirectly).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsStore } from '@animalabs/chronicle';

const NS = 'agents/test';
const SCRIPT = join(process.cwd(), 'dist/scripts/repair-pyramid.js');

interface Sum {
  id: string;
  level: number;
  content: string;
  tokens: number;
  sourceLevel: number;
  sourceIds: string[];
  mergedInto?: string;
  created: number;
}

function l1(id: string, sourceIds: string[], mergedInto?: string): Sum {
  return {
    id, level: 1, content: `summary ${id}`, tokens: 100, sourceLevel: 0,
    sourceIds, ...(mergedInto ? { mergedInto } : {}), created: 1,
  };
}

function buildStore(
  dir: string,
  opts: {
    summaries: Sum[];
    records: unknown[];
    messageCount: number;
    messages?: unknown[];
    resolutions?: Record<string, number>;
  },
): void {
  const store = JsStore.openOrCreate({ path: dir });
  const reg = (id: string) => {
    try { store.registerState({ id, strategy: 'snapshot' }); } catch { /* ok */ }
  };
  reg('messages');
  reg(`${NS}/autobio:summaries`);
  reg(`${NS}/autobio:chunks`);
  reg(`${NS}/autobio:mergeQueue`);
  reg(`${NS}/autobio:resolutions`);
  store.setStateJson(
    'messages',
    opts.messages ?? Array.from({ length: opts.messageCount }, (_, i) => ({ id: `m-${i}` })),
  );
  store.setStateJson(`${NS}/autobio:summaries`, opts.summaries);
  store.setStateJson(`${NS}/autobio:chunks`, opts.records);
  store.setStateJson(`${NS}/autobio:mergeQueue`, []);
  store.setStateJson(`${NS}/autobio:resolutions`, opts.resolutions ?? {});
  store.close();
}

function runRepair(dir: string, args: string[] = []): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, dir, NS, ...args], { encoding: 'utf8' });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 };
  }
}

test('sole-coverage L1s without chunk records survive; true stale generations still prune', () => {
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);
    const summaries: Sum[] = [
      // PRE-RECORD ERA (no chunk records for these spans):
      l1('L1-old-a', msgs(0, 9)),          // sole coverage — MUST survive
      l1('L1-old-b', msgs(10, 19)),        // sole coverage — MUST survive
      // A true prefix-generation family (the duplication disease):
      l1('L1-gen-1', msgs(20, 24)),        // covered by L1-gen-3 → stale
      l1('L1-gen-2', msgs(20, 27)),        // covered by L1-gen-3 → stale
      l1('L1-gen-3', msgs(20, 29)),        // longest generation → keeper
      // POST-FIX ERA (record-backed):
      l1('L1-rec-1', msgs(30, 39)),
      l1('L1-rec-2', msgs(40, 49)),
    ];
    const records = [
      { id: 'c-1', sourceIds: msgs(30, 39), compressed: true, summaryId: 'L1-rec-1' },
      { id: 'c-2', sourceIds: msgs(40, 49), compressed: true, summaryId: 'L1-rec-2' },
    ];
    buildStore(dir, { summaries, records, messageCount: 50 });

    const { out, code } = runRepair(dir); // dry run
    assert.equal(code, 0, `dry run succeeds:\n${out}`);
    // 7 L1s → keep 5 (2 record-backed + 2 sole-coverage + longest generation)
    assert.match(out, /L1: 7 total → keep 5, prune 2/, out);
    assert.match(out, /0 LOST/, `coverage invariant holds:\n${out}`);
    assert.match(out, /chunk records \(2 → 2 keepers\) ∪ coverage sweep \(\+3\)/, out);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('OLD failure mode is now impossible: records-only stores keep recordless sole coverage', () => {
  // The exact mythos shape: records exist (so the OLD code took the
  // records-only branch) but cover only the newest span; older spans have
  // sole-coverage L1s with no records. Old behavior: prune them all
  // (coverage collapse). New behavior: keep them; nothing lost.
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);
    const summaries: Sum[] = [
      l1('L1-pre-1', msgs(0, 19)),
      l1('L1-pre-2', msgs(20, 39)),
      l1('L1-pre-3', msgs(40, 59)),
      l1('L1-new', msgs(60, 69)),
    ];
    const records = [{ id: 'c-9', sourceIds: msgs(60, 69), compressed: true, summaryId: 'L1-new' }];
    buildStore(dir, { summaries, records, messageCount: 70 });

    const { out, code } = runRepair(dir);
    assert.equal(code, 0, out);
    assert.match(out, /L1: 4 total → keep 4, prune 0/, `nothing valid pruned:\n${out}`);
    assert.match(out, /0 LOST/, out);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('coverage guard refuses to apply a repair that would shrink live L1 coverage', () => {
  // Force a coverage-losing prune via --frontier-only semantics? Frontier
  // mode never loses coverage (stale-only). Instead, construct the loss
  // directly: a record-backed keeper plus an L1 whose span is DISJOINT but
  // which is fully orphaned EXCEPT one live message that a bogus record
  // claims. Simplest reliable trigger: a record whose summary covers m-0..9
  // while a recordless L1 covering m-10..19 is marked mergedInto a wiped
  // parent... — in practice the union sweep keeps any coverage-adding L1,
  // so the only way to lose coverage is a record pointing at an L1 whose
  // sourceIds DON'T match the record's span. Simulate that drift.
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);
    const summaries: Sum[] = [
      l1('L1-a', msgs(0, 9)),
      // Same-start LONGER sibling: sweep order visits it first (span desc),
      // keeps it, then L1-a adds nothing → pruned. Fine — no loss. To force
      // loss we make the keeper's sourceIds NOT actually cover what it
      // claims: L1-b claims m-0..9 via the record but its sourceIds only
      // hold m-0..4 — m-5..9's real coverage (L1-a) then gets pruned as
      // "covered" because the RECORD's span marked m-5..9 covered.
      l1('L1-b', msgs(0, 4)),
    ];
    const records = [{ id: 'c-x', sourceIds: msgs(0, 9), compressed: true, summaryId: 'L1-b' }];
    buildStore(dir, { summaries, records, messageCount: 10 });

    const { out, code } = runRepair(dir, ['--apply']);
    assert.equal(code, 4, `refuses to apply (exit 4):\n${out}`);
    assert.match(out, /Refusing to apply/, out);

    // And the store is untouched: summaries state still has both L1s.
    const store = JsStore.open({ path: dir });
    const sums = store.getStateJson(`${NS}/autobio:summaries`);
    store.close();
    assert.equal((sums as Sum[]).length, 2, 'no write happened');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('STRATEGY PARITY: an L1 with covered live ids but uncovered orphaned ids is KEPT, not pruned', () => {
  // The second keeper-logic drift: the script checked staleness over LIVE
  // sourceIds only, while migrateChunkRecords checks ALL sourceIds — an L1
  // whose live ids are covered but which still carries orphaned (deleted /
  // re-cut) message ids was pruned by the script yet kept by the strategy.
  // Both now share selectKeeperL1s; assert the script keeps it.
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);
    const summaries: Sum[] = [
      l1('L1-A', msgs(0, 4)),                          // keeper — covers m-0..4
      l1('L1-B', [...msgs(2, 4), 'ghost-1']),          // live ids covered, ghost-1 not → KEPT
      l1('L1-C', msgs(2, 4)),                          // ALL ids covered → stale → pruned
    ];
    buildStore(dir, { summaries, records: [], messageCount: 5 });

    const { out, code } = runRepair(dir);
    assert.equal(code, 0, out);
    assert.match(out, /L1: 3 total → keep 2, prune 1/, `L1-B kept, only L1-C pruned:\n${out}`);
    assert.match(out, /0 LOST/, out);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('dangling-merged sole-coverage L1 counts as LIVE in the fold-floor estimate; growth guard trips', () => {
  // Liveness-predicate regression (the inverted `byId.has(mergedInto)` test).
  // The strategy's loadPersistedState CLEARS a dangling mergedInto and
  // revives the summary to the unmerged frontier — so an L1 merged into a
  // parent that no longer exists still renders, and when it is the sole
  // deepest coverage for its span the span costs its tokens, NOT raw.
  //
  // Store shape:
  //  - m-0..49: BIG raw messages (~1k tokens each) covered ONLY by L1-d,
  //    whose mergedInto points at a nonexistent 'L2-ghost' (dangling).
  //  - m-50..99: L1-x1/L1-x2 + stale duplicate L1-x1dup, merged into L2-b.
  //  The repair prunes L1-x1dup, wipes L2-b, unmerges x1/x2:
  //    floorBefore = L1-d(10k) + L2-b(12k) = 22k
  //    floorAfter  = L1-d(10k) + x1(10k) + x2(10k) = 30k  → > 22k * 1.25
  //  With the OLD inverted predicate L1-d was excluded from the before-set,
  //  its span costed raw (~50k), floorBefore ≈ 62k, and the guard silently
  //  under-tripped (30k < 62k) — the repair would have APPLIED.
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);
    const big = 'x'.repeat(4000); // ~1k tokens raw per message
    const messages = Array.from({ length: 100 }, (_, i) => ({ id: `m-${i}`, content: i < 50 ? big : 'hi' }));
    const sum = (over: Partial<Sum> & Pick<Sum, 'id' | 'level' | 'sourceLevel' | 'sourceIds' | 'tokens'>): Sum => ({
      content: `summary ${over.id}`, created: 1, ...over,
    });
    const summaries: Sum[] = [
      sum({ id: 'L1-d', level: 1, sourceLevel: 0, sourceIds: msgs(0, 49), tokens: 10000, mergedInto: 'L2-ghost' }),
      sum({ id: 'L1-x1', level: 1, sourceLevel: 0, sourceIds: msgs(50, 74), tokens: 10000, mergedInto: 'L2-b' }),
      sum({ id: 'L1-x1dup', level: 1, sourceLevel: 0, sourceIds: msgs(50, 59), tokens: 10000, mergedInto: 'L2-b' }),
      sum({ id: 'L1-x2', level: 1, sourceLevel: 0, sourceIds: msgs(75, 99), tokens: 10000, mergedInto: 'L2-b' }),
      sum({ id: 'L2-b', level: 2, sourceLevel: 1, sourceIds: ['L1-x1', 'L1-x1dup', 'L1-x2'], tokens: 12000 }),
    ];
    buildStore(dir, { summaries, records: [], messageCount: 100, messages });

    // Dry run: L1-d live → floorBefore counts its tokens (22k), not raw
    // (~62k); the wipe-driven growth to 30k is visible and flagged.
    const dry = runRepair(dir);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /L1: 4 total → keep 3, prune 1/, dry.out);
    assert.match(dry.out, /≥~22k tokens fully-folded before → ≥~30k after/,
      `dangling-merged L1-d counts as live in the before-estimate:\n${dry.out}`);
    assert.match(dry.out, /DEPTH DEBT/, `floor growth is flagged in dry run:\n${dry.out}`);

    // Apply without --allow-floor-growth: the guard must trip (exit 5).
    const applied = runRepair(dir, ['--apply']);
    assert.equal(applied.code, 5, `floor-growth guard trips (exit 5):\n${applied.out}`);
    assert.match(applied.out, /refusing to apply/i, applied.out);

    // Store untouched.
    const store = JsStore.open({ path: dir });
    const sums = store.getStateJson(`${NS}/autobio:summaries`);
    store.close();
    assert.equal((sums as Sum[]).length, 5, 'no write happened');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('full repair refuses a record-backed L1 whose live coverage is non-contiguous', () => {
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const summaries = [l1('L1-fused', ['m-0', 'm-1', 'm-8', 'm-9'])];
    const records = [{
      id: 'c-fused',
      sourceIds: ['m-0', 'm-1', 'm-8', 'm-9'],
      compressed: true,
      summaryId: 'L1-fused',
    }];
    buildStore(dir, { summaries, records, messageCount: 10 });

    const result = runRepair(dir, ['--apply']);
    assert.equal(result.code, 6, result.out);
    assert.match(result.out, /L1-fused: authored live coverage is non-contiguous/, result.out);
    assert.match(result.out, /refusing to apply/i, result.out);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('explicit uncompressed records make retired L1 coverage deferred rather than lost', () => {
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const summaries = [l1('L1-fused', ['m-0', 'm-1', 'm-8', 'm-9'])];
    const records = [
      { id: 'c-early', sourceIds: ['m-0', 'm-1'], compressed: false },
      { id: 'c-late', sourceIds: ['m-8', 'm-9'], compressed: false },
    ];
    buildStore(dir, { summaries, records, messageCount: 10 });

    const dry = runRepair(dir);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /L1: 1 total → keep 0, prune 1/, dry.out);
    assert.match(dry.out, /4 deferred to explicit uncompressed records; 0 LOST\/UNOWNED/, dry.out);
    assert.match(dry.out, /canonical closure verified/, dry.out);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('repair clamps carried resolutions to the deepest surviving ancestor', () => {
  const parent = mkdtempSync(join(tmpdir(), 'repair-keepers-'));
  const dir = join(parent, 'store');
  try {
    const child = l1('L1-a', ['m-0', 'm-1'], 'L2-a');
    const parentSummary: Sum = {
      id: 'L2-a',
      level: 2,
      content: 'parent',
      tokens: 100,
      sourceLevel: 1,
      sourceIds: [child.id],
      created: 2,
    };
    buildStore(dir, {
      summaries: [child, parentSummary],
      records: [{
        id: 'c-a', sourceIds: child.sourceIds, compressed: true, summaryId: child.id,
      }],
      messageCount: 2,
      resolutions: { 'm-0': 3, 'm-1': 2 },
    });

    const result = runRepair(dir, ['--apply']);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /resolutions:\s+1 impossible carried level\(s\) clamped\/cleared/, result.out);
    const store = JsStore.open({ path: dir });
    const resolutions = store.getStateJson(`${NS}/autobio:resolutions`);
    store.close();
    assert.deepEqual(resolutions, { 'm-0': 2, 'm-1': 2 });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
