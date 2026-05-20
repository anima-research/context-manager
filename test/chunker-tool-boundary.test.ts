/**
 * Chunker invariant: a chunk must not close on a message containing a
 * `tool_use` block, because the matching `tool_result` lives in the
 * immediately-following user message and the Anthropic API rejects a
 * compression request where a tool_use isn't followed by its result.
 *
 * Companion to `stripUnpairedToolBlocks` (the runtime safety net) — this
 * verifies the upstream chunker behavior that avoids the situation in the
 * first place.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-chunker-tool-boundary';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

describe('Chunker: tool cycle boundary', () => {
  before(() => cleanup());
  after(() => cleanup());

  it("defers chunk closure when the last message contains a tool_use", async () => {
    cleanup();
    const strategy = new AutobiographicalStrategy({
      // Very small chunk threshold so we hit close-conditions quickly.
      targetChunkTokens: 50,
      // Disable head/recent windows so all messages are eligible for chunking.
      headWindowTokens: 0,
      recentWindowTokens: 0,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Build a sequence where the message that would land at the chunk
    // boundary contains a tool_use. The matching tool_result is the next
    // message. The chunker should defer closing to include both.
    //
    // Messages (~30 tokens each so we cross 50 tokens after the 2nd):
    //   0: user text
    //   1: agent text
    //   2: user text
    //   3: agent text + tool_use(id=A)   <- would close here (4 msgs, >50 tok)
    //   4: user tool_result(id=A)        <- chunk extended to include this
    //   5: agent text
    //   6: user text
    //   ...
    const filler = (n: number) => 'word '.repeat(n);
    manager.addMessage('user', [{ type: 'text', text: filler(30) }]);
    manager.addMessage('agent', [{ type: 'text', text: filler(30) }]);
    manager.addMessage('user', [{ type: 'text', text: filler(30) }]);
    manager.addMessage('agent', [
      { type: 'text', text: filler(20) },
      { type: 'tool_use', id: 'A', name: 'fn', input: {} },
    ] as ContentBlock[]);
    manager.addMessage('user', [
      { type: 'tool_result', toolUseId: 'A', content: 'res' },
    ] as ContentBlock[]);
    // Add more messages to ensure a second chunk forms (so the first
    // chunk's boundary is unambiguous, not just "end of store").
    for (let i = 0; i < 6; i++) {
      manager.addMessage(i % 2 === 0 ? 'agent' : 'user', [
        { type: 'text', text: filler(30) },
      ]);
    }

    // Force a chunker rebuild by reading state via the strategy.
    // ContextManager runs rebuildChunks during compile() — easier to call
    // the internal directly.
    const s = strategy as unknown as {
      chunks: Array<{ messages: Array<{ id: string; content: ContentBlock[] }> }>;
      rebuildChunks: (store: unknown) => void;
    };
    s.rebuildChunks((manager as unknown as { messageStore: unknown }).messageStore);

    assert.ok(s.chunks.length >= 1, 'should have produced at least one chunk');

    // For every closed chunk, the last message must NOT contain a tool_use.
    for (const chunk of s.chunks) {
      const last = chunk.messages[chunk.messages.length - 1];
      const hasToolUse = last.content.some((b) => b.type === 'tool_use');
      assert.ok(
        !hasToolUse,
        `chunk ending on message ${last.id} contains a trailing tool_use — boundary not deferred`,
      );
    }

    // Specifically: the first chunk should have included message 4 (the
    // tool_result), not stopped at message 3.
    const firstChunk = s.chunks[0];
    const firstChunkLastContent = firstChunk.messages[firstChunk.messages.length - 1].content;
    const lastBlockIsToolResult = firstChunkLastContent.some(
      (b) => b.type === 'tool_result',
    );
    assert.ok(
      lastBlockIsToolResult || firstChunk.messages.length >= 5,
      'first chunk should have been extended to include the tool_result',
    );

    await manager.close();
  });
});
