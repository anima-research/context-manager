/**
 * The cut of a message `maxMessageTokens` caps is priced as it renders
 * (#223): what the strategy counts for the message in its plan, its budget
 * checks and its render stats is its path's price for it uncapped, plus the
 * store's estimate of what the cut changed. The cap cuts text and string tool
 * results only, at four characters a token, so a capped message's images,
 * tool calls and thinking go out whole, and its kept text is priced at the
 * store's own rate. Where no image is stripped, that sum is the store's
 * estimate of what's sent, except where the strategy joins a body's shards
 * back into one text block: it counts each shard on its own, and the store
 * would estimate the joined block once (the shard tests). The hierarchical
 * selection prices an image the strip replaces at full weight, uncapped
 * messages included, so the strip's case is tested in the adaptive
 * selection, whose base is post-strip.
 *
 * The rule it replaced charged a capped message no more than the cap plus
 * 50: too little for an image, a tool call or thinking the cap keeps whole,
 * and, at the multiplier of 1 these cases run at, for the text it keeps at
 * large caps, and too much for the few characters it keeps at small ones.
 * So the cases here cut both ways, and one is a message the cap leaves
 * whole, which the old rule charged the cap plus 50 too. Between them they
 * pin each place a raw message is priced but one:
 * the head window, the middle (positioned and combined recall pairs, a plan
 * whose level has no summary, and a body's raw shards, which the adaptive
 * middle sends uncut and the head and recent windows cut), the recent
 * window's reservation and eviction walk, the picker's pinned head and tail
 * chunks, kv-unified's tail units, and the windowed strategy's window. The
 * one, the refusal floor of the head and tail reservation, is pinned by
 * overbudget-diagnostics' floor tests. The windows' sizes aren't prices:
 * they're measured before the cap, in the stored history compression
 * summarizes. A cap that isn't a positive number is no cap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, OverBudgetError, UncoveredDropError, WindowedPassthroughStrategy } from '../src/index.js';
import { Picker, type PickerInputs } from '../src/adaptive/picker.js';
import type { ContextStrategy, StoredMessage } from '../src/types/index.js';

const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

const IMAGE = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock;

type Case = {
  cap: number;
  /** Oldest first, as (participant, content). */
  messages: Array<[string, ContentBlock[]]>;
  /** Which way the old price, the cap plus 50, was wrong for this case. */
  old: 'too little' | 'too much';
};

const CASES: Record<string, Case> = {
  'text past the cap and an image': {
    cap: 100,
    old: 'too little',
    messages: [['u', [{ type: 'text', text: 'p'.repeat(2000) }, IMAGE]]],
  },
  'text past the cap and a large tool call': {
    cap: 100,
    old: 'too little',
    messages: [
      ['a', [
        { type: 'text', text: 'q'.repeat(2000) },
        { type: 'tool_use', id: 't1', name: 'write', input: { content: 'y'.repeat(8000) } } as ContentBlock,
      ]],
      ['u', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock]],
    ],
  },
  'text alone past the cap': {
    cap: 100,
    old: 'too little',
    messages: [['u', [{ type: 'text', text: 'r'.repeat(2000) }]]],
  },
  // The cap leaves this message whole, since its text is under the cap and an
  // image isn't cut, and the old rule charged it the cap plus 50 all the same.
  'an image beside text under the cap': {
    cap: 100,
    old: 'too little',
    messages: [['u', [{ type: 'text', text: 'a short note' }, IMAGE]]],
  },
  // connectome-host's default cap. The cap keeps four characters a token,
  // which the store prices at its own rates.
  'prose alone past a cap of 10,000': {
    cap: 10_000,
    old: 'too little',
    messages: [['u', [{ type: 'text', text: 'r'.repeat(80_000) }]]],
  },
  // The result alone estimates past the default recent window, so both
  // messages fall in the middle.
  'a string tool result past a cap of 10,000': {
    cap: 10_000,
    old: 'too little',
    messages: [
      ['a', [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'f' } } as ContentBlock]],
      ['u', [{ type: 'tool_result', toolUseId: 't1', content: 'z'.repeat(80_000) } as ContentBlock]],
    ],
  },
  // A cap of 1 keeps four characters and the suffix, which estimate well
  // under the 51 the old price charged.
  'three texts past a cap of 1': {
    cap: 1,
    old: 'too much',
    messages: [
      ['u', [{ type: 'text', text: 'r'.repeat(400) }]],
      ['a', [{ type: 'text', text: 's'.repeat(400) }]],
      ['u', [{ type: 'text', text: 't'.repeat(400) }]],
    ],
  },
};

