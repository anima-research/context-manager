/**
 * Estimator calibration against what the request carries besides the window
 * (#323). The provider counts the system prompt and the tool schemas; the
 * compile estimate holds neither. Unless the caller declares them, the
 * multiplier learns that fixed overhead as a per-token rate, and at 1.00 a
 * store whose true ratio is above the band can never learn at all.
 *
 * The synthetic provider here counts `k × (window + overhead)` in the store's
 * own estimate units: an estimator whose per-class rates are right up to the
 * residual `k`, which is what the multiplier is for.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, MockAdapter, NativeFormatter, type ContentBlock, type ToolDefinition } from '@animalabs/membrane';
import type { ContextInjection } from '../src/types/index.js';
import type { RequestOverhead } from '../src/index.js';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StoredMessage } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'calibration-overhead-'));
const BUDGET = { maxTokens: 100_000, reserveForResponse: 2_000 };
after(() => rmSync(dir, { recursive: true, force: true }));

type Internals = {
  _calibration: number;
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void; getStateJson(id: string): unknown } | null;
  _lastCompileEstimate: number;
  _calibrationProvisional: { fromEpoch: number | null } | null;
};

async function openManager(name: string) {
  const membrane = new Membrane(new MockAdapter({}), { formatter: new NativeFormatter() });
  const strategy = new AutobiographicalStrategy({
    targetChunkTokens: 5_000,
    recentWindowTokens: 50_000,
    compressionModel: 'mock',
    adaptiveResolution: true, // the calibration sample is armed on the adaptive (folding) path only
  });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane });
  for (let i = 0; i < 6; i++) {
    cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `turn ${i} ${'lorem ipsum '.repeat(120)}` }]);
  }
  return { cm, strategy, internals: strategy as unknown as Internals };
}

const SYSTEM = `You are a resident. ${'Be precise. '.repeat(40)}`;

/** Tool schemas of about `tokens` estimated tokens in all. */
function toolsOf(tokens: number): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (let i = 0; i * 500 < tokens; i++) {
    tools.push({
      name: `server__tool_${i}`,
      description: 'Does one thing on the server. '.repeat(55),
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id.' } }, required: ['id'] },
    });
  }
  return tools;
}

/** The store's price of the overhead, at its current multiplier: the system
 *  prompt and the tools as sent, the way a compression request prices them. */
