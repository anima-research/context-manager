/** Public manager paths for failures which the lane-only r15 doubles missed. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StrategyContext } from '../src/types/index.js';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, CompressionWithdrawn } from '../src/index.js';

const inside = (value: object): any => value;
const answer = { content: [{ type: 'text', text: 'A concise synthetic memory of the substantive events.' }],
  stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 12 } };

async function fixture(complete: () => Promise<unknown>) {
  const path = mkdtempSync(join(tmpdir(), 'c15b-'));
  const store = JsStore.openOrCreate({ path });
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0,
    compressionModel: 'offline', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    minChunkCharsForLLM: 0, l1HoldbackChunks: 0, mergeThreshold: 6 });
  const manager = await ContextManager.open({ store, strategy, membrane: { complete } as never });
  return { store, strategy, manager, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}
function populate(manager: ContextManager) {
  for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User',
    [{ type: 'text', text: `MSG-${i} ${'substantive event '.repeat(60)}` }]);
}

for (const [kind, failOnRead] of [['transient', 1], ['transient', 2], ['transient', 3], ['admission', 1], ['withdrawn', 1]] as const) {
  it(`manager tick preserves the actual ${kind} provider error when branch probe ${failOnRead} throws`, async () => {
    const original = kind === 'withdrawn' ? new CompressionWithdrawn('host stopped the call') :
      Object.assign(new Error('provider unavailable'), kind === 'admission' ?
        { type: 'rate_limit', retryable: true, providerAdmission: 'deferred' } : {});
    const secondary = new Error('branch unavailable after provider rejection');
    let calls = 0, failedReads = 0, postProviderReads = 0, failing = false;
    const fx = await fixture(async () => { calls++; failing = true; throw original; });
    const currentBranch = fx.store.currentBranch;
    try {
      populate(fx.manager);
      await fx.manager.compile({ maxTokens: 100000, reserveForResponse: 100 });
      fx.store.currentBranch = function () {
        if (failing && ++postProviderReads >= failOnRead) { failedReads++; throw secondary; }
        return currentBranch.call(this);
      };
      await assert.rejects(fx.manager.tick(), error => {
        assert.equal(error, original, 'public tick must not replace the provider failure');
        assert.equal((error as Error).cause, secondary);
        return true;
      });
      assert.equal(calls, 1, 'the real provider path must run');
      assert.ok(failedReads > 0, 'the post-provider observation must fail');
      assert.equal(inside(fx.strategy).pendingCompression, null);
      failing = false;
      const raw = inside(fx.strategy);
      assert.ok(raw.compressionQueue.length > 0, 'failed L1 remains queued');
      raw.activeCompressionPause = () => false;
      // Recovery must use the normal provider path, not another lane double.
      inside(fx.manager).membrane.complete = async () => { calls++; return answer; };
      await fx.manager.tick();
      assert.ok(calls > 1, 'next public tick retries after branch reads recover');
      assert.ok(raw.summaries.length > 0, 'retry actually lands a summary');
    } finally { failing = false; fx.store.currentBranch = currentBranch; fx.close(); }
  });
}

it('manager tick retries the failed L1 when only the second catch probe becomes unreadable', async () => {
  const original = new Error('failed L1');
  const secondary = new Error('second catch probe failed');
  const fx = await fixture(async () => answer);
  const raw = inside(fx.strategy), currentBranch = fx.store.currentBranch;
  let calls = 0, cleanupProbes = 0, failedReads = 0, failObservation = false;
  let failedChunk: unknown;
  const probe = raw.compressionBranchCurrentForCleanup;
  try {
    populate(fx.manager);
    await fx.manager.compile({ maxTokens: 100000, reserveForResponse: 100 });
    // Isolate the lane catch from the real provider's own catch probes.
    raw.compressChunkHierarchical = async (chunk: unknown) => { calls++; failedChunk = chunk; throw original; };
    raw.compressionBranchCurrentForCleanup = function (...args: unknown[]) {
      cleanupProbes++;
      if (cleanupProbes === 2) failObservation = true;
      return Reflect.apply(probe, this, args);
    };
    fx.store.currentBranch = function () {
      if (failObservation) { failedReads++; throw secondary; }
      return currentBranch.call(this);
    };
    await assert.rejects(fx.manager.tick(), error => error === original);
    assert.equal(calls, 1);
    assert.ok(cleanupProbes >= 2 && failedReads > 0, 'first catch probe succeeds, second fails');
    assert.equal(raw.pendingCompression, null);
    failObservation = false;
    raw.compressionBranchCurrentForCleanup = probe;
    raw.compressChunkHierarchical = async (chunk: { compressed: boolean }) => {
      assert.equal(chunk, failedChunk, 'the retry must be the failed chunk, not other queued work');
      calls++; chunk.compressed = true;
    };
    await fx.manager.tick();
    assert.ok(calls > 1, 'a fresh manager tick must find and retry the failed L1 without a rebuild');
  } finally { failObservation = false; fx.store.currentBranch = currentBranch; fx.close(); }
});

it('public manager merge retains the provider error and retries when the rejection probe cannot read the branch', async () => {
  const original = new Error('merge provider unavailable'), secondary = new Error('merge branch unavailable');
  let failCall = false, failObservation = false, failedReads = 0, calls = 0;
  const fx = await fixture(async () => {
    calls++;
    if (failCall) { failObservation = true; throw original; }
    return answer;
  });
  const currentBranch = fx.store.currentBranch, raw = inside(fx.strategy);
  try {
    // Separate additions/compiles close enough actual chunks for a real merge.
    for (let round = 0; round < 3; round++) {
      populate(fx.manager);
      await fx.manager.compile({ maxTokens: 100000, reserveForResponse: 100 });
      await fx.manager.tick();
    }
    assert.ok(raw.summaries.length >= 2, 'real L1 summaries must exist before merging');
    raw.compressionQueue = [];
    const sources = raw.summaries.filter((entry: { level: number }) => entry.level === 1).map((entry: { id: string }) => entry.id);
    raw.mergeQueue = [{ level: 2, sourceIds: sources }];
    fx.store.currentBranch = function () {
      if (failObservation) { failedReads++; throw secondary; }
      return currentBranch.call(this);
    };
    failCall = true;
    const before = calls;
    await assert.rejects(fx.manager.tick(), error => {
      assert.equal(error, original);
      assert.equal((error as Error).cause, secondary);
      return true;
    });
    assert.equal(calls, before + 1, 'the real merge provider must reject');
    assert.ok(failedReads > 0);
    assert.equal(raw.pendingCompression, null);
    assert.equal(raw.mergeQueue.length, 1);
    failObservation = failCall = false;
    raw.activeCompressionPause = () => false;
    await fx.manager.tick();
    assert.equal(calls, before + 2, 'the next manager tick retries the real merge');
    assert.ok(raw.summaries.some((entry: { level: number }) => entry.level === 2));
  } finally { failObservation = false; fx.store.currentBranch = currentBranch; fx.close(); }
});

it('unsupported direct arrow initialize may invalidate a load; manager setStrategy recovers it', async () => {
  const path = mkdtempSync(join(tmpdir(), 'c15b-life-'));
  let context!: StrategyContext;
  class ArrowLifecycle extends AutobiographicalStrategy {
    override initialize = async (ctx: StrategyContext) => { context = ctx; await super.initialize(ctx); };
  }
  const strategy = new ArrowLifecycle({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
  const manager = await ContextManager.open({ path, strategy });
  try {
    assert.doesNotThrow(() => strategy.getSummary('missing'));
    await assert.rejects(strategy.initialize(context), /lifecycle setup requires its own scope/);
    assert.throws(() => strategy.getSummary('missing'), /requires reinitialization/);
    await manager.setStrategy(strategy);
    assert.doesNotThrow(() => strategy.getSummary('missing'));
    await manager.tick();
  } finally { manager.close(); rmSync(path, { recursive: true, force: true }); }
});
