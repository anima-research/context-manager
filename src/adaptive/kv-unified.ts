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
  /** Preserve summaries whose ownership leaves are disjoint but chronologically
   * interleaved with another ownership branch. The ownership forest remains
   * valid, but chronological solvers must treat the intervening branches as
   * protected gaps and emit them independently. */
  preserveGapBearingSummaries?: boolean;
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
  /** Representation hash per available level (parallel to `availableLevels`):
   * `raw:<id>` at level 0, `summary:<ancestor id>` above. Computed once per
   * leaf build so per-compile scoring never rebuilds these strings. */
  readonly repHashes: readonly string[];
  /** Position in `orderedLeaves()` (chronological). Stable across derived forests. */
  readonly index: number;
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
  /** Chunk ids are unique once validated, and chunks are visited in position
   *  order, so these lists hold distinct ids in increasing position. */
  directLeafIds: ChunkId[];
  leafIds: ChunkId[];
  /** Positions of `leafIds`, parallel to it. */
  leafPositions: number[];
}

/** Levels and representation hashes along one ownership chain, shared by
 *  every leaf under that chain. */
interface ChainLevels {
  availableLevels: readonly number[];
  hashTail: readonly string[];
}

/** `chunks` in (sequence, id) order: a copy when already ordered (sorting a
 *  sorted list still pays a comparator call per element), else sorted. */
/** `chunks` by sequence then id; a copy, so the caller's array is untouched. */
export function orderedChunks(chunks: readonly PickerChunk[]): PickerChunk[] {
  let ordered = true;
  for (let i = 1; ordered && i < chunks.length; i++) {
    const a = chunks[i - 1], b = chunks[i];
    ordered = a.sequence < b.sequence || (a.sequence === b.sequence && a.id.localeCompare(b.id) < 0);
  }
  return ordered ? chunks.slice() : [...chunks].sort(
    (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
  );
}

interface PartialCut {
  tokens: number;
  frontier: Map<ChunkId, number>;
}

const IMPOSSIBLE = Number.POSITIVE_INFINITY;

export type OrderedChild =
  | { kind: 'leaf'; id: ChunkId; firstSequence: number; key: string; index: number }
  | { kind: 'summary'; id: SummaryId; firstSequence: number; key: string };
const orderedChildrenCache = new WeakMap<CanonicalSummary, readonly OrderedChild[]>();
/** Positions (in `orderedLeaves()`) of a summary's leaves, parallel to its
 *  `leafIds`; stable across derived forests. */
const summaryLeafIndexCache = new WeakMap<CanonicalSummary, Int32Array>();
const summaryHashes = new WeakMap<CanonicalSummary, string>();
function summaryHashOf(summary: CanonicalSummary): string {
  let hash = summaryHashes.get(summary);
  if (hash === undefined) summaryHashes.set(summary, hash = `summary:${summary.id}`);
  return hash;
}

/** Parts of a forest derived from a previous one (see `derive`). */
export interface PrebuiltForestParts {
  readonly ownership: object;
  readonly chunks: readonly PickerChunk[];
  /** Positions of the leaves present at the full build (shared, never
   *  mutated) and of the leaves appended since (per forest). */
  readonly baseIndex: ReadonlyMap<ChunkId, number>;
  readonly appendedIndex: ReadonlyMap<ChunkId, number>;
  readonly summaryMap: ReadonlyMap<SummaryId, CanonicalSummary>;
  readonly orderedLeafList: readonly CanonicalLeaf[];
  readonly roots: readonly CanonicalRoot[];
  readonly constraintConflicts: readonly ConstraintConflict[];
  readonly treeifiedSummaryIds: readonly SummaryId[];
  readonly gapBearingSummaryIds: readonly SummaryId[];
  readonly leafZone: Uint8Array;
  readonly lineage?: ForestLineage;
}

/** How a forest's ownership relates to the forest it was extended from
 *  (see `derive`): consumers keyed by `ownership` may patch their state for
 *  the changed leaves and summaries instead of rebuilding it. */
export interface ForestLineage {
  /** The previous forest's `ownership`. */
  readonly parent: object;
  /** Positions whose leaf object is new (rebuilt or appended), ascending. */
  readonly changedLeaves: Int32Array;
  /** Summaries whose object is new (added, re-parented, or with changed
   *  leaves or children); every other summary object is shared. */
  readonly changedSummaryIds: ReadonlySet<SummaryId>;
}

/** Head/tail membership per ordered chunk: bit 0 head, bit 1 tail. */
function leafZones(chunks: readonly PickerChunk[], inputs: PickerInputs): Uint8Array {
  const zone = new Uint8Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const id = chunks[i].id;
    zone[i] = (inputs.headChunkIds.has(id) ? 1 : 0) | (inputs.tailChunkIds.has(id) ? 2 : 0);
  }
  return zone;
}

/** Whether `chunk` would build the leaf `leaf` was built from, read from the
 * leaf's own record of its inputs and not from a chunk object a caller may
 * have updated in place: cost and carried level are leaf fields, pins and
 * locks are its constraints (`constraintsFor`; the zone constraints are
 * compared by position, and option constraints make `derive` decline). The
 * leaf keeps its shape: the per-leaf loops of every compile read it. */
function sameLeafInputs(leaf: CanonicalLeaf, chunk: PickerChunk): boolean {
  if (leaf.rawTokens !== chunk.rawTokens || leaf.carriedLevel !== chunk.currentResolution) return false;
  let pinned = false, locked = false;
  let pinLevel: number | undefined, pinMaxLevel: number | undefined;
  for (const constraint of leaf.constraints) {
    switch (constraint.source) {
      case 'classic-pin': pinned = true; break;
      case 'lockedByAgent': locked = true; break;
      case 'pin-level': pinLevel = constraint.level; break;
      case 'pin-max-level': pinMaxLevel = constraint.level; break;
    }
  }
  return pinned === !!chunk.pinned && locked === !!chunk.lockedByAgent &&
    pinLevel === chunk.pinLevel && pinMaxLevel === chunk.pinMaxLevel;
}

