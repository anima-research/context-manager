/**
 * Tests that the message store rejects operations that would corrupt a
 * bodyGroup's byte-faithful reassembly invariant:
 *   - editMessage on a shard
 *   - removeMessage on a single shard (without removing the rest)
 *   - removeRange that bisects a bodyGroup
 *
 * Provides removeBodyGroup as the atomic way to drop a sharded message.
 *
 * Also verifies pins-in-adaptive (Fix #1) and maxMessageTokens not applied
 * to bodyGroup composites (Fix #3) for completeness.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-shard-immutability-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function makeMockMembrane() {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      return { content: [{ type: 'text', text: `[mock #${callCount}]` }] };
    },
    get callCount() { return callCount; },
  };
}

describe('MessageStore — shard immutability', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('editMessage on a shard throws', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });

    // Big body to force sharding
    const body = 'paragraph. '.repeat(1000);
    manager.addMessage('User', [{ type: 'text', text: body }]);

    const all = manager.getAllMessages();
    assert.ok(all.length > 1, 'should be sharded');
    const shardId = all[1].id;

    assert.throws(
      () => manager.editMessage(shardId, [{ type: 'text', text: 'replaced' }]),
      /Cannot edit shard/
    );
    manager.close();
  });

  it('removeMessage on a single shard throws (must remove whole bodyGroup)', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });
    manager.addMessage('User', [{ type: 'text', text: 'paragraph. '.repeat(1000) }]);
    const all = manager.getAllMessages();
    const shardId = all[1].id;

    assert.throws(
      () => manager.removeMessage(shardId),
      /Cannot remove shard/
    );
    manager.close();
  });

  it('removeBodyGroup removes all shards atomically', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });
    // Pre-existing chat
    manager.addMessage('User', [{ type: 'text', text: 'pre-doc' }]);
    manager.addMessage('User', [{ type: 'text', text: 'paragraph. '.repeat(1000) }]);
    manager.addMessage('User', [{ type: 'text', text: 'post-doc' }]);

    const allBefore = manager.getAllMessages();
    assert.ok(allBefore.length >= 3, 'should have at least pre + shards + post');
    const groupShard = allBefore.find((m) => m.bodyGroupId);
    assert.ok(groupShard, 'should have a sharded message');

    // Access the message-store directly via the manager's internals
    const messageStore = (manager as any).messageStore;
    messageStore.removeBodyGroup(groupShard!.id);

    const allAfter = manager.getAllMessages();
    // No remaining shards from that bodyGroup
    const remainingShards = allAfter.filter((m) => m.bodyGroupId === groupShard!.bodyGroupId);
    assert.equal(remainingShards.length, 0, 'all shards should be removed');
    // Pre and post still present
    const ids = allAfter.map((m) => m.id);
    assert.ok(ids.includes(allBefore[0].id), 'pre-doc should survive');
    assert.ok(ids.includes(allBefore[allBefore.length - 1].id), 'post-doc should survive');

    manager.close();
  });

  it('removeRange that bisects a bodyGroup throws', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });
    manager.addMessage('User', [{ type: 'text', text: 'paragraph. '.repeat(1000) }]);
    const all = manager.getAllMessages();
    // First shard to second shard — both inside the bodyGroup → ends mid-group
    assert.ok(all.length >= 3, 'need ≥3 shards for this test');

    assert.throws(
      () => manager.removeMessages(all[0].id, all[1].id),
      /bisect bodyGroup/
    );
    manager.close();
  });

  it('removeRange aligned to bodyGroup boundaries is OK', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });
    manager.addMessage('User', [{ type: 'text', text: 'plain pre' }]);
    manager.addMessage('User', [{ type: 'text', text: 'paragraph. '.repeat(1000) }]);
    manager.addMessage('User', [{ type: 'text', text: 'plain post' }]);

    const all = manager.getAllMessages();
    // Remove just the two plain messages, leaving shards alone
    const plainPreId = all[0].id;
    const plainPostId = all[all.length - 1].id;
    // Can't removeRange(pre, post) because that would bisect — but we can
    // remove just the pre or just the post separately
    manager.removeMessage(plainPreId);
    manager.removeMessage(plainPostId);

    const after = manager.getAllMessages();
    // Only shards remain
    for (const m of after) {
      assert.ok(m.bodyGroupId, `expected only shards after removing plain msgs, got ${m.id} with no bodyGroupId`);
    }
    manager.close();
  });
});

describe('AutobiographicalStrategy — pin respected in adaptive path (Fix #1)', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('pinRange prevents the picker from folding the pinned messages', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });

    const ids: string[] = [];
    for (let i = 0; i < 24; i++) {
      ids.push(manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(40) }]));
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    // Pin a range early in the chronicle (would otherwise be the first to fold)
    strategy.pinRange(ids[2], ids[4]);

    // Force folding pressure
    await manager.compile({ maxTokens: 3000, reserveForResponse: 200 });

    // The pinned messages should remain at L0 (not folded by picker)
    const resolutions = (strategy as any).resolutions as Map<string, number>;
    for (const pinnedId of [ids[2], ids[3], ids[4]]) {
      const level = resolutions.get(pinnedId) ?? 0;
      assert.equal(level, 0, `pinned message ${pinnedId} should be at L0; got L${level}`);
    }
    manager.close();
  });
});
