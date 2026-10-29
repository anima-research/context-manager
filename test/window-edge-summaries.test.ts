import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, OverBudgetError, UncoveredDropError } from '../src/index.js';
import type { StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-window-edge-summaries';
const made: string[] = [];
after(() => {
  for (const p of made) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
});

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }];

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

const SELECTS = {
  hierarchical: { hierarchical: true },
  'flat-profile': { adaptiveResolution: true, foldingStrategy: 'flat-profile' },
  'kv-unified': { adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } },
} as const;

class Edges extends AutobiographicalStrategy {
  ruleOff = false;
  produced: unknown[] = [];
  leftOut = 0;
  liveLeaveFails?: () => Error;
  dryLeaveFails = false;
  protected override summariesAcross(...args: Parameters<AutobiographicalStrategy['summariesAcross']>): ReturnType<AutobiographicalStrategy['summariesAcross']> {
    const state = this as unknown as { acrossMode: string; _dryRunSelect: boolean };
    if (state.acrossMode === 'leave' && state._dryRunSelect && this.dryLeaveFails) throw new TypeError('the narrowed select failed');
    const fails = state.acrossMode === 'leave' && !state._dryRunSelect ? this.liveLeaveFails : undefined;
    if (fails) {
      this.liveLeaveFails = undefined;
      throw fails();
    }
    const across = this.ruleOff ? new Set<string>() : super.summariesAcross(...args);
    this.leftOut = Math.max(this.leftOut, across.size);
    return across as ReturnType<AutobiographicalStrategy['summariesAcross']>;
  }
  protected override handleProducedOps(...args: Parameters<AutobiographicalStrategy['handleProducedOps']>): void {
    this.produced.push(JSON.parse(JSON.stringify(args)));
    super.handleProducedOps(...args);
  }
  sentRaw(ctx: StrategyContext, edge: 'head' | 'recent'): (position: number) => boolean {
    const store = ctx.messageStore;
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = Math.max(this.getRecentWindowStart(store), headEnd);
    return edge === 'head' ? (i) => i >= headStart && i < headEnd : (i) => i >= recentStart;
  }
  leavesOf(id: string): Set<string> {
    const byId = new Map(this.summaries.map((s) => [s.id, s]));
    const out = new Set<string>();
    const summary = byId.get(id);
    if (summary) this.expandSummaryToLeafMessageIds(summary, byId, out);
    return out;
  }
  summaryIds(): string[] {
    return this.summaries.map((s) => s.id);
  }
  summaryLevels(): Array<{ id: string; level: number; mergedInto?: string }> {
    return this.summaries.map((s) => ({ id: s.id, level: s.level, mergedInto: s.mergedInto }));
  }
  lastEstimate(): number {
    return (this as unknown as { _lastCompileEstimate: number })._lastCompileEstimate;
  }
  set(key: 'headWindowTokens' | 'recentWindowTokens', tokens: number): void {
    (this as unknown as { config: Record<string, number> }).config[key] = tokens;
  }
  seedL1(id: string, sourceIds: string[]): void {
    this.summaries.push({
      id, level: 1, content: `${id} recalls ${sourceIds.length} messages`, tokens: 8, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, created: Date.now(),
    } as never);
    for (const m of sourceIds) this.resolutions.set(m as never, 1);
  }
}

const contextOf = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: the queue did not converge within 500 ticks');
}

type Edge = 'head' | 'recent';

let stores = 0;

