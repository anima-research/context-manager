/**
 * KV-stable context controller (see `docs/kv-stable-context-control.md`).
 *
 * A receding-horizon policy that replaces the `value − λ·KVcost` solve. One
 * objective — minimize real billed recompute — under a constraint hierarchy with
 * a single hard wall (the physical window W) and shaped soft constraints
 * (flat zone, perturbation cap, pins/saliency, operating budget). State (the
 * carried frontier + the persistent cache) makes it a controller, not a
 * per-turn solve.
 *
 * This prototype uses a hysteresis band [LW, HW] as the controllable operating
 * point on the cost↔continuity frontier:
 *   - append every turn; if rendered tokens exceed HW, shed down to ≤ LW;
 *     otherwise do nothing (pure append → zero perturbation, full cache hit);
 *   - shed oldest-first, leveled (L1 groups, then L2, then L3), each chunk
 *     capped by the saliency field (log-age + flat zone + pins) — base-k
 *     grouping driven by budget, not a fixed clock;
 *   - W is the only hard wall; if folding everything to its cap can't fit under
 *     W, escalate (don't thrash).
 *
 * Pure and deterministic.
 */

import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';
import type { SummaryEntry } from '../types/strategy.js';
import { SummaryTree } from './summary-tree.js';
import { renderLayout, type RenderLayout, type Frontier } from './render-offsets.js';
import { placeMarkers, CacheStore } from './kv-cache-sim.js';

/** Provider price multipliers relative to base input tokens (Anthropic-ish). */
export const PRICE = { miss: 1.0, cacheRead: 0.1, cacheWrite: 1.25 } as const;

/** Deepest fold level the saliency field will ever allow. */
export const MAX_FOLD_LEVEL = 3;

export interface ControlOptions {
  /** Physical context window — the ONLY hard wall. */
  windowTokens: number;
  /** Operating budget B (< W). High-watermark HW defaults to this. */
  budgetTokens: number;
  /** Shed down to this low-watermark when HW is breached. (HW − LW) sets fold
   *  frequency/amplitude. Default 0.8·budget. */
  lowWatermark?: number;
  /** High-watermark; fold is triggered above it. Default = budgetTokens. */
  highWatermark?: number;
  /** Per-turn divergence reach: how far back (tokens from the live end) a fold
   *  may normally edit — the structural perturbation cap P, and the primary
   *  cost↔continuity knob. Smaller = gentler per-turn KV perturbation (shallow
   *  divergence) but less efficient compression → more/again folding. Exceeded
   *  ONLY to avoid the hard wall W. Default = budgetTokens (effectively
   *  unbounded). */
  reachTokens?: number;
  /** Attended window kept raw + stable (the flat zone). */
  attendedWindowTokens: number;
  /** Base-k summary grouping (matches mergeThreshold). Default 6. */
  mergeThreshold?: number;
  /** Cache breakpoints per turn (1..4). Default 4. */
  markerCount?: number;
  /** Approx replay steps (down-sample). Default 120. */
  targetSteps?: number;
  /** Cache TTL in steps. Default Infinity. */
  cacheTtlSteps?: number;
}

export interface ControlStep {
  now: number;
  numChunks: number;
  renderedTokens: number;
  cachedTokens: number;
  recomputedTokens: number;
  /** Billed recompute at provider multipliers. */
  billed: number;
  /** Prefix churn = recompute beyond genuinely new content (the KV perturbation
   *  of the attended region). 0 on a pure-append turn. */
  perturbation: number;
  /** True when the controller folded this turn (a perturbation event). */
  folded: boolean;
  /** True when even full folding could not fit under W (terminal). */
  escalated: boolean;
  deepestLevel: number;
}

export interface ControlResult {
  steps: ControlStep[];
  totalRecomputed: number;
  totalBilled: number;
  overallHitRate: number;
  /** Worst single-turn perturbation (the continuity ceiling). */
  maxPerturbation: number;
  /** RMS per-turn perturbation (variance-continuity). */
  rmsPerturbation: number;
  /** Count of turns that perturbed the prefix. */
  foldEvents: number;
  /** Count of terminal (over-W) turns. */
  escalations: number;
}

/**
 * Per-chunk maximum fold depth from the saliency field: flat zone and pins are
 * raw (0); otherwise log-age banded against the base-k geometry. The "finest
 * requirement wins" — this is the cap the shedder may not exceed.
 */
