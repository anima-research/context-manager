import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@animalabs/membrane';
import type { ContextInjection, RenderStats } from '../src/types/index.js';
import type { RequestOverhead } from '../src/index.js';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'request-overhead-'));
const BUDGET = { maxTokens: 100_000, reserveForResponse: 2_000 };
const TIGHT = { maxTokens: 1_800, reserveForResponse: 200 };
after(() => rmSync(dir, { recursive: true, force: true }));

type Internals = {
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void } | null;
};

const summarizer = {
  complete: async () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'A memory of this stretch, kept brief: ' + 'detail '.repeat(12) }],
    usage: { input_tokens: 1000, output_tokens: 40 },
  }),
};

type Shape = { adaptiveResolution?: boolean; foldingStrategy?: 'kv-stable' | 'kv-unified' };

const KV_UNIFIED = {
  policy: {
    alpha: 0.7,
    budgetLowRatio: 0.5,
    budgetHighRatio: 0.9,
    budgetUnderLambda: 10,
    budgetOverLambda: 10,
    cacheLambda: 1,
    cacheScale: 1000,
    cacheReadPrice: 0.1,
    cacheWritePrice: 1.25,
    continuityLambda: 1,
    continuityScale: 1000,
    continuityRecencyHalfLifeTokens: 1000,
    continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10,
    continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100,
  continuityBucketSize: 100,
  fidelityBucketSize: 100,
  labelCeiling: 10_000,
  adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false,
  preserveGapBearingSummaries: false,
};
const prefixFor = (shape: Shape) => (shape.foldingStrategy === 'kv-unified' ? { kvUnifiedImmutablePrefixHash: 'immutable-v1' } : {});

async function openManager(name: string, shape: Shape = {}) {
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'zz-model',
    targetChunkTokens: 120,
    headWindowTokens: 0,
    recentWindowTokens: 400,
    hierarchical: true,
    mergeThreshold: 3,
    adaptiveResolution: shape.adaptiveResolution ?? true,
    ...(shape.foldingStrategy ? { foldingStrategy: shape.foldingStrategy } : {}),
    ...(shape.foldingStrategy === 'kv-unified' ? { kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } } : {}),
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: summarizer as never });
  if (cm.getMessageCount() === 0) {
    for (let i = 0; i < 60; i++) {
      cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `turn ${i}: steady traffic about the ongoing work, with specifics `.repeat(4) }]);
      for (let k = 0; k < 200 && !cm.isReady(); k++) await cm.tick();
    }
  }
  return { cm, strategy, internals: strategy as unknown as Internals };
}

const TOOLS: ToolDefinition[] = Array.from({ length: 6 }, (_, i) => ({
  name: `server__tool_${i}`,
  description: 'Does one thing on the server. '.repeat(30),
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id.' } }, required: ['id'] },
}));
const OVERHEAD: RequestOverhead = { system: `You are a resident. ${'Be precise. '.repeat(60)}`, tools: TOOLS };
const INJECTIONS: ContextInjection[] = [
  { namespace: 'retrieval', position: 'afterUser', content: [{ type: 'text', text: `Recalled: ${'a fact worth keeping. '.repeat(40)}` }] },
  { namespace: 'notes', position: 'beforeUser', content: [{ type: 'text', text: `Note: ${'something to mind. '.repeat(20)}` }] },
  { namespace: 'identity', position: 'system', content: [{ type: 'text', text: 'A system-position line, which goes into the system prompt.' }] },
];

const MESSAGE_INJECTIONS = INJECTIONS.filter((i) => i.position !== 'system').map((i) => i.content);

