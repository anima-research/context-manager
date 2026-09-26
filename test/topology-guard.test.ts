/**
 * Store topology guard — merge adjacency in STORE order, refusal of crossed
 * mints, and the load-time audit (issues #122 and #95).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, StoreTopologyError } from '../src/index.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { SummaryEntry, StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

class Probe extends AutobiographicalStrategy {
  /** Chunk records in RECORD order (the order chunks were minted). */
  setChunks(groups: string[][]): void {
    (this as unknown as { chunks: unknown[] }).chunks = groups.map((ids) => ({ messages: ids.map((id) => ({ id })) }));
  }
  /** The store listing (chronicle order). */
  setStore(messageIds: string[]): void {
    this.refreshStoreOrder(messageIds.map((id) => ({ id })));
  }
  setSummaries(summaries: SummaryEntry[]): void {
    (this as unknown as { summaries: SummaryEntry[] }).summaries = summaries;
  }
  allSummaries(): SummaryEntry[] {
    return (this as unknown as { summaries: SummaryEntry[] }).summaries;
  }
  pick(unmerged: SummaryEntry[], threshold: number): SummaryEntry[] | null {
    return this.contiguousMergeCandidates(unmerged, threshold);
  }
  demand(level: number, first: string, last: string): void {
    this.enqueueMergeForRange(level, first, last);
  }
  queue(): Array<{ level: number; sourceIds: string[] }> {
    return (this as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[] }> }).mergeQueue;
  }
  setQueue(queue: Array<{ level: number; sourceIds: string[] }>): void {
    (this as unknown as { mergeQueue: unknown[] }).mergeQueue = queue;
  }
  quarantine(): Map<string, { lastOutcome: string; lastErrorType?: string }> {
    return (this as unknown as { mergeQuarantine: Map<string, { lastOutcome: string; lastErrorType?: string }> }).mergeQuarantine;
  }
  audit(messageIds: string[]): ReturnType<AutobiographicalStrategy['auditStoreTopology']> {
    return this.auditStoreTopology(messageIds.map((id) => ({ id })));
  }
  gate(messageIds: string[]): void {
    this.assertStoreTopology(messageIds.map((id) => ({ id })));
  }
  async merge(level: number, sourceIds: string[], ctx: StrategyContext): Promise<void> {
    await this.executeMerge(level as never, sourceIds, ctx);
  }
}

const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `m-${from + i}`);

function l1(id: string, first: number, last: number, level = 1): SummaryEntry {
  return {
    id, level, content: `s ${id}`, tokens: 100, sourceLevel: level - 1,
    sourceIds: level === 1 ? ids(first, last) : [],
    sourceRange: { first: `m-${first}`, last: `m-${last}` },
    created: 1,
  } as SummaryEntry;
}

function probe(): Probe {
  return new Probe({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, mergeThreshold: 6 });
}

describe('merge adjacency is judged in store order (issue #122)', () => {
  test('a late chunk over an opening message does not join the frontier run', () => {
    const p = probe();
    // Store: m-0..m-199. Chunk RECORDS: the frontier chunks first, then the
    // stray minted last over the chronicle's opening message m-3.
    p.setStore(ids(0, 199));
    // m-4..m-99 are owned by earlier (already merged) chunks: the stray's only
    // neighbours in store order are other live representations.
    const history = [ids(4, 49), ids(50, 99)];
    const frontier = [ids(100, 109), ids(110, 119), ids(120, 129), ids(130, 139), ids(140, 149)];
    p.setChunks([...history, ...frontier, ['m-3']]);
    const stray = l1('L1-stray', 3, 3);
    const run5 = frontier.map((g, i) => l1(`L1-f${i}`, 100 + i * 10, 109 + i * 10));
    // In record order the stray is adjacent to L1-f4 and the six would merge.
    // In store order it is an interior singleton: the frontier run has five
    // members and waits for its sixth.
    assert.equal(p.pick([...run5, stray], 6), null);
    // With a sixth frontier L1 the run merges WITHOUT the stray.
    p.setChunks([...history, ...frontier, ids(150, 159), ['m-3']]);
    const six = [...run5, l1('L1-f5', 150, 159)];
    const picked = p.pick([...six, stray], 6);
    assert.deepEqual(picked?.map((s) => s.id), six.map((s) => s.id));
  });

  test('without a store listing the index degrades to chunk-record order', () => {
    const p = probe();
    p.setChunks([ids(0, 9), ids(10, 19)]);
    const picked = p.pick([l1('a', 0, 9), l1('b', 10, 19)], 2);
    assert.deepEqual(picked?.map((s) => s.id), ['a', 'b']);
  });
});

