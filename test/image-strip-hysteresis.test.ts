/**
 * imageStripHysteresisRatio (opt-in): a binding live-image limit trims down to
 * ratio × the limit, so the stripped set changes once per trim instead of
 * once per new image (each change invalidates the prompt cache from that
 * message on). The set is a function of the stored messages and the limits:
 * they're replayed oldest first, with no stored state.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { MessageStoreView, StoredMessage } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-image-strip-hysteresis';
const cleanup = () => {
  for (const path of [STORE, `${STORE}-off`]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
};

// The store prices an image block at 1,600 tokens, so an image message with
// its label is 1,602.
const img = (label: string, bytes = 4): ContentBlock[] => [
  { type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes), mediaType: 'image/png' } } as ContentBlock,
  { type: 'text', text: label },
];
const images = (label: string, n: number): ContentBlock[] => [
  ...Array.from({ length: n }, () => ({ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } }) as ContentBlock),
  { type: 'text', text: label },
];
/** About `tokens` tokens of prose at the store's 2.9 characters a token. */
const prose = (label: string, tokens: number): ContentBlock[] => [{ type: 'text', text: `${label} ` + 'abcd'.repeat(Math.round(tokens * 2.9 / 4)) }];

// Initialization rebuilds under the live config. Enable the ratio after that
// rebuild so a dry call or observer, rather than initialization, meets it.
class ImageRatioStrategy extends AutobiographicalStrategy {
  enableImageRatio(): void { this.config.imageStripHysteresisRatio = 0.5; }
  configure(extra: Record<string, unknown>): void { Object.assign(this.config, extra); }
  replay(store: MessageStoreView): ReadonlyMap<string, number> | undefined { return this.imageStripReplay(store); }
  summaryCount(): number { return this.summaries.length; }
}
/** Stored image messages of 1,600 tokens each, for the rule read directly. */
const storedImages = (n: number) => Array.from({ length: n }, (_, k) => ({
  id: `m${k + 1}`, sequence: k + 1, participant: 'user', content: img(`img-${k + 1}`), timestamp: new Date(0),
}) as unknown as StoredMessage);
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
const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };
async function stripped(m: ContextManager, n: number): Promise<string> {
  return imagePattern((await m.compile(BUDGET)).messages, n);
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

  it('depth: a trim happens at the arrival that puts the oldest live image past the limit', async () => {
    // Image messages of 1,602 tokens and a depth of 5,000: the fourth puts the
    // first at 6,408, so the trim comes then, down to 2,500, which only the
    // newest fits. Without the ratio the fourth strips the first alone.
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripDepthTokens: 5000, imageStripHysteresisRatio: 0.5 }) });
    const seen: string[] = [];
    for (let i = 1; i <= 7; i++) {
      m.addMessage('user', img(`img-${i}`));
      seen.push(await stripped(m, i));
    }
    assert.deepEqual(seen, ['I', 'II', 'III', '...I', '...II', '...III', '......I']);
    await m.close();
    const off = await ContextManager.open({ path: `${STORE}-off`, strategy: strategy({ imageStripDepthTokens: 5000 }) });
    for (let i = 1; i <= 4; i++) off.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(off, 4), '.III', 'without the ratio, the window slides');
    await off.close();
  });

  it('a text message can be the arrival that trims: the set never keeps an image the depth limit strips', async () => {
    // Two image messages, then 3,000 tokens of text under a depth of 5,000:
    // the first image is at about 6,200, past it. Without the ratio the first
    // is stripped. With it, the text's arrival trims to 2,500: the first goes,
    // and the second, the newest, stays, since it fits the full 5,000.
    const on = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripDepthTokens: 5000, imageStripHysteresisRatio: 0.5 }) });
    const off = await ContextManager.open({ path: `${STORE}-off`, strategy: strategy({ imageStripDepthTokens: 5000 }) });
    for (const m of [on, off]) {
      m.addMessage('user', img('img-1'));
      m.addMessage('user', img('img-2'));
      assert.equal(await stripped(m, 2), 'II');
      m.addMessage('user', prose('later', 3000));
    }
    assert.equal(await stripped(off, 2), '.I');
    assert.equal(await stripped(on, 2), '.I');
    await on.close();
    await off.close();
  });

  it('a message with more images than the target keeps its newest ones (finding 2)', async () => {
    // Five 4-byte images, over a cap of 4 images or of 16 bytes.
    for (const limit of [{ maxLiveImages: 4 }, { maxLiveImageBytes: 16 }]) {
      cleanup();
      const m = await ContextManager.open({ path: STORE, strategy: strategy({ ...limit, imageStripHysteresisRatio: 0.5 }) });
      m.addMessage('user', images('img-1', 5));
      const message = (await m.compile(BUDGET)).messages.find((x) => x.content.some((b) => b.type === 'text' && b.text === 'img-1'))!;
      const kinds = message.content.filter((b) => b.type === 'image' || (b.type === 'text' && b.text !== 'img-1')).map((b) => b.type === 'image' ? 'I' : '.').join('');
      assert.equal(kinds, '...II', `five images over ${JSON.stringify(limit)}: trimmed one at a time to the target, the newest two`);
      await m.close();
    }
  });

  it('the newest image stays while it fits the full limits (findings 3 and 5)', async () => {
    let m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImageBytes: 400, imageStripHysteresisRatio: 0.5 }) });
    for (const [i, bytes] of [[1, 200], [2, 120], [3, 240]] as const) m.addMessage('user', img(`img-${i}`, bytes));
    assert.equal(await stripped(m, 3), '..I', 'the newest, 240 bytes, is over the 200 target but within the 400 limit');
    await m.close();
    cleanup();
    m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 1, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 3; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 3), '..I', 'maxLiveImages 1: the target is 0, and the newest stays');
    await m.close();
    cleanup();
    // A target that rounds to 0 is 0, not "no limit": 5 bytes × 0.1.
    m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImageBytes: 5, imageStripHysteresisRatio: 0.1 }) });
    for (let i = 1; i <= 3; i++) m.addMessage('user', img(`img-${i}`, 4));
    assert.equal(await stripped(m, 3), '..I');
    await m.close();
  });

  it("a depth trim leaves one message's images while they fit the full limits: stripping them can't lower the depth", async () => {
    // img-1, then img-2's three images, about 4,800 tokens, under a depth of
    // 5,000. img-2's arrival puts img-1 past it, and the trim to 2,500 takes
    // img-1. The rest are img-2's, all at its depth, within the full 5,000.
    const kinds = async (m: ContextManager) => {
      const compiled = await m.compile(BUDGET);
      const first = compiled.messages.find((x) => x.content.some((b) => b.type === 'text' && b.text === 'img-1'))!;
      const second = compiled.messages.find((x) => x.content.some((b) => b.type === 'text' && b.text === 'img-2'))!;
      const of = (x: { content: ContentBlock[] }) => x.content.filter((b) => b.type === 'image' || (b.type === 'text' && !/^img-/.test(b.text))).map((b) => b.type === 'image' ? 'I' : '.').join('');
      return `${of(first)} ${of(second)}`;
    };
    const on = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripDepthTokens: 5000, imageStripHysteresisRatio: 0.5 }) });
    const off = await ContextManager.open({ path: `${STORE}-off`, strategy: strategy({ imageStripDepthTokens: 5000 }) });
    for (const m of [on, off]) {
      m.addMessage('user', img('img-1'));
      m.addMessage('user', images('img-2', 3));
    }
    assert.equal(await kinds(off), '. III', 'without the ratio');
    assert.equal(await kinds(on), '. III');
    await on.close();
    await off.close();
  });

  it('the newest image goes when it alone is over a full limit', async () => {
    let m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImageBytes: 4, imageStripHysteresisRatio: 0.5 }) });
    m.addMessage('user', img('img-1', 8));
    assert.equal(await stripped(m, 1), '.', '8 bytes over a limit of 4');
    await m.close();
    cleanup();
    // One image message, about 1,602 tokens, then text that takes it past
    // the full depth of 3,000.
    m = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripDepthTokens: 3000, imageStripHysteresisRatio: 0.5 }) });
    m.addMessage('user', img('img-1'));
    assert.equal(await stripped(m, 1), 'I', 'within the full depth');
    m.addMessage('user', prose('later', 2000));
    assert.equal(await stripped(m, 1), '.', 'a text arrival takes it past the full depth');
    await m.close();
  });

  it('a byte limit of 0 is no byte limit under the ratio too', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, maxLiveImageBytes: 0, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 3; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 3), 'III');
    await m.close();
  });

  it('with one image a message, what the option keeps live is within what the limits alone keep live', async () => {
    // Within a message the two differ: the limits alone keep a message's
    // first images, and the rule its newest (finding 2's test above).
    const limits = { maxLiveImages: 5, maxLiveImageBytes: 900, imageStripDepthTokens: 9000 };
    const on = await ContextManager.open({ path: STORE, strategy: strategy({ ...limits, imageStripHysteresisRatio: 0.6 }) });
    const off = await ContextManager.open({ path: `${STORE}-off`, strategy: strategy(limits) });
    const sizes = [100, 300, 50, 250, 200, 120, 40, 300, 90, 180, 60, 220];
    for (let i = 1; i <= sizes.length; i++) {
      for (const m of [on, off]) {
        m.addMessage('user', img(`img-${i}`, sizes[i - 1]!));
        if (i % 3 === 0) m.addMessage('user', prose(`t-${i}`, 700));
      }
      const a = await stripped(on, i), b = await stripped(off, i);
      for (let k = 0; k < i; k++) assert.ok(a[k] !== 'I' || b[k] === 'I', `step ${i}: image ${k + 1} is live with the option (${a}) but not without it (${b})`);
    }
    await on.close();
    await off.close();
  });

  it('a reopen, a fork and a preview at the same point give the same set (findings 1 and 6)', async () => {
    const adaptiveOn = () => strategy({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 4, imageStripHysteresisRatio: 0.5,
    });
    let m = await ContextManager.open({ path: STORE, strategy: adaptiveOn() });
    for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
    const live = await stripped(m, 6);
    assert.equal(live, '...III');
    assert.equal(imagePattern(m.previewContext(BUDGET, undefined, { render: true })?.entries ?? [], 6), live, 'a preview');
    await m.fork('zz-elsewhere');
    assert.equal(await stripped(m, 6), live, 'a fork at the same point');
    await m.close();
    m = await ContextManager.open({ path: STORE, strategy: adaptiveOn() });
    assert.equal(await stripped(m, 6), live, 'a reopen');
    await m.close();
  });

  it('switching the option on later gives the set it would have had from the start (finding 6)', async () => {
    let m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4 }) });
    for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 6), '..IIII', 'without the option: the newest four');
    await m.close();
    m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    assert.equal(await stripped(m, 6), '...III', 'as the count-cap test has it after six arrivals');
    await m.close();
  });

  it('nothing is stored for it, and a store an earlier version left a watermark in reads the stored messages alone', async () => {
    let m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    const states = () => m.getStore().listStates().map((state) => state.id).sort();
    const before = states();
    for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
    await stripped(m, 6);
    assert.deepEqual(states().filter((id) => id.includes('imageStrip')), [], 'no image-strip slot');
    assert.deepEqual(before.filter((id) => id.includes('imageStrip')), []);
    // The slot an earlier version wrote, at the sixth image: read, it would
    // strip past the rule's set.
    m.getStore().setStateJson('default/autobio:imageStripWatermark', { sequence: m.getAllMessages()[5]!.sequence, at: 0 });
    await m.close();
    m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    assert.equal(await stripped(m, 6), '...III', 'the old watermark is not read');
    await m.close();
  });

  it('a fold moves nothing: compressing older text-only messages leaves the set as it was', async () => {
    const membrane = {
      complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: '[mock summary] ' + 'x '.repeat(40) }], usage: { input_tokens: 100, output_tokens: 25 } }),
    } as never;
    let calls = 0;
    const counting = { complete: async (...args: unknown[]) => { calls++; return (membrane as { complete: (...a: unknown[]) => unknown }).complete(...args); } } as never;
    const s = new ImageRatioStrategy({
      compressionModel: 'mock', targetChunkTokens: 1500, headWindowTokens: 0, recentWindowTokens: 9000,
      hierarchical: true, imageStripDepthTokens: 6000, imageStripHysteresisRatio: 0.5,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    const m = await ContextManager.open({ path: STORE, strategy: s, membrane: counting });
    for (let k = 0; k < 10; k++) { m.addMessage('user', prose(`old-${k}`, 800)); await m.compile(BUDGET); }
    const gaps = [400, 1600, 400, 1400, 300];
    for (let i = 1; i <= 6; i++) {
      m.addMessage('user', img(`img-${i}`));
      if (i < 6) m.addMessage('user', prose(`t${i}`, gaps[i - 1]!));
      await m.compile(BUDGET);
    }
    const before = await stripped(m, 6);
    const summaries = s.summaryCount();
    for (let k = 0; k < 500 && !m.isReady(); k++) await m.tick();
    assert.ok(calls > 0 && s.summaryCount() > summaries, `the older messages were compressed (${summaries} summaries, then ${s.summaryCount()})`);
    assert.equal(await stripped(m, 6), before);
    await m.close();
  });

  it('a removal replays a different history: it can strip an image newer than the change, as the doc says', async () => {
    // Text between the images (tokens): t1 400, t2 1600, t3 400, t4 1400, t5 300.
    // With it, img-5 and img-6 are live; without t4, the trim that img-6's
    // arrival makes reaches img-5, whose own depth didn't change.
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripDepthTokens: 6000, imageStripHysteresisRatio: 0.5 }) });
    const ids: Record<string, string> = {};
    ids.t0 = m.addMessage('user', prose('t0', 1000));
    const gaps = [400, 1600, 400, 1400, 300];
    for (let i = 1; i <= 6; i++) {
      m.addMessage('user', img(`img-${i}`));
      if (i < 6) ids[`t${i}`] = m.addMessage('user', prose(`t${i}`, gaps[i - 1]!));
    }
    assert.equal(await stripped(m, 6), '....II');
    m.removeMessage(ids.t4! as never);
    assert.equal(await stripped(m, 6), '.....I');
    m.removeMessage(ids.t0! as never);
    assert.equal(await stripped(m, 6), '.....I', 'text older than every image changes nothing');
    await m.close();
  });

  it('depth is counted at the store\'s calibrated estimates, so a calibration change can move the set, as the doc says', () => {
    // Three image messages of 1,600 tokens under a depth of 5,000: at
    // calibration 1 the oldest is at 4,800, within it; at 1.1 it is at 5,280,
    // past it, and the trim to 2,500 keeps only the newest.
    const s = strategy({ imageStripDepthTokens: 5000, imageStripHysteresisRatio: 0.5 });
    const messages = [1, 2, 3].map((i) => ({ id: `m${i}`, sequence: i, participant: 'user', content: img(`img-${i}`), timestamp: new Date(0) }) as unknown as StoredMessage);
    const view = (calibration: number) => ({
      getAll: () => messages,
      estimateTokens: () => Math.round(1600 * calibration),
      getTokenCalibration: () => calibration,
    }) as unknown as MessageStoreView;
    assert.deepEqual([...(s.replay(view(1)) ?? new Map())], []);
    assert.deepEqual([...(s.replay(view(1.1)) ?? new Map())], [['m1', 1], ['m2', 1]]);
  });

  it('over the same stored messages, the set follows each limit and the ratio, and is worked out once per change', () => {
    const s = strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 });
    const messages = storedImages(6);
    let estimates = 0;
    const view = { getAll: () => messages, estimateTokens: () => { estimates++; return 1600; }, getTokenCalibration: () => 1 } as unknown as MessageStoreView;
    const strippedIds = () => [...(s.replay(view) ?? new Map()).keys()].join(' ');
    assert.equal(strippedIds(), 'm1 m2 m3', 'a cap of 4 at 0.5: the fifth trims to 2');
    estimates = 0;
    assert.equal(strippedIds(), 'm1 m2 m3');
    assert.equal(estimates, 0, 'a second read of the same listing estimates nothing');
    // One knob at a time, each changing the answer.
    s.configure({ imageStripHysteresisRatio: 0.75 });
    assert.equal(strippedIds(), 'm1 m2', 'at 0.75 the fifth trims to 3');
    assert.equal(estimates, 6, 'a change works the set out again');
    s.configure({ maxLiveImages: 2 });
    assert.equal(strippedIds(), 'm1 m2 m3 m4', 'a cap of 2 trims to 1 at the third and the fifth');
    s.configure({ maxLiveImageBytes: 6 });
    assert.equal(strippedIds(), 'm1 m2 m3 m4 m5', '6 bytes: every arrival after the first trims to the newest');
    s.configure({ imageStripDepthTokens: 1000 });
    assert.equal(strippedIds(), 'm1 m2 m3 m4 m5 m6', 'a depth of 1,000: even the newest is past it');
  });

  it("the set counts the images each message's cut sends, and follows the cut's cap and the tool pruning over the same stored messages", () => {
    /** A cut that sends every tool result as text alone. */
    class CutsResults extends ImageRatioStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        return maxTokens > 0
          ? content.map((b) => (b.type === 'tool_result' ? { ...b, content: [{ type: 'text', text: 'cut' }] } as ContentBlock : b))
          : content;
      }
    }
    const s = new CutsResults({
      headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, maxLiveImages: 4, imageStripHysteresisRatio: 0.5,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    // Five tool rounds, each result holding one image.
    const messages = [1, 2, 3, 4, 5].flatMap((k) => [
      { id: `call-${k}`, sequence: 2 * k, participant: 'Claude', content: [{ type: 'tool_use', id: `t-${k}`, name: 'shot', input: {} }], timestamp: new Date(0) },
      { id: `result-${k}`, sequence: 2 * k + 1, participant: 'User', content: [{ type: 'tool_result', toolUseId: `t-${k}`, toolName: 'shot', content: img(`h-${k}`) }], timestamp: new Date(0) },
    ]) as unknown as StoredMessage[];
    const view = { getAll: () => messages, estimateTokens: () => 100, getTokenCalibration: () => 1 } as unknown as MessageStoreView;
    const strippedIds = () => [...(s.replay(view) ?? new Map()).keys()].join(' ');
    assert.equal(strippedIds(), 'result-1 result-2 result-3', 'five nested images over a cap of 4 trim to 2');
    // One knob at a time, each changing the answer.
    s.configure({ maxMessageTokens: 1000 });
    assert.equal(strippedIds(), '', 'the cut sends no image');
    s.configure({ maxMessageTokens: undefined });
    assert.equal(strippedIds(), 'result-1 result-2 result-3');
    s.configure({ toolResultMaxLastN: { shot: 4 } });
    assert.equal(strippedIds(), '', 'the oldest result goes as its marker, and four images fit the cap of 4');
  });

  it('a reopen with a saved calibration renders the set at that calibration, though initialization prices before it loads', async () => {
    // Three image messages under a depth of 5,000: at multiplier 1 the oldest
    // is at about 4,800, within it; at a saved 1.1, at about 5,290, past it,
    // and the trim to 2,500 keeps only the newest.
    const adaptiveOn = () => strategy({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, imageStripDepthTokens: 5000, imageStripHysteresisRatio: 0.5,
    });
    let s = adaptiveOn();
    let m = await ContextManager.open({ path: STORE, strategy: s });
    for (let i = 1; i <= 3; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 3), 'III', 'at multiplier 1');
    const stateId = (s as unknown as { calibrationStateId: string }).calibrationStateId;
    m.getStore().setStateJson(stateId, {
      multiplier: 1.1, pricing: (AutobiographicalStrategy as unknown as { CALIBRATION_PRICING_EPOCH: number }).CALIBRATION_PRICING_EPOCH,
    });
    await m.close();
    s = adaptiveOn();
    m = await ContextManager.open({ path: STORE, strategy: s });
    assert.equal(imagePattern(m.previewContext(BUDGET, undefined, { render: true })?.entries ?? [], 3), '..I', 'a preview first after the reopen');
    assert.equal(await stripped(m, 3), '..I', 'the compile after it');
    await m.close();
  });

  /** The render's own size, at the store's prices, against its render stats. */
  async function pricedAsRendered(m: ContextManager): Promise<{ total: number; tokens: number; live: string }> {
    const compiled = await m.compile(BUDGET);
    let tokens = 0;
    for (const message of compiled.messages) {
      for (const b of message.content) tokens += b.type === 'image' ? 1600 : b.type === 'text' ? Math.ceil(b.text.length / 2.9) : 0;
    }
    const live = compiled.messages.map((x) => x.content.filter((b) => b.type === 'image').length).join('');
    return { total: m.getRenderStats()!.total.tokens, tokens, live };
  }
  const adaptiveImages = (extra: Record<string, unknown> = {}) => ({
    adaptiveResolution: true, headWindowTokens: 0, recentWindowTokens: 1_000_000,
    maxLiveImages: 4, imageStripHysteresisRatio: 0.5, imageStripDepthTokens: 0, ...extra,
  }) as ConstructorParameters<typeof AutobiographicalStrategy>[0];

  it('the budget prices what the render strips, a message stripped in part or whole', async () => {
    // Five images in one message under a cap of 4 trim to its newest 2; one
    // more image fits, and three more trim again, taking the rest of it.
    for (const [more, live] of [[1, '21'], [3, '0011']] as const) {
      const m = await ContextManager.open({ path: STORE, strategy: new AutobiographicalStrategy(adaptiveImages()) });
      m.addMessage('user', images('img-1', 5));
      for (let i = 2; i <= 1 + more; i++) m.addMessage('user', img(`img-${i}`));
      const r = await pricedAsRendered(m);
      assert.equal(r.live, live);
      assert.ok(Math.abs(r.total - r.tokens) <= Math.max(16, r.tokens * 0.01), `render stats ${r.total} against the rendered ${r.tokens}`);
      await m.close();
      cleanup();
    }
  });

  for (const hierarchical of [true, false]) {
    it(`a tool result that pairing repair moves up keeps its own message's count (${hierarchical ? 'hierarchical' : 'adaptive'})`, async () => {
      // Result a holds image A, ahead of image B in its message. Under a cap
      // of 1 the rule strips that message's first image, A, and keeps B.
      // Pairing repair moves result a up beside result b, so the entries
      // meet B first, in an entry of its own.
      const image = (data: string): ContentBlock => ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } }) as ContentBlock;
      const m = await ContextManager.open({
        path: STORE,
        strategy: new AutobiographicalStrategy({
          headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical, adaptiveResolution: !hierarchical,
          imageStripDepthTokens: 0, maxLiveImages: 1, imageStripHysteresisRatio: 0.5,
        } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
      });
      m.addMessage('Claude', [{ type: 'tool_use', id: 'a', name: 'shot', input: {} }, { type: 'tool_use', id: 'b', name: 'shot', input: {} }] as ContentBlock[]);
      m.addMessage('User', [{ type: 'tool_result', toolUseId: 'b', content: [{ type: 'text', text: 'result b' }] }] as unknown as ContentBlock[]);
      m.addMessage('User', [{ type: 'tool_result', toolUseId: 'a', content: [image('AAAA'), { type: 'text', text: 'result a' }] }, image('BBBB')] as unknown as ContentBlock[]);
      m.addMessage('Claude', [{ type: 'text', text: 'done' }]);
      const compiled = await m.compile(BUDGET);
      const results = (content: ContentBlock[]) => content.filter((b) => b.type === 'tool_result').map((b) => (b as unknown as { toolUseId: string }).toolUseId).sort().join(',');
      assert.ok(compiled.messages.some((x) => results(x.content) === 'a,b'), 'premise: result a moved beside result b');
      const data = (content: ContentBlock[]): string[] => content.flatMap((b) =>
        b.type === 'image' ? [(b as { source: { data: string } }).source.data]
          : b.type === 'tool_result' && Array.isArray((b as { content?: unknown }).content) ? data((b as unknown as { content: ContentBlock[] }).content) : []);
      assert.deepEqual(compiled.messages.flatMap((x) => data(x.content)), ['BBBB'], 'A stripped, B live');
      await m.close();
    });
  }

  describe('previews and dry compiles', () => {
    const adaptive = (extra: Record<string, unknown> = {}) => strategy({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 4, imageStripHysteresisRatio: 0.5, ...extra,
    });
    const previewed = (m: ContextManager, n: number, overrides: Record<string, unknown> = { maxLiveImages: 2 }) => {
      const entries = m.previewContext(BUDGET, overrides, { render: true })?.entries ?? [];
      assert.ok(entries.length > 0, 'the preview rendered its entries');
      return imagePattern(entries, n);
    };

    it('a stricter preview renders its own limits and leaves the next live compile as it was', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 5; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 5), '...II');
      assert.equal(previewed(m, 5), '....I', 'a cap of 2 trims to 1 at the third image and again at the fifth');
      assert.equal(previewed(m, 5), '....I', 'the same preview twice');
      assert.equal(await stripped(m, 5), '...II', 'the live compile keeps what it kept');
      await m.close();
    });

    it('a preview that turns the ratio off prices images as a store without it does', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 6), '...III');
      const warm = m.previewContext(BUDGET, { imageStripHysteresisRatio: 0 }, { render: true });
      assert.equal(imagePattern(warm?.entries ?? [], 6), '..IIII');
      await m.close();
      const off = await ContextManager.open({ path: `${STORE}-off`, strategy: adaptive({ imageStripHysteresisRatio: undefined }) });
      for (let i = 1; i <= 6; i++) off.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(off, 6), '..IIII');
      const cold = off.previewContext(BUDGET, undefined, { render: true });
      assert.equal(warm?.finalTokens, cold?.finalTokens);
      await off.close();
    });

    it('a preview that turns the ratio on renders what a compile with it on does', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive({ imageStripHysteresisRatio: undefined }) });
      for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 6), '..IIII');
      assert.equal(previewed(m, 6, { imageStripHysteresisRatio: 0.5 }), '...III');
      await m.close();
      const on = await ContextManager.open({ path: STORE, strategy: adaptive() });
      assert.equal(await stripped(on, 6), '...III');
      await on.close();
    });

    it('a dry compile renders what a live compile does, and an infeasible preview leaves the next ones as they were', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
      const dry = await m.compile(BUDGET, undefined, { dryRun: true });
      assert.equal(imagePattern(dry.messages, 6), '...III');
      const preview = m.previewContext({ maxTokens: 1, reserveForResponse: 0 }, { maxLiveImages: 2 }, { render: true });
      assert.ok(preview && !preview.fits, 'the preview reports its over-budget throw');
      assert.equal(previewed(m, 6), '....II', 'a cap of 2: trims at the third and fifth images, and the sixth fits');
      assert.equal(await stripped(m, 6), '...III');
      await m.close();
    });

    it('a dry compile releases an expired hold once, outside the dry select, and renders what a live compile does', async () => {
      // The release runs before the select, so it isn't part of the dry run
      // (SelectOptions.dryRun's doc).
      class Releases extends ImageRatioStrategy {
        releasedDuringDryRun: boolean[] = [];
        override onCompressionHoldsReleased(ctx: Parameters<AutobiographicalStrategy['onCompressionHoldsReleased']>[0]): void {
          this.releasedDuringDryRun.push((this as unknown as { _dryRunSelect: boolean })._dryRunSelect);
          super.onCompressionHoldsReleased(ctx);
        }
      }
      const patterns: string[] = [];
      for (const dryRun of [true, false]) {
        cleanup();
        let now = 1000;
        const s = new Releases({
          headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: false, adaptiveResolution: true, compressionModel: 'mock',
          targetChunkTokens: 100, autoTickOnNewMessage: false, imageStripDepthTokens: 0, maxLiveImages: 4, imageStripHysteresisRatio: 0.5,
        } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
        const m = await ContextManager.open({ path: STORE, strategy: s, now: () => now });
        for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
        m.holdCompression([m.getAllMessages()[0]!.id], { timeoutMs: 100 });
        now += 100;
        const compiled = await m.compile(BUDGET, undefined, { dryRun });
        assert.deepEqual(s.releasedDuringDryRun, [false], `${dryRun ? 'dry' : 'live'}: released once, outside the dry select`);
        patterns.push(imagePattern(compiled.messages, 6));
        await m.close();
      }
      assert.deepEqual(patterns, ['...III', '...III']);
    });

    it('render stats before a compile are null, leave the stored state as they found it, and the next compile strips as the rule says', async () => {
      const s = adaptive({ imageStripHysteresisRatio: undefined });
      let m = await ContextManager.open({ path: STORE, strategy: s });
      for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
      await m.close();
      const on = adaptive({ imageStripHysteresisRatio: 0 });
      m = await ContextManager.open({ path: STORE, strategy: on });
      on.enableImageRatio();
      const stored = () => JSON.stringify(m.getStore().listStates());
      const before = stored();
      const chunks = (on as unknown as { chunks: unknown }).chunks;
      const stats = m.getRenderStats();
      assert.strictEqual(stats, null, 'no live compile has recorded stats yet');
      assert.equal(stored(), before, 'the observer writes no stored state');
      assert.ok((on as unknown as { chunks: unknown }).chunks === chunks, 'and leaves the chunks it found');
      assert.equal(await stripped(m, 6), '...III');
      await m.close();
    });
  });

  it("with no byte cap set, the rule trims to ratio × the default byte cap, which its verdicts would otherwise drop", async () => {
    // Three images of 8 MiB, past the default 20 MiB and under the default
    // count. The rule's verdicts replace the limits, so the default byte cap
    // binds only through the rule.
    const big = 8 * 1024 * 1024;
    const off = await ContextManager.open({ path: `${STORE}-off`, strategy: strategy({}) });
    for (let i = 1; i <= 3; i++) off.addMessage('user', img(`img-${i}`, big));
    assert.equal(await stripped(off, 3), '.II', 'without the ratio, the default keeps the newest two');
    await off.close();
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 3; i++) m.addMessage('user', img(`img-${i}`, big));
    assert.equal(await stripped(m, 3), '..I', 'with it, the trim goes to ratio × the default, 10 MiB');
    await m.close();
  });

  it('within one message, the rule keeps its last images, where the limits alone keep the first that fit', async () => {
    // One message of three 8 MiB images, told apart by their data, under the
    // default byte cap.
    const big = 8 * 1024 * 1024;
    const content = ['A', 'B', 'C'].map((c) => ({ type: 'image', source: { type: 'base64', data: c.repeat(big), mediaType: 'image/png' } }) as ContentBlock);
    const live = async (m: ContextManager): Promise<string> => {
      const entry = (await m.compile(BUDGET)).messages.find((e) => e.content.some((b) => b.type === 'text' && b.text === 'zz-label'));
      const kept = new Set((entry?.content ?? []).flatMap((b) => b.type === 'image' ? [(b as { source: { data: string } }).source.data[0]] : []));
      return ['A', 'B', 'C'].map((c) => kept.has(c) ? 'I' : '.').join('');
    };
    const off = await ContextManager.open({ path: `${STORE}-off`, strategy: strategy({}) });
    off.addMessage('user', [...content, { type: 'text', text: 'zz-label' }]);
    assert.equal(await live(off), 'II.', 'without the ratio, its first two stay');
    await off.close();
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ imageStripHysteresisRatio: 0.5 }) });
    m.addMessage('user', [...content, { type: 'text', text: 'zz-label' }]);
    assert.equal(await live(m), '..I', 'with it, its last stays: a message\'s stripped images are its first ones');
    await m.close();
  });

  it("the replay's memo is keyed on the listing too, for a tool pruning override that keeps one decision", async () => {
    // toolPruning's contract asks only that a different decision be a new
    // object, so an override may keep one for every listing.
    class OneDecision extends ImageRatioStrategy {
      private readonly decision = { replaced: new Map(), inputCap: 0 };
      protected override toolPruning() { return this.decision; }
    }
    const m = await ContextManager.open({
      path: STORE,
      strategy: new OneDecision({ headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0,
        maxLiveImages: 4, imageStripHysteresisRatio: 0.5 } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
    });
    for (let i = 1; i <= 3; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 5), 'III--');
    for (let i = 4; i <= 5; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 5), '...II', 'the new listing is replayed, not the memo of the old');
    await m.close();
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
