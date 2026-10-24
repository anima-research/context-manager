/**
 * A strategy's onNewMessage hook no longer makes addMessage throw after the
 * message is stored (#288).
 *
 * The manager calls a strategy's onNewMessage from its own store listener,
 * inside the append that stored the message. A host-written strategy whose
 * onNewMessage isn't async can throw there synchronously, or return no
 * promise at all. A throw is now logged as a rejection is, naming the
 * message, and a hook that returns no promise is no failure. Either way the
 * message stays stored: addMessage returns its id, every shard of a sharded
 * body is written, and a host's onMessage listener still hears the add. The
 * hook still runs inside the write, after a holdCompression hold is placed
 * and before addMessage returns, and the manager's own work around the call
 * still fails the write.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { inspect } from 'node:util';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, PassthroughStrategy } from '../src/index.js';
import type { StoredMessage, StrategyContext } from '../src/index.js';

const TEST_STORE_PATH = './test-strategy-new-message-throw';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

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

/** What the real console writes to stderr while `fn` runs, as it renders it. */
async function stderrDuring(fn: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return written.join('');
}

/** The logged failures of onNewMessage under `namespace`, as [first line, thrown value]. */
function failures(errors: unknown[][], namespace: string): unknown[][] {
  return errors.filter((args) => String(args[0]).startsWith('Strategy onNewMessage failed for message ') && String(args[0]).endsWith(` ns=${namespace}`));
}

function watchUnhandled() {
  const seen: string[] = [];
  const onError = (err: unknown) => { seen.push(String(err)); };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { seen, restore: () => { process.off('uncaughtException', onError); process.off('unhandledRejection', onError); } };
}

/** One macrotask turn: by then a rejection's handler has run, and an unhandled one would have been reported. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Opens a manager on the test store, runs `fn` with it, and closes it whatever `fn` does. */
async function withManager<T>(strategy: PassthroughStrategy, namespace: string | undefined, fn: (manager: ContextManager) => Promise<T> | T): Promise<T> {
  const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, ...(namespace ? { namespace } : {}) });
  try {
    return await fn(manager);
  } finally {
    manager.close();
  }
}

/** A host strategy whose onNewMessage isn't async and throws synchronously. */
class ThrowsSynchronously extends PassthroughStrategy {
  heard: string[] = [];
  thrown: unknown = new Error('zz onNewMessage threw synchronously');
  onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    this.heard.push(message.id);
    throw this.thrown;
  }
}

/** A host strategy whose onNewMessage isn't async and returns no promise. */
class ReturnsNothing extends PassthroughStrategy {
  heard: string[] = [];
  onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    this.heard.push(message.id);
    return undefined as unknown as Promise<void>;
  }
}

/** ThrowsSynchronously, storing each message as three shards of one body group. */
class ShardsAndThrows extends ThrowsSynchronously {
  constructor(readonly group = 'zz-group') {
    super();
  }
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    const body = content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { bodyGroupId: this.group, shards: [0, 1, 2].map((shardIndex) => ({ content: [text(`${body} part ${shardIndex}`)], shardIndex })) };
  }
}

