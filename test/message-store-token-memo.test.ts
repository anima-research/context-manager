import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/message-store.js';
import type { StoredMessage } from '../src/types/index.js';

const opened: Array<{ store: JsStore; path: string }> = [];
afterEach(() => {
  for (const { store, path } of opened.splice(0)) {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test('a block replaced inside the same content array is priced again', () => {
  const path = mkdtempSync(join(tmpdir(), 'cm-token-memo-'));
  const store = JsStore.openOrCreate({ path: join(path, 'store') });
  opened.push({ store, path });
  const messages = new MessageStore(store);
  const message: StoredMessage = {
    id: 'm1', sequence: 0, participant: 'user', content: [{ type: 'text', text: 'short' }], timestamp: new Date(),
  };
  const short = messages.estimateTokens(message);
  assert.equal(messages.estimateTokens(message), short, 'memo hit on the unchanged message');
  message.content[0] = { type: 'text', text: 'long '.repeat(1000) };
  const long = messages.estimateTokens(message);
  assert.ok(long > short, `replaced block must be priced: ${long} vs ${short}`);
  assert.equal(long, messages.estimateTokens({ ...message, content: [...message.content] }));
});
