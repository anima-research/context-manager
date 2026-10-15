/**
 * imageStripHysteresisRatio (opt-in): a binding live-image limit trims down to
 * ratio × the limit and records a watermark, so the stripped set changes once
 * per trim instead of once per new image (each change invalidates the prompt
 * cache from that message on).
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-image-strip-hysteresis';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };

const img = (label: string, bytes = 4): ContentBlock[] => [
  { type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes), mediaType: 'image/png' }, tokenEstimate: 100 } as ContentBlock,
  { type: 'text', text: label },
];
// Initialization rebuilds under the live config. Enable the ratio after that
// rebuild so a dry call or observer, rather than initialization, reaches a trim.
class ImageRatioStrategy extends AutobiographicalStrategy {
  enableImageRatio(): void { this.config.imageStripHysteresisRatio = 0.5; }
}
const strategy = (extra: Record<string, unknown>) => new ImageRatioStrategy({
  headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, ...extra,
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);

function imagePattern(entries: { content: ContentBlock[] }[], n: number): string {
  let out = '';
  for (let i = 1; i <= n; i++) {
    const e = entries.find((x) => x.content.some((b) => b.type === 'text' && b.text === `img-${i}`));
    out += !e ? '-' : e.content.some((b) => b.type === 'image') ? 'I' : '.';
  }
  return out; // e.g. "...II": img-1..3 stripped, img-4..5 live; '-' is a message missing from the render
}

async function stripped(m: ContextManager, n: number): Promise<string> {
  const c = await m.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
  return imagePattern(c.messages, n);
}

describe('imageStripHysteresisRatio', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('count cap: trims to ratio × cap once, then leaves older messages alone until it binds again', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 4), 'IIII', 'under the cap: all live');
    m.addMessage('user', img('img-5'));
    assert.equal(await stripped(m, 5), '...II', 'cap binds: trim to 2');
    m.addMessage('user', img('img-6'));
    assert.equal(await stripped(m, 6), '...III', 'room left: nothing older changes');
    m.addMessage('user', img('img-7'));
    assert.equal(await stripped(m, 7), '...IIII');
    m.addMessage('user', img('img-8'));
    assert.equal(await stripped(m, 8), '......II', 'binds again: one more trim');
    await m.close();
  });

  it('the watermark survives a reopen (a restart renders the same stripped set)', async () => {
    let m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
    const before = await stripped(m, 6);
    await m.close();
    m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    assert.equal(await stripped(m, 6), before);
    await m.close();
  });

  it('byte cap works the same way', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImageBytes: 400, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`, 100));
    assert.equal(await stripped(m, 4), 'IIII');
    m.addMessage('user', img('img-5', 100));
    assert.equal(await stripped(m, 5), '...II', '500 > 400: trim to 200');
    m.addMessage('user', img('img-6', 100));
    assert.equal(await stripped(m, 6), '...III');
    await m.close();
  });

  describe('a dry select leaves the watermark as it found it', () => {
    // Node 20.0.0's runner doesn't apply the outer beforeEach to tests in a
    // nested describe, so these clear the store themselves.
    beforeEach(cleanup);
    // compile() and previewContext() reach the watermark through the adaptive
    // picker's post-strip estimates.
    const adaptive = (extra: Record<string, unknown> = {}) => strategy({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 4, imageStripHysteresisRatio: 0.5, ...extra,
    });
    const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };
    const slot = (m: ContextManager, s: AutobiographicalStrategy) =>
      JSON.stringify(m.getStore().getStateJson((s as unknown as { imageWatermarkStateId: string }).imageWatermarkStateId) ?? null);
    const previewed = (m: ContextManager, n: number, overrides: Record<string, unknown> = { maxLiveImages: 2 }) => {
      const entries = m.previewContext(BUDGET, overrides, { render: true })?.entries ?? [];
      assert.ok(entries.length > 0, 'the preview rendered its entries');
      return imagePattern(entries, n);
    };

    it('a stricter preview changes neither the next live compile nor the stored watermark', async () => {
      const s = adaptive();
      const m = await ContextManager.open({ path: STORE, strategy: s });
      for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 4), 'IIII');
      const before = slot(m, s);
      assert.equal(previewed(m, 4), '...I', 'the preview renders its own trim');
      assert.equal(slot(m, s), before, 'the preview writes nothing');
      assert.equal(await stripped(m, 4), 'IIII', 'the live compile keeps what it kept');
      await m.close();
    });

    it('a preview that turns the ratio off prices images as a store without it does, even after a live compile', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 6), '...III', 'the live compile prices images under ratio 0.5');
      const warm = m.previewContext(BUDGET, { imageStripHysteresisRatio: 0 }, { render: true });
      assert.equal(imagePattern(warm?.entries ?? [], 6), '..IIII', 'the warm ratio-off preview renders four live images');
      await m.close();
      const off = await ContextManager.open({ path: STORE + '-off', strategy: strategy({
        hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
        autoTickOnNewMessage: false, maxLiveImages: 4,
      }) });
      try {
        for (let i = 1; i <= 6; i++) off.addMessage('user', img(`img-${i}`));
        assert.equal(await stripped(off, 6), '..IIII');
        const cold = off.previewContext(BUDGET, undefined, { render: true });
        assert.equal(warm?.finalTokens, cold?.finalTokens);
        assert.equal(imagePattern(warm?.entries ?? [], 6), imagePattern(cold?.entries ?? [], 6));
      } finally {
        await off.close();
        rmSync(STORE + '-off', { recursive: true, force: true });
      }
    });

    it('a store opened with the ratio off keeps its stored watermark through previews that turn the ratio on', async () => {
      const first = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 6; i++) first.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(first, 6), '...III');
      await first.close();
      // Opened with the ratio off, nothing loads the stored watermark: the
      // first preview that turns the ratio on is the one that loads it.
      const m = await ContextManager.open({ path: STORE, strategy: strategy({
        hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
        autoTickOnNewMessage: false, maxLiveImages: 10,
      }) });
      try {
        assert.equal(previewed(m, 6, { imageStripHysteresisRatio: 0.5 }), '...III');
        assert.equal(previewed(m, 6, { imageStripHysteresisRatio: 0.5 }), '...III', 'the second preview finds the stored watermark too');
      } finally {
        await m.close();
      }
    });

    // Write with the ratio off: onNewMessage's live rebuild must not already
    // have performed the trim that the following dry or observer call probes.
    const seedUntrimmed = async (path: string) => {
      const m = await ContextManager.open({ path, strategy: adaptive({ imageStripHysteresisRatio: 0 }) });
      try {
        for (let i = 1; i <= 6; i++) m.addMessage('user', img('img-' + i));
      } finally {
        await m.close();
      }
    };
    const watermark = (s: AutobiographicalStrategy) =>
      (s as unknown as { _imageWatermark: number | undefined })._imageWatermark;

    it('a dry compile without an expired hold renders its trim but leaves the watermark and slot unchanged', async () => {
      await seedUntrimmed(STORE);
      const s = adaptive({ imageStripHysteresisRatio: 0 });
      const m = await ContextManager.open({ path: STORE, strategy: s });
      s.enableImageRatio();
      try {
        const before = slot(m, s);
        const beforeMark = watermark(s);
        assert.equal(before, 'null', 'the fixture has no committed trim');
        const dry = await m.compile(BUDGET, undefined, { dryRun: true });
        assert.equal(imagePattern(dry.messages, 6), '....II', 'the dry compile reaches its own trim');
        assert.equal(slot(m, s), before);
        assert.equal(watermark(s), beforeMark);
        const again = await m.compile(BUDGET, undefined, { dryRun: true });
        assert.equal(imagePattern(again.messages, 6), '....II', 'its restored memo permits the next dry trim');
      } finally {
        await m.close();
      }
    });

    it('a dry compile commits an expired hold release and the same watermark advance as a live compile', async () => {
      const results: Array<{ pattern: string; watermark: number | undefined; sequence: number }> = [];
      for (const dryRun of [true, false]) {
        const path = STORE + (dryRun ? '-dry-hold' : '-live-hold');
        await seedUntrimmed(path);
        let now = 1000;
        const s = adaptive({ imageStripHysteresisRatio: 0 });
        const m = await ContextManager.open({ path, strategy: s, now: () => now });
        s.enableImageRatio();
        try {
          assert.equal(slot(m, s), 'null');
          const id = m.getAllMessages()[0].id;
          m.holdCompression([id], { timeoutMs: 100 });
          now += 100;
          const compiled = await m.compile(BUDGET, undefined, { dryRun });
          // Read what compile left before anything else expires holds:
          // getCompressionHoldDetails releases an expired hold itself.
          const persisted = JSON.parse(slot(m, s));
          assert.ok(persisted && typeof persisted.sequence === 'number', 'compile released the expired hold and persisted its trim');
          assert.equal(watermark(s), persisted.sequence);
          assert.equal(m.getCompressionHoldDetails().size, 0, 'no hold is left');
          const pattern = imagePattern(compiled.messages, 6);
          assert.equal(pattern, '....II');
          results.push({ pattern, watermark: watermark(s), sequence: persisted.sequence });
        } finally {
          await m.close();
          rmSync(path, { recursive: true, force: true });
        }
      }
      assert.deepEqual(results[0], results[1], 'dry and live releases commit the same trim boundary');
    });

    it('a ratio-on preview after a warm ratio-off compile renders the same trim as a ratio-on compile', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive({ imageStripHysteresisRatio: 0 }) });
      let warmPattern: string;
      try {
        for (let i = 1; i <= 6; i++) m.addMessage('user', img('img-' + i));
        assert.equal(await stripped(m, 6), '..IIII', 'the live ratio-off compile fills the memo');
        warmPattern = previewed(m, 6, { imageStripHysteresisRatio: 0.5 });
        assert.equal(warmPattern, '....II', 'turning the ratio on must advance the preview watermark');
      } finally {
        await m.close();
      }
      const on = await ContextManager.open({ path: STORE, strategy: adaptive() });
      try {
        assert.equal(await stripped(on, 6), warmPattern);
      } finally {
        await on.close();
      }
    });

    it('render stats before a compile leave the watermark and its memo live state unchanged', async () => {
      await seedUntrimmed(STORE);
      const s = adaptive({ imageStripHysteresisRatio: 0 });
      const m = await ContextManager.open({ path: STORE, strategy: s });
      s.enableImageRatio();
      try {
        const before = slot(m, s);
        const beforeMark = watermark(s);
        const stats = m.getRenderStats();
        assert.ok(stats && stats.tail.messages === 6, 'the observer reconstructs a nonempty window');
        assert.equal(slot(m, s), before, 'an observer does not write the watermark slot');
        assert.equal(watermark(s), beforeMark, 'an observer does not leave its trim in memory');
        assert.equal(await stripped(m, 6), '....II', 'the observer cannot leave a memo that skips the next live advance');
        assert.notEqual(slot(m, s), before, 'the observer restored the write guard: a live compile persists its trim');
        assert.equal(previewed(m, 6, {}), '....II');
      } finally {
        await m.close();
      }
    });

    it('render stats preserve a stored watermark loaded for the first time by that observer', async () => {
      const first = await ContextManager.open({ path: STORE, strategy: adaptive() });
      try {
        for (let i = 1; i <= 6; i++) first.addMessage('user', img('img-' + i));
        assert.equal(await stripped(first, 6), '...III');
      } finally {
        await first.close();
      }
      const s = adaptive({ imageStripHysteresisRatio: 0, maxLiveImages: 10 });
      const m = await ContextManager.open({ path: STORE, strategy: s });
      s.enableImageRatio();
      try {
        const before = slot(m, s);
        assert.equal(watermark(s), undefined, 'ratio-off initialization has not loaded the persisted watermark');
        assert.ok(m.getRenderStats(), 'the observer reconstructs its window');
        assert.equal(watermark(s), JSON.parse(before).sequence, 'the observer loaded the stored watermark and left it as stored');
        assert.equal(slot(m, s), before);
        assert.equal(await stripped(m, 6), '...III', 'the next live compile retains the stored boundary');
      } finally {
        await m.close();
      }
    });

    it('an infeasible preview restores the live watermark and memo after its trim', async () => {
      const s = adaptive();
      const m = await ContextManager.open({ path: STORE, strategy: s });
      try {
        for (let i = 1; i <= 4; i++) m.addMessage('user', img('img-' + i));
        assert.equal(await stripped(m, 4), 'IIII');
        const before = slot(m, s);
        const beforeMark = watermark(s);
        const preview = m.previewContext({ maxTokens: 1, reserveForResponse: 0 }, { maxLiveImages: 2 }, { render: true });
        assert.ok(preview && !preview.fits, 'the preview reports its over-budget throw');
        assert.equal(slot(m, s), before);
        assert.equal(watermark(s), beforeMark);
        assert.equal(previewed(m, 4), '...I', 'the failed preview leaves no memo priced under its discarded trim');
        assert.equal(await stripped(m, 4), 'IIII');
      } finally {
        await m.close();
      }
    });

    it('the same preview twice renders the same images', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`));
      const withoutRatio = previewed(m, 4, { maxLiveImages: 2, imageStripHysteresisRatio: 0 });
      assert.equal(withoutRatio, '..II');
      const first = previewed(m, 4);
      assert.equal(first, '...I', 'the first preview trims to one live image, below the classic cap');
      assert.equal(previewed(m, 4), first);
      await m.close();
    });
  });

  it('off (default): the classic window slides one image at a time', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4 }) });
    for (let i = 1; i <= 5; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 5), '.IIII');
    m.addMessage('user', img('img-6'));
    assert.equal(await stripped(m, 6), '..IIII', 'img-2 changes: the per-image rewrite this option avoids');
    await m.close();
  });
});
