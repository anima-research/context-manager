/**
 * Estimator calibration band: a sample is learned from when EITHER the
 * observed real/est ratio OR the implied raw multiplier is inside the clamp
 * range. Regression for the pinned-ceiling trap: with the multiplier at
 * 1.8 (driven there by a wrong per-class rate) and the rate then fixed,
 * every honest sample reads real/est ≈ 0.56 — out of band on the ratio
 * alone — so the multiplier could never come back down.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'calibration-band-'));
const BUDGET = { maxTokens: 100_000, reserveForResponse: 2_000 };
after(() => rmSync(dir, { recursive: true, force: true }));

type Internals = {
  _calibration: number;
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void; getStateJson(id: string): unknown } | null;
  _lastCompileEstimate: number;
  applyCalibration(): void;
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

describe('estimator calibration band', () => {
  it('a multiplier pinned at the ceiling comes back down once the raw estimate is honest', async () => {
    const { cm, strategy, internals } = await openManager('pinned');
    await cm.compile(BUDGET);
    internals._calibration = 1.8;
    internals.applyCalibration();
    await cm.compile(BUDGET); // arms one sample; estimate is in calibrated units (raw × 1.8)
    const est = internals._lastCompileEstimate;
    assert.ok(est > 0);
    // The provider bills exactly the raw estimate: real/est = 1/1.8 ≈ 0.56.
    strategy.reportRealInputTokens(est / 1.8);
    assert.ok(internals._calibration < 1.8, `multiplier should decay from 1.8, got ${internals._calibration}`);
    assert.ok(internals._calibration > 1.0, `EMA moves gradually, got ${internals._calibration}`);
    cm.close();
  });

  it('a structurally wrong sample is still rejected', async () => {
    const { cm, strategy, internals } = await openManager('wild');
    await cm.compile(BUDGET);
    const est = internals._lastCompileEstimate;
    assert.equal(internals._calibration, 1);
    strategy.reportRealInputTokens(est * 3); // 3× the window: not a window-shaped request
    assert.equal(internals._calibration, 1);
    cm.close();
  });

  it('an in-band ratio is learned from as before', async () => {
    const { cm, strategy, internals } = await openManager('inband');
    await cm.compile(BUDGET);
    const est = internals._lastCompileEstimate;
    strategy.reportRealInputTokens(est * 1.5);
    assert.ok(internals._calibration > 1.0 && internals._calibration < 1.5, `got ${internals._calibration}`);
    cm.close();
  });

  it('a multiplier persisted under an older pricing epoch is discarded on reopen', async () => {
    // The startup wedge: a store that pinned 1.8 under flat-600 thinking
    // pricing reopens estimating ~1.8x its real size; if that is over the
    // hard budget the first compile throws and no sample can ever decay it.
    const first = await openManager('stale-epoch');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.8, at: Date.now() });
    first.cm.close();

    const reopened = await openManager('stale-epoch');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 1);
    reopened.cm.close();
  });

  it('a multiplier learned under the current pricing epoch survives reopen', async () => {
    const first = await openManager('current-epoch');
    await first.cm.compile(BUDGET);
    first.strategy.reportRealInputTokens(first.internals._lastCompileEstimate * 1.5);
    const learned = first.internals._calibration;
    assert.ok(learned > 1);
    const saved = first.internals.store!.getStateJson(first.internals.calibrationStateId) as { pricing?: number };
    assert.equal(saved.pricing, AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH);
    first.cm.close();

    const reopened = await openManager('current-epoch');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, learned);
    reopened.cm.close();
  });
});
