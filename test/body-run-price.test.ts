/**
 * A body ingress splits into shards is priced shard by shard: each shard at
 * the store's estimate of it, which takes its rate from the shard's own first
 * 2,000 characters. A run of the body's raw shards goes out as one text
 * block, in the adaptive middle through the shard path and in the head and
 * recent windows through their merge, and the strategy counts that block as
 * the parts it joins: in the plan, in the emission and eviction checks, and
 * in the render stats, which the calibration sample reads. The store's own
 * estimate of the joined block would put all of it at the rate its first
 * 2,000 characters set, so where the shards' densities differ it comes to
 * another count: over the parts here when the first shard is the denser, and
 * under them when it's the lighter. The middle used to count that estimate,
 * and so refused plans that fit, or claimed less than its plan.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, OverBudgetError, UncoveredDropError } from '../src/index.js';
import { Picker } from '../src/adaptive/picker.js';
import type { RenderStats, StoredMessage } from '../src/types/index.js';

const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const IMAGE = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock;

// JSON-like text, well past the share of punctuation at which the store
// prices a block as dense (2.3 characters a token), and prose with none of
// it (2.9). Ingress splits an 80,000-character body into seven shards of
// about 12,000 characters, four a token at the default targetChunkTokens.
const DENSE = '{"k":1,"v":[2,3]},'.repeat(700).slice(0, 12_000);
const PROSE = 'lorem ipsum dolor sit amet consectetur '.repeat(2_000).slice(0, 68_000);
const BODIES: Record<string, string> = {
  'a body whose first shard is denser than the rest': DENSE + PROSE,
  'a body whose last shard is denser than the rest': PROSE + DENSE,
};

type Where = { config: Record<string, unknown>; premise: (stats: RenderStats) => void };
/** Where the body's shards render. No summary exists, so nothing can fold. */
const WINDOWS: Record<string, Where> = {
  'raw in the adaptive middle': {
    config: { headWindowTokens: 0, recentWindowTokens: 2_000 },
    premise: (stats) => assert.deepEqual([stats.head.messages, stats.middleRaw.messages, stats.tail.messages], [0, 1, 2],
      'premise: the shards render in the middle as one run, and the two turns after them in the recent window'),
  },
  'in the recent window': {
    config: { headWindowTokens: 0, recentWindowTokens: 60_000 },
    premise: (stats) => assert.deepEqual([stats.head.messages, stats.middleRaw.messages, stats.tail.messages], [0, 0, 9],
      'premise: the recent window holds the seven shards and the two turns'),
  },
  'in the head window': {
    config: { headWindowTokens: 40_000, recentWindowTokens: 2_000 },
    premise: (stats) => assert.ok(stats.head.messages >= 7 && stats.middleRaw.messages === 0,
      `premise: the head holds the seven shards: ${stats.head.messages} messages`),
  },
};

const textOf = (message: { content: ContentBlock[] }): string =>
  message.content.map((block) => (block as { text?: string }).text ?? '').join('');

