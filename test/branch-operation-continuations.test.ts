import { it, mock } from 'node:test';
import { AsyncResource } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import type { StrategyContext } from '../src/types/index.js';

import { observeDrainCompletion } from './_harness/drain-completion.js';

function barrier() { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; }
class Probe extends AutobiographicalStrategy {
  hold?: Promise<void>;
  onInitializeEntered?: () => void;
  async initialize(ctx: StrategyContext) {
    this.onInitializeEntered?.();
    if (this.hold) await this.hold;
    await super.initialize(ctx);
  }
}
// Private seams are invoked only under real installed operation wrappers.
const inside = (s: object): any => s;
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'c12-'));
  const store = JsStore.openOrCreate({ path: dir });
  const raw = new Probe({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 1 });
  const manager = await ContextManager.open({ store, strategy: raw, namespace: 'a' });
  manager.addMessage('user', [{ type: 'text', text: 'hello' }]);
  return { raw, store, manager, close() { manager.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it('terminal drain catch never looks up a failed branch and tolerates a throwing diagnostic sink', async () => {
  const fx = await fixture();
  const branch = fx.store.currentBranch.bind(fx.store);
  let failures = 0;
  const completions: Promise<unknown>[] = [];
  try {
    inside(fx.raw).compressionQueue = [{}];
    Object.defineProperty(fx.raw, 'tick', { configurable: true, value: () => {
      fx.store.currentBranch = () => { throw new Error('store unavailable'); };
      return observeDrainCompletion(Promise.reject(new Error('tick failed')), completions);
    } });
    inside(fx.raw).diag = { error() { failures++; throw new Error('sink unavailable'); } };
    inside(fx.raw).driveSpeculativeDrain({});
    assert.ok(completions.length > 0, 'drain installed its terminal continuation');
    await Promise.all(completions);
    assert.equal(failures, 1, 'original failure must reach diagnostics without querying currentBranch');
  } finally { fx.store.currentBranch = branch; fx.close(); }
});

for (const site of ['repair', 'tick'] as const) {
  it(`${site} continuation stops at lifecycle entry before an initialize override reaches super`, async () => {
    const fx = await fixture(), pause = barrier(), setup = barrier();
    let replacement: Promise<void> | undefined;
    let handed = 0;
    let warnings = 0;
    try {
      fx.raw.setLoadRepairHandler(() => { handed++; });
      inside(fx.raw).diag = { warn() { warnings++; }, error() { warnings++; } };
      // Both continuations start in the real pre-replacement operation scope.
      let pending: Promise<unknown> | undefined;
      let repairCallback: (() => void) | undefined;
      let entered = false;
      if (site === 'repair') {
        const enqueue = globalThis.queueMicrotask;
        try {
          globalThis.queueMicrotask = callback => { repairCallback = AsyncResource.bind(callback); };
          inside(fx.raw).deliverLoadRepair({ stateId: 'x' });
        } finally { globalThis.queueMicrotask = enqueue; }
      } else {
        Object.defineProperty(fx.raw, 'sweepPaidOffQuarantineRecords', { configurable: true, value: () => { entered = true; return pause.wait; } });
        pending = fx.manager.tick();
      }
      assert.ok(site === 'repair' ? repairCallback : entered, `${site} must reach its held seam before replacement`);
      fx.raw.hold = setup.wait;
      const initializing = barrier();
      fx.raw.onInitializeEntered = initializing.release;
      replacement = fx.manager.setStrategy(fx.raw);
      await initializing.wait;
      pause.release();
      if (repairCallback) assert.doesNotThrow(repairCallback, 'scheduled repair callback cannot throw into the host');
      await pending;
      assert.equal(handed, 0);
      assert.equal(warnings, 0, 'stale work must stop, not trip guarded mirrors and reach diagnostics');
    } finally { pause.release(); setup.release(); await replacement; fx.close(); }
  });
}

for (const site of ['drain', 'alarm'] as const) {
  for (const reenter of [false, true]) {
    it(`public ${site} continuation ${reenter ? 'stops at lifecycle entry' : 'does observable work when still current'}`, async () => {
      const fx = await fixture(), pause = barrier(), setup = barrier(), initializing = barrier();
      const raw = inside(fx.raw);
      const completions: Promise<unknown>[] = [];
      let replacement: Promise<void> | undefined;
      let pending: Promise<unknown> | undefined;
      let entered = false, resumed = false, probes = 0, scheduled = 0, reads = 0, errors = 0;
      const probe = site === 'drain' ? 'isBranchIdentityCurrent' : 'isCompressionBranchCurrent';
      const original = raw[probe];
      raw[probe] = function (...args: unknown[]) {
        if (resumed) probes++;
        return Reflect.apply(original, this, args);
      };
      raw.diag = { warn() {}, error() { errors++; } };
      try {
        if (site === 'drain') {
          fx.raw.onPresented = async (_rows, ctx) => {
            raw.compressionQueue = [0, 1];
            raw.driveSpeculativeDrain(ctx);
          };
          fx.raw.tick = () => {
            entered = true;
            // Consume an item but leave more work. No-progress must not mask
            // a lost epoch fence when the held tick resolves.
            raw.compressionQueue.shift();
            raw._drainProgress++;
            return observeDrainCompletion(pause.wait, completions);
          };
          fx.manager.addMessage('user', [{ type: 'text', text: 'start background drain' }]);
          assert.equal(completions.length, 1, 'observe the actual drain continuation');
        } else {
          raw.sweepPaidOffQuarantineRecords = () => { entered = true; return pause.wait; };
          const read = raw.readCompressionQuarantineStatus;
          raw.readCompressionQuarantineStatus = function (...args: unknown[]) {
            reads++;
            return Reflect.apply(read, this, args);
          };
          pending = fx.manager.tick();
        }
        assert.ok(entered, 'public entry reached the held operation');
        if (reenter) {
          fx.raw.hold = setup.wait;
          fx.raw.onInitializeEntered = initializing.release;
          replacement = fx.manager.setStrategy(fx.raw);
          await initializing.wait;
        }
        // Observe scheduling itself, not whether a timer happens to run
        // before a sleep or is later stopped by a second fence.
        const timer = site === 'drain' ? mock.method(globalThis, 'setTimeout', () => { scheduled++; }) : undefined;
        try {
          resumed = true;
          pause.release();
          await pending;
          await Promise.all(completions);
        } finally { timer?.mock.restore(); resumed = false; }
        assert.equal(site === 'drain' ? scheduled : reads, reenter ? 0 : 1);
        if (reenter) {
          assert.equal(probes, 0, 'obsolete work should stop before branch currency probing');
          assert.equal(errors, 0, 'the stale path should be silent');
        } else assert.ok(probes > 0, 'the live path must reach the branch currency probe');
      } finally {
        pause.release(); setup.release();
        await Promise.allSettled([pending, replacement, ...completions]);
        fx.close();
      }
    });
  }
}

it('already-stale checkpoint hygiene is silent, including repeated calls', async () => {
  const fx = await fixture(); let warnings = 0;
  try {
    const source = inside(fx.raw).loadedBranchIdentity;
    await fx.manager.setStrategy(fx.raw);
    inside(fx.raw).diag = { warn() { warnings++; } };
    inside(fx.raw).checkpointCompressionQuarantineIfNeeded(source);
    inside(fx.raw).checkpointCompressionQuarantineIfNeeded(source);
    assert.equal(warnings, 0);
  } finally { fx.close(); }
});

for (const dry of [true, false]) {
  it(`select cleanup does not overwrite or throw into a replacement load (dry=${dry})`, async () => {
    const fx = await fixture(); let replacement: Promise<void> | undefined;
    try {
      const view = inside(fx.manager).createStrategyContext().messageStore;
      const path = inside(fx.raw).selectPath;
      const sentinel = new Error('original selection failure');
      Object.defineProperty(fx.raw, 'selectPath', { configurable: true, value: () => {
        replacement = fx.manager.setStrategy(fx.raw);
        throw sentinel;
      } });
      assert.throws(() => fx.raw.select(view, {} as any, { maxTokens: 10000, reserveForResponse: 100 }, { dryRun: dry }), e => e === sentinel);
      await replacement;
      assert.equal(inside(fx.raw)._dryRunSelect, false);
      Object.defineProperty(fx.raw, 'selectPath', { configurable: true, value: path });
      fx.manager.compile({ maxTokens: 10000, reserveForResponse: 100 });
    } finally { await replacement; fx.close(); }
  });
}

it('preview interrupted by reinitialization releases its latch and temporary configuration', async () => {
  const fx = await fixture(); let replacement: Promise<void> | undefined;
  try {
    const view = inside(fx.manager).createStrategyContext().messageStore;
    const path = inside(fx.raw).selectPath;
    const config = inside(fx.raw).config;
    Object.defineProperty(fx.raw, 'selectPath', { configurable: true, value: () => {
      replacement = fx.manager.setStrategy(fx.raw);
      throw new Error('interrupted preview');
    } });
    assert.throws(() => fx.raw.previewContext(view, {} as any, { maxTokens: 10000, reserveForResponse: 100 }, { recentWindowTokens: 42 }), /interrupted preview/);
    await replacement;
    assert.equal(inside(fx.raw)._previewInFlight, false);
    assert.equal(inside(fx.raw).config, config);
    Object.defineProperty(fx.raw, 'selectPath', { configurable: true, value: path });
    assert.doesNotThrow(() => fx.manager.previewContext({ maxTokens: 10000, reserveForResponse: 100 }));
  } finally { await replacement; fx.close(); }
});

it('detach failure diagnostic tolerates a second throwing protocol lookup and still replaces the strategy', async () => {
  const fx = await fixture(); let armed = false;
  const proxy = new Proxy(fx.raw, { get(target, key, receiver) {
    if (armed && typeof key === 'symbol') throw new Error('protocol unavailable');
    return Reflect.get(target, key, receiver);
  } });
  try {
    await fx.manager.setStrategy(proxy);
    armed = true;
    await fx.manager.setStrategy(new PassthroughStrategy());
    assert.ok(fx.manager.getStrategy() instanceof PassthroughStrategy);
  } finally { armed = false; fx.close(); }
});

it('replacement initialization hands over an old queued repair report once', { timeout: 10_000 }, async () => {
  const fx = await fixture(); let handed = 0;
  const delivered = barrier();
  try {
    fx.raw.setLoadRepairHandler(() => { handed++; delivered.release(); });
    inside(fx.raw).deliverLoadRepair({ stateId: 'x' });
    await fx.manager.setStrategy(fx.raw);
    await delivered.wait;
    assert.equal(handed, 1);
  } finally { fx.close(); }
});

it('reentrant retryAfterMs cannot pause a replacement load', async () => {
  const fx = await fixture(); let replacement: Promise<void> | undefined;
  try {
    const source = inside(fx.raw).loadedBranchIdentity;
    const error = { get retryAfterMs() { replacement = fx.manager.setStrategy(fx.raw); return Infinity; } };
    inside(fx.raw).pauseCompressionLane(source, {}, error, 'l1', 'chunk');
    assert.ok(replacement, 'retryAfterMs getter must start replacement');
    await replacement;
    assert.equal(inside(fx.raw).compressionPause, null);
  } finally { await replacement; fx.close(); }
});

it('final head reset refusal still reports the stored transition and duplicate retry risk', async () => {
  const fx = await fixture();
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  try {
    Object.defineProperty(fx.raw, 'resetHeadWindow', { configurable: true, value: () => { throw revoked.proxy; } });
    await assert.rejects(fx.manager.resetHeadWindow('transition'), (error: Error) => {
      assert.equal(error.cause, revoked.proxy);
      assert.match(error.message, /transition add finished: message .*stored.*another transition message/s);
      return true;
    });
  } finally { fx.close(); }
});

for (const lane of ['compression', 'merge']) {
  it(`an injected ${lane} implementation failure remains observable at tick after replacement`, async () => {
    const fx = await fixture(), started = barrier(), pause = barrier();
    const failure = new Error('original provider failure');
    try {
      const raw = inside(fx.raw);
      raw.config = { ...raw.config, hierarchical: true };
      const ctx = { ...inside(fx.manager).createStrategyContext(), membrane: {} } as StrategyContext;
      if (lane === 'compression') raw.chunks = [{ index: 0, messages: ctx.messageStore.getAll(),
        tokens: 10, startIndex: 0, endIndex: 0, compressed: false }];
      raw.compressionQueue = lane === 'compression' ? [0] : [];
      raw.mergeQueue = lane === 'merge' ? [{ level: 2, sourceIds: [] }] : [];
      for (const member of ['soundQuarantineAlarmIfNeeded', 'sweepCompressionProgressIfDue', 'soundMergeQuarantineAlarmIfNeeded']) {
        Object.defineProperty(fx.raw, member, { configurable: true, value: () => {} });
      }
      Object.defineProperty(fx.raw, lane === 'compression' ? 'compressChunkHierarchical' : 'executeMerge', {
        configurable: true, value: () => { started.release(); return pause.wait.then(() => { throw failure; }); },
      });
      const pending = fx.raw.tick(ctx);
      const rejected = assert.rejects(pending, error => error === failure);
      void rejected.catch(() => {});
      await Promise.race([started.wait, pending.then(() => { throw new Error('lane was not reached'); })]);
      await fx.manager.setStrategy(fx.raw);
      pause.release();
      await rejected;
    } finally { pause.release(); fx.close(); }
  });
}

it('public clear reports uncertainty if its helper completed before load replacement', async () => {
  const fx = await fixture();
  try {
    const clear = inside(fx.raw).clearObservedCompressionQuarantine.bind(fx.raw);
    Object.defineProperty(fx.raw, 'clearObservedCompressionQuarantine', { configurable: true, value: async (...args: unknown[]) => {
      await clear(...args);
      await fx.manager.setStrategy(fx.raw);
      return true;
    } });
    await assert.rejects(fx.raw.clearCompressionRefusalQuarantine(), /clear uncertain:.*earlier writes may have completed/);
  } finally { fx.close(); }
});
