/**
 * What a failed addMessage throws tells a host which of three things
 * happened (agent-framework #844, design question 5):
 * - WriteLandedError: the store holds the rows of the message it names, and
 *   no others, with the write's own error as its cause.
 * - WriteOutcomeUnknownError: the manager can't tell whether the store holds
 *   some row of the message, because the read that would tell threw, or
 *   the write's branch moved, so the manager can't read it. It
 *   names the rows the manager knows are stored, and what it can't say
 *   about.
 * - Any other error: the store holds none of the message. A write that fails
 *   before a row lands throws its own error, unwrapped, and so does a
 *   sharded write once it has removed the shards it stored.
 *
 * A host's onMessage listener can't fail a write (its throw is logged), so
 * the failure after a row landed is the manager's own: its listener runs
 * inside each append. These make it fail by wrapping that listener, or, in
 * legacy mode, the context it builds for the strategy there.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, MalformedContentError, PassthroughStrategy, WriteLandedError, WriteOutcomeUnknownError } from '../src/index.js';
import type { MessageId, MessageStore, StoredMessage, StrategyContext } from '../src/index.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const textOf = (m: StoredMessage): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

const paths: string[] = [];
function freshPath(): string {
  const path = `./test-write-landed-${paths.length}`;
  rmSync(path, { recursive: true, force: true });
  paths.push(path);
  return path;
}
after(() => {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
});

/** Stores each block of a message as a shard of its own, in body group 'three'. */
class Sharding extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
  }
}

/** Sharding, keeping the ids each onPresented and onRetracted call was given. */
class ShardingHears extends Sharding {
  presented: MessageId[][] = [];
  retracted: Array<{ ids: readonly MessageId[]; rows: MessageId[]; removed: boolean }> = [];
  async onPresented(rows: readonly StoredMessage[], _ctx: StrategyContext): Promise<void> {
    this.presented.push(rows.map((m) => m.id));
  }
  async onRetracted(rows: readonly StoredMessage[], _ctx: StrategyContext, info: { removed: boolean; ids: readonly MessageId[] }): Promise<void> {
    this.retracted.push({ ids: info.ids, rows: rows.map((m) => m.id), removed: info.removed });
  }
}

interface Internals {
  messageStore: MessageStore;
  createStrategyContext: () => unknown;
  handleMessageStoreEvent: (event: { type: string }) => void;
}
const internals = (cm: ContextManager): Internals => cm as unknown as Internals;

/**
 * The manager's own listener does its work for the `nth` add from now on,
 * and then fails with `error`: that row's append throws after it landed.
 */
function failOwnListenerAfterAdd(cm: ContextManager, nth: number, error: unknown): void {
  const own = internals(cm);
  const handle = own.handleMessageStoreEvent.bind(cm);
  let adds = 0;
  own.handleMessageStoreEvent = (event) => {
    handle(event);
    if (event.type === 'add' && ++adds === nth) throw error;
  };
}

/** Removing a body fails, removing nothing. */
function failRemoval(cm: ContextManager): void {
  internals(cm).messageStore.removeBodyGroup = () => {
    throw new Error('removal failed');
  };
}

/**
 * Reading the store's tail, the read that tells whether a row whose append
 * threw landed, throws. Returns what undoes it.
 */
function failTailRead(cm: ContextManager): () => void {
  const messages = internals(cm).messageStore;
  const getTail = messages.getTail.bind(messages);
  messages.getTail = () => { throw new Error('store unreadable'); };
  return () => { messages.getTail = getTail; };
}

/**
 * The next `createStrategyContext` the manager makes throws `error`; the
 * ones after it are made. In legacy mode a sharded add's first is the one
 * that tells the strategy of the stored body, once every shard is stored.
 */
function failContextOnce(cm: ContextManager, error: unknown): void {
  const own = internals(cm);
  const build = own.createStrategyContext.bind(cm);
  let failed = false;
  own.createStrategyContext = () => {
    if (failed) return build();
    failed = true;
    throw error;
  };
}

/** What `fn` threw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw');
}

/** console.error's lines while `fn` runs, kept out of the test's output. */
function errorsDuring<T>(fn: () => T): { result: T; logged: string[] } {
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), logged };
  } finally {
    console.error = error;
  }
}

