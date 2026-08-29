/** Exact small-forest welfare oracle for kv-unified.
 *
 * Production will replace exact cut enumeration with Pareto label propagation.
 * This module fixes the terminal metric and scoring semantics first, so the
 * bounded solver has an executable oracle to agree with.
 */

import type { ChunkId, SummaryId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { CanonicalSummaryForest, type ExactCutEnumerationStats, type MinimumTokenResult } from './kv-unified.js';
import { SummaryTree } from './summary-tree.js';
import { renderLayout, type RenderLayout } from './render-offsets.js';
import { evaluateCacheHit, type CacheMarker } from './kv-cache-sim.js';

export interface PresentedLeaf {
  readonly repHash: string;
  readonly level: number;
  readonly lastChangedSeq: number;
}

export interface AcceptedPresentationReference {
  readonly currentSeq: number;
  readonly leaves: ReadonlyMap<ChunkId, PresentedLeaf>;
}

export interface ProviderCacheReference {
  readonly immutablePrefixHash: string;
  readonly layout: RenderLayout;
  readonly markers: readonly CacheMarker[];
}

export interface KvUnifiedWelfarePolicy {
  readonly alpha: number;
  readonly budgetLowRatio: number;
  readonly budgetHighRatio: number;
  readonly budgetUnderLambda: number;
  readonly budgetOverLambda: number;
  readonly cacheLambda: number;
  readonly cacheScale: number;
  readonly cacheReadPrice: number;
  readonly cacheWritePrice: number;
  readonly continuityLambda: number;
  readonly continuityScale: number;
  readonly continuityRecencyHalfLifeTokens: number;
  readonly continuityRecencyFloor: number;
  readonly continuityStableHalfLife: number;
  readonly continuityStableFloor: number;
}

export const DEFAULT_KV_UNIFIED_WELFARE_POLICY: KvUnifiedWelfarePolicy = {
  alpha: 0.7,
  budgetLowRatio: 0.6,
  budgetHighRatio: 0.9,
  budgetUnderLambda: 1_000,
  budgetOverLambda: 4_000,
  cacheLambda: 1,
  cacheScale: 100_000,
  cacheReadPrice: 0.1,
  cacheWritePrice: 1.25,
  continuityLambda: 1,
  continuityScale: 100_000,
  continuityRecencyHalfLifeTokens: 100_000,
  continuityRecencyFloor: 0.2,
  continuityStableHalfLife: 16,
  continuityStableFloor: 0.25,
};

export class KvUnifiedPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KvUnifiedPolicyError';
  }
}

export interface ExactPolicySolveOptions {
  readonly maxTokens: number;
  readonly policy?: Partial<KvUnifiedWelfarePolicy>;
  readonly presentation?: AcceptedPresentationReference;
  readonly cache?: ProviderCacheReference;
  readonly currentImmutablePrefixHash?: string;
  readonly continuityMultiplier?: number;
  readonly maxLeaves?: number;
  readonly maxCandidates?: number;
  /** Recursive oracle or the independent left-to-right label engine. */
  readonly candidateSource?: 'recursive' | 'labels';
  readonly labelCeiling?: number;
}

export interface ExactPolicyCandidate {
  readonly frontier: ReadonlyMap<ChunkId, number>;
  readonly layout: RenderLayout;
  readonly renderedTokens: number;
  readonly cacheChurn: number;
  readonly continuityLoss: number;
  readonly fidelityLoss: number;
  readonly budgetPenalty: number;
  readonly cacheExcess: number;
  readonly continuityExcess: number;
  readonly score: number;
}

export type ExactPolicySolveResult =
  | {
      readonly feasible: false;
      readonly feasibility: Extract<MinimumTokenResult, { feasible: false }>;
    }
  | {
      readonly feasible: true;
      readonly selected: ExactPolicyCandidate;
      readonly candidates: readonly ExactPolicyCandidate[];
      readonly cacheFloor: number;
      readonly continuityFloor: number;
      readonly cacheRelevant: boolean;
      readonly enumeration: ExactCutEnumerationStats;
    };

interface UnscoredCandidate {
  frontier: ReadonlyMap<ChunkId, number>;
  layout: RenderLayout;
  renderedTokens: number;
  cacheChurn: number;
  continuityLoss: number;
  fidelityLoss: number;
  budgetPenalty: number;
}

export class ExactKvUnifiedPolicySolver {
  readonly forest: CanonicalSummaryForest;

  private readonly tree: SummaryTree;
  private readonly orderedChunks: PickerInputs['chunks'];
  private readonly summaryLeaves = new Map<SummaryId, readonly ChunkId[]>();