/** The autobiographical selections; no grace, so a budget means what it says. */
const SELECTIONS: Array<[string, Record<string, unknown>]> = [
  ['hierarchical selection', {}],
  ['hierarchical selection, combined recall pairs', { positionedRecallPairs: false }],
  ['adaptive selection', { adaptiveResolution: true }],
];

function autobiographical(cap: number, config: Record<string, unknown>): AutobiographicalStrategy {
  return new AutobiographicalStrategy({ maxMessageTokens: cap, overBudgetGraceRatio: 0, ...config });
}

/** The premise each case rests on: the old price would have been wrong for it. */
function assertOldPriceWrong(c: Case, sent: number): void {
  if (c.old === 'too little') {
    assert.ok(sent > c.cap + 50, `premise: what's sent estimates past cap + 50: ${sent}`);
  } else {
    assert.ok(sent < (c.cap + 50) * c.messages.length, `premise: what's sent estimates under cap + 50 a message: ${sent}`);
  }
}

async function open(strategy: ContextStrategy, messages: Array<[string, ContentBlock[]]>) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-capped-price-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  for (const [participant, content] of messages) manager.addMessage(participant, content);
  const store = (manager as unknown as { messageStore: { estimateTokens(message: StoredMessage): number } }).messageStore;
  /** The store's estimate of everything a compile sends. */
  const rendered = (compiled: { messages: Array<{ content: ContentBlock[] }> }): number =>
    compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as StoredMessage), 0);
  /** What a compile at `maxTokens` sends, or that it refused. */
  const attempt = async (maxTokens: number): Promise<number | 'refused'> => {
    try {
      return rendered(await manager.compile({ maxTokens, reserveForResponse: 0 }));
    } catch (error) {
      if (error instanceof OverBudgetError || error instanceof UncoveredDropError) return 'refused';
      throw error;
    }
  };
  const close = async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { manager, rendered, attempt, close };
}

/** The render stats' total is what's sent, and an adaptive plan counted what the emitter spent. */
function assertStatsMatch(manager: ContextManager, sent: number, adaptive: boolean): void {
  const stats = manager.getRenderStats()!;
  assert.equal(stats.total.tokens, sent, `render stats ${stats.total.tokens}, sent ${sent}`);
  if (adaptive) {
    assert.ok(stats.planVsActual, 'an adaptive compile reports its plan');
    assert.equal(stats.planVsActual.planned, stats.planVsActual.actual,
      `planned ${stats.planVsActual.planned}, emitted ${stats.planVsActual.actual}`);
  }
}

describe('a capped message is priced as it renders', () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const [mode, config] of SELECTIONS) {
      it(`autobiographical, ${mode}: ${name}: the render stats' total is the store's estimate of what's sent`, async () => {
        const { manager, rendered, close } = await open(autobiographical(c.cap, config), c.messages);
        try {
          const sent = rendered(await manager.compile(BIG));
          assertOldPriceWrong(c, sent);
          assertStatsMatch(manager, sent, config.adaptiveResolution === true);
        } finally {
          await close();
        }
      });
    }

    const strategies: Array<[string, () => ContextStrategy]> = [
      ...SELECTIONS.map(([mode, config]) => [`autobiographical, ${mode}`, () => autobiographical(c.cap, config)] as [string, () => ContextStrategy]),
      ['windowed passthrough', () => new WindowedPassthroughStrategy({ maxMessageTokens: c.cap })],
    ];
    for (const [label, make] of strategies) {
      it(`${label}: ${name}: a budget of what the window sends sends all of it, and one token less is refused or sends less`, async () => {
        const { rendered, attempt, close, manager } = await open(make(), c.messages);
        try {
          const sent = rendered(await manager.compile(BIG));
          assertOldPriceWrong(c, sent);
          const exact = await attempt(sent);
          assert.equal(exact, sent, `a budget of ${sent} sent ${exact}`);
          const under = await attempt(sent - 1);
          if (under !== 'refused') assert.ok(under <= sent - 1, `a budget of ${sent - 1} sent ${under}`);
        } finally {
          await close();
        }
      });
    }
  }
});