function overheadPrice(cm: ContextManager, system: string | undefined, tools: ToolDefinition[]): number {
  const content: ContentBlock[] = [
    ...(system ? [{ type: 'text' as const, text: system }] : []),
    ...(tools.length > 0 ? [{ type: 'text' as const, text: JSON.stringify(tools) }] : []),
  ];
  return content.length > 0
    ? (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore.estimateTokens({ content } as unknown as StoredMessage)
    : 0;
}

describe('estimator calibration and request overhead (#323)', () => {
  it('declared overhead is priced into the sample: a provider at the estimator\'s rate leaves the multiplier at 1', async () => {
    const { cm, strategy, internals } = await openManager('declared-k1');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const tools = toolsOf(window / 2);
    const overhead = overheadPrice(cm, SYSTEM, tools);
    assert.ok(overhead > window * 0.4 && overhead < window * 0.7, `overhead ${overhead} vs window ${window}`);
    // Undeclared, this sample reads real/est ≈ 1.5: in band, so it would be
    // learned as a per-token rate 50% above the truth.
    strategy.reportRealInputTokens(window + overhead, { system: SYSTEM, tools });
    await cm.compile(BUDGET);
    strategy.reportRealInputTokens(internals._lastCompileEstimate + overhead, { system: SYSTEM, tools });
    assert.equal(internals._calibration, 1, 'neither sample moves it from 1: the first confirms the provisional 1 of a store with no record, and the second is an EMA step');
    cm.close();
  });

  it('closed loop: with overhead declared the multiplier converges to the per-token rate', async () => {
    const { cm, strategy, internals } = await openManager('closed-loop');
    await cm.compile(BUDGET);
    const tools = toolsOf(internals._lastCompileEstimate / 2);
    const rawOverhead = overheadPrice(cm, SYSTEM, tools); // at 1.00
    const k = 1.3;
    for (let i = 0; i < 25; i++) {
      const m = internals._calibration;
      const rawWindow = internals._lastCompileEstimate / m;
      strategy.reportRealInputTokens(k * (rawWindow + rawOverhead), { system: SYSTEM, tools });
      await cm.compile(BUDGET);
    }
    assert.ok(Math.abs(internals._calibration - k) / k <= 0.04, `converged to ${internals._calibration}, want ${k}`);
    cm.close();
  });

  it('a ceiling seed on a tool-heavy store relearns the per-token rate in one sample', async () => {
    // The operator's band-aid for the trap: seed 1.8 as provisional. With
    // overhead larger than the window and a true rate of 1, an undeclared
    // sample reads real/est ≈ 2.1 / 1.8 ≈ 1.17, implied 2.1: accepted, and
    // clamped straight back to 1.8, so the seed sticks and folds the window.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const first = await openManager('seeded');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.8, at: 1, pricing: epoch, provisional: true });
    first.cm.close();
    const { cm, strategy, internals } = await openManager('seeded');
    await cm.compile(BUDGET);
    assert.equal(internals._calibration, 1.8);
    const rawWindow = internals._lastCompileEstimate / 1.8;
    const tools = toolsOf(rawWindow * 1.1);
    const rawOverhead = overheadPrice(cm, SYSTEM, tools) / 1.8;
    strategy.reportRealInputTokens(rawWindow + rawOverhead, { system: SYSTEM, tools });
    assert.ok(Math.abs(internals._calibration - 1) <= 0.02, `got ${internals._calibration}`);
    cm.close();
  });

  it('consistent out-of-band samples are learned at the clamp once the caller declares its overhead', async () => {
    const { cm, strategy, internals } = await openManager('trap');
    await cm.compile(BUDGET);
    // real/est ≈ 2.1 at 1.00: out of band on the ratio and on the implied
    // multiplier, which are the same number at 1.00.
    for (const [i, ratio] of [2.1, 2.08, 2.1].entries()) {
      assert.equal(internals._calibration, 1, `sample ${i} must not be learned yet`);
      strategy.reportRealInputTokens(internals._lastCompileEstimate * ratio, {});
      await cm.compile(BUDGET);
    }
    assert.equal(internals._calibration, 1.8, 'the third consistent sample is learned, at the ceiling');
    cm.close();
  });

  it('undeclared out-of-band samples are still rejected, however consistent', async () => {
    const { cm, strategy, internals } = await openManager('undeclared');
    await cm.compile(BUDGET);
    for (let i = 0; i < 5; i++) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 2.1);
      await cm.compile(BUDGET);
    }
    assert.equal(internals._calibration, 1);
    cm.close();
  });

  it('inconsistent out-of-band samples are not learned', async () => {
    const { cm, strategy, internals } = await openManager('inconsistent');
    await cm.compile(BUDGET);
    for (const ratio of [2.1, 3.5, 2.1, 5, 0.3, 2.1]) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * ratio, {});
      await cm.compile(BUDGET);
    }
    assert.equal(internals._calibration, 1);
    cm.close();
  });

  it('an in-band sample ends a run of out-of-band ones', async () => {
    const { cm, strategy, internals } = await openManager('interrupted');
    await cm.compile(BUDGET);
    for (const ratio of [2.1, 2.1, 1.0, 2.1, 2.1]) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * ratio, {});
      await cm.compile(BUDGET);
    }
    assert.equal(internals._calibration, 1);
    cm.close();
  });

  it('a provisional multiplier stays provisional through a re-stamp', async () => {
    // A discard's provisional 1 under an older epoch, in a store holding
    // nothing repriced since: kept and re-stamped, and still a guess, so the
    // first sample replaces it outright instead of stepping toward it.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const reset = { discardedMultiplier: 1.8, fromEpoch: epoch - 2, at: 3 };
    const first = await openManager('restamp-provisional');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId,
      { multiplier: 1, at: 4, pricing: epoch - 1, reset, provisional: true });
    first.cm.close();
    const { cm, strategy, internals } = await openManager('restamp-provisional');
    await cm.compile(BUDGET);
    const saved = internals.store!.getStateJson(internals.calibrationStateId) as { pricing?: number; provisional?: boolean };
    assert.equal(saved.pricing, epoch, 're-stamped');
    assert.equal(saved.provisional, true, 'the re-stamp keeps the record provisional');
    assert.ok(internals._calibrationProvisional, 'and the load treats it as provisional');
    strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.3);
    assert.ok(Math.abs(internals._calibration - 1.3) <= 0.01, `replaced outright, got ${internals._calibration}`);
    cm.close();
  });
});

