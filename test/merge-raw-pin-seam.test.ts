/**
 * No merge groups summaries across a message no chunk owns.
 *
 * The merge grammar numbered only chunk-owned messages, so a message no chunk
 * owns left no hole: a raw pin, a message an unpin freed before the chunker
 * reached it, a head window a reset left mid-stream. The L1s on its two sides
 * read as adjacent and merged into one L2. kv-unified's canonical forest then
 * found that L2 owning live leaves on both sides of the message's raw leaf and
 * rejected it at every compile, about 30 turns later.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager } from '../src/index.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { SummaryEntry, StrategyContext } from '../src/types/strategy.js';

class Probe extends AutobiographicalStrategy {
  setChunks(groups: string[][]): void {
    (this as unknown as { chunks: unknown[] }).chunks = groups.map((ids) => ({ messages: ids.map((id) => ({ id })) }));
  }
  /** The store listing, as stored messages. */
  listStore(messages: ReadonlyArray<{ id: string }>): void {
    this.refreshStoreOrder(messages);
  }
  setSummaries(summaries: SummaryEntry[]): void {
    (this as unknown as { summaries: SummaryEntry[] }).summaries = summaries;
  }
  allSummaries(): SummaryEntry[] {
    return (this as unknown as { summaries: SummaryEntry[] }).summaries;
  }
  /** A raw pin set as `pinRange` records one, for strategies with no store. */
  pinRaw(id: string): void {
    (this as unknown as { pins: unknown[] }).pins.push({ id: `pin-${id}`, firstMessageId: id, lastMessageId: id, kind: 'pin', created: 1 });
  }
  /** Remove every pin, as `unpin` does one. */
  unpinAll(): void {
    (this as unknown as { pins: unknown[] }).pins = [];
  }
  /** A merge-quarantine record, as a failed merge leaves one. */
  quarantineGroup(sourceIds: string[], lastOutcome: string): void {
    this.quarantine().set(`k-${sourceIds.join()}`, { key: `k-${sourceIds.join()}`, level: 2, sourceIds, attempts: 3, lastOutcome, quarantinedAt: 1 } as never);
  }
  held(): Set<string> {
    return this.mergeHeldSourceIds();
  }
  alarm(): void {
    this.soundMergeQuarantineAlarmIfNeeded();
  }
  pick(unmerged: SummaryEntry[], threshold: number): SummaryEntry[] | null {
    return this.contiguousMergeCandidates(unmerged, threshold);
  }
  index(): Map<string, number> {
    return this.mergePositionIndex();
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
  audit(messages: ReadonlyArray<{ id: string }>): ReturnType<AutobiographicalStrategy['auditStoreTopology']> {
    return this.auditStoreTopology(messages);
  }
  async merge(level: number, sourceIds: string[], ctx: StrategyContext): Promise<void> {
    await this.executeMerge(level as never, sourceIds, ctx);
  }
}

const config = { adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, mergeThreshold: 6, compressionModel: 'test-compression-model' };
const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `m-${from + i}`);
const listing = (from: number, to: number) => ids(from, to).map((id) => ({ id, participant: 'user', content: [] }));

function l1(id: string, src: string[], level = 1): SummaryEntry {
  return { id, level, content: `s ${id}`, tokens: 100, sourceLevel: level - 1, sourceIds: src,
    sourceRange: { first: src[0], last: src[src.length - 1] }, created: 1 } as SummaryEntry;
}

/** Store m-0..m-99; six L1s over m-10..m-70, three on each side of m-40, which no chunk owns. */
function sixAroundRawPin(): { p: Probe; six: SummaryEntry[] } {
  const p = new Probe(config);
  const groups = [ids(10, 19), ids(20, 29), ids(30, 39), ids(41, 50), ids(51, 60), ids(61, 70)];
  p.setChunks(groups);
  p.listStore(listing(0, 99));
  p.pinRaw('m-40');
  return { p, six: groups.map((g, i) => l1(`L1-${i}`, g)) };
}

/** Store m-0..m-99; six L1s over m-10..m-70, the fourth owning m-40. */
function sixOverOwnedMessage(): { p: Probe; six: SummaryEntry[] } {
  const p = new Probe(config);
  const groups = [ids(10, 19), ids(20, 29), ids(30, 39), ids(40, 50), ids(51, 60), ids(61, 70)];
  p.setChunks(groups);
  p.listStore(listing(0, 99));
  return { p, six: groups.map((g, i) => l1(`L1-${i}`, g)) };
}

