/**
 * Best-fit frontier solver (docs §3, §6, §11 step 4).
 *
 * Chooses a frontier — a contiguous partition of the chronicle into rendered
 * units (raw chunks and summary recall-pairs) — that maximizes recency-weighted
 * value under a token budget, while preferring SMOOTH frontiers (few resolution
 * changes) when it's affordable.
 *
 * Formulated as a position-ordered sequence DP over the chunks (oldest →
 * newest). Each rendered unit picks a level: raw (level 0, one chunk) or a
 * summary S starting at this position (level S.level, covering S's contiguous
 * range, one recall pair). The objective is
 *
 *     maximize  Σ value(unit) − λ·tokens(unit) − γ·|Δlevel between adjacent units|
 *
 * - `value` / `tokens`: the fidelity-weighted info and recall/raw cost.
 * - `λ` (budget multiplier): swept by binary search to fit the token budget.
 * - `γ` (smoothness): penalizes level changes between adjacent units, so the
 *   solver prefers contiguous resolution bands. Small γ = "smooth when
 *   affordable" — it only smooths where the value cost is low; real value
 *   differences and pins still break it. γ=0 = pure budget-optimal.
 *
 * Pins fall out for free: a non-foldable (pinned) chunk only has a raw unit, and
 * any summary spanning it is excluded — so the cut routes around pins, and the
 * resulting non-monotonic steps are legitimate (not gratuitous fragmentation).
 *
 * Deterministic (no Date.now/Math.random).
 */

import type { ChunkId } from './folding-strategy.js';
import type { SummaryTree } from './summary-tree.js';
import type { ValueFunction } from './value-function.js';

export interface SolveParams {
  /** Token budget for the (foldable) content this tree represents. */
  budgetTokens: number;
  value: ValueFunction;
  /**
   * Whether a chunk may be folded away. A non-foldable chunk renders raw and no
   * summary may span it (pins / fixed ranges stay raw). Default: all foldable.
   */
  isFoldable?: (chunkId: ChunkId) => boolean;
  /**
   * Smoothness weight γ: penalty per unit of level-change between adjacent
   * rendered units. Small = prefer contiguous bands where affordable; 0 = pure
   * value-optimal (may fragment). Default 0.
   */
  smoothness?: number;
  /** Binary-search iterations on the budget multiplier λ. Default 60. */
  iterations?: number;
}

export interface SolveResult {
  /** Chosen display level per chunk (0 = raw). The target frontier. */
  resolutions: Map<ChunkId, number>;
  /** Rendered tokens of the chosen frontier (matches renderLayout total). */
  tokens: number;
  /** Total recency-weighted value of the chosen frontier. */
  value: number;
  /** True if even the most-folded feasible frontier still exceeds the budget. */
  overBudget: boolean;
}

interface Unit {
  level: number;
  span: number; // number of chunks covered
  tokens: number;
  value: number;
}

