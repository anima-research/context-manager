/** Lane ownership uses a real load/store; provider work is explicitly held. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { StrategyContext } from '../src/types/index.js';

const inside = (value: object): any => value;
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'c15-'));
  const store = JsStore.openOrCreate({ path });
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
  const manager = await ContextManager.open({ store, strategy });
  return { store, strategy, manager, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}

for (const lane of ['compression', 'merge'] as const) {
  for (const outcome of ['reject', 'admission', 'resolve'] as const) {
    const failurePoints = lane === 'merge' && outcome !== 'resolve'
      ? ['start', 'settle', 'pause'] as const : ['start', 'settle'] as const;
    for (const failureAt of failurePoints) {
      it(`${lane} joins work and releases its slot when branch reads fail at ${failureAt} (${outcome})`, async () => {
        const fx = await fixture(), entered = barrier(), finish = barrier();
        const raw = inside(fx.strategy);
        const currentBranch = fx.store.currentBranch;
        const providerError = Object.assign(new Error('attempt failed after being held'), outcome === 'admission' ? { type: 'rate_limit', retryable: true, providerAdmission: 'deferred' } : {});
        const observationError = new Error('branch observation unavailable');
        let pending: Promise<void> | undefined;
        let settled = false;
        let observedFailure: unknown;
        let starts = 0;
        let failedReads = 0;
        let failObservation = false;
        if (failureAt === 'pause') Object.defineProperty(providerError, 'retryAfterMs', { get() {
          failObservation = true; // after pauseCompressionLane's first currency check
          return 100;
        } });
        try {
          // Keep unrelated housekeeping out of this lane ownership regression.
          for (const key of ['sweepCompressionProgressIfDue', 'soundMergeQuarantineAlarmIfNeeded', 'checkMergeThreshold']) {
            raw[key] = () => {};
          }
          raw.activeCompressionPause = () => false;
          raw.holdBlockedIds = () => null;
          raw.mergeBlockedByHold = () => false;
          raw.mergeTakesTurnBefore = raw.mergeTakesTurnByRelief = () => false;
          const chunk = { index: 0, messages: [{ id: 'held-source' }], tokens: 1, compressed: false };
          raw.chunks = [chunk];
          raw.compressionQueue = lane === 'compression' ? [0] : [];
          raw.mergeQueue = lane === 'merge' ? [{ level: 2, sourceIds: ['a', 'b'] }] : [];
          raw.config.hierarchical = true;
          const work = async () => {
            starts++;
            failObservation = failureAt === 'start';
            entered.release();
            await finish.wait;
            failObservation = failureAt !== 'pause';
            if (outcome !== 'resolve') throw providerError;
            return false;
          };
          raw.compressChunkHierarchical = raw.executeMerge = work;
          fx.store.currentBranch = function () {
            if (failObservation) { failedReads++; throw observationError; }
            return currentBranch.call(this);
          };
          pending = fx.strategy.tick({ membrane: {}, messageStore: {} } as StrategyContext);
          const observed = pending.then(() => { settled = true; }, error => { settled = true; observedFailure = error; });
          await Promise.race([entered.wait, observed.then(() => { throw observedFailure ?? new Error('tick ended before entering held work'); })]);
          // These microtasks let a premature rejection settle, but completion is
          // always observed below, not inferred from a fixed delay.
          await Promise.resolve(); await Promise.resolve();
          assert.equal(starts, 1);
          assert.equal(settled, false, 'tick must remain joined to the held provider');
          assert.ok(raw.pendingCompression, 'the started work owns the pending slot');
          finish.release();
          await observed;
          assert.ok(failedReads > 0, 'the failure-handling observation seam must run');
          assert.equal(observedFailure, outcome !== 'resolve' ? providerError : observationError);
          assert.equal(raw.pendingCompression, null);
          assert.equal(raw.pendingCompressionWork, null);
          if (outcome !== 'resolve' || lane === 'merge') {
            assert.deepEqual(lane === 'compression' ? raw.compressionQueue : raw.mergeQueue.map(() => 0), [0], 'failed work remains retryable');
          }
          // A normal rebuild can queue more work after a successful L1 call.
          if (lane === 'compression' && outcome === 'resolve') raw.compressionQueue = [0];
          failObservation = false;
          raw.compressChunkHierarchical = raw.executeMerge = async () => { starts++; return false; };
          await fx.strategy.tick({ membrane: {}, messageStore: {} } as StrategyContext);
          assert.equal(starts, 2, 'recovering branch reads must not leave the lane wedged');
        } finally {
          finish.release();
          await pending?.catch(() => {});
          fx.store.currentBranch = currentBranch;
          fx.close();
        }
      });
    }
  }
}

it('an inherited stale status read is unreadable even when the replacement ledger is empty', async () => {
  const fx = await fixture(), entered = barrier(), finish = barrier();
  let status: ReturnType<AutobiographicalStrategy['getCompressionQuarantineStatus']> | undefined;
  let pending: Promise<void> | undefined;
  try {
    fx.strategy.tick = async () => {
      entered.release();
      await finish.wait;
      status = fx.strategy.getCompressionQuarantineStatus();
    };
    pending = fx.manager.tick();
    await entered.wait;
    await fx.manager.setStrategy(fx.strategy);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    finish.release();
    await pending;
    assert.equal(status?.unreadable, true);
  } finally { finish.release(); await pending; fx.close(); }
});

it('onRetracted lookup failure is consumed, not queued ahead of later notifications', async () => {
  const fx = await fixture();
  const raw = inside(fx.manager);
  let lookups = 0, diagnostics = 0, delivered = 0;
  try {
    raw.diag = { error() { diagnostics++; }, warn() {} };
    Object.defineProperty(fx.strategy, 'onRetracted', { configurable: true, get() { lookups++; throw new Error('hook getter failed'); } });
    assert.doesNotThrow(() => raw.tellRetracted([{ id: 'first' }], { removed: true }));
    assert.equal(lookups, 1);
    assert.equal(diagnostics, 1);
    assert.deepEqual(raw.retractedUnheard, []);
    Object.defineProperty(fx.strategy, 'onRetracted', { configurable: true, value() { delivered++; } });
    raw.tellRetracted([{ id: 'second' }], { removed: true });
    assert.equal(delivered, 1);
  } finally { fx.close(); }
});

it('post-append legacy presentation scope failure does not fail addMessage or duplicate the stored row', async () => {
  const fx = await fixture();
  const raw = inside(fx.manager);
  let probes = 0, diagnostics = 0;
  try {
    // Exercise the onNewMessage-only adapter, after the row has landed.
    Object.defineProperty(fx.strategy, 'onPresented', { configurable: true, value: undefined });
    fx.strategy.onNewMessage = async () => {};
    raw.diag = { error() { diagnostics++; }, warn() {} };
    const scope = raw.hookScope;
    raw.hookScope = () => {
      if (fx.manager.getAllMessages().length > 0) { probes++; throw new Error('scope unavailable after append'); }
      return scope.call(raw);
    };
    const id = fx.manager.addMessage('user', [{ type: 'text', text: 'stored once' }]);
    assert.ok(probes > 0);
    assert.equal(diagnostics, 1);
    assert.deepEqual(fx.manager.getAllMessages().map(row => row.id), [id]);
  } finally { fx.close(); }
});

it('public clear reports uncertainty when its completed helper is followed by an unavailable branch read', async () => {
  const fx = await fixture();
  const currentBranch = fx.store.currentBranch;
  let completed = false;
  try {
    inside(fx.strategy).clearObservedCompressionQuarantine = async () => {
      completed = true;
      fx.store.currentBranch = () => { throw new Error('post-clear observation failed'); };
    };
    await assert.rejects(fx.strategy.clearCompressionRefusalQuarantine(), /clear uncertain:.*earlier writes.*inspect the original branch/);
    assert.equal(completed, true);
  } finally { fx.store.currentBranch = currentBranch; fx.close(); }
});
