import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, ToolDefinition } from '@animalabs/membrane';
import type { ContextEntry, ContextInjection, ContextLogView, MessageStoreView, RenderStats, SelectOptions, StoredMessage, TokenBudget } from '../src/types/index.js';
import type { RequestOverhead } from '../src/index.js';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy, WindowedPassthroughStrategy, jsonTokenEstimator } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'request-limit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const BUDGET = { maxTokens: 6_000, reserveForResponse: 600 };

type Internals = {
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void } | null;
};

const summarizer = {
  complete: async () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'A memory of this stretch, kept brief.' }],
    usage: { input_tokens: 1000, output_tokens: 20 },
  }),
};

type Shape = { adaptiveResolution?: boolean; overBudgetGraceRatio?: number; enforceBudget?: boolean };

async function openManager(name: string, shape: Shape = {}, turns = 60) {
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'zz-model',
    targetChunkTokens: 120,
    headWindowTokens: 0,
    recentWindowTokens: 400,
    hierarchical: true,
    mergeThreshold: 3,
    adaptiveResolution: shape.adaptiveResolution ?? true,
    ...(shape.overBudgetGraceRatio !== undefined ? { overBudgetGraceRatio: shape.overBudgetGraceRatio } : {}),
    ...(shape.enforceBudget !== undefined ? { enforceBudget: shape.enforceBudget } : {}),
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: summarizer as never });
  if (cm.getMessageCount() === 0) {
    for (let i = 0; i < turns; i++) {
      cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `turn ${i}: steady traffic about the ongoing work, with specifics `.repeat(4) }]);
      for (let k = 0; k < 200 && !cm.isReady(); k++) await cm.tick();
    }
  }
  return { cm, strategy, internals: strategy as unknown as Internals };
}

