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

async function openManager(name: string, shape: Shape = {}, turns = 60, unansweredCalls = false) {
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
      if (unansweredCalls && i % 2 === 1 && i > 30) {
        cm.addMessage('Claude', [{ type: 'text', text: `Checking ${i}.` }, { type: 'tool_use', id: `m${i}`, name: 'look', input: { at: i } }] as ContentBlock[]);
        cm.addMessage('User', [{ type: 'text', text: `turn ${i}b: and then?` }]);
      }
      for (let k = 0; k < 200 && !cm.isReady(); k++) await cm.tick();
    }
  }
  return { cm, strategy, internals: strategy as unknown as Internals };
}

/** A store whose calibration record holds `multiplier`, so it isn't provisional. */
async function seededAt(name: string, multiplier: number, shape: Shape = {}, turns = 60, unansweredCalls = false) {
  const first = await openManager(name, shape, turns, unansweredCalls);
  await first.cm.compile(BUDGET);
  first.internals.store!.setStateJson(first.internals.calibrationStateId,
    { multiplier, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
  first.cm.close();
  return openManager(name, shape, turns, unansweredCalls);
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

const pricedOf = (stats: RenderStats): number => stats.total.tokens + stats.request!.injectedTokens + stats.request!.overheadTokens;
const besidesOf = (stats: RenderStats): number => stats.request!.injectedTokens + stats.request!.overheadTokens;
const BIG: RequestOverhead = { system: `You are a resident. ${'Be precise about the work in front of you. '.repeat(600)}`, tools: TOOLS };

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

  it('while the multiplier is provisional, keeps the request within the limit priced at that multiplier, as a measured store does, and its first sample replaces it', async () => {
    const base = await uncappedOn('provisional-base', () => openManager('provisional-base'));
    const limit = BUDGET.reserveForResponse + Math.ceil((requestTokens(base) - BUDGET.reserveForResponse) * 1.1);
    const { cm, strategy } = await openManager('provisional');
    const first = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit })).renderStats!;
    assert.equal(first.calibration!.provisional, true, 'premise: a store with no record is provisional');
    assert.equal(first.calibration!.multiplier, 1, 'premise: at 1');
    assert.equal(first.total.tokens, base.total.tokens, 'priced at its multiplier, the request is within the limit, so the window is the one it selects with no limit');
    const priced = pricedOf(first);
    assert.ok(priced * 1.0625 + BUDGET.reserveForResponse <= limit, 'premise: at a true rate of 1.0625 the provider accepts it');
    strategy.reportRealInputTokens(priced * 1.0625, OVERHEAD);
    const next = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit })).renderStats!;
    assert.equal(next.calibration!.multiplier, 1.0625, 'the sample set the rate');
    assert.ok(!next.calibration!.provisional, 'and ended the provisional state');
    assert.ok(requestTokens(next) <= limit, `at the sampled rate, ${requestTokens(next)} is within ${limit}`);
    cm.close();
  });

  it('compiles a fresh store whose overhead fits the limit at its multiplier but not at the calibration\'s ceiling, as a store measured at 1 does', async () => {
    const twin = await seededAt('fresh-fits-twin', 1);
    const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
    const limit = BUDGET.reserveForResponse + Math.floor(besides * 1.6);
    const measured = await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: limit, dryRun: true });
    assert.ok(requestTokens(measured.renderStats!) <= limit, 'premise: a store measured at 1 fits the limit');
    twin.cm.close();
    const { cm } = await openManager('fresh-fits');
    const { messages, renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: limit });
    assert.equal(renderStats!.calibration!.provisional, true, 'premise: a store with no record is provisional');
    assert.ok(requestTokens(renderStats!) <= limit, `the request ${requestTokens(renderStats!)} is within ${limit}`);
    assert.deepStrictEqual(messages, measured.messages, 'the select a store measured at 1 makes');
    cm.close();
  });

  it('names the rate an own refusal under a limit priced the request at', async () => {
    const twin = await seededAt('names-rate-twin', 1);
    const probe = (await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
    const besides = besidesOf(probe);
    const noRoom = BUDGET.reserveForResponse + Math.floor(besides / 2);
    await assert.rejects(twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: noRoom }), (e: Error) => {
      assert.ok(e.message.startsWith(`The request limit of ${noRoom} tokens leaves the window no room`), e.message);
      assert.ok(e.message.includes(' (those two priced at the store\'s multiplier of 1.00) come to '), `a measured store: ${e.message}`);
      return true;
    });
    const inSelect = BUDGET.reserveForResponse + besides + 100;
    await assert.rejects(twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: inSelect }), (e: Error) => {
      assert.equal(e.name, 'OverBudgetError', e.message);
      assert.ok(!e.message.startsWith('The request limit of'), `premise: refused inside the select: ${e.message}`);
      assert.ok(e.message.endsWith(' Under the request limit, the request is priced at the store\'s multiplier of 1.00.'), e.message);
      return true;
    });
    twin.cm.close();
    const { cm } = await openManager('names-rate-fresh');
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: noRoom }), (e: Error) => {
      assert.ok(e.message.includes(' (those two priced at the store\'s provisional multiplier of 1.00, which no request has measured under the current pricing) come to '),
        `a fresh store: ${e.message}`);
      return true;
    });
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
      assert.equal((e as Error & { diagnostics: { requestLimitBound?: boolean; requestAllowanceTokens?: number } }).diagnostics.requestLimitBound, true, 'the limit is the bound that refused');
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

  for (const [label, arm] of [['the limit leaves no room at it', 'no-room'], ['the select refuses within the allowance the limit set', 'in-select']] as const) {
    it(`drops a provisional multiplier above 1 that a limit refuses to 1, as a budget refusal does, and compiles: ${label}`, async () => {
      const twin = await seededAt(`drop-twin-${arm}`, 1);
      const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
      const limit = BUDGET.reserveForResponse + (arm === 'no-room' ? Math.floor(besides * 1.3) : Math.ceil(besides * 1.4) + 100);
      const measured = await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: limit, dryRun: true });
      assert.ok(requestTokens(measured.renderStats!) <= limit, 'premise: a store measured at 1 fits the limit');
      twin.cm.close();
      const { cm } = await provisionalAt(`drop-${arm}`, 1.4);
      const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
      assert.deepStrictEqual([probe.calibration!.provisional, probe.calibration!.multiplier], [true, 1.4], 'premise: provisional at 1.4');
      const { messages, renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: limit });
      assert.equal(renderStats!.calibration!.multiplier, 1, 'dropped to 1');
      assert.equal(renderStats!.calibration!.reset?.discardedMultiplier, 1.4, 'with the reset recorded');
      assert.ok(requestTokens(renderStats!) <= limit, `the request ${requestTokens(renderStats!)} is within ${limit}`);
      assert.deepStrictEqual(messages, measured.messages, 'the select a store measured at 1 makes');
      cm.close();
    });
  }

  it('drops a provisional multiplier above 1 that a limit refuses while the provider\'s rate prices the request, as it does any refusal', async () => {
    const twin = await seededAt('rate-drop-twin', 1);
    const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
    twin.cm.close();
    const { cm, strategy } = await provisionalAt('rate-drop', 1.4);
    const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: BUDGET.reserveForResponse + Math.ceil(pricedOf(probe) / 1.4 * 1.6) });
    assert.equal(strategy.reportRefusedAsTooLong(undefined, BIG).changed, true, 'premise: a count-less refusal keeps the ceiling as the rate');
    const noRoom = BUDGET.reserveForResponse + Math.floor(besides * 1.3);
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: noRoom }), (e: Error) => {
      assert.ok(e.message.includes(' (those two priced at a rate of 1.80 kept from a too-long refusal) come to '), `the rate prices the request: ${e.message}`);
      return true;
    });
    const after = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
    assert.equal(after.calibration!.multiplier, 1, 'dropped to 1');
    assert.equal(after.calibration!.reset?.discardedMultiplier, 1.4, 'with the reset recorded');
    cm.close();
  });

  it('says on a refusal under a limit whether the limit, not the budget, is the bound that refused', async () => {
    const twin = await seededAt('bound-twin', 1);
    const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!);
    twin.cm.close();
    const { cm } = await seededAt('bound', 1);
    const wide = { ...BUDGET, maxTokens: 40_000 };
    const limit = BUDGET.reserveForResponse + besides + 50;
    await assert.rejects(cm.compile(wide, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit, dryRun: true }), (e: Error) => {
      const d = (e as Error & { diagnostics: { requestLimitBound?: boolean; requestAllowanceTokens?: number } }).diagnostics;
      assert.ok(d.requestAllowanceTokens! > 0, `premise: the limit leaves the window a little room: ${e.message}`);
      assert.equal(d.requestLimitBound, true, `a limit too small for the newest turn is the bound that refused: ${e.message}`);
      return true;
    });
    await assert.rejects(cm.compile({ maxTokens: BUDGET.reserveForResponse + 1, reserveForResponse: BUDGET.reserveForResponse }, INJECTIONS,
      { requestOverhead: OVERHEAD, requestLimitTokens: 1_000_000, dryRun: true }), (e: Error) => {
      assert.equal(e.name, 'OverBudgetError', e.message);
      assert.equal((e as Error & { diagnostics: { requestLimitBound?: boolean; requestAllowanceTokens?: number } }).diagnostics.requestLimitBound, undefined, `a budget refusal under a limit it is well within: ${e.message}`);
      return true;
    });
    cm.close();
  });

  it('says the limit is the bound on a stub refusal whose room the budget\'s bound doesn\'t reach', async () => {
    const { cm } = await openManager('stub-above-bound', { overBudgetGraceRatio: 0 }, 0);
    for (let i = 0; i < 200; i++) {
      cm.addMessage('Claude', [{ type: 'tool_use', id: `u${i}`, name: 'look', input: {} }] as ContentBlock[]);
      cm.addMessage('User', [{ type: 'text', text: 'ok' }]);
    }
    const open = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true });
    const stubs = open.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    const stubPrice = stubs.reduce((n, b) => n + jsonTokenEstimator((b as { content: string }).content), 0);
    const target = BUDGET.maxTokens - BUDGET.reserveForResponse;
    const room = target + 100;
    assert.ok(open.renderStats!.total.tokens <= target && stubPrice >= room, `premise: the window fits the budget and its stubs alone pass the room: ${open.renderStats!.total.tokens}, ${stubPrice}`);
    const limit = BUDGET.reserveForResponse + besidesOf(open.renderStats!) + room;
    await assert.rejects(cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit, dryRun: true }), (e: Error) => {
      assert.ok(e.message.startsWith('The tool-result stubs the pairing repair added'), `premise: the stubs refused it: ${e.message}`);
      const d = (e as Error & { diagnostics: { requestLimitBound?: boolean; requestAllowanceTokens?: number } }).diagnostics;
      assert.equal(d.requestLimitBound, true, 'the limit is the bound that refused, though its room is above the budget\'s');
      return true;
    });
    cm.close();
  });

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
    assert.equal(preview!.exhausted, true, 'no fold can make room');
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
      assert.equal((d as { requestLimitBound?: boolean }).requestLimitBound, true, 'and that the limit is the bound that refused');
      return true;
    });
    cm.close();
  });

  for (const [label, shape, turns] of [['hierarchical', { adaptiveResolution: false }, 60], ['adaptive', {}, 6]] as Array<[string, Shape, number]>) {
    it(`counts the tool-result stubs the pairing repair adds against the limit, refusing in the select a request they take past it where a select with their price reserved can't make room (${label})`, async () => {
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
        const d = (e as Error & { diagnostics: { requestLimitTokens?: number; requestLimitBound?: boolean } }).diagnostics;
        assert.equal(d.requestLimitTokens, top);
        assert.equal(d.requestLimitBound, true, 'the limit is the bound that refused');
        return true;
      }, `the window at ${top} leaves no room for the stub's ${stubPrice}, and this store can't fold to make it`);
      const fits = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top + stubPrice, dryRun: true });
      assert.equal(fits.renderStats!.request!.stubTokens, stubPrice, 'the stub is priced as the store prices its block');
      if (label === 'adaptive') {
        const refused = cm.previewContext(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top })!;
        const planned = cm.previewContext(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top + stubPrice })!;
        assert.equal(refused.fits, false, 'a preview the stubs refused doesn\'t fit');
        assert.equal(refused.exhausted, planned.exhausted, 'and reports the picker as its plan found it');
        assert.equal(refused.requestLimitTokens, top, 'and the limit');
      }
      assert.ok(requestTokens(fits.renderStats!) + stubPrice <= top + stubPrice, 'and the request with it is within the limit');
      cm.close();
    });
  }

  it('makes room for the stubs with one more select, pricing the stubs that select sends', async () => {
    const { cm } = await seededAt('stub-room', 1, {}, 60, true);
    for (let i = 0; i < 20; i++) {
      cm.addMessage('Claude', [{ type: 'text', text: `Looking ${i}.` }, { type: 'tool_use', id: `o${i}`, name: 'look', input: { at: i } }] as ContentBlock[]);
      cm.addMessage('User', [{ type: 'text', text: `And ${i}?` }]);
    }
    const sentStubs = (messages: { content: ContentBlock[] }[]) => messages.flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result' && /^[om]\d+$/.test((b as { toolUseId: string }).toolUseId));
    const open = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true });
    const before = sentStubs(open.messages);
    const top = requestTokens(open.renderStats!);
    const allowance = top - BUDGET.reserveForResponse - open.renderStats!.request!.overheadTokens - open.renderStats!.request!.injectedTokens;
    assert.ok(before.length >= 20, `premise: the repair stubs many calls (${before.length})`);
    const room = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top, dryRun: true });
    const after = sentStubs(room.messages);
    const price = after.reduce((n, b) => n + jsonTokenEstimator((b as { content: string }).content), 0);
    assert.ok(room.renderStats!.request!.allowanceTokens! < allowance, 'the second select ran with the stubs\' price reserved');
    assert.ok(after.length < before.length, `it folded away some unanswered calls (${after.length} of ${before.length} stubs)`);
    assert.equal(room.renderStats!.request!.stubTokens, price, 'and the stubs it sends are priced, not the first select\'s');
    assert.ok(requestTokens(room.renderStats!) + price <= top, `the request with them, ${requestTokens(room.renderStats!) + price}, is within ${top}`);
    cm.close();
  });

  it('refuses a select that trims the newest turn for that turn, not for stubs the limit leaves no room for (adaptive)', async () => {
    const { cm } = await seededAt('newest-trimmed', 1, {}, 60, true);
    const open = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true });
    const top = requestTokens(open.renderStats!);
    const allowance = top - BUDGET.reserveForResponse - open.renderStats!.request!.overheadTokens - open.renderStats!.request!.injectedTokens;
    const room = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top, dryRun: true });
    assert.ok(room.renderStats!.request!.allowanceTokens! < allowance, 'premise: at this limit the stubs take the first select past it');
    cm.addMessage('Claude', [{ type: 'text', text: 'One more look.' }, { type: 'tool_use', id: 'n1', name: 'look', input: { at: 'the newest' } }] as ContentBlock[]);
    await assert.rejects(cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true }), { message: /^Structural repair did not retain the newest turn/ },
      'premise: without a limit, the trimmed newest turn refuses the compile');
    await assert.rejects(cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: top, dryRun: true }), (e: Error) => {
      assert.match(e.message, /^Structural repair did not retain the newest turn/, 'the refusal names the trimmed turn, not the stubs');
      return true;
    });
    cm.close();
  });
});

