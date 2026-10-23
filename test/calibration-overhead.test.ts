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
    assert.equal(internals._calibration, 1);
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
