import type { ChunkId } from './folding-strategy.js';
import type { ExactCutEnumerationStats } from './kv-unified.js';
import {
  comparePolicyCandidates, normalizeContinuityMultiplier, normalizePolicy, policyScore,
  type ExactPolicyCandidate, type ExactPolicySolveOptions, type ExactPolicySolveResult, type UnscoredCandidate,
} from './kv-unified-policy.js';

export interface MetricInterval { readonly lower: number; readonly upper: number }
export interface BoundedPolicyCandidate {
  readonly renderedTokens: number;
  readonly budgetPenalty: number;
  readonly fidelity: MetricInterval;
  readonly continuity: MetricInterval;
  /** Exact chronological cache calculation, not a propagation estimate. */
  readonly cacheChurn: number;
  readonly matchesPresentation: boolean;
  exact(): UnscoredCandidate;
}

const bitsBuffer = new ArrayBuffer(8);
const floating = new Float64Array(bitsBuffer);
const bits = new BigUint64Array(bitsBuffer);
function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  floating[0] = value;
  bits[0] += value > 0 ? 1n : -1n;
  return floating[0];
}
function nextDown(value: number): number { return -nextUp(-value); }

/** Both sums use the same nonnegative binary64 leaf terms. The grouped sum
 * performs at most 2n additions and the oracle at most n. 16*epsilon*(n+1)
 * exceeds their combined gamma bounds (including the scale conversion) when
 * it is below 1/4. Outward rounding and a subnormal allowance widen it further.
 * A zero sum of nonnegative floating terms is exactly zero. */
export function nonnegativeSumInterval(value: number, leaves: number): MetricInterval {
  const factor = 16 * Number.EPSILON * (leaves + 1);
  if (!Number.isFinite(value) || value < 0 || factor >= 0.25) return { lower: 0, upper: Infinity };
  if (value === 0) return { lower: 0, upper: 0 };
  const error = nextUp(value * factor + (leaves + 1) * Number.MIN_VALUE);
  return { lower: Math.max(0, nextDown(value - error)), upper: nextUp(value + error) };
}

/** Preserve exact floors, exact winner/hysteresis/ties, and the full public
 * candidate list. Only metrics needed for the decision are evaluated now;
 * inspecting candidates later performs the remaining exact work lazily. */
export function scoreBoundedCandidates(source: readonly BoundedPolicyCandidate[], options: ExactPolicySolveOptions,
  stats: ExactCutEnumerationStats, cacheRelevant: boolean, leafIds: readonly ChunkId[]): Extract<ExactPolicySolveResult, { feasible: true }> {
  if (source.length === 0) throw new Error('kv-unified has no feasible terminal candidates');
  const policy = normalizePolicy(options.policy);
  const multiplier = normalizeContinuityMultiplier(options.continuityMultiplier);
  const epsilon = options.presentation && Number.isFinite(options.adoptEpsilon) && (options.adoptEpsilon ?? 0) > 0
    ? options.adoptEpsilon! : 0;
  const exact: Array<UnscoredCandidate | undefined> = new Array(source.length);
  const refine = (index: number) => exact[index] ??= source[index].exact();
  let fullyEvaluate = source.some((candidate) =>
    !Number.isFinite(candidate.fidelity.upper) || !Number.isFinite(candidate.continuity.upper) ||
    !Number.isFinite(candidate.cacheChurn) || !Number.isFinite(candidate.budgetPenalty));

  // Cache churn is exact for every candidate. Continuity gets its own floor
  // search, independent of whether a candidate could ever win on welfare.
  let cacheFloor = Infinity;
  let continuityFloor = Infinity;
  if (!fullyEvaluate) {
    let witness = 0;
    for (let i = 0; i < source.length; i++) {
      cacheFloor = Math.min(cacheFloor, source[i].cacheChurn);
      if (source[i].continuity.upper < source[witness].continuity.upper) witness = i;
    }
    continuityFloor = source[witness].continuity.upper === 0 ? 0 : refine(witness).continuityLoss;
    for (let i = 0; i < source.length; i++) {
      if (source[i].continuity.lower < continuityFloor) continuityFloor = Math.min(continuityFloor, refine(i).continuityLoss);
    }
  }

  const lower = new Float64Array(source.length);
  let upperBest = Infinity, upperMatching = Infinity;
  if (!fullyEvaluate) for (let i = 0; i < source.length; i++) {
    const c = source[i];
    lower[i] = policyScore(c.fidelity.lower, c.budgetPenalty, c.cacheChurn, c.continuity.lower,
      cacheFloor, continuityFloor, policy, multiplier);
    const upper = policyScore(c.fidelity.upper, c.budgetPenalty, c.cacheChurn, c.continuity.upper,
      cacheFloor, continuityFloor, policy, multiplier);
    if (!Number.isFinite(lower[i]) || !Number.isFinite(upper)) { fullyEvaluate = true; break; }
    upperBest = Math.min(upperBest, upper);
    if (epsilon > 0 && c.matchesPresentation) upperMatching = Math.min(upperMatching, upper);
  }
  if (fullyEvaluate) {
    cacheFloor = Infinity; continuityFloor = Infinity;
    for (let i = 0; i < source.length; i++) {
      const c = refine(i);
      cacheFloor = Math.min(cacheFloor, c.cacheChurn);
      continuityFloor = Math.min(continuityFloor, c.continuityLoss);
    }
  }

  const scored: Array<ExactPolicyCandidate | undefined> = new Array(source.length);
  const score = (index: number): ExactPolicyCandidate => {
    if (scored[index]) return scored[index]!;
    const c = refine(index);
    return scored[index] = {
      get frontier() { return c.frontier; }, get layout() { return c.layout; },
      renderedTokens: c.renderedTokens, fidelityLoss: c.fidelityLoss, continuityLoss: c.continuityLoss,
      cacheChurn: c.cacheChurn, budgetPenalty: c.budgetPenalty,
      cacheExcess: Math.max(0, c.cacheChurn - cacheFloor), continuityExcess: Math.max(0, c.continuityLoss - continuityFloor),
      score: policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss, cacheFloor, continuityFloor, policy, multiplier),
    };
  };
  let best: ExactPolicyCandidate | undefined;
  let carried: ExactPolicyCandidate | undefined;
  let candidates: ExactPolicyCandidate[] | undefined;
  if (fullyEvaluate) {
    const matching = new Set(source.flatMap((candidate, index) => candidate.matchesPresentation ? [score(index)] : []));
    candidates = source.map((_candidate, index) => score(index)).sort((a, b) => comparePolicyCandidates(a, b, leafIds));
    best = candidates[0];
    if (epsilon > 0) carried = candidates.find((candidate) => matching.has(candidate));
  }
  for (let i = 0; !fullyEvaluate && i < source.length; i++) {
    const matching = epsilon > 0 && source[i].matchesPresentation;
    if (!fullyEvaluate && lower[i] > upperBest && (!matching || lower[i] > upperMatching)) continue;
    const c = score(i);
    if (!best || comparePolicyCandidates(c, best, leafIds) < 0) best = c;
    if (matching && (!carried || comparePolicyCandidates(c, carried, leafIds) < 0)) carried = c;
  }
  if (!best) throw new Error('kv-unified score intervals failed to retain a winner');
  const selected = carried && carried.score <= best.score + epsilon ? carried : best;
  return {
    feasible: true, selected, cacheFloor, continuityFloor, cacheRelevant, enumeration: stats,
    get candidates() {
      return candidates ??= source.map((_candidate, index) => score(index))
        .sort((a, b) => comparePolicyCandidates(a, b, leafIds));
    },
  };
}
