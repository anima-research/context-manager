import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore, type JsStateRegistration } from '@animalabs/chronicle';
import {
  AutobiographicalStrategy,
  ContextManager,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
} from '../src/index.js';

const namespace = 'registration-test';
const stateIds = [
  'autobio:summaries',
  'autobio:chunks',
  'kvunified:presentation-receipt',
  'autobio:counter',
  'autobio:mergeQueue',
  'autobio:merge-quarantine',
  'autobio:pins',
  'autobio:calibration',
  'autobio:compression-refusal-quarantine-events',
  'autobio:compression-family-progress',
  'autobio:resolutions',
  'autobio:locks',
].map(id => `${namespace}/${id}`);

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    autoTickOnNewMessage: false,
    speculativeProduction: false,
  });
}

async function withStore(run: (store: JsStore) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'cm-state-registration-'));
  const store = JsStore.openOrCreate({ path: join(directory, 'store') });
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('AutobiographicalStrategy state registration', () => {
  for (const stateId of stateIds) {
    it(`propagates a registration failure for ${stateId}`, async (t) => {
      await withStore(async (store) => {
        const failure = new Error(`IO failure registering ${stateId}`);
        const register = store.registerState.bind(store);
        t.mock.method(store, 'registerState', (registration: JsStateRegistration) => {
          if (registration.id === stateId) throw failure;
          register(registration);
        });
        await assert.rejects(
          ContextManager.open({ store, namespace, strategy: strategy() }),
          (error: unknown) => error === failure,
        );
      });
    });
  }

  for (const failure of [
    null,
    undefined,
    'State already exists: registration-test/autobio:summaries',
    new Error('State already exists: a-different-slot'),
    new Error('IO failure: directory already exists'),
    new Error('State already exists: registration-test/autobio:summaries; header corrupt'),
  ]) {
    it(`does not treat ${String(failure)} as a duplicate for this slot`, async (t) => {
      await withStore(async (store) => {
        const register = store.registerState.bind(store);
        t.mock.method(store, 'registerState', (registration: JsStateRegistration) => {
          if (registration.id === stateIds[0]) throw failure;
          register(registration);
        });
        await assert.rejects(
          ContextManager.open({ store, namespace, strategy: strategy() }),
          (error: unknown) => error === failure,
        );
      });
    });
  }

  it('accepts native duplicate registrations and preserves state through reinitialization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-state-registration-'));
    const path = join(directory, 'store');
    try {
      const store = JsStore.openOrCreate({ path });
      const manager = await ContextManager.open({ store, namespace, strategy: strategy() });
      const counterId = `${namespace}/autobio:counter`;
      store.setStateJson(counterId, 37);
      const main = store.currentBranch().name;
      const branch = await manager.fork('registration-fork');
      await manager.switchBranch(branch);
      assert.equal(store.getStateJson(counterId), 37);
      await manager.switchBranch(main);
      assert.equal(store.getStateJson(counterId), 37);
      await manager.close();
      store.close();
      // A fresh handle over the existing store: the path every resident takes at each start.
      const fresh = JsStore.openOrCreate({ path });
      try {
        const reopened = await ContextManager.open({ store: fresh, namespace, strategy: strategy() });
        assert.equal(fresh.getStateJson(counterId), 37);
        await reopened.close();
      } finally {
        fresh.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens a store whose slots were registered with another strategy kind or cadence', async () => {
    await withStore(async (store) => {
      // Chronicle answers a duplicate registration by id alone, so these stand
      // as they are: an append-log slot at another cadence, and a slot the
      // strategy registers as a snapshot, registered as an append log.
      store.registerState({ id: `${namespace}/autobio:summaries`, strategy: 'append_log', deltaSnapshotEvery: 5, fullSnapshotEvery: 2 });
      store.registerState({ id: `${namespace}/kvunified:presentation-receipt`, strategy: 'append_log' });
      const manager = await ContextManager.open({ store, namespace, strategy: strategy() });
      await manager.close();
    });
  });
});

describe('state registration outside the autobiographical strategy', () => {
  const sites = [
    { name: 'the message slot', id: 'messages', strategy: () => new PassthroughStrategy() },
    { name: 'the context log', id: `${namespace}/context`, strategy: () => new PassthroughStrategy() },
    { name: 'an auxiliary view', id: 'other-writer/messages', strategy: () => new PassthroughStrategy() },
    { name: "the windowed strategy's anchor", id: `${namespace}/windowed:anchor`, strategy: () => new WindowedPassthroughStrategy() },
  ];
  const open = (store: JsStore, site: (typeof sites)[number]) => ContextManager.open({
    store,
    namespace,
    strategy: site.strategy(),
    auxiliaryMessageViews: [{ namespace: 'other-writer' }],
  });

  for (const site of sites) {
    it(`propagates a registration failure for ${site.name}`, async (t) => {
      await withStore(async (store) => {
        const failure = new Error(`IO failure registering ${site.id}`);
        const register = store.registerState.bind(store);
        t.mock.method(store, 'registerState', (registration: JsStateRegistration) => {
          if (registration.id === site.id) throw failure;
          register(registration);
        });
        await assert.rejects(open(store, site), (error: unknown) => error === failure);
      });
    });

    it(`keeps ${site.name} when it already exists`, async () => {
      await withStore(async (store) => {
        await (await open(store, site)).close();
        await (await open(store, site)).close();
      });
    });
  }

  it('releases a store it opened when a registration fails', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-state-registration-'));
    const path = join(directory, 'store');
    try {
      const failure = new Error('IO failure registering messages');
      const register = JsStore.prototype.registerState;
      const mocked = t.mock.method(JsStore.prototype, 'registerState', function (this: JsStore, registration: JsStateRegistration) {
        if (registration.id === 'messages') throw failure;
        return register.call(this, registration);
      });
      await assert.rejects(
        ContextManager.open({ path, strategy: new PassthroughStrategy() }),
        (error: unknown) => error === failure,
      );
      mocked.mock.restore();
      // The failed open released its lock, so the store opens again.
      const manager = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      await manager.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
