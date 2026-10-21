/**
 * A manager tells a strategy it is done with it (#209).
 *
 * setStrategy() and close() call ContextStrategy.detach?() on the strategy
 * they let go of. AutobiographicalStrategy then discards a compression that
 * was in flight, instead of writing its summary and chunk record into a
 * store and namespace that another strategy now owns, and its background
 * drain makes no further provider call. Setting the same instance again
 * initializes it as before. close() is final: the manager then refuses each
 * operation that writes or calls into the strategy, naming it.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';
import { Membrane, MembraneError, MockAdapter, abortError } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy, CompressionWithdrawn } from '../src/index.js';

const TEST_STORE_PATH = './test-strategy-detach';
const SUMMARIES = 'default/autobio:summaries';
const MERGE_QUEUE = 'default/autobio:mergeQueue';
const CHUNKS = 'default/autobio:chunks';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

const filler = (n: number) => 'word '.repeat(n);

/** A membrane whose compression calls each wait until the test answers them
 *  (release) or fails them (fail). */
function heldMembrane() {
  const calls: Array<{ request: unknown; release: (content?: unknown[], stopReason?: string) => void; fail: (error: unknown) => void }> = [];
  return {
    calls,
    membrane: {
      complete: (request: unknown) => new Promise((resolve, reject) => {
        const n = calls.length + 1;
        calls.push({
          request,
          release: (content = [{ type: 'text', text: `Summary #${n}` }], stopReason = 'end_turn') => resolve({ stopReason, content }),
          fail: reject,
        });
      }),
    },
  };
}

/** Membrane's cancellation: what `complete()` rejects with once the caller's
 *  signal fires. */
const cancellation = () => abortError();

/** heldMembrane, honouring the signal each call carries as membrane does: a
 *  call whose signal is aborted rejects at once with a cancellation. */
function signalledMembrane() {
  const calls: Array<{ request: unknown; signal: AbortSignal | undefined; release: (content?: unknown[], stopReason?: string) => void; fail: (error: unknown) => void }> = [];
  return {
    calls,
    membrane: {
      complete: (request: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
        const n = calls.length + 1;
        const signal = options?.signal;
        signal?.addEventListener('abort', () => reject(cancellation()), { once: true });
        calls.push({
          request,
          signal,
          release: (content = [{ type: 'text', text: `Summary #${n}` }], stopReason = 'end_turn') => resolve({ stopReason, content }),
          fail: reject,
        });
      }),
    },
  };
}

/** A provider error that says nothing about the request. */
const serverError = () => Object.assign(new Error('zz server error'), { type: 'server', retryable: true, httpStatus: 500 });

function newStrategy(
  autoTickOnNewMessage = false,
  extra: Partial<ConstructorParameters<typeof AutobiographicalStrategy>[0]> = {},
) {
  return new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage,
    minChunkCharsForLLM: 0,
    l1HoldbackChunks: 0,
    ...extra,
  });
}