  constructor(private readonly inputs: PickerInputs, forest?: CanonicalSummaryForest) {
    this.forest = forest ?? new CanonicalSummaryForest(inputs);
    this.tree = new SummaryTree(inputs);
    this.orderedChunks = [...inputs.chunks].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
    );
    for (const summary of this.forest.allSummaries()) {
      this.summaryLeaves.set(summary.id, summary.leafIds);
    }
  }

  solve(options: ExactPolicySolveOptions): ExactPolicySolveResult {
    const policy = normalizePolicy(options.policy);
    const feasibility = this.forest.minimumTokens(options.maxTokens);
    if (!feasibility.feasible) return { feasible: false, feasibility };

    const enumeration =
      options.candidateSource === 'labels'
        ? (() => {
            const labels = this.forest.propagateExactLabels({
              maxTokens: options.maxTokens,
              labelCeiling: options.labelCeiling ?? options.maxCandidates,
            });
            return {
              candidates: labels.candidates,
              stats: {
                statesVisited: labels.stats.structuralStates,
                candidatesGenerated: labels.stats.labelsCreated,
                maxCandidatesAtState: labels.stats.maxLabelsPerState,
                terminalCandidates: labels.stats.terminalLabels,
              },
            };
          })()
        : this.forest.enumerateExactCuts({
            maxLeaves: options.maxLeaves,
            maxCandidates: options.maxCandidates,
            maxTokens: options.maxTokens,
          });
    const cacheRelevant =
      options.cache !== undefined &&
      options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    const unscored: UnscoredCandidate[] = enumeration.candidates.map((candidate) => {
      const layout = renderLayout(this.inputs, this.tree, candidate.frontier);
      return {
        frontier: candidate.frontier,
        layout,
        renderedTokens: candidate.renderedTokens,
        cacheChurn: cacheRelevant
          ? this.cacheChurn(layout, options.cache!, options.presentation, policy)
          : 0,
        continuityLoss: this.continuityLoss(candidate.frontier, options.presentation, policy),
        fidelityLoss: this.fidelityLoss(candidate.frontier, policy),
        budgetPenalty: budgetPenalty(candidate.renderedTokens, options.maxTokens, policy),
      };
    });
    if (unscored.length === 0) {
      // The exact feasibility witness must always survive the exact enumerator.
      throw new Error('kv-unified exact oracle produced no candidate under a feasible hard wall');
    }
    const cacheFloor = Math.min(...unscored.map((candidate) => candidate.cacheChurn));
    const continuityFloor = Math.min(...unscored.map((candidate) => candidate.continuityLoss));
    const continuityMultiplier = normalizeContinuityMultiplier(options.continuityMultiplier);
    const candidates: ExactPolicyCandidate[] = unscored.map((candidate) => {
      const cacheExcess = Math.max(0, candidate.cacheChurn - cacheFloor);
      const continuityExcess = Math.max(0, candidate.continuityLoss - continuityFloor);
      const score =
        candidate.fidelityLoss +
        candidate.budgetPenalty +
        quadratic(cacheExcess, policy.cacheScale, policy.cacheLambda) +
        continuityMultiplier *
          quadratic(continuityExcess, policy.continuityScale, policy.continuityLambda);
      return { ...candidate, cacheExcess, continuityExcess, score };
    });
    candidates.sort((a, b) =>
      a.score - b.score ||
      a.renderedTokens - b.renderedTokens ||
      frontierSignature(a.frontier, this.orderedChunks.map((chunk) => chunk.id)).localeCompare(
        frontierSignature(b.frontier, this.orderedChunks.map((chunk) => chunk.id)),
      ),
    );
    return {
      feasible: true,
      selected: candidates[0],
      candidates,
      cacheFloor,
      continuityFloor,
      cacheRelevant,
      enumeration: enumeration.stats,
    };
  }

  private fidelityLoss(
    frontier: ReadonlyMap<ChunkId, number>,
    policy: KvUnifiedWelfarePolicy,
  ): number {
    const newestSequence = this.orderedChunks.at(-1)?.sequence ?? 0;
    let loss = 0;
    for (const chunk of this.orderedChunks) {
      if (this.inputs.headChunkIds.has(chunk.id) || this.inputs.tailChunkIds.has(chunk.id)) continue;
      const level = frontier.get(chunk.id) ?? 0;
      const age = Math.max(1, newestSequence - chunk.sequence + 1);
      const salience = clamp(chunk.salience ?? 1, 0.2, 1);
      loss += salience * age ** (-policy.alpha) * chunk.rawTokens * level;
    }
    return loss;
  }

  private continuityLoss(
    frontier: ReadonlyMap<ChunkId, number>,
    presentation: AcceptedPresentationReference | undefined,
    policy: KvUnifiedWelfarePolicy,
  ): number {
    if (!presentation) return 0;
    const recencyHalfLife = positive(policy.continuityRecencyHalfLifeTokens);
    const stableHalfLife = positive(policy.continuityStableHalfLife);
    let distanceFromLiveEdge = 0;
    let loss = 0;
    for (let index = this.orderedChunks.length - 1; index >= 0; index--) {
      const chunk = this.orderedChunks[index];
      const midpointAge = distanceFromLiveEdge + chunk.rawTokens / 2;
      distanceFromLiveEdge += chunk.rawTokens;
      const previous = presentation.leaves.get(chunk.id);
      if (!previous) continue; // extension
      const level = frontier.get(chunk.id) ?? 0;
      const repHash = this.representationHash(chunk.id, level);
      if (repHash === previous.repHash && level === previous.level) continue;
      const recency =
        policy.continuityRecencyFloor +
        (1 - policy.continuityRecencyFloor) * 2 ** (-midpointAge / recencyHalfLife);
      const tau = Math.max(0, presentation.currentSeq - previous.lastChangedSeq);
      const stability =
        policy.continuityStableFloor +
        (1 - policy.continuityStableFloor) * 2 ** (-tau / stableHalfLife);
      const salience = clamp(chunk.salience ?? 1, 0.2, 1);
      const representationDistance = Math.max(1, Math.abs(level - previous.level));
      loss += salience * chunk.rawTokens * recency * stability * representationDistance;
    }
    return loss;
  }

  private cacheChurn(
    layout: RenderLayout,
    cache: ProviderCacheReference,
    presentation: AcceptedPresentationReference | undefined,
    policy: KvUnifiedWelfarePolicy,
  ): number {
    const hit = evaluateCacheHit(cache.layout, cache.markers, layout);
    const extensionTokens = presentation ? this.extensionTokens(layout, presentation) : 0;
    const avoidableRecompute = Math.max(0, hit.recomputedTokens - extensionTokens);
    return avoidableRecompute * Math.max(0, policy.cacheWritePrice - policy.cacheReadPrice);
  }

  private extensionTokens(
    layout: RenderLayout,
    presentation: AcceptedPresentationReference,
  ): number {
    let tokens = 0;
    for (const unit of layout.units) {
      if (unit.kind === 'raw') {
        if (!presentation.leaves.has(unit.key)) tokens += unit.tokens;
      } else if (unit.kind === 'recall') {
        const leaves = this.summaryLeaves.get(unit.key) ?? [];
        if (leaves.length > 0 && leaves.every((leafId) => !presentation.leaves.has(leafId))) {
          tokens += unit.tokens;
        }
      }
    }
    return tokens;
  }

  private representationHash(chunkId: ChunkId, level: number): string {
    if (level === 0) return `raw:${chunkId}`;
    const leaf = this.forest.leaf(chunkId);
    const summaryId = leaf?.summaryIds.find(
      (candidateId) => this.forest.summary(candidateId)?.level === level,
    );
    if (!summaryId) throw new Error(`missing L${level} representation for ${chunkId}`);
    return `summary:${summaryId}`;
  }
}

