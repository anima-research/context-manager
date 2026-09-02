/**
 * Strict structural foundation for the kv-unified solver.
 *
 * SummaryTree intentionally tolerates damaged chronicles for the shipped
 * strategies. Kv-unified's cut DP cannot: it needs one ownership path per
 * live leaf, leaf-disjoint chronological roots, and explicit constraint
 * intersections. This module builds that checked view without changing the
 * permissive compatibility surface.
 */

import { getSummaryParentId } from '../types/strategy.js';
import type { ChunkId, SummaryId } from './folding-strategy.js';
import type { PickerChunk, PickerInputs } from './picker.js';

export type CanonicalConstraintKind = 'raw' | 'exact' | 'max' | 'min';

export interface CanonicalLeafConstraint {
  kind: CanonicalConstraintKind;
  /** Required/capped/floored level. Omitted only for `raw`. */
  level?: number;
  /** Human-readable origin included in infeasibility certificates. */
  source: string;
}

export interface CanonicalForestOptions {
  /** Additional first-class constraints (for example memory-tool ≥ pins). */
  constraints?: ReadonlyMap<ChunkId, readonly CanonicalLeafConstraint[]>;
  /** Scar-tolerance leaves that must render raw beside any covering recall. */
  overlapExempt?: ReadonlySet<ChunkId>;
  /** Explicit treeification mode: remove non-contiguous summary nodes from the
   * candidate forest and retain their children as independent roots. */
  treeifyNonContiguousSummaries?: boolean;
}

export type CanonicalForestIssueCode =
  | 'duplicate-chunk-id'
  | 'duplicate-sequence'
  | 'missing-l1'
  | 'missing-parent'
  | 'ownership-cycle'
  | 'invalid-l1-level'
  | 'non-increasing-level'
  | 'invalid-raw-cost'
  | 'invalid-fixed-cost'
  | 'invalid-summary-cost'
  | 'non-contiguous-ownership';

export interface CanonicalForestIssue {
  code: CanonicalForestIssueCode;
  message: string;
  leafIds: ChunkId[];
  summaryIds: SummaryId[];
}

export class CanonicalForestError extends Error {
  readonly issues: readonly CanonicalForestIssue[];

  constructor(issues: readonly CanonicalForestIssue[]) {
    const first = issues[0];
    super(
      `Canonical summary forest rejected ${issues.length} structural issue(s)` +
        (first ? `: ${first.message}` : ''),
    );
    this.name = 'CanonicalForestError';
    this.issues = issues;
  }
}

export interface CanonicalLeaf {
  readonly kind: 'leaf';
  readonly id: ChunkId;
  readonly sequence: number;
  readonly rawTokens: number;
  readonly carriedLevel: number;
  /** Head/tail tokens are already included in fixedTokens. */
  readonly externallyAccounted: boolean;
  readonly summaryIds: readonly SummaryId[];
  readonly availableLevels: readonly number[];
  readonly allowedLevels: readonly number[];
  readonly constraints: readonly CanonicalLeafConstraint[];
}

export interface CanonicalSummary {
  readonly kind: 'summary';
  readonly id: SummaryId;
  readonly level: number;
  readonly recallTokens: number;
  readonly parentId?: SummaryId;
  readonly childSummaryIds: readonly SummaryId[];
  readonly directLeafIds: readonly ChunkId[];
  readonly leafIds: readonly ChunkId[];
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export type CanonicalRoot =
  | { readonly kind: 'leaf'; readonly id: ChunkId; readonly firstSequence: number }
  | { readonly kind: 'summary'; readonly id: SummaryId; readonly firstSequence: number };

export interface ConstraintConflict {
  readonly leafId: ChunkId;
  readonly availableLevels: readonly number[];
  readonly constraints: readonly CanonicalLeafConstraint[];
  readonly requestedMissingLevels: readonly number[];
}

export interface MinimumTokenCertificate {
  readonly reason: 'constraint-conflict' | 'over-budget';
  readonly floorTokens: number | null;
  readonly bindingLeaves: readonly ConstraintConflict[];
  readonly protectedTokens: number;
  readonly missingLevels: readonly number[];
  readonly requiredAdditionalTokens: number;
  readonly suggestion: string;
}

export type MinimumTokenResult =
  | {
      readonly feasible: true;
      readonly floorTokens: number;
      readonly frontier: ReadonlyMap<ChunkId, number>;
    }
  | {
      readonly feasible: false;
      readonly floorTokens: number | null;
      /** Minimum-token frontier is present for an over-budget result. */
      readonly frontier?: ReadonlyMap<ChunkId, number>;
      readonly certificate: MinimumTokenCertificate;
    };

export interface CanonicalSelectAction {
  readonly level: number;
  readonly renderedTokens: number;
  readonly participantLeafIds: readonly ChunkId[];
  readonly protectedHoleLeafIds: readonly ChunkId[];
}

export interface CanonicalDecisionNode {
  readonly key: string;
  readonly kind: 'leaf' | 'summary';
  readonly id: ChunkId | SummaryId;
  readonly firstSequence: number;
  /** Null when no active leaf can legally select this representation. */
  readonly select: CanonicalSelectAction | null;
  /** Chronological child keys followed by the expand action. */
  readonly expandKeys: readonly string[];
}

export interface CanonicalDecisionDag {
  readonly roots: readonly string[];
  readonly nodes: ReadonlyMap<string, CanonicalDecisionNode>;
  readonly nodeCount: number;
  readonly expandEdgeCount: number;
}

export interface ExactCutCandidate {
  readonly frontier: ReadonlyMap<ChunkId, number>;
  readonly renderedTokens: number;
}

export interface ExactCutEnumerationStats {
  readonly statesVisited: number;
  readonly candidatesGenerated: number;
  readonly maxCandidatesAtState: number;
  readonly terminalCandidates: number;
}

export interface ExactCutEnumeration {
  readonly candidates: readonly ExactCutCandidate[];
  readonly stats: ExactCutEnumerationStats;
}

export class ExactEnumerationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExactEnumerationLimitError';
  }
}

