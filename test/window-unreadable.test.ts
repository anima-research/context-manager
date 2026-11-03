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
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, WindowWriteOutcomeUnknownError, windowIndexStateId } from '../src/index.js';
import type { CompileResult, MessageId, StoredMessage } from '../src/index.js';

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
 * can't be read again to tell which. Returns the undo.
 */
function failNextWriteUnread(cm: ContextManager, kept: boolean, reads = 1): () => void {
  const store = cm.getStore() as unknown as Record<string, unknown>;
  const names = ['appendToStateJsonWithIdentity', 'appendManyToStateJsonWithIdentity', 'stateHeadOffset', 'getStateLen'];
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
  for (const name of names.slice(2)) {
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
  expected: { operation: string; entering: MessageId[]; leaving: MessageId[]; cause: string },
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