describe("a cap that isn't a positive number is no cap", () => {
  // A caller's explicit `maxMessageTokens: undefined` stays in the
  // autobiographical config, as the constructor resolves it. capContent cut
  // at NaN characters would send this text as its suffix alone.
  const text = 'r'.repeat(2000);
  const sentText = (compiled: { messages: Array<{ content: ContentBlock[] }> }): string =>
    compiled.messages.flatMap((m) => m.content).map((block) => (block as { text?: string }).text ?? '').join('');
  for (const [mode, config] of SELECTIONS) for (const [label, cap] of [['undefined', undefined], ['NaN', Number.NaN]] as const) {
    it(`autobiographical, ${mode}, a cap of ${label}: the message is sent whole, and the render stats count what's sent`, async () => {
      const strategy = new AutobiographicalStrategy({ maxMessageTokens: cap, ...config });
      const { manager, rendered, close } = await open(strategy, [['u', [{ type: 'text', text }]]]);
      try {
        const compiled = await manager.compile(BIG);
        assert.equal(sentText(compiled), text, `sent ${sentText(compiled).length} characters of ${text.length}`);
        assertStatsMatch(manager, rendered(compiled), config.adaptiveResolution === true);
      } finally {
        await close();
      }
    });
  }
  for (const [label, cap] of [['undefined', undefined], ['NaN', Number.NaN]] as const) {
    it(`windowed passthrough, a cap of ${label}: the message is sent whole`, async () => {
      const { manager, close } = await open(new WindowedPassthroughStrategy({ maxMessageTokens: cap }), [['u', [{ type: 'text', text }]]]);
      try {
        const compiled = await manager.compile(BIG);
        assert.equal(sentText(compiled), text, `sent ${sentText(compiled).length} characters of ${text.length}`);
      } finally {
        await close();
      }
    });
  }
});

describe('a capped message in the head window is priced as it renders', () => {
  // The image keeps the first message's whole estimate under the head window
  // and the second one pushes past it, so the head holds the first alone.
  const messages: Array<[string, ContentBlock[]]> = [
    ['u', [{ type: 'text', text: 'p'.repeat(2000) }, IMAGE]],
    ['a', [{ type: 'text', text: 'x'.repeat(4000) }]],
  ];
  for (const [mode, config] of SELECTIONS) {
    it(`autobiographical, ${mode}: the head's price is what it sends`, async () => {
      const { manager, rendered, close } = await open(autobiographical(100, { ...config, headWindowTokens: 3000 }), messages);
      try {
        const sent = rendered(await manager.compile(BIG));
        assert.equal(manager.getRenderStats()!.head.messages, 1, 'premise: the head holds the capped message');
        assertStatsMatch(manager, sent, config.adaptiveResolution === true);
      } finally {
        await close();
      }
    });
  }
});

describe("the picker's pinned head and tail chunks carry the prices the head and tail are reserved at", () => {
  // The picker reads headTokens and tailTokens for the raw windows; the
  // pinned chunks carry each message's price too, and kv-unified reads them.
  class CapturingStrategy extends AutobiographicalStrategy {
    inputs: PickerInputs | null = null;
    protected buildPicker(...args: [PickerInputs, ...unknown[]]): Picker {
      this.inputs = args[0];
      return (AutobiographicalStrategy.prototype as unknown as { buildPicker: (...rest: unknown[]) => Picker })
        .buildPicker.apply(this, args);
    }
  }
  it('autobiographical, adaptive selection: a capped head message and a capped tail message', async () => {
    const strategy = new CapturingStrategy({ maxMessageTokens: 100, adaptiveResolution: true, headWindowTokens: 3000 });
    const { manager, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'p'.repeat(2000) }, IMAGE]],
      ['a', [{ type: 'text', text: 'x'.repeat(4000) }, IMAGE]],
    ]);
    try {
      await manager.compile(BIG);
      const inputs = strategy.inputs!;
      const chunkTotal = (ids: ReadonlySet<string>): number =>
        inputs.chunks.filter((chunk) => ids.has(chunk.id)).reduce((sum, chunk) => sum + chunk.rawTokens, 0);
      assert.equal(inputs.headChunkIds.size, 1, 'premise: the head holds the first message');
      assert.equal(inputs.tailChunkIds.size, 1, 'premise: the tail holds the second');
      assert.ok(inputs.headTokens > 150 && inputs.tailTokens > 150,
        `premise: each is priced past cap + 50: head ${inputs.headTokens}, tail ${inputs.tailTokens}`);
      assert.equal(chunkTotal(inputs.headChunkIds), inputs.headTokens, 'the head chunks');
      assert.equal(chunkTotal(inputs.tailChunkIds), inputs.tailTokens, 'the tail chunks');
    } finally {
      await close();
    }
  });
});

