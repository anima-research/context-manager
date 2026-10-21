/**
 * `renderAsNewest`: what the next compile sends for messages just stored as
 * the newest of the window, for a caller that appends them to a compiled
 * request without recompiling (agent-framework's mid-turn injections). Most
 * cases compare the rendering with the next compile's newest messages; the
 * rest check the answers that aren't renderings (null, undefined, a
 * refusal), or what a render leaves behind for the compiles after it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, WindowedPassthroughStrategy } from '../src/index.js';
import type { ContextEntry, ContextStrategy, MessageStoreView, StoredMessage } from '../src/index.js';
import type { JsStore } from '@animalabs/chronicle';

const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** An image message labelled `label`, with `images` images of `bytes` base64
 *  characters each: a multiple of 4, since the store keeps an image's base64
 *  as the bytes it decodes to and re-encodes it on the way out. */
const imageMessage = (label: string, images = 1, bytes = 4): ContentBlock[] => [
  ...Array.from({ length: images }, () => (
    { type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes), mediaType: 'image/png' }, tokenEstimate: 100 } as ContentBlock)),
  { type: 'text', text: label },
];

/** About `words` × 1.5 tokens of text, starting with `label`. */
const longText = (label: string, words: number): ContentBlock[] =>
  [{ type: 'text', text: `${label} ${Array.from({ length: words }, (_, i) => `word${i}`).join(' ')}` }];

/** Content as sent, without the cache markers a compile places. */
const sent = (content: readonly unknown[]): unknown =>
  JSON.parse(JSON.stringify(content, (key, value) => (key === 'cache_control' ? undefined : value)));

const memory = (options: Record<string, unknown>) => new AutobiographicalStrategy({
  headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, ...options,
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
const windowed = (options: Record<string, unknown>) => new WindowedPassthroughStrategy({
  imageStripDepthTokens: 0, ...options,
} as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]);
const STRATEGIES = { autobiographical: memory, 'windowed passthrough': windowed };

async function withManager(
  strategy: ContextStrategy,
  run: (manager: ContextManager) => Promise<void>,
  viewFilter?: (message: StoredMessage) => boolean,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-render-as-newest-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, ...(viewFilter ? { viewFilter } : {}) });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The rendering of `ids`, and the next compile's newest `ids.length` messages. */
async function renderedAndSent(manager: ContextManager, ids: string[]): Promise<{ rendered: unknown[]; next: unknown[] }> {
  const rendered = manager.renderAsNewest(ids)!.map((content) => sent(content!));
  const compiled = await manager.compile(BUDGET);
  const next = compiled.messages.slice(-ids.length).map((m) => sent(m.content));
  return { rendered, next };
}

const textOf = (content: unknown): string =>
  (content as ContentBlock[]).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
const imagesIn = (content: unknown): number => (content as ContentBlock[]).filter((b) => b.type === 'image').length;

