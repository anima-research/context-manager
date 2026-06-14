/**
 * Regression: image stripping must run BEFORE the render-stats snapshot is
 * committed and BEFORE cache markers are placed, so that
 *
 *   (a) RenderStats.total reflects the POST-strip context — the real bytes the
 *       agent receives — not the pre-strip size that still counts full image
 *       weight (≈1600 tok) for images replaced by a short text placeholder.
 *       Pre-fix, getRenderStats() over-reported by ~1592 tok per stripped image
 *       (and image stripping is on by default: maxLiveImages = 6).
 *
 *   (b) cache markers and stripping coexist cleanly: marker positions are
 *       structural (content-independent, so deterministic across recompiles)
 *       and a stripped image never resurrects across turns — the live-image
 *       window is monotonic, so each image strips at most once (one bounded KV
 *       perturbation, not per-turn flicker).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-image-strip-render-stats';
const PLACEHOLDER = 'image dropped from live context';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

/** A message carrying one image plus a text label so we can locate it later. */
function imageMessage(label: string, tokenEstimate = 1600): ContentBlock[] {
  return [
    { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' }, tokenEstimate } as ContentBlock,
    { type: 'text', text: label },
  ];
}

/** Re-derive rendered tokens from the COMPILED output using the strategy's
 *  default estimator (image -> tokenEstimate ?? 1600, text -> ceil(len/4)).
 *  The fixtures use only image + text blocks. */
function renderedTokens(messages: { content: ContentBlock[] }[]): number {
  let t = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'image') t += (b as { tokenEstimate?: number }).tokenEstimate ?? 1600;
      else if (b.type === 'text') t += Math.ceil(b.text.length / 4);
    }
  }
  return t;
}

function hasLabel(content: ContentBlock[], label: string): boolean {
  return content.some((b) => b.type === 'text' && b.text.includes(label));
}

describe('image stripping × render stats', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('(a) total reflects the post-strip size, not the pre-strip image weight', async () => {
    // Default live-image policy is ON (maxLiveImages: 6). 10 images => 4 stripped.
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 1_000_000, // keep everything verbatim; isolate the count cap
      }),
    });
    for (let i = 1; i <= 10; i++) manager.addMessage('user', imageMessage(`img-${String(i).padStart(2, '0')}`));
    const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });

    const live = compiled.messages.filter((m) => m.content.some((b) => b.type === 'image')).length;
    const stripped = compiled.messages.filter((m) => hasLabel(m.content, PLACEHOLDER)).length;
    assert.equal(live, 6, 'default maxLiveImages keeps 6 images live');
    assert.equal(stripped, 4, 'the other 4 are stripped to placeholders');

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present after compile');

    // Decisive assertion: total == the ACTUAL rendered size. Pre-fix this was
    // inflated by the 4 stripped images (~4 * 1592 tok).
    const expected = renderedTokens(compiled.messages);
    assert.equal(rs!.total.tokens, expected, 'total.tokens equals the real rendered size');

    // Internal invariant must still hold (total == sum of buckets).
    const s = rs!.summaries;
    const bucketSum =
      rs!.head.tokens + rs!.tail.tokens + rs!.middleRaw.tokens +
      s.l1.tokens + s.l2.tokens + s.l3.tokens;
    assert.equal(rs!.total.tokens, bucketSum, 'total == sum of buckets');
    for (const k of ['head', 'tail', 'middleRaw'] as const) {
      assert.ok(rs![k].tokens >= 0, `${k} tokens stay non-negative after the strip credit`);
    }

    // And total must be strictly below the pre-strip size — proves the credit bites.
    const preStrip = expected + stripped * (1600 - Math.ceil('[image dropped from live context]'.length / 4));
    assert.ok(rs!.total.tokens < preStrip, 'total is the stripped size, not the pre-strip size');

    manager.close();
  });

  it('(b) cache markers coexist with stripping; stripped images never resurrect', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 1_000_000,
        maxLiveImages: 3,
        imageStripDepthTokens: 0, // isolate the count cap
      }),
    });
    for (let i = 1; i <= 6; i++) manager.addMessage('user', imageMessage(`img-${String(i).padStart(2, '0')}`));

    const c1 = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    const markers1 = c1.messages.flatMap((m, i) => ((m as { cacheBreakpoint?: boolean }).cacheBreakpoint ? [i] : []));
    const stripped1 = c1.messages.filter((m) => hasLabel(m.content, PLACEHOLDER)).length;

    assert.ok(markers1.length > 0, 'cache markers are placed');
    assert.equal(stripped1, 3, 'oldest 3 of 6 images stripped under maxLiveImages:3');

    // Re-compile the SAME store: marker placement is structural (head/tail
    // membership + index), so positions are identical even though stripping
    // mutated content. Guards against a future token-sensitive marker pass
    // being fed pre-strip sizes.
    const c1b = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    const markers1b = c1b.messages.flatMap((m, i) => ((m as { cacheBreakpoint?: boolean }).cacheBreakpoint ? [i] : []));
    assert.deepEqual(markers1b, markers1, 'marker positions are deterministic across recompiles');

    // Cross-turn: append a new image so the live window slides forward. Images
    // that were already stripped must STAY stripped — monotonic, no flicker
    // that would churn the cached prefix turn-to-turn.
    manager.addMessage('user', imageMessage('img-07'));
    const c2 = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    for (const label of ['img-01', 'img-02', 'img-03']) {
      const e = c2.messages.find((m) => hasLabel(m.content, label));
      assert.ok(e, `${label} still present`);
      assert.ok(!e!.content.some((b) => b.type === 'image'), `${label} stays stripped after a new turn`);
    }

    manager.close();
  });
});