async function open(content: ContentBlock[], config: Record<string, unknown>, Strategy: typeof AutobiographicalStrategy = AutobiographicalStrategy) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-body-run-price-'));
  // No grace, so a budget means what it says.
  const strategy = new Strategy({ adaptiveResolution: true, overBudgetGraceRatio: 0, ...config });
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  manager.addMessage('u', content);
  manager.addMessage('a', [{ type: 'text', text: 'ok' }]);
  manager.addMessage('u', [{ type: 'text', text: 'next' }]);
  const store = (manager as unknown as {
    messageStore: { estimateTokens(message: StoredMessage): number; getAll(): StoredMessage[]; getTokenCalibration(): number };
  }).messageStore;
  /** The store's estimate of some content, taken as one message. */
  const estimate = (blocks: ContentBlock[]): number => store.estimateTokens({ content: blocks } as StoredMessage);
  /** The stored messages, each priced on its own, so each shard by itself; `keep` picks the blocks counted. */
  const parts = (keep: (block: ContentBlock) => boolean = () => true): number =>
    store.getAll().reduce((sum, m) => sum + estimate(m.content.filter(keep)), 0);
  /** The store's estimate of what a compile sends, each message it sends taken as one. */
  const joined = (compiled: { messages: Array<{ content: ContentBlock[] }> }): number =>
    compiled.messages.reduce((sum, m) => sum + estimate(m.content), 0);
  /** The render stats' total of a compile at `maxTokens`, or that it refused. */
  const attempt = async (maxTokens: number): Promise<number | 'refused'> => {
    try {
      await manager.compile({ maxTokens, reserveForResponse: 0 });
      return manager.getRenderStats()!.total.tokens;
    } catch (error) {
      if (error instanceof OverBudgetError || error instanceof UncoveredDropError) return 'refused';
      throw error;
    }
  };
  const shards = (): number => store.getAll().filter((m) => m.bodyGroupId).length;
  const close = async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { manager, strategy, store, parts, joined, attempt, shards, close };
}

