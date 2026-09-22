/**
 * The strategy prices rendered bodies the way the store does. Under
 * carrierPolicy 'live-strip' the recall-pair price is the estimate alone (no
 * exact mint `tokens` floor), so a strategy-local chars/4 rule under-priced
 * dense summary prose by ~25-30% against count_tokens.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, MessageStore, defaultTokenEstimator } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const dir = mkdtempSync(join(tmpdir(), 'strategy-estimator-'));
after(() => rmSync(dir, { recursive: true, force: true }));

type Exposed = {
  estimateTokens(content: ContentBlock[]): number;
  _storeView: unknown;
};

const PROSE = 'The lighthouse keeper counted the ships that did not come. '.repeat(50); // ~2,950 chars
const SIG = 'A'.repeat(32_000);

describe('strategy estimator parity with the store', () => {
  it('fallback (no store bound) uses the store rates, not chars/4', () => {
    const s = new AutobiographicalStrategy({ compressionModel: 'mock' }) as unknown as Exposed;
    const est = s.estimateTokens([{ type: 'text', text: PROSE }]);
    assert.equal(est, defaultTokenEstimator(PROSE));
    assert.ok(est > Math.ceil(PROSE.length / 4), `chars/4 would be ${Math.ceil(PROSE.length / 4)}, got ${est}`);
  });

  it('fallback prices a signed thinking block by its signature', () => {
    const s = new AutobiographicalStrategy({ compressionModel: 'mock' }) as unknown as Exposed;
    const est = s.estimateTokens([{ type: 'thinking', thinking: '', signature: SIG } as ContentBlock]);
    assert.equal(est, MessageStore.signedThinkingTokens(SIG));
  });

  it('with a store bound, delegates to the calibrated store estimate', () => {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    try { MessageStore.register(store); } catch {}
    const messages = new MessageStore(store);
    messages.setTokenCalibration(1.5);
    const s = new AutobiographicalStrategy({ compressionModel: 'mock' }) as unknown as Exposed;
    s._storeView = messages.createView();
    const content: ContentBlock[] = [{ type: 'text', text: PROSE }, { type: 'thinking', thinking: '', signature: SIG } as ContentBlock];
    const est = s.estimateTokens(content);
    assert.equal(est, messages.estimateTokens({ content } as never));
    assert.equal(est, Math.round(defaultTokenEstimator(PROSE) * 1.5) + Math.round(MessageStore.signedThinkingTokens(SIG) * 1.5));
    store.close?.();
  });
});