export interface SparseLabelStats {
  readonly labelsCreated: number;
  readonly labelsExpanded: number;
  readonly structuralStates: number;
  readonly maxLabelsPerState: number;
  readonly terminalLabels: number;
}

export interface SparseLabelResult {
  readonly candidates: readonly ExactCutCandidate[];
  readonly stats: SparseLabelStats;
}

export class SparseLabelCeilingError extends Error {
  readonly ceiling: number;
  readonly labelsCreated: number;

  constructor(ceiling: number, labelsCreated: number) {
    super(`kv-unified exact label propagation exceeded ceiling ${ceiling} at ${labelsCreated}`);
    this.name = 'SparseLabelCeilingError';
    this.ceiling = ceiling;
    this.labelsCreated = labelsCreated;
  }
}

interface MutableSummary {
  id: SummaryId;
  level: number;
  recallTokens: number;
  parentId?: SummaryId;
  childSummaryIds: Set<SummaryId>;
  directLeafIds: Set<ChunkId>;
  leafIds: Set<ChunkId>;
}

interface PartialCut {
  tokens: number;
  frontier: Map<ChunkId, number>;
}

const IMPOSSIBLE = Number.POSITIVE_INFINITY;

export class CanonicalSummaryForest {
  readonly fixedTokens: number;
  readonly roots: readonly CanonicalRoot[];
  readonly constraintConflicts: readonly ConstraintConflict[];
  readonly treeifiedSummaryIds: readonly SummaryId[];

  private readonly leafMap: ReadonlyMap<ChunkId, CanonicalLeaf>;
  private readonly summaryMap: ReadonlyMap<SummaryId, CanonicalSummary>;
  private readonly orderedLeafList: readonly CanonicalLeaf[];

  constructor(inputs: PickerInputs, options: CanonicalForestOptions = {}) {
    this.fixedTokens = inputs.headTokens + inputs.tailTokens;
    const issues: CanonicalForestIssue[] = [];
    if (
      !Number.isFinite(inputs.headTokens) ||
      inputs.headTokens < 0 ||
      !Number.isFinite(inputs.tailTokens) ||
      inputs.tailTokens < 0
    ) {
      issues.push({
        code: 'invalid-fixed-cost',
        message: `head/tail costs must be finite and non-negative (head=${inputs.headTokens}, tail=${inputs.tailTokens})`,
        leafIds: [],
        summaryIds: [],
      });
    }
    const chunks = [...inputs.chunks].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
    );
    const chunkById = new Map<ChunkId, PickerChunk>();
    const sequenceOwner = new Map<number, ChunkId>();
    for (const chunk of chunks) {
      if (chunkById.has(chunk.id)) {
        issues.push({
          code: 'duplicate-chunk-id',
          message: `live chunk id ${chunk.id} occurs more than once`,
          leafIds: [chunk.id],
          summaryIds: [],
        });
        continue;
      }
      const previousAtSequence = sequenceOwner.get(chunk.sequence);
      if (previousAtSequence !== undefined) {
        issues.push({
          code: 'duplicate-sequence',
          message: `chunks ${previousAtSequence} and ${chunk.id} share sequence ${chunk.sequence}`,
          leafIds: [previousAtSequence, chunk.id],
          summaryIds: [],
        });
      } else {
        sequenceOwner.set(chunk.sequence, chunk.id);
      }
      if (!Number.isFinite(chunk.rawTokens) || chunk.rawTokens < 0) {
        issues.push({
          code: 'invalid-raw-cost',
          message: `chunk ${chunk.id} has invalid raw cost ${String(chunk.rawTokens)}`,
          leafIds: [chunk.id],
          summaryIds: [],
        });
      }
      chunkById.set(chunk.id, chunk);
    }

    const chains = new Map<ChunkId, SummaryId[]>();
    const mutableSummaries = new Map<SummaryId, MutableSummary>();
    for (const chunk of chunks) {
      const chain: SummaryId[] = [];
      const seen = new Set<SummaryId>();
      let currentId = chunk.l1Id;
      let previousLevel = 0;
      while (currentId !== undefined) {
        if (seen.has(currentId)) {
          issues.push({
            code: 'ownership-cycle',
            message: `ownership chain for ${chunk.id} cycles at ${currentId}`,
            leafIds: [chunk.id],
            summaryIds: [...chain, currentId],
          });
          break;
        }
        seen.add(currentId);
        const entry = inputs.summaries.get(currentId);
        if (!entry) {
          issues.push({
            code: chain.length === 0 ? 'missing-l1' : 'missing-parent',
            message:
              chain.length === 0
                ? `chunk ${chunk.id} points to missing L1 ${currentId}`
                : `summary ${chain[chain.length - 1]} points to missing parent ${currentId}`,
            leafIds: [chunk.id],
            summaryIds: [...chain, currentId],
          });
          break;
        }
        if (chain.length === 0 && entry.level !== 1) {
          issues.push({
            code: 'invalid-l1-level',
            message: `chunk ${chunk.id} l1Id ${entry.id} is level ${entry.level}, expected 1`,
            leafIds: [chunk.id],
            summaryIds: [entry.id],
          });
        }
        if (entry.level <= previousLevel) {
          issues.push({
            code: 'non-increasing-level',
            message: `ownership chain for ${chunk.id} moves from L${previousLevel} to L${entry.level}`,
            leafIds: [chunk.id],
            summaryIds: [...chain, entry.id],
          });
        }
        const recallTokens = inputs.recallPairTokens?.get(entry.id) ?? entry.tokens;
        if (!Number.isFinite(recallTokens) || recallTokens < 0) {
          issues.push({
            code: 'invalid-summary-cost',
            message: `summary ${entry.id} has invalid recall cost ${String(recallTokens)}`,
            leafIds: [chunk.id],
            summaryIds: [entry.id],
          });
        }
        if (!mutableSummaries.has(entry.id)) {
          mutableSummaries.set(entry.id, {
            id: entry.id,
            level: entry.level,
            recallTokens,
            parentId: getSummaryParentId(entry),
            childSummaryIds: new Set(),
            directLeafIds: new Set(),
            leafIds: new Set(),
          });
        }
        chain.push(entry.id);
        previousLevel = entry.level;
        currentId = getSummaryParentId(entry);
      }
      chains.set(chunk.id, chain);
    }