function seed(manager: ContextManager, count = 12) {
  for (let i = 0; i < count; i++) {
    manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${filler(30)}` }]);
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Whether `cond` holds within `ms`: waitFor that answers rather than throws,
 *  so a test can assert on it. */
async function reaches(cond: () => boolean, ms = 3000): Promise<boolean> {
  return waitFor(cond, ms).then(() => true, () => false);
}

/**
 * Whether `promise` settles within `ms`. The bound only keeps a regression
 * from hanging the suite, so it's set wide: a loaded host's stall needn't be
 * in proportion to the work waited on, and a promise that settles ends the
 * wait at once.
 */
async function settlesWithin(promise: Promise<unknown>, ms = 60_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function persisted(store: JsStore, id: string): unknown[] {
  try {
    return (store.getStateJson(id) as unknown[] | null) ?? [];
  } catch {
    return [];
  }
}

/** Every state the strategy keeps under the manager's namespace, by id. A
 *  state that can't be read is kept as its error, never taken for empty. */
function strategyStates(store: JsStore): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { id } of store.listStates()) {
    if (!id.startsWith('default/autobio:') && !id.startsWith('default/kvunified:')) continue;
    try {
      out[id] = store.getStateJson(id);
    } catch (error) {
      out[id] = `unreadable: ${(error as Error).message}`;
    }
  }
  return out;
}

/** No summary, and every state the strategy keeps as it was before the
 *  strategy was let go of. */
function assertNothingWritten(store: JsStore, statesBefore: Record<string, unknown>, when: string) {
  const states = strategyStates(store);
  const changed = [...new Set([...Object.keys(statesBefore), ...Object.keys(states)])]
    .filter((id) => JSON.stringify(states[id]) !== JSON.stringify(statesBefore[id]));
  assert.deepStrictEqual(
    changed,
    [],
    `written ${when}: ${persisted(store, SUMMARIES).length} summaries; changed states: ${changed.join(', ')}`,
  );
}

/** Count the drain's re-armed timers as they run, so a test can wait for the
 *  one it is about rather than for a fixed time. `onArm` runs as one is set;
 *  when it returns a promise, that timer runs once the promise settles. */
function watchDrainTimers(onArm?: () => void | Promise<unknown>) {
  const realSetTimeout = globalThis.setTimeout;
  const counts = { armed: 0, ran: 0 };
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 0 && String(fn).includes('driveSpeculativeDrain')) {
      counts.armed++;
      const before = onArm?.();
      return realSetTimeout(() => {
        void Promise.resolve(before).catch(() => {}).then(() => {
          try { fn(...args); } finally { counts.ran++; }
        });
      }, ms);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  return { counts, restore: () => { globalThis.setTimeout = realSetTimeout; } };
}

/** Count each time the strategy's background drain is driven, by a message or
 *  by its own re-armed timer. A drive the timer makes after the strategy was
 *  let go of is the drain going on, whether or not its tick reaches the
 *  provider before a test looks. */
function countDrives(strategy: AutobiographicalStrategy) {
  const s = strategy as unknown as { driveSpeculativeDrain: (ctx: unknown) => void };
  const real = s.driveSpeculativeDrain.bind(strategy);
  const counts = { drives: 0 };
  s.driveSpeculativeDrain = (ctx: unknown) => { counts.drives++; real(ctx); };
  return counts;
}

/** Count the compressions and merges the strategy starts, and the
 *  compressions that have settled. Nothing awaits between a compression's
 *  start and its wait on identical work in flight, so one that has started
 *  and not settled, with no new provider call, is waiting there. */
function watchWork(strategy: AutobiographicalStrategy) {
  const s = strategy as unknown as {
    compressChunkHierarchical: (...args: unknown[]) => Promise<void>;
    executeMerge: (...args: unknown[]) => Promise<void>;
  };
  const compress = s.compressChunkHierarchical.bind(strategy);
  const merge = s.executeMerge.bind(strategy);
  const counts = { compressions: 0, compressionsSettled: 0, merges: 0 };
  s.compressChunkHierarchical = (...args: unknown[]) => {
    counts.compressions++;
    const compressing = compress(...args);
    compressing.finally(() => { counts.compressionsSettled++; }).catch(() => {});
    return compressing;
  };
  s.executeMerge = (...args: unknown[]) => { counts.merges++; return merge(...args); };
  return counts;
}

/** What each executeMerge() of `strategy` resolves from now on: true when it wrote the merged parent. */
function mergeResults(strategy: AutobiographicalStrategy): unknown[] {
  const s = strategy as unknown as { executeMerge: (...args: unknown[]) => Promise<unknown> };
  const merge = s.executeMerge.bind(strategy);
  const results: unknown[] = [];
  s.executeMerge = async (...args: unknown[]) => {
    const wrote = await merge(...args);
    results.push(wrote);
    return wrote;
  };
  return results;
}

/** The first message id of each chunk in a strategy's compression queue, in queue order. */
function queueFirsts(strategy: AutobiographicalStrategy): string[] {
  const internals = strategy as unknown as { compressionQueue: number[]; chunks: Array<{ messages: Array<{ id: string }> }> };
  return internals.compressionQueue.map((index) => internals.chunks[index]?.messages[0]?.id ?? '?');
}

/** The first message id of the chunk at the head of a strategy's compression queue. */
function queueHead(strategy: AutobiographicalStrategy): string {
  return queueFirsts(strategy)[0];
}

/** The first source of each L1 summary the store holds. */
function l1Firsts(store: JsStore): string[] {
  return (persisted(store, SUMMARIES) as Array<{ level: number; sourceIds: string[] }>)
    .filter((summary) => summary.level === 1)
    .map((summary) => summary.sourceIds[0]);
}

/** console.error's and console.warn's lines while `fn` runs. */
async function logsDuring(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return lines;
}

/** The compression log's records written while `fn` runs, from the file
 *  CONTEXT_MANAGER_COMPRESSION_LOG names. */
async function compressionLogDuring(fn: () => Promise<void>): Promise<Array<Record<string, any>>> {
  const logPath = `${TEST_STORE_PATH}-compression-log.jsonl`;
  rmSync(logPath, { force: true });
  const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
  }
  const records = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
    : [];
  rmSync(logPath, { force: true });
  return records;
}

/** The phases of the discards a compression log records. */
const discardPhases = (records: Array<Record<string, any>>) =>
  records.filter((record) => record.event === 'compression:branch-result-discarded').map((record) => record.metadata?.phase);

/** Record how a promise ends, so a test can assert it resolved. */
function outcomeOf(promise: Promise<unknown>) {
  const result = { outcome: 'pending' };
  void promise.then(() => { result.outcome = 'resolved'; }, (e) => { result.outcome = `rejected: ${(e as Error).message}`; });
  return result;
}

/** Collect what would otherwise end the process: uncaught exceptions and
 *  unhandled rejections. */
function watchUnhandled() {
  const seen: string[] = [];
  const onError = (err: unknown) => { seen.push(String(err)); };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { seen, restore: () => { process.off('uncaughtException', onError); process.off('unhandledRejection', onError); } };
}

/** console.error's calls while `fn` runs. */
async function errorsDuring(fn: () => Promise<void>): Promise<unknown[][]> {
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return errors;
}

/**
 * A provider's refusal of the reasoning carriers in a request, typed as
 * membrane types a 400: an untyped error is transient, which interrupts the
 * ladder instead of taking the carrier fallback.
 */
const carrierRejection = () => Object.assign(
  new Error('invalid_request_error: thinking blocks in this request cannot be accepted'),
  { type: 'invalid_request', httpStatus: 400, retryable: false },
);

describe('a manager detaches the strategy it lets go of (#209)', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it('setStrategy(): the replaced strategy writes nothing from a compression in flight', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const replaced = newStrategy();
    const manager = await ContextManager.open({ store, strategy: replaced, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      const statesBefore = strategyStates(store);

      await manager.setStrategy(new PassthroughStrategy());
      calls[0].release();
      await ticking.catch(() => {});
      await settle();

      assertNothingWritten(store, statesBefore, 'after the swap');
      assert.throws(() => replaced.getStats(), /requires reinitialization/, "the replaced strategy's reads fail closed");
    } finally {
      manager.close();
      store.close();
    }
  });

  it('setStrategy(): a drain armed before the swap makes no further provider call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const timers = watchDrainTimers();
    const unhandled = watchUnhandled();
    const replaced = newStrategy(true);
    const drives = countDrives(replaced);
    const manager = await ContextManager.open({ store, strategy: replaced, membrane: membrane as never });
    try {
      seed(manager);
      await waitFor(() => calls.length === 1);
      const drivesBefore = drives.drives;

      await manager.setStrategy(new PassthroughStrategy());
      // The drain re-arms after the tick it was running; wait for that timer,
      // not one that ran while the messages went in. A drive it makes happens
      // before its run is counted.
      const ranBefore = timers.counts.ran;
      calls[0].release();
      await waitFor(() => timers.counts.ran > ranBefore);

      assert.strictEqual(drives.drives, drivesBefore, "the replaced strategy's drain was driven again after the swap");
      assert.strictEqual(calls.length, 1, `the replaced strategy's drain called the provider ${calls.length - 1} more time(s)`);
      assert.deepStrictEqual(persisted(store, SUMMARIES), [], 'no summary written after the swap');
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
    } finally {
      timers.restore();
      unhandled.restore();
      manager.close();
      store.close();
    }
  });

  it('close(): with an app-owned store, the strategy writes nothing from a compression in flight', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      const statesBefore = strategyStates(store);

      manager.close();
      assert.strictEqual(store.isClosed(), false, 'the app still owns its store');
      calls[0].release();
      await ticking.catch(() => {});
      await settle();

      assertNothingWritten(store, statesBefore, 'after close()');
    } finally {
      store.close();
    }
  });

  it('close(): with an app-owned store, a drain armed before it makes no further provider call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const timers = watchDrainTimers();
    const unhandled = watchUnhandled();
    const strategy = newStrategy(true);
    const drives = countDrives(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    let closed = false;
    try {
      seed(manager);
      await waitFor(() => calls.length === 1);
      const drivesBefore = drives.drives;

      manager.close();
      closed = true;
      assert.strictEqual(store.isClosed(), false, 'the app still owns its store');
      // The drain re-arms after the tick it was running; wait for that timer,
      // not one that ran while the messages went in. A drive it makes happens
      // before its run is counted.
      const ranBefore = timers.counts.ran;
      calls[0].release();
      await waitFor(() => timers.counts.ran > ranBefore);

      assert.strictEqual(drives.drives, drivesBefore, "the closed manager's strategy was driven again after close()");
      assert.strictEqual(calls.length, 1, `the closed manager's strategy called the provider ${calls.length - 1} more time(s)`);
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
    } finally {
      timers.restore();
      unhandled.restore();
      if (!closed) manager.close();
      store.close();
    }
  });

  it('the manager detaches a strategy only when it lets go of it', async () => {
    const detached: string[] = [];
    class Recording extends PassthroughStrategy {
      constructor(readonly label: string) { super(); }
      detach(): void { detached.push(this.label); }
    }
    const first = new Recording('first');
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: first });
    await manager.setStrategy(first);
    assert.deepStrictEqual(detached, [], 'setting the same instance again detaches nothing');
    await manager.setStrategy(new Recording('second'));
    assert.deepStrictEqual(detached, ['first'], 'a replacement detaches the strategy it replaces');
    manager.close();
    assert.deepStrictEqual(detached, ['first', 'second'], 'close() detaches the current strategy');
  });

  it('a strategy whose detach() throws is still replaced, and close() still closes an owned store', async () => {
    class ThrowingDetach extends PassthroughStrategy {
      initialized = 0;
      async initialize(): Promise<void> { this.initialized++; }
      detach(): void {
        throw new Error('detach failed');
      }
    }
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new ThrowingDetach(), namespace: 'agents/zz-throwing' });
      const replacement = new ThrowingDetach();
      await manager.setStrategy(replacement);
      assert.strictEqual(manager.getStrategy(), replacement);
      assert.strictEqual(replacement.initialized, 1, 'the replacement initialized');
      manager.addMessage('User', [{ type: 'text', text: 'still works' }]);
      manager.close();
      assert.strictEqual(manager.getStore().isClosed(), true, 'close() closed the store it owns');
      assert.strictEqual(errors.filter((args) => args[0] === 'Strategy detach failed: ns=agents/zz-throwing').length, 2, 'each failed detach is logged, naming its namespace');
    } finally {
      console.error = realError;
    }
  });

  it('a drain tick armed before the store\'s branch moved stops instead of throwing from its timer', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}` }] };
      },
    };
    const unhandled = watchUnhandled();
    let callsAtMove: number | undefined;
    // The drain re-arms with setTimeout(…, 0) after a tick that compressed;
    // move the store's branch directly, as a host may, before that timer runs.
    const timers = watchDrainTimers(() => {
      if (callsAtMove !== undefined) return;
      callsAtMove = calls;
      store.createBranch('elsewhere');
      store.switchBranch('elsewhere');
    });
    const manager = await ContextManager.open({ store, strategy: newStrategy(true), membrane: membrane as never });
    try {
      seed(manager);
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
      assert.strictEqual(calls, callsAtMove, 'the drain made no provider call after the branch moved');
    } finally {
      timers.restore();
      unhandled.restore();
      manager.close();
      store.close();
    }
  });

  it('setting the same instance again initializes it and it compresses as before', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.setStrategy(new PassthroughStrategy());
      await manager.setStrategy(strategy);

      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      calls[0].release();
      await ticking;

      assert.strictEqual(persisted(store, SUMMARIES).length, 1, 'the re-set strategy wrote its summary');
    } finally {
      manager.close();
      store.close();
    }
  });

  it('a compression whose first call fails on its reasoning carriers after the swap makes no second call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      // The first summary keeps its reasoning, so the next request's recall
      // pair carries it, and a carrier rejection would take the text-only retry.
      const first = manager.tick();
      await waitFor(() => calls.length === 1);
      calls[0].release([
        { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
        { type: 'text', text: 'Summary #1' },
      ]);
      await first;
      const second = manager.tick();
      await waitFor(() => calls.length === 2);
      assert.ok(JSON.stringify(calls[1].request).includes('"thinking"'), "the second request carries the first summary's reasoning");

      let ended = false;
      const records = await compressionLogDuring(async () => {
        await manager.setStrategy(new PassthroughStrategy());
        calls[1].fail(carrierRejection());
        ended = await settlesWithin(second);
        await settle(50);
      });

      assert.strictEqual(calls.length, 2, `the replaced strategy retried the call ${calls.length - 2} time(s)`);
      assert.ok(ended, 'the tick ended');
      assert.deepStrictEqual(discardPhases(records), ['canonical:error'], 'the discard is logged at the failed call');
    } finally {
      for (const call of calls.slice(2)) call.release();
      manager.close();
      store.close();
    }
  });

  it('close() of a manager that owns its store: a drain tick armed before it throws nothing from its timer', async () => {
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}` }] };
      },
    };
    const unhandled = watchUnhandled();
    let manager: ContextManager | undefined;
    let closed = false;
    // Close as the drain re-arms, so its timer runs after the store is gone.
    const timers = watchDrainTimers(() => {
      if (closed || !manager) return;
      closed = true;
      manager.close();
    });
    try {
      manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: newStrategy(true), membrane: membrane as never });
      seed(manager);
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.strictEqual(manager.getStore().isClosed(), true, 'close() closed the store it owns');
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
    } finally {
      timers.restore();
      unhandled.restore();
      if (manager && !closed) manager.close();
    }
  });

  it('close() of a manager that owns its store: a compression in flight discards its result quietly', async () => {
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: newStrategy(), membrane: membrane as never });
    seed(manager);
    await manager.compile();
    const ticking = manager.tick();
    await waitFor(() => calls.length === 1);
    let outcome = 'pending';
    const errors = await errorsDuring(async () => {
      manager.close();
      calls[0].release();
      await ticking.then(() => { outcome = 'resolved'; }, (e) => { outcome = `rejected: ${(e as Error).message}`; });
    });
    assert.strictEqual(manager.getStore().isClosed(), true, 'close() closed the store it owns');
    assert.strictEqual(outcome, 'resolved', 'the tick ends without an error');
    assert.deepStrictEqual(errors.filter((args) => String(args[0]).includes('Failed to compress')), [], 'no compression failure logged');
  });

  it('a drain armed before a swap stays stopped when the same instance is set again', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(true);
    const drives = countDrives(strategy);
    let drivesAtSwapBack: number | undefined;
    let manager: ContextManager | undefined;
    let swappedBack: Promise<unknown> | undefined;
    // As the drain re-arms after its first tick, swap the strategy out and
    // back in; the timer runs once the same instance is set again.
    const timers = watchDrainTimers(() => {
      if (swappedBack || !manager) return;
      const m = manager;
      swappedBack = m.setStrategy(new PassthroughStrategy())
        .then(() => m.setStrategy(strategy))
        .then(() => { drivesAtSwapBack = drives.drives; });
      return swappedBack;
    });
    try {
      manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      seed(manager);
      await waitFor(() => calls.length === 1);
      calls[0].release();
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.strictEqual(drives.drives, drivesAtSwapBack, 'the timer armed before the swap drove the drain again');
      assert.strictEqual(calls.length, 1, `the drain armed before the swap called the provider ${calls.length - 1} more time(s)`);
    } finally {
      timers.restore();
      manager?.close();
      store.close();
    }
  });

  it("a drain running when the manager's switchBranch() re-initializes the strategy stops, and the next message starts the new branch's drain", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(true);
    const drives = countDrives(strategy);
    let drivesAtSwitch: number | undefined;
    let manager: ContextManager | undefined;
    let switched: Promise<unknown> | undefined;
    // As the drain re-arms after its first tick, switch the manager to another
    // branch, as a host's branch surgery does; the timer runs once the
    // switch's re-initialization is done.
    const timers = watchDrainTimers(() => {
      if (switched || !manager) return;
      const m = manager;
      store.createBranch('elsewhere');
      switched = m.switchBranch('elsewhere').then(() => { drivesAtSwitch = drives.drives; });
      return switched;
    });
    try {
      manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      seed(manager);
      // The drain can re-arm, and the switch run, while this first call is
      // still out; a drain that goes on then calls again at once, so wait for
      // at least one call rather than exactly one.
      await waitFor(() => calls.length >= 1);
      calls[0].release();
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.strictEqual(drives.drives, drivesAtSwitch, 'the timer armed before the switch drove the drain again');
      assert.strictEqual(calls.length, 1, `the drain armed before the switch called the provider ${calls.length - 1} more time(s)`);

      manager.addMessage('User', [{ type: 'text', text: `after the switch ${filler(30)}` }]);
      await waitFor(() => calls.length === 2);
      assert.ok(drives.drives > (drivesAtSwitch ?? Infinity), "the next message drove the new branch's drain");
    } finally {
      timers.restore();
      for (const call of calls.slice(1)) call.release();
      manager?.close();
      store.close();
    }
  });

  it('a tick whose quarantine sweep spans the swap ends there, and its alarm stays quiet', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const alarms: unknown[] = [];
    strategy.setQuarantineAlarmHandler((status) => { alarms.push(status); });
    let openSweep!: () => void;
    const sweep = new Promise<void>((resolve) => { openSweep = resolve; });
    let sweeping = false;
    const internals = strategy as unknown as { sweepPaidOffQuarantineRecords: () => Promise<void>; quarantineAlarmActive: boolean };
    internals.sweepPaidOffQuarantineRecords = () => { sweeping = true; return sweep; };
    // An alarm episode is open, so with no quarantine left the all-clear
    // would sound once the sweep returns.
    internals.quarantineAlarmActive = true;
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      let outcome = 'pending';
      const ticking = manager.tick().then(() => { outcome = 'resolved'; }, (e) => { outcome = `rejected: ${(e as Error).message}`; });
      assert.ok(await reaches(() => sweeping), 'the tick reached its quarantine sweep');
      await manager.setStrategy(new PassthroughStrategy());
      openSweep();
      await settlesWithin(ticking);
      assert.strictEqual(calls.length, 0, 'the tick started no compression');
      assert.strictEqual(outcome, 'resolved', 'the tick ends without an error');
      assert.deepStrictEqual(alarms, [], 'no all-clear from the replaced strategy');
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it("a replacement that joins the replaced strategy's compression in flight puts the chunk back once that work is thrown away, and its next tick compresses it", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const replacedTick = manager.tick();
      await waitFor(() => calls.length === 1);

      const replacement = newStrategy();
      const work = watchWork(replacement);
      await manager.setStrategy(replacement);
      await manager.compile();
      const joined = queueHead(replacement);
      const replacementTick = manager.tick();
      const replacementEnd = outcomeOf(replacementTick);
      assert.ok(await reaches(() => work.compressions === 1), 'the replacement started compressing');
      assert.deepStrictEqual(
        [work.compressionsSettled, calls.length],
        [0, 1],
        "the replacement waits on the replaced strategy's call for the same chunk",
      );

      calls[0].release();
      assert.ok(await settlesWithin(replacedTick.catch(() => {})), "the replaced strategy's tick settled");
      // Its scan goes on to the chunk behind the one it put back.
      assert.ok(await reaches(() => calls.length === 2), 'the replacement went on to the next chunk');
      assert.strictEqual(queueHead(replacement), joined, 'the chunk whose work was thrown away is back at the head of the queue');
      calls[1].release();
      assert.ok(await settlesWithin(replacementTick), "the replacement's tick settled");
      assert.strictEqual(replacementEnd.outcome, 'resolved', "the replacement's tick ended quietly");

      const next = manager.tick();
      assert.ok(await reaches(() => calls.length === 3), 'its next tick asked for the chunk it put back');
      calls[2].release();
      assert.ok(await settlesWithin(next), 'that tick settled');
      const firsts = l1Firsts(store);
      assert.strictEqual(firsts.length, 2, `one summary each for the two chunks: ${JSON.stringify(firsts)}`);
      assert.ok(firsts.includes(joined), `the chunk put back has its summary: ${JSON.stringify(firsts)}`);
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it("a chunk whose joined work was thrown away isn't put back where a rebuild during the wait left it out, and a tick after the hold's release compresses it", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const replacedTick = manager.tick();
      await waitFor(() => calls.length === 1);

      const replacement = newStrategy();
      const work = watchWork(replacement);
      await manager.setStrategy(replacement);
      await manager.compile();
      const internals = replacement as unknown as { compressionQueue: number[]; chunks: Array<{ messages: Array<{ id: string }> }> };
      const joinedIds = internals.chunks[internals.compressionQueue[0]].messages.map((message) => message.id);
      const replacementTick = manager.tick();
      const replacementEnd = outcomeOf(replacementTick);
      assert.ok(await reaches(() => work.compressions === 1), 'the replacement started compressing');

      // While it waits, a hold covers the joined chunk, and a message's
      // arrival rebuilds the queue, which leaves out the held chunk and those
      // after it.
      manager.holdCompression(joinedIds);
      manager.addMessage('User', [{ type: 'text', text: `late ${filler(30)}` }]);
      calls[0].release();
      assert.ok(await settlesWithin(replacedTick.catch(() => {})), "the replaced strategy's tick settled");
      assert.ok(await settlesWithin(replacementTick), "the replacement's tick settled");
      assert.strictEqual(replacementEnd.outcome, 'resolved', "the replacement's tick ended quietly");
      assert.strictEqual(calls.length, 1, `the replacement made ${calls.length - 1} call(s) while a hold covered the chunk`);
      assert.ok(!queueFirsts(replacement).includes(joinedIds[0]), 'the chunk the rebuild left out is not put back');

      manager.releaseCompression(joinedIds);
      const released = manager.tick();
      assert.ok(await reaches(() => calls.length === 2), 'a tick after the release asks for the chunk');
      calls[1].release();
      assert.ok(await settlesWithin(released), 'that tick settled');
      assert.ok(l1Firsts(store).includes(joinedIds[0]), 'the chunk has its summary');
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it('a detach() that returns a rejected promise is logged, not left unhandled', async () => {
    class AsyncDetach extends PassthroughStrategy {
      async detach(): Promise<void> {
        throw new Error('async detach failed');
      }
    }
    const unhandled = watchUnhandled();
    try {
      const errors = await errorsDuring(async () => {
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new AsyncDetach(), namespace: 'agents/zz-async' });
        await manager.setStrategy(new PassthroughStrategy());
        await settle(20);
        manager.close();
      });
      assert.deepStrictEqual(unhandled.seen, [], 'no unhandled rejection');
      assert.ok(
        errors.some((args) => args[0] === 'Strategy detach failed: ns=agents/zz-async' && args[1] === 'passthrough' && String(args[2]).includes('async detach failed')),
        'the rejection is logged with the strategy\'s name and the manager\'s namespace',
      );
    } finally {
      unhandled.restore();
    }
  });

  it("two strategies waiting on a replaced strategy's compression each put the chunk back, and their next ticks compress it with one call between them", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    let other: ContextManager | undefined;
    try {
      seed(manager);
      await manager.compile();
      const replacedTick = manager.tick();
      await waitFor(() => calls.length === 1);

      // One waiter in a second manager on the same store and namespace, and
      // one in the first manager, replacing the strategy whose call is out.
      const otherStrategy = newStrategy();
      const otherWork = watchWork(otherStrategy);
      other = await ContextManager.open({ store, strategy: otherStrategy, membrane: membrane as never });
      await other.compile();
      const joined = queueHead(otherStrategy);
      const otherTick = other.tick();
      const otherEnd = outcomeOf(otherTick);
      assert.ok(await reaches(() => otherWork.compressions === 1), "the second manager's strategy started compressing");
      const replacement = newStrategy();
      const replacementWork = watchWork(replacement);
      await manager.setStrategy(replacement);
      await manager.compile();
      const replacementTick = manager.tick();
      const replacementEnd = outcomeOf(replacementTick);
      assert.ok(await reaches(() => replacementWork.compressions === 1), 'the replacement started compressing');
      assert.deepStrictEqual(
        [otherWork.compressionsSettled, replacementWork.compressionsSettled, calls.length],
        [0, 0, 1],
        "both wait on the replaced strategy's call for the same chunk",
      );

      calls[0].release();
      assert.ok(await settlesWithin(replacedTick.catch(() => {})), "the replaced strategy's tick settled");
      // Each goes on to the chunk behind, which one asks for and the other joins.
      assert.ok(await reaches(() => calls.length === 2), 'one of them asked for the next chunk');
      calls[1].release();
      assert.ok(await settlesWithin(Promise.all([otherTick, replacementTick])), 'both ticks settled');
      assert.deepStrictEqual([otherEnd.outcome, replacementEnd.outcome], ['resolved', 'resolved'], 'both ticks resolved');
      assert.strictEqual(calls.length, 2, 'the other joined that call instead of making its own');
      assert.deepStrictEqual([queueHead(otherStrategy), queueHead(replacement)], [joined, joined], 'both put the chunk back at the head of their queues');

      const otherNext = other.tick();
      const replacementNext = manager.tick();
      assert.ok(await reaches(() => calls.length === 3), 'one of them asked for the chunk they put back');
      calls[2].release();
      assert.ok(await settlesWithin(Promise.all([otherNext, replacementNext])), 'both next ticks settled');
      assert.strictEqual(calls.length, 3, 'the other joined that call too');
      const firsts = l1Firsts(store);
      assert.strictEqual(firsts.length, 2, `one summary each for the two chunks: ${JSON.stringify(firsts)}`);
      assert.ok(firsts.includes(joined), `the chunk put back has its summary: ${JSON.stringify(firsts)}`);
    } finally {
      for (const call of calls) call.release();
      other?.close();
      manager.close();
      store.close();
    }
  });

  it("a strategy waiting on a compression that quarantined the chunk before its strategy was let go of makes no call of its own", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    // No fallback variants, so refusals exhaust the chunk's request family.
    const producer = newStrategy(false, { compressionRefusalCurveFallbacks: 0 });
    const manager = await ContextManager.open({ store, strategy: producer, membrane: membrane as never });
    let other: ContextManager | undefined;
    try {
      // Once armed, the producer's next alert delivery, which comes after it
      // writes the exhausted record, waits until the test lets it go.
      const internals = producer as unknown as { deliverPendingCompressionQuarantineAlerts: (source: unknown) => Promise<void> };
      const deliver = internals.deliverPendingCompressionQuarantineAlerts.bind(producer);
      let armed = false;
      let delivering = false;
      let openDelivery!: () => void;
      const delivery = new Promise<void>((resolve) => { openDelivery = resolve; });
      internals.deliverPendingCompressionQuarantineAlerts = async (source) => {
        if (armed) {
          armed = false;
          delivering = true;
          await delivery;
        }
        return deliver(source);
      };
      seed(manager);
      await manager.compile();
      const producing = manager.tick();
      await waitFor(() => calls.length === 1);

      // A strategy in a second manager on the same store waits on that call.
      const waiter = newStrategy(false, { compressionRefusalCurveFallbacks: 0 });
      const waiterWork = watchWork(waiter);
      other = await ContextManager.open({ store, strategy: waiter, membrane: membrane as never });
      await other.compile();
      const waiting = other.tick();
      const waited = outcomeOf(waiting);
      assert.ok(await reaches(() => waiterWork.compressions === 1), "the second manager's strategy started compressing");
      assert.deepStrictEqual([waiterWork.compressionsSettled, calls.length], [0, 1], "it waits on the producer's call");

      // Refusals exhaust the family: the producer writes its exhausted record,
      // and its strategy is let go of while it delivers the alert.
      armed = true;
      let answered = 0;
      while (!delivering) {
        if (calls.length > answered) {
          calls[answered++].release([], 'refusal');
          continue;
        }
        if (!(await reaches(() => delivering || calls.length > answered))) break;
      }
      assert.ok(delivering, 'the producer quarantined the chunk and is delivering its alert');
      await manager.setStrategy(new PassthroughStrategy());
      openDelivery();
      await settlesWithin(producing.catch(() => {}));
      await settlesWithin(waiting);

      assert.strictEqual(waiterWork.compressions, 1, "the waiter found the chunk's quarantine in the ledger and compressed nothing more");
      assert.strictEqual(calls.length, answered, `the waiter made ${calls.length - answered} call(s) for a quarantined chunk`);
      assert.strictEqual(waited.outcome, 'resolved', "the waiter's tick ended quietly");
      assert.deepStrictEqual(persisted(store, SUMMARIES), [], 'no summary written');
    } finally {
      for (const call of calls) call.release();
      other?.close();
      manager.close();
      store.close();
    }
  });

  it("a merge whose first call fails on its reasoning carriers after the swap makes no second call", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    // Two L1s are a merge, and with two unmerged a tick merges before it
    // compresses another chunk.
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      // Two L1s, their merge, and two more L1s, each answer keeping its
      // reasoning. The second merge's request then carries the first two L1s
      // as recall pairs ahead of its own sources, reasoning included.
      for (let n = 1; n <= 5; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release([
          { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
          { type: 'text', text: `Summary #${n}` },
        ]);
        await tick;
      }
      const merges = mergeResults(strategy);
      const merging = manager.tick();
      await waitFor(() => calls.length === 6);
      assert.deepStrictEqual(work, { compressions: 4, compressionsSettled: 4, merges: 2 }, 'the sixth call is the second merge');
      assert.ok(JSON.stringify(calls[5].request).includes('"thinking"'), "the merge's request carries earlier summaries' reasoning");

      const merged = outcomeOf(merging);
      await manager.setStrategy(new PassthroughStrategy());
      calls[5].fail(carrierRejection());
      await settlesWithin(merging);

      assert.strictEqual(calls.length, 6, `the replaced strategy retried the merge ${calls.length - 6} time(s)`);
      assert.deepStrictEqual(merges, [false], 'the merge resolved as one that wrote nothing, so no landing is counted');
      // The failure reached a merge whose strategy was let go of, which
      // discards it as it would the call's result.
      assert.strictEqual(merged.outcome, 'resolved', 'the tick ended quietly');
    } finally {
      for (const call of calls.slice(6)) call.release();
      manager.close();
      store.close();
    }
  });

  it("a strategy let go of while it waits on another instance's compression ends its tick quietly and takes nothing up", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    let other: ContextManager | undefined;
    try {
      seed(manager);
      await manager.compile();
      const producing = manager.tick();
      await waitFor(() => calls.length === 1);

      // A strategy in a second manager on the same store waits on that call,
      // and that manager lets it go while it waits.
      const waiter = newStrategy();
      const waiterWork = watchWork(waiter);
      other = await ContextManager.open({ store, strategy: waiter, membrane: membrane as never });
      await other.compile();
      const waiting = other.tick();
      const waited = outcomeOf(waiting);
      assert.ok(await reaches(() => waiterWork.compressions === 1), "the second manager's strategy started compressing");
      await other.setStrategy(new PassthroughStrategy());

      calls[0].release();
      await settlesWithin(producing);
      await settlesWithin(waiting);

      assert.strictEqual(waited.outcome, 'resolved', "the let-go waiter's tick ended quietly");
      assert.strictEqual(calls.length, 1, `the let-go waiter made ${calls.length - 1} call(s)`);
      assert.strictEqual(waiterWork.compressions, 1, 'it took nothing over');
      const held = (waiter as unknown as { summaries: unknown[] }).summaries;
      assert.deepStrictEqual(held, [], "it took up none of the store's state after it was let go of");
      assert.strictEqual(persisted(store, SUMMARIES).length, 1, "the producer's summary is written");
    } finally {
      for (const call of calls) call.release();
      other?.close();
      manager.close();
      store.close();
    }
  });

  it("a replacement waiting on the replaced strategy's compression starts nothing while a hold covers the chunk, and compresses it after the release", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const replacedTick = manager.tick();
      await waitFor(() => calls.length === 1);
      const replacement = newStrategy();
      const work = watchWork(replacement);
      await manager.setStrategy(replacement);
      await manager.compile();
      const joined = queueHead(replacement);
      const replacementTick = manager.tick();
      const replacementEnd = outcomeOf(replacementTick);
      assert.ok(await reaches(() => work.compressions === 1), 'the replacement started compressing');
      assert.deepStrictEqual([work.compressionsSettled, calls.length], [0, 1], "it waits on the replaced strategy's call");

      const ids = manager.getAllMessages().map((message) => message.id);
      manager.holdCompression(ids);
      calls[0].release();
      assert.ok(await settlesWithin(replacedTick.catch(() => {})), "the replaced strategy's tick settled");
      assert.ok(await settlesWithin(replacementTick), "the replacement's tick settled");
      assert.strictEqual(calls.length, 1, `the replacement made ${calls.length - 1} call(s) while a hold covered the chunk`);
      assert.strictEqual(replacementEnd.outcome, 'resolved', "the replacement's tick ended quietly");
      assert.ok(await settlesWithin(manager.tick()), 'a tick while the hold stands settled');
      assert.strictEqual(calls.length, 1, 'a tick while the hold stands starts nothing');

      manager.releaseCompression(ids);
      const released = manager.tick();
      assert.ok(await reaches(() => calls.length === 2), 'a tick after the release asks for the chunk');
      calls[1].release();
      assert.ok(await settlesWithin(released), 'that tick settled');
      assert.deepStrictEqual(l1Firsts(store), [joined], 'the chunk has its summary');
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it("a strategy waiting on a compression that wrote its summary before its strategy was let go of takes that summary up, and compresses nothing", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const producer = newStrategy();
    const manager = await ContextManager.open({ store, strategy: producer, membrane: membrane as never });
    let other: ContextManager | undefined;
    try {
      seed(manager);
      await manager.compile();
      // The producer's clear after its summary waits until the test lets it go.
      const internals = producer as unknown as { clearQuarantineForCompressedChunk: (chunk: unknown) => Promise<void> };
      const clear = internals.clearQuarantineForCompressedChunk.bind(producer);
      let clearing = false;
      let openClear!: () => void;
      const clearGate = new Promise<void>((resolve) => { openClear = resolve; });
      internals.clearQuarantineForCompressedChunk = async (chunk) => {
        clearing = true;
        await clearGate;
        return clear(chunk);
      };
      const producing = manager.tick();
      await waitFor(() => calls.length === 1);

      // A strategy in a second manager on the same store waits on that call.
      const waiter = newStrategy();
      const waiterWork = watchWork(waiter);
      other = await ContextManager.open({ store, strategy: waiter, membrane: membrane as never });
      await other.compile();
      const waiting = other.tick();
      const waited = outcomeOf(waiting);
      assert.ok(await reaches(() => waiterWork.compressions === 1), "the second manager's strategy started compressing");

      // The producer writes its summary, and is let go of while its clear waits.
      calls[0].release();
      assert.ok(await reaches(() => clearing), "the producer's summary is written and its clear is waiting");
      await manager.setStrategy(new PassthroughStrategy());
      openClear();
      await settlesWithin(producing.catch(() => {}));
      await settlesWithin(waiting);

      assert.strictEqual(waiterWork.compressions, 1, 'the waiter took the summary up rather than compressing the chunk again');
      assert.strictEqual(calls.length, 1, `the waiter made ${calls.length - 1} call(s) for a chunk with a summary`);
      assert.strictEqual(waited.outcome, 'resolved', "the waiter's tick ended quietly");
      const written = persisted(store, SUMMARIES) as Array<{ id: string }>;
      assert.strictEqual(written.length, 1, 'one summary for the chunk');
      const adopted = waiter as unknown as { summaries: Array<{ id: string }>; chunks: Array<{ compressed?: boolean; summaryId?: string }> };
      assert.ok(adopted.summaries.some((summary) => summary.id === written[0].id), "the waiter holds the producer's summary");
      assert.ok(
        adopted.chunks.some((chunk) => chunk.compressed && chunk.summaryId === written[0].id),
        "the waiter's chunk is marked compressed by the producer's summary",
      );
    } finally {
      for (const call of calls) call.release();
      other?.close();
      manager.close();
      store.close();
    }
  });

  it('a detach() that returns a rejecting thenable is logged too', async () => {
    class ThenableDetach extends PassthroughStrategy {
      detach(): PromiseLike<void> {
        const thenable = { then: (_resolve: unknown, reject: (error: unknown) => void) => reject(new Error('thenable detach failed')) };
        return thenable as unknown as PromiseLike<void>;
      }
    }
    const unhandled = watchUnhandled();
    try {
      const errors = await errorsDuring(async () => {
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new ThenableDetach(), namespace: 'agents/zz-thenable' });
        await manager.setStrategy(new PassthroughStrategy());
        await settle(20);
        manager.close();
      });
      assert.deepStrictEqual(unhandled.seen, [], 'no unhandled rejection');
      assert.ok(
        errors.some((args) => args[0] === 'Strategy detach failed: ns=agents/zz-thenable' && args[1] === 'passthrough' && String(args[2]).includes('thenable detach failed')),
        "the rejection is logged with the strategy's name and the manager's namespace",
      );
    } finally {
      unhandled.restore();
    }
  });

  for (const owned of [false, true]) {
    it(`after close(), the manager refuses each mutation and strategy operation by name, ${owned ? 'with the store it owned closed' : 'while the app keeps its store open'}`, async () => {
      class Watched extends PassthroughStrategy {
        detaches = 0;
        messages = 0;
        detach(): void { this.detaches++; }
        async onNewMessage(): Promise<void> { this.messages++; }
      }
      const strategy = new Watched();
      const store = owned ? undefined : JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const manager = await ContextManager.open(owned ? { path: TEST_STORE_PATH, strategy } : { store: store!, strategy });
      try {
        seed(manager, 2);
        assert.strictEqual(strategy.messages, 2, 'messages reach the strategy before close()');
        const id = manager.getAllMessages()[0].id;
        const branch = manager.currentBranch().name;
        manager.close();
        manager.close();
        assert.strictEqual(strategy.detaches, 1, 'a second close() detaches nothing more');
        assert.strictEqual(manager.isClosed(), true, 'the manager says it is closed');
        assert.strictEqual(manager.getStore().isClosed(), owned, owned ? 'the store it owned is closed' : "the app's store stays open");
        if (!owned) {
          // Inspection of messages, branches and receipts, and the manager's
          // own setters, still answer.
          assert.strictEqual(manager.getMessageCount(), 2, 'messages still read');
          assert.strictEqual(manager.currentBranch().name, branch, 'the branch still reads');
          assert.ok(manager.listBranches().length >= 1, 'branches still list');
          manager.listFoldReceipts();
          manager.setSystemPrompt('after close');
          manager.setToolDefinitions(undefined);
          manager.releaseCompression([id]);
        }

        // Each operation's name and arguments; the refusal comes first, so
        // the arguments needn't be valid.
        const operations: Array<[string, unknown[], string?]> = [
          ['addMessage', ['User', [{ type: 'text', text: 'after close' }]]],
          ['editMessage', [id, [{ type: 'text', text: 'after close' }]]],
          ['removeMessage', [id]],
          ['removeMessages', [id, id]],
          ['branchAt', [id]],
          ['switchBranch', [branch]],
          ['fork', []],
          ['isReady', []],
          ['getPendingWork', []],
          ['compile', []],
          ['acceptRound', [{ provenance: {} }]],
          ['setStrategy', [new PassthroughStrategy()]],
          ['getHotContextSettings', []],
          ['updateHotContextSettings', [{}]],
          ['previewContext', [{}]],
          ['pinRange', [id, id]],
          ['pinAtLevel', [id, id, 1]],
          ['markDocument', [id]],
          ['unpin', ['pin']],
          ['listPins', []],
          ['searchSummaries', ['query']],
          ['getSummary', ['summary']],
          ['getSummariesInRange', [id, id]],
          ['getMaxSummaryLevel', []],
          ['getRenderStats', []],
          ['resetHeadWindow', []],
          ['tick', []],
        ];
        const m = manager as unknown as Record<string, (...args: unknown[]) => unknown>;
        for (const [name, args, operation = name] of operations) {
          await assert.rejects(
            async () => { await m[name](...args); },
            { message: `ContextManager.${operation} after close()` },
            `${name} refuses`,
          );
        }
        assert.strictEqual(strategy.messages, 2, 'no message reached the strategy after close()');
      } finally {
        store?.close();
      }
    });
  }

  it('after close(), a hold released through the manager reaches no strategy', async () => {
    class CountsReleases extends PassthroughStrategy {
      releases = 0;
      onCompressionHoldsReleased(): void { this.releases++; }
    }
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = new CountsReleases();
    const manager = await ContextManager.open({ store, strategy });
    try {
      const before = manager.addMessage('User', [{ type: 'text', text: 'released before close' }], undefined, undefined, { holdCompression: true });
      const after = manager.addMessage('User', [{ type: 'text', text: 'released after close' }], undefined, undefined, { holdCompression: true });
      manager.releaseCompression([before]);
      assert.strictEqual(strategy.releases, 1, 'a release before close() reaches the strategy');
      manager.close();
      manager.releaseCompression([after]);
      assert.strictEqual(strategy.releases, 1, 'a release after close() reaches no strategy');
    } finally {
      store.close();
    }
  });

  it("a compression's next attempt after the swap makes no call", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      // The swap lands as the second attempt is prepared, after the first
      // attempt's own check passed: between two attempts of one compression.
      const internals = strategy as unknown as { prepareCompressionCandidate: (request: unknown, label: string) => unknown };
      const prepare = internals.prepareCompressionCandidate.bind(strategy);
      let swapping: Promise<void> | undefined;
      internals.prepareCompressionCandidate = (request, label) => {
        if (label === 'canonical-no-tools' && !swapping) swapping = manager.setStrategy(new PassthroughStrategy());
        return prepare(request, label);
      };
      let ended = { outcome: 'pending' };
      const records = await compressionLogDuring(async () => {
        const ticking = manager.tick();
        ended = outcomeOf(ticking);
        await waitFor(() => calls.length === 1);
        // A tool call takes the compression to its no-tools attempt.
        calls[0].release([{ type: 'tool_use', id: 'tool-1', name: 'note', input: {} }], 'tool_use');
        await settlesWithin(ticking);
        if (swapping) await settlesWithin(swapping);
      });

      assert.ok(swapping, 'the second attempt began after the tool call');
      assert.strictEqual(calls.length, 1, `the replaced strategy made ${calls.length - 1} more call(s)`);
      assert.strictEqual(ended.outcome, 'resolved', 'the tick ended quietly');
      assert.deepStrictEqual(discardPhases(records), ['canonical-no-tools:before_call'], 'the discard is logged as before the call');
      assert.deepStrictEqual(persisted(store, SUMMARIES), [], 'no summary written');
    } finally {
      for (const call of calls.slice(1)) call.release();
      manager.close();
      store.close();
    }
  });

  it('a strategy replaced while it initializes is detached again once its initialize() returns, and a newer initialization of the same instance is not', async () => {
    // Each initialize() call waits on its own gate, then starts work, as a
    // timer would be armed.
    class GatedInitialize extends PassthroughStrategy {
      gates: Array<() => void> = [];
      running = false;
      detaches = 0;
      async initialize(): Promise<void> {
        await new Promise<void>((resolve) => { this.gates.push(resolve); });
        this.running = true;
      }
      detach(): void { this.detaches++; this.running = false; }
    }
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const manager = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
    try {
      // Replaced: setStrategy(replaced) is superseded by setStrategy(next).
      const replaced = new GatedInitialize();
      const replacing = manager.setStrategy(replaced);
      await waitFor(() => replaced.gates.length === 1);
      const next = new GatedInitialize();
      const nexting = manager.setStrategy(next);
      await waitFor(() => next.gates.length === 1);
      replaced.gates[0]();
      await assert.rejects(replacing, { name: 'InitializationSupersededError' });
      assert.strictEqual(replaced.running, false, 'the work the replaced strategy started after it was replaced is stopped');
      assert.strictEqual(replaced.detaches, 2, 'detached as it was replaced, and again once its initialize() returned');

      // The same instance: a switchBranch() supersedes next's first
      // initialization with a second one of its own.
      const switching = manager.switchBranch(manager.currentBranch().name);
      await waitFor(() => next.gates.length === 2);
      next.gates[0]();
      await assert.rejects(nexting, { name: 'InitializationSupersededError' });
      next.gates[1]();
      await switching;
      assert.strictEqual(next.detaches, 0, 'a newer initialization of the same instance is left alone');
      assert.strictEqual(next.running, true, 'and its strategy runs');
    } finally {
      manager.close();
      store.close();
    }
  });

  for (const operation of ['setStrategy', 'switchBranch', 'fork'] as const) {
    it(`a close() while ${operation}() initializes the strategy fails that call, and detaches the strategy again`, async () => {
      let openInitialize!: () => void;
      const gate = new Promise<void>((resolve) => { openInitialize = resolve; });
      let initializing = false;
      // Work it starts at the end of initialize(), as a timer would be.
      class SlowInitialize extends PassthroughStrategy {
        gated = false;
        running = false;
        detaches = 0;
        async initialize(): Promise<void> {
          if (!this.gated) return;
          initializing = true;
          await gate;
          this.running = true;
        }
        detach(): void { this.detaches++; this.running = false; }
      }
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const first = new SlowInitialize();
      const manager = await ContextManager.open({ store, strategy: first });
      try {
        let initialized: SlowInitialize;
        let call: Promise<unknown>;
        if (operation === 'setStrategy') {
          initialized = new SlowInitialize();
          initialized.gated = true;
          call = manager.setStrategy(initialized);
        } else {
          initialized = first;
          initialized.gated = true;
          call = operation === 'switchBranch' ? manager.switchBranch(manager.currentBranch().name) : manager.fork();
        }
        assert.ok(await reaches(() => initializing), 'the strategy is initializing');
        manager.close();
        openInitialize();
        await assert.rejects(call, { message: 'ContextManager closed during strategy initialization' });
        assert.strictEqual(initialized.running, false, 'the work it started after close() is stopped');
        assert.strictEqual(initialized.detaches, 2, 'close() detached it, and the manager again once initialize() returned');
      } finally {
        store.close();
      }
    });
  }

  it("a second close() does nothing, even when the first one's store close threw", async () => {
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new PassthroughStrategy() });
    const store = manager.getStore() as unknown as { close: () => void };
    const realClose = store.close.bind(store);
    let closes = 0;
    // As Chronicle 0.4.0's does when its final sync fails: the store is
    // closed, and then the sync's error is thrown.
    store.close = () => {
      closes++;
      realClose();
      if (closes === 1) throw new Error('sync failed');
    };
    try {
      assert.throws(() => manager.close(), /sync failed/);
      assert.ok(manager.getStore().isClosed(), 'the failed close closed the store');
      manager.close();
      assert.strictEqual(closes, 1, "the second close() called the store's close() again");
    } finally {
      if (!manager.getStore().isClosed()) realClose();
    }
  });

  for (const letGo of ['close', 'setStrategy'] as const) {
    it(`a strategy whose initialize() rejects after ${letGo === 'close' ? 'a close()' : 'a replacement'} let go of it is detached again`, async () => {
      let openInitialize!: () => void;
      const gate = new Promise<void>((resolve) => { openInitialize = resolve; });
      // It starts work, as a timer would be armed, and then fails.
      class FailingInitialize extends PassthroughStrategy {
        initializing = false;
        running = false;
        detaches = 0;
        async initialize(): Promise<void> {
          this.initializing = true;
          await gate;
          this.running = true;
          throw new Error('initialize failed');
        }
        detach(): void { this.detaches++; this.running = false; }
      }
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const manager = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      try {
        const failing = new FailingInitialize();
        const call = manager.setStrategy(failing);
        assert.ok(await reaches(() => failing.initializing), 'the strategy is initializing');
        if (letGo === 'close') manager.close();
        else await manager.setStrategy(new PassthroughStrategy());
        openInitialize();
        assert.ok(await settlesWithin(call), 'the call settled');
        await assert.rejects(call, { message: 'initialize failed' });
        assert.strictEqual(failing.running, false, 'the work it started before it failed is stopped');
        assert.strictEqual(failing.detaches, 2, `detached by the ${letGo === 'close' ? 'close()' : 'replacement'}, and again once its initialize() rejected`);
      } finally {
        manager.close();
        store.close();
      }
    });
  }

  it('a strategy whose earlier initialize() rejects while a newer initialization of the same instance runs is not detached', async () => {
    // Each initialize() call waits on its own gate; the first then fails,
    // and the second starts work, as a timer would be armed.
    class GatedInitialize extends PassthroughStrategy {
      gates: Array<() => void> = [];
      running = false;
      detaches = 0;
      async initialize(): Promise<void> {
        const first = this.gates.length === 0;
        await new Promise<void>((resolve) => { this.gates.push(resolve); });
        if (first) throw new Error('first initialize failed');
        this.running = true;
      }
      detach(): void { this.detaches++; this.running = false; }
    }
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const manager = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
    try {
      const strategy = new GatedInitialize();
      const setting = manager.setStrategy(strategy);
      await waitFor(() => strategy.gates.length === 1);
      // A switchBranch() initializes the same instance again while the
      // first initialization waits.
      const switching = manager.switchBranch(manager.currentBranch().name);
      await waitFor(() => strategy.gates.length === 2);
      strategy.gates[0]();
      assert.ok(await settlesWithin(setting), 'the first call settled');
      await assert.rejects(setting, { message: 'first initialize failed' });
      strategy.gates[1]();
      assert.ok(await settlesWithin(switching), 'the second call settled');
      await switching;
      assert.strictEqual(strategy.detaches, 0, 'the manager holds the instance again, so its failed earlier initialization detaches nothing');
      assert.strictEqual(strategy.running, true, 'and the newer initialization runs');
    } finally {
      manager.close();
      store.close();
    }
  });

  it('an open() whose strategy fails to initialize lets go of the strategy', async () => {
    // It starts work, as a timer would be armed, and then fails.
    class FailingInitialize extends PassthroughStrategy {
      running = false;
      detaches = 0;
      async initialize(): Promise<void> {
        this.running = true;
        throw new Error('initialize failed');
      }
      detach(): void { this.detaches++; this.running = false; }
    }
    const strategy = new FailingInitialize();
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    try {
      const opening = ContextManager.open({ store, strategy });
      assert.ok(await settlesWithin(opening), 'open() settled');
      await assert.rejects(opening, { message: 'initialize failed' });
      assert.strictEqual(strategy.running, false, 'the work it started before it failed is stopped');
      assert.strictEqual(strategy.detaches, 1, 'detached once');
    } finally {
      store.close();
    }
  });

  it("a compression whose clear after its summary spans the swap ends there, and logs no discard", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      // The clear that follows a written summary waits until the test lets it go.
      const internals = strategy as unknown as { clearQuarantineForCompressedChunk: (chunk: unknown) => Promise<void> };
      const clear = internals.clearQuarantineForCompressedChunk.bind(strategy);
      let clearing = false;
      let openClear!: () => void;
      const clearGate = new Promise<void>((resolve) => { openClear = resolve; });
      internals.clearQuarantineForCompressedChunk = async (chunk) => {
        clearing = true;
        await clearGate;
        return clear(chunk);
      };
      let ended = { outcome: 'pending' };
      const records = await compressionLogDuring(async () => {
        const ticking = manager.tick();
        ended = outcomeOf(ticking);
        await waitFor(() => calls.length === 1);
        calls[0].release();
        assert.ok(await reaches(() => clearing), 'the summary is written and its clear is waiting');
        await manager.setStrategy(new PassthroughStrategy());
        openClear();
        await settlesWithin(ticking);
      });

      assert.strictEqual(persisted(store, SUMMARIES).length, 1, 'the summary written before the swap stays');
      assert.strictEqual(ended.outcome, 'resolved', 'the tick ended quietly');
      const events = records.map((record) => String(record.event));
      assert.ok(events.includes('compression:attempt'), `the compression log is written: ${JSON.stringify(events)}`);
      assert.deepStrictEqual(discardPhases(records), [], `a discard was logged for a summary that was written: ${JSON.stringify(events)}`);
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it('a quiet stretch whose stub summary is written ends quietly when its clear spans the swap', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    // Every chunk is a quiet stretch, stored as a stub with no call.
    const strategy = newStrategy(false, { minChunkCharsForLLM: Number.MAX_SAFE_INTEGER });
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      // The clear that follows the written stub waits until the test lets it go.
      const internals = strategy as unknown as { clearQuarantineForCompressedChunk: (chunk: unknown) => Promise<void> };
      const clear = internals.clearQuarantineForCompressedChunk.bind(strategy);
      let clearing = false;
      let openClear!: () => void;
      const clearGate = new Promise<void>((resolve) => { openClear = resolve; });
      internals.clearQuarantineForCompressedChunk = async (chunk) => {
        clearing = true;
        await clearGate;
        return clear(chunk);
      };
      let ended = { outcome: 'pending' };
      const records = await compressionLogDuring(async () => {
        const ticking = manager.tick();
        ended = outcomeOf(ticking);
        assert.ok(await reaches(() => clearing), 'the stub is written and its clear is waiting');
        await manager.setStrategy(new PassthroughStrategy());
        openClear();
        await settlesWithin(ticking);
      });

      assert.strictEqual(ended.outcome, 'resolved', 'the tick ended quietly');
      assert.strictEqual(calls.length, 0, 'a stub makes no call');
      assert.strictEqual(persisted(store, SUMMARIES).length, 1, 'the stub written before the swap stays');
      assert.ok(records.some((record) => record.metadata?.stub === true), `the stub's log entry is written: ${JSON.stringify(records)}`);
      assert.deepStrictEqual(discardPhases(records), [], `a discard was logged for a stub that was written: ${JSON.stringify(records)}`);
    } finally {
      manager.close();
      store.close();
    }
  });

  for (const move of ['swap', 'fork'] as const) {
    it(`a quarantine sweep whose clear spans ${move === 'swap' ? 'the swap' : 'a fork that loads the same strategy on a new branch'} stops there, and logs no clear`, async () => {
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const { calls, membrane } = heldMembrane();
      const strategy = newStrategy();
      const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      try {
        seed(manager);
        await manager.compile();
        // Two quarantine records whose chunk no chunk record matches, so the
        // sweep clears both. Each clear waits until the test lets it go, as one
        // waiting on the state lock does, and then writes nothing, as one that
        // finds its strategy detached by then does.
        const internals = strategy as unknown as {
          readCompressionQuarantineProjection: () => Map<string, unknown>;
          clearCompressionRefusalQuarantine: (key?: string) => Promise<void>;
          quarantineAlarmActive: boolean;
        };
        const orphan = (key: string) => ({ record: { key, chunkSourceHash: key } });
        internals.readCompressionQuarantineProjection = () => new Map([['orphan-1', orphan('orphan-1')], ['orphan-2', orphan('orphan-2')]]);
        let openClear!: () => void;
        const clearing = new Promise<void>((resolve) => { openClear = resolve; });
        const cleared: string[] = [];
        internals.clearCompressionRefusalQuarantine = async (key) => { cleared.push(String(key)); await clearing; };
        internals.quarantineAlarmActive = true;
        let ended = { outcome: 'pending' };
        const logged = await logsDuring(async () => {
          const ticking = manager.tick();
          ended = outcomeOf(ticking);
          assert.ok(await reaches(() => cleared.length === 1), 'the sweep reached its first clear');
          if (move === 'swap') await manager.setStrategy(new PassthroughStrategy());
          else await manager.fork();
          openClear();
          await settlesWithin(ticking);
        });
        assert.deepStrictEqual(cleared, ['orphan-1'], 'the sweep made no further clear');
        assert.deepStrictEqual(logged.filter((line) => line.includes('[compression-quarantine]')), [], 'no clear and no failed sweep logged');
        assert.strictEqual(ended.outcome, 'resolved', 'the tick ended quietly');
        assert.strictEqual(calls.length, 0, 'the tick started no compression');
      } finally {
        for (const call of calls) call.release();
        manager.close();
        store.close();
      }
    });
  }

  for (const move of ['swap', 'fork'] as const) {
    it(`a compressed chunk's quarantine clear that spans ${move === 'swap' ? 'the swap' : 'a fork that loads the same strategy on a new branch'} stops there, and logs no clear`, async () => {
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const strategy = newStrategy();
      const manager = await ContextManager.open({ store, strategy });
      try {
        seed(manager, 2);
        await manager.compile();
        // Two quarantine records of the chunk that just compressed, each
        // cleared as one waiting on the state lock is: it waits until the
        // test lets it go, then writes nothing.
        const chunk = { messages: [{ id: 'chunk-a' }, { id: 'chunk-b' }] };
        const hash = createHash('sha256').update(JSON.stringify(['chunk-a', 'chunk-b']), 'utf8').digest('hex');
        const internals = strategy as unknown as {
          readCompressionQuarantineProjection: () => Map<string, unknown>;
          clearCompressionRefusalQuarantine: (key?: string) => Promise<void>;
          clearQuarantineForCompressedChunk: (chunk: unknown) => Promise<void>;
        };
        const debt = (key: string) => ({ record: { key, chunkSourceHash: hash } });
        internals.readCompressionQuarantineProjection = () => new Map([['debt-1', debt('debt-1')], ['debt-2', debt('debt-2')]]);
        let openClear!: () => void;
        const clearing = new Promise<void>((resolve) => { openClear = resolve; });
        const cleared: string[] = [];
        internals.clearCompressionRefusalQuarantine = async (key) => { cleared.push(String(key)); await clearing; };
        let ended = { outcome: 'pending' };
        const logged = await logsDuring(async () => {
          const clearingChunk = internals.clearQuarantineForCompressedChunk(chunk);
          ended = outcomeOf(clearingChunk);
          assert.ok(await reaches(() => cleared.length === 1), 'the first clear began');
          if (move === 'swap') await manager.setStrategy(new PassthroughStrategy());
          else await manager.fork();
          openClear();
          await settlesWithin(clearingChunk);
        });
        assert.deepStrictEqual(cleared, ['debt-1'], 'the clear made no further clear');
        assert.deepStrictEqual(logged.filter((line) => line.includes('[compression-quarantine]')), [], 'no clear and no failure logged');
        assert.strictEqual(ended.outcome, 'resolved', 'the clear ended quietly');
      } finally {
        manager.close();
        store.close();
      }
    });
  }

  // An instance started again while its last generation's tick has a call
  // out: the next tick starts no work beside the new generation's. A new
  // manager on the same app-owned store after close(), and setStrategy() on
  // the same manager, start the new generation on the same branch, so its
  // first compression joins the last generation's call for the same chunk:
  // these two pin the hand-back of that thrown-away work. A fork() starts it
  // on another branch, whose in-flight key differs, so its own compression is
  // under way, its tick holding the single-flight marker, when the last
  // generation's call settles: that one pins the L1 tick's clear of only its
  // own marker, which the next tick would otherwise find empty. The merge
  // test after this loop pins the merge tick's.
  for (const reuse of ['reopen', 'setStrategy', 'fork'] as const) {
    it(`an instance started again (${reuse}) while its last generation's compression call is out starts no work beside the new generation's when that call settles`, async () => {
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const { calls, membrane } = heldMembrane();
      const strategy = newStrategy();
      const work = watchWork(strategy);
      const first = await ContextManager.open({ store, strategy, membrane: membrane as never });
      let manager = first;
      try {
        seed(first, 24);
        await first.compile();
        const detachedTick = first.tick();
        await waitFor(() => calls.length === 1);
        if (reuse === 'reopen') {
          first.close();
          manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
        } else if (reuse === 'setStrategy') {
          await first.setStrategy(new PassthroughStrategy());
          await first.setStrategy(strategy);
        } else {
          await first.fork();
        }
        await manager.compile();
        const newTick = manager.tick();
        // The new generation's compression has started, and its tick holds
        // the marker, before the detached call returns.
        await waitFor(() => work.compressions === 2);
        calls[0].release();
        await detachedTick;
        await waitFor(() => calls.length === 2);
        assert.ok((strategy as unknown as { pendingCompressionWork: unknown }).pendingCompressionWork, "the new generation's record of its work stands");
        const next = manager.tick();
        await Promise.race([next, waitFor(() => calls.length === 3)]);
        assert.strictEqual(calls.length, 2, 'a tick started a compression beside the new generation\'s, still out');
        calls[1].release();
        await newTick;
        await next;
      } finally {
        for (const call of calls) call.release();
        manager.close();
        first.close();
        store.close();
      }
    });
  }

  it('an instance set again while its detached merge\'s call is out writes one merge of its sources', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    // Two L1s are a merge, and with two unmerged a tick merges before it
    // compresses another chunk.
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const first = await ContextManager.open({ store, strategy, membrane: membrane as never });
    let second: ContextManager | undefined;
    try {
      seed(first, 24);
      await first.compile();
      for (let n = 1; n <= 2; n++) {
        const tick = first.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release();
        await tick;
      }
      const detachedTick = first.tick();
      await waitFor(() => calls.length === 3);
      assert.strictEqual(work.merges, 1, 'the third call is the merge');
      first.close();
      second = await ContextManager.open({ store, strategy, membrane: membrane as never });
      const newTick = second.tick();
      await waitFor(() => calls.length === 4);
      assert.strictEqual(work.merges, 2, 'the fourth call is the new generation\'s merge of the same sources');
      calls[2].release();
      await detachedTick;
      assert.ok((strategy as unknown as { pendingCompressionWork: unknown }).pendingCompressionWork, "the new generation's record of its merge stands");
      const next = second.tick();
      await Promise.race([next, waitFor(() => calls.length === 5)]);
      assert.strictEqual(calls.length, 4, 'a tick started a call beside the new generation\'s merge, still out');
      calls[3].release();
      await newTick;
      await next;
      const merges = (persisted(store, SUMMARIES) as Array<{ level: number; sourceIds: string[] }>).filter((s) => s.level === 2);
      assert.deepStrictEqual(merges.map((s) => s.sourceIds), [['L1-0', 'L1-1']], 'one L2 over the two L1s');
    } finally {
      for (const call of calls) call.release();
      second?.close();
      first.close();
      store.close();
    }
  });

  // A summary has one parent: a merge whose sources were parented in this
  // instance's own summaries while its call was out writes nothing.
  it('a merge whose sources were parented in its own instance while its call was out writes no summary', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      for (let n = 1; n <= 2; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release();
        await tick;
      }
      const merges = mergeResults(strategy);
      const merging = manager.tick();
      await waitFor(() => calls.length === 3);
      const held = (strategy as unknown as { summaries: Array<{ id: string; mergedInto?: string }> }).summaries;
      held.find((s) => s.id === 'L1-0')!.mergedInto = 'L2-elsewhere';
      const logged = await logsDuring(async () => {
        calls[2].release();
        await merging;
      });
      const written = persisted(store, SUMMARIES) as Array<{ level: number }>;
      assert.strictEqual(written.filter((s) => s.level === 2).length, 0, 'the merge wrote no summary');
      assert.deepStrictEqual(merges, [false], 'the merge resolved as one that wrote nothing, so no landing is counted');
      assert.ok(logged.some((line) => line.includes("parented while the L2 merge's call was out (L1-0)")), `the skip is said: ${JSON.stringify(logged)}`);
      assert.deepStrictEqual((strategy as unknown as { mergeQueue: unknown[] }).mergeQueue, [], 'the merge left the queue');
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  // Another instance sharing the store merges the same run: this one writes
  // nothing and takes that merge up, whether it finds it after its own call
  // or before making one, so it doesn't choose the run again.
  for (const found of ['after its call', 'before its call'] as const) {
    it(`a merge that finds another instance's merge of its sources ${found} writes nothing and takes that merge up`, async () => {
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const { calls, membrane } = heldMembrane();
      // Two L1s are a merge, and with two unmerged an instance is at its
      // speculative cap, so a tick merges before it compresses another chunk.
      const config = { mergeThreshold: 2, maxSpeculativeL1s: 1 };
      const strategy = newStrategy(false, config);
      const work = watchWork(strategy);
      const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      let other: ContextManager | undefined;
      try {
        seed(manager, 24);
        await manager.compile();
        for (let n = 1; n <= 2; n++) {
          const tick = manager.tick();
          await waitFor(() => calls.length === n);
          calls[n - 1].release();
          await tick;
        }
        // Another manager and instance on the store merge the same two L1s.
        const otherMerges = async () => {
          other = await ContextManager.open({ store, strategy: newStrategy(false, config), membrane: membrane as never });
          await other.compile();
          const before = calls.length;
          const otherTick = other.tick();
          await waitFor(() => calls.length === before + 1);
          calls[before].release();
          await otherTick;
        };
        let logged: string[];
        if (found === 'after its call') {
          const merging = manager.tick();
          await waitFor(() => calls.length === 3);
          await otherMerges();
          logged = await logsDuring(async () => {
            calls[2].release();
            await merging;
          });
          assert.ok(logged.some((line) => line.includes("parented while the L2 merge's call was out (L1-0, L1-1)")), `the skip is said: ${JSON.stringify(logged)}`);
        } else {
          await otherMerges();
          logged = await logsDuring(async () => {
            await Promise.race([manager.tick(), waitFor(() => calls.length === 4)]);
          });
          assert.strictEqual(calls.length, 3, 'this instance made no call for the merge');
          assert.ok(logged.some((line) => line.includes('already parented (L1-0, L1-1)')), `the skip is said: ${JSON.stringify(logged)}`);
        }
        const merges = (persisted(store, SUMMARIES) as Array<{ id: string; level: number }>).filter((s) => s.level === 2);
        assert.strictEqual(merges.length, 1, "only the other instance's merge was written");
        const held = (strategy as unknown as { summaries: Array<{ id: string; mergedInto?: string }> }).summaries;
        assert.ok(held.some((s) => s.id === merges[0]!.id), "this instance holds the other instance's merge");
        assert.deepStrictEqual(
          held.filter((s) => s.id === 'L1-0' || s.id === 'L1-1').map((s) => s.mergedInto),
          [merges[0]!.id, merges[0]!.id],
          'and holds its sources as merged into it',
        );
        // Off its speculative cap, it compresses the next chunk rather than
        // choosing the run again.
        const { compressions, merges: merged } = work;
        const next = manager.tick();
        await waitFor(() => work.compressions > compressions);
        assert.strictEqual(work.merges, merged, 'it chose no merge');
        calls.at(-1)!.release();
        await next;
      } finally {
        for (const call of calls) call.release();
        other?.close();
        manager.close();
        store.close();
      }
    });
  }

  it("a merge that takes up another instance's queue queues again a merge that queue lacks", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    // Past three unmerged L1s this instance merges, so it compresses four
    // chunks first, queueing a merge for each two.
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 3 });
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    const queued = () => (strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }> }).mergeQueue.map((m) => m.sourceIds.join('+'));
    let other: ContextManager | undefined;
    try {
      seed(manager, 24);
      await manager.compile();
      const compress = async () => {
        const before = calls.length;
        const tick = manager.tick();
        await waitFor(() => calls.length === before + 1);
        calls[before].release();
        await tick;
      };
      await compress();
      await compress();
      // Another instance loads the store while it queues L1-0+L1-1 alone. At
      // its own cap, it merges before it compresses.
      other = await ContextManager.open({ store, strategy: newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 }), membrane: membrane as never });
      await other.compile();
      await compress();
      await compress();
      assert.deepStrictEqual(queued(), ['L1-0+L1-1', 'L1-2+L1-3'], 'this instance queued both merges');
      const merging = manager.tick();
      await waitFor(() => calls.length === 5);
      // The other instance merges L1-0 and L1-1 first, and writes its queue,
      // which never held L1-2+L1-3.
      const otherTick = other.tick();
      await waitFor(() => calls.length === 6);
      calls[5].release();
      await otherTick;
      calls[4].release();
      await merging;
      const merges = (persisted(store, SUMMARIES) as Array<{ level: number }>).filter((s) => s.level === 2);
      assert.strictEqual(merges.length, 1, "this instance took up the other's merge rather than writing its own");
      assert.deepStrictEqual(queued(), ['L1-2+L1-3'], "the merge the other instance's queue lacked is queued again");
      assert.deepStrictEqual(
        (persisted(store, MERGE_QUEUE) as Array<{ sourceIds: string[] }>).map((m) => m.sourceIds.join('+')),
        ['L1-2+L1-3'],
        "and the store's queue holds it",
      );
    } finally {
      for (const call of calls) call.release();
      other?.close();
      manager.close();
      store.close();
    }
  });

  it("a close() from a listener during resetHeadWindow()'s transition add refuses the reset by name, and the transition message stands", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy });
    const resets: string[] = [];
    const resettable = strategy as unknown as { resetHeadWindow: (id: string) => void };
    const reset = resettable.resetHeadWindow.bind(strategy);
    resettable.resetHeadWindow = (id) => {
      resets.push(id);
      reset(id);
    };
    try {
      seed(manager, 2);
      let transition: string | undefined;
      manager.onMessage((event) => {
        if (event.type === 'add' && event.message.participant === 'Context Manager') {
          transition = event.message.id;
          manager.close();
        }
      });
      await assert.rejects(manager.resetHeadWindow('moving on'), (error: Error) => {
        assert.match(error.message, /^ContextManager\.resetHeadWindow after close\(\)/);
        assert.ok(
          transition && error.message.endsWith(`. Its transition add finished: message ${transition} is stored, and the head window wasn't reset. A later resetHeadWindow() that goes ahead adds another transition message.`),
          `the refusal names the stored message: ${error.message}`,
        );
        return true;
      });
      assert.deepStrictEqual(resets, [], "the strategy's head window wasn't reset");
      assert.ok(transition && manager.getMessage(transition), 'the transition message was stored');
    } finally {
      manager.close();
      store.close();
    }
  });

  // A listener of the transition add that sets a strategy, or moves the
  // store's branch, refuses the reset: it would reach a strategy or branch
  // the call didn't start on.
  for (const move of ['setStrategy', 'branch'] as const) {
    it(`a ${move === 'setStrategy' ? 'strategy set' : "store's branch moved"} by a listener during resetHeadWindow()'s transition add refuses the reset, and no strategy is reset`, async () => {
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const strategy = newStrategy();
      const replacement = newStrategy();
      const manager = await ContextManager.open({ store, strategy });
      const resets: string[] = [];
      for (const s of [strategy, replacement]) {
        const resettable = s as unknown as { resetHeadWindow: (id: string) => void };
        const reset = resettable.resetHeadWindow.bind(s);
        resettable.resetHeadWindow = (id) => {
          resets.push(id);
          reset(id);
        };
      }
      let setting: Promise<void> | undefined;
      let transition: string | undefined;
      try {
        seed(manager, 2);
        manager.onMessage((event) => {
          if (event.type !== 'add' || event.message.participant !== 'Context Manager') return;
          transition = event.message.id;
          if (move === 'setStrategy') setting = manager.setStrategy(replacement);
          else {
            store.createBranch('elsewhere');
            store.switchBranch('elsewhere');
          }
        });
        await assert.rejects(manager.resetHeadWindow('moving on'), (error: Error) => {
          assert.match(
            error.message,
            move === 'setStrategy'
              ? /^ContextManager\.resetHeadWindow requires successful strategy initialization/
              : /^Branch or strategy changed during ContextManager\.resetHeadWindow/,
          );
          assert.ok(
            transition && error.message.endsWith(`. Its transition add finished: message ${transition} is stored, and the head window wasn't reset. A later resetHeadWindow() that goes ahead adds another transition message.`),
            `the refusal names the stored message: ${error.message}`,
          );
          // A later call that goes ahead stores a second transition, so the
          // refusal keeps its reason and none of the advice the same refusal
          // before the add gives.
          assert.doesNotMatch(error.message, /retry on the intended branch|recover with/, 'the refusal advises no retry');
          return true;
        });
        assert.deepStrictEqual(resets, [], 'no head window was reset');
        await setting;
      } finally {
        manager.close();
        store.close();
      }
    });
  }

  for (const change of ['edit', 'remove', 'removeRange'] as const) {
    const named = change === 'edit' ? 'an edit' : change === 'remove' ? 'a removal' : 'a range removal';
    it(`a close() from a listener of ${named} leaves the owned store open to the listeners after it, and closes it when the call returns`, async () => {
      const path = `${TEST_STORE_PATH}-owned`;
      rmSync(path, { recursive: true, force: true });
      const manager = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      try {
        const [first, second] = ['one', 'two', 'three'].map((text) => manager.addMessage('User', [{ type: 'text', text }]));
        let openToLater: boolean | undefined;
        manager.onMessage((event) => {
          if (event.type !== 'add') manager.close();
        });
        manager.onMessage((event) => {
          if (event.type !== 'add') openToLater = !manager.getStore().isClosed();
        });
        if (change === 'edit') manager.editMessage(first!, [{ type: 'text', text: 'edited' }]);
        else if (change === 'remove') manager.removeMessage(first!);
        else manager.removeMessages(first!, second!);
        assert.strictEqual(openToLater, true, 'the listener after the one that closed found the store open');
        assert.ok(manager.getStore().isClosed(), 'and the store closed when the call returned');
      } finally {
        if (!manager.getStore().isClosed()) manager.getStore().close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  it("a close() from a listener during a sharded add lets the add finish: every shard is stored, the strategy hears none after it, and the owned store closes when the add returns", async () => {
    const path = `${TEST_STORE_PATH}-owned`;
    rmSync(path, { recursive: true, force: true });
    class ShardingStrategy extends PassthroughStrategy {
      heard: string[] = [];
      chunkIngressMessage() {
        return { bodyGroupId: 'group', shards: [0, 1, 2].map((i) => ({ content: [{ type: 'text' as const, text: `shard ${i}` }], shardIndex: i })) };
      }
      async onNewMessage(message: { content: Array<{ type: string; text?: string }> }): Promise<void> {
        this.heard.push(message.content.map((b) => b.text ?? '').join(''));
      }
    }
    const strategy = new ShardingStrategy();
    const manager = await ContextManager.open({ path, strategy });
    try {
      const added: string[] = [];
      let storeOpenAtClose: boolean | undefined;
      manager.onMessage((event) => {
        if (event.type !== 'add') return;
        added.push(event.message.id);
        if (added.length === 1) {
          manager.close();
          storeOpenAtClose = !manager.getStore().isClosed();
        }
      });
      manager.addMessage('User', [{ type: 'text', text: 'one body' }]);
      assert.strictEqual(added.length, 3, 'each shard was stored, and the listener heard it');
      assert.deepStrictEqual(strategy.heard, ['shard 0'], 'the strategy heard only the shard stored before the close()');
      assert.strictEqual(storeOpenAtClose, true, 'the owned store stayed open while the add ran');
      assert.ok(manager.getStore().isClosed(), 'and closed when the add returned');
      const reopened = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      try {
        assert.deepStrictEqual(
          reopened.getAllMessages().map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')),
          ['shard 0', 'shard 1', 'shard 2'],
          'every shard is stored',
        );
      } finally {
        reopened.close();
      }
    } finally {
      manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("a close() from a listener whose owned store then fails to close is logged, and the add it followed returns", async () => {
    const path = `${TEST_STORE_PATH}-owned`;
    rmSync(path, { recursive: true, force: true });
    class ShardingStrategy extends PassthroughStrategy {
      chunkIngressMessage() {
        return { bodyGroupId: 'group', shards: [0, 1].map((i) => ({ content: [{ type: 'text' as const, text: `shard ${i}` }], shardIndex: i })) };
      }
    }
    const manager = await ContextManager.open({ path, strategy: new ShardingStrategy(), namespace: 'agents/zz-close' });
    try {
      const store = manager.getStore();
      const closeStore = store.close.bind(store);
      store.close = () => { closeStore(); throw new Error('the final sync failed'); };
      manager.onMessage((event) => { if (event.type === 'add') manager.close(); });
      const logged = await logsDuring(async () => {
        manager.addMessage('User', [{ type: 'text', text: 'one body' }]);
      });
      assert.ok(store.isClosed(), 'the store is closed');
      assert.ok(
        logged.some((line) => line.includes('closing the store after a close() from a listener failed; the store is closed all the same: ns=agents/zz-close ') && line.includes('the final sync failed')),
        `the failure is logged: ${JSON.stringify(logged)}`,
      );
    } finally {
      manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('after close(), an add refuses by name before reading its content, pinAtLevel() names itself, and getStoreId() reads an id but mints none', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy });
    manager.close();
    try {
      assert.throws(() => manager.addMessage('User', [{ type: 'text' } as never]), /ContextManager\.addMessage after close\(\)/);
      assert.throws(
        () => manager.addMessage('User', [{ type: 'text', text: 'held' }], undefined, undefined, { holdCompression: { timeoutMs: -1 } }),
        /ContextManager\.addMessage after close\(\)/,
      );
      assert.throws(() => manager.pinAtLevel('a', 'b', 1), /ContextManager\.pinAtLevel after close\(\)/);
      const records = store.getRecordIdsByType('context-manager/store-identity').length;
      assert.throws(() => manager.getStoreId(), /ContextManager\.getStoreId after close\(\)/, 'a store with no id gets none minted');
      assert.strictEqual(store.getRecordIdsByType('context-manager/store-identity').length, records, 'no identity record was written');
      const open = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      const id = open.getStoreId();
      open.close();
      assert.strictEqual(manager.getStoreId(), id, 'a store with an id answers it after close()');
      // Opened anew, the store's id isn't held in memory, so a closed manager
      // reads it from the store's identity record.
      store.close();
      const reopened = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      try {
        const closedOnIt = await ContextManager.open({ store: reopened, strategy: new PassthroughStrategy() });
        closedOnIt.close();
        assert.strictEqual(closedOnIt.getStoreId(), id, "a closed manager reads the store's id from its record");
      } finally {
        reopened.close();
      }
      // A store the manager owned is closed with it: the id is answered only
      // if it was read before, and otherwise refused by name, the closed
      // store unread.
      for (const readBefore of [false, true]) {
        const owning = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new PassthroughStrategy() });
        const known = readBefore ? owning.getStoreId() : undefined;
        owning.close();
        if (readBefore) assert.strictEqual(owning.getStoreId(), known, 'an owned store answers the id read before close()');
        else assert.throws(() => owning.getStoreId(), /ContextManager\.getStoreId after close\(\)/, 'an owned store closed with no id read refuses by name');
      }
    } finally {
      store.close();
    }
  });
});

describe('a strategy let go of ends the provider calls its work has out (#241)', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it("close() cancels a compression's call that is out, and the compression ends quietly, writing nothing", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      const ended = outcomeOf(ticking);
      await waitFor(() => calls.length === 1);
      const statesBefore = strategyStates(store);
      const errors = await errorsDuring(async () => {
        manager.close();
        await settlesWithin(ticking);
      });
      assert.strictEqual(calls[0].signal?.aborted, true, "the compression's call was cancelled");
      assert.strictEqual(ended.outcome, 'resolved', 'the tick ended quietly');
      assert.deepStrictEqual(errors, [], 'nothing was logged as an error');
      assertNothingWritten(store, statesBefore, 'after the close');
    } finally {
      manager.close();
      store.close();
    }
  });

  it("setting the same instance again cancels its compression's call that is out, and the new generation compresses the chunk", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const detachedTick = manager.tick();
      const detached = outcomeOf(detachedTick);
      await waitFor(() => calls.length === 1);
      await manager.setStrategy(strategy);
      assert.strictEqual(calls[0].signal?.aborted, true, "the earlier generation's call was cancelled");
      await settlesWithin(detachedTick);
      assert.strictEqual(detached.outcome, 'resolved', "the earlier generation's tick ended quietly");
      const tick = manager.tick();
      await waitFor(() => calls.length === 2);
      assert.strictEqual(calls[1].signal?.aborted, false, "the new generation's call is out");
      calls[1].release();
      await tick;
      assert.strictEqual(persisted(store, SUMMARIES).length, 1, 'the new generation wrote its summary');
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it("close() cancels a merge's call that is out, and the merge ends quietly, still queued", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    // Two L1s are a merge, and with two unmerged a tick merges before it
    // compresses another chunk.
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      for (let n = 1; n <= 2; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release();
        await tick;
      }
      const merging = manager.tick();
      const merged = outcomeOf(merging);
      await waitFor(() => calls.length === 3);
      assert.strictEqual(work.merges, 1, 'the third call is the merge');
      const queued = persisted(store, MERGE_QUEUE);
      const errors = await errorsDuring(async () => {
        manager.close();
        await settlesWithin(merging);
      });
      assert.strictEqual(calls[2].signal?.aborted, true, "the merge's call was cancelled");
      assert.strictEqual(merged.outcome, 'resolved', 'the tick ended quietly');
      assert.deepStrictEqual(errors, [], 'nothing was logged as an error');
      assert.deepStrictEqual(persisted(store, MERGE_QUEUE), queued, 'the merge is still queued');
      assert.deepStrictEqual((persisted(store, SUMMARIES) as Array<{ level: number }>).filter((s) => s.level === 2), [], 'no L2 written');
    } finally {
      manager.close();
      store.close();
    }
  });

  it("a merge whose call fails after its strategy was let go of logs no failure", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      for (let n = 1; n <= 2; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release();
        await tick;
      }
      const merging = manager.tick();
      const merged = outcomeOf(merging);
      await waitFor(() => calls.length === 3);
      assert.strictEqual(work.merges, 1, 'the third call is the merge');
      const errors = await errorsDuring(async () => {
        manager.close();
        calls[2].fail(serverError());
        await settlesWithin(merging);
      });
      assert.strictEqual(merged.outcome, 'resolved', 'the tick ended quietly');
      assert.deepStrictEqual(errors, [], 'nothing was logged as an error');
    } finally {
      manager.close();
      store.close();
    }
  });

  it("a compression's stripped retry that is out at the swap is cancelled, and discarded at that call", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      // The first summary keeps its reasoning, so the next request's recall
      // pair carries it, and a carrier rejection takes the text-only retry.
      const first = manager.tick();
      await waitFor(() => calls.length === 1);
      calls[0].release([
        { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
        { type: 'text', text: 'Summary #1' },
      ]);
      await first;
      const second = manager.tick();
      await waitFor(() => calls.length === 2);
      let ended = false;
      const records = await compressionLogDuring(async () => {
        calls[1].fail(carrierRejection());
        await waitFor(() => calls.length === 3);
        await manager.setStrategy(new PassthroughStrategy());
        ended = await settlesWithin(second);
      });
      assert.strictEqual(calls[2].signal?.aborted, true, 'the stripped retry was cancelled');
      assert.ok(ended, 'the tick ended');
      assert.deepStrictEqual(discardPhases(records), ['canonical:error'], 'the discard is logged at the retry');
    } finally {
      for (const call of calls.slice(3)) call.release();
      manager.close();
      store.close();
    }
  });

  it("a merge's stripped retry that is out when its strategy is let go of is cancelled, and logs no failure", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      // As in the carrier test above: the second merge's request carries
      // earlier summaries' reasoning, so a carrier rejection takes the
      // text-only retry.
      for (let n = 1; n <= 5; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release([
          { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
          { type: 'text', text: `Summary #${n}` },
        ]);
        await tick;
      }
      const merging = manager.tick();
      const merged = outcomeOf(merging);
      await waitFor(() => calls.length === 6);
      assert.deepStrictEqual(work, { compressions: 4, compressionsSettled: 4, merges: 2 }, 'the sixth call is the second merge');
      calls[5].fail(carrierRejection());
      await waitFor(() => calls.length === 7);
      const errors = await errorsDuring(async () => {
        manager.close();
        await settlesWithin(merging);
      });
      assert.strictEqual(calls[6].signal?.aborted, true, 'the stripped retry was cancelled');
      assert.strictEqual(merged.outcome, 'resolved', 'the tick ended quietly');
      assert.deepStrictEqual(errors, [], 'nothing was logged as an error');
    } finally {
      for (const call of calls.slice(7)) call.release();
      manager.close();
      store.close();
    }
  });

  it("close() during a call's wait before membrane retries it ends the call there", async () => {
    // A real membrane over an adapter that fails retryably, so membrane
    // waits a minute before its retry.
    let attempts = 0;
    class FailingAdapter extends MockAdapter {
      override async complete(): Promise<never> {
        attempts++;
        throw new MembraneError({ type: 'server', message: 'zz server error', retryable: true, httpStatus: 500, rawError: undefined });
      }
    }
    const WAIT_MS = 60_000;
    const membrane = new Membrane(new FailingAdapter(), { retry: { maxRetries: 3, retryDelayMs: WAIT_MS, backoffMultiplier: 1, maxRetryDelayMs: WAIT_MS } });
    // Membrane's wait is a timer of that length: count it as it is armed.
    const realSetTimeout = globalThis.setTimeout;
    let waits = 0;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === WAIT_MS) waits++;
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      const ended = outcomeOf(ticking);
      await waitFor(() => waits === 1);
      assert.strictEqual(attempts, 1, 'membrane waits after the first attempt');
      manager.close();
      assert.ok(await settlesWithin(ticking, 5_000), 'the tick ended without waiting for the retry');
      assert.strictEqual(ended.outcome, 'resolved', 'the tick ended quietly');
      assert.strictEqual(attempts, 1, 'no further attempt');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      manager.close();
      store.close();
    }
  });

  it('calls that settled before their strategy was let go of, answered or failed, keep their signals unaborted', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const tick = manager.tick();
      await waitFor(() => calls.length === 1);
      calls[0].release();
      await tick;
      await errorsDuring(async () => {
        const failing = manager.tick();
        await waitFor(() => calls.length === 2);
        calls[1].fail(serverError());
        await failing.catch(() => {});
      });
      manager.close();
      assert.deepStrictEqual(calls.map((call) => call.signal?.aborted), [false, false], "the settled calls' signals were left alone");
    } finally {
      manager.close();
      store.close();
    }
  });

  it("close() during a transition summary's call cancels it, and resetHeadWindow() refuses with the generation's end, the cancellation its cause", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const resetting = manager.resetHeadWindow();
      await waitFor(() => calls.length === 1);
      manager.close();
      assert.strictEqual(calls[0].signal?.aborted, true, "the transition summary's call was cancelled");
      assert.ok(await settlesWithin(resetting), 'resetHeadWindow() ended');
      await assert.rejects(resetting, (error: Error) => {
        assert.match(error.message, /^Transition summary crossed a branch generation/);
        assert.strictEqual((error.cause as { type?: unknown } | undefined)?.type, 'abort', 'the cancellation is its cause');
        return true;
      });
    } finally {
      manager.close();
      store.close();
    }
  });

  it("a merge whose call the host withdraws after its strategy was let go of rethrows the withdrawal", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      for (let n = 1; n <= 2; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release();
        await tick;
      }
      const merging = manager.tick();
      await waitFor(() => calls.length === 3);
      assert.strictEqual(work.merges, 1, 'the third call is the merge');
      const withdrawn = new CompressionWithdrawn();
      manager.close();
      calls[2].fail(withdrawn);
      await assert.rejects(merging, (error) => error === withdrawn, 'the withdrawal is rethrown unchanged');
    } finally {
      manager.close();
      store.close();
    }
  });

  it("resetHeadWindow() whose transition summary's call the host withdraws after close() rethrows the withdrawal", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const resetting = manager.resetHeadWindow();
      await waitFor(() => calls.length === 1);
      const withdrawn = new CompressionWithdrawn();
      manager.close();
      calls[0].fail(withdrawn);
      await assert.rejects(resetting, (error) => error === withdrawn, 'the withdrawal is rethrown unchanged');
    } finally {
      manager.close();
      store.close();
    }
  });
  it('close() cancels every call its strategy has out, each by a signal of its own', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = signalledMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      const resetting = manager.resetHeadWindow();
      await waitFor(() => calls.length === 2);
      assert.notStrictEqual(calls[0].signal, calls[1].signal, 'each call has a signal of its own');
      manager.close();
      assert.deepStrictEqual(calls.map((call) => call.signal?.aborted), [true, true], 'both calls were cancelled');
      assert.ok(await settlesWithin(ticking), "the compression's tick ended");
      assert.ok(await settlesWithin(resetting), 'resetHeadWindow() ended');
      await resetting.catch(() => {});
    } finally {
      manager.close();
      store.close();
    }
  });

  it("a transition summary whose call fails after close() refuses with the generation's end, the failure its cause", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const resetting = manager.resetHeadWindow();
      await waitFor(() => calls.length === 1);
      manager.close();
      const failure = serverError();
      calls[0].fail(failure);
      await assert.rejects(resetting, (error: Error) => {
        assert.match(error.message, /^Transition summary crossed a branch generation/);
        assert.strictEqual(error.cause, failure, 'the failure is its cause');
        return true;
      });
    } finally {
      manager.close();
      store.close();
    }
  });

  it('a transition summary whose call fails while its strategy is current rethrows the failure', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const resetting = manager.resetHeadWindow();
      await waitFor(() => calls.length === 1);
      const failure = serverError();
      calls[0].fail(failure);
      await assert.rejects(resetting, (error) => error === failure, 'the failure is rethrown as itself');
    } finally {
      manager.close();
      store.close();
    }
  });

  it("a transition summary whose call the host cancels while its strategy is current rethrows the cancellation as itself", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const resetting = manager.resetHeadWindow();
      await waitFor(() => calls.length === 1);
      // As membrane rejects a call whose signal a host combined with the
      // strategy's and aborted.
      const cancelled = abortError();
      calls[0].fail(cancelled);
      await assert.rejects(resetting, (error) => error === cancelled, 'the cancellation is rethrown as itself');
    } finally {
      manager.close();
      store.close();
    }
  });

  it('a merge whose strategy is let go of while its request is prepared makes no call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    // Two L1s are a merge, and with two unmerged a tick merges before it
    // compresses another chunk.
    const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 1 });
    const work = watchWork(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager, 24);
      await manager.compile();
      for (let n = 1; n <= 2; n++) {
        const tick = manager.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1].release();
        await tick;
      }
      // The swap lands as the merge's request is prepared, after the merge's
      // check at its start.
      const internals = strategy as unknown as { prepareCompressionCandidate: (request: unknown, label: string) => unknown };
      const prepare = internals.prepareCompressionCandidate.bind(strategy);
      let swapping: Promise<void> | undefined;
      internals.prepareCompressionCandidate = (request, label) => {
        if (label.startsWith('merge-') && !swapping) swapping = manager.setStrategy(new PassthroughStrategy());
        return prepare(request, label);
      };
      const merging = manager.tick();
      const merged = outcomeOf(merging);
      await settlesWithin(merging);
      if (swapping) await settlesWithin(swapping);
      assert.ok(swapping, "the merge's request was prepared");
      assert.strictEqual(work.merges, 1, 'the tick started the merge');
      assert.strictEqual(calls.length, 2, `the replaced strategy's merge made ${calls.length - 2} call(s)`);
      assert.strictEqual(merged.outcome, 'resolved', 'the tick ended quietly');
    } finally {
      for (const call of calls.slice(2)) call.release();
      manager.close();
      store.close();
    }
  });

  it('a transition summary whose strategy is let go of while its request is prepared makes no call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const internals = strategy as unknown as { prepareCompressionRequest: (request: unknown) => unknown };
      const prepare = internals.prepareCompressionRequest.bind(strategy);
      internals.prepareCompressionRequest = (request) => {
        manager.close();
        return prepare(request);
      };
      const resetting = manager.resetHeadWindow();
      assert.strictEqual(calls.length, 0, `the transition summary made ${calls.length} call(s)`);
      assert.ok(await settlesWithin(resetting), 'resetHeadWindow() ended');
      await assert.rejects(resetting, /Transition summary crossed a branch generation/);
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  // takeUpStoreState() replaces the instance's merge queue with the store's,
  // which another instance may have written without a merge this one queued;
  // its threshold pass queues that merge again, whichever take-up it is.
  describe("a take-up of another instance's L1 queues again a merge the store's queue lacks", () => {
    const setUp = async () => {
      const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
      const { calls, membrane } = heldMembrane();
      // Below its cap an instance compresses rather than merges, queueing a
      // merge for each two L1s.
      const strategy = newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 5 });
      const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      const queued = () => (strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }> }).mergeQueue.map((m) => m.sourceIds.join('+'));
      seed(manager, 24);
      await manager.compile();
      const compress = async (m: ContextManager) => {
        const before = calls.length;
        const tick = m.tick();
        await waitFor(() => calls.length === before + 1);
        calls[before].release();
        await tick;
      };
      for (let n = 0; n < 4; n++) await compress(manager);
      assert.deepStrictEqual(queued(), ['L1-0+L1-1', 'L1-2+L1-3'], 'this instance queued both merges');
      const other = await ContextManager.open({ store, strategy: newStrategy(false, { mergeThreshold: 2, maxSpeculativeL1s: 5 }), membrane: membrane as never });
      await other.compile();
      // The store's queue as an instance that never held L1-2+L1-3 writes it.
      const dropMerge = () => store.setStateJson(
        MERGE_QUEUE,
        (persisted(store, MERGE_QUEUE) as Array<{ sourceIds: string[] }>).filter((m) => m.sourceIds.join('+') !== 'L1-2+L1-3'),
      );
      return { store, calls, strategy, manager, other, queued, compress, dropMerge };
    };

    it("when the instance finds the other's L1 of its chunk", async () => {
      const { store, calls, manager, other, queued, compress, dropMerge } = await setUp();
      try {
        await compress(other);
        dropMerge();
        const before = calls.length;
        await manager.tick();
        assert.strictEqual(calls.length, before, "this instance took up the other's L1 rather than compressing the chunk");
        assert.deepStrictEqual(queued(), ['L1-0+L1-1', 'L1-2+L1-3'], "the merge the store's queue lacked is queued again");
      } finally {
        for (const call of calls) call.release();
        other.close();
        manager.close();
        store.close();
      }
    });

    it("when the instance waited on the other's compression of its chunk", async () => {
      const { store, calls, strategy, manager, other, queued, dropMerge } = await setUp();
      try {
        const work = watchWork(strategy);
        const otherTick = other.tick();
        await waitFor(() => calls.length === 5);
        const tick = manager.tick();
        assert.ok(await reaches(() => work.compressions === 1), 'this instance started compressing the chunk');
        assert.strictEqual(calls.length, 5, "it waits on the other instance's call for the same chunk");
        dropMerge();
        calls[4].release();
        await otherTick;
        await tick;
        assert.strictEqual(calls.length, 5, 'it made no call of its own');
        assert.deepStrictEqual(queued(), ['L1-0+L1-1', 'L1-2+L1-3'], "the merge the store's queue lacked is queued again");
      } finally {
        for (const call of calls) call.release();
        other.close();
        manager.close();
        store.close();
      }
    });
  });
});
