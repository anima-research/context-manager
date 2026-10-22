/**
 * A body ingress splits into shards goes out as it was given, wherever its
 * shards render: every block in its place, its text blocks with their own
 * boundaries, and one message whichever regions its raw shards fall in. A
 * body stored before each block was kept in place goes out in the windows as
 * it always did, and in the middle as in the windows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } } as unknown as ContentBlock;
const prose = (tag: string, chars: number) => `${tag} sentence of the body, plain words. `.repeat(Math.ceil(chars / 40)).slice(0, chars);
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string) => ({ type: 'tool_use', id, name: 'get_weather', input: { city: 'Oslo' } }) as unknown as ContentBlock;
const result = (id: string, content: string) => ({ type: 'tool_result', toolUseId: id, content }) as unknown as ContentBlock;
const tools = [{ name: 'get_weather', description: 'The weather in a city.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }];

/** Each shape: the messages written, and which of them is the body watched. */
const SHAPES: Record<string, { writes: Array<[string, ContentBlock[]]>; body: number }> = {
  'a reply that thinks, writes and calls a tool': {
    writes: [['User', [text('please check the weather')]],
      ['Claude', [{ type: 'thinking', thinking: 'let me look it up', signature: 'SIG' } as unknown as ContentBlock, text(prose('REPLY', 40_000)), call('call-1')]],
      ['User', [result('call-1', 'Sunny.')]]],
    body: 1,
  },
  'two text blocks': { writes: [['User', [text(prose('FIRST', 20_000)), text(prose('SECOND', 20_000))]]], body: 0 },
  'a short text, an image, a long text': { writes: [['User', [text('Look at this:'), image, text(prose('DETAIL', 40_000))]]], body: 0 },
  'an image before its caption': { writes: [['User', [image, text(prose('CAPTION', 40_000))]]], body: 0 },
  'a result, then a long note': {
    writes: [['Claude', [call('call-2')]], ['User', [result('call-2', 'Rain.'), text(prose('NOTE', 40_000))]]],
    body: 1,
  },
};
/** Where the body's raw shards render. No summary exists, so nothing folds. */
const PLACES: Record<string, Record<string, unknown>> = {
  'in the recent window': { headWindowTokens: 0, recentWindowTokens: 1_000_000 },
  'raw in the adaptive middle': { headWindowTokens: 0, recentWindowTokens: 300 },
  'across the middle and the recent window': { headWindowTokens: 0, recentWindowTokens: 6_000 },
  'in the head window': { headWindowTokens: 1_000_000, recentWindowTokens: 300 },
};
const FOLDS: Record<string, Record<string, unknown>> = {
  'the default folding': {},
  'kv-unified': {
    foldingStrategy: 'kv-unified',
    kvUnified: {
      policy: {
        alpha: 0.7, budgetLowRatio: 0.6, budgetHighRatio: 0.85, budgetUnderLambda: 1_000, budgetOverLambda: 4_000,
        cacheLambda: 1, cacheScale: 100_000, cacheReadPrice: 0.1, cacheWritePrice: 2,
        continuityLambda: 1, continuityScale: 100_000, continuityRecencyHalfLifeTokens: 100_000, continuityRecencyFloor: 0.2,
        continuityStableHalfLife: 16, continuityStableFloor: 0.25,
      },
      tokenBucketSize: 50_000, continuityBucketSize: 50_000, fidelityBucketSize: 100_000, labelCeiling: 100_000,
      adoptEpsilon: 3_000, treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false, hysteresisCertificate: true,
    },
  },
};

/** JSON with object keys sorted: the store keeps a block's fields, not their order. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

/** Ingress as bodies were stored before each block was kept in place: the
 *  text joined into one block, cut across the shards, and the other blocks on
 *  the first shard after its text, with no seam declared. */
class LegacyIngress extends AutobiographicalStrategy {
  override chunkIngressMessage(participant: string, content: ContentBlock[]) {
    const decision = super.chunkIngressMessage(participant, content);
    if (!decision) return decision;
    const others = content.filter((block) => block.type !== 'text');
    return {
      bodyGroupId: decision.bodyGroupId,
      shards: decision.shards.map((shard, k) => ({
        shardIndex: shard.shardIndex,
        content: [
          text(shard.content.map((block) => (block.type === 'text' ? block.text : '')).join('')),
          ...(k === 0 ? others : []),
        ],
      })),
    };
  }
}