function priceOf(cm: ContextManager, content: ContentBlock[]): number {
  return (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore.estimateTokens({ content } as unknown as StoredMessage);
}

function injectionOf(position: 'beforeUser' | 'afterUser' | 'system', tokens: number): ContextInjection {
  return { namespace: 'probe', position, content: [{ type: 'text', text: 'Retrieved knowledge. '.repeat(Math.ceil(tokens / 4)) }] };
}

type DeclaredInternals = Internals & { _calibrationDeclared: boolean; _calibrationArmed: boolean };
const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;

async function seeded(name: string, record: Record<string, unknown>) {
  const first = await openManager(name);
  await first.cm.compile(BUDGET);
  first.internals.store!.setStateJson(first.internals.calibrationStateId, record);
  first.cm.close();
  const opened = await openManager(name);
  await opened.cm.compile(BUDGET);
  return { ...opened, internals: opened.internals as DeclaredInternals };
}

async function sampleAt(cm: ContextManager, strategy: AutobiographicalStrategy, internals: Internals, impliedMultiplier: number, declared: boolean): Promise<void> {
  await cm.compile(BUDGET);
  const m = internals._calibration;
  const tools = toolsOf(internals._lastCompileEstimate / m / 2);
  const rawWindow = internals._lastCompileEstimate / m;
  const rawOverhead = overheadPrice(cm, SYSTEM, tools) / m;
  strategy.reportRealInputTokens(impliedMultiplier * (rawWindow + (declared ? rawOverhead : 0)), declared ? { system: SYSTEM, tools } : undefined);
}

const declaredOf = (internals: Internals) =>
  (internals.store!.getStateJson(internals.calibrationStateId) as { declaredOverhead?: boolean } | null)?.declaredOverhead;

describe('estimator calibration: what the compile adds among the messages', () => {
  async function twoSamples(name: string, injection: (window: number) => ContextInjection) {
    const { cm, strategy, internals } = await openManager(name);
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const inj = injection(window);
    const tools = toolsOf(window / 2);
    for (let i = 0; i < 2; i++) {
      await cm.compile(BUDGET, [inj]);
      assert.equal(internals._lastCompileEstimate, window, 'the window estimate leaves the injection out');
      strategy.reportRealInputTokens(window + overheadPrice(cm, SYSTEM, tools) + priceOf(cm, inj.content), { system: SYSTEM, tools });
    }
    return { cm, internals, window, inj };
  }

  it('a message-position injection is priced into the sample: in band, it is not learned as a per-token rate', async () => {
    const { cm, internals, window, inj } = await twoSamples('injected-in-band', (w) => injectionOf('afterUser', w / 2));
    assert.ok(priceOf(cm, inj.content) > window * 0.4,
      `premise: priced as the window and the declared head alone, these samples would read about 1.33; injection ${priceOf(cm, inj.content)} vs window ${window}`);
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });

  it('a large injection on a small window is not learned at the clamp', async () => {
    const { cm, strategy, internals } = await openManager('injected-out-of-band');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const injection = injectionOf('beforeUser', window * 3);
    const tools = toolsOf(window / 2);
    for (let i = 0; i < 4; i++) {
      await cm.compile(BUDGET, [injection]);
      strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, SYSTEM, tools) + priceOf(cm, injection.content), { system: SYSTEM, tools });
    }
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken in band');
    cm.close();
  });

  it('a dry compile between the compile and its sample leaves the compile\'s injection priced', async () => {
    const { cm, strategy, internals } = await openManager('injected-dry');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const injection = injectionOf('afterUser', window / 2);
    const tools = toolsOf(window / 2);
    for (let i = 0; i < 2; i++) {
      await cm.compile(BUDGET, [injection]);
      await cm.compile(BUDGET, undefined, { dryRun: true });
      strategy.reportRealInputTokens(window + overheadPrice(cm, SYSTEM, tools) + priceOf(cm, injection.content), { system: SYSTEM, tools });
    }
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });

  it('a compile without injections prices none, after one with', async () => {
    const { cm, strategy, internals } = await openManager('injected-then-none');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const injection = injectionOf('afterUser', window / 2);
    const tools = toolsOf(window / 2);
    await cm.compile(BUDGET, [injection]);
    strategy.reportRealInputTokens(window + overheadPrice(cm, SYSTEM, tools) + priceOf(cm, injection.content), { system: SYSTEM, tools });
    await cm.compile(BUDGET);
    strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, SYSTEM, tools), { system: SYSTEM, tools });
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });

  it('a system-position injection is priced once, as part of the declared system prompt', async () => {
    const { cm, strategy, internals } = await openManager('injected-system');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const injection = injectionOf('system', window / 2);
    const tools = toolsOf(window / 2);
    for (let i = 0; i < 2; i++) {
      const result = await cm.compile(BUDGET, [injection]);
      const system = `${SYSTEM}\n${result.systemInjections.map((b) => (b as { text: string }).text).join('\n')}`;
      strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, system, tools), { system, tools });
    }
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });

  it('a dry compile with injections leaves the committing compile\'s count', async () => {
    const { cm, strategy, internals } = await openManager('dry-with-injections');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const tools = toolsOf(window / 2);
    for (let i = 0; i < 2; i++) {
      await cm.compile(BUDGET);
      await cm.compile(BUDGET, [injectionOf('afterUser', window / 2)], { dryRun: true });
      strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, SYSTEM, tools), { system: SYSTEM, tools });
    }
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });

  it('several message-position injections are each priced', async () => {
    const { cm, strategy, internals } = await openManager('two-injections');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const injections = [injectionOf('beforeUser', window / 4), injectionOf('afterUser', window / 4)];
    const tools = toolsOf(window / 2);
    for (let i = 0; i < 2; i++) {
      await cm.compile(BUDGET, injections);
      const injected = injections.reduce((sum, inj) => sum + priceOf(cm, inj.content), 0);
      strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, SYSTEM, tools) + injected, { system: SYSTEM, tools });
    }
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });

  it('an injection is priced at the multiplier in force, as the window is', async () => {
    const { cm, strategy, internals } = await seeded('injected-calibrated', { multiplier: 1.5, at: 1, pricing: epoch, declaredOverhead: true });
    assert.equal(internals._calibration, 1.5);
    const tools = toolsOf(internals._lastCompileEstimate / 2);
    const injection = injectionOf('afterUser', internals._lastCompileEstimate / 2);
    await cm.compile(BUDGET, [injection]);
    strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, SYSTEM, tools) + priceOf(cm, injection.content), { system: SYSTEM, tools });
    assert.equal(internals._calibration, 1.5);
    assert.equal((internals as unknown as { _calibrationEma: number | null })._calibrationEma, 1.5, 'the sample was taken');
    cm.close();
  });

  it('an undeclared sample counts the injections too', async () => {
    const { cm, strategy, internals } = await openManager('injected-undeclared');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const injection = injectionOf('afterUser', window / 2);
    await cm.compile(BUDGET, [injection]);
    strategy.reportRealInputTokens(window + priceOf(cm, injection.content));
    assert.equal(internals._calibration, 1);
    assert.equal((internals as unknown as { _calibrationEma: number | null })._calibrationEma, 1, 'the sample was taken');
    cm.close();
  });

  it('a system prompt alone is priced into the sample', async () => {
    const { cm, strategy, internals } = await openManager('system-only');
    await cm.compile(BUDGET);
    const window = internals._lastCompileEstimate;
    const system = `You are a resident. ${'Keep to your purpose. '.repeat(Math.ceil(window / 14))}`;
    const share = overheadPrice(cm, system, []) / window;
    assert.ok(share > 0.25 && share < 0.7, `premise: left out, the samples would read 1.25 to 1.7, in band; the system prompt is ${share} of the window`);
    for (let i = 0; i < 2; i++) {
      await cm.compile(BUDGET);
      strategy.reportRealInputTokens(internals._lastCompileEstimate + overheadPrice(cm, system, []), { system });
    }
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true, 'the samples were taken');
    cm.close();
  });
});

