import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { certifyCarriedLayout, type HysteresisCertificate } from './kv-unified-certificate.js';
import { TerminalPolicyEvaluator } from './kv-unified-terminal.js';
import { PackedDagSolver } from './kv-unified-packed.js';
import {
  CanonicalSummaryForest,
  SparseLabelCeilingError,
  type ExactCutCandidate,
} from './kv-unified.js';
import {
  ExactKvUnifiedPolicySolver,
  continuityLeafLoss,
  fidelityLeafLoss,
  frontierSignature,
  normalizePolicy,
  type ExactPolicySolveOptions,
  type ExactPolicySolveResult,
  type KvUnifiedWelfarePolicy,
  type UnscoredCandidate,
} from './kv-unified-policy.js';

interface CacheState {
  intact: boolean;
  matchedUnits: number;
  cachedTokens: number;
  cachedUnits: number;
}

interface PendingEmission {
  readonly kind: 'raw' | 'recall';
  readonly key: string;
  readonly tokens: number;
  readonly sequence: number;
}

interface ParetoLabel {
  active: boolean;
  remaining: bigint;
  renderedTokens: number;
  /** Rendered tokens not covered by the accepted presentation. Priced by the
   * cache term (avoidable recompute = recomputed - extension), so it is a
   * dominance dimension while a provider cache is relevant — never a state-key
   * dimension (#97). */
  extensionTokens: number;
  continuityLoss: number;
  fidelityLoss: number;
  cache: CacheState;
  /** Cache-relevant units waiting for a chronologically earlier ownership
   * branch. Non-empty only for preserved gap-bearing ownership. */
  pendingEmissions: readonly PendingEmission[];
  trace: AssignmentTrace | null;
  approximation: ApproximationEnvelope;
}

export interface ApproximationEnvelope {
  token: number;
  continuity: number;
  fidelity: number;
  /** Extension tokens a covered label had beyond its representative: the
   * cache term may be overstated by this many tokens times the cache price. */
  cache: number;
}

interface AssignmentTrace {
  parent: AssignmentTrace | null;
  ids: readonly ChunkId[];
  level: number;
}

export interface ParetoPropagationStats {
  readonly storageMode?: 'packed' | 'objects';
  readonly packedLabelSlots?: number;
  readonly packedTraceNodes?: number;
  readonly terminalEvaluationMode?: 'full' | 'selective';
  readonly exactTerminalEvaluations?: number;
  readonly labelsCreated: number;
  readonly labelsExpanded: number;
  readonly labelsDominated: number;
  readonly states: number;
  readonly maxLabelsPerState: number;
  readonly terminalLabels: number;
  readonly tokenBucketSize: number;
  readonly continuityBucketSize: number;
  readonly fidelityBucketSize: number;
  /** True when approximationScoreErrorBound covers configured grid pruning. */
  readonly approximationBounded: boolean;
  readonly approximationScoreErrorBound: number;
  readonly approximationTokenErrorBound: number;
  readonly approximationContinuityErrorBound: number;
  readonly approximationFidelityErrorBound: number;
  /** Extension tokens the cache term may have been overstated by. */
  readonly approximationCacheErrorBound: number;
}

export type ParetoPolicySolveResult = ExactPolicySolveResult & {
  readonly propagation?: ParetoPropagationStats;
  readonly certificate?: HysteresisCertificate;
};

export type ParetoSolveOptions = ExactPolicySolveOptions & {
  labelCeiling?: number;
  tokenBucketSize?: number;
  continuityBucketSize?: number;
  fidelityBucketSize?: number;
  engine?: 'auto' | 'leaf' | 'dag';
  /** Opt-in prototype: prove the hysteresis selection before propagating labels. */
  hysteresisCertificate?: boolean;
  /** Diagnostic reference path; the normal DAG path uses packed storage. */
  storage?: 'packed' | 'objects';
  /** Diagnostic exhaustive rescoring; selection otherwise uses exact bounds. */
  terminalEvaluation?: 'full' | 'selective';
  /** Optional diagnostic observer; never used to choose a cut or stop a solve. */
  onProgress?: (event: { phase: string; elapsedMs: number; states: number; labels: number }) => void;
};

/** Exact sparse Pareto propagation. R bucketing is added only after this
 * engine agrees with the exhaustive oracle on small forests. */
export class ParetoKvUnifiedPolicySolver {
  readonly forest: CanonicalSummaryForest;

  private readonly leaves: ReturnType<CanonicalSummaryForest['orderedLeaves']>;
  private readonly chunksById: ReadonlyMap<ChunkId, PickerInputs['chunks'][number]>;
  private readonly indexById: ReadonlyMap<ChunkId, number>;
  private readonly midpointAge = new Map<ChunkId, number>();
  private summaryMetricCache = new WeakMap<readonly ChunkId[], { continuity: number; fidelity: number }>();
  private readonly newestSequence: number;
  private bufferGapEmissions = false;

