import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, type ContextStrategy } from '../src/index.js';

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

for (const closeAt of ['drain hook', 'retry scope lookup'] as const) {
  it(`close in a retraction ${closeAt} leaves no pending retractions`, async (t) => {
    const path = mkdtempSync(join(tmpdir(), 'retraction-drain-close-'));
    const store = JsStore.openOrCreate({ path });
    const manager = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
    t.after(() => { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); });
    const ids = ['one', 'two'].map(text => manager.addMessage('User', [{ type: 'text', text }]));
    manager.presentRows(ids);
    let finish!: () => void;
    const initializing = new Promise<void>((resolve) => { finish = resolve; });
    const heard: string[] = [];
    const strategy: ContextStrategy = {
      name: 'close-during-retraction',
      select: () => [],
      checkReadiness: () => ({ ready: true }),
      initialize: () => initializing,
      async onRetracted(rows) {
        heard.push(...rows.map(row => row.id));
        manager.close();
      },
    };
    const setting = manager.setStrategy(strategy);
    try {
      manager.retractRows([ids[0]!]);
      assert.equal(manager.stats().pendingStrategyNotifications.retracted, 1);
      if (closeAt === 'retry scope lookup') {
        t.mock.method(manager as unknown as { hookScope(): unknown }, 'hookScope', () => {
          manager.close();
          throw new Error('closed during retry scope lookup');
        });
      }
      manager.retractRows([ids[1]!]);
      if (closeAt === 'drain hook') {
        assert.equal(manager.stats().pendingStrategyNotifications.retracted, 2);
      } else {
        assert.equal(manager.isClosed(), true);
      }
    } finally {
      finish();
      if (closeAt === 'retry scope lookup') await assert.rejects(setting, /closed/i);
      else await setting;
    }
    assert.equal(manager.isClosed(), true);
    assert.deepEqual(heard, closeAt === 'drain hook' ? [ids[0]] : []);
    assert.equal(manager.stats().pendingStrategyNotifications.retracted, 0);
  });
}