describe('estimator calibration: consistent out-of-band runs', () => {
  async function oob(cm: ContextManager, strategy: AutobiographicalStrategy, internals: Internals, ratio: number, declared = true) {
    await cm.compile(BUDGET);
    const nothingBesides: RequestOverhead = {};
    strategy.reportRealInputTokens(internals._lastCompileEstimate * ratio, declared ? nothingBesides : undefined);
  }

  it('a consistent run on a learned record without the flag is learned at the clamp, not held', async () => {
    const { cm, strategy, internals } = await seeded('run-on-learned', { multiplier: 1, at: 1, pricing: epoch });
    assert.equal(internals._calibrationProvisional, null, 'learned');
    for (let i = 0; i < 3; i++) await oob(cm, strategy, internals, 2.1);
    assert.equal(internals._calibration, 1.8);
    assert.equal(declaredOf(internals), true);
    cm.close();
  });

  it('an undeclared out-of-band sample ends a declared run', async () => {
    const { cm, strategy, internals } = await openManager('undeclared-ends-run');
    await oob(cm, strategy, internals, 2.1);
    await oob(cm, strategy, internals, 2.1);
    await oob(cm, strategy, internals, 2.1, false);
    await oob(cm, strategy, internals, 2.1);
    assert.equal(internals._calibration, 1);
    await oob(cm, strategy, internals, 2.1);
    await oob(cm, strategy, internals, 2.1);
    assert.equal(internals._calibration, 1.8, 'a fresh run of three is learned');
    cm.close();
  });

  it('a run agrees with its first sample: within 10% it is learned, and a drift past 10% of the first is not', async () => {
    const drift = await openManager('run-drift');
    for (const ratio of [2.0, 2.18, 2.38]) await oob(drift.cm, drift.strategy, drift.internals, ratio);
    assert.equal(drift.internals._calibration, 1, 'each within 10% of the one before, the third 19% past the first');
    drift.cm.close();
    const near = await openManager('run-near');
    for (const ratio of [2.0, 2.18, 2.08]) await oob(near.cm, near.strategy, near.internals, ratio);
    assert.equal(near.internals._calibration, 1.8, 'each within 10% of the first');
    near.cm.close();
  });

  it('a consistent run below the band is learned at the floor', async () => {
    const { cm, strategy, internals } = await openManager('run-low');
    for (let i = 0; i < 3; i++) await oob(cm, strategy, internals, 0.3);
    assert.equal(internals._calibration, 0.6);
    cm.close();
  });

  it('one compile counts once toward a run, however many reports follow it', async () => {
    const { cm, strategy, internals } = await openManager('run-one-arm');
    await cm.compile(BUDGET);
    for (let i = 0; i < 3; i++) strategy.reportRealInputTokens(internals._lastCompileEstimate * 2.1, {});
    assert.equal(internals._calibration, 1, 'three reports of one compile');
    await oob(cm, strategy, internals, 2.1);
    assert.equal(internals._calibration, 1, 'the second compile is the run\'s second sample');
    await oob(cm, strategy, internals, 2.1);
    assert.equal(internals._calibration, 1.8, 'the third compile is its third');
    cm.close();
  });

  it('a branch switch starts a run afresh', async () => {
    const { cm, strategy, internals } = await openManager('run-branch');
    await oob(cm, strategy, internals, 2.1);
    await oob(cm, strategy, internals, 2.1);
    await cm.fork('other');
    await oob(cm, strategy, internals, 2.1);
    assert.equal(internals._calibration, 1);
    assert.equal((internals as unknown as { _outOfBandRun: { count: number } | null })._outOfBandRun?.count, 1, 'the sample on the new branch starts a run');
    cm.close();
  });
});

