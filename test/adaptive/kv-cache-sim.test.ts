/**
 * Tests for the Anthropic-style KV cache simulation (kv-cache-sim.ts).
 *
 * Load-bearing properties:
 *  - placeMarkers never exceeds the breakpoint budget, stays in-bounds, and
 *    always offers the end (pure-append) breakpoint;
 *  - a pure append (identical prefix, longer next) is a full cache hit when an
 *    end marker exists — only the appended tail is recomputed;
 *  - a mid-prefix change caches up to the largest marker at/under the
 *    divergence point;
 *  - the discrete-marker cache never beats the idealized longest-prefix bound,
 *    and with a marker on every unit it equals the divergence offset (the same
 *    quantity render-offsets.kvCost is built on).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderLayout, kvCost, type RenderLayout, type RenderedUnit } from '../../src/adaptive/render-offsets.js';
import {
  placeMarkers,
  evaluateCacheHit,
  CacheStore,
  MAX_CACHE_MARKERS,
  type CacheMarker,
} from '../../src/adaptive/kv-cache-sim.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { buildChronicleWithChain } from './harness.js';
import type { PickerInputs } from '../../src/adaptive/picker.js';

/** A bare layout from explicit unit token sizes (kinds/keys are synthetic). */
function layoutOf(units: Array<{ key: string; tokens: number; kind?: RenderedUnit['kind'] }>): RenderLayout {
  let offset = 0;
  const out: RenderedUnit[] = units.map((u) => {
    const unit: RenderedUnit = { kind: u.kind ?? 'raw', key: u.key, tokens: u.tokens, offset };
    offset += u.tokens;
    return unit;
  });
  return { units: out, totalTokens: offset };
}

/** A marker per unit boundary (the idealized, no-breakpoint-limit cache). */
function perUnitMarkers(layout: RenderLayout): CacheMarker[] {
  const out: CacheMarker[] = [];
  for (let i = 1; i <= layout.units.length; i++) {
    out.push({ unitIndex: i, offset: i < layout.units.length ? layout.units[i].offset : layout.totalTokens });
  }
  return out;
}

test('placeMarkers: respects budget, stays in-bounds, includes the end marker', () => {
  const layout = layoutOf([
    { key: 'head', tokens: 100, kind: 'head' },
    { key: 'a', tokens: 50 },
    { key: 'b', tokens: 50 },
    { key: 'c', tokens: 50 },
    { key: 'd', tokens: 50 },
    { key: 'e', tokens: 50 },
  ]);
  for (const count of [1, 2, 3, 4, 9]) {
    const markers = placeMarkers(layout, count, { boundaryUnitIndex: 4 });
    assert.ok(markers.length <= Math.min(count, MAX_CACHE_MARKERS), `≤${count} markers`);
    assert.ok(markers.every((m) => m.unitIndex >= 1 && m.unitIndex <= layout.units.length), 'in bounds');
    const idxs = markers.map((m) => m.unitIndex);
    assert.deepEqual([...idxs].sort((a, b) => a - b), idxs, 'sorted ascending');
    assert.ok(idxs.includes(layout.units.length), 'end (pure-append) marker present');
    // offsets are consistent with the layout
    for (const m of markers) {
      const expected = m.unitIndex < layout.units.length ? layout.units[m.unitIndex].offset : layout.totalTokens;
      assert.equal(m.offset, expected);
    }
  }
});

test('pure append: identical prefix + appended tail → only the tail recomputes', () => {
  const prev = layoutOf([{ key: 'a', tokens: 100 }, { key: 'b', tokens: 100 }]);
  const next = layoutOf([{ key: 'a', tokens: 100 }, { key: 'b', tokens: 100 }, { key: 'c', tokens: 60 }]);
  const markers = placeMarkers(prev, 4); // includes end-of-prev (unitIndex 2)
  const hit = evaluateCacheHit(prev, markers, next);
  assert.equal(hit.cachedTokens, 200, 'whole prev prefix served from cache');
  assert.equal(hit.recomputedTokens, 60, 'only appended tail recomputed');
  assert.equal(hit.markerUnitIndex, 2);
  assert.ok(hit.hitRate > 0.76 && hit.hitRate < 0.77);
});

test('mid-prefix change: cache stops at the largest marker ≤ divergence', () => {
  const prev = layoutOf([
    { key: 'a', tokens: 50 }, { key: 'b', tokens: 50 }, { key: 'c', tokens: 50 },
    { key: 'd', tokens: 50 }, { key: 'e', tokens: 50 },
  ]);
  // next diverges at unit index 3 (a,b,c identical; d→X).
  const next = layoutOf([
    { key: 'a', tokens: 50 }, { key: 'b', tokens: 50 }, { key: 'c', tokens: 50 },
    { key: 'X', tokens: 70 }, { key: 'e', tokens: 50 },
  ]);
  // Markers at unit indices 2 and 5 (end). Largest ≤ divergence(3) is 2 → 100 tokens.
  const markers: CacheMarker[] = [
    { unitIndex: 2, offset: prev.units[2].offset },
    { unitIndex: 5, offset: prev.totalTokens },
  ];
  const hit = evaluateCacheHit(prev, markers, next);
  assert.equal(hit.divergenceUnits, 3);
  assert.equal(hit.markerUnitIndex, 2);
  assert.equal(hit.cachedTokens, 100);
  assert.equal(hit.recomputedTokens, next.totalTokens - 100);
});

