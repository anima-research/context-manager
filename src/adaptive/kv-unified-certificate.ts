import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { CanonicalSummaryForest } from './kv-unified.js';
import { TerminalPolicyEvaluator } from './kv-unified-terminal.js';
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
  /** Independent, constraint-forced holes emitted beside a selected summary. */
  readonly selectedChildren: readonly number[];
  readonly canExpand: boolean;
  readonly id: string;
  readonly level: number;
  readonly leafIds: readonly string[];
  readonly canSelect: boolean;
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
 * to the existing solver. Internal holes use the canonical select-participants
 * plus expand-holes recurrence. Excessive context/extension graphs and nonzero
 * carried cache churn decline; no eligibility or adoption rule is relaxed.
 */
export function certifyCarriedLayout(
  inputs: PickerInputs,
  forest: CanonicalSummaryForest,
  options: ExactPolicySolveOptions,
): CertifiedPolicyResult | null {
  const epsilon = options.adoptEpsilon ?? 0;
  if (!options.presentation || !Number.isFinite(epsilon) || epsilon <= 0 ||
      !Number.isFinite(options.maxTokens) || options.maxTokens < 0 ||
      forest.constraintConflicts.length > 0) return null;
  const policy = normalizePolicy(options.policy);
  const leaves = forest.orderedLeaves();
  // Bound recursive context construction independently of the node-count cap.
  // Decline deep ownership chains before entering the recursive compiler.
  if (leaves.some((leaf) => leaf.summaryIds.length > 256)) return null;
  const chunks = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
  const newest = inputs.chunks.reduce((latest, chunk) => Math.max(latest, chunk.sequence), 0);
  // Old leaves are fixed at their accepted level. New leaves (no accepted
  // representation — appended since the presentation) are free: hysteresis
  // keeps the accepted layout under the BEST extension over them, so every
  // valid extension is enumerated below and scored exactly. A fresh L1 over
  // appended messages is the common case (one solve per mint otherwise).
  const fixed = new Map<ChunkId, number>();
  const leafFidelity = new Map<ChunkId, number>();
  for (const leaf of leaves) {
    const previous = options.presentation.leaves.get(leaf.id);
    if (previous) {
      if (!leaf.allowedLevels.includes(previous.level)) return null;
      const summaryId = previous.level === 0 ? undefined : leaf.summaryIds.find(
        (id) => forest.summary(id)!.level === previous.level,
      );
      const hash = previous.level === 0 ? `raw:${leaf.id}` : `summary:${summaryId}`;
      if (hash !== previous.repHash) return null;
      fixed.set(leaf.id, previous.level);
    } else if (!leaf.allowedLevels.includes(0) && leaf.allowedLevels.length === 0) return null;
    leafFidelity.set(leaf.id, leaf.externallyAccounted ? 0 :
      fidelityLeafLoss(chunks.get(leaf.id)!, 1, newest, policy));
  }

  // Compile the canonical cut recurrence into an active-leaf context DAG.
  // Selecting a summary covers exactly its eligible participants and expands
  // its forced holes. Expanding covers all active children. These disjoint
  // branches are the same as enumerateExactCuts/minimumTokens, so a linear
  // minimum is valid even with nested holes or chronological ownership gaps.
  const nodes: LinearNode[] = [];
  const leafNodes = new Map<string, number>();
  const summaryNodes = new Map<string, number>();
  const contextLimit = 4 * (leaves.length + inputs.summaries.size) + 256;
  const contextLimitReached = new Error('certificate context limit');
  // Node count alone does not bound large active sets or repeated long IDs.
  // Charge every attempted context, including memo hits, before allocating
  // its JSON key, sets or child lists. Partition storage is linear in these
  // memberships; JSON escaping uses at most six units per identifier unit.
  const membershipLimit = 32 * (leaves.length + inputs.summaries.size) + 1024;
  const identifierLimit = 32 * (leaves.length + inputs.summaries.size +
    leaves.reduce((sum, leaf) => sum + leaf.id.length, 0) +
    [...inputs.summaries.keys()].reduce((sum, id) => sum + id.length, 0)) + 1024;
  let memberships = 0, identifierUnits = 0;
  const addNode = (node: LinearNode): number => {
    if (nodes.length >= contextLimit) throw contextLimitReached;
    nodes.push(node);
    return nodes.length - 1;
  };
  const addLeaf = (id: string): number => {
    const known = leafNodes.get(id);
    if (known !== undefined) return known;
    const leaf = forest.leaf(id)!;
    const index = addNode({
      tokens: leaf.allowedLevels.includes(0)
        ? (leaf.externallyAccounted ? 0 : leaf.rawTokens) : Infinity,
      fidelity: 0, children: [], selectedChildren: [], canExpand: false,
      id, level: 0, leafIds: [id], canSelect: leaf.allowedLevels.includes(0),
    });
    leafNodes.set(id, index);
    return index;
  };
  const addChildren = (id: string, activeIds: readonly string[]): number[] => {
    const summary = forest.summary(id)!;
    const active = new Set(activeIds);
    const children = summary.directLeafIds.filter((id) => active.has(id)).map(addLeaf);
    for (const childId of summary.childSummaryIds) {
      const childActive = forest.summary(childId)!.leafIds.filter((id) => active.has(id));
      if (childActive.length > 0) children.push(addSummary(childId, childActive));
    }
    return children;
  };
  const addSummary = (id: string, activeIds: readonly string[]): number => {
    memberships += activeIds.length;
    if (memberships > membershipLimit) throw contextLimitReached;
    identifierUnits += id.length + 1;
    if (identifierUnits > identifierLimit) throw contextLimitReached;
    for (const leafId of activeIds) {
      identifierUnits += leafId.length + 1;
      if (identifierUnits > identifierLimit) throw contextLimitReached;
    }
    const key = JSON.stringify([id, activeIds]);
    const known = summaryNodes.get(key);
    if (known !== undefined) return known;
    const summary = forest.summary(id)!;
    const children = addChildren(id, activeIds);
    const participants = activeIds.filter((id) => forest.leaf(id)!.allowedLevels.includes(summary.level));
    const participantSet = new Set(participants);
    const holes = activeIds.filter((id) => !participantSet.has(id));
    const canSelect = participants.length > 0;
    const selectedChildren = canSelect && holes.length > 0 ? addChildren(id, holes) : [];
    const fidelity = participants.reduce((sum, id) => sum + leafFidelity.get(id)! * summary.level, 0);
    const index = addNode({
      tokens: canSelect ? summary.recallTokens : Infinity,
      fidelity, children, selectedChildren, canExpand: true,
      id: summary.id, level: summary.level, leafIds: participants, canSelect,
    });
    summaryNodes.set(key, index);
    return index;
  };
  let roots: number[];
  try {
    roots = forest.roots.map((root) => root.kind === 'leaf' ? addLeaf(root.id)
      : addSummary(root.id, forest.summary(root.id)!.leafIds));
  } catch (error) {
    if (error === contextLimitReached) return null;
    throw error;
  }

  // Enumerate every cut that keeps each old leaf at its accepted level. A node
  // may be selected only when all of its old leaves are accepted at exactly
  // its level (and every new leaf allows it); otherwise it must expand.
  const EXTENSION_CAP = 256;
  type Assignment = Array<[ChunkId, number]>;
  const cutMemo = new Map<number, Assignment[] | null>();
  const combineChildren = (children: readonly number[], initial: Assignment = []): Assignment[] | null => {
    let combinations = [initial];
    for (const child of children) {
      const childCuts = cuts(child);
      if (childCuts === null) return null;
      const next: Assignment[] = [];
      for (const prefix of combinations) for (const suffix of childCuts) {
        next.push([...prefix, ...suffix]);
        if (next.length > EXTENSION_CAP) return null;
      }
      combinations = next;
    }
    return combinations;
  };
  const cuts = (index: number): Assignment[] | null => {
    if (cutMemo.has(index)) return cutMemo.get(index)!;
    const node = nodes[index];
    if (!node.canExpand) {
      const id = node.leafIds[0]!;
      const level = fixed.get(id);
      if (level !== undefined) return level === 0 ? [[[id, 0]]] : [];
      return forest.leaf(id)!.allowedLevels.includes(0) ? [[[id, 0]]] : [];
    }
    const out: Assignment[] = [];
    const selectable = node.canSelect && node.leafIds.every((id) => {
      const leaf = forest.leaf(id)!;
      if (leaf.externallyAccounted) return true;
      const level = fixed.get(id);
      return level === undefined ? leaf.allowedLevels.includes(node.level) : level === node.level;
    });
    if (selectable) {
      const selected = combineChildren(node.selectedChildren,
        node.leafIds.map((id) => [id, node.level] as [ChunkId, number]));
      if (selected === null) return null;
      out.push(...selected);
    }
    const expanded = combineChildren(node.children);
    if (expanded === null) return null;
    out.push(...expanded);
    const result = out.length > EXTENSION_CAP ? null : out;
    cutMemo.set(index, result);
    return result;
  };
  let extensions: Assignment[];
  if (fixed.size === leaves.length) {
    // There is exactly one matching frontier. Validate its complete coverage
    // on today's graph before materializing it once; token accounting alone
    // would wrongly admit arbitrary mixed cuts through unconstrained siblings.
    const matches = new Uint8Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const selected = node.canSelect && node.leafIds.every((id) => fixed.get(id) === node.level)
        && node.selectedChildren.every((child) => matches[child]);
      const expanded = node.canExpand && node.children.every((child) => matches[child]);
      matches[i] = selected || expanded ? 1 : 0;
    }
    if (roots.some((root) => !matches[root])) return null;
    extensions = [[...fixed]];
  } else {
    const combined = combineChildren(roots);
    if (combined === null) return null;
    extensions = combined;
  }
  const candidates = extensions.map((assignment) => {
    const frontier = new Map<ChunkId, number>(assignment);
    for (const leaf of leaves) if (!frontier.has(leaf.id)) frontier.set(leaf.id, 0);
    return { frontier, renderedTokens: forest.tokensForFrontier(frontier) };
  }).filter((candidate) => candidate.renderedTokens <= options.maxTokens);
  if (candidates.length === 0) return null;
  const witness = candidates.reduce((best, candidate) => candidate.renderedTokens < best.renderedTokens ? candidate : best);

  // Score through the same terminal evaluator the solver uses. It computes
  // churn from emitted unit codes, so no SummaryTree or rendered layout is
  // built here; the old exact scorer rebuilt both on every compile.
  // Every enumerated cut is structurally valid under the wall (witness:
  // ${witness.renderedTokens} tokens), so no minimum-token floor is needed.
  void witness;
  const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
  const unscored = candidates.map((candidate) => {
    const byLevel = new Map<number, ChunkId[]>();
    for (const [id, level] of candidate.frontier) {
      let ids = byLevel.get(level);
      if (!ids) byLevel.set(level, ids = []);
      ids.push(id);
    }
    return evaluator.candidate({
      forEachAssignment(visit) { for (const [level, ids] of byLevel) visit(ids, level); },
    }, candidate.renderedTokens);
  });
  const scored = new ExactKvUnifiedPolicySolver(inputs, forest).scorePreparedCandidates(
    unscored, options,
    { statesVisited: 0, candidatesGenerated: candidates.length, maxCandidatesAtState: candidates.length, terminalCandidates: candidates.length },
    evaluator.cacheRelevant,
  );
  // Every enumerated cut matches the accepted presentation, so the policy's
  // carried candidate is exactly `scored.selected`. Carried continuity is zero
  // by construction; churn must be zero too, else the global floors are not
  // proven zero and this single-family scoring could renormalize.
  if (!scored.feasible || scored.selected.continuityLoss !== 0 ||
      scored.candidates.some((candidate) => candidate.cacheChurn !== 0)) return null;
  const renderedTokens = scored.selected.renderedTokens;
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
      let selected = Number.isFinite(node.tokens) ? node.fidelity + slope * node.tokens : Infinity;
      let selectedTokens = node.tokens;
      for (const child of node.selectedChildren) {
        selected += costs[child];
        selectedTokens += tokens[child];
      }
      let expanded = node.canExpand ? 0 : Infinity;
      let expandedTokens = 0;
      for (const child of node.children) {
        expanded += costs[child];
        expandedTokens += tokens[child];
      }
      const select = selected < expanded;
      costs[i] = select ? selected : expanded;
      tokens[i] = select ? selectedTokens : expandedTokens;
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
