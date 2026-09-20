import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { CanonicalSummaryForest } from './kv-unified.js';
import {
  ExactKvUnifiedPolicySolver,
  budgetPenalty,
  fidelityLeafLoss,
  normalizePolicy,
  type ExactPolicySolveOptions,
  type ExactPolicySolveResult,
} from './kv-unified-policy.js';

export interface HysteresisCertificate {
  readonly kind: 'budget-tangent';
  readonly lowerBound: number;
  readonly carriedScore: number;
  readonly maxImprovement: number;
  readonly adoptEpsilon: number;
  readonly passes: number;
  readonly nodes: number;
  readonly roundoffAllowance: number;
}

export type CertifiedPolicyResult = Extract<ExactPolicySolveResult, { feasible: true }> & {
  readonly certificate: HysteresisCertificate;
};

interface LinearNode {
  readonly tokens: number;
  readonly fidelity: number;
  readonly children: readonly number[];
  readonly canExpand: boolean;
  readonly matches: boolean;
}

/** Try to prove that the existing hysteresis rule selects the carried cut.
 *
 * Convexity gives B(T) >= B(t) + B'(t)(T-t). A linear forest solve then gives
 * L(t) = min_cuts(F + B'(t) T) + B(t) - B'(t)t <= min_feasible(F+B).
 * The linear solve may include over-budget cuts: relaxing the hard wall only
 * lowers L. Cache/continuity penalties remain present and nonnegative.
 *
 * This is a sufficient certificate, not an approximate optimizer. No bucket
 * errors or policy deadlines enter the proof. Failed certificates fall back
 * to the existing solver. The prototype deliberately declines internal holes,
 * ambiguous extension cuts, and nonzero carried cache churn.
 */