export function foldDepthCap(
  chunk: PickerChunk,
  now: number,
  flatZone: ReadonlySet<ChunkId>,
  flatZoneChunks: number,
  mergeThreshold: number,
): number {
  if (chunk.pinned || flatZone.has(chunk.id)) return 0;
  const age = Math.max(0, now - chunk.sequence);
  const ratio = age / Math.max(1, flatZoneChunks);
  if (ratio < 1) return 0; // just outside the flat zone → still raw
  const band = Math.floor(Math.log(ratio) / Math.log(Math.max(2, mergeThreshold))) + 1;
  return Math.max(0, Math.min(MAX_FOLD_LEVEL, band));
}

/**
 * Deepen `frontier` in place to bring rendered tokens ≤ `target`, leveled
 * (L1 groups, then L2, then L3) and oldest-first *within the reach window*. A
 * chunk is editable this turn only if the raw tokens newer than it are <
 * `reachTokens` — this bounds the divergence depth (and thus the per-turn KV
 * perturbation) to ≈ reach. Each chunk is bounded by its saliency cap;
 * flat-zone/pinned chunks (cap 0) are never touched.
 *
 * `reachTokens` is the soft cap P; `windowTokens` is the hard wall W. If folding
 * within reach can't fit under W, reach is lifted (emergency) and folding
 * continues to caps — yielding P minimally to keep W. Returns final tokens.
 */
function shedToTarget(
  frontier: Map<ChunkId, number>,
  inputs: PickerInputs,
  tree: SummaryTree,
  ordered: PickerChunk[],
  caps: Map<ChunkId, number>,
  target: number,
  reachTokens: number,
  windowTokens: number,
): number {
  // Raw tokens strictly newer than each chunk (its distance from the live end).
  const newerTokens = new Map<ChunkId, number>();
  let acc = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    newerTokens.set(ordered[i].id, acc);
    acc += ordered[i].rawTokens;
  }

  const foldWithinReach = (reach: number): boolean => {
    for (let level = 1; level <= MAX_FOLD_LEVEL; level++) {
      for (const c of ordered) {
        // oldest-first within reach
        if ((newerTokens.get(c.id) ?? 0) >= reach) continue;
        if ((frontier.get(c.id) ?? 0) >= level) continue;
        const ancestor = tree.ancestorAt(c.id, level);
        if (!ancestor) continue; // summary not produced yet → can't fold here
        // Group-consistency + reach: fold the WHOLE group to `level` only if
        // every covered leaf permits it (cap ≥ level) and is within reach. The
        // picker raises whole groups, so a partially-eligible group would be an
        // unreachable target (it oscillates). A uniform fold keeps the frontier
        // group-consistent and the picker convergent.
        let eligible = true;
        for (const leafId of ancestor.leafChunkIds) {
          if ((caps.get(leafId) ?? 0) < level || (newerTokens.get(leafId) ?? 0) >= reach) {
            eligible = false;
            break;
          }
        }
        if (!eligible) continue;
        for (const leafId of ancestor.leafChunkIds) {
          if ((frontier.get(leafId) ?? 0) < level) frontier.set(leafId, level);
        }
        if (renderLayout(inputs, tree, frontier).totalTokens <= target) return true;
      }
    }
    return false;
  };

  foldWithinReach(reachTokens);
  let tokens = renderLayout(inputs, tree, frontier).totalTokens;
  // Hard wall: yield the reach cap (P) only as far as needed to keep under W.
  if (tokens > windowTokens) {
    foldWithinReach(Infinity);
    tokens = renderLayout(inputs, tree, frontier).totalTokens;
  }
  return tokens;
}

/**
 * Raise `frontier` resolution in place (UN-fold toward raw) to fill up to
 * `target`, leveled (L3→L2, L2→L1, L1→raw) and **youngest-first within the reach
 * window** — the mirror image of `shedToTarget`. Un-folding is a prefix
 * perturbation too, so it obeys the same reach cap (bounded divergence) and only
 * lowers whole groups (group-consistent → the picker reaches it via `lower`
 * ops). Youngest-first spends the budget on the most recent foldable content
 * (highest value, shallowest divergence). Stops before exceeding `target`.
 * rawZone/frozen chunks are never touched. Returns final tokens.
 */