describe('the merge grammar keeps runs apart at a message no chunk owns', () => {
  test("the threshold pass's grouping (contiguousMergeCandidates) groups only one side of a raw pin", () => {
    const { p, six } = sixAroundRawPin();
    // Each side is a run of three, short of six. The older one is not the
    // newest run, so it merges as it stands; the newer waits for its sixth.
    assert.deepEqual(p.pick(six, 6)?.map((s) => s.id), ['L1-0', 'L1-1', 'L1-2']);
  });

  test('a message an unpin freed keeps the runs apart until a chunk owns it', () => {
    const { p, six } = sixAroundRawPin();
    p.unpinAll();
    // m-40 is no longer pinned, and no chunk owns it yet: it still renders
    // raw between L1-2 and L1-3.
    assert.deepEqual(p.pick(six, 6)?.map((s) => s.id), ['L1-0', 'L1-1', 'L1-2']);
  });

  test('a raw pin over a message a chunk already owns leaves the run whole', () => {
    // Pinned after it was chunked: its L1 owns it, so nothing raw stands
    // between. The messages no chunk owns at either end (m-0..m-9 and
    // m-71..m-99) split nothing either.
    const { p, six } = sixOverOwnedMessage();
    p.pinRaw('m-45');
    assert.deepEqual(p.pick(six, 6)?.map((s) => s.id), six.map((s) => s.id));
  });

  test('a chunk member the listing lacks is placed after every listed message', () => {
    // m-100..m-105 were chunked after the last listing the strategy saw.
    const p = new Probe(config);
    p.setChunks([ids(10, 19), ids(100, 105)]);
    p.listStore(listing(0, 99));
    const index = p.index();
    assert.equal(index.get('m-10'), 10);
    assert.deepEqual(ids(100, 105).map((id) => index.get(id)), [100, 101, 102, 103, 104, 105]);
  });

  test('the audit reads ownership from live L1s where no chunk record holds it', () => {
    // No chunk records: the L1s alone own m-10..m-39, and an L2 over the
    // first and third skips the second.
    const p = new Probe(config);
    p.setChunks([]);
    const [a, b, c] = [l1('L1-a', ids(10, 19)), l1('L1-b', ids(20, 29)), l1('L1-c', ids(30, 39))];
    const l2: SummaryEntry = { ...l1('L2-x', ['L1-a', 'L1-c'], 2), sourceRange: { first: 'm-10', last: 'm-39' } };
    a.mergedInto = 'L2-x'; c.mergedInto = 'L2-x';
    p.setSummaries([a, b, c, l2]);
    assert.deepEqual(p.audit(listing(0, 99)).map((v) => v.id), ['L2-x']);
  });

  test('a quarantine record whose group spans a message no chunk owns holds nothing, and the alarm does not count it as holding', () => {
    // The control: the same record with m-40 owned holds both its sources.
    const owned = sixOverOwnedMessage();
    owned.p.setSummaries(owned.six);
    owned.p.quarantineGroup(['L1-2', 'L1-3'], 'refusal');
    assert.deepEqual([...owned.p.held()].sort(), ['L1-2', 'L1-3']);

    const p = new Probe({ ...config, quarantineAlarmIntervalMs: 1 });
    const groups = [ids(10, 19), ids(20, 29), ids(30, 39), ids(41, 50), ids(51, 60), ids(61, 70)];
    p.setChunks(groups);
    p.listStore(listing(0, 99));
    p.setSummaries(groups.map((g, i) => l1(`L1-${i}`, g)));
    p.quarantineGroup(['L1-2', 'L1-3'], 'refusal');
    assert.deepEqual([...p.held()], []);
    const lines: string[] = [];
    const error = console.error, warn = console.warn;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    console.warn = () => {};
    try { p.alarm(); } finally { console.error = error; console.warn = warn; }
    assert.ok(lines.some((line) => /1 merge\(s\) quarantined; 0 of them hold their sources out of merges/.test(line)), lines.join('\n'));
  });

  test('the load-time audit still judges ownership: an L2 minted across a raw pin before is left as it stands', () => {
    const { p, six } = sixAroundRawPin();
    const l2: SummaryEntry = { ...l1('L2-0', six.map((s) => s.id), 2), sourceRange: { first: 'm-10', last: 'm-70' } };
    p.setSummaries([...six, l2]);
    assert.deepEqual(p.audit(listing(0, 99)), []);
  });
});

const STORES = ['./test-merge-raw-pin-demand', './test-merge-raw-pin-mint', './test-merge-raw-pin-kv-unified', './test-merge-raw-pin-head-reset', './test-merge-raw-pin-demand-bound', './test-merge-raw-pin-unplaced'];
const wipe = () => { for (const s of STORES) if (existsSync(s)) rmSync(s, { recursive: true, force: true }); };

/** A Probe on a real store holding m-0..m-99 as real messages, with message 40 pinned raw
 *  (or, with `pin` false, owned by the fourth chunk). */
