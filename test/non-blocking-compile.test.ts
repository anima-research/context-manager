/**
 * Tests for `compile()`'s non-blocking contract + the uncompressed-chunk
 * fallback that prevents silent message loss.
 *
 * Background: commit `3e42e98` dropped the `await readiness.pendingWork`
 * inside `compile()` to keep turn latency low (compression can take
 * 30+s; awaiting it per-turn was the wrong tradeoff). The side effect
 * was that messages caught in a queued-but-not-yet-compressed chunk
 * would vanish from rendered context in hierarchical mode — no summary
 * existed yet for the chunk, and `selectHierarchical` only emitted raw
 * messages from `recentStart` onward.
 *
 * The fix (these tests pin in place): `selectHierarchical` now emits
 * raw messages for any uncompressed chunk that overlaps the middle
 * region between the head and recent windows, mirroring
 * `selectLegacy`'s "Uncompressed: emit raw" behavior. Once compression
 * finishes and the chunk transitions to `compressed: true`, the raw
 * emission stops (the chunk is now covered by an L1 summary), so
 * there's no double-counting across the transition.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-non-blocking-compile';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function compiledHas(
  compiled: { messages: ReadonlyArray<{ content: ContentBlock[] }> },
  fragment: string,
): boolean {
  for (const m of compiled.messages) {
    for (const block of m.content) {
      if (block.type === 'text' && block.text.includes(fragment)) return true;
    }
  }
  return false;
}

describe('AutobiographicalStrategy — non-blocking compile + uncompressed-chunk fallback', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('emits raw messages for uncompressed chunks in the middle region (no silent drop)', async () => {
    // Configure for a small middle region:
    //  - No head window (so all messages compete for visibility via the
    //    summary path and the recent window).
    //  - Small recentWindowTokens so older messages fall out of recent.
    //  - Small targetChunkTokens so a single old message ends up in
    //    its own chunk.
    //  - Hierarchical mode so `selectHierarchical` is the codepath
    //    under test (selectLegacy already had this fallback).
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 12,
      targetChunkTokens: 4,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Three "old" messages whose chunks will be queued but un-ticked,
    // plus a "latest" big enough to dominate the small recent window.
    manager.addMessage('user', textBlock('ANCIENT_MARKER_1'));
    manager.addMessage('user', textBlock('ANCIENT_MARKER_2'));
    manager.addMessage('user', textBlock('ANCIENT_MARKER_3'));
    manager.addMessage('user', textBlock('LATEST ' + 'X'.repeat(80)));

    // Critically: we do NOT call manager.tick(). The chunks for the
    // ancient messages exist in the strategy's compression queue but
    // never run through executeMerge/compressChunk, so they stay
    // `chunk.compressed === false`. This is the exact state where the
    // bug used to silently drop messages.
    const compiled = await manager.compile({
      maxTokens: 100_000,
      reserveForResponse: 0,
    });

    assert.ok(
      compiledHas(compiled, 'ANCIENT_MARKER_1'),
      'ANCIENT_MARKER_1 must appear in compiled output (uncompressed-chunk fallback)',
    );
    assert.ok(
      compiledHas(compiled, 'ANCIENT_MARKER_2'),
      'ANCIENT_MARKER_2 must appear in compiled output',
    );
    assert.ok(
      compiledHas(compiled, 'ANCIENT_MARKER_3'),
      'ANCIENT_MARKER_3 must appear in compiled output',
    );
    // The recent message must of course still be there.
    assert.ok(
      compiledHas(compiled, 'LATEST'),
      'LATEST message must appear in compiled output',
    );

    manager.close();
  });

  it('compile() returns while a compression is in flight, without waiting for it', { timeout: 60_000 }, async () => {
    let entered!: () => void;
    const called = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const answer = new Promise<void>((resolve) => { release = resolve; });
    const membrane = {
      complete: async () => {
        entered();
        await answer;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'A summary.' }], usage: { inputTokens: 500, outputTokens: 100 } };
      },
    };
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'm',
      headWindowTokens: 0,
      recentWindowTokens: 0,
      targetChunkTokens: 200,
      minChunkCharsForLLM: 0,
      summaryParticipant: 'Claude',
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as never,
    });

    for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock(`message ${i} ${'word '.repeat(30)}`));
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });

    const ticking = manager.tick();
    try {
      await Promise.race([called, ticking.then(() => { throw new Error('premise: the tick asked for no compression'); })]);
      const started = process.cpuUsage();
      await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      const cpu = process.cpuUsage(started);
      const ms = (cpu.user + cpu.system) / 1000;
      assert.ok(ms < 500, `compile() should return promptly; it used ${ms} ms of CPU`);
    } finally {
      release();
      await ticking;
      manager.close();
    }
  });
});
