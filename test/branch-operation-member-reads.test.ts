/** Manager-owned lookups can start async work BEFORE returning a method. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import { callStrategy } from '../src/branch-operation-scope.js';
import type { SummaryEntry } from '../src/types/index.js';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
class Probe extends AutobiographicalStrategy {
  commit(id = 'from-A') {
    this.pushSummary({ id, level: 1, sourceLevel: 0, sourceIds: ['a'],
      sourceRange: { first: 'a', last: 'a' }, content: id, tokens: 1, created: 1 });
  }
  commitAtWriter(store: JsStore) {
    // No loaded mirror read before the final library-owned writer.
    (this as unknown as { branchMutation(s: JsStore, method: string, id: string, v: SummaryEntry): void })
      .branchMutation(store, 'appendToStateJson', 'a/autobio:summaries', {
        id: 'from-A', level: 1, sourceLevel: 0, sourceIds: ['a'],
        sourceRange: { first: 'a', last: 'a' }, content: 'A', tokens: 1, created: 1,
      });
  }
}
const config = { autoTickOnNewMessage: false };
const budget = { maxTokens: 10000, reserveForResponse: 100 };
const text = [{ type: 'text' as const, text: 'A' }];
type Shape = 'accessor' | 'proxy-get' | 'proxy-has' | 'protocol-get';

/** Only library entrypoints write. The getter/trap itself only schedules work. */
function watch(raw: Probe, shape: Shape, member: string, value: unknown, launch: () => void) {
  let enabled = false;
  let armed = false;
  const trigger = () => { if (enabled && armed) { armed = false; launch(); } };
  const original = Object.getOwnPropertyDescriptor(raw, member);
  if (shape === 'accessor') Object.defineProperty(raw, member, {
    configurable: true,
    get() { trigger(); return enabled ? value : original?.value; },
  });
  const strategy = shape === 'accessor' ? raw : new Proxy(raw, {
    get(target, key, receiver) {
      if (shape === 'protocol-get' && typeof key === 'symbol') trigger();
      if (shape === 'proxy-get' && key === member) {
        trigger();
        if (enabled) return value;
      }
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (shape === 'proxy-has' && key === member) {
        trigger();
        if (enabled) return false;
      }
      return Reflect.has(target, key);
    },
  });
  return {
    strategy,
    arm() { enabled = true; armed = true; },
    disable() { enabled = false; },
    restore() {
      enabled = false;
      if (shape === 'accessor') {
        if (original) Object.defineProperty(raw, member, original);
        else Reflect.deleteProperty(raw, member);
      }
    },
  };
}
async function fixture(raw: Probe, strategy: Probe = raw) {
  const dir = mkdtempSync(join(tmpdir(), 'mr-'));
  const store = JsStore.openOrCreate({ path: dir });
  const manager = await ContextManager.open({ store, strategy, namespace: 'a' });
  const id = manager.addMessage('user', text);
  return { store, manager, id, close() { manager.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function summaries(store: JsStore) { return store.getStateJson('a/autobio:summaries') ?? []; }

// The reviewer's accessor-probe.mjs, adapted to node:test, plus its forwarding
// Proxy equivalent. tick's first presence lookup must already carry A's origin.
for (const shape of ['accessor', 'proxy-get', 'protocol-get'] as const) {
  for (const writer of ['pushSummary', 'final-writer'] as const) {
    it(`reviewer tick lookup ${shape}/${writer}: B stays at zero summaries`, async () => {
      const raw = new Probe(config);
      const pause = barrier();
      let pending: Promise<void> | undefined;
      let store!: JsStore;
      const watched = watch(raw, shape, 'tick', async () => {}, () => {
        pending = (async () => {
          await pause.wait;
          if (writer === 'pushSummary') raw.commit(); else raw.commitAtWriter(store);
        })();
        void pending.catch(() => {});
      });
      const fx = await fixture(raw, watched.strategy);
      store = fx.store;
      try {
        watched.arm();
        await fx.manager.tick();
        assert.ok(pending, 'the manager lookup starts the continuation');
        watched.disable();
        await fx.manager.setStrategy(watched.strategy);
        assert.deepEqual(summaries(store), [], 'B starts at zero');
        pause.release();
        await assert.rejects(pending!, /stale branch/);
        assert.deepEqual(summaries(store), [], 'no 0 -> 1 summary leak into B');
      } finally { watched.restore(); pause.release(); fx.close(); }
    });
  }
}

type Site = { name: string; member: string; has?: boolean; present?: boolean; value?: unknown;
  run: (m: ContextManager, id: string, strategy: Probe) => unknown };
const sites: Site[] = [
  { name: 'absent tick', member: 'tick', run: m => m.tick() },
  { name: 'absent initialize', member: 'initialize', run: (m, _, s) => m.setStrategy(s) },
  { name: 'present initialize', member: 'initialize', present: true, run: (m, _, s) => m.setStrategy(s) },
  { name: 'absent ingress', member: 'chunkIngressMessage', run: m => m.addMessage('user', text) },
  { name: 'absent presentation', member: 'onPresented', run: m => m.addMessage('user', text) },
  { name: 'absent legacy presentation', member: 'onNewMessage', run: m => m.addMessage('user', text) },
  { name: 'absent retraction', member: 'onRetracted', run: (m, id) => { m.presentRows([id]); m.retractRows([id]); } },
  { name: 'absent hold release', member: 'onCompressionHoldsReleased', run: (m, id) => { m.holdCompression([id]); m.releaseCompression([id]); } },
  { name: 'absent newest rendering', member: 'renderAsNewest', run: (m, id) => m.renderAsNewest([id]) },
  { name: 'absent preview', member: 'previewContext', run: m => m.previewContext(budget) },
  { name: 'present preview', member: 'previewContext', present: true, run: m => m.previewContext(budget) },
  { name: 'reported forms', member: 'renderedForms', run: m => m.describeRenderedForms() },
  { name: 'reported name', member: 'name', value: 'probe', run: m => m.describeRenderedForms() },
  { name: 'compiled forms', member: 'renderedForms', run: m => m.compile(budget) },
  { name: 'compiled name', member: 'name', value: 'probe', run: m => m.compile(budget) },
  { name: 'detach diagnostic name', member: 'name', value: 'probe', run: async (m, _, s) => {
    Object.defineProperty(s, 'detach', { configurable: true, value: () => { throw new Error('detach probe'); } });
    await m.setStrategy(new PassthroughStrategy());
  } },
  // Both get and has traps in every capability guard, at each manager site.
  ...[
    ['hot read', 'getHotContextSettings', (m: ContextManager) => m.getHotContextSettings()],
    ['hot read second member', 'updateHotContextSettings', (m: ContextManager) => m.getHotContextSettings()],
    ['hot update', 'getHotContextSettings', (m: ContextManager) => m.updateHotContextSettings({})],
    ['hot update second member', 'updateHotContextSettings', (m: ContextManager) => m.updateHotContextSettings({})],
    ['pin', 'pinRange', (m: ContextManager, id: string) => m.pinRange(id, id)],
    ['pin second member', 'unpin', (m: ContextManager, id: string) => m.pinRange(id, id)],
    ['document', 'pinRange', (m: ContextManager, id: string) => m.markDocument(id)],
    ['unpin', 'pinRange', (m: ContextManager) => m.unpin('absent')],
    ['pins', 'pinRange', (m: ContextManager) => m.listPins()],
    ['search', 'searchSummaries', (m: ContextManager) => m.searchSummaries({ text: 'A' })],
    ['search second member', 'getSummary', (m: ContextManager) => m.searchSummaries({ text: 'A' })],
    ['summary', 'searchSummaries', (m: ContextManager) => m.getSummary('absent')],
    ['overview', 'listSummariesInRange', (m: ContextManager) => m.getSummariesInRange({})],
    ['overview second member', 'getMaxSummaryLevel', (m: ContextManager) => m.getSummariesInRange({})],
    ['max level', 'listSummariesInRange', (m: ContextManager) => m.getMaxSummaryLevel()],
    ['stats', 'getRenderStats', (m: ContextManager) => m.getRenderStats()],
    ['compile stats', 'getRenderStats', (m: ContextManager) => m.compile(budget)],
    ['reset', 'resetHeadWindow', (m: ContextManager) => m.resetHeadWindow('transition')],
    ['transition', 'resetHeadWindow', (m: ContextManager) => m.generateTransitionSummary()],
  ].map(([name, member, run]) => ({ name, member, run, has: true }) as Site),
];
for (const site of sites) {
  for (const shape of ['accessor', 'proxy-get', ...(site.has ? ['proxy-has'] as const : [])] as Shape[]) {
    it(`manager scopes ${site.name} ${shape} lookup continuation`, async (t) => {
      t.mock.method(console, 'error', () => {});
      const raw = new Probe(config);
      // Reach the legacy fallback, rather than being short-circuited by onPresented.
      if (site.member === 'onNewMessage') Object.defineProperty(raw, 'onPresented', { configurable: true, value: undefined });
      let pause = barrier();
      let pending: Promise<void> | undefined;
      let id = 'current-control';
      const watched = watch(raw, shape, site.member, site.present ? Reflect.get(raw, site.member) : site.value, () => {
        pending = (async () => { await pause.wait; raw.commit(id); })();
        void pending.catch(() => {});
      });
      const fx = await fixture(raw, watched.strategy);
      const run = async () => {
        try { await site.run(fx.manager, fx.id, watched.strategy); }
        catch (error) { assert.match(String(error), /does not support/); }
        assert.ok(pending, 'the intended lookup must actually be exercised');
        watched.disable();
      };
      try {
        watched.arm();
        await run();
        pause.release();
        await pending;
        assert.equal((summaries(fx.store) as unknown[]).length, 1,
          'positive control: a current lookup continuation can write through pushSummary');
        // Retraction consumes its row, detach replaces the strategy. Restore
        // them before arming the obsolete lookup, not from inside the getter.
        await fx.manager.setStrategy(watched.strategy);
        const newId = fx.manager.addMessage('user', text);
        fx.id = newId;
        pause = barrier(); pending = undefined; id = 'from-A';
        watched.arm();
        await run();
        await fx.manager.setStrategy(watched.strategy); // same binding, new load B
        const before = summaries(fx.store);
        pause.release();
        await assert.rejects(pending!, /stale branch/);
        assert.deepEqual(summaries(fx.store), before, 'A must not append to replacement B');
      } finally { watched.restore(); pause.release(); fx.close(); }
    });
  }
}

// Derivation reads capabilities both on the loaded parent and on its not-yet
// initialized child. The latter must not adopt the child's subsequent load.
for (const shape of ['accessor', 'proxy-get'] as const) {
  for (const member of ['derivationManifest', 'exportRenderingFrontier', 'adoptRenderingFrontier', 'discardRenderingFrontier']) {
    it(`derive parent ${member} ${shape} lookup keeps its origin`, async () => {
      const raw = new Probe(config), pause = barrier();
      let pending: Promise<void> | undefined;
      const watched = watch(raw, shape, member, undefined, () => {
        pending = (async () => { await pause.wait; raw.commit(); })();
        void pending.catch(() => {});
      });
      const fx = await fixture(raw, watched.strategy);
      let child: ContextManager | undefined;
      try {
        watched.arm();
        child = await fx.manager.derive({ branch: 'child', strategy: new Probe(config) });
        assert.ok(pending);
        watched.disable();
        await fx.manager.setStrategy(watched.strategy);
        const before = summaries(fx.store);
        pause.release();
        await assert.rejects(pending!, /stale branch/);
        assert.deepEqual(summaries(fx.store), before);
      } finally { watched.restore(); pause.release(); child?.close(); fx.close(); }
    });
  }
  for (const solve of ['reuse', 'fresh'] as const) {
    for (const member of ['exportRenderingFrontier', 'adoptRenderingFrontier', 'discardRenderingFrontier', 'prepareFromRenderingFrontier']) {
      if (solve === 'fresh' && member === 'prepareFromRenderingFrontier') continue;
      it(`derive child ${solve}/${member} ${shape} lookup cannot recapture a later load`, async () => {
        const parent = new Probe(config), raw = new Probe(config), pause = barrier();
        let pending: Promise<void> | undefined;
        // Leave capability methods present, so the preparation and post-init
        // adopt/discard checks run as well. The real base frontier is empty.
        const value = Reflect.get(raw, member);
        const watched = watch(raw, shape, member, value, () => {
          pending = (async () => { await pause.wait; raw.commit(); })();
          void pending.catch(() => {});
        });
        const fx = await fixture(parent);
        let child: ContextManager | undefined;
        try {
          watched.arm();
          child = await fx.manager.derive({ branch: 'child', strategy: watched.strategy, solve });
          assert.ok(pending, 'derived strategy lookup must run');
          watched.disable();
          await child.setStrategy(watched.strategy);
          const before = summaries(child.getStore());
          pause.release();
          await assert.rejects(pending!, /stale branch/);
          assert.deepEqual(summaries(child.getStore()), before);
        } finally { watched.restore(); pause.release(); child?.close(); fx.close(); }
      });
    }
  }
}

it('a forwarding boundary-symbol trap cannot synchronously recapture a protected origin', async () => {
  const raw = new Probe(config);
  let armed = false;
  const proxy = new Proxy(raw, {
    get(target, key, receiver) {
      if (armed && typeof key === 'symbol') {
        armed = false;
        assert.throws(() => raw.commit(), /stale branch/);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const fx = await fixture(raw, proxy);
  try {
    armed = true;
    await fx.manager.tick();
    assert.equal(armed, false);
    assert.deepEqual(summaries(fx.store), []);
  } finally { fx.close(); }
});

it('boundary-symbol lookup cannot adopt B after synchronous manager reinitialization', async () => {
  const raw = new Probe(config), pause = barrier();
  let armed = false;
  let manager!: ContextManager;
  let pending: Promise<void> | undefined;
  let reinitializing: Promise<void> | undefined;
  const proxy: Probe = new Proxy(raw, {
    get(target, key, receiver) {
      if (armed && typeof key === 'symbol') {
        armed = false;
        pending = (async () => { await pause.wait; raw.commit(); })();
        void pending.catch(() => {});
        reinitializing = manager.setStrategy(proxy);
        void reinitializing.catch(() => {});
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const fx = await fixture(raw, proxy);
  manager = fx.manager;
  try {
    armed = true;
    await assert.rejects(manager.tick(), /stale branch/);
    await reinitializing;
    assert.ok(pending);
    assert.deepEqual(summaries(fx.store), []);
    pause.release();
    await assert.rejects(pending!, /stale branch/);
    assert.deepEqual(summaries(fx.store), []);
  } finally { pause.release(); await reinitializing?.catch(() => {}); fx.close(); }
});

it('a current boundary-symbol continuation is allowed to write', async () => {
  const raw = new Probe(config), pause = barrier();
  let pending: Promise<void> | undefined;
  const watched = watch(raw, 'protocol-get', 'tick', undefined, () => {
    pending = (async () => { await pause.wait; raw.commit('current-control'); })();
    void pending.catch(() => {});
  });
  const fx = await fixture(raw, watched.strategy);
  try {
    watched.arm();
    await fx.manager.tick();
    watched.disable();
    assert.ok(pending);
    pause.release();
    await pending;
    assert.equal((summaries(fx.store) as unknown[]).length, 1);
  } finally { watched.restore(); pause.release(); fx.close(); }
});

// A fresh manager call is a new origin, even if invoked by an old async tree.
it('boundary-symbol work inherits the fresh manager origin, not a displaced stale caller', async () => {
  const raw = new Probe(config), oldPause = barrier(), lookupPause = barrier();
  let pending: Promise<void> | undefined;
  const watched = watch(raw, 'protocol-get', 'tick', undefined, () => {
    pending = (async () => { await lookupPause.wait; raw.commit('fresh-origin'); })();
    void pending.catch(() => {});
  });
  const fx = await fixture(raw, watched.strategy);
  const old = callStrategy(raw, 'tick', async () => {
    await oldPause.wait;
    watched.arm();
    await fx.manager.tick();
    watched.disable();
    assert.ok(pending);
    lookupPause.release();
    await pending;
  });
  void old.catch(() => {});
  try {
    await fx.manager.setStrategy(watched.strategy);
    oldPause.release();
    await old;
    assert.equal((summaries(fx.store) as unknown[]).length, 1);
  } finally { watched.restore(); oldPause.release(); lookupPause.release(); fx.close(); }
});
