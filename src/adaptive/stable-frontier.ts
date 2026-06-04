/**
 * KV-stable best-fit frontier (docs §4, §4.1, §11 step 5).
 *
 * Layers the KV-cache-stability term onto the budget-optimal solver. The full
 * objective is
 *
 *     maximize  Σ value(n)  −  λ · KVcost(F, F_prev)
 *
 * where KVcost depends only on the EARLIEST position at which F diverges from
 * the previously-rendered frontier F_prev — every token after that point is
 * recomputed by the provider (§4).
 *
 * Because KV cost is governed by that single divergence point, the solve
 * decomposes (§4.1, "longest stable prefix"): for each candidate boundary S we
 *
 *   - freeze F = F_prev for the rendered units before S (byte-identical →
 *     cached, no recompute), consuming their tokens from the budget;
 *   - re-solve the budget-optimal frontier for the suffix at/after S;
 *   - score it `prefixValue + suffixValue − λ · suffixTokens`.
 *
 * The best S wins. Candidates are F_prev's own rendered-unit seams (so a frozen
 * prefix never splits a fold), clustered near the tail — plus S=0 (full
 * re-solve, pay full KV cost) as the escape hatch that lets a real budget
 * increase self-adjust, and S=end (freeze everything → no churn).
 *
 * λ trades optimality against stickiness. λ=0 reproduces the pure budget-optimal
 * solve. λ→∞ never changes anything. The load-bearing risk (docs §11): too-high
 * λ rejects even cheap near-tail re-solves and silently reproduces V1's "budget
 * increase has no effect" bug — guarded by a test.
 *
 * Pure and deterministic. Assumes the inputs are the foldable middle (no
 * head/tail blocks); the caller subtracts those and passes the middle budget.
 */

import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';
import { SummaryTree } from './summary-tree.js';
import type { SummaryEntry } from '../types/strategy.js';
import type { ValueFunction } from './value-function.js';
import { solveFrontier, type SolveResult } from './best-fit-solver.js';
import { renderLayout, type RenderedUnit, type Frontier } from './render-offsets.js';

export interface StableSolveParams {
  /** Previous committed frontier (F_prev) — resolutions from the last compile. */
  previous: Frontier;
  budgetTokens: number;
  value: ValueFunction;
  /** KV-stability weight (value-tokens per recomputed cache-token). 0 = pure
   *  budget-optimal; higher = stickier prefix. */
  lambda: number;
  isFoldable?: (id: ChunkId) => boolean;
  /** Cap on near-tail candidate boundaries (plus full-resolve and no-change).
   *  Default 256. */
  candidateCap?: number;
  muIterations?: number;
  /** Smoothness weight γ for the per-suffix budget-optimal solves. */
  smoothness?: number;
}

export interface StableSolveResult {
  resolutions: Map<ChunkId, number>;
  tokens: number;
  value: number;
  /** Tokens recomputed vs F_prev (the cache invalidation), per the §4.1 proxy. */
  kvCost: number;
  /** Source sequence at/after which the frontier was re-optimized
   *  (= number of chunks when nothing changed). */
  boundarySequence: number;
  overBudget: boolean;
}