async function seeded(select: keyof typeof SELECTS, edge: Edge, extra: Record<string, unknown> = {}) {
  const path = `${STORE}-${process.pid}-${stores++}`;
  made.push(path);
  let calls = 0;
  const membrane = {
    complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[summary ${++calls}] brief` }], usage: { input_tokens: 100, output_tokens: 10 } }),
  };
  const strategy = new Edges({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 80,
    headWindowTokens: 1e9,
    recentWindowTokens: 0,
    mergeThreshold: 4,
    autoTickOnNewMessage: false,
    ...SELECTS[select],
    ...extra,
  } as never);
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ctx = contextOf(manager);
  for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`OPENING_${i} ` + 'opening words of the chronicle '.repeat(3)));
  const opening = ctx.messageStore.getAll();
  let head = 0;
  for (let i = 0; i < 8; i++) head += ctx.messageStore.estimateTokens(opening[i]!);
  strategy.set('headWindowTokens', edge === 'head' ? head : 0);
  for (let i = 0; i < 40; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + 'substantive words about real happenings '.repeat(8)));
  const all = ctx.messageStore.getAll();
  let recent = 0;
  for (let i = all.length - 6; i < all.length; i++) recent += ctx.messageStore.estimateTokens(all[i]!);
  strategy.set('recentWindowTokens', edge === 'head' ? 0 : recent);
  await drain(manager);
  const position = new Map(all.map((m, i) => [m.id, i]));

  if (select === 'hierarchical') ctx.messageStore.setTokenCalibration!(0.6);
  for (let i = 0; i < 12 && ctx.messageStore.getTokenCalibration!() > 0.7; i++) {
    await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    strategy.reportRealInputTokens(Math.round(0.65 * strategy.lastEstimate()));
  }
  assert.ok(ctx.messageStore.getTokenCalibration!() <= 0.7, `premise: the multiplier fell (to ${ctx.messageStore.getTokenCalibration!()})`);
  const sentRaw = strategy.sentRaw(ctx, edge);
  const straddling = strategy.summaryIds().filter((id) => {
    const at = [...strategy.leavesOf(id)].map((leaf) => position.get(leaf)!);
    return at.some(sentRaw) && at.some((i) => !sentRaw(i));
  });
  assert.ok(straddling.length > 0, "premise: a summary covers a message the window sends raw and one it doesn't");
  const twice = async (maxTokens: number): Promise<number[]> => {
    const result = await manager.compile({ maxTokens, reserveForResponse: 0 });
    const sources = result.provenance!.messages;
    const raw = new Set(sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : [])));
    const inSummaries = new Set(sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.flatMap((x) => [...strategy.leavesOf(x.id)]) : [])));
    assert.ok(inSummaries.size > 0, `premise: the compile at ${maxTokens} sends history through summaries`);
    return [...raw].filter((id) => inSummaries.has(id)).map((id) => position.get(id)!);
  };
  return { manager, strategy, ctx, position, twice };
}

const where = (edge: Edge): string =>
  ({ head: "a calibration fall moves the head window's end", recent: "a calibration fall moves the recent window's start" })[edge];

describe('no message is sent both raw and inside a summary', () => {
  for (const select of Object.keys(SELECTS) as Array<keyof typeof SELECTS>) {
    for (const edge of ['head', 'recent'] as const) {
      it(`${select}: after ${where(edge)} among a summary's messages`, async () => {
        const { manager, strategy, twice } = await seeded(select, edge);
        for (const maxTokens of [1000, 1500, 2000]) {
          assert.deepStrictEqual(await twice(maxTokens), [], `at ${maxTokens}, no message is sent both raw and inside a summary`);
        }
        assert.strictEqual(strategy.getStats().acrossFallbacks, 0, 'premise: each compile fits without those summaries');
        await manager.close();
      });
    }
  }
});

describe('a compile that fits only with a summary over a window edge', () => {
  for (const select of Object.keys(SELECTS) as Array<keyof typeof SELECTS>) {
    it(`${select}: takes the summary rather than refusing, and counts it`, async () => {
      const { manager, strategy, twice } = await seeded(select, 'head');
      for (const maxTokens of [600, 700]) await twice(maxTokens);
      assert.strictEqual(strategy.getStats().acrossFallbacks, 2, 'both compiles took the summaries over the edge');
      await manager.close();
    });
  }
});