function expandToTarget(
  frontier: Map<ChunkId, number>,
  inputs: PickerInputs,
  tree: SummaryTree,
  ordered: PickerChunk[],
  target: number,
  reachTokens: number,
  rawZone: ReadonlySet<ChunkId>,
  frozen: ReadonlySet<ChunkId>,
): number {
  const newerTokens = new Map<ChunkId, number>();
  let acc = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    newerTokens.set(ordered[i].id, acc);
    acc += ordered[i].rawTokens;
  }

  let tokens = renderLayout(inputs, tree, frontier).totalTokens;
  for (let level = MAX_FOLD_LEVEL; level >= 1 && tokens < target; level--) {
    for (let oi = ordered.length - 1; oi >= 0; oi--) {
      if (tokens >= target) break;
      const c = ordered[oi]; // youngest-first
      if ((frontier.get(c.id) ?? 0) !== level) continue;
      if (rawZone.has(c.id) || frozen.has(c.id)) continue;
      if ((newerTokens.get(c.id) ?? 0) >= reachTokens) continue;
      const node = tree.ancestorAt(c.id, level);
      if (!node) continue;
      // Lower the WHOLE group to level-1 only if every covered leaf is at this
      // level and within reach (group-consistent + reach-bounded).
      let eligible = true;
      for (const leafId of node.leafChunkIds) {
        if (
          (frontier.get(leafId) ?? 0) !== level ||
          rawZone.has(leafId) || frozen.has(leafId) ||
          (newerTokens.get(leafId) ?? 0) >= reachTokens
        ) {
          eligible = false;
          break;
        }
      }
      if (!eligible) continue;
      for (const leafId of node.leafChunkIds) frontier.set(leafId, level - 1);
      const nt = renderLayout(inputs, tree, frontier).totalTokens;
      if (nt <= target) tokens = nt; // accept the un-fold
      else for (const leafId of node.leafChunkIds) frontier.set(leafId, level); // overshoot → revert
    }
  }
  return tokens;
}

/** Earliest source sequence whose resolution changed `prev → next`. */
function earliestChangedSequence(
  prev: Frontier,
  next: ReadonlyMap<ChunkId, number>,
  ordered: PickerChunk[],
): number {
  for (const c of ordered) {
    if ((prev.get(c.id) ?? 0) !== (next.get(c.id) ?? 0)) return c.sequence;
  }
  return Number.MAX_SAFE_INTEGER;
}

function unitsBeforeSequence(layout: RenderLayout, tree: SummaryTree, boundary: number): number {
  let count = 0;
  for (const u of layout.units) {
    const seq =
      u.kind === 'raw' ? tree.leaf(u.key)?.sequence ?? 0
      : u.kind === 'recall' ? tree.summary(u.key)?.firstSequence ?? 0
      : u.kind === 'head' ? -1
      : Number.MAX_SAFE_INTEGER;
    if (seq < boundary) count++;
    else break;
  }
  return count;
}

function rawTailSet(ordered: PickerChunk[], tailTokens: number): Set<ChunkId> {
  const s = new Set<ChunkId>();
  if (tailTokens <= 0) return s;
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    s.add(ordered[i].id);
    used += ordered[i].rawTokens;
    if (used >= tailTokens) break;
  }
  return s;
}

const EMPTY_SET: ReadonlySet<ChunkId> = new Set();

export interface ControlPlanParams {
  /** Carried frontier (F_prev). */
  previous: ReadonlyMap<ChunkId, number>;
  /** Fold (deepen) when rendered tokens exceed this (high-watermark). */
  foldAtTokens: number;
  /** Un-fold (raise toward raw) when rendered tokens are below this
   *  (low-watermark). Default = targetTokens. The band (foldAt − expandAt) is a
   *  no-op dead zone that prevents fold↔unfold oscillation. Set below foldAt. */
  expandAtTokens?: number;
  /** The attractor both fold and un-fold aim for (soft target). */
  targetTokens: number;
  /** Hard wall W — fold past the reach cap only to keep under this. */
  windowTokens: number;
  /** Per-turn divergence reach (perturbation cap P) — bounds BOTH fold and
   *  un-fold divergence. Default = windowTokens. */
  reachTokens?: number;
  /** Chunks forced to raw and never folded (flat zone / head / tail / pinned). */
  rawZone: ReadonlySet<ChunkId>;
  /** Chunks kept at their carried resolution and never touched (locked). */
  frozen?: ReadonlySet<ChunkId>;
  /** Newest source sequence — the age reference for the log-age fold caps. */
  now: number;
  /** Base-k summary grouping. Default 6. */
  mergeThreshold?: number;
}

