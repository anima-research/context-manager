/** Public notification retries and host-owned health dispatch. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const inside = (value: object): any => value;
for (const drain of [false, true]) {
  it(`legacy add notifications survive a failed mode lookup (${drain ? 'drain' : 'initial delivery'})`, async () => {
    const path = mkdtempSync(join(tmpdir(), 'c19-'));
    const heard: string[] = [];
    let arm = false;
    const strategy = {
      name: 'legacy-notifications',
      checkReadiness() { return { ready: true }; },
      select() { throw new Error('not used'); },
      get onNewMessage() {
        // Fail the adapter's observation, after the append's legacy check.
        if (arm) { arm = false; failMode = true; }
        return async (row: { id: string }) => { heard.push(row.id); };
      },
    };
    let failMode = false;
    const manager = await ContextManager.open({ path, strategy });
    const raw = inside(manager);
    const mode = raw.windowIndex.mode;
    const hookScope = raw.hookScope;
    let failScope = drain;
    let failures = 0;
    raw.diag = { error() {}, warn() {} };
    raw.windowIndex.mode = function () {
      if (failMode) { failMode = false; failures++; throw new Error('mode unavailable'); }
      return mode.call(this);
    };
    raw.hookScope = function () {
      if (failScope) { failScope = false; throw new Error('scope unavailable'); }
      return hookScope.call(this);
    };
    try {
      arm = !drain;
      const first = manager.addMessage('user', [{ type: 'text', text: 'first' }]);
      assert.deepEqual(heard, []);
      // In the drain case the first add queued a known legacy row. Fail the
      // retried adapter lookup, then give a third public notification to retry.
      arm = drain;
      const second = manager.addMessage('user', [{ type: 'text', text: 'second' }]);
      const third = drain ? manager.addMessage('user', [{ type: 'text', text: 'third' }]) : undefined;
      assert.equal(failures, 1, 'the mode observation must actually fail');
      assert.deepEqual(heard, [first, second, ...(third ? [third] : [])]);
      assert.deepEqual(manager.getAllMessages().map(row => row.id), heard, 'each stored row is heard once, in order');
    } finally { manager.close(); rmSync(path, { recursive: true, force: true }); }
  });
}

it('stale public health reads prescribe host dispatch to strategy methods, not nonexistent manager methods', async () => {
  const dispatcher = new AsyncResource('startup-health-dispatch');
  const path = mkdtempSync(join(tmpdir(), 'c19-health-'));
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
  const manager = await ContextManager.open({ path, strategy });
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  strategy.tick = async () => {
    entered();
    await hold;
    const debt = strategy.getCompressionDebt();
    const stranded = strategy.getStrandedSummaries();
    assert.equal(debt.state, 'unknown');
    assert.equal(debt.failure, 'report');
    assert.equal(stranded.summaries, null);
    for (const error of [debt.error, 'error' in stranded ? stranded.error : undefined]) {
      assert.match(error!, /host-owned dispatcher outside the old callback scope/);
      assert.match(error!, /call the strategy's health method/);
      assert.doesNotMatch(error!, /through ContextManager/);
    }
    dispatcher.runInAsyncScope(() => {
      assert.notEqual(strategy.getCompressionDebt().state, 'unknown');
      assert.deepEqual(strategy.getStrandedSummaries(), { summaries: [], tokens: 0 });
    });
  };
  const pending = manager.tick();
  try {
    await started;
    await manager.setStrategy(strategy);
    release();
    await pending;
  } finally { release(); await pending; manager.close(); dispatcher.emitDestroy(); rmSync(path, { recursive: true, force: true }); }
});

it('initialization cannot commit after its final branch-id read starts a newer attempt', async () => {
  const path = mkdtempSync(join(tmpdir(), 'c19-init-'));
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
  const manager = await ContextManager.open({ path, strategy });
  const store = inside(manager).store;
  const currentBranch = store.currentBranch;
  const initialize = strategy.initialize;
  let armed = false, newerEntered = false;
  let replacement: Promise<void> | undefined;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  strategy.initialize = async ctx => { await initialize.call(strategy, ctx); armed = true; };
  store.currentBranch = function () {
    return new Proxy(currentBranch.call(this), { get(target, key, receiver) {
      if (key === 'id' && armed) {
        armed = false;
        strategy.initialize = async ctx => { newerEntered = true; await hold; await initialize.call(strategy, ctx); };
        replacement = manager.setStrategy(strategy);
      }
      return Reflect.get(target, key, receiver);
    } });
  };
  try {
    await assert.rejects(manager.setStrategy(strategy), /superseded/);
    assert.equal(newerEntered, true, 'the competing initialization is held before completion');
    await assert.rejects(manager.compile({ maxTokens: 1000, reserveForResponse: 100 }), /initialization/);
    release();
    await replacement;
    await assert.doesNotReject(manager.compile({ maxTokens: 1000, reserveForResponse: 100 }));
  } finally { armed = false; release(); await replacement; store.currentBranch = currentBranch; manager.close(); rmSync(path, { recursive: true, force: true }); }
});
