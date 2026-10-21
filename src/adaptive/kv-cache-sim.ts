/**
 * Anthropic-style KV cache simulation over a rendered layout.
 *
 * Real providers don't cache "the longest byte-identical prefix" for free — the
 * Anthropic API honors up to FOUR explicit `cache_control` breakpoints, and on
 * each request reuses the LONGEST previously-marked prefix that is still
 * byte-identical to the new prompt. Everything after that match is recomputed
 * at full input price (`docs/best-fit-frontier-resolution.md` §4).
 *
 * This module models that discrete-breakpoint behavior, so the playground can
 * measure the cache hit a real deployment would actually get — not the
 * idealized ceiling that `render-offsets.kvCost` computes.
 *
 *  - `placeMarkers` chooses ≤N breakpoint positions on a layout (the markers we
 *    attach to THIS render, written into the cache for FUTURE renders to hit).
 *  - `CacheStore` is a PERSISTENT, content-keyed cache: each `write` records the
 *    exact bytes of the marked prefixes (as a content hash + write step), and
 *    they stay live across turns (subject to a TTL). `read` returns the LONGEST
 *    live stored prefix that is byte-identical to the current render. This is
 *    the real provider behaviour: a prefix cached many turns ago is still a hit
 *    today if it hasn't changed — even if intervening turns diverged and the
 *    frontier later reverted. A single-turn "compare to the previous render"
 *    check (see `evaluateCacheHit`) cannot model that, so the replay uses the
 *    store.
 *
 * A marker's `unitIndex` is the number of leading rendered units it caches
 * (so `unitIndex` ∈ [0, units.length]); `offset` is the cumulative tokens of
 * that prefix. `unitIndex === units.length` caches the whole render (the
 * pure-append breakpoint).
 *
 * Cache identity: two rendered units match when they share (kind, key), the
 * same identity `render-offsets` uses: a recall unit keyed by a summary id
 * renders that summary's fixed recall pair, a raw unit keyed by a chunk id
 * renders that chunk, and head/tail are fixed blocks. This simulator takes
 * the (kind, key) sequence as the cached bytes. A raw or head unit's bytes
 * can change in place under its key (an edit, an image stripped, a tool
 * result replaced or moved, a cut), which it doesn't see; kv-unified's
 * accepted cache reference records and checks those (CacheRenderRecord).
 *
 * Pure and deterministic (no Date/random; the store tracks a logical step clock
 * advanced by the caller).
 */

import { earliestDivergenceIndex, type RenderLayout } from './render-offsets.js';

/** Maximum cache breakpoints the Anthropic API honors. */
export const MAX_CACHE_MARKERS = 4;

/** A cache breakpoint: caches the first `unitIndex` rendered units (`offset` tokens). */
export interface CacheMarker {
  /** Number of leading units cached by this breakpoint (0 … units.length). */
  unitIndex: number;
  /** Cumulative tokens of the cached prefix. */
  offset: number;
}

export interface CacheHit {
  /** Tokens served from cache in `next` (longest matching marked prefix). */
  cachedTokens: number;
  /** Tokens recomputed in `next` (everything after the cached prefix). */
  recomputedTokens: number;
  /** cachedTokens / next.totalTokens, in [0, 1]. 0 when next is empty. */
  hitRate: number;
  /** unitIndex of the winning marker (−1 if no marker matched → full recompute). */
  markerUnitIndex: number;
  /** First unit index at which `next` diverges from `prev` (units.length-style;
   *  equals the identical-prefix length). */
  divergenceUnits: number;
}

/** Token offset of a prefix of `layout.units` of the given length. */
function prefixOffset(layout: RenderLayout, unitIndex: number): number {
  if (unitIndex <= 0) return 0;
  if (unitIndex >= layout.units.length) return layout.totalTokens;
  return layout.units[unitIndex].offset;
}

/**
 * Choose ≤`count` cache breakpoints for `layout`. The placement mirrors real
 * Anthropic usage and the stable solver's structure:
 *
 *  - the END of the render (caches everything → a pure-append next turn is a
 *    full hit) is always included;
 *  - the stable-prefix seam (`opts.boundaryUnitIndex`, where the frontier was
 *    frozen vs F_prev) — the most likely longest-surviving prefix under churn;
 *  - the HEAD boundary (the fixed system block) when present;
 *  - remaining budget spent on evenly-spaced tail seams.
 *
 * Returns distinct markers sorted by `unitIndex` ascending, capped to
 * `min(count, MAX_CACHE_MARKERS)`.
 */
export function placeMarkers(
  layout: RenderLayout,
  count: number,
  opts: { boundaryUnitIndex?: number } = {},
): CacheMarker[] {
  const n = layout.units.length;
  const budget = Math.max(1, Math.min(count, MAX_CACHE_MARKERS));
  if (n === 0) return [];

  // Priority-ordered candidate unit indices (most valuable first).
  const ordered: number[] = [];
  const add = (idx: number): void => {
    const clamped = Math.round(idx);
    if (clamped > 0 && clamped <= n && !ordered.includes(clamped)) ordered.push(clamped);
  };

  add(n); // end — pure-append breakpoint
  if (opts.boundaryUnitIndex !== undefined) add(opts.boundaryUnitIndex); // stable seam
  if (layout.units[0]?.kind === 'head') add(1); // system block
  // Evenly-spaced tail seams to fill any remaining slots.
  for (let k = 1; k < budget && ordered.length < budget; k++) {
    add((n * k) / budget);
  }

  const chosen = ordered.slice(0, budget).sort((a, b) => a - b);
  return chosen.map((unitIndex) => ({ unitIndex, offset: prefixOffset(layout, unitIndex) }));
}

