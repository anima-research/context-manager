/**
 * branch-switch-unsaved: a branch selection that the store makes and then
 * fails to save, and one that leaves the store on another branch.
 *
 * Chronicle selects a branch before it checkpoints the selection. A failed
 * checkpoint leaves the selection in effect. The manager takes that as a
 * switch that is made and not saved: the call rejects, saying so, and the
 * manager refuses work until it is initialized on the branch.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsStore } from '@animalabs/chronicle';

import { ContextManager, InitializationSupersededError, PassthroughStrategy } from '../src/index.js';
import { observeStoreBranch } from '../src/branch-generation.js';

const dir = mkdtempSync(join(tmpdir(), 'branch-switch-unsaved-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const NS = 'agents/Ada';
let stores = 0;

/** Runs `body` while the store's branch file can't be written: a directory stands at its path. */
function withBranchFileBlocked<T>(path: string, body: () => T): T {
  const file = join(path, 'branches.bin');
  renameSync(file, `${file}.held`);
  mkdirSync(file);
  try {
    return body();
  } finally {
    rmdirSync(file);
    renameSync(`${file}.held`, file);
  }
}

describe('a branch selection that the store makes and does not save', () => {
  it('leaves the store on a branch whose switch failed its checkpoint, with the manager refusing work until it is initialized there', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('elsewhere', 'main');
      const native = store.switchBranch.bind(store);
      store.switchBranch = (name: string) => withBranchFileBlocked(path, () => native(name));
      try {
        await assert.rejects(manager.switchBranch('elsewhere'), /Branch selection elsewhere took effect, and then the switch failed, so the selection may not be saved: getStore\(\)\.sync\(\) saves it once the store can write/);
      } finally {
        store.switchBranch = native;
      }
      assert.equal(store.currentBranch().name, 'elsewhere', 'the store is on the branch it selected');
      assert.throws(() => manager.editMessage(id, [{ type: 'text', text: 'an edit' }]), /requires successful strategy initialization/, 'the manager refuses work there');
      const unsynced = join(dir, `copy-${stores++}`);
      cpSync(path, unsynced, { recursive: true });
      const before = JsStore.open({ path: unsynced });
      try {
        assert.equal(before.currentBranch().name, 'main', 'setup: before sync(), the saved selection is the old one');
      } finally {
        before.close();
      }
      store.sync();
      const copy = join(dir, `copy-${stores++}`);
      cpSync(path, copy, { recursive: true });
      const saved = JsStore.open({ path: copy });
      try {
        assert.equal(saved.currentBranch().name, 'elsewhere', 'sync() saved the selection, before any close');
      } finally {
        saved.close();
      }
      await manager.setStrategy(manager.getStrategy());
      assert.equal(manager.currentBranch().name, 'elsewhere');
      manager.editMessage(id, [{ type: 'text', text: 'an edit' }]);
    } finally {
      manager.close();
    }
  });

  it('leaves the store on a branch that fork created and selected, when the selection fails its checkpoint', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      const native = store.switchBranch.bind(store);
      store.switchBranch = (name: string) => withBranchFileBlocked(path, () => native(name));
      try {
        await assert.rejects(manager.fork('forked'), /Branch selection forked \(created\) took effect, and then the switch failed/);
      } finally {
        store.switchBranch = native;
      }
      assert.equal(store.currentBranch().name, 'forked');
      assert.throws(() => manager.editMessage(id, [{ type: 'text', text: 'an edit' }]), /requires successful strategy initialization/);
      store.sync();
      await manager.setStrategy(manager.getStrategy());
      assert.equal(manager.currentBranch().name, 'forked');
    } finally {
      manager.close();
    }
  });

  it('leaves the manager uninitialized where a failed native switch left the store on another branch', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('elsewhere', 'main');
      store.createBranch('asked', 'main');
      const switchBranch = store.switchBranch.bind(store);
      store.switchBranch = (name: string) => {
        if (name === 'asked') {
          switchBranch('elsewhere');
          throw new Error('zz the switch went elsewhere');
        }
        return switchBranch(name);
      };
      try {
        await assert.rejects(manager.switchBranch('asked'), /Branch selection asked failed, and the store is on elsewhere: the manager is uninitialized; setStrategy\(getStrategy\(\)\) initializes it where the store is, and getStore\(\)\.sync\(\) saves the store's selection once the store can write: zz the switch went elsewhere/);
      } finally {
        store.switchBranch = switchBranch;
      }
      assert.equal(store.currentBranch().name, 'elsewhere');
      assert.throws(() => manager.editMessage(id, [{ type: 'text', text: 'an edit' }]), /requires successful strategy initialization/);
      store.switchBranch = (name: string) => {
        switchBranch(name);
        throw undefined;
      };
      try {
        await assert.rejects(manager.switchBranch('asked'), /Branch selection asked took effect, and then the switch failed/, 'a native error of any value');
      } finally {
        store.switchBranch = switchBranch;
      }
    } finally {
      manager.close();
    }
  });

  it('leaves the manager uninitialized where the store can\'t say which branch it is on after a failed switch', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('asked', 'main');
      const switchBranch = store.switchBranch.bind(store);
      const currentBranch = store.currentBranch.bind(store);
      let switched = false;
      store.switchBranch = () => {
        switched = true;
        throw new Error('zz no switch');
      };
      store.currentBranch = () => {
        if (switched) throw new Error('zz no read');
        return currentBranch();
      };
      try {
        await assert.rejects(manager.switchBranch('asked'), /Branch selection asked failed, and the store can't say which branch it is on: the manager is uninitialized/);
      } finally {
        store.switchBranch = switchBranch;
        store.currentBranch = currentBranch;
      }
      assert.throws(() => manager.editMessage(id, [{ type: 'text', text: 'an edit' }]), /requires successful strategy initialization/);
    } finally {
      manager.close();
    }
  });

  it('moves the store\'s branch generation for a switch that took effect and then failed, so a move away and back shows', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('elsewhere', 'main');
      const native = store.switchBranch.bind(store);
      const before = observeStoreBranch(store).generation;
      store.switchBranch = (name: string) => {
        native(name);
        throw new Error('zz the save failed');
      };
      try {
        await assert.rejects(manager.switchBranch('elsewhere'), /took effect, and then the switch failed/);
      } finally {
        store.switchBranch = native;
      }
      native('main');
      assert.ok(observeStoreBranch(store).generation > before, 'back on main, the generation is a new one');
    } finally {
      manager.close();
    }
  });

  it('says where reconciliation found the store, and that a newer selection superseded this one, where a read during the failed switch moves it', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('elsewhere', 'main');
      store.createBranch('third', 'main');
      const native = store.switchBranch.bind(store);
      const currentBranch = store.currentBranch.bind(store);
      let reads = -1;
      let onRead: (read: number) => void = () => {};
      store.switchBranch = (name: string) => {
        const branch = native(name);
        if (name !== 'elsewhere') return branch;
        reads = 0;
        throw new Error('zz the save failed');
      };
      store.currentBranch = () => {
        if (reads >= 0) onRead(++reads);
        return currentBranch();
      };
      try {
        onRead = (read) => {
          if (read === 2) native('third');
        };
        await assert.rejects(manager.switchBranch('elsewhere'), /took effect and then the switch failed, and reconciliation found third: the selection may not be saved/);
        reads = -1;
        await manager.setStrategy(manager.getStrategy());
        let newer: Promise<void> | undefined;
        onRead = (read) => {
          if (read === 1) newer = manager.switchBranch('main');
        };
        await assert.rejects(manager.switchBranch('elsewhere'), (error: unknown) => {
          assert.ok(error instanceof InitializationSupersededError);
          assert.match(error.message, /^ContextManager\.switchBranch to branch "elsewhere" threw, and a newer initialization superseded it: zz the save failed$/);
          assert.equal((error.cause as Error).message, 'zz the save failed');
          return true;
        });
        reads = -1;
        await newer;
        assert.equal(manager.currentBranch().name, 'main', 'the newer selection stands');

        for (const [where, moveTo] of [['after the switch took effect', undefined], ['with the store on a third branch', 'third']] as const) {
          store.switchBranch = (name: string) => {
            const branch = native(name === 'elsewhere' && moveTo ? moveTo : name);
            if (name !== 'elsewhere') return branch;
            reads = 0;
            throw new Error('zz the save failed');
          };
          onRead = (read) => {
            if (read === 2) newer = manager.switchBranch('main');
          };
          await assert.rejects(manager.switchBranch('elsewhere'), (error: unknown) => {
            assert.ok(error instanceof InitializationSupersededError, where);
            assert.equal((error.cause as Error).message, 'zz the save failed', `${where}: the native error is the cause`);
            return true;
          });
          reads = -1;
          await newer;
          assert.equal(manager.currentBranch().name, 'main', `${where}: the newer selection stands`);
          assert.doesNotThrow(() => manager.editMessage(id, [{ type: 'text', text: 'an edit' }]), `${where}: and the manager works there`);
        }
      } finally {
        store.switchBranch = native;
        store.currentBranch = currentBranch;
      }
    } finally {
      manager.close();
    }
  });

  it('keeps the loaded branch usable where the native switch fails and the store stays where it was', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('asked', 'main');
      const switchBranch = store.switchBranch.bind(store);
      store.switchBranch = () => {
        throw new Error('zz no switch');
      };
      try {
        await assert.rejects(manager.switchBranch('asked'), /^Error: zz no switch$/);
      } finally {
        store.switchBranch = switchBranch;
      }
      assert.equal(store.currentBranch().name, 'main');
      manager.editMessage(id, [{ type: 'text', text: 'an edit' }]);
    } finally {
      manager.close();
    }
  });
});