describe('a too-long refusal (AutobiographicalStrategy.reportRefusedAsTooLong)', () => {
  const R = BUDGET.reserveForResponse;
  const BUDGET_ABOVE_LIMIT = { ...BUDGET, maxTokens: 40_000 };
  const compileUnder = async (cm: ContextManager, limit: number, budget = BUDGET) =>
    (await cm.compile(budget, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit })).renderStats!;
  const compileFree = async (cm: ContextManager) => (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD })).renderStats!;
  const allowanceAt = (limit: number, scale: number, stats: RenderStats) =>
    Math.floor((limit - R) * scale - stats.request!.overheadTokens - stats.request!.injectedTokens);
  const countFor = (stats: RenderStats, multiplier: number, rate: number) => Math.round(pricedOf(stats) / multiplier * rate);
  const rateOf = (count: number, stats: RenderStats, multiplier: number) => count / pricedOf(stats) * multiplier;
  async function bound(name: string, multiplier: number, rate = multiplier) {
    const base = await uncappedOn(`${name}-base`, () => seededAt(`${name}-base`, multiplier));
    const limit = R + Math.floor((pricedOf(base) - Math.floor(base.total.tokens / 4)) / multiplier * rate);
    return { limit, ...(await seededAt(name, multiplier)) };
  }

  it('a provisional store learns a stated count its calibration band takes outright, and says so on its calibration line', async () => {
    const base = await uncappedOn('learn-base', () => openManager('learn-base'));
    const limit = requestTokens(base) + 200;
    const { cm, strategy } = await openManager('learn');
    const first = await compileUnder(cm, limit);
    assert.equal(first.calibration!.provisional, true, 'premise: provisional');
    const count = countFor(first, 1, 1.5);
    const why = `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of 1.50.`;
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    let refused: { changed: boolean; why: string };
    try {
      refused = strategy.reportRefusedAsTooLong(count, OVERHEAD);
    } finally {
      console.warn = warn;
    }
    assert.deepStrictEqual(refused, { changed: true, why });
    assert.ok(warned.some((line) => line.includes(`[estimator-calibration] a too-long refusal: ${why}`)), warned.join('\n'));
    const next = await compileUnder(cm, limit);
    assert.ok(Math.abs(next.calibration!.multiplier - 1.5) < 0.01, `the count set the multiplier: ${next.calibration!.multiplier}`);
    assert.ok(!next.calibration!.provisional, 'and ended the provisional state');
    assert.ok(requestTokens(next) <= limit, `the retry's request ${requestTokens(next)} is within ${limit}`);
    cm.close();
  });

  it('under a generous limit, a count that raises the multiplier past what the budget held is a change, since a retry folds the window', async () => {
    const base = await uncappedOn('both-bounds-base', () => openManager('both-bounds-base'));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await openManager('both-bounds');
    const first = await compileUnder(cm, limit);
    assert.equal(first.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(first.total.tokens * 1.25 > BUDGET.maxTokens - BUDGET.reserveForResponse, `premise: at 1.25 the window passes the budget's target (${first.total.tokens})`);
    const count = countFor(first, 1, 1.25);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of 1.25.`,
    });
    cm.close();
  });

  it('a count inside the dead band under a generous limit changes nothing for a window sent within grace above the budget\'s target, since a retry is the same request', async () => {
    const shape = { overBudgetGraceRatio: 0.35 };
    const { cm, strategy } = await seededAt('grace-window', 1, shape);
    const target = BUDGET.maxTokens - R;
    const big = `the newest message, long enough to be past the target alone `.repeat(Math.ceil((target - 100) * 2.9 / 60));
    cm.addMessage('User', [{ type: 'text', text: big }]);
    const open = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    const limit = requestTokens(open) * 3;
    const first = await compileUnder(cm, limit);
    assert.ok(!first.calibration!.provisional, 'premise: a measured store, so the sample steps the multiplier');
    assert.ok(first.total.tokens > target && first.total.tokens <= target * 1.35, `premise: the window sent sits within grace above the target (${first.total.tokens}, target ${target})`);
    const count = countFor(first, 1, 1.05);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, but at a rate of 1.05 the refused request still fits the request limit, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    const next = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit, dryRun: true })).renderStats!;
    assert.equal(next.calibration!.multiplier, 1, 'premise: the count stayed inside the dead band');
    cm.close();
  });

  it('under a limit, a count no more than a kept rate\'s price that raises the multiplier past what the budget held is a change, since a retry folds the window', async () => {
    const base = await uncappedOn('kept-rate-fold-base', () => openManager('kept-rate-fold-base'));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await openManager('kept-rate-fold');
    await compileUnder(cm, limit);
    assert.equal(strategy.reportRefusedAsTooLong(undefined, OVERHEAD).changed, false, 'premise: a count-less refusal that still fits keeps the ceiling as the rate');
    const second = await compileUnder(cm, limit);
    assert.equal(second.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(second.total.tokens * 1.3 > BUDGET.maxTokens - R, `premise: at 1.3 the window passes the budget's target (${second.total.tokens})`);
    const count = countFor(second, 1, 1.3);
    const price = Math.round(pricedOf(second) * 1.8);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${price}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the sample raises the multiplier to 1.30, at which the window passes the compile's budget, so a retry folds it.`,
    });
    cm.close();
  });

  it('a stated count over the store\'s price that the multiplier doesn\'t step to sets the provider\'s rate, and the next compile fits at it', async () => {
    const { cm, strategy, limit } = await bound('over-a-little', 1.2);
    const first = await compileUnder(cm, limit);
    assert.notEqual(first.request!.allowanceTokens, undefined, 'premise: the limit binds');
    const count = countFor(first, 1.2, 1.2 * 1.08);
    const rate = rateOf(count, first, 1.2);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${rate.toFixed(2)}.`,
    });
    const next = await compileUnder(cm, limit);
    assert.equal(next.calibration!.multiplier, 1.2, 'the multiplier stays');
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1.2 / rate, next), 'the allowance is priced at the provider\'s rate');
    assert.ok(pricedOf(next) / 1.2 * rate + R <= limit, 'so at that rate the request fits');
    cm.close();
  });

  it('a stated count at a true 2.5: the retry fits, its sample keeps the rate, the next turn fits, and so does the turn after the run lands the multiplier at its ceiling', async () => {
    const { cm, strategy, limit } = await bound('true-rate', 1, 2.5);
    const first = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    const count = countFor(first, 1, 2.5);
    const rate = rateOf(count, first, 1);
    assert.equal(strategy.reportRefusedAsTooLong(count, OVERHEAD).changed, true);
    const retry = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(retry.request!.allowanceTokens, allowanceAt(limit, 1 / rate, retry), 'the retry is priced at the provider\'s rate');
    assert.ok(pricedOf(retry) * rate + R <= limit, 'and fits at it');
    const served = countFor(retry, 1, 2.5);
    strategy.reportRealInputTokens(served, OVERHEAD);
    cm.addMessage('User', [{ type: 'text', text: 'And the next thing?' }]);
    const next = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(next.calibration!.multiplier, 1, 'premise: two out-of-band samples leave the multiplier');
    const kept = rateOf(served, retry, 1);
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / kept, next), 'the retry\'s sample keeps the provider\'s rate');
    assert.ok(pricedOf(next) * kept + R <= limit, 'so the next turn fits');
    const third = countFor(next, 1, 2.5);
    strategy.reportRealInputTokens(third, OVERHEAD);
    cm.addMessage('Claude', [{ type: 'text', text: 'Here it is.' }]);
    const after = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(after.calibration!.multiplier, 1.8, 'premise: the third agreeing sample lands the multiplier at its ceiling');
    const last = rateOf(third, next, 1);
    assert.equal(after.request!.allowanceTokens, allowanceAt(limit, 1.8 / last, after), 'and the provider\'s rate still prices the request');
    assert.ok(pricedOf(after) / 1.8 * last + R <= limit, 'so it fits');
    cm.close();
  });

  it('a stated count no higher than the store\'s price changes nothing, and says the limit or the reply\'s reserve is above what the provider takes', async () => {
    const { cm, strategy, limit } = await bound('priced-right', 1.2);
    const first = await compileUnder(cm, limit);
    const count = countFor(first, 1.2, 1.19);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${pricedOf(first)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    const next = await compileUnder(cm, limit);
    assert.equal(next.calibration!.multiplier, 1.2);
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1, next), 'the allowance is priced at the multiplier');
    cm.close();
  });

  it('with the provider\'s rate at 2.5, a count implying 2.3 changes nothing and leaves the rate', async () => {
    const { cm, strategy, limit } = await bound('rate-lower', 1, 2.5);
    const first = await compileUnder(cm, limit);
    const count = countFor(first, 1, 2.5);
    const rate = rateOf(count, first, 1);
    strategy.reportRefusedAsTooLong(count, OVERHEAD);
    const retry = await compileUnder(cm, limit);
    const lower = countFor(retry, 1, 2.3);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(lower, OVERHEAD), {
      changed: false,
      why: `The provider counted ${lower} input tokens, no more than the store's price of ${Math.round(pricedOf(retry) / 1 * rate)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    const next = await compileUnder(cm, limit);
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / rate, next), 'the provider\'s rate stays');
    cm.close();
  });

  it('a count-less refusal prices the request at the calibration\'s ceiling, until a sample replaces that rate or clears it', async () => {
    const { cm, strategy, limit } = await bound('count-less', 1, 1.8);
    await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: true,
      why: 'The provider refused the request as too long without stating its count, so the next compile prices the request at the calibration\'s ceiling of 1.80.',
    });
    const atCeiling = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(atCeiling.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, atCeiling), 'priced at 1.8');
    const higher = countFor(atCeiling, 1, 2);
    strategy.reportRealInputTokens(higher, OVERHEAD);
    const replaced = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(replaced.request!.allowanceTokens, allowanceAt(limit, 1 / rateOf(higher, atCeiling, 1), replaced), 'a sample above the multiplier replaces the rate');
    strategy.reportRealInputTokens(countFor(replaced, 1, 0.95), OVERHEAD);
    const cleared = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(cleared.calibration!.multiplier, 1, 'premise: the multiplier stays at 1');
    assert.equal(cleared.request!.allowanceTokens, allowanceAt(limit, 1, cleared), 'and one at or below the multiplier ends it: the allowance is priced at the multiplier');
    cm.close();
  });

  it('a count-less refusal changes nothing where the store already prices the request at the ceiling or above', async () => {
    const ceiling = await bound('count-less-ceiling', 1.8);
    await compileUnder(ceiling.cm, ceiling.limit);
    assert.deepStrictEqual(ceiling.strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: 'The provider refused the request as too long without stating its count, and the store already prices it at a rate of 1.80, at or above the calibration\'s ceiling of 1.80, so it has nothing to raise.',
    });
    const next = await compileUnder(ceiling.cm, ceiling.limit);
    assert.equal(next.request!.allowanceTokens, allowanceAt(ceiling.limit, 1, next), 'priced at the multiplier still');
    ceiling.cm.close();
    const above = await bound('count-less-above', 1, 2.5);
    const first = await compileUnder(above.cm, above.limit);
    const count = countFor(first, 1, 2.5);
    above.strategy.reportRefusedAsTooLong(count, OVERHEAD);
    await compileUnder(above.cm, above.limit);
    assert.deepStrictEqual(above.strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: `The provider refused the request as too long without stating its count, and the store already prices it at a rate of ${rateOf(count, first, 1).toFixed(2)}, at or above the calibration's ceiling of 1.80, so it has nothing to raise.`,
    });
    above.cm.close();
  });

  it('takes only the compile\'s own sample: a refusal after it was reported changes nothing, and a usage report after a refusal is not taken', async () => {
    const { cm, strategy, limit } = await bound('not-armed', 1);
    const first = await compileUnder(cm, limit);
    strategy.reportRealInputTokens(pricedOf(first), OVERHEAD);
    const why = 'The store has no estimate of the refused request to learn from: its last compile was already reported, there is none, or its select doesn\'t calibrate (adaptiveResolution off).';
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(countFor(first, 1, 2), OVERHEAD), { changed: false, why });
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, OVERHEAD), { changed: false, why }, 'a count-less one too');
    const next = await compileUnder(cm, limit);
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1, next), 'no provider\'s rate was set');
    cm.close();
    const base = await uncappedOn('not-armed-fresh-base', () => openManager('not-armed-fresh-base'));
    const fresh = await openManager('not-armed-fresh');
    const taken = await compileUnder(fresh.cm, requestTokens(base) + 200);
    assert.equal(fresh.strategy.reportRefusedAsTooLong(undefined, OVERHEAD).changed, true, 'premise: the refusal took the sample');
    fresh.strategy.reportRealInputTokens(countFor(taken, 1, 1.5), OVERHEAD);
    const after = (await fresh.cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    assert.deepStrictEqual([after.calibration!.multiplier, after.calibration!.provisional], [1, true], 'the usage report after it teaches nothing');
    fresh.cm.close();
  });

  it('a branch the strategy loads anew starts with no provider\'s rate', async () => {
    const { cm, strategy, limit } = await bound('rate-branch', 1, 1.8);
    await compileUnder(cm, limit);
    assert.equal(strategy.reportRefusedAsTooLong(undefined, OVERHEAD).changed, true, 'premise: the refusal kept the ceiling as the rate');
    await cm.fork('other');
    const forked = await compileUnder(cm, limit);
    assert.equal(forked.calibration!.multiplier, 1, 'premise: at 1');
    const reported = forked.request!.allowanceTokens;
    assert.ok(reported === undefined || reported === allowanceAt(limit, 1, forked),
      `the allowance, where the limit lowers the bound, is priced at the multiplier: ${reported} against ${allowanceAt(limit, 1, forked)}`);
    cm.close();
  });

  it('a dry compile between a compile and its refusal leaves what the refusal reads', async () => {
    const { cm, strategy, limit } = await bound('dry-between', 1, 1.8);
    const first = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    const count = countFor(first, 1, 2.5);
    const rate = rateOf(count, first, 1);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${rate.toFixed(2)}.`,
    }, 'the refusal is of the compile under the limit, at its estimate');
    const next = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / rate, next), 'priced at its rate');
    cm.close();
  });

  it('a refusal changes nothing where the refused request still fits the request limit at the rate it leaves, since a retry would be the same request', async () => {
    const base = await uncappedOn('limit-above-base', () => seededAt('limit-above-base', 1));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await seededAt('limit-above', 1);
    const first = await compileUnder(cm, limit);
    const count = countFor(first, 1, 1.5);
    const rate = rateOf(count, first, 1);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, but at a rate of ${rate.toFixed(2)} the refused request still fits the request limit, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    await compileUnder(cm, limit);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: 'The provider refused the request as too long without stating its count, and at the calibration\'s ceiling of 1.80 the refused request still fits the request limit, so the request limit, or the reply\'s reserve against max_tokens, is above what the provider takes.',
    });
    cm.close();
  });

  it('without a request limit, a count that raises the multiplier changes nothing where the window still fits the budget at it', async () => {
    const small = await openManager('no-limit-small', {}, 6);
    const a = await compileFree(small.cm);
    assert.equal(a.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(a.total.tokens * 1.5 < BUDGET.maxTokens - BUDGET.reserveForResponse, `premise: the window fits the budget at 1.5 (${a.total.tokens})`);
    const count = countFor(a, 1, 1.5);
    assert.deepStrictEqual(small.strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(a)}, but at the multiplier of 1.50 the window still fits the compile's budget, so the compile's budget, with what the request sends beside the window, is above what the provider takes.`,
    });
    small.cm.close();
  });

  it('a usage sample that leaves out the request\'s overhead leaves the provider\'s rate as it is', async () => {
    const { cm, strategy, limit } = await bound('undeclared', 1, 1.8);
    await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(strategy.reportRefusedAsTooLong(undefined, OVERHEAD).changed, true, 'premise: the refusal keeps the ceiling as the rate');
    const priced = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    strategy.reportRealInputTokens(countFor(priced, 1, 5));
    const next = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(next.calibration!.multiplier, 1, 'premise: the undeclared sample leaves the multiplier');
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, next), 'still priced at 1.80');
    cm.close();
  });

  it('without a request limit, a stated count is an ordinary sample, no provider\'s rate is kept, and a retry is worth it only where the multiplier rose', async () => {
    const fresh = await openManager('no-limit-fresh');
    const a = await compileFree(fresh.cm);
    await fresh.cm.compile(BUDGET_ABOVE_LIMIT, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    const countA = countFor(a, 1, 1.5);
    assert.deepStrictEqual(fresh.strategy.reportRefusedAsTooLong(countA, OVERHEAD), {
      changed: true,
      why: `The provider counted ${countA} input tokens, more than the store's price of ${pricedOf(a)}, so the next compile prices the request at a rate of 1.50.`,
    });
    fresh.cm.close();
    const measured = await seededAt('no-limit-measured', 1.2);
    const b = await compileFree(measured.cm);
    const countB = countFor(b, 1.2, 1.19);
    assert.deepStrictEqual(measured.strategy.reportRefusedAsTooLong(countB, OVERHEAD), {
      changed: false,
      why: `The provider counted ${countB} input tokens, no more than the store's price of ${pricedOf(b)}, so the compile's budget, with what the request sends beside the window, is above what the provider takes.`,
    });
    const c = await compileFree(measured.cm);
    const countC = countFor(c, 1.2, 2.5);
    assert.deepStrictEqual(measured.strategy.reportRefusedAsTooLong(countC, OVERHEAD), {
      changed: false,
      why: `The provider counted ${countC} input tokens, more than the store's price of ${pricedOf(c)}, but this sample doesn't move the multiplier, and without a request limit the store keeps no other rate, so the next compile prices the request as this one did.`,
    });
    const limit = requestTokens(c) - Math.floor(c.total.tokens / 4);
    const limited = await compileUnder(measured.cm, limit);
    assert.equal(limited.calibration!.multiplier, 1.2, 'premise: the multiplier stays');
    assert.equal(limited.request!.allowanceTokens, allowanceAt(limit, 1, limited), 'no provider\'s rate was kept');
    await compileFree(measured.cm);
    assert.deepStrictEqual(measured.strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: 'The provider refused the request as too long without stating its count, and without a request limit the store keeps no rate to raise for it.',
    });
    measured.cm.close();
  });
});
