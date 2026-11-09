/** Exact small-forest welfare oracle for kv-unified.
 *
 * Production will replace exact cut enumeration with Pareto label propagation.
 * This module fixes the terminal metric and scoring semantics first, so the
 * bounded solver has an executable oracle to agree with.
 */

import type { ChunkId, SummaryId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import type { KvUnifiedReuse } from './kv-unified-reuse.js';
import {
  CanonicalSummaryForest,
  type ExactCutCandidate,
  type ExactCutEnumerationStats,
  type MinimumTokenResult,
} from './kv-unified.js';
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
  /** Per marker, which entry it sat on and a hash of the request's entries up
   *  to it, as the strategy emitted them, so a later compile can tell a
   *  prefix that changed in place under the same unit keys. Absent on a
   *  reference an earlier version wrote. */
  readonly render?: CacheRenderRecord;
}

/**
 * What an accepted request's prefixes were, byte for byte, as the strategy
 * emitted them, where a later compile can change them under the same unit
 * keys. A unit's key is its message id, or `head`, or a summary id. What
 * renders under a key can still change: an edit rewrites a message, an image
 * is stripped, last-N replaces a tool result, pairing repair moves or stubs
 * one, the cap cuts a message or a recall answer, a recall's envelope or
 * label changes. A provider serves a marker's prefix only while every byte
 * before it is unchanged, so a marker whose prefix no longer matches is left
 * out of the reference the solver gets. The context manager's message-position
 * injections, which it adds after the strategy's selection, aren't in it.
 */
export interface CacheRenderRecord {
  /** Per marker, parallel to `markers`: the identity of the entry the marker
   *  sat on (the message it ends on, or its layout key), and a hash of every
   *  entry up to it, by participant and whole content. */
  readonly prefixes: readonly { readonly through: string; readonly hash: string }[];
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
  /** Geometric bands the three age measures are read at, as bands per
   * doubling: a leaf's fidelity age (sequences from the newest leaf), its
   * continuity recency (tokens from the live edge) and its stability (turns
   * since it last moved) are each priced at the lower edge of the band they
   * fall in, so a weight changes only when the age crosses a band edge.
   * Exact ages change every leaf's weight on every append, which is what
   * keeps a solve from reusing any score from the compile before (#45). 0
   * prices exact ages. With banding on, the stability age is 0 for half a
   * half-life after a move and read at whole doublings from there, and
   * recency is the floor from eight half-lives out (see continuityLeafBase). */
  readonly ageBandSteps: number;
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
  // Exact at the solver level; the strategy built from a recipe fills in
  // its own default (see KvUnifiedConfig.policy.ageBandSteps).
  ageBandSteps: 0,
};

/** The finest banding the policy accepts: 64 bands per doubling is a
 * step of 1.1%, below any weight's sensitivity, and keeps the edge table
 * (one entry per band, scanned per leaf) small. */
export const MAX_AGE_BAND_STEPS = 64;

/** The lower edge of the geometric band `age` falls in, with `steps` bands
 * per doubling: 2^(floor(log2(age) · steps) / steps). Ages below 1 and a
 * `steps` of 0 are returned as given. */
export function bandedAge(age: number, steps: number): number {
  if (!(steps > 0) || !(age >= 1) || !Number.isFinite(age)) return age;
  // The octave the age falls in, then its band within the octave from the
  // table of fractional edges (every solve calls this three times per
  // leaf, so no pow per call). Floating-point: log2 of an age beside a
  // doubling can floor an octave off either way; the doublings decide. The
  // exponent is capped where 2^exponent is still finite.
  let exponent = Math.min(1023, Math.floor(Math.log2(age)));
  let octave = 2 ** exponent;
  if (octave > age) { exponent--; octave /= 2; }
  else if (octave * 2 <= age) { exponent++; octave *= 2; }
  const edges = bandEdges(steps);
  const ratio = age / octave;
  let k = edges.length - 1;
  while (k > 0 && edges[k] > ratio) k--;
  return octave * edges[k];
}

const bandEdgeTables = new Map<number, Float64Array>();

