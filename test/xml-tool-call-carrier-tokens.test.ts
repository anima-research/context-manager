/**
 * Membrane's XML-history carriers are priced, not counted as 0.
 *
 * With membrane#101, XML tool mode keeps two non-prose blocks in history: a
 * `tool_attempt` (the model's own tool-call block that dispatched nothing,
 * replayed verbatim) and a `tool_notice` (the harness's notice about refused
 * or warned invokes, replayed as `<tool_call_notice>` elements). Both reach
 * the provider as text. The store's estimator fell through to its default for
 * unknown blocks and priced them at 0, so a history of refused attempts
 * compiled as free and could carry the request past its budget.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore, jsonTokenEstimator } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE_PATH = './test-xml-tool-call-carrier-tokens';

function cleanup(): void {
  if (existsSync(STORE_PATH)) rmSync(STORE_PATH, { recursive: true, force: true });
}

function openMessages(): MessageStore {
  cleanup();
  const store = JsStore.openOrCreate({ path: STORE_PATH });
  try {
    MessageStore.register(store);
  } catch {}
  return new MessageStore(store);
}

const CALLS_OPEN = '<' + 'function_calls>';
const CALLS_CLOSE = '</' + 'function_calls>';
const ATTEMPT_XML = `${CALLS_OPEN}<invoke name="board_update"><parameter name="item">${'x'.repeat(400)}</antra:parameter></invoke>${CALLS_CLOSE}`;
const NOTICE = {
  invoke: 0,
  toolName: 'board_update',
  kind: 'refused',
  message: `the value of item contains the closing tag \`</antra:parameter>\`; nothing was sent. ${'y'.repeat(300)}`,
};

// Typed through `unknown`: the blocks are membrane#101's, and the store must
// price them whatever membrane version its own types come from.
const attempt = { type: 'tool_attempt', rawXml: ATTEMPT_XML } as unknown as ContentBlock;
const notice = { type: 'tool_notice', notices: [NOTICE] } as unknown as ContentBlock;

describe('XML-history carrier token estimates (membrane#101)', () => {
  after(cleanup);

  it('prices a tool_attempt as the markup it replays', () => {
    const messages = openMessages();
    const tokens = messages.estimateTokens({ content: [attempt] } as never);
    assert.strictEqual(tokens, jsonTokenEstimator(ATTEMPT_XML));
    assert.ok(tokens > 100);
  });

  it('prices a tool_notice as the notice elements it replays', () => {
    const messages = openMessages();
    const rendered =
      `<tool_call_notice invoke="0" tool="board_update" kind="refused">${NOTICE.message}</tool_call_notice>`;
    assert.strictEqual(messages.estimateTokens({ content: [notice] } as never), jsonTokenEstimator(rendered));
  });

  it('still prices an unrecognized block at 0', () => {
    const messages = openMessages();
    const unknown = { type: 'some_future_block', payload: 'z'.repeat(400) } as unknown as ContentBlock;
    assert.strictEqual(messages.estimateTokens({ content: [unknown] } as never), 0);
  });
});
