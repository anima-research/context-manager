import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-ingress-provider-items-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

const mockMembrane = {
  complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: '[mock summary]' }] }),
};

const prose = (chars: number) => 'The answer goes on. '.repeat(Math.ceil(chars / 20)).slice(0, chars);

async function stored(content: ContentBlock[]) {
  const strategy = new AutobiographicalStrategy({ compressionModel: 'mock', adaptiveResolution: true });
  const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: mockMembrane as any });
  try {
    manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
    manager.addMessage('Claude', content);
    return manager.getAllMessages().filter((m) => m.participant === 'Claude').map((m) => m.content);
  } finally {
    manager.close();
  }
}

describe('AutobiographicalStrategy — ingestion keeps provider items', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('a long message with a compaction item is stored whole, item and order kept', async () => {
    const content = [
      { type: 'text', text: '', rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'E'.repeat(3_000) } },
      { type: 'text', text: prose(40_000) },
    ] as ContentBlock[];
    const rows = await stored(content);
    assert.equal(rows.length, 1, `stored as ${rows.length} rows`);
    assert.deepEqual(rows, [content]);
  });

  it("a long Responses reply's message parts are stored whole, each keeping its item and phase", async () => {
    const item = {
      type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: prose(20_000) }, { type: 'output_text', text: prose(20_000) }],
    };
    const content = [
      { type: 'text', text: prose(20_000), rawItem: item },
      { type: 'text', text: prose(20_000), rawItem: item },
    ] as ContentBlock[];
    const rows = await stored(content);
    assert.equal(rows.length, 1, `stored as ${rows.length} rows`);
    assert.deepEqual(rows, [content]);
  });

  it('a long message with a reasoning item and its follower is stored whole, the pairing in its order', async () => {
    const text = prose(40_000);
    const content = [
      { type: 'redacted_thinking', data: 'opaque', rawItem: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' } },
      { type: 'text', text, rawItem: { type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } },
    ] as ContentBlock[];
    const rows = await stored(content);
    assert.equal(rows.length, 1, `stored as ${rows.length} rows`);
    assert.deepEqual(rows, [content]);
  });

  it('an item on a block that is not text keeps a long message whole too', async () => {
    const content = [
      { type: 'redacted_thinking', data: 'opaque', rawItem: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' } },
      { type: 'text', text: prose(40_000) },
    ] as ContentBlock[];
    const rows = await stored(content);
    assert.equal(rows.length, 1, `stored as ${rows.length} rows`);
    assert.deepEqual(rows, [content]);
  });

  it('a message under the threshold with a compaction item is stored whole', async () => {
    const content = [
      { type: 'text', text: '', rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'E'.repeat(3_000) } },
      { type: 'text', text: prose(20_000) },
    ] as ContentBlock[];
    const rows = await stored(content);
    assert.equal(rows.length, 1, `stored as ${rows.length} rows`);
    assert.deepEqual(rows, [content]);
  });

  it('a long message with no provider item is still split into shards', async () => {
    const text = prose(40_000);
    const rows = await stored([{ type: 'text', text }] as ContentBlock[]);
    assert.ok(rows.length > 1, `expected shards, got ${rows.length} row(s)`);
    assert.equal(rows.flat().map((b) => (b as { text: string }).text).join(''), text);
  });
});

describe('AutobiographicalStrategy — a message stored whole for its items is sent uncut', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  const item = {
    type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: prose(30_000) }, { type: 'output_text', text: prose(30_000) }],
  };
  const reply = [
    { type: 'text', text: prose(30_000), rawItem: item },
    { type: 'text', text: prose(30_000), rawItem: item },
  ] as ContentBlock[];

  async function sentReply(adaptiveResolution: boolean) {
    const strategy = new AutobiographicalStrategy({ compressionModel: 'mock', adaptiveResolution, maxMessageTokens: 10_000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: mockMembrane as any });
    try {
      manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
      manager.addMessage('Claude', reply);
      manager.addMessage('User', [{ type: 'text', text: 'and then?' }]);
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      return compiled.messages.filter((m) => m.participant === 'Claude').flatMap((m) => m.content);
    } finally {
      manager.close();
    }
  }

  it("a Responses reply past maxMessageTokens goes out whole, as its shards did, with its parts' message item", async () => {
    const sent = await sentReply(true);
    const text = sent.map((b) => (b as { text?: string }).text ?? '').join('');
    assert.equal(text.length, 60_000, `sent ${text.length} characters of 60,000`);
    assert.ok(!text.includes('[truncated'), 'nothing is cut');
    assert.deepEqual(sent, reply, 'each part keeps its message item');
  });

  it('with adaptiveResolution off, such a reply is stored whole and cut at the cap, as before', async () => {
    const sent = await sentReply(false);
    const text = sent.map((b) => (b as { text?: string }).text ?? '').join('');
    assert.ok(text.length < 60_000, `sent ${text.length} characters`);
    assert.match(text, /\[truncated — original was \d+ tokens\]$/);
  });
});