  constructor(private readonly inputs: PickerInputs, forest?: CanonicalSummaryForest) {
    this.forest = forest ?? new CanonicalSummaryForest(inputs);
    this.leaves = this.forest.orderedLeaves();
    this.chunksById = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
    this.indexById = new Map(this.leaves.map((leaf, index) => [leaf.id, index]));
    this.newestSequence = inputs.chunks.reduce((newest, chunk) => Math.max(newest, chunk.sequence), 0);
    let age = 0;
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const leaf = this.leaves[i];
      this.midpointAge.set(leaf.id, age + leaf.rawTokens / 2);
      age += leaf.rawTokens;
    }
  }

  solve(options: ParetoSolveOptions): ParetoPolicySolveResult {
    this.summaryMetricCache = new WeakMap();
    const internalHoles = this.hasInternalProtectedHoles();
    const gapBearingOwnership = this.forest.gapBearingSummaryIds.length > 0;
    if (options.hysteresisCertificate) {
      const certified = certifyCarriedLayout(this.inputs, this.forest, options);
      if (certified) return certified;
    }
    if (options.engine !== 'leaf') {
      if (options.storage !== 'objects') {
        const feasibility = this.forest.minimumTokens(options.maxTokens);
        if (!feasibility.feasible) return { feasible: false, feasibility };
        return new PackedDagSolver(this.inputs, this.forest, options, gapBearingOwnership || internalHoles,
          (error) => this.approximationBound(options, normalizePolicy(options.policy), error), feasibility).solve();
      }
      this.bufferGapEmissions = gapBearingOwnership || internalHoles;
      try {
        return this.solveDag(options);
      } finally {
        this.bufferGapEmissions = false;
      }
    }
    return this.solveLeaf(options);
  }

  private solveLeaf(options: ParetoSolveOptions): ParetoPolicySolveResult {
    const feasibility = this.forest.minimumTokens(options.maxTokens);
    if (!feasibility.feasible) return { feasible: false, feasibility };
    const policy = normalizePolicy(options.policy);
    const cacheRelevant =
      options.cache !== undefined &&
      options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    const markerByUnit = new Map(
      (options.cache?.markers ?? []).map((marker) => [marker.unitIndex, marker.offset]),
    );
    const bit = (index: number): bigint => 1n << BigInt(index);
    let remaining = 0n;
    const externalIds: ChunkId[] = [];
    for (let i = 0; i < this.leaves.length; i++) {
      if (this.leaves[i].externallyAccounted) externalIds.push(this.leaves[i].id);
      else remaining |= bit(i);
    }
    let initial: ParetoLabel = {
      active: true,
      remaining,
      renderedTokens: 0,
      extensionTokens: 0,
      continuityLoss: 0,
      fidelityLoss: 0,
      cache: { intact: cacheRelevant, matchedUnits: 0, cachedTokens: 0, cachedUnits: 0 },
      pendingEmissions: [],
      trace: externalIds.length > 0 ? { parent: null, ids: externalIds, level: 0 } : null,
      approximation: ZERO_APPROXIMATION,
    };
    if (this.inputs.headTokens > 0) {
      initial = this.emit(initial, 'head', 'head', this.inputs.headTokens, false, options, markerByUnit);
    }

    const ceiling = options.labelCeiling ?? 1_000_000;
    const tokenBucketSize = Math.max(0, Math.floor(options.tokenBucketSize ?? 0));
    const continuityBucketSize = Math.max(0, options.continuityBucketSize ?? 0);
    const fidelityBucketSize = Math.max(0, options.fidelityBucketSize ?? 0);
    const stack: ParetoLabel[] = [];
    const states = new Map<string, ParetoLabel[]>();
    let labelsCreated = 0;
    let labelsExpanded = 0;
    let labelsDominated = 0;
    let maxLabelsPerState = 0;
    const insert = (label: ParetoLabel): void => {
      if (label.renderedTokens > options.maxTokens) return;
      const key = stateKey(label, tokenBucketSize, continuityBucketSize, fidelityBucketSize);
      const current = states.get(key) ?? [];
      for (const incumbent of current) {
        if (dominates(incumbent, label, cacheRelevant)) {
          labelsDominated++;
          return;
        }
      }
      const survivors: ParetoLabel[] = [];
      for (const incumbent of current) {
        if (dominates(label, incumbent, cacheRelevant)) {
          incumbent.active = false;
          labelsDominated++;
        } else survivors.push(incumbent);
      }
      survivors.push(label);
      states.set(key, survivors);
      maxLabelsPerState = Math.max(maxLabelsPerState, survivors.length);
      labelsCreated++;
      if (labelsCreated > ceiling) throw new SparseLabelCeilingError(ceiling, labelsCreated);
      stack.push(label);
    };
    insert(initial);

    const terminal: ExactCutCandidate[] = [];
    while (stack.length > 0) {
      const label = stack.pop()!;
      if (!label.active) continue;
      if (label.remaining === 0n) {
        let finished = label;
        if (this.inputs.tailTokens > 0) {
          finished = this.emit(label, 'tail', 'tail', this.inputs.tailTokens, false, options, markerByUnit);
        }
        if (finished.renderedTokens <= options.maxTokens) {
          terminal.push({ frontier: reconstructFrontier(finished.trace), renderedTokens: finished.renderedTokens });
        }
        continue;
      }
      labelsExpanded++;
      const oldest = lowestSetBit(label.remaining);
      const leaf = this.leaves[oldest];
      if (leaf.allowedLevels.includes(0)) {
        const next = this.assign(label, [leaf.id], 0, policy, options);
        insert(this.emit(next, 'raw', leaf.id, leaf.rawTokens, this.isExtension([leaf.id], options), options, markerByUnit));
      }
      for (const summaryId of leaf.summaryIds) {
        const summary = this.forest.summary(summaryId)!;
        if (!leaf.allowedLevels.includes(summary.level)) continue;
        const participants: ChunkId[] = [];
        let mask = 0n;
        let overlap = false;
        for (const id of summary.leafIds) {
          const index = this.indexById.get(id)!;
          const candidateBit = bit(index);
          const allowed = this.forest.leaf(id)!.allowedLevels.includes(summary.level);
          if ((label.remaining & candidateBit) === 0n && allowed) { overlap = true; break; }
          if ((label.remaining & candidateBit) !== 0n && allowed) {
            mask |= candidateBit;
            participants.push(id);
          }
        }
        if (overlap || (mask & bit(oldest)) === 0n) continue;
        const next = this.assign(label, participants, summary.level, policy, options);
        insert(this.emit(next, 'recall', summary.id, summary.recallTokens, this.isExtension(summary.leafIds, options), options, markerByUnit));
      }
    }

    if (feasibility.frontier && !terminal.some((candidate) => sameFrontier(candidate.frontier, feasibility.frontier!))) {
      terminal.push({ frontier: feasibility.frontier, renderedTokens: feasibility.floorTokens });
    }
    const scoringStats = {
      statesVisited: states.size,
      candidatesGenerated: labelsCreated,
      maxCandidatesAtState: maxLabelsPerState,
      terminalCandidates: terminal.length,
    };
    const scored = new ExactKvUnifiedPolicySolver(this.inputs, this.forest).scoreCandidates(
      terminal,
      options,
      scoringStats,
      feasibility,
    );
    if (!scored.feasible) return scored;
    return {
      ...scored,
      propagation: {
        labelsCreated,
        labelsExpanded,
        labelsDominated,
        states: states.size,
        maxLabelsPerState,
        terminalLabels: terminal.length,
        tokenBucketSize,
        continuityBucketSize,
        fidelityBucketSize,
        approximationBounded: true,
        // The leaf engine performs exact dominance only. Bucket keys can
        // retain extra labels but never discard a nondominated one.
        approximationScoreErrorBound: 0,
        approximationTokenErrorBound: 0,
        approximationContinuityErrorBound: 0,
        approximationFidelityErrorBound: 0,
        approximationCacheErrorBound: 0,
      },
    };
  }

  private solveDag(options: ParetoSolveOptions): ParetoPolicySolveResult {
    const started = performance.now();
    const feasibility = this.forest.minimumTokens(options.maxTokens);
    if (!feasibility.feasible) return { feasible: false, feasibility };
    const policy = normalizePolicy(options.policy);
    const cacheRelevant =
      options.cache !== undefined &&
      options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    const markerByUnit = new Map(
      (options.cache?.markers ?? []).map((marker) => [marker.unitIndex, marker.offset]),
    );
    const externalIds = this.leaves.filter((leaf) => leaf.externallyAccounted).map((leaf) => leaf.id);
    let initial: ParetoLabel = {
      active: true,
      remaining: 0n,
      renderedTokens: 0,
      extensionTokens: 0,
      continuityLoss: 0,
      fidelityLoss: 0,
      cache: { intact: cacheRelevant, matchedUnits: 0, cachedTokens: 0, cachedUnits: 0 },
      pendingEmissions: [],
      trace: externalIds.length > 0 ? { parent: null, ids: externalIds, level: 0 } : null,
      approximation: ZERO_APPROXIMATION,
    };
    if (this.inputs.headTokens > 0) {
      initial = this.emit(initial, 'head', 'head', this.inputs.headTokens, false, options, markerByUnit);
    }
    const ceiling = options.labelCeiling ?? 1_000_000;
    const tokenBucketSize = Math.max(0, Math.floor(options.tokenBucketSize ?? 0));
    const continuityBucketSize = Math.max(0, options.continuityBucketSize ?? 0);
    const fidelityBucketSize = Math.max(0, options.fidelityBucketSize ?? 0);
    let labelsCreated = 1;
    let labelsExpanded = 0;
    let labelsDominated = 0;
    let maxLabelsPerState = 1;
    let states = 0;
    // With no applicable provider receipt, neither extension counts nor cache
    // state can affect any future objective term. Use a compact grid key.
    let continuityBins = 0;
    let fidelityBins = 0;
    let gridKeys = 0;
    if (tokenBucketSize > 0 && continuityBucketSize > 0 && fidelityBucketSize > 0) {
      let maxContinuity = 0;
      let maxFidelity = 0;
      for (const leaf of this.leaves) {
        const maxLevel = Math.max(...leaf.availableLevels);
        const previousLevel = options.presentation?.leaves.get(leaf.id)?.level ?? 0;
        maxContinuity += leaf.rawTokens * Math.max(1, previousLevel, Math.abs(maxLevel - previousLevel));
        if (!leaf.externallyAccounted) maxFidelity += fidelityLeafLoss(
          this.chunksById.get(leaf.id)!, maxLevel, this.newestSequence, policy,
        );
      }
      continuityBins = Math.ceil(maxContinuity / continuityBucketSize) + 2;
      fidelityBins = Math.ceil(maxFidelity / fidelityBucketSize) + 2;
      const keys = (Math.ceil(options.maxTokens / tokenBucketSize) + 2) * continuityBins * fidelityBins;
      if (!Number.isSafeInteger(keys)) continuityBins = fidelityBins = 0;
      else gridKeys = keys;
    }
    const cacheClasses = new Map([...markerByUnit.keys()].filter((index) => index > 0)
      .sort((a, b) => a - b).map((index, i) => [index, i + 1]));
    const cacheClassCount = cacheClasses.size + 1;
    const numericCacheKey = gridKeys > 0 && Number.isSafeInteger(
      gridKeys * cacheClassCount,
    );
    const keyFor = (label: ParetoLabel): string | number => {
      if (cacheRelevant && label.cache.intact) return stateKey(label, tokenBucketSize, continuityBucketSize, fidelityBucketSize);
      const t = tokenBucketSize > 0 ? Math.ceil(label.renderedTokens / tokenBucketSize) : label.renderedTokens;
      const k = continuityBucketSize > 0 ? Math.floor(label.continuityLoss / continuityBucketSize) : 'c*';
      const f = fidelityBucketSize > 0 ? Math.floor(label.fidelityLoss / fidelityBucketSize) : 'f*';
      const numericGrid = continuityBins > 0 && typeof k === 'number' && typeof f === 'number' &&
        k >= 0 && k < continuityBins && f >= 0 && f < fidelityBins;
      const grid = numericGrid ? (t * continuityBins + k) * fidelityBins + f
        : `${t}:${k}:${f}`;
      if (!cacheRelevant) return grid;
      // Once a prefix diverges, future cache cost depends on its last matched
      // marker, not on how many unmarked units happened to match after it.
      const cacheClass = cacheClasses.get(label.cache.cachedUnits) ?? 0;
      // Extension stays a priced dominance/envelope dimension, as on main;
      // keying by its exact value would reintroduce stale-receipt growth.
      return numericCacheKey && typeof grid === 'number'
        ? cacheClass * gridKeys + grid
        : `broken:${cacheClass}:${grid}`;
    };
    const leafIds = this.leaves.map((leaf) => leaf.id);
    const prune = (labels: ParetoLabel[]): ParetoLabel[] => {
      states++;
      // Labels in one pool cover the same leaves. A full tie on the metrics
      // below resolves the way terminal selection breaks a score tie
      // (renderedTokens, then frontierSignature): the partial cut with the
      // earlier signature, which the terminal order would also prefer had both
      // been completed the same way. Signatures are built for ties only.
      const signatures = new Map<ParetoLabel, string>();
      const signature = (label: ParetoLabel): string => {
        let value = signatures.get(label);
        if (value === undefined) {
          value = frontierSignature(reconstructFrontier(label.trace), leafIds);
          signatures.set(label, value);
        }
        return value;
      };
      const representativeOrder = (a: ParetoLabel, b: ParetoLabel): number =>
        a.fidelityLoss - b.fidelityLoss ||
        a.continuityLoss - b.continuityLoss ||
        a.renderedTokens - b.renderedTokens ||
        (cacheRelevant ? b.extensionTokens - a.extensionTokens : 0) ||
        signature(a).localeCompare(signature(b));
      const groups = new Map<string | number, ParetoLabel | ParetoLabel[]>();
      for (const label of labels) {
        if (label.renderedTokens > options.maxTokens) continue;
        const key = keyFor(label);
        const current = groups.get(key);
        if (Array.isArray(current)) current.push(label);
        else if (current) groups.set(key, [current, label]);
        else groups.set(key, label);
      }
      const result: ParetoLabel[] = [];
      for (const pool of groups.values()) {
        // DAG labels are immutable. A singleton neither loses a path nor
        // changes its approximation envelope, so it needs no clone or array.
        if (!Array.isArray(pool)) { result.push(pool); continue; }
        const representatives = continuityBucketSize > 0 && fidelityBucketSize > 0
          ? bucketRepresentatives(pool, cacheRelevant, representativeOrder)
          : pool.filter((candidate, index) => !pool.some(
              (other, otherIndex) => otherIndex !== index && dominates(other, candidate, cacheRelevant),
            ));
        const covered = coverApproximationPool(pool, representatives, cacheRelevant);
        labelsDominated += pool.length - covered.length;
        result.push(...covered);
      }
      labelsCreated += result.length;
      maxLabelsPerState = Math.max(maxLabelsPerState, result.length);
      if (result.length > ceiling) throw new SparseLabelCeilingError(ceiling, result.length);
      if (states % 1000 === 0) options.onProgress?.({
        phase: 'propagate', elapsedMs: performance.now() - started, states, labels: result.length,
      });
      return result;
    };
    const orderedChildren = (summaryId: string): Array<{ kind: 'leaf' | 'summary'; id: string; sequence: number }> => {
      const summary = this.forest.summary(summaryId)!;
      return [
        ...summary.directLeafIds.map((id) => ({ kind: 'leaf' as const, id, sequence: this.forest.leaf(id)!.sequence })),
        ...summary.childSummaryIds.map((id) => ({ kind: 'summary' as const, id, sequence: this.forest.summary(id)!.firstSequence })),
      ].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    };
    const processSummary = (summaryId: string, incoming: ParetoLabel[],
      active: ReadonlySet<ChunkId> | undefined, flushLimit: number): ParetoLabel[] => {
      labelsExpanded += incoming.length;
      const summary = this.forest.summary(summaryId)!;
      const live = summary.leafIds.filter((id) => (!active || active.has(id)) && !this.forest.leaf(id)!.externallyAccounted);
      const participants = live.filter((id) => this.forest.leaf(id)!.allowedLevels.includes(summary.level));
      const holes = live.filter((id) => !this.forest.leaf(id)!.allowedLevels.includes(summary.level));
      let selected: ParetoLabel[] = [];
      if (participants.length > 0) {
        const metrics = this.summaryMetrics(summary.id, participants, summary.level, policy, options);
        const extension = this.isExtension(summary.leafIds, options);
        const firstEmission = participants.reduce((first, id) => Math.min(first, this.forest.leaf(id)!.sequence), Infinity);
        selected = incoming.map((label) => {
          if (!label.cache.intact) return appendAction(label, participants, summary.level,
            metrics.continuity, metrics.fidelity, summary.recallTokens, extension ? summary.recallTokens : 0);
          const assigned = this.assignSummary(
            label,
            summary.id,
            participants,
            summary.level,
            policy,
            options,
          );
          return this.emit(
            assigned,
            'recall',
            summary.id,
            summary.recallTokens,
            extension,
            options,
            markerByUnit,
            firstEmission,
          );
        });
        if (holes.length > 0) selected = processChildren(summaryId, selected, new Set(holes), flushLimit);
      }
      const expanded = processChildren(summaryId, incoming, active, flushLimit);
      return prune([...selected, ...expanded]);
    };
    const processChildren = (summaryId: string, incoming: ParetoLabel[],
      active: ReadonlySet<ChunkId> | undefined, flushLimit: number): ParetoLabel[] => {
      let expanded = incoming;
      const children = orderedChildren(summaryId).filter((child) => !active || (child.kind === 'leaf'
        ? active.has(child.id) : this.forest.summary(child.id)!.leafIds.some((id) => active.has(id))));
      for (let childIndex = 0; childIndex < children.length;) {
        const child = children[childIndex];
        if (cacheRelevant && this.bufferGapEmissions) expanded = expanded.map((label) =>
          this.flushPendingEmissions(label, Math.min(child.sequence, flushLimit), options, markerByUnit),
        );
        if (child.kind === 'summary') {
          // A later ownership sibling can contain chronologically earlier
          // leaves. Never flush beyond an unvisited sibling's first sequence.
          const nextLimit = Math.min(flushLimit, children[childIndex + 1]?.sequence ?? Infinity);
          expanded = processSummary(child.id, expanded, active, nextLimit);
          childIndex++;
          // processSummary already pruned this exact state. Repeating the
          // same grid projection is idempotent and performs no useful work.
          continue;
        } else {
          const rawRun: string[] = [];
          while (childIndex < children.length && children[childIndex].kind === 'leaf') {
            rawRun.push(children[childIndex].id);
            childIndex++;
          }
          const ids = rawRun.filter((leafId) => !this.forest.leaf(leafId)!.externallyAccounted);
          const rawAllowed = ids.every((leafId) => this.forest.leaf(leafId)!.allowedLevels.includes(0));
          const rawMetrics = this.rawRunMetrics(ids, policy, options);
          expanded = rawAllowed ? expanded.map((label) => {
            if (!label.cache.intact) return appendAction(label, ids, 0,
              rawMetrics.continuity, 0, rawMetrics.tokens, rawMetrics.extensionTokens);
            return this.emitRawRun(
              this.assignRawRun(label, ids, policy, options, rawMetrics.continuity),
              ids,
              options,
              markerByUnit,
              rawMetrics,
            );
          }) : [];
        }
        expanded = prune(expanded);
      }
      return expanded;
    };

    let labels = [initial];
    for (let rootIndex = 0; rootIndex < this.forest.roots.length; rootIndex++) {
      const root = this.forest.roots[rootIndex];
      if (cacheRelevant && this.bufferGapEmissions) labels = labels.map((label) =>
        this.flushPendingEmissions(label, root.firstSequence, options, markerByUnit),
      );
      if (root.kind === 'summary') labels = processSummary(root.id, labels, undefined,
        this.forest.roots[rootIndex + 1]?.firstSequence ?? Infinity);
      else {
        const leaf = this.forest.leaf(root.id)!;
        if (!leaf.externallyAccounted) {
          const ids = [leaf.id];
          const metrics = this.rawRunMetrics(ids, policy, options);
          labels = labels.map((label) => !label.cache.intact
            ? appendAction(label, ids, 0, metrics.continuity, 0, metrics.tokens, metrics.extensionTokens)
            : this.emitRawRun(this.assignRawRun(label, ids, policy, options, metrics.continuity),
                ids, options, markerByUnit, metrics));
        }
      }
      if (root.kind !== 'summary') labels = prune(labels);
    }
    options.onProgress?.({ phase: 'propagated', elapsedMs: performance.now() - started, states, labels: labels.length });
    const evaluator = new TerminalPolicyEvaluator(this.inputs, this.forest, options);
    const terminal: UnscoredCandidate[] = [];
    for (const label of labels) {
      let finished = this.flushPendingEmissions(
        label,
        Number.POSITIVE_INFINITY,
        options,
        markerByUnit,
      );
      if (this.inputs.tailTokens > 0) {
        finished = this.emit(
          finished,
          'tail',
          'tail',
          this.inputs.tailTokens,
          false,
          options,
          markerByUnit,
        );
      }
      if (finished.renderedTokens <= options.maxTokens) {
        terminal.push(evaluator.candidate(finished.trace, finished.renderedTokens));
      }
    }
    const tokenRoundoff = 32 * Number.EPSILON * this.leaves.length * Math.max(1, options.maxTokens);
    if (!terminal.some((candidate) =>
      Math.abs(candidate.renderedTokens - feasibility.floorTokens) <= tokenRoundoff &&
      sameFrontier(candidate.frontier, feasibility.frontier))) {
      const byLevel = new Map<number, string[]>();
      for (const [id, level] of feasibility.frontier) {
        const ids = byLevel.get(level);
        if (ids) ids.push(id);
        else byLevel.set(level, [id]);
      }
      let trace: AssignmentTrace | null = null;
      for (const [level, ids] of byLevel) trace = { parent: trace, ids, level };
      terminal.push(evaluator.candidate(trace, feasibility.floorTokens));
    }
    options.onProgress?.({ phase: 'evaluated', elapsedMs: performance.now() - started, states, labels: terminal.length });
    const scored = new ExactKvUnifiedPolicySolver(this.inputs, this.forest).scorePreparedCandidates(
      terminal,
      options,
      {
        statesVisited: states,
        candidatesGenerated: labelsCreated,
        maxCandidatesAtState: maxLabelsPerState,
        terminalCandidates: terminal.length,
      },
      cacheRelevant,
    );
    if (!scored.feasible) return scored;
    options.onProgress?.({ phase: 'scored', elapsedMs: performance.now() - started, states, labels: terminal.length });
    const approximation = maxApproximation(labels);
    return {
      ...scored,
      propagation: {
        labelsCreated,
        labelsExpanded,
        labelsDominated,
        states,
        maxLabelsPerState,
        terminalLabels: terminal.length,
        tokenBucketSize,
        continuityBucketSize,
        fidelityBucketSize,
        approximationBounded: true,
        approximationScoreErrorBound: this.approximationBound(options, policy, approximation),
        approximationTokenErrorBound: approximation.token,
        approximationContinuityErrorBound: approximation.continuity,
        approximationFidelityErrorBound: approximation.fidelity,
        approximationCacheErrorBound: approximation.cache,
      },
    };
  }

  private hasInternalProtectedHoles(): boolean {
    for (const summary of this.forest.allSummaries()) {
      const live = summary.leafIds.filter((id) => !this.forest.leaf(id)!.externallyAccounted);
      const allowed = live.filter((id) => this.forest.leaf(id)!.allowedLevels.includes(summary.level));
      if (allowed.length > 0 && allowed.length < live.length) return true;
    }
    return false;
  }

  private approximationBound(
    options: ExactPolicySolveOptions,
    policy: KvUnifiedWelfarePolicy,
    approximation: ApproximationEnvelope,
  ): number {
    const tokenError = approximation.token;
    const continuityError = approximation.continuity;
    const fidelityError = approximation.fidelity;
    const low = policy.budgetLowRatio * options.maxTokens;
    const high = policy.budgetHighRatio * options.maxTokens;
    const budgetSlope = Math.max(
      low > 0 ? (2 * policy.budgetUnderLambda) / low : 0,
      options.maxTokens > high
        ? (2 * policy.budgetOverLambda) / (options.maxTokens - high)
        : 0,
    );
    const cachePrice = Math.max(0, policy.cacheWritePrice - policy.cacheReadPrice);
    const maxCache = options.maxTokens * cachePrice;
    const cacheSlope = (2 * policy.cacheLambda * maxCache) / (policy.cacheScale ** 2);
    const maxContinuity = this.leaves.reduce(
      (total, leaf) => {
        const previousLevel = options.presentation?.leaves.get(leaf.id)?.level ?? 0;
        const maxDistance = Math.max(
          1,
          ...leaf.availableLevels.map((level) => Math.abs(level - previousLevel)),
        );
        return total + leaf.rawTokens * maxDistance;
      },
      0,
    );
    const continuitySlope =
      (2 * policy.continuityLambda * maxContinuity) / (policy.continuityScale ** 2);
    const rho =
      options.continuityMultiplier !== undefined &&
      Number.isFinite(options.continuityMultiplier) &&
      options.continuityMultiplier >= 0 &&
      options.continuityMultiplier <= 1
        ? options.continuityMultiplier
        : 1;
    const hysteresis = options.presentation && Number.isFinite(options.adoptEpsilon)
      ? Math.max(0, options.adoptEpsilon ?? 0)
      : 0;
    return (
      fidelityError +
      budgetSlope * tokenError +
      cacheSlope * (tokenError + approximation.cache) * cachePrice +
      rho * continuitySlope * continuityError +
      hysteresis
    );
  }

  private assign(label: ParetoLabel, ids: readonly ChunkId[], level: number, policy: KvUnifiedWelfarePolicy, options: ExactPolicySolveOptions): ParetoLabel {
    let remaining = label.remaining;
    let continuityLoss = label.continuityLoss;
    let fidelityLoss = label.fidelityLoss;
    const presentation = options.presentation;
    for (const id of ids) {
      remaining &= ~(1n << BigInt(this.indexById.get(id)!));
      const chunk = this.chunksById.get(id)!;
      fidelityLoss += fidelityLeafLoss(chunk, level, this.newestSequence, policy);
      const previous = presentation?.leaves.get(id);
      continuityLoss += continuityLeafLoss(
        chunk,
        level,
        level === 0 ? `raw:${id}` : `summary:${this.forest.leaf(id)!.summaryIds.find((sid) => this.forest.summary(sid)!.level === level)!}`,
        previous,
        presentation?.currentSeq ?? 0,
        this.midpointAge.get(id)!,
        policy,
      );
    }
    return {
      ...label,
      active: true,
      remaining,
      trace: { parent: label.trace, ids, level },
      continuityLoss,
      fidelityLoss,
    };
  }

  private assignSummary(
    label: ParetoLabel,
    summaryId: string,
    ids: readonly ChunkId[],
    level: number,
    policy: KvUnifiedWelfarePolicy,
    options: ExactPolicySolveOptions,
  ): ParetoLabel {
    const metrics = this.summaryMetrics(summaryId, ids, level, policy, options);
    return {
      ...label,
      active: true,
      trace: { parent: label.trace, ids, level },
      continuityLoss: label.continuityLoss + metrics.continuity,
      fidelityLoss: label.fidelityLoss + metrics.fidelity,
    };
  }

  private summaryMetrics(summaryId: string, ids: readonly ChunkId[], level: number,
    policy: KvUnifiedWelfarePolicy, options: ExactPolicySolveOptions) {
    let metrics = this.summaryMetricCache.get(ids);
    if (!metrics) {
      let continuity = 0;
      let fidelity = 0;
      for (const id of ids) {
        const chunk = this.chunksById.get(id)!;
        fidelity += fidelityLeafLoss(chunk, level, this.newestSequence, policy);
        const previous = options.presentation?.leaves.get(id);
        const repHash = `summary:${summaryId}`;
        continuity += continuityLeafLoss(
          chunk,
          level,
          repHash,
          previous,
          options.presentation?.currentSeq ?? 0,
          this.midpointAge.get(id)!,
          policy,
        );
      }
      metrics = { continuity, fidelity };
      this.summaryMetricCache.set(ids, metrics);
    }
    return metrics;
  }

  private emit(label: ParetoLabel, kind: 'head' | 'raw' | 'recall' | 'tail', key: string, tokens: number, extension: boolean, options: ExactPolicySolveOptions, markerByUnit: ReadonlyMap<number, number>, emissionSequence?: number): ParetoLabel {
    const renderedTokens = label.renderedTokens + tokens;
    const extensionTokens = label.extensionTokens + (extension ? tokens : 0);
    if (
      this.bufferGapEmissions &&
      label.cache.intact &&
      (kind === 'raw' || kind === 'recall')
    ) {
      const sequence = emissionSequence ?? (kind === 'raw'
        ? this.forest.leaf(key)!.sequence
        : this.forest.summary(key)!.firstSequence);
      return {
        ...label,
        active: true,
        renderedTokens,
        extensionTokens,
        pendingEmissions: [...label.pendingEmissions, { kind, key, tokens, sequence }],
      };
    }
    const cache = label.cache.intact ? { ...label.cache } : label.cache;
    if (cache.intact && options.cache) {
      const previous = options.cache.layout.units[cache.matchedUnits];
      if (previous?.kind === kind && previous.key === key) {
        cache.matchedUnits++;
        const marker = markerByUnit.get(cache.matchedUnits);
        if (marker !== undefined) { cache.cachedTokens = marker; cache.cachedUnits = cache.matchedUnits; }
      } else cache.intact = false;
    }
    return { ...label, active: true, renderedTokens, extensionTokens, cache };
  }

  private flushPendingEmissions(
    label: ParetoLabel,
    beforeSequence: number,
    options: ExactPolicySolveOptions,
    markerByUnit: ReadonlyMap<number, number>,
  ): ParetoLabel {
    if (!this.bufferGapEmissions || !label.cache.intact || label.pendingEmissions.length === 0) {
      return label;
    }
    const ordered = [...label.pendingEmissions].sort((a, b) =>
      a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key),
    );
    const cache = { ...label.cache };
    let consumed = 0;
    while (consumed < ordered.length && ordered[consumed].sequence < beforeSequence) {
      const emission = ordered[consumed++];
      const previous = options.cache?.layout.units[cache.matchedUnits];
      if (previous?.kind === emission.kind && previous.key === emission.key) {
        cache.matchedUnits++;
        const marker = markerByUnit.get(cache.matchedUnits);
        if (marker !== undefined) { cache.cachedTokens = marker; cache.cachedUnits = cache.matchedUnits; }
      } else {
        cache.intact = false;
        return { ...label, active: true, cache, pendingEmissions: [] };
      }
    }
    return {
      ...label,
      active: true,
      cache,
      pendingEmissions: ordered.slice(consumed),
    };
  }

  private isExtension(ids: readonly ChunkId[], options: ExactPolicySolveOptions): boolean {
    return options.presentation !== undefined && ids.length > 0 && ids.every((id) => !options.presentation!.leaves.has(id));
  }

  private assignRawRun(
    label: ParetoLabel,
    ids: readonly ChunkId[],
    policy: KvUnifiedWelfarePolicy,
    options: ExactPolicySolveOptions,
    knownContinuity?: number,
  ): ParetoLabel {
    if (ids.length === 0) return label;
    let continuityLoss = label.continuityLoss;
    if (knownContinuity !== undefined) continuityLoss += knownContinuity;
    else if (options.presentation) {
      for (const id of ids) {
        const chunk = this.chunksById.get(id)!;
        continuityLoss += continuityLeafLoss(
          chunk,
          0,
          `raw:${id}`,
          options.presentation.leaves.get(id),
          options.presentation.currentSeq,
          this.midpointAge.get(id)!,
          policy,
        );
      }
    }
    return {
      ...label,
      active: true,
      trace: { parent: label.trace, ids, level: 0 },
      continuityLoss,
    };
  }

  private emitRawRun(
    label: ParetoLabel,
    ids: readonly ChunkId[],
    options: ExactPolicySolveOptions,
    markerByUnit: ReadonlyMap<number, number>,
    totals?: { tokens: number; extensionTokens: number },
  ): ParetoLabel {
    if (ids.length === 0) return label;
    if (label.cache.intact) {
      let next = label;
      for (const id of ids) {
        const leaf = this.forest.leaf(id)!;
        next = this.emit(
          next,
          'raw',
          id,
          leaf.rawTokens,
          this.isExtension([id], options),
          options,
          markerByUnit,
        );
      }
      return next;
    }
    let tokens = totals?.tokens ?? 0;
    let extensionTokens = totals?.extensionTokens ?? 0;
    if (!totals) for (const id of ids) {
      const leafTokens = this.forest.leaf(id)!.rawTokens;
      tokens += leafTokens;
      if (this.isExtension([id], options)) extensionTokens += leafTokens;
    }
    return {
      ...label,
      active: true,
      renderedTokens: label.renderedTokens + tokens,
      extensionTokens: label.extensionTokens + extensionTokens,
    };
  }

  private rawRunMetrics(ids: readonly ChunkId[], policy: KvUnifiedWelfarePolicy, options: ExactPolicySolveOptions) {
    let tokens = 0;
    let extensionTokens = 0;
    let continuity = 0;
    for (const id of ids) {
      const chunk = this.chunksById.get(id)!;
      tokens += chunk.rawTokens;
      const previous = options.presentation?.leaves.get(id);
      if (options.presentation && !previous) extensionTokens += chunk.rawTokens;
      continuity += continuityLeafLoss(chunk, 0, `raw:${id}`, previous,
        options.presentation?.currentSeq ?? 0, this.midpointAge.get(id)!, policy);
    }
    return { tokens, extensionTokens, continuity };
  }

}

