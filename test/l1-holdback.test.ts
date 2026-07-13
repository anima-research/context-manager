/**
 * L1 production holdback (`l1HoldbackChunks`, default 1).
 *
 * Speculative L1 production is supply-driven: a chunk is queued for
 * compression the moment it closes, and the background drain produces its
 * summary ahead of any fold demand. The holdback keeps the newest N closed
 * chunks OUT of that speculative queue — the chunk at the live edge is the
 * one most likely to still be in motion — releasing each automatically once
 * a newer chunk closes behind it (the queue is rebuilt on every message).
 *
 * Demand overrides: a picker `produce` op (enqueueL1ForRange) marks the
 * chunk demanded, and demanded chunks are never held back.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { Chunk } from '../src/strategies/autobiographical.js';

const TEST_STORE_PATH = './test-l1-holdback';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class InspectableStrategy extends AutobiographicalStrategy {
  queuedChunkIndices(): number[] {
    return [...(this as any).compressionQueue] as number[];
  }
  closedChunks(): Chunk[] {
    return (this as any).chunks as Chunk[];
  }
  demandRange(firstId: string, lastId: string): void {
    (this as any).enqueueL1ForRange(firstId, lastId);
  }
}

/** Feed enough small messages to close `n` chunks (targetChunkTokens=20,
 *  recentWindowTokens=5 keeps only the newest message out of the
 *  compressible region). */
async function closeChunks(manager: ContextManager, strategy: InspectableStrategy, n: number): Promise<void> {
  let guard = 0;
  while (strategy.closedChunks().length < n && guard++ < 200) {
    manager.addMessage('user', textBlock(`m-${guard} hello world padding`));
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.strictEqual(strategy.closedChunks().length >= n, true, `expected ≥${n} closed chunks`);
}

function makeStrategy(overrides: Record<string, unknown> = {}): InspectableStrategy {
  return new InspectableStrategy({
    headWindowTokens: 0,
    recentWindowTokens: 5,
    targetChunkTokens: 20,
    autoTickOnNewMessage: false, // inspect the queue without draining it
    ...overrides,
  });
}

describe('AutobiographicalStrategy — L1 holdback', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('default: the newest closed chunk is held out of the speculative queue', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    await closeChunks(manager, strategy, 2);
    const total = strategy.closedChunks().length;
    const queued = strategy.queuedChunkIndices();

    assert.ok(!queued.includes(total - 1), 'newest closed chunk must be held back');
    assert.ok(queued.includes(0), 'older chunks must be queued speculatively');
    manager.close();
  });

  it('a held-back chunk is released once a newer chunk closes behind it', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    await closeChunks(manager, strategy, 2);
    const heldIndex = strategy.closedChunks().length - 1;
    assert.ok(!strategy.queuedChunkIndices().includes(heldIndex), 'sanity: held at first');

    await closeChunks(manager, strategy, strategy.closedChunks().length + 1);
    assert.ok(
      strategy.queuedChunkIndices().includes(heldIndex),
      'previously-held chunk must be queued once it ages out of the holdback window',
    );
    manager.close();
  });

  it('l1HoldbackChunks: 0 restores compress-at-close', async () => {
    const strategy = makeStrategy({ l1HoldbackChunks: 0 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    await closeChunks(manager, strategy, 1);
    const total = strategy.closedChunks().length;
    assert.ok(
      strategy.queuedChunkIndices().includes(total - 1),
      'with holdback disabled the newest chunk queues at close',
    );
    manager.close();
  });

  it('l1HoldbackChunks: 2 holds the two newest closed chunks', async () => {
    const strategy = makeStrategy({ l1HoldbackChunks: 2 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    await closeChunks(manager, strategy, 3);
    const total = strategy.closedChunks().length;
    const queued = strategy.queuedChunkIndices();
    assert.ok(!queued.includes(total - 1), 'newest held');
    assert.ok(!queued.includes(total - 2), 'second-newest held');
    assert.ok(queued.includes(total - 3) || total - 3 < 0, 'third-newest queued');
    manager.close();
  });

  it('demand (enqueueL1ForRange) overrides the holdback — and survives a rebuild', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    await closeChunks(manager, strategy, 2);
    const chunks = strategy.closedChunks();
    const newest = chunks[chunks.length - 1];
    assert.ok(!strategy.queuedChunkIndices().includes(newest.index), 'sanity: held before demand');

    strategy.demandRange(newest.messages[0].id, newest.messages[newest.messages.length - 1].id);
    assert.ok(
      strategy.queuedChunkIndices().includes(newest.index),
      'demanded chunk enters the queue immediately',
    );

    // A new message rebuilds the queue from scratch — the demanded chunk must
    // NOT be filtered back out by the holdback window.
    manager.addMessage('user', textBlock('another message'));
    await new Promise((r) => setTimeout(r, 5));
    const stillNewest = strategy.closedChunks()[newest.index];
    assert.ok(
      strategy.queuedChunkIndices().includes(stillNewest.index) || stillNewest.compressed,
      'demanded chunk stays queued across rebuilds',
    );
    manager.close();
  });
});
