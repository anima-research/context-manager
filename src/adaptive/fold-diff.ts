/**
 * Fold diff — what a compile changed in the frontier, and where its request
 * first differs from the previous one.
 *
 * `[plan-vs-actual]` reports how many chunks moved; it does not say which
 * levels they moved between or where the request first changed. Both decide
 * the provider bill for the turn (a cached prefix can't reach past the first
 * change, so everything after it is read at full price) and the operator has
 * had no way to answer them short of replaying the store. Observed on Fable
 * (2026-10-06): 24 of 51 large requests in a week read exactly the
 * system+tools prefix and re-wrote ~450k tokens, with nothing in the logs
 * saying which band had rotated.
 *
 * `describeFoldDiff` is pure: it compares a carried frontier against the one
 * the solver just produced and groups the changed chunks into contiguous runs
 * in source order by (from → to) level. Where the request first changed is
 * measured, not modelled: the strategy compares this compile's entries with
 * those of the last request it returned, by their bytes (the comparison that
 * places its stable-prefix cache marker), and passes the result in.
 * `formatFoldDiff` renders one log line.
 *
 * Levels are the levels chunks render at (`renderedAncestor`, the rule
 * `renderLayout` uses): a pinned chunk is raw whatever level it carries, and a
 * level whose ancestor summary is missing renders raw. Locked chunks are
 * skipped, as the strategy's commit loop skips them (their carried level never
 * changes). Counting stored levels instead let a line report a pinned chunk's
 * move that changed nothing it rendered (PR #157 review).
 */

import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import type { SummaryTree } from './summary-tree.js';
import { renderedAncestor, type Frontier } from './render-offsets.js';

/** Runs a `FoldDiff` keeps; `runsTotal` counts them all. */
const MAX_RUNS = 8;

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
}

/** Where a request's entries first differ from the previous request's, in their tokens. */
export interface RequestDivergence {
  /** Tokens before the first entry that differs. */
  offset: number;
  /** Tokens from that entry to the end of the request. */
  suffixTokens: number;
}

/**
 * What one compile changed. `moves` and `runs` compare the carried frontier
 * with the new one, both rendered under this compile's pins and summaries, so
 * they describe what this compile's commit changes. A pin added or removed, a
 * summary lost or a lock released since the previous request changes the
 * request without a move, and the divergence shows where. The divergence
 * compares this request's entries, its messages, with those of the last
 * request the strategy returned (after a branch switch, the other branch's);
 * the system prompt and tools come before the entries and are neither
 * compared nor counted. Nor are the injections ContextManager.compile adds
 * after the comparison: one placed before the last user message moves with
 * it, so where nothing earlier differs, the request first differs at the
 * injection, a message before the divergence reported.
 */
export interface FoldDiff {
  /** Chunks whose rendered level differs between the carried frontier and the
   *  new one (head/tail and locked chunks excluded, as in the commit loop). A
   *  move can leave the request unchanged, when the summary it moves to
   *  already renders for its siblings and the one it leaves still renders for
   *  theirs. A committing compile can count none: when a chunk's saved level
   *  has lost its summary, the commit saves the level the chunk can still
   *  render, which is its carried level here. */
  moves: number;
  /** Chunks that folded deeper. */
  deepened: number;
  /** Chunks that un-folded toward raw. */
  raised: number;
  /** The first runs in source order, at most eight. */
  runs: FoldDiffRun[];
  /** Every run, those `runs` leaves out included. */
  runsTotal: number;
  /**
   * Tokens of this request's entries before the first one whose bytes differ
   * from the previous request's entry at the same position, or that has none
   * there (the first appended one). A cached prefix can reach past the system
   * prompt and tools and this far into the entries, no further. It counts
   * every entry when this request's entries are the previous request's or a
   * prefix of them. `null` when there's no earlier compile to compare with:
   * the strategy's first since the process started.
   */
  divergenceOffset: number | null;
  /** Tokens of the entries from `divergenceOffset` to the end, which no
   *  cached prefix covers: 0 when this request's entries are the previous
   *  request's or a prefix of them, `null` with `divergenceOffset`. */
  suffixTokens: number | null;
}

/**
 * Describe the change from `previous` to `next` over `inputs.chunks`, with
 * where the request first changed as the strategy measured it (`null`: no
 * earlier compile). Chunks absent from a map are at level 0. Head, tail and
 * locked chunks never count (head and tail are forced raw by the picker; a
 * locked chunk's carried level is never committed).
 */
export function describeFoldDiff(
  inputs: PickerInputs,
  tree: SummaryTree,
  previous: Frontier,
  next: Frontier,
  divergence: RequestDivergence | null,
): FoldDiff {
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const runs: FoldDiffRun[] = [];
  let runsTotal = 0;
  let moves = 0;
  let deepened = 0;
  let raised = 0;
  let current: FoldDiffRun | null = null;
  for (const c of ordered) {
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id) || c.lockedByAgent) {
      current = null;
      continue;
    }
    const from = renderedAncestor(c, tree, previous)?.level ?? 0;
    const to = renderedAncestor(c, tree, next)?.level ?? 0;
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
    runsTotal++;
    current = { from, to, count: 1, firstChunkId: c.id, lastChunkId: c.id };
    // A run past the cap is still counted; the record keeps the first ones.
    if (runs.length < MAX_RUNS) runs.push(current);
  }

  return {
    moves,
    deepened,
    raised,
    runs,
    runsTotal,
    divergenceOffset: divergence?.offset ?? null,
    suffixTokens: divergence?.suffixTokens ?? null,
  };
}

const k = (n: number): string => `${Math.round(n / 1000)}k`;

/** One line for the operator log, listing the runs the record kept. */
export function formatFoldDiff(diff: FoldDiff): string {
  const runText = diff.runs.map((r) => {
    const span = r.count === 1 ? r.firstChunkId : `${r.firstChunkId}..${r.lastChunkId}`;
    return `L${r.from}→L${r.to}×${r.count}[${span}]`;
  });
  if (diff.runsTotal > diff.runs.length) runText.push(`+${diff.runsTotal - diff.runs.length} more runs`);
  const divergence =
    diff.divergenceOffset === null || diff.suffixTokens === null
      ? 'no earlier compile to compare'
      : `divergence@${k(diff.divergenceOffset)} suffix=${k(diff.suffixTokens)}`;
  return (
    `[fold-diff] moves=${diff.moves} (deepened=${diff.deepened} raised=${diff.raised}) ${divergence}` +
    (runText.length > 0 ? ` runs=${diff.runsTotal}: ${runText.join(' ')}` : '')
  );
}