/** A Probe bound to a real store: branch-guarded entrypoints need one. */
async function openProbe(path: string, membrane: unknown, count = 40): Promise<{ manager: ContextManager; p: Probe; ids: string[]; ctx: StrategyContext }> {
  const p = new Probe({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, mergeThreshold: 6, compressionModel: 'test-compression-model' });
  const manager = await ContextManager.open({ path, strategy: p, membrane: membrane as never });
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
  const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
  return { manager, p, ids: out, ctx };
}
const real = (all: string[]) => (a: number, b: number) => all.slice(a, b + 1);
function l1r(id: string, src: string[], level = 1): SummaryEntry {
  return { id, level, content: `s ${id}`, tokens: 100, sourceLevel: level - 1, sourceIds: src,
    sourceRange: { first: src[0], last: src[src.length - 1] }, created: 1 } as SummaryEntry;
}
const STORES = ['./test-topology-guard-demand', './test-topology-guard-refuse', './test-topology-guard-pass', './test-topology-guard-store'];
const wipe = () => { for (const s of STORES) if (existsSync(s)) rmSync(s, { recursive: true, force: true }); };

describe('demand-path merges respect holes (issue #95)', () => {
  before(wipe);
  after(wipe);
  test('a source separated by an unlanded neighbour is left out; no contiguous pair enqueues nothing', async () => {
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const { manager, p, ids: all } = await openProbe(STORES[0], membrane);
    const s = real(all);
    p.setChunks([s(0, 9), s(10, 19), s(20, 29), s(30, 39)]);
    // The L1 over 20..29 has not landed: folding a and d across it would cross.
    p.setSummaries([l1r('a', s(0, 9)), l1r('b', s(10, 19)), l1r('d', s(30, 39))]);
    p.demand(2, all[0], all[39]);
    assert.deepEqual(p.queue().map((m) => m.sourceIds), [['a', 'b']]);
    p.setQueue([]);
    p.setSummaries([l1r('a', s(0, 9)), l1r('d', s(30, 39))]);
    p.demand(2, all[0], all[39]);
    assert.deepEqual(p.queue(), []);
    manager.close();
  });
});

describe('a crossed merge is refused at mint time', () => {
  before(wipe);
  after(wipe);
  test('non-adjacent sources: no model call, entry quarantined, health critical', async () => {
    let calls = 0;
    const membrane = { complete: async () => { calls++; return { stopReason: 'end_turn', content: [{ type: 'text', text: 'merged' }] }; } };
    const { manager, p, ids: all, ctx } = await openProbe(STORES[1], membrane);
    const s = real(all);
    p.setChunks([s(0, 9), s(10, 19), s(20, 29)]);
    p.setSummaries([l1r('a', s(0, 9)), l1r('b', s(10, 19)), l1r('c', s(20, 29))]);
    const queued = { level: 2, sourceIds: ['a', 'c'] };
    p.setQueue([queued]);
    await p.merge(2, queued.sourceIds, ctx);
    assert.equal(calls, 0, 'the summarizer must not be called for a crossed group');
    assert.deepEqual(p.queue(), [], 'the entry left the queue');
    const [record] = [...p.quarantine().values()];
    assert.equal(record.lastOutcome, 'topology_violation');
    assert.match(record.lastErrorType ?? '', /not adjacent in store order/);
    const debt = p.getCompressionDebt();
    assert.equal(debt.topologyRefusals, 1);
    assert.equal(debt.state, 'critical');
    assert.equal(p.allSummaries().filter((x) => x.level === 2).length, 0, 'nothing was minted');
    manager.close();
  });

  test('adjacent sources pass the gate (reaches the summarizer)', async () => {
    let calls = 0;
    const membrane = { complete: async () => { calls++; return { stopReason: 'end_turn', content: [{ type: 'text', text: 'merged '.repeat(10) }], usage: { input_tokens: 1, output_tokens: 1 } }; } };
    const { manager, p, ids: all, ctx } = await openProbe(STORES[2], membrane);
    const s = real(all);
    p.setChunks([s(0, 9), s(10, 19)]);
    p.setSummaries([l1r('a', s(0, 9)), l1r('b', s(10, 19))]);
    p.setQueue([{ level: 2, sourceIds: ['a', 'b'] }]);
    await p.merge(2, ['a', 'b'], ctx);
    assert.equal(calls, 1);
    assert.equal(p.getCompressionDebt().topologyRefusals, 0);
    manager.close();
  });
});

