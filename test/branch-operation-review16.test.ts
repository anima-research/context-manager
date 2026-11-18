/** Offline real-store regressions for review 16; provider and observation seams are explicit. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import { markStoreBranchSwitch, observeStoreBranch } from '../src/branch-generation.js';
import type { StrategyContext } from '../src/types/index.js';
const inside = (value: object): any => value;
const answer = { content: [{ type: 'text', text: 'A concise synthetic memory of substantive events.' }], stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 12 } };
async function fixture(complete: () => Promise<unknown> = async () => answer) {
  const path = mkdtempSync(join(tmpdir(), 'c16-'));
  const store = JsStore.openOrCreate({ path });
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0,
    compressionModel: 'offline', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    minChunkCharsForLLM: 0, l1HoldbackChunks: 0, mergeThreshold: 99 });
  const manager = await ContextManager.open({ store, strategy, membrane: { complete } as never });
  const raw = inside(strategy);
  return { store, strategy, raw, manager, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}
async function populate(manager: ContextManager) {
  for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `MSG-${i} ${'substantive event '.repeat(60)}` }]);
  await manager.compile({ maxTokens: 100000, reserveForResponse: 100 });
}
function barrier() { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; }

it('1: secondary merge rejection probe cannot turn unknown currency into success', async () => {
  const fx = await fixture(); const branch = fx.store.currentBranch;
  const original = Object.assign(new Error('request rejected'), { type: 'invalid_request' }) as Error & { type: string };
  try {
    for (const key of ['sweepCompressionProgressIfDue', 'soundMergeQuarantineAlarmIfNeeded', 'checkMergeThreshold']) fx.raw[key] = () => {};
    fx.raw.mergeQueue = [{ level: 2, sourceIds: ['a', 'b'] }];
    fx.raw.mergeBlockedByHold = () => false;
    let unavailable = false;
    fx.raw.executeMerge = async () => { unavailable = true; throw original; };
    let probes = 0;
    fx.raw.compressionBranchCurrentForCleanup = () => ++probes === 1 ? true : undefined;
    // Keep the real preservation helper; fail its underlying observation.
    const secondary = new Error('secondary observation unavailable');
    fx.store.currentBranch = function () {
      if (unavailable) throw secondary;
      return branch.call(this);
    };
    await assert.rejects(fx.manager.tick(), error => error === original);
    assert.equal(original.cause, secondary);
    assert.equal(fx.raw.pendingCompression, null);
    assert.equal(fx.raw.mergeQueue.length, 1);
  } finally { fx.store.currentBranch = branch; fx.close(); }
});

it('2: an unavailable post-landing merge-discovery probe cannot fail a persisted L1', async () => {
  const fx = await fixture(); const probe = fx.raw.isCompressionBranchCurrent;
  let landed = false, failedReads = 0, diagnostics = 0;
  try {
    await populate(fx.manager);
    const clear = fx.raw.clearQuarantineForCompressedChunk;
    fx.raw.clearQuarantineForCompressedChunk = async function (...args: unknown[]) { await Reflect.apply(clear, this, args); landed = true; };
    fx.raw.isCompressionBranchCurrent = function (...args: unknown[]) {
      if (landed && failedReads++ === 0) throw new Error('post-landing observation unavailable');
      return Reflect.apply(probe, this, args);
    };
    fx.raw.diag = { warn() { diagnostics++; }, error() { throw new Error('successful L1 must not enter failure accounting'); } };
    await fx.manager.tick();
    assert.ok(fx.raw.summaries.length > 0);
    assert.ok(fx.raw.chunkRecords.some((record: any) => record.compressed));
    assert.equal(fx.raw.compressionPause, null);
    assert.ok(diagnostics > 0);
  } finally { fx.close(); }
});

for (const kind of ['transient', 'rejection'] as const) {
  it(`5: ${kind} error survives progress persistence failure`, async () => {
    const original = Object.assign(new Error('provider failure'), kind === 'rejection' ? { type: 'invalid_request' } : {});
    const secondary = new Error('progress branch probe unavailable');
    const fx = await fixture(async () => { throw original; }); let seam = 0;
    try {
      await populate(fx.manager);
      fx.raw.recordCompressionFamilyProgress = () => { seam++; throw secondary; };
      await assert.rejects(fx.manager.tick(), error => { assert.equal(error, original); assert.equal((error as Error).cause, secondary); return true; });
      assert.ok(seam > 0);
      assert.equal(fx.raw.pendingCompression, null);
    } finally { fx.close(); }
  });
}

for (const branch of ['unknown', 'moved'] as const) {
  it(`4: coalesced waiter exposes producer failure when its branch is ${branch}`, async () => {
    const entered = barrier(), finish = barrier(), original = new Error('producer failure');
    const fx = await fixture(async () => { entered.release(); await finish.wait; throw original; });
    const waiter = new AutobiographicalStrategy(inside(fx.strategy).config);
    let producer: Promise<void> | undefined, joined: Promise<void> | undefined;
    try {
      await populate(fx.manager);
      const manager2 = await ContextManager.open({ store: fx.store, strategy: waiter, membrane: inside(fx.manager).membrane });
      try {
        producer = fx.manager.tick(); const observedProducer = producer.catch(error => error);
        await entered.wait;
        const raw = inside(waiter), probe = raw.isCompressionBranchCurrent, joinEntered = barrier();
        const gate = raw.durableQuarantineFor;
        raw.durableQuarantineFor = function (...args: unknown[]) {
          const result = Reflect.apply(gate, this, args);
          assert.equal(result, undefined);
          joinEntered.release();
          return result;
        };
        let awaiting = false;
        raw.isCompressionBranchCurrent = function (...args: unknown[]) {
          if (awaiting) { if (branch === 'unknown') throw new Error('waiter observation failed'); return false; }
          return Reflect.apply(probe, this, args);
        };
        joined = manager2.tick(); const observed = joined.catch(error => error);
        // No await separates this last preflight gate and the in-flight join.
        await joinEntered.wait;
        awaiting = true;
        finish.release();
        assert.equal(await observed, original);
        assert.equal(await observedProducer, original);
      } finally { manager2.close(); }
    } finally { finish.release(); await producer?.catch(() => {}); await joined?.catch(() => {}); fx.close(); }
  });
}

it('6: stale gateway refusal gives partial-write and fresh-dispatch guidance', async () => {
  const fx = await fixture();
  try {
    fx.raw.isBranchIdentityCurrent = () => false;
    assert.throws(() => fx.raw.requireBranchMutation('write'), /earlier writes.*inspect the original branch.*ContextManager/);
  } finally { fx.close(); }
});

for (const throwingSink of [false, true]) it(`13: an unknown pause observation emits a diagnostic without masking the provider failure (sinkThrows=${throwingSink})`, async () => {
  const fx = await fixture(); let diagnostics = 0;
  try {
    fx.raw.diag = { warn() { diagnostics++; if (throwingSink) throw new Error('diagnostic sink failed'); } };
    fx.raw.compressionBranchCurrentForCleanup = () => undefined;
    fx.raw.pauseCompressionLane(fx.raw.loadedBranchIdentity, {}, new Error('provider failed'), 'l1', 'chunk');
    assert.equal(diagnostics, 1);
    assert.equal(fx.raw.compressionPause, null);
  } finally { fx.close(); }
});

for (const lane of ['l1', 'merge']) {
  it(`7: ${lane} pending slot belongs to the unchanged load after an override fails before super`, async () => {
    const path = mkdtempSync(join(tmpdir(), 'c16-load-')), entered = barrier(), finish = barrier();
    let fail = false;
    class FailingInitialize extends AutobiographicalStrategy {
      override async initialize(ctx: StrategyContext) { if (fail) throw new Error('before super'); await super.initialize(ctx); }
    }
    const strategy = new FailingInitialize({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
    const manager = await ContextManager.open({ path, strategy, membrane: {} as never }), raw = inside(strategy);
    let pending: Promise<void> | undefined;
    try {
      for (const key of ['sweepCompressionProgressIfDue', 'soundMergeQuarantineAlarmIfNeeded', 'checkMergeThreshold']) raw[key] = () => {};
      raw.holdBlockedIds = () => null; raw.mergeBlockedByHold = () => false;
      raw.chunks = [{ index: 0, messages: [{ id: 'source' }], compressed: false }];
      raw.compressionQueue = lane === 'l1' ? [0] : [];
      raw.mergeQueue = lane === 'merge' ? [{ level: 2, sourceIds: ['a', 'b'] }] : [];
      raw.compressChunkHierarchical = raw.executeMerge = async () => { entered.release(); await finish.wait; return false; };
      pending = manager.tick(); const observed = pending.catch(() => {});
      await entered.wait;
      fail = true;
      await assert.rejects(manager.setStrategy(strategy), /before super/);
      finish.release(); await observed;
      assert.equal(raw.pendingCompression, null);
      assert.equal(raw.pendingCompressionWork, null);
      fail = false;
      await manager.setStrategy(strategy);
      await manager.tick();
    } finally { finish.release(); await pending?.catch(() => {}); manager.close(); rmSync(path, { recursive: true, force: true }); }
  });
}

for (const operation of ['switchBranch', 'fork'] as const) {
  it(`8: ${operation} rejects a requested B superseded during bookkeeping by C`, async () => {
    const fx = await fixture(), branch = fx.store.currentBranch;
    try {
      fx.store.createBranchAt('B', 'main', fx.store.currentSequence());
      fx.store.createBranchAt('C', 'main', fx.store.currentSequence());
      let armed = true;
      fx.store.currentBranch = function () {
        const result = branch.call(this);
        if (armed && result.name === 'B') { armed = false; this.switchBranch('C'); markStoreBranchSwitch(this); }
        return result;
      };
      if (operation === 'fork') fx.store.deleteBranch('B');
      await assert.rejects(fx.manager[operation]('B'), /supersed|requested B/i);
      assert.equal(branch.call(fx.store).name, 'C');
    } finally { fx.store.currentBranch = branch; fx.close(); }
  });
}

it('9/15: unstable fork bookkeeping blocks mutations and identifies the created branch and recovery', async () => {
  const fx = await fixture(), branch = fx.store.currentBranch;
  try {
    let nested = false;
    fx.store.currentBranch = function () {
      const result = branch.call(this);
      if (!nested && result.name !== 'main') {
        nested = true;
        try { markStoreBranchSwitch(this); } finally { nested = false; }
      }
      return result;
    };
    await assert.rejects(fx.manager.fork('created-B'), /created-B.*earlier.*inspect.*retry/i);
    fx.store.currentBranch = branch;
    assert.throws(() => fx.manager.addMessage('User', [{ type: 'text', text: 'must be blocked' }]), /requires successful strategy initialization/);
    await fx.manager.setStrategy(fx.strategy);
    fx.manager.addMessage('User', [{ type: 'text', text: 'recovered' }]);
  } finally { fx.store.currentBranch = branch; fx.close(); }
});

for (const observe of [observeStoreBranch, markStoreBranchSwitch]) {
  it(`14: ${observe.name} reconciles even when a nested record matches a stale outer name`, async () => {
    const fx = await fixture(), branch = fx.store.currentBranch;
    try {
      fx.store.createBranchAt('B', 'main', fx.store.currentSequence());
      let armed = true;
      fx.store.currentBranch = function () {
        const captured = branch.call(this);
        if (armed) { armed = false; markStoreBranchSwitch(this); this.switchBranch('B'); }
        return captured;
      };
      assert.equal(observe(fx.store).name, 'B');
    } finally { fx.store.currentBranch = branch; fx.close(); }
  });
}

it('10: a stored legacy presentation is deferred when scope observation fails', async () => {
  const fx = await fixture(); const manager = inside(fx.manager); let heard = 0;
  try {
    Object.defineProperty(fx.strategy, 'onPresented', { configurable: true, value: undefined });
    fx.strategy.onNewMessage = async () => { heard++; };
    manager.diag = { error() {}, warn() {} };
    const scope = manager.hookScope;
    let failedObservations = 0;
    manager.hookScope = () => {
      // An old infinite drain escapes at ten so the regression fails, not hangs.
      if (++failedObservations >= 10) return scope.call(manager);
      throw new Error('scope unavailable');
    };
    const id = fx.manager.addMessage('User', [{ type: 'text', text: 'stored' }]);
    assert.equal(heard, 0);
    assert.ok(manager.presentedUnheard.has(id));
    fx.manager.addMessage('User', [{ type: 'text', text: 'pending too' }]);
    assert.equal(heard, 0);
    assert.ok(failedObservations < 10, 'failed drain must stop instead of retrying its own requeue');
    assert.equal(manager.presentedUnheard.size, 2);
    manager.hookScope = scope;
    fx.manager.addMessage('User', [{ type: 'text', text: 'next' }]);
    assert.equal(heard, 3);
    assert.equal(manager.presentedUnheard.size, 0);
  } finally { fx.close(); }
});

it('11/17: immutable name remains readable but stale report reads request a fresh dispatch', async () => {
  const fx = await fixture(), entered = barrier(), finish = barrier();
  let pending: Promise<void> | undefined;
  try {
    let name: string | undefined, debt: any, stranded: any;
    fx.strategy.tick = async () => { entered.release(); await finish.wait; name = fx.strategy.name; debt = fx.strategy.getCompressionDebt(); stranded = fx.strategy.getStrandedSummaries(); };
    pending = fx.manager.tick(); const observed = pending.catch(error => error);
    await entered.wait; await fx.manager.setStrategy(fx.strategy); finish.release();
    assert.equal(await observed, undefined);
    assert.equal(name, 'autobiographical');
    for (const report of [debt, stranded]) {
      assert.match(report.error, /obsolete|stale/);
      assert.match(report.error, /host-owned dispatcher outside the old callback scope/);
      assert.match(report.error, /call the strategy's health method on the current load/);
      assert.doesNotMatch(report.error, /through ContextManager/);
      assert.doesNotMatch(report.error, /fault in context-manager/);
    }
  } finally { finish.release(); await pending?.catch(() => {}); fx.close(); }
});

for (const unreadable of [false, true]) it(`16: an active alarm sweeps at most once per interval even when maintenance fails (unreadable=${unreadable})`, async () => {
  const fx = await fixture(); let sweeps = 0;
  try {
    fx.raw.config.quarantineAlarmIntervalMs = 3_600_000;
    fx.raw.quarantineAlarmActive = true;
    fx.raw.quarantineAlarmScope = { ns: 'default', branch: 'main' };
    fx.raw.readCompressionQuarantineStatus = () => ({ status: { count: 1, keys: ['held'], spans: [], ...(unreadable ? { unreadable: true } : {}) }, error: new Error('status unavailable') });
    fx.raw.sweepPaidOffQuarantineRecords = async () => { sweeps++; };
    fx.raw.diag = { error() {}, warn() {} };
    await fx.raw.soundQuarantineAlarmIfNeeded();
    await fx.raw.soundQuarantineAlarmIfNeeded();
    assert.equal(sweeps, 1);
  } finally { fx.close(); }
});

it('18: a one-off sweep observation failure is diagnosed even when later status reads recover', async () => {
  const fx = await fixture(); let diagnostics = 0;
  try {
    const probe = fx.raw.isCompressionBranchCurrent; let calls = 0;
    fx.raw.isCompressionBranchCurrent = function (...args: unknown[]) { if (++calls === 1) throw new Error('sweep observation failed once'); return Reflect.apply(probe, this, args); };
    fx.raw.diag = { warn() { diagnostics++; } };
    await fx.raw.sweepPaidOffQuarantineRecords(fx.raw.loadedBranchIdentity);
    assert.equal(diagnostics, 1);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
  } finally { fx.close(); }
});

it('1: a split-window deferral is rethrown, not silently dropped, when its later probe is unknown', async () => {
  const fx = await fixture(), branch = fx.store.currentBranch;
  let unavailable = false;
  try {
    await populate(fx.manager);
    fx.raw.splitCallTimes = [Date.now()];
    const original = fx.raw.splitWindowWait(1, 1, 600000);
    assert.ok(original, 'native window must produce its actual no-call deferral');
    const probe = fx.raw.compressionBranchCurrentForCleanup;
    let calls = 0;
    fx.raw.compressionBranchCurrentForCleanup = function (...args: unknown[]) {
      if (++calls >= 2) unavailable = true;
      return Reflect.apply(probe, this, args);
    };
    fx.store.currentBranch = function () { if (unavailable) throw new Error('late split observation unavailable'); return branch.call(this); };
    fx.raw.compressChunkHierarchical = async () => { throw original; };
    await assert.rejects(fx.manager.tick(), error => error === original);
    assert.equal(fx.raw.pendingCompression, null);
    assert.ok(fx.raw.compressionQueue.length > 0);
  } finally { unavailable = false; fx.store.currentBranch = branch; fx.close(); }
});

it('5: carrier-rejection accounting also retains the transport error if progress persistence fails', async () => {
  const original = Object.assign(new Error('invalid thinking block signature'), { type: 'invalid_request' });
  const secondary = new Error('carrier progress unavailable');
  const fx = await fixture(async () => { throw original; }); let seam = 0;
  try {
    await populate(fx.manager);
    const prepare = fx.raw.prepareCompressionAhead;
    fx.raw.prepareCompressionAhead = function (...args: unknown[]) {
      const request = Reflect.apply(prepare, this, args) as any;
      request.messages[0].content.unshift({ type: 'thinking', thinking: 'synthetic carrier', signature: 'synthetic' });
      return request;
    };
    fx.raw.recordCompressionFamilyProgress = () => { seam++; throw secondary; };
    await assert.rejects(fx.manager.tick(), error => { assert.ok(error === original, 'transport rejection must remain primary'); assert.equal((error as Error).cause, secondary); return true; });
    assert.ok(seam > 0);
  } finally { fx.close(); }
});


it('an unreadable presentation mode does not grant legacy delivery on another branch', async () => {
  const fx = await fixture(); const manager = inside(fx.manager); let heard = 0;
  const mode = manager.windowIndex.mode;
  try {
    Object.defineProperty(fx.strategy, 'onPresented', { configurable: true, value: undefined });
    fx.strategy.onNewMessage = async () => { heard++; };
    manager.diag = { error() {}, warn() {} };
    const id = fx.manager.addMessage('User', [{ type: 'text', text: 'shared record' }]);
    heard = 0;
    const row = manager.createStrategyContext().messageStore.get(id);
    manager.windowIndex.mode = () => { throw new Error('mode unavailable'); };
    assert.equal(manager.tellPresented([row]), false);
    assert.equal(manager.presentedUnheard.get(id), false, 'unknown mode cannot confer legacy eligibility');
    manager.windowIndex.mode = mode;
    fx.store.createBranchAt('other-legacy', 'main', fx.store.currentSequence());
    await fx.manager.switchBranch('other-legacy');
    assert.equal(heard, 0);
  } finally { manager.windowIndex.mode = mode; fx.close(); }
});

it('paid-off sweep warns when active holds cannot be checked against chunk data', async () => {
  const fx = await fixture(); let diagnostics = 0;
  try {
    fx.raw.readCompressionQuarantineProjection = () => new Map([['held', {}]]);
    const get = fx.store.getStateJson;
    fx.store.getStateJson = function (id: string) {
      return id === fx.raw.chunksStateId ? [] : get.call(this, id);
    };
    fx.raw.diag = { warn(line: string) { diagnostics++; assert.match(line, /chunk records unavailable or empty.*holds retained.*not completed/); } };
    await fx.raw.sweepPaidOffQuarantineRecords(fx.raw.loadedBranchIdentity);
    assert.equal(diagnostics, 1);
  } finally { fx.close(); }
});
