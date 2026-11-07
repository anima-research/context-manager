/**
 * Calibration learns nothing from a compile that holds a Responses compaction
 * item.
 *
 * OpenAI may count a request that carries a compaction item from the item
 * onward, so the request's usage no longer measures the window the compile
 * priced. A sample from such a compile would teach the multiplier that every
 * window costs less than it does. The change is logged once when skipping
 * begins, and once when a compile without one lets calibration learn again,
 * not at every sample. Other carriers stay ordinary samples, and a multiplier
 * learned before carriers were priced still loads: agent-framework releases
 * from 0.6.5 on, before the one that carries
 * anima-research/agent-framework#988, leave carriers out of a turn's first
 * request, the one a sample is taken from.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, MockAdapter, NativeFormatter, type ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'compaction-calibration-'));
const BUDGET = { maxTokens: 100_000, reserveForResponse: 2_000 };
after(() => rmSync(dir, { recursive: true, force: true }));

type Internals = {
  _calibration: number;
  _calibrationProvisional: unknown;
  _lastCompileEstimate: number;
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void } | null;
};

const COMPACTION = { type: 'text', text: '', rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'E'.repeat(3_000) } } as unknown as ContentBlock;
const HOSTED_CALL = { type: 'text', text: '', rawItem: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'etosha' } } } as unknown as ContentBlock;

async function openManager(name: string, carrier?: ContentBlock) {
  const membrane = new Membrane(new MockAdapter({}), { formatter: new NativeFormatter() });
  const strategy = new AutobiographicalStrategy({
    targetChunkTokens: 5_000,
    recentWindowTokens: 50_000,
    compressionModel: 'mock',
    adaptiveResolution: true, // the calibration sample is armed on the adaptive (folding) path only
  });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane });
  let carrierAt: string | undefined;
  for (let i = 0; i < 6; i++) {
    const text: ContentBlock = { type: 'text', text: `turn ${i} ${'lorem ipsum '.repeat(120)}` };
    const id = cm.addMessage(i % 2 ? 'Claude' : 'User', i === 3 && carrier ? [carrier, text] : [text]);
    if (i === 3) carrierAt = id;
  }
  return { cm, strategy, internals: strategy as unknown as Internals, carrierAt: carrierAt! };
}

/** The `[estimator-calibration]` lines logged while `fn` runs. */
async function calibrationLines(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const { warn, error } = console;
  console.warn = console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines.filter((l) => l.includes('[estimator-calibration]'));
}

describe('calibration and compaction items', () => {
  it('learns nothing from a compile holding a compaction item, says so once, and learns again once a compile holds none', async () => {
    const { cm, strategy, internals, carrierAt } = await openManager('compaction', COMPACTION);
    // A fresh store's provisional 1 is replaced outright by the first sample
    // the band accepts, so a learned sample would read 1.2 at once.
    const first = await calibrationLines(async () => {
      await cm.compile(BUDGET);
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.2);
    });
    assert.strictEqual(internals._calibration, 1, 'a sample from a compile holding a compaction item is not learned');
    assert.strictEqual(first.length, 1, `one line when skipping begins: ${JSON.stringify(first)}`);
    assert.match(first[0]!, /compaction item/);

    const second = await calibrationLines(async () => {
      await cm.compile(BUDGET);
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.2);
    });
    assert.strictEqual(internals._calibration, 1);
    assert.deepStrictEqual(second, [], 'nothing more while it lasts');

    cm.editMessage(carrierAt, [{ type: 'text', text: `turn 3 ${'lorem ipsum '.repeat(120)}` }]);
    const third = await calibrationLines(async () => {
      await cm.compile(BUDGET);
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.2);
    });
    assert.ok(Math.abs(internals._calibration - 1.2) < 1e-9, `learned once the compile holds none: got ${internals._calibration}`);
    assert.strictEqual(third.filter((l) => /learned again/.test(l)).length, 1, `one line when learning resumes: ${JSON.stringify(third)}`);
    cm.close();
  });

  it('learns from a compile holding any other carrier, as from any other', async () => {
    const { cm, strategy, internals } = await openManager('hosted-call', HOSTED_CALL);
    await cm.compile(BUDGET);
    strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.2);
    assert.ok(Math.abs(internals._calibration - 1.2) < 1e-9, `got ${internals._calibration}`);
    cm.close();
  });

  it('loads a multiplier learned before carriers were priced unchanged, over a store holding them', async () => {
    const seeded = await openManager('learned', HOSTED_CALL);
    await seeded.cm.compile(BUDGET);
    seeded.internals.store!.setStateJson(seeded.internals.calibrationStateId,
      { multiplier: 1.3, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    seeded.cm.close();
    const membrane = new Membrane(new MockAdapter({}), { formatter: new NativeFormatter() });
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, compressionModel: 'mock', adaptiveResolution: true });
    const cm = await ContextManager.open({ path: join(dir, 'learned'), strategy, membrane });
    await cm.compile(BUDGET);
    const internals = strategy as unknown as Internals;
    assert.deepStrictEqual([internals._calibration, internals._calibrationProvisional], [1.3, null]);
    cm.close();
  });
});
