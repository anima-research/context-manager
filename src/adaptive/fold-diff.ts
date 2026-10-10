/**
 * Fold diff — what a compile actually changed in the frontier, and where.
 *
 * `[plan-vs-actual]` reports how many chunks moved; it does not say which
 * levels they moved between or where in the rendered prefix the first change
 * landed. Both questions decide the provider bill for the turn (everything
 * after the earliest layout divergence is re-read at full price) and the
 * operator has had no way to answer them short of replaying the store.
 * Observed on Fable (2026-10-06): 24 of 51 large rewrites in a week read
 * exactly the system+tools prefix and re-wrote ~450k tokens, with nothing in
 * the logs saying which band had rotated.
 *
 * `describeFoldDiff` is pure: it compares a carried frontier against the one
 * the solver just produced, groups the changed chunks into contiguous runs in
 * source order by (from → to) level, prices each run's position by the
 * carried layout's cumulative offset, and reports the earliest divergence in
 * the same unit model `kvCost` uses. `formatFoldDiff` renders one log line.
 */

import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import type { SummaryTree } from './summary-tree.js';
import { renderLayout, earliestDivergenceIndex, type Frontier } from './render-offsets.js';

/** One contiguous (in source order) run of chunks that moved between the same two levels. */
export interface FoldDiffRun {
  /** Level before the compile (0 = raw). */
  from: number;
  /** Level after the compile (0 = raw). */
  to: number;
  /** Chunks in the run. */
  count: number;
  firstChunkId: ChunkId;
  lastChunkId: ChunkId;
  /**
   * Rendered offset (tokens before) of the run's first chunk in the CARRIED
   * layout — i.e. how deep into the previous request the change lands.
   * `null` when the chunk did not render as its own unit before (a sibling
   * shared its recall pair, or it sat in the head/tail).
   */
  offsetBefore: number | null;
}

export interface FoldDiff {
  /** Chunks whose level changed (head/tail excluded, as in the picker). */
  moves: number;
  /** Chunks that folded deeper. */
  deepened: number;
  /** Chunks that un-folded toward raw. */
  raised: number;
  runs: FoldDiffRun[];
  /** Rendered tokens of the carried layout and of the new one. */
  previousTokens: number;
  nextTokens: number;
  /**
   * Offset in the NEW layout of the first rendered unit that differs from the
   * carried layout (`kvCost` semantics): a prompt-cache prefix can survive up
   * to here. `null` when the layouts are identical.
   */
  divergenceOffset: number | null;
  /** Tokens of the new layout from the divergence to the end — what the
   *  provider re-reads at full price. 0 when nothing diverged. */
  suffixTokens: number;
}

/**
 * Describe the change from `previous` to `next` over `inputs.chunks`.
 * Chunks absent from a map are at level 0. Head and tail chunks never count
 * (they are forced raw by the picker and are not frontier decisions).
 */
export function describeFoldDiff(
  inputs: PickerInputs,
  tree: SummaryTree,
  previous: Frontier,
  next: Frontier,
): FoldDiff {
  const prevLayout = renderLayout(inputs, tree, previous);
  const nextLayout = renderLayout(inputs, tree, next);

  // Offset of each chunk's own unit in the carried layout: raw units are
  // keyed by chunk id; a recall unit is keyed by summary id and covers every
  // leaf under it, so attribute it to all of them.
  const offsetBefore = new Map<ChunkId, number>();
  for (const unit of prevLayout.units) {
    if (unit.kind === 'raw') {
      offsetBefore.set(unit.key, unit.offset);
    } else if (unit.kind === 'recall') {
      for (const leaf of tree.leavesUnder(unit.key)) {
        if (!offsetBefore.has(leaf)) offsetBefore.set(leaf, unit.offset);
      }
    }
  }

  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const runs: FoldDiffRun[] = [];
  let moves = 0;
  let deepened = 0;
  let raised = 0;
  let current: FoldDiffRun | null = null;
  for (const c of ordered) {
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id)) {
      current = null;
      continue;
    }
    const from = previous.get(c.id) ?? 0;
    const to = next.get(c.id) ?? 0;
    if (from === to) {
      current = null;
      continue;
    }
    moves++;
    if (to > from) deepened++;
    else raised++;
    if (current && current.from === from && current.to === to) {
      current.count++;
      current.lastChunkId = c.id;
      continue;
    }
    current = {
      from,
      to,
      count: 1,
      firstChunkId: c.id,
      lastChunkId: c.id,
      offsetBefore: offsetBefore.get(c.id) ?? null,
    };
    runs.push(current);
  }

  const d = earliestDivergenceIndex(prevLayout.units, nextLayout.units);
  const divergenceOffset =
    d === -1 || d >= nextLayout.units.length ? null : nextLayout.units[d].offset;
  const suffixTokens = divergenceOffset === null ? 0 : nextLayout.totalTokens - divergenceOffset;

  return {
    moves,
    deepened,
    raised,
    runs,
    previousTokens: prevLayout.totalTokens,
    nextTokens: nextLayout.totalTokens,
    divergenceOffset,
    suffixTokens,
  };
}

const k = (n: number): string => `${Math.round(n / 1000)}k`;

/**
 * One line for the operator log. Runs are listed in source order (oldest
 * first) so the leftmost entry is the deepest-positioned change. `maxRuns`
 * caps the listing; the remainder is summarized.
 */
export function formatFoldDiff(diff: FoldDiff, maxRuns = 8): string {
  const runText = diff.runs.slice(0, maxRuns).map((r) => {
    const where = r.offsetBefore === null ? '' : `@${k(r.offsetBefore)}`;
    const span = r.count === 1 ? r.firstChunkId : `${r.firstChunkId}..${r.lastChunkId}`;
    return `L${r.from}→L${r.to}×${r.count}${where}[${span}]`;
  });
  if (diff.runs.length > maxRuns) runText.push(`+${diff.runs.length - maxRuns} more runs`);
  const divergence =
    diff.divergenceOffset === null
      ? 'layout unchanged'
      : `divergence@${k(diff.divergenceOffset)} suffix=${k(diff.suffixTokens)}`;
  return (
    `[fold-diff] moves=${diff.moves} (deepened=${diff.deepened} raised=${diff.raised}) ` +
    `rendered ${k(diff.previousTokens)}→${k(diff.nextTokens)} ${divergence}` +
    (runText.length > 0 ? ` runs=${diff.runs.length}: ${runText.join(' ')}` : '')
  );
}