/** Fused select/emit for a label whose provider prefix has already broken.
 * All fields retain one object shape; the immutable cache/envelope are shared. */
function appendAction(label: ParetoLabel, ids: readonly ChunkId[], level: number,
  continuity: number, fidelity: number, tokens: number, extensionTokens: number): ParetoLabel {
  if (ids.length === 0) return label;
  return {
    active: true, remaining: label.remaining,
    renderedTokens: label.renderedTokens + tokens,
    extensionTokens: label.extensionTokens + extensionTokens,
    continuityLoss: label.continuityLoss + continuity,
    fidelityLoss: label.fidelityLoss + fidelity,
    cache: label.cache, pendingEmissions: label.pendingEmissions,
    trace: { parent: label.trace, ids, level }, approximation: label.approximation,
  };
}

function stateKey(
  label: ParetoLabel,
  tokenBucketSize: number,
  continuityBucketSize: number,
  fidelityBucketSize: number,
): string {
  const tokenKey = tokenBucketSize > 0
    ? Math.ceil(label.renderedTokens / tokenBucketSize)
    : label.renderedTokens;
  // Extension tokens are deliberately NOT a key dimension. They are priced
  // (cache term), so they are a dominance dimension while a cache is relevant
  // and a cover-envelope term when bucketed; keying on their exact value
  // multiplied the live label set by the number of distinct extension sums —
  // superlinear in forest size once a stale receipt covered half the leaves
  // (#97).
  //
  // matchedUnits is keyed only while the cache is intact. Once a label has
  // diverged from the cached layout nothing reads it again (emit() and
  // flushPendingEmissions() advance it only while intact, representatives
  // tie-break on the frontier, and terminals are scored from their frontier),
  // while cachedTokens, which the cache term does price, stays in the key.
  // Keying the dead value kept every label whose cache broke at a different
  // unit in its own group, so none of them ever competed, and the label set
  // grew with the forest under any relevant cache (#105).
  return [
    label.remaining.toString(16),
    tokenKey,
    label.cache.intact ? 1 : 0,
    label.cache.intact ? label.cache.matchedUnits : -1,
    label.cache.cachedTokens,
    label.pendingEmissions
      .map((emission) => `${emission.sequence}/${emission.kind}/${emission.key}`)
      .join(','),
    continuityBucketSize > 0 ? Math.floor(label.continuityLoss / continuityBucketSize) : 'c*',
    fidelityBucketSize > 0 ? Math.floor(label.fidelityLoss / fidelityBucketSize) : 'f*',
  ].join(':');
}