/**
 * SINGLE-TURN cache check: score `next` against the breakpoints we placed on the
 * IMMEDIATELY PRECEDING render `prev`. The cache serves the longest marked
 * prefix of `prev` that is still byte-identical to `next`; everything after is
 * recomputed.
 *
 * This is a one-step primitive and intentionally has NO memory beyond `prev` —
 * it cannot model a prefix cached several turns ago surviving an intervening
 * divergence. For session replay use {@link CacheStore}, which persists entries
 * across turns. `prevMarkers` must be markers produced from `prev`. On a cold
 * start pass an empty `prevMarkers` (no cache → full recompute).
 */
export function evaluateCacheHit(
  prev: RenderLayout,
  prevMarkers: readonly CacheMarker[],
  next: RenderLayout,
): CacheHit {
  const total = next.totalTokens;
  // Identical leading units between prev and next (the byte-identical prefix).
  const d = earliestDivergenceIndex(prev.units, next.units);
  const identicalUnits = d === -1 ? prev.units.length : d;

  // Longest marker whose cached prefix is wholly inside the identical region.
  let best = -1;
  for (const m of prevMarkers) {
    if (m.unitIndex <= identicalUnits && m.unitIndex > best) best = m.unitIndex;
  }

  const cachedTokens = best <= 0 ? 0 : prefixOffset(next, best);
  const recomputedTokens = total - cachedTokens;
  return {
    cachedTokens,
    recomputedTokens,
    hitRate: total > 0 ? cachedTokens / total : 0,
    markerUnitIndex: best,
    divergenceUnits: identicalUnits,
  };
}

// ---------------------------------------------------------------------------
// Persistent, content-keyed, multi-turn cache (the model the replay uses).
// ---------------------------------------------------------------------------

/**
 * Deterministic prefix-hash chain over a layout's unit identities. Returns
 * `H[k]` = a 64-bit-ish hash (two 32-bit FNV/xorshift lanes, joined) of the
 * concatenation of the first `k` units' `(kind,key)`. `H[0]` is the empty
 * prefix. Two layouts share `H[k]` iff their first `k` units share their
 * identities, which this simulator takes as their bytes (see Cache identity
 * above).
 */
function prefixHashes(layout: RenderLayout): string[] {
  const H = new Array<string>(layout.units.length + 1);
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  H[0] = '0,0';
  for (let i = 0; i < layout.units.length; i++) {
    const u = layout.units[i];
    const s = u.kind + '\0' + u.key + '';
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul((h2 + c) >>> 0, 0x85ebca6b) >>> 0;
    }
    H[i + 1] = (h1 >>> 0) + ',' + (h2 >>> 0);
  }
  return H;
}

export interface CacheStoreOptions {
  /** Entries written more than this many steps ago are evicted before a read
   *  (models the provider TTL). Default Infinity (keep all — the faithful upper
   *  bound on reuse). */
  ttlSteps?: number;
}

export interface CacheReadResult {
  /** Tokens served from cache (longest live stored prefix matching `layout`). */
  cachedTokens: number;
  /** Units served from cache (the matched prefix length). */
  cachedUnits: number;
  /** How many steps ago the winning entry was written (0 = this step, −1 = miss). */
  ageSteps: number;
}

/**
 * A persistent provider cache. Holds, per cached prefix length, the set of
 * content hashes ever written at that length and the step each was last
 * (re)written. `read` finds the longest live stored prefix byte-identical to
 * the current render; `write` records the current render's breakpoint prefixes;
 * `tick` advances the logical turn clock used for TTL and age.
 */
export class CacheStore {
  private readonly ttl: number;
  /** length → (contentHash → last-written step). */
  private readonly byLength = new Map<number, Map<string, number>>();
  private step = 0;

  constructor(opts: CacheStoreOptions = {}) {
    this.ttl = opts.ttlSteps ?? Infinity;
  }

  /** Longest live cached prefix that is byte-identical to `layout`. */
  read(layout: RenderLayout): CacheReadResult {
    const H = prefixHashes(layout);
    const n = layout.units.length;
    let bestLen = 0;
    let bestStep = -1;
    for (const [len, byHash] of this.byLength) {
      if (len < 1 || len > n || len <= bestLen) continue;
      const written = byHash.get(H[len]);
      if (written === undefined) continue;
      if (this.step - written > this.ttl) continue; // expired
      bestLen = len;
      bestStep = written;
    }
    const cachedTokens =
      bestLen === 0 ? 0 : bestLen < n ? layout.units[bestLen].offset : layout.totalTokens;
    return { cachedTokens, cachedUnits: bestLen, ageSteps: bestStep < 0 ? -1 : this.step - bestStep };
  }

  /** Record the marked prefixes of `layout` as cache entries at the current step. */
  write(layout: RenderLayout, markers: readonly CacheMarker[]): void {
    const H = prefixHashes(layout);
    for (const m of markers) {
      const len = m.unitIndex;
      if (len < 1 || len > layout.units.length) continue;
      let byHash = this.byLength.get(len);
      if (!byHash) {
        byHash = new Map<string, number>();
        this.byLength.set(len, byHash);
      }
      byHash.set(H[len], this.step);
    }
  }

  /** Advance the logical turn clock (call once per replay step, after write). */
  tick(): void {
    this.step++;
    if (this.ttl === Infinity) return;
    for (const [len, byHash] of this.byLength) {
      for (const [hash, written] of byHash) {
        if (this.step - written > this.ttl) byHash.delete(hash);
      }
      if (byHash.size === 0) this.byLength.delete(len);
    }
  }
}
