/**
 * Session replay for measuring REAL KV-cache stability.
 *
 * `replaySession` is the BASELINE: the production-default `FlatProfileStrategy`
 * (level-equalizing) run through the real `Picker`, replayed over a growing
 * session. Compare it against `replayControlled` (the KV-stable controller) to
 * see what minimizing prefix churn actually buys. (Prior to the half-life/λ
 * solver's removal this line ran `solveStableFrontier`; the λ value model was
 * retired — see docs/kv-stable-context-control.md.)
 *
 * At each step it:
 *   1. exposes only the chunks/summaries that existed by that point
 *      (a summary is available once its youngest covered message has happened —
 *      `SummaryNode.lastSequence <= now`; compression is bottom-up over time);
 *   2. folds the middle to a FIXED token cap, carrying F_prev forward, with the
 *      newest `rawTailTokens` pinned raw (the flat zone);
 *   3. READS a PERSISTENT provider cache (`CacheStore`, Anthropic ≤4
 *      breakpoints) for the longest live stored prefix still byte-identical to
 *      this render — entries written ANY prior turn — then WRITES this render's
 *      breakpoints back. A prefix frozen many turns ago is still a hit today.
 *
 * Pure and deterministic.
 */

import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';
import type { SummaryEntry } from '../types/strategy.js';
import { SummaryTree } from './summary-tree.js';
import { Picker } from './picker.js';
import { FlatProfileStrategy } from './strategies/flat-profile.js';
import { renderLayout, type RenderLayout, type Frontier } from './render-offsets.js';
import { placeMarkers, CacheStore } from './kv-cache-sim.js';

export interface ReplayOptions {
  /** Fixed context-window cap each step folds against (tokens). */
  budgetTokens: number;
  /** Cache breakpoints to place per step (1…4). Default 4. */
  markerCount?: number;
  /** Newest-N tokens kept raw (the protected flat zone). */
  rawTailTokens?: number;
  /** Approximate number of replay steps (history is down-sampled to this).
   *  Default 120. */
  targetSteps?: number;
  /** Cache entries older than this many steps are evicted (provider TTL).
   *  Default Infinity (keep all — the faithful upper bound on reuse). */
  cacheTtlSteps?: number;
}

export interface ReplayStep {
  /** Newest visible source sequence at this step. */
  now: number;
  /** Visible chunk count. */
  numChunks: number;
  /** Rendered tokens of this step's frontier. */
  renderedTokens: number;
  /** Tokens served from the simulated provider cache this step. */
  cachedTokens: number;
  /** Tokens recomputed this step (cache miss). */
  recomputedTokens: number;
  /** cachedTokens / renderedTokens, in [0, 1]. */
  hitRate: number;
  /** Source sequence at/after which the frontier was re-optimized. */
  boundarySequence: number;
  /** Solver could not fit under the cap this step. */
  overBudget: boolean;
  /** Deepest fold level present in the rendered frontier (0 = all raw). */
  deepestLevel: number;
  /** Age (in steps) of the cache entry that served this step's hit — evidence
   *  the hit came from an older write, not just the previous turn. −1 = miss. */
  cacheAgeSteps: number;
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** Σ renderedTokens over all steps. */
  totalRendered: number;
  /** Σ recomputedTokens over all steps (the cache-miss bill). */
  totalRecomputed: number;
  /** (totalRendered − totalRecomputed) / totalRendered, in [0, 1]. */
  overallHitRate: number;
}

/**
 * Replay a full session (the exported PickerInputs snapshot) as growing
 * history, measuring per-step provider-cache hit under a fixed budget.
 */