/** The fractional edges of one octave at `steps` bands per doubling:
 * 2^(k/steps) for k in [0, steps). */
function bandEdges(steps: number): Float64Array {
  let table = bandEdgeTables.get(steps);
  if (!table) {
    const count = Math.max(1, Math.ceil(steps));
    table = new Float64Array(count);
    for (let k = 0; k < count; k++) table[k] = 2 ** (k / steps);
    bandEdgeTables.set(steps, table);
  }
  return table;
}

export class KvUnifiedPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KvUnifiedPolicyError';
  }
}

export interface ExactPolicySolveOptions {
  /** Cross-compile reuse holder (see kv-unified-reuse.ts). Never read by what-if solves. */
  readonly reuse?: KvUnifiedReuse;
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
  /** Score improvement required to replace a feasible accepted presentation. */
  readonly adoptEpsilon?: number;
}

export interface ExactPolicyCandidate {
  readonly frontier: ReadonlyMap<ChunkId, number>;
  readonly layout: RenderLayout;
  /** The cut as the level per leaf in `leafIds` order, when the candidate
   *  came through the terminal evaluator (the same assignment as `frontier`). */
  readonly levels?: ArrayLike<number>;
  readonly leafIds?: readonly ChunkId[];
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
    } & SharedFrameHooks;

/** Both hooks or neither: an engine that scores its terminal candidates
 * lazily supplies both (see `withBestScoreUnder`), so a consumer that has
 * `bestScoreUnder` can take the cut from `bestUnder` instead of scoring the
 * whole pool. */
export type SharedFrameHooks =
  | {
      /** Best score this pool reaches when both penalties are measured from
       * the given floors instead of the pool's own. Scores from different
       * solves are comparable only through a shared frame like this. */
      readonly bestScoreUnder: (cacheFloor: number, continuityFloor: number) => number;
      /** The candidate that reaches `bestScoreUnder`, ties broken on rendered
       * tokens then frontier signature, as the selection breaks them. Its
       * fields are in the pool's own frame. */
      readonly bestUnder: (cacheFloor: number, continuityFloor: number) => ExactPolicyCandidate;
    }
  | { readonly bestScoreUnder?: undefined; readonly bestUnder?: undefined };

export interface UnscoredCandidate {
  frontier: ReadonlyMap<ChunkId, number>;
  layout: RenderLayout;
  levels?: ArrayLike<number>;
  leafIds?: readonly ChunkId[];
  renderedTokens: number;
  cacheChurn: number;
  continuityLoss: number;
  fidelityLoss: number;
  budgetPenalty: number;
  /** Optional exact identity check supplied by a prepared evaluator. */
  matchesPresentation?: boolean;
}

export class ExactKvUnifiedPolicySolver {
  readonly forest: CanonicalSummaryForest;

  private tree: SummaryTree | null = null;
  private readonly orderedChunks: readonly PickerInputs['chunks'][number][];
  private readonly summaryLeaves = new Map<SummaryId, readonly ChunkId[]>();