describe('load-time topology audit', () => {
  function crossedFixture(): { p: Probe; store: string[] } {
    const p = probe();
    const store = ids(0, 49);
    p.setChunks([['m-3'], ids(4, 13), ids(14, 23), ids(24, 33), ids(34, 43)]);
    const stray = l1('L1-stray', 3, 3);
    const era = [l1('L1-a', 4, 13), l1('L1-b', 14, 23), l1('L1-c', 24, 33), l1('L1-d', 34, 43)];
    // L2-x owns the stray opening message plus m-24..43: crossed over L1-a/L1-b.
    const l2 = { ...l1('L2-x', 3, 43, 2), sourceIds: ['L1-stray', 'L1-c', 'L1-d'] } as SummaryEntry;
    stray.mergedInto = 'L2-x'; era[2].mergedInto = 'L2-x'; era[3].mergedInto = 'L2-x';
    p.setSummaries([stray, ...era, l2]);
    return { p, store };
  }

  test('finds the crossed summary and names the interleaved owners', () => {
    const { p, store } = crossedFixture();
    const violations = p.audit(store);
    assert.deepEqual(violations.map((v) => v.id), ['L2-x']);
    const [v] = violations;
    assert.equal(v.level, 2);
    assert.equal(v.leafCount, 21);
    assert.deepEqual(v.span, { first: 'm-3', last: 'm-43' });
    assert.equal(v.holes, 20);
    assert.deepEqual(v.holeOwners, ['L1-a', 'L1-b']);
  });

  test('a clean pyramid has no violations', () => {
    const p = probe();
    p.setChunks([ids(0, 9), ids(10, 19), ids(20, 29)]);
    const l1s = [l1('a', 0, 9), l1('b', 10, 19), l1('c', 20, 29)];
    const l2 = { ...l1('L2', 0, 19, 2), sourceIds: ['a', 'b'] } as SummaryEntry;
    p.setSummaries([...l1s, l2]);
    assert.deepEqual(p.audit(ids(0, 40)), []);
  });

  test("never-chunked messages inside a span are not holes", () => {
    const p = probe();
    // m-10 is unowned (e.g. a message the chunker skipped): it occupies no position.
    p.setChunks([ids(0, 9), ids(11, 20)]);
    const l2 = { ...l1('L2', 0, 20, 2), sourceIds: ['a', 'b'] } as SummaryEntry;
    p.setSummaries([l1('a', 0, 9), l1('b', 11, 20), l2]);
    assert.deepEqual(p.audit(ids(0, 20)), []);
  });

  test("'reject' throws StoreTopologyError; 'report' records and goes critical", () => {
    const { p, store } = crossedFixture();
    assert.throws(() => p.gate(store), (e: unknown) => e instanceof StoreTopologyError && e.violations.length === 1 && /L2-x/.test(e.message));
    const r = new Probe({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, topologyPolicy: 'report' });
    const { p: fixture } = crossedFixture();
    r.setChunks((fixture as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks.map((c) => c.messages.map((m) => m.id)));
    r.setSummaries(fixture.allSummaries());
    r.gate(store);
    assert.equal(r.getTopologyViolations().length, 1);
    assert.equal(r.getCompressionDebt().topologyViolations, 1);
    assert.equal(r.getCompressionDebt().state, 'critical');
  });

  test('explicit kv-unified gap handling defaults to report', () => {
    const { p: fixture, store } = crossedFixture();
    const kv = new Probe({
      adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false,
      foldingStrategy: 'kv-unified',
      kvUnified: { treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: true } as never,
    });
    kv.setChunks((fixture as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks.map((c) => c.messages.map((m) => m.id)));
    kv.setSummaries(fixture.allSummaries());
    kv.gate(store);
    assert.equal(kv.getTopologyViolations().length, 1);
  });
});

describe('ContextManager.open fails closed on a crossed store', () => {
  const STORE = STORES[3];
  before(wipe);
  after(wipe);
  const t = (s: string): ContentBlock[] => [{ type: 'text', text: s }];

  test('a persisted crossed L2 rejects open; report opens and surfaces it', async () => {
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const seed = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({ path: STORE, strategy: seed, membrane: membrane as never });
    const msgIds: string[] = [];
    for (let i = 0; i < 40; i++) msgIds.push(manager.addMessage(i % 2 ? 'agent' : 'user', t(`message ${i} ` + 'w '.repeat(20))));
    const mk = (id: string, level: number, src: string[], first: string, last: string, mergedInto?: string): SummaryEntry => ({
      id, level, content: `s ${id}`, tokens: 50, sourceLevel: level - 1, sourceIds: src,
      sourceRange: { first, last }, created: 1, ...(mergedInto ? { mergedInto } : {}),
    } as SummaryEntry);
    const slice = (a: number, b: number) => msgIds.slice(a, b + 1);
    const summaries = [
      mk('L1-stray', 1, slice(3, 3), msgIds[3], msgIds[3], 'L2-x'),
      mk('L1-a', 1, slice(4, 13), msgIds[4], msgIds[13]),
      mk('L1-b', 1, slice(14, 23), msgIds[14], msgIds[23]),
      mk('L1-c', 1, slice(24, 33), msgIds[24], msgIds[33], 'L2-x'),
      mk('L2-x', 2, ['L1-stray', 'L1-c'], msgIds[3], msgIds[33]),
    ];
    const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void }; summariesStateId: string };
    internals.store.setStateJson(internals.summariesStateId, summaries);
    manager.close();

    await assert.rejects(
      ContextManager.open({ path: STORE, strategy: new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false }), membrane: membrane as never }),
      (e: unknown) => e instanceof StoreTopologyError && e.violations.map((v) => v.id).join() === 'L2-x',
    );

    const report = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, topologyPolicy: 'report' });
    const reopened = await ContextManager.open({ path: STORE, strategy: report, membrane: membrane as never });
    try {
      assert.deepEqual(report.getTopologyViolations().map((v) => v.id), ['L2-x']);
      assert.equal(report.getCompressionDebt().state, 'critical');
    } finally {
      reopened.close();
    }
  });
});

