/** Synthetic stores/providers: exhaustive occurrence replay, not provider qualification. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import { markStoreBranchSwitch } from '../src/branch-generation.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { MessageStoreView, StoredMessage, StrategyContext, SummaryEntry } from '../src/types/index.js';

type Rebind = 'same-name-generation' | 'branch' | 'store' | 'namespace';
type Operation = 'counter-push' | 'async-counter-push' | 'compress' | 'initialize' |
  'counter-push-override' | 'initialize-override' | 'detach-override';
const operations: Operation[] = ['counter-push', 'async-counter-push', 'compress', 'initialize',
  'counter-push-override', 'initialize-override', 'detach-override'];
type Point = { label: string; occurrence: number; calls: number };
const clone = <T>(value: T): T => structuredClone(value);
// Pin the complete successful occurrence trace, not only its dynamic replay.
// Removing a hook/read (or reducing its occurrences) MUST fail reachability.
// Initialization includes scheduleLoadRepairs. Local pricing/chunk helpers now
// resolve each method getter once per pass (nine fewer duplicate getter seams);
// every remaining occurrence is still replayed across all four rebind modes.
// Queue partition construction reuses each chunk key within ordering (one
// fewer key return) and checks persistence once; initializer trace lengths
// stay unchanged, but these two occurrences change their labels/positions.
const expectedTrace: Record<Operation, [number, string]> = {
  'counter-push': [38, 'c7bed58b97d18b600f475cb0009a2c786cd4ed106d7503299a4dd7ff32cf28aa'],
  'async-counter-push': [45, '8797cd678f9ad82d94caeb0cfc01bfc2f285ca6ac08da590fe5a75a0ea94ac85'],
  compress: [365, 'c6815973fb3204ecd4f7a8c099666c2d154edd2057cbe18da3207e1369dab68a'],
  initialize: [378, '6e45bcafe3a8fb788a155e40dad8bd246e04d1124c294094f9f127a77d579b09'],
  'counter-push-override': [46, '8cc84189bae14beab6601df2b64348af7b57202f648cec125b5a665a7a5339ae'],
  'initialize-override': [406, '71b798c9206d52693abf271d2ac1bb965caa539a9f413e6ffbdc68f004a3fb68'],
  'detach-override': [6, '1da3b2e603db9a077b0f109e9ebf8453a632d4cb10ab882a0d844a4af66aeb2c'],
};
const config = {
  compressionModel: 'synthetic', targetChunkTokens: 100, headWindowTokens: 0, recentWindowTokens: 0,
  minChunkCharsForLLM: 0, autoTickOnNewMessage: false, l1HoldbackChunks: 0, mergeThreshold: 99,
  compressionRefusalCurveFallbacks: 0,
};

class MemoryStore {
  branch = 'main';
  readonly states = new Map<string, Map<string, unknown>>([['main', new Map()]]);
  readonly registrations = new Set<string>();
  revision = 0;
  data() { return this.states.get(this.branch)!; }
  currentBranch() { return { name: this.branch }; }
  registerState({ id }: { id: string }) {
    if (this.registrations.has(id)) throw new Error(`State already exists: ${id}`);
    this.registrations.add(id);
  }
  listStates() { return [...this.registrations].map((id) => ({ id })); }
  getStateJson(id: string) { return clone(this.data().get(id) ?? null); }
  setStateJson(id: string, value: unknown) { this.data().set(id, clone(value)); this.revision++; }
  appendToStateJson(id: string, value: unknown) {
    this.data().set(id, [...(this.data().get(id) as unknown[] ?? []), clone(value)]); this.revision++;
  }
  appendToStateJsonWithIdentity(id: string, value: object) {
    const sequence = ++this.revision;
    this.appendToStateJson(id, { ...value, eventId: String(sequence), sequence });
    return { id: String(sequence), sequence };
  }
  editStateItem(id: string, at: number, bytes: Uint8Array) {
    const rows = this.data().get(id) as unknown[];
    rows[at] = JSON.parse(Buffer.from(bytes).toString()); this.revision++;
  }
  stateHeadOffset() { return this.revision; }
  getStateLen(id: string) { return (this.data().get(id) as unknown[] ?? []).length; }
  sync() {}
}

function message(id: string, sequence: number): StoredMessage {
  return { id, sequence, participant: sequence % 2 ? 'User' : 'Claude',
    content: [{ type: 'text', text: `Synthetic substantive event ${id}. ${'detail '.repeat(60)}` }],
    timestamp: new Date(1), tokens: 110 } as StoredMessage;
}
function summary(id: string, ids = ['primary-1', 'primary-2']): SummaryEntry {
  return { id, level: 1, sourceLevel: 0, sourceIds: ids,
    sourceRange: { first: ids[0]!, last: ids.at(-1)! }, content: `Memory ${id}`, tokens: 10, created: 1 };
}

class ReentryProbe extends AutobiographicalStrategy {
  /** Real protected helper signatures: no token forwarding by this subclass. */
  counterPush(ctx: StrategyContext): void {
    ctx.messageStore.getAll();
    const id = this.nextSummaryIdCounter();
    this.pushSummary(summary(`L1-${id}`));
  }
  async asyncCounterPush(ctx: StrategyContext): Promise<void> {
    ctx.messageStore.getAll();
    await Promise.resolve();
    ctx.messageStore.getAll();
    const id = this.nextSummaryIdCounter();
    await Promise.resolve();
    this.pushSummary(summary(`L1-${id}`));
  }
  compress(ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(this.chunks[0]!, ctx); }
  protected scheduledCounterPush(ctx: StrategyContext): Promise<void> {
    return new Promise((resolve, reject) => setImmediate(() => {
      try { this.counterPush(ctx); resolve(); } catch (error) { reject(error); }
    }));
  }
  async capturedMirrors(after: () => Promise<void>): Promise<void> {
    const locks = this.locked, resolutions = this.resolutions;
    await after();
    locks.add('obsolete');
    resolutions.set('obsolete', 2);
  }
  mirrors() {
    return clone({ summaries: this.summaries, counter: this.summaryIdCounter, records: this.chunkRecords,
      chunks: this.chunks, queue: this.mergeQueue, quarantine: [...this.mergeQuarantine],
      pins: this.pins, resolutions: [...this.resolutions], locks: [...this.locked], head: this.headWindowStartId });
  }
}

