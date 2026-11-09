import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, ToolDefinition } from '@animalabs/membrane';
import type { CompileResult, ContextEntry, ContextInjection, ContextLogView, MessageStoreView, RenderStats, SelectOptions, StoredMessage, TokenBudget } from '../src/types/index.js';
import type { RequestOverhead } from '../src/index.js';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy, WindowedPassthroughStrategy, jsonTokenEstimator } from '../src/index.js';
import type { Picker, PickerInputs } from '../src/adaptive/picker.js';

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

class OverstatingStrategy extends AutobiographicalStrategy {
  overstate = false;

  protected buildPicker(inputs: PickerInputs, ...rest: unknown[]): Picker {
    const picker = (super.buildPicker as (inputs: PickerInputs, ...rest: unknown[]) => Picker).call(this, inputs, ...rest);
    if (!this.overstate) return picker;
    const run = picker.run.bind(picker);
    picker.run = (runInputs, budget) => ({ ...run(runInputs, budget), finalTokens: 10_000, budgetMet: false });
    return picker;
  }
}

async function openManager(name: string, shape: Shape = {}, turns = 60, unansweredCalls = false, Strategy: typeof AutobiographicalStrategy = AutobiographicalStrategy) {
  const strategy = new Strategy({
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

const NOT_ARMED = 'The store has no estimate of the refused request to learn from: its last compile was already reported, there is none, a refused compile since discarded the multiplier it was priced at, or its select doesn\'t calibrate (adaptiveResolution off).';

type LimitDiagnostics = { requestLimitBound?: boolean; requestLimitTokens?: number; requestAllowanceTokens?: number };

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
      assert.ok(e.message.includes(', priced at the store\'s multiplier of 1.00)'), e.message);
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

  it('keeps a provisional multiplier that a limit refuses while the provider\'s rate prices the request, since no multiplier moves what that rate lets through', async () => {
    const twin = await seededAt('rate-drop-twin', 1);
    const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
    twin.cm.close();
    const { cm, strategy } = await provisionalAt('rate-drop', 1.4);
    const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: BUDGET.reserveForResponse + Math.ceil(pricedOf(probe) / 1.4 * 1.6) });
    strategy.reportRefusedAsTooLong(undefined, BIG);
    const noRoom = BUDGET.reserveForResponse + Math.floor(besides * 1.3);
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: noRoom }), (e: Error) => {
      assert.ok(e.message.includes(' (those two priced at a rate of 1.80 the store keeps for the request limit) come to '), `premise: the rate prices the request: ${e.message}`);
      return true;
    });
    const after = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
    assert.deepStrictEqual([after.calibration!.multiplier, after.calibration!.provisional, after.calibration!.reset], [1.4, true, undefined],
      'the multiplier stays, provisional, with no reset recorded');
    cm.close();
  });

  it('still drops a provisional multiplier that the budget refuses while a kept rate prices the limit, since the drop resolves a budget\'s refusal', async () => {
    const { cm, strategy } = await provisionalAt('rate-budget-drop', 1.4);
    const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: BUDGET.reserveForResponse + Math.ceil(pricedOf(probe) / 1.4 * 1.6) });
    strategy.reportRefusedAsTooLong(undefined, OVERHEAD);
    cm.addMessage('User', [{ type: 'text', text: 'the newest message, which fits the budget at 1 but not at 1.4 '.repeat(185) }]);
    const { renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: 1_000_000 });
    assert.equal(renderStats!.request!.allowanceTokens, undefined, 'premise: the limit is well above the budget, at the kept rate too');
    assert.deepStrictEqual([renderStats!.calibration!.multiplier, renderStats!.calibration!.reset?.discardedMultiplier], [1, 1.4],
      'the budget refused at 1.4, and the drop to 1 resolved it');
    cm.close();
  });

  it('a refused compile that discards a provisional multiplier leaves no sample of the compile before it to learn from', async () => {
    const twin = await seededAt('discard-armed-twin', 1);
    const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
    twin.cm.close();
    const { cm, strategy } = await provisionalAt('discard-armed', 1.4);
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: 1_000_000 });
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: BUDGET.reserveForResponse + Math.floor(besides * 0.9) }), (e: Error) => {
      assert.ok(e.message.startsWith('The request limit of'), `premise: no room even at 1: ${e.message}`);
      return true;
    });
    const after = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!;
    assert.equal(after.calibration!.reset?.discardedMultiplier, 1.4, 'premise: the refused compile discarded the provisional 1.4');
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, BIG), { changed: false, why: NOT_ARMED });
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

  for (const [label, make] of [['passthrough', () => new PassthroughStrategy()], ['windowed-passthrough', () => new WindowedPassthroughStrategy()]] as const) {
    it(`says on a ${label} refusal under a limit whether the limit, not the budget, is the bound that refused`, async () => {
      const cm = await ContextManager.open({ path: join(dir, `bound-${label}`), strategy: make() });
      cm.addMessage('User', [{ type: 'text', text: 'Set up the tools, please.' }]);
      cm.addMessage('Harness', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]);
      cm.addMessage('User', [{ type: 'text', text: 'the newest message, too long for the room the limit leaves '.repeat(150) }]);
      const small: RequestOverhead = { system: 'You are a resident.' };
      const refusal = async (budget: TokenBudget, requestLimitTokens: number) => {
        let diagnostics: LimitDiagnostics | undefined;
        await assert.rejects(cm.compile(budget, undefined, { requestOverhead: small, requestLimitTokens }), (e: Error) => {
          assert.equal(e.name, 'OverBudgetError', e.message);
          diagnostics = (e as Error & { diagnostics: LimitDiagnostics }).diagnostics;
          return true;
        });
        return diagnostics!;
      };
      const limit = BUDGET.reserveForResponse + 1_000;
      const byLimit = await refusal(BUDGET, limit);
      assert.equal(byLimit.requestLimitBound, true, 'the limit is the bound that refused');
      assert.equal(byLimit.requestLimitTokens, limit, 'with the limit');
      assert.ok(byLimit.requestAllowanceTokens! > 0 && byLimit.requestAllowanceTokens! < 1_000, `and what it left the window: ${byLimit.requestAllowanceTokens}`);
      const byBudget = await refusal({ maxTokens: BUDGET.reserveForResponse + 1_000, reserveForResponse: BUDGET.reserveForResponse }, 1_000_000);
      assert.deepStrictEqual([byBudget.requestLimitBound, byBudget.requestLimitTokens, byBudget.requestAllowanceTokens], [undefined, undefined, undefined],
        'a budget refusal under a limit it is well within carries none of them');
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
    assert.equal(preview!.exhausted, true, 'no fold can make room');
    assert.equal(preview!.requestLimitTokens, limit, 'the limit');
    assert.equal(preview!.requestAllowanceTokens, 0, 'and the window\'s allowance under it');
    assert.equal(preview!.requestLimitBound, true, 'and that the limit is the bound that refused');
    cm.close();
  });

  it('a preview whose plan is over the bound a limit set says the limit is that bound, as the refusal does', async () => {
    const { cm } = await seededAt('preview-plan-bound', 1);
    const probe = (await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    for (let i = 0; i < 40; i++) {
      cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `later turn ${i}: not compressed yet, with specifics `.repeat(4) }]);
    }
    const room = Math.floor((BUDGET.maxTokens - BUDGET.reserveForResponse) / 2);
    const limit = BUDGET.reserveForResponse + probe.request!.overheadTokens + room;
    const preview = cm.previewContext(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit })!;
    assert.equal(preview.fits, false, `premise: the plan is over the bound (${preview.finalTokens} against ${preview.budgetTokens})`);
    assert.equal(preview.budgetTokens, room, 'premise: the bound is the room the limit left');
    assert.equal(preview.requestLimitBound, true, 'the preview says the limit is that bound');
    await assert.rejects(cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit }), (e: Error) => {
      assert.equal((e as Error & { diagnostics: LimitDiagnostics }).diagnostics.requestLimitBound, true, `as the refusal does: ${e.message}`);
      return true;
    });
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
  const sentUnder = (cm: ContextManager, limit: number, budget = BUDGET) =>
    cm.compile(budget, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
  const sentFree = (cm: ContextManager, budget: TokenBudget = BUDGET) => cm.compile(budget, INJECTIONS, { requestOverhead: OVERHEAD });
  const differs = (refused: CompileResult, retry: CompileResult) =>
    retry.messages.length !== refused.messages.length || retry.firstChanged !== retry.messages.length;
  const SMALL: TokenBudget = { maxTokens: R + 180, reserveForResponse: R };
  const NEWEST = 'the newest message, past the target alone and within grace '.repeat(10);
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
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
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
    const retry = await sentUnder(cm, limit);
    assert.ok(differs(sent, retry), 'the retry sends another request');
    const next = retry.renderStats!;
    assert.ok(Math.abs(next.calibration!.multiplier - 1.5) < 0.01, `the count set the multiplier: ${next.calibration!.multiplier}`);
    assert.ok(!next.calibration!.provisional, 'and ended the provisional state');
    assert.ok(requestTokens(next) <= limit, `the retry's request ${requestTokens(next)} is within ${limit}`);
    cm.close();
  });

  it('under a generous limit, a count that raises the multiplier past what the budget held is a change, since a retry folds the window', async () => {
    const base = await uncappedOn('both-bounds-base', () => openManager('both-bounds-base'));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await openManager('both-bounds');
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    assert.equal(first.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(first.total.tokens * 1.25 > BUDGET.maxTokens - BUDGET.reserveForResponse, `premise: at 1.25 the window passes the budget's target (${first.total.tokens})`);
    const count = countFor(first, 1, 1.25);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)} but within the request limit less the reply's reserve, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the sample moves the multiplier to 1.25.`,
    });
    assert.ok(differs(sent, await sentUnder(cm, limit)), 'and the retry sends another request');
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
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    assert.ok(!first.calibration!.provisional, 'premise: a measured store, so the sample steps the multiplier');
    assert.ok(first.total.tokens > target && first.total.tokens <= target * 1.35, `premise: the window sent sits within grace above the target (${first.total.tokens}, target ${target})`);
    const count = countFor(first, 1, 1.05);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)} but within the request limit less the reply's reserve, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the store keeps a rate of ${rateOf(count, first, 1).toFixed(2)} for the request limit.`,
    });
    const retry = await sentUnder(cm, limit);
    assert.equal(retry.renderStats!.calibration!.multiplier, 1, 'premise: the count stayed inside the dead band');
    assert.ok(!differs(sent, retry), 'and the retry sends the refused request');
    cm.close();
  });

  it('under a limit, a count no more than a kept rate\'s price that raises the multiplier past what the budget held is a change, since a retry folds the window', async () => {
    const base = await uncappedOn('kept-rate-fold-base', () => openManager('kept-rate-fold-base'));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await openManager('kept-rate-fold');
    await compileUnder(cm, limit);
    assert.equal(strategy.reportRefusedAsTooLong(undefined, OVERHEAD).changed, false, 'premise: a count-less refusal that still fits keeps the ceiling as the rate');
    const sent = await sentUnder(cm, limit);
    const second = sent.renderStats!;
    assert.equal(second.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(second.total.tokens * 1.3 > BUDGET.maxTokens - R, `premise: at 1.3 the window passes the budget's target (${second.total.tokens})`);
    const count = countFor(second, 1, 1.3);
    const price = Math.round(pricedOf(second) * 1.8);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${price}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the sample moves the multiplier to 1.30.`,
    });
    assert.ok(differs(sent, await sentUnder(cm, limit)), 'and the retry sends another request');
    cm.close();
  });

  it('a refusal of a request whose window was empty changes nothing, and says the request was all overhead and injections', async () => {
    const { cm, strategy } = await openManager('empty-window', {}, 0);
    const limitedSent = await sentUnder(cm, 1_000_000);
    const limited = limitedSent.renderStats!;
    assert.equal(limited.total.tokens, 0, 'premise: the window is empty');
    const empty = 'The refused request\'s window was empty, so it was all overhead and injections, which the store can\'t fold; ' +
      'what the request sends beside the window, with the reply\'s reserve against max_tokens, is above what the provider takes';
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: `${empty}, and either the store's price of it is below the provider's count, or the request limit is above what the provider takes too.`,
    });
    assert.ok(!differs(limitedSent, await sentUnder(cm, 1_000_000)), 'and the retry sends the refused request');
    const freeSent = await sentFree(cm);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(5_000, OVERHEAD), {
      changed: false,
      why: `${empty}.`,
    });
    assert.ok(!differs(freeSent, await sentFree(cm)), 'and without a limit, the retry sends the refused request too');
    cm.close();
  });

  it('a stated count over the store\'s price that the multiplier doesn\'t step to sets the provider\'s rate, and the next compile fits at it', async () => {
    const { cm, strategy, limit } = await bound('over-a-little', 1.2);
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    assert.notEqual(first.request!.allowanceTokens, undefined, 'premise: the limit binds');
    const count = countFor(first, 1.2, 1.2 * 1.08);
    const rate = rateOf(count, first, 1.2);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${rate.toFixed(2)}.`,
    });
    const retry = await sentUnder(cm, limit);
    assert.ok(differs(sent, retry), 'the retry sends another request');
    const next = retry.renderStats!;
    assert.equal(next.calibration!.multiplier, 1.2, 'the multiplier stays');
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1.2 / rate, next), 'the allowance is priced at the provider\'s rate');
    assert.ok(pricedOf(next) / 1.2 * rate + R <= limit, 'so at that rate the request fits');
    cm.close();
  });

  it('a stated count at a true 2.5: the retry fits, its sample keeps the rate, the next turn fits, and so does the turn after the run lands the multiplier at its ceiling', async () => {
    const { cm, strategy, limit } = await bound('true-rate', 1, 2.5);
    const sent = await sentUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    const first = sent.renderStats!;
    const count = countFor(first, 1, 2.5);
    const rate = rateOf(count, first, 1);
    assert.equal(strategy.reportRefusedAsTooLong(count, OVERHEAD).changed, true);
    const retrySent = await sentUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.ok(differs(sent, retrySent), 'the retry sends another request');
    const retry = retrySent.renderStats!;
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
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    const count = countFor(first, 1.2, 1.19);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${pricedOf(first)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    const retry = await sentUnder(cm, limit);
    assert.ok(!differs(sent, retry), 'the retry sends the refused request');
    const next = retry.renderStats!;
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
    const retrySent = await sentUnder(cm, limit);
    const retry = retrySent.renderStats!;
    const lower = countFor(retry, 1, 2.3);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(lower, OVERHEAD), {
      changed: false,
      why: `The provider counted ${lower} input tokens, no more than the store's price of ${Math.round(pricedOf(retry) / 1 * rate)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    const again = await sentUnder(cm, limit);
    assert.ok(!differs(retrySent, again), 'the retry sends the refused request');
    const next = again.renderStats!;
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / rate, next), 'the provider\'s rate stays');
    cm.close();
  });

  it('a count-less refusal prices the request at the calibration\'s ceiling, until a sample replaces that rate or clears it', async () => {
    const { cm, strategy, limit } = await bound('count-less', 1, 1.8);
    const sent = await sentUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: true,
      why: 'The provider refused the request as too long without stating its count, so the next compile prices the request at the calibration\'s ceiling of 1.80.',
    });
    const ceilingSent = await sentUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.ok(differs(sent, ceilingSent), 'the retry sends another request');
    const atCeiling = ceilingSent.renderStats!;
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
    const sent = await sentUnder(ceiling.cm, ceiling.limit);
    assert.deepStrictEqual(ceiling.strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: 'The provider refused the request as too long without stating its count, and the store already prices it at a rate of 1.80, at or above the calibration\'s ceiling of 1.80, so it has nothing to raise.',
    });
    const retry = await sentUnder(ceiling.cm, ceiling.limit);
    assert.ok(!differs(sent, retry), 'the retry sends the refused request');
    const next = retry.renderStats!;
    assert.equal(next.request!.allowanceTokens, allowanceAt(ceiling.limit, 1, next), 'priced at the multiplier still');
    ceiling.cm.close();
    const above = await bound('count-less-above', 1, 2.5);
    const first = await compileUnder(above.cm, above.limit);
    const count = countFor(first, 1, 2.5);
    above.strategy.reportRefusedAsTooLong(count, OVERHEAD);
    const aboveSent = await sentUnder(above.cm, above.limit);
    assert.deepStrictEqual(above.strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: `The provider refused the request as too long without stating its count, and the store already prices it at a rate of ${rateOf(count, first, 1).toFixed(2)}, at or above the calibration's ceiling of 1.80, so it has nothing to raise.`,
    });
    assert.ok(!differs(aboveSent, await sentUnder(above.cm, above.limit)), 'and the retry above the ceiling sends the refused request too');
    above.cm.close();
  });

  it('takes only the compile\'s own sample: a refusal after it was reported changes nothing, and a usage report after a refusal is not taken', async () => {
    const { cm, strategy, limit } = await bound('not-armed', 1);
    const first = await compileUnder(cm, limit);
    strategy.reportRealInputTokens(pricedOf(first), OVERHEAD);
    const why = NOT_ARMED;
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
    strategy.reportRefusedAsTooLong(undefined, OVERHEAD);
    const kept = await compileUnder(cm, limit);
    assert.equal(kept.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, kept), 'premise: the refusal kept the ceiling as the rate, which prices this branch\'s request');
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
    const sent = await sentUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    const first = sent.renderStats!;
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    const count = countFor(first, 1, 2.5);
    const rate = rateOf(count, first, 1);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${rate.toFixed(2)}.`,
    }, 'the refusal is of the compile under the limit, at its estimate');
    const retry = await sentUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.ok(differs(sent, retry), 'the retry sends another request');
    const next = retry.renderStats!;
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / rate, next), 'priced at its rate');
    cm.close();
  });

  it('a count within the request limit less the reply\'s reserve says the limit is above what the provider takes, and a count-less refusal that still fits at the ceiling says either reading', async () => {
    const base = await uncappedOn('limit-above-base', () => seededAt('limit-above-base', 1));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await seededAt('limit-above', 1);
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    const count = countFor(first, 1, 1.5);
    const counted = strategy.reportRefusedAsTooLong(count, OVERHEAD);
    const again = await sentUnder(cm, limit);
    assert.equal(again.renderStats!.calibration!.multiplier, 1, 'premise: the store holds the first sample that declares its overhead, so the multiplier stays');
    assert.equal(counted.why, `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)} but within the request limit less the reply's reserve, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the store keeps a rate of ${rateOf(count, first, 1).toFixed(2)} for the request limit.`);
    assert.equal(counted.changed, differs(sent, again), `changed is ${counted.changed}, and the retry ${differs(sent, again) ? 'sends another request' : 'sends the refused one'}`);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: 'The provider refused the request as too long without stating its count, and at the calibration\'s ceiling of 1.80 the refused request still fits the request limit, so either the provider counts it at more than that, or the request limit, or the reply\'s reserve against max_tokens, is above what the provider takes.',
    });
    assert.ok(!differs(again, await sentUnder(cm, limit)), 'and the count-less refusal\'s retry sends the refused request');
    cm.close();
  });

  it('without a request limit, a count that raises the multiplier where the window stays under the picker\'s fold target is no change: the retry sends the refused request', async () => {
    const small = await openManager('no-limit-small', {}, 6);
    const sent = await sentFree(small.cm);
    const a = sent.renderStats!;
    assert.equal(a.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(a.total.tokens * 1.5 < (BUDGET.maxTokens - R) * 0.9, `premise: at 1.5 the window stays under the fold target (${a.total.tokens})`);
    const count = countFor(a, 1, 1.5);
    assert.deepStrictEqual(small.strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(a)}, so the next compile prices the request at a rate of 1.50.`,
    });
    assert.ok(!differs(sent, await sentFree(small.cm)), 'and the retry sends the refused request');
    small.cm.close();
  });

  it('a usage sample that leaves out the request\'s overhead leaves the provider\'s rate as it is', async () => {
    const { cm, strategy, limit } = await bound('undeclared', 1, 1.8);
    await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(strategy.reportRefusedAsTooLong(undefined, OVERHEAD).changed, true, 'premise: the refusal keeps the ceiling as the rate');
    const priced = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    strategy.reportRealInputTokens(Math.round((priced.total.tokens + priced.request!.injectedTokens) * 0.95));
    const next = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(next.calibration!.multiplier, 1, 'premise: the undeclared sample, implying a little under 1, leaves the multiplier inside the dead band');
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, next), 'still priced at 1.80');
    cm.close();
  });

  it('without a request limit, a stated count is an ordinary sample, no provider\'s rate is kept, and a retry is worth it only where the multiplier rose', async () => {
    const fresh = await openManager('no-limit-fresh');
    const aSent = await sentFree(fresh.cm);
    const a = aSent.renderStats!;
    await fresh.cm.compile(BUDGET_ABOVE_LIMIT, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true });
    const countA = countFor(a, 1, 1.5);
    assert.deepStrictEqual(fresh.strategy.reportRefusedAsTooLong(countA, OVERHEAD), {
      changed: true,
      why: `The provider counted ${countA} input tokens, more than the store's price of ${pricedOf(a)}, so the next compile prices the request at a rate of 1.50.`,
    });
    assert.ok(differs(aSent, await sentFree(fresh.cm)), 'its retry sends another request');
    fresh.cm.close();
    const measured = await seededAt('no-limit-measured', 1.2);
    const bSent = await sentFree(measured.cm);
    const b = bSent.renderStats!;
    const countB = countFor(b, 1.2, 1.19);
    assert.deepStrictEqual(measured.strategy.reportRefusedAsTooLong(countB, OVERHEAD), {
      changed: false,
      why: `The provider counted ${countB} input tokens, no more than the store's price of ${pricedOf(b)}, so the compile's budget with its over-budget grace, and what the request sends beside the window, is above what the provider takes.`,
    });
    const cSent = await sentFree(measured.cm);
    assert.ok(!differs(bSent, cSent), 'the retry of a count no more than the price sends the refused request');
    const c = cSent.renderStats!;
    const countC = countFor(c, 1.2, 2.5);
    assert.deepStrictEqual(measured.strategy.reportRefusedAsTooLong(countC, OVERHEAD), {
      changed: false,
      why: `The provider counted ${countC} input tokens, more than the store's price of ${pricedOf(c)}, but this sample doesn't move the multiplier, and without a request limit the store keeps no other rate, so the next compile prices the request as this one did.`,
    });
    assert.ok(!differs(cSent, await sentFree(measured.cm)), 'and so does the retry of a count the multiplier doesn\'t move for');
    const limit = requestTokens(c) - Math.floor(c.total.tokens / 4);
    const limited = await compileUnder(measured.cm, limit);
    assert.equal(limited.calibration!.multiplier, 1.2, 'premise: the multiplier stays');
    assert.equal(limited.request!.allowanceTokens, allowanceAt(limit, 1, limited), 'no provider\'s rate was kept');
    const dSent = await sentFree(measured.cm);
    assert.deepStrictEqual(measured.strategy.reportRefusedAsTooLong(undefined, OVERHEAD), {
      changed: false,
      why: 'The provider refused the request as too long without stating its count, and without a request limit the store keeps no rate to raise for it.',
    });
    assert.ok(!differs(dSent, await sentFree(measured.cm)), 'and the retry of a count-less refusal sends the refused request');
    measured.cm.close();
  });

  it('a count that moves the window past the picker\'s fold target, though not past the budget\'s target, is a change: the retry folds it', async () => {
    const { cm, strategy } = await openManager('fold-target');
    const sent = await sentFree(cm);
    const first = sent.renderStats!;
    const target = BUDGET.maxTokens - R;
    assert.equal(first.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    const rate = target * 0.95 / first.total.tokens;
    assert.ok(rate > 1 && rate < 1.8, `premise: a rate the band takes (${rate})`);
    const count = countFor(first, 1, rate);
    const learned = rateOf(count, first, 1);
    assert.ok(first.total.tokens * learned > target * 0.9 && first.total.tokens * learned <= target,
      `premise: at ${learned} the window is between the fold target and the budget's target (${first.total.tokens * learned})`);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${learned.toFixed(2)}.`,
    });
    assert.ok(differs(sent, await sentFree(cm)), 'and the retry sends another request');
    cm.close();
  });

  it('a count that moves a window sent within grace above the budget\'s target, all of it the newest message, is no change: the retry sends the same message', async () => {
    const { cm, strategy } = await openManager('tail-in-grace', { overBudgetGraceRatio: 0.35 }, 0);
    cm.addMessage('User', [{ type: 'text', text: NEWEST }]);
    const target = SMALL.maxTokens - R;
    const sent = await sentFree(cm, SMALL);
    const first = sent.renderStats!;
    assert.equal(first.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    assert.ok(first.total.tokens > target && first.total.tokens * 1.15 <= target * 1.35,
      `premise: the newest message alone is past the target, and at 1.15 still within grace (${first.total.tokens}, target ${target})`);
    const count = countFor(first, 1, 1.15);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${rateOf(count, first, 1).toFixed(2)}.`,
    });
    assert.ok(!differs(sent, await sentFree(cm, SMALL)), 'and the retry sends the refused request');
    cm.close();
  });

  it('where a retry\'s select would itself refuse, a count is no change, and says the store\'s refusal', async () => {
    const { cm, strategy } = await openManager('retry-refused', { overBudgetGraceRatio: 0.35 }, 0);
    cm.addMessage('User', [{ type: 'text', text: NEWEST }]);
    const target = SMALL.maxTokens - R;
    const sent = await sentFree(cm, SMALL);
    const first = sent.renderStats!;
    assert.ok(first.total.tokens * 1.4 > target * 1.35, `premise: at 1.4 the newest message alone is past grace (${first.total.tokens}, target ${target})`);
    const count = countFor(first, 1, 1.4);
    const answer = strategy.reportRefusedAsTooLong(count, OVERHEAD);
    let refusal = '';
    await assert.rejects(sentFree(cm, SMALL), (e: Error) => {
      refusal = e.message;
      return e.name === 'OverBudgetError';
    });
    assert.deepStrictEqual(answer, {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, so the next compile prices the request at a rate of ${rateOf(count, first, 1).toFixed(2)}. A retry's select now refuses: ${refusal}`,
    });
    cm.close();
  });

  it('a count whose rate leaves the window room under the limit but not for its stubs is a change: the retry makes room for them', async () => {
    const { cm, strategy } = await seededAt('stub-retry', 1, {}, 60, true);
    for (let i = 0; i < 20; i++) {
      cm.addMessage('Claude', [{ type: 'text', text: `Looking ${i}.` }, { type: 'tool_use', id: `o${i}`, name: 'look', input: { at: i } }] as ContentBlock[]);
      cm.addMessage('User', [{ type: 'text', text: `And ${i}?` }]);
    }
    const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: 1_000_000, dryRun: true })).renderStats!;
    const stubs = probe.request!.stubTokens!;
    assert.ok(stubs > 0, 'premise: the repair stubs the unanswered calls');
    const limit = R + Math.max(pricedOf(probe) + stubs, BUDGET.maxTokens - R + besidesOf(probe)) + 20;
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    assert.deepStrictEqual([first.total.tokens, first.request!.stubTokens], [probe.total.tokens, stubs], 'premise: the limit leaves the window as it was, stubs and all');
    const count = countFor(first, 1, (limit - R) / (pricedOf(first) + stubs / 2));
    const learned = rateOf(count, first, 1);
    assert.ok(pricedOf(first) * learned <= limit - R && (pricedOf(first) + stubs) * learned > limit - R,
      'premise: at the rate the count implies, the window and what the request sends beside it fit the limit, but not with the stubs');
    const answer = strategy.reportRefusedAsTooLong(count, OVERHEAD);
    const retry = await sentUnder(cm, limit);
    assert.equal(retry.renderStats!.calibration!.multiplier, 1, 'premise: the count stayed inside the dead band');
    assert.deepStrictEqual(answer, {
      changed: true,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)} but within the request limit less the reply's reserve, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the store keeps a rate of ${learned.toFixed(2)} for the request limit.`,
    });
    assert.ok(differs(sent, retry), 'and the retry sends another request');
    cm.close();
  });

  it('a count-less refusal says the refused request still fits the limit at the ceiling only where it does with its stubs', async () => {
    const { cm, strategy } = await seededAt('stub-countless', 1, {}, 60, true);
    for (let i = 0; i < 20; i++) {
      cm.addMessage('Claude', [{ type: 'text', text: `Looking ${i}.` }, { type: 'tool_use', id: `o${i}`, name: 'look', input: { at: i } }] as ContentBlock[]);
      cm.addMessage('User', [{ type: 'text', text: `And ${i}?` }]);
    }
    const probe = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: 1_000_000, dryRun: true })).renderStats!;
    const stubs = probe.request!.stubTokens!;
    const limit = R + Math.floor(1.8 * (pricedOf(probe) + stubs / 2));
    const first = await compileUnder(cm, limit);
    assert.deepStrictEqual([first.total.tokens, first.request!.stubTokens], [probe.total.tokens, stubs], 'premise: the limit leaves the window as it was, stubs and all');
    assert.ok(pricedOf(first) * 1.8 <= limit - R && (pricedOf(first) + stubs) * 1.8 > limit - R,
      'premise: at the ceiling the window and what the request sends beside it fit the limit, but not with the stubs');
    assert.equal(strategy.reportRefusedAsTooLong(undefined, OVERHEAD).why,
      'The provider refused the request as too long without stating its count, so the next compile prices the request at the calibration\'s ceiling of 1.80.');
    cm.close();
  });

  it('a refusal reads the refused compile\'s own budget and options, whatever the caller does with its objects afterwards', async () => {
    const { cm, strategy, limit } = await bound('caller-objects', 1.2);
    const budget = { ...BUDGET };
    const opts = { requestOverhead: OVERHEAD, requestLimitTokens: limit };
    const sent = await cm.compile(budget, undefined, opts);
    const first = sent.renderStats!;
    assert.notEqual(first.request!.allowanceTokens, undefined, 'premise: the limit binds, so a tighter one changes the select');
    opts.requestLimitTokens = limit - 400;
    budget.maxTokens = R + Math.floor(first.request!.allowanceTokens! / 2);
    const selected = async (b: TokenBudget, requestLimitTokens: number) =>
      (await cm.compile(b, undefined, { requestOverhead: OVERHEAD, requestLimitTokens, dryRun: true })).renderStats!.total.tokens;
    assert.ok(await selected(budget, limit) < first.total.tokens, 'premise: the caller\'s budget, as it is now, selects less');
    assert.ok(await selected(BUDGET, opts.requestLimitTokens) < first.total.tokens, 'premise: and so do its options');
    const count = countFor(first, 1.2, 1.19);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${pricedOf(first)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    const retry = await cm.compile(BUDGET, undefined, { requestOverhead: OVERHEAD, requestLimitTokens: limit });
    assert.ok(!differs(sent, retry), 'and the retry with the compile\'s own budget and options sends the refused request');
    cm.close();
  });

  it('a message added between the compile and its refusal makes the refusal a change, since the retry carries it', async () => {
    const { cm, strategy, limit } = await bound('grown', 1.2);
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    cm.addMessage('User', [{ type: 'text', text: 'And one more thing, while you were busy.' }]);
    const count = countFor(first, 1.2, 1.19);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: true,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${pricedOf(first)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    assert.ok(differs(sent, await sentUnder(cm, limit)), 'and the retry sends another request');
    cm.close();
  });

  for (const [label, stated] of [['a count', 2], ['no count', undefined]] as const) {
    it(`keeps no rate at which what the request sends beside the window leaves it no room under the limit: ${label}`, async () => {
      const twin = await seededAt(`no-room-rate-twin-${label}`, 1);
      const besides = besidesOf((await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
      twin.cm.close();
      const { cm, strategy } = await seededAt(`no-room-rate-${label}`, 1);
      const limit = R + Math.floor(besides * 1.5);
      const sent = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: limit });
      const first = sent.renderStats!;
      const count = stated === undefined ? undefined : countFor(first, 1, stated);
      const leaves = 'what the request sends beside the window leaves it no room under the request limit';
      assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, BIG), {
        changed: false,
        why: count === undefined
          ? `The provider refused the request as too long without stating its count, and at the calibration's ceiling of 1.80 ${leaves}, so the store doesn't keep the ceiling as a rate.`
          : `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, and at the rate of ${rateOf(count, first, 1).toFixed(2)} that it teaches, ${leaves}, so the store learns nothing from it.`,
      });
      const retry = await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: limit });
      assert.ok(!differs(sent, retry), 'and the retry, priced as the refused request was, sends it again rather than refusing itself');
      cm.close();
    });
  }

  async function besidesAt(name: string, multiplier: number, overhead: RequestOverhead) {
    const twin = await seededAt(name, multiplier);
    const stats = (await twin.cm.compile(BUDGET, INJECTIONS, { requestOverhead: overhead, dryRun: true })).renderStats!;
    twin.cm.close();
    return { besides: besidesOf(stats), overheadTokens: stats.request!.overheadTokens };
  }

  const leavesNoRoom = /what the request sends beside the window leaves it no room under the request limit, so the store learns nothing from it\.$/;

  it('a count whose sample would set a multiplier at which what the request sends beside the window leaves it no room teaches nothing, and the store, reopened, still compiles', async () => {
    const { besides } = await besidesAt('sample-no-room-twin', 1, BIG);
    const limit = R + Math.floor(besides * 1.5);
    const opts = { requestOverhead: BIG, requestLimitTokens: limit };
    const { cm, strategy } = await openManager('sample-no-room');
    const sent = await cm.compile(BUDGET, INJECTIONS, opts);
    const first = sent.renderStats!;
    assert.equal(first.calibration!.provisional, true, 'premise: provisional, so a sample in the band would replace the multiplier outright');
    const estimated = cm.getChannelTokenStats();
    const count = countFor(first, 1, 1.75);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, BIG), {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)}, and at the rate of ${rateOf(count, first, 1).toFixed(2)} that it teaches, what the request sends beside the window leaves it no room under the request limit, so the store learns nothing from it.`,
    });
    assert.deepStrictEqual(cm.getChannelTokenStats(), estimated, 'the store estimates its messages as it did');
    const retry = await cm.compile(BUDGET, INJECTIONS, opts);
    assert.ok(!differs(sent, retry), 'the retry sends the refused request rather than refusing itself');
    assert.equal(retry.renderStats!.calibration!.multiplier, 1, 'the multiplier is as it was');
    assert.equal(retry.renderStats!.calibration!.provisional, true, 'and still provisional');
    cm.close();
    const reopened = await openManager('sample-no-room');
    const after = (await reopened.cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(after.calibration!.multiplier, 1, 'reopened, the store holds no multiplier from the refusal');
    reopened.cm.close();
  });

  it('a refusal that would leave the window no room leaves the multiplier\'s average as it was', async () => {
    const { besides } = await besidesAt('average-no-room-twin', 1, BIG);
    const limit = R + Math.floor(besides * 1.5);
    const opts = { requestOverhead: BIG, requestLimitTokens: limit };
    const { cm, strategy, internals } = await seededAt('average-no-room', 1);
    for (let i = 0; i < 2; i++) {
      const stats = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
      strategy.reportRealInputTokens(countFor(stats, 1, 1), BIG);
    }
    const record = (internals.store as unknown as { getStateJson(id: string): { declaredOverhead?: boolean } | null })
      .getStateJson(internals.calibrationStateId);
    assert.equal(record?.declaredOverhead, true, 'premise: two agreeing samples that declare their overhead mark the store, so the next one steps its average');
    const sent = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(sent.calibration!.multiplier, 1, 'premise: at 1');
    const answer = strategy.reportRefusedAsTooLong(countFor(sent, 1, 1.75), BIG);
    assert.match(answer.why, leavesNoRoom);
    const next = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    strategy.reportRealInputTokens(countFor(next, 1, 1), BIG);
    const after = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(after.calibration!.multiplier, 1,
      'a sample at 1 leaves the multiplier at 1: the average the refusal would have stepped to 1.15 is still at 1, so the step stays inside the dead band');
    cm.close();
  });

  it('a refusal that would leave the window no room leaves the multiplier and a held sample as they were', async () => {
    const { besides } = await besidesAt('held-no-room-twin', 1, BIG);
    const limit = R + Math.floor(besides * 1.5);
    const opts = { requestOverhead: BIG, requestLimitTokens: limit };
    const { cm, strategy } = await seededAt('held-no-room', 1);
    const heldFrom = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    strategy.reportRealInputTokens(countFor(heldFrom, 1, 1.1), BIG);
    const sent = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(sent.calibration!.multiplier, 1, 'premise: the first sample that declares its overhead is held, not learned');
    const answer = strategy.reportRefusedAsTooLong(countFor(sent, 1, 1.75), BIG);
    assert.equal(answer.changed, false);
    assert.match(answer.why, leavesNoRoom);
    const next = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(next.calibration!.multiplier, 1, 'the refusal stepped no multiplier');
    strategy.reportRealInputTokens(countFor(next, 1, 1.1), BIG);
    const paired = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.ok(Math.abs(paired.calibration!.multiplier - 1.1) < 0.01,
      `the held sample still pairs with the next one that agrees, and their mean replaces the multiplier: ${paired.calibration!.multiplier}`);
    cm.close();
  });

  it('a select that arms no sample leaves a refusal to the request of the compile that armed one', async () => {
    const { cm, strategy } = await seededAt('unarmed-between', 1);
    const open = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, dryRun: true })).renderStats!;
    const limit = requestTokens(open) * 2;
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    const config = (strategy as unknown as { config: { adaptiveResolution: boolean } }).config;
    config.adaptiveResolution = false;
    const between = await sentUnder(cm, limit);
    config.adaptiveResolution = true;
    assert.notDeepStrictEqual(between.messages, sent.messages, 'premise: the select between, which arms no sample, sends another request');
    const count = countFor(first, 1, 0.99);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(count, OVERHEAD), {
      changed: false,
      why: `The provider counted ${count} input tokens, no more than the store's price of ${pricedOf(first)}, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes.`,
    });
    cm.close();
  });

  it('a usage sample keeps no rate at which what the request sends beside the window leaves it no room under the limit', async () => {
    const { besides } = await besidesAt('usage-no-room-twin', 1, BIG);
    const limit = R + Math.floor(besides * 2.2);
    const opts = { requestOverhead: BIG, requestLimitTokens: limit };
    const { cm, strategy } = await seededAt('usage-no-room', 1);
    await cm.compile(BUDGET, INJECTIONS, opts);
    strategy.reportRefusedAsTooLong(undefined, BIG);
    const priced = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(priced.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, priced), 'premise: the refusal kept the ceiling as the rate');
    strategy.reportRealInputTokens(countFor(priced, 1, 2.5), BIG);
    const next = (await cm.compile(BUDGET, INJECTIONS, opts)).renderStats!;
    assert.equal(next.calibration!.multiplier, 1, 'premise: the band rejected the sample, so the multiplier stays');
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, next), 'and the rate stays at the ceiling');
    cm.close();
  });

  it('decides room by pricing each block at the multiplier a refusal would set, as the compile does', async () => {
    const TINY: RequestOverhead = { ...OVERHEAD, messages: [Array.from({ length: 400 }, () => ({ type: 'text', text: 'ab' }) as ContentBlock)] };
    const at1 = (await besidesAt('tiny-at-1', 1, TINY)).besides;
    const at152 = (await besidesAt('tiny-at-152', 1.52, TINY)).besides;
    assert.ok(at152 - Math.round(at1 * 1.52) >= 100, `premise: rounded per block, 1.52 prices the overhead well past 1.52 times its price at 1 (${at1} at 1, ${at152} at 1.52)`);
    const limit = R + Math.floor((at1 * 1.52 + at152) / 2);
    const opts = { requestOverhead: TINY, requestLimitTokens: limit };
    const { cm, strategy } = await openManager('tiny-rounding');
    const sent = await cm.compile(BUDGET, INJECTIONS, opts);
    assert.equal(sent.renderStats!.calibration!.provisional, true, 'premise: provisional, so the count would set the multiplier outright');
    const answer = strategy.reportRefusedAsTooLong(countFor(sent.renderStats!, 1, 1.52), TINY);
    assert.equal(answer.changed, false);
    assert.match(answer.why, leavesNoRoom);
    assert.ok(!differs(sent, await cm.compile(BUDGET, INJECTIONS, opts)), 'and the retry sends the refused request rather than refusing itself');
    cm.close();
  });

  it('decides room by what the refused compile sends beside the window, not by the overhead its report names', async () => {
    const big = await besidesAt('report-overhead-twin', 1, BIG);
    const small = await besidesAt('report-overhead-small', 1, OVERHEAD);
    const limit = R + Math.floor(big.besides * 1.5);
    const opts = { requestOverhead: BIG, requestLimitTokens: limit };
    const { cm, strategy } = await seededAt('report-overhead', 1);
    const sent = await cm.compile(BUDGET, INJECTIONS, opts);
    const first = sent.renderStats!;
    const reported = first.total.tokens + first.request!.injectedTokens + small.overheadTokens;
    assert.ok(limit - R > reported * 1.7 - first.total.tokens * 1.7, 'premise: priced by the report\'s overhead, the rate would leave the window room');
    const answer = strategy.reportRefusedAsTooLong(Math.round(reported * 1.7), OVERHEAD);
    assert.equal(answer.changed, false);
    assert.match(answer.why, leavesNoRoom);
    const retry = await cm.compile(BUDGET, INJECTIONS, opts);
    assert.ok(!differs(sent, retry), 'and the retry sends the refused request rather than refusing itself');
    assert.equal(retry.renderStats!.request!.allowanceTokens, first.request!.allowanceTokens, 'priced as it was');
    cm.close();
  });

  it('where a retry\'s select would refuse at the plan\'s check, a count is no change, and says that refusal', async () => {
    const base = await uncappedOn('plan-check-base', () => openManager('plan-check-base'));
    const limit = requestTokens(base) * 3;
    const { cm, strategy } = await openManager('plan-check', {}, 60, false, OverstatingStrategy);
    const sent = await sentUnder(cm, limit);
    const first = sent.renderStats!;
    assert.equal(first.calibration!.provisional, true, 'premise: provisional, so the sample sets the multiplier outright');
    (strategy as OverstatingStrategy).overstate = true;
    const count = countFor(first, 1, 1.25);
    const answer = strategy.reportRefusedAsTooLong(count, OVERHEAD);
    await cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: limit, dryRun: true });
    let refusal = '';
    await assert.rejects(sentUnder(cm, limit), (e: Error) => {
      refusal = e.message;
      return e.name === 'OverBudgetError' && e.message.startsWith('Adaptive picker exhausted');
    });
    assert.deepStrictEqual(answer, {
      changed: false,
      why: `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(first)} but within the request limit less the reply's reserve, so the request limit, or the reply's reserve against max_tokens, is above what the provider takes; the sample moves the multiplier to 1.25. A retry's select now refuses: ${refusal}`,
    });
    cm.close();
  });

  it('reports the allowance of the attempt a compile returns: a drop\'s retry that the limit doesn\'t bind reports none', async () => {
    const shape = { overBudgetGraceRatio: 0 };
    const target = BUDGET.maxTokens - R;
    const first = await openManager('drop-allowance', shape, 0);
    first.cm.addMessage('User', [{ type: 'text', text: 'one message, most of the target on its own, '.repeat(Math.floor(target * 0.85 * 2.9 / 44)) }]);
    const besides = besidesOf((await first.cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, dryRun: true })).renderStats!);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.4, at: 1 });
    first.cm.close();
    const { cm } = await openManager('drop-allowance', shape, 0);
    const stats = (await cm.compile(BUDGET, INJECTIONS, { requestOverhead: BIG, requestLimitTokens: R + target + besides + 50 })).renderStats!;
    assert.equal(stats.calibration!.multiplier, 1, 'premise: the limit refused the compile at 1.4, and the store dropped the multiplier to 1 and compiled again');
    assert.equal(stats.request!.allowanceTokens, undefined, 'the retry, which the limit doesn\'t bind, reports no allowance');
    cm.close();
  });

  it('names an own refusal\'s pricing inside its list, so a refusal that names pins still ends with what clears them', async () => {
    const { besides } = await besidesAt('pins-limit-twin', 1, OVERHEAD);
    const { cm } = await seededAt('pins-limit', 1);
    const all = cm.getAllMessages();
    cm.pinRange(all[10]!.id, all[40]!.id, { name: 'a long stretch' });
    await assert.rejects(cm.compile(BUDGET, INJECTIONS, { requestOverhead: OVERHEAD, requestLimitTokens: R + besides + 2_000 }), (e: Error) => {
      assert.equal(e.name, 'OverBudgetError', e.message);
      assert.ok(e.message.includes(', priced at the store\'s multiplier of 1.00)'), e.message);
      assert.ok(e.message.endsWith('whoever sets the hard budget can raise it if the model\'s window allows.'), e.message);
      return true;
    });
    cm.close();
  });

  it('without a request limit, a count that a held sample pairs with to lower the multiplier says the next compile prices at the lower one', async () => {
    const { cm, strategy } = await seededAt('no-limit-lowered', 1);
    const heldFrom = (await sentFree(cm)).renderStats!;
    strategy.reportRealInputTokens(countFor(heldFrom, 1, 0.92), OVERHEAD);
    const sent = (await sentFree(cm)).renderStats!;
    assert.equal(sent.calibration!.multiplier, 1, 'premise: the first sample that declares its overhead is held');
    const count = countFor(sent, 1, 1.01);
    const answer = strategy.reportRefusedAsTooLong(count, OVERHEAD);
    const next = (await sentFree(cm)).renderStats!;
    assert.ok(next.calibration!.multiplier < 1, `premise: the pair's mean lowered the multiplier: ${next.calibration!.multiplier}`);
    assert.equal(answer.why, `The provider counted ${count} input tokens, more than the store's price of ${pricedOf(sent)}, so the next compile prices the request at a rate of ${next.calibration!.multiplier.toFixed(2)}.`);
    cm.close();
  });

  it('a usage sample the calibration\'s band rejects as below it leaves the provider\'s rate as it is', async () => {
    const { cm, strategy, limit } = await bound('rejected-sample', 1, 1.8);
    await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    strategy.reportRefusedAsTooLong(undefined, OVERHEAD);
    const priced = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(priced.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, priced), 'premise: the refusal kept the ceiling as the rate');
    strategy.reportRealInputTokens(countFor(priced, 1, 0.3), OVERHEAD);
    const next = await compileUnder(cm, limit, BUDGET_ABOVE_LIMIT);
    assert.equal(next.calibration!.multiplier, 1, 'premise: the band rejected the sample, so the multiplier stays');
    assert.equal(next.request!.allowanceTokens, allowanceAt(limit, 1 / 1.8, next), 'and the rate stays too');
    cm.close();
  });

  it('an empty window\'s compile takes one sample, its usage report\'s or its refusal\'s, whichever comes first', async () => {
    const { cm, strategy } = await openManager('empty-once', {}, 0);
    await sentFree(cm);
    strategy.reportRealInputTokens(5_000, OVERHEAD);
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(5_000, OVERHEAD), { changed: false, why: NOT_ARMED }, 'a refusal after its usage report');
    await sentFree(cm);
    assert.match(strategy.reportRefusedAsTooLong(5_000, OVERHEAD).why, /^The refused request's window was empty/, 'premise: the first refusal takes the sample');
    assert.deepStrictEqual(strategy.reportRefusedAsTooLong(5_000, OVERHEAD), { changed: false, why: NOT_ARMED }, 'and a second refusal finds none');
    cm.close();
  });
});