/** A store whose `failOn`th identity-stamped append from the last reset throws `error`, writing nothing. */
function flakyStore(path: string, error: unknown) {
  const real = JsStore.openOrCreate({ path });
  const state = { failOn: -1, writes: 0 };
  const store = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'appendToStateJsonWithIdentity') {
        return (...args: Parameters<typeof real.appendToStateJsonWithIdentity>) => {
          if (++state.writes === state.failOn) throw error;
          return target.appendToStateJsonWithIdentity(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof real;
  return { real, store, state };
}

describe('WriteLandedError and WriteOutcomeUnknownError: what an add that fails throws', () => {
  it("a message stored as one row stays when its append fails after it landed: the error names it, and its cause is the write's own error", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    cm.addMessage('bob', [text('before')]);
    const heard: string[] = [];
    cm.onMessage((event) => heard.push(event.type));
    // In legacy mode the manager builds the strategy's context inside the append, after the row landed.
    const failure = new Error('zz the manager failed');
    internals(cm).createStrategyContext = () => { throw failure; };
    const err = thrownBy(() => cm.addMessage('alice', [text('one')], undefined, undefined, { holdCompression: true }));
    delete (cm as unknown as { createStrategyContext?: unknown }).createStrategyContext;
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    assert.ok(err instanceof Error);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one'], 'the row stays');
    assert.deepEqual(err.landed, [stored[1]!.id]);
    assert.equal(err.cause, failure);
    assert.equal(err.name, 'WriteLandedError');
    assert.ok(err.message.includes(`message ${stored[1]!.id}`), err.message);
    assert.match(err.message, /zz the manager failed$/, "the message ends with the write's own");
    assert.deepEqual(heard, [], "the manager's own listener ended the event before the host's heard it");
    assert.deepEqual([...cm.getCompressionHolds()], err.landed, 'the hold the add placed stays');
    cm.releaseCompression(err.landed);
    assert.equal(cm.getCompressionHolds().size, 0, 'and is released by the ids named');
    cm.close();
  });

  // CM #350 bot review, wave 5, finding 11: a host listener's throw is
  // caught, but logging it goes through console.error, which a host can
  // make throw too. Then the append throws after the listener moved the
  // store's branch, and the row landed on the branch the add started on.
  it("a message stored as one row whose append throws after a listener moved the store's branch says the manager can't tell, and names no row of the other branch", async () => {
    for (const other of ['a plain row where the row would be', 'no row there'] as const) {
      const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
      cm.addMessage('bob', [text('before')]);
      const store = cm.getStore();
      const start = cm.currentBranch().name;
      const moved = store.createBranchAt('zz-other', start, store.currentSequence()).name;
      if (other === 'a plain row where the row would be') {
        await cm.switchBranch(moved);
        cm.addMessage('carol', [text('on the other branch')]);
        await cm.switchBranch(start);
      }
      const failure = new Error('zz-console-failed');
      cm.onMessage((event) => {
        if (event.type !== 'add') return;
        store.switchBranch(moved);
        throw new Error('zz-listener-failed');
      });
      const consoleError = console.error;
      console.error = () => { throw failure; };
      let err: unknown;
      try {
        err = thrownBy(() => cm.addMessage('alice', [text('one')]));
      } finally {
        console.error = consoleError;
      }
      assert.equal(store.currentBranch().name, moved, `${other}, setup: the listener moved the store`);
      assert.ok(err instanceof WriteOutcomeUnknownError, `${other}: a WriteOutcomeUnknownError, not ${String(err)}`);
      assert.deepEqual(err.landed, [], `${other}: no row of the other branch is named`);
      assert.deepEqual(err.unknown, []);
      assert.equal(err.unnamed, 1, `${other}: the row, whose append returned no id`);
      assert.equal(err.cause, failure);
      await cm.switchBranch(start);
      assert.deepEqual(cm.getAllMessages().map(textOf), ['before', 'one'], `${other}: the row landed where the add started`);
      cm.close();
    }
  });

  it('once a host presents rows, the row named is out of the window until the host presents it', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 1, failure);
    const err = thrownBy(() => cm.addMessage('alice', [text('one')]));
    assert.ok(err instanceof WriteLandedError);
    assert.equal(err.cause, failure);
    const [id] = err.landed;
    assert.equal(cm.getAllMessages().at(-1)?.id, id);
    assert.equal(cm.windowStatusOf(id!), 'out');
    assert.deepEqual(cm.getUnpresentedMessages().map((m) => m.id), [id]);
    cm.presentRows(err.landed);
    assert.equal(cm.windowStatusOf(id!), 'in');
    cm.close();
  });

  it("a sharded write whose own listener fails after its first shard landed removes the shard and throws the write's own error", async () => {
    // The rule the clean-up already kept: a sharded write that fails partway leaves no part of the body.
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 1, failure);
    const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
    assert.equal(err, failure, 'unwrapped: the store holds none of the message');
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before']);
    cm.close();
  });

  it("where the store can't be read to tell whether the failing shard landed, removing the shards before it takes out its row too, and the write's own error is thrown", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    const readable = failTailRead(cm);
    const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
    readable();
    assert.equal(err, failure, 'unwrapped: the store holds none of the message');
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], "the second shard's row, which landed, went with the first's");
    cm.close();
  });

  it('when removing the shards fails too, the error names the first shard, which stayed', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 1, failure);
    failRemoval(cm);
    const { result: err, logged } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one '], 'the first shard stays');
    assert.deepEqual(err.landed, [stored[1]!.id]);
    assert.equal(err.cause, failure);
    assert.match(err.message, /propagation failed$/);
    assert.ok(logged.some((l) => l.includes('may be left short') && l.includes(`(first shard ${stored[1]!.id})`)), logged.join('\n'));
    cm.close();
  });

  it('when removing the shards fails too, the error names every shard that stayed, in store order', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    failRemoval(cm);
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.ok(err instanceof WriteLandedError);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two ']);
    assert.deepEqual(err.landed, stored.slice(1).map((m) => m.id), "the second shard's own row too: its append threw after it landed");
    assert.equal(err.cause, failure);
    assert.ok(err.message.includes(`2 rows of the message (${err.landed.join(', ')})`), err.message);
    cm.close();
  });

  it("where a host's listener presented shards that stayed, presenting the rows of landed that read 'out' completes the body", async () => {
    for (const failing of ['own listener', 'store'] as const) {
      const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
      cm.presentRows([]);
      // The host presents each row as it is stored. The manager's own
      // listener failing on the second shard ends that event before the
      // host's hears it; the store refusing the third leaves two presented.
      cm.onMessage((event) => { if (event.type === 'add') cm.presentRows([event.message.id]); });
      const messages = internals(cm).messageStore;
      if (failing === 'own listener') failOwnListenerAfterAdd(cm, 2, new Error('propagation failed'));
      else {
        const append = messages.append.bind(messages);
        messages.append = (...args: Parameters<MessageStore['append']>) => {
          if (args[4]?.shardIndex === 2) throw new Error('disk full');
          return append(...args);
        };
      }
      failRemoval(cm);
      const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
      assert.ok(err instanceof WriteLandedError, `${failing}: a WriteLandedError, not ${String(err)}`);
      const statuses = err.landed.map((id) => cm.windowStatusOf(id));
      assert.deepEqual(statuses, failing === 'own listener' ? ['in', 'out'] : ['in', 'in'], `${failing}, setup: the listener presented what it heard`);
      if (failing === 'store') assert.throws(() => cm.presentRows(err.landed), /in the window already/, 'presenting every row of landed is refused');
      cm.presentRows(err.landed.filter((id) => cm.windowStatusOf(id) === 'out'));
      assert.deepEqual(err.landed.map((id) => cm.windowStatusOf(id)), ['in', 'in'], failing);
      cm.close();
    }
  });

  it("where a host's listener took a shard it presented out again, presenting the first row of landed the window lacks puts the body in whole", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.presentRows([]);
    // The host presents the first shard as it is stored and takes it out
    // again, as an undone turn's, before the second is stored; the store
    // refuses the third.
    cm.onMessage((event) => {
      if (event.type !== 'add' || event.message.shardIndex !== 0) return;
      cm.presentRows([event.message.id]);
      cm.retractRows([event.message.id], { undone: true });
    });
    const messages = internals(cm).messageStore;
    const append = messages.append.bind(messages);
    messages.append = (...args: Parameters<MessageStore['append']>) => {
      if (args[4]?.shardIndex === 2) throw new Error('disk full');
      return append(...args);
    };
    failRemoval(cm);
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    assert.deepEqual(err.landed.map((id) => cm.windowStatusOf(id)), ['undone', 'out'], 'setup: the first shard is out as undone');
    const out = err.landed.filter((id) => cm.windowStatusOf(id) === 'out');
    assert.throws(() => cm.presentRows(out), /is shard 1 of a body stored as shards/, "the rows that read 'out' alone name a later shard without its first");
    cm.presentRows([err.landed.find((id) => cm.windowStatusOf(id) !== 'in')!]);
    assert.deepEqual(err.landed.map((id) => cm.windowStatusOf(id)), ['in', 'in']);
    cm.close();
  });

  it("a shard the store refused isn't named: the error names the shards stored before it", async () => {
    const diskFull = new Error('disk full');
    const { real, store, state } = flakyStore(freshPath(), diskFull);
    const cm = await ContextManager.open({ store, strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    failRemoval(cm);
    state.writes = 0;
    state.failOn = 2; // the second shard's append
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.ok(err instanceof WriteLandedError);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ']);
    assert.deepEqual(err.landed, [stored[1]!.id]);
    assert.equal(err.cause, diskFull);
    cm.close();
    real.close();
  });

  it("a sharded write that fails partway takes a shard a host's listener presented out of the window as it removes it, and the strategy hears it leave", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.presentRows([]);
    cm.presentRows([cm.addMessage('bob', [text('before')])]);
    // The host presents each row as it is stored.
    const shown: MessageId[] = [];
    cm.onMessage((event) => {
      if (event.type !== 'add') return;
      shown.push(event.message.id);
      cm.presentRows([event.message.id]);
    });
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
    assert.equal(err, failure, 'unwrapped: the store holds none of the message');
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before']);
    assert.equal(shown.length, 1, "setup: the listener presented the first shard, and the second's event ended at the manager's own listener");
    assert.deepEqual(strategy.presented.at(-1), shown, 'setup: the strategy heard the first shard enter');
    assert.equal(cm.ordinalOf(shown[0]!), undefined, 'the shard left the window as it was removed');
    assert.deepEqual(strategy.retracted, [{ ids: shown, rows: shown, removed: true }], 'the strategy heard it leave, with the row as it was, removed');
    assert.deepEqual(cm.retractAbsentRows(), [], 'nothing is left for a repair to take out');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 28: the range removal's hold
  // pruning runs before the window's work, which runs all the same.
  it("a rollback removal whose pruning of holds throws still takes a presented shard out of the window, and the strategy hears it leave", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.presentRows([]);
    const shown: MessageId[] = [];
    cm.onMessage((event) => {
      if (event.type !== 'add') return;
      shown.push(event.message.id);
      cm.presentRows([event.message.id]);
    });
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    // Reading a held row throws while the removal runs: the pruning's read.
    const messages = internals(cm).messageStore;
    const get = messages.get.bind(messages);
    const remove = messages.removeBodyGroup.bind(messages);
    let removing = false;
    messages.get = (id) => {
      if (removing) throw new Error('store unreadable');
      return get(id);
    };
    messages.removeBodyGroup = (id) => {
      removing = true;
      try {
        remove(id);
      } finally {
        removing = false;
      }
    };
    const { result: err } = errorsDuring(() =>
      thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')], undefined, undefined, { holdCompression: true })),
    );
    assert.equal(err, failure, 'unwrapped: the store holds none of the message');
    assert.deepEqual(cm.getAllMessages(), []);
    assert.equal(shown.length, 1, 'setup: the listener presented the first shard');
    assert.equal(cm.ordinalOf(shown[0]!), undefined, 'the shard left the window as it was removed');
    assert.deepEqual(strategy.retracted, [{ ids: shown, rows: shown, removed: true }], 'the strategy heard it leave');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 34: the rollback knows the ids it
  // removes, so a failed read of their rows doesn't keep them in the window.
  it("a rollback whose read of the rows it removes throws still takes a presented shard out of the window, told by its id", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.presentRows([]);
    const shown: MessageId[] = [];
    cm.onMessage((event) => {
      if (event.type !== 'add') return;
      shown.push(event.message.id);
      cm.presentRows([event.message.id]);
    });
    // The second shard's append fails after it landed, and from then on
    // reading a row by its id throws: the rollback's read of what it removes.
    const own = internals(cm);
    const handle = own.handleMessageStoreEvent.bind(cm);
    const messages = own.messageStore;
    const get = messages.get.bind(messages);
    let unreadable = false;
    messages.get = (id) => {
      if (unreadable) throw new Error('store unreadable');
      return get(id);
    };
    const failure = new Error('propagation failed');
    let adds = 0;
    own.handleMessageStoreEvent = (event) => {
      handle(event);
      if (event.type === 'add' && ++adds === 2) {
        unreadable = true;
        throw failure;
      }
    };
    const { result: err, logged } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    unreadable = false;
    assert.equal(err, failure, 'unwrapped: the store holds none of the message');
    assert.deepEqual(cm.getAllMessages(), []);
    assert.ok(logged.some((l) => l.includes('reading the rows before removing body group three') && l.includes('store unreadable')), logged.join('\n'));
    assert.equal(shown.length, 1, 'setup: the listener presented the first shard');
    assert.equal(cm.ordinalOf(shown[0]!), undefined, 'the shard left the window as it was removed');
    assert.deepEqual(strategy.retracted, [{ ids: [shown[0]!], rows: [], removed: true }], 'the strategy heard it leave, by its id');
    assert.deepEqual(cm.retractAbsentRows(), [], 'nothing is left for a repair to take out');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  it("a removal that took the shards out and then failed leaves none, so the write's own error is thrown", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    const messages = internals(cm).messageStore;
    const remove = messages.removeBodyGroup.bind(messages);
    messages.removeBodyGroup = (id) => {
      remove(id);
      throw new Error('failed after removing');
    };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.equal(err, failure);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before']);
    cm.close();
  });

  it("where the store can't be read to tell which shards a failed removal left, the error says the manager can't tell, naming every shard the write stored", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    failRemoval(cm);
    const messages = internals(cm).messageStore;
    const sequenceOf = messages.sequenceOf.bind(messages);
    messages.sequenceOf = () => { throw new Error('store unreadable'); };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    messages.sequenceOf = sequenceOf;
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.ok(!(err instanceof WriteLandedError));
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two ']);
    assert.deepEqual(err.landed, [], 'none it knows stayed');
    assert.deepEqual(err.unknown, stored.slice(1).map((m) => m.id), "the second shard's own row too: the store could be read to tell that it landed");
    assert.equal(err.unnamed, 0);
    assert.equal(err.cause, failure);
    assert.ok(err.message.includes(`can't tell whether the store holds 2 rows of the message (${err.unknown.join(', ')}): propagation failed`), err.message);
    // CM #350 bot review, wave 4, finding 12: the shards whose outcome is
    // unknown wait, and are heard where the window holds them.
    assert.deepEqual(strategy.presented, [[stored[0]!.id], err.unknown], 'the strategy hears the shards the legacy window holds, in one call');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  it("a removal that took the shards out and then failed, where the store can't be read to tell, isn't taken to have left them", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    const before = cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    const messages = internals(cm).messageStore;
    const remove = messages.removeBodyGroup.bind(messages);
    const sequenceOf = messages.sequenceOf.bind(messages);
    let written: string[] = [];
    messages.removeBodyGroup = (id) => {
      written = messages.getAll().slice(1).map((m) => m.id);
      remove(id);
      messages.sequenceOf = () => { throw new Error('store unreadable'); };
      throw new Error('failed after removing');
    };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    messages.sequenceOf = sequenceOf;
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], 'the removal took them out');
    assert.deepEqual(err.landed, []);
    assert.deepEqual(err.unknown, written);
    assert.equal(err.unnamed, 0);
    assert.equal(err.unknown.length, 2);
    cm.addMessage('bob', [text('after')]);
    assert.deepEqual(strategy.presented.slice(0, 1), [[before]]);
    assert.ok(!strategy.presented.flat().some((id) => written.includes(id)), 'no shard the removal took out is heard');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 4, finding 9: a hook the rollback's removal
  // runs can move the store's branch before the removal fails.
  it("a rollback whose removal fails after a hold-release hook moved the store's branch says the manager can't tell which shards stayed", async () => {
    let cm!: ContextManager;
    let target: string | null = null;
    let switching: Promise<void> | undefined;
    class SwitchesOnRelease extends Sharding {
      onCompressionHoldsReleased(): void {
        const name = target;
        target = null;
        if (name) switching = cm.switchBranch(name);
      }
    }
    cm = await ContextManager.open({ path: freshPath(), strategy: new SwitchesOnRelease() });
    cm.addMessage('bob', [text('before')]);
    const start = cm.currentBranch().name;
    // A host's listener makes a branch once the first shard is stored, so
    // that branch's record holds it, and the hook moves the store there.
    cm.onMessage((event) => {
      if (event.type === 'add' && event.message.shardIndex === 0) target = cm.getStore().createBranch('zz-first-shard').name;
    });
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    // The removal lands, its event runs the hook, and then it fails.
    const own = internals(cm);
    const handle = own.handleMessageStoreEvent.bind(cm);
    own.handleMessageStoreEvent = (event) => {
      handle(event);
      if (event.type === 'remove' || event.type === 'removeRange') throw new Error('failed after removing');
    };
    const { result: err } = errorsDuring(() =>
      thrownBy(() => cm.addMessage('alice', [text('one '), text('two ')], undefined, undefined, { holdCompression: true })),
    );
    await switching;
    assert.equal(cm.currentBranch().name, 'zz-first-shard', 'setup: the hook moved the store');
    assert.equal(cm.getAllMessages().length, 2, "setup: the other branch's record holds the first shard");
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.deepEqual(err.landed, [], 'none it knows stayed: the other branch says nothing of the one the write was made on');
    assert.equal(err.unknown.length, 2, 'every shard the write stored');
    assert.equal(err.cause, failure);
    await cm.switchBranch(start);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], 'where the write was made, the removal took them out');
    cm.close();
  });

  it("where the store can't be read to tell whether a row landed, the error says the manager can't tell, and the failed read is logged", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('zz the manager failed');
    internals(cm).createStrategyContext = () => { throw failure; };
    const readable = failTailRead(cm);
    const { result: err, logged } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one')])));
    readable();
    delete (cm as unknown as { createStrategyContext?: unknown }).createStrategyContext;
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.ok(err instanceof Error && !(err instanceof WriteLandedError));
    assert.equal(err.name, 'WriteOutcomeUnknownError');
    assert.deepEqual(err.landed, []);
    assert.deepEqual(err.unknown, []);
    assert.equal(err.unnamed, 1, 'the row, whose append returned no id');
    assert.equal(err.cause, failure);
    assert.match(err.message, /^addMessage failed, and the manager can't tell whether the store holds a row of the append that threw: /);
    assert.match(err.message, /zz the manager failed$/, "the message ends with the write's own");
    assert.ok(logged.some((l) => l.includes('reading the store to tell whether its row landed threw, so the row may be stored: store unreadable')), logged.join('\n'));
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before', 'one'], 'it was');
    cm.close();
  });

  it("where the store can't be read to tell whether a sharded write's first shard landed, nothing is removed, the failed read is logged, and the error says the manager can't tell", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 1, failure);
    const readable = failTailRead(cm);
    const { result: err, logged } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two ')])));
    readable();
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.deepEqual(err.landed, []);
    assert.deepEqual(err.unknown, []);
    assert.equal(err.unnamed, 1);
    assert.equal(err.cause, failure);
    assert.ok(
      logged.some((l) => l.includes('failed on its first shard, and reading the store to tell whether that shard landed threw, so it may be stored, leaving body group three short: store unreadable')),
      logged.join('\n'),
    );
    assert.ok(!logged.some((l) => l.includes('removing what it wrote threw')), `no removal was tried: ${logged.join('\n')}`);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before', 'one '], 'it was stored');
    cm.close();
  });

  it("where the failing shard's landing can't be read and removing the shards fails too, the error names the shards that stayed and says the manager can't tell about the failing one", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    failRemoval(cm);
    const readable = failTailRead(cm);
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    readable();
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two '], "the second shard's row is stored too, which the manager couldn't read");
    assert.deepEqual(err.landed, [stored[1]!.id], 'the first shard, which it knows stayed');
    assert.deepEqual(err.unknown, []);
    assert.equal(err.unnamed, 1, 'the second shard, whose append threw');
    assert.equal(err.cause, failure);
    assert.ok(err.message.includes(`a row of the append that threw; it holds message ${stored[1]!.id}: propagation failed`), err.message);
    // CM #350 bot review, wave 4, finding 12: the failing shard, which the
    // manager couldn't name, is heard with the shard it knows stayed.
    assert.deepEqual(strategy.presented.at(-1), stored.slice(1).map((m) => m.id), 'the strategy hears both shards the legacy window holds, in one call');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  it("resetHeadWindow's transition add that fails after storing it rejects with the error naming it, and the head window isn't reset", async () => {
    class Resettable extends PassthroughStrategy {
      resets: string[] = [];
      resetHeadWindow(fromMessageId: string): void { this.resets.push(fromMessageId); }
      async generateTransitionSummary(): Promise<string> { return 'summary'; }
    }
    const strategy = new Resettable();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 1, failure);
    const err = await cm.resetHeadWindow('the transition').then(() => assert.fail('expected a rejection'), (e: unknown) => e);
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    assert.equal(err.cause, failure);
    const last = cm.getAllMessages().at(-1)!;
    assert.match(textOf(last), /^\[Topic Transition\]\n\nthe transition$/);
    assert.deepEqual(err.landed, [last.id]);
    assert.deepEqual(strategy.resets, [], "the head window wasn't reset");
    cm.close();
  });

  it("a write that fails before a row lands throws its own error, unwrapped", async () => {
    const diskFull = new Error('disk full');
    const { real, store, state } = flakyStore(freshPath(), diskFull);
    const cm = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
    cm.addMessage('bob', [text('before')]);
    // A refusal of the message.
    const refused = thrownBy(() => cm.addMessage('alice', [null] as unknown as ContentBlock[]));
    assert.ok(refused instanceof MalformedContentError && !(refused instanceof WriteLandedError));
    assert.match((refused as Error).message, /^Message refused: /);
    // A store that refuses the append.
    state.writes = 0;
    state.failOn = 1;
    assert.equal(thrownBy(() => cm.addMessage('alice', [text('one')])), diskFull);
    // A sharded write whose first shard the store refuses.
    await cm.setStrategy(new Sharding());
    state.writes = 0;
    state.failOn = 1;
    assert.equal(thrownBy(() => cm.addMessage('alice', [text('one '), text('two ')])), diskFull);
    // A chunking that throws.
    const chunking = new Error('chunking failed');
    await cm.setStrategy(Object.assign(new PassthroughStrategy(), { chunkIngressMessage: () => { throw chunking; } }));
    assert.equal(thrownBy(() => cm.addMessage('alice', [text('one')])), chunking);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], 'nothing stored');
    cm.close();
    real.close();
  });
});

