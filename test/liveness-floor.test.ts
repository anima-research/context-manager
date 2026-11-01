/**
 * Liveness of the adaptive compile against its floor (#415, #412).
 *
 * An adaptive compile refuses once the floor, the cheapest plan the summaries
 * held allow (head, tail and the most-folded middle), passes the hard budget.
 * Staying live needs the lane's relief (L1s and merges) to keep pace with what
 * the agent takes in. These tests drive a reader agent with no LLM: each turn
 * adds tool reads, and a mock compressor answers at once, but the lane gets
 * only the ticks a test grants it, one compression call each, since a tick
 * starts at most one. That models a compressor slower than the agent.
 *
 * - Under a backlog, queued merges get calls. tick() used to run every
 *   queued L1 before any merge, so a reader that closes chunks as fast as
 *   calls complete kept its merges waiting for as long as it read: the
 *   pyramid stopped deepening, unmerged L1s filled the middle and the plan
 *   refused at its deepest available level (#412).
 * - Through bursts the lane can't keep up with, followed by idle stretches
 *   that let it catch up, the compile stays live.
 * - Each adaptive compile whose floor can be computed reports it beside the
 *   hard budget, and the floor drops as relief lands; a refusal after the
 *   plan names its floor and the relief the queue holds, when the floor was
 *   computed. Outside kv-unified the floor counts no lock, so a lock a pin
 *   overrides doesn't take it away; under kv-unified it counts every lock. A
 *   floor that can't be computed is said once per cause.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, OverBudgetError } from '../src/index.js';
import { CanonicalSummaryForest } from '../src/adaptive/kv-unified.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-liveness-floor';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
const t = (s: string): ContentBlock => ({ type: 'text', text: s });
const words = (n: number) => 'substantive words about real happenings '.repeat(n);
const TOOLS = [{ name: 'read', description: 'read part of a file', inputSchema: { type: 'object' as const } }];

const KV_UNIFIED = {
  policy: {
    alpha: 0.7,
    budgetLowRatio: 0.6,
    budgetHighRatio: 0.85,
    budgetUnderLambda: 1_000,
    budgetOverLambda: 4_000,
    cacheLambda: 1,
    cacheScale: 1000,
    cacheReadPrice: 0.1,
    cacheWritePrice: 2,
    continuityLambda: 1,
    continuityScale: 1000,
    continuityRecencyHalfLifeTokens: 1000,
    continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 16,
    continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100,
  continuityBucketSize: 100,
  fidelityBucketSize: 100,
  labelCeiling: 10_000,
  adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false,
  preserveGapBearingSummaries: false,
};

interface Reader {
  manager: ContextManager;
  strategy: AutobiographicalStrategy;
  calls: { l1: number; merge: number };
  /** Add one turn of `reads` tool reads. */
  read(reads: number, passage?: string): void;
  /** Grant the lane `n` ticks (one compression call each, at most). */
  grant(n: number): Promise<void>;
  /** Tick until nothing is queued, bounded. */
  drain(): Promise<void>;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function collectFloorWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => { if (/floor not computed/.test(String(message))) warnings.push(String(message)); };
  return { warnings, restore: () => { console.warn = warn; } };
}

async function openReader(config: Record<string, unknown> = {}, summaryWords = 4, refuse?: RegExp): Promise<Reader> {
  cleanup();
  const calls = { l1: 0, merge: 0 };
  const membrane = {
    complete: async (request: { messages?: unknown[] }) => {
      if (refuse?.test(JSON.stringify(request.messages ?? []))) {
        return { stopReason: 'refusal', content: [], usage: { input_tokens: 100, output_tokens: 0 } };
      }
      const last = JSON.stringify(request.messages?.[request.messages.length - 1] ?? '');
      if (/consolidat/i.test(last)) calls.merge++;
      else calls.l1++;
      return {
        stopReason: 'end_turn',
        content: [t(`a recollection of what happened, ${words(summaryWords)}`)],
        usage: { input_tokens: 100, output_tokens: 40 },
      };
    },
  };
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } },
    targetChunkTokens: 100,
    summaryTargetTokens: 40,
    headWindowTokens: 0,
    recentWindowTokens: 300,
    autoTickOnNewMessage: false,
    ...config,
  });
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
  manager.setToolDefinitions(TOOLS);
  let n = 0;
  return {
    manager,
    strategy,
    calls,
    read(reads: number, passage = '') {
      for (let k = 0; k < reads; k++, n++) {
        const id = `read-${n}`;
        manager.addMessage('agent', [t('reading on'), { type: 'tool_use', id, name: 'read', input: { offset: n } } as ContentBlock]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: id, content: `passage ${n}: ${passage}${words(12)}` } as ContentBlock]);
      }
    },
    async grant(ticks: number) {
      for (let k = 0; k < ticks; k++) {
        await manager.tick();
        await settle();
      }
    },
    async drain() {
      for (let k = 0; k < 400 && !manager.isReady(); k++) {
        await manager.tick();
        await settle();
      }
    },
  };
}