describe("an override of truncateContent is the cut a raw message is priced and sent by", () => {
  // The strategy's cut is its protected truncateContent, which a raw message
  // and a summary both go through, so an override changes what a raw message
  // sends, and its price follows.
  class MarkedCut extends AutobiographicalStrategy {
    protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
      const long = content.some((block) => block.type === 'text' && block.text.length > maxTokens * 4);
      return maxTokens > 0 && long ? [{ type: 'text', text: 'cut by the override' }] : content;
    }
  }
  for (const [mode, config] of SELECTIONS) {
    it(`autobiographical, ${mode}: a capped message sends the override's cut, and the render stats count it`, async () => {
      const strategy = new MarkedCut({ maxMessageTokens: 100, overBudgetGraceRatio: 0, ...config });
      const { manager, rendered, attempt, close } = await open(strategy, [['u', [{ type: 'text', text: 'r'.repeat(2000) }]]]);
      try {
        const compiled = await manager.compile(BIG);
        const texts = compiled.messages.flatMap((m) => m.content.map((block) => (block as { text?: string }).text));
        assert.ok(texts.includes('cut by the override'), `the override's cut is sent: ${JSON.stringify(texts).slice(0, 200)}`);
        const sent = rendered(compiled);
        assertStatsMatch(manager, sent, config.adaptiveResolution === true);
        assert.equal(await attempt(sent), sent, `a budget of ${sent} sends all of it`);
      } finally {
        await close();
      }
    });
  }

  it('autobiographical, adaptive selection: an override that drops an image the strip replaces prices the message as the cut it sends', async () => {
    // The older message's image would be past the one live image. The
    // override's cut sends neither its text nor its image, so the estimate,
    // which counts the images the cut sends, gives it no slot and no saving.
    const strategy = new MarkedCut({ maxMessageTokens: 100, overBudgetGraceRatio: 0, adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, attempt, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'r'.repeat(2000) }, IMAGE]],
      ['a', [{ type: 'text', text: 'short' }, IMAGE]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      const sent = rendered(compiled);
      assertStatsMatch(manager, sent, true);
      assert.equal(await attempt(sent), sent, `a budget of ${sent} sends all of it`);
    } finally {
      await close();
    }
  });

  it("autobiographical, adaptive selection: a preview that overrides only maxMessageTokens prices that cap's cut, not the live compile's", async () => {
    // The live compile has no cap, so the older image goes out as the
    // placeholder. The preview's cap leaves it out, so its estimate must count
    // the images that cut sends, not reuse the live compile's.
    class DropsMarkedWhenCapped extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        const marked = content.some((block) => block.type === 'text' && block.text === 'drop images');
        return maxTokens > 0 && marked ? content.filter((block) => block.type !== 'image') : content;
      }
    }
    const strategy = new DropsMarkedWhenCapped({ overBudgetGraceRatio: 0, adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'drop images' }, IMAGE]],
      ['a', [{ type: 'text', text: 'newer' }, IMAGE]],
    ]);
    try {
      await manager.compile(BIG);
      const preview = manager.previewContext(BIG, { maxMessageTokens: 100 }, { render: true })!;
      assert.ok(preview.entries, 'premise: the preview renders');
      const images = preview.entries.flatMap((entry) => entry.content).filter((block) => block.type === 'image').length;
      assert.equal(images, 1, "premise: the preview's cut leaves out the older image");
      const sent = rendered({ messages: preview.entries });
      assert.equal(preview.finalTokens, sent, `preview ${preview.finalTokens}, rendered ${sent}`);
    } finally {
      await close();
    }
  });

  it('autobiographical, adaptive selection: an image the estimate gave no verdict, from an override that answers each call afresh, goes out as the placeholder', async () => {
    // Outside truncateContent's contract: each call renames the older
    // message's image, so the image the window sends isn't one the estimate
    // judged. It's replaced, which errs under the budget: the estimate priced
    // the image it judged as the placeholder, past the one live image.
    let calls = 0;
    class RenamesEachCall extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        if (maxTokens <= 0 || !content.some((block) => block.type === 'text' && block.text === 'renamed')) return content;
        calls++;
        return content.map((block) => block.type === 'image'
          ? { ...block, source: { type: 'base64', mediaType: 'image/png', data: `R${calls}` } } as ContentBlock
          : block);
      }
    }
    const strategy = new RenamesEachCall({ maxMessageTokens: 100, overBudgetGraceRatio: 0, adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'renamed' }, IMAGE]],
      ['a', [{ type: 'text', text: 'newer' }, IMAGE]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      const images = compiled.messages.flatMap((m) => m.content).filter((block) => block.type === 'image').length;
      assert.equal(images, 1, 'premise: only the newer image goes out live');
      assert.ok(calls >= 2, `premise: the cut was asked more than once (${calls})`);
      assertStatsMatch(manager, rendered(compiled), true);
    } finally {
      await close();
    }
  });

  it('autobiographical, adaptive selection: an image whose verdict was given to another image, from an override that reorders its images after the first call, never goes out over the plan', async () => {
    // Outside truncateContent's contract: every call after the first, which
    // the estimate makes, swaps the message's two images, so each sent image
    // meets the verdict the estimate gave the other. The estimate kept the
    // first live and priced the second as the placeholder; neither verdict
    // is the other image's, so both go out as the placeholder, under the
    // plan, rather than the second going out live on the first's verdict.
    // The blob store prices both images alike, so the live count, not the
    // budget check, is what tells the two outcomes apart.
    let calls = 0;
    class SwapsEachCall extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        if (maxTokens <= 0) return content;
        calls++;
        const images = content.filter((block) => block.type === 'image');
        const order = calls === 1 ? images : [...images].reverse();
        return [...content.filter((block) => block.type !== 'image'), ...order];
      }
    }
    const first = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'FIRST' } } as ContentBlock;
    const second = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'SECOND' } } as ContentBlock;
    const strategy = new SwapsEachCall({ maxMessageTokens: 100, overBudgetGraceRatio: 0, adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'two images' }, first, second]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      assert.ok(calls >= 2, `premise: the cut was asked more than once (${calls})`);
      const live = compiled.messages.flatMap((m) => m.content).filter((block) => block.type === 'image').length;
      assert.equal(live, 0, 'premise: the window sent the images in the other order, and neither went out live');
      const sent = rendered(compiled);
      const total = manager.getRenderStats()!.total.tokens;
      assert.ok(sent <= total, `sent ${sent}, past the render stats' ${total}`);
    } finally {
      await close();
    }
  });

  it('autobiographical, adaptive selection: an override that leaves out the live one of two images prices the one it sends as live', async () => {
    // With one live image, the first of the two takes the slot. The cut sends
    // only the second, which then takes it: the strip and the estimate both
    // decide over what the cut sends.
    class KeepsLastImage extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        const first = content.findIndex((block) => block.type === 'image');
        return maxTokens > 0 && first >= 0 ? content.filter((_, k) => k !== first) : content;
      }
    }
    const second = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'BBBB' } } as ContentBlock;
    const strategy = new KeepsLastImage({ maxMessageTokens: 100, overBudgetGraceRatio: 0, adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, attempt, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'two images' }, IMAGE, second]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      const images = compiled.messages.flatMap((m) => m.content).filter((block) => block.type === 'image').length;
      assert.equal(images, 1, 'premise: the cut sends the second image, and the strip keeps it live');
      const sent = rendered(compiled);
      assertStatsMatch(manager, sent, true);
      assert.equal(await attempt(sent - 1), 'refused', `a budget of ${sent - 1} is refused`);
    } finally {
      await close();
    }
  });

  it('autobiographical, adaptive selection: an override that leaves out one of two images alike prices the message as the cut it sends', async () => {
    // Two generated images with the same data, in one message: the first takes
    // the one live slot and the second is priced as the placeholder. The cut
    // leaves out the second, so the one it sends goes out live.
    class DropsLastImage extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        const last = content.map((block) => block.type).lastIndexOf('generated_image' as never);
        return maxTokens > 0 && last >= 0 ? content.filter((_, k) => k !== last) : content;
      }
    }
    const generated = { type: 'generated_image', data: 'C'.repeat(64), mimeType: 'image/png' } as unknown as ContentBlock;
    const strategy = new DropsLastImage({ maxMessageTokens: 100, overBudgetGraceRatio: 0, adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'two alike' }, generated, { ...generated } as ContentBlock]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      const images = compiled.messages.flatMap((m) => m.content).filter((block) => (block as { type: string }).type === 'generated_image').length;
      assert.equal(images, 1, 'premise: the cut sends one of the two, and the strip keeps it live');
      assertStatsMatch(manager, rendered(compiled), true);
    } finally {
      await close();
    }
  });

  // An override that rewrites a message and passes the rewrite on to this
  // class's cut, with the estimate it was given: the cut decides from the
  // rewrite's estimate, not the stored message's, whether the rewrite adds a
  // block or keeps the message's count of them.
  class AddsNote extends AutobiographicalStrategy {
    protected override truncateContent(
      content: ContentBlock[],
      maxTokens: number,
      estimate?: (content: ContentBlock[]) => number,
    ): ContentBlock[] {
      return super.truncateContent([...content, { type: 'text', text: 'n'.repeat(4000) }], maxTokens, estimate);
    }
  }
  class ReplacesText extends AutobiographicalStrategy {
    protected override truncateContent(
      content: ContentBlock[],
      maxTokens: number,
      estimate?: (content: ContentBlock[]) => number,
    ): ContentBlock[] {
      const rewritten = content.map((block) => (block.type === 'text' ? { type: 'text', text: 'n'.repeat(4000) } as ContentBlock : block));
      return super.truncateContent(rewritten, maxTokens, estimate);
    }
  }
  const rewrites: Array<[string, typeof AutobiographicalStrategy]> = [
    ['that adds a block', AddsNote],
    ['that keeps the block count', ReplacesText],
  ];
  for (const [how, Rewrites] of rewrites) for (const [mode, config] of SELECTIONS) {
    it(`autobiographical, ${mode}: a rewrite ${how}, passed on to the cut, is cut by its own estimate, and the render stats count it`, async () => {
      // 'hello' alone is 2 tokens to the cut's estimate, under a cap of 100,
      // and with the override's 4,000 characters it is past 1,000.
      const strategy = new Rewrites({ maxMessageTokens: 100, overBudgetGraceRatio: 0, ...config });
      const { manager, rendered, attempt, close } = await open(strategy, [['u', [{ type: 'text', text: 'hello' }]]]);
      try {
        const compiled = await manager.compile(BIG);
        const texts = compiled.messages.flatMap((m) => m.content.map((block) => (block as { text?: string }).text ?? ''));
        assert.ok(texts.some((text) => text.includes('[truncated — original was 1000 tokens]')),
          `the rewrite is cut: ${JSON.stringify(texts.map((text) => text.slice(0, 60)))}`);
        assert.ok(!texts.some((text) => text.includes('n'.repeat(4000))), 'nothing sends the rewrite whole');
        const sent = rendered(compiled);
        assertStatsMatch(manager, sent, config.adaptiveResolution === true);
        assert.equal(await attempt(sent), sent, `a budget of ${sent} sends all of it`);
      } finally {
        await close();
      }
    });
  }
});

