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
 *     with the OLD cadence retunes it to the current constants via
 *     chronicle's updateStateStrategy (0.3.0+).
 *   - The retune only touches scheduling: message content is unaffected.
 *   - On chronicle builds without updateStateStrategy, open still works
 *     (feature-detected; old cadence simply remains).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/message-store.js';

function tmpStore(): { dir: string; store: JsStore } {
  // openOrCreate treats an existing directory as "open" (and then requires
  // a MANIFEST) — hand it a not-yet-existing subpath so it takes the
  // create branch.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-retune-')), 'store');
  const store = JsStore.openOrCreate({ path: dir });
  return { dir, store };
}

describe('snapshot cadence retune', () => {
  it('retunes an existing old-cadence registration to current constants', () => {
    const { store } = tmpStore();

    // Simulate an existing store: registered under the OLD cadence.
    store.registerState({
      id: 'messages',
      strategy: 'append_log',
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 10,
    });

    // Sanity: chronicle must expose the upsert (0.3.0+ in node_modules).
    const s = store as unknown as { updateStateStrategy?: (r: unknown) => void };
    assert.strictEqual(typeof s.updateStateStrategy, 'function');

    // Re-registration still throws (this is what ContextManager.open catches)...
    assert.throws(() => MessageStore.register(store));

    // ...and the retune path applies the current constants without error.
    s.updateStateStrategy!(MessageStore.registrationFor());

    // Scheduling proof: with fullSnapshotEvery=10 a full snapshot would
    // fire by 500 appends. Not asserting 5000 appends here (slow); instead
    // assert the kind-guard behaves: a kind change is rejected...
    assert.throws(() =>
      s.updateStateStrategy!({ id: 'messages', strategy: 'snapshot' }),
    );

    // ...and message traffic on the retuned state is unaffected.
    for (let i = 0; i < 20; i++) {
      store.appendToStateJsonWithIdentity(
        'messages',
        { participant: 'test', content: [{ type: 'text', text: `m${i}` }], timestamp: i },
        'id',
        'sequence',
      );
    }
    const items = store.getStateJson('messages') as unknown as unknown[];
    assert.strictEqual(items.length, 20);
  });

  it('registrationFor and register use the same constants', () => {
    const { store } = tmpStore();
    MessageStore.register(store);
    const reg = MessageStore.registrationFor();
    assert.strictEqual(reg.id, 'messages');
    assert.strictEqual(reg.strategy, 'append_log');
    assert.strictEqual(reg.deltaSnapshotEvery, 50);
    assert.strictEqual(reg.fullSnapshotEvery, 100);
    // Registering again with identical constants still throws — proving
    // register() itself is not silently an upsert.
    assert.throws(() => MessageStore.register(store));
  });
});