describe('Adaptive compile liveness against the floor (#415)', () => {
  after(cleanup);

  it('a queued merge gets a call while chunks keep arriving faster than they compress', async () => {
    const reader = await openReader();
    let backloggedTurns = 0;
    let mostMergesQueued = 0;
    const TURNS = 60;
    for (let turn = 0; turn < TURNS; turn++) {
      // Three reads a turn close about a chunk and a half, against one call.
      reader.read(3);
      await reader.grant(1);
      const progress = reader.strategy.getProgressSnapshot();
      if (progress.l1QueueLength > 0) backloggedTurns++;
      mostMergesQueued = Math.max(mostMergesQueued, progress.mergeQueueLength);
    }
    const snapshot = reader.strategy.getProgressSnapshot();
    assert.ok(backloggedTurns >= TURNS / 2, `premise: a chunk waited for L1 after most turns (${backloggedTurns}/${TURNS})`);
    assert.ok(reader.calls.l1 >= 30, `premise: the lane ran a call per turn (${reader.calls.l1} L1 calls)`);
    assert.ok(mostMergesQueued > 0, 'premise: a merge was queued');
    assert.ok(
      reader.calls.merge > 0,
      `${snapshot.mergeQueueLength} merge(s) queued, but no merge got a call in ${reader.calls.l1} compression calls over ${TURNS} turns`,
    );
    reader.manager.close();
  });

  it('stays live through reading bursts the lane catches up on between them', async () => {
    // Summaries about two thirds of their chunk, as the default target of
    // 2,000 tokens is of 3,000-token chunks: an L1 relieves little, a merge
    // a lot.
    const reader = await openReader({}, BURST_SUMMARY_WORDS);
    const budget = { maxTokens: BURST_BUDGET, reserveForResponse: 0 };
    const refusals: string[] = [];
    for (let turn = 1; turn <= BURST_TURNS; turn++) {
      reader.read(2);
      await reader.grant(1);
      if (turn % BURST_LENGTH === 0) await reader.drain();
      try {
        await reader.manager.compile(budget);
      } catch (error) {
        if (!(error instanceof OverBudgetError)) throw error;
        refusals.push(`turn ${turn}: ${error.message}`);
      }
    }
    const { totalChunks } = reader.strategy.getProgressSnapshot();
    assert.ok(totalChunks >= BURST_TURNS * 0.9, `premise: the reader closed about a chunk a turn, against one call a turn (${totalChunks} chunks)`);
    assert.ok(reader.calls.merge > 0, 'premise: merges ran');
    assert.deepStrictEqual(refusals.slice(0, 3), [], `${refusals.length} of ${BURST_TURNS} compiles refused`);
    reader.manager.close();
  });

  it('reports the floor beside the hard budget, under the plan, dropping as relief lands', async () => {
    const reader = await openReader();
    const budget = { maxTokens: 20_000, reserveForResponse: 0 };
    reader.read(24);
    await reader.manager.compile(budget);
    const before = reader.manager.getRenderStats()?.planVsActual;
    assert.ok(before?.floorTokens !== undefined, 'the plan reports its floor');
    assert.strictEqual(before.hardBudget, Math.floor(20_000 * 1.02), 'beside the budget it refuses above');
    assert.ok(before.floorTokens <= before.planned, `the floor (${before.floorTokens}) is at most the plan (${before.planned})`);
    assert.ok((before.queuedReliefTokens ?? 0) > 0, `queued work is counted as relief (${before.queuedReliefTokens})`);
    await reader.drain();
    await reader.manager.compile(budget);
    const after = reader.manager.getRenderStats()?.planVsActual;
    assert.ok(after?.floorTokens !== undefined);
    assert.ok(
      after.floorTokens < before.floorTokens,
      `the floor drops once the queued work lands (${before.floorTokens} → ${after.floorTokens})`,
    );
    assert.strictEqual(after.queuedReliefTokens, 0, 'with nothing queued, no relief is counted');
    reader.manager.close();
  });

  it('counts a chunk the compression quarantine holds as no relief, though it stays queued', async () => {
    const reader = await openReader(
      // Source-only requests, so the chunks after the refused one don't carry
      // it raw and get refused too (#346).
      { recentWindowTokens: 0, compressionRefusalCurveFallbacks: 0, mergeThreshold: 99, compressionSourceOnly: true },
      4,
      /UNSUMMARIZABLE/,
    );
    reader.read(6);
    await reader.drain();
    reader.read(2, 'UNSUMMARIZABLE ');
    reader.read(3); // closes the refused chunk
    const quarantined = () =>
      (reader.strategy as unknown as { quarantinedChunkSources(): Set<string> | undefined }).quarantinedChunkSources()?.size ?? 0;
    for (let k = 0; k < 40 && quarantined() === 0; k++) await reader.grant(1);
    await reader.manager.compile({ maxTokens: 20_000, reserveForResponse: 0 });
    const stats = reader.manager.getRenderStats()?.planVsActual;
    assert.ok(quarantined() > 0, 'premise: the refused chunk is quarantined');
    assert.ok(reader.strategy.getProgressSnapshot().l1QueueLength > 0, 'premise: the rebuild queued it again');
    assert.strictEqual(stats?.queuedReliefTokens, 0, 'a chunk tick will skip relieves nothing');
    reader.manager.close();
  });

  it('names the floor and the queued relief in a refusal', async () => {
    const reader = await openReader();
    reader.read(24);
    let refusal: OverBudgetError | undefined;
    try {
      await reader.manager.compile({ maxTokens: 600, reserveForResponse: 0 });
    } catch (error) {
      if (error instanceof OverBudgetError) refusal = error;
      else throw error;
    }
    assert.ok(refusal, 'premise: the compile refused');
    const { floorTokens, queuedReliefTokens } = refusal.diagnostics;
    assert.ok(floorTokens !== undefined && floorTokens > refusal.budget, `its floor (${floorTokens}) is over the budget (${refusal.budget})`);
    assert.ok((queuedReliefTokens ?? 0) > 0, `the queue's relief is named (${queuedReliefTokens})`);
    assert.match(refusal.message, new RegExp(`floor=${floorTokens}, queued relief=${queuedReliefTokens}`));
    reader.manager.close();
  });

  for (const foldingStrategy of ['kv-stable', 'flat-profile', 'oldest-first']) {
    it(`keeps the floor where a pin overrides a lock, under ${foldingStrategy}`, async () => {
      const reader = await openReader({ foldingStrategy, kvUnified: undefined });
      reader.read(40);
      await reader.drain();
      await reader.manager.compile({ maxTokens: 3_000, reserveForResponse: 0 });
      const resolutions = (reader.strategy as unknown as { resolutions: Map<string, number> }).resolutions;
      const folded = [...resolutions].find(([, level]) => level >= 1)?.[0];
      assert.ok(folded, 'premise: a message is folded');
      const budget = { maxTokens: 20_000, reserveForResponse: 0 };
      const floor = collectFloorWarnings();
      try {
        reader.strategy.lockChunk(folded);
        await reader.manager.compile(budget);
        const beforePin = reader.manager.getRenderStats()?.planVsActual?.floorTokens;
        reader.manager.pinRange(folded, folded);
        await reader.manager.compile(budget);
        const stats = reader.manager.getRenderStats()?.planVsActual;
        assert.ok(stats?.floorTokens !== undefined, 'the floor is reported beside a raw pin over a locked message');
        assert.ok(stats.floorTokens <= stats.planned, `at or under the plan (${stats.floorTokens} > ${stats.planned})`);
        assert.ok(beforePin !== undefined && stats.floorTokens > beforePin, `the pin counts (${stats.floorTokens}, ${beforePin})`);
        assert.strictEqual(floor.warnings.length, 0, floor.warnings.join('\n'));
      } finally {
        floor.restore();
      }
      reader.manager.close();
    });
  }

  it('counts no lock outside kv-unified, so a lock a level pin overrides through its summary leaves the floor under the plan', async () => {
    const reader = await openReader({ foldingStrategy: 'kv-stable', kvUnified: undefined });
    reader.read(40);
    await reader.drain();
    const locked = reader.manager.getAllMessages()[20]!.id;
    reader.strategy.lockChunk(locked);
    await reader.manager.compile({ maxTokens: 3_000, reserveForResponse: 0 });
    const summaries = (reader.strategy as unknown as { summaries: { level: number; sourceIds: string[] }[] }).summaries;
    const sibling = summaries.find((summary) => summary.level === 1 && summary.sourceIds.includes(locked))?.sourceIds.find((id) => id !== locked);
    assert.ok(sibling, 'premise: the locked message shares an L1');
    const budget = { maxTokens: 20_000, reserveForResponse: 0 };
    reader.manager.pinRange(sibling, sibling, { level: 1 });
    await reader.manager.compile(budget);
    const withLock = reader.manager.getRenderStats()?.planVsActual;
    reader.strategy.unlockChunk(locked);
    await reader.manager.compile(budget);
    const withoutLock = reader.manager.getRenderStats()?.planVsActual;
    assert.ok(withLock?.floorTokens !== undefined && withLock.floorTokens <= withLock.planned, `at or under the plan (${withLock?.floorTokens}, ${withLock?.planned})`);
    assert.strictEqual(withLock.floorTokens, withoutLock?.floorTokens, 'the lock leaves the floor as it is');
    reader.manager.close();
  });

  it('counts a lock under kv-unified, whose constraints the floor takes', async () => {
    const reader = await openReader();
    reader.read(40);
    await reader.drain();
    const budget = { maxTokens: 20_000, reserveForResponse: 0 };
    const floorNow = async () => {
      await reader.manager.compile(budget);
      return reader.manager.getRenderStats()?.planVsActual?.floorTokens;
    };
    const free = await floorNow();
    reader.strategy.lockChunk(reader.manager.getAllMessages()[20]!.id);
    const held = await floorNow();
    assert.ok(free !== undefined && held !== undefined && held > free, `a message held raw raises the floor (${held}, ${free})`);
    reader.manager.close();
  });

  it('keeps the floor where a level pin overrides a lock under kv-stable, as kv-unified refuses the compile for it', async () => {
    const budget = { maxTokens: 20_000, reserveForResponse: 0 };
    const unified = await openReader();
    unified.read(40);
    await unified.drain();
    const first = unified.manager.getAllMessages()[0]!.id;
    unified.strategy.lockChunk(first);
    unified.manager.pinRange(first, first, { level: 2 });
    await assert.rejects(unified.manager.compile(budget), /infeasible/, 'premise: under kv-unified the lock and the pin conflict');
    unified.manager.close();

    const reader = await openReader({ foldingStrategy: 'kv-stable', kvUnified: undefined });
    reader.read(40);
    await reader.drain();
    const id = reader.manager.getAllMessages()[0]!.id;
    const floor = collectFloorWarnings();
    try {
      reader.strategy.lockChunk(id);
      reader.manager.pinRange(id, id, { level: 2 });
      await reader.manager.compile(budget);
      const stats = reader.manager.getRenderStats()?.planVsActual;
      assert.ok(stats?.floorTokens !== undefined, 'the floor is reported');
      assert.ok(stats.floorTokens <= stats.planned, `at or under the plan (${stats.floorTokens} > ${stats.planned})`);
      assert.strictEqual(floor.warnings.length, 0, floor.warnings.join('\n'));
    } finally {
      floor.restore();
    }
    reader.manager.close();
  });

  it('says once that a floor whose computation fails is missing, again when it recurs or the store is opened again, and the compile goes on', async () => {
    const reader = await openReader({ foldingStrategy: 'kv-stable', kvUnified: undefined });
    reader.read(24);
    await reader.drain();
    const budget = { maxTokens: 20_000, reserveForResponse: 0 };
    const forest = CanonicalSummaryForest.prototype as unknown as { minimumTokens: () => unknown };
    const minimumTokens = forest.minimumTokens;
    const breakIt = () => { forest.minimumTokens = () => { throw new Error('the forest broke'); }; };
    const floor = collectFloorWarnings();
    try {
      breakIt();
      await reader.manager.compile(budget);
      await reader.manager.compile(budget);
      const stats = reader.manager.getRenderStats()?.planVsActual;
      assert.ok(stats, 'premise: the compile went on');
      assert.strictEqual(stats.floorTokens, undefined, 'no floor is reported');
      assert.strictEqual(stats.hardBudget, undefined, 'nor the budget beside it');
      assert.strictEqual(floor.warnings.length, 1, `said once over two compiles (${floor.warnings.length})`);
      assert.match(floor.warnings[0]!, /floor not computed.*the forest broke/);
      forest.minimumTokens = () => { throw new Error('the forest broke otherwise'); };
      await reader.manager.compile(budget);
      assert.strictEqual(floor.warnings.length, 2, `another cause is said too (${floor.warnings.length})`);
      forest.minimumTokens = minimumTokens;
      await reader.manager.compile(budget);
      assert.ok(reader.manager.getRenderStats()?.planVsActual?.floorTokens !== undefined, 'premise: the floor is back');
      forest.minimumTokens = () => { throw new Error('the forest broke otherwise'); };
      await reader.manager.compile(budget);
      assert.strictEqual(floor.warnings.length, 3, `said again when it recurs (${floor.warnings.length})`);
      reader.manager.close();
      const reopened = await ContextManager.open({ path: STORE, strategy: reader.strategy, membrane: { complete: async () => { throw new Error('no call expected'); } } as never });
      await reopened.compile(budget);
      assert.strictEqual(floor.warnings.length, 4, `said again for the store opened anew (${floor.warnings.length})`);
      reopened.close();
    } finally {
      forest.minimumTokens = minimumTokens;
      floor.restore();
    }
  });
});

