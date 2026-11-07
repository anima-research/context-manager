import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'carrier-compression-input-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const COMPACTION = { type: 'text', text: '', rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'E'.repeat(3_000) } } as unknown as ContentBlock;
const SEARCH = {
  type: 'text', text: '',
  rawItem: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.org', title: 'A', encrypted_content: 'x'.repeat(2_800) }] },
} as unknown as ContentBlock;

describe('compression input and zero-width carriers', () => {
  it('a chunk holding carriers is compressed without them', async () => {
    const requests: NormalizedRequest[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        requests.push(request);
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${requests.length} of the chunk` }] };
      },
    };
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'test-compression-model',
      targetChunkTokens: 50,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
    });
    const cm = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: membrane as never });
    const filler = (n: number) => 'word '.repeat(n);
    for (let i = 0; i < 8; i++) {
      const text: ContentBlock = { type: 'text', text: `${i === 1 ? 'the carrier turn ' : ''}${filler(30)}` };
      cm.addMessage(i % 2 === 0 ? 'User' : 'Claude', i === 1 ? [COMPACTION, SEARCH, text] : [text]);
    }
    await cm.compile();
    await cm.tick();

    const sent = requests.flatMap((r) => r.messages.flatMap((m) => m.content as ContentBlock[]));
    assert.ok(sent.some((b) => b.type === 'text' && b.text.includes('the carrier turn')), 'premise: the carriers\' message was compressed');
    assert.deepStrictEqual(sent.filter((b) => (b as { rawItem?: unknown }).rawItem !== undefined), [], 'no request carried a raw item');
    cm.close();
  });
});