async function compileShape(
  shape: { writes: Array<[string, ContentBlock[]]>; body: number },
  config: Record<string, unknown>,
  Strategy: typeof AutobiographicalStrategy = AutobiographicalStrategy,
) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-'));
  const strategy = new Strategy({ adaptiveResolution: true, maxMessageTokens: 100_000, autoTickOnNewMessage: false, ...config });
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  manager.setToolDefinitions(tools as never);
  try {
    let bodyIds: string[] = [];
    for (const [k, [participant, content]] of shape.writes.entries()) {
      const before = manager.getAllMessages().length;
      manager.addMessage(participant, content);
      if (k === shape.body) bodyIds = manager.getAllMessages().slice(before).map((m) => m.id);
    }
    for (let k = 0; k < 2; k++) {
      manager.addMessage('User', [text(`after ${k} ` + 'u '.repeat(300))]);
      manager.addMessage('Claude', [text(`reply ${k} ` + 'a '.repeat(300))]);
    }
    const compiled = await manager.compile({ maxTokens: 400_000, reserveForResponse: 0 }, undefined,
      (config.foldingStrategy === 'kv-unified' ? { kvUnifiedImmutablePrefixHash: 'immutable' } : undefined) as never);
    const stats = manager.getRenderStats()!;
    return { compiled, stats, bodyIds };
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a sharded body goes out as it was given, wherever its shards render', () => {
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    for (const [place, placeConfig] of Object.entries(PLACES)) {
      for (const [fold, foldConfig] of Object.entries(FOLDS)) {
        it(`${shapeName}, ${place}, under ${fold}`, async () => {
          const { compiled, stats, bodyIds } = await compileShape(shape, { ...placeConfig, ...foldConfig });
          assert.ok(bodyIds.length > 2, `premise: the body is stored as shards (${bodyIds.length})`);
          // Messages written after the body: the rest of the shape, then four turns.
          const after = shape.writes.length - 1 - shape.body + 4;
          if (place === 'raw in the adaptive middle') assert.ok(stats.middleRaw.tokens > 0, 'premise: the middle sends raw history');
          if (place === 'across the middle and the recent window') {
            assert.ok(stats.middleRaw.tokens > 0, 'premise: the middle sends some of the body raw');
            assert.ok(stats.tail.messages > after, `premise: the recent window holds some of its shards too (${stats.tail.messages} messages)`);
          }
          const given = shape.writes[shape.body]![1];
          const at = compiled.messages.findIndex((m) => canonical(m.content) === canonical(given));
          assert.ok(at >= 0, 'a message sends the body, exactly as given');
          // Nothing of the body anywhere else: its tagged text, its images, its tool blocks.
          const tags = given.flatMap((b) => {
            const tag = b.type === 'text' ? /^([A-Z]{4,}) /.exec((b as { text: string }).text)?.[1] : undefined;
            return tag ? [tag] : [];
          });
          const uses = given.flatMap((b) => (b.type === 'tool_use' ? [(b as { id: string }).id] : []));
          const results = given.flatMap((b) => (b.type === 'tool_result' ? [(b as { toolUseId: string }).toolUseId] : []));
          // The body's untagged text, such as an introduction, whole.
          const plain = given.flatMap((b) => (b.type === 'text' && !/^[A-Z]{4,} /.test((b as { text: string }).text) ? [(b as { text: string }).text] : []));
          const ownBlock = (b: ContentBlock) =>
            (b.type === 'text' && tags.some((tag) => b.text.includes(`${tag} sentence`))) ||
            (b.type === 'text' && plain.some((t) => b.text.includes(t))) ||
            (b.type === 'image' && given.some((g) => g.type === 'image')) ||
            (b.type === 'thinking' && given.some((g) => g.type === 'thinking')) ||
            (b.type === 'tool_use' && uses.includes((b as { id: string }).id)) ||
            (b.type === 'tool_result' && results.includes((b as { toolUseId: string }).toolUseId));
          compiled.messages.forEach((m, i) => {
            if (i !== at) assert.ok(!m.content.some(ownBlock), `message ${i} carries none of the body`);
          });
        });
      }
    }
  }
});

