import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy } from '../src/index.js';

for (const operation of ['presentRows', 'retractRows', 'removeMessage', 'retractRemoved'] as const) {
  it(`${operation} does not requeue its first notification when building the hook context closes the manager`, async (t) => {
    const path = mkdtempSync(join(tmpdir(), 'notification-close-'));
    const store = JsStore.openOrCreate({ path });
    const failure = new Error('closed during strategy context read');
    const sequence = store.currentSequence.bind(store);
    let ready = false;
    let armed = false;
    let failed = false;
    let heard = 0;
    const hook = () => {
      // Arm after the window write, on the notification's hook lookup.
      if (ready) armed = true;
      return async () => { heard++; };
    };
    let manager: ContextManager | undefined;
    let writer: ContextManager | undefined;
    try {
      if (operation === 'retractRemoved') {
        writer = await ContextManager.open({ store, namespace: 'writer', strategy: new PassthroughStrategy() });
      }
      manager = await ContextManager.open({ store, strategy: {
        name: 'closing-notification',
        checkReadiness: () => ({ ready: true }),
        select: () => [],
        get onPresented() { return hook(); },
        get onRetracted() { return hook(); },
      } });
      store.currentSequence = () => {
        if (!armed) return sequence();
        armed = ready = false;
        failed = true;
        manager!.close();
        throw failure;
      };
      manager.presentRows([]);
      const id = (writer ?? manager).addMessage('User', [{ type: 'text', text: 'a row' }]);
      if (operation !== 'presentRows') manager.presentRows([id]);
      writer?.removeMessage(id);
      heard = 0;
      ready = true;
      const log = t.mock.method(console, 'error', (..._args: unknown[]) => {});
      if (operation === 'removeMessage') manager.removeMessage(id);
      else manager[operation]([id]);

      assert.ok(failed, 'the first delivery hit the closing store read');
      assert.equal(heard, 0, 'no hook was delivered');
      assert.equal(store.isClosed(), false, 'the store is host-owned');
      assert.deepEqual(manager.getPresentedMessages().map(row => row.id), operation === 'presentRows' ? [id] : []);
      const queues = manager as unknown as { presentedUnheard: ReadonlyMap<string, boolean>; retractedUnheard: readonly unknown[] };
      assert.equal(queues.presentedUnheard.size + queues.retractedUnheard.length, 0, 'close discards pending ids');
      const diagnostic = log.mock.calls.find(call => call.arguments.includes(failure));
      assert.ok(diagnostic, 'the failed notification is logged');
      assert.doesNotMatch(String(diagnostic.arguments[0]), /next notification/, 'closed managers cannot retry');
    } finally {
      manager?.close();
      writer?.close();
      store.close();
      rmSync(path, { recursive: true, force: true });
    }
  });
}