const ZERO_APPROXIMATION: ApproximationEnvelope = Object.freeze({
  token: 0,
  continuity: 0,
  fidelity: 0,
  cache: 0,
});

/** Attach every discarded path to one retained representative.  The
 * component envelopes are one-sided: how much worse the representative may
 * be than an exact path it stands in for.  Subsequent actions add the same
 * component costs at the same structural/cache state, so the envelope carries
 * forward unchanged until another prune. */
function coverApproximationPool(
  pool: readonly ParetoLabel[],
  representatives: readonly ParetoLabel[],
  cacheRelevant: boolean,
): ParetoLabel[] {
  const covered = representatives.map((label) => ({
    ...label,
    approximation: { ...label.approximation },
  }));
  for (const source of pool) {
    let chosen = 0;
    let chosenCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < covered.length; i++) {
      const candidate = covered[i];
      const cost =
        Math.abs(candidate.renderedTokens - source.renderedTokens) +
        Math.max(0, candidate.continuityLoss - source.continuityLoss) +
        Math.max(0, candidate.fidelityLoss - source.fidelityLoss) +
        (cacheRelevant ? Math.max(0, source.extensionTokens - candidate.extensionTokens) : 0);
      if (cost < chosenCost) {
        chosen = i;
        chosenCost = cost;
      }
    }
    const target = covered[chosen];
    target.approximation.token = Math.max(
      target.approximation.token,
      source.approximation.token + Math.abs(target.renderedTokens - source.renderedTokens),
    );
    target.approximation.continuity = Math.max(
      target.approximation.continuity,
      source.approximation.continuity + Math.max(0, target.continuityLoss - source.continuityLoss),
    );
    target.approximation.fidelity = Math.max(
      target.approximation.fidelity,
      source.approximation.fidelity + Math.max(0, target.fidelityLoss - source.fidelityLoss),
    );
    if (cacheRelevant) {
      target.approximation.cache = Math.max(
        target.approximation.cache,
        source.approximation.cache + Math.max(0, source.extensionTokens - target.extensionTokens),
      );
    }
  }
  return covered;
}

