/**
 * Following a branch move made elsewhere: setStrategy(getStrategy())
 * (agent-framework #291 and #353, CM-3).
 *
 * Every manager on a store follows its branch, but only the manager that
 * moved it, through switchBranch() or fork(), initializes its strategy
 * again. A host that moves the store itself, or through one of several
 * managers, leaves every other manager's strategy at the old branch
 * generation: AutobiographicalStrategy then refuses each compile ("requires
 * reinitialization for the current branch generation"). switchBranch() on
 * each of the others doesn't repair it, since each switch starts a
 * generation of its own and leaves the managers before it stale again.
 *
 * - setStrategy(getStrategy()) detaches nothing and initializes the strategy
 *   on the branch the store is on, at the generation it observes there, so
 *   every manager on the store can make the call after one move, in turn or
 *   at once, and all of them compile. It is the one call for this: the
 *   manager has no reinitializeOnStoreBranch().
 * - It writes nothing, and the window index follows the store on its own:
 *   on a branch made before the write-down the manager reads 'legacy', and
 *   presentRows([]) writes that branch down.
 * - Its recovery contract is setStrategy()'s: a superseded call rejects
 *   with InitializationSupersededError naming no branch, a failed one keeps
 *   the manager fenced until a call succeeds, and a store moved again while
 *   it initialized rejects it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, InitializationSupersededError, PassthroughStrategy } from '../src/index.js';
import type { ContextStrategy } from '../src/types/index.js';

const text = (s: string) => [{ type: 'text' as const, text: s }];
const BUDGET = { maxTokens: 100_000, reserveForResponse: 0 };
const stale = /requires reinitialization for the current branch generation/;
const fenced = /requires successful strategy initialization/;

const memory = () => new AutobiographicalStrategy({ autoTickOnNewMessage: false });

/** The call a host makes on a manager whose store something else moved. */
const follow = (manager: ContextManager) => manager.setStrategy(manager.getStrategy());

