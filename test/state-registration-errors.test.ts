import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore, type JsStateRegistration } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

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
    await withStore(async (store) => {
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
      const reopened = await ContextManager.open({ store, namespace, strategy: strategy() });
      assert.equal(store.getStateJson(counterId), 37);
      await reopened.close();
    });
  });
});