// The relief rule's exclusions: where the merge at the head keeps its usual
// place behind the queued L1s. A store of six unmerged L1s, a merge of them
// queued by hand (mergeThreshold 99 queues none), and closed chunks queued
// after them; each case reads which kind of call the next tick makes.
class OrderProbe extends AutobiographicalStrategy {
  drainMode = false;
  queueMergeOf(sourceIds: string[]): void {
    this.enqueueMerge({ level: 2, sourceIds });
  }
  protected override landsAsPlanned(): boolean {
    return this.drainMode;
  }
}

async function openOrder(opts: { adaptive?: boolean; refuseMerges?: boolean; truncateMerges?: boolean; failFirstMerge?: boolean; drainMode?: boolean } = {}) {
  cleanup();
  const calls: Array<'l1' | 'merge'> = [];
  let mergeFailed = false;
  const membrane = {
    complete: async (request: { messages?: unknown[] }) => {
      const last = JSON.stringify(request.messages?.[request.messages.length - 1] ?? '');
      const merge = /consolidat/i.test(last);
      calls.push(merge ? 'merge' : 'l1');
      if (merge && opts.refuseMerges) return { stopReason: 'refusal', content: [], usage: { input_tokens: 100, output_tokens: 0 } };
      if (merge && opts.truncateMerges) return { stopReason: 'max_tokens', content: [t(`a recollection cut off ${words(2)}`)], usage: { input_tokens: 100, output_tokens: 40 } };
      if (merge && opts.failFirstMerge && !mergeFailed) {
        mergeFailed = true;
        throw Object.assign(new Error('connection reset'), { type: 'network', retryable: true });
      }
      return { stopReason: 'end_turn', content: [t(`a recollection of what happened, ${words(4)}`)], usage: { input_tokens: 100, output_tokens: 40 } };
    },
  };
  const adaptive = opts.adaptive ?? true;
  const strategy = new OrderProbe({
    compressionModel: 'test-compression-model',
    adaptiveResolution: adaptive,
    ...(adaptive ? { foldingStrategy: 'kv-unified', kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } } : {}),
    targetChunkTokens: 100,
    summaryTargetTokens: 40,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    mergeThreshold: 99,
    autoTickOnNewMessage: false,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  strategy.drainMode = opts.drainMode ?? false;
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
  manager.setToolDefinitions(TOOLS);
  let n = 0;
  const read = (reads: number) => {
    for (let k = 0; k < reads; k++, n++) {
      const id = `read-${n}`;
      manager.addMessage('agent', [t('reading on'), { type: 'tool_use', id, name: 'read', input: { offset: n } } as ContentBlock]);
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: id, content: `passage ${n}: ${words(12)}` } as ContentBlock]);
    }
  };
  const tickOnce = async () => { await manager.tick(); await settle(); };
  // About two reads close a chunk.
  read(16);
  for (let k = 0; k < 40 && !manager.isReady(); k++) await tickOnce();
  const l1s = manager.getSummariesInRange({ level: 1 });
  assert.ok(l1s.length >= 6, `premise: six L1s to merge (${l1s.length})`);
  strategy.queueMergeOf(l1s.slice(0, 6).map((summary) => summary.id));
  read(5);
  assert.ok(strategy.getProgressSnapshot().l1QueueLength > 0, 'premise: chunks wait for L1');
  assert.strictEqual(strategy.getProgressSnapshot().mergeQueueLength, 1, 'premise: the merge is queued');
  calls.length = 0;
  return { manager, strategy, calls, tickOnce };
}

