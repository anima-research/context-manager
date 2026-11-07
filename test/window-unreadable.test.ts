/**
 * A window index the manager can't read (src/window-index.ts).
 *
 * - A write the store threw on, where the index can't then be read again to
 *   tell whether the write landed: the call throws
 *   WindowWriteOutcomeUnknownError, carrying the write's own error as its
 *   `cause` and the rows the write would have moved. What the write did is
 *   settled at the next write through the index, on the branch it was made
 *   on: the strategy then hears the rows that entered or left, once, before
 *   that call's own work, and hears nothing of a write the store refused.
 *   Where the store can't say its branch before the write or after it,
 *   nothing waits, the error and a warning say so, and the strategy reads
 *   the window at its next select (the nothing-waits case below); a write
 *   made while the store can't say its branch, where a settlement waits,
 *   writes nothing.
 * - A window state that holds no index this version reads, a value that
 *   isn't a list of items or one the store can't read back: the window is
 *   the record, with one warning saying what the state holds, and
 *   presentRows and retractRows refuse to write to it, saying so; nothing
 *   is written, and a reopen reads the same. A read that fails another way
 *   throws, and the next read reads the index.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, WindowWriteOutcomeUnknownError, windowIndexStateId } from '../src/index.js';
import type { CompileResult, MessageId, StoredMessage, StrategyContext } from '../src/index.js';

const BASE = './test-window-unreadable';
let storeSeq = 0;
function freshPath(): string {
  const path = `${BASE}-${storeSeq++}`;
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  return path;
}
after(() => {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const INDEX = windowIndexStateId('zz-agent');
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** The first text of each compiled message, in order. */
function texts(result: CompileResult): string[] {
  return result.messages.map((m) => (m.content.find((b) => b.type === 'text') as { text: string } | undefined)?.text ?? '');
}

/** Runs `fn`, keeping what it warns. */
async function warnings<T>(fn: () => Promise<T>): Promise<{ value: T; warned: string[] }> {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), warned };
  } finally {
    console.warn = warn;
  }
}

/** Passthrough that keeps each onPresented and onRetracted call, in one log. */
class Hearing extends PassthroughStrategy {
  log: string[] = [];
  async onPresented(rows: readonly StoredMessage[]): Promise<void> {
    this.log.push(`presented ${rows.map((m) => m.id).join(',')}`);
  }
  async onRetracted(_rows: readonly StoredMessage[], _ctx?: unknown, info?: { ids: readonly MessageId[] }): Promise<void> {
    this.log.push(`retracted ${(info?.ids ?? []).join(',')}`);
  }
}

/**
 * Makes the next append to the window index, single or batched, throw:
 * after the store kept it (`kept`), or before it wrote anything. Every read
 * of the index's revision then throws too, `reads` times, so the index
 * can't be read again to tell which. With `branchUnread`, so does every
 * read of the store's branch after the append throws. Returns the undo.
 */
function failNextWriteUnread(cm: ContextManager, kept: boolean, reads = 1, branchUnread = false): () => void {
  const store = cm.getStore() as unknown as Record<string, unknown>;
  const names = ['appendToStateJsonWithIdentity', 'appendManyToStateJsonWithIdentity', 'stateHeadOffset', 'getStateLen', 'currentBranch'];
  const originals = new Map(names.map((name) => [name, { own: Object.prototype.hasOwnProperty.call(store, name), fn: store[name] }]));
  let failed = false;
  let failingReads = 0;
  for (const name of names.slice(0, 2)) {
    const append = originals.get(name)!.fn as (this: unknown, id: string, ...rest: unknown[]) => unknown;
    store[name] = function (this: unknown, id: string, ...rest: unknown[]) {
      if (id !== INDEX || failed) return append.call(this, id, ...rest);
      failed = true;
      if (kept) append.call(this, id, ...rest);
      failingReads = reads;
      throw new Error(kept ? 'zz-index-kept-then-failed' : 'zz-index-refused');
    };
  }
  if (branchUnread) {
    const branch = originals.get('currentBranch')!.fn as (this: unknown) => unknown;
    store.currentBranch = function (this: unknown) {
      if (failed) throw new Error('zz-branch-read-failed');
      return branch.call(this);
    };
  }
  for (const name of names.slice(2, 4)) {
    const read = originals.get(name)!.fn as ((this: unknown, id: string) => unknown) | undefined;
    if (typeof read !== 'function') continue;
    store[name] = function (this: unknown, id: string) {
      if (id === INDEX && failingReads > 0) {
        failingReads--;
        throw new Error('zz-index-read-failed');
      }
      return read.call(this, id);
    };
  }
  return () => {
    for (const [name, { own, fn }] of originals) {
      if (own) store[name] = fn;
      else delete store[name];
    }
  };
}

/** Asserts `run` throws WindowWriteOutcomeUnknownError for `operation`, naming the rows and the cause. */
function throwsUnknown(
  run: () => unknown,
  expected: { operation: string; entering: MessageId[]; leaving: MessageId[]; cause: string; says?: RegExp },
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof WindowWriteOutcomeUnknownError, `a WindowWriteOutcomeUnknownError: ${String(error)}`);
    assert.equal(error.name, 'WindowWriteOutcomeUnknownError');
    assert.equal(error.operation, expected.operation);
    assert.deepEqual(error.entering, expected.entering);
    assert.deepEqual(error.leaving, expected.leaving);
    assert.equal((error.cause as Error).message, expected.cause);
    assert.equal((error.readError as Error).message, 'zz-index-read-failed');
    assert.match(error.message, new RegExp(`^ContextManager\\.${expected.operation}: `));
    assert.match(error.message, /can't be read again to tell whether the write landed/);
    assert.ok(error.message.endsWith(`: ${expected.cause}`), 'the message ends with the cause\'s');
    if (expected.says) assert.match(error.message, expected.says);
    return true;
  });
}

