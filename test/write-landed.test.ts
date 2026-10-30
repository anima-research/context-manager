/**
 * What a failed addMessage throws tells a host which of three things
 * happened (agent-framework #844, design question 5):
 * - WriteLandedError: the store holds the rows of the message it names, and
 *   no others, with the write's own error as its cause.
 * - WriteOutcomeUnknownError: the manager can't tell whether the store holds
 *   some row of the message, because the read that would tell threw. It
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
import type { MessageStore, StoredMessage } from '../src/index.js';

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
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
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
    cm.close();
  });

  it("a removal that took the shards out and then failed, where the store can't be read to tell, isn't taken to have left them", async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
    cm.addMessage('bob', [text('before')]);
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
    const cm = await ContextManager.open({ path: freshPath(), strategy: new Sharding() });
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
