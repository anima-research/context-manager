import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import type { PresentedLeaf } from './kv-unified-policy.js';
import { CanonicalSummaryForest, type CanonicalLeaf } from './kv-unified.js';
import { TerminalPolicyEvaluator, presentedLeavesByIndex } from './kv-unified-terminal.js';
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

export interface DagNode {
  tokens: number;
  fidelity: number;
  readonly children: readonly number[];
  /** Independent, constraint-forced holes emitted beside a selected summary. */
  readonly selectedChildren: readonly number[];
  readonly canExpand: boolean;
  readonly id: string;
  readonly level: number;
  readonly leafIds: readonly string[];
  canSelect: boolean;
  /** Leaf positions of a summary node's participants, null for a leaf node. */
  readonly participants: Int32Array | null;
  /** Leaf position of a leaf node, -1 for a summary node. */
  readonly leafIndex: number;
}

/** The certificate's context DAG for one ownership structure. Kept in the
 * reuse holder across compiles; `fidelity` is refreshed on every use. */
export interface CertificateDag {
  readonly ownership: object;
  leafObjects: readonly CanonicalLeaf[];
  readonly nodes: DagNode[];
  readonly roots: number[];
  readonly leafNode: Map<ChunkId, number>;
  /** Last compile's accepted-level check per leaf: the leaf object, the
   *  receipt entry it was checked against, and the level it fixed. A leaf
   *  seen again with the same objects passes with the same level. */
  fixed?: { leaves: CanonicalLeaf[]; previous: (PresentedLeaf | undefined)[]; level: Int32Array };
  /** The graph's edges and per-node constants as flat typed arrays, rebuilt
   *  when the node count changes (see `flatten`). */
  flat?: FlatDag;
}

/** The DAG's structure in CSR form: the per-pass walks, the fidelity refresh
 * and the coverage check touch only these arrays. Node order, child order and
 * participant order are the node objects' own, so every sum runs in the same
 * order as before. */
interface FlatDag {
  length: number;
  /** Per-node arrays hold `length + 1` or more entries; appended leaf nodes
   *  (see `reuseDag`) extend them in place. */
  childStart: Int32Array;
  readonly children: Int32Array;
  selectedStart: Int32Array;
  readonly selectedChildren: Int32Array;
  participantStart: Int32Array;
  readonly participants: Int32Array;
  /** -1 for a summary node. */
  leafIndex: Int32Array;
  level: Float64Array;
  canExpand: Uint8Array;
}

function grown<T extends Int32Array | Float64Array | Uint8Array>(array: T, needed: number): T {
  if (array.length >= needed) return array;
  const next = new (array.constructor as new (length: number) => T)(Math.max(needed, array.length * 2));
  next.set(array);
  return next;
}

function flatten(dag: CertificateDag): FlatDag {
  const nodes = dag.nodes;
  const flat = dag.flat;
  if (flat && flat.length === nodes.length) return flat;
  if (flat && flat.length < nodes.length) {
    // Nodes past the flattened length are ownerless leaves appended by
    // `reuseDag`: no edges, so only the per-node arrays extend.
    let leavesOnly = true;
    for (let i = flat.length; leavesOnly && i < nodes.length; i++) {
      const node = nodes[i];
      leavesOnly = node.participants === null && node.children.length === 0 && node.selectedChildren.length === 0;
    }
    if (leavesOnly) {
      const n = nodes.length;
      flat.childStart = grown(flat.childStart, n + 1);
      flat.selectedStart = grown(flat.selectedStart, n + 1);
      flat.participantStart = grown(flat.participantStart, n + 1);
      flat.leafIndex = grown(flat.leafIndex, n);
      flat.level = grown(flat.level, n);
      flat.canExpand = grown(flat.canExpand, n);
      const c = flat.childStart[flat.length], s = flat.selectedStart[flat.length], p = flat.participantStart[flat.length];
      for (let i = flat.length; i < n; i++) {
        flat.childStart[i + 1] = c; flat.selectedStart[i + 1] = s; flat.participantStart[i + 1] = p;
        flat.leafIndex[i] = nodes[i].leafIndex; flat.level[i] = nodes[i].level; flat.canExpand[i] = 0;
      }
      flat.length = n;
      return flat;
    }
  }
  const n = nodes.length;
  let childCount = 0, selectedCount = 0, participantCount = 0;
  for (const node of nodes) {
    childCount += node.children.length;
    selectedCount += node.selectedChildren.length;
    participantCount += node.participants?.length ?? 0;
  }
  const childStart = new Int32Array(n + 1), children = new Int32Array(childCount);
  const selectedStart = new Int32Array(n + 1), selectedChildren = new Int32Array(selectedCount);
  const participantStart = new Int32Array(n + 1), participants = new Int32Array(participantCount);
  const leafIndex = new Int32Array(n), level = new Float64Array(n), canExpand = new Uint8Array(n);
  let c = 0, s = 0, p = 0;
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    childStart[i] = c;
    for (const child of node.children) children[c++] = child;
    selectedStart[i] = s;
    for (const child of node.selectedChildren) selectedChildren[s++] = child;
    participantStart[i] = p;
    if (node.participants) { participants.set(node.participants, p); p += node.participants.length; }
    leafIndex[i] = node.leafIndex;
    level[i] = node.level;
    canExpand[i] = node.canExpand ? 1 : 0;
  }
  childStart[n] = c; selectedStart[n] = s; participantStart[n] = p;
  return dag.flat = { length: n, childStart, children, selectedStart, selectedChildren, participantStart, participants, leafIndex, level, canExpand };
}

