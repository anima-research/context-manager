/**
 * The seeding option's default and its path through the strategy
 * (#156 review, nissa item 2): `planControlledFrontier` seeds by default,
 * `KvStableStrategy` forwards the option untouched, and the autobiographical
 * strategy threads `kvStableSeedFromCarried` into the solver it builds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutobiographicalStrategy } from '../../src/strategies/autobiographical.js';
import { KvStableStrategy, type KvStableOptions } from '../../src/adaptive/strategies/kv-stable.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';
import { Picker } from '../../src/adaptive/picker.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

const optsOf = (s: KvStableStrategy): KvStableOptions => (s as unknown as { opts: KvStableOptions }).opts;

class Exposed extends AutobiographicalStrategy {
  solver(inputs: PickerInputs): KvStableStrategy | null {
    this.buildPicker(inputs);
    return (this as unknown as { _lastKvStable: KvStableStrategy | null })._lastKvStable;
  }
}

function inputs(): PickerInputs {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 100, mergeThreshold: 6, recallPairTokens: 100 });
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

test('kvStableSeedFromCarried threads from strategy config into the kv-stable solver', () => {
  const dflt = new Exposed({ foldingStrategy: 'kv-stable', adaptiveResolution: true } as never).solver(inputs());
  assert.ok(dflt, 'kv-stable solver built');
  assert.equal(optsOf(dflt).seedFromCarried, undefined, 'unset config leaves the solver default (true) in force');
  const off = new Exposed({ foldingStrategy: 'kv-stable', adaptiveResolution: true, kvStableSeedFromCarried: false } as never).solver(inputs());
  assert.ok(off);
  assert.equal(optsOf(off).seedFromCarried, false, 'an explicit false is preserved');
});

/** The review's carried-growth stream, driven through Picker + KvStableStrategy
 *  (the production path) instead of planControlledFrontier directly. */
function growthViaStrategy(opts: KvStableOptions, turns: number): { deepRaises: number; folds: number } {
  const ch = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 100 });
  let n = 0;
  const add = () => { ch.addChunk({ id: `c-${String(n).padStart(5, '0')}`, rawTokens: 50 }); n++; };
  const produce = () => {
    for (let i = 0; i + 6 <= ch.chunks.length; i += 6) {
      if (!ch.chunks[i]!.l1Id) ch.produceL1(ch.chunks.slice(i, i + 6).map((c) => c.id));
    }
    ch.preProduceUpperLevels();
  };
  for (let i = 0; i < 1296; i++) add();
  produce();
  const picker = new Picker(new KvStableStrategy(opts));
  let previous = new Map<string, number>();
  let deepRaises = 0, folds = 0;
  for (let t = 0; t < turns; t++) {
    add(); produce();
    const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
    const inp: PickerInputs = {
      chunks: ch.chunks.map((c) => ({ ...c, currentResolution: previous.get(c.id) ?? 0 })),
      summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
      headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
    };
    const r = picker.run(inp, { totalBudget: 2150, targetBudget: 1600, slack: 2150 > 0 ? 1 - 1600 / 2150 : 0 });
    for (const c of inp.chunks) {
      const before = previous.get(c.id) ?? 0, after = r.finalResolutions.get(c.id) ?? 0;
      if (before >= 3 && after < before) deepRaises++;
    }
    if (t > 0 && r.moves > 0) folds++;
    previous = new Map(r.finalResolutions);
  }
  return { deepRaises, folds };
}

test('KvStableStrategy forwards seedFromCarried; the default is seeded', () => {
  const dflt = growthViaStrategy({}, 120);
  assert.ok(dflt.folds >= 2, `the stream crosses W (folds=${dflt.folds})`);
  assert.equal(dflt.deepRaises, 0, 'default: no deep group is ever raised');
  const off = growthViaStrategy({ seedFromCarried: false }, 120);
  assert.ok(off.deepRaises > 0, `seedFromCarried:false reaches the from-scratch ideal (deep raises=${off.deepRaises})`);
});
