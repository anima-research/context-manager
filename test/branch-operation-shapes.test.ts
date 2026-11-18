/** Call-boundary regressions, not an isolation sandbox for arbitrary host code. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import { BranchOperationScope, callStrategy } from '../src/branch-operation-scope.js';
import type { StoredMessage, StrategyContext, SummaryEntry } from '../src/types/index.js';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
function summary(id: string): SummaryEntry {
  return { id, level: 1, sourceLevel: 0, sourceIds: ['a'], sourceRange: { first: 'a', last: 'a' },
    content: `Origin ${id}`, tokens: 3, created: 1 };
}
const config = { autoTickOnNewMessage: false };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cs-'));
  const stores: JsStore[] = [];
  const managers: ContextManager[] = [];
  const newStore = () => {
    const store = JsStore.openOrCreate({ path: join(directory, String(stores.length)) });
    stores.push(store);
    return store;
  };
  const open = async (store: JsStore, strategy: AutobiographicalStrategy, namespace = 'a') => {
    const manager = await ContextManager.open({ store, strategy, namespace });
    managers.push(manager);
    return manager;
  };
  return {
    newStore, open,
    close() {
      for (const manager of managers.reverse()) manager.close();
      for (const store of stores) store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("fences the reviewer's async class-field onNewMessage after initialize(B)", async (t) => {
  const pause = barrier(), reached = barrier(), finished = barrier();
  let failure: unknown;
  class ClassFieldMessage extends AutobiographicalStrategy {
    override onNewMessage = async (_message: StoredMessage, _ctx: StrategyContext): Promise<void> => {
      reached.release();
      await pause.wait;
      try { this.pushSummary(summary('from-A')); }
      catch (error) { failure = error; throw error; }
      finally { finished.release(); }
    };
  }
  const strategy = new ClassFieldMessage(config);
  // Exercise the manager's documented legacy onNewMessage fallback instead
  // of the base class's newer batched onPresented hook.
  Object.defineProperty(strategy, 'onPresented', { value: undefined, configurable: true });
  t.mock.method(console, 'error', () => {}); // manager reports the obsolete async hook
  const fx = await fixture();
  try {
    const store = fx.newStore();
    const manager = await fx.open(store, strategy);
    manager.addMessage('user', [{ type: 'text', text: 'A' }]);
    await reached.wait;
    await manager.setStrategy(strategy); // B: same store/namespace/branch, new load
    const before = store.getStateJson('a/autobio:summaries') ?? [];
    assert.deepEqual(before, [], 'B starts with zero durable summaries');
    pause.release();
    await finished.wait;
    assert.deepEqual(store.getStateJson('a/autobio:summaries') ?? [], before,
      'A must not grow B durable summaries from 0 to 1');
    assert.match(String(failure), /stale branch/);
  } finally { pause.release(); fx.close(); }
});

type Writer = 'pushSummary' | 'writer-boundary';
type Shape = 'prototype' | 'class-field' | 'instance-function' | 'arrow' | 'late-assignment' |
  'function-proxy' | 'strategy-proxy' | 'accessor';
const shapes: Shape[] = ['prototype', 'class-field', 'instance-function', 'arrow', 'late-assignment',
  'function-proxy', 'strategy-proxy', 'accessor'];
const replacements = ['load', 'branch', 'store', 'namespace'] as const;

/** All shapes execute identical work. None forwards a new protected argument. */
function shaped(shape: Shape, work: (probe: Probe, ctx: StrategyContext) => Promise<void>) {
  class Prototype extends Probe {
    override tick(ctx: StrategyContext): Promise<void> { return work(this, ctx); }
  }
  class ClassField extends Probe {
    override tick = (ctx: StrategyContext): Promise<void> => work(this, ctx);
  }
  const raw = shape === 'prototype' ? new Prototype(config) :
    shape === 'class-field' ? new ClassField(config) : new Probe(config);
  const assigned = async function (this: Probe, ctx: StrategyContext) { await work(this, ctx); };
  const install = () => {
    if (shape === 'instance-function' || shape === 'late-assignment') raw.tick = assigned;
    if (shape === 'arrow') raw.tick = (ctx) => work(raw, ctx);
    if (shape === 'function-proxy') raw.tick = new Proxy(assigned, {
      apply(target, receiver, args) { return Reflect.apply(target, receiver, args); },
    });
    if (shape === 'accessor') Object.defineProperty(raw, 'tick', {
      configurable: true, get() { return assigned; },
    });
  };
  if (shape !== 'late-assignment') install();
  const strategy = shape === 'strategy-proxy' ? new Proxy(raw, {
    get(target, key, receiver) {
      if (key === 'tick') return assigned;
      return Reflect.get(target, key, receiver);
    },
  }) : raw;
  return { strategy, install };
}

