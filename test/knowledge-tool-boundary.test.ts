/**
 * Bug 6.8: KnowledgeStrategy.rebuildChunks dropped the base class's
 * tool-pair chunk-boundary guard. The override closed a chunk on
 * `length >= 2 && (phaseChanged || sizeExceeded)` with NO check that the
 * chunk's last message contains a `tool_use` — so `sizeExceeded` could
 * split a tool_use from its tool_result across chunks. When the earlier
 * chunk compresses first, the raw orphan tool_result renders unpaired and
 * the Anthropic API rejects the request.
 *
 * Companion to chunker-tool-boundary.test.ts (same invariant on the base
 * chunker).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, KnowledgeStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-knowledge-tool-boundary';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

describe('KnowledgeStrategy chunker: tool cycle boundary', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('never closes a chunk on a message containing a tool_use (sizeExceeded lands on the tool_use)', async () => {
    cleanup();
    const strategy = new KnowledgeStrategy({
      targetChunkTokens: 30,
      // Cap research chunks low so the size trigger fires right after a
      // [text, tool_use] prefix — i.e. the close decision lands exactly when
      // the last message in the chunk-in-progress is the tool_use.
      maxResearchChunkTokens: 60,
      headWindowTokens: 0,
      recentWindowTokens: 0,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Repeated triplets: [synthesis text (~50 tok), tool_use (~20 tok),
    // tool_result (~10 tok)]. At the tool_result's iteration the chunk
    // holds [text, tool_use] with cumulative tokens >= maxResearchChunkTokens,
    // so an unguarded chunker closes there — splitting the pair.
    const filler = (n: number) => 'word '.repeat(n);
    for (let k = 0; k < 4; k++) {
      manager.addMessage('User', [{ type: 'text', text: filler(40) }]);
      manager.addMessage('Claude', [
        { type: 'tool_use', id: `tu-${k}`, name: 'mcpl:search', input: { q: 'x'.repeat(60) } },
      ] as ContentBlock[]);
      manager.addMessage('User', [
        { type: 'tool_result', toolUseId: `tu-${k}`, content: 'ok' },
      ] as ContentBlock[]);
    }
    // Trailing filler so the last pair isn't only in the never-closed final chunk.
    for (let i = 0; i < 4; i++) {
      manager.addMessage(i % 2 === 0 ? 'Claude' : 'User', [
        { type: 'text', text: filler(40) },
      ]);
    }

    const s = strategy as unknown as {
      chunks: Array<{ messages: Array<{ id: string; content: ContentBlock[] }> }>;
      rebuildChunks: (store: unknown) => void;
    };
    s.rebuildChunks((manager as unknown as { messageStore: unknown }).messageStore);

    assert.ok(s.chunks.length >= 2, `expected multiple chunks, got ${s.chunks.length}`);

    // Invariant 1: no chunk's LAST message contains a tool_use — a close
    // there guarantees the pair is split.
    for (const chunk of s.chunks) {
      const last = chunk.messages[chunk.messages.length - 1];
      assert.ok(
        !last.content.some((b) => b.type === 'tool_use'),
        `chunk ending on message ${last.id} has a trailing tool_use — boundary guard missing`,
      );
    }

    // Invariant 2 (stronger): both members of every tool_use/tool_result
    // pair land in the SAME chunk.
    for (const chunk of s.chunks) {
      const useIds = new Set<string>();
      const resultIds = new Set<string>();
      for (const msg of chunk.messages) {
        for (const b of msg.content) {
          if (b.type === 'tool_use') useIds.add((b as { id: string }).id);
          if (b.type === 'tool_result') resultIds.add((b as { toolUseId: string }).toolUseId);
        }
      }
      for (const id of useIds) {
        assert.ok(resultIds.has(id), `tool_use ${id} has no tool_result in its chunk`);
      }
      for (const id of resultIds) {
        assert.ok(useIds.has(id), `tool_result for ${id} has no tool_use in its chunk`);
      }
    }

    await manager.close();
  });
});