/** Real subclass lifecycle and protected overrides, before/after super and await. */
class OverrideReentryProbe extends ReentryProbe {
  override async initialize(ctx: StrategyContext): Promise<void> {
    ctx.messageStore.getAll();
    await Promise.resolve();
    ctx.messageStore.getAll();
    await super.initialize(ctx);
    ctx.messageStore.getAll();
    await Promise.resolve();
    ctx.messageStore.getAll();
    this.summaries.push(summary('override-tail'));
  }
  override detach(): void {
    this.overrideHook();
    super.detach();
    this.overrideHook();
    this.summaries.push(summary('detach-tail'));
  }
  protected overrideHook(): number { return this.summaries.length; }
  protected override nextSummaryIdCounter(): number {
    this.overrideHook();
    const counter = super.nextSummaryIdCounter();
    this.overrideHook();
    return counter;
  }
  protected override pushSummary(entry: SummaryEntry): void {
    this.overrideHook();
    super.pushSummary(entry);
    this.overrideHook();
  }
}

/** Records ALL invoked read methods and strategy hooks, with occurrence identity. */
class Recorder {
  enabled = false;
  fired = false;
  points: Point[] = [];
  counts = new Map<string, number>();
  calls = 0;
  initializer: Promise<void> | undefined;
  expectedDurable: unknown;
  constructor(readonly target?: Point, readonly reenter?: () => Promise<void>) {}
  hit(label: string) {
    if (!this.enabled || this.fired) return;
    const occurrence = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, occurrence);
    const point = { label, occurrence, calls: this.calls };
    this.points.push(point);
    if (this.target?.label === label && this.target.occurrence === occurrence) {
      this.fired = true;
      this.initializer = this.reenter!();
      // Attach immediately: a rejecting initializer must never become an
      // unhandled rejection while the original operation is being settled.
      void this.initializer.catch(() => {});
    }
  }
  wrap(target: object, label: string, names: string[]) {
    for (const name of names) {
      const method = (target as any)[name];
      if (typeof method !== 'function') continue;
      const wrapped = (...args: unknown[]) => {
        const result = Reflect.apply(method, target, args);
        this.hit(`${label}.${name}${name === 'getStateJson' ? `(${String(args[0])})` : ''}:return`);
        if (result instanceof Promise) return result.then((value) => {
          this.hit(`${label}.${name}:resolved`); return value;
        });
        return result;
      };
      Object.defineProperty(target, name, {
        configurable: true,
        get: () => { this.hit(`${label}.${name}:get`); return wrapped; },
      });
    }
  }
}