describe('a body stored before each block was kept in place', () => {
  const shape = SHAPES['a short text, an image, a long text']!;
  const given = shape.writes[0]![1];
  /** How such a body always went out from the windows: its other blocks, then its text joined. */
  const legacyRender = [image, text(given.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(''))];
  for (const place of ['in the recent window', 'in the head window', 'raw in the adaptive middle', 'across the middle and the recent window']) {
    it(`goes out ${place} as the windows always sent it: its image, then its text as one block`, async () => {
      const { compiled, bodyIds } = await compileShape(shape, PLACES[place]!, LegacyIngress);
      assert.ok(bodyIds.length > 2, 'premise: the body is stored as shards');
      const sent = compiled.messages.filter((m) => canonical(m.content) === canonical(legacyRender));
      assert.equal(sent.length, 1);
    });
  }
});

describe("the recent window starting at a result keeps the call it answers, from the call's first shard that holds a tool_use or a thinking block", () => {
  for (const [legacy, thinking] of [[false, false], [false, 'thinking'], [false, 'redacted_thinking'], [true, false]] as const) {
    it(legacy ? 'a call stored before each block was kept in place: from its first shard'
      : thinking ? `a call that thinks first (${thinking}): from its first shard, which holds the thinking the newest call is sent with`
      : 'a call ending in its tool_use: from its last shard', async () => {
      const Base = legacy ? LegacyIngress : AutobiographicalStrategy;
      class Exposed extends Base {
        recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
        estimates(store: unknown) { return this.postStripEstimates(store as never); }
      }
      const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-window-'));
      const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, headWindowTokens: 0, recentWindowTokens: 1 });
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
      manager.setToolDefinitions(tools as never);
      try {
        manager.addMessage('User', [text('please check the weather')]);
        const before = manager.getAllMessages().length;
        manager.addMessage('Claude', [
          ...(thinking === 'thinking' ? [{ type: 'thinking', thinking: 'let me look it up', signature: 'SIG' } as unknown as ContentBlock] : []),
          ...(thinking === 'redacted_thinking' ? [{ type: 'redacted_thinking', data: 'ENCRYPTED' } as unknown as ContentBlock] : []),
          text(prose('REPLY', 40_000)), call('call-1'),
        ]);
        const resultAt = manager.getAllMessages().length;
        manager.addMessage('User', [result('call-1', 'Sunny.')]);
        manager.addMessage('Claude', [text('It is sunny.')]);
        const stored = manager.getAllMessages();
        const callShards = stored.slice(before, resultAt);
        assert.ok(callShards.length > 2, 'premise: the call is stored as shards');
        const holding = before + callShards.findIndex((m) => m.content.some((b) => b.type === 'tool_use'));
        assert.equal(holding, legacy ? before : resultAt - 1, `premise: the ${legacy ? 'first' : 'last'} shard holds the tool_use`);
        const expected = thinking ? before : holding;
        // A window that the result and what follows it fill exactly: its edge falls at the result.
        const store = (manager as unknown as { messageStore: unknown }).messageStore;
        const config = (strategy as unknown as { config: Record<string, number> }).config;
        config.recentWindowTokens = strategy.estimates(store).slice(resultAt).reduce((a, b) => a + b, 0);
        assert.equal(strategy.recentStart(store), expected, thinking
          ? "the window starts at the call's first shard, with its thinking"
          : "the window starts at the call's shard that holds the tool_use");
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('a raw shard is sent the same in every region', () => {
  it('with a cap that cuts its shards, the body raw in the middle goes out as in the recent window', async () => {
    const shape = SHAPES['two text blocks']!;
    const cap = { maxMessageTokens: 1_000 };
    const inWindow = await compileShape(shape, { ...PLACES['in the recent window'], ...cap });
    const inMiddle = await compileShape(shape, { ...PLACES['raw in the adaptive middle'], ...cap });
    const bodyOf = (r: typeof inWindow) => r.compiled.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text.includes('FIRST sentence')))!;
    assert.ok(JSON.stringify(bodyOf(inWindow).content).includes('[truncated'), 'premise: the cap cuts its shards');
    assert.ok(inMiddle.stats.middleRaw.tokens > 0, 'premise: the middle sends it raw');
    assert.equal(canonical(bodyOf(inMiddle).content), canonical(bodyOf(inWindow).content));
  });
});

describe("a reply's calls on different shards", () => {
  it("the recent window starting at their results keeps both calls, from the first call's shard", async () => {
    class Exposed extends AutobiographicalStrategy {
      recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
      estimates(store: unknown) { return this.postStripEstimates(store as never); }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-calls-'));
    const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, headWindowTokens: 0, recentWindowTokens: 1 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      manager.addMessage('User', [text('please check two cities')]);
      const before = manager.getAllMessages().length;
      manager.addMessage('Claude', [text('First Oslo.'), call('call-a'), text(prose('REPLY', 40_000)), call('call-b')]);
      const resultAt = manager.getAllMessages().length;
      manager.addMessage('User', [result('call-a', 'Sunny.'), result('call-b', 'Rain.')]);
      manager.addMessage('Claude', [text('Done.')]);
      const stored = manager.getAllMessages();
      const holding = stored.slice(before, resultAt).flatMap((m, k) => (m.content.some((b) => b.type === 'tool_use') ? [before + k] : []));
      assert.deepEqual(holding, [before, resultAt - 1], 'premise: the first shard holds one call and the last the other');
      const store = (manager as unknown as { messageStore: unknown }).messageStore;
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      config.recentWindowTokens = strategy.estimates(store).slice(resultAt).reduce((a, b) => a + b, 0);
      assert.equal(strategy.recentStart(store), before, "the window starts at the first call's shard");
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the recent window at a result that sits after text, on a later shard of its message', () => {
  it('starts at the call before the result\'s message, not at that message\'s start', async () => {
    class Exposed extends AutobiographicalStrategy {
      recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
      estimates(store: unknown) { return this.postStripEstimates(store as never); }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-late-result-'));
    const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, headWindowTokens: 0, recentWindowTokens: 1 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      manager.addMessage('User', [text('please check the weather')]);
      const callAt = manager.getAllMessages().length;
      manager.addMessage('Claude', [call('call-1')]);
      const before = manager.getAllMessages().length;
      manager.addMessage('User', [text(prose('NOTE', 40_000)), result('call-1', 'Sunny.')]);
      manager.addMessage('Claude', [text('It is sunny.')]);
      const stored = manager.getAllMessages();
      const resultAt = stored.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
      assert.ok(resultAt > before, 'premise: the result sits on a later shard of its message');
      const store = (manager as unknown as { messageStore: unknown }).messageStore;
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      config.recentWindowTokens = strategy.estimates(store).slice(resultAt).reduce((a, b) => a + b, 0);
      assert.equal(strategy.recentStart(store), callAt, 'the window starts at the call');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the recent window at a result on a later shard of the store\'s first message', () => {
  it('starts at the store\'s start: there is no call before it to step back to', async () => {
    class Exposed extends AutobiographicalStrategy {
      recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
      estimates(store: unknown) { return this.postStripEstimates(store as never); }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-first-result-'));
    const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, headWindowTokens: 0, recentWindowTokens: 1 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      manager.addMessage('User', [text(prose('NOTE', 40_000)), result('call-0', 'Sunny.')]);
      manager.addMessage('Claude', [text('It is sunny.')]);
      const stored = manager.getAllMessages();
      const resultAt = stored.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
      assert.ok(resultAt > 0 && stored[0]!.bodyGroupId === stored[resultAt]!.bodyGroupId, 'premise: the result sits on a later shard of the first message');
      const store = (manager as unknown as { messageStore: unknown }).messageStore;
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      config.recentWindowTokens = strategy.estimates(store).slice(resultAt).reduce((a, b) => a + b, 0);
      assert.equal(strategy.recentStart(store), 0);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
