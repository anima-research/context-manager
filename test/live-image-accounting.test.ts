/**
 * The live window's image accounting counts every `image` block, whatever its
 * source (base64, a `data:` URL or a remote URL), and every `generated_image`,
 * top-level or nested in a tool result. The strip, the post-strip estimates,
 * imageStripHysteresisRatio's rule and the store's price all see the same images and agree
 * on how deep each one is, and a strip releases the raw replay form of a tool
 * result whose nested image it replaces, from every block of its message that
 * shares it.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy, WindowedPassthroughStrategy, MessageStore, ContextLog } from '../src/index.js';
import type { ContextEntry, MessageStoreView, StoredMessage } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'live-image-accounting-'));
let n = 0;
const fresh = () => join(dir, `store-${n++}`);
after(() => rmSync(dir, { recursive: true, force: true }));

const PLACEHOLDER = 'image not shown: this context keeps only some images';
const base64Image = (): ContentBlock =>
  ({ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' }, tokenEstimate: 1600 }) as ContentBlock;
const generatedImage = (bytes = 5000): ContentBlock =>
  ({ type: 'generated_image', data: 'C'.repeat(bytes), mimeType: 'image/png' }) as unknown as ContentBlock;
const dataUrlImage = (bytes: number): ContentBlock =>
  ({ type: 'image', source: { type: 'url', url: 'data:image/png;base64,' + 'A'.repeat(bytes) } }) as unknown as ContentBlock;

/**
 * A tool round whose result nests an image beside a text label. With `raw`,
 * the result carries a raw replay form (a Responses `function_call_output`
 * item), which the Responses formatter sends in place of the block's fields.
 */
function toolRound(cm: ContextManager, label: string, image: ContentBlock, raw = false): void {
  cm.addMessage('Claude', [{ type: 'tool_use', id: `t-${label}`, name: 'shot', input: {} } as ContentBlock]);
  cm.addMessage('User', [{
    type: 'tool_result', toolUseId: `t-${label}`, toolName: 'shot',
    ...(raw ? { rawItem: { type: 'function_call_output', call_id: `t-${label}`, output: 'with an image' } } : {}),
    content: [image, { type: 'text', text: label }],
  } as unknown as ContentBlock]);
}

/** The compiled tool result of the round labelled `label`. */
function resultOf(messages: { content: ContentBlock[] }[], label: string): { rawItem?: unknown; rawXml?: unknown } | undefined {
  return messages.flatMap((m) => m.content).find((b) =>
    b.type === 'tool_result' && (b as { toolUseId?: string }).toolUseId === `t-${label}`) as { rawItem?: unknown; rawXml?: unknown } | undefined;
}

/** Whether the compiled entry holding `label` (top-level or nested) still carries an image. */
function stateOf(messages: { content: ContentBlock[] }[], label: string): 'image' | 'stripped' | 'missing' {
  const flat = (blocks: ContentBlock[]): ContentBlock[] => blocks.flatMap((b) => {
    const nested = (b as { type: string; content?: unknown }).content;
    return b.type === 'tool_result' && Array.isArray(nested) ? [b, ...flat(nested as ContentBlock[])] : [b];
  });
  const entry = messages.map((m) => flat(m.content)).find((blocks) =>
    blocks.some((b) => b.type === 'text' && b.text.includes(label)));
  if (!entry) return 'missing';
  if (entry.some((b) => b.type === 'image' || b.type === 'generated_image')) return 'image';
  if (entry.some((b) => b.type === 'text' && b.text.includes(PLACEHOLDER))) return 'stripped';
  return 'missing';
}

/**
 * A store view over plain messages, priced as the store prices them: an image
 * at its estimate or 1600, a generated image at 1600, text at a token per four
 * characters unless `textTokens` says otherwise, a tool result at what it
 * nests.
 */
function viewOf(
  messages: Array<{ id: string; sequence: number; content: ContentBlock[] }>,
  textTokens: (text: string) => number = (text) => Math.ceil(text.length / 4),
) {
  const raw = (b: ContentBlock): number => {
    if (b.type === 'image') return (b as { tokenEstimate?: number }).tokenEstimate ?? 1600;
    if ((b as { type: string }).type === 'generated_image') return 1600;
    if (b.type === 'text') return textTokens(b.text);
    const nested = (b as { content?: unknown }).content;
    return b.type === 'tool_result' && Array.isArray(nested) ? (nested as ContentBlock[]).reduce((s, x) => s + raw(x), 0) : 0;
  };
  return {
    getAll: () => messages as never[],
    length: () => messages.length,
    estimateTokens: (m: { content: ContentBlock[] }) => m.content.reduce((s, b) => s + raw(b), 0),
    getTokenCalibration: () => 1,
  };
}

type StripInternals = {
  getImageStripStart(store: unknown, depthTokens: number): number;
  postStripEstimates(store: unknown): number[];
  imageStripReplay(store: unknown): ReadonlyMap<string, number> | undefined;
};

/** The store's and the context log's estimators, each over one message's content on a fresh store. */
const ESTIMATORS: Array<{ name: string; open(store: JsStore): (content: ContentBlock[]) => number }> = [
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
];

const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };

describe('live image accounting', () => {
  it('counts and strips images nested in tool results (count cap)', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    for (const label of ['nested-1', 'nested-2', 'nested-3']) toolRound(cm, label, base64Image());
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'nested-3'), 'image', 'the newest nested image is kept');
    assert.equal(stateOf(messages, 'nested-2'), 'stripped', 'an older nested image is stripped');
    assert.equal(stateOf(messages, 'nested-1'), 'stripped', 'the oldest nested image is stripped');
    cm.close();
  });

  it('counts and strips a top-level generated image (count cap)', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    cm.addMessage('Claude', [generatedImage(), { type: 'text', text: 'gen-1' }]);
    cm.addMessage('User', [base64Image(), { type: 'text', text: 'img-2' }]);
    cm.addMessage('Claude', [generatedImage(), { type: 'text', text: 'gen-3' }]);
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'gen-3'), 'image', 'the newest, a generated image, takes the one live slot');
    assert.equal(stateOf(messages, 'img-2'), 'stripped', 'so the image before it is stripped');
    assert.equal(stateOf(messages, 'gen-1'), 'stripped', 'and an older generated image is replaced too');
    cm.close();
  });

  it('counts a data: URL source and a generated image by their inline bytes (bytes cap)', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 6000 }),
    });
    const shapes: Array<[string, ContentBlock]> = [
      ['url-image', dataUrlImage(5000)],
      ['generated', generatedImage(5000)],
    ];
    for (const [label, image] of shapes) toolRound(cm, label, image);
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'generated'), 'image', 'the newest, 5000 bytes, fits in 6000');
    assert.equal(stateOf(messages, 'url-image'), 'stripped', 'a second 5000 bytes is over 6000');
    cm.close();
  });

  it('prices a generated image as both estimators price an image without a stamp', () => {
    const unstamped = { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } } as ContentBlock;
    for (const estimator of ESTIMATORS) {
      const js = JsStore.openOrCreate({ path: fresh() });
      try {
        const estimate = estimator.open(js);
        assert.ok(estimate([unstamped]) > 0, `${estimator.name}: an image has a price`);
        assert.equal(estimate([generatedImage()]), estimate([unstamped]), `${estimator.name}: a generated image is priced as an image`);
      } finally {
        js.close();
      }
    }
  });

  it('weighs a generated image as an image in the fold planner\'s salience', () => {
    const salience = (block: ContentBlock): number =>
      (AutobiographicalStrategy as unknown as { computeStaticSalience(m: StoredMessage): number })
        .computeStaticSalience({ id: 'm', sequence: 0, participant: 'Claude', content: [block], timestamp: new Date(0) });
    assert.equal(salience(base64Image()), 0.2, 'an image is fully externalized');
    assert.equal(salience(generatedImage()), 0.2, 'and so is a generated image');
  });

  it('takes a stripped nested image off the post-strip estimate', () => {
    const strategy = new AutobiographicalStrategy({ maxLiveImages: 1 } as never);
    const store = viewOf([
      { id: 'old', sequence: 0, content: [{ type: 'tool_result', toolUseId: 'a', content: [base64Image()] } as ContentBlock] },
      { id: 'new', sequence: 1, content: [{ type: 'tool_result', toolUseId: 'b', content: [base64Image()] } as ContentBlock] },
    ]);
    const pse = (strategy as unknown as StripInternals).postStripEstimates(store);
    assert.equal(pse[1], 1600, 'the newest nested image is live');
    // The placeholder's 54 characters, at 4 to a token.
    assert.equal(pse[0], 14, 'the older one costs its placeholder');
  });

  it('prices the image of the message that crosses the strip depth as the strip treats it', () => {
    // 1000 tokens of text, then, older, a 1600-token image: the depth crosses
    // 2000 inside the image's message.
    const strategy = new AutobiographicalStrategy({ maxLiveImages: 0, imageStripDepthTokens: 2000 } as never);
    const store = viewOf([
      { id: 'image', sequence: 0, content: [base64Image()] },
      { id: 'text', sequence: 1, content: [{ type: 'text', text: 'x'.repeat(4000) }] },
    ]);
    const internals = strategy as unknown as StripInternals;
    assert.equal(internals.getImageStripStart(store, 2000), 1, 'the strip replaces the image of the message that crosses the depth');
    assert.equal(internals.postStripEstimates(store)[0], 14, 'and the estimate prices that image at its placeholder');
  });

  it("imageStripHysteresisRatio's rule strips the image of the message that crosses the strip depth", () => {
    const strategy = new AutobiographicalStrategy({ maxLiveImages: 0, imageStripDepthTokens: 2000, imageStripHysteresisRatio: 0.5 } as never);
    const store = viewOf([
      { id: 'image', sequence: 0, content: [base64Image()] },
      { id: 'text', sequence: 1, content: [{ type: 'text', text: 'x'.repeat(4000) }] },
    ]);
    const internals = strategy as unknown as StripInternals;
    assert.deepEqual([...(internals.imageStripReplay(store) ?? new Map())], [['image', 1]], 'the image the strip replaces is in the rule\'s set');
  });

  it("imageStripHysteresisRatio's rule counts images nested in tool results", async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 4, imageStripDepthTokens: 0, imageStripHysteresisRatio: 0.5 }),
    });
    const labels = ['h-1', 'h-2', 'h-3', 'h-4', 'h-5'];
    for (const label of labels) toolRound(cm, label, base64Image());
    const { messages } = await cm.compile(BUDGET);
    assert.deepEqual(labels.map((label) => stateOf(messages, label)), ['stripped', 'stripped', 'stripped', 'image', 'image'],
      'five nested images over a cap of four trim to half the cap, two');
    cm.close();
  });

  it("imageStripHysteresisRatio's rule counts a tool result as it's sent, so one toolResultMaxLastN replaces holds no image", async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({
        headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 4, imageStripDepthTokens: 0, imageStripHysteresisRatio: 0.5,
        toolResultMaxLastN: { shot: 4 },
      }),
    });
    const labels = ['h-1', 'h-2', 'h-3', 'h-4', 'h-5'];
    for (const label of labels) toolRound(cm, label, base64Image());
    const { messages } = await cm.compile(BUDGET);
    assert.deepEqual(labels.map((label) => stateOf(messages, label)), ['missing', 'image', 'image', 'image', 'image'],
      "the oldest result is sent as its marker, so four nested images are sent, within the cap of four, and none is trimmed");
    cm.close();
  });

  it("imageStripHysteresisRatio's rule counts each message as its cut sends it", async () => {
    /** A cut that leaves out the images of the oldest round. */
    class DropsFirstRound extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        const first = content.some((b) => b.type === 'tool_result' && (b as { toolUseId?: string }).toolUseId === 't-h-1');
        return maxTokens > 0 && first
          ? content.map((b) => (b.type === 'tool_result' ? { ...b, content: [{ type: 'text', text: 'h-1 cut' }] } as ContentBlock : b))
          : content;
      }
    }
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new DropsFirstRound({
        headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 4, imageStripDepthTokens: 0, imageStripHysteresisRatio: 0.5,
        maxMessageTokens: 100_000,
      }),
    });
    const labels = ['h-1', 'h-2', 'h-3', 'h-4', 'h-5'];
    for (const label of labels) toolRound(cm, label, base64Image());
    const { messages } = await cm.compile(BUDGET);
    assert.deepEqual(labels.slice(1).map((label) => stateOf(messages, label)), ['image', 'image', 'image', 'image'],
      "the oldest round's cut sends no image, so four are sent, within the cap of four, and none is trimmed");
    cm.close();
  });

  it('releases the raw replay form of a tool result whose nested image it strips', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    for (const label of ['raw-1', 'raw-2']) toolRound(cm, label, base64Image(), true);
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'raw-1'), 'stripped');
    assert.equal(stateOf(messages, 'raw-2'), 'image');
    assert.ok(resultOf(messages, 'raw-1'), 'the stripped tool result is in the window');
    assert.equal(resultOf(messages, 'raw-1')!.rawItem, undefined, 'its raw form, which still holds the image, is released');
    assert.ok(resultOf(messages, 'raw-2')?.rawItem, 'the kept tool result keeps its raw form');
    cm.close();
  });

  it('releases rawXml too, from every block of the message that shares it', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    // One XML results block that both results were parsed from, as the XML
    // formatter replays it once for the run of blocks that carry it.
    const xml = '<function_results>pair</function_results>';
    cm.addMessage('Claude', [
      { type: 'tool_use', id: 't-pair-a', name: 'shot', input: {} } as ContentBlock,
      { type: 'tool_use', id: 't-pair-b', name: 'shot', input: {} } as ContentBlock,
    ]);
    cm.addMessage('User', [
      { type: 'tool_result', toolUseId: 't-pair-a', toolName: 'shot', rawXml: xml,
        rawItem: { type: 'function_call_output', call_id: 't-pair-a', output: 'with an image' },
        content: [base64Image(), { type: 'text', text: 'pair-a' }] } as unknown as ContentBlock,
      { type: 'tool_result', toolUseId: 't-pair-b', toolName: 'shot', rawXml: xml,
        content: [{ type: 'text', text: 'pair-b' }] } as unknown as ContentBlock,
    ]);
    toolRound(cm, 'newer', base64Image());
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'pair-a'), 'stripped', 'the newer image takes the one live slot');
    const a = resultOf(messages, 'pair-a');
    const b = resultOf(messages, 'pair-b');
    assert.ok(a && b, 'both results are in the window');
    assert.equal(a.rawItem, undefined, 'the stripped result gives up its rawItem');
    assert.equal(a.rawXml, undefined, 'and its rawXml');
    assert.equal(b.rawXml, undefined, 'the result that shared that rawXml gives it up too');
    cm.close();
  });

  it('windowed passthrough counts and strips nested images the same way', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    for (const label of ['wp-1', 'wp-2']) toolRound(cm, label, base64Image(), true);
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'wp-2'), 'image');
    assert.equal(stateOf(messages, 'wp-1'), 'stripped');
    assert.equal(resultOf(messages, 'wp-1')!.rawItem, undefined, 'the stripped result gives up its raw form');
    assert.ok(resultOf(messages, 'wp-2')?.rawItem, 'the kept one keeps its own');
    cm.close();
  });

  it('windowed passthrough counts a data: URL and a nested generated image by their inline bytes', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 6000 }),
    });
    toolRound(cm, 'wp-url', dataUrlImage(5000));
    toolRound(cm, 'wp-gen', generatedImage(5000));
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'wp-gen'), 'image', 'the newest, 5000 bytes, fits in 6000');
    assert.equal(stateOf(messages, 'wp-url'), 'stripped', 'a second 5000 bytes is over 6000');
    cm.close();
  });

  it('windowed passthrough strips a top-level generated image', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    cm.addMessage('Claude', [generatedImage(), { type: 'text', text: 'wp-gen-1' }]);
    cm.addMessage('Claude', [generatedImage(), { type: 'text', text: 'wp-gen-2' }]);
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'wp-gen-2'), 'image');
    assert.equal(stateOf(messages, 'wp-gen-1'), 'stripped');
    cm.close();
  });

  it('windowed passthrough strips a nested image beyond the depth and keeps one within it', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 0, imageStripDepthTokens: 2000 }),
    });
    toolRound(cm, 'wp-deep', base64Image());
    cm.addMessage('Claude', [{ type: 'text', text: 'x'.repeat(4000) }]); // 1000 tokens
    toolRound(cm, 'wp-shallow', base64Image());
    const { messages } = await cm.compile(BUDGET);
    assert.equal(stateOf(messages, 'wp-shallow'), 'image', 'within 2000 tokens of the tail');
    assert.equal(stateOf(messages, 'wp-deep'), 'stripped', 'past 2000 tokens, with the shallow image and the text newer');
    cm.close();
  });

  it('takes a stripped nested generated image off the post-strip estimate at the store\'s price, whatever it carries', () => {
    const strategy = new AutobiographicalStrategy({ maxLiveImages: 1 } as never);
    const stamped = (): ContentBlock => ({ ...generatedImage(), tokenEstimate: 400 }) as unknown as ContentBlock;
    const store = viewOf([
      { id: 'old', sequence: 0, content: [{ type: 'tool_result', toolUseId: 'a', content: [stamped()] } as ContentBlock] },
      { id: 'new', sequence: 1, content: [{ type: 'tool_result', toolUseId: 'b', content: [stamped()] } as ContentBlock] },
    ]);
    const pse = (strategy as unknown as StripInternals).postStripEstimates(store);
    assert.equal(pse[1], 1600, 'the newest is live at 1600');
    assert.equal(pse[0], 14, 'the older costs its placeholder: all 1600 come off, not the 400 it carries');
  });

  it('windowed passthrough prices a message after its image policy, so an image the policy strips no longer refuses it', async () => {
    const largeBase64 = (): ContentBlock =>
      ({ type: 'image', source: { type: 'base64', data: 'A'.repeat(5000), mediaType: 'image/png' } }) as ContentBlock;
    for (const [kind, image] of [['base64', largeBase64], ['generated', () => generatedImage(5000)]] as const) {
      const cm = await ContextManager.open({
        path: fresh(),
        strategy: new WindowedPassthroughStrategy({ maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 1000 }),
      });
      cm.addMessage('Claude', [image(), { type: 'text', text: `wp-bytes-${kind}` }]);
      // About 1,600 tokens with its image, and far under the budget once the
      // bytes cap replaces it with the placeholder.
      const { messages } = await cm.compile({ maxTokens: 1000, reserveForResponse: 0 });
      assert.equal(stateOf(messages, `wp-bytes-${kind}`), 'stripped', `the ${kind} image goes, and its message is sent`);
      cm.close();
    }
  });

  it('windowed passthrough prices a message the cap cuts after its image policy too', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 1000, maxMessageTokens: 100 }),
    });
    cm.addMessage('Claude', [{ type: 'text', text: 'wp-capped ' + 'x'.repeat(2000) }, { type: 'image', source: { type: 'base64', data: 'A'.repeat(5000), mediaType: 'image/png' } } as ContentBlock]);
    // About 2,300 tokens as stored, about 700 with its image replaced by the
    // placeholder, and under 200 cut to its cap as well: a budget of 300 fits
    // only the price after both the policy and the cut.
    const { messages } = await cm.compile({ maxTokens: 300, reserveForResponse: 0 });
    assert.equal(stateOf(messages, 'wp-capped'), 'stripped', 'the image goes, and the message is sent');
    assert.ok(messages.flatMap((m) => m.content).some((b) => b.type === 'text' && b.text.includes('[truncated')), 'premise: the cap cut its text');
    cm.close();
  });

  it('windowed passthrough keeps its anchor while the window fits once its images are stripped', async () => {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    const labels = ['wp-fit-1', 'wp-fit-2', 'wp-fit-3', 'wp-fit-4', 'wp-fit-5'];
    for (const label of labels) cm.addMessage('Claude', [base64Image(), { type: 'text', text: label }]);
    // About 8,000 tokens with every image; with four of them stripped, well
    // under the 3,000 budget.
    const { messages } = await cm.compile({ maxTokens: 3000, reserveForResponse: 0 });
    assert.equal(stateOf(messages, 'wp-fit-5'), 'image', 'the newest image is kept');
    for (const label of labels.slice(0, 4)) {
      assert.equal(stateOf(messages, label), 'stripped', `${label} is sent, with its image stripped`);
    }
    cm.close();
  });

  /** An autobiographical strategy whose head window is message 0 and whose recent window starts at message 2, with its two image passes in reach. */
  class FoldedWindow extends AutobiographicalStrategy {
    protected override getHeadWindowStartIndex(): number { return 0; }
    protected override getHeadWindowEnd(): number { return 1; }
    protected override getRecentWindowStart(): number { return 2; }
    estimates(store: unknown): number[] { return this.postStripEstimates(store as never); }
    /** The strip as `selectAdaptive` asks for it, or, with `asEstimated` false, as `selectHierarchical` does. */
    strip(entries: ContextEntry[], store: unknown, asEstimated = true): void {
      this.applyImageStripping(entries, store as never, { asEstimated });
    }
  }

  for (const nested of [false, true]) {
    it(`the strip counts the ${nested ? 'nested' : 'top-level'} image of a message a fold left out, as the estimate does`, () => {
      const middle: ContentBlock[] = nested
        ? [{ type: 'tool_result', toolUseId: 'm', content: [base64Image(), { type: 'text', text: 'middle' }] } as unknown as ContentBlock]
        : [base64Image(), { type: 'text', text: 'middle' }];
      const messages = [
        { id: 'head', sequence: 0, participant: 'User', content: [base64Image(), { type: 'text', text: 'head' }] as ContentBlock[] },
        { id: 'middle', sequence: 1, participant: 'User', content: middle },
        { id: 'tail', sequence: 2, participant: 'Claude', content: [base64Image(), { type: 'text', text: 'tail' }] as ContentBlock[] },
      ];
      const store = viewOf(messages);
      const strategy = new FoldedWindow({ maxLiveImages: 2, imageStripDepthTokens: 0 } as never);
      const estimates = strategy.estimates(store);
      // The fold leaves the middle message out: a summary derived from it
      // stands for it, without its image.
      const entries: ContextEntry[] = [
        { index: 0, sourceMessageId: 'head', sourceRelation: 'copy', participant: 'User', content: messages[0]!.content },
        { index: 1, sourceMessageIds: ['middle'], sourceRelation: 'derived', participant: 'User', content: [{ type: 'text', text: 'what came between' }] },
        { index: 2, sourceMessageId: 'tail', sourceRelation: 'copy', participant: 'Claude', content: messages[2]!.content },
      ];
      strategy.strip(entries, store);
      assert.equal(estimates[0], 15, "the estimate gives the middle's image the second live slot and prices the head's at the placeholder");
      assert.equal(stateOf(entries, 'head'), 'stripped', 'and the strip does the same');
      assert.equal(stateOf(entries, 'tail'), 'image');
    });
  }

  it("the strip counts a folded message's images as it's sent, so one in a result toolResultMaxLastN replaces takes no slot, as in the estimate", () => {
    /** Head window message 0, recent window from message 3: messages 1 and 2 are the middle's. */
    class FoldedRound extends FoldedWindow {
      protected override getRecentWindowStart(): number { return 3; }
    }
    const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'shot', input: {} }) as ContentBlock;
    const result = (id: string, label: string): ContentBlock =>
      ({ type: 'tool_result', toolUseId: id, toolName: 'shot', content: [base64Image(), { type: 'text', text: label }] }) as unknown as ContentBlock;
    const messages = [
      { id: 'head', sequence: 0, participant: 'User', content: [base64Image(), { type: 'text', text: 'head' }] as ContentBlock[] },
      { id: 'call-1', sequence: 1, participant: 'Claude', content: [call('t-1')] },
      { id: 'middle', sequence: 2, participant: 'User', content: [result('t-1', 'middle')] },
      { id: 'call-2', sequence: 3, participant: 'Claude', content: [call('t-2')] },
      { id: 'tail', sequence: 4, participant: 'User', content: [result('t-2', 'tail')] },
    ];
    const store = viewOf(messages);
    // The tool's last result shows; the middle's is replaced by its marker,
    // image and all.
    const strategy = new FoldedRound({ maxLiveImages: 2, imageStripDepthTokens: 0, toolResultMaxLastN: { shot: 1 } } as never);
    const estimates = strategy.estimates(store);
    // The fold leaves the middle's two messages out.
    const entries: ContextEntry[] = [
      { index: 0, sourceMessageId: 'head', sourceRelation: 'copy', participant: 'User', content: messages[0]!.content },
      { index: 1, sourceMessageIds: ['call-1', 'middle'], sourceRelation: 'derived', participant: 'User', content: [{ type: 'text', text: 'what came between' }] },
      { index: 2, sourceMessageId: 'call-2', sourceRelation: 'copy', participant: 'Claude', content: messages[3]!.content },
      { index: 3, sourceMessageId: 'tail', sourceRelation: 'copy', participant: 'User', content: messages[4]!.content },
    ];
    strategy.strip(entries, store);
    assert.equal(estimates[2], 0, "premise: the middle's result is replaced, so its estimate holds no image");
    assert.equal(estimates[0], 1600 + 1, "the tail's image and the head's take the two live slots in the estimate");
    assert.equal(stateOf(entries, 'head'), 'image', "and the strip keeps the head's image, the replaced result's taking no slot");
    assert.equal(stateOf(entries, 'tail'), 'image');
  });

  it("the strip counts a folded message's images as its cut sends them, so one a truncateContent override leaves out takes no slot, as in the estimate", () => {
    /** A cut that leaves out every image of a message whose text says so. */
    class DropsMarkedImages extends FoldedWindow {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        const marked = content.some((b) => b.type === 'text' && b.text.includes('drop images'));
        return maxTokens > 0 && marked ? content.filter((b) => b.type !== 'image') : content;
      }
    }
    const messages = [
      { id: 'head', sequence: 0, participant: 'User', content: [base64Image(), { type: 'text', text: 'head' }] as ContentBlock[] },
      { id: 'middle', sequence: 1, participant: 'User', content: [base64Image(), { type: 'text', text: 'middle, drop images' }] as ContentBlock[] },
      { id: 'tail', sequence: 2, participant: 'Claude', content: [base64Image(), { type: 'text', text: 'tail' }] as ContentBlock[] },
    ];
    const store = viewOf(messages);
    const strategy = new DropsMarkedImages({ maxLiveImages: 2, imageStripDepthTokens: 0, maxMessageTokens: 1000 } as never);
    const estimates = strategy.estimates(store);
    const entries: ContextEntry[] = [
      { index: 0, sourceMessageId: 'head', sourceRelation: 'copy', participant: 'User', content: messages[0]!.content },
      { index: 1, sourceMessageIds: ['middle'], sourceRelation: 'derived', participant: 'User', content: [{ type: 'text', text: 'what came between' }] },
      { index: 2, sourceMessageId: 'tail', sourceRelation: 'copy', participant: 'Claude', content: messages[2]!.content },
    ];
    strategy.strip(entries, store);
    assert.equal(estimates[0], 1600 + 1, "the middle's cut sends no image, so the tail's and the head's take the two live slots in the estimate");
    assert.equal(stateOf(entries, 'head'), 'image', 'and the strip keeps the head\'s image');
    assert.equal(stateOf(entries, 'tail'), 'image');
  });

  it("the strip counts a merged body's images once, at its first shard, where the chunker puts them, as the estimate does", () => {
    // chunkIngressMessage puts a body's images on its first shard, and
    // mergeAdjacentBodyGroupRaw keeps them ahead of the merged text.
    const messages = [
      { id: 'a', sequence: 0, participant: 'User', content: [{ type: 'text', text: 'a' }, base64Image(), base64Image()] as ContentBlock[] },
      { id: 'b', sequence: 1, participant: 'User', content: [{ type: 'text', text: 'b' }] as ContentBlock[] },
      { id: 'c', sequence: 2, participant: 'Claude', content: [base64Image(), { type: 'text', text: 'c' }] as ContentBlock[] },
    ];
    const store = viewOf(messages);
    const strategy = new FoldedWindow({ maxLiveImages: 2, imageStripDepthTokens: 0 } as never);
    const estimates = strategy.estimates(store);
    const entries: ContextEntry[] = [
      {
        index: 0, sourceMessageId: 'a', sourceMessageIds: ['a', 'b'], sourceRelation: 'copy', participant: 'User',
        content: [base64Image(), base64Image(), { type: 'text', text: 'ab' }],
      },
      { index: 1, sourceMessageId: 'c', sourceRelation: 'copy', participant: 'Claude', content: messages[2]!.content },
    ];
    strategy.strip(entries, store);
    assert.equal(estimates[0], 1600 + 14 + 1, "two live slots: the estimate prices c's image and a's first live, and a's second at the placeholder");
    assert.equal(stateOf(entries, 'c'), 'image', 'and the strip keeps the same images');
    assert.deepEqual(entries[0]!.content.map((b) => b.type), ['image', 'text', 'text']);
  });

  it("the real chunker and merge put a body's images on its first shard, ahead of its text, where the strip and the estimate count them alike", () => {
    class Chunking extends FoldedWindow {
      merge(entries: ContextEntry[], store: unknown, messages: unknown): ContextEntry[] {
        return this.mergeAdjacentBodyGroupRaw(entries, store as never, messages as never);
      }
    }
    const strategy = new Chunking({ adaptiveResolution: true, targetChunkTokens: 20, maxLiveImages: 2, imageStripDepthTokens: 0 } as never);
    const decision = strategy.chunkIngressMessage('User', [{ type: 'text', text: 'word '.repeat(200) }, base64Image(), base64Image()]);
    assert.ok(decision && decision.shards.length > 1, 'the body is sharded');
    const shards = decision.shards.map((s, k) => ({
      id: `s${k}`, sequence: k, participant: 'User', content: s.content, bodyGroupId: decision.bodyGroupId, shardIndex: s.shardIndex,
    }));
    const tail = { id: 'tail', sequence: shards.length, participant: 'Claude', content: [base64Image(), { type: 'text', text: 'tail' }] as ContentBlock[] };
    const messages = [...shards, tail];
    const store = viewOf(messages);
    const estimates = strategy.estimates(store);
    const entries: ContextEntry[] = messages.map((m, index) => ({ index, sourceMessageId: m.id, sourceRelation: 'copy', participant: m.participant, content: m.content }));
    const merged = strategy.merge(entries, store, messages);
    const body = merged.find((e) => (e.sourceMessageIds?.length ?? 0) > 1);
    assert.ok(body, 'the shards merge into one entry');
    assert.deepEqual(body.content.map((b) => b.type).slice(0, 2), ['image', 'image'], "the first shard's images, ahead of the text");
    strategy.strip(merged, store);
    const firstShardText = (shards[0]!.content[0] as { text: string }).text;
    assert.equal(estimates[0], Math.ceil(firstShardText.length / 4) + 1600 + 14,
      "two live slots: the estimate prices the tail's image and the body's first live, at the first shard, and its second at the placeholder");
    assert.deepEqual(body.content.map((b) => b.type).slice(0, 2), ['image', 'text'], 'and the strip keeps the same one');
    assert.equal(stateOf(merged, 'tail'), 'image');
  });

  it("the strip counts the images on a body's first shard where the middle region's composite sends the body's text only, as the estimate does", () => {
    const messages = [
      { id: 'head', sequence: 0, participant: 'User', content: [base64Image(), { type: 'text', text: 'head' }] as ContentBlock[] },
      { id: 's0', sequence: 1, participant: 'User', content: [{ type: 'text', text: 'shard zero ' }, base64Image()] as ContentBlock[] },
      { id: 's1', sequence: 2, participant: 'User', content: [{ type: 'text', text: 'shard one' }] as ContentBlock[] },
      { id: 'tail', sequence: 3, participant: 'Claude', content: [base64Image(), { type: 'text', text: 'tail' }] as ContentBlock[] },
    ];
    const store = viewOf(messages);
    const strategy = new FoldedWindow({ maxLiveImages: 2, imageStripDepthTokens: 0 } as never);
    const estimates = strategy.estimates(store);
    // The middle region renders a raw run of a body's shards as one entry of
    // their text (selectAdaptive): it names both shards and sends no image.
    const entries: ContextEntry[] = [
      { index: 0, sourceMessageId: 'head', sourceRelation: 'copy', participant: 'User', content: messages[0]!.content },
      { index: 1, sourceMessageIds: ['s0', 's1'], sourceRelation: 'copy', participant: 'User', content: [{ type: 'text', text: 'shard zero shard one' }] },
      { index: 2, sourceMessageId: 'tail', sourceRelation: 'copy', participant: 'Claude', content: messages[3]!.content },
    ];
    strategy.strip(entries, store);
    assert.equal(estimates[0], 15, "the estimate gives the first shard's image the second live slot and prices the head's at the placeholder");
    assert.equal(stateOf(entries, 'head'), 'stripped', 'and the strip does the same');
    assert.equal(stateOf(entries, 'tail'), 'image');
  });

  it("the strip counts only the images it sends where its caller prices them at full, as the hierarchical selection does", () => {
    const messages = [
      { id: 'head', sequence: 0, participant: 'User', content: [base64Image(), { type: 'text', text: 'head' }] as ContentBlock[] },
      { id: 'middle', sequence: 1, participant: 'User', content: [base64Image(), { type: 'text', text: 'middle' }] as ContentBlock[] },
      { id: 'tail', sequence: 2, participant: 'Claude', content: [base64Image(), { type: 'text', text: 'tail' }] as ContentBlock[] },
    ];
    const store = viewOf(messages);
    const strategy = new FoldedWindow({ maxLiveImages: 2, imageStripDepthTokens: 0 } as never);
    const entries: ContextEntry[] = [
      { index: 0, sourceMessageId: 'head', sourceRelation: 'copy', participant: 'User', content: messages[0]!.content },
      { index: 1, sourceMessageIds: ['middle'], sourceRelation: 'derived', participant: 'User', content: [{ type: 'text', text: 'what came between' }] },
      { index: 2, sourceMessageId: 'tail', sourceRelation: 'copy', participant: 'Claude', content: messages[2]!.content },
    ];
    strategy.strip(entries, store, false);
    assert.equal(stateOf(entries, 'head'), 'image', "the folded message's image takes no slot, so both images sent stay live");
    assert.equal(stateOf(entries, 'tail'), 'image');
  });

  it('only the adaptive selection, which prices by the post-strip estimates, asks the strip to count as they do', async () => {
    class Recording extends AutobiographicalStrategy {
      asked: boolean[] = [];
      protected override applyImageStripping(entries: ContextEntry[], store: MessageStoreView, opts?: { asEstimated?: boolean }): void {
        this.asked.push(opts?.asEstimated ?? false);
        super.applyImageStripping(entries, store, opts);
      }
    }
    for (const adaptiveResolution of [true, false]) {
      const strategy = new Recording({ adaptiveResolution, headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1, imageStripDepthTokens: 0 });
      const cm = await ContextManager.open({ path: fresh(), strategy });
      cm.addMessage('User', [base64Image(), { type: 'text', text: 'one' }]);
      cm.addMessage('Claude', [{ type: 'text', text: 'two' }]);
      await cm.compile(BUDGET);
      assert.ok(strategy.asked.length > 0, 'the strip ran');
      assert.ok(strategy.asked.every((a) => a === adaptiveResolution),
        `${adaptiveResolution ? 'selectAdaptive asks' : 'selectHierarchical does not ask'}: ${JSON.stringify(strategy.asked)}`);
      cm.close();
    }
  });

  it("takes a stripped image's placeholder off the post-strip estimate at the store's price for its text", () => {
    const strategy = new AutobiographicalStrategy({ maxLiveImages: 1 } as never);
    // A store whose estimator prices text at a token per two characters.
    const textTokens = (text: string) => Math.ceil(text.length / 2);
    const store = viewOf([
      { id: 'old', sequence: 0, content: [base64Image(), { type: 'text', text: 'old' }] },
      { id: 'new', sequence: 1, content: [base64Image(), { type: 'text', text: 'new' }] },
    ], textTokens);
    const pse = (strategy as unknown as StripInternals).postStripEstimates(store);
    assert.equal(pse[1], 1600 + 2, 'the newest is live');
    assert.equal(pse[0], textTokens('[image not shown: this context keeps only some images]') + 2,
      "the older costs its placeholder at the store's price for that text, 27 here, and its own text");
  });

  it("takes a stripped image priced below the placeholder off the post-strip estimate as the placeholder's extra cost", () => {
    const strategy = new AutobiographicalStrategy({ maxLiveImages: 1 } as never);
    const cheap = (): ContentBlock => ({ ...base64Image(), tokenEstimate: 5 }) as ContentBlock;
    const store = viewOf([
      { id: 'old', sequence: 0, content: [cheap(), { type: 'text', text: 'old' }] },
      { id: 'new', sequence: 1, content: [cheap(), { type: 'text', text: 'new' }] },
    ]);
    const pse = (strategy as unknown as StripInternals).postStripEstimates(store);
    assert.equal(pse[1], 5 + 1, 'the newest is live, at its stamp');
    assert.equal(pse[0], 14 + 1, 'the older costs the placeholder, 14 here, more than the 5 its image cost');
  });

  it("windowed passthrough prices a stripped image's placeholder at the store's price for its text", async () => {
    const js = JsStore.openOrCreate({ path: fresh() });
    let price: (content: ContentBlock[]) => number;
    try {
      const estimate = ESTIMATORS[0]!.open(js);
      price = (content) => estimate(content);
      // Priced now, on a fresh store at calibration 1, as the windowed store below prices them.
      const first = price([base64Image(), { type: 'text', text: 'wp-ph-1' }]);
      const second = price([base64Image(), { type: 'text', text: 'wp-ph-2' }]);
      const placeholder = price([{ type: 'text', text: '[image not shown: this context keeps only some images]' }]);
      // One live slot: the older image goes, and the window costs exactly this.
      const total = first - (1600 - placeholder) + second;
      for (const [maxTokens, older] of [[total, 'stripped'], [total - 1, 'missing']] as const) {
        const cm = await ContextManager.open({
          path: fresh(),
          strategy: new WindowedPassthroughStrategy({ maxLiveImages: 1, imageStripDepthTokens: 0 }),
        });
        cm.addMessage('Claude', [base64Image(), { type: 'text', text: 'wp-ph-1' }]);
        cm.addMessage('Claude', [base64Image(), { type: 'text', text: 'wp-ph-2' }]);
        const { messages } = await cm.compile({ maxTokens, reserveForResponse: 0 });
        assert.equal(stateOf(messages, 'wp-ph-2'), 'image');
        assert.equal(stateOf(messages, 'wp-ph-1'), older,
          older === 'stripped' ? `at ${maxTokens}, the window as sent fits` : `at ${maxTokens}, one under it, the window moves past the older message`);
        cm.close();
      }
    } finally {
      js.close();
    }
  });

  it("marks a generated image as an image in formatChunkForCompression's transcript", () => {
    class Subclass extends AutobiographicalStrategy {
      render(messages: StoredMessage[]): string {
        return this.formatChunkForCompression({ messages } as never);
      }
    }
    const transcript = new Subclass({} as never).render([
      { id: 'm', sequence: 0, participant: 'Claude', content: [generatedImage(), { type: 'text', text: 'drawn' }], timestamp: new Date(0) },
    ] as StoredMessage[]);
    assert.match(transcript, /\[Image\]\ndrawn/);
  });

  it('keeps imageBlockBytes and compressionImageBytes for subclasses, giving the inline sizes', () => {
    class Subclass extends AutobiographicalStrategy {
      static sizes(b: unknown): number[] {
        return [Subclass.imageBlockBytes(b), Subclass.compressionImageBytes(b)];
      }
    }
    assert.deepEqual(Subclass.sizes(dataUrlImage(5000)), [5000, 5000], "a data: URL's payload, not the whole URL");
    assert.deepEqual(Subclass.sizes(generatedImage(300)), [300, 300]);
    assert.deepEqual(Subclass.sizes({ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }), [0, 0]);
  });
});

