/**
 * Best-fit frontier solver (docs §3, §6, §11 step 4).
 *
 * Chooses a frontier (antichain cut) over the summary forest that maximizes
 * recency-weighted value subject to a token budget — optimal tree pruning under
 * a knapsack budget. Solved by Lagrangian relaxation on a budget multiplier μ:
 * for a given μ each node independently picks the higher-reward of
 *
 *     collapse:  value(node)        − μ · tokens(node)
 *     expand:    Σ children rewards          (recurse)
 *
 * computed bottom-up. Total cost is non-increasing in μ, so binary-searching μ
 * finds the smallest multiplier whose frontier fits the budget — i.e. the
 * frontier that fills the budget without exceeding it, folding lowest-weight
 * (oldest/least-salient) regions first and expanding again when budget returns
 * (bidirectional self-adjust). This is the doc's preferred approach (§6); it is
 * a relaxation, so it can leave a small duality gap vs an exact bucketized DP —
 * acceptable for v1, revisit if integration shows under-fill.
 *
 * The KV-stability term (§4) is layered on top in a later step; this solver is
 * the pure budget-optimal core. Deterministic (no Date.now/Math.random).
 */

import type { ChunkId } from './folding-strategy.js';
import type { SummaryTree, TreeNode } from './summary-tree.js';
import type { ValueFunction } from './value-function.js';

export interface SolveParams {
  /** Token budget for the (foldable) content this tree represents. */
  budgetTokens: number;
  value: ValueFunction;
  /**
   * Whether a chunk may be folded away. A non-foldable chunk renders raw and
   * blocks the collapse of any summary covering it (so pins / fixed ranges stay
   * raw). Default: everything foldable.
   */
  isFoldable?: (chunkId: ChunkId) => boolean;
  /** Binary-search iterations on the Lagrange multiplier. Default 60. */
  muIterations?: number;
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

type Choice = 'raw' | 'collapse' | 'expand';
interface Eval {
  reward: number;
  value: number;
  cost: number;
  choice: Choice;
}

export function solveFrontier(tree: SummaryTree, params: SolveParams): SolveResult {
  const { budgetTokens, value } = params;
  const isFoldable = params.isFoldable ?? (() => true);
  const iterations = params.muIterations ?? 60;
  const roots = tree.roots();

  const collapsibleMemo = new Map<string, boolean>();
  const collapsible = (id: string, leafIds: ChunkId[]): boolean => {
    let c = collapsibleMemo.get(id);
    if (c === undefined) {
      c = leafIds.every(isFoldable);
      collapsibleMemo.set(id, c);
    }
    return c;
  };

  const evalNode = (node: TreeNode, mu: number): Eval => {
    if (node.kind === 'leaf') {
      const v = value.nodeValue(node, tree);
      const cost = node.rawTokens;
      return { reward: v - mu * cost, value: v, cost, choice: 'raw' };
    }
    const collapseV = value.nodeValue(node, tree);
    const collapse: Eval = {
      reward: collapseV - mu * node.recallTokens,
      value: collapseV,
      cost: node.recallTokens,
      choice: 'collapse',
    };
    const children = tree.children(node);
    if (children.length === 0) return collapse;

    let reward = 0;
    let val = 0;
    let cost = 0;
    for (const ch of children) {
      const e = evalNode(ch, mu);
      reward += e.reward;
      val += e.value;
      cost += e.cost;
    }
    const expand: Eval = { reward, value: val, cost, choice: 'expand' };
    if (!collapsible(node.id, node.leafChunkIds)) return expand;
    return collapse.reward >= expand.reward ? collapse : expand;
  };

  const totalCost = (mu: number): number => {
    let c = 0;
    for (const r of roots) c += evalNode(r, mu).cost;
    return c;
  };

  // Bracket μ: cost(0) = all raw (max); grow μ until cost bottoms out (the
  // most-folded feasible frontier).
  const maxCost = totalCost(0);
  let muHi = 1;
  let prevCost = totalCost(muHi);
  while (muHi <= 1e9) {
    const nextCost = totalCost(muHi * 2);
    muHi *= 2;
    if (nextCost >= prevCost) break; // cost stopped decreasing → bottomed out
    prevCost = nextCost;
  }
  const minCost = totalCost(muHi);

  if (maxCost <= budgetTokens) return assignAt(0); // fits fully raw
  if (minCost > budgetTokens) {
    const res = assignAt(muHi);
    res.overBudget = true;
    return res;
  }

  // Smallest μ whose frontier fits the budget.
  let lo = 0;
  let hi = muHi;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (totalCost(mid) <= budgetTokens) hi = mid;
    else lo = mid;
  }
  return assignAt(hi);

  function assignAt(mu: number): SolveResult {
    const resolutions = new Map<ChunkId, number>();
    const walk = (node: TreeNode): void => {
      const e = evalNode(node, mu);
      if (node.kind === 'leaf') {
        resolutions.set(node.chunkId, 0);
        return;
      }
      if (e.choice === 'collapse') {
        for (const leafId of node.leafChunkIds) resolutions.set(leafId, node.level);
      } else {
        for (const ch of tree.children(node)) walk(ch);
      }
    };
    let tokens = 0;
    let val = 0;
    for (const r of roots) {
      const e = evalNode(r, mu);
      tokens += e.cost;
      val += e.value;
      walk(r);
    }
    return { resolutions, tokens, value: val, overBudget: false };
  }
}