describe('a strategy onNewMessage that fails without rejecting (#288)', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('a synchronous throw is logged, naming the message, and addMessage returns the id of the message it stored', async () => {
    const strategy = new ThrowsSynchronously();
    const unhandled = watchUnhandled();
    try {
      let id: string | undefined;
      let stored: string[] = [];
      const errors = await errorsDuring(() => withManager(strategy, 'agents/zz-sync', async (manager) => {
        id = manager.addMessage('User', [text('hello')]);
        stored = manager.getAllMessages().map((m) => m.id);
        await settle();
      }));
      assert.ok(id, 'addMessage returned an id');
      assert.deepEqual(stored, [id], 'the store holds the message');
      assert.deepEqual(strategy.heard, [id], 'the strategy heard it once');
      const logged = failures(errors, 'agents/zz-sync');
      assert.equal(logged.length, 1, 'the failure is logged once, naming the namespace');
      assert.equal(String(logged[0]![0]), `Strategy onNewMessage failed for message ${id}: ns=agents/zz-sync`);
      assert.match(String(logged[0]![1]), /zz onNewMessage threw synchronously/);
      assert.deepEqual(unhandled.seen, [], 'nothing escapes as an uncaught error');
    } finally {
      unhandled.restore();
    }
  });

  it('a synchronous throw of a value console cannot format is still logged, and addMessage still returns', async () => {
    // The real console formats an object through its inspect hook, which can
    // throw; the line's '%' must print as itself on that path too.
    const strategy = new ShardsAndThrows('zz-%s');
    strategy.thrown = { [inspect.custom]() { throw new Error('custom inspect failed'); } };
    let id: string | undefined;
    const written = await withManager(strategy, 'agents/zz-unprintable', async (manager) => {
      const out = await stderrDuring(async () => { id = manager.addMessage('User', [text('hello')]); });
      assert.equal(manager.getAllMessages().length, 3, 'the whole body is stored');
      return out;
    });
    assert.ok(id, 'addMessage returned an id');
    assert.ok(
      written.includes(`Strategy onNewMessage failed for message ${id} (body group zz-%s): [object Object] ns=agents/zz-unprintable`),
      `reported: ${written}`,
    );
  });

  it('a rejection with a value console cannot format is still logged, and nothing is left unhandled', async () => {
    class RejectsUnprintable extends PassthroughStrategy {
      async onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
        throw { [inspect.custom]() { throw new Error('custom inspect failed'); } };
      }
    }
    const unhandled = watchUnhandled();
    try {
      let id: string | undefined;
      const written = await withManager(new RejectsUnprintable(), 'agents/zz-rejects-unprintable', (manager) =>
        stderrDuring(async () => {
          id = manager.addMessage('User', [text('hello')]);
          await settle();
        }));
      assert.ok(
        written.includes(`Strategy onNewMessage failed for message ${id}: [object Object] ns=agents/zz-rejects-unprintable`),
        `reported: ${written}`,
      );
      assert.deepEqual(unhandled.seen, []);
    } finally {
      unhandled.restore();
    }
  });

  it("a '%' in a body group a host's strategy chose prints as itself, with the error after it", async () => {
    // A '%' in the line's message would be read as a format directive and take the error's place.
    const strategy = new ShardsAndThrows('zz-%s-%d');
    let id: string | undefined;
    const written = await withManager(strategy, 'agents/zz-percent', async (manager) => {
      manager.onMessage((event) => { if (event.type === 'add' && event.message.shardIndex === 0) throw new Error('zz the listener threw'); });
      return stderrDuring(async () => { id = manager.addMessage('User', [text('hello')]); });
    });
    const lines = written.split('\n');
    const hook = lines.findIndex((l) => l === `Strategy onNewMessage failed for message ${id} (body group zz-%s-%d): ns=agents/zz-percent Error: zz onNewMessage threw synchronously`);
    assert.ok(hook >= 0, `the hook's line: ${written}`);
    const listener = lines.findIndex((l) => l.startsWith(`[context-manager] an onMessage listener threw on a 'add' event for message ${id} (body group zz-%s-%d); the write stands: ns=agents/zz-percent Error: zz the listener threw`));
    assert.ok(listener >= 0, `the listener's line: ${written}`);
  });

  it('an onNewMessage that returns no promise passes, logging nothing', async () => {
    const strategy = new ReturnsNothing();
    const unhandled = watchUnhandled();
    try {
      let id: string | undefined;
      let count = 0;
      const errors = await errorsDuring(() => withManager(strategy, 'agents/zz-void', async (manager) => {
        id = manager.addMessage('User', [text('hello')]);
        count = manager.getAllMessages().length;
        await settle();
      }));
      assert.ok(id, 'addMessage returned an id');
      assert.equal(count, 1);
      assert.deepEqual(strategy.heard, [id]);
      assert.deepEqual(errors, [], 'no promise is no failure, and nothing is logged');
      assert.deepEqual(unhandled.seen, []);
    } finally {
      unhandled.restore();
    }
  });

  it('a sharded add whose every shard the strategy throws on stores the whole body, and returns shard 0', async () => {
    const strategy = new ShardsAndThrows();
    let id: string | undefined;
    let stored: StoredMessage[] = [];
    const errors = await errorsDuring(() => withManager(strategy, 'agents/zz-shards', async (manager) => {
      id = manager.addMessage('User', [text('a long body')]);
      stored = manager.getAllMessages();
      await settle();
    }));
    assert.deepEqual(stored.map((m) => m.shardIndex), [0, 1, 2], 'every shard is stored, in order');
    assert.equal(stored[0]!.id, id, "addMessage returned shard 0's id");
    assert.ok(stored.every((m) => m.bodyGroupId === 'zz-group' && m.shardCount === 3), 'one body of three shards');
    assert.equal(strategy.heard.length, 3, 'the strategy heard each shard');
    const logged = failures(errors, 'agents/zz-shards').map((args) => String(args[0]));
    assert.deepEqual(
      logged,
      stored.map((m) => `Strategy onNewMessage failed for message ${m.id} (body group zz-group): ns=agents/zz-shards`),
      'each shard\'s throw is logged once, naming its message',
    );
  });

  it("a host's onMessage listener still hears the add", async () => {
    const strategy = new ThrowsSynchronously();
    const heard: string[] = [];
    let id: string | undefined;
    const errors = await errorsDuring(() => withManager(strategy, 'agents/zz-listener', (manager) => {
      manager.onMessage((event) => { if (event.type === 'add') heard.push(event.message.id); });
      id = manager.addMessage('User', [text('hello')]);
    }));
    assert.deepEqual(strategy.heard, [id], 'the strategy was called, and threw');
    assert.equal(failures(errors, 'agents/zz-listener').length, 1, 'its throw was logged');
    assert.deepEqual(heard, [id], 'the listener registered after the manager heard the add');
  });

  it('a rejection is still logged, as before, and nothing is left unhandled', async () => {
    class Rejects extends PassthroughStrategy {
      async onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
        throw new Error('zz onNewMessage rejected');
      }
    }
    const unhandled = watchUnhandled();
    try {
      const errors = await errorsDuring(() => withManager(new Rejects(), 'agents/zz-rejects', async (manager) => {
        manager.addMessage('User', [text('hello')]);
        await settle();
      }));
      const logged = failures(errors, 'agents/zz-rejects');
      assert.equal(logged.length, 1);
      assert.match(String(logged[0]![1]), /zz onNewMessage rejected/);
      assert.deepEqual(unhandled.seen, []);
    } finally {
      unhandled.restore();
    }
  });

  it("a thenable that isn't a Promise is read as one: its rejection is logged", async () => {
    class ReturnsThenable extends PassthroughStrategy {
      onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
        const thenable = { then: (_resolve: unknown, reject: (error: unknown) => void) => reject(new Error('zz thenable rejected')) };
        return thenable as unknown as Promise<void>;
      }
    }
    const unhandled = watchUnhandled();
    try {
      const errors = await errorsDuring(() => withManager(new ReturnsThenable(), 'agents/zz-thenable', async (manager) => {
        manager.addMessage('User', [text('hello')]);
        await settle();
      }));
      const logged = failures(errors, 'agents/zz-thenable');
      assert.equal(logged.length, 1, 'the rejection is logged once');
      assert.match(String(logged[0]![1]), /zz thenable rejected/, 'what is logged is the thenable\'s own rejection');
      assert.deepEqual(unhandled.seen, []);
    } finally {
      unhandled.restore();
    }
  });

  it("the strategy's synchronous part runs before addMessage returns, after a holdCompression hold is placed", async () => {
    // Pins the order: deferring the hook would move this past the return, and
    // calling it before the hold would leave it unheld.
    class Records extends PassthroughStrategy {
      saw: Array<{ id: string; held: boolean | undefined }> = [];
      async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
        this.saw.push({ id: message.id, held: ctx.messageStore.isCompressionHeld?.(message.id) });
        await settle();
      }
    }
    const strategy = new Records();
    await withManager(strategy, undefined, async (manager) => {
      const id = manager.addMessage('User', [text('hello')], undefined, undefined, { holdCompression: true });
      assert.deepEqual(strategy.saw, [{ id, held: true }], 'the hook ran inside addMessage, with the message already held');
      await settle();
    });
  });

  it("the manager's own work around the call still fails the write", async () => {
    const strategy = new ThrowsSynchronously();
    await withManager(strategy, 'agents/zz-own', (manager) => {
      // The context the manager builds for the hook is the manager's own work.
      (manager as unknown as { createStrategyContext: () => never }).createStrategyContext = () => {
        throw new Error('zz the manager failed');
      };
      assert.throws(() => manager.addMessage('User', [text('hello')]), /zz the manager failed/);
      assert.deepEqual(strategy.heard, [], 'the strategy was never called');
    });
  });
});