async function openAroundRawPin(path: string, membrane: unknown, pin = true) {
  const p = new Probe(config);
  const manager = await ContextManager.open({ path, strategy: p, membrane: membrane as never });
  const all: string[] = [];
  for (let i = 0; i < 100; i++) all.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i}` }]));
  if (pin) p.pinRange(all[40], all[40]);
  const s = (a: number, b: number) => all.slice(a, b + 1);
  const groups = [s(10, 19), s(20, 29), s(30, 39), s(pin ? 41 : 40, 50), s(51, 60), s(61, 70)];
  p.setChunks(groups);
  const six = groups.map((g, i) => l1(`L1-${i}`, g));
  p.setSummaries(six);
  p.listStore(manager.getAllMessages() as never);
  const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
  return { manager, p, all, six, ctx };
}

describe('merges that would cross a raw pin', () => {
  before(wipe);
  after(wipe);

  test('the demand path enqueues one side of a raw pin, not both', async () => {
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const { manager, p, all } = await openAroundRawPin(STORES[0], membrane);
    p.demand(2, all[10], all[70]);
    assert.deepEqual(p.queue().map((m) => m.sourceIds), [['L1-0', 'L1-1', 'L1-2']]);
    manager.close();
  });

  test('a demand range whose endpoint no chunk owns bounds the sources it takes', async () => {
    // m-5 is in the unowned head end. The range m-5..m-35 takes the three L1s
    // over m-10..m-39; read as the whole store, it would take all six.
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const { manager, p, all } = await openAroundRawPin(STORES[4], membrane, false);
    p.demand(2, all[5], all[35]);
    assert.deepEqual(p.queue().map((m) => m.sourceIds), [['L1-0', 'L1-1', 'L1-2']]);
    manager.close();
  });

  test('a queued group whose source has an endpoint neither listed nor owned is refused at mint time', async () => {
    let calls = 0;
    const membrane = { complete: async () => { calls++; return { stopReason: 'end_turn', content: [{ type: 'text', text: 'merged' }] }; } };
    const { manager, p, six, ctx } = await openAroundRawPin(STORES[5], membrane, false);
    // L1-5's last covered message is one the store never held.
    six[5].sourceRange = { ...six[5].sourceRange, last: 'gone' };
    const group = { level: 2, sourceIds: ['L1-4', 'L1-5'] };
    p.setQueue([group]);
    await p.merge(2, group.sourceIds, ctx);
    assert.equal(calls, 0);
    const [record] = [...p.quarantine().values()];
    assert.match(record?.lastErrorType ?? '', /source position unresolved/);
    manager.close();
  });

  test('a queued group across a raw pin is refused at mint time, with no model call', async () => {
    let calls = 0;
    const membrane = { complete: async () => { calls++; return { stopReason: 'end_turn', content: [{ type: 'text', text: 'merged' }] }; } };
    const { manager, p, six, ctx } = await openAroundRawPin(STORES[1], membrane);
    const crossing = { level: 2, sourceIds: six.map((s) => s.id) };
    p.setQueue([crossing]);
    await p.merge(2, crossing.sourceIds, ctx);
    assert.equal(calls, 0);
    const [record] = [...p.quarantine().values()];
    assert.equal(record.lastOutcome, 'topology_violation');
    assert.match(record.lastErrorType ?? '', /not adjacent in store order/);
    assert.equal(p.allSummaries().filter((x) => x.level === 2).length, 0, 'nothing was minted');
    manager.close();
  });
});

describe('kv-unified across a message no chunk owns, end to end', () => {
  before(wipe);
  after(wipe);

  // connectome-host's kv-unified block (framework-strategy.ts), fail-closed:
  // neither treeify nor gap-bearing summaries.
  const hostKvUnified = {
    policy: {
      alpha: 0.7, budgetLowRatio: 0.6, budgetHighRatio: 0.85, budgetUnderLambda: 1_000, budgetOverLambda: 4_000,
      cacheLambda: 1, cacheScale: 100_000, cacheReadPrice: 0.1, cacheWritePrice: 2,
      continuityLambda: 1, continuityScale: 100_000, continuityRecencyHalfLifeTokens: 100_000, continuityRecencyFloor: 0.2,
      continuityStableHalfLife: 16, continuityStableFloor: 0.25,
    },
    tokenBucketSize: 50_000, continuityBucketSize: 50_000, fidelityBucketSize: 100_000, labelCeiling: 100_000,
    adoptEpsilon: 3_000, treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false, hysteresisCertificate: true,
  };

  /**
   * Ninety turns (or `turns`) of a resident's shape under the host's block,
   * each compile's layout accepted as sent and eight ticks after each turn.
   * `event` runs after each turn's compile and returns the id of a message it
   * adds that no chunk will own, if any. Any compile that throws fails the test.
   */
  async function drive(path: string, turns: number, event: (turn: number, manager: ContextManager) => Promise<string | undefined>) {
    const budget = { maxTokens: 200_000, reserveForResponse: 0 };
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: hostKvUnified,
      headWindowTokens: 4_000, recentWindowTokens: 80_000, maxMessageTokens: 10_000,
      autoTickOnNewMessage: false, compressionModel: 'test-compression-model',
    } as never);
    const membrane = { complete: async () => ({ content: [{ type: 'text', text: 'm '.repeat(1000) }], stopReason: 'end_turn' }) };
    const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
    const internals = strategy as unknown as {
      summaries: SummaryEntry[];
      kvUnifiedPendingLayout: { units: Array<{ tokens?: number }> } | null;
      kvUnifiedPendingMarkerUnitIndices: number[];
    };
    // Each compile's layout is accepted as sent, as a host reports it, its
    // markers hashed by the units before them.
    const fnv = (s: string): string => {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      return (h >>> 0).toString(16);
    };
    let submission = 0;
    const accept = () => {
      const id = `s${++submission}`;
      strategy.beginKvUnifiedSubmission({ submissionId: id, requestHash: `r${id}`, layoutHash: `l${id}` });
      const units = internals.kvUnifiedPendingLayout?.units ?? [];
      let offset = 0;
      const offsets = units.map((u) => (offset += u.tokens ?? 0));
      strategy.reportKvUnifiedAccepted({
        submissionId: id, acceptedAt: Date.now(),
        wireReceipt: { requestHash: `r${id}`, markers: internals.kvUnifiedPendingMarkerUnitIndices.map((unitIndex, ordinal) => ({
          ordinal, prefixHash: fnv(JSON.stringify(units.slice(0, unitIndex + 1))), estimatedOffset: offsets[unitIndex] ?? 0,
        })) },
      } as never);
    };
    // Each compile logs its plan; ninety of them would bury the test's output.
    const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
      const { log, warn } = console;
      console.log = () => {}; console.warn = () => {};
      try { return await work(); } finally { console.log = log; console.warn = warn; }
    };
    let unowned = '';
    for (let turn = 0; turn < turns; turn++) {
      manager.addMessage('User', [{ type: 'text', text: `user ${turn} ` + 'u '.repeat(1200) }]);
      await quiet(() => manager.compile(budget, undefined, { kvUnifiedImmutablePrefixHash: 'immutable' } as never));
      accept();
      unowned = (await quiet(() => event(turn, manager))) ?? unowned;
      manager.addMessage('Claude', [
        { type: 'thinking', thinking: `think ${turn} ` + 't '.repeat(1400), signature: 'S'.repeat(300) },
        { type: 'text', text: `reply ${turn} ` + 'a '.repeat(2400) },
      ] as never);
      await quiet(async () => { for (let k = 0; k < 8; k++) await manager.tick(); });
    }
    // The run reached the merges that grouped summaries across the message
    // before: summaries above L1 formed on its far side, and none spans it.
    const position = new Map((manager.getAllMessages() as Array<{ id: string }>).map((m, i) => [m.id, i] as const));
    const byId = new Map(internals.summaries.map((s) => [s.id, s] as const));
    const span = (s: SummaryEntry): [number, number] => {
      if (s.level === 1) return [position.get(s.sourceRange.first)!, position.get(s.sourceRange.last)!];
      const spans = s.sourceIds.map((id) => span(byId.get(id)!));
      return [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))];
    };
    const at = position.get(unowned)!;
    const above = internals.summaries.filter((s) => s.level >= 2);
    assert.ok(above.some((s) => span(s)[0] > at), 'a summary above L1 formed after the message');
    assert.deepEqual(above.filter((s) => { const [lo, hi] = span(s); return lo < at && at < hi; }).map((s) => s.id), []);
    manager.close();
  }

  test('compiles keep going past the first merge that reaches a raw pin, and no summary spans it', { timeout: 120_000 }, async () => {
    await drive(STORES[2], 90, async (turn, manager) => {
      if (turn !== 40) return undefined;
      const pinned = manager.addMessage('User', [{ type: 'text', text: 'pinned ' + 'p'.repeat(8_000) }]);
      manager.pinRange(pinned, pinned);
      return pinned;
    });
  });

  test('compiles keep going after a head-window reset, and no summary spans the new head', { timeout: 120_000 }, async () => {
    // The reset's transition message starts the new head window, which no
    // chunk ever owns, mid-stream once later messages are chunked.
    await drive(STORES[3], 70, async (turn, manager) => {
      if (turn !== 30) return undefined;
      await manager.resetHeadWindow('a new topic');
      const all = manager.getAllMessages() as Array<{ id: string }>;
      return all[all.length - 1].id;
    });
  });
});