describe('renderAsNewest', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: a message past the cap comes back cut, as the next compile sends it`, async () => {
      await withManager(make({ maxMessageTokens: 50 }), async (manager) => {
        manager.addMessage('user', [{ type: 'text', text: 'before' }]);
        const id = manager.addMessage('user', longText('LONG', 300));
        const { rendered, next } = await renderedAndSent(manager, [id]);
        assert.deepEqual(rendered, next);
        assert.ok(textOf(rendered[0]).length < textOf(longText('LONG', 300)).length, 'the cap cut it');
      });
    });

    it(`${name}: a message under the cap comes back as stored`, async () => {
      await withManager(make({ maxMessageTokens: 50 }), async (manager) => {
        const id = manager.addMessage('user', [{ type: 'text', text: 'a short one' }]);
        const { rendered, next } = await renderedAndSent(manager, [id]);
        assert.deepEqual(rendered, next);
        assert.deepEqual(rendered[0], [{ type: 'text', text: 'a short one' }]);
      });
    });

    it(`${name}: images past the count, counted newest-first across the batch`, async () => {
      await withManager(make({ maxLiveImages: 2 }), async (manager) => {
        manager.addMessage('user', imageMessage('older', 1));
        const first = manager.addMessage('user', imageMessage('first', 2));
        const second = manager.addMessage('user', imageMessage('second', 2));
        const { rendered, next } = await renderedAndSent(manager, [first, second]);
        assert.deepEqual(rendered, next);
        assert.deepEqual(rendered.map(imagesIn), [0, 2], 'the newer message keeps the two images the count allows');
      });
    });

    it(`${name}: an image past the byte limit on its own`, async () => {
      await withManager(make({ maxLiveImageBytes: 8 }), async (manager) => {
        const id = manager.addMessage('user', imageMessage('big', 1, 12));
        const { rendered, next } = await renderedAndSent(manager, [id]);
        assert.deepEqual(rendered, next);
        assert.equal(imagesIn(rendered[0]), 0, 'the 12-byte image is past the 8-byte limit');
      });
    });

    it(`${name}: images past the depth, measured from the newest message`, async () => {
      // The store prices an image message at about 1,600 tokens, so the
      // newest one is within 2,000 and the deep one, past MID, isn't.
      await withManager(make({ imageStripDepthTokens: 2000 }), async (manager) => {
        manager.addMessage('user', [{ type: 'text', text: 'before' }]);
        const deep = manager.addMessage('user', imageMessage('deep', 1));
        const mid = manager.addMessage('user', longText('MID', 300));
        const newest = manager.addMessage('user', imageMessage('newest', 1));
        const { rendered, next } = await renderedAndSent(manager, [deep, mid, newest]);
        assert.deepEqual(rendered, next);
        assert.deepEqual([imagesIn(rendered[0]), imagesIn(rendered[2])], [0, 1],
          "the deep message's image is past 2,000 tokens from the newest, and the newest's isn't");
      });
    });

    it(`${name}: ids given out of store order, or twice, render as in store order, once`, async () => {
      await withManager(make({ maxLiveImages: 2 }), async (manager) => {
        const first = manager.addMessage('user', imageMessage('first', 2));
        const second = manager.addMessage('user', imageMessage('second', 2));
        const inOrder = manager.renderAsNewest([first, second])!.map((c) => sent(c!));
        const reversed = manager.renderAsNewest([second, first, second])!.map((c) => sent(c!));
        assert.deepEqual(reversed, [inOrder[1], inOrder[0], inOrder[1]]);
        assert.deepEqual(inOrder.map(imagesIn), [0, 2]);
      });
    });

    it(`${name}: an id the view filter leaves out comes back as null`, async () => {
      await withManager(make({}), async (manager) => {
        const shown = manager.addMessage('user', [{ type: 'text', text: 'shown' }]);
        const hidden = manager.addMessage('user', [{ type: 'text', text: 'hidden' }]);
        const result = manager.renderAsNewest([shown, hidden])!;
        assert.deepEqual(result.map((c) => (c === null ? null : textOf(c))), ['shown', null]);
      }, (message) => !message.content.some((b) => b.type === 'text' && b.text === 'hidden'));
    });

    it(`${name}: refuses an id no stored message has`, async () => {
      await withManager(make({}), async (manager) => {
        const id = manager.addMessage('user', [{ type: 'text', text: 'stored' }]);
        assert.throws(() => manager.renderAsNewest([id, 'no-such-id']), /no stored message has id no-such-id/);
      });
    });

    it(`${name}: image bytes counted across the batch, newest first`, async () => {
      await withManager(make({ maxLiveImageBytes: 8 }), async (manager) => {
        const ids = [1, 2, 3].map((i) => manager.addMessage('user', imageMessage(`img-${i}`, 1, 4)));
        const { rendered, next } = await renderedAndSent(manager, ids);
        assert.deepEqual(rendered, next);
        assert.deepEqual(rendered.map(imagesIn), [0, 1, 1], 'the newest two 4-byte images fill the 8 bytes');
      });
    });

    it(`${name}: a message stored after the batch counts toward its images, as in a compile`, async () => {
      await withManager(make({ maxLiveImages: 2 }), async (manager) => {
        const a = manager.addMessage('user', imageMessage('a', 1));
        const b = manager.addMessage('user', imageMessage('b', 1));
        manager.addMessage('user', imageMessage('c', 1));
        const rendered = manager.renderAsNewest([a, b])!.map((content) => sent(content!));
        const compiled = await manager.compile(BUDGET);
        assert.deepEqual(rendered, compiled.messages.slice(-3, -1).map((m) => sent(m.content)));
        assert.deepEqual(rendered.map(imagesIn), [0, 1], 'c and b keep the two images');
      });
    });

    it(`${name}: depth is measured on the messages as stored, before the cap`, async () => {
      // The image message is about 1,600 tokens and the long text about 650
      // as stored, past 2,000 together; cut to 50, the text would leave the
      // image within it.
      await withManager(make({ imageStripDepthTokens: 2000, maxMessageTokens: 50 }), async (manager) => {
        const deep = manager.addMessage('user', imageMessage('deep', 1));
        const after = manager.addMessage('user', longText('AFTER', 300));
        const { rendered, next } = await renderedAndSent(manager, [deep, after]);
        assert.deepEqual(rendered, next);
        assert.equal(imagesIn(rendered[0]), 0);
      });
    });
  }

  const sharding = (options: Record<string, unknown>) => memory({
    hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
    autoTickOnNewMessage: false, ...options,
  });

  it('autobiographical: a sharded body comes back joined, as the next compile sends it', async () => {
    await withManager(sharding({}), async (manager) => {
      const id = manager.addMessage('user', longText('BODY', 600));
      const shards = manager.getAllMessages().filter((m) => m.bodyGroupId !== undefined);
      assert.ok(shards.length > 1, `the body was stored as shards (${shards.length})`);
      const { rendered, next } = await renderedAndSent(manager, [id]);
      assert.deepEqual(rendered, next);
      assert.equal(textOf(rendered[0]), textOf(longText('BODY', 600)), 'joined whole');
    });
  });

  it('autobiographical: a sharded body under adaptive resolution with the hierarchical setting on', async () => {
    // selectPath takes the adaptive select whatever `hierarchical` says.
    await withManager(sharding({ hierarchical: true }), async (manager) => {
      const id = manager.addMessage('user', longText('BODY', 600));
      const { rendered, next } = await renderedAndSent(manager, [id]);
      assert.deepEqual(rendered, next);
      assert.equal(textOf(rendered[0]), textOf(longText('BODY', 600)), 'joined whole');
    });
  });

  it('autobiographical: any shard of a body renders the whole body', async () => {
    await withManager(sharding({}), async (manager) => {
      const id = manager.addMessage('user', longText('BODY', 600));
      const shards = manager.getAllMessages().filter((m) => m.bodyGroupId !== undefined);
      assert.equal(shards[0]!.id, id, 'addMessage returns the first shard');
      const [byFirst, byLater] = manager.renderAsNewest([id, shards[2]!.id])!;
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(byFirst!), sent(compiled.messages.at(-1)!.content));
      assert.deepEqual(sent(byLater!), sent(byFirst!));
      assert.equal(textOf(byLater), textOf(longText('BODY', 600)));
    });
  });

  it("autobiographical: a body too big for the window's recent part comes back as null", async () => {
    await withManager(sharding({ recentWindowTokens: 300 }), async (manager) => {
      const body = manager.addMessage('user', longText('BODY', 600));
      const lastShard = manager.getAllMessages().filter((m) => m.bodyGroupId !== undefined).at(-1)!.id;
      const after = manager.addMessage('user', [{ type: 'text', text: 'after' }]);
      const [forBody, forLastShard, forAfter] = manager.renderAsNewest([body, lastShard, after])!;
      assert.equal(forBody, null, 'the compile sends some of its shards from the middle');
      assert.equal(forLastShard, null, 'by any of its shards');
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(forAfter!), sent(compiled.messages.at(-1)!.content));
    });
  });

  it("autobiographical: a body that starts in the head window and runs on past it comes back as null", async () => {
    // Shards of about 100 tokens: the head's 150 holds the first, the recent
    // window's 300 the last few, and the middle the rest.
    await withManager(sharding({ headWindowTokens: 150, recentWindowTokens: 300 }), async (manager) => {
      const body = manager.addMessage('user', longText('BODY', 600));
      const after = manager.addMessage('user', [{ type: 'text', text: 'after' }]);
      const [forBody, forAfter] = manager.renderAsNewest([body, after])!;
      assert.equal(forBody, null, 'the compile sends its first shard in the head and others from the middle');
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(forAfter!), sent(compiled.messages.at(-1)!.content));
    });
  });

  it('autobiographical: with adaptive resolution off, each shard renders as its own message, as the hierarchical select sends it', async () => {
    // A store sharded under adaptive resolution, then read with it off, as a
    // host that rolls the setting back reads it.
    await withManager(sharding({}), async (manager) => {
      manager.addMessage('user', longText('BODY', 600));
      const shards = manager.getAllMessages().filter((m) => m.bodyGroupId !== undefined);
      await manager.setStrategy(memory({}));
      const { rendered, next } = await renderedAndSent(manager, shards.map((m) => m.id));
      assert.deepEqual(rendered, next);
      assert.equal(textOf(rendered[0]), textOf(shards[0]!.content), 'the first shard alone');
    });
  });

  it('autobiographical: two ingestions of the same text, given newest first, each render as its own body', async () => {
    // The same text gives both bodies one bodyGroupId. Only the second
    // carries an image, which ingress puts on its first shard, so each body
    // can be told from the other.
    await withManager(sharding({}), async (manager) => {
      manager.addMessage('user', longText('SAME', 600));
      const second = manager.addMessage('user', [...imageMessage('', 1).slice(0, 1), ...longText('SAME', 600)]);
      const shards = manager.getAllMessages().filter((m) => m.bodyGroupId !== undefined);
      const firstShards = shards.slice(0, shards.findIndex((m) => m.id === second));
      assert.equal(new Set(shards.map((m) => m.bodyGroupId)).size, 1, 'one bodyGroupId for both');
      const laterShardOfFirst = firstShards.find((m) => m.shardIndex === 2)!.id;
      const rendered = manager.renderAsNewest([second, laterShardOfFirst])!.map((content) => sent(content!));
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(rendered, compiled.messages.slice(-2).map((m) => sent(m.content)).reverse());
      assert.deepEqual(rendered.map(imagesIn), [1, 0], 'the second is the one with the image');
    });
  });

  it('autobiographical: refuses a branch it loaded before the store switched', async () => {
    await withManager(memory({}), async (manager) => {
      const id = manager.addMessage('user', [{ type: 'text', text: 'on main' }]);
      const main = manager.currentBranch().name;
      await manager.fork('other');
      // The store goes back to main underneath, without the manager's switch.
      (manager as unknown as { store: JsStore }).store.switchBranch(main);
      const view = (manager as unknown as { strategyMessageView(): MessageStoreView }).strategyMessageView();
      assert.throws(() => manager.getStrategy().renderAsNewest!(view, [id]), /requires reinitialization for the current branch generation/);
    });
  });

  it('autobiographical: renders only for the branch it has loaded', () => {
    const strategy = memory({});
    assert.throws(() => strategy.renderAsNewest({} as MessageStoreView, []), /requires reinitialization for the current branch generation/);
  });

  it("autobiographical: a sharded body under a cap below its shards' size", async () => {
    await withManager(sharding({ maxMessageTokens: 50 }), async (manager) => {
      const id = manager.addMessage('user', longText('BODY', 600));
      const { rendered, next } = await renderedAndSent(manager, [id]);
      assert.deepEqual(rendered, next);
      assert.ok(textOf(rendered[0]).length < textOf(longText('BODY', 600)).length, 'each shard was cut');
    });
  });

  it("autobiographical: a subclass's own cut is the one it renders with", async () => {
    class OwnCut extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        const text = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        return text.length > maxTokens * 4 ? [{ type: 'text', text: 'OWN CUT' }] : content;
      }
    }
    const strategy = new OwnCut({
      headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, maxMessageTokens: 50,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    await withManager(strategy, async (manager) => {
      const id = manager.addMessage('user', longText('LONG', 300));
      const { rendered, next } = await renderedAndSent(manager, [id]);
      assert.deepEqual(rendered, next);
      assert.equal(textOf(rendered[0]), 'OWN CUT');
    });
  });

  it('autobiographical: messages the head window holds, with nothing after it, render as the next compile sends them', async () => {
    await withManager(memory({ headWindowTokens: 1_000_000, recentWindowTokens: 100, maxLiveImages: 1, maxMessageTokens: 50 }), async (manager) => {
      manager.addMessage('user', imageMessage('older', 1));
      const ids = [manager.addMessage('user', imageMessage('a', 1)), manager.addMessage('user', longText('B', 300))];
      const { rendered, next } = await renderedAndSent(manager, ids);
      assert.deepEqual(rendered, next);
      assert.deepEqual(rendered.map(imagesIn), [1, 0], 'the newest image is the one the count keeps');
    });
  });

  it("autobiographical: after the head window's start is reset, messages it holds come back as null, since the history before it follows them", async () => {
    const strategy = memory({ headWindowTokens: 1_000_000, recentWindowTokens: 100 });
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'before the reset' }]);
      const a = manager.addMessage('user', [{ type: 'text', text: 'a' }]);
      strategy.resetHeadWindow(a);
      const b = manager.addMessage('user', [{ type: 'text', text: 'b' }]);
      assert.deepEqual(manager.renderAsNewest([a, b]), [null, null]);
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(compiled.messages.slice(-3).map((m) => textOf(m.content)), ['a', 'b', 'before the reset'], 'the compile sends the history after the head');
    });
  });

  it('autobiographical: a head message with a middle after it comes back as null', async () => {
    // Messages of about 90 tokens: the head's 150 holds the first, the
    // recent window's 150 the last, and the middle the five between.
    await withManager(memory({ headWindowTokens: 150, recentWindowTokens: 150 }), async (manager) => {
      const head = manager.addMessage('user', longText('HEAD', 60));
      for (let i = 0; i < 5; i++) manager.addMessage('user', longText(`MID${i}`, 60));
      const last = manager.addMessage('user', longText('LAST', 60));
      const [forHead, forLast] = manager.renderAsNewest([head, last])!;
      assert.equal(forHead, null);
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(forLast!), sent(compiled.messages.at(-1)!.content));
    });
  });

  it("autobiographical: after the head window's start is reset, a message past the head renders as the next compile sends it", async () => {
    const strategy = memory({ headWindowTokens: 150, recentWindowTokens: 150 });
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'before the reset' }]);
      const a = manager.addMessage('user', longText('A', 60));
      strategy.resetHeadWindow(a);
      for (let i = 0; i < 3; i++) manager.addMessage('user', longText(`M${i}`, 60));
      const last = manager.addMessage('user', longText('LAST', 60));
      const [forA, forLast] = manager.renderAsNewest([a, last])!;
      assert.equal(forA, null, 'the head is followed by the middle and the history before it');
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(forLast!), sent(compiled.messages.at(-1)!.content));
    });
  });

  it('autobiographical: a render that throws partway puts back what it had changed', async () => {
    let failCut = false;
    class FailingCut extends AutobiographicalStrategy {
      protected override truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
        if (failCut) throw new Error('cut failed');
        return super.truncateContent(content, maxTokens);
      }
    }
    const strategy = new FailingCut({
      headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0,
      maxLiveImages: 2, imageStripHysteresisRatio: 0.5, maxMessageTokens: 50,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    await withManager(strategy, async (manager) => {
      const ids = [1, 2, 3, 4].map((i) => manager.addMessage('user', imageMessage(`img-${i}`, 1)));
      ids.push(manager.addMessage('user', longText('LONG', 300)));
      const state = strategy as unknown as { _imageWatermark: unknown; _imageWatermarkLoaded: boolean; _postStripMemo: unknown; _dryRunSelect: boolean };
      state._imageWatermark = undefined;
      state._imageWatermarkLoaded = true;
      state._postStripMemo = null;
      failCut = true;
      assert.throws(() => manager.renderAsNewest(ids), /cut failed/);
      failCut = false;
      assert.equal(state._imageWatermark, undefined, 'the watermark is as it was');
      assert.equal(state._postStripMemo, null, 'the estimates are as they were');
      assert.equal(state._dryRunSelect, false, 'the next select is live');
    });
  });

  it("autobiographical: images the hysteresis watermark trims, as the next compile trims them", async () => {
    // Eight new images under a count of 6 at ratio 0.5: the watermark keeps
    // the newest 3 or 4, where the count alone would keep 6.
    await withManager(memory({ maxLiveImages: 6, imageStripHysteresisRatio: 0.5 }), async (manager) => {
      const ids: string[] = [];
      for (let i = 1; i <= 8; i++) ids.push(manager.addMessage('user', imageMessage(`new-${i}`, 1)));
      const { rendered, next } = await renderedAndSent(manager, ids);
      assert.deepEqual(rendered, next);
      assert.ok(rendered.filter((c) => imagesIn(c) > 0).length < 6, `the watermark trimmed past the count (${rendered.map(imagesIn).join('')})`);
    });
  });

  it('windowed passthrough: a message before the anchor comes back as null', async () => {
    await withManager(windowed({}), async (manager) => {
      const ids = Array.from({ length: 10 }, (_, i) => manager.addMessage('user', longText(`M${i}`, 60)));
      const small = { maxTokens: 600, reserveForResponse: 0 };
      await manager.compile(small);
      const rendered = manager.renderAsNewest([ids[0]!, ids[9]!])!;
      assert.equal(rendered[0], null, 'the re-anchor moved the window past the first message');
      const compiled = await manager.compile(small);
      assert.deepEqual(sent(rendered[1]!), sent(compiled.messages.at(-1)!.content));
    });
  });

  it('windowed passthrough: renders by the anchor of the branch the store is on', async () => {
    await withManager(windowed({}), async (manager) => {
      const ids = Array.from({ length: 10 }, (_, i) => manager.addMessage('user', longText(`M${i}`, 60)));
      const main = manager.currentBranch().name;
      await manager.fork('other');
      // Re-anchored past the first message on the fork only.
      await manager.compile({ maxTokens: 600, reserveForResponse: 0 });
      assert.equal(manager.renderAsNewest([ids[0]!])![0], null, "the fork's anchor leaves it out");
      // The store goes back to main underneath, without the manager's switch,
      // as a host's undo does.
      (manager as unknown as { store: JsStore }).store.switchBranch(main);
      const [first] = manager.renderAsNewest([ids[0]!, ids[9]!])!;
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(first!), sent(compiled.messages.at(-10)!.content), "main's anchor holds it");
    });
  });

  it('a compression hold that has timed out reads as released, as the next compile reads it', async () => {
    // Shards of about 100 tokens: held, the body starts the protected recent
    // window and renders whole; released, the recent window's 300 tokens
    // hold only its last shards, and the compile sends the rest from the
    // middle. The render comes after the hold's deadline, with no other
    // manager call between, so nothing else has released it.
    const clock = { t: 1_000 };
    const dir = mkdtempSync(join(tmpdir(), 'cm-render-as-newest-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: sharding({ recentWindowTokens: 300 }), now: () => clock.t });
    try {
      const body = manager.addMessage('user', longText('BODY', 600), undefined, undefined, { holdCompression: { timeoutMs: 100 } });
      const after = manager.addMessage('user', [{ type: 'text', text: 'after' }]);
      assert.notEqual(manager.renderAsNewest([body])![0], null, 'held, the body is in the recent window');
      clock.t = 1_200;
      const [forBody, forAfter] = manager.renderAsNewest([body, after])!;
      assert.equal(forBody, null, 'released, some of its shards go to the middle');
      const compiled = await manager.compile(BUDGET);
      assert.deepEqual(sent(forAfter!), sent(compiled.messages.at(-1)!.content));
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the manager refuses before its strategy has initialized', async () => {
    await withManager(memory({}), async (manager) => {
      const id = manager.addMessage('user', [{ type: 'text', text: 'stored' }]);
      const failing = memory({});
      (failing as unknown as { initialize: () => Promise<void> }).initialize = async () => { throw new Error('initialize failed'); };
      await assert.rejects(manager.setStrategy(failing));
      assert.throws(() => manager.renderAsNewest([id]), /requires successful strategy initialization/);
    });
  });

  it('a strategy without the hook gives undefined, so a caller appends the content as stored', async () => {
    const plain: ContextStrategy = {
      name: 'plain',
      select: (store: MessageStoreView): ContextEntry[] => store.getAll().map((m, index) => ({
        index, sourceMessageId: m.id, sourceRelation: 'copy', participant: m.participant, content: m.content,
      })),
    } as unknown as ContextStrategy;
    await withManager(plain, async (manager) => {
      const id = manager.addMessage('user', [{ type: 'text', text: 'as stored' }]);
      assert.equal(manager.renderAsNewest([id]), undefined);
      assert.throws(() => manager.renderAsNewest([id, 'no-such-id']), /no stored message has id no-such-id/, 'it refuses an unknown id first');
    });
  });

  it('autobiographical: rendering puts back the watermark and post-strip estimates it priced from', async () => {
    // With the watermark unloaded and no estimates kept, the render's image
    // pass prices afresh and advances the watermark for itself, as a dry
    // select does; what the next compile reads must be as it was before.
    const strategy = memory({ maxLiveImages: 2, imageStripHysteresisRatio: 0.5 });
    await withManager(strategy, async (manager) => {
      const ids = [1, 2, 3, 4].map((i) => manager.addMessage('user', imageMessage(`img-${i}`, 1)));
      const state = strategy as unknown as { _imageWatermark: unknown; _imageWatermarkLoaded: boolean; _postStripMemo: unknown; imageWatermarkStateId: string };
      state._imageWatermark = undefined;
      state._imageWatermarkLoaded = true;
      state._postStripMemo = null;
      // The stored watermark a restart would load, older than any advance.
      const store = (manager as unknown as { store: JsStore }).store;
      store.setStateJson(state.imageWatermarkStateId, { sequence: 0, at: 1 });
      const rendered = manager.renderAsNewest(ids)!;
      assert.equal(rendered.map(imagesIn).join(''), '0001', 'the watermark the render advanced keeps one image, where the count alone keeps two');
      assert.equal(state._imageWatermark, undefined, 'the watermark is as it was');
      assert.equal(state._postStripMemo, null, 'the estimates are as they were');
      assert.deepEqual(store.getStateJson(state.imageWatermarkStateId), { sequence: 0, at: 1 }, 'the stored watermark is as it was');
    });
  });

  it('autobiographical: under adaptive resolution, prices with the calibration the next compile loads', async () => {
    // A persisted multiplier of 1.5 makes the deep image message and the text
    // after it about 2,850 tokens, past a depth of 2,000; uncalibrated, about
    // 1,900, within it.
    const strategy = sharding({ imageStripDepthTokens: 2000 });
    await withManager(strategy, async (manager) => {
      const deep = manager.addMessage('user', imageMessage('deep', 1));
      const after = manager.addMessage('user', longText('AFTER', 120));
      const stateId = (strategy as unknown as { calibrationStateId: string }).calibrationStateId;
      (manager as unknown as { store: JsStore }).store.setStateJson(stateId, {
        multiplier: 1.5, pricing: (AutobiographicalStrategy as unknown as { CALIBRATION_PRICING_EPOCH: number }).CALIBRATION_PRICING_EPOCH,
      });
      const { rendered, next } = await renderedAndSent(manager, [deep, after]);
      assert.deepEqual(rendered, next);
      assert.equal(imagesIn(rendered[0]), 0, 'calibrated, the image is past the depth');
    });
  });

  it("autobiographical: the render's calibration load writes nothing to the store", async () => {
    // A record from an older pricing epoch is one a committing load re-stamps
    // or discards, writing it back.
    const strategy = sharding({});
    await withManager(strategy, async (manager) => {
      const id = manager.addMessage('user', longText('TEXT', 120));
      const stateId = (strategy as unknown as { calibrationStateId: string }).calibrationStateId;
      const store = (manager as unknown as { store: JsStore }).store;
      const epoch = (AutobiographicalStrategy as unknown as { CALIBRATION_PRICING_EPOCH: number }).CALIBRATION_PRICING_EPOCH;
      const record = { multiplier: 1.2, pricing: epoch - 1, at: 1 };
      store.setStateJson(stateId, record);
      (strategy as unknown as { _calibrationLoaded: boolean })._calibrationLoaded = false;
      manager.renderAsNewest([id]);
      assert.deepEqual(store.getStateJson(stateId), record);
    });
  });

  it("an id another writer stored, in an auxiliary view, renders as the next compile sends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-render-as-newest-'));
    const main = await ContextManager.open({ path: join(dir, 'store'), strategy: memory({}) });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: memory({}), auxiliaryMessageViews: [{}],
    });
    try {
      const theirs = main.addMessage('user', [{ type: 'text', text: 'from the other writer' }]);
      const [rendered] = side.renderAsNewest([theirs])!;
      const compiled = await side.compile(BUDGET);
      assert.deepEqual(sent(rendered!), sent(compiled.messages.at(-1)!.content));
    } finally {
      await side.close();
      await main.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('autobiographical: rendering changes nothing a compile reads', async () => {
    await withManager(memory({ maxLiveImages: 2, imageStripHysteresisRatio: 0.5, maxMessageTokens: 50 }), async (manager) => {
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`, 1));
      const id = manager.addMessage('user', longText('LONG', 300));
      const before = (await manager.compile(BUDGET)).messages.map((m) => sent(m.content));
      manager.renderAsNewest([id]);
      const after = (await manager.compile(BUDGET)).messages.map((m) => sent(m.content));
      assert.deepEqual(after, before);
    });
  });
});