describe("the cut asks about a stored message's own content through the message's cached estimate", () => {
  // The text-only estimate is cached on the stored message object, so a site
  // that gives the cut that message's content reads its estimate from the
  // cache, where any other object, a copy of the message included, is
  // estimated afresh.
  class RecordsEstimates extends AutobiographicalStrategy {
    asked: StoredMessage[] = [];
    protected override estimateTextOnlyTokens(msg: StoredMessage): number {
      this.asked.push(msg);
      return super.estimateTextOnlyTokens(msg);
    }
  }
  for (const [mode, config] of SELECTIONS) {
    it(`autobiographical, ${mode}: a compile of raw messages under a cap estimates only the stored messages themselves`, async () => {
      const strategy = new RecordsEstimates({ maxMessageTokens: 100, ...config });
      const { manager, close } = await open(strategy, [
        ['u', [{ type: 'text', text: 'r'.repeat(2000) }]],
        ['a', [{ type: 'text', text: 'ok' }]],
      ]);
      try {
        const compiled = await manager.compile(BIG);
        const texts = compiled.messages.flatMap((m) => m.content.map((block) => (block as { text?: string }).text ?? ''));
        assert.ok(texts.some((text) => text.includes('[truncated')), 'premise: the cap cuts the first message');
        const store = (manager as unknown as { messageStore: { getAll(): StoredMessage[] } }).messageStore;
        const stored = new Map(store.getAll().map((m) => [m.id, m]));
        assert.ok(strategy.asked.length > 0, 'premise: the cut asked for estimates');
        const apart = strategy.asked.filter((m) => stored.get(m.id) !== m);
        assert.equal(apart.length, 0, `estimated apart from the stored messages: ${apart.length} of ${strategy.asked.length}`);
      } finally {
        await close();
      }
    });
  }
});

