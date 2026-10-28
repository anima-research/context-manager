import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, KnowledgeStrategy } from '../src/index.js';
import type { StoredMessage } from '../src/index.js';
import { legacyIngress } from './_harness/legacy-ingress.js';

const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } } as unknown as ContentBlock;
const prose = (tag: string, chars: number) => `${tag} sentence of the body, plain words. `.repeat(Math.ceil(chars / 40)).slice(0, chars);
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string) => ({ type: 'tool_use', id, name: 'get_weather', input: { city: 'Oslo' } }) as unknown as ContentBlock;
const result = (id: string, content: string) => ({ type: 'tool_result', toolUseId: id, content }) as unknown as ContentBlock;
const tools = [{ name: 'get_weather', description: 'The weather in a city.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }];

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

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

class LegacyIngress extends AutobiographicalStrategy {
  override chunkIngressMessage(participant: string, content: ContentBlock[]) {
    return legacyIngress(super.chunkIngressMessage(participant, content), content);
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
          const after = shape.writes.length - 1 - shape.body + 4;
          if (place === 'raw in the adaptive middle') assert.ok(stats.middleRaw.tokens > 0, 'premise: the middle sends raw history');
          const given = shape.writes[shape.body]![1];
          if (place === 'across the middle and the recent window') {
            if (given.some((b) => b.type === 'tool_result')) {
              assert.ok(stats.tail.messages >= after + bodyIds.length + 1,
                `the recent window holds the whole message and its call (${stats.tail.messages} messages)`);
            } else {
              assert.ok(stats.middleRaw.tokens > 0, 'premise: the middle sends some of the body raw');
              assert.ok(stats.tail.messages > after, `premise: the recent window holds some of its shards too (${stats.tail.messages} messages)`);
            }
          }
          const at = compiled.messages.findIndex((m) => canonical(m.content) === canonical(given));
          assert.ok(at >= 0, 'a message sends the body, exactly as given');
          const tags = given.flatMap((b) => {
            const tag = b.type === 'text' ? /^([A-Z]{4,}) /.exec((b as { text: string }).text)?.[1] : undefined;
            return tag ? [tag] : [];
          });
          const uses = given.flatMap((b) => (b.type === 'tool_use' ? [(b as { id: string }).id] : []));
          const results = given.flatMap((b) => (b.type === 'tool_result' ? [(b as { toolUseId: string }).toolUseId] : []));
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

describe('a result that sits after text, on a later shard of its message', () => {
  class Exposed extends AutobiographicalStrategy {
    recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
    hold(store: unknown) { return this.holdBoundary(store as never); }
    estimates(store: unknown) { return this.postStripEstimates(store as never); }
  }
  async function withLateResult(
    hold: boolean,
    body: (strategy: Exposed, store: unknown, at: { callAt: number; from: number; to: number; resultAt: number }, view: unknown) => void,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-late-result-'));
    const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, headWindowTokens: 0, recentWindowTokens: 1 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      manager.addMessage('User', [text('please check the weather')]);
      const callAt = manager.getAllMessages().length;
      manager.addMessage('Claude', [call('call-1')]);
      const from = manager.getAllMessages().length;
      manager.addMessage('User', [text(prose('NOTE', 40_000)), result('call-1', 'Sunny.')], undefined, undefined, hold ? { holdCompression: true } : undefined);
      const to = manager.getAllMessages().length - 1;
      manager.addMessage('Claude', [text('It is sunny.')]);
      const stored = manager.getAllMessages();
      const resultAt = stored.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
      assert.ok(to - from >= 2 && resultAt === to, `premise: the message is three or more shards, its result on the last (${from}..${to}, result at ${resultAt})`);
      body(strategy, (manager as unknown as { messageStore: unknown }).messageStore, { callAt, from, to, resultAt },
        (manager as unknown as { strategyMessageView(): unknown }).strategyMessageView());
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the recent window, its edge on any of the message's shards, starts at the call", async () => {
    await withLateResult(false, (strategy, store, { callAt, from, to }) => {
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      const pse = strategy.estimates(store);
      for (let edge = from; edge <= to; edge++) {
        config.recentWindowTokens = pse.slice(edge).reduce((a, b) => a + b, 0);
        assert.equal(strategy.recentStart(store), callAt, `an edge on message ${edge}`);
      }
    });
  });

  it('a compression hold on the message starts at the call', async () => {
    await withLateResult(true, (strategy, _store, { callAt, from }, view) => {
      assert.ok(strategy.hold(view) <= from, 'premise: the message is held');
      assert.equal(strategy.hold(view), callAt);
    });
  });
});

describe('the recent window at a result on a later shard of the store\'s first message', () => {
  it('starts at its edge: there is no call before it to step back to', async () => {
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
      assert.equal(strategy.recentStart(store), resultAt);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class LegacyKnowledgeIngress extends KnowledgeStrategy {
  override chunkIngressMessage(participant: string, content: ContentBlock[]) {
    return legacyIngress(super.chunkIngressMessage(participant, content), content);
  }
}

const PAIRS: Record<string, { legacy: boolean; call: ContentBlock[]; result: ContentBlock[] }> = {
  'a result after a long text, on its message\'s last shard': {
    legacy: false, call: [text('looking it up'), call('call-1')], result: [text(prose('NOTE', 2_000)), result('call-1', 'Sunny.')],
  },
  'a call stored before each block was kept in place, its tool_use on its first shard': {
    legacy: true, call: [text(prose('REPLY', 2_000)), call('call-1')], result: [result('call-1', 'Sunny.')],
  },
  'a call whose text follows its tool_use, answered by a result after a long text': {
    legacy: false, call: [call('call-1'), text(prose('REPLY', 2_000))], result: [text(prose('NOTE', 2_000)), result('call-1', 'Sunny.')],
  },
  'a call that thinks first, its tool_use on its last shard, answered by a result after a long text': {
    legacy: false,
    call: [{ type: 'thinking', thinking: 'let me look it up', signature: 'SIG' } as unknown as ContentBlock, text(prose('REPLY', 2_000)), call('call-1')],
    result: [text(prose('NOTE', 2_000)), result('call-1', 'Sunny.')],
  },
};
class HintEverywhere extends AutobiographicalStrategy {
  protected override chunkBoundaryHint(): boolean { return true; }
}
class LegacyHintEverywhere extends HintEverywhere {
  override chunkIngressMessage(participant: string, content: ContentBlock[]) {
    return legacyIngress(super.chunkIngressMessage(participant, content), content);
  }
}
const STRATEGIES = {
  autobiographical: { inPlace: AutobiographicalStrategy, legacy: LegacyIngress },
  'a boundary hint at every message': { inPlace: HintEverywhere, legacy: LegacyHintEverywhere },
  Knowledge: { inPlace: KnowledgeStrategy, legacy: LegacyKnowledgeIngress },
} as const;

async function withPair(
  Strategy: typeof AutobiographicalStrategy,
  pair: { call: ContentBlock[]; result: ContentBlock[] },
  config: Record<string, unknown>,
  body: (manager: ContextManager, strategy: AutobiographicalStrategy, at: { callFrom: number; resultTo: number }) => Promise<void>,
  membrane?: unknown,
) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-pair-'));
  const strategy = new Strategy({
    adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0, ...config,
  });
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, ...(membrane ? { membrane: membrane as never } : {}) });
  manager.setToolDefinitions(tools as never);
  try {
    for (let k = 0; k < 4; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(60))]);
    const callFrom = manager.getAllMessages().length;
    manager.addMessage('Claude', pair.call);
    manager.addMessage('User', pair.result);
    const resultTo = manager.getAllMessages().length - 1;
    for (let k = 0; k < 6; k++) manager.addMessage(k % 2 ? 'User' : 'Claude', [text(`after ${k} ` + 'w '.repeat(60))]);
    assert.ok(resultTo - callFrom >= 3, `premise: the call and its result are stored as shards (${callFrom}..${resultTo})`);
    await body(manager, strategy, { callFrom, resultTo });
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const holds = (m: { content: ContentBlock[] }, type: string) => m.content.some((b) => b.type === type);

describe('no compression chunk parts a call from the message answering it, wherever in their shards the tool_use and the tool_result sit', () => {
  for (const [name, { inPlace, legacy }] of Object.entries(STRATEGIES)) {
    for (const [shape, pair] of Object.entries(PAIRS)) {
      it(`${name}: ${shape}`, async () => {
        await withPair(pair.legacy ? legacy : inPlace, pair, {}, async (manager, strategy) => {
          const chunker = strategy as unknown as { chunks: Array<{ messages: Array<{ id: string; content: ContentBlock[] }> }>; rebuildChunks(store: unknown): void };
          chunker.rebuildChunks((manager as unknown as { messageStore: unknown }).messageStore);
          const withCall = chunker.chunks.filter((c) => c.messages.some((m) => holds(m, 'tool_use')));
          assert.ok(chunker.chunks.length > 2 && withCall.length === 1, `premise: the store chunks into several, one holding the tool_use (${chunker.chunks.length})`);
          assert.ok(withCall[0]!.messages.some((m) => holds(m, 'tool_result')), 'the chunk holding the tool_use holds its tool_result');
        });
      });
    }
  }
});

describe('no compression chunk parts a call from its own result across the shards of one message', () => {
  for (const [name, { inPlace }] of Object.entries(STRATEGIES)) {
    it(`${name}: a message that makes a call, then a long text, then the call's result`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-own-'));
      const strategy = new inPlace({ adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0 });
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
      manager.setToolDefinitions(tools as never);
      try {
        for (let k = 0; k < 4; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(60))]);
        const from = manager.getAllMessages().length;
        manager.addMessage('Claude', [text('looking it up'), call('call-1'), text(prose('NOTE', 2_000)), result('call-1', 'Sunny.'), text('done')]);
        const shards = manager.getAllMessages().slice(from);
        for (let k = 0; k < 6; k++) manager.addMessage(k % 2 ? 'User' : 'Claude', [text(`after ${k} ` + 'w '.repeat(60))]);
        const useAt = shards.findIndex((m) => holds(m, 'tool_use'));
        const resultAt = shards.findIndex((m) => holds(m, 'tool_result'));
        assert.ok(useAt >= 0 && resultAt - useAt >= 2, `premise: the call and its result are on shards apart (${useAt}, ${resultAt} of ${shards.length})`);
        const chunker = strategy as unknown as { chunks: Array<{ messages: Array<{ id: string; content: ContentBlock[] }> }>; rebuildChunks(store: unknown): void };
        chunker.rebuildChunks((manager as unknown as { messageStore: unknown }).messageStore);
        const withCall = chunker.chunks.filter((c) => c.messages.some((m) => holds(m, 'tool_use')));
        assert.ok(chunker.chunks.length > 2 && withCall.length === 1, `premise: the store chunks into several, one holding the tool_use (${chunker.chunks.length})`);
        assert.ok(withCall[0]!.messages.some((m) => holds(m, 'tool_result')), 'the chunk holding the tool_use holds its tool_result');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("the head window's end, wherever it falls in a call and the message answering it, leaves them on one side", () => {
  for (const [shape, pair] of Object.entries(PAIRS)) {
    it(shape, async () => {
      class Exposed extends (pair.legacy ? LegacyIngress : AutobiographicalStrategy) {
        headEnd(store: unknown) { return this.getHeadWindowEnd(store as never); }
      }
      await withPair(Exposed, pair, {}, async (manager, strategy, { callFrom, resultTo }) => {
        const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
        const stored = manager.getAllMessages();
        const config = (strategy as unknown as { config: Record<string, number> }).config;
        const callAt = stored.findIndex((m, k) => k >= callFrom && (holds(m, 'tool_use') || holds(m, 'thinking')));
        for (let edge = callAt + 1; edge <= resultTo; edge++) {
          config.headWindowTokens = stored.slice(0, edge).reduce((n, m) => n + store.estimateTokens(m), 0);
          assert.equal((strategy as Exposed).headEnd(store), callAt, `an edge on message ${edge}`);
        }
      });
    });
  }
});

describe("the recent window's start, wherever it falls inside a call before the message answering it, keeps the call from its start", () => {
  for (const [shape, pair] of Object.entries(PAIRS)) {
    it(shape, async () => {
      class Exposed extends (pair.legacy ? LegacyIngress : AutobiographicalStrategy) {
        recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
        estimates(store: unknown) { return this.postStripEstimates(store as never); }
      }
      await withPair(Exposed, pair, {}, async (manager, strategy, { callFrom }) => {
        const store = (manager as unknown as { messageStore: unknown }).messageStore;
        const stored = manager.getAllMessages();
        const config = (strategy as unknown as { config: Record<string, number> }).config;
        const callAt = stored.findIndex((m, k) => k >= callFrom && (holds(m, 'tool_use') || holds(m, 'thinking')));
        const callEnd = stored.findIndex((m, k) => k > callFrom && holds(m, 'tool_result')) - 1;
        assert.ok(callAt >= 0 && callEnd > callAt, `premise: an edge can fall inside the call before its answer (${callAt}, ${callEnd})`);
        const pse = (strategy as Exposed).estimates(store);
        for (let edge = callAt + 1; edge <= callEnd; edge++) {
          config.recentWindowTokens = pse.slice(edge).reduce((n, t) => n + t, 0);
          assert.equal((strategy as Exposed).recentStart(store), callAt, `an edge on message ${edge}`);
        }
      });
    });
  }
});

describe('the head window\'s end inside a message that thinks, makes a call and answers it itself', () => {
  it('steps back to the message\'s first shard, which holds the thinking', async () => {
    class Exposed extends AutobiographicalStrategy {
      headEnd(store: unknown) { return this.getHeadWindowEnd(store as never); }
    }
    const pair = {
      call: [{ type: 'thinking', thinking: 'let me look it up', signature: 'SIG' } as unknown as ContentBlock, text(prose('REPLY', 1_000)), call('call-1'), text(prose('NOTE', 1_000)), result('call-1', 'Sunny.'), text('done')],
      result: [text('thanks')],
    };
    await withPair(Exposed, pair, {}, async (manager, strategy, { callFrom }) => {
      const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
      const stored = manager.getAllMessages();
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      const resultAt = stored.findIndex((m) => holds(m, 'tool_result'));
      assert.ok(holds(stored[callFrom]!, 'thinking') && resultAt - callFrom >= 3, `premise: thinking on the first shard, the result shards later (${callFrom}, ${resultAt})`);
      for (let edge = callFrom + 1; edge <= resultAt; edge++) {
        config.headWindowTokens = stored.slice(0, edge).reduce((n, m) => n + store.estimateTokens(m), 0);
        assert.equal((strategy as Exposed).headEnd(store), callFrom, `an edge on message ${edge}`);
      }
    });
  });
});

describe("the head window's end at messages without shards, paired by the calls each leaves open", () => {
  const STUB = "this call's result isn't shown in this context";
  async function headAt(writes: Array<[string, ContentBlock[]]>, body: (headEnd: number, first: number, sent: string) => void, edge = 2) {
    const requests: string[] = [];
    const membrane = {
      complete: async (req: unknown) => {
        requests.push(JSON.stringify(req));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary ${requests.length}` }] };
      },
    };
    class Exposed extends AutobiographicalStrategy {
      headEnd(store: unknown) { return this.getHeadWindowEnd(store as never); }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-head-'));
    const strategy = new Exposed({
      autoTickOnNewMessage: false, targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0,
      compressionModel: 'm', minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: membrane as never });
    manager.setToolDefinitions(tools as never);
    try {
      for (let k = 0; k < 6; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(30))]);
      const first = manager.getAllMessages().length;
      for (const [participant, content] of writes) manager.addMessage(participant, content);
      for (let k = 0; k < 8; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`after ${k} ` + 'w '.repeat(30))]);
      const stored = manager.getAllMessages();
      assert.ok(stored.every((m) => !m.bodyGroupId), 'premise: no message is stored as shards');
      const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      config.headWindowTokens = stored.slice(0, first + edge).reduce((n, m) => n + store.estimateTokens(m), 0);
      const headEnd = strategy.headEnd(store);
      const queue = (strategy as unknown as { compressionQueue: number[] }).compressionQueue;
      await manager.compile();
      for (let guard = 0; queue.length > 0 && guard < 80; guard++) await manager.tick();
      assert.ok(requests.length > 0, 'premise: what follows the head compresses');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      body(headEnd, first, JSON.stringify(compiled.messages));
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a call, then a message answering it that makes the next call: the head ends before the call, and no call goes out with a stub for its result', async () => {
    await headAt([
      ['Claude', [text('looking it up'), call('c')]],
      ['User', [result('c', 'Sunny.'), call('d')]],
      ['User', [result('d', 'Rain.')]],
    ], (headEnd, first, sent) => {
      assert.equal(headEnd, first, 'the head ends before the call');
      assert.ok(!sent.includes(STUB), 'no call is sent with a stub in place of its result');
    });
  });

  it('a chain of such messages: the head ends before the first call', async () => {
    await headAt([
      ['Claude', [text('looking it up'), call('c')]],
      ['User', [result('c', 'Sunny.'), call('d')]],
      ['User', [result('d', 'Rain.'), call('e')]],
      ['User', [result('e', 'Snow.')]],
    ], (headEnd, first, sent) => {
      assert.equal(headEnd, first, 'the head ends before the first call');
      assert.ok(!sent.includes(STUB), 'no call is sent with a stub in place of its result');
    }, 3);
  });

  it('two bundles in a row, each answering its own call: the head ends after the first, as main ends it', async () => {
    await headAt([
      ['Claude', [text('one'), call('c'), result('c', 'Sunny.'), text('done one')]],
      ['Claude', [call('d'), result('d', 'Rain.'), text('done two')]],
    ], (headEnd, first) => {
      assert.equal(headEnd, first + 1, 'the head ends after the first bundle');
    });
  });
});

describe('a message stored as shards that answers its own calls holds no close', () => {
  it('two such bundles in a row: a chunk closes inside the second', async () => {
    const bundle = (id: string): ContentBlock[] => [text(prose(`OPEN-${id}`, 1_000)), call(id), result(id, 'Sunny.'), text(prose(`CLOSE-${id}`, 1_000))];
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-bundles-'));
    const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      for (let k = 0; k < 4; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(60))]);
      manager.addMessage('Claude', bundle('c'));
      const second = manager.getAllMessages().length;
      manager.addMessage('Claude', bundle('d'));
      const shards = manager.getAllMessages().slice(second).map((m) => m.id);
      for (let k = 0; k < 4; k++) manager.addMessage(k % 2 ? 'User' : 'Claude', [text(`after ${k} ` + 'w '.repeat(60))]);
      assert.ok(shards.length > 3, `premise: the second bundle is stored as shards (${shards.length})`);
      const chunker = strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }>; rebuildChunks(store: unknown): void };
      chunker.rebuildChunks((manager as unknown as { messageStore: unknown }).messageStore);
      const holding = chunker.chunks.filter((c) => c.messages.some((m) => shards.includes(m.id)));
      assert.ok(holding.length > 1, `a chunk closes inside the second bundle (its shards fall in ${holding.length} chunk${holding.length === 1 ? '' : 's'})`);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parallel calls' results, each in a message of its own", () => {
  const parallel = (n: number): Array<[string, ContentBlock[]]> => {
    const ids = Array.from({ length: n }, (_, k) => `call-${k}`);
    return [['Claude', [text('looking them up'), ...ids.map(call)]], ...ids.map((id): [string, ContentBlock[]] => ['User', [result(id, `${id} answered ` + 'w '.repeat(60))]])];
  };
  async function withWrites(
    Strategy: typeof AutobiographicalStrategy,
    writes: Array<[string, ContentBlock[]]>,
    body: (manager: ContextManager, strategy: AutobiographicalStrategy, first: number) => Promise<void>,
    config: Record<string, unknown> = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-parallel-'));
    const strategy = new Strategy({ autoTickOnNewMessage: false, targetChunkTokens: 40, headWindowTokens: 0, recentWindowTokens: 0, ...config });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      for (let k = 0; k < 4; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(10))]);
      const first = manager.getAllMessages().length;
      for (const [participant, content] of writes) manager.addMessage(participant, content);
      for (let k = 0; k < 12; k++) manager.addMessage(k % 2 ? 'User' : 'Claude', [text(`after ${k} ` + 'w '.repeat(10))]);
      await body(manager, strategy, first);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const storeOf = (manager: ContextManager) => (manager as unknown as { messageStore: unknown }).messageStore;

  for (const [name, { inPlace }] of Object.entries(STRATEGIES)) {
    it(`${name}: the chunk holding the call holds its first result's message, and the later results, one to a message, close as before`, async () => {
      await withWrites(inPlace, parallel(3), async (manager, strategy) => {
        const chunker = strategy as unknown as { chunks: Array<{ messages: Array<{ content: ContentBlock[] }> }>; rebuildChunks(store: unknown): void };
        chunker.rebuildChunks(storeOf(manager));
        const withCall = chunker.chunks.filter((c) => c.messages.some((m) => holds(m, 'tool_use')));
        assert.ok(chunker.chunks.length >= 3 && withCall.length === 1, `premise: the store chunks into several, one holding the tool_use (${chunker.chunks.length})`);
        const expected = name.startsWith('a boundary hint') ? 3 : 1;
        assert.equal(withCall[0]!.messages.filter((m) => holds(m, 'tool_result')).length, expected, 'the chunk holding the call holds the first result, and closes as before');
      });
    });
  }

  it('autobiographical: a walk over a long run of unchunked messages at once, as when the recent window shrinks, keeps the call with its first result', async () => {
    await withWrites(AutobiographicalStrategy, parallel(3), async (manager, strategy) => {
      const chunker = strategy as unknown as { chunks: Array<{ messages: Array<{ content: ContentBlock[] }> }>; rebuildChunks(store: unknown): void; config: Record<string, number> };
      assert.equal(chunker.chunks.length, 0, 'premise: nothing was chunked while the window held everything');
      chunker.config.recentWindowTokens = 0;
      chunker.rebuildChunks(storeOf(manager));
      const withCall = chunker.chunks.filter((c) => c.messages.some((m) => holds(m, 'tool_use')));
      assert.ok(chunker.chunks.length >= 3 && withCall.length === 1, `premise: the store chunks into several, one holding the tool_use (${chunker.chunks.length})`);
      assert.equal(withCall[0]!.messages.filter((m) => holds(m, 'tool_result')).length, 1, 'the chunk holding the call holds the first result');
    }, { recentWindowTokens: 1_000_000 });
  });

  class Exposed extends AutobiographicalStrategy {
    recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
    headEnd(store: unknown) { return this.getHeadWindowEnd(store as never); }
    estimates(store: unknown) { return this.postStripEstimates(store as never); }
    held(messages: unknown[], from: number) { return this.closesHeld(messages as never, from); }
    parted(messages: unknown[], from?: number, until?: number) { return this.callPartedStarts(messages as never, from, until); }
    startOfCall(messages: unknown[], at: number) { return this.callStart(messages as never, at); }
    hold(store: unknown) { return this.holdBoundary(store as never); }
  }
  const config = (strategy: AutobiographicalStrategy) => (strategy as unknown as { config: Record<string, number> }).config;

  it('a message answering one of the calls and making its own keeps the others waiting: no boundary parts the first call from its later result', async () => {
    const writes: Array<[string, ContentBlock[]]> = [
      ['Claude', [text('looking them up'), call('call-a'), call('call-b')]],
      ['User', [result('call-a', 'a'), call('call-c')]],
      ['User', [result('call-b', 'b')]],
      ['User', [result('call-c', 'c')]],
    ];
    await withWrites(Exposed, writes, async (manager, strategy, first) => {
      const starts = (strategy as Exposed).parted(manager.getAllMessages());
      assert.deepEqual([...starts.slice(first, first + 4)], [first, first, first, -1]);
    });
  });

  it('a message answering none of the calls ends their run, a result for another call included: a later result is as before', async () => {
    const writes: Array<[string, ContentBlock[]]> = [
      ['Claude', [text('looking them up'), call('call-a'), call('call-b')]],
      ['User', [result('call-a', 'a')]],
      ['User', [result('elsewhere', 'not one of these')]],
      ['User', [result('call-b', 'b')]],
    ];
    await withWrites(Exposed, writes, async (manager, strategy, first) => {
      const starts = (strategy as Exposed).parted(manager.getAllMessages());
      assert.deepEqual([...starts.slice(first, first + 4)], [first, -1, -1, -1]);
    });
  });

  it("the listing's end holds a close after a call until its first result's message has come, and not after it while another call waits", async () => {
    await withWrites(Exposed, parallel(2), async (manager, strategy, first) => {
      const all = manager.getAllMessages();
      const toCall = all.slice(0, first + 1);
      const toFirst = all.slice(0, first + 2);
      assert.equal((strategy as Exposed).held(toCall, 0)[first], 1, 'after the call');
      assert.equal((strategy as Exposed).held(toFirst, 0)[first + 1], 0, 'after the first of two results');
    });
  });

  it('the smaller-window floor and the compression hold count a later result from its call', async () => {
    await withWrites(Exposed, parallel(3), async (manager, strategy, first) => {
      assert.equal((strategy as Exposed).startOfCall(manager.getAllMessages(), first + 3), first, 'callStart for the third result');
    });
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-parallel-hold-'));
    const strategy = new Exposed({ autoTickOnNewMessage: false, targetChunkTokens: 40, headWindowTokens: 0, recentWindowTokens: 0 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      for (let k = 0; k < 4; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(10))]);
      const first = manager.getAllMessages().length;
      const writes = parallel(3);
      writes.forEach(([participant, content], k) => manager.addMessage(participant, content, undefined, undefined, k === 3 ? { holdCompression: true } : undefined));
      const view = (manager as unknown as { strategyMessageView(): unknown }).strategyMessageView();
      assert.ok(strategy.hold(view) <= first + 3, 'premise: the third result is held');
      assert.equal(strategy.hold(view), first, 'the hold on the third result starts at the call');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the recent window's start, with its edge on any of the results, starts at the call", async () => {
    for (const n of [2, 3, 5]) {
      await withWrites(Exposed, parallel(n), async (manager, strategy, first) => {
        const store = storeOf(manager);
        const pse = (strategy as Exposed).estimates(store);
        for (let edge = first + 1; edge <= first + n; edge++) {
          config(strategy).recentWindowTokens = pse.slice(edge).reduce((t, x) => t + x, 0);
          assert.equal((strategy as Exposed).recentStart(store), first, `${n} results, an edge on message ${edge}`);
        }
      });
    }
  });

  it("the head window's end, with its edge on any of the results, ends before the call", async () => {
    await withWrites(Exposed, parallel(3), async (manager, strategy, first) => {
      const store = storeOf(manager) as { estimateTokens(m: unknown): number };
      const stored = manager.getAllMessages();
      for (let edge = first + 1; edge <= first + 3; edge++) {
        config(strategy).headWindowTokens = stored.slice(0, edge).reduce((t, m) => t + store.estimateTokens(m), 0);
        assert.equal((strategy as Exposed).headEnd(store), first, `an edge on message ${edge}`);
      }
    });
  });

  it("in a chain of calls, each message answering the call before and making the next, the recent window's start steps back one call past main's step and no further", async () => {
    const links = 5;
    const writes: Array<[string, ContentBlock[]]> = [['Claude', [text('start'), call('call-0')]]];
    for (let k = 1; k < links; k++) writes.push(['User', [result(`call-${k - 1}`, `answer ${k - 1}`), call(`call-${k}`)]]);
    writes.push(['User', [result(`call-${links - 1}`, 'last answer')]]);
    await withWrites(Exposed, writes, async (manager, strategy, first) => {
      const store = storeOf(manager);
      const pse = (strategy as Exposed).estimates(store);
      const last = first + links;
      config(strategy).recentWindowTokens = pse.slice(last).reduce((t, x) => t + x, 0);
      assert.equal((strategy as Exposed).recentStart(store), last - 2);
    });
  });

  it('the holds a walk asks from a position, and the call starts asked around one, are those of the whole listing', async () => {
    const writes: Array<[string, ContentBlock[]]> = [
      ...parallel(3),
      ['Claude', [text('next'), call('chain-0')]],
      ['User', [result('chain-0', 'a'), call('chain-1')]],
      ['User', [result('chain-1', 'b')]],
      ['Claude', [text('one'), call('own'), text(prose('NOTE', 2_000)), result('own', 'x'), text('done')]],
      ['Claude', [text(prose('REPLY', 2_000)), call('sharded')]],
      ['User', [text(prose('LOG', 2_000)), result('sharded', 'y')]],
      ['Claude', [call('open')]],
    ];
    await withWrites(Exposed, writes, async (manager, strategy) => {
      const all = manager.getAllMessages();
      assert.ok(all.length - new Set(all.map((m) => m.bodyGroupId ?? m.id)).size >= 4, 'premise: some messages are stored as shards');
      for (let length = 1; length <= all.length; length++) {
        const listing = all.slice(0, length);
        const whole = (strategy as Exposed).held(listing, 0);
        const starts = (strategy as Exposed).parted(listing);
        for (let from = 1; from <= length; from++) {
          const part = (strategy as Exposed).held(listing, from);
          for (let p = from; p < length; p++) assert.equal(part[p], whole[p], `a listing of ${length}, from ${from}, position ${p}`);
          const around = (strategy as Exposed).parted(listing, from - 1, from);
          const stepBack = (a: Int32Array, once: boolean) => {
            let b = from;
            while (b > 0 && a[b - 1]! >= 0) { b = a[b - 1]!; if (once) break; }
            return b;
          };
          assert.equal(stepBack(around, false), stepBack(starts, false), `a listing of ${length}, the head stepping back from ${from}`);
          assert.equal(stepBack(around, true), stepBack(starts, true), `a listing of ${length}, the window stepping back from ${from}`);
        }
      }
    }, { adaptiveResolution: true });
  });
});

describe('a result whose call compresses first, end to end', () => {
  for (const [name, { inPlace, legacy }] of Object.entries(STRATEGIES)) {
    for (const [shape, pair] of Object.entries(PAIRS)) {
      it(`${name}: ${shape}: the result reaches a summary, beside its call`, async () => {
        const requests: string[] = [];
        const membrane = {
          complete: async (req: unknown) => {
            requests.push(JSON.stringify(req));
            return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary ${requests.length}` }] };
          },
        };
        await withPair(pair.legacy ? legacy : inPlace, pair, { compressionModel: 'm', minChunkCharsForLLM: 0, l1HoldbackChunks: 0 }, async (manager, strategy) => {
          const queue = (strategy as unknown as { compressionQueue: number[] }).compressionQueue;
          await manager.compile();
          for (let guard = 0; queue.length > 0 && guard < 80; guard++) await manager.tick();
          assert.ok(requests.length > 2, `premise: the store compresses in several requests (${requests.length})`);
          const blocksOf = (r: string) => (JSON.parse(r) as { messages: Array<{ content: Array<{ type: string; id?: string; toolUseId?: string; content?: unknown }> }> })
            .messages.flatMap((m) => m.content);
          assert.ok(requests.some((r) => {
            const blocks = blocksOf(r);
            return blocks.some((b) => b.type === 'tool_use' && b.id === 'call-1')
              && blocks.some((b) => b.type === 'tool_result' && b.toolUseId === 'call-1' && JSON.stringify(b.content).includes('Sunny.'));
          }), 'a compression request carries the call and its result');
        }, membrane);
      });
    }
  }
});

describe('the recent window at a result whose call is not in the message before it', () => {
  it('starts at its edge: there is no call there to step back to', async () => {
    class Exposed extends AutobiographicalStrategy {
      recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
      estimates(store: unknown) { return this.postStripEstimates(store as never); }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-unanswered-'));
    const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 1 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      manager.addMessage('User', [text('hi')]);
      manager.addMessage('User', [text(prose('DOCUMENT', 12_000))]);
      const resultAt = manager.getAllMessages().length;
      manager.addMessage('User', [result('call-0', 'Sunny.')]);
      manager.addMessage('Claude', [text('It is sunny.')]);
      assert.ok(resultAt > 3, 'premise: the message before the result is stored as shards');
      const store = (manager as unknown as { messageStore: unknown }).messageStore;
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      config.recentWindowTokens = strategy.estimates(store).slice(resultAt).reduce((a, b) => a + b, 0);
      assert.equal(strategy.recentStart(store), resultAt);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a message stored as shards that answers its own call, after a long plain message', () => {
  class Exposed extends AutobiographicalStrategy {
    recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
    estimates(store: unknown) { return this.postStripEstimates(store as never); }
    startOfCall(messages: unknown[], at: number) { return this.callStart(messages as never, at); }
    hold(store: unknown) { return this.holdBoundary(store as never); }
  }
  const bundle = (): ContentBlock[] => [text(prose('OPEN', 3_000)), call('b1'), text(prose('MIDDLE', 3_000)), result('b1', 'Sunny.'), text(prose('CLOSE', 1_500))];
  async function withBundle(
    hold: boolean,
    body: (strategy: Exposed, store: unknown, view: unknown, at: { from: number; to: number; callAt: number; resultAt: number }) => void,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-own-call-'));
    const strategy = new Exposed({ adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 1 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    manager.setToolDefinitions(tools as never);
    try {
      manager.addMessage('User', [text('hi')]);
      const document = manager.getAllMessages().length;
      manager.addMessage('User', [text(prose('DOCUMENT', 12_000))]);
      const from = manager.getAllMessages().length;
      manager.addMessage('Claude', bundle(), undefined, undefined, hold ? { holdCompression: true } : undefined);
      const to = manager.getAllMessages().length - 1;
      manager.addMessage('User', [text('thanks')]);
      const stored = manager.getAllMessages();
      const callAt = stored.findIndex((m) => holds(m, 'tool_use'));
      const resultAt = stored.findIndex((m) => holds(m, 'tool_result'));
      assert.ok(from - document > 3 && from < callAt && callAt < resultAt && resultAt < to,
        `premise: the document and the bundle are stored as shards, the call and its result on shards of their own inside the bundle (${document}, ${from}..${to}, call ${callAt}, result ${resultAt})`);
      body(strategy, (manager as unknown as { messageStore: unknown }).messageStore,
        (manager as unknown as { strategyMessageView(): unknown }).strategyMessageView(), { from, to, callAt, resultAt });
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the recent window, its edge on any of the message's shards, starts in the message: at the call when the edge would part it from its result, else at the edge", async () => {
    await withBundle(false, (strategy, store, _view, { from, to, callAt, resultAt }) => {
      const config = (strategy as unknown as { config: Record<string, number> }).config;
      const pse = strategy.estimates(store);
      for (let edge = from + 1; edge <= to; edge++) {
        config.recentWindowTokens = pse.slice(edge).reduce((a, b) => a + b, 0);
        assert.equal(strategy.recentStart(store), edge > callAt && edge <= resultAt ? callAt : edge, `an edge on message ${edge}`);
      }
    });
  });

  it('the smaller-window floor counts the newest turn from the message itself', async () => {
    await withBundle(false, (strategy, store, _view, { from }) => {
      const messages = (store as { getAll(): unknown[] }).getAll();
      assert.equal(strategy.startOfCall(messages, from), from);
    });
  });

  it('a compression hold on the message starts at the message', async () => {
    await withBundle(true, (strategy, _store, view, { from }) => {
      assert.equal(strategy.hold(view), from);
    });
  });
});

describe("tool pruning counts a message's own result as no answer, whether the message is stored as shards or not", () => {
  for (const [name, chars] of [['unsharded', 200], ['sharded', 6_000]] as const) {
    it(`${name}: with toolResultMaxLastN 1, the earlier call's result is the one sent`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-pruning-'));
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 1_000_000, toolResultMaxLastN: 1,
      });
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
      manager.setToolDefinitions(tools as never);
      try {
        manager.addMessage('User', [text('please check the weather')]);
        manager.addMessage('Claude', [text('looking it up'), call('real')]);
        manager.addMessage('User', [result('real', 'REAL-RESULT')]);
        const before = manager.getAllMessages().length;
        manager.addMessage('Claude', [text(prose('OPEN', chars)), call('own'), text(prose('MIDDLE', chars)), result('own', 'BUNDLE-RESULT'), text('done')]);
        const shards = manager.getAllMessages().length - before;
        manager.addMessage('User', [text('thanks')]);
        assert.ok(name === 'sharded' ? shards > 2 : shards === 1, `premise: the message is stored as ${name === 'sharded' ? 'several shards' : 'one message'} (${shards})`);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        assert.ok(JSON.stringify(compiled.messages).includes('REAL-RESULT'), 'the earlier call\'s result is sent');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('a call held through its first result\'s message', () => {
  async function withProvider(
    Strategy: typeof AutobiographicalStrategy,
    write: (manager: ContextManager) => void,
    body: (manager: ContextManager, strategy: AutobiographicalStrategy, seen: { l1: number; sizeRefused: number; largest: number }) => Promise<void>,
  ) {
    const seen = { l1: 0, sizeRefused: 0, largest: 0 };
    let store: { estimateTokens(m: unknown): number } | undefined;
    const membrane = {
      complete: async (req: { messages: Array<{ content: unknown }>; system?: unknown; tools?: unknown; config?: { maxTokens?: number } }) => {
        const counted = (content: unknown) => store!.estimateTokens({ content } as never);
        const tokens = req.messages.reduce((t, m) => t + counted(m.content), 0)
          + (req.system ? counted([{ type: 'text', text: JSON.stringify(req.system) }]) : 0)
          + (req.tools ? counted([{ type: 'text', text: JSON.stringify(req.tools) }]) : 0)
          + (req.config?.maxTokens ?? 0);
        const own = JSON.stringify(req).includes('form a new memory');
        if (own) {
          seen.l1++;
          seen.largest = Math.max(seen.largest, tokens);
        }
        if (tokens > 200_000) {
          if (own) seen.sizeRefused++;
          throw Object.assign(new Error(`prompt is too long: ${tokens} tokens > 200000 maximum`), { type: 'context_length', httpStatus: 400, retryable: false });
        }
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Summary' }] };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-first-result-'));
    const strategy = new Strategy({
      adaptiveResolution: true, autoTickOnNewMessage: false, targetChunkTokens: 400, headWindowTokens: 0, recentWindowTokens: 2_000,
      compressionModel: 'm', minChunkCharsForLLM: 0, l1HoldbackChunks: 0, quarantineAlarmIntervalMs: 0,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: membrane as never });
    store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
    manager.setToolDefinitions(tools as never);
    try {
      for (let k = 0; k < 6; k++) manager.addMessage(k % 2 ? 'Claude' : 'User', [text(`before ${k} ` + 'w '.repeat(300))]);
      write(manager);
      for (let k = 0; k < 30; k++) manager.addMessage(k % 2 ? 'User' : 'Claude', [text(`after ${k} ` + 'w '.repeat(300))]);
      const queue = (strategy as unknown as { compressionQueue: number[] }).compressionQueue;
      await manager.compile().catch(() => undefined);
      for (let guard = 0; queue.length > 0 && guard < 400; guard++) await manager.tick();
      await body(manager, strategy, seen);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const chunksOf = (strategy: AutobiographicalStrategy) =>
    (strategy as unknown as { chunks: Array<{ compressed?: boolean; messages: Array<{ id: string; content: ContentBlock[] }> }> }).chunks;
  const answeredWithCall = (strategy: AutobiographicalStrategy): string[] => {
    const holding = chunksOf(strategy).find((c) => c.messages.some((m) => m.content.some((b) => b.type === 'tool_use')));
    return (holding?.messages ?? []).flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => (b as unknown as { toolUseId: string }).toolUseId));
  };

  for (const [name, { inPlace }] of Object.entries(STRATEGIES)) {
    it(`${name}: a call whose first result sits on a later shard of a long message stays with that whole message`, async () => {
      let message: string[] = [];
      await withProvider(inPlace, (manager) => {
        manager.addMessage('Claude', [text('looking it up'), call('call-0')]);
        const from = manager.getAllMessages().length;
        manager.addMessage('User', [text(prose('LONG', 12_000)), result('call-0', 'Sunny.'), text(prose('AFTER', 6_000))]);
        message = manager.getAllMessages().slice(from).map((m) => m.id);
      }, async (manager, strategy) => {
        const stored = manager.getAllMessages();
        const resultAt = stored.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
        assert.ok((stored[resultAt]!.shardIndex ?? 0) > 0 && message.indexOf(stored[resultAt]!.id) < message.length - 2, 'premise: the result sits on a later shard of its message, with shards of text after it');
        const holding = chunksOf(strategy).find((c) => c.messages.some((m) => m.content.some((b) => b.type === 'tool_use')));
        const ids = new Set(holding?.messages.map((m) => m.id) ?? []);
        assert.deepEqual(message.filter((id) => !ids.has(id)), [], 'the chunk holding the call holds every shard of the message after it');
      });
    });

    it(`${name}: a message that makes calls in turn keeps each call with its own result, a result for an earlier message's call releasing none, and a chunk closes between call-a's result and call-b`, async () => {
      let message: ReturnType<ContextManager['getAllMessages']> = [];
      await withProvider(inPlace, (manager) => {
        manager.addMessage('Claude', [text('asking'), call('call-x')]);
        manager.addMessage('User', [text('plain')]);
        const from = manager.getAllMessages().length;
        manager.addMessage('Claude', [
          text('first'), call('call-a'), text(prose('A', 8_000)), result('call-a', 'a done'), text(prose('MID', 8_000)),
          call('call-b'), text(prose('B', 8_000)), result('call-x', 'x done'), text(prose('XB', 8_000)),
          call('call-c'), text(prose('C', 8_000)), result('call-c', 'c done'),
          text(prose('CB', 8_000)), result('call-b', 'b done'), text('done'),
        ]);
        message = manager.getAllMessages().slice(from);
      }, async (_manager, strategy) => {
        const shardOf = (type: string, id: string) => message.findIndex((m) => m.content.some((b) => b.type === type && ((b as { id?: string }).id === id || (b as { toolUseId?: string }).toolUseId === id)));
        const chunkOf = (k: number) => chunksOf(strategy).findIndex((c) => c.messages.some((m) => m.id === message[k]!.id));
        const [callA, resultA, callB, resultX, callC, resultC, resultB] = [shardOf('tool_use', 'call-a'), shardOf('tool_result', 'call-a'), shardOf('tool_use', 'call-b'), shardOf('tool_result', 'call-x'), shardOf('tool_use', 'call-c'), shardOf('tool_result', 'call-c'), shardOf('tool_result', 'call-b')];
        assert.ok(resultA - callA >= 2 && callB - resultA >= 2 && resultX - callB >= 2 && callC - resultX >= 2 && resultC - callC >= 2 && resultB - resultC >= 2, `premise: the blocks sit on shards apart (${[callA, resultA, callB, resultX, callC, resultC, resultB]})`);
        assert.ok(message.every((_, k) => chunkOf(k) >= 0), 'premise: every shard of the message is in a chunk');
        assert.equal(chunkOf(callA), chunkOf(resultA), 'call-a and its result share a chunk');
        assert.equal(chunkOf(callB), chunkOf(resultB), "call-b and its result share a chunk, call-x's and call-c's results between them notwithstanding");
        assert.equal(chunkOf(callC), chunkOf(resultC), 'call-c and its result share a chunk');
        assert.notEqual(chunkOf(resultA), chunkOf(callB), "a chunk closes between call-a's result and call-b");
      });
    });

    it(`${name}: a round's results in one message stored as shards, as agent-framework stores them, stay with their calls`, async () => {
      const ids = Array.from({ length: 5 }, (_, k) => `call-${k}`);
      await withProvider(inPlace, (manager) => {
        manager.addMessage('Claude', [text('looking them up'), ...ids.map(call)]);
        manager.addMessage('User', ids.flatMap((id) => [text(prose(`BEFORE-${id}`, 3_000)), result(id, `${id} answered`)]));
      }, async (manager, strategy) => {
        assert.ok(manager.getAllMessages().filter((m) => (m.shardIndex ?? 0) > 0 && m.content.some((b) => b.type === 'tool_result')).length > 1, 'premise: results sit on later shards of their message');
        assert.deepEqual(answeredWithCall(strategy), ids, 'the chunk holding the calls holds every result');
      });
    });

    it(`${name}: 40 parallel results, one to a message, too many for one request, close as before: every chunk compresses and the context compiles`, async () => {
      const ids = Array.from({ length: 40 }, (_, k) => `call-${k}`);
      await withProvider(inPlace, (manager) => {
        manager.addMessage('Claude', [text('looking them up'), ...ids.map(call)]);
        for (const id of ids) manager.addMessage('User', [result(id, `${id} answered ` + 'w '.repeat(12_000))]);
      }, async (manager, strategy, seen) => {
        assert.deepEqual(answeredWithCall(strategy), ['call-0'], 'the chunk holding the call holds its first result');
        assert.ok(seen.l1 > 0, 'premise: the stand-in provider saw L1 requests');
        assert.equal(seen.sizeRefused, 0, `no chunk's request is refused for its size (the largest was ~${seen.largest} tokens)`);
        const chunks = chunksOf(strategy);
        assert.ok(chunks.length > 0 && chunks.every((c) => c.compressed), `every chunk compresses (${chunks.filter((c) => c.compressed).length} of ${chunks.length})`);
        for (const maxTokens of [100_000, 300_000]) await manager.compile({ maxTokens, reserveForResponse: 0 });
      });
    });
  }
});

describe('after a head-window reset, a long reply that thinks and makes a call', () => {
  const MEMBRANE = { complete: async () => ({ stopReason: 'end_turn', content: [text('Summary.')] }) };
  for (const headWindowTokens of [150, 300]) {
    it(`goes out whole after the history from before the reset, its thinking with its call (head ${headWindowTokens})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-reset-'));
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true, targetChunkTokens: 100, headWindowTokens, recentWindowTokens: 300,
        autoTickOnNewMessage: false, compressionModel: 'mock', minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
      });
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: MEMBRANE as never });
      manager.setToolDefinitions(tools as never);
      try {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`old ${i} ` + prose('OLD', 150))]);
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        await manager.resetHeadWindow('NEW TOPIC');
        manager.addMessage('User', [text('go')]);
        const from = manager.getAllMessages().length;
        manager.addMessage('Claude', [
          { type: 'thinking', thinking: 'thinking it through', signature: 'sig' } as unknown as ContentBlock,
          text(prose('REPLY', 7_000)),
          call('call-1'),
        ]);
        const shards = manager.getAllMessages().length - from;
        manager.addMessage('User', [result('call-1', 'Sunny.')]);
        assert.ok(shards >= 12, `premise: the reply is stored as 12 or more shards (${shards})`);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const blocksOf = (type: string) => compiled.messages.map((m, k) => (m.content.some((b) => b.type === type) ? k : -1)).filter((k) => k >= 0);
        const reply = compiled.messages.map((m, k) => (m.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes('REPLY')) ? k : -1)).filter((k) => k >= 0);
        const history = compiled.messages.findIndex((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('old 3')));
        assert.equal(reply.length, 1, `the reply goes out in one entry (${reply.length})`);
        assert.deepEqual([blocksOf('thinking'), blocksOf('tool_use')], [reply, reply], 'its thinking and its call in that entry');
        assert.ok(history >= 0 && reply[0]! > history, 'after the history from before the reset');
        const sent = compiled.messages[reply[0]!]!.content;
        assert.deepEqual(sent.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'its blocks in the order given');
        assert.equal((sent[1] as { text: string }).text, prose('REPLY', 7_000), 'its text whole');
        const stored = manager.getAllMessages();
        const owned = (strategy as unknown as { ownedMessageIds(): Set<string> }).ownedMessageIds();
        const headEnd = (strategy as unknown as { getHeadWindowEnd(s: unknown): number }).getHeadWindowEnd((manager as unknown as { messageStore: unknown }).messageStore);
        const firstShard = stored.findIndex((m) => m.content.some((b) => b.type === 'thinking'));
        assert.ok(headEnd <= firstShard && owned.has(stored[firstShard]!.id), `the head ends before the reply and a chunk owns its first shard, so none of it is left raw outside both (head ends at ${headEnd}, reply from ${firstShard})`);
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const headWindowTokens of [450, 900]) {
    it(`in a store whose chunks begin partway through it, as 0.23.x's do, goes out in two pieces around the history, split where the chunks begin (head ${headWindowTokens})`, async () => {
      // 0.23.1's head end (the token boundary, one message back past a call, then the anchor)
      // and its chunk closes (no close right after a message with a call, and no other hold).
      class Released extends LegacyIngress {
        released = true;
        protected override closesHeld(messages: readonly StoredMessage[], from?: number): Uint8Array {
          return this.released ? new Uint8Array(messages.length) : super.closesHeld(messages, from);
        }
        protected override headWindowEndFrom(store: { estimateTokens(m: StoredMessage): number }, messages: StoredMessage[], startIdx: number): number {
          const self = this as unknown as {
            config: { headWindowTokens: number };
            anchorHeadToCoverage(s: unknown, m: StoredMessage[], b: number, t: number): number;
          };
          if (!this.released) return super.headWindowEndFrom(store as never, messages, startIdx);
          if (self.config.headWindowTokens <= 0) return 0;
          let tokens = 0;
          for (let i = startIdx; i < messages.length; i++) {
            tokens += store.estimateTokens(messages[i]!);
            if (tokens > self.config.headWindowTokens) {
              let boundary = i;
              if (boundary > startIdx && this.hasToolUse(messages[boundary - 1]!)) boundary--;
              return self.anchorHeadToCoverage(store, messages, boundary, tokens);
            }
          }
          return messages.length;
        }
      }
      const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-reset-'));
      const strategy = new Released({
        adaptiveResolution: true, targetChunkTokens: 100, headWindowTokens, recentWindowTokens: 300,
        autoTickOnNewMessage: false, compressionModel: 'mock', minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
      });
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: MEMBRANE as never });
      manager.setToolDefinitions(tools as never);
      try {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`old ${i} ` + prose('OLD', 150))]);
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        await manager.resetHeadWindow('NEW TOPIC');
        manager.addMessage('User', [text('go')]);
        manager.addMessage('Claude', [
          { type: 'thinking', thinking: 'thinking it through', signature: 'sig' } as unknown as ContentBlock,
          text(prose('REPLY', 7_000)),
          call('call-1'),
        ]);
        manager.addMessage('User', [result('call-1', 'Sunny.')]);
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        strategy.released = false;
        const stored = manager.getAllMessages();
        const group = stored.find((m) => m.content.some((b) => b.type === 'thinking'))!.bodyGroupId;
        const shards = stored.map((m, k) => (m.bodyGroupId === group ? k : -1)).filter((k) => k >= 0);
        const owned = (strategy as unknown as { ownedMessageIds(): Set<string> }).ownedMessageIds();
        const split = shards.find((k) => owned.has(stored[k]!.id));
        assert.ok(split !== undefined && split > shards[0]!, `premise: chunks begin partway through the reply (reply ${shards[0]}..${shards.at(-1)}, first owned ${split})`);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const replyAt = compiled.messages.map((m, k) => (m.content.some((b) => b.type === 'thinking' || b.type === 'tool_use' || (b.type === 'text' && (b as { text: string }).text.includes('REPLY'))) ? k : -1)).filter((k) => k >= 0);
        const history = compiled.messages.findIndex((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('old 3')));
        const resultAt = compiled.messages.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
        assert.equal(replyAt.length, 2, `the reply goes out in two entries (${replyAt.length})`);
        assert.ok(replyAt[0]! < history && history < replyAt[1]!, 'one before the history from before the reset and one after it');
        assert.deepEqual(compiled.messages[replyAt[0]!]!.content.map((b) => b.type), ['thinking', 'tool_use', 'text'], 'the first holds its thinking and its call, which a body stored before keeps on its first shard');
        assert.equal(resultAt, replyAt[0]! + 1, 'its result right after the call');
        assert.deepEqual(compiled.messages[replyAt[1]!]!.content.map((b) => b.type), ['text'], 'the second holds the rest of its text');
        const textOf = (k: number) => compiled.messages[k]!.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        const before = stored.slice(shards[0], split).flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        assert.equal(textOf(replyAt[0]!), before, 'the head holds the text of the shards before the first one a chunk owns');
        assert.equal(textOf(replyAt[0]!) + textOf(replyAt[1]!), prose('REPLY', 7_000), 'its text whole across the two');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('the head window\'s end beside a call and its result', () => {
  const MEMBRANE = { complete: async () => ({ stopReason: 'end_turn', content: [text('Summary.')] }) };
  async function withStore(options: Record<string, unknown>, body: (manager: ContextManager, strategy: AutobiographicalStrategy) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'cm-body-blocks-head-'));
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true, targetChunkTokens: 100, autoTickOnNewMessage: false, compressionModel: 'mock',
      minChunkCharsForLLM: 0, l1HoldbackChunks: 0, ...options,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: MEMBRANE as never });
    manager.setToolDefinitions(tools as never);
    try {
      await body(manager, strategy);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const entriesWith = (messages: Array<{ content: ContentBlock[] }>, test: (b: ContentBlock) => boolean) =>
    messages.map((m, k) => (m.content.some(test) ? k : -1)).filter((k) => k >= 0);

  for (const headWindowTokens of [150, 300]) {
    it(`after a reset, a reply that thinks and makes three calls, answered one to a message, goes out whole after the history (head ${headWindowTokens})`, async () => {
      await withStore({ headWindowTokens, recentWindowTokens: 200 }, async (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`old ${i} ` + prose('OLD', 150))]);
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        await manager.resetHeadWindow('NEW TOPIC');
        manager.addMessage('User', [text('go')]);
        const from = manager.getAllMessages().length;
        manager.addMessage('Claude', [
          { type: 'thinking', thinking: 'thinking it through', signature: 'sig' } as unknown as ContentBlock,
          text(prose('REPLY', 5_000)), call('c1'), call('c2'), call('c3'),
        ]);
        assert.ok(manager.getAllMessages().length - from > 4, 'premise: the reply is stored as shards');
        for (const id of ['c1', 'c2', 'c3']) manager.addMessage('User', [result(id, prose(`R-${id}`, 600))]);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const reply = entriesWith(compiled.messages, (b) => b.type === 'text' && (b as { text: string }).text.includes('REPLY'));
        const history = compiled.messages.findIndex((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('old 3')));
        assert.equal(reply.length, 1, `the reply goes out in one entry (${reply.length})`);
        assert.deepEqual(entriesWith(compiled.messages, (b) => b.type === 'tool_use'), reply, 'with its calls');
        assert.ok(history >= 0 && reply[0]! > history, 'after the history from before the reset');
        const sent = compiled.messages[reply[0]!]!.content;
        assert.deepEqual(sent.map((b) => (b.type === 'tool_use' ? `tool_use:${(b as unknown as { id: string }).id}` : b.type)),
          ['thinking', 'text', 'tool_use:c1', 'tool_use:c2', 'tool_use:c3'], 'its blocks in the order given');
        assert.equal((sent[1] as { text: string }).text, prose('REPLY', 5_000), 'its text whole');
      });
    });
  }

  async function resetThenReply(manager: ContextManager, strategy: AutobiographicalStrategy, reply: ContentBlock[], results: string[], budgetThrough: (replyFrom: number, replyTo: number) => number) {
    for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`old ${i} ` + prose('OLD', 150))]);
    await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    const headFrom = manager.getAllMessages().length;
    await manager.resetHeadWindow('NEW TOPIC');
    manager.addMessage('User', [text('go')]);
    const replyFrom = manager.getAllMessages().length;
    manager.addMessage('Claude', reply);
    const replyTo = manager.getAllMessages().length - 1;
    for (const id of results) manager.addMessage('User', [result(id, prose(`R-${id}`, 600))]);
    const all = manager.getAllMessages();
    const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
    (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens =
      all.slice(headFrom, budgetThrough(replyFrom, replyTo) + 1).reduce((t, m) => t + store.estimateTokens(m), 0);
    return { all, replyFrom, replyTo, compiled: await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }) };
  }
  const historyAt = (messages: Array<{ content: ContentBlock[] }>) =>
    messages.findIndex((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('old 3')));

  it('after a reset, where the head\'s budget ends between parallel results of a reply that opens with text, the reply goes out whole after the history', async () => {
    await withStore({ headWindowTokens: 100_000, recentWindowTokens: 300 }, async (manager, strategy) => {
      const { all, replyFrom, replyTo, compiled } = await resetThenReply(manager, strategy,
        [text(prose('REPLY', 5_000)), call('c1'), call('c2'), call('c3')],
        ['c1', 'c2', 'c3'], (_from, to) => to + 1);
      assert.ok(replyTo > replyFrom && !all[replyFrom]!.content.some((b) => b.type === 'tool_use'), 'premise: the reply\'s calls sit on a later shard than its first');
      const reply = entriesWith(compiled.messages, (b) => b.type === 'text' && (b as { text: string }).text.includes('REPLY'));
      assert.equal(reply.length, 1, `the reply goes out in one entry (${reply.length})`);
      const sent = compiled.messages[reply[0]!]!.content;
      assert.deepEqual(sent.map((b) => (b.type === 'tool_use' ? `tool_use:${(b as unknown as { id: string }).id}` : b.type)),
        ['text', 'tool_use:c1', 'tool_use:c2', 'tool_use:c3'], 'its blocks in the order given');
      assert.equal((sent[0] as { text: string }).text, prose('REPLY', 5_000), 'its text whole');
      const history = historyAt(compiled.messages);
      assert.ok(history >= 0 && reply[0]! > history, 'after the history from before the reset');
      assert.ok(entriesWith(compiled.messages, (b) => b.type === 'tool_result').every((k) => k > reply[0]!), 'its results after it');
    });
  });

  it('where the head\'s end steps back to a reply\'s start, the move to where chunks resume counts the reply\'s shards once', async () => {
    await withStore({ headWindowTokens: 100_000, recentWindowTokens: 30 }, async (manager, strategy) => {
      manager.addMessage('User', [text('start')]);
      const replyFrom = manager.getAllMessages().length;
      manager.addMessage('Claude', [text(prose('REPLY', 5_000)), call('c1')]);
      const replyTo = manager.getAllMessages().length - 1;
      manager.addMessage('User', [result('c1', prose('R-c1', 600))]);
      const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
      const config = (strategy as unknown as { config: { headWindowTokens: number } }).config;
      const throughResult = manager.getAllMessages().reduce((t, m) => t + store.estimateTokens(m), 0);
      config.headWindowTokens = throughResult;
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`later ${i} ` + prose('LATER', 400))]);
      await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      const all = manager.getAllMessages();
      const owned = (strategy as unknown as { ownedMessageIds(): Set<string> }).ownedMessageIds();
      const firstOwned = all.findIndex((m) => owned.has(m.id));
      assert.equal(firstOwned, replyTo + 2, 'premise: chunks begin right after the result, and none owns the reply');
      const first = store.estimateTokens(all[0]) + store.estimateTokens(all[replyFrom]);
      assert.ok(throughResult - first > 0.6 * throughResult, 'premise: the reply and its result after its first shard outweigh the head\'s new budget');
      const throughReply = all.slice(0, replyTo + 1).reduce((t, m) => t + store.estimateTokens(m), 0);
      const headEndAt = (budget: number) => {
        config.headWindowTokens = budget;
        return (strategy as unknown as { getHeadWindowEnd(s: unknown): number }).getHeadWindowEnd(store);
      };
      for (const share of [0.6, 0.4]) assert.ok(store.estimateTokens(all[0]) < share * throughResult && share * throughResult < throughReply, `premise: a budget of ${share} of the tokens through the result ends inside the reply`);
      assert.equal(headEndAt(Math.floor(0.6 * throughResult)), firstOwned, 'the head ends where chunks resume, holding the reply and its result');
      assert.equal(headEndAt(Math.floor(0.4 * throughResult)), replyFrom, 'past twice the budget the move gives up, and the head ends at the reply\'s start');
    });
  });

  it('a long body that answers an earlier call and makes and answers its own stays in the head where the budget reaches past it', async () => {
    await withStore({ headWindowTokens: 100_000, recentWindowTokens: 30 }, async (manager, strategy) => {
      manager.addMessage('User', [text('start')]);
      manager.addMessage('Claude', [text('calling a'), call('a')]);
      manager.addMessage('User', [result('a', 'a done'), text(prose('B1', 1_500)), call('b'), result('b', 'b done'), text(prose('B2', 2_500))]);
      const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
      const throughBody = manager.getAllMessages();
      assert.ok(throughBody.length > 4, 'premise: the body is stored as shards');
      (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens =
        throughBody.reduce((t, m) => t + store.estimateTokens(m), 0);
      manager.addMessage('Claude', [text('ok ' + prose('OK', 200))]);
      for (let round = 0; round < 2; round++) {
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const headEnd = (strategy as unknown as { getHeadWindowEnd(s: unknown): number }).getHeadWindowEnd(store);
        const owned = (strategy as unknown as { ownedMessageIds(): Set<string> }).ownedMessageIds();
        assert.equal(headEnd, throughBody.length, `compile ${round}: the head ends after the body, as the budget reaches`);
        assert.ok(throughBody.every((m) => !owned.has(m.id)), `compile ${round}: no chunk owns a shard of it`);
        for (let k = 0; k < 40; k++) await manager.tick();
      }
    });
  });
});