export function solveFrontier(tree: SummaryTree, params: SolveParams): SolveResult {
  const { budgetTokens, value } = params;
  const isFoldable = params.isFoldable ?? (() => true);
  const gamma = params.smoothness ?? 0;
  const iterations = params.iterations ?? 60;

  const leaves = tree.orderedLeaves();
  const M = leaves.length;
  if (M === 0) return { resolutions: new Map(), tokens: 0, value: 0, overBudget: false };

  const posOf = new Map<ChunkId, number>();
  leaves.forEach((l, i) => posOf.set(l.chunkId, i));
  const foldable = leaves.map((l) => isFoldable(l.chunkId));

  // ---- Candidate rendered units per start position ----
  const unitsAt: Unit[][] = Array.from({ length: M }, () => []);
  for (let pos = 0; pos < M; pos++) {
    unitsAt[pos].push({ level: 0, span: 1, tokens: leaves[pos].rawTokens, value: value.nodeValue(leaves[pos], tree) });
  }
  let maxLevel = 0;
  for (const s of tree.allSummaries()) {
    maxLevel = Math.max(maxLevel, s.level);
    // A summary's sourceIds can reference items absent from the current chunk
    // set (sharded / migrated ids). Validate against the REAL leaves only — the
    // recall renders over the chunks actually present.
    let startPos = Infinity;
    let lastPos = -Infinity;
    let count = 0;
    let allFoldable = true;
    for (const id of s.leafChunkIds) {
      const pp = posOf.get(id);
      if (pp === undefined) continue; // phantom id — not a chunk in this view
      count++;
      if (pp < startPos) startPos = pp;
      if (pp > lastPos) lastPos = pp;
      if (!foldable[pp]) {
        allFoldable = false;
        break;
      }
    }
    if (!allFoldable || count === 0) continue;
    // Real leaves must exactly fill [startPos, lastPos] (no foreign chunk
    // interleaved) so the recall can render as one contiguous block.
    if (lastPos - startPos + 1 !== count) continue;
    unitsAt[startPos].push({ level: s.level, span: count, tokens: s.recallTokens, value: value.nodeValue(s, tree) });
  }

  // ---- Sequence DP for a given λ ----
  // prevLevel index p: 0 = no previous unit (first), k+1 = previous unit at level k.
  const P = maxLevel + 2;
  const solveAt = (lambda: number): { tokens: number; value: number; res: Map<ChunkId, number> } => {
    // f[pos][p] = best objective for covering [pos, M); choiceUnit[pos][p] = unit index.
    const f: Float64Array[] = new Array(M + 1);
    const pick: Int32Array[] = new Array(M + 1);
    f[M] = new Float64Array(P); // zeros
    for (let pos = M - 1; pos >= 0; pos--) {
      const fp = new Float64Array(P);
      const ch = new Int32Array(P);
      const us = unitsAt[pos];
      for (let p = 0; p < P; p++) {
        const prevLevel = p === 0 ? -1 : p - 1;
        let best = -Infinity;
        let bestU = 0;
        for (let ui = 0; ui < us.length; ui++) {
          const u = us[ui];
          const pen = prevLevel < 0 ? 0 : gamma * Math.abs(u.level - prevLevel);
          const obj = u.value - lambda * u.tokens - pen + f[pos + u.span][u.level + 1];
          if (obj > best) {
            best = obj;
            bestU = ui;
          }
        }
        fp[p] = best;
        ch[p] = bestU;
      }
      f[pos] = fp;
      pick[pos] = ch;
    }
    // Backtrack from (pos 0, no previous).
    const res = new Map<ChunkId, number>();
    let pos = 0;
    let p = 0;
    let tokens = 0;
    let val = 0;
    while (pos < M) {
      const u = unitsAt[pos][pick[pos][p]];
      for (let k = 0; k < u.span; k++) res.set(leaves[pos + k].chunkId, u.level);
      tokens += u.tokens;
      val += u.value;
      pos += u.span;
      p = u.level + 1;
    }
    return { tokens, value: val, res };
  };

  // ---- Budget via λ (higher λ → fewer tokens) ----
  const atZero = solveAt(0); // value-optimal ignoring budget (≈ all raw → max tokens)
  // Upper bound on λ: total all-raw value guarantees the cost term dominates.
  let maxValue = 0;
  for (let pos = 0; pos < M; pos++) maxValue += unitsAt[pos][0].value;
  const muHi = Math.max(1, maxValue);
  const folded = solveAt(muHi); // most-folded feasible frontier

  if (atZero.tokens <= budgetTokens) return finalize(atZero, false);
  if (folded.tokens > budgetTokens) return finalize(folded, true);

  let lo = 0;
  let hi = muHi;
  let result = folded;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const r = solveAt(mid);
    if (r.tokens <= budgetTokens) {
      hi = mid;
      result = r;
    } else {
      lo = mid;
    }
  }
  return finalize(result, false);

  function finalize(r: { tokens: number; value: number; res: Map<ChunkId, number> }, over: boolean): SolveResult {
    return { resolutions: r.res, tokens: r.tokens, value: r.value, overBudget: over };
  }
}