    if (issues.length > 0) throw new CanonicalForestError(issues);

    const indexOfLeaf = new Map(chunks.map((chunk, index) => [chunk.id, index] as const));
    const treeified = new Set<SummaryId>();
    const rebuildOwnership = (): void => {
      mutableSummaries.clear();
      for (const chain of chains.values()) {
        for (const id of chain) {
          if (mutableSummaries.has(id)) continue;
          const entry = inputs.summaries.get(id)!;
          mutableSummaries.set(id, {
            id,
            level: entry.level,
            recallTokens: inputs.recallPairTokens?.get(id) ?? entry.tokens,
            parentId: getSummaryParentId(entry),
            childSummaryIds: new Set(),
            directLeafIds: new Set(),
            leafIds: new Set(),
          });
        }
      }
      for (const chunk of chunks) {
        const chain = chains.get(chunk.id) ?? [];
        if (chain.length > 0) mutableSummaries.get(chain[0])!.directLeafIds.add(chunk.id);
        for (let i = 0; i < chain.length; i++) {
          mutableSummaries.get(chain[i])!.leafIds.add(chunk.id);
          if (i + 1 < chain.length) mutableSummaries.get(chain[i + 1])!.childSummaryIds.add(chain[i]);
        }
      }
    };
    while (true) {
      rebuildOwnership();
      const contiguityIssues: CanonicalForestIssue[] = [];
      for (const summary of mutableSummaries.values()) {
        const indices = [...summary.leafIds].map((id) => indexOfLeaf.get(id)!).sort((a, b) => a - b);
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] !== indices[i - 1] + 1) {
            contiguityIssues.push({
              code: 'non-contiguous-ownership',
              message: `summary ${summary.id} owns non-contiguous live leaves`,
              leafIds: [...summary.leafIds],
              summaryIds: [summary.id],
            });
            break;
          }
        }
      }
      if (contiguityIssues.length === 0) break;
      if (!options.treeifyNonContiguousSummaries) {
        throw new CanonicalForestError(contiguityIssues);
      }
      const newlyTreeified = new Set(contiguityIssues.flatMap((issue) => issue.summaryIds));
      for (const id of newlyTreeified) treeified.add(id);
      for (const [leafId, chain] of chains) {
        const cut = chain.findIndex((id) => newlyTreeified.has(id));
        if (cut >= 0) chains.set(leafId, chain.slice(0, cut));
      }
    }

    const summaryMap = new Map<SummaryId, CanonicalSummary>();
    for (const summary of mutableSummaries.values()) {
      const leafIds = [...summary.leafIds].sort(
        (a, b) => indexOfLeaf.get(a)! - indexOfLeaf.get(b)!,
      );
      summaryMap.set(summary.id, {
        kind: 'summary',
        id: summary.id,
        level: summary.level,
        recallTokens: summary.recallTokens,
        parentId: summary.parentId,
        childSummaryIds: [...summary.childSummaryIds].sort((a, b) => {
          const aFirst = Math.min(...[...mutableSummaries.get(a)!.leafIds].map((id) => indexOfLeaf.get(id)!));
          const bFirst = Math.min(...[...mutableSummaries.get(b)!.leafIds].map((id) => indexOfLeaf.get(id)!));
          return aFirst - bFirst || a.localeCompare(b);
        }),
        directLeafIds: [...summary.directLeafIds].sort(
          (a, b) => indexOfLeaf.get(a)! - indexOfLeaf.get(b)!,
        ),
        leafIds,
        firstSequence: chunkById.get(leafIds[0])!.sequence,
        lastSequence: chunkById.get(leafIds[leafIds.length - 1])!.sequence,
      });
    }

    const leafMap = new Map<ChunkId, CanonicalLeaf>();
    const conflicts: ConstraintConflict[] = [];
    for (const chunk of chunks) {
      const chain = chains.get(chunk.id) ?? [];
      const availableLevels = [0, ...chain.map((id) => summaryMap.get(id)!.level)];
      const constraints = this.constraintsFor(chunk, inputs, options);
      let allowedLevels = [...availableLevels];
      const requestedMissingLevels = new Set<number>();
      for (const constraint of constraints) {
        const level = constraint.kind === 'raw' ? 0 : constraint.level;
        if (level === undefined || !Number.isInteger(level) || level < 0) {
          allowedLevels = [];
          continue;
        }
        if (constraint.kind === 'raw' || constraint.kind === 'exact') {
          if (!availableLevels.includes(level)) requestedMissingLevels.add(level);
          allowedLevels = allowedLevels.filter((candidate) => candidate === level);
        } else if (constraint.kind === 'max') {
          allowedLevels = allowedLevels.filter((candidate) => candidate <= level);
        } else {
          if (!availableLevels.some((candidate) => candidate >= level)) {
            requestedMissingLevels.add(level);
          }
          allowedLevels = allowedLevels.filter((candidate) => candidate >= level);
        }
      }
      allowedLevels.sort((a, b) => a - b);
      const leaf: CanonicalLeaf = {
        kind: 'leaf',
        id: chunk.id,
        sequence: chunk.sequence,
        rawTokens: chunk.rawTokens,
        carriedLevel: chunk.currentResolution,
        externallyAccounted:
          inputs.headChunkIds.has(chunk.id) || inputs.tailChunkIds.has(chunk.id),
        summaryIds: chain,
        availableLevels,
        allowedLevels,
        constraints,
      };
      leafMap.set(chunk.id, leaf);
      if (allowedLevels.length === 0) {
        conflicts.push({
          leafId: chunk.id,
          availableLevels,
          constraints,
          requestedMissingLevels: [...requestedMissingLevels].sort((a, b) => a - b),
        });
      }
    }

    const roots: CanonicalRoot[] = [];
    const seenRoots = new Set<string>();
    for (const chunk of chunks) {
      const chain = chains.get(chunk.id) ?? [];
      if (chain.length === 0) {
        const key = `leaf:${chunk.id}`;
        if (!seenRoots.has(key)) {
          roots.push({ kind: 'leaf', id: chunk.id, firstSequence: chunk.sequence });
          seenRoots.add(key);
        }
      } else {
        const id = chain[chain.length - 1];
        const key = `summary:${id}`;
        if (!seenRoots.has(key)) {
          roots.push({
            kind: 'summary',
            id,
            firstSequence: summaryMap.get(id)!.firstSequence,
          });
          seenRoots.add(key);
        }
      }
    }
    roots.sort((a, b) => a.firstSequence - b.firstSequence || a.id.localeCompare(b.id));

    this.leafMap = leafMap;
    this.summaryMap = summaryMap;
    this.orderedLeafList = chunks.map((chunk) => leafMap.get(chunk.id)!);
    this.roots = roots;
    this.constraintConflicts = conflicts;
    this.treeifiedSummaryIds = [...treeified].sort();
  }

  orderedLeaves(): readonly CanonicalLeaf[] {
    return this.orderedLeafList;
  }

  leaf(id: ChunkId): CanonicalLeaf | null {
    return this.leafMap.get(id) ?? null;
  }

  summary(id: SummaryId): CanonicalSummary | null {
    return this.summaryMap.get(id) ?? null;
  }

  allSummaries(): readonly CanonicalSummary[] {
    return [...this.summaryMap.values()].sort(
      (a, b) => a.firstSequence - b.firstSequence || a.level - b.level || a.id.localeCompare(b.id),
    );
  }

  /**
   * Linear structural decision graph. A summary has a select action and
   * chronological expand edges. Protected holes are action annotations: a
   * solver intersects them with its active-leaf set and continues through
   * the expand edges for the holes only.
   */
  decisionDag(): CanonicalDecisionDag {
    const nodes = new Map<string, CanonicalDecisionNode>();
    let expandEdgeCount = 0;
    for (const leaf of this.orderedLeafList) {
      const key = leafKey(leaf.id);
      nodes.set(key, {
        key,
        kind: 'leaf',
        id: leaf.id,
        firstSequence: leaf.sequence,
        select: leaf.allowedLevels.includes(0)
          ? {
              level: 0,
              renderedTokens: leaf.externallyAccounted ? 0 : leaf.rawTokens,
              participantLeafIds: [leaf.id],
              protectedHoleLeafIds: [],
            }
          : null,
        expandKeys: [],
      });
    }
    for (const summary of this.allSummaries()) {
      const key = summaryKey(summary.id);
      const participants = summary.leafIds.filter((leafId) =>
        this.leafMap.get(leafId)!.allowedLevels.includes(summary.level),
      );
      const holes = summary.leafIds.filter((leafId) => !participants.includes(leafId));
      const expandKeys = this.orderedChildren(summary).map((child) => child.key);
      expandEdgeCount += expandKeys.length;
      nodes.set(key, {
        key,
        kind: 'summary',
        id: summary.id,
        firstSequence: summary.firstSequence,
        select:
          participants.length > 0
            ? {
                level: summary.level,
                renderedTokens: summary.recallTokens,
                participantLeafIds: participants,
                protectedHoleLeafIds: holes,
              }
            : null,
        expandKeys,
      });
    }
    return {
      roots: this.roots.map((root) =>
        root.kind === 'leaf' ? leafKey(root.id) : summaryKey(root.id),
      ),
      nodes,
      nodeCount: nodes.size,
      expandEdgeCount,
    };
  }

  /**
   * Development oracle: enumerate every structurally feasible cut on a small
   * forest. This walks the same select/expand semantics as the production DP,
   * including protected holes, and records frontier-growth telemetry.
   */
  enumerateExactCuts(options: {
    maxLeaves?: number;
    maxCandidates?: number;
    maxTokens?: number;
  } = {}): ExactCutEnumeration {
    const maxLeaves = options.maxLeaves ?? 12;
    const maxCandidates = options.maxCandidates ?? 1_000_000;
    const maxTokens = options.maxTokens ?? Number.POSITIVE_INFINITY;
    if (this.orderedLeafList.length > maxLeaves) {
      throw new ExactEnumerationLimitError(
        `exact cut enumeration is limited to ${maxLeaves} leaves; got ${this.orderedLeafList.length}`,
      );
    }
    if (this.constraintConflicts.length > 0) {
      return {
        candidates: [],
        stats: {
          statesVisited: 0,
          candidatesGenerated: 0,
          maxCandidatesAtState: 0,
          terminalCandidates: 0,
        },
      };
    }

    const memo = new Map<string, Map<string, Map<ChunkId, number>>>();
    let statesVisited = 0;
    let candidatesGenerated = 0;
    let maxCandidatesAtState = 0;
    const checkLimit = (count: number): void => {
      maxCandidatesAtState = Math.max(maxCandidatesAtState, count);
      if (count > maxCandidates) {
        throw new ExactEnumerationLimitError(
          `exact cut enumeration exceeded ${maxCandidates} candidates in one state`,
        );
      }
    };

    const enumerateLeaf = (id: ChunkId): Map<string, Map<ChunkId, number>> => {
      const leaf = this.leafMap.get(id)!;
      const cuts = new Map<string, Map<ChunkId, number>>();
      if (leaf.allowedLevels.includes(0)) {
        const frontier = new Map<ChunkId, number>([[id, 0]]);
        cuts.set(this.frontierSignature(frontier, [id]), frontier);
      }
      candidatesGenerated += cuts.size;
      checkLimit(cuts.size);
      return cuts;
    };

    const enumerateChildren = (
      summary: CanonicalSummary,
      activeLeafIds: readonly ChunkId[],
      enumerateSummary: (
        id: SummaryId,
        active: readonly ChunkId[],
      ) => Map<string, Map<ChunkId, number>>,
    ): Map<string, Map<ChunkId, number>> => {
      const active = new Set(activeLeafIds);
      let combined = new Map<string, Map<ChunkId, number>>([['', new Map()]]);
      for (const child of this.orderedChildren(summary)) {
        let childCuts: Map<string, Map<ChunkId, number>>;
        if (child.kind === 'leaf') {
          if (!active.has(child.id)) continue;
          childCuts = enumerateLeaf(child.id);
        } else {
          const childSummary = this.summaryMap.get(child.id)!;
          const childActive = childSummary.leafIds.filter((leafId) => active.has(leafId));
          if (childActive.length === 0) continue;
          childCuts = enumerateSummary(child.id, childActive);
        }
        const next = new Map<string, Map<ChunkId, number>>();
        for (const left of combined.values()) {
          for (const right of childCuts.values()) {
            const frontier = combineFrontiers(left, right);
            next.set(this.frontierSignature(frontier, activeLeafIds), frontier);
          }
        }
        combined = next;
        candidatesGenerated += combined.size;
        checkLimit(combined.size);
      }
      return combined;
    };

    const enumerateSummary = (
      id: SummaryId,
      activeLeafIds: readonly ChunkId[],
    ): Map<string, Map<ChunkId, number>> => {
      const key = `${id}\u0000${activeLeafIds.join('\u0001')}`;
      const cached = memo.get(key);
      if (cached) return cloneFrontierSet(cached);
      statesVisited++;
      const summary = this.summaryMap.get(id)!;
      const all = enumerateChildren(summary, activeLeafIds, enumerateSummary);
      const participants = activeLeafIds.filter((leafId) =>
        this.leafMap.get(leafId)!.allowedLevels.includes(summary.level),
      );
      if (participants.length > 0) {
        const participantSet = new Set(participants);
        const holes = activeLeafIds.filter((leafId) => !participantSet.has(leafId));
        const holeCuts = enumerateChildren(summary, holes, enumerateSummary);
        for (const holeCut of holeCuts.values()) {
          const frontier = new Map(holeCut);
          for (const leafId of participants) frontier.set(leafId, summary.level);
          all.set(this.frontierSignature(frontier, activeLeafIds), frontier);
        }
      }
      candidatesGenerated += all.size;
      checkLimit(all.size);
      memo.set(key, cloneFrontierSet(all));
      return cloneFrontierSet(all);
    };

    let terminal = new Map<string, Map<ChunkId, number>>([['', new Map()]]);
    for (const root of this.roots) {
      const rootCuts =
        root.kind === 'leaf'
          ? enumerateLeaf(root.id)
          : enumerateSummary(root.id, this.summaryMap.get(root.id)!.leafIds);
      const next = new Map<string, Map<ChunkId, number>>();
      for (const left of terminal.values()) {
        for (const right of rootCuts.values()) {
          const frontier = combineFrontiers(left, right);
          next.set(this.frontierSignature(frontier, this.orderedLeafList.map((leaf) => leaf.id)), frontier);
        }
      }
      terminal = next;
      candidatesGenerated += terminal.size;
      checkLimit(terminal.size);
    }

    const candidates = [...terminal.values()]
      .map((frontier) => ({ frontier, renderedTokens: this.tokensForFrontier(frontier) }))
      .filter((candidate) => candidate.renderedTokens <= maxTokens)
      .sort((a, b) =>
        a.renderedTokens - b.renderedTokens ||
        this.frontierSignature(a.frontier, this.orderedLeafList.map((leaf) => leaf.id)).localeCompare(
          this.frontierSignature(b.frontier, this.orderedLeafList.map((leaf) => leaf.id)),
        ),
      );
    return {
      candidates,
      stats: {
        statesVisited,
        candidatesGenerated,
        maxCandidatesAtState,
        terminalCandidates: candidates.length,
      },
    };
  }

  tokensForFrontier(frontier: ReadonlyMap<ChunkId, number>): number {
    let tokens = this.fixedTokens;
    const summaries = new Set<SummaryId>();
    for (const leaf of this.orderedLeafList) {
      const level = frontier.get(leaf.id) ?? 0;
      if (!leaf.allowedLevels.includes(level)) {
        throw new Error(`frontier selects disallowed L${level} for ${leaf.id}`);
      }
      if (level === 0) {
        if (!leaf.externallyAccounted) tokens += leaf.rawTokens;
        continue;
      }
      const summaryId = leaf.summaryIds.find(
        (candidateId) => this.summaryMap.get(candidateId)!.level === level,
      );
      if (!summaryId) throw new Error(`frontier selects unavailable L${level} for ${leaf.id}`);
      summaries.add(summaryId);
    }
    for (const summaryId of summaries) tokens += this.summaryMap.get(summaryId)!.recallTokens;
    return tokens;
  }

  /**
   * Exact left-to-right label propagation. Unlike the recursive enumeration
   * oracle, this chooses a representation at the oldest uncovered leaf and
   * advances a structural remaining-leaf state. It is the production DP's
   * unpruned reference implementation; a hard ceiling prevents accidental
   * exponential use before bounded pruning is enabled.
   */
  propagateExactLabels(options: {
    maxTokens?: number;
    labelCeiling?: number;
  } = {}): SparseLabelResult {
    if (this.constraintConflicts.length > 0) {
      return {
        candidates: [],
        stats: {
          labelsCreated: 0,
          labelsExpanded: 0,
          structuralStates: 0,
          maxLabelsPerState: 0,
          terminalLabels: 0,
        },
      };
    }
    const maxTokens = options.maxTokens ?? Number.POSITIVE_INFINITY;
    const labelCeiling = options.labelCeiling ?? 1_000_000;
    const leaves = this.orderedLeafList;
    const indexById = new Map(leaves.map((leaf, index) => [leaf.id, index] as const));
    const bit = (index: number): bigint => 1n << BigInt(index);
    let initialRemaining = 0n;
    const initialFrontier = new Map<ChunkId, number>();
    for (let index = 0; index < leaves.length; index++) {
      if (leaves[index].externallyAccounted) initialFrontier.set(leaves[index].id, 0);
      else initialRemaining |= bit(index);
    }

    interface WorkLabel {
      remaining: bigint;
      renderedTokens: number;
      frontier: Map<ChunkId, number>;
    }
    const stack: WorkLabel[] = [
      { remaining: initialRemaining, renderedTokens: this.fixedTokens, frontier: initialFrontier },
    ];
    const terminal = new Map<string, ExactCutCandidate>();
    const labelsByState = new Map<string, number>();
    let labelsCreated = 1;
    let labelsExpanded = 0;
    let maxLabelsPerState = 1;

    const noteState = (remaining: bigint): void => {
      const key = remaining.toString(16);
      const count = (labelsByState.get(key) ?? 0) + 1;
      labelsByState.set(key, count);
      maxLabelsPerState = Math.max(maxLabelsPerState, count);
    };
    noteState(initialRemaining);
    const push = (label: WorkLabel): void => {
      if (label.renderedTokens > maxTokens) return;
      labelsCreated++;
      if (labelsCreated > labelCeiling) {
        throw new SparseLabelCeilingError(labelCeiling, labelsCreated);
      }
      noteState(label.remaining);
      stack.push(label);
    };

    while (stack.length > 0) {
      const label = stack.pop()!;
      if (label.remaining === 0n) {
        const signature = this.frontierSignature(
          label.frontier,
          leaves.map((leaf) => leaf.id),
        );
        terminal.set(signature, {
          frontier: label.frontier,
          renderedTokens: label.renderedTokens,
        });
        continue;
      }
      labelsExpanded++;
      const oldestIndex = lowestSetBit(label.remaining);
      const leaf = leaves[oldestIndex];

      if (leaf.allowedLevels.includes(0)) {
        const frontier = new Map(label.frontier);
        frontier.set(leaf.id, 0);
        push({
          remaining: label.remaining & ~bit(oldestIndex),
          renderedTokens: label.renderedTokens + leaf.rawTokens,
          frontier,
        });
      }

      for (const summaryId of leaf.summaryIds) {
        const summary = this.summaryMap.get(summaryId)!;
        if (!leaf.allowedLevels.includes(summary.level)) continue;
        let participantMask = 0n;
        const participantIds: ChunkId[] = [];
        let overlapsEarlierFreeChoice = false;
        for (const candidateId of summary.leafIds) {
          const candidateIndex = indexById.get(candidateId)!;
          const candidateBit = bit(candidateIndex);
          const candidateAllowsSummary = this.leafMap
            .get(candidateId)!
            .allowedLevels.includes(summary.level);
          if ((label.remaining & candidateBit) === 0n && candidateAllowsSummary) {
            // This leaf was already rendered at a finer choice even though it
            // could have participated in this summary. Only a constraint-
            // forced hole may sit beside an ancestor recall.
            overlapsEarlierFreeChoice = true;
            break;
          }
          if (
            (label.remaining & candidateBit) !== 0n &&
            candidateAllowsSummary
          ) {
            participantMask |= candidateBit;
            participantIds.push(candidateId);
          }
        }
        if (overlapsEarlierFreeChoice) continue;
        if ((participantMask & bit(oldestIndex)) === 0n) continue;
        const frontier = new Map(label.frontier);
        for (const participantId of participantIds) frontier.set(participantId, summary.level);
        push({
          remaining: label.remaining & ~participantMask,
          renderedTokens: label.renderedTokens + summary.recallTokens,
          frontier,
        });
      }
    }

    const candidates = [...terminal.values()].sort(
      (a, b) =>
        a.renderedTokens - b.renderedTokens ||
        this.frontierSignature(a.frontier, leaves.map((leaf) => leaf.id)).localeCompare(
          this.frontierSignature(b.frontier, leaves.map((leaf) => leaf.id)),
        ),
    );
    return {
      candidates,
      stats: {
        labelsCreated,
        labelsExpanded,
        structuralStates: labelsByState.size,
        maxLabelsPerState,
        terminalLabels: candidates.length,
      },
    };
  }

  /** Exact minimum-token cut, including protected-hole emissions. */
  minimumTokens(maxTokens = Number.POSITIVE_INFINITY): MinimumTokenResult {
    if (this.constraintConflicts.length > 0) {
      return {
        feasible: false,
        floorTokens: null,
        certificate: this.certificate('constraint-conflict', null, maxTokens),
      };
    }

    const memo = new Map<string, number>();
    const selectedChoice = new Map<string, boolean>();
    const keyOf = (id: SummaryId, active: readonly ChunkId[]): string =>
      `${id}\u0000${active.join('\u0001')}`;
    const leafCost = (id: ChunkId): number => {
      const leaf = this.leafMap.get(id)!;
      if (!leaf.allowedLevels.includes(0)) return IMPOSSIBLE;
      return leaf.externallyAccounted ? 0 : leaf.rawTokens;
    };
    const childrenCost = (summary: CanonicalSummary, activeIds: readonly ChunkId[]): number => {
      const active = new Set(activeIds);
      let total = 0;
      for (const child of this.orderedChildren(summary)) {
        if (child.kind === 'leaf') {
          if (!active.has(child.id)) continue;
          total += leafCost(child.id);
        } else {
          const childSummary = this.summaryMap.get(child.id)!;
          const childActive = childSummary.leafIds.filter((id) => active.has(id));
          if (childActive.length > 0) total += summaryCost(child.id, childActive);
        }
        if (!Number.isFinite(total)) return IMPOSSIBLE;
      }
      return total;
    };
    const summaryCost = (id: SummaryId, activeIds: readonly ChunkId[]): number => {
      if (activeIds.length === 0) return 0;
      const key = keyOf(id, activeIds);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const summary = this.summaryMap.get(id)!;
      const expanded = childrenCost(summary, activeIds);
      const participants = activeIds.filter((leafId) =>
        this.leafMap.get(leafId)!.allowedLevels.includes(summary.level),
      );
      let selected = IMPOSSIBLE;
      if (participants.length > 0) {
        const participantSet = new Set(participants);
        const holes = activeIds.filter((leafId) => !participantSet.has(leafId));
        const holeCost = childrenCost(summary, holes);
        if (Number.isFinite(holeCost)) selected = summary.recallTokens + holeCost;
      }
      const useSelected = selected < expanded;
      const best = useSelected ? selected : expanded;
      memo.set(key, best);
      selectedChoice.set(key, useSelected);
      return best;
    };

    let variableTokens = 0;
    for (const root of this.roots) {
      const cost =
        root.kind === 'leaf'
          ? leafCost(root.id)
          : summaryCost(root.id, this.summaryMap.get(root.id)!.leafIds);
      if (!Number.isFinite(cost)) {
        return {
          feasible: false,
          floorTokens: null,
          certificate: this.certificate('constraint-conflict', null, maxTokens),
        };
      }
      variableTokens += cost;
    }
    const frontier = new Map<ChunkId, number>();
    const reconstructLeaf = (id: ChunkId): void => { frontier.set(id, 0); };
    const reconstructChildren = (summary: CanonicalSummary, activeIds: readonly ChunkId[]): void => {
      const active = new Set(activeIds);
      for (const child of this.orderedChildren(summary)) {
        if (child.kind === 'leaf') {
          if (active.has(child.id)) reconstructLeaf(child.id);
        } else {
          const childSummary = this.summaryMap.get(child.id)!;
          const childActive = childSummary.leafIds.filter((id) => active.has(id));
          if (childActive.length > 0) reconstructSummary(child.id, childActive);
        }
      }
    };
    const reconstructSummary = (id: SummaryId, activeIds: readonly ChunkId[]): void => {
      const summary = this.summaryMap.get(id)!;
      if (selectedChoice.get(keyOf(id, activeIds))) {
        const participants = activeIds.filter((leafId) =>
          this.leafMap.get(leafId)!.allowedLevels.includes(summary.level),
        );
        const participantSet = new Set(participants);
        for (const leafId of participants) frontier.set(leafId, summary.level);
        reconstructChildren(summary, activeIds.filter((leafId) => !participantSet.has(leafId)));
      } else {
        reconstructChildren(summary, activeIds);
      }
    };
    for (const root of this.roots) {
      if (root.kind === 'leaf') reconstructLeaf(root.id);
      else reconstructSummary(root.id, this.summaryMap.get(root.id)!.leafIds);
    }
    const floorTokens = this.fixedTokens + variableTokens;
    if (floorTokens > maxTokens) {
      return {
        feasible: false,
        floorTokens,
        frontier,
        certificate: this.certificate('over-budget', floorTokens, maxTokens),
      };
    }
    return { feasible: true, floorTokens, frontier };
  }

  private constraintsFor(
    chunk: PickerChunk,
    inputs: PickerInputs,
    options: CanonicalForestOptions,
  ): CanonicalLeafConstraint[] {
    const constraints: CanonicalLeafConstraint[] = [];
    if (inputs.headChunkIds.has(chunk.id)) {
      constraints.push({ kind: 'raw', source: 'head-zone' });
    }
    if (inputs.tailChunkIds.has(chunk.id)) {
      constraints.push({ kind: 'raw', source: 'tail-zone' });
    }
    if (chunk.pinned) constraints.push({ kind: 'raw', source: 'classic-pin' });
    if (options.overlapExempt?.has(chunk.id)) {
      constraints.push({ kind: 'raw', source: 'overlap-exempt' });
    }
    if (chunk.lockedByAgent) {
      constraints.push({
        kind: 'exact',
        level: chunk.currentResolution,
        source: 'lockedByAgent',
      });
    }
    if (chunk.pinLevel !== undefined) {
      constraints.push({ kind: 'exact', level: chunk.pinLevel, source: 'pin-level' });
    }
    if (chunk.pinMaxLevel !== undefined) {
      constraints.push({ kind: 'max', level: chunk.pinMaxLevel, source: 'pin-max-level' });
    }
    constraints.push(...(options.constraints?.get(chunk.id) ?? []));
    return constraints;
  }

  private orderedChildren(summary: CanonicalSummary): Array<
    | { kind: 'leaf'; id: ChunkId; firstSequence: number; key: string }
    | { kind: 'summary'; id: SummaryId; firstSequence: number; key: string }
  > {
    return [
      ...summary.directLeafIds.map((id) => ({
        kind: 'leaf' as const,
        id,
        firstSequence: this.leafMap.get(id)!.sequence,
        key: leafKey(id),
      })),
      ...summary.childSummaryIds.map((id) => ({
        kind: 'summary' as const,
        id,
        firstSequence: this.summaryMap.get(id)!.firstSequence,
        key: summaryKey(id),
      })),
    ].sort((a, b) => a.firstSequence - b.firstSequence || a.id.localeCompare(b.id));
  }

  private frontierSignature(
    frontier: ReadonlyMap<ChunkId, number>,
    leafIds: readonly ChunkId[],
  ): string {
    return leafIds.map((leafId) => `${leafId}:${frontier.get(leafId) ?? '-'}`).join('|');
  }

  private coverLeaf(id: ChunkId): PartialCut | null {
    const leaf = this.leafMap.get(id)!;
    if (!leaf.allowedLevels.includes(0)) return null;
    return {
      tokens: leaf.externallyAccounted ? 0 : leaf.rawTokens,
      frontier: new Map([[id, 0]]),
    };
  }

  private coverSummary(
    id: SummaryId,
    activeLeafIds: readonly ChunkId[],
    memo: Map<string, PartialCut | null>,
  ): PartialCut | null {
    if (activeLeafIds.length === 0) return { tokens: 0, frontier: new Map() };
    const key = `${id}\u0000${activeLeafIds.join('\u0001')}`;
    if (memo.has(key)) return cloneCut(memo.get(key) ?? null);
    const summary = this.summaryMap.get(id)!;

    const expanded = this.coverChildren(summary, activeLeafIds, memo);
    const participants: ChunkId[] = [];
    const holes: ChunkId[] = [];
    for (const leafId of activeLeafIds) {
      if (this.leafMap.get(leafId)!.allowedLevels.includes(summary.level)) {
        participants.push(leafId);
      } else {
        holes.push(leafId);
      }
    }

    let selected: PartialCut | null = null;
    if (participants.length > 0) {
      const holeCut = this.coverChildren(summary, holes, memo);
      if (holeCut) {
        const frontier = new Map(holeCut.frontier);
        for (const leafId of participants) frontier.set(leafId, summary.level);
        selected = { tokens: summary.recallTokens + holeCut.tokens, frontier };
      }
    }

    const best = chooseCheaper(expanded, selected);
    memo.set(key, cloneCut(best));
    return cloneCut(best);
  }

  private coverChildren(
    summary: CanonicalSummary,
    activeLeafIds: readonly ChunkId[],
    memo: Map<string, PartialCut | null>,
  ): PartialCut | null {
    const active = new Set(activeLeafIds);
    let combined: PartialCut = { tokens: 0, frontier: new Map() };
    for (const leafId of summary.directLeafIds) {
      if (!active.has(leafId)) continue;
      const cut = this.coverLeaf(leafId);
      if (!cut) return null;
      combined = mergeCuts(combined, cut);
    }
    for (const childId of summary.childSummaryIds) {
      const child = this.summaryMap.get(childId)!;
      const childActive = child.leafIds.filter((leafId) => active.has(leafId));
      if (childActive.length === 0) continue;
      const cut = this.coverSummary(childId, childActive, memo);
      if (!cut) return null;
      combined = mergeCuts(combined, cut);
    }
    return combined;
  }

  private certificate(
    reason: MinimumTokenCertificate['reason'],
    floorTokens: number | null,
    maxTokens: number,
  ): MinimumTokenCertificate {
    const protectedTokens =
      this.fixedTokens +
      this.orderedLeafList.reduce(
        (total, leaf) =>
          total +
          (!leaf.externallyAccounted &&
          leaf.allowedLevels.length === 1 &&
          leaf.allowedLevels[0] === 0
            ? leaf.rawTokens
            : 0),
        0,
      );
    const missingLevels = [
      ...new Set(this.constraintConflicts.flatMap((conflict) => conflict.requestedMissingLevels)),
    ].sort((a, b) => a - b);
    const requiredAdditionalTokens =
      floorTokens === null || !Number.isFinite(maxTokens)
        ? 0
        : Math.max(0, floorTokens - maxTokens);
    return {
      reason,
      floorTokens,
      bindingLeaves: this.constraintConflicts,
      protectedTokens,
      missingLevels,
      requiredAdditionalTokens,
      suggestion:
        reason === 'constraint-conflict'
          ? 'Release or reconcile the listed constraints, or produce the missing levels.'
          : `Raise W by at least ${requiredAdditionalTokens} tokens, or release a binding protection.`,
    };
  }
}