function normalizePolicy(
  override: Partial<KvUnifiedWelfarePolicy> | undefined,
): KvUnifiedWelfarePolicy {
  const policy = { ...DEFAULT_KV_UNIFIED_WELFARE_POLICY, ...override };
  const finiteNonNegative: Array<keyof KvUnifiedWelfarePolicy> = [
    'alpha',
    'budgetUnderLambda',
    'budgetOverLambda',
    'cacheLambda',
    'cacheReadPrice',
    'cacheWritePrice',
    'continuityLambda',
  ];
  for (const key of finiteNonNegative) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0) {
      throw new KvUnifiedPolicyError(`${key} must be finite and non-negative`);
    }
  }
  const finitePositive: Array<keyof KvUnifiedWelfarePolicy> = [
    'cacheScale',
    'continuityScale',
    'continuityRecencyHalfLifeTokens',
    'continuityStableHalfLife',
  ];
  for (const key of finitePositive) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) {
      throw new KvUnifiedPolicyError(`${key} must be finite and positive`);
    }
  }
  for (const key of [
    'budgetLowRatio',
    'budgetHighRatio',
    'continuityRecencyFloor',
    'continuityStableFloor',
  ] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > 1) {
      throw new KvUnifiedPolicyError(`${key} must be in [0, 1]`);
    }
  }
  if (policy.budgetLowRatio > policy.budgetHighRatio) {
    throw new KvUnifiedPolicyError('budgetLowRatio must not exceed budgetHighRatio');
  }
  return policy;
}

function budgetPenalty(
  renderedTokens: number,
  maxTokens: number,
  policy: KvUnifiedWelfarePolicy,
): number {
  const low = policy.budgetLowRatio * maxTokens;
  const high = policy.budgetHighRatio * maxTokens;
  const under = Math.max(0, low - renderedTokens);
  const over = Math.max(0, renderedTokens - high);
  return (
    policy.budgetUnderLambda * (under / positive(low)) ** 2 +
    policy.budgetOverLambda * (over / positive(maxTokens - high)) ** 2
  );
}

function quadratic(excess: number, scale: number, lambda: number): number {
  return lambda * (excess / positive(scale)) ** 2;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function normalizeContinuityMultiplier(value: number | undefined): number {
  if (value === undefined) return 1;
  // Malformed relaxation fails closed: it must never make continuity cheaper.
  if (!Number.isFinite(value) || value < 0 || value > 1) return 1;
  return value;
}

function frontierSignature(
  frontier: ReadonlyMap<ChunkId, number>,
  leafIds: readonly ChunkId[],
): string {
  return leafIds.map((leafId) => `${leafId}:${frontier.get(leafId) ?? 0}`).join('|');
}