describe("a body's raw shards, joined into one text block, are counted as the shards they join", () => {
  for (const [bodyName, text] of Object.entries(BODIES)) {
    for (const [where, { config, premise }] of Object.entries(WINDOWS)) {
      it(`${bodyName}, ${where}: the plan, the emitted count and the render stats are the shards' estimates, and a budget of that sends it all where one less is refused`, async () => {
        const o = await open([{ type: 'text', text }], config);
        try {
          assert.equal(o.shards(), 7, 'premise: ingress splits the body into seven shards');
          const compiled = await o.manager.compile(BIG);
          const stats = o.manager.getRenderStats()!;
          premise(stats);
          assert.equal(textOf(compiled.messages[0]), text, 'premise: the body goes out whole, as one message');
          const parts = o.parts();
          const joined = o.joined(compiled);
          assert.ok(Math.abs(joined - parts) > 1_000,
            `premise: the store's estimate of the joined block is another count: ${joined}, against ${parts} for the parts`);
          assert.equal(stats.total.tokens, parts, `render stats ${stats.total.tokens}, the parts ${parts}`);
          const { planned, actual } = stats.planVsActual!;
          assert.deepEqual([planned, actual], [parts, parts], `planned ${planned}, emitted ${actual}, the parts ${parts}`);
          assert.equal(await o.attempt(parts), parts, `a budget of ${parts} sends it all`);
          assert.equal(await o.attempt(parts - 1), 'refused', `a budget of ${parts - 1} is refused`);
        } finally {
          await o.close();
        }
      });
    }
  }

  it('raw in the adaptive middle at a multiplier of 1.3: each shard is counted at the multiplier the plan priced it at', async () => {
    const o = await open([{ type: 'text', text: DENSE + PROSE }], WINDOWS['raw in the adaptive middle'].config);
    try {
      await o.manager.compile(BIG); // loads the calibration, at 1 for a new store
      const internals = o.strategy as unknown as { _calibration: number; applyCalibration(): void };
      internals._calibration = 1.3;
      internals.applyCalibration();
      assert.equal(o.store.getTokenCalibration(), 1.3, 'premise: the store prices at 1.3');
      await o.manager.compile(BIG);
      const stats = o.manager.getRenderStats()!;
      const parts = o.parts();
      assert.ok(parts > 1.25 * 28_000, `premise: the parts are counted at the multiplier: ${parts}`);
      const { planned, actual } = stats.planVsActual!;
      assert.deepEqual([planned, actual, stats.total.tokens], [parts, parts, parts],
        `planned ${planned}, emitted ${actual}, render stats ${stats.total.tokens}, the parts ${parts}`);
    } finally {
      await o.close();
    }
  });

  it("raw in the adaptive middle, with an image on the first shard: the run is counted as the text it sends", async () => {
    // Ingress puts a split body's other blocks on its first shard, and the
    // middle's shard path sends only its shards' text. The plan prices the
    // image with the shard, so here it plans more than the run sends. With
    // no depth strip: at the default 30,000 tokens the first shard is the
    // message that crosses the depth, so the estimate, as the strip, would
    // price its image as the placeholder.
    const o = await open([{ type: 'text', text: DENSE + PROSE }, IMAGE], { ...WINDOWS['raw in the adaptive middle'].config, imageStripDepthTokens: 0 });
    try {
      const compiled = await o.manager.compile(BIG);
      const stats = o.manager.getRenderStats()!;
      assert.ok(compiled.messages.every((m) => m.content.every((block) => block.type === 'text')),
        'premise: the middle sends no image');
      const textParts = o.parts((block) => block.type === 'text');
      assert.ok(o.parts() > textParts, 'premise: the image has a price');
      const { planned, actual } = stats.planVsActual!;
      assert.equal(planned, o.parts(), `the plan counts the image with its shard: planned ${planned}, every part ${o.parts()}`);
      assert.deepEqual([actual, stats.total.tokens], [textParts, textParts],
        `emitted ${actual}, render stats ${stats.total.tokens}, the text parts ${textParts}`);
    } finally {
      await o.close();
    }
  });

  it('raw in the adaptive middle through the fallback for a planned level with no summary: the run is counted as its shards', async () => {
    // A solver that folds every chunk it may to level 1, where no summary
    // exists: the picker accounts each such chunk raw, and the shard path's
    // fallback for a shard with no ancestor at its level joins it to the raw
    // run.
    class UnrealizableStrategy extends AutobiographicalStrategy {
      static unrealizable = 0;
      protected override buildPicker(): Picker {
        const picker = new Picker({
          name: 'unrealizable-fixture',
          solve: (inputs) => ({ frontier: new Map(inputs.chunks.map((chunk) => [chunk.id, chunk.pinned ? 0 : 1])), produced: [] }),
        });
        const run = picker.run.bind(picker);
        picker.run = (...args: Parameters<Picker['run']>) => {
          const result = run(...args);
          UnrealizableStrategy.unrealizable = result.unrealizable;
          return result;
        };
        return picker;
      }
    }
    const o = await open([{ type: 'text', text: DENSE + PROSE }], WINDOWS['raw in the adaptive middle'].config, UnrealizableStrategy);
    try {
      await o.manager.compile(BIG);
      const stats = o.manager.getRenderStats()!;
      assert.equal(UnrealizableStrategy.unrealizable, 7, 'premise: the plan targets a level with no summary for each of the seven shards');
      assert.equal(stats.middleRaw.messages, 1, 'premise: the shards render raw in the middle, as one run');
      const parts = o.parts();
      const { planned, actual } = stats.planVsActual!;
      assert.deepEqual([planned, actual, stats.total.tokens], [parts, parts, parts],
        `planned ${planned}, emitted ${actual}, render stats ${stats.total.tokens}, the parts ${parts}`);
    } finally {
      await o.close();
    }
  });

  it("raw in the adaptive middle, with an emitter that counts more than the plan: the run's own check refuses the compile", async () => {
    // estimateTokens prices what the middle sends and, with no summaries yet,
    // nothing the plan counts, so doubling it puts the run over a plan that
    // fits its budget, and only the emission check stands between them.
    class DoubleCountingEmitter extends AutobiographicalStrategy {
      protected override estimateTokens(content: ContentBlock[]): number {
        return 2 * super.estimateTokens(content);
      }
    }
    const o = await open([{ type: 'text', text: PROSE + DENSE }], WINDOWS['raw in the adaptive middle'].config, DoubleCountingEmitter);
    try {
      const parts = o.parts();
      await assert.rejects(o.manager.compile({ maxTokens: parts, reserveForResponse: 0 }), /Emission overran the plan/);
    } finally {
      await o.close();
    }
  });
});