describe('a summary wholly inside a window, on the hierarchical select', () => {
  async function merged(mergeThreshold: number) {
    const path = `${STORE}-${process.pid}-${stores++}`;
    made.push(path);
    let calls = 0;
    const membrane = {
      complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[summary ${++calls}] brief` }], usage: { input_tokens: 100, output_tokens: 10 } }),
    };
    const strategy = new Edges({
      compressionModel: 'test-compression-model',
      targetChunkTokens: 80,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      mergeThreshold,
      autoTickOnNewMessage: false,
      hierarchical: true,
    } as never);
    const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
    const ctx = contextOf(manager);
    for (let i = 0; i < 64; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + 'substantive words about real happenings '.repeat(8)));
    for (let i = 0; i < 2000 && !manager.isReady(); i++) await manager.tick();
    assert.ok(manager.isReady(), 'premise: compression converged');
    const all = ctx.messageStore.getAll();
    const position = new Map(all.map((m, i) => [m.id, i]));
    const span = (id: string): number[] => [...strategy.leavesOf(id)].map((leaf) => position.get(leaf)!).sort((a, b) => a - b);
    const l2s = strategy.summaryLevels().filter((s) => s.level === 2).sort((a, b) => span(a.id)[0]! - span(b.id)[0]!);
    const tokensFrom = (from: number, to: number): number => {
      let tokens = 0;
      for (let i = from; i < to; i++) tokens += ctx.messageStore.estimateTokens(all[i]!);
      return tokens;
    };
    const twice = async (maxTokens: number): Promise<number[]> => {
      const result = await manager.compile({ maxTokens, reserveForResponse: 0 });
      const sources = result.provenance!.messages;
      const raw = new Set(sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : [])));
      const inSummaries = new Set(sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.flatMap((x) => [...strategy.leavesOf(x.id)]) : [])));
      return [...raw].filter((id) => inSummaries.has(id)).map((id) => position.get(id)!);
    };
    return { manager, strategy, ctx, all, l2s, span, tokensFrom, twice };
  }

  it('the head window ends after an unmerged L2: none of its messages goes out inside it', async () => {
    const { manager, strategy, ctx, l2s, span, tokensFrom, twice } = await merged(4);
    const first = l2s[0]!;
    assert.strictEqual(first.mergedInto, undefined, 'premise: the first L2 is unmerged');
    const end = span(first.id).at(-1)! + 1;
    strategy.set('headWindowTokens', tokensFrom(0, end));
    assert.strictEqual(strategy.sentRaw(ctx, 'head')(end - 1), true, 'premise: the head window holds the L2 whole');
    for (const maxTokens of [3000, 1_000_000]) assert.deepStrictEqual(await twice(maxTokens), [], `at ${maxTokens}, no message is sent both raw and inside a summary`);
    assert.strictEqual(strategy.getStats().acrossFallbacks, 0);
    await manager.close();
  });

  it("the head window ends after an L2 whose L3 reaches past it: the L2 doesn't go out in the L3's place", async () => {
    const { manager, strategy, ctx, l2s, span, tokensFrom, twice } = await merged(2);
    const first = l2s[0]!;
    assert.ok(first.mergedInto !== undefined, 'premise: the first L2 is merged into an L3');
    const end = span(first.id).at(-1)! + 1;
    assert.ok(span(first.mergedInto!).at(-1)! >= end, 'premise: the L3 reaches past the head window');
    strategy.set('headWindowTokens', tokensFrom(0, end));
    assert.strictEqual(strategy.sentRaw(ctx, 'head')(end - 1), true, 'premise: the head window holds the L2 whole');
    for (const maxTokens of [2000, 4000, 1_000_000]) assert.deepStrictEqual(await twice(maxTokens), [], `at ${maxTokens}, no message is sent both raw and inside a summary`);
    assert.strictEqual(strategy.getStats().acrossFallbacks, 0);
    await manager.close();
  });

  it('the recent window starts at an unmerged L2: none of its messages goes out inside it', async () => {
    const { manager, strategy, ctx, all, l2s, span, tokensFrom, twice } = await merged(4);
    const last = l2s.at(-1)!;
    assert.strictEqual(last.mergedInto, undefined, 'premise: the last L2 is unmerged');
    const start = span(last.id)[0]!;
    strategy.set('recentWindowTokens', tokensFrom(start, all.length));
    assert.strictEqual(strategy.sentRaw(ctx, 'recent')(start), true, 'premise: the recent window holds the L2 whole');
    for (const maxTokens of [4000, 1_000_000]) assert.deepStrictEqual(await twice(maxTokens), [], `at ${maxTokens}, no message is sent both raw and inside a summary`);
    assert.strictEqual(strategy.getStats().acrossFallbacks, 0);
    await manager.close();
  });
});

describe('a compile whose select with those summaries left out does not fit, as a dry run', () => {
  const capture = (t: { mock: { method(o: object, k: string, f: (...a: unknown[]) => void): unknown } }): string[] => {
    const lines: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    return lines;
  };
  const timed = (l: string): string => l.replace(/\b(compileMs|solveMs)=\d+/g, '$1=?');
  const FALLBACK = 'failed in a dry run';

  for (const select of ['flat-profile', 'kv-unified'] as const) {
  it(`${select}: does what selecting as before does, ${select === 'kv-unified' ? 'a level pin under a left-out summary and ' : ''}the shadow production pick included`, async (t) => {
    const lines = capture(t);
    const twins = [];
    for (let k = 0; k < 2; k++) {
      const twin = await seeded(select, 'head', { productionBudgetTokens: 400 });
      const inHead = twin.strategy.sentRaw(twin.ctx, 'head');
      const all = twin.ctx.messageStore.getAll();
      const straddling = twin.strategy.summaryLevels().filter((s) => s.level === 1).map((s) => [...twin.strategy.leavesOf(s.id)].map((leaf) => twin.position.get(leaf)!).sort((a, b) => a - b))
        .find((at) => at.some(inHead) && at.some((i) => !inHead(i)))!;
      const outside = straddling.find((i) => !inHead(i))!;
      if (select === 'kv-unified') twin.manager.pinRange(all[outside]!.id, all[outside]!.id, { name: 'held', level: 1 });
      twins.push(twin);
    }
    const [taken, before] = twins as [typeof twins[0], typeof twins[0]];
    before.strategy.ruleOff = true;
    const seen = async (twin: typeof taken, maxTokens: number) => {
      lines.length = 0;
      twin.strategy.produced = [];
      const result = await twin.manager.compile({ maxTokens, reserveForResponse: 0 });
      return {
        request: result.messages.map((m) => ({ participant: m.participant, content: m.content, cacheBreakpoint: m.cacheBreakpoint ?? false })),
        lines: lines.filter((l) => !l.includes(FALLBACK) && !l.includes('dryRun=true')).map(timed).sort(),
        produced: twin.strategy.produced,
        settings: twin.strategy.getHotContextSettings(),
      };
    };
    for (const maxTokens of [600, 700]) {
      const fallbacks = taken.strategy.getStats().acrossFallbacks;
      const a = await seen(taken, maxTokens);
      assert.strictEqual(taken.strategy.getStats().acrossFallbacks, fallbacks + 1, `premise: at ${maxTokens} the compile takes the summaries`);
      const b = await seen(before, maxTokens);
      assert.ok(b.produced.length > 0, `premise: at ${maxTokens} selecting as before enqueues produce ops`);
      assert.deepStrictEqual(a, b, `at ${maxTokens}, the request, its lines, produce ops and hot-context settings are the ones selecting as before gives`);
    }
    taken.strategy.ruleOff = true;
    const a = await seen(taken, 2000);
    const b = await seen(before, 2000);
    assert.deepStrictEqual(a, b, 'the next compile, selecting as before in both, measures its cache markers and fold diff against the same request');
    await taken.manager.close();
    await before.manager.close();
  });
  }

  for (const select of Object.keys(SELECTS) as Array<keyof typeof SELECTS>) {
    it(`${select}: warns and counts the compile, while a preview at that budget does neither and says it fits`, async (t) => {
      const lines = capture(t);
      const { manager, strategy } = await seeded(select, 'head');
      lines.length = 0;
      const fallbacks = strategy.getStats().acrossFallbacks;
      const preview = select === 'hierarchical' ? undefined : manager.previewContext({ maxTokens: 600, reserveForResponse: 0 });
      assert.strictEqual(strategy.getStats().acrossFallbacks, fallbacks, 'a preview counts nothing');
      assert.deepStrictEqual(lines.filter((l) => l.includes(FALLBACK)), [], 'a preview warns nothing');
      if (select !== 'hierarchical') assert.strictEqual(preview?.fits, true, 'the preview says what the compile does: it fits');
      await manager.compile({ maxTokens: 600, reserveForResponse: 0 });
      assert.strictEqual(strategy.getStats().acrossFallbacks, fallbacks + 1, 'the compile counts');
      assert.strictEqual(lines.filter((l) => l.includes(FALLBACK) && l.includes('can send messages twice')).length, 1, 'the compile warns once');
      await manager.close();
    });
  }

  it('kv-unified: a branch opened after a counted fallback reports none of it', async () => {
    const { manager, strategy } = await seeded('kv-unified', 'head');
    const before = strategy.getStats().acrossFallbacks;
    await manager.compile({ maxTokens: 600, reserveForResponse: 0 });
    assert.strictEqual(strategy.getStats().acrossFallbacks, before + 1, 'premise: the compile at 600 counts a fallback');
    await manager.fork('after-a-fallback');
    assert.strictEqual(strategy.getStats().acrossFallbacks, 0, "the new branch's count starts at 0");
    await manager.close();
  });

  it('kv-unified: refused by both selects, the refusal is the one selecting as before gives', async () => {
    const taken = await seeded('kv-unified', 'head');
    const before = await seeded('kv-unified', 'head');
    before.strategy.ruleOff = true;
    const refusal = async (twin: typeof taken, maxTokens: number) => {
      const error = await twin.manager.compile({ maxTokens, reserveForResponse: 0 }).then(() => undefined, (e: unknown) => e);
      if (!(error instanceof OverBudgetError)) return undefined;
      return { name: error.name, message: error.message, clearedBy: error.clearedBy, budget: error.budget, actual: error.actual };
    };
    let budget: number | undefined;
    let expected: Awaited<ReturnType<typeof refusal>>;
    for (let maxTokens = 590; maxTokens >= 200 && budget === undefined; maxTokens -= 10) {
      expected = await refusal(before, maxTokens);
      if (expected && !expected.message.startsWith('Head/tail')) budget = maxTokens;
    }
    assert.ok(budget !== undefined, 'premise: selecting as before refuses past the head and tail at some budget');
    const fallbacks = taken.strategy.getStats().acrossFallbacks;
    taken.strategy.leftOut = 0;
    assert.deepStrictEqual(await refusal(taken, budget!), expected!);
    assert.ok(taken.strategy.leftOut > 0, 'premise: the select with those summaries left out ran');
    assert.strictEqual(taken.strategy.getStats().acrossFallbacks, fallbacks, 'a refused compile counts no fallback');
    assert.deepStrictEqual(taken.strategy.getLastSelectStats(), before.strategy.getLastSelectStats(), "the refused compile's stats are the ones selecting as before leaves, not its dry run's");
    assert.deepStrictEqual(taken.strategy.getHotContextSettings(), before.strategy.getHotContextSettings(), 'and so are its hot-context settings');
    await taken.manager.close();
    await before.manager.close();
  });
});

describe('a live select with those summaries left out that fails after its dry run fit', () => {
  const capture = (t: { mock: { method(o: object, k: string, f: (...a: unknown[]) => void): unknown } }): string[] => {
    const lines: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    return lines;
  };
  const MISS = 'after a dry run of it fit';
  const refusal = (): OverBudgetError => new OverBudgetError({ budget: 1, actual: 2, diagnostics: {} as never, stage: 'a live refusal the dry run did not give' });
  async function leaving(select: keyof typeof SELECTS) {
    const twin = await seeded(select, 'head');
    for (let maxTokens = 500; maxTokens <= 2000; maxTokens += 100) {
      const fallbacks = twin.strategy.getStats().acrossFallbacks;
      twin.strategy.leftOut = 0;
      try {
        await twin.manager.compile({ maxTokens, reserveForResponse: 0 });
      } catch {
        continue;
      }
      if (twin.strategy.getStats().acrossFallbacks === fallbacks && twin.strategy.leftOut > 0) return { ...twin, budget: maxTokens };
    }
    assert.fail('premise: a compile sends the select with summaries left out');
  }

  const refusals = [
    [OverBudgetError, refusal],
    [UncoveredDropError, (): UncoveredDropError => new UncoveredDropError({ droppedIds: ['a live refusal the dry run did not give'], site: 'the live select', diagnostics: { budget: 1, totalTokens: 2 } })],
  ] as const;
  for (const [kind, make] of refusals) {
    it(`flat-profile: a refusal (${kind.name}) stands, warned once, with no render stats of the dry run`, async (t) => {
      const lines = capture(t);
      const { manager, strategy, budget } = await leaving('flat-profile');
      const { acrossFallbacks } = strategy.getStats();
      lines.length = 0;
      strategy.liveLeaveFails = make;
      await assert.rejects(manager.compile({ maxTokens: budget, reserveForResponse: 0 }), (e: unknown) => e instanceof kind && e.message.includes('a live refusal the dry run did not give'));
      assert.strictEqual(strategy.getStats().acrossFallbacks, acrossFallbacks, 'no fallback');
      assert.strictEqual(lines.filter((l) => l.includes(MISS)).length, 1, 'warned once');
      assert.strictEqual(strategy.getLastSelectStats(), null, "the refused compile reports no render stats, not its dry run's");
      await manager.close();
    });
  }

  it('flat-profile: any other failure propagates unwarned', async (t) => {
    const lines = capture(t);
    const { manager, strategy, budget } = await leaving('flat-profile');
    const { acrossFallbacks } = strategy.getStats();
    lines.length = 0;
    strategy.liveLeaveFails = () => new Error('the store failed');
    await assert.rejects(manager.compile({ maxTokens: budget, reserveForResponse: 0 }), /the store failed/);
    assert.strictEqual(strategy.getStats().acrossFallbacks, acrossFallbacks, 'no fallback');
    assert.deepStrictEqual(lines.filter((l) => l.includes(MISS)), [], 'not warned');
    await manager.close();
  });

  it('flat-profile: under a provisional multiplier above 1, the refusal is warned once and the retry at 1 compiles', async (t) => {
    const lines = capture(t);
    const { manager, strategy } = await leaving('flat-profile');
    const calibration = strategy as unknown as { _calibration: number; _calibrationProvisional: { fromEpoch: number | null } | null };
    calibration._calibration = 1.5;
    calibration._calibrationProvisional = { fromEpoch: null };
    strategy.set('headWindowTokens', 100_000);
    const { acrossFallbacks } = strategy.getStats();
    lines.length = 0;
    strategy.leftOut = 0;
    strategy.liveLeaveFails = refusal;
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    assert.ok(strategy.leftOut > 0, 'premise: the select leaves summaries out');
    assert.strictEqual(strategy.getStats().acrossFallbacks, acrossFallbacks, 'no fallback');
    assert.strictEqual(lines.filter((l) => l.includes(MISS)).length, 1, 'warned once');
    assert.deepStrictEqual(lines.filter((l) => l.includes(MISS) && l.includes('compile is refused')), [], "the warning doesn't say the compile is refused");
    assert.strictEqual(lines.filter((l) => l.includes('DISCARDED provisional multiplier')).length, 1, 'premise: the retry at 1 ran');
    assert.strictEqual(calibration._calibration, 1, 'premise: the multiplier was dropped to 1');
    await manager.close();
  });
});

describe('a compile whose select with those summaries left out fails as a dry run for a reason besides the budget', () => {
  for (const select of Object.keys(SELECTS) as Array<keyof typeof SELECTS>) {
    it(`${select}: sends what selecting as before sends, counted and warned`, async (t) => {
      const lines: string[] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
      const taken = await seeded(select, 'head');
      const before = await seeded(select, 'head');
      before.strategy.ruleOff = true;
      taken.strategy.dryLeaveFails = true;
      const request = async (twin: typeof taken) => (await twin.manager.compile({ maxTokens: 1000, reserveForResponse: 0 })).messages.map((m) => ({ participant: m.participant, content: m.content }));
      lines.length = 0;
      const fallbacks = taken.strategy.getStats().acrossFallbacks;
      assert.deepStrictEqual(await request(taken), await request(before));
      assert.strictEqual(taken.strategy.getStats().acrossFallbacks, fallbacks + 1, 'counted');
      assert.strictEqual(lines.filter((l) => l.includes('failed in a dry run (TypeError: the narrowed select failed)')).length, 1, 'warned once');
      await taken.manager.close();
      await before.manager.close();
    });
  }
});

describe('a preview at a budget where the select with those summaries left out fits', () => {
  for (const select of ['flat-profile', 'kv-unified'] as const) {
    it(`${select}: plans what the compile at that budget plans`, async () => {
      const taken = await seeded(select, 'head');
      const before = await seeded(select, 'head');
      before.strategy.ruleOff = true;
      const budget = { maxTokens: 1000, reserveForResponse: 0 };
      const preview = taken.manager.previewContext(budget)!;
      const previewBefore = before.manager.previewContext(budget)!;
      assert.notStrictEqual(preview.finalTokens, previewBefore.finalTokens, 'premise: leaving those summaries out changes the plan');
      const fallbacks = taken.strategy.getStats().acrossFallbacks;
      await taken.manager.compile(budget);
      assert.strictEqual(taken.strategy.getStats().acrossFallbacks, fallbacks, 'premise: the compile leaves them out');
      assert.strictEqual(preview.fits, true, 'the preview fits');
      assert.strictEqual(preview.finalTokens, taken.strategy.getLastSelectStats()?.planVsActual?.planned, "the preview's plan is the compile's");
      await taken.manager.close();
      await before.manager.close();
    });
  }
});

describe('a call and its results, where a window holds part of a summary', () => {
  const shapes = {
    recent: 'the recent window starts inside the summary holding a result, whose call another summary holds, as does the call before it',
    head: "the head window ends inside the summary holding a call, whose results another summary holds",
  } as const;
  const REPAIRED = ['[tool call omitted]', "result isn't shown in this context"];
  const pairedInRequest = (messages: Array<{ content: ContentBlock[] }>, toolId: string): boolean => {
    const at = messages.findIndex((m) => m.content.some((b) => b.type === 'tool_use' && (b as { id?: string }).id === toolId));
    return at >= 0 && (messages[at + 1]?.content.some((b) => b.type === 'tool_result' && (b as { toolUseId?: string }).toolUseId === toolId) ?? false);
  };
  async function pairsStore(select: 'hierarchical' | 'flat-profile', edge: Edge) {
    const path = `${STORE}-${process.pid}-${stores++}`;
    made.push(path);
    const strategy = new Edges({ targetChunkTokens: 1e9, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false, ...SELECTS[select] } as never);
    const manager = await ContextManager.open({ path, strategy });
    const ctx = contextOf(manager);
    const said = (tag: string): string => `${tag} ` + 'words about what happened in this turn '.repeat(4);
    manager.addMessage('user', text(said('ask 0')));
    manager.addMessage('agent', [{ type: 'text', text: said('looking 1') }, { type: 'tool_use', id: 't0', name: 'search', input: { q: 'zero' } }] as never);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: 't0', content: said('result 2') }] as never);
    manager.addMessage('agent', text(said('reply 3')));
    manager.addMessage('user', text(said('ask 4')));
    manager.addMessage('agent', [{ type: 'text', text: said('looking 5') }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'one' } }] as never);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: 't1', content: said('result 6') }] as never);
    for (let i = 7; i < 12; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(said(`turn ${i}`)));
    const all = ctx.messageStore.getAll();
    const ids = (...at: number[]): string[] => at.map((i) => all[i]!.id);
    const tokens = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += ctx.messageStore.estimateTokens(all[i]!);
      return sum;
    };
    if (edge === 'recent') {
      strategy.seedL1('L1-Z', ids(0, 1));
      strategy.seedL1('L1-A', ids(2, 3, 4, 5));
      strategy.seedL1('L1-B', ids(6, 7, 8));
      strategy.set('recentWindowTokens', tokens(8, 12));
    } else {
      strategy.seedL1('L1-A', ids(2, 3, 4, 5));
      strategy.seedL1('L1-B', ids(6, 7, 8));
      strategy.seedL1('L1-C', ids(9, 10));
      strategy.set('headWindowTokens', tokens(0, 3));
      strategy.set('recentWindowTokens', tokens(11, 12));
    }
    const sends = async (maxTokens: number) => {
      const result = await manager.compile({ maxTokens, reserveForResponse: 0 });
      const sources = result.provenance!.messages;
      const raw = new Set(sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : [])));
      const sent = sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.map((x) => x.id) : []));
      const inSummaries = new Set(sent.flatMap((id) => [...strategy.leavesOf(id)]));
      const json = JSON.stringify(result.messages);
      return { messages: result.messages, raw, sent, inSummaries, twice: [...raw].filter((id) => inSummaries.has(id)), repaired: REPAIRED.filter((r) => json.includes(r)) };
    };
    return { manager, strategy, all, sends };
  }

  for (const select of ['hierarchical', 'flat-profile'] as const) {
    for (const edge of ['recent', 'head'] as const) {
      it(`${select}: ${shapes[edge]}, the request parts no call from its results`, async () => {
        const { manager, strategy, all, sends } = await pairsStore(select, edge);
        const pairs: Array<[call: string, result: string, tool: string]> = [[all[1]!.id, all[2]!.id, 't0'], [all[5]!.id, all[6]!.id, 't1']];
        strategy.ruleOff = true;
        assert.ok((await sends(100_000)).twice.length > 0, 'premise: selecting as before, a summary goes out beside a raw copy of one of its messages');
        strategy.ruleOff = false;
        for (const maxTokens of [100_000, 2_000]) {
          const { messages, raw, inSummaries, twice, repaired } = await sends(maxTokens);
          assert.deepStrictEqual(twice, [], `at ${maxTokens}, no message is sent both raw and inside a summary`);
          const parted = pairs.filter(([call, res]) => (raw.has(call) && !raw.has(res) && inSummaries.has(res)) || (raw.has(res) && !raw.has(call) && inSummaries.has(call)));
          assert.deepStrictEqual(parted, [], `at ${maxTokens}, no call goes raw with its result only inside a summary, nor a result with its call`);
          assert.deepStrictEqual(repaired, [], `at ${maxTokens}, the request holds no placeholder or stub`);
          for (const [call, , tool] of pairs) {
            assert.ok(raw.has(call), `at ${maxTokens}, ${tool}'s call goes out raw`);
            assert.ok(pairedInRequest(messages, tool), `at ${maxTokens}, ${tool}'s call goes out with its result in the next message`);
          }
        }
        assert.strictEqual(strategy.getStats().acrossFallbacks, 0, 'premise: each compile fits without those summaries');
        await manager.close();
      });
    }
    it(`${select}: a call a pin keeps raw doesn't take out the summary over it when its result goes raw`, async () => {
      const { manager, strategy, all, sends } = await pairsStore(select, 'recent');
      manager.pinRange(all[5]!.id, all[5]!.id);
      const { messages, raw, sent, repaired } = await sends(100_000);
      assert.ok(raw.has(all[6]!.id), "premise: the window's summary is left out, so its result goes raw");
      assert.ok(sent.includes('L1-A'), 'the summary over the pinned call goes out');
      assert.ok(pairedInRequest(messages, 't1'), 'the pinned call goes out with its result in the next message');
      assert.deepStrictEqual(repaired, [], 'the request holds no placeholder or stub');
      await manager.close();
    });
  }
});