describe('The relief rule leaves the usual order where it should (#415)', () => {
  after(cleanup);

  it('puts the queued merge first in the plain case (control)', async () => {
    const probe = await openOrder();
    await probe.tickOnce();
    assert.deepStrictEqual(probe.calls, ['merge']);
    probe.manager.close();
  });

  it('runs the next L1 before a merge the model has refused once', async () => {
    const probe = await openOrder({ refuseMerges: true });
    await probe.tickOnce();
    assert.strictEqual(probe.strategy.getProgressSnapshot().mergeQueueLength, 1, 'premise: the refused merge is still queued');
    await probe.tickOnce();
    assert.deepStrictEqual(probe.calls, ['merge', 'l1'], 'the refused merge is retried only behind the queued L1s');
    probe.manager.close();
  });

  it('runs the next L1 before a merge whose answer was cut off', async () => {
    const probe = await openOrder({ truncateMerges: true });
    await probe.tickOnce();
    assert.strictEqual(probe.strategy.getProgressSnapshot().mergeQueueLength, 1, 'premise: the cut-off merge is still queued');
    await probe.tickOnce();
    assert.deepStrictEqual(probe.calls, ['merge', 'l1'], 'the cut-off merge is retried only behind the queued L1s');
    probe.manager.close();
  });

  it('runs the next L1 before a merge whose call failed, once the pause it caused has passed', async () => {
    const probe = await openOrder({ failFirstMerge: true });
    await assert.rejects(() => probe.tickOnce(), /connection reset/);
    const lane = probe.strategy as unknown as { compressionPause: { backoffUntil: number } | null };
    assert.ok(lane.compressionPause, 'premise: the failure paused the lane');
    assert.strictEqual(probe.strategy.getProgressSnapshot().mergeQueueLength, 1, 'premise: the failed merge is still queued');
    lane.compressionPause.backoffUntil = 0;
    await probe.tickOnce();
    assert.deepStrictEqual(probe.calls, ['merge', 'l1'], 'the failed merge is retried only behind the queued L1s');
    probe.manager.close();
  });

  it('runs the next L1 first under the drain script (landsAsPlanned)', async () => {
    const probe = await openOrder({ drainMode: true });
    await probe.tickOnce();
    assert.deepStrictEqual(probe.calls, ['l1']);
    probe.manager.close();
  });

  it('runs the next L1 first without adaptive resolution', async () => {
    const probe = await openOrder({ adaptive: false });
    await probe.tickOnce();
    assert.deepStrictEqual(probe.calls, ['l1']);
    probe.manager.close();
  });

  it('counts a queued merge holding a held source as no relief', async () => {
    const probe = await openOrder({ drainMode: true });
    // Under the drain script the merge waits behind the L1s, so the chunks
    // compress and the merge stays queued.
    for (let k = 0; k < 40 && probe.strategy.getProgressSnapshot().l1QueueLength > 0; k++) await probe.tickOnce();
    assert.strictEqual(probe.strategy.getProgressSnapshot().mergeQueueLength, 1, 'premise: the merge is still queued');
    const budget = { maxTokens: 20_000, reserveForResponse: 0 };
    await probe.manager.compile(budget);
    const open = probe.manager.getRenderStats()?.planVsActual?.queuedReliefTokens ?? 0;
    assert.ok(open > 0, `premise: the merge alone counts as relief (${open})`);
    const sourceId = (probe.strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }> }).mergeQueue[0]!.sourceIds[0]!;
    (probe.strategy as unknown as { config: { mergeHoldSummaryIds?: string[] } }).config.mergeHoldSummaryIds = [sourceId];
    await probe.manager.compile(budget);
    assert.strictEqual(probe.manager.getRenderStats()?.planVsActual?.queuedReliefTokens, 0, 'a merge tick will drop relieves nothing');
    probe.manager.close();
  });
});

// The burst scenario's geometry: two reads a turn (about a chunk) against one
// call, the lane drained every BURST_LENGTH turns, at a budget the floor fits
// under only while merges keep landing during the bursts. On main at
// fb4cf104, 35 of the 90 compiles refused; with merges taking their turn by
// relief, none did, the plan peaking near 6,050 tokens.
const BURST_TURNS = 90;
const BURST_LENGTH = 30;
const BURST_BUDGET = 7_000;
const BURST_SUMMARY_WORDS = 18;
