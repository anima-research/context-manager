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
}

export type ParetoPolicySolveResult = ExactPolicySolveResult & {
  readonly propagation?: ParetoPropagationStats;
};

/** Exact sparse Pareto propagation. R bucketing is added only after this
 * engine agrees with the exhaustive oracle on small forests. */
export class ParetoKvUnifiedPolicySolver {
  readonly forest: CanonicalSummaryForest;

  private readonly leaves: ReturnType<CanonicalSummaryForest['orderedLeaves']>;
  private readonly chunksById: ReadonlyMap<ChunkId, PickerInputs['chunks'][number]>;
  private readonly indexById: ReadonlyMap<ChunkId, number>;
  private readonly midpointAge = new Map<ChunkId, number>();
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

  solve(options: ExactPolicySolveOptions & {
    labelCeiling?: number;
    /** 0 = exact R; positive = approximate token-state buckets. */
    tokenBucketSize?: number;
  }): ParetoPolicySolveResult {
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
    };
    if (this.inputs.headTokens > 0) {
      initial = this.emit(initial, 'head', 'head', this.inputs.headTokens, false, options, markerByUnit);
    }

    const ceiling = options.labelCeiling ?? 1_000_000;
    const tokenBucketSize = Math.max(0, Math.floor(options.tokenBucketSize ?? 0));
    const stack: ParetoLabel[] = [];
    const states = new Map<string, ParetoLabel[]>();
    let labelsCreated = 0;
    let labelsExpanded = 0;
    let labelsDominated = 0;
    let maxLabelsPerState = 0;
    const insert = (label: ParetoLabel): void => {
      if (label.renderedTokens > options.maxTokens) return;
      const key = stateKey(label, tokenBucketSize);
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
      },
    };
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
      trace: { parent: label.trace, ids: [...ids], level },
      continuityLoss,
      fidelityLoss,
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

  private isExtension(ids: readonly ChunkId[], options: ExactPolicySolveOptions): boolean {
    return options.presentation !== undefined && ids.length > 0 && ids.every((id) => !options.presentation!.leaves.has(id));
  }
}

function stateKey(label: ParetoLabel, tokenBucketSize: number): string {
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
  ].join(':');
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