describe("a body's raw shards go out uncut in the adaptive middle and cut in the head and recent windows, each priced as it's sent", () => {
  // Ingress splits a long text into shards of about targetChunkTokens at four
  // characters a token, 12,000 characters by default. In the middle, the
  // shard path joins a body's raw shards into one entry without the cap, so a
  // cap smaller than a shard doesn't cut them there. The head and recent
  // windows cut each shard as they emit it.
  const body: Array<[string, ContentBlock[]]> = [
    ['u', [{ type: 'text', text: 'r'.repeat(80_000) }]],
    ['a', [{ type: 'text', text: 'ok' }]],
    ['u', [{ type: 'text', text: 'next' }]],
  ];
  const textOf = (message: { content: ContentBlock[] }): string =>
    message.content.map((block) => (block as { text?: string }).text ?? '').join('');
  // The strategy merges a run of a body's raw shards into one entry, their
  // texts joined into one block (mergeAdjacentBodyGroupRaw), so the cut
  // shards are counted by their truncation suffixes.
  const cutShards = (compiled: { messages: Array<{ content: ContentBlock[] }> }): number =>
    compiled.messages.map(textOf).join('').split('[truncated').length - 1;
  type Sent = { messages: Array<{ content: ContentBlock[] }> };
  type Stats = { head: { messages: number }; tail: { messages: number } };
  // A text block's estimate is its characters over a rate the store picks
  // from its first 2,000 characters, rounded up. The strategy counts each
  // shard on its own, in the head and recent windows and in the middle's
  // joined run alike, so where the request joins the shards into one block,
  // the render stats come to between 0 and 6 tokens over the store's
  // estimate of what's sent, and the plan is what the emitter counted.
  // Shards of different densities are body-run-price's cases.
  const windows: Array<[string, Record<string, unknown>, (compiled: Sent, stats: Stats) => void]> = [
    ['in the middle, uncut', { headWindowTokens: 0, recentWindowTokens: 2000 }, (compiled) =>
      assert.equal(textOf(compiled.messages[0]).length, 80_000, 'premise: the middle sends the body uncut, its shards joined')],
    ['in the recent window, cut', { headWindowTokens: 0 }, (compiled, stats) => {
      assert.ok(stats.tail.messages >= 7, `premise: the tail holds the seven shards: ${stats.tail.messages} messages`);
      assert.equal(cutShards(compiled), 7, 'premise: the recent window sends each shard cut');
    }],
    ['in the head window, cut', { headWindowTokens: 40_000 }, (compiled, stats) => {
      assert.ok(stats.head.messages >= 7, `premise: the head holds the seven shards: ${stats.head.messages} messages`);
      assert.equal(cutShards(compiled), 7, 'premise: the head sends each shard cut');
    }],
  ];
  for (const [where, config, premise] of windows) {
    it(`autobiographical, adaptive selection, a cap of 1,000 tokens under shards of 12,000 characters: ${where}`, async () => {
      const strategy = autobiographical(1000, { adaptiveResolution: true, ...config });
      const { manager, rendered, attempt, close } = await open(strategy, body);
      try {
        const compiled = await manager.compile(BIG);
        const stats = manager.getRenderStats()!;
        premise(compiled, stats);
        const sent = rendered(compiled);
        const price = stats.total.tokens;
        assert.ok(price - sent >= 0 && price - sent <= 6, `render stats ${price}, sent ${sent}`);
        const { planned, actual } = stats.planVsActual!;
        assert.equal(planned, actual, `planned ${planned}, emitted ${actual}`);
        assert.equal(await attempt(price), sent, `a budget of ${price} sends all of it`);
        const under = await attempt(price - 1);
        if (under !== 'refused') assert.ok(under < sent, `a budget of ${price - 1} sent ${under}`);
      } finally {
        await close();
      }
    });
  }
});