class Probe extends AutobiographicalStrategy {
  commit(entry: SummaryEntry, ctx: StrategyContext, writer: Writer) {
    if (writer === 'pushSummary') this.pushSummary(entry);
    else {
      // Reach the final library writer without touching any loaded mirror:
      // mirror accessors must not be the only protection of durable state.
      const internals = this as unknown as {
        branchMutation(store: JsStore, method: 'appendToStateJson', id: string, value: unknown): void;
      };
      internals.branchMutation(ctx.store, 'appendToStateJson', `${ctx.namespace}/autobio:summaries`, entry);
    }
  }
}

for (const shape of shapes) for (const replacement of replacements) {
  for (const writer of ['pushSummary', 'writer-boundary'] as const) {
    it(`manager call fences ${shape}/${writer} across ${replacement} replacement`, async () => {
      const fx = await fixture();
      const pause = barrier(), reached = barrier();
      let shouldPause = false;
      const { strategy, install } = shaped(shape, async (probe, ctx) => {
        const entry = summary(shouldPause ? 'from-A' : 'current-control');
        if (shouldPause) { reached.release(); await pause.wait; }
        probe.commit(entry, ctx, writer);
      });
      try {
        const storeA = fx.newStore();
        const manager = await fx.open(storeA, strategy);
        install(); // includes assignment AFTER construction and initialization
        await manager.tick();
        assert.equal((storeA.getStateJson('a/autobio:summaries') as unknown[]).length, 1,
          'positive control: this override shape reaches a real durable write');
        shouldPause = true;
        const obsolete = manager.tick();
        void obsolete.catch(() => {});
        await reached.wait;
        let storeB = storeA;
        let namespace = 'a';
        if (replacement === 'load') await manager.setStrategy(strategy);
        if (replacement === 'branch') await manager.fork('B');
        if (replacement === 'store') { storeB = fx.newStore(); await fx.open(storeB, strategy); }
        if (replacement === 'namespace') { namespace = 'b'; await fx.open(storeB, strategy, namespace); }
        const before = storeB.getStateJson(`${namespace}/autobio:summaries`) ?? [];
        pause.release();
        await assert.rejects(obsolete, /stale branch/);
        assert.deepEqual(storeB.getStateJson(`${namespace}/autobio:summaries`) ?? [], before,
          'the obsolete invocation must not modify replacement durable state');
      } finally { pause.release(); fx.close(); }
    });
  }
}

// Lifecycle shapes use captured installed base functions as well as direct
// super calls. The manager must own the whole override, not just super's body.
for (const shape of shapes) for (const position of ['before-super', 'after-super'] as const) {
  it(`manager scopes ${shape} initialize ${position}`, async () => {
    const fx = await fixture();
    const pause = barrier(), reached = barrier();
    let shouldPause = false;
    const paused = async () => {
      if (shouldPause) { shouldPause = false; reached.release(); await pause.wait; }
    };
    const body = async (probe: Probe, ctx: StrategyContext, base: () => Promise<void>) => {
      if (position === 'before-super') await paused();
      await base();
      if (position === 'after-super') await paused();
      probe.commit(summary('initialize-control'), ctx, 'pushSummary');
    };
    class Prototype extends Probe {
      override async initialize(ctx: StrategyContext) { await body(this, ctx, () => super.initialize(ctx)); }
    }
    class ClassField extends Probe {
      override initialize = async (ctx: StrategyContext) => body(this, ctx, () => super.initialize(ctx));
    }
    const raw = shape === 'prototype' ? new Prototype(config) : shape === 'class-field' ?
      new ClassField(config) : new Probe(config);
    const base = raw.initialize.bind(raw);
    const assigned = async function (this: Probe, ctx: StrategyContext) {
      await body(this, ctx, () => base(ctx));
    };
    const install = () => {
      if (shape === 'instance-function' || shape === 'late-assignment') raw.initialize = assigned;
      if (shape === 'arrow') raw.initialize = (ctx) => body(raw, ctx, () => base(ctx));
      if (shape === 'function-proxy') raw.initialize = new Proxy(assigned, {
        apply(target, receiver, args) { return Reflect.apply(target, receiver, args); },
      });
      if (shape === 'accessor') Object.defineProperty(raw, 'initialize', { configurable: true, get: () => assigned });
    };
    if (shape !== 'late-assignment') install();
    const strategy = shape === 'strategy-proxy' ? new Proxy(raw, {
      get(target, key, receiver) { return key === 'initialize' ? assigned : Reflect.get(target, key, receiver); },
    }) : raw;
    try {
      const store = fx.newStore();
      const manager = await fx.open(store, strategy);
      if (shape === 'late-assignment') install();
      // Also exercise a successful invocation of every shape, before racing it.
      await manager.setStrategy(strategy);
      shouldPause = true;
      const obsolete = manager.setStrategy(strategy);
      void obsolete.catch(() => {});
      await reached.wait;
      await manager.setStrategy(strategy);
      const before = store.getStateJson('a/autobio:summaries');
      pause.release();
      await assert.rejects(obsolete, /stale branch/);
      assert.deepEqual(store.getStateJson('a/autobio:summaries'), before);
      assert.doesNotThrow(() => strategy.getSummary('initialize-control'), 'delayed super must not invalidate B');
    } finally { pause.release(); fx.close(); }
  });
}