function leafNodeFields(leaf: CanonicalLeaf): { tokens: number; canSelect: boolean } {
  const canSelect = leaf.allowedLevels.includes(0);
  return { tokens: canSelect ? (leaf.externallyAccounted ? 0 : leaf.rawTokens) : Infinity, canSelect };
}

/** Reuse a cached graph when the forest shares its ownership build and no
 * owned leaf object changed. Ownerless leaves that changed are patched in
 * place; appended ownerless leaves become new roots. */
function reuseDag(
  cache: CertificateDag | undefined,
  forest: CanonicalSummaryForest,
  leaves: readonly CanonicalLeaf[],
): CertificateDag | null {
  if (!cache || cache.ownership !== forest.ownership) return null;
  const previous = cache.leafObjects;
  if (leaves.length < previous.length) return null;
  for (let i = 0; i < previous.length; i++) {
    const leaf = leaves[i];
    if (leaf === previous[i]) continue;
    if (leaf.id !== previous[i].id || leaf.summaryIds.length > 0) return null;
    const index = cache.leafNode.get(leaf.id);
    if (index === undefined) return null;
    const node = cache.nodes[index];
    const fields = leafNodeFields(leaf);
    node.tokens = fields.tokens;
    node.canSelect = fields.canSelect;
  }
  for (let i = previous.length; i < leaves.length; i++) {
    const leaf = leaves[i];
    if (leaf.summaryIds.length > 0 || cache.leafNode.has(leaf.id)) return null;
    const fields = leafNodeFields(leaf);
    cache.nodes.push({
      tokens: fields.tokens, fidelity: 0, children: [], selectedChildren: [], canExpand: false,
      id: leaf.id, level: 0, leafIds: [leaf.id], canSelect: fields.canSelect, participants: null, leafIndex: i,
    });
    cache.leafNode.set(leaf.id, cache.nodes.length - 1);
    cache.roots.push(cache.nodes.length - 1);
  }
  cache.leafObjects = leaves;
  return cache;
}

/** Compile the canonical cut recurrence into an active-leaf context DAG.
 * Selecting a summary covers exactly its eligible participants and expands
 * its forced holes. Expanding covers all active children. These disjoint
 * branches are the same as enumerateExactCuts/minimumTokens, so a linear
 * minimum is valid even with nested holes or chronological ownership gaps.
 * Returns null when the context limits are exceeded. */