describe('a capped message in a plan whose level has no summary is priced as it renders', () => {
  // A solver that folds every chunk it may to level 1 where no summary
  // exists: the picker accounts each such chunk raw, and the emitter's
  // fallback for a level with no ancestor renders it raw.
  class UnrealizableStrategy extends AutobiographicalStrategy {
    unrealizable = 0;
    protected buildPicker(): Picker {
      const picker = new Picker({
        name: 'unrealizable-fixture',
        solve: (inputs) => ({ frontier: new Map(inputs.chunks.map((chunk) => [chunk.id, chunk.pinned ? 0 : 1])), produced: [] }),
      });
      const run = picker.run.bind(picker);
      picker.run = (...args: Parameters<Picker['run']>) => {
        const result = run(...args);
        this.unrealizable = result.unrealizable;
        return result;
      };
      return picker;
    }
  }
  it('autobiographical, adaptive selection: the fallback renders the message at its price', async () => {
    const strategy = new UnrealizableStrategy({ maxMessageTokens: 100, adaptiveResolution: true, recentWindowTokens: 100 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'p'.repeat(2000) }, IMAGE]],
      ['a', [{ type: 'text', text: 'ok' }]],
    ]);
    try {
      const sent = rendered(await manager.compile(BIG));
      assert.equal(strategy.unrealizable, 1, 'premise: the plan targets a level with no summary for the capped message');
      assert.equal(manager.getRenderStats()!.middleRaw.messages, 1, 'premise: the capped message renders raw in the middle');
      assertStatsMatch(manager, sent, true);
    } finally {
      await close();
    }
  });
});

