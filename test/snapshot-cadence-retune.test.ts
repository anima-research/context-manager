/**
 * Snapshot-cadence retune on existing stores (2026-08-01).
 *
 * Chronicle persists state registrations in state.bin, so the cadence
 * numbers in MessageStore.register only ever applied to NEW stores —
 * existing stores stayed pinned to their first-registration values
 * forever (Mythos: full_snapshot_every=10 -> a full copy of the entire
 * message history every ~500 appends; 57% of the last GB of its log).
 *
 * Contract pinned here:
 *   - ContextManager.open on a store whose messages state was registered
 *     with the OLD cadence retunes it to the current delta cadence via
 *     chronicle's updateStateStrategy (0.3.0+).
 *   - The retune only touches scheduling: message content is unaffected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/message-store.js';
import { ContextManager } from '../src/context-manager.js';

function tmpStore(): { dir: string; store: JsStore } {
  // openOrCreate treats an existing directory as "open" (and then requires
  // a MANIFEST) — hand it a not-yet-existing subpath so it takes the
  // create branch.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-retune-')), 'store');
  const store = JsStore.openOrCreate({ path: dir });
  return { dir, store };
}

describe('snapshot cadence retune', () => {
  it('an open retunes a message slot registered under another cadence to the current delta cadence', async () => {
    const { store } = tmpStore();
    const current = MessageStore.registrationFor();
    const delta = current.deltaSnapshotEvery;
    store.registerState({ id: current.id, strategy: 'append_log', deltaSnapshotEvery: 10, fullSnapshotEvery: 10 });
    assert.strictEqual(typeof (store as unknown as { updateStateStrategy?: unknown }).updateStateStrategy, 'function', 'premise: this chronicle can retune a registration');
    const opsSinceSnapshot = () => store.listStates().find((state) => state.id === current.id)?.opsSinceSnapshot;
    const manager = await ContextManager.open({ store });
    for (let i = 0; i < delta - 1; i++) manager.addMessage('test', [{ type: 'text', text: `m${i}` }]);
    assert.strictEqual(opsSinceSnapshot(), delta - 1, `no snapshot before ${delta} appends`);
    manager.addMessage('test', [{ type: 'text', text: `m${delta - 1}` }]);
    assert.strictEqual(opsSinceSnapshot(), 0, `a snapshot at ${delta} appends`);
    manager.close();
    assert.strictEqual((store.getStateJson(current.id) as unknown as unknown[]).length, delta, 'every message is kept');
    store.close();
  });

  it('register refuses a second registration of the message state', () => {
    const { store } = tmpStore();
    MessageStore.register(store);
    assert.throws(() => MessageStore.register(store));
  });
});
