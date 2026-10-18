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
  _calibrationProvisional: { fromEpoch: number | null } | null;
  applyCalibration(): void;
};

/** A budget the store fits under at 1.0 and `factor` times the hard-budget
 *  check's count, but not above: for a multiplier the load should drop. */
async function tightBudget(name: string, factor: number, opts: { signedThinking?: boolean } = {}) {
  // openManager appends six messages per open, so the probe goes through the
  // same open → close → reopen as the stores under test, to hold the same content.
  const probeFirst = await openManager(name, opts);
  await probeFirst.cm.compile(BUDGET);
  probeFirst.cm.close();
  const probe = await openManager(name, opts);
  const reserve = 500;
  // Measure what the hard-budget check counts at 1.0 (the OverBudgetError's
  // `actual`), rather than inferring it from the estimator's own fields.
  const raw = await probe.cm.compile({ maxTokens: reserve + 1, reserveForResponse: reserve }).then(
    () => { throw new Error('probe budget unexpectedly fit'); },
    (e: { actual?: number }) => e.actual!,
  );
  probe.cm.close();
  assert.ok(raw > 0);
  return { maxTokens: Math.ceil(raw * factor) + reserve, reserveForResponse: reserve };
}

/** Collects `[estimator-calibration]` warnings while `fn` runs. */
async function calibrationWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, lines: warned.filter((l) => l.includes('[estimator-calibration]')) };
  } finally {
    console.warn = warn;
  }
}

/** Anthropic keep-all signed thinking: the content pricing epoch 1 repriced. */
const SIGNED_THINKING = { type: 'thinking', thinking: '', signature: 'sig'.repeat(110) } as const;