export interface ControlPlan {
  resolutions: Map<ChunkId, number>;
  tokens: number;
  /** A fold (deepen) happened this turn. */
  folded: boolean;
  /** An un-fold (raise toward raw, to use budget headroom) happened this turn. */
  expanded: boolean;
  /** Even full folding under caps could not fit under W (terminal). */
  escalated: boolean;
}

/**
 * Plan one turn's frontier under the controller policy — shared by the replay
 * harness (`replayControlled`) and `KvStableStrategy`. Carries F_prev forward,
 * holds the raw zone raw and the frozen set fixed, then drives the rendered size
 * toward `targetTokens` from EITHER side, both bounded by the `reachTokens`
 * divergence cap (KV-continuity preserving in both directions):
 *   - over `foldAtTokens`  → deepen, oldest-first, under the log-age saliency
 *     caps, yielding the reach cap only as needed to stay under the hard wall W;
 *   - under `expandAtTokens` → un-fold, youngest-first, to use budget headroom.
 * The [expandAt, foldAt] dead band leaves F_prev untouched (zero perturbation)
 * when already in range. Pure and deterministic.
 */
export function planControlledFrontier(
  inputs: PickerInputs,
  tree: SummaryTree,
  p: ControlPlanParams,
): ControlPlan {
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const frozen = p.frozen ?? EMPTY_SET;
  const mergeThreshold = p.mergeThreshold ?? 6;
  const reach = p.reachTokens ?? p.windowTokens;
  const expandAt = p.expandAtTokens ?? p.targetTokens;

  const F = new Map<ChunkId, number>();
  for (const c of ordered) {
    if (p.rawZone.has(c.id)) F.set(c.id, 0);
    else if (frozen.has(c.id)) F.set(c.id, p.previous.get(c.id) ?? c.currentResolution);
    else F.set(c.id, p.previous.get(c.id) ?? 0);
  }

  let tokens = renderLayout(inputs, tree, F).totalTokens;
  const before = tokens;
  let folded = false;
  let expanded = false;
  let escalated = false;
  if (tokens > p.foldAtTokens) {
    const flatZoneChunks = p.rawZone.size;
    const caps = new Map<ChunkId, number>();
    for (const c of ordered) {
      caps.set(
        c.id,
        p.rawZone.has(c.id) || frozen.has(c.id)
          ? 0
          : foldDepthCap(c, p.now, p.rawZone, flatZoneChunks, mergeThreshold),
      );
    }
    tokens = shedToTarget(F, inputs, tree, ordered, caps, p.targetTokens, reach, p.windowTokens);
    folded = tokens !== before; // a real fold only if it actually changed the render
    if (tokens > p.windowTokens) escalated = true;
  } else if (tokens < expandAt) {
    tokens = expandToTarget(F, inputs, tree, ordered, p.targetTokens, reach, p.rawZone, frozen);
    expanded = tokens !== before; // a real un-fold only if it actually changed
  }
  return { resolutions: F, tokens, folded, expanded, escalated };
}

/**
 * Run the controller over a session (the exported PickerInputs snapshot) as
 * growing history, measuring billed recompute and KV perturbation per turn.
 */