function maxApproximation(labels: readonly ParetoLabel[]): ApproximationEnvelope {
  const result = { token: 0, continuity: 0, fidelity: 0, cache: 0 };
  for (const label of labels) {
    result.token = Math.max(result.token, label.approximation.token);
    result.continuity = Math.max(result.continuity, label.approximation.continuity);
    result.fidelity = Math.max(result.fidelity, label.approximation.fidelity);
    result.cache = Math.max(result.cache, label.approximation.cache);
  }
  return result;
}

function dominates(a: ParetoLabel, b: ParetoLabel, cacheRelevant: boolean): boolean {
  // Extension is priced only through the cache term (avoidable recompute =
  // recomputed - extension), so more extension is better exactly when a
  // provider cache is relevant. Without one it is not a dimension at all.
  if (cacheRelevant && a.extensionTokens < b.extensionTokens) return false;
  return (
    a.renderedTokens <= b.renderedTokens &&
    a.continuityLoss <= b.continuityLoss &&
    a.fidelityLoss <= b.fidelityLoss &&
    (a.renderedTokens < b.renderedTokens ||
      a.continuityLoss < b.continuityLoss ||
      a.fidelityLoss < b.fidelityLoss ||
      (cacheRelevant && a.extensionTokens > b.extensionTokens))
  );
}