async function seededAt(name: string, multiplier: number, shape: Shape = {}) {
  const first = await openManager(name, shape);
  await first.cm.compile(BUDGET, undefined, prefixFor(shape));
  first.internals.store!.setStateJson(first.internals.calibrationStateId,
    { multiplier, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
  first.cm.close();
  return openManager(name, shape);
}

let atOneStores = 0;

async function pricesAtOne(): Promise<{ overheadTokens: number; injectedTokens: number }> {
  const { cm } = await openManager(`at-one-${++atOneStores}`);
  const { renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
  assert.equal(renderStats!.calibration!.multiplier, 1, 'premise: a fresh store prices at 1');
  cm.close();
  return renderStats!.request!;
}

const strip = (s: RenderStats) => ({ ...s, planVsActual: s.planVsActual && { ...s.planVsActual, compileMs: 0, solveMs: 0 } });

const OVERHEAD_BLOCKS = 2;
const INJECTED_BLOCKS = MESSAGE_INJECTIONS.reduce((n, content) => n + content.length, 0);

function assertPricedAt(stats: RenderStats, atOne: { overheadTokens: number; injectedTokens: number }, where: string): void {
  const m = stats.calibration!.multiplier;
  const request = stats.request!;
  const rounding = (blocks: number) => (blocks * (1 + m)) / 2;
  assert.ok(Math.abs(request.overheadTokens - m * atOne.overheadTokens) <= rounding(OVERHEAD_BLOCKS), `${where}: overhead ${request.overheadTokens} at ${m}, ${atOne.overheadTokens} at 1`);
  assert.ok(Math.abs(request.injectedTokens - m * atOne.injectedTokens) <= rounding(INJECTED_BLOCKS), `${where}: injections ${request.injectedTokens} at ${m}, ${atOne.injectedTokens} at 1`);
}

describe('the request overhead priced by the compile (RenderStats.request)', () => {
  it('reports the overhead and the message injections at the prices a calibration sample compares', async () => {
    const { cm, strategy } = await openManager('sample-agrees');
    const { renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
    const request = renderStats!.request!;
    assert.ok(request.overheadTokens > 0 && request.injectedTokens > 0, JSON.stringify(request));
    assert.equal(renderStats!.calibration!.provisional, true, 'premise: a store with no record starts provisional, so its first sample replaces the multiplier outright');
    const total = renderStats!.total.tokens + request.overheadTokens + request.injectedTokens;
    strategy.reportRealInputTokens(1.5 * total, OVERHEAD);
    const next = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
    assert.equal(next.renderStats!.calibration!.multiplier, 1.5,
      'a provider total of 1.5 times the reported window, overhead and injections reads exactly 1.5 only if the sample prices them as the render stats do');
    cm.close();
  });

  it('prices the overhead and the injections at the compile\'s multiplier', async () => {
    const atOne = await pricesAtOne();
    const { cm } = await seededAt('at-one-and-a-half', 1.5);
    const stats = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD })).renderStats!;
    assert.equal(stats.calibration!.multiplier, 1.5, 'premise: the seeded multiplier is in force');
    assertPricedAt(stats, atOne, 'live');
    cm.close();
  });

  it('prices the system prompt and the tool definitions each, and an empty overhead at zero', async () => {
    const { cm } = await openManager('overhead-parts');
    const price = async (requestOverhead: RequestOverhead) => (await cm.compile(BUDGET, undefined, { requestOverhead })).renderStats!.request!;
    assert.deepStrictEqual(await price({}), { overheadTokens: 0, injectedTokens: 0 }, 'an empty overhead with no injections');
    const system = (await price({ system: OVERHEAD.system })).overheadTokens;
    const tools = (await price({ tools: OVERHEAD.tools })).overheadTokens;
    assert.ok(system > 0 && tools > 0, `system ${system}, tools ${tools}`);
    assert.equal((await price(OVERHEAD)).overheadTokens, system + tools);
    cm.close();
  });

  it('refuses an overhead whose tool definitions can\'t be serialised, before anything is selected', async () => {
    const refused = await openManager('bad-overhead');
    const twin = await openManager('bad-overhead-twin');
    const counts = { name: 'counts', description: 'Counts.', inputSchema: { type: 'object', properties: { n: { type: 'integer', default: BigInt(1) } } } };
    await assert.rejects(refused.cm.compile(TIGHT, INJECTIONS, { requestOverhead: { tools: [counts as unknown as ToolDefinition] } }), TypeError);
    const after = await refused.cm.compile(TIGHT, INJECTIONS);
    const first = await twin.cm.compile(TIGHT, INJECTIONS);
    assert.ok(first.renderStats!.planVsActual!.moves > 0, 'premise: a first compile at this budget moves fold levels');
    assert.deepStrictEqual(after.messages, first.messages);
    assert.deepStrictEqual(strip(after.renderStats!), strip(first.renderStats!), 'the refused compile committed nothing a first compile would see');
    refused.cm.close();
    twin.cm.close();
  });

  it('is absent from a compile given no overhead, whatever compiled before it', async () => {
    const { cm } = await openManager('no-overhead');
    assert.strictEqual((await cm.compile(BUDGET)).renderStats!.request, undefined, 'a first compile');
    assert.strictEqual((await cm.compile(BUDGET, INJECTIONS)).renderStats!.request, undefined, 'with message injections');
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
    assert.strictEqual((await cm.compile(BUDGET, INJECTIONS)).renderStats!.request, undefined, 'after a compile with an overhead');
    assert.strictEqual(cm.getRenderStats()!.request, undefined, 'getRenderStats after it');
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    assert.strictEqual((await cm.compile(BUDGET, INJECTIONS)).renderStats!.request, undefined, 'after a dry compile with an overhead');
    await assert.rejects(cm.compile({ maxTokens: 300, reserveForResponse: 100 }, INJECTIONS, { requestOverhead: OVERHEAD }), (e: Error) => e.name === 'OverBudgetError');
    assert.strictEqual((await cm.compile(BUDGET, INJECTIONS)).renderStats!.request, undefined, 'after a refused compile with an overhead');
    assert.strictEqual((await cm.compile(BUDGET, INJECTIONS, { dryRun: true })).renderStats!.request, undefined, 'a dry compile');
    assert.strictEqual(cm.previewContext(TIGHT, undefined, { render: true, messageInjections: MESSAGE_INJECTIONS })!.stats!.request, undefined, 'a preview');
    cm.close();
    const hierarchical = await openManager('no-overhead-hierarchical', { adaptiveResolution: false });
    await hierarchical.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
    assert.strictEqual((await hierarchical.cm.compile(BUDGET, INJECTIONS)).renderStats!.request, undefined, 'the hierarchical path, after a compile with an overhead');
    hierarchical.cm.close();
  });

  it('is absent from a subclass\'s own render-stats pass after a compile with an overhead', async () => {
    class OwnPass extends AutobiographicalStrategy {
      ownPass(): RenderStats | null {
        this.rsBegin();
        return this.rsEnd();
      }
    }
    const strategy = new OwnPass({ compressionModel: 'zz-model', targetChunkTokens: 120, headWindowTokens: 0, recentWindowTokens: 400, adaptiveResolution: true });
    const cm = await ContextManager.open({ path: join(dir, 'own-pass'), strategy, membrane: summarizer as never });
    cm.addMessage('User', [{ type: 'text', text: 'hello '.repeat(400) }]);
    assert.ok((await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD })).renderStats!.request, 'premise: the compile priced its overhead');
    assert.strictEqual(strategy.ownPass()!.request, undefined, 'after a live compile');
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    assert.strictEqual(strategy.ownPass()!.request, undefined, 'after a dry compile');
    await assert.rejects(cm.compile({ maxTokens: 300, reserveForResponse: 100 }, INJECTIONS, { requestOverhead: OVERHEAD }), (e: Error) => e.name === 'OverBudgetError');
    assert.strictEqual(strategy.ownPass()!.request, undefined, 'after a refused compile');
    cm.close();
  });

  it('comes with every compile that returns render stats, at its multiplier: live, dry, a preview and hierarchical', async () => {
    const atOne = await pricesAtOne();
    const { cm } = await seededAt('paths-adaptive', 1.5);
    const live = (await cm.compile(TIGHT, INJECTIONS, { requestOverhead: OVERHEAD })).renderStats!;
    assert.equal(live.calibration!.multiplier, 1.5, 'premise: the seeded multiplier is in force');
    assertPricedAt(live, atOne, 'live');
    assert.deepStrictEqual(cm.getRenderStats()!.request, live.request, 'getRenderStats after the live compile');
    assertPricedAt((await cm.compile(TIGHT, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!, atOne, 'a dry compile');
    assertPricedAt(cm.previewContext(TIGHT, undefined, { render: true, requestOverhead: OVERHEAD, messageInjections: MESSAGE_INJECTIONS })!.stats!, atOne, 'a preview');
    cm.close();
    const hierarchical = await openManager('paths-hierarchical', { adaptiveResolution: false });
    const hs = (await hierarchical.cm.compile(TIGHT, INJECTIONS, { requestOverhead: OVERHEAD })).renderStats!;
    assert.equal(hs.calibration!.multiplier, 1, 'premise: the hierarchical path neither loads nor learns calibration, so it reports and prices at 1');
    assertPricedAt(hs, atOne, 'the hierarchical path');
    hierarchical.cm.close();
  });

  const shapes: Array<[string, Shape, number]> = [
    ['adaptive, flat-profile', {}, 2_000],
    ['adaptive, kv-stable', { foldingStrategy: 'kv-stable' }, 1_800],
    ['adaptive, kv-unified', { foldingStrategy: 'kv-unified' }, 1_800],
    ['hierarchical', { adaptiveResolution: false }, 1_200],
  ];
  for (const [label, shape, maxTokens] of shapes) {
    it(`selects identically with and without an overhead (${label})`, async () => {
      const budget = { maxTokens, reserveForResponse: 200 };
      const without = await openManager(`same-without-${label}`, shape);
      const withOverhead = await openManager(`same-with-${label}`, shape);
      for (let round = 0; round < 3; round++) {
        const a = await without.cm.compile(budget, INJECTIONS, prefixFor(shape));
        const lower = await without.cm.compile({ ...budget, maxTokens: maxTokens - 200 }, INJECTIONS, { ...prefixFor(shape), dryRun: true })
          .then((r) => r.messages, (e: Error) => {
            if (e.name === 'OverBudgetError' || e.name === 'UncoveredDropError') return e.name;
            throw e;
          });
        assert.notDeepStrictEqual(lower, a.messages, `premise, round ${round}: 200 tokens less budget selects otherwise or refuses`);
        const b = await withOverhead.cm.compile(budget, INJECTIONS, { ...prefixFor(shape), requestOverhead: OVERHEAD });
        assert.deepStrictEqual(b.messages, a.messages, `round ${round}: the messages`);
        const { request: _priced, ...bStats } = b.renderStats!;
        assert.deepStrictEqual(strip(bStats as RenderStats), strip(a.renderStats!), `round ${round}: the render stats besides the overhead's price`);
        for (const { cm } of [without, withOverhead]) {
          cm.addMessage('User', [{ type: 'text', text: `more ${round}: further traffic about the work `.repeat(4) }]);
          for (let k = 0; k < 200 && !cm.isReady(); k++) await cm.tick();
        }
      }
      without.cm.close();
      withOverhead.cm.close();
    });
  }
});

describe('the calibration ceiling (RenderStats.calibration.ceiling)', () => {
  it('is reported with every calibration, and is the multiplier a record above it loads and prices at', async () => {
    const atOne = await pricesAtOne();
    const { cm } = await openManager('ceiling-fresh');
    assert.equal((await cm.compile(BUDGET)).renderStats!.calibration!.ceiling, 1.8);
    cm.close();
    const reopened = await seededAt('ceiling', 2.5);
    const stats = (await reopened.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD })).renderStats!;
    assert.equal(stats.calibration!.multiplier, stats.calibration!.ceiling);
    assertPricedAt(stats, atOne, 'the record above the ceiling');
    reopened.cm.close();
  });
});