export function replayControlled(fullInputs: PickerInputs, opts: ControlOptions): ControlResult {
  const mergeThreshold = opts.mergeThreshold ?? 6;
  const markerCount = opts.markerCount ?? 4;
  const targetSteps = Math.max(1, opts.targetSteps ?? 120);
  const HW = opts.highWatermark ?? opts.budgetTokens;
  const LW = opts.lowWatermark ?? Math.round(0.8 * opts.budgetTokens);
  const reachTokens = opts.reachTokens ?? opts.budgetTokens;

  const fullTree = new SummaryTree(fullInputs);
  const availableAt = new Map<string, number>();
  for (const s of fullTree.allSummaries()) availableAt.set(s.id, s.lastSequence);

  const allChunks = [...fullInputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const seqValues = allChunks.map((c) => c.sequence);
  const stride = Math.max(1, Math.ceil(seqValues.length / targetSteps));
  const stepSeqs: number[] = [];
  for (let i = 0; i < seqValues.length; i += stride) stepSeqs.push(seqValues[i]);
  const last = seqValues[seqValues.length - 1];
  if (stepSeqs[stepSeqs.length - 1] !== last) stepSeqs.push(last);

  const steps: ControlStep[] = [];
  let fprev: Frontier = new Map<ChunkId, number>();
  const cache = new CacheStore({ ttlSteps: opts.cacheTtlSteps });
  let prevNow = -1;
  let totalRecomputed = 0;
  let totalBilled = 0;
  let totalCached = 0;
  let totalRendered = 0;
  let sumSqPerturb = 0;
  let maxPerturbation = 0;
  let foldEvents = 0;
  let escalations = 0;

  for (const now of stepSeqs) {
    const visible = allChunks.filter((c) => c.sequence <= now);
    const summaries = new Map<string, SummaryEntry>();
    const recallPairTokens = new Map<string, number>();
    for (const [id, s] of fullInputs.summaries) {
      const lastSeq = availableAt.get(id);
      if (lastSeq !== undefined && lastSeq >= 0 && lastSeq <= now) {
        summaries.set(id, s);
        const rp = fullInputs.recallPairTokens?.get(id);
        if (rp !== undefined) recallPairTokens.set(id, rp);
      }
    }
    const inputs: PickerInputs = {
      chunks: visible, summaries, recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const tree = new SummaryTree(inputs);
    const flatZone = rawTailSet(visible, opts.attendedWindowTokens);
    // Plan this turn's frontier via the shared controller policy (the same code
    // KvStableStrategy runs): carry F_prev, hold the flat zone raw, fold to LW
    // when over HW, and un-fold to LW when under it — both reach-bounded, with
    // [LW, HW] a no-op dead band; never past the hard wall W.
    const plan = planControlledFrontier(inputs, tree, {
      previous: fprev, foldAtTokens: HW, expandAtTokens: LW, targetTokens: LW,
      windowTokens: opts.windowTokens, reachTokens, rawZone: flatZone, now, mergeThreshold,
    });
    const F = plan.resolutions;
    const folded = plan.folded || plan.expanded; // any active prefix change this turn
    const escalated = plan.escalated;

    const layout = renderLayout(inputs, tree, F);
    const hit = cache.read(layout);
    const recomputed = layout.totalTokens - hit.cachedTokens;

    // Perturbation = recompute beyond genuinely new content (prefix churn).
    let newContent = 0;
    for (const c of visible) if (c.sequence > prevNow) newContent += c.rawTokens;
    const perturbation = Math.max(0, recomputed - newContent);

    const billed = PRICE.miss * recomputed + PRICE.cacheRead * hit.cachedTokens;

    // Write breakpoints for future turns, hinting at the change boundary.
    const boundarySeq = earliestChangedSequence(fprev, F, visible);
    const boundaryUnitIndex = unitsBeforeSequence(layout, tree, boundarySeq);
    cache.write(layout, placeMarkers(layout, markerCount, { boundaryUnitIndex }));
    cache.tick();

    let deepestLevel = 0;
    for (const lvl of F.values()) if (lvl > deepestLevel) deepestLevel = lvl;

    steps.push({
      now, numChunks: visible.length, renderedTokens: layout.totalTokens,
      cachedTokens: hit.cachedTokens, recomputedTokens: recomputed, billed,
      perturbation, folded, escalated, deepestLevel,
    });
    totalRecomputed += recomputed;
    totalBilled += billed;
    totalCached += hit.cachedTokens;
    totalRendered += layout.totalTokens;
    sumSqPerturb += perturbation * perturbation;
    if (perturbation > maxPerturbation) maxPerturbation = perturbation;
    if (folded) foldEvents++;
    if (escalated) escalations++;

    fprev = F;
    prevNow = now;
  }

  return {
    steps,
    totalRecomputed,
    totalBilled,
    overallHitRate: totalRendered > 0 ? totalCached / totalRendered : 0,
    maxPerturbation,
    rmsPerturbation: Math.sqrt(sumSqPerturb / Math.max(1, steps.length)),
    foldEvents,
    escalations,
  };
}
