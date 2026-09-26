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

  it('the startup wedge: a stale-epoch 1.8 no longer makes the first compile throw', async () => {
    // A store that pinned 1.8 under flat-600 thinking pricing reopens
    // estimating ~1.8x its real size; if that is over the hard budget the
    // first compile throws OverBudgetError, so no inference runs and no sample
    // can ever decay it. Size a budget that fits at 1.0 but not at 1.8.
    // Measure what the hard-budget check counts at 1.0 (the OverBudgetError's
    // `actual`), rather than inferring it from the estimator's own fields.
    // (openManager appends six messages per open, so the probe goes through the
    // same open → close → reopen as the stores under test, to hold the same content.)
    const probeFirst = await openManager('wedge-probe');
    await probeFirst.cm.compile(BUDGET);
    probeFirst.cm.close();
    const probe = await openManager('wedge-probe');
    const reserve = 500;
    const raw = await probe.cm.compile({ maxTokens: reserve + 1, reserveForResponse: reserve }).then(
      () => { throw new Error('probe budget unexpectedly fit'); },
      (e: { actual?: number }) => e.actual!,
    );
    probe.cm.close();
    assert.ok(raw > 0);
    const tight = { maxTokens: Math.ceil(raw * 1.35) + reserve, reserveForResponse: reserve };

    // Control: the SAME budget with a current-epoch 1.8 does throw, so the
    // assertion below can't pass vacuously.
    const control = await openManager('wedge-control');
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, {
      multiplier: 1.8, at: Date.now(), pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH,
    });
    control.cm.close();
    const controlReopened = await openManager('wedge-control');
    await assert.rejects(controlReopened.cm.compile(tight), /budget/i);
    controlReopened.cm.close();

    // The wedge case: an unstamped (epoch 0) 1.8 is discarded and the first
    // compile resolves; the reset is persisted, so a rollback can't reload 1.8.
    const first = await openManager('wedge');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.8, at: Date.now() });
    first.cm.close();
    const reopened = await openManager('wedge');
    await reopened.cm.compile(tight);
    assert.equal(reopened.internals._calibration, 1);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { multiplier?: number; pricing?: number };
    assert.equal(saved.multiplier, 1, 'the reset must be persisted');
    assert.equal(saved.pricing, AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH);
    reopened.cm.close();
  });

  it('a record from a newer pricing epoch is not used, and is left on disk', async () => {
    const first = await openManager('newer-epoch');
    await first.cm.compile(BUDGET);
    const future = { multiplier: 1.4, at: 123, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH + 1 };
    first.internals.store!.setStateJson(first.internals.calibrationStateId, future);
    first.cm.close();

    const reopened = await openManager('newer-epoch');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 1);
    assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), future);
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

  it('a discard is visible in render stats and survives restarts and learning, until re-stamped', async () => {
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    // An unstamped 0.6: e.g. a store on another provider's tokenizer, where
    // the old value was still accurate. The discard must not be silent.
    const first = await openManager('visible');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.6, at: 1 });
    first.cm.close();

    const reopened = await openManager('visible');
    await reopened.cm.compile(BUDGET);
    const cal = reopened.cm.getRenderStats()!.calibration!;
    assert.equal(cal.multiplier, 1);
    assert.equal(cal.pricingEpoch, epoch);
    assert.equal(cal.reset?.discardedMultiplier, 0.6);
    assert.equal(cal.reset?.fromEpoch, 0);
    const resetAt = cal.reset!.at;
    // Learning after the reset keeps the record (it is a fact about this
    // store's history, not about the current value).
    reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 1.5);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { reset?: { at: number } };
    assert.equal(saved.reset?.at, resetAt);
    reopened.cm.close();

    // Still visible after another restart, with no second discard.
    const again = await openManager('visible');
    await again.cm.compile(BUDGET);
    assert.equal(again.cm.getRenderStats()!.calibration!.reset?.at, resetAt);
    // An operator re-stamp (the old value, checked against provider billing)
    // clears it.
    again.internals.store!.setStateJson(again.internals.calibrationStateId, { multiplier: 0.6, at: Date.now(), pricing: epoch });
    again.cm.close();
    const restamped = await openManager('visible');
    await restamped.cm.compile(BUDGET);
    const after = restamped.cm.getRenderStats()!.calibration!;
    assert.equal(after.multiplier, 0.6);
    assert.equal(after.reset, undefined);
    restamped.cm.close();
  });

  it('a store with no calibration history reports its multiplier and no reset', async () => {
    const { cm } = await openManager('no-history');
    await cm.compile(BUDGET);
    assert.deepEqual(cm.getRenderStats()!.calibration, { multiplier: 1, pricingEpoch: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    cm.close();
  });
});