export function replaySession(fullInputs: PickerInputs, opts: ReplayOptions): ReplayResult {
  const markerCount = opts.markerCount ?? 4;
  const targetSteps = Math.max(1, opts.targetSteps ?? 120);

  // Availability threshold per summary: youngest covered leaf sequence.
  // Built once over the full tree; a summary is usable at `now` iff <= now.
  const fullTree = new SummaryTree(fullInputs);
  const availableAt = new Map<string, number>();
  for (const s of fullTree.allSummaries()) availableAt.set(s.id, s.lastSequence);

  const allChunks = [...fullInputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const seqValues = allChunks.map((c) => c.sequence);

  // Down-sample to ~targetSteps growth points (always include the final state).
  const stride = Math.max(1, Math.ceil(seqValues.length / targetSteps));
  const stepSeqs: number[] = [];
  for (let i = 0; i < seqValues.length; i += stride) stepSeqs.push(seqValues[i]);
  const last = seqValues[seqValues.length - 1];
  if (stepSeqs[stepSeqs.length - 1] !== last) stepSeqs.push(last);

  const steps: ReplayStep[] = [];
  let fprev: Frontier = new Map<ChunkId, number>();
  const cache = new CacheStore({ ttlSteps: opts.cacheTtlSteps });
  let totalRendered = 0;
  let totalRecomputed = 0;

  for (const now of stepSeqs) {
    const visiblePlain = allChunks.filter((c) => c.sequence <= now);
    const tailIds = rawTailSet(visiblePlain, opts.rawTailTokens ?? 0);
    // Pin the flat zone so flat-profile won't fold it AND it renders as
    // individual raw units — not collapsed into one fixed-key 'tail' unit,
    // which would falsely match across turns in the cache.
    const visible = visiblePlain.map((c) => (tailIds.has(c.id) ? { ...c, pinned: true } : c));
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
      chunks: visible,
      summaries,
      recallPairTokens,
      headTokens: 0,
      tailTokens: 0,
      headChunkIds: new Set(),
      tailChunkIds: new Set(),
    };
    const tree = new SummaryTree(inputs);

    // Baseline policy: the production default, FlatProfileStrategy, via the real
    // Picker — folds the middle to the budget, leaving the pinned flat zone raw.
    const result = new Picker(new FlatProfileStrategy()).run(inputs, {
      totalBudget: opts.budgetTokens,
      targetBudget: opts.budgetTokens,
      slack: 0,
    });
    const resolutions = result.finalResolutions;

    const layout = renderLayout(inputs, tree, resolutions);
    // READ the persistent cache: longest live stored prefix that still matches.
    const hit = cache.read(layout);
    const recomputedTokens = layout.totalTokens - hit.cachedTokens;
    // WRITE this render's breakpoints back (hinting at the earliest change vs
    // F_prev), then advance the turn clock so future reads see this write.
    const boundarySeq = earliestChangedSequence(fprev, resolutions, visible);
    const boundaryUnitIndex = unitsBeforeSequence(layout, tree, boundarySeq);
    cache.write(layout, placeMarkers(layout, markerCount, { boundaryUnitIndex }));
    cache.tick();

    let deepestLevel = 0;
    for (const lvl of resolutions.values()) if (lvl > deepestLevel) deepestLevel = lvl;

    steps.push({
      now,
      numChunks: visible.length,
      renderedTokens: layout.totalTokens,
      cachedTokens: hit.cachedTokens,
      recomputedTokens,
      hitRate: layout.totalTokens > 0 ? hit.cachedTokens / layout.totalTokens : 0,
      boundarySequence: boundarySeq,
      overBudget: result.finalTokens > opts.budgetTokens,
      deepestLevel,
      cacheAgeSteps: hit.ageSteps,
    });
    totalRendered += layout.totalTokens;
    totalRecomputed += recomputedTokens;

    fprev = resolutions;
  }

  return {
    steps,
    totalRendered,
    totalRecomputed,
    overallHitRate: totalRendered > 0 ? (totalRendered - totalRecomputed) / totalRendered : 0,
  };
}

// ---------------------------------------------------------------------------

/** Earliest source sequence whose resolution changed `prev → next` (the marker
 *  hint / churn boundary). MAX_SAFE_INTEGER when nothing changed. */
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

/** Chunk ids within the newest `tailTokens` of raw content (kept non-foldable). */
function rawTailSet(orderedChunks: PickerChunk[], tailTokens: number): Set<ChunkId> {
  const s = new Set<ChunkId>();
  if (tailTokens <= 0) return s;
  let used = 0;
  for (let i = orderedChunks.length - 1; i >= 0; i--) {
    s.add(orderedChunks[i].id);
    used += orderedChunks[i].rawTokens;
    if (used >= tailTokens) break;
  }
  return s;
}

/** Number of leading rendered units whose start sequence is < `boundary` (the
 *  frozen-prefix length → a natural cache breakpoint). */
function unitsBeforeSequence(layout: RenderLayout, tree: SummaryTree, boundary: number): number {
  let count = 0;
  for (const u of layout.units) {
    if (unitStartSeq(u, tree) < boundary) count++;
    else break;
  }
  return count;
}

function unitStartSeq(
  u: RenderLayout['units'][number],
  tree: SummaryTree,
): number {
  if (u.kind === 'raw') return tree.leaf(u.key)?.sequence ?? 0;
  if (u.kind === 'recall') return tree.summary(u.key)?.firstSequence ?? 0;
  if (u.kind === 'head') return -1;
  return Number.MAX_SAFE_INTEGER; // tail
}