describe('estimator calibration: a store that learned the overhead as a rate', () => {
  it('two declared samples that agree replace a multiplier learned without them, by their mean', async () => {
    const { cm, strategy, internals } = await seeded('learned-undeclared', { multiplier: 1.8, at: 1, pricing: epoch });
    assert.equal(internals._calibration, 1.8);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.equal(internals._calibration, 1.8, 'the first is held');
    assert.equal(declaredOf(internals), undefined);
    await sampleAt(cm, strategy, internals, 1.04, true);
    assert.ok(Math.abs(internals._calibration - 1.02) <= 0.01, `replaced by the mean, got ${internals._calibration}`);
    assert.equal(declaredOf(internals), true, 'and the record says its samples declare their overhead');
    cm.close();
  });

  it('two declared samples that disagree step by the EMA, and mark the record declared', async () => {
    const { cm, strategy, internals } = await seeded('learned-disagree', { multiplier: 1.8, at: 1, pricing: epoch });
    await sampleAt(cm, strategy, internals, 1, true);
    await sampleAt(cm, strategy, internals, 1.5, true);
    assert.ok(Math.abs(internals._calibration - 1.74) <= 0.01, `stepped toward the second, got ${internals._calibration}`);
    assert.equal(declaredOf(internals), true);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1.592) <= 0.01, `then steps by the EMA, got ${internals._calibration}`);
    cm.close();
  });

  it('a branch switch between the two loses the held sample', async () => {
    const { cm, strategy, internals } = await seeded('held-branch', { multiplier: 1.8, at: 1, pricing: epoch });
    await sampleAt(cm, strategy, internals, 1, true);
    await cm.fork('other');
    await cm.compile(BUDGET);
    assert.equal(internals._calibration, 1.8, 'the fork has the record');
    await sampleAt(cm, strategy, internals, 1, true);
    assert.equal(internals._calibration, 1.8, 'held, not paired with the other branch\'s sample');
    assert.notEqual((internals as unknown as { _declaredCandidate: number | null })._declaredCandidate, null, 'and held afresh');
    cm.close();
  });

  it('an undeclared sample between the two leaves the held sample, and the pair still replaces', async () => {
    const { cm, strategy, internals } = await seeded('held-undeclared', { multiplier: 1.8, at: 1, pricing: epoch });
    await sampleAt(cm, strategy, internals, 1, true);
    assert.equal(internals._calibration, 1.8, 'the first is held');
    await sampleAt(cm, strategy, internals, 1, false);
    assert.ok(Math.abs(internals._calibration - 1.64) <= 0.01, `the undeclared sample steps, got ${internals._calibration}`);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1) <= 0.01, `paired with the held sample and replaced, got ${internals._calibration}`);
    assert.equal(declaredOf(internals), true);
    cm.close();
  });

  it('a consistent run between the two ends the held sample', async () => {
    const { cm, strategy, internals } = await seeded('held-run', { multiplier: 1, at: 1, pricing: epoch });
    await sampleAt(cm, strategy, internals, 1, true);
    for (let i = 0; i < 3; i++) {
      await cm.compile(BUDGET);
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 2.1, {});
    }
    assert.equal(internals._calibration, 1.8, 'the run is learned');
    await sampleAt(cm, strategy, internals, 1.5, false);
    assert.ok(Math.abs(internals._calibration - 1.74) <= 0.01, `an undeclared sample steps and unmarks, got ${internals._calibration}`);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1.74) <= 0.01, `held, not paired with the sample from before the run, got ${internals._calibration}`);
    cm.close();
  });

  it('a restart between the two loses the held sample: it starts over, and the record is not marked', async () => {
    const first = await seeded('held-restart', { multiplier: 1.8, at: 1, pricing: epoch });
    await sampleAt(first.cm, first.strategy, first.internals, 1, true);
    first.cm.close();
    const { cm, strategy, internals } = await openManager('held-restart');
    await cm.compile(BUDGET);
    const typed = internals as DeclaredInternals;
    assert.deepEqual([internals._calibration, typed._calibrationDeclared, declaredOf(internals)], [1.8, false, undefined]);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.equal(internals._calibration, 1.8, 'held again');
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1) <= 0.02, `then replaced, got ${internals._calibration}`);
    cm.close();
  });

  it('a multiplier learned from declared samples steps by the EMA', async () => {
    const { cm, strategy, internals } = await seeded('learned-declared', { multiplier: 1.8, at: 1, pricing: epoch, declaredOverhead: true });
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1.64) <= 0.01, `stepped, got ${internals._calibration}`);
    cm.close();
  });

  it('after the replacement, a restart steps by the EMA', async () => {
    const first = await seeded('declared-restart', { multiplier: 1.8, at: 1, pricing: epoch });
    await sampleAt(first.cm, first.strategy, first.internals, 1, true);
    await sampleAt(first.cm, first.strategy, first.internals, 1, true);
    first.cm.close();
    const { cm, strategy, internals } = await openManager('declared-restart');
    await cm.compile(BUDGET);
    await sampleAt(cm, strategy, internals, 1.3, true);
    assert.ok(Math.abs(internals._calibration - 1.06) <= 0.01, `stepped, got ${internals._calibration}`);
    cm.close();
  });

  it('an undeclared sample that moves the multiplier unmarks the record, and the next two declared replace it', async () => {
    const { cm, strategy, internals } = await seeded('undeclared-after-declared', { multiplier: 1, at: 1, pricing: epoch, declaredOverhead: true });
    await sampleAt(cm, strategy, internals, 1.5, false);
    assert.ok(internals._calibration > 1.05, `the undeclared sample stepped, got ${internals._calibration}`);
    assert.equal(declaredOf(internals), undefined);
    await sampleAt(cm, strategy, internals, 1, true);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1) <= 0.02, `replaced, got ${internals._calibration}`);
    cm.close();
  });

  it('two declared samples that confirm the multiplier mark the record declared', async () => {
    const { cm, strategy, internals } = await seeded('confirmed-declared', { multiplier: 1, at: 1, pricing: epoch });
    await sampleAt(cm, strategy, internals, 1, true);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.equal(internals._calibration, 1);
    assert.equal(declaredOf(internals), true);
    await sampleAt(cm, strategy, internals, 1.5, true);
    assert.ok(Math.abs(internals._calibration - 1.1) <= 0.01, `stepped, got ${internals._calibration}`);
    cm.close();
  });

  it('a store with no record is set by its first declared sample, with nothing held, and marked declared', async () => {
    const { cm, strategy, internals } = await openManager('fresh-declared');
    await cm.compile(BUDGET);
    assert.deepEqual(internals._calibrationProvisional, { fromEpoch: null });
    await sampleAt(cm, strategy, internals as DeclaredInternals, 1.4, true);
    assert.ok(Math.abs(internals._calibration - 1.4) <= 0.01, `set by one sample, got ${internals._calibration}`);
    assert.equal((internals as unknown as { _declaredCandidate: number | null })._declaredCandidate, null, 'nothing held');
    assert.equal(declaredOf(internals), true);
    cm.close();
  });

  it('a provisional multiplier is replaced by one declared sample, and marked declared', async () => {
    const { cm, strategy, internals } = await seeded('provisional-declared', { multiplier: 1, at: 1, pricing: epoch, provisional: true });
    await sampleAt(cm, strategy, internals, 1.4, true);
    assert.ok(Math.abs(internals._calibration - 1.4) <= 0.01, `replaced, not stepped, got ${internals._calibration}`);
    assert.equal(internals._calibrationProvisional, null);
    assert.equal(declaredOf(internals), true);
    cm.close();
  });

  it('a dry compile after the load keeps a record\'s declared overhead', async () => {
    const { cm, strategy, internals } = await seeded('declared-dry', { multiplier: 1.8, at: 1, pricing: epoch, declaredOverhead: true });
    await cm.compile(BUDGET, undefined, { dryRun: true });
    assert.equal(internals._calibrationDeclared, true);
    await sampleAt(cm, strategy, internals, 1, true);
    assert.ok(Math.abs(internals._calibration - 1.64) <= 0.01, `stepped, not held, got ${internals._calibration}`);
    cm.close();
  });

  it('an undeclared sample inside the dead band leaves a record marked, and a rejected declared one leaves it unmarked', async () => {
    const marked = await seeded('deadband-undeclared', { multiplier: 1, at: 1, pricing: epoch, declaredOverhead: true });
    await sampleAt(marked.cm, marked.strategy, marked.internals, 1.01, false);
    const ema = (marked.internals as unknown as { _calibrationEma: number | null })._calibrationEma;
    assert.ok(ema !== null && Math.abs(ema - 1.002) < 0.001, `premise: the sample reached the EMA, got ${ema}`);
    assert.deepStrictEqual([marked.internals._calibration, marked.internals._calibrationDeclared, declaredOf(marked.internals)], [1, true, true]);
    marked.cm.close();
    const unmarked = await seeded('rejected-declared', { multiplier: 1, at: 1, pricing: epoch });
    await unmarked.cm.compile(BUDGET);
    unmarked.strategy.reportRealInputTokens(unmarked.internals._lastCompileEstimate * 2.1, {});
    assert.equal((unmarked.internals as unknown as { _outOfBandRun: { count: number } | null })._outOfBandRun?.count, 1, 'premise: the sample was rejected as the start of a run');
    assert.deepStrictEqual([unmarked.internals._calibration, unmarked.internals._calibrationDeclared, declaredOf(unmarked.internals)], [1, false, undefined]);
    unmarked.cm.close();
  });

  it('any overhead a JS caller passes but null or undefined counts as declared, in the run as in the mark', async () => {
    const { cm, strategy, internals } = await seeded('falsy-overhead', { multiplier: 1, at: 1, pricing: epoch });
    for (let i = 0; i < 3; i++) {
      await cm.compile(BUDGET);
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 2.1, 0 as unknown as RequestOverhead);
    }
    assert.equal(internals._calibration, 1.8, 'learned as a declared run');
    assert.equal(declaredOf(internals), true);
    cm.close();
  });

  it('a null overhead from a JS caller counts as undeclared', async () => {
    const { cm, strategy, internals } = await seeded('null-overhead', { multiplier: 1, at: 1, pricing: epoch });
    await cm.compile(BUDGET);
    strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.5, null as unknown as RequestOverhead);
    assert.ok(Math.abs(internals._calibration - 1.1) <= 0.01, `stepped as undeclared, not held, got ${internals._calibration}`);
    assert.deepEqual([internals._calibrationDeclared, declaredOf(internals)], [false, undefined]);
    cm.close();
  });

  it('a re-stamp keeps a record\'s declared overhead', async () => {
    const { cm, internals } = await seeded('restamp-declared', { multiplier: 1.2, at: 1, pricing: epoch - 1, declaredOverhead: true });
    const saved = internals.store!.getStateJson(internals.calibrationStateId) as { pricing?: number; declaredOverhead?: boolean };
    assert.equal(saved.pricing, epoch, 're-stamped');
    assert.equal(saved.declaredOverhead, true);
    assert.equal(internals._calibrationDeclared, true);
    cm.close();
  });
});
