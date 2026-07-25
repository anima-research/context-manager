/**
 * Regression tests for the message-store materialized-cache rework
 * (2026-07-25).
 *
 * `getAllInternal()` caches the deserialized messages array keyed on the
 * STORE-GLOBAL chronicle sequence. Before this fix, ANY write to any other
 * state slot (summary appends, autobio counters, framework/state, …)
 * bumped the sequence and invalidated the cache — so ingest-time chunk
 * rebuilds (which call getAll() on every new message) paid a full
 * state-slot re-materialization per message. On a 13.5k-message store with
 * inline images that was ~10s of blocked event loop per ingested message:
 * ambient traffic arrived faster than it could be ingested and the agent
 * looked permanently wedged (the mythos incident).
 *
 * The fix: mutators write through the cache (append pushes, edit replaces,
 * remove splices; range/bodyGroup removals invalidate), and when only
 * foreign slots moved the sequence the cache revalidates in O(1) via
 * item-count + last-record identity instead of re-materializing.
 *
 * These tests pin CORRECTNESS of every new cache path. (The perf win is
 * measured, not asserted — timing assertions flake in CI.)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-message-store-cache';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function texts(manager: ContextManager): string[] {
  const { messages } = manager.queryMessages({});
  return messages.map((m) => {
    const b = m.content[0];
    return b && b.type === 'text' ? b.text : `[${b?.type}]`;
  });
}

async function openManager(): Promise<ContextManager> {
  // Autobiographical strategy so background state appends (counters,
  // resolutions, …) interleave with message appends — exactly the foreign
  // sequence bumps the revalidation path exists for.
  const strategy = new AutobiographicalStrategy({ targetChunkTokens: 300 });
  return ContextManager.open({ path: TEST_STORE_PATH, strategy });
}

describe('MessageStore — materialized cache write-through & revalidation', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('append write-through: reads after each append see exactly the appended tail', async () => {
    const manager = await openManager();

    const expected: string[] = [];
    for (let i = 0; i < 10; i++) {
      // Interleave a read between appends so the cache is warm when the
      // next append writes through it (the hot ingest pattern).
      manager.addMessage('user', textBlock(`m${i}`));
      expected.push(`m${i}`);
      assert.deepEqual(texts(manager), expected, `after append ${i}`);
    }
  });

  it('foreign state-slot writes do not corrupt or stale the cache (revalidation path)', async () => {
    const manager = await openManager();
    const store = manager.getStore();

    manager.addMessage('user', textBlock('a'));
    manager.addMessage('user', textBlock('b'));
    assert.deepEqual(texts(manager), ['a', 'b'], 'warm the cache');

    // Bump the store-global sequence with writes the messages slot never
    // sees. Pre-fix this invalidated the cache (correct but quadratic);
    // post-fix the O(1) revalidation must return the SAME content.
    store.setStateJson('test/foreign-slot', { tick: 1 });
    store.setStateJson('test/foreign-slot', { tick: 2 });
    assert.deepEqual(texts(manager), ['a', 'b'], 'unchanged after foreign writes');

    // And a subsequent append still lands correctly on the revalidated cache.
    manager.addMessage('user', textBlock('c'));
    assert.deepEqual(texts(manager), ['a', 'b', 'c'], 'append after revalidation');
  });

  it('edit write-through: edited content is visible without re-materialization', async () => {
    const manager = await openManager();

    const id = manager.addMessage('user', textBlock('original'));
    manager.addMessage('user', textBlock('tail'));
    assert.deepEqual(texts(manager), ['original', 'tail']);

    manager.editMessage(id, textBlock('edited'));
    assert.deepEqual(texts(manager), ['edited', 'tail'], 'edit visible through cache');

    // Edit is also correct when foreign writes intervene before the read.
    manager.getStore().setStateJson('test/foreign-slot', { tick: 3 });
    assert.deepEqual(texts(manager), ['edited', 'tail'], 'edit survives revalidation');
  });

  it('remove write-through: single removal splices correctly at head, middle, and tail', async () => {
    const manager = await openManager();

    const ids: string[] = [];
    for (const t of ['a', 'b', 'c', 'd', 'e']) {
      ids.push(manager.addMessage('user', textBlock(t)));
    }
    assert.deepEqual(texts(manager), ['a', 'b', 'c', 'd', 'e']);

    manager.removeMessage(ids[2]); // middle
    assert.deepEqual(texts(manager), ['a', 'b', 'd', 'e'], 'middle removal');

    manager.removeMessage(ids[0]); // head
    assert.deepEqual(texts(manager), ['b', 'd', 'e'], 'head removal');

    manager.removeMessage(ids[4]); // tail
    assert.deepEqual(texts(manager), ['b', 'd'], 'tail removal');

    // Appends after removals continue from the correct state.
    manager.addMessage('user', textBlock('f'));
    assert.deepEqual(texts(manager), ['b', 'd', 'f'], 'append after removals');
  });

  it('range removal invalidates cleanly', async () => {
    const manager = await openManager();

    const ids: string[] = [];
    for (const t of ['a', 'b', 'c', 'd', 'e']) {
      ids.push(manager.addMessage('user', textBlock(t)));
    }
    assert.deepEqual(texts(manager), ['a', 'b', 'c', 'd', 'e'], 'warm the cache');

    manager.removeMessages(ids[1], ids[3]);
    assert.deepEqual(texts(manager), ['a', 'e'], 'range removed');

    manager.addMessage('user', textBlock('f'));
    assert.deepEqual(texts(manager), ['a', 'e', 'f'], 'append after range removal');
  });

  it('branch operations see the correct per-branch message set', async () => {
    const manager = await openManager();

    manager.addMessage('user', textBlock('a'));
    const forkId = manager.addMessage('user', textBlock('b'));
    manager.addMessage('user', textBlock('c'));
    assert.deepEqual(texts(manager), ['a', 'b', 'c'], 'warm the cache on the main branch');

    manager.branchAt(forkId, 'fork-test');
    // branchAt creates the branch without switching — the warm cache must
    // still serve the current branch unchanged.
    assert.deepEqual(texts(manager), ['a', 'b', 'c'], 'current branch unchanged after branchAt');

    await manager.switchBranch('fork-test');
    // The fork contains messages up to and including the fork point; the
    // cache is keyed by branch name and must not leak the old branch's tail.
    assert.deepEqual(texts(manager), ['a', 'b'], 'fork sees the truncated set');

    manager.addMessage('user', textBlock('d'));
    assert.deepEqual(texts(manager), ['a', 'b', 'd'], 'append on the fork');
  });
});