test('no marker at/under divergence → full recompute', () => {
  const prev = layoutOf([{ key: 'a', tokens: 50 }, { key: 'b', tokens: 50 }, { key: 'c', tokens: 50 }]);
  const next = layoutOf([{ key: 'X', tokens: 50 }, { key: 'b', tokens: 50 }, { key: 'c', tokens: 50 }]);
  // Only an end marker; divergence is at unit 0, so nothing is cached.
  const markers: CacheMarker[] = [{ unitIndex: 3, offset: prev.totalTokens }];
  const hit = evaluateCacheHit(prev, markers, next);
  assert.equal(hit.divergenceUnits, 0);
  assert.equal(hit.markerUnitIndex, -1);
  assert.equal(hit.cachedTokens, 0);
  assert.equal(hit.recomputedTokens, next.totalTokens);
});

test('discrete markers never beat the idealized longest-prefix bound; per-unit markers equal it', () => {
  // Real-ish layouts from a small chronicle, two different frontiers.
  const ch = buildChronicleWithChain({ chunkCount: 18, tokensPerChunk: 500, mergeThreshold: 6, recallPairTokens: 120 });
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const tree = new SummaryTree(inputs);
  const allRaw = new Map(ch.chunks.map((c) => [c.id, 0]));
  const folded = new Map(ch.chunks.map((c, i) => [c.id, i < 12 ? 1 : 0])); // fold the old half to L1
  const prev = renderLayout(inputs, tree, allRaw);
  const next = renderLayout(inputs, tree, folded);

  // Idealized: longest byte-identical prefix is cached → cached = total − kvCost.
  const idealCached = next.totalTokens - kvCost(prev, next);

  // Discrete ≤4 markers can only cache a prefix at one of its breakpoints → ≤ ideal.
  const fourHit = evaluateCacheHit(prev, placeMarkers(prev, 4), next);
  assert.ok(fourHit.cachedTokens <= idealCached, '≤4 markers ≤ idealized prefix');

  // A marker on every unit recovers the idealized bound exactly.
  const idealHit = evaluateCacheHit(prev, perUnitMarkers(prev), next);
  assert.equal(idealHit.cachedTokens, idealCached, 'per-unit markers == longest prefix');
});

// ---- CacheStore: persistent, cross-turn cache ----

const A = layoutOf([{ key: 'a', tokens: 50 }, { key: 'b', tokens: 50 }, { key: 'c', tokens: 50 }, { key: 'd', tokens: 50 }, { key: 'e', tokens: 50 }]);
const B = layoutOf([{ key: 'a', tokens: 50 }, { key: 'b', tokens: 50 }, { key: 'X', tokens: 70 }, { key: 'd', tokens: 50 }, { key: 'e', tokens: 50 }]);

test('CacheStore: cold read misses; write then read identical is a full hit', () => {
  const store = new CacheStore();
  assert.equal(store.read(A).cachedTokens, 0, 'cold cache = full recompute');
  store.write(A, placeMarkers(A, 4));
  const hit = store.read(A);
  assert.equal(hit.cachedUnits, A.units.length, 'whole render served from cache');
  assert.equal(hit.cachedTokens, A.totalTokens);
  assert.equal(hit.ageSteps, 0, 'written this step');
});

test('CacheStore: remembers a prefix written turns ago across an intervening divergence (the revert case)', () => {
  const store = new CacheStore();
  // step 0: render A, cache its breakpoints (incl. the full-length end marker).
  store.write(A, placeMarkers(A, 4));
  store.tick();
  // step 1: render B diverges from A at unit 2; cache B's breakpoints.
  store.write(B, placeMarkers(B, 4));
  store.tick();
  // step 2: the frontier reverts to A. A persistent cache still has A's full
  // entry from step 0 — a single-turn "compare to previous render (B)" check
  // would only credit the shared [a,b) prefix.
  const hit = store.read(A);
  assert.equal(hit.cachedUnits, A.units.length, 'full A prefix recovered from step-0 write');
  assert.equal(hit.cachedTokens, A.totalTokens);
  assert.equal(hit.ageSteps, 2, 'hit served by a 2-step-old entry');

  // Contrast: the single-turn check against B can only credit the prefix shared
  // with B (up to the divergence), never the full A entry the store recovered.
  const single = evaluateCacheHit(B, placeMarkers(B, 4), A);
  assert.ok(single.cachedTokens < hit.cachedTokens, 'single-turn check cannot see the old entry');
  assert.ok(single.cachedTokens <= 100, 'single-turn limited to the shared a,b prefix');
});

test('CacheStore: TTL evicts stale entries', () => {
  const store = new CacheStore({ ttlSteps: 1 });
  store.write(A, placeMarkers(A, 4));
  store.tick(); // step 1: age 1, still within ttl
  assert.equal(store.read(A).cachedUnits, A.units.length, 'age 1 ≤ ttl → still live');
  store.tick(); // step 2: age 2 > ttl → evicted
  assert.equal(store.read(A).cachedTokens, 0, 'expired entry no longer hits');
});

test('CacheStore: a longer live entry wins over a shorter one', () => {
  const store = new CacheStore();
  // Two writes of the same render: one with only a short marker, then full.
  store.write(A, [{ unitIndex: 2, offset: A.units[2].offset }]);
  store.write(A, [{ unitIndex: A.units.length, offset: A.totalTokens }]);
  assert.equal(store.read(A).cachedUnits, A.units.length, 'longest matching prefix served');
});