async function fixture(operation: Operation, mode: Rebind, target?: Point) {
  const a = new MemoryStore(), other = new MemoryStore();
  const Probe = operation.endsWith('-override') ? OverrideReentryProbe : ReentryProbe;
  const strategy = new Probe(config);
  let namespace = 'a';
  let b = a;
  const recorder = new Recorder(target, async () => {
    if (mode === 'store') b = other;
    if (mode === 'namespace') namespace = 'b';
    if (mode === 'branch') { a.branch = 'b'; a.states.set('b', new Map()); }
    if (mode === 'same-name-generation') markStoreBranchSwitch(a as unknown as JsStore);
    seed(b, namespace, true);
    recorder.expectedDurable = durable(b);
    const value = await strategy.initialize(context(b, namespace));
    assert.equal(value, undefined, 'initializer result');
  });
  const primaryRows = [message('primary-1', 1), message('primary-2', 2)];
  const auxiliaryRows = [message('auxiliary-3', 3), message('hidden-4', 4)];
  function view(rows: StoredMessage[], label: string): MessageStoreView {
    const result = {
      getAll: () => rows, get: (id: string) => rows.find((m) => m.id === id) ?? null,
      getFrom: (at: number) => rows.slice(at), getTail: (n: number) => rows.slice(-n), length: () => rows.length,
      estimateTokens: () => 110, getTokenCalibration: () => 1,
      hasCompressionHolds: () => false, isCompressionHeld: () => false,
    };
    recorder.wrap(result, label, Object.keys(result));
    return result;
  }
  // The filtered view really composes primary and auxiliary views: every
  // upstream read is recorded too, not just a second alias of the primary.
  const primary = view(primaryRows, 'primary');
  const auxiliary = view(auxiliaryRows, 'auxiliary');
  const filtered = view([], 'filtered');
  Object.defineProperty(filtered, 'getAll', { configurable: true, value: () => {
    recorder.hit('filtered.getAll:get');
    const rows = [...primary.getAll(), ...auxiliary.getAll()].filter((row) => row.id !== 'hidden-4');
    recorder.hit('filtered.getAll:return'); return rows;
  } });
  Object.defineProperty(filtered, 'get', { configurable: true, value: (id: string) => {
    recorder.hit('filtered.get:get');
    const row = primary.get(id) ?? auxiliary.get(id);
    recorder.hit('filtered.get:return'); return row?.id === 'hidden-4' ? null : row;
  } });
  const membrane = { complete: async () => {
    recorder.calls++;
    recorder.hit('provider.before-await');
    await Promise.resolve();
    recorder.hit('provider.after-await');
    return { content: [{ type: 'text', text: 'A concise synthetic memory of the substantive events.' }],
      stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 12 } };
  } };
  function context(store: MemoryStore, ns: string): StrategyContext {
    const ctx: StrategyContext = { store: store as unknown as JsStore, namespace: ns, messageStore: filtered, membrane: membrane as never,
      contextLog: { getAll: () => [], getFrom: () => [], getTail: () => [], length: () => 0, estimateTokens: () => 0 },
      currentSequence: 4 };
    return new Proxy(ctx, { get: (object, key, receiver) => {
      const value = Reflect.get(object, key, receiver);
      recorder.hit(`context.${String(key)}:get`); return value;
    } });
  }
  recorder.wrap(membrane, 'provider', ['complete']);
  function seed(store: MemoryStore, ns: string, replacement: boolean) {
    const state = store.data();
    state.clear();
    state.set(`${ns}/autobio:summaries`, replacement ? [summary('L1-40')] : []);
    state.set(`${ns}/autobio:counter`, replacement ? 41 : 0);
    state.set(`${ns}/autobio:chunks`, [{ id: 'c-0', sourceIds: ['primary-1', 'primary-2'],
      compressed: replacement, ...(replacement ? { summaryId: 'L1-40' } : {}) }]);
    state.set(`${ns}/autobio:mergeQueue`, []);
    state.set(`${ns}/autobio:merge-quarantine`, []);
    state.set(`${ns}/autobio:pins`, { pins: [], counter: 0 });
    state.set(`${ns}/autobio:compression-refusal-quarantine-events`, []);
  }
  const durable = (store: MemoryStore) => clone([...store.data()].sort(([a], [b]) => a.localeCompare(b)));
  seed(a, 'a', false);
  await strategy.initialize(context(a, 'a'));
  const ctx = context(a, 'a');
  // No fixture reads are counted. All external store reads and every native
  // or overridden strategy method reached by the operation are enumerated.
  for (const [store, label] of [[a, 'store-a'], [other, 'store-b']] as const) {
    recorder.wrap(store, label, ['currentBranch', 'getStateJson', 'getStateLen', 'listStates', 'stateHeadOffset',
      'registerState', 'setStateJson', 'appendToStateJson', 'appendToStateJsonWithIdentity', 'editStateItem', 'sync']);
  }
  const hooks = new Set<string>();
  for (let p = Object.getPrototypeOf(strategy); p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(p, name)?.value === 'function') hooks.add(name);
    }
  }
  // Entrypoint/root completion is outside its scope. Inspection of the test
  // oracle and the internal scoping/guard machinery aren't user hook points.
  for (const name of ['initialize', 'detach', 'mirrors', 'counterPush', 'asyncCounterPush', 'compress',
    'requireBranchMutation', 'branchMutation', 'isBranchIdentityCurrent', 'isCompressionBranchCurrent',
    'requireLoadedBranch', 'captureCompressionBranch', 'isLoadedBranchCurrent']) hooks.delete(name);
  for (let p = Object.getPrototypeOf(strategy); p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      const getter = Object.getOwnPropertyDescriptor(p, name)?.get;
      if (!getter) continue;
      Object.defineProperty(strategy, name, { configurable: true, get() {
        const value = Reflect.apply(getter, strategy, []);
        recorder.hit(`hook.${name}:get`); return value;
      } });
    }
  }
  recorder.wrap(strategy, 'hook', [...hooks]);
  return {
    strategy, recorder, ctx, a,
    async run() {
      recorder.enabled = true;
      try {
        if (operation === 'counter-push' || operation === 'counter-push-override') strategy.counterPush(ctx);
        if (operation === 'async-counter-push') await strategy.asyncCounterPush(ctx);
        if (operation === 'compress') await strategy.compress(ctx);
        if (operation === 'initialize' || operation === 'initialize-override') await strategy.initialize(ctx);
        if (operation === 'detach-override') strategy.detach();
      } finally { recorder.enabled = false; }
    },
    async verify() {
      assert.equal(recorder.fired, true, `unreachable ${JSON.stringify(target)}`);
      assert.ok(recorder.initializer);
      await assert.doesNotReject(recorder.initializer, `B initializer must fulfill: ${operation}/${mode}/${JSON.stringify(target)}`);
      assert.deepEqual(durable(b), recorder.expectedDurable, `B durable state unchanged: ${operation}/${mode}/${JSON.stringify(target)}`);
      assert.equal((strategy as any).store, b, 'B store binding');
      assert.equal((strategy as any).ns, namespace, 'B namespace binding');
      // Fresh, independently loaded oracle catches silent poisoning of ANY
      // loaded mirror represented by the fixture, not only the stored counter.
      const oracle = new Probe(config);
      await oracle.initialize(context(b, namespace));
      let actualMirrors: unknown;
      assert.doesNotThrow(() => { actualMirrors = strategy.mirrors(); }, `${operation}/${mode}/${JSON.stringify(target)}`);
      assert.deepEqual(actualMirrors, oracle.mirrors(), `B loaded mirrors unchanged: ${operation}/${mode}/${JSON.stringify(target)}`);
      assert.equal(recorder.calls, target!.calls, 'no extra provider call after losing the operation scope');
    },
  };
}