function mergeCuts(a: PartialCut, b: PartialCut): PartialCut {
  const frontier = new Map(a.frontier);
  for (const [id, level] of b.frontier) frontier.set(id, level);
  return { tokens: a.tokens + b.tokens, frontier };
}

function chooseCheaper(a: PartialCut | null, b: PartialCut | null): PartialCut | null {
  if (!a) return cloneCut(b);
  if (!b) return cloneCut(a);
  // Expanding wins exact ties. This makes the scalar pass deterministic and
  // avoids gratuitous representation changes when token cost is identical.
  return cloneCut(b.tokens < a.tokens ? b : a);
}

function cloneCut(cut: PartialCut | null): PartialCut | null {
  return cut ? { tokens: cut.tokens, frontier: new Map(cut.frontier) } : null;
}

function leafKey(id: ChunkId): string {
  return `leaf:${id}`;
}

function summaryKey(id: SummaryId): string {
  return `summary:${id}`;
}

function combineFrontiers(
  a: ReadonlyMap<ChunkId, number>,
  b: ReadonlyMap<ChunkId, number>,
): Map<ChunkId, number> {
  const combined = new Map(a);
  for (const [id, level] of b) combined.set(id, level);
  return combined;
}

function cloneFrontierSet(
  cuts: ReadonlyMap<string, ReadonlyMap<ChunkId, number>>,
): Map<string, Map<ChunkId, number>> {
  return new Map([...cuts].map(([key, frontier]) => [key, new Map(frontier)]));
}

function lowestSetBit(value: bigint): number {
  let index = 0;
  let cursor = value;
  while ((cursor & 1n) === 0n) {
    cursor >>= 1n;
    index++;
  }
  return index;
}