  constructor(private readonly inputs: PickerInputs, forest?: CanonicalSummaryForest) {
    this.forest = forest ?? new CanonicalSummaryForest(inputs);
    // A forest built from these inputs already holds this sort of them.
    this.orderedChunks = this.forest.builtFrom(inputs) ? this.forest.orderedChunks() : [...inputs.chunks].sort(
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
    return this.scoreCandidates(enumeration.candidates, options, enumeration.stats);
  }

  scoreCandidates(
    sourceCandidates: readonly ExactCutCandidate[],
    options: ExactPolicySolveOptions,
    stats: ExactCutEnumerationStats,
    knownFeasibility?: Extract<MinimumTokenResult, { feasible: true }>,
  ): ExactPolicySolveResult {
    const policy = normalizePolicy(options.policy);
    const feasibility = knownFeasibility ?? this.forest.minimumTokens(options.maxTokens);
    if (!feasibility.feasible) return { feasible: false, feasibility };
    const cacheRelevant =
      options.cache !== undefined &&
      options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    const unscored: UnscoredCandidate[] = sourceCandidates.map((candidate) => {
      const layout = cacheRelevant
        ? renderLayout(this.inputs, this.getTree(), candidate.frontier)
        : { units: [], totalTokens: candidate.renderedTokens };
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
    return this.scorePreparedCandidates(unscored, options, stats, cacheRelevant);
  }

  /** Score exact prepared metrics without eagerly materializing each frontier. */
  scorePreparedCandidates(
    unscored: readonly UnscoredCandidate[],
    options: ExactPolicySolveOptions,
    stats: ExactCutEnumerationStats,
    cacheRelevant: boolean,
  ): Extract<ExactPolicySolveResult, { feasible: true }> {
    const policy = normalizePolicy(options.policy);
    if (unscored.length === 0) {
      // The exact feasibility witness must always survive the exact enumerator.
      throw new Error('kv-unified exact oracle produced no candidate under a feasible hard wall');
    }
    // A loop, not a spread: a full terminal evaluation passes every terminal
    // label, which only the label ceiling bounds, and a call takes about
    // 125,000 spread arguments (#255).
    let cacheFloor = Infinity;
    let continuityFloor = Infinity;
    for (const candidate of unscored) {
      cacheFloor = Math.min(cacheFloor, candidate.cacheChurn);
      continuityFloor = Math.min(continuityFloor, candidate.continuityLoss);
    }
    const continuityMultiplier = normalizeContinuityMultiplier(options.continuityMultiplier);
    const matching = new Map<ExactPolicyCandidate, boolean | undefined>();
    const candidates: ExactPolicyCandidate[] = unscored.map((candidate) => {
      const cacheExcess = Math.max(0, candidate.cacheChurn - cacheFloor);
      const continuityExcess = Math.max(0, candidate.continuityLoss - continuityFloor);
      const score = policyScore(candidate.fidelityLoss, candidate.budgetPenalty,
        candidate.cacheChurn, candidate.continuityLoss, cacheFloor, continuityFloor, policy, continuityMultiplier);
      const result = {
        get frontier() { return candidate.frontier; },
        get layout() { return candidate.layout; },
        renderedTokens: candidate.renderedTokens,
        cacheChurn: candidate.cacheChurn, continuityLoss: candidate.continuityLoss,
        fidelityLoss: candidate.fidelityLoss, budgetPenalty: candidate.budgetPenalty,
        cacheExcess, continuityExcess, score,
      };
      Object.defineProperty(result, 'levels', { get: () => candidate.levels, enumerable: false });
      Object.defineProperty(result, 'leafIds', { get: () => candidate.leafIds, enumerable: false });
      matching.set(result, candidate.matchesPresentation);
      return result as ExactPolicyCandidate;
    });
    const leafIds = this.orderedChunks.map((chunk) => chunk.id);
    if (candidates.length > 1) candidates.sort((a, b) => comparePolicyCandidates(a, b, leafIds));
    let selected = candidates[0];
    const epsilon =
      Number.isFinite(options.adoptEpsilon) && (options.adoptEpsilon ?? 0) > 0
        ? options.adoptEpsilon!
        : 0;
    if (epsilon > 0 && options.presentation) {
      const carried = candidates.find((candidate) =>
        matching.get(candidate) ?? this.matchesPresentation(candidate.frontier, options.presentation!),
      );
      if (carried && carried.score <= selected.score + epsilon) selected = carried;
    }
    // The pool's best in a caller's frame, ties broken as the selection
    // breaks them (tokens, then signature); every candidate is scored.
    const inFrame = (c: ExactPolicyCandidate, kf: number, cf: number): number =>
      policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss, kf, cf, policy, continuityMultiplier);
    const bestUnder = (kf: number, cf: number): ExactPolicyCandidate => {
      let best = candidates[0];
      let bestScore = inFrame(best, kf, cf);
      for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        const value = inFrame(c, kf, cf);
        const tie = value === bestScore && (c.renderedTokens < best.renderedTokens || (c.renderedTokens === best.renderedTokens &&
          frontierSignature(c.frontier, leafIds).localeCompare(frontierSignature(best.frontier, leafIds)) < 0));
        if (value < bestScore || tie) { best = c; bestScore = value; }
      }
      return best;
    };
    return withBestScoreUnder({
      feasible: true,
      selected,
      candidates,
      cacheFloor,
      continuityFloor,
      cacheRelevant,
      enumeration: stats,
    }, (kf, cf) => inFrame(bestUnder(kf, cf), kf, cf), bestUnder);
  }

  private fidelityLoss(
    frontier: ReadonlyMap<ChunkId, number>,
    policy: KvUnifiedWelfarePolicy,
  ): number {
    const newestSequence = this.orderedChunks.at(-1)?.sequence ?? 0;
    let loss = 0;
    for (const chunk of this.orderedChunks) {
      if (this.inputs.headChunkIds.has(chunk.id) || this.inputs.tailChunkIds.has(chunk.id)) continue;
      loss += fidelityLeafLoss(chunk, frontier.get(chunk.id) ?? 0, newestSequence, policy);
    }
    return loss;
  }

  private continuityLoss(
    frontier: ReadonlyMap<ChunkId, number>,
    presentation: AcceptedPresentationReference | undefined,
    policy: KvUnifiedWelfarePolicy,
  ): number {
    if (!presentation) return 0;
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
      loss += continuityLeafLoss(
        chunk,
        level,
        repHash,
        previous,
        presentation.currentSeq,
        midpointAge,
        policy,
      );
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

  private getTree(): SummaryTree {
    this.tree ??= new SummaryTree(this.inputs);
    return this.tree;
  }

  private matchesPresentation(
    frontier: ReadonlyMap<ChunkId, number>,
    presentation: AcceptedPresentationReference,
  ): boolean {
    for (const [leafId, previous] of presentation.leaves) {
      if (!this.forest.leaf(leafId)) continue;
      const level = frontier.get(leafId) ?? 0;
      if (level !== previous.level || this.representationHash(leafId, level) !== previous.repHash) {
        return false;
      }
    }
    return true;
  }
}

export function normalizePolicy(
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
  if (!Number.isInteger(policy.ageBandSteps) || policy.ageBandSteps < 0 || policy.ageBandSteps > MAX_AGE_BAND_STEPS) {
    throw new KvUnifiedPolicyError(`ageBandSteps must be an integer from 0 to ${MAX_AGE_BAND_STEPS}`);
  }
  return policy;
}

/** The level-independent factor of `fidelityLeafLoss`: the loss at level L is
 * exactly `fidelityLeafBase(...) * L` (same operations, same order). */
export function fidelityLeafBase(
  chunk: PickerInputs['chunks'][number],
  newestSequence: number,
  policy: KvUnifiedWelfarePolicy,
): number {
  const age = bandedAge(Math.max(1, newestSequence - chunk.sequence + 1), policy.ageBandSteps);
  const salience = clamp(chunk.salience ?? 1, 0.2, 1);
  return salience * age ** (-policy.alpha) * chunk.rawTokens;
}

export function fidelityLeafLoss(
  chunk: PickerInputs['chunks'][number],
  level: number,
  newestSequence: number,
  policy: KvUnifiedWelfarePolicy,
): number {
  return fidelityLeafBase(chunk, newestSequence, policy) * level;
}

/** The level-independent factor of `continuityLeafLoss` for a leaf with an
 * accepted presentation: the loss at a level that moves the leaf is exactly
 * `continuityLeafBase(...) * max(1, |level - previous.level|)`. */
export function continuityLeafBase(
  chunk: PickerInputs['chunks'][number],
  previous: PresentedLeaf,
  currentSeq: number,
  midpointAgeTokens: number,
  policy: KvUnifiedWelfarePolicy,
): number {
  const halfLife = positive(policy.continuityRecencyHalfLifeTokens);
  const recencyAge = bandedAge(midpointAgeTokens, policy.ageBandSteps);
  // With banding on, recency is the floor from eight half-lives out (the
  // exact age, so the cutoff sits where it is documented rather than at the
  // first band edge past it): the decayed share is about 2^-8 of the range
  // there (the band just below the cutoff is read at its lower edge, so the
  // step is about 1.5x that), and every band edge past it would re-price
  // the old history for less.
  const recency = policy.ageBandSteps > 0 && midpointAgeTokens >= 8 * halfLife
    ? policy.continuityRecencyFloor
    : policy.continuityRecencyFloor + (1 - policy.continuityRecencyFloor) * 2 ** (-recencyAge / halfLife);
  // With banding on, stability is 1 for the first half of a half-life after
  // a move and read at whole doublings of tau from there: a move resets tau
  // for every leaf it touched at once, and finer bands would re-price that
  // whole region on each of its next turns.
  const stableHalfLife = positive(policy.continuityStableHalfLife);
  const exactTau = Math.max(0, currentSeq - previous.lastChangedSeq);
  const tau = policy.ageBandSteps > 0
    ? (exactTau < stableHalfLife / 2 ? 0 : bandedAge(exactTau, 1))
    : exactTau;
  const stability =
    policy.continuityStableFloor +
    (1 - policy.continuityStableFloor) *
      2 ** (-tau / stableHalfLife);
  const salience = clamp(chunk.salience ?? 1, 0.2, 1);
  return salience * chunk.rawTokens * recency * stability;
}

export function continuityLeafLoss(
  chunk: PickerInputs['chunks'][number],
  level: number,
  repHash: string,
  previous: PresentedLeaf | undefined,
  currentSeq: number,
  midpointAgeTokens: number,
  policy: KvUnifiedWelfarePolicy,
): number {
  if (!previous || (repHash === previous.repHash && level === previous.level)) return 0;
  const representationDistance = Math.max(1, Math.abs(level - previous.level));
  return continuityLeafBase(chunk, previous, currentSeq, midpointAgeTokens, policy) * representationDistance;
}

export function budgetPenalty(
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

export function normalizeContinuityMultiplier(value: number | undefined): number {
  if (value === undefined) return 1;
  // Malformed relaxation fails closed: it must never make continuity cheaper.
  if (!Number.isFinite(value) || value < 0 || value > 1) return 1;
  return value;
}

export function comparePolicyCandidates(a: ExactPolicyCandidate, b: ExactPolicyCandidate,
  leafIds: readonly ChunkId[]): number {
  return a.score - b.score || a.renderedTokens - b.renderedTokens ||
    frontierSignature(a.frontier, leafIds).localeCompare(frontierSignature(b.frontier, leafIds));
}

/** Attach the shared-frame scorer as a non-enumerable property: results are
 * compared structurally in tests and serialized by diagnostics, and a
 * per-result closure must not take part in either. Object spread drops it;
 * callers fall back to scoring the public candidate list. */
export function withBestScoreUnder<T extends object>(
  result: T,
  bestScoreUnder: (cacheFloor: number, continuityFloor: number) => number,
  bestUnder: (cacheFloor: number, continuityFloor: number) => ExactPolicyCandidate,
): T & { readonly bestScoreUnder: typeof bestScoreUnder; readonly bestUnder: typeof bestUnder } {
  Object.defineProperty(result, 'bestScoreUnder', { value: bestScoreUnder, enumerable: false, writable: false, configurable: true });
  Object.defineProperty(result, 'bestUnder', { value: bestUnder, enumerable: false, writable: false, configurable: true });
  return result as T & { readonly bestScoreUnder: typeof bestScoreUnder; readonly bestUnder: typeof bestUnder };
}

export function policyScore(fidelity: number, budget: number, cache: number, continuity: number,
  cacheFloor: number, continuityFloor: number, policy: KvUnifiedWelfarePolicy, multiplier: number): number {
  return fidelity + budget + quadratic(Math.max(0, cache - cacheFloor), policy.cacheScale, policy.cacheLambda) +
    multiplier * quadratic(Math.max(0, continuity - continuityFloor), policy.continuityScale, policy.continuityLambda);
}

export function frontierSignature(
  frontier: ReadonlyMap<ChunkId, number>,
  leafIds: readonly ChunkId[],
): string {
  return leafIds.map((leafId) => `${leafId}:${frontier.get(leafId) ?? 0}`).join('|');
}
