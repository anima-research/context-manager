/**
 * Value function for the V2 best-fit frontier solver (docs §5, §11 step 3).
 *
 * `val(n)` = the information retained by rendering node `n`, modelled as
 * recency-weighted rendered tokens:
 *
 *     value(node) = weight(node) × tokens(node)
 *
 * where `tokens` is the rendered size (raw for a leaf, recall-pair for a
 * summary) and `weight` is a recency multiplier (newer = higher) times an
 * optional salience multiplier. Because a recall pair renders far fewer tokens
 * than its raw leaves, collapsing a region loses value proportional to its
 * weight — so under budget pressure the solver folds the lowest-weight (oldest,
 * least-salient) regions first, and expands again when budget returns. This is
 * the "memory fading as a budget-pressure continuum" of §5, with no one-way
 * ratchet.
 *
 * The exact shape is the principal empirical knob (§9); this is the defensible
 * v1. The `salience` hook is the CM-ready seam (§11): a future Context Manager
 * agent can inject per-range importance without touching the solver.
 *
 * Pure and deterministic.
 */

import type { SummaryTree, TreeNode } from './summary-tree.js';

export interface ValueParams {
  /** Recency half-life as a FRACTION of history length (the default mode):
   *  effective half-life = fraction × newestSequence, so the recency curve
   *  spans the actual history regardless of how long it is. Default 0.25.
   *
   *  This matters: an absolute half-life devalues everything past a few
   *  half-lives to `minWeight`, so on a long history the solver treats old
   *  content as worthless and won't spend surplus budget un-folding it — i.e. a
   *  budget increase fails to take effect. Scaling to history avoids that. */
  recencyHalfLifeFraction?: number;
  /** Absolute recency half-life in chunk positions. Overrides the fraction when
   *  set. weight = 0.5^(age / halfLife), age measured from the newest chunk. */
  recencyHalfLifeChunks?: number;
  /** Floor so very old content keeps a little value (avoids 0). Default 0.01. */
  minWeight?: number;
  /** CM-ready salience hook: a multiplier for a chunk by its source sequence.
   *  Default `() => 1` (recency only). Must be pure. */
  salience?: (sequence: number) => number;
  /** Per-level information-retention factor: a summary at level L retains
   *  `foldFidelity^L` of the recency-weighted information of its leaves (raw
   *  retains all). Concave in fold depth — this is what makes the solver
   *  produce a smooth resolution gradient (raw → L1 → L2 → L3 by age) instead
   *  of a raw↔deepest-fold cliff. Default 0.6. */
  foldFidelity?: number;
}

export class ValueFunction {
  private readonly halfLife: number;
  private readonly minWeight: number;
  private readonly salienceFn: (sequence: number) => number;
  private readonly foldFidelity: number;
  private readonly sumInfoMemo = new Map<string, number>();

  /**
   * @param newestSequence source sequence of the newest chunk (age reference).
   */
  constructor(
    private readonly newestSequence: number,
    params: ValueParams = {},
  ) {
    this.halfLife = params.recencyHalfLifeChunks
      ?? Math.max(1, (params.recencyHalfLifeFraction ?? 0.25) * newestSequence);
    this.minWeight = params.minWeight ?? 0.01;
    this.salienceFn = params.salience ?? (() => 1);
    this.foldFidelity = params.foldFidelity ?? 0.6;
  }

  /** Recency × salience weight for a chunk at the given source sequence. */
  weight(sequence: number): number {
    const age = Math.max(0, this.newestSequence - sequence);
    const recency = Math.pow(0.5, age / this.halfLife);
    return Math.max(this.minWeight, recency) * this.salienceFn(sequence);
  }

  /**
   * Recency-weighted "raw-token information" under a node = Σ weight × rawTokens
   * over its covered leaves (memoized). This is the verbatim information content
   * the region would carry if rendered raw, recency-weighted. Keeping value on
   * the token scale (not just weight) is what keeps the KV term λ calibrated.
   */
  private sumLeafInfo(node: TreeNode, tree: SummaryTree): number {
    if (node.kind === 'leaf') return this.weight(node.sequence) * node.rawTokens;
    const memo = this.sumInfoMemo.get(node.id);
    if (memo !== undefined) return memo;
    let sum = 0;
    for (const leafId of node.leafChunkIds) {
      const leaf = tree.leaf(leafId);
      if (leaf) sum += this.weight(leaf.sequence) * leaf.rawTokens;
    }
    this.sumInfoMemo.set(node.id, sum);
    return sum;
  }

  /**
   * Value of rendering a node = recency-weighted information RETAINED at its
   * fold depth — concave in depth, but on the token scale. A raw leaf retains
   * all of its weighted information (weight × rawTokens); a level-L summary
   * retains `foldFidelity^L` of its leaves' weighted raw-token information,
   * while costing only its (small) recall-pair tokens. Concavity makes
   * intermediate levels win at intermediate recency — a smooth raw → L1 → L2 →
   * L3 gradient — instead of collapsing every region to raw or to the deepest
   * fold. Cost (rendered tokens) is handled separately by the solver.
   */
  nodeValue(node: TreeNode, tree: SummaryTree): number {
    if (node.kind === 'leaf') return this.weight(node.sequence) * node.rawTokens;
    return Math.pow(this.foldFidelity, node.level) * this.sumLeafInfo(node, tree);
  }
}