export class CanonicalSummaryForest {
  readonly fixedTokens: number;
  readonly roots: readonly CanonicalRoot[];
  readonly constraintConflicts: readonly ConstraintConflict[];
  readonly treeifiedSummaryIds: readonly SummaryId[];
  readonly gapBearingSummaryIds: readonly SummaryId[];
  /** True when this forest was derived from a previous compile's forest. */
  readonly derived: boolean;
  /** Head/tail membership per ordered leaf (bit 0 head, bit 1 tail), so a
   *  derive compares zones without four set lookups per chunk. */
  private readonly leafZone: Uint8Array;
  /** Identity of the ownership structure: shared by every forest derived
   * from the same full build, new on each full build and on each extension
   * (see `lineage`). */
  readonly ownership: object;
  /** Set when this forest's ownership was extended from a previous one. */
  readonly lineage: ForestLineage | undefined;
  private internalHolesMemo: boolean | undefined;

  /** Leaf positions in `orderedLeafList`: ids present at the full build in
   *  `baseIndex` (shared by derived forests, never mutated), ids appended by
   *  derives in `appendedIndex` (copied per forest). `leaf()` checks the id
   *  at the position, so no forest ever reads another forest's leaf. */
  private readonly baseIndex: ReadonlyMap<ChunkId, number>;
  private readonly appendedIndex: ReadonlyMap<ChunkId, number>;
  private readonly summaryMap: ReadonlyMap<SummaryId, CanonicalSummary>;
  private readonly orderedLeafList: readonly CanonicalLeaf[];
  // What this forest was built from, kept so the next compile can derive
  // from it instead of rebuilding ownership over every leaf.
  private readonly sourceChunks: readonly PickerChunk[];
  private readonly sourceInputs: PickerInputs;
  /** `inputs.chunks` as given, element by element, for `builtFrom`. */
  private readonly sourceChunkList: readonly PickerChunk[];
  private readonly sourceOptions: CanonicalForestOptions;

  constructor(inputs: PickerInputs, options: CanonicalForestOptions = {}, prebuilt?: PrebuiltForestParts) {
    this.fixedTokens = inputs.headTokens + inputs.tailTokens;
    this.sourceInputs = inputs;
    this.sourceChunkList = [...inputs.chunks];
    this.sourceOptions = options;
    this.derived = prebuilt !== undefined;
    this.ownership = prebuilt?.ownership ?? {};
    this.lineage = prebuilt?.lineage;
    if (prebuilt) {
      this.sourceChunks = prebuilt.chunks;
      this.leafZone = prebuilt.leafZone;
      this.baseIndex = prebuilt.baseIndex;
      this.appendedIndex = prebuilt.appendedIndex;
      this.summaryMap = prebuilt.summaryMap;
      this.orderedLeafList = prebuilt.orderedLeafList;
      this.roots = prebuilt.roots;
      this.constraintConflicts = prebuilt.constraintConflicts;
      this.treeifiedSummaryIds = prebuilt.treeifiedSummaryIds;
      this.gapBearingSummaryIds = prebuilt.gapBearingSummaryIds;
      return;
    }
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
    const chunks = orderedChunks(inputs.chunks);
    this.leafZone = leafZones(chunks, inputs);
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

    /** Ownership chain per chunk, by position in `chunks`. */
    const chainOf: SummaryId[][] = new Array(chunks.length);
    // Every chunk under one L1 has the same chain: a walk that raised no
    // issue is shared; a walk with issues is repeated per chunk so each
    // issue names its chunk as before.
    const cleanChainByL1 = new Map<SummaryId, SummaryId[]>();
    for (let at = 0; at < chunks.length; at++) {
      const chunk = chunks[at];
      if (chunk.l1Id !== undefined) {
        const known = cleanChainByL1.get(chunk.l1Id);
        if (known) { chainOf[at] = known; continue; }
      }
      const issuesBefore = issues.length;
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
        chain.push(entry.id);
        previousLevel = entry.level;
        currentId = getSummaryParentId(entry);
      }
      chainOf[at] = chain;
      if (chunk.l1Id !== undefined && issues.length === issuesBefore) cleanChainByL1.set(chunk.l1Id, chain);
    }

    if (issues.length > 0) throw new CanonicalForestError(issues);

