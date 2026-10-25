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
import { AutobiographicalStrategy, ContextManager, KnowledgeStrategy } from '../src/index.js';
import { legacyIngress } from './_harness/legacy-ingress.js';

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
          // Messages written after the body: the rest of the shape, then four turns.
          const after = shape.writes.length - 1 - shape.body + 4;
          if (place === 'raw in the adaptive middle') assert.ok(stats.middleRaw.tokens > 0, 'premise: the middle sends raw history');
          const given = shape.writes[shape.body]![1];
          if (place === 'across the middle and the recent window') {
            if (given.some((b) => b.type === 'tool_result')) {
              // A window's edge inside a message that holds a tool result moves
              // back to its call, so the whole message and its call are raw in
              // the recent window.
              assert.ok(stats.tail.messages >= after + bodyIds.length + 1,
                `the recent window holds the whole message and its call (${stats.tail.messages} messages)`);
            } else {
              assert.ok(stats.middleRaw.tokens > 0, 'premise: the middle sends some of the body raw');
              assert.ok(stats.tail.messages > after, `premise: the recent window holds some of its shards too (${stats.tail.messages} messages)`);
            }
          }
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

describe('a result that sits after text, on a later shard of its message', () => {
  class Exposed extends AutobiographicalStrategy {
    recentStart(store: unknown) { return this.getRecentWindowStart(store as never); }
    hold(store: unknown) { return this.holdBoundary(store as never); }
    estimates(store: unknown) { return this.postStripEstimates(store as never); }
  }
  /** A call, then a result message `[long text, tool_result]` and a reply. */
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
    // The strategy's view of the store, which carries the holds.
    await withLateResult(true, (strategy, _store, { callAt, from }, view) => {
      assert.ok(strategy.hold(view) <= from, 'premise: the message is held');
      assert.equal(strategy.hold(view), callAt);
    });
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

/** Ingress as LegacyIngress has it, for the Knowledge strategy. */
class LegacyKnowledgeIngress extends KnowledgeStrategy {
  override chunkIngressMessage(participant: string, content: ContentBlock[]) {
    return legacyIngress(super.chunkIngressMessage(participant, content), content);
  }
}

/**
 * The two ways a sharded body puts a call's result past the message right
 * after its tool_use: a result after a long text, on its message's last
 * shard, and a call stored before each block was kept in place, whose
 * tool_use is on its first shard and its text on the shards after it.
 */
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
/** A subclass whose boundary hint asks for a close between every two messages. */
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

/** A store of plain turns, then the pair, then more turns, chunked small. */
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
        // The call starts at its first shard holding a tool_use or a thinking block.
        const callAt = stored.findIndex((m, k) => k >= callFrom && (holds(m, 'tool_use') || holds(m, 'thinking')));
        for (let edge = callAt + 1; edge <= resultTo; edge++) {
          // A head window the messages before `edge` fill exactly: its edge falls at `edge`.
          config.headWindowTokens = stored.slice(0, edge).reduce((n, m) => n + store.estimateTokens(m), 0);
          assert.equal((strategy as Exposed).headEnd(store), callAt, `an edge on message ${edge}`);
        }
      });
    });
  }
});

describe("the head window's end at messages without shards, paired by the calls each leaves open", () => {
  const STUB = "this call's result isn't shown in this context";
  /** Plain turns, the shape, more plain turns; the head's tokens run out at the shape's message `edge` (from 0). */
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
      // Fold what follows the head, so a call the head keeps is sent without the message after it.
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
