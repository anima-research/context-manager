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
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy } from '../src/index.js';

const TEST_STORE_PATH = './test-strategy-detach';
const SUMMARIES = 'default/autobio:summaries';
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

/** Whether `promise` settles within `ms`. The bound only keeps a regression
 *  from hanging the suite, so it is generous. */
async function settlesWithin(promise: Promise<unknown>, ms = 5000): Promise<boolean> {
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

/** A provider's refusal of the reasoning carriers in a request. */
const carrierRejection = () => Object.assign(
  new Error('invalid_request_error: thinking blocks in this request cannot be accepted'),
  { httpStatus: 400 },
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
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new ThrowingDetach() });
      const replacement = new ThrowingDetach();
      await manager.setStrategy(replacement);
      assert.strictEqual(manager.getStrategy(), replacement);
      assert.strictEqual(replacement.initialized, 1, 'the replacement initialized');
      manager.addMessage('User', [{ type: 'text', text: 'still works' }]);
      manager.close();
      assert.strictEqual(manager.getStore().isClosed(), true, 'close() closed the store it owns');
      assert.strictEqual(errors.filter((args) => args[0] === 'Strategy detach failed:').length, 2, 'each failed detach is logged');
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
      assert.deepStrictEqual(discardPhases(records), ['canonical:before_call'], 'the discard is logged as before the retry');
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

  it("a replacement that joins the replaced strategy's compression in flight compresses the chunk itself", async () => {
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
      const replacementTick = manager.tick();
      assert.ok(await reaches(() => work.compressions === 1), 'the replacement started compressing');
      assert.deepStrictEqual(
        [work.compressionsSettled, calls.length],
        [0, 1],
        "the replacement waits on the replaced strategy's call for the same chunk",
      );

      calls[0].release();
      await replacedTick.catch(() => {});
      assert.ok(await reaches(() => calls.length === 2), 'the replacement called the provider itself once the replaced strategy threw its result away');
      calls[1].release();
      await settlesWithin(replacementTick);

      assert.strictEqual(persisted(store, SUMMARIES).length, 1, `the replacement wrote the chunk's summary (${calls.length} provider calls)`);
    } finally {
      for (const call of calls.slice(1)) call.release();
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
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new AsyncDetach() });
        await manager.setStrategy(new PassthroughStrategy());
        await settle(20);
        manager.close();
      });
      assert.deepStrictEqual(unhandled.seen, [], 'no unhandled rejection');
      assert.ok(
        errors.some((args) => args[0] === 'Strategy detach failed:' && args[1] === 'passthrough' && String(args[2]).includes('async detach failed')),
        'the rejection is logged with the strategy\'s name',
      );
    } finally {
      unhandled.restore();
    }
  });

  it("two strategies waiting on a replaced strategy's compression take it over once between them", async () => {
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
      await replacedTick.catch(() => {});
      assert.ok(await reaches(() => calls.length >= 2), 'one of them took the work over');
      calls[1].release();
      await settlesWithin(Promise.all([otherTick, replacementTick]));

      assert.strictEqual(calls.length, 2, 'the other waited on that call instead of making its own');
      assert.deepStrictEqual([otherEnd.outcome, replacementEnd.outcome], ['resolved', 'resolved'], 'both ticks resolved');
      assert.strictEqual(persisted(store, SUMMARIES).length, 1, "one summary for the chunk");
    } finally {
      for (const call of calls.slice(1)) call.release();
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

      assert.strictEqual(waiterWork.compressions, 2, 'the waiter took the chunk over with a fresh compression');
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
      const merging = manager.tick();
      await waitFor(() => calls.length === 6);
      assert.deepStrictEqual(work, { compressions: 4, compressionsSettled: 4, merges: 2 }, 'the sixth call is the second merge');
      assert.ok(JSON.stringify(calls[5].request).includes('"thinking"'), "the merge's request carries earlier summaries' reasoning");

      const merged = outcomeOf(merging);
      await manager.setStrategy(new PassthroughStrategy());
      calls[5].fail(carrierRejection());
      await settlesWithin(merging);

      assert.strictEqual(calls.length, 6, `the replaced strategy retried the merge ${calls.length - 6} time(s)`);
      // A merge that found the call's failure no carrier rejection would
      // rethrow it and fail the tick: resolving is the check before the retry.
      assert.strictEqual(merged.outcome, 'resolved', 'the tick ended at the check before the retry');
    } finally {
      for (const call of calls.slice(6)) call.release();
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
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new ThenableDetach() });
        await manager.setStrategy(new PassthroughStrategy());
        await settle(20);
        manager.close();
      });
      assert.deepStrictEqual(unhandled.seen, [], 'no unhandled rejection');
      assert.ok(
        errors.some((args) => args[0] === 'Strategy detach failed:' && args[1] === 'passthrough' && String(args[2]).includes('thenable detach failed')),
        "the rejection is logged with the strategy's name",
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
        // the arguments needn't be valid. pinAtLevel() refuses as pinRange().
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
          ['pinAtLevel', [id, id, 1], 'pinRange'],
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
    store.close = () => {
      closes++;
      if (closes === 1) throw new Error('sync failed');
      realClose();
    };
    try {
      assert.throws(() => manager.close(), /sync failed/);
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
        const logged = await logsDuring(async () => {
          const clearingChunk = internals.clearQuarantineForCompressedChunk(chunk);
          assert.ok(await reaches(() => cleared.length === 1), 'the first clear began');
          if (move === 'swap') await manager.setStrategy(new PassthroughStrategy());
          else await manager.fork();
          openClear();
          await settlesWithin(clearingChunk);
        });
        assert.deepStrictEqual(cleared, ['debt-1'], 'the clear made no further clear');
        assert.deepStrictEqual(logged.filter((line) => line.includes('[compression-quarantine]')), [], 'no clear and no failure logged');
      } finally {
        manager.close();
        store.close();
      }
    });
  }
});