    const indexOfLeaf = new Map(chunks.map((chunk, index) => [chunk.id, index] as const));
    const treeified = new Set<SummaryId>();
    const gapBearing = new Set<SummaryId>();
    if (
      options.treeifyNonContiguousSummaries &&
      options.preserveGapBearingSummaries
    ) {
      throw new Error(
        'treeifyNonContiguousSummaries and preserveGapBearingSummaries are mutually exclusive',
      );
    }
    const mutableSummaries = new Map<SummaryId, MutableSummary>();
    const rebuildOwnership = (): void => {
      mutableSummaries.clear();
      // Summaries are created in first-seen order along each chain, L1 up;
      // a chain array is resolved to its summaries once and its parent links
      // recorded once (child order is sorted below).
      const owners = new Map<SummaryId[], MutableSummary[]>();
      for (let at = 0; at < chunks.length; at++) {
        const chain = chainOf[at];
        if (chain.length === 0) continue;
        let resolved = owners.get(chain);
        if (resolved === undefined) {
          resolved = new Array(chain.length);
          for (let i = 0; i < chain.length; i++) {
            const id = chain[i];
            let summary = mutableSummaries.get(id);
            if (summary === undefined) {
              const entry = inputs.summaries.get(id)!;
              summary = {
                id,
                level: entry.level,
                recallTokens: inputs.recallPairTokens?.get(id) ?? entry.tokens,
                parentId: getSummaryParentId(entry),
                childSummaryIds: new Set(),
                directLeafIds: [],
                leafIds: [],
                leafPositions: [],
              };
              mutableSummaries.set(id, summary);
            }
            resolved[i] = summary;
            if (i > 0) summary.childSummaryIds.add(chain[i - 1]);
          }
          owners.set(chain, resolved);
        }
        const chunkId = chunks[at].id;
        resolved[0].directLeafIds.push(chunkId);
        for (const summary of resolved) { summary.leafIds.push(chunkId); summary.leafPositions.push(at); }
      }
    };
    while (true) {
      rebuildOwnership();
      const contiguityIssues: CanonicalForestIssue[] = [];
      for (const summary of mutableSummaries.values()) {
        // Leaf ids are listed in increasing position, so the owned leaves
        // are contiguous exactly when the list spans as many positions as it
        // has entries.
        const positions = summary.leafPositions;
        if (positions.length > 0 && positions[positions.length - 1] - positions[0] + 1 !== positions.length) {
          contiguityIssues.push({
            code: 'non-contiguous-ownership',
            message: `summary ${summary.id} owns non-contiguous live leaves`,
            leafIds: [...summary.leafIds],
            summaryIds: [summary.id],
          });
        }
      }
      if (contiguityIssues.length === 0) break;
      if (options.preserveGapBearingSummaries) {
        for (const issue of contiguityIssues) {
          for (const id of issue.summaryIds) gapBearing.add(id);
        }
        break;
      }
      if (!options.treeifyNonContiguousSummaries) {
        throw new CanonicalForestError(contiguityIssues);
      }
      const newlyTreeified = new Set(contiguityIssues.flatMap((issue) => issue.summaryIds));
      for (const id of newlyTreeified) treeified.add(id);
      for (let at = 0; at < chainOf.length; at++) {
        const chain = chainOf[at];
        const cut = chain.findIndex((id) => newlyTreeified.has(id));
        if (cut >= 0) chainOf[at] = chain.slice(0, cut);
      }
    }

    const summaryMap = new Map<SummaryId, CanonicalSummary>();
    // rebuildOwnership inserts leaf ids in chunk (position) order, so each
    // set already lists its leaves by position; a summary's first position
    // is its first leaf's.
    const firstPosition = new Map<SummaryId, number>();
    for (const summary of mutableSummaries.values()) {
      firstPosition.set(summary.id, summary.leafPositions.length === 0 ? Infinity : summary.leafPositions[0]);
    }
    for (const summary of mutableSummaries.values()) {
      const leafIds = summary.leafIds;
      const built: CanonicalSummary = {
        kind: 'summary',
        id: summary.id,
        level: summary.level,
        recallTokens: summary.recallTokens,
        parentId: summary.parentId,
        childSummaryIds: [...summary.childSummaryIds].sort((a, b) =>
          firstPosition.get(a)! - firstPosition.get(b)! || a.localeCompare(b)),
        directLeafIds: summary.directLeafIds,
        leafIds,
        firstSequence: chunkById.get(leafIds[0])!.sequence,
        lastSequence: chunkById.get(leafIds[leafIds.length - 1])!.sequence,
      };
      summaryMap.set(summary.id, built);
      // The positions are known here; `leafIndicesOf` would recompute them
      // through the leaf index for every summary of every new forest.
      summaryLeafIndexCache.set(built, Int32Array.from(summary.leafPositions));
    }

    const orderedLeafList: CanonicalLeaf[] = new Array(chunks.length);
    const conflicts: ConstraintConflict[] = [];
    const chainLevels = new Map<readonly SummaryId[], ChainLevels>();
    for (let i = 0; i < chunks.length; i++) {
      const built = CanonicalSummaryForest.buildLeaf(chunks[i], chainOf[i], inputs, options, summaryMap, i, chainLevels);
      orderedLeafList[i] = built.leaf;
      if (built.conflict) conflicts.push(built.conflict);
    }