/** A store whose calibration record holds `multiplier`, so it isn't provisional. */
async function seededAt(name: string, multiplier: number, shape: Shape = {}, turns = 60) {
  const first = await openManager(name, shape, turns);
  await first.cm.compile(BUDGET);
  first.internals.store!.setStateJson(first.internals.calibrationStateId,
    { multiplier, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
  first.cm.close();
  return openManager(name, shape, turns);
}

const TOOLS: ToolDefinition[] = Array.from({ length: 6 }, (_, i) => ({
  name: `server__tool_${i}`,
  description: 'Does one thing on the server. '.repeat(30),
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id.' } }, required: ['id'] },
}));
const OVERHEAD: RequestOverhead = { system: `You are a resident. ${'Be precise. '.repeat(60)}`, tools: TOOLS };
const INJECTIONS: ContextInjection[] = [
  { namespace: 'retrieval', position: 'afterUser', content: [{ type: 'text', text: `Recalled: ${'a fact worth keeping. '.repeat(40)}` }] },
  { namespace: 'identity', position: 'system', content: [{ type: 'text', text: 'A system-position line, which goes into the system prompt.' }] },
];

/** A tool result a caller adds to the request after the compile, sent beside the window. */
const RESULT: ContentBlock[] = [{ type: 'tool_result', toolUseId: 'call-1', content: `{"rows":[${'{"id":"r","value":"a row of output"},'.repeat(120)}{}]}` }] as ContentBlock[];
const BESIDE: RequestOverhead = { ...OVERHEAD, messages: [RESULT] };

/** The whole request as the compile prices it: window, message injections, overhead and the reply's reserve. */
function requestTokens(stats: RenderStats, reserve = BUDGET.reserveForResponse): number {
  return stats.total.tokens + stats.request!.injectedTokens + stats.request!.overheadTokens + reserve;
}

const strip = (s: RenderStats) => ({ ...s, planVsActual: s.planVsActual && { ...s.planVsActual, compileMs: 0, solveMs: 0 } });

/** What a compile without a limit sends, on a twin store. */
async function uncappedOn(name: string, open: () => ReturnType<typeof openManager>) {
  const { cm } = await open();
  const { renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
  cm.close();
  void name;
  return renderStats!;
}

describe('a request limit (SelectOptions.requestLimitTokens)', () => {
  for (const [label, shape] of [['adaptive', {}], ['adaptive, a 0.35 grace', { overBudgetGraceRatio: 0.35 }]] as Array<[string, Shape]>) {
    it(`keeps the whole request within it once the overhead is counted (${label})`, async () => {
      const base = await uncappedOn(`fit-base-${label}`, () => seededAt(`fit-base-${label}`, 1, shape));
      const limit = requestTokens(base) - Math.floor(base.total.tokens / 4);
      const { cm } = await seededAt(`fit-${label}`, 1, shape);
      const { renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
      const stats = renderStats!;
      assert.ok(!stats.calibration?.provisional, 'premise: the seeded store isn\'t provisional');
      assert.ok(requestTokens(stats) <= limit, `the request ${requestTokens(stats)} is within the limit ${limit} (uncapped it was ${requestTokens(base)})`);
      assert.equal(stats.request!.limitTokens, limit);
      assert.equal(stats.request!.allowanceTokens, limit - BUDGET.reserveForResponse - stats.request!.overheadTokens - stats.request!.injectedTokens);
      cm.close();
    });
  }

  for (const [label, shape] of [['', { adaptiveResolution: false }], [', with enforceBudget off', { adaptiveResolution: false, enforceBudget: false }]] as Array<[string, Shape]>) it(`on the hierarchical path${label}, a limit under what the path can fit refuses there, as a budget that low does, not past the limit`, async () => {
    const base = await uncappedOn(`hier-base${label}`, () => seededAt(`hier-base${label}`, 1, shape));
    const limit = requestTokens(base) - Math.floor(base.total.tokens / 20);
    const room = limit - BUDGET.reserveForResponse - base.request!.overheadTokens - base.request!.injectedTokens;
    const plain = await seededAt(`hier-plain${label}`, 1, { adaptiveResolution: false });
    const refusedAt = (e: Error) => e.name === 'UncoveredDropError' || e.name === 'OverBudgetError';
    await assert.rejects(plain.cm.compile({ maxTokens: room + BUDGET.reserveForResponse, reserveForResponse: BUDGET.reserveForResponse }, INJECTIONS),
      refusedAt, 'premise: the path refuses a budget that leaves the window this little');
    plain.cm.close();
    const { cm } = await seededAt(`hier${label}`, 1, shape);
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit }), (e: Error) => {
      assert.ok(refusedAt(e), `${e.name}: ${e.message}`);
      assert.ok(!e.message.startsWith('The compiled request would hold'), `the path refused it itself: ${e.message}`);
      return true;
    });
    cm.close();
  });

  it('while the multiplier is provisional, keeps the request within the limit priced at the calibration\'s ceiling, and its first sample replaces it', async () => {
    const base = await uncappedOn('provisional-base', () => openManager('provisional-base'));
    const limit = requestTokens(base) + 200;
    const { cm, strategy } = await openManager('provisional');
    const first = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit })).renderStats!;
    assert.equal(first.calibration!.provisional, true, 'premise: a store with no record is provisional');
    const ceiling = first.calibration!.ceiling!;
    const priced = first.total.tokens + first.request!.injectedTokens + first.request!.overheadTokens;
    assert.ok(priced * ceiling + BUDGET.reserveForResponse <= limit,
      `priced at the ceiling ${ceiling}, the request ${Math.ceil(priced * ceiling) + BUDGET.reserveForResponse} is within ${limit}`);
    // A true rate of 1.5, under the ceiling: the provider's count fits, and its sample ends the provisional state.
    assert.ok(priced * 1.5 + BUDGET.reserveForResponse <= limit, 'premise: at a true rate of 1.5 the provider accepts it');
    strategy.reportRealInputTokens(priced * 1.5, OVERHEAD);
    const next = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit })).renderStats!;
    assert.equal(next.calibration!.multiplier, 1.5, 'the sample set the rate');
    assert.ok(!next.calibration!.provisional, 'and ended the provisional state');
    assert.ok(requestTokens(next) <= limit, `at the sampled rate, ${requestTokens(next)} is within ${limit}`);
    cm.close();
  });

  it('refuses as an over-budget compile does when the overhead leaves the window no room, naming the limit, and commits nothing', async () => {
    const { cm } = await seededAt('no-room', 1);
    const twin = await seededAt('no-room-twin', 1);
    const probe = (await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    const limit = BUDGET.reserveForResponse + probe.request!.overheadTokens + probe.request!.injectedTokens;
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit }), (e: Error) => {
      assert.equal(e.name, 'OverBudgetError');
      assert.ok(e.message.startsWith(`The request limit of ${limit} tokens leaves the window no room`), e.message);
      return true;
    });
    const after = await cm.compile(BUDGET, INJECTIONS);
    const first = await twin.cm.compile(BUDGET, INJECTIONS);
    assert.deepStrictEqual(after.messages, first.messages);
    assert.deepStrictEqual(strip(after.renderStats!), strip(first.renderStats!), 'the refused compile committed nothing a first compile would see');
    cm.close();
    twin.cm.close();
  });

  /** A store whose record holds `multiplier` with no pricing stamp, so it loads provisional at it. */
  async function provisionalAt(name: string, multiplier: number) {
    const first = await openManager(name);
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier, at: 1 });
    first.cm.close();
    return openManager(name);
  }

  for (const [label, allowance] of [['the limit leaves no room', 0], ['the select refuses within the allowance the limit set', 100]] as const) {
    it(`keeps a provisional multiplier above 1 when the limit made the refusal: ${label}`, async () => {
      const { cm } = await provisionalAt(`keep-provisional-${allowance}`, 1.4);
      const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
      assert.equal(probe.calibration!.provisional, true, 'premise: provisional');
      assert.equal(probe.calibration!.multiplier, 1.4, 'premise: at 1.4');
      const scale = probe.calibration!.multiplier / probe.calibration!.ceiling!;
      const limit = Math.ceil(BUDGET.reserveForResponse + (allowance + probe.request!.overheadTokens + probe.request!.injectedTokens) / scale);
      await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit }), (e: Error) => {
        assert.equal(e.name, 'OverBudgetError', e.message);
        const d = (e as Error & { diagnostics: { requestLimitTokens?: number; requestAllowanceTokens?: number } }).diagnostics;
        assert.equal(d.requestLimitTokens, limit, 'the refusal names the limit');
        assert.equal(typeof d.requestAllowanceTokens, 'number', 'and what it left the window');
        const noRoom = e.message.startsWith(`The request limit of ${limit} tokens leaves the window no room`);
        if (allowance === 0) assert.ok(noRoom && d.requestAllowanceTokens! <= 0, `the no-room refusal: ${e.message}`);
        else assert.ok(!noRoom && d.requestAllowanceTokens! > 0, `a refusal inside the select, within a positive allowance: ${d.requestAllowanceTokens}, ${e.message}`);
        return true;
      });
      const after = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
      assert.equal(after.calibration!.multiplier, 1.4, 'no drop can help a refusal whose bound the limit set, so none is made');
      assert.equal(after.calibration!.reset, undefined, 'and none is recorded');
      cm.close();
    });
  }

  it('windowed-passthrough with an image its policy strips, nested in a tool_result, is never refused by the compile\'s own check where it kept to the limit', async () => {
    const strategy = new SpiedWindowed({ imageStripDepthTokens: 1 });
    const cm = await ContextManager.open({ path: join(dir, 'windowed-image'), strategy, membrane: summarizer as never });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    for (let i = 0; i < 12; i++) {
      cm.addMessage('User', [{ type: 'text', text: `turn ${i}: look at this. `.repeat(6) }]);
      cm.addMessage('Claude', [{ type: 'tool_use', id: `t${i}`, name: 'look', input: { at: i } }] as ContentBlock[]);
      cm.addMessage('User', [{ type: 'tool_result', toolUseId: `t${i}`, content: [{ type: 'text', text: `seen ${i}` }, { type: 'image', source: { type: 'base64', data: png, mediaType: 'image/png' } }] }] as ContentBlock[]);
    }
    await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true });
    strategy.view!.setTokenCalibration!(1.37);
    const base = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true });
    assert.ok(base.messages.some((m) => JSON.stringify(m.content).includes('[image not shown')), 'premise: the policy strips a nested image');
    const exact = strategy.lastWindow + overheadOn(strategy.view!) + BUDGET.reserveForResponse;
    const refusedByTheCheck: number[] = [];
    for (let limit = exact - 40; limit <= exact + 5; limit++) {
      try {
        await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit, dryRun: true });
      } catch (e) {
        if ((e as Error).message.startsWith('The compiled request would hold')) refusedByTheCheck.push(limit);
        else if ((e as Error).name !== 'OverBudgetError') throw e;
      }
    }
    assert.deepStrictEqual(refusedByTheCheck, [], 'the compile\'s check agreed with the strategy\'s own price at every limit');
    cm.close();
  });

  /** The result's price in the window, as a message injection, and the request without it, on a seeded store. */
  async function resultInWindow(twin: Awaited<ReturnType<typeof openManager>>) {
    const asInjection = (await twin.cm.compile(BUDGET, [...INJECTIONS, { namespace: 'result', position: 'afterUser', content: RESULT }], { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    const plain = (await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    return { plain, inWindow: asInjection.request!.injectedTokens - plain.request!.injectedTokens };
  }

  it('prices the messages sent beside the window as the window prices the same content, and keeps the request within the limit with them', async () => {
    const twin = await seededAt('beside-price', 1);
    const { plain, inWindow } = await resultInWindow(twin);
    assert.ok(inWindow > plain.total.tokens / 4, `premise: the result (${inWindow}) is more than a quarter of the window (${plain.total.tokens})`);
    // Without a limit, the select is the same; the overhead's price carries the result.
    const beside = await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BESIDE, dryRun: true });
    const without = await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    assert.deepStrictEqual(beside.messages, without.messages, 'no limit, no change to the select');
    assert.equal(beside.renderStats!.request!.overheadTokens, plain.request!.overheadTokens + inWindow, 'beside the window it costs what it costs in it');
    twin.cm.close();
    // With a limit the uncounted result would take the request past, the request stays within it.
    const limit = requestTokens(plain) + inWindow - Math.floor(plain.total.tokens / 4);
    const { cm } = await seededAt('beside-limit', 1);
    const stats = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BESIDE, requestLimitTokens: limit })).renderStats!;
    const sent = stats.total.tokens + stats.request!.injectedTokens + plain.request!.overheadTokens + inWindow + BUDGET.reserveForResponse;
    assert.ok(sent <= limit, `the request with the result, ${sent}, is within ${limit}`);
    cm.close();
  });

  it('refuses where the messages beside the window leave it no room', async () => {
    const twin = await seededAt('beside-no-room-twin', 1);
    const { plain, inWindow } = await resultInWindow(twin);
    twin.cm.close();
    const limit = BUDGET.reserveForResponse + plain.request!.overheadTokens + plain.request!.injectedTokens + Math.floor(inWindow / 2);
    const { cm } = await seededAt('beside-no-room', 1);
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: BESIDE, requestLimitTokens: limit }), (e: Error) => {
      assert.equal(e.name, 'OverBudgetError', e.message);
      assert.ok(e.message.startsWith(`The request limit of ${limit} tokens leaves the window no room`), e.message);
      assert.ok(e.message.includes(`the request overhead of ${plain.request!.overheadTokens + inWindow}`), `the overhead it names carries the result: ${e.message}`);
      return true;
    });
    cm.close();
  });

  it('changes nothing it doesn\'t have to: a limit the request is within selects as no limit does', async () => {
    const without = await seededAt('under-without', 1);
    const withLimit = await seededAt('under-with', 1);
    const a = await without.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD });
    const b = await withLimit.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: requestTokens(a.renderStats!) * 4 });
    assert.deepStrictEqual(b.messages, a.messages);
    const { request: rb, ...bStats } = b.renderStats!;
    const { request: ra, ...aStats } = a.renderStats!;
    assert.deepStrictEqual(strip(bStats as RenderStats), strip(aStats as RenderStats));
    assert.deepStrictEqual({ overheadTokens: rb!.overheadTokens, injectedTokens: rb!.injectedTokens }, ra);
    assert.equal(rb!.allowanceTokens, undefined, 'no allowance is reported where the limit lowers neither bound');
    without.cm.close();
    withLimit.cm.close();
  });

  it('a dry compile with the same options plans as the live one', async () => {
    const base = await uncappedOn('dry-base', () => seededAt('dry-base', 1));
    const limit = requestTokens(base) - Math.floor(base.total.tokens / 4);
    const dry = await seededAt('dry', 1);
    const live = await seededAt('dry-live', 1);
    const d = await dry.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit, dryRun: true });
    const l = await live.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
    assert.ok(l.renderStats!.request!.allowanceTokens !== undefined, 'premise: the limit lowered the live compile\'s target');
    assert.ok(l.renderStats!.total.tokens < base.total.tokens, 'and it selected less than without the limit');
    assert.ok(requestTokens(l.renderStats!) <= limit, `the live request ${requestTokens(l.renderStats!)} is within ${limit}`);
    assert.deepStrictEqual(d.messages, l.messages);
    assert.equal(d.renderStats!.total.tokens, l.renderStats!.total.tokens);
    assert.equal(d.renderStats!.request!.allowanceTokens, l.renderStats!.request!.allowanceTokens);
    dry.cm.close();
    live.cm.close();
  });

  it('refuses a limit given without the request overhead, or one that isn\'t a positive finite number, before anything is selected', async () => {
    const { cm } = await seededAt('bad-limit', 1);
    const twin = await seededAt('bad-limit-twin', 1);
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestLimitTokens: 5_000 }), TypeError);
    for (const requestLimitTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5000' as unknown as number]) {
      await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens }), TypeError, String(requestLimitTokens));
    }
    assert.throws(() => cm.previewContext(BUDGET, undefined, { render: true, requestLimitTokens: 5_000 }), TypeError, 'a preview');
    const after = await cm.compile(BUDGET, INJECTIONS);
    const first = await twin.cm.compile(BUDGET, INJECTIONS);
    assert.deepStrictEqual(after.messages, first.messages);
    assert.deepStrictEqual(strip(after.renderStats!), strip(first.renderStats!));
    cm.close();
    twin.cm.close();
  });

  it('reserves room only for the injections the compile inserts, not a caller\'s own messageInjections option', async () => {
    const base = await uncappedOn('phantom-base', () => seededAt('phantom-base', 1));
    const limit = requestTokens(base) - Math.floor(base.total.tokens / 4);
    const plain = await seededAt('phantom-plain', 1);
    const phantom = await seededAt('phantom', 1);
    const a = await plain.cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
    const b = await phantom.cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit, messageInjections: [INJECTIONS[0]!.content] });
    assert.equal(b.renderStats!.request!.injectedTokens, 0, 'no injection is priced that the compile doesn\'t insert');
    assert.deepStrictEqual(b.messages, a.messages, 'the same select as without the option');
    plain.cm.close();
    phantom.cm.close();
  });

  it('a preview refused for want of room reports the limit and what it left the window, as the refusal does', async () => {
    const { cm } = await seededAt('preview-no-room', 1);
    const probe = (await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    const limit = BUDGET.reserveForResponse + probe.request!.overheadTokens;
    const preview = cm.previewContext(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
    assert.ok(preview, 'premise: the adaptive path previews');
    assert.equal(preview!.fits, false);
    assert.equal(preview!.exhausted, false, 'no picker ran, so none exhausted');
    assert.equal(preview!.requestLimitTokens, limit, 'the limit');
    assert.equal(preview!.requestAllowanceTokens, 0, 'and the window\'s allowance under it');
    cm.close();
  });

  type View = Pick<MessageStoreView, 'estimateTokens'>;
  type Spy = { view: MessageStoreView | null; lastWindow: number };
  /** Runs a select, recording the store view it prices by and what its entries cost there. */
  function spiedSelect(spy: Spy, store: MessageStoreView, opts: SelectOptions | undefined, ignoreLimit: boolean,
    select: (opts: SelectOptions | undefined) => ContextEntry[]): ContextEntry[] {
    spy.view = store;
    const { requestLimitTokens: _ignored, ...rest } = opts ?? {};
    const entries = select(ignoreLimit ? rest : opts);
    spy.lastWindow = entries.reduce((n, e) => n + store.estimateTokens({ content: e.content } as StoredMessage), 0);
    return entries;
  }
  class SpiedPassthrough extends PassthroughStrategy implements Spy {
    view: MessageStoreView | null = null;
    lastWindow = 0;
    constructor(private readonly ignoreLimit = false) { super(); }
    override select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget, opts?: SelectOptions): ContextEntry[] {
      return spiedSelect(this, store, opts, this.ignoreLimit, (o) => super.select(store, log, budget, o));
    }
  }
  class SpiedWindowed extends WindowedPassthroughStrategy implements Spy {
    view: MessageStoreView | null = null;
    constructor(options: ConstructorParameters<typeof WindowedPassthroughStrategy>[0] = {}) { super(options); }
    lastWindow = 0;
    override select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget, opts?: SelectOptions): ContextEntry[] {
      return spiedSelect(this, store, opts, false, (o) => super.select(store, log, budget, o));
    }
  }

  async function seeded(name: string, strategy: SpiedPassthrough | SpiedWindowed) {
    const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: summarizer as never });
    for (let i = 0; i < 60; i++) {
      cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `turn ${i}: steady traffic about the ongoing work, with specifics `.repeat(4) }]);
    }
    return cm;
  }

  const overheadOn = (view: View) =>
    view.estimateTokens({ content: [{ type: 'text', text: OVERHEAD.system! }, { type: 'text', text: JSON.stringify(OVERHEAD.tools) }] } as StoredMessage);
  /** The result's price as a message in the window: what these strategies select each stored message by. */
  const resultOn = (view: View) => view.estimateTokens({ content: RESULT } as StoredMessage);

  for (const [label, make] of [
    ['passthrough', () => new SpiedPassthrough()],
    ['windowed-passthrough', () => new SpiedWindowed()],
  ] as Array<[string, () => SpiedPassthrough | SpiedWindowed]>) {
    it(`a strategy without render stats keeps the request within it too (${label})`, async () => {
      const strategy = make();
      const cm = await seeded(`room-${label}`, strategy);
      const uncapped = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD });
      const overhead = overheadOn(strategy.view!);
      const limit = strategy.lastWindow + overhead + BUDGET.reserveForResponse - 1_000;
      const capped = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
      assert.ok(capped.messages.length < uncapped.messages.length, 'premise: the limit drops older messages');
      assert.ok(strategy.lastWindow + overhead + BUDGET.reserveForResponse <= limit,
        `the request ${strategy.lastWindow + overhead + BUDGET.reserveForResponse} is within ${limit}`);
      cm.close();
    });

    it(`a strategy without render stats counts the messages beside the window too (${label})`, async () => {
      const strategy = make();
      const cm = await seeded(`room-beside-${label}`, strategy);
      await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD });
      const uncapped = strategy.lastWindow;
      const overhead = overheadOn(strategy.view!) + resultOn(strategy.view!);
      assert.ok(resultOn(strategy.view!) > 1_000, 'premise: the result costs more than the limit takes off');
      const limit = uncapped + overhead + BUDGET.reserveForResponse - 1_000;
      await cm.compile(BUDGET, undefined, { requestOverhead: BESIDE, requestLimitTokens: limit });
      assert.ok(strategy.lastWindow + overhead + BUDGET.reserveForResponse <= limit,
        `the request with the result, ${strategy.lastWindow + overhead + BUDGET.reserveForResponse}, is within ${limit}`);
      cm.close();
    });
  }

  it('the compile itself refuses a request past the limit from a strategy that doesn\'t keep to it, and lets one exactly at it through', async () => {
    const strategy = new SpiedPassthrough(true);
    const cm = await seeded('post-check', strategy);
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    const view = strategy.view!;
    const exact = strategy.lastWindow + view.estimateTokens({ content: INJECTIONS[0]!.content } as StoredMessage) + overheadOn(view) + resultOn(view) + BUDGET.reserveForResponse;
    const at = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BESIDE, requestLimitTokens: exact, dryRun: true });
    assert.ok(at.messages.length > 0, 'a request exactly at the limit is sent');
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: BESIDE, requestLimitTokens: exact - 1, dryRun: true }), (e: Error) => {
      assert.equal(e.name, 'OverBudgetError');
      assert.ok(e.message.includes(String(exact - 1)), e.message);
      const d = (e as Error & { diagnostics: { requestLimitTokens?: number; requestAllowanceTokens?: number } }).diagnostics;
      assert.equal(d.requestLimitTokens, exact - 1, 'the refusal names the limit, as the no-room one does');
      assert.equal(d.requestAllowanceTokens, strategy.lastWindow - 1, 'and what it left the window');
      return true;
    });
    cm.close();
  });

  for (const [label, shape, turns] of [['hierarchical', { adaptiveResolution: false }, 60], ['adaptive', {}, 6]] as Array<[string, Shape, number]>) {
    it(`counts the tool-result stubs the pairing repair adds against the limit, refusing in the select a request they take past it (${label})`, async () => {
      const { cm } = await seededAt(`stubbed-${label}`, 1, shape, turns);
      cm.addMessage('Claude', [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'x1', name: 'look', input: { at: 'the mill' } }] as ContentBlock[]);
      cm.addMessage('User', [{ type: 'text', text: 'And what did you see there?' }]);
      cm.addMessage('Claude', [{ type: 'text', text: 'Nothing yet.' }]);
      cm.addMessage('User', [{ type: 'text', text: 'Look again.' }]);
      const open = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true });
      const stubs = open.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'x1');
      assert.equal(stubs.length, 1, 'premise: the repair stubs the unanswered call');
      const stubPrice = jsonTokenEstimator((stubs[0] as { content: string }).content);
      const top = requestTokens(open.renderStats!);
      await assert.rejects(cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top, dryRun: true }), (e: Error) => {
        assert.equal(e.name, 'OverBudgetError', e.message);
        assert.ok(e.message.startsWith('The tool-result stubs the pairing repair added'), `the select refused it for the stubs: ${e.message}`);
        const d = (e as Error & { diagnostics: { requestLimitTokens?: number } }).diagnostics;
        assert.equal(d.requestLimitTokens, top);
        return true;
      }, `the window at ${top} leaves no room for the stub's ${stubPrice}`);
      const fits = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top + stubPrice, dryRun: true });
      assert.equal(fits.renderStats!.request!.stubTokens, stubPrice, 'the stub is priced as the store prices its block');
      if (label === 'adaptive') {
        const refused = cm.previewContext(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top })!;
        const planned = cm.previewContext(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top + stubPrice })!;
        assert.equal(refused.fits, false, 'a preview the stubs refused doesn\'t fit');
        assert.equal(refused.exhausted, planned.exhausted, 'and reports the picker as its plan found it');
      }
      assert.ok(requestTokens(fits.renderStats!) + stubPrice <= top + stubPrice, 'and the request with it is within the limit');
      cm.close();
    });
  }
});