describe('a capped message whose image the strip replaces is priced with that image counted once', () => {
  it('autobiographical, adaptive selection: an image the cut sends as a copy, releasing a raw form it shared with the cut text, is priced once', async () => {
    // The cut releases the cut text's raw form, and so copies the image that
    // shares it. The estimate priced that image as the placeholder, and the
    // copy goes out as one.
    const raw = { type: 'message', id: 'm-old', role: 'user', content: [] };
    const url = { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' }, rawItem: raw } as ContentBlock;
    const strategy = autobiographical(100, { adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'p'.repeat(2000), rawItem: raw } as ContentBlock, url]],
      ['a', [{ type: 'text', text: 'q'.repeat(2000) }, IMAGE]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      const images = compiled.messages.flatMap((m) => m.content).filter((block) => block.type === 'image').length;
      assert.equal(images, 1, 'premise: the strip replaces the older image of the two');
      assertStatsMatch(manager, rendered(compiled), true);
    } finally {
      await close();
    }
  });

  it('autobiographical, adaptive selection, keeping one live image', async () => {
    const strategy = autobiographical(100, { adaptiveResolution: true, maxLiveImages: 1 });
    const { manager, rendered, close } = await open(strategy, [
      ['u', [{ type: 'text', text: 'p'.repeat(2000) }, IMAGE]],
      ['a', [{ type: 'text', text: 'q'.repeat(2000) }, IMAGE]],
    ]);
    try {
      const compiled = await manager.compile(BIG);
      const images = compiled.messages.flatMap((m) => m.content).filter((block) => block.type === 'image').length;
      assert.equal(images, 1, 'premise: the strip replaces the older image of the two');
      const sent = rendered(compiled);
      const stats = manager.getRenderStats()!;
      // The post-strip estimate takes the stripped image's placeholder at the
      // store's price for its text, so the two agree exactly.
      assert.equal(stats.total.tokens, sent, `render stats ${stats.total.tokens}, sent ${sent}`);
      assert.equal(stats.planVsActual!.planned, stats.planVsActual!.actual,
        `planned ${stats.planVsActual!.planned}, emitted ${stats.planVsActual!.actual}`);
    } finally {
      await close();
    }
  });
});

describe('kv-unified prices a capped tail message as it renders', () => {
  // The integration tests' recipe (kv-unified refuses live defaults).
  const kvUnified = {
    policy: {
      alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
      cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
      continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
      continuityStableHalfLife: 10, continuityStableFloor: 0.25,
    },
    tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
    treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
  };
  it('the tail message is its own unit at that price, with nothing left to the opaque tail block', async () => {
    const strategy = new AutobiographicalStrategy({ maxMessageTokens: 100, adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified });
    const { manager, rendered, close } = await open(strategy, CASES['text past the cap and an image'].messages);
    try {
      const sent = rendered(await manager.compile(BIG, undefined, { kvUnifiedImmutablePrefixHash: 'v1' }));
      const draft = (strategy as unknown as {
        kvUnifiedDraft: { layout: { units: Array<{ kind: string; key: string; tokens: number }>; totalTokens: number } };
      }).kvUnifiedDraft;
      const units = draft.layout.units.map((unit) => `${unit.kind}:${unit.tokens}`).join(', ');
      assert.ok(draft.layout.units.every((unit) => unit.kind !== 'tail'), `every tail token is attributed to its message: ${units}`);
      assert.equal(draft.layout.totalTokens, sent);
    } finally {
      await close();
    }
  });
});