function lowestSetBit(value: bigint): number {
  let index = 0;
  while ((value & 1n) === 0n) { value >>= 1n; index++; }
  return index;
}

function reconstructFrontier(trace: AssignmentTrace | null): Map<ChunkId, number> {
  const chain: AssignmentTrace[] = [];
  for (let cursor = trace; cursor; cursor = cursor.parent) chain.push(cursor);
  const frontier = new Map<ChunkId, number>();
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const id of chain[i].ids) frontier.set(id, chain[i].level);
  }
  return frontier;
}

function sameFrontier(a: ReadonlyMap<ChunkId, number>, b: ReadonlyMap<ChunkId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, level] of a) if (b.get(id) !== level) return false;
  return true;
}

/** Each lexicographic minimum is necessarily nondominated when its ordering
 * includes every priced dimension. Extension breaks F/K/T ties before the
 * frontier signature tie-breaker, and supplies a fourth extremum when warm. */
function bucketRepresentatives(pool: readonly ParetoLabel[], cacheRelevant: boolean,
  representativeOrder: (a: ParetoLabel, b: ParetoLabel) => number): ParetoLabel[] {
  let fidelity = pool[0];
  let continuity = pool[0];
  let tokens = pool[0];
  let extension = pool[0];
  for (let i = 1; i < pool.length; i++) {
    const label = pool[i];
    if (representativeOrder(label, fidelity) < 0) fidelity = label;
    if ((label.continuityLoss - continuity.continuityLoss || representativeOrder(label, continuity)) < 0) continuity = label;
    if ((label.renderedTokens - tokens.renderedTokens || representativeOrder(label, tokens)) < 0) tokens = label;
    if (cacheRelevant && (extension.extensionTokens - label.extensionTokens || representativeOrder(label, extension)) < 0) extension = label;
  }
  const result = [fidelity];
  if (continuity !== fidelity) result.push(continuity);
  if (tokens !== fidelity && tokens !== continuity) result.push(tokens);
  if (cacheRelevant && !result.includes(extension)) result.push(extension);
  return result;
}
