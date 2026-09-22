/**
 * Rendered-unit / offset accounting for the adaptive compiled context.
 *
 * `render.ts` reconstructs content byte-faithfully but exposes no token
 * positions. The V2 best-fit KV term needs them: KV cost is governed by the
 * EARLIEST position at which a new frontier diverges from the previous one —
 * the provider caches the longest byte-identical prefix, so every token after
 * the first divergence is recomputed (`docs/best-fit-frontier-resolution.md`
 * §4, §4.1).
 *
 * `renderLayout` produces the ordered sequence of rendered units (head,
 * per-chunk raw/recall in source order, tail) with cumulative token offsets,
 * matching the picker's `accountFrontier` exactly:
 *  - head/tail are fixed blocks;
 *  - pinned chunks render raw (L0) regardless of resolution;
 *  - a folded chunk emits its L_k ancestor's recall pair, once per distinct
 *    ancestor (siblings share one recall pair);
 *  - a resolution whose ancestor summary is missing falls back to raw.
 *
 * Pure and deterministic.
 */

import type { ChunkId, SummaryId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import type { SummaryTree } from './summary-tree.js';

/** Resolution map: chunkId → display level (0 = raw). */
export type Frontier = ReadonlyMap<ChunkId, number>;

export interface RenderedUnit {
  kind: 'head' | 'raw' | 'recall' | 'tail';
  /**
   * Stable identity for prefix comparison. Two units are byte-identical iff
   * they share (kind, key): 'head'/'tail' for the fixed blocks, the chunk id
   * for a raw shard, the summary id for a recall pair.
   */
  key: string;
  tokens: number;
  /** Cumulative tokens BEFORE this unit (its start offset in the prefix). */
  offset: number;
}

export interface RenderLayout {
  units: RenderedUnit[];
  totalTokens: number;
}

/**
 * Build the ordered rendered-unit layout for a frontier. `totalTokens` equals
 * `accountFrontier` for the same resolutions.
 */
export function renderLayout(
  inputs: PickerInputs,
  tree: SummaryTree,
  frontier: Frontier,
): RenderLayout {
  const units: RenderedUnit[] = [];
  let offset = 0;
  const push = (kind: RenderedUnit['kind'], key: string, tokens: number): void => {
    units.push({ kind, key, tokens, offset });
    offset += tokens;
  };

  if (inputs.headTokens > 0) push('head', 'head', inputs.headTokens);

  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const renderedSummaries = new Set<SummaryId>();
  for (const c of ordered) {
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id)) continue;
    const effective = c.pinned ? 0 : frontier.get(c.id) ?? 0;
    if (effective === 0) {
      push('raw', c.id, c.rawTokens);
      continue;
    }
    const ancestor = tree.ancestorAt(c.id, effective);
    if (!ancestor) {
      // Resolution set but summary missing — render raw (renderer makes the
      // same call). Matches computeTokens' fallback.
      push('raw', c.id, c.rawTokens);
      continue;
    }
    if (renderedSummaries.has(ancestor.id)) continue; // sibling shares the pair
    renderedSummaries.add(ancestor.id);
    push('recall', ancestor.id, ancestor.recallTokens);
  }

  for (const unit of tailUnits(inputs)) push(unit.kind, unit.key, unit.tokens);

  return { units, totalTokens: offset };
}

/**
 * The raw tail as rendered units, in wire order.
 *
 * Each tail chunk is its own `raw` unit keyed by chunk id — the SAME identity
 * it has once it slides out of the tail into the middle. Until 2026-09-21 the
 * whole tail was one opaque `('tail','tail')` unit, so every append shifted
 * that unit's position (the messages leaving the tail became new raw units in
 * front of it) and the end-of-tail cache marker fell outside the "identical"
 * prefix: an unchanged layout was priced as ~100k tokens of cache churn on
 * every turn although the wire bytes were identical (sill, kv-unified
 * certificate never fired). Tail tokens not attributed to any tail chunk
 * (synthetic inputs; in production `tailTokens` is exactly the chunk sum)
 * still render as the opaque block, so token totals are unchanged.
 */
export function tailUnits(
  inputs: Pick<PickerInputs, 'chunks' | 'tailChunkIds' | 'tailTokens'>,
): Array<{ kind: 'raw' | 'tail'; key: string; tokens: number; chunkId?: ChunkId }> {
  const units: Array<{ kind: 'raw' | 'tail'; key: string; tokens: number; chunkId?: ChunkId }> = [];
  let attributed = 0;
  const tail = inputs.chunks
    .filter((chunk) => inputs.tailChunkIds.has(chunk.id))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  for (const chunk of tail) {
    units.push({ kind: 'raw', key: chunk.id, tokens: chunk.rawTokens, chunkId: chunk.id });
    attributed += chunk.rawTokens;
  }
  const residual = inputs.tailTokens - attributed;
  if (residual > 0) units.push({ kind: 'tail', key: 'tail', tokens: residual });
  return units;
}

/**
 * Earliest index at which two unit sequences differ (by kind+key).
 * Returns -1 when the sequences are identical; otherwise the first differing
 * index (which may be `min(len)` when one is a strict prefix of the other).
 */
export function earliestDivergenceIndex(a: RenderedUnit[], b: RenderedUnit[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].kind !== b[i].kind || a[i].key !== b[i].key) return i;
  }
  return a.length === b.length ? -1 : n;
}

/**
 * KV cost of moving from `prev` to `next`: the number of tokens in `next` that
 * must be recomputed — everything from the earliest divergence onward. 0 when
 * `next`'s units are an exact prefix of (or identical to) `prev`'s, since the
 * whole of `next` is then a cached prefix.
 */
export function kvCost(prev: RenderLayout, next: RenderLayout): number {
  const d = earliestDivergenceIndex(prev.units, next.units);
  if (d === -1) return 0; // identical
  if (d >= next.units.length) return 0; // next is a prefix of prev → fully cached
  return next.totalTokens - next.units[d].offset;
}