export function certifyCarriedLayout(
  inputs: PickerInputs,
  forest: CanonicalSummaryForest,
  options: ExactPolicySolveOptions,
): CertifiedPolicyResult | null {
  const epsilon = options.adoptEpsilon ?? 0;
  if (!options.presentation || !Number.isFinite(epsilon) || epsilon <= 0 ||
      !Number.isFinite(options.maxTokens) || options.maxTokens < 0) return null;
  const policy = normalizePolicy(options.policy);
  const leaves = forest.orderedLeaves();
  const chunks = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
  const newest = Math.max(0, ...inputs.chunks.map((chunk) => chunk.sequence));
  const frontier = new Map<ChunkId, number>();
  const leafFidelity = new Map<ChunkId, number>();
  for (const leaf of leaves) {
    const previous = options.presentation.leaves.get(leaf.id);
    // Hysteresis chooses the best matching extension. Only certify when the
    // unchanged presentation has a unique extension (new leaves forced raw).
    if (!previous && leaf.allowedLevels.some((level) => level !== 0)) return null;
    const level = previous?.level ?? 0;
    if (!leaf.allowedLevels.includes(level)) return null;
    const summaryId = level === 0 ? undefined : leaf.summaryIds.find(
      (id) => forest.summary(id)!.level === level,
    );
    const hash = level === 0 ? `raw:${leaf.id}` : `summary:${summaryId}`;
    if (previous && hash !== previous.repHash) return null;
    frontier.set(leaf.id, level);
    leafFidelity.set(leaf.id, leaf.externallyAccounted ? 0 :
      fidelityLeafLoss(chunks.get(leaf.id)!, 1, newest, policy));
  }

  // Compile the ownership tree once; every subsequent linear solve is an
  // array pass. Chronological gaps do not affect additive F/T costs.
  const nodes: LinearNode[] = [];
  const addLeaf = (id: string): number => {
    const leaf = forest.leaf(id)!;
    nodes.push({
      tokens: leaf.allowedLevels.includes(0)
        ? (leaf.externallyAccounted ? 0 : leaf.rawTokens) : Infinity,
      fidelity: 0, children: [], canExpand: false,
      matches: frontier.get(id) === 0,
    });
    return nodes.length - 1;
  };
  let unsupported = false;
  const addSummary = (id: string): number => {
    const summary = forest.summary(id)!;
    const children = [
      ...summary.directLeafIds.map(addLeaf),
      ...summary.childSummaryIds.map(addSummary),
    ];
    let participants = 0;
    let live = 0;
    let fidelity = 0;
    let matches = true;
    for (const leafId of summary.leafIds) {
      const leaf = forest.leaf(leafId)!;
      if (leaf.externallyAccounted) continue;
      live++;
      if (leaf.allowedLevels.includes(summary.level)) {
        participants++;
        fidelity += leafFidelity.get(leafId)! * summary.level;
        matches &&= frontier.get(leafId) === summary.level;
      }
    }
    if (participants > 0 && participants < live) unsupported = true;
    const canSelect = participants > 0 && participants === live;
    nodes.push({
      tokens: canSelect ? summary.recallTokens : Infinity,
      fidelity, children, canExpand: true,
      matches: (canSelect && matches) || children.every((index) => nodes[index].matches),
    });
    return nodes.length - 1;
  };
  const roots = forest.roots.map((root) =>
    root.kind === 'leaf' ? addLeaf(root.id) : addSummary(root.id),
  );
  if (unsupported || roots.some((index) => !nodes[index].matches)) return null;
  const renderedTokens = forest.tokensForFrontier(frontier);
  if (renderedTokens > options.maxTokens) return null;

  const scored = new ExactKvUnifiedPolicySolver(inputs, forest).scoreCandidates(
    [{ frontier, renderedTokens }], options,
    { statesVisited: 0, candidatesGenerated: 1, maxCandidatesAtState: 1, terminalCandidates: 1 },
    // The structurally checked carried cut is a feasibility witness. The
    // scorer only checks feasible; it does not use the minimum-token floor.
    { feasible: true, floorTokens: renderedTokens, frontier },
  );
  if (!scored.feasible || scored.selected.continuityLoss !== 0 ||
      scored.selected.cacheChurn !== 0) return null;
  // Both true floors are now exactly zero. Scoring this one candidate cannot
  // renormalize either penalty or hide a floor witness.

  const low = policy.budgetLowRatio * options.maxTokens;
  const high = policy.budgetHighRatio * options.maxTokens;
  const underScale = low > 0 ? low : 1;
  const overScale = options.maxTokens > high ? options.maxTokens - high : 1;
  const costs = new Float64Array(nodes.length);
  const tokens = new Float64Array(nodes.length);
  let bestBound = -Infinity;
  let maxRoundoff = 0;
  let left = 0;
  let right = options.maxTokens;
  let tangentAt = renderedTokens;
  // A fixed number of bound-improvement passes is not a solve deadline:
  // every early return is proved, and exhaustion falls through to Pareto.
  for (let pass = 1; pass <= 32; pass++) {
    const slope = tangentAt < low
      ? -2 * policy.budgetUnderLambda * (low - tangentAt) / underScale ** 2
      : tangentAt > high
        ? 2 * policy.budgetOverLambda * (tangentAt - high) / overScale ** 2 : 0;
    let magnitude = 1;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const selected = Number.isFinite(node.tokens) ? node.fidelity + slope * node.tokens : Infinity;
      let expanded = node.canExpand ? 0 : Infinity;
      let expandedTokens = 0;
      for (const child of node.children) {
        expanded += costs[child];
        expandedTokens += tokens[child];
      }
      const select = selected < expanded;
      costs[i] = select ? selected : expanded;
      tokens[i] = select ? node.tokens : expandedTokens;
      if (Number.isFinite(selected)) magnitude += Math.abs(node.fidelity) + Math.abs(slope * node.tokens);
    }
    const fixed = inputs.headTokens + inputs.tailTokens;
    let linearCost = slope * fixed;
    let linearTokens = fixed;
    for (const root of roots) {
      linearCost += costs[root];
      linearTokens += tokens[root];
    }
    const intercept = budgetPenalty(tangentAt, options.maxTokens, policy) - slope * tangentAt;
    // Conservative floating-point guard, including accumulation/cancellation.
    // This is separate from the Pareto score bound (which includes hysteresis).
    const roundoff = 64 * Number.EPSILON * (nodes.length + 1) *
      (magnitude + Math.abs(linearCost) + Math.abs(intercept) + Math.abs(scored.selected.score));
    maxRoundoff = Math.max(maxRoundoff, roundoff);
    const bound = linearCost + intercept - roundoff;
    if (Number.isFinite(bound)) bestBound = Math.max(bestBound, bound);
    if (scored.selected.score - bestBound <= epsilon) {
      return {
        ...scored,
        enumeration: { ...scored.enumeration, statesVisited: pass * nodes.length },
        certificate: {
          kind: 'budget-tangent', lowerBound: bestBound,
          carriedScore: scored.selected.score,
          maxImprovement: scored.selected.score - bestBound,
          adoptEpsilon: epsilon, passes: pass, nodes: nodes.length,
          roundoffAllowance: maxRoundoff,
        },
      };
    }
    if (linearTokens > tangentAt) left = tangentAt;
    else right = tangentAt;
    const next = (left + right) / 2;
    if (next === tangentAt) break;
    tangentAt = next;
  }
  return null;
}
