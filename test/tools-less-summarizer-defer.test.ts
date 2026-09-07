/**
 * Tools-less summarizer deferral (Linn, claude-fable-5-1, 2026-09-05).
 *
 * On Fable/Mythos-family summarizers a compression request that carries the
 * marker+directive but NO `tools` param is a deterministic
 * reasoning_extraction input-block regardless of chunk content (measured:
 * bare marker+directive IB 3/3, identical bytes with the live tool set
 * end_turn 3/3; same on claude-fable-5). The host pushes tools on MCPL
 * registration and on every activation, so before the first push the
 * strategy must DEFER rather than burn a doomed call that lands the chunk
 * in quarantine. Other summarizers keep minting tools-less (lena bench;
 * every test harness in this repo).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { isToolsLessRefusingSummarizer } from '../src/strategies/autobiographical.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-tools-less-defer';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
const t = (s: string): ContentBlock => ({ type: 'text', text: s });
const TOOLS = [{ name: 'fn', description: 'test tool', inputSchema: { type: 'object' as const } }];

function mockMembrane() {
  const calls: Array<{ tools: unknown }> = [];
  const membrane = {
    complete: async (request: { messages: Array<{ content: ContentBlock[] }>; tools?: unknown }) => {
      calls.push({ tools: request.tools });
      const inChars = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('').length;
      const summary = `[mock summary inChars=${inChars}] ` + 'x '.repeat(40);
      return { stopReason: 'end_turn', content: [t(summary)], usage: { input_tokens: Math.ceil(inChars / 4), output_tokens: 30 } };
    },
  };
  return { membrane, calls };
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) { if (manager.isReady()) return; await manager.tick(); }
  throw new Error('drain: queue did not converge within 500 ticks');
}

async function openChatty(model: string) {
  cleanup();
  const { membrane, calls } = mockMembrane();
  const strategy = new AutobiographicalStrategy({
    compressionModel: model, targetChunkTokens: 80, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true,
  });
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as any });
  // Pure chat, no tool blocks anywhere — the shape of a seeded transcript.
  for (let i = 0; i < 30; i++) {
    manager.addMessage('user', [t('word '.repeat(12))]);
    manager.addMessage('agent', [t('reply '.repeat(20))]);
  }
  return { manager, calls };
}

describe('tools-less summarizer deferral', () => {
  after(cleanup);

  it('classifies Fable/Mythos-family ids (bare, dated, gateway-prefixed) and nothing else', () => {
    for (const m of ['claude-fable-5-1', 'claude-fable-5', 'claude-fable-5-20260901', 'anthropic/claude-fable-5-1', 'claude-mythos-5']) {
      assert.ok(isToolsLessRefusingSummarizer(m), m);
    }
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'gpt-5.6-sol', 'test-compression-model', 'fable-5']) {
      assert.ok(!isToolsLessRefusingSummarizer(m), m);
    }
  });

  it('Fable summarizer + pure-chat chunks: defers until tools are pushed, then mints WITH tools declared', async () => {
    const { manager, calls } = await openChatty('claude-fable-5-1');
    await drain(manager);
    assert.strictEqual(calls.length, 0, 'no summarizer call may be issued before the host pushes tools');
    manager.setToolDefinitions(TOOLS);
    // Deferred chunks are not a queued work item; they are re-examined on the
    // next ingestion/activation (exactly what a resident's first turn does).
    await drain(manager);
    manager.addMessage('user', [t('one more line after the host pushed tools')]);
    await drain(manager);
    assert.ok(calls.length > 0, 'compression resumes once tools are pushed and the next message lands');
    assert.ok(calls.every((c) => Array.isArray(c.tools) && (c.tools as unknown[]).length === TOOLS.length), 'every summarizer request declares the live tools');
    await manager.close();
  });

  it('non-Fable summarizer + pure-chat chunks: still mints tools-less (baseline behaviour preserved)', async () => {
    const { manager, calls } = await openChatty('test-compression-model');
    await drain(manager);
    assert.ok(calls.length > 0, 'tools-less compression proceeds on non-Fable summarizers');
    await manager.close();
  });
});