it('replays every successful read/hook occurrence across branch/store/namespace and async boundaries', async (t) => {
  let points = 0;
  for (const operation of operations) {
    const baseline = await fixture(operation, 'branch');
    await baseline.run();
    const trace = baseline.recorder.points;
    assert.deepEqual([trace.length, createHash('sha256').update(JSON.stringify(trace)).digest('hex')],
      expectedTrace[operation], `${operation}: complete successful trace reachability changed`);
    assert.ok(trace.length > 0, `${operation} trace must not go empty`);
    if (operation !== 'detach-override') {
      for (const label of ['primary.getAll:return', 'auxiliary.getAll:return', 'filtered.getAll:return', 'store-a.getStateJson(a/autobio:counter):return']) {
        assert.ok(trace.some((point) => point.label === label), `${operation} must reach ${label}`);
      }
    }
    if (operation === 'initialize-override') {
      assert.equal(trace.filter((p) => p.label === 'filtered.getAll:return').length, 11,
        'four override reads before/after super and awaits, plus seven native initializer reads');
    } else if (operation.endsWith('-override')) {
      assert.ok(trace.some((p) => p.label === 'hook.overrideHook:return'), 'subclass override hook is reachable');
    }
    if (operation.includes('counter-push')) {
      assert.ok(trace.some((p) => p.label === 'store-a.getStateJson(a/autobio:counter):return'), 'counter read before pushSummary');
      assert.ok(trace.some((p) => p.label === 'hook.nextSummaryIdCounter:return'));
      assert.ok(trace.some((p) => p.label === 'hook.pushSummary:return'));
    }
    if (operation === 'compress') {
      assert.equal(baseline.recorder.calls, 1, 'successful native compression must call provider');
      assert.ok(trace.some((p) => p.label === 'provider.before-await'));
      assert.ok(trace.some((p) => p.label === 'provider.after-await'));
      assert.ok(trace.some((p) => p.label === 'hook.pushSummary:return'));
    }
    for (const mode of ['same-name-generation', 'branch', 'store', 'namespace'] as const) {
      for (const point of trace) {
        const replay = await fixture(operation, mode, point);
        try { await replay.run(); } catch (error) {
          assert.match(String(error), /stale branch|reinitialization|binding changed/, `${operation}/${mode}/${JSON.stringify(point)}`);
        }
        await replay.verify();
        // Require the exact successful prefix through the selected occurrence,
        // rather than silently accepting changed reachability or call counts.
        const at = trace.findIndex((p) => p === point);
        assert.deepEqual(replay.recorder.points, trace.slice(0, at + 1));
        points++;
      }
    }
  }
  t.diagnostic(`adversarial re-entry points: ${points}`);
});