describe("the adaptive strip applies the estimate's verdicts", () => {
  const image = (data: string, tokenEstimate: number): ContentBlock =>
    ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' }, tokenEstimate }) as ContentBlock;
  /** Compiles the messages under the adaptive selection, and returns what's
   *  sent, by the store's estimate, the render stats' total and its plan, and
   *  the live images' data, by message. */
  async function compileMoved(maxLiveImages: number, messages: Array<[string, ContentBlock[]]>) {
    const cm = await ContextManager.open({
      path: fresh(),
      strategy: new AutobiographicalStrategy({ adaptiveResolution: true, overBudgetGraceRatio: 0, maxLiveImages }),
    });
    for (const [participant, content] of messages) cm.addMessage(participant, content);
    const store = (cm as unknown as { messageStore: { estimateTokens(message: StoredMessage): number } }).messageStore;
    const compiled = await cm.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    const sent = compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as StoredMessage), 0);
    const stats = cm.getRenderStats()!;
    const live = compiled.messages.map((m) => [...imagesOf(m.content)].map((b) => (b as { source: { data: string } }).source.data).join(','));
    /** The text the repair leaves where it moved a message's only result, which no estimate prices. */
    const movedText = store.estimateTokens({ content: [{ type: 'text', text: '[tool result moved during context repair]' }] } as unknown as StoredMessage);
    cm.close();
    return { sent, total: stats.total.tokens, planned: stats.planVsActual?.planned, actual: stats.planVsActual?.actual, live, movedText };
  }
  function* imagesOf(content: ContentBlock[]): Generator<ContentBlock> {
    for (const b of content) {
      if (b.type === 'image') yield b;
      const nested = (b as { content?: unknown }).content;
      if (b.type === 'tool_result' && Array.isArray(nested)) yield* imagesOf(nested as ContentBlock[]);
    }
  }
  const calls = ['Claude', [
    { type: 'tool_use', id: 'a', name: 'shot', input: {} }, { type: 'tool_use', id: 'b', name: 'shot', input: {} },
  ] as ContentBlock[]] as [string, ContentBlock[]];
  const resultB = ['User', [{ type: 'tool_result', toolUseId: 'b', content: [{ type: 'text', text: 'result b' }] }] as unknown as ContentBlock[]] as [string, ContentBlock[]];

  for (const knob of ['maxLiveImages', 'imageStripDepthTokens', 'maxLiveImageBytes'] as const) for (const value of [-1, Number.NaN]) {
    it(`sends every image where no limit is positive (${knob} ${value}), as the estimate prices them`, async () => {
      const cm = await ContextManager.open({
        path: fresh(),
        strategy: new AutobiographicalStrategy({
          adaptiveResolution: true, overBudgetGraceRatio: 0, maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 0, [knob]: value,
        }),
      });
      cm.addMessage('User', [{ type: 'text', text: 'first' }, image('AAAA', 1600)]);
      cm.addMessage('Claude', [{ type: 'text', text: 'second' }, image('BBBB', 1600)]);
      const store = (cm as unknown as { messageStore: { estimateTokens(message: StoredMessage): number } }).messageStore;
      const compiled = await cm.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      const sent = compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as StoredMessage), 0);
      assert.equal([...compiled.messages.flatMap((m) => [...imagesOf(m.content)])].length, 2, 'both images go out');
      assert.equal(cm.getRenderStats()!.total.tokens, sent);
      cm.close();
    });
  }

  it("keeps the verdict the estimate gave a moved result's image, ahead of a later image in its message", async () => {
    // Result a holds image A, ahead of image B in its message: the estimate
    // keeps A live and prices B as the placeholder. Pairing repair moves
    // result a up beside result b, so the entries meet B first.
    const r = await compileMoved(1, [
      calls, resultB,
      ['User', [{ type: 'tool_result', toolUseId: 'a', content: [image('AAAA', 100), { type: 'text', text: 'result a' }] }, image('BBBB', 1600)] as unknown as ContentBlock[]],
      ['Claude', [{ type: 'text', text: 'done' }]],
    ]);
    assert.deepEqual(r.live, ['', 'AAAA', '', ''], 'premise: result a moved beside result b; A goes out live, B as the placeholder');
    assert.equal(r.total, r.sent, `render stats ${r.total}, sent ${r.sent}`);
    assert.equal(r.planned, r.actual);
  });

  it("keeps each image's own verdict where a moved result's image has the payload of a later image in its message, at another price", async () => {
    // As above, but A and B carry one payload: A's verdict is still A's.
    const r = await compileMoved(1, [
      calls, resultB,
      ['User', [{ type: 'tool_result', toolUseId: 'a', content: [image('AAAA', 100), { type: 'text', text: 'result a' }] }, image('AAAA', 1600)] as unknown as ContentBlock[]],
      ['Claude', [{ type: 'text', text: 'done' }]],
    ]);
    assert.deepEqual(r.live, ['', 'AAAA', '', ''], "premise: result a moved beside result b, and its image is the one that goes out live");
    assert.equal(r.total, r.sent, `render stats ${r.total}, sent ${r.sent}`);
    assert.equal(r.planned, r.actual);
  });

  it("gives an unmoved result its own message's verdicts where a later message reuses its call's id", async () => {
    const round = (label: string, data: string): Array<[string, ContentBlock[]]> => [
      ['Claude', [{ type: 'tool_use', id: 'x', name: 'shot', input: {} }] as ContentBlock[]],
      ['User', [{ type: 'tool_result', toolUseId: 'x', content: [image(data, 1600), { type: 'text', text: label }] }] as unknown as ContentBlock[]],
    ];
    const r = await compileMoved(2, [...round('first', 'FFFF'), ...round('second', 'SSSS'), ['Claude', [{ type: 'text', text: 'done' }]]]);
    assert.deepEqual(r.live, ['', 'FFFF', '', 'SSSS', ''], 'both rounds\' images go out live, within the limit of two');
    assert.equal(r.total, r.sent, `render stats ${r.total}, sent ${r.sent}`);
  });

  it("keeps a moved result's verdict where the repair copies it, giving up a raw form it shared with a block left behind", async () => {
    // Result a and the text after it share one raw item, so the moved result
    // is a copy without it (releaseSharedRawFormsOnMove): the copy is what
    // the repair records and what the strip meets.
    const item = { type: 'message', id: 'm-a', role: 'user', content: [] };
    const r = await compileMoved(1, [
      calls, resultB,
      ['User', [
        { type: 'tool_result', toolUseId: 'a', rawItem: item, content: [image('AAAA', 100), { type: 'text', text: 'result a' }] },
        { type: 'text', text: 'after the result', rawItem: item },
        image('BBBB', 1600),
      ] as unknown as ContentBlock[]],
      ['Claude', [{ type: 'text', text: 'done' }]],
    ]);
    assert.deepEqual(r.live, ['', 'AAAA', '', ''], "result a's copy moved beside result b goes out live, on its own verdict; B goes out as the placeholder");
  });

  it("gives a moved result its own message's verdicts where a later message reuses its call's id", async () => {
    // Text between call x and its result makes the repair move the result
    // up, into an entry of its own; a later round reuses the id x.
    const r = await compileMoved(2, [
      ['Claude', [{ type: 'tool_use', id: 'x', name: 'shot', input: {} }] as ContentBlock[]],
      ['User', [{ type: 'text', text: 'between' }]],
      ['User', [{ type: 'tool_result', toolUseId: 'x', content: [image('FFFF', 1600), { type: 'text', text: 'first' }] }] as unknown as ContentBlock[]],
      ['Claude', [{ type: 'tool_use', id: 'x', name: 'shot', input: {} }] as ContentBlock[]],
      ['User', [{ type: 'tool_result', toolUseId: 'x', content: [image('SSSS', 1600), { type: 'text', text: 'second' }] }] as unknown as ContentBlock[]],
      ['Claude', [{ type: 'text', text: 'done' }]],
    ]);
    assert.deepEqual(r.live.filter((data) => data !== '').sort(), ['FFFF', 'SSSS'], 'both rounds\' images go out live, within the limit of two');
    // Everything is priced but the text the repair leaves in the first result's place.
    assert.equal(r.total + r.movedText, r.sent, `render stats ${r.total} and the repair's text ${r.movedText}, sent ${r.sent}`);
  });

  it("counts a moved result's image once, so an older image the estimate kept stays live", async () => {
    // Result a's message sends nothing once the repair moves its result, so
    // its image goes out in result b's entry.
    const r = await compileMoved(2, [
      ['User', [{ type: 'text', text: 'old' }, image('OOOO', 1600)]],
      calls, resultB,
      ['User', [{ type: 'tool_result', toolUseId: 'a', content: [image('AAAA', 1600), { type: 'text', text: 'result a' }] }] as unknown as ContentBlock[]],
      ['Claude', [{ type: 'text', text: 'done' }]],
    ]);
    assert.deepEqual(r.live, ['OOOO', '', 'AAAA', '', ''], 'premise: result a moved beside result b; both images live');
    // Everything is priced but the text the repair leaves in result a's place.
    assert.equal(r.total + r.movedText, r.sent, `render stats ${r.total} and the repair's text ${r.movedText}, sent ${r.sent}`);
  });
});