describe('a write the store threw on, where the index then can\'t be read', () => {
  it('presentRows, the write kept: throws outcome-unknown; the next write tells the strategy the rows entered, once', async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const [x, y] = ['x', 'y'].map((t) => cm.addMessage('alice', [text(t)]));
    const restore = failNextWriteUnread(cm, true);
    try {
      throwsUnknown(() => cm.presentRows([x!]), { operation: 'presentRows', entering: [x!], leaving: [], cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
    assert.deepEqual(strategy.log, [], 'nothing is told while the outcome is unknown');
    assert.equal(cm.windowStatusOf(x!), 'in', 'setup: the store kept the write');
    // A retry is refused, the row being in, and settles the write first.
    assert.throws(() => cm.presentRows([x!]), /in the window already/);
    assert.deepEqual(strategy.log, [`presented ${x}`], 'the strategy hears the row once');
    cm.presentRows([y!]);
    assert.deepEqual(strategy.log, [`presented ${x}`, `presented ${y}`], 'and never again');
    cm.close();
  });

  it('presentRows, the write refused: throws outcome-unknown; the strategy hears nothing until a retry presents the row', async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const [x, y] = ['x', 'y'].map((t) => cm.addMessage('alice', [text(t)]));
    const restore = failNextWriteUnread(cm, false);
    try {
      throwsUnknown(() => cm.presentRows([x!, y!]), { operation: 'presentRows', entering: [x!, y!], leaving: [], cause: 'zz-index-refused' });
    } finally {
      restore();
    }
    assert.deepEqual([x!, y!].map((id) => cm.windowStatusOf(id)), ['out', 'out'], 'setup: the store wrote nothing');
    cm.presentRows([x!, y!]);
    assert.deepEqual(strategy.log, [`presented ${x},${y}`], 'only the retry is heard');
    cm.close();
  });

  // CM #350 bot review, wave 2, findings 10 and 33: what a write whose
  // outcome was unknown did is told from the call's own record, so a
  // removal before it settles doesn't leave it rows to look up.
  it('presentRows, the write kept: a removal of its row before the next write tells the row as it was stored, then its leaving', async () => {
    for (const hook of ['onPresented', 'onNewMessage'] as const) {
      class HearsRows extends PassthroughStrategy {
        log: string[] = [];
        async onPresented(rows: readonly StoredMessage[]): Promise<void> {
          this.log.push(`presented ${rows.map((m) => m?.id).join(',')}`);
          throw new Error('zz-hook-failed');
        }
        async onNewMessage(message: StoredMessage): Promise<void> {
          this.log.push(`new ${message?.id}`);
          throw new Error('zz-hook-failed');
        }
        async onRetracted(_rows: readonly StoredMessage[], _ctx: unknown, info: { ids: readonly MessageId[]; removed: boolean }): Promise<void> {
          this.log.push(`retracted ${info.ids.join(',')}${info.removed ? ' removed' : ''}`);
        }
      }
      const strategy = new HearsRows();
      if (hook === 'onNewMessage') (strategy as { onPresented?: unknown }).onPresented = undefined;
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      const x = cm.addMessage('alice', [text('x')]);
      const restore = failNextWriteUnread(cm, true);
      try {
        throwsUnknown(() => cm.presentRows([x]), { operation: 'presentRows', entering: [x], leaving: [], cause: 'zz-index-kept-then-failed' });
      } finally {
        restore();
      }
      const unhandled: string[] = [];
      const onUnhandled = (err: unknown) => { unhandled.push(String(err)); };
      process.on('unhandledRejection', onUnhandled);
      const logged: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        cm.removeMessage(x);
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        console.error = error;
        process.off('unhandledRejection', onUnhandled);
      }
      assert.deepEqual(strategy.log, [hook === 'onPresented' ? `presented ${x}` : `new ${x}`, `retracted ${x} removed`], `${hook}: the row as stored, then its leaving`);
      assert.ok(logged.some((line) => line.includes(`failed for message ${x}`) && line.includes('zz-hook-failed')), `${hook}: the hook's failure is logged, naming the row: ${logged.join('\n')}`);
      assert.deepEqual(unhandled, [], hook);
      cm.close();
    }
  });

  // CM #350 bot review, wave 4, finding 31: the settlement a removal runs
  // can take its row out first, through a hook.
  it("presentRows, the write kept: a removal whose settlement's hook takes the row out tells the row's leaving once", async () => {
    let cm!: ContextManager;
    /** Hearing, whose onPresented takes the rows it hears out of the window again, by their ids, before it returns. */
    class RetractsOnPresented extends Hearing {
      async onPresented(rows: readonly StoredMessage[]): Promise<void> {
        this.log.push(`presented ${rows.map((m) => m.id).join(',')}`);
        cm.retractRows(rows.map((m) => m.id));
      }
    }
    const strategy = new RetractsOnPresented();
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    const restore = failNextWriteUnread(cm, true);
    try {
      throwsUnknown(() => cm.presentRows([x]), { operation: 'presentRows', entering: [x], leaving: [], cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
    cm.removeMessage(x);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cm.ordinalOf(x), undefined, 'setup: the row is out of the window');
    assert.deepEqual(strategy.log, [`presented ${x}`, `retracted ${x}`], 'the row as stored, then its leaving, once');
    cm.close();
  });

  // CM #350 bot review, wave 6, finding 26: where the removal's own
  // tombstones then fail to land, what it tells is what that write was
  // taking out, read after the settlement, not before it.
  it("a removal whose settlement's hook takes one of its rows out, and whose own tombstones fail, tells that row once", async () => {
    let cm!: ContextManager;
    let x!: MessageId;
    /** Hearing, whose onPresented, once armed, takes x out by its id, then makes the next write to the index fail, writing nothing. */
    class RetractsX extends Hearing {
      armed = false;
      async onPresented(rows: readonly StoredMessage[]): Promise<void> {
        this.log.push(`presented ${rows.map((m) => m.id).join(',')}`);
        if (!this.armed) return;
        this.armed = false;
        cm.retractRemoved([x]);
        const store = cm.getStore() as unknown as Record<string, unknown>;
        const append = store.appendToStateJsonWithIdentity as (this: unknown, id: string, ...rest: unknown[]) => unknown;
        store.appendToStateJsonWithIdentity = function (this: unknown, id: string, ...rest: unknown[]) {
          if (id !== INDEX) return append.call(this, id, ...rest);
          delete store.appendToStateJsonWithIdentity;
          throw new Error('zz-tombstones-refused');
        };
      }
    }
    const strategy = new RetractsX();
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    let y: MessageId;
    [x, y] = ['x', 'y'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    const z = cm.addMessage('alice', [text('z')]);
    cm.presentRows([x, y]);
    const restore = failNextWriteUnread(cm, true);
    try {
      throwsUnknown(() => cm.presentRows([z]), { operation: 'presentRows', entering: [z], leaving: [], cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
    strategy.log.length = 0;
    strategy.armed = true;
    const error = console.error;
    console.error = () => {};
    try {
      cm.removeMessages(x, y);
    } finally {
      console.error = error;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cm.ordinalOf(x), undefined, "setup: the hook's retractRemoved took x out");
    assert.notEqual(cm.ordinalOf(y), undefined, "setup: the removal's own tombstone for y didn't land");
    assert.deepEqual(strategy.log, [`presented ${z}`, `retracted ${x}`, `retracted ${y}`], 'x is told once, by the hook\'s call, and y by the removal');
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 45: what waits for a later write
  // holds the rows the write named, not the call's record.
  it("a write whose outcome is unknown doesn't keep the record its call read while its telling waits", async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (const operation of ['presentRows', 'retractRows', 'retractAbsentRows'] as const) {
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Hearing() });
      cm.presentRows([]);
      const rows = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t.repeat(1000))]));
      if (operation !== 'presentRows') cm.presentRows(rows);
      if (operation === 'retractAbsentRows') {
        const other = await ContextManager.open({ store: cm.getStore(), namespace: 'zz-other', strategy: new PassthroughStrategy() });
        other.removeMessage(rows[0]!);
        other.close();
      }
      // Each listing of the record the call reads.
      const listings: WeakRef<object>[] = [];
      const own = cm as unknown as { mergedMessageView: () => object };
      const real = own.mergedMessageView;
      own.mergedMessageView = function (this: unknown) {
        const view = real.call(this) as { getAll: () => object };
        return new Proxy(view, {
          get(target, prop) {
            if (prop === 'getAll') {
              return () => {
                const listing = target.getAll();
                listings.push(new WeakRef(listing));
                return listing;
              };
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      // CM #350 bot review, wave 3, finding 31: the setup's presentRows(rows)
      // logged already, so what the settled write tells is what follows.
      const heardBefore = (cm.getStrategy() as Hearing).log.length;
      const restore = failNextWriteUnread(cm, true);
      try {
        assert.throws(
          () => (operation === 'presentRows' ? cm.presentRows([rows[0]!]) : operation === 'retractRows' ? cm.retractRows([rows[0]!]) : cm.retractAbsentRows()),
          WindowWriteOutcomeUnknownError,
          operation,
        );
      } finally {
        restore();
        delete (own as { mergedMessageView?: unknown }).mergedMessageView;
      }
      assert.ok(listings.length > 0, `${operation}, setup: the call read the record`);
      // A listing the store caches is let go once the record changes.
      cm.addMessage('alice', [text('c')]);
      cm.getAllMessages();
      for (let i = 0; i < 5; i++) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(listings.map((ref) => ref.deref() === undefined), listings.map(() => true), `${operation}: the record the call read is let go`);
      cm.presentRows([]);
      assert.deepEqual(
        (cm.getStrategy() as Hearing).log.slice(heardBefore),
        [`${operation === 'presentRows' ? 'presented' : 'retracted'} ${rows[0]}`],
        `${operation}: the write is still told once it settles`,
      );
      cm.close();
    }
  });

  it('a write that settles waits while the index still can\'t be read, and settles at the write after', async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const [x, y] = ['x', 'y'].map((t) => cm.addMessage('alice', [text(t)]));
    const restore = failNextWriteUnread(cm, true, 2);
    try {
      throwsUnknown(() => cm.presentRows([x!]), { operation: 'presentRows', entering: [x!], leaving: [], cause: 'zz-index-kept-then-failed' });
      assert.throws(() => cm.presentRows([y!]), /zz-index-read-failed/, 'the next call can\'t read the index either');
    } finally {
      restore();
    }
    assert.deepEqual(strategy.log, []);
    cm.presentRows([y!]);
    assert.deepEqual(strategy.log, [`presented ${x}`, `presented ${y}`]);
    cm.close();
  });

  // CM #350 bot review (wave 2), finding 16: the write waits on the branch
  // it was made on, read before it, so a store that can't say its branch
  // once the write throws doesn't drop it.
  it("a write that settles waits on the branch read before it, where the store can't say its branch after", async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    const restore = failNextWriteUnread(cm, true, 1, true);
    try {
      throwsUnknown(() => cm.presentRows([x]), { operation: 'presentRows', entering: [x], leaving: [], cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
    assert.deepEqual(strategy.log, []);
    cm.presentRows([]);
    assert.deepEqual(strategy.log, [`presented ${x}`], 'the next write on the branch settles it');
    cm.close();
  });

  // CM #350 bot review, wave 5, finding 29: a write can't tell whether an
  // earlier write waits on its branch while the store can't say which that
  // is, so it writes nothing, as while the index can't be read.
  it("a write while the store can't say its branch, and an earlier write's outcome waits, writes nothing, and the earlier write settles first once it can", async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    const restore = failNextWriteUnread(cm, true);
    try {
      throwsUnknown(() => cm.presentRows([x]), { operation: 'presentRows', entering: [x], leaving: [], cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
    // The index reads; the store's branch, read where the index settles, doesn't.
    type Settled = (operation: string) => unknown;
    const index = (cm as unknown as { windowIndex: { settled: Settled } }).windowIndex;
    const store = cm.getStore() as unknown as Record<string, unknown>;
    const currentBranch = store.currentBranch as (this: unknown) => unknown;
    const settled = index.settled;
    let settling = false;
    index.settled = function (this: unknown, operation: string) {
      settling = true;
      try {
        return settled.call(this, operation);
      } finally {
        settling = false;
      }
    };
    store.currentBranch = function (this: unknown) {
      if (settling) throw new Error('zz-branch-read-failed');
      return currentBranch.call(this);
    };
    try {
      assert.throws(() => cm.retractRows([x]), (error: Error) => {
        assert.match(error.message, /^ContextManager\.retractRows: the store can't say its branch/);
        assert.ok(error.message.endsWith('zz-branch-read-failed'), error.message);
        return true;
      });
    } finally {
      delete (index as { settled?: unknown }).settled;
      delete store.currentBranch;
    }
    assert.deepEqual(strategy.log, [], 'nothing is told while it waits');
    assert.equal(cm.windowStatusOf(x), 'in', 'nothing was written');
    cm.retractRows([x]);
    assert.deepEqual(strategy.log, [`presented ${x}`, `retracted ${x}`], 'once the store says its branch, x is heard entering, then leaving');
    cm.close();
  });

  // CM #350 bot review, wave 4, finding 13: where the store can't say its
  // branch before the write or after it, nothing waits, and the error says so.
  it("a write whose outcome is unknown, where the store can't say its branch before the write either, says nothing waits to tell the strategy", async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    // The index's read of the store's branch before the write fails (the
    // message store's own reads of it before then don't), and so does
    // every read of it once the write throws. The read before is the
    // store's own, made inside settled (CM #350 bot review, wave 5,
    // finding 24), so a settled that let it throw would fail the call
    // before its write.
    type Settled = (operation: string) => { state: unknown; branch: string | null };
    const index = (cm as unknown as { windowIndex: { settled: Settled } }).windowIndex;
    const settled = index.settled;
    let settling = false;
    index.settled = function (this: unknown, operation: string) {
      settling = true;
      try {
        return settled.call(this, operation);
      } finally {
        settling = false;
      }
    };
    let warned: string[];
    try {
      const restore = failNextWriteUnread(cm, true, 1, true);
      const store = cm.getStore() as unknown as Record<string, unknown>;
      const branch = store.currentBranch as (this: unknown) => unknown;
      store.currentBranch = function (this: unknown) {
        if (settling) throw new Error('zz-branch-read-failed');
        return branch.call(this);
      };
      try {
        ({ warned } = await warnings(async () =>
          throwsUnknown(() => cm.presentRows([x]), {
            operation: 'presentRows',
            entering: [x],
            leaving: [],
            cause: 'zz-index-kept-then-failed',
            says: /nothing waits to tell the strategy what it did, so it reads the window at its next select: zz-index-kept-then-failed$/,
          }),
        ));
      } finally {
        restore();
      }
    } finally {
      delete (index as { settled?: unknown }).settled;
    }
    assert.ok(warned.some((line) => line.includes('nothing waits to tell the strategy what it did')), warned.join('\n'));
    cm.close();
  });

  // Weft's plant on 6a18406: the other form of that message. Where the
  // store says the branch the write was made on, before the write or only
  // after it, the write waits there, and the error says the strategy hears
  // what it did at the next write to the window, which it then does.
  it("a write whose outcome is unknown, where the store says the branch it was made on, says the strategy hears what it did at the next write to the window", async () => {
    for (const read of ['before and after', 'before only', 'after only'] as const) {
      const strategy = new Hearing();
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      const x = cm.addMessage('alice', [text('x')]);
      type Settled = (operation: string) => { state: unknown; branch: string | null };
      const index = (cm as unknown as { windowIndex: { settled: Settled } }).windowIndex;
      if (read === 'after only') {
        // The index's read of the store's branch before the write fails.
        const settled = index.settled;
        index.settled = function (this: unknown, operation: string) {
          return { ...settled.call(this, operation), branch: null };
        };
      }
      let warned: string[];
      try {
        const restore = failNextWriteUnread(cm, true, 1, read === 'before only');
        try {
          ({ warned } = await warnings(async () =>
            throwsUnknown(() => cm.presentRows([x]), {
              operation: 'presentRows',
              entering: [x],
              leaving: [],
              cause: 'zz-index-kept-then-failed',
              says: /windowStatusOf tells which once the index reads, and the strategy hears what it did at the next write to the window: zz-index-kept-then-failed$/,
            }),
          ));
        } finally {
          restore();
        }
      } finally {
        delete (index as { settled?: unknown }).settled;
      }
      assert.ok(!warned.some((line) => line.includes('nothing waits')), `${read}: ${warned.join('\n')}`);
      assert.deepEqual(strategy.log, [], `${read}: nothing is told while the outcome is unknown`);
      cm.presentRows([]);
      assert.deepEqual(strategy.log, [`presented ${x}`], `${read}: the next write to the window tells the strategy, as the error says`);
      cm.close();
    }
  });

  // CM #350 bot review, wave 4, finding 5: windowStatusOf reads 'absent' for
  // a row the store no longer holds, whether or not a repair took it out.
  it("retractRemoved and retractAbsentRows, the outcome unknown: the error says ordinalOf tells which, and that the call can be made again", async () => {
    for (const repair of ['retractRemoved', 'retractAbsentRows'] as const) {
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Hearing() });
      cm.presentRows([]);
      const rows = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
      cm.presentRows(rows);
      const other = await ContextManager.open({ store: cm.getStore(), namespace: 'zz-other', strategy: new PassthroughStrategy() });
      other.removeMessage(rows[0]!);
      other.close();
      const restore = failNextWriteUnread(cm, true);
      try {
        throwsUnknown(() => (repair === 'retractRemoved' ? cm.retractRemoved([rows[0]!]) : cm.retractAbsentRows()), {
          operation: repair,
          entering: [],
          leaving: [rows[0]!],
          cause: 'zz-index-kept-then-failed',
          // "It" would be ordinalOf, a read (CM #350 bot review, wave 5, finding 30).
          says: new RegExp(`ordinalOf tells which once the index reads \\(undefined for a row taken out\\), and calling ${repair} again takes out only what is still there`),
        });
      } finally {
        restore();
      }
      assert.equal(cm.windowStatusOf(rows[0]!), 'absent', `${repair}: windowStatusOf can't tell`);
      assert.equal(cm.ordinalOf(rows[0]!), undefined, `${repair}, setup: the store kept the write, which ordinalOf tells`);
      assert.deepEqual(repair === 'retractRemoved' ? cm.retractRemoved([rows[0]!]) : cm.retractAbsentRows(), [], `${repair}: a second call takes out nothing more`);
      cm.close();
    }
  });

  it('retractRows, the write kept: throws outcome-unknown; the next write tells the strategy the rows left', async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const rows = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.presentRows(rows);
    strategy.log.length = 0;
    const restore = failNextWriteUnread(cm, true);
    try {
      throwsUnknown(() => cm.retractRows(rows, { undone: true }), { operation: 'retractRows', entering: [], leaving: rows, cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
    assert.deepEqual(strategy.log, []);
    assert.deepEqual(rows.map((id) => cm.windowStatusOf(id)), ['undone', 'undone'], 'setup: the store kept the write');
    cm.presentRows([]);
    assert.deepEqual(strategy.log, [`retracted ${rows.join(',')}`], 'presentRows([]) settles it');
    cm.close();
  });

  for (const repair of ['retractRemoved', 'retractAbsentRows'] as const) {
    it(`${repair}, the write kept: throws outcome-unknown; the next write tells the strategy the rows left`, async () => {
      const strategy = new Hearing();
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      const rows = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
      cm.presentRows(rows);
      const other = await ContextManager.open({ store: cm.getStore(), namespace: 'zz-other', strategy: new PassthroughStrategy() });
      other.removeMessages(rows[0]!, rows[1]!);
      other.close();
      strategy.log.length = 0;
      const restore = failNextWriteUnread(cm, true);
      try {
        throwsUnknown(
          () => (repair === 'retractRemoved' ? cm.retractRemoved(rows) : cm.retractAbsentRows()),
          { operation: repair, entering: [], leaving: [rows[0]!, rows[1]!], cause: 'zz-index-kept-then-failed' },
        );
      } finally {
        restore();
      }
      assert.deepEqual(strategy.log, []);
      assert.deepEqual(cm.retractAbsentRows(), [], 'the store kept the write: nothing is left to take out');
      assert.deepEqual(strategy.log, [`retracted ${rows[0]},${rows[1]}`], 'that call settles it');
      cm.close();
    });
  }

  // CM #350 bot review (wave 2), finding 6: the write-down, in legacy mode,
  // is a write to the index too. It puts no row in the window and takes
  // none out, so the error names none and nothing waits to be heard;
  // windowMode tells, once the index reads, whether it landed.
  for (const kept of [true, false]) {
    for (const operation of ['presentRows', 'retractRows'] as const) {
      it(`${operation} in legacy mode, the write-down ${kept ? 'kept' : 'refused'}: throws outcome-unknown, naming no row`, async () => {
        const strategy = new Hearing();
        const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
        const [x, y] = ['x', 'y'].map((t) => cm.addMessage('alice', [text(t)]));
        strategy.log.length = 0;
        const restore = failNextWriteUnread(cm, kept);
        try {
          throwsUnknown(
            () => (operation === 'presentRows' ? cm.presentRows([x!]) : cm.retractRows([x!])),
            {
              operation,
              entering: [],
              leaving: [],
              cause: kept ? 'zz-index-kept-then-failed' : 'zz-index-refused',
              says: /so whether the window was written down is unknown; .*windowMode tells which once the index reads/,
            },
          );
        } finally {
          restore();
        }
        assert.equal(cm.windowMode(), kept ? 'presented' : 'legacy', 'setup: the write-down landed, or not');
        assert.deepEqual([x!, y!].map((id) => cm.windowStatusOf(id)), ['in', 'in'], 'the write-down took no row out');
        if (operation === 'retractRows') {
          cm.retractRows([x!]);
          assert.deepEqual(strategy.log, [`retracted ${x}`], 'a call made again takes the row out, heard once');
        } else {
          assert.deepEqual(strategy.log, [], 'a write-down enters no row: nothing is heard');
        }
        cm.close();
      });
    }
  }

  // CM #350 bot review, wave 3, finding 20: the read of the ordinals a
  // presentation wrote, after its write, is the write's too.
  it("presentRows whose write lands and whose read of the index after it throws: told before the throw, or waiting as a write whose outcome is unknown", async () => {
    for (const reads of [1, 2]) {
      const label = reads === 1 ? 'read again' : 'unread';
      const strategy = new Hearing();
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      const [x, y] = ['x', 'y'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
      // The append lands, and the write's own read of the revision after it
      // works; the `reads` reads of the index after that throw.
      const store = cm.getStore() as unknown as Record<string, unknown>;
      const names = ['appendToStateJsonWithIdentity', 'appendManyToStateJsonWithIdentity', 'stateHeadOffset', 'getStateLen'];
      const originals = new Map(names.map((name) => [name, { own: Object.prototype.hasOwnProperty.call(store, name), fn: store[name] }]));
      let landed = false;
      let passing = 0;
      let failing = 0;
      for (const name of names.slice(0, 2)) {
        const append = originals.get(name)!.fn as (this: unknown, id: string, ...rest: unknown[]) => unknown;
        store[name] = function (this: unknown, id: string, ...rest: unknown[]) {
          const written = append.call(this, id, ...rest);
          if (id === INDEX && !landed) {
            landed = true;
            passing = 1;
            failing = reads;
          }
          return written;
        };
      }
      for (const name of names.slice(2)) {
        const read = originals.get(name)!.fn as ((this: unknown, id: string) => unknown) | undefined;
        if (typeof read !== 'function') continue;
        store[name] = function (this: unknown, id: string) {
          if (id === INDEX && passing > 0) passing--;
          else if (id === INDEX && failing > 0) {
            failing--;
            throw new Error('zz-index-read-failed');
          }
          return read.call(this, id);
        };
      }
      try {
        if (reads === 1) assert.throws(() => cm.presentRows([x]), (error: unknown) => error instanceof Error && error.message === 'zz-index-read-failed', label);
        else throwsUnknown(() => cm.presentRows([x]), { operation: 'presentRows', entering: [x], leaving: [], cause: 'zz-index-read-failed' });
      } finally {
        for (const [name, { own, fn }] of originals) {
          if (own) store[name] = fn;
          else delete store[name];
        }
      }
      assert.equal(cm.windowStatusOf(x), 'in', `${label}, setup: the write landed`);
      assert.deepEqual(strategy.log, reads === 1 ? [`presented ${x}`] : [], `${label}: told once the index reads, before the error is thrown; nothing while it can't`);
      assert.throws(() => cm.presentRows([x]), /in the window already/, `${label}: a retry is refused`);
      cm.presentRows([y]);
      assert.deepEqual(strategy.log, [`presented ${x}`, `presented ${y}`], `${label}: the row is heard once, before the next`);
      cm.close();
    }
  });
});

// CM #350 bot review (wave 2), finding 1: a write settles what an earlier
// write whose outcome was unknown did before its own work, and the hook that
// hears it can move the store's branch. The call was given the record of
// the branch it was made on, so it refuses, writing nothing, where it would
// have written that record into the other branch's window.
describe("a hook that hears what an unknown write did, and moves the store's branch", () => {
  /** Hearing, whose onPresented moves the store to `to`, once, before it logs. */
  class Moves extends Hearing {
    to: string | null = null;
    override async onPresented(rows: readonly StoredMessage[], ctx?: StrategyContext): Promise<void> {
      if (this.to !== null && ctx) {
        const to = this.to;
        this.to = null;
        ctx.store.switchBranch(to);
      }
      return super.onPresented(rows);
    }
  }

  /** A presentRows([x]) whose write the store kept and whose outcome can't be read. */
  function presentUnread(cm: ContextManager, x: MessageId): void {
    const restore = failNextWriteUnread(cm, true);
    try {
      throwsUnknown(() => cm.presentRows([x]), { operation: 'presentRows', entering: [x], leaving: [], cause: 'zz-index-kept-then-failed' });
    } finally {
      restore();
    }
  }

  it("presentRows([]) refuses, writing nothing into the window of the legacy branch the hook moved to", async () => {
    const strategy = new Moves();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const store = cm.getStore();
    const a = cm.addMessage('alice', [text('a')]);
    // Made before the first presentation: in legacy mode, its record a alone.
    const before = store.createBranchAt('zz-before', cm.currentBranch().name, store.currentSequence()).name;
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    presentUnread(cm, x);
    strategy.log.length = 0;
    strategy.to = before;
    assert.throws(() => cm.presentRows([]), /^Error: ContextManager\.presentRows: .*moved the store's branch from main to zz-before/);
    assert.equal(cm.currentBranch().name, before, 'setup: the hook moved the store');
    assert.deepEqual(strategy.log, [`presented ${x}`], 'the earlier write is settled, once');
    assert.equal(cm.windowMode(), 'legacy', "nothing is written to the branch's window");
    assert.equal(cm.ordinalOf(x), undefined);
    cm.presentRows([]);
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a], "a call made again writes down this branch's record");
    assert.deepEqual(strategy.log, [`presented ${x}`]);
    cm.close();
  });

  it("retractAbsentRows() refuses, taking nothing out of the window of the branch the hook moved to", async () => {
    const strategy = new Moves();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const store = cm.getStore();
    cm.presentRows([]);
    const home = cm.currentBranch().name;
    const side = store.createBranchAt('zz-side', home, store.currentSequence()).name;
    await cm.switchBranch(side);
    // A row of the side branch alone, in its window.
    const s = cm.addMessage('alice', [text('s')]);
    cm.presentRows([s]);
    await cm.switchBranch(home);
    const x = cm.addMessage('alice', [text('x')]);
    presentUnread(cm, x);
    strategy.log.length = 0;
    strategy.to = side;
    assert.throws(() => cm.retractAbsentRows(), /^Error: ContextManager\.retractAbsentRows: .*moved the store's branch from main to zz-side/);
    assert.equal(cm.currentBranch().name, side, 'setup: the hook moved the store');
    assert.deepEqual(strategy.log, [`presented ${x}`], 'the earlier write is settled, once');
    assert.equal(cm.windowStatusOf(s), 'in', "the branch's own row stays in its window");
    assert.deepEqual(cm.retractAbsentRows(), [], 'a call made again finds nothing to take out');
    assert.deepEqual(strategy.log, [`presented ${x}`]);
    cm.close();
  });

  // CM #350 bot review, wave 5, finding 16: a removal's settlement can run
  // that hook too, which makes the tombstones' write refuse; the rows read
  // before it aren't told then, on the branch the store moved to.
  it("a removal whose settlement's hook moves the store tells no strategy of the removed row, and leaves the other branch's window as it was", async () => {
    const strategy = new Moves();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const store = cm.getStore();
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    cm.presentRows([a]);
    // Made now: its record and its window hold a.
    const side = store.createBranchAt('zz-side', cm.currentBranch().name, store.currentSequence()).name;
    const x = cm.addMessage('alice', [text('x')]);
    presentUnread(cm, x);
    strategy.log.length = 0;
    strategy.to = side;
    const error = console.error;
    console.error = () => {};
    let warned: string[];
    try {
      ({ warned } = await warnings(async () => cm.removeMessage(a)));
    } finally {
      console.error = error;
    }
    assert.equal(cm.currentBranch().name, side, 'setup: the settlement\'s hook moved the store');
    assert.deepEqual(strategy.log, [`presented ${x}`], 'the earlier write is settled, once, and no strategy is told a left');
    assert.ok(warned.some((line) => line.includes("moved the store's branch") && line.includes(`removed message ${a}`)), warned.join('\n'));
    assert.equal(cm.windowStatusOf(a), 'in', "the other branch's window still holds a");
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 6, finding 22: two writes can wait on one
  // branch (a hook that heard an earlier one made a write whose outcome was
  // unknown, and so did the call that settled it). Where the first one's
  // hook moves the store, the second isn't settled on the other branch: it
  // waits for the next write on its own.
  it("of two writes waiting on a branch, the one after a hook that moved the store waits for the next write on that branch", async () => {
    /** Hearing, which runs the reaction set for a row, once, when it hears that row enter, after logging it. */
    class Reacts extends Hearing {
      on = new Map<MessageId, () => void>();
      override onPresented(rows: readonly StoredMessage[]): Promise<void> {
        const heard = super.onPresented(rows);
        for (const row of rows) {
          const react = this.on.get(row.id);
          this.on.delete(row.id);
          react?.();
        }
        return heard;
      }
    }
    const strategy = new Reacts();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const store = cm.getStore();
    cm.presentRows([]);
    const home = cm.currentBranch().name;
    const side = store.createBranchAt('zz-side', home, store.currentSequence()).name;
    const [x, y, w] = ['x', 'y', 'w'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    // Each of the next `n` appends to the index is kept and then throws,
    // and the read of the index after it throws once.
    const failing = { appends: 0, reads: 0 };
    const raw = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    const originals = new Map(['appendToStateJsonWithIdentity', 'stateHeadOffset'].map((name) => [name, raw[name]!] as const));
    raw.appendToStateJsonWithIdentity = function (this: unknown, id: unknown, ...rest: unknown[]) {
      const record = originals.get('appendToStateJsonWithIdentity')!.call(this, id, ...rest);
      if (id !== INDEX || failing.appends === 0) return record;
      failing.appends--;
      failing.reads++;
      throw new Error('zz-index-kept-then-failed');
    };
    raw.stateHeadOffset = function (this: unknown, id: unknown) {
      if (id === INDEX && failing.reads > 0) {
        failing.reads--;
        throw new Error('zz-index-read-failed');
      }
      return originals.get('stateHeadOffset')!.call(this, id);
    };
    try {
      failing.appends = 1;
      assert.throws(() => cm.presentRows([x]), WindowWriteOutcomeUnknownError);
      // Hearing x, the hook presents y, whose write's outcome is unknown too;
      // then the call that settled x presents w, likewise.
      strategy.on.set(x, () => {
        assert.throws(() => cm.presentRows([y]), WindowWriteOutcomeUnknownError);
      });
      failing.appends = 2;
      assert.throws(() => cm.presentRows([w]), WindowWriteOutcomeUnknownError);
      assert.deepEqual(strategy.log, [`presented ${x}`], 'setup: x is settled, and y and w wait on the branch');
      // Hearing y, the hook moves the store itself.
      strategy.on.set(y, () => store.switchBranch(side));
      assert.throws(() => cm.presentRows([]), /^Error: ContextManager\.presentRows: .*moved the store's branch from main to zz-side/);
      assert.equal(cm.currentBranch().name, side, 'setup: the hook moved the store');
      assert.deepEqual(strategy.log, [`presented ${x}`, `presented ${y}`], "w isn't told on the branch the hook moved to");
      store.switchBranch(home);
      cm.presentRows([]);
      assert.deepEqual(strategy.log, [`presented ${x}`, `presented ${y}`, `presented ${w}`], 'the next write on the branch it was made on settles it, once');
    } finally {
      for (const [name, fn] of originals) raw[name] = fn;
    }
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });
});

describe('a window state that holds no index this version reads', () => {
  const cases: Array<[label: string, setUp: (store: JsStore) => void, says: RegExp]> = [
    ['an object', (store) => {
      store.registerState({ id: INDEX, strategy: 'snapshot' });
      store.setStateJson(INDEX, { someone: 'else', n: 1 });
    }, /holds an object \(\{"someone":"else","n":1\}\), not a list of index items/],
    ['a string', (store) => {
      store.registerState({ id: INDEX, strategy: 'snapshot' });
      store.setStateJson(INDEX, 'zz');
    }, /holds a string \("zz"\), not a list of index items/],
    // CM #350 bot review (wave 2), finding 25: a value of JSON null is a
    // value, not the absence of one.
    ['null', (store) => {
      store.registerState({ id: INDEX, strategy: 'snapshot' });
      store.setStateJson(INDEX, null);
    }, /holds null, not a list of index items/],
    ['bytes that aren\'t JSON', (store) => {
      store.registerState({ id: INDEX, strategy: 'snapshot' });
      store.setState(INDEX, Buffer.from([0xff, 0x00, 0x13]));
    }, /holds a value that isn't JSON \(.+\)/],
    // A snapshot value with an item appended after it: the store can't
    // rebuild one value from its records.
    ['records the store can\'t read back', (store) => {
      store.registerState({ id: INDEX, strategy: 'snapshot' });
      store.setStateJson(INDEX, { someone: 'else' });
      store.appendToStateJsonWithIdentity(INDEX, { id: 'zz-x' }, 'by', 'at');
    }, /holds records the store can't read back as one value \(Deserialization error: .+\)/],
    ['an item that isn\'t JSON', (store) => {
      store.registerState({ id: INDEX, strategy: 'append_log' });
      store.appendToState(INDEX, Buffer.from([0xff, 0x00]));
    }, /holds records the store can't read back as one value \(Deserialization error: .+\)/],
  ];
  for (const [label, setUp, says] of cases) {
    it(`${label}: the window is the record, with one warning, and presentRows and retractRows refuse to write to it`, async () => {
      const path = freshPath();
      const cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
      const store = cm.getStore();
      setUp(store);
      const revision = store.stateHeadOffset(INDEX);
      const { warned } = await warnings(async () => {
        assert.equal(cm.windowMode(), 'legacy');
        assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b']);
        assert.equal(cm.getPresentedMessages(), cm.getAllMessages());
        assert.equal(cm.ordinalOf(a!), undefined);
        assert.equal(cm.indexLength(), 0);
        assert.deepEqual(cm.getUnpresentedMessages(), []);
        const refused = new RegExp(`the window index of branch main ${says.source}, so this version writes nothing to it`);
        assert.throws(() => cm.presentRows([]), refused);
        assert.throws(() => cm.presentRows([b!]), refused);
        assert.throws(() => cm.retractRows([a!]), refused);
        cm.retractRows([]);
        assert.deepEqual(cm.retractAbsentRows(), []);
        assert.deepEqual(cm.retractRemoved([a!]), []);
      });
      const lines = warned.filter((line) => line.includes('window index'));
      assert.equal(lines.length, 1, warned.join('\n'));
      assert.match(lines[0]!, new RegExp(`the window index of branch main ${says.source}; the window there is the record \\(legacy mode\\)`));
      assert.equal(store.stateHeadOffset(INDEX), revision, 'nothing is written');
      cm.close();

      const reopened = await warnings(async () => {
        const again = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
        try {
          assert.equal(again.windowMode(), 'legacy');
          assert.deepEqual(texts(await again.compile(BIG)), ['a', 'b'], 'a reopen reads the record');
        } finally {
          again.close();
        }
      });
      assert.equal(reopened.warned.filter((line) => line.includes('window index')).length, 1);
    });
  }

  it('a read that fails another way throws, and isn\'t kept: the next read reads the index', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const a = cm.addMessage('alice', [text('a')]);
    cm.presentRows([]);
    const other = await ContextManager.open({ store: cm.getStore(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const b = other.addMessage('alice', [text('b')]);
    other.presentRows([b]);
    other.close();
    // The index moved under cm, which reads it again at its next read.
    const store = cm.getStore() as unknown as { getStateJson: (id: string) => unknown };
    const read = store.getStateJson;
    let fail = true;
    store.getStateJson = function (this: unknown, id: string) {
      if (id === INDEX && fail) {
        fail = false;
        throw new Error('zz-io-failed');
      }
      return read.call(this, id);
    };
    try {
      assert.throws(() => cm.windowMode(), /zz-io-failed/);
      assert.equal(cm.windowMode(), 'presented');
      assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a, b]);
    } finally {
      store.getStateJson = read;
    }
    cm.close();
  });
});