    // Chunk ids are unique here, so every ownerless chunk is its own root;
    // a summary root repeats for every chunk under it.
    const roots: CanonicalRoot[] = [];
    const seenSummaryRoots = new Set<SummaryId>();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chain = chainOf[i];
      if (chain.length === 0) {
        roots.push({ kind: 'leaf', id: chunk.id, firstSequence: chunk.sequence });
      } else {
        const id = chain[chain.length - 1];
        if (!seenSummaryRoots.has(id)) {
          roots.push({
            kind: 'summary',
            id,
            firstSequence: summaryMap.get(id)!.firstSequence,
          });
          seenSummaryRoots.add(id);
        }
      }
    }
    roots.sort((a, b) => a.firstSequence - b.firstSequence || a.id.localeCompare(b.id));

    this.sourceChunks = chunks;
    this.baseIndex = indexOfLeaf;
    this.appendedIndex = new Map();
    this.summaryMap = summaryMap;
    this.orderedLeafList = orderedLeafList;
    this.roots = roots;
    this.constraintConflicts = conflicts;
    this.treeifiedSummaryIds = [...treeified].sort();
    this.gapBearingSummaryIds = [...gapBearing].sort();
  }

  /**
   * Derive when ownership changed by additions: new summaries, children
   * re-parented under them, ownerless leaves now owned, owned leaves
   * appended. Only the leaves whose chain changed and the summaries on an
   * old or new chain of such a leaf are rebuilt; every other leaf and summary
   * object is shared with `previous`, and `lineage` names what changed. The
   * result equals a full build of `inputs`; any input the full build would
   * reject, or treeified or gap-bearing ownership, returns null so the
   * constructor runs with its own diagnostics. Called by `derive` after its
   * checks on options, summaries' levels and costs, and chunk positions.
   */
  private static extend(
    previous: CanonicalSummaryForest,
    inputs: PickerInputs,
    options: CanonicalForestOptions,
    chunks: readonly PickerChunk[],
  ): CanonicalSummaryForest | null {
    if (previous.treeifiedSummaryIds.length > 0 || previous.gapBearingSummaryIds.length > 0) return null;
    const oldLeaves = previous.orderedLeafList;
    const oldMap = previous.summaryMap;
    // One chain walk per L1, validated as the full build validates it; the
    // previous chain array is kept when the ids did not change.
    const chainByL1 = new Map<SummaryId, SummaryId[]>();
    const walk = (l1Id: SummaryId): SummaryId[] | null => {
      const known = chainByL1.get(l1Id);
      if (known) return known;
      const chain: SummaryId[] = [];
      const seen = new Set<SummaryId>();
      let currentId: SummaryId | undefined = l1Id;
      let previousLevel = 0;
      while (currentId !== undefined) {
        if (seen.has(currentId)) return null;
        seen.add(currentId);
        const entry = inputs.summaries.get(currentId);
        if (!entry) return null;
        if (chain.length === 0 && entry.level !== 1) return null;
        if (entry.level <= previousLevel) return null;
        const recallTokens = inputs.recallPairTokens?.get(entry.id) ?? entry.tokens;
        if (!Number.isFinite(recallTokens) || recallTokens < 0) return null;
        chain.push(entry.id);
        previousLevel = entry.level;
        currentId = getSummaryParentId(entry);
      }
      const placed = oldMap.get(l1Id);
      let result = chain;
      if (placed) {
        const first = previous.leafIndicesOf(placed)[0];
        const before = oldLeaves[first].summaryIds;
        let same = before.length === chain.length;
        for (let k = 0; same && k < chain.length; k++) same = before[k] === chain[k];
        if (same) result = before as SummaryId[];
      }
      chainByL1.set(l1Id, result);
      return result;
    };
    const zone = leafZones(chunks, inputs);
    const oldZone = previous.leafZone;
    const n = chunks.length;
    const chainOf: (readonly SummaryId[])[] = new Array(n);
    const rebuilt = new Uint8Array(n);
    const changedSummaryIds = new Set<SummaryId>();
    /** L1s whose owned positions differ from the previous forest, with those positions. */
    const positionsOfL1 = new Map<SummaryId, number[]>();
    const noChain: readonly SummaryId[] = [];
    for (let i = 0; i < n; i++) {
      const chunk = chunks[i];
      const chain = chunk.l1Id === undefined ? noChain : walk(chunk.l1Id);
      if (chain === null) return null;
      chainOf[i] = chain;
      const before = i < oldLeaves.length ? oldLeaves[i].summaryIds : null;
      // `walk` returns the previous chain array when the ids match, so a
      // different non-empty array is a different chain; empty chains are
      // one per leaf in a full build and compare by length.
      const ownedChanged = before === null ? chain.length > 0
        : before !== chain && (before.length > 0 || chain.length > 0);
      if (ownedChanged) {
        if (before) for (const id of before) changedSummaryIds.add(id);
        for (const id of chain) changedSummaryIds.add(id);
        // A leaf newly owned by this L1 (it was ownerless or appended); a
        // re-parented L1 keeps its previous leaves, added below.
        if (chunk.l1Id !== undefined && (before === null || before.length === 0)) {
          let positions = positionsOfL1.get(chunk.l1Id);
          if (!positions) positionsOfL1.set(chunk.l1Id, positions = []);
          positions.push(i);
        }
      }
      if (ownedChanged || before === null || !sameLeafInputs(oldLeaves[i], chunk) || oldZone[i] !== zone[i]) rebuilt[i] = 1;
    }
    if (changedSummaryIds.size === 0) return null;
    // An L1 that gained leaves keeps its previous ones too (disjoint sets).
    for (const [l1Id, positions] of positionsOfL1) {
      const placed = oldMap.get(l1Id);
      if (placed) positions.push(...previous.leafIndicesOf(placed));
    }
    // Leaves and children of every changed summary, from the L1 blocks under it.
    const leavesOf = new Map<SummaryId, number[]>();
    const childrenOf = new Map<SummaryId, Set<SummaryId>>();
    for (const [l1Id, chain] of chainByL1) {
      let touches = false;
      for (const id of chain) if (changedSummaryIds.has(id)) { touches = true; break; }
      if (!touches) continue;
      let block = positionsOfL1.get(l1Id);
      if (!block) {
        const placed = oldMap.get(l1Id);
        if (!placed) return null;
        block = Array.from(previous.leafIndicesOf(placed));
      }
      for (let k = 0; k < chain.length; k++) {
        const id = chain[k];
        if (!changedSummaryIds.has(id)) continue;
        let positions = leavesOf.get(id);
        if (!positions) leavesOf.set(id, positions = []);
        for (const at of block) positions.push(at);
        if (k > 0) {
          let children = childrenOf.get(id);
          if (!children) childrenOf.set(id, children = new Set());
          children.add(chain[k - 1]);
        }
      }
    }
    for (const id of changedSummaryIds) {
      // A summary on an old chain only (its leaves moved away) would need a
      // removal; the full build decides.
      if (!leavesOf.has(id)) return null;
    }
    const summaryMap = new Map(oldMap);
    const firstPositionOf = (id: SummaryId): number => {
      const positions = leavesOf.get(id);
      if (positions) return positions[0];
      return previous.leafIndicesOf(oldMap.get(id)!)[0];
    };
    for (const positions of leavesOf.values()) {
      positions.sort((a, b) => a - b);
      if (positions[positions.length - 1] - positions[0] + 1 !== positions.length) return null;
    }
    for (const [id, positions] of leavesOf) {
      const entry = inputs.summaries.get(id)!;
      const leafIds = positions.map((at) => chunks[at].id);
      const children = childrenOf.get(id);
      const summary: CanonicalSummary = {
        kind: 'summary',
        id,
        level: entry.level,
        recallTokens: inputs.recallPairTokens?.get(id) ?? entry.tokens,
        parentId: getSummaryParentId(entry),
        childSummaryIds: children
          ? [...children].sort((a, b) => firstPositionOf(a) - firstPositionOf(b) || a.localeCompare(b))
          : [],
        // Chains start at the L1, so only an L1 has direct leaves, and they
        // are all of its leaves.
        directLeafIds: entry.level === 1 ? leafIds : [],
        leafIds,
        firstSequence: chunks[positions[0]].sequence,
        lastSequence: chunks[positions[positions.length - 1]].sequence,
      };
      summaryMap.set(id, summary);
      summaryLeafIndexCache.set(summary, Int32Array.from(positions));
    }
    const appendedIndex = new Map(previous.appendedIndex);
    const previousConflicts = new Map(previous.constraintConflicts.map((conflict) => [conflict.leafId, conflict]));
    const conflicts: ConstraintConflict[] = [];
    const orderedLeaves: CanonicalLeaf[] = new Array(n);
    const chainLevels = new Map<readonly SummaryId[], ChainLevels>();
    const changedLeaves: number[] = [];
    for (let i = 0; i < n; i++) {
      const chunk = chunks[i];
      if (i >= oldLeaves.length) appendedIndex.set(chunk.id, i);
      if (rebuilt[i] === 0) {
        orderedLeaves[i] = oldLeaves[i];
        if (previousConflicts.size > 0) {
          const conflict = previousConflicts.get(chunk.id);
          if (conflict) conflicts.push(conflict);
        }
        continue;
      }
      if (i < oldLeaves.length && (!Number.isFinite(chunk.rawTokens) || chunk.rawTokens < 0)) return null;
      const result = CanonicalSummaryForest.buildLeaf(chunk, chainOf[i], inputs, options, summaryMap, i, chainLevels);
      orderedLeaves[i] = result.leaf;
      if (result.conflict) conflicts.push(result.conflict);
      changedLeaves.push(i);
    }
    const roots: CanonicalRoot[] = [];
    const seenSummaryRoots = new Set<SummaryId>();
    for (let i = 0; i < n; i++) {
      const chain = chainOf[i];
      if (chain.length === 0) {
        roots.push({ kind: 'leaf', id: chunks[i].id, firstSequence: chunks[i].sequence });
      } else {
        const id = chain[chain.length - 1];
        if (!seenSummaryRoots.has(id)) {
          roots.push({ kind: 'summary', id, firstSequence: summaryMap.get(id)!.firstSequence });
          seenSummaryRoots.add(id);
        }
      }
    }
    roots.sort((a, b) => a.firstSequence - b.firstSequence || a.id.localeCompare(b.id));
    return new CanonicalSummaryForest(inputs, options, {
      ownership: {},
      chunks, baseIndex: previous.baseIndex, appendedIndex, summaryMap, orderedLeafList: orderedLeaves, roots,
      constraintConflicts: conflicts,
      treeifiedSummaryIds: [],
      gapBearingSummaryIds: [],
      leafZone: zone,
      lineage: { parent: previous.ownership, changedLeaves: Int32Array.from(changedLeaves), changedSummaryIds },
    });
  }

  /** The per-leaf layer: available levels from the ownership chain, then the
   * leaf's constraints narrow them. Independent of every other leaf. */
  private static buildLeaf(
    chunk: PickerChunk,
    chain: readonly SummaryId[],
    inputs: PickerInputs,
    options: CanonicalForestOptions,
    summaryMap: ReadonlyMap<SummaryId, CanonicalSummary>,
    index: number,
    shared?: Map<readonly SummaryId[], ChainLevels>,
  ): { leaf: CanonicalLeaf; conflict?: ConstraintConflict } {
    // Levels and summary hashes depend only on the chain; leaves under one
    // chain array share them (`availableLevels` is read-only everywhere).
    let levels = shared?.get(chain);
    if (levels === undefined) {
      const availableLevels: number[] = [0];
      const hashTail: string[] = [];
      for (const id of chain) {
        const summary = summaryMap.get(id)!;
        availableLevels.push(summary.level);
        hashTail.push(summaryHashOf(summary));
      }
      levels = { availableLevels, hashTail };
      shared?.set(chain, levels);
    }
    const availableLevels = levels.availableLevels;
    const repHashes = [`raw:${chunk.id}`, ...levels.hashTail];
    const constraints = CanonicalSummaryForest.constraintsFor(chunk, inputs, options);
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
      repHashes,
      index,
    };
    if (allowedLevels.length === 0) {
      return {
        leaf,
        conflict: {
          leafId: chunk.id,
          availableLevels,
          constraints,
          requestedMissingLevels: [...requestedMissingLevels].sort((a, b) => a - b),
        },
      };
    }
    return { leaf };
  }

  /**
   * Build the forest for `inputs` from `previous` when ownership did not
   * change: every previous leaf is still there in the same order with the
   * same L1 link, only ownerless leaves were appended, summaries and recall
   * costs are identical, and the options match. Summary nodes, treeified and
   * gap-bearing sets are shared. Leaves whose own fields or head/tail
   * membership changed are rebuilt; the rest are shared. Returns null when a
   * full build is needed, which the caller does with the constructor.
   */
  static derive(
    previous: CanonicalSummaryForest,
    inputs: PickerInputs,
    options: CanonicalForestOptions = {},
  ): CanonicalSummaryForest | null {
    const po = previous.sourceOptions;
    if (options.constraints || options.overlapExempt || po.constraints || po.overlapExempt) return null;
    if (
      Boolean(options.treeifyNonContiguousSummaries) !== Boolean(po.treeifyNonContiguousSummaries) ||
      Boolean(options.preserveGapBearingSummaries) !== Boolean(po.preserveGapBearingSummaries)
    ) return null;
    if (
      !Number.isFinite(inputs.headTokens) || inputs.headTokens < 0 ||
      !Number.isFinite(inputs.tailTokens) || inputs.tailTokens < 0
    ) return null;
    const pi = previous.sourceInputs;
    // Summaries are compared with the previous forest's own record of them:
    // the strategy updates a child's parent link on the entry object itself
    // when an upper summary arrives, so the old input map may already show
    // the new link. A summary the previous forest did not place (no chain
    // reached it) is compared with the old entry as before.
    let ownershipChanged = false;
    for (const [id, entry] of inputs.summaries) {
      const placed = previous.summaryMap.get(id);
      const recall = inputs.recallPairTokens?.get(id) ?? entry.tokens;
      if (placed) {
        if (placed.level !== entry.level || placed.recallTokens !== recall) return null;
        if (getSummaryParentId(entry) !== placed.parentId) ownershipChanged = true;
        continue;
      }
      const old = pi.summaries.get(id);
      if (!old) { ownershipChanged = true; continue; }
      if (old.level !== entry.level || getSummaryParentId(old) !== getSummaryParentId(entry)) return null;
      if (recall !== (pi.recallPairTokens?.get(id) ?? old.tokens)) return null;
    }
    // A placed summary that is gone is a full build (which reports any chunk
    // still pointing at it). Checked against the previous forest's own
    // record, not the old input map: a caller may edit that map in place.
    for (const id of previous.summaryMap.keys()) if (!inputs.summaries.has(id)) return null;
    const chunks = orderedChunks(inputs.chunks);
    const oldLeaves = previous.orderedLeafList;
    if (chunks.length < oldLeaves.length) return null;
    for (let i = 0; i < oldLeaves.length; i++) {
      // Position, id and ownership are read from the leaf the previous forest
      // built, not from the old chunk object, which a caller may have updated
      // in place since.
      const leaf = oldLeaves[i], b = chunks[i];
      if (leaf.id !== b.id || leaf.sequence !== b.sequence) return null;
      const l1Id = leaf.summaryIds.length > 0 ? leaf.summaryIds[0] : undefined;
      if (l1Id !== b.l1Id) {
        // A leaf may become owned; any other change of ownership is a full build.
        if (l1Id !== undefined) return null;
        ownershipChanged = true;
      }
    }
    let lastSequence = oldLeaves.length > 0 ? oldLeaves[oldLeaves.length - 1].sequence : -Infinity;
    const appendedIds = chunks.length > oldLeaves.length ? new Set<ChunkId>() : null;
    for (let i = oldLeaves.length; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.sequence <= lastSequence || previous.leaf(chunk.id) !== null) return null;
      if (!Number.isFinite(chunk.rawTokens) || chunk.rawTokens < 0) return null;
      if (appendedIds!.has(chunk.id)) return null;
      appendedIds!.add(chunk.id);
      if (chunk.l1Id !== undefined) ownershipChanged = true;
      lastSequence = chunk.sequence;
    }
    if (ownershipChanged) return CanonicalSummaryForest.extend(previous, inputs, options, chunks);

    const zone = leafZones(chunks, inputs);
    const oldZone = previous.leafZone;
    // The derived forest takes over the previous forest's leaf map and
    // extends it in place (appended leaves added, changed leaves replaced):
    // the previous forest is superseded by this one, and nothing reads it
    // for leaves it did not have. Its ordered leaf list stays its own.
    const appendedIndex = new Map(previous.appendedIndex);
    const previousConflicts = new Map(previous.constraintConflicts.map((conflict) => [conflict.leafId, conflict]));
    const conflicts: ConstraintConflict[] = [];
    const orderedLeaves: CanonicalLeaf[] = new Array(chunks.length);
    const roots = [...previous.roots];
    let ownedLeafChanged = false;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Ids match positionally (checked above), so the previous leaf list
      // answers without a map lookup per chunk.
      if (i < oldLeaves.length && sameLeafInputs(oldLeaves[i], chunk) && oldZone[i] === zone[i]) {
        orderedLeaves[i] = oldLeaves[i];
        if (previousConflicts.size > 0) {
          const conflict = previousConflicts.get(chunk.id);
          if (conflict) conflicts.push(conflict);
        }
        continue;
      }
      if (i < oldLeaves.length && (!Number.isFinite(chunk.rawTokens) || chunk.rawTokens < 0)) return null;
      const chain = i < oldLeaves.length ? oldLeaves[i].summaryIds : [];
      if (chain.length > 0) ownedLeafChanged = true;
      const built = CanonicalSummaryForest.buildLeaf(chunk, chain, inputs, options, previous.summaryMap, i);
      if (i >= oldLeaves.length) appendedIndex.set(chunk.id, i);
      orderedLeaves[i] = built.leaf;
      if (built.conflict) conflicts.push(built.conflict);
      if (i >= oldLeaves.length) {
        // Appended leaves carry sequences above every previous leaf (checked
        // above), so pushing them in chunk order keeps the roots sorted.
        roots.push({ kind: 'leaf', id: chunk.id, firstSequence: chunk.sequence });
      }
    }
    const derived = new CanonicalSummaryForest(inputs, options, {
      ownership: previous.ownership,
      chunks, baseIndex: previous.baseIndex, appendedIndex, summaryMap: previous.summaryMap, orderedLeafList: orderedLeaves, roots,
      constraintConflicts: conflicts,
      treeifiedSummaryIds: previous.treeifiedSummaryIds,
      gapBearingSummaryIds: previous.gapBearingSummaryIds,
      leafZone: zone,
    });
    if (!ownedLeafChanged) derived.internalHolesMemo = previous.internalHolesMemo;
    return derived;
  }

  orderedLeaves(): readonly CanonicalLeaf[] {
    return this.orderedLeafList;
  }

  /** Leaf count of the full build this forest descends from. A derive keeps
   * every position below it under the same leaf id (ids are checked by
   * position, and an extension runs after that check), so forests of one
   * ownership, and extensions of them, can differ only from here on. */
  get baseLeafCount(): number {
    return this.baseIndex.size;
  }

  /** Whether `orderedChunks()` is the sorted form of exactly these inputs'
   * chunks: the same inputs object, still holding the same chunk objects
   * (a chunk replaced inside the array after the build is detected). */
  builtFrom(inputs: PickerInputs): boolean {
    if (inputs !== this.sourceInputs) return false;
    const given = inputs.chunks, snapshot = this.sourceChunkList;
    if (given.length !== snapshot.length) return false;
    for (let i = 0; i < given.length; i++) if (given[i] !== snapshot[i]) return false;
    return true;
  }

  /** The picker chunks in leaf order (parallel to `orderedLeaves()`). */
  orderedChunks(): readonly PickerChunk[] {
    return this.sourceChunks;
  }

  /** Some summary has a live participant and a live non-participant leaf: a
   * protected hole inside its span. Depends only on this forest's leaves and
   * summaries, so it is computed once and inherited by derived forests whose
   * owned leaves did not change. */
  hasInternalProtectedHoles(): boolean {
    if (this.internalHolesMemo !== undefined) return this.internalHolesMemo;
    let holes = false;
    const masks = this.allowedLevelMasks();
    const leaves = this.orderedLeafList;
    for (const summary of this.allSummaries()) {
      let live = 0, allowed = 0;
      if (summary.level < 31) {
        // The same test by position and allowed-level bit.
        const indices = this.leafIndicesOf(summary);
        const bit = 1 << summary.level;
        for (let k = 0; k < indices.length; k++) {
          const i = indices[k];
          if (leaves[i].externallyAccounted) continue;
          live++;
          if (masks[i] & bit) allowed++;
        }
      } else {
        for (const id of summary.leafIds) {
          const leaf = this.leafOf(id)!;
          if (leaf.externallyAccounted) continue;
          live++;
          if (leaf.allowedLevels.includes(summary.level)) allowed++;
        }
      }
      if (allowed > 0 && allowed < live) { holes = true; break; }
    }
    return this.internalHolesMemo = holes;
  }

  leaf(id: ChunkId): CanonicalLeaf | null {
    const at = this.appendedIndex.get(id) ?? this.baseIndex.get(id);
    if (at === undefined || at >= this.orderedLeafList.length) return null;
    const leaf = this.orderedLeafList[at];
    return leaf.id === id ? leaf : null;
  }

  private leafOf(id: ChunkId): CanonicalLeaf | undefined {
    return this.leaf(id) ?? undefined;
  }

  /** Allowed levels per leaf position (`orderedLeaves()` order) as bits,
   *  levels below 31; built once per forest. */
  allowedLevelMasks(): Uint32Array {
    if (this.allowedMasksMemo) return this.allowedMasksMemo;
    const leaves = this.orderedLeafList;
    const masks = new Uint32Array(leaves.length);
    for (let i = 0; i < leaves.length; i++) {
      let mask = 0;
      for (const level of leaves[i].allowedLevels) if (level >= 0 && level < 31) mask |= 1 << level;
      masks[i] = mask;
    }
    return this.allowedMasksMemo = masks;
  }
  private allowedMasksMemo: Uint32Array | undefined;

  /** Positions in `orderedLeaves()` of a summary's leaves, parallel to its
   *  `leafIds`; cached per summary object and stable across derived forests. */
  leafIndicesOf(summary: CanonicalSummary): Int32Array {
    let indices = summaryLeafIndexCache.get(summary);
    if (!indices) {
      indices = Int32Array.from(summary.leafIds, (id) => this.leafOf(id)!.index);
      summaryLeafIndexCache.set(summary, indices);
    }
    return indices;
  }

  summary(id: SummaryId): CanonicalSummary | null {
    return this.summaryMap.get(id) ?? null;
  }

  allSummaries(): readonly CanonicalSummary[] {
    return this.allSummariesMemo ??= [...this.summaryMap.values()].sort(
      (a, b) => a.firstSequence - b.firstSequence || a.level - b.level || a.id.localeCompare(b.id),
    );
  }
  private allSummariesMemo: readonly CanonicalSummary[] | undefined;

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
        this.leafOf(leafId)!.allowedLevels.includes(summary.level),
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
      const leaf = this.leafOf(id)!;
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
        this.leafOf(leafId)!.allowedLevels.includes(summary.level),
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

  /** `tokensForFrontier` for a frontier given as the level per leaf in
   * `orderedLeaves()` order (missing entries are raw). Same sums, same order. */
  tokensForLevels(levels: ArrayLike<number>): number {
    let tokens = this.fixedTokens;
    const summaries = new Set<SummaryId>();
    const leaves = this.orderedLeafList;
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const level = levels[i] ?? 0;
      if (!leaf.allowedLevels.includes(level)) {
        throw new Error(`frontier selects disallowed L${level} for ${leaf.id}`);
      }
      if (level === 0) {
        if (!leaf.externallyAccounted) tokens += leaf.rawTokens;
        continue;
      }
      const slot = leaf.availableLevels.indexOf(level);
      const summaryId = slot > 0 ? leaf.summaryIds[slot - 1] : undefined;
      if (!summaryId) throw new Error(`frontier selects unavailable L${level} for ${leaf.id}`);
      summaries.add(summaryId);
    }
    for (const summaryId of summaries) tokens += this.summaryMap.get(summaryId)!.recallTokens;
    return tokens;
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
          const candidateAllowsSummary = this.leafOf(candidateId)!
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

    // The active set is always a subset of the summary's leaves; the full set
    // is the common case (no hole above it) and keys by the id alone, in its
    // own tables, so no partial key can alias a summary id.
    const memoFull = new Map<string, number>();
    const memoPartial = new Map<string, number>();
    const selectedFull = new Map<string, boolean>();
    const selectedPartial = new Map<string, boolean>();
    const isFull = (id: SummaryId, active: readonly ChunkId[]): boolean =>
      active.length === this.summaryMap.get(id)!.leafIds.length;
    const keyOf = (id: SummaryId, active: readonly ChunkId[]): string =>
      isFull(id, active) ? id : `${id}\u0000${active.join('\u0001')}`;
    const leafCost = (id: ChunkId): number => {
      const leaf = this.leafOf(id)!;
      if (!leaf.allowedLevels.includes(0)) return IMPOSSIBLE;
      return leaf.externallyAccounted ? 0 : leaf.rawTokens;
    };
    // For a fully owned summary the participants are a bit test per leaf
    // position; the id arrays are only built when there are holes.
    const allowed = this.allowedLevelMasks();
    const leaves = this.orderedLeafList;
    const leafCostAt = (index: number): number => {
      if ((allowed[index] & 1) === 0) return IMPOSSIBLE;
      const leaf = leaves[index];
      return leaf.externallyAccounted ? 0 : leaf.rawTokens;
    };
    const participantsOf = (summary: CanonicalSummary, activeIds: readonly ChunkId[]):
      { count: number; ids: () => ChunkId[] } => {
      if (activeIds.length === summary.leafIds.length && summary.level < 31) {
        const indices = this.leafIndicesOf(summary);
        const bit = 1 << summary.level;
        let count = 0;
        for (let k = 0; k < indices.length; k++) if (allowed[indices[k]] & bit) count++;
        return { count, ids: () => summary.leafIds.filter((_, k) => (allowed[indices[k]] & bit) !== 0) };
      }
      const ids = activeIds.filter((leafId) => this.leafOf(leafId)!.allowedLevels.includes(summary.level));
      return { count: ids.length, ids: () => ids };
    };
    const childrenCost = (summary: CanonicalSummary, activeIds: readonly ChunkId[]): number => {
      let total = 0;
      if (activeIds.length === summary.leafIds.length) {
        // Every child is fully active: the same terms in the same order, with
        // no membership set and no per-child filter.
        for (const child of this.orderedChildren(summary)) {
          if (child.kind === 'leaf') total += leafCostAt(child.index);
          else {
            const childSummary = this.summaryMap.get(child.id)!;
            if (childSummary.leafIds.length > 0) total += summaryCost(child.id, childSummary.leafIds);
          }
          if (!Number.isFinite(total)) return IMPOSSIBLE;
        }
        return total;
      }
      const active = new Set(activeIds);
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
      const full = isFull(id, activeIds);
      const key = keyOf(id, activeIds);
      const memo = full ? memoFull : memoPartial;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const summary = this.summaryMap.get(id)!;
      const expanded = childrenCost(summary, activeIds);
      const participants = participantsOf(summary, activeIds);
      let selected = IMPOSSIBLE;
      if (participants.count === activeIds.length) {
        selected = summary.recallTokens + 0;
      } else if (participants.count > 0) {
        const participantSet = new Set(participants.ids());
        const holes = activeIds.filter((leafId) => !participantSet.has(leafId));
        const holeCost = childrenCost(summary, holes);
        if (Number.isFinite(holeCost)) selected = summary.recallTokens + holeCost;
      }
      const useSelected = selected < expanded;
      const best = useSelected ? selected : expanded;
      memo.set(key, best);
      (full ? selectedFull : selectedPartial).set(key, useSelected);
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
      if (activeIds.length === summary.leafIds.length) {
        for (const child of this.orderedChildren(summary)) {
          if (child.kind === 'leaf') reconstructLeaf(child.id);
          else {
            const childSummary = this.summaryMap.get(child.id)!;
            if (childSummary.leafIds.length > 0) reconstructSummary(child.id, childSummary.leafIds);
          }
        }
        return;
      }
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
      if ((isFull(id, activeIds) ? selectedFull : selectedPartial).get(keyOf(id, activeIds))) {
        const participants = participantsOf(summary, activeIds);
        const ids = participants.ids();
        for (const leafId of ids) frontier.set(leafId, summary.level);
        if (participants.count !== activeIds.length) {
          const participantSet = new Set(ids);
          reconstructChildren(summary, activeIds.filter((leafId) => !participantSet.has(leafId)));
        }
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

  private static constraintsFor(
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

  /** A summary's direct leaves and child summaries in (first sequence, id)
   *  order; cached per summary object. */
  orderedChildren(summary: CanonicalSummary): readonly OrderedChild[] {
    // Summary objects are shared by every forest derived from the same build
    // and leaf sequences are fixed per id, so the order is a property of
    // the summary object.
    const known = orderedChildrenCache.get(summary);
    if (known) return known;
    const children: OrderedChild[] = [
      ...summary.directLeafIds.map((id) => ({
        kind: 'leaf' as const,
        id,
        firstSequence: this.leafOf(id)!.sequence,
        key: leafKey(id),
        index: this.leafOf(id)!.index,
      })),
      ...summary.childSummaryIds.map((id) => ({
        kind: 'summary' as const,
        id,
        firstSequence: this.summaryMap.get(id)!.firstSequence,
        key: summaryKey(id),
      })),
    ].sort((a, b) => a.firstSequence - b.firstSequence || a.id.localeCompare(b.id));
    orderedChildrenCache.set(summary, children);
    return children;
  }

  private frontierSignature(
    frontier: ReadonlyMap<ChunkId, number>,
    leafIds: readonly ChunkId[],
  ): string {
    return leafIds.map((leafId) => `${leafId}:${frontier.get(leafId) ?? '-'}`).join('|');
  }

  private coverLeaf(id: ChunkId): PartialCut | null {
    const leaf = this.leafOf(id)!;
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
      if (this.leafOf(leafId)!.allowedLevels.includes(summary.level)) {
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
