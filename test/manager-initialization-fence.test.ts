import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore, type JsStateRegistration } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy } from '../src/index.js';
import type { ContextStrategy } from '../src/types/index.js';

const text = (s: string) => [{ type: 'text' as const, text: s }];
const fenced = /requires successful strategy initialization/;

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class GatedStrategy extends PassthroughStrategy {
  nextInitialization: Promise<void> = Promise.resolve();
  ingressCalls = 0;
  initialize(): Promise<void> { return this.nextInitialization; }
  chunkIngressMessage() { this.ingressCalls++; return null; }
}

async function fixture(strategy: ContextStrategy, run: (manager: ContextManager, store: JsStore) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-initialization-fence-'));
  const store = JsStore.openOrCreate({ path: join(directory, 'store') });
  const manager = await ContextManager.open({ store, strategy });
  try { await run(manager, store); }
  finally { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

async function assertFenced(manager: ContextManager, id: string) {
  const store = manager.getStore();
  const sequence = store.currentSequence();
  const messages = manager.getAllMessages();
  const branches = manager.listBranches().map(branch => branch.name);
  assert.throws(() => manager.addMessage('user', text('wrong branch')), fenced);
  assert.throws(() => manager.editMessage(id, text('wrong edit')), fenced);
  assert.throws(() => manager.removeMessage(id), fenced);
  assert.throws(() => manager.removeMessages(id, id), fenced);
  assert.throws(() => manager.branchAt(id, 'forbidden-history'), fenced);
  await assert.rejects(manager.fork('forbidden-fork'), fenced);
  await assert.rejects(manager.compile(), fenced);
  await assert.rejects(manager.tick(), fenced);
  assert.throws(() => manager.pinRange(id, id), fenced);
  assert.throws(() => manager.markDocument(id), fenced);
  assert.throws(() => manager.unpin('unknown-pin'), fenced);
  assert.throws(() => manager.updateHotContextSettings({}), fenced);
  await assert.rejects(manager.resetHeadWindow('transition'), fenced);
  assert.throws(() => manager.isReady(), fenced);
  assert.throws(() => manager.getPendingWork(), fenced);
  assert.equal(store.currentSequence(), sequence, 'blocked work must not append/edit any state');
  assert.deepEqual(manager.getAllMessages(), messages, 'raw inspection remains available');
  assert.deepEqual(manager.listBranches().map(branch => branch.name), branches, 'blocked forks create nothing');
}

describe('ContextManager initialization fence', () => {
  for (const operation of ['switch', 'fork'] as const) {
    it(`fences failed native registration during ${operation} and recovers explicitly`, async (t) => {
      const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
      await fixture(strategy, async (manager, store) => {
        const id = manager.addMessage('user', text('original'));
        const main = manager.currentBranch().name;
        if (operation === 'switch') store.createBranch('target');
        const failure = new Error('injected Chronicle registration failure');
        const register = store.registerState.bind(store);
        const mocked = t.mock.method(store, 'registerState', (registration: JsStateRegistration) => {
          if (registration.id === 'default/autobio:summaries') throw failure;
          register(registration);
        });
        await assert.rejects(
          operation === 'switch' ? manager.switchBranch('target') : manager.fork('target'),
          error => error === failure,
        );
        assert.equal(manager.currentBranch().name, 'target', 'failed transitions remain observable, not rolled back');
        await assertFenced(manager, id);
        mocked.mock.restore();
        await manager.switchBranch(main);
        manager.addMessage('user', text('recovered'));
        assert.equal(manager.getMessageCount(), 2);
        await manager.switchBranch('target');
        assert.equal(manager.getMessageCount(), 1, 'the failed target received no accidental writes');
      });
    });
  }

  it('fences pending initialization before sharding and recovers after success', async () => {
    const strategy = new GatedStrategy();
    await fixture(strategy, async (manager, store) => {
      const id = manager.addMessage('user', text('original'));
      const beforeIngress = strategy.ingressCalls;
      store.createBranch('target');
      const pending = gate();
      strategy.nextInitialization = pending.promise;
      const switching = manager.switchBranch('target');
      await assertFenced(manager, id);
      assert.equal(strategy.ingressCalls, beforeIngress, 'the ingress hook must not run while fenced');
      pending.resolve();
      await switching;
      manager.addMessage('user', text('after initialization'));
      assert.equal(manager.getMessageCount(), 2);
    });
  });

  it('a failed custom initializer stays fenced until setStrategy succeeds', async () => {
    const strategy = new GatedStrategy();
    await fixture(strategy, async (manager) => {
      const id = manager.addMessage('user', text('original'));
      const failure = new Error('custom initializer rejected');
      const broken = new GatedStrategy();
      broken.nextInitialization = Promise.reject(failure);
      await assert.rejects(manager.setStrategy(broken), error => error === failure);
      await assertFenced(manager, id);
      await manager.setStrategy(new PassthroughStrategy());
      manager.addMessage('user', text('recovered by strategy replacement'));
      assert.equal(manager.getMessageCount(), 2);
    });
  });

  it('an older same-branch initializer cannot open the fence for a newer pending strategy', async () => {
    await fixture(new PassthroughStrategy(), async (manager) => {
      const id = manager.addMessage('user', text('original'));
      const firstGate = gate();
      const first = new GatedStrategy();
      first.nextInitialization = firstGate.promise;
      const firstResult = manager.setStrategy(first);
      const secondGate = gate();
      const second = new GatedStrategy();
      second.nextInitialization = secondGate.promise;
      const secondResult = manager.setStrategy(second);
      firstGate.resolve();
      await assert.rejects(firstResult, /superseded/);
      await assertFenced(manager, id);
      secondGate.resolve();
      await secondResult;
      manager.addMessage('user', text('newer strategy ready'));
      assert.equal(manager.getMessageCount(), 2);
    });
  });

  it('an older failure cannot revoke a newer successful initialization', async () => {
    await fixture(new PassthroughStrategy(), async (manager) => {
      manager.addMessage('user', text('original'));
      const pending = gate();
      const old = new GatedStrategy();
      old.nextInitialization = pending.promise;
      const oldResult = manager.setStrategy(old);
      await manager.setStrategy(new PassthroughStrategy());
      const failure = new Error('old attempt failed');
      pending.reject(failure);
      await assert.rejects(oldResult, error => error === failure);
      manager.addMessage('user', text('newer strategy stays ready'));
      assert.equal(manager.getMessageCount(), 2);
    });
  });

  for (const mode of ['manager', 'direct-store'] as const) {
    it(`a delayed head transition cannot append after a ${mode} branch switch`, async () => {
      const summaryGate = gate();
      // No initialize hook: the manager-owned write still pins its own branch.
      class TransitionStrategy extends PassthroughStrategy {
        resetCalls = 0;
        async generateTransitionSummary(): Promise<string> {
          await summaryGate.promise;
          return 'summary of the old branch';
        }
        resetHeadWindow(): void { this.resetCalls++; }
      }
      const strategy = new TransitionStrategy();
      await fixture(strategy, async (manager, store) => {
        manager.addMessage('user', text('original'));
        store.createBranch('target');
        const transition = manager.resetHeadWindow();
        if (mode === 'manager') await manager.switchBranch('target');
        else store.switchBranch('target');
        const sequence = store.currentSequence();
        summaryGate.resolve();
        await assert.rejects(transition, /Branch or strategy changed during ContextManager.resetHeadWindow/);
        assert.equal(store.currentSequence(), sequence);
        assert.equal(manager.getMessageCount(), 1);
        assert.equal(strategy.resetCalls, 0);
      });
    });
  }

  it('a sibling switch during initialization rejects and keeps the failed manager fenced', async () => {
    const strategy = new GatedStrategy();
    await fixture(strategy, async (manager, store) => {
      const id = manager.addMessage('user', text('original'));
      const sibling = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      try {
        const pending = gate();
        strategy.nextInitialization = pending.promise;
        const initializing = manager.switchBranch('main');
        await sibling.fork('sibling');
        pending.resolve();
        await assert.rejects(initializing, /Branch changed during strategy initialization/);
        assert.equal(manager.currentBranch().name, 'sibling', 'failed initialization must not roll back another manager');
        await assertFenced(manager, id);
        await manager.switchBranch('main');
        manager.addMessage('user', text('main recovered'));
        assert.equal(manager.getMessageCount(), 2);
      } finally { await sibling.close(); }
    });
  });

  it('same-name branch recreation during initialization cannot satisfy its requested identity', async () => {
    const strategy = new GatedStrategy();
    await fixture(strategy, async (manager, store) => {
      const id = manager.addMessage('user', text('original'));
      await manager.fork('reused');
      const pending = gate();
      strategy.nextInitialization = pending.promise;
      const initializing = manager.switchBranch('reused');
      store.switchBranch('main');
      store.deleteBranch('reused');
      store.createBranch('reused');
      store.switchBranch('reused');
      pending.resolve();
      await assert.rejects(initializing, /Branch changed during strategy initialization/);
      await assertFenced(manager, id);
      await manager.switchBranch('reused');
      manager.addMessage('user', text('recreated branch initialized'));
      assert.equal(manager.getMessageCount(), 2);
    });
  });

  // Compression holds stay usable while fenced; a release that lands during an
  // attempt is delivered by the attempt that succeeds, never by one that fails.
  class HoldAwareStrategy extends GatedStrategy {
    releases = 0;
    onCompressionHoldsReleased(): void { this.releases++; }
  }

  it('a hold released while initialization is pending reaches the strategy once that attempt succeeds', async () => {
    const strategy = new HoldAwareStrategy();
    await fixture(strategy, async (manager, store) => {
      const id = manager.addMessage('user', text('held'), undefined, undefined, { holdCompression: true });
      store.createBranch('target');
      const pending = gate();
      strategy.nextInitialization = pending.promise;
      const switching = manager.switchBranch('target');
      manager.releaseCompression([id]);
      assert.equal(strategy.releases, 0, 'not delivered while the attempt is pending');
      pending.resolve();
      await switching;
      assert.equal(strategy.releases, 1, 'delivered once the attempt succeeds');
    });
  });

  it('a failed attempt keeps a release pending until a later attempt succeeds', async () => {
    const strategy = new HoldAwareStrategy();
    await fixture(strategy, async (manager, store) => {
      const main = manager.currentBranch().name;
      const id = manager.addMessage('user', text('held'), undefined, undefined, { holdCompression: true });
      store.createBranch('target');
      const pending = gate();
      strategy.nextInitialization = pending.promise;
      const switching = manager.switchBranch('target');
      manager.releaseCompression([id]);
      const failure = new Error('initializer rejected');
      pending.reject(failure);
      await assert.rejects(switching, error => error === failure);
      assert.equal(strategy.releases, 0, 'a failed attempt does not deliver it');
      strategy.nextInitialization = Promise.resolve();
      await manager.switchBranch(main);
      assert.equal(strategy.releases, 1, 'the next successful attempt delivers it');
    });
  });

  it('a rejected native branch selection leaves the loaded branch usable', async () => {
    await fixture(new PassthroughStrategy(), async (manager) => {
      const current = manager.currentBranch().name;
      await assert.rejects(manager.switchBranch('missing'));
      assert.equal(manager.currentBranch().name, current);
      manager.addMessage('user', text('selection never changed'));
      assert.equal(manager.getMessageCount(), 1);
    });
  });
});
