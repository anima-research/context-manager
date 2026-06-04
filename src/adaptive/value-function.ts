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
import { nodeTokens } from './summary-tree.js';

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
}

export class ValueFunction {
  private readonly halfLife: number;
  private readonly minWeight: number;
  private readonly salienceFn: (sequence: number) => number;
  private readonly nodeWeightMemo = new Map<string, number>();

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
  }

  /** Recency × salience weight for a chunk at the given source sequence. */
  weight(sequence: number): number {
    const age = Math.max(0, this.newestSequence - sequence);
    const recency = Math.pow(0.5, age / this.halfLife);
    return Math.max(this.minWeight, recency) * this.salienceFn(sequence);
  }

  /** Mean leaf weight over a node's covered leaves (memoized for summaries). */
  private nodeWeight(node: TreeNode, tree: SummaryTree): number {
    if (node.kind === 'leaf') return this.weight(node.sequence);
    const memo = this.nodeWeightMemo.get(node.id);
    if (memo !== undefined) return memo;
    let sum = 0;
    let count = 0;
    for (const leafId of node.leafChunkIds) {
      const leaf = tree.leaf(leafId);
      if (!leaf) continue;
      sum += this.weight(leaf.sequence);
      count++;
    }
    const w = count > 0 ? sum / count : this.minWeight;
    this.nodeWeightMemo.set(node.id, w);
    return w;
  }

  /** Value of rendering a node collapsed: weight × rendered tokens. */
  nodeValue(node: TreeNode, tree: SummaryTree): number {
    return this.nodeWeight(node, tree) * nodeTokens(node);
  }
}