describe('auditOnly opens never mutate the store', () => {
  const STORE = './test-topology-guard-auditonly';
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  before(wipe);
  after(wipe);
  test('a plain open chunks the frontier; an audit-only open leaves records and queue untouched', async () => {
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const cfg = { adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, headWindowTokens: 50, recentWindowTokens: 0, targetChunkTokens: 200 };
    const seed = new AutobiographicalStrategy(cfg);
    const manager = await ContextManager.open({ path: STORE, strategy: seed, membrane: membrane as never });
    for (let i = 0; i < 60; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(30) }]);
    manager.close();
    const records = (s: AutobiographicalStrategy) => (s as unknown as { chunkRecords: unknown[] }).chunkRecords.length;
    const audit = new AutobiographicalStrategy({ ...cfg, headWindowTokens: 0, auditOnly: true, topologyPolicy: 'report' });
    const a = await ContextManager.open({ path: STORE, strategy: audit, membrane: membrane as never });
    const auditRecords = records(audit);
    a.close();
    const plain = new AutobiographicalStrategy({ ...cfg, headWindowTokens: 0 });
    const p = await ContextManager.open({ path: STORE, strategy: plain, membrane: membrane as never });
    const plainRecords = records(plain);
    p.close();
    assert.ok(plainRecords > auditRecords, `a plain open under a foreign config mints records (${plainRecords} > ${auditRecords})`);
    const again = new AutobiographicalStrategy({ ...cfg, headWindowTokens: 0, auditOnly: true, topologyPolicy: 'report' });
    const b = await ContextManager.open({ path: STORE, strategy: again, membrane: membrane as never });
    assert.equal(records(again), plainRecords, 'audit-only reads what the plain open wrote and adds nothing');
    b.close();
  });
});