it('keeps a standalone protected scheduled continuation in A, without forwarding a token', async () => {
  const fx = await fixture('counter-push', 'same-name-generation');
  const work = (fx.strategy as any).scheduledCounterPush(fx.ctx) as Promise<void>;
  await fx.strategy.initialize(fx.ctx);
  const before = fx.strategy.mirrors();
  await assert.rejects(work, /stale branch/);
  assert.deepEqual(fx.strategy.mirrors(), before);
  assert.equal(fx.recorder.calls, 0);
});

it('detaches captured A collections and preserves standalone method arity', async () => {
  const fx = await fixture('counter-push', 'same-name-generation');
  assert.equal(fx.strategy.counterPush.length, 1);
  await fx.strategy.capturedMirrors(() => fx.strategy.initialize(fx.ctx));
  const mirrors = fx.strategy.mirrors();
  assert.deepEqual(mirrors.resolutions, []);
  assert.deepEqual(mirrors.locks, []);
});

it('fences a standalone unloaded helper when its read initializes the first load', async () => {
  const fx = await fixture('counter-push', 'store');
  const strategy = new ReentryProbe(config);
  let initialization: Promise<void> | undefined;
  const view = { ...fx.ctx.messageStore, getAll: () => {
    initialization = strategy.initialize(fx.ctx);
    return [];
  } };
  assert.throws(() => (strategy as any).rebuildChunks(view), /stale branch/);
  assert.ok(initialization, 'the unloaded helper actually reached its view read');
  await initialization;
  assert.deepEqual(strategy.mirrors(), fx.strategy.mirrors());
});

