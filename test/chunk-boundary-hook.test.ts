/**
 * `chunkBoundaryHint` — the subclass seam for semantic chunk boundaries.
 *
 * Host strategies with domain knowledge about conversation structure
 * (e.g. chat-topic transitions in connectome-host's FrontdeskStrategy)
 * previously had to fork the whole of `rebuildChunks` to close chunks at
 * semantic boundaries — bypassing chunk-record persistence, the
 * fail-closed orphan guard, and every future fix to the base chunker.
 * The hint hook lets them keep semantic boundaries while riding the base
 * implementation.
 *
 * Contract under test:
 *  1. A hint between two frontier messages closes the running chunk
 *     BEFORE the next message is appended, even under `targetChunkTokens`.
 *  2. The hint is not consulted until the chunk has the chunker's minimum
 *     message count (4).
 *  3. The tool_use pairing guard outranks the hint: a chunk never closes
 *     on a trailing tool_use, topic boundary or not.
 *  4. Hinted closes persist chunk records exactly like size-based closes.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StoredMessage } from '../src/types/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-chunk-boundary-hook';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

/** Closes chunks whenever `metadata.topic` changes between neighbors. */
class TopicBoundaryStrategy extends AutobiographicalStrategy {
  protected override chunkBoundaryHint(prev: StoredMessage, next: StoredMessage): boolean {
    const topicOf = (m: StoredMessage): unknown =>
      (m.metadata as Record<string, unknown> | undefined)?.topic;
    const a = topicOf(prev);
    const b = topicOf(next);
    return a !== undefined && b !== undefined && a !== b;
  }
}

interface StrategyInternals {
  chunks: Array<{
    recordId?: string;
    messages: Array<{ id: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>;
  }>;
  chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean }>;
  rebuildChunks: (store: unknown) => void;
}

function internals(strategy: AutobiographicalStrategy): StrategyInternals {
  return strategy as unknown as StrategyInternals;
}

async function openManager(strategy: AutobiographicalStrategy): Promise<ContextManager> {
  return ContextManager.open({ path: TEST_STORE_PATH, strategy });
}

function rebuild(manager: ContextManager, strategy: AutobiographicalStrategy): void {
  internals(strategy).rebuildChunks(
    (manager as unknown as { messageStore: unknown }).messageStore,
  );
}

const filler = (n: number) => 'word '.repeat(n);

describe('Chunker: subclass boundary hint', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('closes an undersized chunk at a hinted boundary, and persists its record', async () => {
    cleanup();
    const strategy = new TopicBoundaryStrategy({
      // Size-close would need 10k tokens — far beyond this workload, so any
      // close we observe is the hint's.
      targetChunkTokens: 10_000,
      headWindowTokens: 0,
      recentWindowTokens: 0,
    });
    const manager = await openManager(strategy);

    // 5 messages on topic alpha (past the 4-message minimum), then 5 on
    // topic beta. The alpha→beta transition must close the alpha chunk.
    for (let i = 0; i < 5; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [{ type: 'text', text: filler(20) }], { topic: 'alpha' });
    }
    for (let i = 0; i < 5; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [{ type: 'text', text: filler(20) }], { topic: 'beta' });
    }

    rebuild(manager, strategy);
    const s = internals(strategy);

    assert.strictEqual(s.chunks.length, 1, 'exactly the alpha chunk should have closed');
    const topics = new Set(s.chunks[0].messages.map((m) => m.metadata?.topic));
    assert.deepStrictEqual([...topics], ['alpha'], 'the closed chunk must be single-topic');
    assert.strictEqual(s.chunks[0].messages.length, 5);

    // Hinted closes persist boundary ownership like size-based ones.
    assert.strictEqual(s.chunkRecords.length, 1, 'hinted close must append a chunk record');
    assert.deepStrictEqual(
      s.chunkRecords[0].sourceIds,
      s.chunks[0].messages.map((m) => m.id),
      'record must own exactly the closed chunk\'s messages',
    );
    assert.strictEqual(s.chunks[0].recordId, s.chunkRecords[0].id);

    await manager.close();
  });

  it('ignores a boundary before the minimum message count', async () => {
    cleanup();
    const strategy = new TopicBoundaryStrategy({
      targetChunkTokens: 10_000,
      headWindowTokens: 0,
      recentWindowTokens: 0,
    });
    const manager = await openManager(strategy);

    // Only 3 alpha messages before the transition — under the 4-message
    // minimum, the hint must not fire; with size-close unreachable the
    // whole store stays an open frontier.
    for (let i = 0; i < 3; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [{ type: 'text', text: filler(20) }], { topic: 'alpha' });
    }
    for (let i = 0; i < 4; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [{ type: 'text', text: filler(20) }], { topic: 'beta' });
    }

    rebuild(manager, strategy);
    assert.strictEqual(internals(strategy).chunks.length, 0,
      'no chunk may close: boundary was under-minimum, size target unreached');

    await manager.close();
  });

  it('tool_use pairing outranks the hinted boundary', async () => {
    cleanup();
    const strategy = new TopicBoundaryStrategy({
      targetChunkTokens: 10_000,
      headWindowTokens: 0,
      recentWindowTokens: 0,
    });
    const manager = await openManager(strategy);

    // alpha ends on a tool_use; its tool_result opens beta. The hint at the
    // alpha→beta edge must be suppressed (closing there would strand the
    // pair across chunks); the next hintable boundary (beta→gamma) closes a
    // chunk containing BOTH topics with the pair intact.
    for (let i = 0; i < 3; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [{ type: 'text', text: filler(20) }], { topic: 'alpha' });
    }
    manager.addMessage('agent', [
      { type: 'text', text: filler(10) },
      { type: 'tool_use', id: 'A', name: 'fn', input: {} },
    ] as ContentBlock[], { topic: 'alpha' });
    manager.addMessage('user', [
      { type: 'tool_result', toolUseId: 'A', content: 'res' },
    ] as ContentBlock[], { topic: 'beta' });
    for (let i = 0; i < 3; i++) {
      manager.addMessage(i % 2 === 0 ? 'agent' : 'user',
        [{ type: 'text', text: filler(20) }], { topic: 'beta' });
    }
    for (let i = 0; i < 4; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [{ type: 'text', text: filler(20) }], { topic: 'gamma' });
    }

    rebuild(manager, strategy);
    const s = internals(strategy);

    assert.strictEqual(s.chunks.length, 1, 'one chunk should close at the beta→gamma edge');
    const chunk = s.chunks[0];
    assert.strictEqual(chunk.messages.length, 8, 'alpha + beta ride together (pair kept)');
    const chunkTopics = new Set(chunk.messages.map((m) => m.metadata?.topic));
    assert.deepStrictEqual([...chunkTopics].sort(), ['alpha', 'beta']);
    const last = chunk.messages[chunk.messages.length - 1];
    assert.ok(
      !last.content.some((b) => b.type === 'tool_use'),
      'closed chunk must not end on a tool_use',
    );

    await manager.close();
  });
});
