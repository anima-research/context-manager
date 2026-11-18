/** Small review regressions; real stores, no host/provider qualification. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const inside = (value: object): any => value;
async function fixture(forward = false) {
  const path = mkdtempSync(join(tmpdir(), 'c14-'));
  const store = JsStore.openOrCreate({ path });
  const raw = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 1 });
  const strategy = forward ? new Proxy(raw, { get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) : raw;
  let manager: ContextManager;
  try { manager = await ContextManager.open({ store, strategy }); }
  catch (error) { store.close(); rmSync(path, { recursive: true, force: true }); throw error; }
  return { raw, store, manager, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}

it('a function-binding forwarding proxy initializes, compiles and fences an old callback', async () => {
  const fx = await fixture(true);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let old: Promise<void> | undefined;
  let entered = false;
  try {
    // Late instance functions must still receive the manager's authoritative boundary.
    fx.raw.tick = async () => { entered = true; await wait; fx.raw.resetHeadWindow('obsolete'); };
    old = fx.manager.tick();
    const refused = assert.rejects(old, /stale|reinitializ/);
    await fx.manager.setStrategy(fx.manager.getStrategy());
    release();
    await refused;
    assert.equal(entered, true, 'the old callback must have entered');
    fx.manager.addMessage('user', [{ type: 'text', text: 'current' }]);
    await fx.manager.compile();
    assert.notEqual(inside(fx.raw).headWindowStartId, 'obsolete');
  } finally { release(); await old?.catch(() => {}); fx.close(); }
});

for (const replacement of ['fork', 'switchBranch'] as const) {
  it(`the callback's own continuation after awaiting ${replacement} retains its old origin`, async () => {
    const fx = await fixture();
    let entered = false, replaced = false;
    try {
      fx.raw.tick = async () => {
        entered = true;
        if (replacement === 'fork') await fx.manager.fork('next');
        else await fx.manager.switchBranch('main');
        replaced = true;
        fx.raw.resetHeadWindow('obsolete');
      };
      await assert.rejects(fx.manager.tick(), /stale|reinitializ/);
      assert.equal(entered, true);
      assert.equal(replaced, true, 'replacement must complete before the refused continuation');
      // Work deliberately dispatched from the host's context is fresh.
      fx.raw.resetHeadWindow('fresh');
      assert.equal(inside(fx.raw).headWindowStartId, 'fresh');
    } finally { fx.close(); }
  });
}

it('an alarm superseded during its status read cannot change shared episode metadata or notify', async () => {
  const fx = await fixture();
  let replacement: Promise<void> | undefined;
  let notifications = 0;
  try {
    fx.raw.setQuarantineAlarmHandler(() => { notifications++; });
    inside(fx.raw).quarantineAlarmActive = true;
    inside(fx.raw).quarantineAlarmScope = { ns: 'default', branch: 'main' };
    Object.defineProperty(fx.raw, 'sweepPaidOffQuarantineRecords', { configurable: true, value: async () => {} });
    Object.defineProperty(fx.raw, 'readCompressionQuarantineStatus', { configurable: true, value: () => {
      replacement = fx.manager.setStrategy(fx.raw);
      return { status: { count: 0, keys: [], spans: [] } };
    } });
    await inside(fx.raw).soundQuarantineAlarmIfNeeded();
    assert.ok(replacement, 'status read must start replacement');
    await replacement;
    assert.equal(inside(fx.raw).quarantineAlarmActive, true);
    assert.equal(notifications, 0);
  } finally { await replacement; fx.close(); }
});

it('post-write presentation protocol failure is contained and the stored message ID is returned', async () => {
  const fx = await fixture();
  let armed = false;
  let replacement: Promise<void> | undefined;
  let diagnostics = 0;
  const proxy = new Proxy(fx.raw, { get(target, key, receiver) {
    if (armed && typeof key === 'symbol' && fx.manager.getAllMessages().length > 0) {
      armed = false;
      replacement = fx.manager.setStrategy(proxy);
    }
    return Reflect.get(target, key, receiver);
  } });
  try {
    await fx.manager.setStrategy(proxy);
    inside(fx.manager).diag = { error() { diagnostics++; }, warn() {} };
    armed = true;
    const id = fx.manager.addMessage('user', [{ type: 'text', text: 'stored exactly once' }]);
    assert.ok(replacement, 'post-write protocol lookup must start the replacement race');
    await replacement;
    assert.ok(id);
    assert.equal(fx.manager.getAllMessages().length, 1);
    assert.equal(fx.manager.getAllMessages()[0].id, id);
    assert.equal(diagnostics, 1);
  } finally { armed = false; await replacement; fx.close(); }
});

for (const site of ['progress', 'merge-retained', 'merge-quarantined'] as const) {
  for (const seam of ['writer-return', 'sync-getter'] as const) {
    it(`${site} does not dispatch sync after reinitialization at ${seam}`, async () => {
      const fx = await fixture();
      let replacement: Promise<void> | undefined;
      let syncs = 0;
      const writer = fx.store.setStateJson;
      const sync = fx.store.sync;
      const replace = () => { replacement = fx.manager.setStrategy(fx.raw); };
      try {
        if (seam === 'writer-return') fx.store.setStateJson = function (...args) {
          const result = writer.apply(this, args);
          fx.store.setStateJson = writer; // only the operation's first write reenters
          replace();
          return result;
        };
        Object.defineProperty(fx.store, 'sync', { configurable: true, get() {
          if (seam === 'sync-getter' && !replacement) replace();
          return () => { syncs++; };
        } });
        if (site === 'progress') {
          assert.throws(() => inside(fx.raw).writeCompressionFamilyProgress(new Map(), inside(fx.raw).loadedBranchIdentity), /stale|reinitializ/);
        } else {
          const merge = { level: 2, sourceIds: ['one', 'two'] };
          inside(fx.raw).mergeQueue = [merge];
          inside(fx.raw).config.mergeAttemptLimit = site === 'merge-quarantined' ? 1 : 5;
          assert.throws(() => inside(fx.raw).recordMergeRejection(merge, { outcome: 'refusal', requestHash: 'x' }), /stale|reinitializ/);
        }
        assert.ok(replacement, 'the reentrant seam must have run');
        assert.equal(syncs, 0, 'obsolete work must not dispatch sync');
        await replacement;
      } finally {
        fx.store.setStateJson = writer;
        Object.defineProperty(fx.store, 'sync', { configurable: true, writable: true, value: sync });
        await replacement;
        fx.close();
      }
    });
  }
}