async function openManager(name: string, opts: { signedThinking?: boolean; stampedThinking?: boolean; generatedImage?: boolean; nestedGeneratedImage?: boolean; recentWindowTokens?: number } = {}) {
  const membrane = new Membrane(new MockAdapter({}), { formatter: new NativeFormatter() });
  const strategy = new AutobiographicalStrategy({
    targetChunkTokens: 5_000,
    recentWindowTokens: opts.recentWindowTokens ?? 50_000,
    compressionModel: 'mock',
    adaptiveResolution: true, // the calibration sample is armed on the adaptive (folding) path only
  });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane });
  for (let i = 0; i < 6; i++) {
    cm.addMessage(i % 2 ? 'Claude' : 'User', [
      ...(i % 2 && opts.signedThinking ? [SIGNED_THINKING as never] : []),
      // As agent-framework stamps it from usage (src/thinking-token-stamp.ts).
      ...(i % 2 && opts.stampedThinking ? [{ ...SIGNED_THINKING, tokenEstimate: 900 } as never] : []),
      // Priced at 0 before pricing epoch 3, and as an image since.
      ...(i % 2 && opts.generatedImage ? [{ type: 'generated_image', data: 'C'.repeat(64), mimeType: 'image/png' } as never] : []),
      // A tool's generated image, nested in its result.
      ...(i === 3 && opts.nestedGeneratedImage
        ? [{ type: 'tool_result', toolUseId: 't-gen', content: [{ type: 'generated_image', data: 'C'.repeat(64), mimeType: 'image/png' }] } as never]
        : []),
      { type: 'text', text: `turn ${i} ${'lorem ipsum '.repeat(120)}` },
    ]);
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
    const ST = { signedThinking: true };
    const probeFirst = await openManager('wedge-probe', ST);
    await probeFirst.cm.compile(BUDGET);
    probeFirst.cm.close();
    const probe = await openManager('wedge-probe', ST);
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
    const control = await openManager('wedge-control', ST);
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, {
      multiplier: 1.8, at: Date.now(), pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH,
    });
    control.cm.close();
    const controlReopened = await openManager('wedge-control', ST);
    await assert.rejects(controlReopened.cm.compile(tight), /budget/i);
    controlReopened.cm.close();

    // The wedge case: an epoch-0 1.8 is discarded and the first compile
    // resolves; the reset is persisted, so a rollback can't reload 1.8.
    const first = await openManager('wedge', ST);
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.8, at: Date.now(), pricing: 0 });
    first.cm.close();
    const reopened = await openManager('wedge', ST);
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

    // It gets no warning either: the discard warning's re-stamp advice would
    // overwrite the record the load means to keep.
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      const reopened = await openManager('newer-epoch');
      await reopened.cm.compile(BUDGET);
      assert.equal(reopened.internals._calibration, 1);
      assert.deepEqual(reopened.cm.getRenderStats()!.calibration,
        { multiplier: 1, pricingEpoch: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH }, 'no reset either');
      assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), future);
      reopened.cm.close();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(warned.filter((l) => l.includes('[estimator-calibration]')), []);
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
    // An epoch-0 0.6, where the old value may still have been accurate. The
    // discard must not be silent.
    const first = await openManager('visible', { signedThinking: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.6, at: 1, pricing: 0 });
    first.cm.close();

    const reopened = await openManager('visible', { signedThinking: true });
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
    const again = await openManager('visible', { signedThinking: true });
    await again.cm.compile(BUDGET);
    assert.equal(again.cm.getRenderStats()!.calibration!.reset?.at, resetAt);
    // An operator re-stamp (the old value, checked against provider billing)
    // clears it.
    again.internals.store!.setStateJson(again.internals.calibrationStateId, { multiplier: 0.6, at: Date.now(), pricing: epoch });
    again.cm.close();
    const restamped = await openManager('visible', { signedThinking: true });
    await restamped.cm.compile(BUDGET);
    const after = restamped.cm.getRenderStats()!.calibration!;
    assert.equal(after.multiplier, 0.6);
    assert.equal(after.reset, undefined);
    restamped.cm.close();
  });

  it('an older multiplier is kept and re-stamped when nothing in the store was repriced', async () => {
    // A store with no signed thinking (e.g. a resident on another provider's
    // tokenizer): no epoch since 0 changed anything it holds, so its 0.6
    // still holds.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const first = await openManager('kept');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.6, at: 1, pricing: 0 });
    first.cm.close();
    const reopened = await openManager('kept');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 0.6);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.6, pricingEpoch: epoch });
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { multiplier?: number; pricing?: number };
    assert.equal(saved.multiplier, 0.6);
    assert.equal(saved.pricing, epoch, 're-stamped under the current epoch');
    reopened.cm.close();

    // Control: the same record in a store holding signed thinking is discarded.
    const signed = await openManager('kept-control', { signedThinking: true });
    await signed.cm.compile(BUDGET);
    signed.internals.store!.setStateJson(signed.internals.calibrationStateId, { multiplier: 0.6, at: 1, pricing: 0 });
    signed.cm.close();
    const signedReopened = await openManager('kept-control', { signedThinking: true });
    await signedReopened.cm.compile(BUDGET);
    assert.equal(signedReopened.internals._calibration, 1);
    assert.equal(signedReopened.cm.getRenderStats()!.calibration!.reset?.discardedMultiplier, 0.6);
    signedReopened.cm.close();
  });

  it('an epoch-2 multiplier is discarded in a store holding a generated image, and kept in one without', async () => {
    // Epoch 3 priced generated images as images, where they had cost 0: the
    // residual learned under epoch 2 absorbed those images' real tokens.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const generated = await openManager('epoch3-generated', { generatedImage: true });
    await generated.cm.compile(BUDGET);
    generated.internals.store!.setStateJson(generated.internals.calibrationStateId, { multiplier: 1.4, at: 1, pricing: 2 });
    generated.cm.close();
    const generatedReopened = await openManager('epoch3-generated', { generatedImage: true });
    await generatedReopened.cm.compile(BUDGET);
    const cal = generatedReopened.cm.getRenderStats()!.calibration!;
    assert.equal(cal.multiplier, 1, 'restarts from 1');
    assert.equal(cal.reset?.discardedMultiplier, 1.4);
    assert.equal(cal.reset?.fromEpoch, 2);
    generatedReopened.cm.close();

    const plain = await openManager('epoch3-plain');
    await plain.cm.compile(BUDGET);
    plain.internals.store!.setStateJson(plain.internals.calibrationStateId, { multiplier: 1.4, at: 1, pricing: 2 });
    plain.cm.close();
    const plainReopened = await openManager('epoch3-plain');
    await plainReopened.cm.compile(BUDGET);
    assert.equal(plainReopened.internals._calibration, 1.4, 'nothing this store holds was repriced');
    const saved = plainReopened.internals.store!.getStateJson(plainReopened.internals.calibrationStateId) as { pricing?: number };
    assert.equal(saved.pricing, epoch, 're-stamped under the current epoch');
    plainReopened.cm.close();
  });

  it('a generated image nested in a tool result reprices the store too', async () => {
    const nested = await openManager('epoch3-nested', { nestedGeneratedImage: true });
    await nested.cm.compile(BUDGET);
    nested.internals.store!.setStateJson(nested.internals.calibrationStateId, { multiplier: 1.4, at: 1, pricing: 2 });
    nested.cm.close();
    const reopened = await openManager('epoch3-nested', { nestedGeneratedImage: true });
    await reopened.cm.compile(BUDGET);
    const cal = reopened.cm.getRenderStats()!.calibration!;
    assert.equal(cal.multiplier, 1, 'restarts from 1');
    assert.equal(cal.reset?.discardedMultiplier, 1.4);
    reopened.cm.close();
  });

  it('a record with no stamp is discarded in a store whose only repriced content is a generated image', async () => {
    const first = await openManager('unstamped-generated', { generatedImage: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.3, at: 1 });
    first.cm.close();
    const reopened = await openManager('unstamped-generated', { generatedImage: true });
    await reopened.cm.compile(BUDGET);
    const cal = reopened.cm.getRenderStats()!.calibration!;
    assert.deepEqual([cal.multiplier, cal.provisional, cal.reset?.discardedMultiplier, cal.reset?.fromEpoch], [1, true, 1.3, null]);
    reopened.cm.close();
  });

  it("a previous epoch's provisional 1 stays provisional when it's kept and re-stamped", async () => {
    // A discard under epoch 2 persisted its restart as provisional; no
    // sample confirmed it before the upgrade, in a store epoch 3 didn't reprice.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const reset = { discardedMultiplier: 0.6, fromEpoch: 1, at: 5 };
    const first = await openManager('provisional-kept');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1, at: 1, pricing: 2, reset, provisional: true });
    first.cm.close();
    const reopened = await openManager('provisional-kept');
    await reopened.cm.compile(BUDGET);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 1, pricingEpoch: epoch, provisional: true, reset });
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { pricing?: number; provisional?: boolean };
    assert.deepEqual([saved.pricing, saved.provisional], [epoch, true], 're-stamped, still provisional');
    reopened.cm.close();
  });

  it("a previous epoch's provisional 1 is kept in a store epoch 3 repriced, not discarded again over its reset", async () => {
    // As 0.15.0 persists a discard under epoch 2: the restart's 1, flagged
    // provisional, beside the reset that records what it replaced. The store
    // holds a generated image, which epoch 3 repriced, but a 1 no sample has
    // confirmed holds nothing learned under epoch 2's pricing.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const reset = { discardedMultiplier: 1.45, fromEpoch: 1, at: 5 };
    const first = await openManager('provisional-generated', { generatedImage: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1, at: 1, pricing: 2, reset, provisional: true });
    first.cm.close();
    const reopened = await openManager('provisional-generated', { generatedImage: true });
    const { lines } = await calibrationWarnings(() => reopened.cm.compile(BUDGET));
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 1, pricingEpoch: epoch, provisional: true, reset });
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { pricing?: number; provisional?: boolean; reset?: unknown };
    assert.deepEqual([saved.pricing, saved.provisional, saved.reset], [epoch, true, reset], 're-stamped, still provisional, its reset kept');
    assert.deepEqual(lines, [
      `[estimator-calibration] kept the provisional multiplier 1.00 from pricing epoch 2 (current ${epoch}): ` +
        `a restart that no provider sample has confirmed holds nothing learned under that epoch's pricing, so ` +
        `this store's content repriced since doesn't discard it; re-stamped, still provisional`,
    ]);
    reopened.cm.close();
  });

  it('an epoch-1 multiplier is discarded in a store whose only content repriced since is a generated image', async () => {
    // The reprice check walks every epoch after the record's: epoch 2 repriced
    // nothing this store holds, and epoch 3 repriced its generated images.
    const first = await openManager('epoch1-generated', { generatedImage: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.4, at: 1, pricing: 1 });
    first.cm.close();
    const reopened = await openManager('epoch1-generated', { generatedImage: true });
    await reopened.cm.compile(BUDGET);
    const cal = reopened.cm.getRenderStats()!.calibration!;
    assert.deepEqual([cal.multiplier, cal.provisional, cal.reset?.discardedMultiplier, cal.reset?.fromEpoch], [1, true, 1.4, 1]);
    reopened.cm.close();
  });

  it('a store with no calibration history reports its multiplier and no reset', async () => {
    const { cm } = await openManager('no-history');
    await cm.compile(BUDGET);
    assert.deepEqual(cm.getRenderStats()!.calibration, { multiplier: 1, pricingEpoch: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    cm.close();
  });

  it('a record without a stamp is kept as provisional, and stamped by the first sample, not the load', async () => {
    // 0.11.0 to 0.13.0 learned under epoch 1's pricing and wrote no stamp, and
    // so did every release before 0.11.0 (#179); the record can't say which.
    // Counting it as epoch 0 would reset an honest multiplier, and one below 1
    // the most: this store fits at 0.94 and is refused at 1. Counting it as
    // epoch 1 and re-stamping it made a stale one look learned under this
    // pricing. It is kept, as provisional, until a sample confirms it.
    const ST = { signedThinking: true };
    const probeFirst = await openManager('unstamped-probe', ST);
    await probeFirst.cm.compile(BUDGET);
    probeFirst.cm.close();
    const probe = await openManager('unstamped-probe', ST);
    const reserve = 500;
    const raw = await probe.cm.compile({ maxTokens: reserve + 1, reserveForResponse: reserve }).then(
      () => { throw new Error('probe budget unexpectedly fit'); },
      (e: { actual?: number }) => e.actual!,
    );
    probe.cm.close();
    const tight = { maxTokens: Math.floor(raw * 0.97) + reserve, reserveForResponse: reserve };
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;

    // Control: the same 0.94 stamped as epoch 0 is discarded, and the same
    // budget refuses the compile, so the case below can't pass vacuously.
    const control = await openManager('unstamped-control', ST);
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, { multiplier: 0.94, at: Date.now(), pricing: 0 });
    control.cm.close();
    const controlReopened = await openManager('unstamped-control', ST);
    await assert.rejects(controlReopened.cm.compile(tight), (e: Error) => e.name === 'OverBudgetError');
    assert.equal(controlReopened.internals._calibration, 1, 'the control was refused because its 0.94 was discarded');
    controlReopened.cm.close();

    // The record as 0.13.0's learner writes it (and every release before): no stamp.
    const first = await openManager('unstamped', ST);
    await first.cm.compile(BUDGET);
    const unstamped = { multiplier: 0.94, at: Date.now() };
    first.internals.store!.setStateJson(first.internals.calibrationStateId, unstamped);
    first.cm.close();
    const reopened = await openManager('unstamped', ST);
    const { lines } = await calibrationWarnings(() => reopened.cm.compile(tight));
    assert.equal(reopened.internals._calibration, 0.94);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.94, pricingEpoch: epoch, provisional: true });
    assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), unstamped,
      'the load writes nothing: the stamp is the first sample\'s to give');
    assert.equal(lines.length, 1, 'the load says once that the multiplier is provisional');
    assert.match(lines[0], /provisional/);
    // A sample within the dead band confirms it: no repricing, but the stamp
    // is written, and the multiplier is no longer provisional.
    reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 1.01);
    assert.equal(reopened.internals._calibration, 0.94);
    const stampedRecord = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
      { multiplier?: number; pricing?: number; reset?: unknown };
    assert.deepEqual([stampedRecord.multiplier, stampedRecord.pricing, stampedRecord.reset], [0.94, epoch, undefined]);
    await reopened.cm.compile(tight);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.94, pricingEpoch: epoch });
    reopened.cm.close();
    // The next open finds a current-epoch record: no warning, nothing provisional.
    const again = await openManager('unstamped', ST);
    const second = await calibrationWarnings(() => again.cm.compile(BUDGET));
    assert.deepEqual(second.lines, []);
    assert.deepEqual(again.cm.getRenderStats()!.calibration, { multiplier: 0.94, pricingEpoch: epoch });
    again.cm.close();
  });

  it('a record without a stamp pinned at a clamp edge is discarded at load', async () => {
    // #179: five stores last learned before 0.11.0 came to 0.14.0 with a 1.8
    // pinned under the flat signed-thinking price, and no stamp. A residual
    // pinned at the clamp corrected rates that were off by more than the clamp
    // allows, and says nothing about this release's: it is not kept, whatever
    // the store holds. The same budget that fit at 1.0 (and would be refused
    // at 1.8, the wedge of store B) compiles.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const tight = await tightBudget('pinned-probe', 1.35);
    for (const [multiplier, edge] of [[1.8, 'ceiling'], [0.6, 'floor']] as const) {
      const name = `pinned-${edge}`;
      const first = await openManager(name); // no signed thinking, no carriers: nothing the reprice table asks about
      await first.cm.compile(BUDGET);
      first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier, at: Date.now() });
      first.cm.close();
      const reopened = await openManager(name);
      const { lines } = await calibrationWarnings(() => reopened.cm.compile(multiplier > 1 ? tight : BUDGET));
      assert.equal(reopened.internals._calibration, 1, `${edge}: discarded`);
      const cal = reopened.cm.getRenderStats()!.calibration!;
      assert.deepEqual([cal.provisional, cal.reset?.discardedMultiplier, cal.reset?.fromEpoch], [true, multiplier, null], edge);
      const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: { discardedMultiplier: number; fromEpoch: number | null } };
      assert.deepEqual([saved.multiplier, saved.pricing, saved.reset?.discardedMultiplier, saved.reset?.fromEpoch],
        [1, epoch, multiplier, null], `${edge}: the discard is persisted`);
      assert.equal(lines.length, 1, edge);
      assert.match(lines[0], new RegExp(`DISCARDED multiplier ${multiplier.toFixed(2)} .*pinned at the ${edge}`), edge);
      reopened.cm.close();
    }
    // Control: the same 1.8 stamped under the current epoch is applied as it
    // is, so the discard above is the unstamped record's, not the value's.
    const control = await openManager('pinned-control');
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, { multiplier: 1.8, at: Date.now(), pricing: epoch });
    control.cm.close();
    const controlReopened = await openManager('pinned-control');
    await assert.rejects(controlReopened.cm.compile(tight), (e: Error) => e.name === 'OverBudgetError');
    assert.equal(controlReopened.internals._calibration, 1.8);
    controlReopened.cm.close();
  });

  it('a provisional multiplier is replaced outright by the first sample the band accepts', async () => {
    // Store E of #179: an unstamped 1.45, not pinned, nothing repriced held,
    // 2.2x over once applied to this release's rates. Kept as provisional, it
    // prices one compile; the first sample then sets it, where the EMA would
    // have stepped a fifth of the way and taken about ten applied steps.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const first = await openManager('snap');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.45, at: Date.now() });
    first.cm.close();
    const reopened = await openManager('snap');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 1.45);
    assert.equal(reopened.cm.getRenderStats()!.calibration!.provisional, true);
    // The provider bills 0.9x the raw estimate: real/est = 0.9/1.45 ≈ 0.62, in band.
    const est = reopened.internals._lastCompileEstimate;
    reopened.strategy.reportRealInputTokens((est / 1.45) * 0.9);
    assert.ok(Math.abs(reopened.internals._calibration - 0.9) < 1e-9, `replaced outright, got ${reopened.internals._calibration}`);
    assert.equal(reopened.internals._calibrationProvisional, null);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
      { multiplier?: number; pricing?: number; reset?: unknown };
    assert.deepEqual([saved.multiplier, saved.pricing, saved.reset], [0.9, epoch, undefined], 'stamped, no reset: nothing was discarded');
    // From here the EMA steps as it always did.
    await reopened.cm.compile(BUDGET);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.9, pricingEpoch: epoch });
    reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 1.2); // observed 1.08
    assert.ok(reopened.internals._calibration > 0.9 && reopened.internals._calibration < 1.0,
      `stepped, not replaced: ${reopened.internals._calibration}`);
    reopened.cm.close();

    // A sample the band rejects is no evidence: the multiplier stays provisional.
    const wild = await openManager('snap-wild');
    await wild.cm.compile(BUDGET);
    wild.internals.store!.setStateJson(wild.internals.calibrationStateId, { multiplier: 1.45, at: Date.now() });
    wild.cm.close();
    const wildReopened = await openManager('snap-wild');
    await wildReopened.cm.compile(BUDGET);
    wildReopened.strategy.reportRealInputTokens(wildReopened.internals._lastCompileEstimate * 3);
    assert.equal(wildReopened.internals._calibration, 1.45);
    assert.deepEqual(wildReopened.internals._calibrationProvisional, { fromEpoch: null });
    wildReopened.cm.close();
  });

  it('a provisional multiplier above 1 that puts the compile over budget is dropped to 1, and the compile resolves', async () => {
    // Store B of #179: the compile is refused before any inference, so no
    // sample could ever correct the multiplier. Dropping a provisional one to
    // 1 and selecting again turns the crash loop into a working start.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const tight = await tightBudget('fallback-probe', 1.2); // fits at 1.0, not at 1.45

    // Control: the same 1.45 stamped under the current epoch is refused, as it
    // was learned here and says what fits.
    const control = await openManager('fallback-control');
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, { multiplier: 1.45, at: Date.now(), pricing: epoch });
    control.cm.close();
    const controlReopened = await openManager('fallback-control');
    await assert.rejects(controlReopened.cm.compile(tight), (e: Error) => e.name === 'OverBudgetError');
    assert.equal(controlReopened.internals._calibration, 1.45);
    controlReopened.cm.close();

    const first = await openManager('fallback');
    await first.cm.compile(BUDGET);
    const unstamped = { multiplier: 1.45, at: Date.now() };
    first.internals.store!.setStateJson(first.internals.calibrationStateId, unstamped);
    first.cm.close();
    const reopened = await openManager('fallback');
    // A preview at that budget resolves as the real compile will, by the
    // dropped multiplier, and writes and logs nothing.
    const dry = await calibrationWarnings(async () => reopened.cm.previewContext(tight, undefined, { render: true })!);
    assert.equal(dry.result.stats!.calibration!.multiplier, 1, 'the preview priced by the dropped multiplier');
    assert.equal(dry.result.stats!.calibration!.reset?.discardedMultiplier, 1.45);
    assert.deepEqual(dry.lines, []);
    assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), unstamped);
    assert.equal(reopened.internals._calibration, 1, 'put back: nothing loaded yet');
    assert.equal(reopened.internals._calibrationProvisional, null);
    // The real compile: refused at 1.45, dropped, resolved at 1; the drop is
    // logged and persisted, and visible as the reset.
    const { lines } = await calibrationWarnings(() => reopened.cm.compile(tight));
    assert.equal(reopened.internals._calibration, 1);
    const cal = reopened.cm.getRenderStats()!.calibration!;
    assert.deepEqual([cal.multiplier, cal.provisional, cal.reset?.discardedMultiplier, cal.reset?.fromEpoch], [1, true, 1.45, null]);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
      { multiplier?: number; pricing?: number; reset?: { discardedMultiplier: number; fromEpoch: number | null } };
    assert.deepEqual([saved.multiplier, saved.pricing, saved.reset?.discardedMultiplier, saved.reset?.fromEpoch], [1, epoch, 1.45, null]);
    assert.equal(lines.length, 2, `the provisional keep, then the drop: ${lines.join(' | ')}`);
    assert.match(lines[1], /DISCARDED provisional multiplier 1\.45 .*refused/);
    // The 1 is provisional: the first sample sets the multiplier.
    reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 1.1);
    assert.ok(Math.abs(reopened.internals._calibration - 1.1) < 1e-9, `set by the sample, got ${reopened.internals._calibration}`);
    reopened.cm.close();
    // A restart finds the persisted discard: no second drop, no warning. (The
    // reopen appended six more messages, so the tight budget is not for it.)
    const again = await openManager('fallback');
    const second = await calibrationWarnings(() => again.cm.compile(BUDGET));
    assert.deepEqual(second.lines, []);
    assert.equal(again.cm.getRenderStats()!.calibration!.reset?.discardedMultiplier, 1.45);
    again.cm.close();

    // A provisional multiplier at or below 1 is never raised: lowering
    // estimates is the only direction a drop can help, so the refusal stands.
    const below = await openManager('fallback-below');
    await below.cm.compile(BUDGET);
    below.internals.store!.setStateJson(below.internals.calibrationStateId, { multiplier: 0.94, at: Date.now() });
    below.cm.close();
    const belowReopened = await openManager('fallback-below');
    const refused = { maxTokens: Math.floor((tight.maxTokens - tight.reserveForResponse) * 0.7) + tight.reserveForResponse, reserveForResponse: tight.reserveForResponse };
    await assert.rejects(belowReopened.cm.compile(refused), (e: Error) => e.name === 'OverBudgetError');
    assert.equal(belowReopened.internals._calibration, 0.94);
    assert.deepEqual(belowReopened.internals._calibrationProvisional, { fromEpoch: null }, 'still provisional, nothing discarded');
    const untouched = belowReopened.internals.store!.getStateJson(belowReopened.internals.calibrationStateId) as
      { multiplier?: number; pricing?: number; reset?: unknown };
    assert.deepEqual([untouched.multiplier, untouched.pricing, untouched.reset], [0.94, undefined, undefined], 'the record is untouched');
    belowReopened.cm.close();
  });

  it('a discard\'s provisional 1 survives a restart until a sample confirms it', async () => {
    // Both discard writers (the load's and the drop's) persist the 1 as
    // provisional; a reopen before the first sample must not read it as
    // learned, or that sample would step a fifth of the way (0.7 -> 0.94).
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const tight = await tightBudget('reopen-probe', 1.2);
    const cases = [
      { name: 'reopen-load-discard', record: { multiplier: 0.6, at: 1, pricing: 0 }, signedThinking: true, budget: BUDGET, fromEpoch: 0 },
      { name: 'reopen-drop', record: { multiplier: 1.45, at: 1 }, signedThinking: false, budget: tight, fromEpoch: null },
    ] as const;
    for (const c of cases) {
      const first = await openManager(c.name, { signedThinking: c.signedThinking });
      await first.cm.compile(BUDGET);
      first.internals.store!.setStateJson(first.internals.calibrationStateId, c.record);
      first.cm.close();
      const discarding = await openManager(c.name, { signedThinking: c.signedThinking });
      await discarding.cm.compile(c.budget);
      assert.equal(discarding.internals._calibration, 1, c.name);
      const saved = discarding.internals.store!.getStateJson(discarding.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; provisional?: boolean; reset?: { fromEpoch: number | null } };
      assert.deepEqual([saved.multiplier, saved.pricing, saved.provisional, saved.reset?.fromEpoch], [1, epoch, true, c.fromEpoch],
        `${c.name}: the discard is persisted as provisional`);
      discarding.cm.close(); // no sample: the host restarted first
      const reopened = await openManager(c.name, { signedThinking: c.signedThinking });
      const { lines } = await calibrationWarnings(() => reopened.cm.compile(BUDGET));
      assert.deepEqual(lines, [], `${c.name}: nothing to say on a reopen`);
      assert.deepEqual(reopened.internals._calibrationProvisional, { fromEpoch: c.fromEpoch }, `${c.name}: still a guess`);
      const cal = reopened.cm.getRenderStats()!.calibration!;
      assert.deepEqual([cal.multiplier, cal.provisional, cal.reset?.discardedMultiplier], [1, true, c.record.multiplier], c.name);
      reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 0.7);
      assert.ok(Math.abs(reopened.internals._calibration - 0.7) < 1e-9, `${c.name}: set by the sample, got ${reopened.internals._calibration}`);
      const confirmed = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; provisional?: boolean; reset?: unknown };
      assert.deepEqual([confirmed.multiplier, confirmed.pricing, confirmed.provisional, confirmed.reset !== undefined],
        [0.7, epoch, undefined, true], `${c.name}: the sample's write drops the flag and keeps the reset`);
      reopened.cm.close();
      const learned = await openManager(c.name, { signedThinking: c.signedThinking });
      await learned.cm.compile(BUDGET);
      assert.equal(learned.internals._calibrationProvisional, null, `${c.name}: learned now`);
      learned.cm.close();
    }
  });

  it('a preview takes the fallback at the picker\'s refusal too, not only at head/tail', async () => {
    // The picker's over-budget throw is dry-run-guarded (a preview reports
    // `fits: false` instead), so a preview under a provisional 1.45 said the
    // window doesn't fit where the real compile drops to 1 and fits. Store B's
    // signature ("Adaptive picker exhausted ...") is this path. It needs the
    // picker over and the emitter under: a sharded body of prose followed by
    // JSON is planned shard by shard (the JSON shards at the dense rate) and
    // emitted as one joined text, priced by its first 2000 chars (prose). A
    // small recent window keeps the body in the middle, where no summary
    // exists yet to fold it.
    const BODY = `${'the quick brown fox jumps over the lazy dog and keeps running. '.repeat(45)}` +
      JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, key: `k_${i}`, value: [i, i * 2, i * 3], flag: i % 2 === 0 })));
    const openSharded = async (name: string, seed: boolean) => {
      const membrane = new Membrane(new MockAdapter({}), { formatter: new NativeFormatter() });
      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 1_000, headWindowTokens: 0, recentWindowTokens: 1_000,
        compressionModel: 'mock', adaptiveResolution: true,
      });
      const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane });
      if (seed) {
        cm.addMessage('User', [{ type: 'text', text: BODY }]);
        cm.addMessage('Claude', [{ type: 'text', text: 'Noted. '.repeat(40) }]);
        cm.addMessage('User', [{ type: 'text', text: 'Thanks. '.repeat(40) }]);
      }
      return { cm, strategy, internals: strategy as unknown as Internals };
    };
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const reserve = 500;

    // Size the budget from the store: the plan at 1.0 (P) and what the
    // emitter commits at 1.0 (E). The rejection budget must take P (fits at
    // 1.0) and 1.45·E (emission under at 1.45) but not 1.45·P (the picker
    // refuses at 1.45).
    const probe = await openSharded('picker-probe', true);
    assert.ok(probe.cm.getAllMessages().filter((m) => m.bodyGroupId).length >= 3, 'the body is sharded');
    const P = probe.cm.previewContext(BUDGET)!.finalTokens;
    await probe.cm.compile(BUDGET);
    const E = probe.cm.getRenderStats()!.planVsActual!.actual;
    probe.cm.close();
    assert.ok(P > E * 1.1, `the fixture plans over what it emits: plan ${P}, emitted ${E}`);
    const rejection = Math.ceil(Math.max(P, 1.45 * E) * 1.02);
    assert.ok(rejection < 1.45 * P, `the picker refuses at 1.45: budget ${rejection}, plan ${Math.ceil(1.45 * P)}`);
    const tight = { maxTokens: rejection + reserve, reserveForResponse: reserve };

    // Control: a current-epoch 1.45 is refused by the picker, not at head/tail
    // or emission, and its preview reports that.
    const control = await openSharded('picker-control', true);
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, { multiplier: 1.45, at: Date.now(), pricing: epoch });
    control.cm.close();
    const controlReopened = await openSharded('picker-control', false);
    assert.equal(controlReopened.cm.previewContext(tight)!.fits, false);
    await assert.rejects(controlReopened.cm.compile(tight), /Adaptive picker exhausted/);
    controlReopened.cm.close();

    const first = await openSharded('picker', true);
    await first.cm.compile(BUDGET);
    const unstamped = { multiplier: 1.45, at: Date.now() };
    first.internals.store!.setStateJson(first.internals.calibrationStateId, unstamped);
    first.cm.close();
    const reopened = await openSharded('picker', false);
    const dry = await calibrationWarnings(async () => reopened.cm.previewContext(tight, undefined, { render: true })!);
    assert.equal(dry.result.fits, true, 'the preview says what the real compile will do');
    assert.deepEqual([dry.result.stats!.calibration!.multiplier, dry.result.stats!.calibration!.reset?.discardedMultiplier], [1, 1.45]);
    assert.deepEqual(dry.lines, []);
    assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), unstamped, 'a preview writes nothing');
    assert.equal(reopened.internals._calibration, 1, 'put back');
    await reopened.cm.compile(tight);
    assert.equal(reopened.internals._calibration, 1);
    assert.equal(reopened.cm.getRenderStats()!.calibration!.reset?.discardedMultiplier, 1.45);
    reopened.cm.close();

    // A preview whose retry at 1 is still over budget reports that, as before.
    const over = { maxTokens: Math.floor(P * 0.8) + reserve, reserveForResponse: reserve };
    const stillOver = await openSharded('picker-over', true);
    await stillOver.cm.compile(BUDGET);
    stillOver.internals.store!.setStateJson(stillOver.internals.calibrationStateId, unstamped);
    stillOver.cm.close();
    const stillOverReopened = await openSharded('picker-over', false);
    const overPreview = stillOverReopened.cm.previewContext(over)!;
    assert.equal(overPreview.fits, false);
    assert.ok(overPreview.finalTokens < P * 1.1, `reported at the dropped multiplier: ${overPreview.finalTokens} vs ${P} at 1.0`);
    stillOverReopened.cm.close();
  });

  it('the 1 a discard restarts from is provisional: one sample sets it', async () => {
    // A stamped epoch-0 0.6 in a store holding unstamped signed thinking is
    // discarded as before; the first sample then sets the multiplier instead
    // of stepping a fifth of the way toward it.
    const first = await openManager('discard-snap', { signedThinking: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.6, at: 1, pricing: 0 });
    first.cm.close();
    const reopened = await openManager('discard-snap', { signedThinking: true });
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 1);
    assert.deepEqual(reopened.internals._calibrationProvisional, { fromEpoch: 0 });
    assert.equal(reopened.cm.getRenderStats()!.calibration!.provisional, true);
    reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 0.7);
    assert.ok(Math.abs(reopened.internals._calibration - 0.7) < 1e-9, `set by the sample, got ${reopened.internals._calibration}`);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
      { multiplier?: number; reset?: { discardedMultiplier: number } };
    assert.deepEqual([saved.multiplier, saved.reset?.discardedMultiplier], [0.7, 0.6], 'the reset stays with the record');
    reopened.cm.close();
  });

  it('epoch 2: a store holding XML-history carriers discards a multiplier from before it', async () => {
    // tool_attempt and tool_notice estimated as 0 before epoch 2, so a
    // multiplier learned beside them absorbed their cost. (Without carriers
    // an unstamped record is kept as provisional: the case above.)
    const carriers = [
      { type: 'tool_attempt', rawXml: `<invoke name="search">${'q'.repeat(400)}</invoke>` },
      { type: 'tool_notice', notices: [{ invoke: 'search', toolName: 'search', kind: 'refused', message: 'no such tool '.repeat(30) }] },
    ];
    for (const carrier of carriers) {
      const name = `carrier-${carrier.type}`;
      const first = await openManager(name);
      first.cm.addMessage('Claude', [carrier as never, { type: 'text', text: 'and then' }]);
      await first.cm.compile(BUDGET);
      first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.3, at: 1 });
      first.cm.close();
      const reopened = await openManager(name);
      await reopened.cm.compile(BUDGET);
      assert.equal(reopened.internals._calibration, 1, `${carrier.type}: discarded`);
      assert.equal(reopened.cm.getRenderStats()!.calibration!.reset?.fromEpoch, null, `${carrier.type}: from a record with no stamp`);
      reopened.cm.close();
    }
  });

  it('a kept record carries its reset through the re-stamp', async () => {
    // A record a discard wrote under epoch 1 (as #114's earlier commits did),
    // in a store with nothing epoch 2 repriced: kept and re-stamped, and the
    // reset, which is this store's history, stays with it.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const reset = { discardedMultiplier: 1.5, fromEpoch: 0, at: 4 };
    const first = await openManager('kept-reset');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.8, at: 5, pricing: 1, reset });
    first.cm.close();
    const reopened = await openManager('kept-reset');
    await reopened.cm.compile(BUDGET);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.8, pricingEpoch: epoch, reset });
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
      { multiplier?: number; pricing?: number; reset?: unknown };
    assert.deepEqual([saved.multiplier, saved.pricing, saved.reset], [0.8, epoch, reset]);
    reopened.cm.close();
  });

  it('signed thinking stamped with its own tokenEstimate does not count as repriced', async () => {
    // MessageStore and ContextLog price a block with a numeric tokenEstimate
    // by that stamp, before epoch 1 and since, so in a store whose signed
    // thinking is all stamped an older record still means what it did.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const first = await openManager('stamped-thinking', { stampedThinking: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.7, at: 1, pricing: 0 });
    first.cm.close();
    const reopened = await openManager('stamped-thinking', { stampedThinking: true });
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 0.7);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.7, pricingEpoch: epoch });
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { multiplier?: number; pricing?: number };
    assert.equal(saved.multiplier, 0.7);
    assert.equal(saved.pricing, epoch, 're-stamped under the current epoch');
    reopened.cm.close();
  });

  it('a dry select leaves the record as it was, and the next real compile persists the load', async () => {
    // A preview (previewContext) and a dry compile each select with dryRun:
    // the load decides as a real one would, but writes and logs nothing, and
    // it must not latch, or the real compile after it would never persist.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const cases = [
      { name: 'dry-reset-preview', signedThinking: true, dry: 'preview' },
      { name: 'dry-reset-compile', signedThinking: true, dry: 'compile' },
      { name: 'dry-restamp-preview', signedThinking: false, dry: 'preview' },
      { name: 'dry-restamp-compile', signedThinking: false, dry: 'compile' },
    ] as const;
    for (const c of cases) {
      const first = await openManager(c.name, { signedThinking: c.signedThinking });
      await first.cm.compile(BUDGET);
      const old = { multiplier: 0.7, at: 1, pricing: 0 };
      first.internals.store!.setStateJson(first.internals.calibrationStateId, old);
      first.cm.close();

      const reopened = await openManager(c.name, { signedThinking: c.signedThinking });
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        if (c.dry === 'preview') assert.ok(reopened.cm.previewContext(BUDGET));
        else await reopened.cm.compile(BUDGET, undefined, { dryRun: true });
        const calibrationLines = () => warned.filter((l) => l.includes('[estimator-calibration]'));
        assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), old,
          `${c.name}: a dry select must not write the record`);
        assert.equal(calibrationLines().length, 0, `${c.name}: a dry select logs nothing`);
        await reopened.cm.compile(BUDGET);
        assert.equal(calibrationLines().length, 1, `${c.name}: the real compile logs the load once`);
      } finally {
        console.warn = warn;
      }
      const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: { discardedMultiplier: number } };
      assert.equal(saved.pricing, epoch, `${c.name}: the real compile persists the load's decision`);
      assert.equal(saved.multiplier, c.signedThinking ? 1 : 0.7);
      assert.equal(saved.reset?.discardedMultiplier, c.signedThinking ? 0.7 : undefined);
      reopened.cm.close();
    }
  });

  it('a dry select prices by the multiplier its load decided', async () => {
    // The dry load applies its decision to the store, so a preview's plan is
    // priced as the next real compile's is: a kept 0.7 against no record.
    const plans: number[] = [];
    const cases = [['priced-kept', { multiplier: 0.7, at: 1 }], ['priced-none', null]] as const;
    for (const [name, record] of cases) {
      const first = await openManager(name);
      await first.cm.compile(BUDGET);
      if (record) first.internals.store!.setStateJson(first.internals.calibrationStateId, record);
      first.cm.close();
      const reopened = await openManager(name);
      const preview = reopened.cm.previewContext(BUDGET)!;
      await reopened.cm.compile(BUDGET);
      assert.equal(preview.finalTokens, reopened.cm.getRenderStats()!.planVsActual!.planned,
        `${name}: the preview's plan is the real compile's`);
      plans.push(preview.finalTokens);
      reopened.cm.close();
    }
    assert.ok(plans[0] < plans[1] * 0.8, `the kept 0.7 priced the preview: ${plans.join(' vs ')}`);
  });

  it('a real load after a dry one decides from the record and history as they are then', async () => {
    // Whatever a dry load decided stays its own: the store can change before
    // the first real compile, and that compile's load decides afresh, for the
    // multiplier and for the reset alike.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const storeCalibration = (cm: ContextManager) =>
      (cm as unknown as { messageStore: { getTokenCalibration(): number } }).messageStore.getTokenCalibration();
    // Returns the multiplier the dry select priced by, where it reports one.
    const dryRun = async (cm: ContextManager, how: 'preview' | 'compile') => {
      if (how === 'preview') return cm.previewContext(BUDGET, undefined, { render: true })!.stats!.calibration!.multiplier;
      await cm.compile(BUDGET, undefined, { dryRun: true });
      return undefined;
    };
    for (const how of ['preview', 'compile'] as const) {
      // Kept by the dry load (nothing repriced held yet); unstamped signed
      // thinking arrives, so the real load discards it.
      const first = await openManager(`dry-keep-then-discard-${how}`);
      await first.cm.compile(BUDGET);
      first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.7, at: 1, pricing: 0 });
      first.cm.close();
      const kept = await openManager(`dry-keep-then-discard-${how}`);
      const priced = await dryRun(kept.cm, how);
      if (how === 'preview') assert.equal(priced, 0.7, 'the preview priced by the kept 0.7');
      // Nothing the dry load decided is left: neither the strategy's multiplier
      // nor the one the store prices new messages by, which chunking reads.
      assert.equal(kept.internals._calibration, 1, `${how}: the strategy's multiplier is as it was`);
      assert.equal(storeCalibration(kept.cm), 1, `${how}: the store prices by what it did before`);
      kept.cm.addMessage('Claude', [SIGNED_THINKING as never, { type: 'text', text: 'and then' }]);
      await kept.cm.compile(BUDGET);
      assert.equal(kept.internals._calibration, 1, `${how}: the real load discarded it`);
      assert.equal(kept.cm.getRenderStats()!.calibration!.multiplier, 1);
      const discarded = kept.internals.store!.getStateJson(kept.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: { discardedMultiplier: number } };
      assert.deepEqual([discarded.multiplier, discarded.pricing, discarded.reset?.discardedMultiplier], [1, epoch, 0.7]);
      kept.cm.close();

      // Discarded by the dry load (unstamped signed thinking); that content
      // goes, so the real load keeps it, with no reset anywhere.
      const second = await openManager(`dry-discard-then-keep-${how}`, { signedThinking: true });
      await second.cm.compile(BUDGET);
      second.internals.store!.setStateJson(second.internals.calibrationStateId, { multiplier: 0.7, at: 1, pricing: 0 });
      second.cm.close();
      const reset = await openManager(`dry-discard-then-keep-${how}`, { signedThinking: true });
      await dryRun(reset.cm, how);
      for (const m of reset.cm.getAllMessages()) {
        if (m.content.some((b) => (b as { type?: string }).type === 'thinking')) reset.cm.removeMessage(m.id);
      }
      await reset.cm.compile(BUDGET);
      assert.equal(reset.internals._calibration, 0.7, `${how}: the real load kept it`);
      assert.deepEqual(reset.cm.getRenderStats()!.calibration, { multiplier: 0.7, pricingEpoch: epoch }, `${how}: no reset`);
      const restamped = reset.internals.store!.getStateJson(reset.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: unknown };
      assert.deepEqual([restamped.multiplier, restamped.pricing, restamped.reset], [0.7, epoch, undefined]);
      reset.cm.close();
    }
  });

  it('a dry select refuses a store view whose calibration it could not put back', async () => {
    // A view with the calibration setter but not the getter: select() can't
    // read its factor to restore it, so a dry select refuses before changing
    // it, and the caller's own factor stays.
    const first = await openManager('setter-only');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId,
      { multiplier: 0.7, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    first.cm.close();
    const reopened = await openManager('setter-only');
    const cm = reopened.cm as unknown as {
      strategyMessageView(): Record<string, unknown>;
      messageStore: { getTokenCalibration(): number; setTokenCalibration(factor: number): void };
    };
    const build = Object.getPrototypeOf(reopened.cm).strategyMessageView as () => Record<string, unknown>;
    cm.strategyMessageView = function (this: unknown) {
      const view = build.call(this);
      delete view.getTokenCalibration;
      return view;
    };
    cm.messageStore.setTokenCalibration(1.3); // the caller's own factor
    assert.throws(() => reopened.cm.previewContext(BUDGET), /getTokenCalibration/);
    await assert.rejects(reopened.cm.compile(BUDGET, undefined, { dryRun: true }), /getTokenCalibration/);
    assert.equal(cm.messageStore.getTokenCalibration(), 1.3, 'neither dry select changed the caller\'s factor');
    await reopened.cm.compile(BUDGET);
    assert.equal(cm.messageStore.getTokenCalibration(), 0.7, 'a real compile applies the loaded one');
    reopened.cm.close();
  });

  it('a drift inside 2% is not applied; once the EMA passes 2% it is', async () => {
    const { cm, strategy, internals } = await openManager('deadband');
    await cm.compile(BUDGET);
    assert.equal(internals._calibration, 1);
    // real/est = 1.01 every compile: the EMA creeps toward 1.01 and never
    // leaves the band, so nothing is repriced between compiles.
    for (let i = 0; i < 12; i++) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.01);
      assert.equal(internals._calibration, 1, `sample ${i} must not move the applied multiplier`);
      await cm.compile(BUDGET);
    }
    // real/est = 1.10: the EMA passes 2% within a few samples and is applied.
    let applied = false;
    for (let i = 0; i < 6 && !applied; i++) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.1);
      applied = internals._calibration !== 1;
      await cm.compile(BUDGET);
    }
    assert.ok(applied, 'a sustained 10% error must be applied');
    assert.ok(internals._calibration > 1.02 && internals._calibration < 1.1, `got ${internals._calibration}`);
    cm.close();
  });
});
