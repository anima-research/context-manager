import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextLog, MessageStore, jsonTokenEstimator } from '../src/index.js';

type Estimate = (content: ContentBlock[]) => number;

class Unbound extends AutobiographicalStrategy {
  price(content: ContentBlock[]): number { return this.estimateTokens(content); }
}

class Compressing extends AutobiographicalStrategy {
  sent(content: ContentBlock[], ctx: never): number { return this.sentTokensOf(content, ctx); }
  prepared(content: ContentBlock[], ctx: never): number { return this.preparedTokensOf(content, ctx); }
}

const PATHS: Array<{ name: string; open(store: JsStore): Estimate }> = [
  {
    name: 'MessageStore.estimateTokens',
    open(store) {
      MessageStore.register(store);
      const messages = new MessageStore(store);
      return (content) => messages.estimateTokens({ content } as never);
    },
  },
  {
    name: 'ContextLogView.estimateTokens',
    open(store) {
      ContextLog.register(store);
      const log = new ContextLog(store).createView();
      return (content) => log.estimateTokens({ index: 0, participant: 'agent', content });
    },
  },
  {
    name: "the strategy's estimate before a view is bound",
    open() {
      const strategy = new Unbound({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, compressionModel: 'mock' });
      return (content) => strategy.price(content);
    },
  },
];

const carrier = (rawItem: Record<string, unknown>): ContentBlock => ({ type: 'text', text: '', rawItem }) as unknown as ContentBlock;

const COMPACTION = { type: 'compaction', id: 'cmp_1', encrypted_content: 'E'.repeat(6_000) };
const COMPACTION_PRICE = jsonTokenEstimator(JSON.stringify({ type: 'compaction', id: 'cmp_1' })) + 1_000;

const SEARCH_RESULT = {
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: [
    { type: 'web_search_result', url: 'https://example.org/a', title: 'A', encrypted_content: 'x'.repeat(2_800), page_age: null },
    { type: 'web_search_result', url: 'https://example.org/b', title: 'B', encrypted_content: 'y'.repeat(1_400) },
  ],
};
const SEARCH_RESULT_PRICE = jsonTokenEstimator(JSON.stringify({
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: [
    { type: 'web_search_result', url: 'https://example.org/a', title: 'A', page_age: null },
    { type: 'web_search_result', url: 'https://example.org/b', title: 'B' },
  ],
})) + 1_500;

const SERVER_TOOL_USE = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'okaukuejo waterhole' } };
const SEARCH_ERROR = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } };
const HOSTED_CALL = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'etosha' } };

for (const path of PATHS) {
  describe(`zero-width carriers priced as their items: ${path.name}`, () => {
    let dir: string;
    let store: JsStore;
    let estimate: Estimate;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'opaque-carrier-tokens-'));
      store = JsStore.openOrCreate({ path: join(dir, 'store') });
      estimate = path.open(store);
    });

    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('prices a compaction item as its fields plus its ciphertext at the encrypted carrier rate', () => {
      assert.strictEqual(MessageStore.ENCRYPTED_CARRIER_CHARS_PER_TOKEN, 6, 'premise: the rate the expected price uses');
      assert.strictEqual(estimate([carrier(COMPACTION)]), COMPACTION_PRICE);
    });

    it("prices a web search's results as their fields plus their ciphertext at its own rate", () => {
      assert.strictEqual(MessageStore.WEB_SEARCH_RESULT_CIPHERTEXT_CHARS_PER_TOKEN, 2.8, 'premise: the rate the expected price uses');
      assert.strictEqual(estimate([carrier(SEARCH_RESULT)]), SEARCH_RESULT_PRICE);
    });

    it('prices a server tool call, a search error and a hosted call as their JSON', () => {
      for (const item of [SERVER_TOOL_USE, SEARCH_ERROR, HOSTED_CALL]) {
        assert.strictEqual(estimate([carrier(item)]), jsonTokenEstimator(JSON.stringify(item)), String(item.type));
      }
    });

    it('prices a message item\'s text part by its text, as before', () => {
      const part = { type: 'text', text: 'First answer.', rawItem: { type: 'message', id: 'msg_1', content: [] } } as unknown as ContentBlock;
      assert.strictEqual(estimate([part]), estimate([{ type: 'text', text: 'First answer.' }]));
      assert.ok(estimate([part]) > 0);
    });

    it('prices a text block whose raw item is no object by its text, as before', () => {
      const odd = { type: 'text', text: 'plain words', rawItem: 'not an item' } as unknown as ContentBlock;
      assert.strictEqual(estimate([odd]), estimate([{ type: 'text', text: 'plain words' }]));
      assert.ok(estimate([odd]) > 0);
    });
  });
}

describe('zero-width carriers in a stored message', () => {
  let dir: string;
  let store: JsStore;
  let messages: MessageStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opaque-carrier-message-'));
    store = JsStore.openOrCreate({ path: join(dir, 'store') });
    MessageStore.register(store);
    messages = new MessageStore(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds each carrier to its message, and a carrier inside a tool result too', () => {
    const answer: ContentBlock = { type: 'text', text: 'First answer.' };
    const nested = { type: 'tool_result', toolUseId: 't1', content: [carrier(HOSTED_CALL)] } as unknown as ContentBlock;
    const without = messages.estimateTokens({ content: [answer] } as never);
    assert.strictEqual(
      messages.estimateTokens({ content: [carrier(COMPACTION), answer, nested] } as never),
      without + COMPACTION_PRICE + jsonTokenEstimator(JSON.stringify(HOSTED_CALL)),
    );
  });

  it('prices a compression request without the carriers it never sends', () => {
    const strategy = new Compressing({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, compressionModel: 'mock' });
    const ctx = { messageStore: messages } as never;
    const answer: ContentBlock = { type: 'text', text: 'word '.repeat(200) };
    assert.ok(strategy.sent([answer], ctx) > 0 && strategy.prepared([answer], ctx) > 0, 'premise: the answer itself has a price');
    for (const item of [COMPACTION, SEARCH_RESULT, HOSTED_CALL]) {
      assert.strictEqual(strategy.sent([carrier(item), answer], ctx), strategy.sent([answer], ctx), `sentTokensOf, ${String(item.type)}`);
      assert.strictEqual(strategy.prepared([carrier(item), answer], ctx), strategy.prepared([answer], ctx), `preparedTokensOf, ${String(item.type)}`);
    }
  });
});