it('writer guards reject rebinding of the captured invocation before writer dispatch', () => {
  const identity = Object.freeze({ load: 1 });
  let generation = 0;
  const scope = new BranchOperationScope(() => identity, () => true, () => generation);
  const target = {};
  scope.install(target, new Set(), new Set());
  callStrategy(target, 'initialize', () => {
    const authorize = scope.writerGuard();
    scope.advanceLifecycle(generation + 1);
    generation++;
    assert.throws(authorize, /stale branch/);
  });
});

it('a captured writer guard cannot authorize a different invocation binding', () => {
  const identity = Object.freeze({ load: 1 });
  const scope = new BranchOperationScope(() => identity, () => true, () => 0);
  const target = {};
  scope.install(target, new Set(), new Set());
  const authorize = callStrategy(target, 'tick', () => scope.writerGuard());
  callStrategy(target, 'tick', () => assert.throws(authorize, /stale branch/));
});

it('guarded mirror access is local: no fallible store lookup on the hot field path', () => {
  const identity = { load: 1 };
  let checks = 0;
  const scope = new BranchOperationScope(() => identity, () => { checks++; return true; }, () => 0);
  const target = { mirror: 1 };
  scope.install(target, new Set(), new Set());
  callStrategy(target, 'tick', () => {
    const before = checks;
    for (let i = 0; i < 100; i++) target.mirror++;
    assert.equal(checks, before, 'field access must check epoch/generation, not query a host store');
  });
});

it('nested boundary resolutions retain an ancestor owner origin', async () => {
  const identity = { load: 1 };
  const aScope = new BranchOperationScope(() => identity, () => true, () => 0);
  const bScope = new BranchOperationScope(() => identity, () => true, () => 0);
  const a = { mirror: 0 }, b = {};
  aScope.install(a, new Set(), new Set()); bScope.install(b, new Set(), new Set());
  let continueWork!: () => void;
  const pause = new Promise<void>(r => { continueWork = r; });
  let pending: Promise<void> | undefined;
  const bProxy = new Proxy(b, { get(target, key, receiver) {
    if (typeof key === 'symbol') {
      pending = pause.then(() => { a.mirror++; });
      void pending.catch(() => {});
    }
    return Reflect.get(target, key, receiver);
  } });
  const aProxy = new Proxy(a, { get(target, key, receiver) {
    if (typeof key === 'symbol') callStrategy(bProxy, 'tick', () => {});
    return Reflect.get(target, key, receiver);
  } });
  callStrategy(aProxy, 'tick', () => {});
  callStrategy(a, 'initialize', () => {});
  continueWork();
  await assert.rejects(pending!, /stale branch/);
  assert.equal(a.mirror, 0);
});

it('initialization detaches discarded order caches without traversing old history', () => {
  const scope = new BranchOperationScope(() => ({ load: 1 }), () => true, () => 0);
  class OldOrder extends Map<string, number> {
    [Symbol.iterator](): MapIterator<[string, number]> { throw new Error('history traversed'); }
  }
  const old = new OldOrder([['a', 1]]);
  const target = { order: old, source: ['a'] };
  (scope.install as Function)(target, new Set(), new Set(), new Set(['order', 'source']));
  callStrategy(target, 'initialize', () => scope.isolateMirrors());
  assert.equal(target.order.size, 0);
  assert.deepEqual(target.source, []);
  assert.equal(old.get('a'), 1, 'old captured shell remains intact');
});
