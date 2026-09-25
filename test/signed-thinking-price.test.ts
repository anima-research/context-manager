/**
 * Signed thinking blocks are priced by their signature, never by a flat
 * constant. On keep-all models every prior thinking block is replayed as
 * input at the size of the hidden chain of thought; the signature is the
 * only client-side trace of that size, and a stamped `tokenEstimate` (from
 * the response usage at creation) is exact and wins.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '../src/index.js';

const TEST_STORE_PATH = './test-signed-thinking-price';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

function openStore(): MessageStore {
  const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
  try { MessageStore.register(store); } catch {}
  return new MessageStore(store);
}

function msg(content: ContentBlock[]): StoredMessage {
  return { id: 'm', role: 'assistant', content, timestamp: Date.now() } as unknown as StoredMessage;
}

const SIG_32K = 'A'.repeat(32_000); // a ~9.5k-token chain of thought on Opus 4.8

describe('signed thinking block pricing', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('prices a signed, text-empty block by signature length, not the flat default', () => {
    const messages = openStore();
    const est = messages.estimateTokens(msg([{ type: 'thinking', thinking: '', signature: SIG_32K } as ContentBlock]));
    assert.equal(est, MessageStore.signedThinkingTokens(SIG_32K));
    assert.ok(est > 8_000 && est < 12_000, `expected ~9.7k tokens, got ${est}`);
    assert.notEqual(est, MessageStore.HIDDEN_THINKING_TOKENS_DEFAULT);
  });

  it('a stamped tokenEstimate wins over the signature', () => {
    const messages = openStore();
    const block = { type: 'thinking', thinking: '', signature: SIG_32K, tokenEstimate: 9428 } as unknown as ContentBlock;
    assert.equal(messages.estimateTokens(msg([block])), 9428);
  });

  it('summarized text under a long signature is priced by the signature', () => {
    const messages = openStore();
    const summary = 'The user asks for a proof; I check small cases first.';
    const est = messages.estimateTokens(msg([{ type: 'thinking', thinking: summary, signature: SIG_32K } as ContentBlock]));
    assert.equal(est, MessageStore.signedThinkingTokens(SIG_32K));
  });

  it('full visible text under a short signature is priced by the text (older models)', () => {
    const messages = openStore();
    const text = 'x'.repeat(20_000);
    const shortSig = 'S'.repeat(200);
    const est = messages.estimateTokens(msg([{ type: 'thinking', thinking: text, signature: shortSig } as ContentBlock]));
    assert.ok(est > MessageStore.signedThinkingTokens(shortSig));
    assert.equal(est, messages.estimateTokens(msg([{ type: 'thinking', thinking: text } as ContentBlock])));
  });

  it('a tiny signature prices as a tiny block — no 600-token floor', () => {
    const messages = openStore();
    const est = messages.estimateTokens(msg([{ type: 'thinking', thinking: '', signature: 'S'.repeat(540) } as ContentBlock]));
    assert.ok(est < MessageStore.HIDDEN_THINKING_TOKENS_DEFAULT, `got ${est}`);
    assert.ok(est > 0);
  });

  it('scales with the calibration multiplier like every other block', () => {
    const messages = openStore();
    const base = messages.estimateTokens(msg([{ type: 'thinking', thinking: '', signature: SIG_32K } as ContentBlock]));
    messages.setTokenCalibration(1.5);
    const scaled = messages.estimateTokens(msg([{ type: 'thinking', thinking: '', signature: SIG_32K } as ContentBlock]));
    assert.equal(scaled, Math.round(base * 1.5));
  });
});
