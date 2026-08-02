/**
 * Bug 6.10: compression concurrent with new messages — stale chunk identity
 * across rebuildChunks.
 *
 * tick() shifts an index into `this.chunks` and starts an async
 * `compressChunkHierarchical` holding a reference to that chunk OBJECT.
 * A rebuildChunks (fired by select()/onNewMessage while the LLM call is in
 * flight) rebuilds `this.chunks` and resets `compressionQueue`; the rebuilt
 * chunk for the same messages is created BEFORE the in-flight summary
 * exists, so it re-queues as uncompressed. When the in-flight call
 * completes it marks only the STALE object — the next tick compresses the
 * same messages again, producing a duplicate L1 over identical history.
 *
 * Fix: compressChunkHierarchical reconciles by content identity (sourceIds)
 * against the summary archive before (and after) the LLM call — an exact
 * match adopts the existing summary; full coverage by existing L1s drops
 * the chunk instead of duplicating history.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-compression-dedup';
const TEST_COMPRESSION_MODEL = 'test-compression-model';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

describe('Concurrent compression: stale chunk identity', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('does not produce duplicate L1s when rebuildChunks runs during a slow compression', async () => {
    cleanup();

    let llmCalls = 0;
    const slowMembrane = {
      complete: async () => {
        llmCalls++;
        await new Promise((r) => setTimeout(r, 80));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${llmCalls} of the chunk` }] };
      },
    };

    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 50,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      autoTickOnNewMessage: false, // drive ticks manually for determinism
      minChunkCharsForLLM: 0, // always go through the LLM path
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: slowMembrane as never,
    });

    const filler = (n: number) => 'word '.repeat(n);
    for (let i = 0; i < 8; i++) {
      manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [
        { type: 'text', text: filler(30) },
      ]);
    }

    // Populate chunks + queue.
    await manager.compile();

    const s = strategy as unknown as {
      compressionQueue: number[];
      summaries: SummaryEntry[];
    };
    assert.ok(s.compressionQueue.length >= 1, 'setup: at least one chunk queued');

    // Start a slow compression of chunk 0 — do NOT await yet.
    const inflight = manager.tick();

    // While the LLM call is in flight: a new message arrives and a compile
    // runs → rebuildChunks resets the queue and re-queues chunk 0 (its L1
    // doesn't exist yet, so the rebuilt chunk object is uncompressed).
    manager.addMessage('User', [{ type: 'text', text: filler(30) }]);
    await manager.compile();

    await inflight;

    // Drain the (stale) queue: without the dedup guard, the re-queued chunk 0
    // compresses again → a second L1 over the same messages.
    let guard = 0;
    while (s.compressionQueue.length > 0 && guard++ < 25) {
      await manager.tick();
    }

    const l1s = s.summaries.filter((x) => x.level === 1);
    assert.ok(l1s.length >= 1, 'at least one L1 must have been produced');

    // No two L1s may share any source message id.
    const seen = new Map<string, string>();
    for (const l1 of l1s) {
      for (const msgId of l1.sourceIds) {
        const prior = seen.get(msgId);
        assert.ok(
          prior === undefined,
          `message ${msgId} is covered by BOTH ${prior} and ${l1.id} — duplicate L1 over the same history`,
        );
        seen.set(msgId, l1.id);
      }
    }

    await manager.close();
  });
});