// CM #350 bot review findings 27, 28 and 29: a sharded add's shards are one
// body only while they land together, in one slot, under one group id.
describe("a sharded addMessage's shards land together, as one body", () => {
  it('a chunking whose body group id is empty or not a string is refused before any shard is stored', async () => {
    for (const bodyGroupId of ['', 42, undefined]) {
      const chunking = (_participant: string, content: ContentBlock[]) => ({
        bodyGroupId,
        shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })),
      });
      const strategy = Object.assign(new PassthroughStrategy(), { chunkIngressMessage: chunking }) as unknown as PassthroughStrategy;
      const cm = await ContextManager.open({ path: freshPath(), strategy });
      cm.addMessage('bob', [text('before')]);
      const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
      assert.ok(err instanceof Error && !(err instanceof WriteLandedError) && !(err instanceof WriteOutcomeUnknownError), `${JSON.stringify(bodyGroupId)}: ${String(err)}`);
      assert.match(err.message, /^chunkIngressMessage returned bodyGroupId /, String(bodyGroupId));
      assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], `${JSON.stringify(bodyGroupId)}: no shard was stored`);
      cm.close();
    }
  });

  it('in legacy mode the strategy hears the body once every shard is stored, in one call, so a message its hook adds lands after the body', async () => {
    let cm!: ContextManager;
    class Replies extends ShardingHears {
      views: MessageId[][] = [];
      replied = false;
      async onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
        this.views.push(ctx.messageStore.getAll().map((m) => m.id));
        const heard = super.onPresented(rows, ctx);
        // Before its first await, as a hook's synchronous part runs inside the add.
        if (!this.replied) {
          this.replied = true;
          cm.addMessage('bob', [text('reply')]);
        }
        return heard;
      }
    }
    const strategy = new Replies();
    cm = await ContextManager.open({ path: freshPath(), strategy });
    const id = cm.addMessage('alice', [text('one '), text('two '), text('three')]);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['one ', 'two ', 'three', 'reply'], 'the reply follows the body');
    assert.equal(id, stored[0]!.id);
    const shards = stored.slice(0, 3).map((m) => m.id);
    assert.deepEqual(strategy.views[0], shards, 'the call came once every shard was stored');
    assert.deepEqual(strategy.presented, [shards, [stored[3]!.id]], 'one call with every shard, then the reply');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  it('an addMessage while a sharded addMessage stores its shards is refused, saying why, and the body is stored whole', async () => {
    for (const from of ['listener', 'hook'] as const) {
      let cm!: ContextManager;
      let refusal: unknown;
      const nest = () => {
        try {
          cm.addMessage('bob', [text('nested')]);
        } catch (err) {
          refusal = err;
        }
      };
      // The hook is the strategy's, for a shard a host's listener presents as it is stored.
      class NestsOnPresented extends ShardingHears {
        nested = false;
        async onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
          if (!this.nested) {
            this.nested = true;
            nest();
          }
          return super.onPresented(rows, ctx);
        }
      }
      cm = await ContextManager.open({ path: freshPath(), strategy: from === 'hook' ? new NestsOnPresented() : new Sharding() });
      if (from === 'hook') cm.presentRows([]);
      let first = true;
      cm.onMessage((event) => {
        if (event.type !== 'add' || !first) return;
        first = false;
        if (from === 'listener') nest();
        else cm.presentRows([event.message.id]);
      });
      const id = cm.addMessage('alice', [text('one '), text('two '), text('three')]);
      assert.ok(refusal instanceof Error, `${from}: refused`);
      assert.match(refusal.message, /^ContextManager\.addMessage refused: a sharded addMessage is storing its shards/, from);
      assert.match(refusal.message, /split the body/, from);
      assert.deepEqual(cm.getAllMessages().map(textOf), ['one ', 'two ', 'three'], `${from}: nothing landed between the shards`);
      assert.equal(id, cm.getAllMessages()[0]!.id);
      const after = cm.addMessage('bob', [text('after')]);
      assert.equal(cm.getAllMessages().at(-1)!.id, after, `${from}: an add once the call returned is taken`);
      await new Promise((resolve) => setImmediate(resolve));
      cm.close();
    }
  });

  // CM #350 bot review, wave 2, finding 27: a legacy window holds the
  // shards a failed write leaves stored, so the strategy hears them.
  it('in legacy mode the strategy hears the shards a failed write leaves stored, in one call', async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('propagation failed');
    failOwnListenerAfterAdd(cm, 2, failure);
    failRemoval(cm);
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two ']);
    assert.deepEqual(strategy.presented, [[stored[0]!.id], err.landed], 'one call with the shards that stayed, which the window holds');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  it("in legacy mode the shards a write stopped by a branch move leaves stored are heard where the branch the strategy initializes on holds them", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const store = cm.getStore();
    const start = cm.currentBranch().name;
    let switched: Promise<void> | undefined;
    // The listener moves to a branch made after the first shard landed, so
    // its record, the window there, holds that shard.
    cm.onMessage((event) => {
      if (event.type !== 'add' || switched) return;
      switched = cm.switchBranch(store.createBranchAt('zz-after-shard', start, store.currentSequence()).name);
    });
    const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
    await switched;
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before', 'one ']);
    assert.deepEqual(strategy.presented.at(-1), err.landed, 'the shard that stayed, heard once the strategy initialized there');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 2: a removal from a listener would
  // take a shard the write's failure removes, or move the rows it reads back.
  it('a removal while a sharded addMessage stores its shards is refused, saying why, and a write that then fails leaves none of the body', async () => {
    for (const remove of ['removeMessage', 'removeMessages'] as const) {
      const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
      const before = cm.addMessage('bob', [text('before')]);
      const refusals: unknown[] = [];
      let first = true;
      cm.onMessage((event) => {
        if (event.type !== 'add' || !first) return;
        first = false;
        for (const id of [event.message.id, before]) {
          try {
            if (remove === 'removeMessage') cm.removeMessage(id);
            else cm.removeMessages(id, id);
          } catch (err) {
            refusals.push(err);
          }
        }
      });
      const failure = new Error('propagation failed');
      failOwnListenerAfterAdd(cm, 2, failure);
      const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
      assert.equal(refusals.length, 2, `${remove}: both refused`);
      for (const refusal of refusals) {
        assert.ok(refusal instanceof Error, remove);
        assert.match(refusal.message, new RegExp(`^ContextManager\\.${remove} refused: a sharded addMessage is storing its shards`), remove);
      }
      assert.equal(err, failure, `${remove}: unwrapped, the store holds none of the message`);
      assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], `${remove}: no shard stays, and the row before is kept`);
      cm.removeMessage(before);
      assert.deepEqual(cm.getAllMessages(), [], `${remove}: a removal once the call returned is taken`);
      cm.close();
    }
  });

  // CM #350 bot review, wave 4, finding 3: a cut taken while the body's
  // later shards aren't stored yet would hold only the shards stored so far.
  it('a branchAt or branchSequenceOf while a sharded addMessage stores its shards is refused, saying why, and one once it returns holds the whole body', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.presentRows([]);
    const refusals: unknown[] = [];
    let first = true;
    cm.onMessage((event) => {
      if (event.type !== 'add' || !first) return;
      first = false;
      // A host that presents the shard it heard, then asks for a cut at it.
      cm.presentRows([event.message.id]);
      for (const cut of [() => cm.branchAt(event.message.id, 'zz-mid-add'), () => cm.branchSequenceOf(event.message.id)]) {
        try {
          cut();
        } catch (err) {
          refusals.push(err);
        }
      }
    });
    const doc = cm.addMessage('alice', [text('one '), text('two '), text('three')]);
    assert.equal(refusals.length, 2, 'both refused');
    for (const [refusal, operation] of [[refusals[0], 'branchAt'], [refusals[1], 'branchSequenceOf']] as const) {
      assert.ok(refusal instanceof Error, operation);
      assert.match(refusal.message, new RegExp(`^ContextManager\\.${operation} refused: a sharded addMessage is storing its shards`), operation);
      assert.match(refusal.message, /whole body/, operation);
    }
    assert.ok(!cm.listBranches().some((b) => b.name === 'zz-mid-add'), 'no branch was made');
    const shards = cm.getAllMessages().map((m) => m.id);
    assert.equal(shards.length, 3, 'the body is stored whole');
    cm.presentRows([doc]);
    const cut = cm.branchAt(doc, 'zz-after-add');
    await cm.switchBranch(cut);
    assert.deepEqual(cm.getAllMessages().map((m) => m.id), shards, "a cut once the call returned holds the whole body in the new branch's record");
    cm.close();
  });

  // CM #350 bot review, wave 5, finding 2: fork() cuts at the head and moves
  // the store there, and derive() cuts a child at the head, so either would
  // hold only the shards stored so far.
  it('a fork or derive while a sharded addMessage stores its shards is refused, saying why, and the body is stored whole on the branch it started on', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    const start = cm.currentBranch().name;
    const refusals: Array<[string, Promise<unknown>]> = [];
    let first = true;
    cm.onMessage((event) => {
      if (event.type !== 'add' || !first) return;
      first = false;
      refusals.push(['fork', cm.fork('zz-mid-add-fork')]);
      refusals.push(['derive', cm.derive({ branch: 'zz-mid-add-derive', strategy: new PassthroughStrategy() })]);
    });
    const doc = cm.addMessage('alice', [text('one '), text('two '), text('three')]);
    assert.equal(refusals.length, 2, 'setup: both were asked for');
    for (const [operation, refusal] of refusals) {
      await assert.rejects(refusal, (err: Error) => {
        assert.match(err.message, new RegExp(`^ContextManager\\.${operation} refused: a sharded addMessage is storing its shards`), operation);
        assert.match(err.message, /whole body/, operation);
        return true;
      });
    }
    assert.ok(!cm.listBranches().some((b) => b.name.startsWith('zz-mid-add')), 'no branch was made');
    assert.equal(cm.currentBranch().name, start, 'the store stayed on the branch the add started on');
    assert.deepEqual(cm.getAllMessages().map(textOf), ['one ', 'two ', 'three'], 'the body is stored whole');
    assert.equal(cm.getAllMessages()[0]!.id, doc);
    cm.close();
  });

  it("a listener that moves the store's branch between shards stops the write: the error names the shards stored, on the branch it started on", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const store = cm.getStore();
    const start = cm.currentBranch().name;
    const other = store.createBranchAt('zz-other', start, store.currentSequence()).name;
    let switched: Promise<void> | undefined;
    cm.onMessage((event) => {
      if (event.type === 'add' && !switched) switched = cm.switchBranch(other);
    });
    const err = thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]));
    await switched;
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    assert.ok(err.cause instanceof Error);
    assert.match(err.cause.message, new RegExp(`^the store's branch moved from ${start} to ${other} while addMessage stored the shards of body group three, after 1 of 3`));
    assert.match(err.message, /branch moved/);
    assert.equal(cm.currentBranch().name, other);
    assert.deepEqual(cm.getAllMessages().map(textOf), ['before'], 'no shard was written to the other branch');
    await cm.switchBranch(start);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one '], 'the first shard stays where the write started');
    assert.deepEqual(err.landed, [stored[1]!.id]);
    cm.close();
  });

  // CM #350 bot review, wave 3, finding 1: the read of the store's branch
  // in the failure's handling can throw too.
  it("where the store can't say its branch once a shard is stored, the error names the shards stored, and the strategy hears them once it can", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    const before = cm.addMessage('bob', [text('before')]);
    const store = cm.getStore() as unknown as Record<string, unknown>;
    const own = Object.prototype.hasOwnProperty.call(store, 'currentBranch');
    const currentBranch = store.currentBranch as (this: unknown) => unknown;
    let unreadable = false;
    store.currentBranch = function (this: unknown) {
      if (unreadable) throw new Error('zz-branch-unreadable');
      return currentBranch.call(this);
    };
    // A host's listener of the first shard's add runs after the manager's
    // own: from then on the store can't say its branch.
    cm.onMessage((event) => { if (event.type === 'add') unreadable = true; });
    let err: unknown;
    let logged: string[];
    try {
      ({ result: err, logged } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]))));
    } finally {
      if (own) store.currentBranch = currentBranch;
      else delete store.currentBranch;
    }
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one '], 'the first shard stays, and nothing is removed');
    assert.deepEqual(err.landed, [stored[1]!.id], 'no shard after it was appended, so none is unnamed');
    assert.ok(err.cause instanceof Error && err.cause.message === 'zz-branch-unreadable', String(err.cause));
    assert.ok(logged.some((l) => l.includes("reading the store's branch") && l.includes('zz-branch-unreadable')), logged.join('\n'));
    // The shard that stayed is in the legacy window: the strategy hears it,
    // once, by the next notification.
    const after = cm.addMessage('bob', [text('after')]);
    assert.deepEqual(strategy.presented.flat(), [before, stored[1]!.id, after]);
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 3, finding 1: only an error from a shard's own
  // append can leave a row unnamed. One after the last append, once that
  // shard's listener moved the store's branch, names every shard.
  it("a write that fails once every shard is stored, after the last shard's listener moved the store's branch, names every shard", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const store = cm.getStore();
    const start = cm.currentBranch().name;
    let adds = 0;
    let switched: Promise<void> | undefined;
    cm.onMessage((event) => {
      if (event.type !== 'add' || ++adds !== 3) return;
      switched = cm.switchBranch(store.createBranchAt('zz-after-body', start, store.currentSequence()).name);
    });
    // The manager's own work after the loop, which makes the body wait to be
    // heard on the branch the write started on, fails once.
    const failure = new Error('zz-defer-failed');
    const own = cm as unknown as { deferPresented: (...args: unknown[]) => void };
    const defer = own.deferPresented.bind(cm);
    let failed = false;
    own.deferPresented = (...args: unknown[]) => {
      if (failed) return defer(...args);
      failed = true;
      throw failure;
    };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    delete (cm as unknown as { deferPresented?: unknown }).deferPresented;
    await switched;
    assert.ok(failed, 'setup: the write failed after the loop');
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    assert.equal(err.cause, failure);
    assert.equal(cm.currentBranch().name, 'zz-after-body', 'setup: the last shard\'s listener moved the branch');
    await cm.switchBranch(start);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two ', 'three'], 'every shard stays where the write started');
    assert.deepEqual(err.landed, stored.slice(1).map((m) => m.id), 'and is named');
    cm.close();
  });

  // Weft's plant on cabf546: the other arm of a write the branch moved
  // under. A shard's own append throws once that shard's listener moved the
  // store's branch: its row may have landed on the branch the write started
  // on, which the store no longer reads, so it has no id here, and the
  // manager says it can't tell (WriteOutcomeUnknownError, one row unnamed),
  // naming the shards stored before it. Nothing is removed.
  it("a shard's own append that fails after its listener moved the store's branch leaves that row unnamed, and names the shards before it", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
    const store = cm.getStore();
    const start = cm.currentBranch().name;
    const failure = new Error('zz-own-listener-failed');
    const own = internals(cm);
    const handle = own.handleMessageStoreEvent.bind(cm);
    let adds = 0;
    let switched: Promise<void> | undefined;
    own.handleMessageStoreEvent = (event) => {
      handle(event);
      if (event.type !== 'add' || ++adds !== 2) return;
      switched = cm.switchBranch(store.createBranchAt('zz-mid-body', start, store.currentSequence()).name);
      throw failure;
    };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    await switched;
    assert.equal(cm.currentBranch().name, 'zz-mid-body', "setup: the second shard's listener moved the branch");
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.equal(err.cause, failure);
    assert.equal(err.unnamed, 1, 'the second shard, whose append threw, has no id');
    assert.deepEqual(err.unknown, []);
    assert.match(err.message, /can't tell whether the store holds a row of the append that threw; it holds message /);
    await cm.switchBranch(start);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two '], 'the first shard stays where the write started, and the second landed there too; nothing is removed');
    assert.deepEqual(err.landed, [stored[1]!.id], 'only the first shard is named');
    cm.close();
  });

  // Weft's plant on 6a18406: what the strategy hears of that write. The
  // shard whose append threw landed on the branch the write started on, and
  // the legacy window took it in, so every shard the window took in waits
  // to be heard (hearWhatStayed), not only those the write could name: the
  // strategy hears the second shard with the first, once each.
  it("in legacy mode a shard whose own append failed after its listener moved the store's branch, and that landed, is heard with the shards before it, once", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    const before = cm.addMessage('bob', [text('before')]);
    const store = cm.getStore();
    const start = cm.currentBranch().name;
    const failure = new Error('zz-own-listener-failed');
    const own = internals(cm);
    const handle = own.handleMessageStoreEvent.bind(cm);
    let adds = 0;
    let switched: Promise<void> | undefined;
    own.handleMessageStoreEvent = (event) => {
      handle(event);
      if (event.type !== 'add' || ++adds !== 2) return;
      switched = cm.switchBranch(store.createBranchAt('zz-mid-body', start, store.currentSequence()).name);
      throw failure;
    };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    await switched;
    assert.equal(cm.currentBranch().name, 'zz-mid-body', "setup: the second shard's listener moved the branch");
    assert.ok(err instanceof WriteOutcomeUnknownError, `a WriteOutcomeUnknownError, not ${String(err)}`);
    assert.equal(err.unnamed, 1, 'setup: the second shard, whose append threw, has no id');
    await cm.switchBranch(start);
    await new Promise((resolve) => setImmediate(resolve));
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two '], 'setup: the second shard landed where the write started');
    assert.deepEqual(err.landed, [stored[1]!.id], 'setup: only the first shard is named');
    assert.deepEqual(
      strategy.presented.flat(),
      [before, stored[1]!.id, stored[2]!.id],
      'the strategy heard the shard that landed unnamed, and the one before it, once each',
    );
    cm.close();
  });

  // CM #350 bot review, wave 3, finding 21: the rows the strategy is to hear
  // are kept until it has heard them.
  it("in legacy mode the strategy hears the shards that stayed when telling it of the stored body failed in the manager's own work", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('zz-context-failed');
    failContextOnce(cm, failure);
    failRemoval(cm);
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two ', 'three'], 'setup: every shard stayed');
    assert.deepEqual(err.landed, stored.slice(1).map((m) => m.id));
    assert.equal(err.cause, failure);
    assert.deepEqual(strategy.presented, [[stored[0]!.id], err.landed], 'one call with the shards that stayed, which the window holds');
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });

  // CM #350 bot review, wave 3, finding 22: once every shard is stored, no
  // append failed, so no row is unnamed.
  it("a write that fails once every shard is stored names them all, and no row it can't, whatever the store's reads do", async () => {
    const strategy = new ShardingHears();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    cm.addMessage('bob', [text('before')]);
    const failure = new Error('zz-context-failed');
    failContextOnce(cm, failure);
    failRemoval(cm);
    // The read that tells whether a failing append's row landed.
    (cm as unknown as { rowLandedAt: () => never }).rowLandedAt = () => { throw new Error('store unreadable'); };
    const { result: err } = errorsDuring(() => thrownBy(() => cm.addMessage('alice', [text('one '), text('two '), text('three')])));
    delete (cm as unknown as { rowLandedAt?: unknown }).rowLandedAt;
    assert.ok(err instanceof WriteLandedError, `a WriteLandedError, not ${String(err)}`);
    const stored = cm.getAllMessages();
    assert.deepEqual(stored.map(textOf), ['before', 'one ', 'two ', 'three']);
    assert.deepEqual(err.landed, stored.slice(1).map((m) => m.id), 'every shard, which stayed');
    assert.equal(err.cause, failure);
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
  });
});