/** Two managers on one store, each with its own namespace and strategy, sharing the message slot. */
async function pair(
  run: (a: ContextManager, b: ContextManager, store: JsStore) => Promise<void>,
  strategies: () => [ContextStrategy, ContextStrategy] = () => [memory(), memory()],
) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-follow-store-branch-'));
  const store = JsStore.openOrCreate({ path: join(directory, 'store') });
  const [first, second] = strategies();
  const a = await ContextManager.open({ store, namespace: 'zz-a', strategy: first });
  const b = await ContextManager.open({ store, namespace: 'zz-b', strategy: second });
  try {
    await run(a, b, store);
  } finally {
    a.close();
    b.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The texts a compile sends, in order. */
async function compiled(manager: ContextManager): Promise<string[]> {
  const { messages } = await manager.compile(BUDGET);
  return messages.map((m) => m.content.map((block) => (block as { text?: string }).text ?? '').join(''));
}

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Passthrough whose next initialize() waits on, or fails with, what the test sets; counts its detaches. */
class GatedStrategy extends PassthroughStrategy {
  nextInitialization: Promise<void> = Promise.resolve();
  detached = 0;
  initialize(): Promise<void> { return this.nextInitialization; }
  detach(): void { this.detached++; }
}

describe('setStrategy(getStrategy()) follows a branch move made elsewhere', () => {
  it('is the one call: the manager has no reinitializeOnStoreBranch()', () => {
    assert.equal(
      (ContextManager.prototype as unknown as Record<string, unknown>).reinitializeOnStoreBranch,
      undefined,
    );
  });

  it('after a direct store switch, both managers compile again, and nothing is written', async () => {
    await pair(async (a, b, store) => {
      a.addMessage('user', text('one'));
      a.addMessage('assistant', text('two'));
      a.presentRows([]);
      b.presentRows([]);
      const main = store.currentBranch().name;
      store.createBranchAt('side', main, store.currentSequence());

      // The host moves the store itself: neither manager hears of it.
      store.switchBranch('side');
      await assert.rejects(a.compile(BUDGET), stale, 'setup: a stale strategy refuses');
      await assert.rejects(b.compile(BUDGET), stale, 'setup: a stale strategy refuses');

      const sequence = store.currentSequence();
      const messages = a.getAllMessages().map((m) => m.id);
      const lengths = [a.indexLength(), b.indexLength()];
      await follow(a);
      await follow(b);

      assert.equal(a.currentBranch().name, 'side', 'it selects no branch');
      assert.deepEqual(await compiled(a), ['one', 'two']);
      assert.deepEqual(await compiled(b), ['one', 'two']);
      assert.equal(store.currentSequence(), sequence, 'nothing is written to the record');
      assert.deepEqual(a.getAllMessages().map((m) => m.id), messages);
      assert.deepEqual([a.indexLength(), b.indexLength()], lengths, 'neither window is written');
      assert.deepEqual([a.windowMode(), b.windowMode()], ['presented', 'presented']);
    });
  });

  it('detaches nothing: the strategy the manager holds is initialized again', async () => {
    await pair(async (a, _b, store) => {
      const strategy = a.getStrategy() as GatedStrategy;
      a.addMessage('user', text('one'));
      store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
      store.switchBranch('side');
      await follow(a);
      assert.equal(strategy.detached, 0);
      assert.equal(a.getStrategy(), strategy);
      assert.deepEqual(await compiled(a), ['one']);
    }, () => [new GatedStrategy(), new PassthroughStrategy()]);
  });

  it('calls at once on every manager each end valid: no call stales another', async () => {
    await pair(async (a, b, store) => {
      a.addMessage('user', text('one'));
      const main = store.currentBranch().name;
      store.createBranchAt('side', main, store.currentSequence());
      store.switchBranch('side');

      await Promise.all([follow(a), follow(b)]);
      assert.deepEqual(await compiled(a), ['one']);
      assert.deepEqual(await compiled(b), ['one']);

      // A second round on an unmoved store loads each strategy again and
      // stales neither.
      await follow(b);
      assert.deepEqual(await compiled(a), ['one']);
      assert.deepEqual(await compiled(b), ['one']);
    });
  });

  it("follows one manager's switchBranch on the others, where their own switchBranch would stale it", async () => {
    await pair(async (a, b, store) => {
      a.addMessage('user', text('one'));
      const main = store.currentBranch().name;
      store.createBranchAt('side', main, store.currentSequence());
      b.addMessage('user', text('main only'));

      await a.switchBranch('side');
      await assert.rejects(b.compile(BUDGET), stale, "setup: the other manager's strategy is stale");
      await follow(b);
      assert.deepEqual(await compiled(a), ['one']);
      assert.deepEqual(await compiled(b), ['one']);

      // Back, the same way: both valid on main.
      await b.switchBranch(main);
      await follow(a);
      assert.deepEqual(await compiled(a), ['one', 'main only']);
      assert.deepEqual(await compiled(b), ['one', 'main only']);

      // The reason for the call: a switchBranch() to the branch the store is
      // already on starts a generation of its own, which leaves the manager
      // that switched before it stale.
      await a.switchBranch(main);
      await assert.rejects(b.compile(BUDGET), stale);
      await follow(b);
      assert.deepEqual(await compiled(a), ['one', 'main only']);
      assert.deepEqual(await compiled(b), ['one', 'main only']);
    });
  });

  it("follows another manager's fork", async () => {
    await pair(async (a, b) => {
      a.addMessage('user', text('one'));
      const forked = await a.fork('forked');
      await assert.rejects(b.compile(BUDGET), stale, 'setup');
      await follow(b);
      assert.equal(b.currentBranch().name, forked);
      assert.deepEqual(await compiled(b), ['one']);
      assert.deepEqual(await compiled(a), ['one']);
    });
  });

  it("on a branch made before the write-down reads 'legacy', and presentRows([]) writes it down", async () => {
    await pair(async (a, b, store) => {
      a.addMessage('user', text('one'));
      a.addMessage('assistant', text('two'));
      const main = store.currentBranch().name;
      store.createBranchAt('old', main, store.currentSequence());
      a.presentRows([]);
      b.presentRows([]);
      a.addMessage('user', text('stored, not presented'));
      assert.deepEqual([a.windowMode(), b.windowMode()], ['presented', 'presented'], 'setup');

      store.switchBranch('old');
      await follow(a);
      await follow(b);
      assert.deepEqual([a.windowMode(), b.windowMode()], ['legacy', 'legacy'], 'the index of the branch the store is on');
      assert.deepEqual(await compiled(a), ['one', 'two'], 'a legacy window is the record');

      a.presentRows([]);
      assert.equal(a.windowMode(), 'presented', 'the write-down on the old branch');
      assert.equal(b.windowMode(), 'legacy', "each manager's index is its own");
      assert.deepEqual(a.getPresentedMessages().map((m) => m.content), [text('one'), text('two')]);
      assert.deepEqual(await compiled(a), ['one', 'two']);
      assert.deepEqual(await compiled(b), ['one', 'two']);

      // Back on main, the index there is as it was.
      store.switchBranch(main);
      await Promise.all([follow(a), follow(b)]);
      assert.deepEqual([a.windowMode(), b.windowMode()], ['presented', 'presented']);
      assert.deepEqual(await compiled(a), ['one', 'two'], 'the row stored after the write-down is still out');
    });
  });

  it('a superseded call rejects with InitializationSupersededError naming no branch', async () => {
    await pair(async (a, _b, store) => {
      const strategy = a.getStrategy() as GatedStrategy;
      a.addMessage('user', text('one'));
      store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
      store.switchBranch('side');
      const pending = gate();
      strategy.nextInitialization = pending.promise;
      const following = follow(a);
      const replacement = a.setStrategy(new PassthroughStrategy());
      pending.resolve();
      await assert.rejects(following, (error: unknown) => {
        assert.ok(error instanceof InitializationSupersededError);
        assert.equal(error.branch, undefined);
        assert.equal(error.created, false);
        assert.equal(error.message, 'Strategy initialization was superseded by a newer initialization');
        return true;
      });
      await replacement;
      assert.equal(a.currentBranch().name, 'side');
      assert.deepEqual(await compiled(a), ['one']);
    }, () => [new GatedStrategy(), new PassthroughStrategy()]);
  });

  it('a failed call keeps the manager fenced until a later one succeeds', async () => {
    await pair(async (a, _b, store) => {
      const strategy = a.getStrategy() as GatedStrategy;
      a.addMessage('user', text('one'));
      store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
      store.switchBranch('side');
      strategy.nextInitialization = Promise.reject(new Error('zz-initialize-failed'));
      await assert.rejects(follow(a), /zz-initialize-failed/);
      assert.throws(() => a.addMessage('user', text('refused')), fenced);
      await assert.rejects(a.compile(BUDGET), fenced);

      strategy.nextInitialization = Promise.resolve();
      await follow(a);
      a.addMessage('user', text('two'));
      assert.deepEqual(await compiled(a), ['one', 'two']);
    }, () => [new GatedStrategy(), new PassthroughStrategy()]);
  });

  it('a store moved again while it initialized rejects it, and a later call follows the move', async () => {
    await pair(async (a, _b, store) => {
      const strategy = a.getStrategy() as GatedStrategy;
      a.addMessage('user', text('one'));
      const main = store.currentBranch().name;
      store.createBranchAt('side', main, store.currentSequence());
      store.switchBranch('side');
      const pending = gate();
      strategy.nextInitialization = pending.promise;
      const following = follow(a);
      store.switchBranch(main);
      pending.resolve();
      await assert.rejects(following, /Branch changed during strategy initialization: requested side/);
      assert.throws(() => a.addMessage('user', text('refused')), fenced);

      strategy.nextInitialization = Promise.resolve();
      await follow(a);
      assert.equal(a.currentBranch().name, main);
      assert.deepEqual(await compiled(a), ['one']);
    }, () => [new GatedStrategy(), new PassthroughStrategy()]);
  });
});