it('fences the reviewer\'s post-super initialize override continuation', async () => {
  class TailInit extends ReentryProbe {
    afterInit: (() => Promise<void>) | null = null;
    override async initialize(ctx: StrategyContext): Promise<void> {
      await super.initialize(ctx);
      if (this.afterInit) await this.afterInit();
      this.summaries.push(summary('tail-init'));
    }
  }
  const fx = await fixture('counter-push', 'same-name-generation');
  const strategy = new TailInit(config);
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  strategy.afterInit = async () => {
    strategy.afterInit = null;
    reach();
    await hold;
  };
  const a = strategy.initialize(fx.ctx);
  void a.catch(() => {});
  await reached;
  await strategy.initialize({ ...fx.ctx, namespace: 'b' });
  const before = strategy.mirrors();
  assert.equal(before.summaries.length, 1, 'B completed its own override tail');
  release();
  await assert.rejects(a, /stale branch/);
  assert.deepEqual(strategy.mirrors(), before, 'A must not grow B summaries from 1 to 2');
});

for (const lifecycle of ['initialize', 'detach'] as const) {
  for (const position of ['before-super', 'after-super'] as const) {
    it(`fences ${lifecycle} override ${position} across a same-binding generation change`, async () => {
      class PausedLifecycle extends ReentryProbe {
        pause: (() => Promise<void>) | null = null;
        override async initialize(ctx: StrategyContext): Promise<void> {
          if (lifecycle === 'initialize' && position === 'before-super' && this.pause) await this.pause();
          await super.initialize(ctx);
          if (lifecycle === 'initialize' && position === 'after-super' && this.pause) await this.pause();
          this.summaries.push(summary('initialize-tail'));
        }
        override async detach(): Promise<void> {
          if (position === 'before-super' && this.pause) await this.pause();
          super.detach();
          if (position === 'after-super' && this.pause) await this.pause();
          this.summaries.push(summary('detach-tail'));
        }
      }
      const fx = await fixture('counter-push', 'same-name-generation');
      const strategy = new PausedLifecycle(config);
      // Include an unloaded first initializer: null identity must still carry
      // a generation while the subclass waits before super.
      if (lifecycle !== 'initialize' || position !== 'before-super') await strategy.initialize(fx.ctx);
      let reach!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => { reach = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      strategy.pause = async () => { strategy.pause = null; reach(); await hold; };
      const a = lifecycle === 'initialize' ? strategy.initialize(fx.ctx) : strategy.detach();
      void a.catch(() => {});
      await reached;
      // Same store, namespace AND branch: only the strategy generation changes.
      await strategy.initialize(fx.ctx);
      const before = strategy.mirrors();
      release();
      await assert.rejects(a, /stale branch/);
      assert.deepEqual(strategy.mirrors(), before);
      // In particular a delayed super.initialize/detach must not invalidate B.
      assert.doesNotThrow(() => strategy.getSummary('initialize-tail'));
    });
  }
}