function buildDag(
  forest: CanonicalSummaryForest,
  leaves: readonly CanonicalLeaf[],
  inputs: PickerInputs,
): CertificateDag | null {
  const leafIndex = new Map<ChunkId, number>();
  for (let i = 0; i < leaves.length; i++) leafIndex.set(leaves[i].id, i);
  const nodes: DagNode[] = [];
  const leafNode = new Map<ChunkId, number>();
  // Fully owned contexts key by summary id, partial ones by a serialized id
  // list; separate tables, so no partial key can alias a summary id.
  const fullNodes = new Map<string, number>();
  const partialNodes = new Map<string, number>();
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
  const addNode = (node: DagNode): number => {
    if (nodes.length >= contextLimit) throw contextLimitReached;
    nodes.push(node);
    return nodes.length - 1;
  };
  const addLeaf = (id: string): number => {
    const known = leafNode.get(id);
    if (known !== undefined) return known;
    const leaf = forest.leaf(id)!;
    const fields = leafNodeFields(leaf);
    const index = addNode({
      tokens: fields.tokens, fidelity: 0, children: [], selectedChildren: [], canExpand: false,
      id, level: 0, leafIds: [id], canSelect: fields.canSelect, participants: null, leafIndex: leafIndex.get(id)!,
    });
    leafNode.set(id, index);
    return index;
  };
  const addChildren = (id: string, activeIds: readonly string[]): number[] => {
    const summary = forest.summary(id)!;
    // activeIds is always a subset of this summary's leaves, so equal length
    // means full ownership: every direct leaf and child summary is active and
    // the per-summary membership set (O(leaves) at every level) is skipped.
    if (activeIds.length === summary.leafIds.length) {
      const children = summary.directLeafIds.map(addLeaf);
      for (const childId of summary.childSummaryIds) {
        const child = forest.summary(childId)!;
        if (child.leafIds.length > 0) children.push(addSummary(childId, child.leafIds));
      }
      return children;
    }
    const active = new Set(activeIds);
    const children = summary.directLeafIds.filter((id) => active.has(id)).map(addLeaf);
    for (const childId of summary.childSummaryIds) {
      const childActive = forest.summary(childId)!.leafIds.filter((id) => active.has(id));
      if (childActive.length > 0) children.push(addSummary(childId, childActive));
    }
    return children;
  };
  const allowed = forest.allowedLevelMasks();
  const addSummary = (id: string, activeIds: readonly string[]): number => {
    memberships += activeIds.length;
    if (memberships > membershipLimit) throw contextLimitReached;
    identifierUnits += id.length + 1;
    if (identifierUnits > identifierLimit) throw contextLimitReached;
    for (const leafId of activeIds) {
      identifierUnits += leafId.length + 1;
      if (identifierUnits > identifierLimit) throw contextLimitReached;
    }
    const summary = forest.summary(id)!;
    // The active set is a subset of the summary's leaves; the full set (no
    // hole above it) keys by the id alone and tests participants by bit.
    const full = activeIds.length === summary.leafIds.length;
    const key = full ? id : JSON.stringify([id, activeIds]);
    const table = full ? fullNodes : partialNodes;
    const known = table.get(key);
    if (known !== undefined) return known;
    const children = addChildren(id, activeIds);
    let participants: readonly string[];
    let holes: readonly string[];
    if (full && summary.level < 31) {
      const indices = forest.leafIndicesOf(summary);
      const bit = 1 << summary.level;
      let count = 0;
      for (let k = 0; k < indices.length; k++) if (allowed[indices[k]] & bit) count++;
      participants = count === indices.length ? summary.leafIds
        : summary.leafIds.filter((_, k) => (allowed[indices[k]] & bit) !== 0);
      holes = count === indices.length ? [] : summary.leafIds.filter((_, k) => (allowed[indices[k]] & bit) === 0);
    } else {
      participants = activeIds.filter((id) => forest.leaf(id)!.allowedLevels.includes(summary.level));
      const participantSet = new Set(participants);
      holes = activeIds.filter((id) => !participantSet.has(id));
    }
    const canSelect = participants.length > 0;
    const selectedChildren = canSelect && holes.length > 0 ? addChildren(id, holes) : [];
    const index = addNode({
      tokens: canSelect ? summary.recallTokens : Infinity,
      fidelity: 0, children, selectedChildren, canExpand: true,
      id: summary.id, level: summary.level, leafIds: participants, canSelect,
      participants: Int32Array.from(participants, (leafId) => leafIndex.get(leafId)!), leafIndex: -1,
    });
    table.set(key, index);
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
  return { ownership: forest.ownership, leafObjects: leaves, nodes, roots, leafNode };
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
  const chunks = forest.orderedChunks();
  const n = leaves.length;
  const newest = n > 0 ? chunks[n - 1].sequence : 0;
  const presentation = options.presentation;

  // Accepted level per leaf, or -1 for a leaf appended since the presentation.
  // Old leaves are fixed at their accepted level. New leaves are free:
  // hysteresis keeps the accepted layout under the BEST extension over them,
  // so every valid extension is enumerated below and scored exactly.
  const fixedLevel = new Int32Array(n);
  let fixedCount = 0;
  const cached = options.reuse?.certificate;
  const known = cached && cached.ownership === forest.ownership ? cached.fixed : undefined;
  const checkedLeaves: CanonicalLeaf[] = new Array(n);
  // One receipt lookup per leaf position, shared with this compile's
  // evaluator.
  const checkedPrevious = presentedLeavesByIndex(presentation.leaves, forest, options) as (PresentedLeaf | undefined)[];
  for (let i = 0; i < n; i++) {
    const leaf = leaves[i];
    const previous = checkedPrevious[i];
    checkedLeaves[i] = leaf;
    if (known && i < known.leaves.length && known.leaves[i] === leaf && known.previous[i] === previous) {
      // Same leaf object against the same receipt entry: the checks below
      // gave this level last compile and depend on nothing else.
      const level = known.level[i];
      fixedLevel[i] = level;
      if (level >= 0) fixedCount++;
      continue;
    }
    if (previous) {
      if (!leaf.allowedLevels.includes(previous.level)) return null;
      if (leaf.repHashes[leaf.availableLevels.indexOf(previous.level)] !== previous.repHash) return null;
      fixedLevel[i] = previous.level;
      fixedCount++;
    } else {
      if (!leaf.allowedLevels.includes(0) && leaf.allowedLevels.length === 0) return null;
      fixedLevel[i] = -1;
    }
  }

  // The context DAG depends only on the forest's ownership and leaf
  // constraints, so a previous compile's graph is reused when the forest was
  // derived from the same build and no owned leaf changed. Fidelity is
  // relative to the newest leaf and is refreshed below every compile.
  const dag = reuseDag(options.reuse?.certificate, forest, leaves) ?? buildDag(forest, leaves, inputs);
  if (dag === null) return null;
  dag.fixed = { leaves: checkedLeaves, previous: checkedPrevious, level: fixedLevel };
  if (options.reuse) options.reuse.certificate = dag;
  const { nodes, roots } = dag;
  const flat = flatten(dag);
  const nodeCount = flat.length;
  const leafFidelity = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    leafFidelity[i] = leaves[i].externallyAccounted ? 0 : fidelityLeafLoss(chunks[i], 1, newest, policy);
  }
  // Per-node constants for this compile: a leaf node's tokens/canSelect can
  // change between compiles (reuseDag patches them), so read them fresh.
  const nodeTokens = new Float64Array(nodeCount);
  const nodeCanSelect = new Uint8Array(nodeCount);
  const nodeFidelity = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    nodeTokens[i] = node.tokens;
    nodeCanSelect[i] = node.canSelect ? 1 : 0;
    if (flat.leafIndex[i] >= 0) { node.fidelity = 0; continue; }
    let fidelity = 0;
    const level = flat.level[i];
    for (let k = flat.participantStart[i], end = flat.participantStart[i + 1]; k < end; k++) {
      fidelity += leafFidelity[flat.participants[k]] * level;
    }
    nodeFidelity[i] = fidelity;
    node.fidelity = fidelity;
  }

  // Does the accepted layout, with every free leaf raw, match the graph? A
  // leaf node matches when raw is allowed and it is free or accepted raw; a
  // summary node matches when selected (every participant accepted at its
  // level, forced holes matching) or expanded (every child matching). Token
  // accounting alone would wrongly admit mixed cuts through unconstrained
  // siblings, so this validates coverage before anything is materialized.
  const matches = new Uint8Array(nodeCount);
  let freeAreRootLeaves = true;
  for (let i = 0; i < nodeCount; i++) {
    const leafAt = flat.leafIndex[i];
    if (leafAt >= 0) {
      const level = fixedLevel[leafAt];
      const canSelect = nodeCanSelect[i] === 1;
      matches[i] = canSelect && (level === 0 || level === -1) ? 1 : 0;
      if (level === -1 && (!canSelect || leaves[leafAt].summaryIds.length > 0)) freeAreRootLeaves = false;
      continue;
    }
    let selected = nodeCanSelect[i] === 1;
    const level = flat.level[i];
    for (let k = flat.participantStart[i], end = flat.participantStart[i + 1]; selected && k < end; k++) selected = fixedLevel[flat.participants[k]] === level;
    for (let k = flat.selectedStart[i], end = flat.selectedStart[i + 1]; selected && k < end; k++) selected = matches[flat.selectedChildren[k]] === 1;
    let expanded = flat.canExpand[i] === 1;
    for (let k = flat.childStart[i], end = flat.childStart[i + 1]; expanded && k < end; k++) expanded = matches[flat.children[k]] === 1;
    matches[i] = selected || expanded ? 1 : 0;
  }
  const rootsMatch = roots.every((root) => matches[root] === 1);

  // A cut as the level per leaf, in `leaves` order (`CanonicalLeaf.index`).
  type Assignment = Array<[ChunkId, number]>;
  let extensions: Uint32Array[];
  if (fixedCount === n) {
    // Exactly one matching frontier, or none.
    if (!rootsMatch) return null;
    extensions = [Uint32Array.from(fixedLevel)];
  } else if (freeAreRootLeaves && rootsMatch) {
    // Every free leaf is an ownerless root that allows raw: each has exactly
    // one cut, so the accepted layout has exactly one extension.
    const levels = new Uint32Array(n);
    for (let i = 0; i < n; i++) levels[i] = fixedLevel[i] > 0 ? fixedLevel[i] : 0;
    extensions = [levels];
  } else {
    // Enumerate every cut that keeps each old leaf at its accepted level. A
    // node may be selected only when all of its old leaves are accepted at
    // exactly its level (and every new leaf allows it); otherwise it must
    // expand.
    const fixed = new Map<ChunkId, number>();
    for (let i = 0; i < n; i++) if (fixedLevel[i] >= 0) fixed.set(leaves[i].id, fixedLevel[i]);
    const EXTENSION_CAP = 256;
    const cutMemo = new Map<number, Assignment[] | null>();
    const combineChildren = (children: readonly number[], initial: Assignment = []): Assignment[] | null => {
      let combinations = [initial];
      for (const child of children) {
        const childCuts = cuts(child);
        if (childCuts === null) return null;
        if (childCuts.length === 1) {
          // One cut for this child: extend every combination in place. The
          // arrays in `combinations` are private to this call (the caller's
          // fresh initial, or copies made below), and memoized cuts are only
          // ever read as suffixes, so nothing shared is mutated.
          const suffix = childCuts[0];
          for (const prefix of combinations) for (const entry of suffix) prefix.push(entry);
          continue;
        }
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
    const combined = combineChildren(roots);
    if (combined === null) return null;
    extensions = combined.map((assignment) => {
      const levels = new Uint32Array(n);
      for (const [id, level] of assignment) levels[forest.leaf(id)!.index] = level;
      return levels;
    });
  }
  const candidates = extensions
    .map((levels) => ({ levels, renderedTokens: forest.tokensForLevels(levels) }))
    .filter((candidate) => candidate.renderedTokens <= options.maxTokens);
  if (candidates.length === 0) return null;
  const witness = candidates.reduce((best, candidate) => candidate.renderedTokens < best.renderedTokens ? candidate : best);

  // Score through the same terminal evaluator the solver uses. It computes
  // churn from emitted unit codes, so no SummaryTree or rendered layout is
  // built here; the old exact scorer rebuilt both on every compile.
  // Every enumerated cut is structurally valid under the wall (witness:
  // ${witness.renderedTokens} tokens), so no minimum-token floor is needed.
  void witness;
  const evaluator = new TerminalPolicyEvaluator(inputs, forest, options);
  const unscored = candidates.map((candidate) =>
    evaluator.candidate({ levels: candidate.levels }, candidate.renderedTokens));
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
    const leafAt = flat.leafIndex;
    for (let i = 0; i < nodeCount; i++) {
      const ownTokens = nodeTokens[i];
      const ownFidelity = nodeFidelity[i];
      if (leafAt[i] >= 0) {
        // A leaf node has no children and cannot expand: the same arithmetic
        // as below with both child sums empty and `expanded` infinite.
        if (Number.isFinite(ownTokens)) {
          const selected = ownFidelity + slope * ownTokens;
          costs[i] = selected;
          tokens[i] = ownTokens;
          magnitude += Math.abs(ownFidelity) + Math.abs(slope * ownTokens);
        } else {
          costs[i] = Infinity;
          tokens[i] = 0;
        }
        continue;
      }
      let selected = Number.isFinite(ownTokens) ? ownFidelity + slope * ownTokens : Infinity;
      let selectedTokens = ownTokens;
      for (let k = flat.selectedStart[i], end = flat.selectedStart[i + 1]; k < end; k++) {
        const child = flat.selectedChildren[k];
        selected += costs[child];
        selectedTokens += tokens[child];
      }
      let expanded = flat.canExpand[i] === 1 ? 0 : Infinity;
      let expandedTokens = 0;
      for (let k = flat.childStart[i], end = flat.childStart[i + 1]; k < end; k++) {
        const child = flat.children[k];
        expanded += costs[child];
        expandedTokens += tokens[child];
      }
      const select = selected < expanded;
      costs[i] = select ? selected : expanded;
      tokens[i] = select ? selectedTokens : expandedTokens;
      if (Number.isFinite(selected)) magnitude += Math.abs(ownFidelity) + Math.abs(slope * ownTokens);
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
