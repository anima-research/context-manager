import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import {
  CanonicalSummaryForest,
  SparseLabelCeilingError,
  type ExactCutCandidate,
} from './kv-unified.js';
import {
  ExactKvUnifiedPolicySolver,
  continuityLeafLoss,
  fidelityLeafLoss,
  normalizePolicy,
  type ExactPolicySolveOptions,
  type ExactPolicySolveResult,
  type KvUnifiedWelfarePolicy,
} from './kv-unified-policy.js';

interface CacheState {
  intact: boolean;
  matchedUnits: number;
  cachedTokens: number;
}

interface ParetoLabel {
  active: boolean;
  remaining: bigint;
  renderedTokens: number;
  extensionTokens: number;
  continuityLoss: number;
  fidelityLoss: number;
  cache: CacheState;
  trace: AssignmentTrace | null;
  approximation: ApproximationEnvelope;
}

interface ApproximationEnvelope {
  token: number;
  continuity: number;
  fidelity: number;
}

interface AssignmentTrace {
  parent: AssignmentTrace | null;
  ids: readonly ChunkId[];
  level: number;
}

export interface ParetoPropagationStats {
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
}

export type ParetoPolicySolveResult = ExactPolicySolveResult & {
  readonly propagation?: ParetoPropagationStats;
};

export type ParetoSolveOptions = ExactPolicySolveOptions & {
  labelCeiling?: number;
  tokenBucketSize?: number;
  continuityBucketSize?: number;
  fidelityBucketSize?: number;
  engine?: 'auto' | 'leaf' | 'dag';
};

/** Exact sparse Pareto propagation. R bucketing is added only after this
 * engine agrees with the exhaustive oracle on small forests. */
export class ParetoKvUnifiedPolicySolver {
  readonly forest: CanonicalSummaryForest;

  private readonly leaves: ReturnType<CanonicalSummaryForest['orderedLeaves']>;
  private readonly chunksById: ReadonlyMap<ChunkId, PickerInputs['chunks'][number]>;
  private readonly indexById: ReadonlyMap<ChunkId, number>;
  private readonly midpointAge = new Map<ChunkId, number>();
  private readonly summaryMetricCache = new Map<string, { continuity: number; fidelity: number }>();
  private readonly newestSequence: number;