export function solveStableFrontier(
  inputs: PickerInputs,
  tree: SummaryTree,
  params: StableSolveParams,
): StableSolveResult {
  const { previous, budgetTokens, value, lambda } = params;
  const cap = params.candidateCap ?? 256;
  const numChunks = inputs.chunks.length;

  const prevLayout = renderLayout(inputs, tree, previous);
  const units = prevLayout.units;
  const numUnits = units.length;

  // Prefix value prefix-sum over F_prev's rendered units.
  const pv = new Array<number>(numUnits + 1).fill(0);
  for (let i = 0; i < numUnits; i++) pv[i + 1] = pv[i] + unitValue(units[i], tree, value);

  // Candidate boundary unit-indices: full-resolve (0), no-change (numUnits),
  // and the last `cap` seams near the tail.
  const candidates = new Set<number>([0, numUnits]);
  for (let j = Math.max(0, numUnits - cap); j <= numUnits; j++) candidates.add(j);

  let best: {
    boundary: number;
    score: number;
    suffix: SolveResult;
    prefixTokens: number;
    prefixValue: number;
  } | null = null;

  for (const j of candidates) {
    const prefixTokens = j < numUnits ? units[j].offset : prevLayout.totalTokens;
    if (prefixTokens > budgetTokens) continue; // can't freeze a prefix bigger than budget
    const boundary = j < numUnits ? unitStartSequence(units[j], tree) : numChunks;

    const suffixInputs = buildSuffixInputs(inputs, tree, boundary);
    const suffixTree = new SummaryTree(suffixInputs);
    const suffix = solveFrontier(suffixTree, {
      budgetTokens: budgetTokens - prefixTokens,
      value,
      isFoldable: params.isFoldable,
      iterations: params.muIterations,
      smoothness: params.smoothness,
    });

    const score = pv[j] + suffix.value - lambda * suffix.tokens;
    if (!best || score > best.score) {
      best = { boundary, score, suffix, prefixTokens, prefixValue: pv[j] };
    }
  }

  // best is always set: j=0 has prefixTokens 0 ≤ budget.
  const b = best!;
  const resolutions = new Map<ChunkId, number>();
  for (const c of inputs.chunks) {
    resolutions.set(
      c.id,
      c.sequence < b.boundary ? previous.get(c.id) ?? 0 : b.suffix.resolutions.get(c.id) ?? 0,
    );
  }

  return {
    resolutions,
    tokens: b.prefixTokens + b.suffix.tokens,
    value: b.prefixValue + b.suffix.value,
    kvCost: b.suffix.tokens,
    boundarySequence: b.boundary,
    overBudget: b.suffix.overBudget,
  };
}

// ---------------------------------------------------------------------------

function unitValue(u: RenderedUnit, tree: SummaryTree, value: ValueFunction): number {
  if (u.kind === 'raw') {
    const leaf = tree.leaf(u.key);
    return leaf ? value.nodeValue(leaf, tree) : 0;
  }
  if (u.kind === 'recall') {
    const node = tree.summary(u.key);
    return node ? value.nodeValue(node, tree) : 0;
  }
  return 0; // head / tail are fixed blocks
}

function unitStartSequence(u: RenderedUnit, tree: SummaryTree): number {
  if (u.kind === 'raw') return tree.leaf(u.key)?.sequence ?? 0;
  if (u.kind === 'recall') return tree.summary(u.key)?.firstSequence ?? 0;
  if (u.kind === 'head') return 0;
  return Number.MAX_SAFE_INTEGER; // tail
}

/**
 * Build PickerInputs over the suffix [S, end): chunks at sequence ≥ S, and only
 * summaries whose every leaf is also ≥ S. A summary straddling S is dropped and
 * its suffix leaves are detached (l1Id cleared) so they can only render raw —
 * folding them would require the frozen prefix leaves.
 */
function buildSuffixInputs(inputs: PickerInputs, tree: SummaryTree, S: number): PickerInputs {
  const chunks: PickerChunk[] = [];
  for (const c of inputs.chunks) {
    if (c.sequence < S) continue;
    const l1 = c.l1Id ? tree.summary(c.l1Id) : null;
    const straddles = l1 ? l1.firstSequence < S : false;
    chunks.push(straddles ? { ...c, l1Id: undefined } : c);
  }

  const summaries = new Map<string, SummaryEntry>();
  const recallPairTokens = new Map<string, number>();
  for (const [id, s] of inputs.summaries) {
    const node = tree.summary(id);
    if (node && node.firstSequence >= S) {
      summaries.set(id, s);
      const rp = inputs.recallPairTokens?.get(id);
      if (rp !== undefined) recallPairTokens.set(id, rp);
    }
  }

  return {
    chunks,
    summaries,
    recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
}
