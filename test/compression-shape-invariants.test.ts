/**
 * End-to-end shape invariants for the compression pipeline.
 *
 * The whole compression-bug family (5/6/7/8/9) was about the *shape* of the
 * request sent to the Anthropic API, not the content of summaries. This
 * suite exercises the full pipeline (message store → chunker → L1 compress
 * → L2/L3 merges) against a mock membrane that:
 *
 *   1. Validates every request against the API's structural rules
 *      (tool_use/tool_result adjacency, placement in user vs. assistant
 *      turns) and throws if any rule is violated.
 *   2. Returns a deterministic summary text at a realistic ~5:1 compression
 *      ratio so summary IDs and merge cascades behave predictably.
 *
 * If any of the patched call sites — `compressChunkHierarchical`,
 * `executeMerge`, the chunker's tool-cycle-respecting close, or the
 * runtime `splitMixedToolMessages` / `stripUnpairedToolBlocks` passes —
 * regresses, the mock will throw with the same error shape the live API
 * would return, and the test fails.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-compression-shape';
const TEST_COMPRESSION_MODEL = 'test-compression-model';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

interface ApiMessage { participant: string; content: ContentBlock[] }

// ---------------------------------------------------------------------------
// API-shape validator: mirrors what the Anthropic API enforces.
// ---------------------------------------------------------------------------

function validateApiShape(messages: readonly ApiMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isUser = msg.participant.toLowerCase() === 'user';

    for (const block of msg.content) {
      if (block.type === 'tool_result' && !isUser) {
        throw new Error(
          `messages[${i}]: tool_result block in non-user turn (participant=${msg.participant})`,
        );
      }

      if (block.type === 'tool_use') {
        const id = (block as { id: string }).id;
        const next = messages[i + 1];
        const matched = next?.content.some(
          (b) =>
            b.type === 'tool_result' &&
            (b as { toolUseId: string }).toolUseId === id,
        );
        if (!matched) {
          throw new Error(
            `messages[${i}]: tool_use id=${id} was not followed by a matching tool_result in messages[${i + 1}]`,
          );
        }
      }

      if (block.type === 'tool_result') {
        const tid = (block as { toolUseId: string }).toolUseId;
        const prev = messages[i - 1];
        const matched = prev?.content.some(
          (b) => b.type === 'tool_use' && (b as { id: string }).id === tid,
        );
        if (!matched) {
          throw new Error(
            `messages[${i}]: tool_result toolUseId=${tid} was not preceded by a matching tool_use in messages[${i - 1}]`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mock membrane: validates shape, returns deterministic compressed text.
// ---------------------------------------------------------------------------

function createValidatingMembrane(compressionRatio = 5) {
  const calls: Array<{ messages: ApiMessage[]; outputChars: number }> = [];
  const membrane = {
    complete: async (request: {
      messages: ApiMessage[];
      config?: { maxTokens?: number };
    }) => {
      validateApiShape(request.messages);
      const inputChars = request.messages
        .flatMap((m) => m.content)
        .map((b) => (b as { text?: string }).text ?? '')
        .join('').length;
      const targetChars = Math.max(60, Math.floor(inputChars / compressionRatio));
      const summary =
        `[mock summary inChars=${inputChars}] ` +
        'x '.repeat(Math.max(0, Math.floor((targetChars - 30) / 2)));
      calls.push({ messages: request.messages, outputChars: summary.length });
      return {
        content: [{ type: 'text', text: summary }],
        usage: {
          input_tokens: Math.ceil(inputChars / 4),
          output_tokens: Math.ceil(summary.length / 4),
        },
      };
    },
  };
  return { membrane, calls };
}

const t = (s: string): ContentBlock => ({ type: 'text', text: s });
const u = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'fn', input: {} });
const r = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'ok' });

// Compression of tool-bearing history DEFERS until the host declares its tool
// definitions (the 07-09 reasoning_extraction fix: a summarizer call replaying
// tool blocks without a `tools` param gets refused). Fixtures that add tool
// cycles must do what agent-framework does every activation.
const TEST_TOOLS = [
  { name: 'fn', description: 'test tool', inputSchema: { type: 'object' as const } },
];

async function drain(manager: ContextManager): Promise<void> {
  // Cap iterations so a regression that fails to converge can't hang CI.
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

describe('Compression pipeline: API shape invariants', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('L1 compression: chunker close lands on a tool_use without fix — must not throw', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });
    manager.setToolDefinitions(TEST_TOOLS);

    // Force the chunker to want to close on a tool_use-bearing message:
    //   - 3 small messages (length 3, tokens ~30)
    //   - then a FAT agent message with a tool_use (length 4 → meets >=4,
    //     fat enough to push currentTokens past targetChunkTokens=80)
    //   - then the matching tool_result (would land in next chunk
    //     without the chunker-defer fix → orphan tool_use at boundary)
    // Repeat this pattern many times so multiple boundaries are exercised.
    const small = (n: number) => 'word '.repeat(n);
    const fat = (n: number) => 'thinking '.repeat(n);
    for (let i = 0; i < 12; i++) {
      manager.addMessage('user', [t(small(8))]);
      manager.addMessage('agent', [t(small(8))]);
      manager.addMessage('user', [t(small(8))]);
      manager.addMessage('agent', [t(fat(60)), u(`A${i}`)]);
      manager.addMessage('user', [r(`A${i}`)]);
      manager.addMessage('agent', [t(small(10))]);
    }

    await drain(manager);
    assert.ok(calls.length > 0, 'expected at least one L1 compression call');
    await manager.close();
  });

  it('L1 compression: strips thinking/redacted_thinking from the summarizer input', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });
    manager.setToolDefinitions(TEST_TOOLS);
    const th = (s: string): ContentBlock =>
      ({ type: 'thinking', thinking: s, signature: 'sig-' + s.slice(0, 6) } as unknown as ContentBlock);
    const small = (n: number) => 'word '.repeat(n);
    // Agent turns carry SIGNED thinking blocks alongside text + a tool cycle —
    // the shape that was leaking the agent's reasoning into the summarizer and
    // tripping reasoning_extraction.
    for (let i = 0; i < 12; i++) {
      manager.addMessage('user', [t(small(8))]);
      manager.addMessage('agent', [th(`private chain-of-thought ${i} ` + small(20)), t(small(10)), u(`A${i}`)]);
      manager.addMessage('user', [r(`A${i}`)]);
      manager.addMessage('agent', [t(small(10))]);
    }
    await drain(manager);
    assert.ok(calls.length > 0, 'expected at least one L1 compression call');
    // The summarizer must NEVER receive the agent's own thinking.
    for (const call of calls) {
      for (const m of call.messages) {
        for (const b of m.content) {
          assert.ok(
            b.type !== 'thinking' && b.type !== 'redacted_thinking',
            `thinking block leaked into compression input (participant=${m.participant})`,
          );
        }
      }
    }
    await manager.close();
  });

  it('L2/L3 merge cascade preserves shape across hundreds of summaries', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 50,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 3, // L1→L2 every 3 L1s, L2→L3 every 9 L1s
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });
    manager.setToolDefinitions(TEST_TOOLS);

    const filler = (n: number) => 'word '.repeat(n);
    for (let i = 0; i < 80; i++) {
      if (i % 5 === 0 && i > 0) {
        manager.addMessage('agent', [t(filler(10)), u(`B${i}`)]);
        manager.addMessage('user', [r(`B${i}`)]);
      } else {
        manager.addMessage(i % 2 === 0 ? 'agent' : 'user', [t(filler(15))]);
      }
    }

    await drain(manager);

    // We should have hit L1 + at least one L2 merge — easiest signal is the
    // sheer call count plus the absence of validation throws.
    const snap = strategy.getProgressSnapshot();
    assert.ok(snap.summaryCounts.l1 > 0, 'expected L1 summaries');
    assert.ok(
      snap.summaryCounts.l2 > 0,
      `expected at least one L2 merge (l1=${snap.summaryCounts.l1}, l2=${snap.summaryCounts.l2})`,
    );
    assert.ok(calls.length >= snap.summaryCounts.l1 + snap.summaryCounts.l2);
    await manager.close();
  });

  it('Bug 10: raw middle dedup correctly handles L2+ summaries (no message leak)', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 3,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    // 100 messages → enough chunks to drive a multi-level merge cascade
    // (L1s → L2s → L3) so executeMerge runs with L2s in its prior
    // frontier. Each message has a distinctive marker (`RAW-N`) so we
    // can count how many leak into requests as raw content.
    const filler = (n: number) => 'word '.repeat(n);
    for (let i = 0; i < 100; i++) {
      manager.addMessage(i % 2 === 0 ? 'agent' : 'user', [
        t(`RAW-${i} ${filler(8)}`),
      ]);
    }

    await drain(manager);

    const snap = strategy.getProgressSnapshot();
    assert.ok(
      snap.summaryCounts.l2 >= 2,
      `expected >=2 L2 summaries to exercise the bug (got l2=${snap.summaryCounts.l2})`,
    );

    // Count raw conversation messages in each request. The expansion bug
    // allowed ~all messages to leak in (the bug report saw 256 user +
    // 262 agent for a 4234-msg conversation). With the fix, per-request
    // raw-message count should be bounded by the merge target's leaf
    // size — for mergeThreshold=3 with ~3-msg L1s, that's <= ~25.
    const RAW_MSG_LIMIT = 40;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      let rawCount = 0;
      for (const m of call.messages) {
        for (const block of m.content) {
          const text = (block as { text?: string }).text ?? '';
          if (text.includes('RAW-')) rawCount++;
        }
      }
      assert.ok(
        rawCount <= RAW_MSG_LIMIT,
        `call ${i}: ${rawCount} raw messages in request — raw middle is leaking already-summarized content (Bug 10)`,
      );
    }
    await manager.close();
  });

  it('runtime splitMixedToolMessages handles bundled cycles in source data', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 60,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });
    manager.setToolDefinitions(TEST_TOOLS);

    // Pre-Bug-8 import shape: tool_use AND tool_result bundled into one
    // assistant message. The runtime split has to unpack these before the
    // request reaches the membrane.
    for (let i = 0; i < 20; i++) {
      manager.addMessage('user', [t('q'.repeat(60))]);
      manager.addMessage('agent', [
        t('a'.repeat(40)),
        u(`C${i}`),
        r(`C${i}`),
        t('done'),
      ]);
    }

    await drain(manager);
    assert.ok(calls.length > 0);
    await manager.close();
  });

  it('orphan tool_use at the very tail (no next message ever) does not crash', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 50,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    // Build a sequence that ends on a tool_use with no following tool_result.
    // The chunker's defer rule can't help here (there's no next message);
    // stripUnpairedToolBlocks is the safety net.
    const filler = (n: number) => 'word '.repeat(n);
    for (let i = 0; i < 12; i++) {
      manager.addMessage(i % 2 === 0 ? 'agent' : 'user', [t(filler(20))]);
    }
    manager.addMessage('agent', [t(filler(10)), u('orphan')]);

    await drain(manager);
    assert.ok(calls.length > 0);
    await manager.close();
  });

  it('adaptive resolution variant uses the same compression sites — same shape guarantees', async () => {
    cleanup();
    const { membrane, calls } = createValidatingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 50,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      adaptiveResolution: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    const filler = (n: number) => 'word '.repeat(n);
    for (let i = 0; i < 30; i++) {
      if (i % 4 === 0 && i > 0) {
        manager.addMessage('agent', [t(filler(10)), u(`D${i}`)]);
        manager.addMessage('user', [r(`D${i}`)]);
      } else {
        manager.addMessage(i % 2 === 0 ? 'agent' : 'user', [t(filler(20))]);
      }
    }

    // Adaptive path produces L1s lazily via the picker — trigger a compile
    // (or two) so FoldOps run and enqueue compression work.
    await manager.compile();
    await drain(manager);
    await manager.compile();
    await drain(manager);

    assert.ok(calls.length > 0, 'adaptive path produced no compression calls');
    await manager.close();
  });
});