  constructor(private readonly inputs: PickerInputs, forest?: CanonicalSummaryForest) {
    this.forest = forest ?? new CanonicalSummaryForest(inputs);
    this.leaves = this.forest.orderedLeaves();
    this.chunksById = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
    this.indexById = new Map(this.leaves.map((leaf, index) => [leaf.id, index]));
    this.newestSequence = Math.max(0, ...inputs.chunks.map((chunk) => chunk.sequence));
    let age = 0;
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const leaf = this.leaves[i];
      this.midpointAge.set(leaf.id, age + leaf.rawTokens / 2);
      age += leaf.rawTokens;
    }
  }

  solve(options: ParetoSolveOptions): ParetoPolicySolveResult {
    const internalHoles = this.hasInternalProtectedHoles();
    if (options.engine === 'dag' && internalHoles) {
      throw new Error('recursive DAG engine does not yet support internal protected holes');
    }
    if (options.engine !== 'leaf' && !internalHoles) return this.solveDag(options);
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
      cache: { intact: cacheRelevant, matchedUnits: 0, cachedTokens: 0 },
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
        if (dominates(incumbent, label)) {
          labelsDominated++;
          return;
        }
      }
      const survivors: ParetoLabel[] = [];
      for (const incumbent of current) {
        if (dominates(label, incumbent)) {
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
      },
    };
  }

  private solveDag(options: ParetoSolveOptions): ParetoPolicySolveResult {
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
      cache: { intact: cacheRelevant, matchedUnits: 0, cachedTokens: 0 },
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
    const prune = (labels: ParetoLabel[]): ParetoLabel[] => {
      states++;
      const groups = new Map<string, ParetoLabel[]>();
      for (const label of labels) {
        if (label.renderedTokens > options.maxTokens) continue;
        const key = stateKey(label, tokenBucketSize, continuityBucketSize, fidelityBucketSize);
        const current = groups.get(key);
        if (current) current.push(label);
        else groups.set(key, [label]);
      }
      const result: ParetoLabel[] = [];
      for (const pool of groups.values()) {
        const nondominated = pool.filter(
          (candidate, index) => !pool.some(
            (other, otherIndex) => otherIndex !== index && dominates(other, candidate),
          ),
        );
        const representatives = continuityBucketSize > 0 && fidelityBucketSize > 0
          ? uniqueLabels([
              [...nondominated].sort(representativeOrder)[0],
              [...nondominated].sort((a, b) =>
                a.continuityLoss - b.continuityLoss || representativeOrder(a, b),
              )[0],
              [...nondominated].sort((a, b) =>
                a.renderedTokens - b.renderedTokens || representativeOrder(a, b),
              )[0],
            ])
          : nondominated;
        const covered = coverApproximationPool(pool, representatives);
        labelsDominated += pool.length - covered.length;
        result.push(...covered);
      }
      labelsCreated += result.length;
      maxLabelsPerState = Math.max(maxLabelsPerState, result.length);
      if (result.length > ceiling) throw new SparseLabelCeilingError(ceiling, result.length);
      return result;
    };
    const orderedChildren = (summaryId: string): Array<{ kind: 'leaf' | 'summary'; id: string; sequence: number }> => {
      const summary = this.forest.summary(summaryId)!;
      return [
        ...summary.directLeafIds.map((id) => ({ kind: 'leaf' as const, id, sequence: this.forest.leaf(id)!.sequence })),
        ...summary.childSummaryIds.map((id) => ({ kind: 'summary' as const, id, sequence: this.forest.summary(id)!.firstSequence })),
      ].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    };
    const processSummary = (summaryId: string, incoming: ParetoLabel[]): ParetoLabel[] => {
      labelsExpanded += incoming.length;
      const summary = this.forest.summary(summaryId)!;
      const participants = summary.leafIds.filter((id) => !this.forest.leaf(id)!.externallyAccounted);
      let selected: ParetoLabel[] = [];
      if (participants.length > 0 && participants.every((id) => this.forest.leaf(id)!.allowedLevels.includes(summary.level))) {
        selected = incoming.map((label) => {
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
            this.isExtension(summary.leafIds, options),
            options,
            markerByUnit,
          );
        });
      }
      let expanded = incoming;
      const children = orderedChildren(summaryId);
      for (let childIndex = 0; childIndex < children.length;) {
        const child = children[childIndex];
        if (child.kind === 'summary') {
          expanded = processSummary(child.id, expanded);
          childIndex++;
        } else {
          const rawRun: string[] = [];
          while (childIndex < children.length && children[childIndex].kind === 'leaf') {
            rawRun.push(children[childIndex].id);
            childIndex++;
          }
          expanded = expanded.map((label) => {
            const ids = rawRun.filter((leafId) => !this.forest.leaf(leafId)!.externallyAccounted);
            if (ids.some((leafId) => !this.forest.leaf(leafId)!.allowedLevels.includes(0))) return null;
            return this.emitRawRun(
              this.assignRawRun(label, ids, policy, options),
              ids,
              options,
              markerByUnit,
            );
          }).filter((label): label is ParetoLabel => label !== null);
        }
        expanded = prune(expanded);
      }
      return prune([...selected, ...expanded]);
    };

    let labels = [initial];
    for (const root of this.forest.roots) {
      if (root.kind === 'summary') labels = processSummary(root.id, labels);
      else {
        const leaf = this.forest.leaf(root.id)!;
        if (!leaf.externallyAccounted) {
          labels = labels.map((label) => this.emit(
            this.assign(label, [leaf.id], 0, policy, options),
            'raw',
            leaf.id,
            leaf.rawTokens,
            this.isExtension([leaf.id], options),
            options,
            markerByUnit,
          ));
        }
      }
      labels = prune(labels);
    }
    const terminal: ExactCutCandidate[] = [];
    for (const label of labels) {
      let finished = label;
      if (this.inputs.tailTokens > 0) {
        finished = this.emit(label, 'tail', 'tail', this.inputs.tailTokens, false, options, markerByUnit);
      }
      if (finished.renderedTokens <= options.maxTokens) {
        terminal.push({ frontier: reconstructFrontier(finished.trace), renderedTokens: finished.renderedTokens });
      }
    }
    if (!terminal.some((candidate) => sameFrontier(candidate.frontier, feasibility.frontier))) {
      terminal.push({ frontier: feasibility.frontier, renderedTokens: feasibility.floorTokens });
    }
    const scored = new ExactKvUnifiedPolicySolver(this.inputs, this.forest).scoreCandidates(
      terminal,
      options,
      {
        statesVisited: states,
        candidatesGenerated: labelsCreated,
        maxCandidatesAtState: maxLabelsPerState,
        terminalCandidates: terminal.length,
      },
      feasibility,
    );
    if (!scored.feasible) return scored;
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
      cacheSlope * tokenError * cachePrice +
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
    const key = `${summaryId}:${options.presentation?.currentSeq ?? 'none'}`;
    let metrics = this.summaryMetricCache.get(key);
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
      this.summaryMetricCache.set(key, metrics);
    }
    return {
      ...label,
      active: true,
      trace: { parent: label.trace, ids, level },
      continuityLoss: label.continuityLoss + metrics.continuity,
      fidelityLoss: label.fidelityLoss + metrics.fidelity,
    };
  }

  private emit(label: ParetoLabel, kind: 'head' | 'raw' | 'recall' | 'tail', key: string, tokens: number, extension: boolean, options: ExactPolicySolveOptions, markerByUnit: ReadonlyMap<number, number>): ParetoLabel {
    const renderedTokens = label.renderedTokens + tokens;
    const extensionTokens = label.extensionTokens + (extension ? tokens : 0);
    const cache = { ...label.cache };
    if (cache.intact && options.cache) {
      const previous = options.cache.layout.units[cache.matchedUnits];
      if (previous?.kind === kind && previous.key === key) {
        cache.matchedUnits++;
        const marker = markerByUnit.get(cache.matchedUnits);
        if (marker !== undefined) cache.cachedTokens = marker;
      } else cache.intact = false;
    }
    return { ...label, active: true, renderedTokens, extensionTokens, cache };
  }

  private assignRawRun(
    label: ParetoLabel,
    ids: readonly ChunkId[],
    policy: KvUnifiedWelfarePolicy,
    options: ExactPolicySolveOptions,
  ): ParetoLabel {
    if (ids.length === 0) return label;
    let continuityLoss = label.continuityLoss;
    if (options.presentation) {
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
    let tokens = 0;
    let extensionTokens = 0;
    for (const id of ids) {
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

  private isExtension(ids: readonly ChunkId[], options: ExactPolicySolveOptions): boolean {
    return options.presentation !== undefined && ids.length > 0 && ids.every((id) => !options.presentation!.leaves.has(id));
  }
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
  return [
    label.remaining.toString(16),
    tokenKey,
    label.extensionTokens,
    label.cache.intact ? 1 : 0,
    label.cache.matchedUnits,
    label.cache.cachedTokens,
    continuityBucketSize > 0 ? Math.floor(label.continuityLoss / continuityBucketSize) : 'c*',
    fidelityBucketSize > 0 ? Math.floor(label.fidelityLoss / fidelityBucketSize) : 'f*',
  ].join(':');
}

const ZERO_APPROXIMATION: ApproximationEnvelope = Object.freeze({
  token: 0,
  continuity: 0,
  fidelity: 0,
});

/** Attach every discarded path to one retained representative.  The
 * component envelopes are one-sided: how much worse the representative may
 * be than an exact path it stands in for.  Subsequent actions add the same
 * component costs at the same structural/cache state, so the envelope carries
 * forward unchanged until another prune. */
function coverApproximationPool(
  pool: readonly ParetoLabel[],
  representatives: readonly ParetoLabel[],
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
        Math.max(0, candidate.fidelityLoss - source.fidelityLoss);
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
  }
  return covered;
}

function maxApproximation(labels: readonly ParetoLabel[]): ApproximationEnvelope {
  const result = { token: 0, continuity: 0, fidelity: 0 };
  for (const label of labels) {
    result.token = Math.max(result.token, label.approximation.token);
    result.continuity = Math.max(result.continuity, label.approximation.continuity);
    result.fidelity = Math.max(result.fidelity, label.approximation.fidelity);
  }
  return result;
}

function dominates(a: ParetoLabel, b: ParetoLabel): boolean {
  return (
    a.renderedTokens <= b.renderedTokens &&
    a.continuityLoss <= b.continuityLoss &&
    a.fidelityLoss <= b.fidelityLoss &&
    (a.renderedTokens < b.renderedTokens ||
      a.continuityLoss < b.continuityLoss ||
      a.fidelityLoss < b.fidelityLoss)
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

function representativeOrder(a: ParetoLabel, b: ParetoLabel): number {
  return (
    a.fidelityLoss - b.fidelityLoss ||
    a.continuityLoss - b.continuityLoss ||
    a.renderedTokens - b.renderedTokens ||
    a.cache.matchedUnits - b.cache.matchedUnits
  );
}

function uniqueLabels(labels: readonly ParetoLabel[]): ParetoLabel[] {
  return labels.filter((label, index) => labels.indexOf(label) === index);
}
