/**
 * KV-stable context controller — the rev 5.0 single-path solve
 * (see `docs/adaptive-resolution-design.md` §13; supersedes the two-path
 * fold-within-reach + emergency design of §12, and the older prose in
 * `docs/kv-stable-context-control.md` where they conflict).
 *
 * One algorithm per turn, one hard constraint:
 *
 *   minimize    relevance_loss(F) + perturbation(F, F_prev)   [lexicographic]
 *   subject to  render(F) ≤ W            — the only physics
 *               perturbation(F, F_prev) ≤ P   — trust region; overridable
 *
 * - The IDEAL CUT is built from scratch each turn by pure relevance: fold in
 *   salience-then-age priority order, level by level, under the soft shape
 *   prior (`foldDepthCap`), past it if W demands, never past the hard
 *   protections (flat zone / pins / locked); then pack youngest-first back
 *   toward the target. Age/salience-monotone by construction.
 * - PERTURBATION is exact, not modeled: `kvCost` — the tokens the provider
 *   will re-read from the earliest layout divergence to the end.
 * - P (`reachTokens`, re-priced) is a TRUST REGION on per-turn divergence,
 *   not a spatial eligibility gate. Within it the solver adopts the ideal;
 *   beyond it it adopts the ideal's newest changes only (suffix adoption —
 *   perturbation is prefix-based, so partial adoption is exactly a suffix
 *   cut) and converges over turns, receding-horizon style.
 * - OVERRIDES (same code path, recorded on the plan, logged by the caller):
 *   'bootstrap' (no carried frontier — nothing to preserve), 'infeasible'
 *   (nothing within P fits under W), 'quality-gap' (the best plan within P
 *   is certifiably bad vs the ideal). There is no emergency path.
 *
 * Pure and deterministic.
 */

import type { ChunkId, SummaryId } from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';
import type { SummaryEntry } from '../types/strategy.js';
import { SummaryTree } from './summary-tree.js';
import { renderLayout, kvCost, type RenderLayout, type Frontier } from './render-offsets.js';
import { placeMarkers, CacheStore } from './kv-cache-sim.js';

/** Provider price multipliers relative to base input tokens (Anthropic-ish). */
export const PRICE = { miss: 1.0, cacheRead: 0.1, cacheWrite: 1.25 } as const;

/** Safety ceiling on saliency fold depth. The *effective* cap is
 *  `maxAvailableLevel(tree)` (fold only as deep as summaries actually exist),
 *  which every caller passes in; this constant is just a high sane upper bound so
 *  L4/L5/… are allowed as the merge pipeline builds them — never a pin at L3. */
export const MAX_FOLD_LEVEL = 8;

export interface ControlOptions {
  /** Physical context window — the ONLY hard wall. */
  windowTokens: number;
  /** Operating budget B (< W). High-watermark HW defaults to this. */
  budgetTokens: number;
  /** Shed down to this low-watermark when HW is breached. (HW − LW) sets fold
   *  frequency/amplitude. Default 0.8·budget. */
  lowWatermark?: number;
  /** High-watermark; fold is triggered above it. Default = budgetTokens. */
  highWatermark?: number;
  /** Per-turn divergence reach: how far back (tokens from the live end) a fold
   *  may normally edit — the structural perturbation cap P, and the primary
   *  cost↔continuity knob. Smaller = gentler per-turn KV perturbation (shallow
   *  divergence) but less efficient compression → more/again folding. Exceeded
   *  ONLY to avoid the hard wall W. Default = budgetTokens (effectively
   *  unbounded). */
  reachTokens?: number;
  /** Attended window kept raw + stable (the flat zone). */
  attendedWindowTokens: number;
  /** Base-k summary grouping (matches mergeThreshold). Default 6. */
  mergeThreshold?: number;
  /** Cache breakpoints per turn (1..4). Default 4. */
  markerCount?: number;
  /** Approx replay steps (down-sample). Default 120. */
  targetSteps?: number;
  /** Cache TTL in steps. Default Infinity. */
  cacheTtlSteps?: number;
}

export interface ControlStep {
  now: number;
  numChunks: number;
  renderedTokens: number;
  cachedTokens: number;
  recomputedTokens: number;
  /** Billed recompute at provider multipliers. */
  billed: number;
  /** Prefix churn = recompute beyond genuinely new content (the KV perturbation
   *  of the attended region). 0 on a pure-append turn. */
  perturbation: number;
  /** True when the controller folded this turn (a perturbation event). */
  folded: boolean;
  /** True when even full folding could not fit under W (terminal). */
  escalated: boolean;
  deepestLevel: number;
}

export interface ControlResult {
  steps: ControlStep[];
  totalRecomputed: number;
  totalBilled: number;
  overallHitRate: number;
  /** Worst single-turn perturbation (the continuity ceiling). */
  maxPerturbation: number;
  /** RMS per-turn perturbation (variance-continuity). */
  rmsPerturbation: number;
  /** Count of turns that perturbed the prefix. */
  foldEvents: number;
  /** Count of terminal (over-W) turns. */
  escalations: number;
}

/**
 * Per-chunk maximum fold depth from the saliency field: flat zone and pins are
 * raw (0); otherwise log-age banded against the base-k geometry. The "finest
 * requirement wins" — this is the cap the shedder may not exceed.
 */
export function foldDepthCap(
  chunk: PickerChunk,
  now: number,
  flatZone: ReadonlySet<ChunkId>,
  flatZoneChunks: number,
  mergeThreshold: number,
  maxLevel: number = MAX_FOLD_LEVEL,
): number {
  if (chunk.pinned || flatZone.has(chunk.id)) return 0;
  const age = Math.max(0, now - chunk.sequence);
  const ratio = age / Math.max(1, flatZoneChunks);
  if (ratio < 1) return 0; // just outside the flat zone → still raw
  const band = Math.floor(Math.log(ratio) / Math.log(Math.max(2, mergeThreshold))) + 1;
  return Math.max(0, Math.min(maxLevel, band));
}

/** Deepest summary level that actually exists in the tree (0 if none). The
 *  fold depth is bounded by this — NOT a hardcoded constant — so the controller
 *  uses L4/L5… summaries when production has built them (else it floors at L3 and
 *  refuses deeper summaries that exist; cf. the lab L3-floor-with-L4-present). */
function maxAvailableLevel(tree: SummaryTree): number {
  let m = 0;
  for (const s of tree.allSummaries()) if (s.level > m) m = s.level;
  return m;
}

/** Per-chunk salience: the coefficient on information loss (design §13.3).
 *  Defaults to 1. Lower = folds earlier and costs less when folded (code-heavy /
 *  tool-output / externalized content). Never overrides hard protections. */
function salienceOf(c: PickerChunk): number {
  const s = c.salience;
  if (s === undefined || !Number.isFinite(s)) return 1;
  return Math.min(1, Math.max(0, s));
}

/**
 * Salience-weighted MISALLOCATION loss of a frontier: Σ salience(c) ·
 * max(0, level(c) − shapeCap(c)) over foldable chunks — the excess fold depth
 * beyond what the relevance shape prior (log-age band) would assign. Zero for
 * any cut that folds nothing deeper than its prior; positive exactly where
 * fidelity is spent in the wrong place. Recency-aware by construction (the
 * cap grows with age), so an INVERTED profile — recent content deep, ancient
 * content fine — scores high even when a naive Σ level would tie it with the
 * correct gradient. Used only to compare cuts of the same tree (quality-gap
 * tests, §13.4).
 */
function relevanceLoss(
  F: ReadonlyMap<ChunkId, number>,
  ordered: PickerChunk[],
  rawZone: ReadonlySet<ChunkId>,
  caps: ReadonlyMap<ChunkId, number>,
): number {
  let loss = 0;
  for (const c of ordered) {
    if (rawZone.has(c.id)) continue;
    const lvl = F.get(c.id) ?? 0;
    if (lvl <= 0) continue;
    const cap = Math.max(0, caps.get(c.id) ?? 0);
    if (lvl > cap) loss += salienceOf(c) * (lvl - cap);
  }
  return loss;
}

/**
 * Incremental token accounting for whole-group fold/unfold moves.
 *
 * `renderLayout` is O(n); calling it per accepted fold makes the ideal-cut
 * construction O(n·folds) ≈ O(n²) — seconds on a 4k-chunk store, paid on
 * EVERY compile under the single-path solve. The ledger tracks rendered units
 * (raw shards / recall pairs) as a multiset keyed exactly like renderLayout's
 * units, so a group fold/unfold is O(group) and `tokens` stays equal to
 * `renderLayout(...).totalTokens` for the same frontier (both share the
 * "missing ancestor → raw" fallback; siblings share one recall unit).
 */
class TokenLedger {
  private readonly unitTokens = new Map<string, number>(); // unitKey → tokens
  private readonly unitRefs = new Map<string, number>(); // unitKey → leaf count
  tokens = 0;

  constructor(
    private readonly tree: SummaryTree,
    private readonly inputs: PickerInputs,
    ordered: PickerChunk[],
    F: ReadonlyMap<ChunkId, number>,
  ) {
    this.tokens = inputs.headTokens + inputs.tailTokens;
    for (const c of ordered) {
      if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id)) continue;
      const { key, tokens } = this.unitFor(c, F.get(c.id) ?? 0);
      this.addRef(key, tokens);
    }
  }

  /** Unit identity + cost for a leaf at a level — mirrors renderLayout. */
  private unitFor(c: PickerChunk, level: number): { key: string; tokens: number } {
    const effective = c.pinned ? 0 : level;
    if (effective > 0) {
      const ancestor = this.tree.ancestorAt(c.id, effective);
      if (ancestor) return { key: `recall:${ancestor.id}`, tokens: ancestor.recallTokens };
    }
    return { key: `raw:${c.id}`, tokens: c.rawTokens };
  }

  private addRef(key: string, tokens: number): void {
    const refs = this.unitRefs.get(key) ?? 0;
    if (refs === 0) {
      this.unitTokens.set(key, tokens);
      this.tokens += tokens;
    }
    this.unitRefs.set(key, refs + 1);
  }

  private dropRef(key: string): void {
    const refs = this.unitRefs.get(key) ?? 0;
    if (refs <= 1) {
      this.unitRefs.delete(key);
      this.tokens -= this.unitTokens.get(key) ?? 0;
      this.unitTokens.delete(key);
    } else {
      this.unitRefs.set(key, refs - 1);
    }
  }

  /** Move one leaf from `fromLevel` to `toLevel`. Callers move whole groups
   *  (every leaf of the target node), which keeps units exact. */
  move(c: PickerChunk, byId: ReadonlyMap<ChunkId, PickerChunk>, fromLevel: number, toLevel: number): void {
    if (this.inputs.headChunkIds.has(c.id) || this.inputs.tailChunkIds.has(c.id)) return;
    void byId;
    this.dropRef(this.unitFor(c, fromLevel).key);
    const next = this.unitFor(c, toLevel);
    this.addRef(next.key, next.tokens);
  }
}

/**
 * Build the IDEAL CUT from scratch — pure relevance, no P anywhere (§13.4).
 *
 * Fold order is (salience ascending, then oldest-first), level by level, so the
 * profile is salience/age-monotone by construction: with uniform salience it
 * reduces to the classic oldest-first shed. Two phases against the shape prior:
 *   A. fold under the soft `caps` (log-age shape + pin caps) until ≤ target;
 *   B. if still over W, keep folding past the shape caps (never past the
 *      hard-protected −1 sentinel or a pin cap) — the prior is a relevance
 *      shaper, never a feasibility wall;
 *   C. pack: un-fold youngest-first back toward `target` (accept-if-fit), so
 *      headroom is spent on the most recent foldable content.
 * Ends projected to a valid group-consistent tree cut.
 */
function relevanceCut(
  inputs: PickerInputs,
  tree: SummaryTree,
  ordered: PickerChunk[],
  base: ReadonlyMap<ChunkId, number>,
  caps: ReadonlyMap<ChunkId, number>,
  pinCaps: ReadonlyMap<ChunkId, number>,
  rawZone: ReadonlySet<ChunkId>,
  immovable: ReadonlySet<ChunkId>,
  frozen: ReadonlySet<ChunkId>,
  fixedLevels: ReadonlyMap<ChunkId, number>,
  target: number,
  windowTokens: number,
  maxFoldLevel: number,
): { F: Map<ChunkId, number>; tokens: number } {
  const F = new Map(base);
  const byId = new Map(ordered.map((c) => [c.id, c] as const));
  // OVERLAP TOLERANCE (2026-08-03, opus4). After store surgery a summary
  // "tree" can be non-nested: a group's leafChunkIds may include leaves whose
  // OWN l1Id lineage tops out below the group's level or climbs through a
  // different family. Folding such a leaf to the group's level plants an
  // unrenderable mark; the final validity projection then monotone-LOWERS the
  // whole group around it — one disagreeing leaf un-folded a 200-leaf group,
  // 615 leaves cascaded (+24k tokens) and the solve returned an over-W
  // frontier while a produced L4/L5 layer sat unused. Leaves whose lineage
  // disagrees are skipped by folds and exempted from unanimity: they render
  // raw beside the recall — exactly the renderer's existing ownership-wins
  // semantics for boundary-cut members.
  const overlapExempt = new Set<ChunkId>();
  // Fold priority: cheapest information first — ascending salience, then oldest.
  const priority = [...ordered].sort((a, b) => {
    const sa = salienceOf(a);
    const sb = salienceOf(b);
    if (sa !== sb) return sa - sb;
    return a.sequence - b.sequence;
  });

  // Incremental accounting: O(group) per move instead of O(n) renderLayout.
  const _tl = typeof process !== 'undefined' && process.env?.KV_TIMING ? Date.now() : 0;
  let ledger = new TokenLedger(tree, inputs, ordered, F);
  if (_tl) console.error(`[kv-timing] ledger-init ${Date.now() - _tl}ms tokens=${ledger.tokens}`);

  // Eligibility memo, keyed (node, level, phase). The verdict is a pure
  // function of static inputs (caps / pinCaps) shared by every member chunk
  // of the group, but the naive loop re-derived it per MEMBER — a group the
  // head/tail boundary cuts through is permanently ineligible, and its
  // ~1.7k members each re-scanned its ~1.7k leaves at every level:
  // O(N·groupSize·levels) ≈ tens of millions of leaf checks per compile
  // (mythos 2026-07-26: relevanceCut 0.5s → 16s the moment a 150k tail
  // landed inside the L4 groups). One scan per group instead.
  const eligibilityMemo = new Map<string, boolean>();
  const groupEligible = (nodeId: SummaryId, leafIds: readonly ChunkId[], level: number, ignoreShapeCaps: boolean): boolean => {
    const key = `${nodeId}:${level}:${ignoreShapeCaps ? 'B' : 'A'}`;
    const hit = eligibilityMemo.get(key);
    if (hit !== undefined) return hit;
    let eligible = true;
    let foldable = 0;
    for (const leafId of leafIds) {
      const cap = caps.get(leafId) ?? 0;
      // Boundary-cut tolerance (2026-07-27): a hard-protected leaf (−1
      // sentinel — raw zone / pins / locked) is EXCLUDED from the fold rather
      // than vetoing it. The renderer's ownership machinery already renders
      // protected messages raw alongside their chunk's recall ("ownership
      // wins"), so a boundary cutting through a group must not make the whole
      // group permanently unfoldable. Observed: calibration drift moved the
      // token-derived head boundary 2 messages into an L3's first chunk — the
      // 2-leaf overlap vetoed the entire 742-leaf group in every phase, and
      // the agent was OverBudget-wedged with its own L3 sitting unused.
      if (cap < 0) continue;
      foldable++;
      const pinCap = pinCaps.get(leafId);
      if (pinCap !== undefined && level > pinCap) { eligible = false; break; }
      if (!ignoreShapeCaps && cap < level) { eligible = false; break; }
    }
    if (foldable === 0) eligible = false;
    eligibilityMemo.set(key, eligible);
    return eligible;
  };

  const foldPass = (ignoreShapeCaps: boolean, stopAt: number): boolean => {
    for (let level = 1; level <= maxFoldLevel; level++) {
      for (const c of priority) {
        if (ledger.tokens <= stopAt) return true;
        if ((caps.get(c.id) ?? 0) < 0) continue; // protected leaves never drive a fold
        if ((F.get(c.id) ?? 0) >= level) continue;
        const ancestor = tree.ancestorAt(c.id, level);
        if (!ancestor) continue; // summary not produced yet → can't fold here
        // Group-atomicity: fold the WHOLE group to `level` only if every
        // covered leaf permits it. Hard protections (−1 sentinel: flat zone /
        // pins / locked) always block; pin-max-level always blocks past its
        // bound; the soft shape cap blocks only in phase A.
        if (!groupEligible(ancestor.id, ancestor.leafChunkIds, level, ignoreShapeCaps)) continue;
        for (const leafId of ancestor.leafChunkIds) {
          if ((caps.get(leafId) ?? 0) < 0) continue; // protected: stays raw beside the recall
          // Overlap tolerance: only mark leaves whose own lineage renders as
          // part of THIS node at this level. Disagreeing leaves keep their
          // level and become unanimity-exempt (see declaration above).
          const own = tree.ancestorAt(leafId, level);
          if (!own || own.id !== ancestor.id) {
            overlapExempt.add(leafId);
            continue;
          }
          const leaf = byId.get(leafId);
          const from = F.get(leafId) ?? 0;
          if (from < level) {
            if (leaf) ledger.move(leaf, byId, from, level);
            F.set(leafId, level);
          }
        }
        if (ledger.tokens <= stopAt) return true;
      }
    }
    return false;
  };

  // FOLD → PROJECT FIXPOINT (2026-08-03). The validity projection at the end
  // can only LOWER levels; on a non-nested tree its repairs add tokens after
  // the phases stopped at target, and a single projection pass used to be
  // final — the solve returned an over-W frontier with deeper summaries
  // still unused ("W — the only physics" violated; opus4: ledger 150k,
  // post-projection render 174k > W 166k, L4/L5 never touched). Iterate:
  // re-fold on the projected frontier (the ledger is rebuilt to match) until
  // the render fits under W, a round makes no progress, or the round cap.
  let projTokens = Number.POSITIVE_INFINITY;
  for (let round = 0; ; round++) {

  // Phase A: fold under the shape prior toward the target.
  if (ledger.tokens > target) foldPass(false, target);
  // Phase B: the prior yields to W (only hard protections stand).
  if (ledger.tokens > windowTokens) foldPass(true, target);

  // Phase C: pack youngest-first back toward the target (skip if infeasible).
  if (ledger.tokens <= windowTokens && ledger.tokens < target) {
    // A group's un-fold verdict (eligibility + accept/revert) can only change
    // after the ledger moves — i.e. after some OTHER group's un-fold is
    // accepted. The naive loop re-attempted a just-reverted group for EVERY
    // remaining member chunk at that level: for a ~1.7k-leaf group the tail
    // boundary cuts through, that is ~1.7k attempts × 2×1.7k ledger moves
    // (try + revert) — the dominant term of the mythos 30s/turn leak.
    // `attempted` short-circuits repeats and is cleared whenever an accept
    // changes the ledger, so the accept SEQUENCE is exactly the naive one.
    const attempted = new Set<string>();
    for (let level = maxFoldLevel; level >= 1 && ledger.tokens < target; level--) {
      for (let oi = ordered.length - 1; oi >= 0; oi--) {
        if (ledger.tokens >= target) break;
        const c = ordered[oi]; // youngest-first
        if ((F.get(c.id) ?? 0) !== level) continue;
        if (rawZone.has(c.id) || immovable.has(c.id) || overlapExempt.has(c.id)) continue;
        const node = tree.ancestorAt(c.id, level);
        if (!node) continue;
        const attemptKey = `${node.id}:${level}`;
        if (attempted.has(attemptKey)) continue;
        let eligible = true;
        for (const leafId of node.leafChunkIds) {
          // Protected members sit at raw beside the recall (boundary-cut
          // tolerance) — they neither veto nor participate in the un-fold.
          // Overlap-exempt members likewise (their lineage disagrees).
          if (rawZone.has(leafId) || immovable.has(leafId) || overlapExempt.has(leafId)) continue;
          if ((F.get(leafId) ?? 0) !== level) {
            eligible = false;
            break;
          }
        }
        if (!eligible) { attempted.add(attemptKey); continue; }
        const before = ledger.tokens;
        // Record exact prior levels for an honest revert: with boundary-cut
        // tolerance a group may hold members below `level` (protected raw,
        // frozen mid-levels) — hardcoded from/to drifts the ledger away from
        // renderLayout, and every later accept decision is made on corrupt
        // arithmetic (observed: phase C walked an L3 fold all the way back to
        // carried while its ledger believed it sat on target).
        const moved: Array<[ChunkId, number]> = [];
        for (const leafId of node.leafChunkIds) {
          if (rawZone.has(leafId) || immovable.has(leafId) || overlapExempt.has(leafId)) continue; // protected: not part of the fold
          const from = F.get(leafId) ?? 0;
          if (from <= level - 1) continue; // already at/below the destination
          const leaf = byId.get(leafId);
          if (leaf) ledger.move(leaf, byId, from, level - 1);
          F.set(leafId, level - 1);
          moved.push([leafId, from]);
        }
        // Accept an un-fold that lands PAST the target when it still gets
        // CLOSER to it (and stays under W). Merge groups are coarse quanta
        // (8-15k on production trees); accept-only-if-under-target strands
        // real headroom un-spent whenever every remaining quantum overshoots
        // (mythos 2026-07-12: 134k rendered of a 183.6k hard budget). The
        // target stays the attractor — W stays the only wall (§13.2).
        const nt = ledger.tokens;
        const accept = nt <= windowTokens && Math.abs(nt - target) < Math.abs(before - target);
        if (!accept) {
          // moves away from the target (or breaches W) → revert
          for (const [leafId, from] of moved) {
            const leaf = byId.get(leafId);
            if (leaf) ledger.move(leaf, byId, level - 1, from);
            F.set(leafId, from);
          }
          attempted.add(attemptKey);
        } else {
          // The ledger moved: previously reverted/ineligible groups may now
          // verdict differently — exactly when the naive loop would have
          // re-attempted them.
          attempted.clear();
        }
      }
    }
  }

  const _tp = typeof process !== 'undefined' && process.env?.KV_TIMING ? Date.now() : 0;
  // Hard-protected leaves (−1 caps) are exempt from group unanimity here too —
  // without this, the final projection undoes every boundary-cut fold the
  // phases just made (monotone-lowering the whole group back toward carried).
  const projectionExempt = new Set<ChunkId>();
  for (const [id, cap] of caps) if (cap < 0) projectionExempt.add(id);
  // Overlap-exempt leaves render beside their group's recall (ownership-wins)
  // and must not veto unanimity — same exemption as the boundary-cut set.
  for (const id of overlapExempt) projectionExempt.add(id);
  projectToValidCut(F, tree, ordered, frozen, fixedLevels, projectionExempt);
  if (_tp) console.error(`[kv-timing] cut-projection ${Date.now() - _tp}ms`);
  // One authoritative render at the end (the ledger tracks it exactly, but the
  // projection may have moved leaves — recompute once, not per move).
  const tokens = renderLayout(inputs, tree, F).totalTokens;
  // Fits, or a full round made no progress, or round cap → done. Otherwise
  // re-fold on the projected frontier with a resynced ledger.
  if (tokens <= windowTokens || tokens >= projTokens || round >= 2) {
    // NEVER QUIET (2026-08-03): overlap tolerance is a degraded mode, not a
    // feature — every exempted leaf means the store's summary tree is
    // NON-NESTED (two live lineages over one span), and its messages are
    // now SEMANTICALLY DOUBLE-REPRESENTED in the window (rendered raw or
    // via their own chain WHILE a covering recall also renders). The solve
    // proceeding is the mitigation; the topology is the disease. Surface it
    // on every affected compile until the store is repaired (nesting
    // reconciler — see the 2026-08-03 opus4 incident).
    if (overlapExempt.size > 0) {
      console.error(
        `[kv-overlap] ⚠️ non-nested summary tree: ${overlapExempt.size} leaf(s) with ` +
          `conflicting lineage tolerated this compile (double-representation in window). ` +
          `Store needs nesting repair. sample=${[...overlapExempt].slice(0, 5).join(',')}`,
      );
    }
    return { F, tokens };
  }
  projTokens = tokens;
  ledger = new TokenLedger(tree, inputs, ordered, F);

  } // fold → project fixpoint loop
}

/**
 * Partial adoption of the ideal under the trust region (§13.4): keep `prev`
 * before a boundary sequence, take `ideal` at and after it. Perturbation is
 * prefix-based, so the cheapest partial plans are exactly the suffix cuts;
 * binary-search the oldest boundary whose perturbation stays ≤ P (perturbation
 * is monotone non-increasing as the boundary moves newer). Each candidate is
 * projected to a valid cut before costing (mixing two cuts can bisect a group).
 */
function suffixAdopt(
  inputs: PickerInputs,
  tree: SummaryTree,
  ordered: PickerChunk[],
  prev: ReadonlyMap<ChunkId, number>,
  prevLayout: RenderLayout,
  ideal: ReadonlyMap<ChunkId, number>,
  frozen: ReadonlySet<ChunkId>,
  fixedLevels: ReadonlyMap<ChunkId, number>,
  P: number,
  exempt: ReadonlySet<ChunkId> = new Set(),
): { F: Map<ChunkId, number>; tokens: number; perturbation: number } {
  const changedSeqs: number[] = [];
  for (const c of ordered) {
    if ((prev.get(c.id) ?? 0) !== (ideal.get(c.id) ?? 0)) changedSeqs.push(c.sequence);
  }

  const build = (boundary: number): { F: Map<ChunkId, number>; layout: RenderLayout; pert: number } => {
    const F = new Map(prev);
    for (const c of ordered) {
      if (c.sequence >= boundary) F.set(c.id, ideal.get(c.id) ?? 0);
    }
    projectToValidCut(F, tree, ordered, frozen, fixedLevels, exempt);
    const layout = renderLayout(inputs, tree, F);
    return { F, layout, pert: kvCost(prevLayout, layout) };
  };

  if (changedSeqs.length === 0) {
    const layout = renderLayout(inputs, tree, new Map(prev));
    return { F: new Map(prev), tokens: layout.totalTokens, perturbation: 0 };
  }

  // Binary search: smallest index (oldest boundary) with perturbation ≤ P.
  let lo = 0;
  let hi = changedSeqs.length; // hi = adopt nothing (pert 0, always feasible)
  let best = build(Number.MAX_SAFE_INTEGER);
  let bestIdx = hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cand = build(changedSeqs[mid]);
    if (cand.pert <= P) {
      best = cand;
      bestIdx = mid;
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  void bestIdx;
  return { F: best.F, tokens: best.layout.totalTokens, perturbation: best.pert };
}

/**
 * Project a per-chunk frontier onto the nearest VALID TREE CUT (group-consistent).
 *
 * A leaf folded to level k renders as part of its L_k ancestor node, and that
 * node is atomic over its whole covered range — so EVERY leaf under it must share
 * level k, or the node is unrenderable. The picker walks group-atomic raise/lower
 * ops, so a frontier that folds only SOME leaves under a node is an unreachable
 * target: it raises the group (over-folding a sibling), lowers it (under-folding
 * another), forever — non-convergence (the wedge this fixes).
 *
 * Frontiers seeded per-chunk from the carried `previous` frontier can violate
 * this: as a summary group accretes new raw leaves over turns while older leaves
 * stay folded, its leaves end up at mixed levels. shed/expand only re-consolidate
 * groups they actively move; a mixed group sitting in the budget dead-band passes
 * through untouched. This pass repairs it.
 *
 * Shallowest-first: where a group disagrees, UN-fold the folded leaves one level
 * toward raw (preserving continuity), cascading until every folded leaf's group
 * is unanimous. Monotone (only lowers) → terminates. Any budget breach from the
 * extra raw is re-folded whole-group by the shed pass that runs afterward.
 *
 * Pinned (`fixedLevels`) and frozen (locked) leaves are already made
 * group-consistent by the caller (pin-at-level fixes a whole node's leaves), so
 * they are held here rather than lowered.
 */
function projectToValidCut(
  F: Map<ChunkId, number>,
  tree: SummaryTree,
  ordered: PickerChunk[],
  frozen: ReadonlySet<ChunkId>,
  fixedLevels: ReadonlyMap<ChunkId, number>,
  /** Hard-protected leaves (raw zone / pins / locked): rendered raw beside
   *  their group's recall (ownership-wins), so they are exempt from the
   *  unanimity requirement — a boundary cutting through a group must not
   *  force the whole group back to raw (boundary-cut tolerance, 2026-07-27). */
  exempt: ReadonlySet<ChunkId> = new Set(),
): void {
  const maxPasses = (ordered.length + 1) * (maxAvailableLevel(tree) + 2);
  let changed = true;
  let pass = 0;
  while (changed && pass++ < maxPasses) {
    changed = false;
    // DEEPEST-first within each pass: lower the deeper disagreeing leaves
    // toward their shallower group-mates before judging the shallow ones.
    // Shallowest-first overshot: a leaf un-folded to its pin cap (L1) among
    // still-deeper siblings (L2) was pushed past the cap to raw in pass 1,
    // before the siblings descended to meet it — the group then converged at
    // raw instead of at the cap. Still monotone (only lowers) → terminates.
    const byDepth = [...ordered].sort(
      (a, b) => (F.get(b.id) ?? 0) - (F.get(a.id) ?? 0),
    );
    // Unanimity memo per (node, level), reset each pass. Within a pass the
    // verdict is stable: lowering a member leaf only makes the group MORE
    // non-unanimous at that level, and a unanimous group lowers nobody. The
    // naive per-leaf rescan was O(groupSize²) per disagreeing group per pass
    // (each of an L4 group's ~1.7k members re-scanning ~1.7k leaves).
    const unanimityMemo = new Map<string, boolean>();
    for (const c of byDepth) {
      const lvl = F.get(c.id) ?? 0;
      if (lvl <= 0) continue;
      if (frozen.has(c.id) || fixedLevels.has(c.id)) continue; // held; consistent by construction
      const node = tree.ancestorAt(c.id, lvl);
      let unanimous = false;
      if (node) {
        const key = `${node.id}:${lvl}`;
        const hit = unanimityMemo.get(key);
        if (hit !== undefined) {
          unanimous = hit;
        } else {
          unanimous = true;
          for (const leafId of node.leafChunkIds) {
            if (exempt.has(leafId)) continue;
            if ((F.get(leafId) ?? 0) !== lvl) { unanimous = false; break; }
          }
          unanimityMemo.set(key, unanimous);
        }
      }
      if (!unanimous) { F.set(c.id, lvl - 1); changed = true; } // un-fold one level
    }
  }
}

/** Earliest source sequence whose resolution changed `prev → next`. */
function earliestChangedSequence(
  prev: Frontier,
  next: ReadonlyMap<ChunkId, number>,
  ordered: PickerChunk[],
): number {
  for (const c of ordered) {
    if ((prev.get(c.id) ?? 0) !== (next.get(c.id) ?? 0)) return c.sequence;
  }
  return Number.MAX_SAFE_INTEGER;
}

function unitsBeforeSequence(layout: RenderLayout, tree: SummaryTree, boundary: number): number {
  let count = 0;
  for (const u of layout.units) {
    const seq =
      u.kind === 'raw' ? tree.leaf(u.key)?.sequence ?? 0
      : u.kind === 'recall' ? tree.summary(u.key)?.firstSequence ?? 0
      : u.kind === 'head' ? -1
      : Number.MAX_SAFE_INTEGER;
    if (seq < boundary) count++;
    else break;
  }
  return count;
}

function rawTailSet(ordered: PickerChunk[], tailTokens: number): Set<ChunkId> {
  const s = new Set<ChunkId>();
  if (tailTokens <= 0) return s;
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    s.add(ordered[i].id);
    used += ordered[i].rawTokens;
    if (used >= tailTokens) break;
  }
  return s;
}

const EMPTY_SET: ReadonlySet<ChunkId> = new Set();
const EMPTY_LEVEL_MAP: ReadonlyMap<ChunkId, number> = new Map();

/** KV_DIAG_GROUP=<summaryId>: log that group's leaf-level histogram at each
 *  solve stage + the branch taken — for diagnosing cut-through-group targets. */
const DIAG_GROUP = typeof process !== 'undefined' ? process.env?.KV_DIAG_GROUP : undefined;
function diagHist(label: string, F: ReadonlyMap<ChunkId, number>, tree: SummaryTree): void {
  if (!DIAG_GROUP) return;
  const node = tree.summary(DIAG_GROUP);
  if (!node) return;
  const hist = new Map<number, number>();
  for (const id of node.leafChunkIds) {
    const l = F.get(id) ?? 0;
    hist.set(l, (hist.get(l) ?? 0) + 1);
  }
  console.error(`[kv-diag] ${label}: levels ${JSON.stringify([...hist.entries()].sort((a, b) => a[0] - b[0]))}`);
}
function diagBranch(label: string): void {
  if (DIAG_GROUP) console.error(`[kv-diag] branch: ${label}`);
}

export interface ControlPlanParams {
  /** Carried frontier (F_prev). */
  previous: ReadonlyMap<ChunkId, number>;
  /** Fold (deepen) when rendered tokens exceed this (high-watermark). */
  foldAtTokens: number;
  /** Un-fold (raise toward raw) when rendered tokens are below this
   *  (low-watermark). Default = targetTokens. The band (foldAt − expandAt) is a
   *  no-op dead zone that prevents fold↔unfold oscillation. Set below foldAt. */
  expandAtTokens?: number;
  /** The attractor both fold and un-fold aim for (soft target). */
  targetTokens: number;
  /** Hard wall W — the only hard constraint (§13.2). */
  windowTokens: number;
  /** Trust region P on per-turn perturbation, in tokens the provider would
   *  re-read (exact `kvCost`, not a spatial gate). Within P the solver adopts
   *  the ideal cut outright; beyond it it adopts the ideal's newest changes
   *  only (suffix adoption) unless an override fires (§13.4). Default =
   *  windowTokens (a rendered layout never exceeds W, so the default trust
   *  region never binds). */
  reachTokens?: number;
  /** Never override P for quality while preparing a future window. If the
   * smallest realizable change exceeds P, hold and report a pace floor. */
  strictReach?: boolean;
  /** Quality-gap override threshold (§13.4): a plan within P is rejected — and
   *  the ideal adopted, paying the perturbation — when its relevance loss
   *  exceeds the ideal's by more than this fraction of the ideal's loss.
   *  Also bounds how misallocated a dead-band hold may be before the solver
   *  self-heals. Default 0.35. */
  qualityGapRatio?: number;
  /** Chunks forced to raw and never folded (flat zone / head / tail / pinned). */
  rawZone: ReadonlySet<ChunkId>;
  /** Chunks kept at their carried resolution and never touched (locked). */
  frozen?: ReadonlySet<ChunkId>;
  /**
   * V2 pin-at-level-k: chunks fixed to render at EXACTLY the given fold level
   * (0 = raw). Held there and never folded or un-folded — the frontier cut
   * passes through that L_k node. A level deeper than the tree has produced is
   * clamped to the deepest available. (`ProtectedRange.level`.)
   */
  fixedLevels?: ReadonlyMap<ChunkId, number>;
  /**
   * V2 pin-max-level: per-chunk HARD cap on fold depth — the chunk may fold no
   * deeper than this level, enforced in normal AND emergency shedding, and any
   * carried resolution deeper than the cap is un-folded to it at plan start.
   * (`ProtectedRange.maxLevel`.)
   */
  pinCaps?: ReadonlyMap<ChunkId, number>;
  /** Newest source sequence — the age reference for the log-age fold caps. */
  now: number;
  /** Base-k summary grouping. Default 6. */
  mergeThreshold?: number;
}

export interface ControlPlan {
  resolutions: Map<ChunkId, number>;
  tokens: number;
  /** A fold (deepen) happened this turn. */
  folded: boolean;
  /** An un-fold (raise toward raw, to use budget headroom) happened this turn. */
  expanded: boolean;
  /** Even full folding could not fit under W (terminal — production problem). */
  escalated: boolean;
  /** Exact prefix-invalidation cost of this plan vs the carried frontier:
   *  tokens the provider will re-read (0 on a hold/pure-append turn). */
  perturbation: number;
  /** Set when the trust region P did not bind normally (§13.4). Callers should
   *  log these loudly (`[kv-escalation]`):
   *  - 'bootstrap': no carried frontier — pure relevance solve, P not applicable;
   *  - 'infeasible': nothing within P fits under W — feasibility beats P;
   *  - 'quality-gap': the best plan within P was certifiably bad vs the ideal. */
  override?: 'bootstrap' | 'infeasible' | 'quality-gap';
  /** No realizable progress fits inside a strict trust region. */
  blocked?: 'reach-floor' | 'target-floor';
}

/**
 * Plan one turn's frontier — the rev 5.0 single-path solve (§13.4), shared by
 * the replay harness (`replayControlled`) and `KvStableStrategy`.
 *
 *   1. Build the IDEAL CUT from scratch (pure relevance; W the only wall).
 *   2. No carried frontier → adopt it (bootstrap; P not applicable).
 *   3. Carried frontier in the [expandAt, foldAt] dead band with a small
 *      quality gap → hold it (zero perturbation). A LARGE gap falls through:
 *      a stuck misallocated profile self-heals instead of fossilizing.
 *   4. Ideal within the trust region P (exact kvCost) → adopt it.
 *   5. Otherwise adopt the ideal's newest changes only (suffix adoption) if
 *      that fits W and is not certifiably bad; else adopt the ideal and record
 *      the override ('infeasible' / 'quality-gap').
 *
 * There is no emergency path and no spatial eligibility gate: cache continuity
 * is priced (and bounded by P) — never a reason a chunk can't move.
 * Pure and deterministic.
 */
export function planControlledFrontier(
  inputs: PickerInputs,
  tree: SummaryTree,
  p: ControlPlanParams,
): ControlPlan {
  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const frozen = p.frozen ?? EMPTY_SET;
  const fixedLevels = p.fixedLevels ?? EMPTY_LEVEL_MAP;
  const pinCaps = p.pinCaps ?? EMPTY_LEVEL_MAP;
  const mergeThreshold = p.mergeThreshold ?? 6;
  const P = p.reachTokens ?? p.windowTokens;
  const expandAt = p.expandAtTokens ?? p.targetTokens;
  const gapRatio = p.qualityGapRatio ?? 0.35;
  const strictReach = p.strictReach ?? false;
  // Fold as deep as the tree actually goes (L4/L5… when produced), not a constant.
  const maxFoldLevel = maxAvailableLevel(tree);

  // Immovable = never folded OR un-folded by the solve: the locked (frozen)
  // set plus V2 pin-at-level-k chunks (held at their fixed level).
  const immovable = new Set<ChunkId>(frozen);
  for (const id of fixedLevels.keys()) immovable.add(id);

  // Base = the non-negotiable part of every cut: raw zone raw, pins at their
  // level, frozen at their carried resolution. Everything else starts raw here;
  // the carried frontier and the ideal cut both build on this base.
  const base = new Map<ChunkId, number>();
  for (const c of ordered) {
    if (p.rawZone.has(c.id)) {
      base.set(c.id, 0);
    } else if (fixedLevels.has(c.id)) {
      // Pin-at-k: fix to exactly k, clamped to the deepest produced level for
      // this chunk (can't render at a level whose summary doesn't exist yet).
      const k = Math.max(0, fixedLevels.get(c.id)!);
      base.set(c.id, k === 0 ? 0 : Math.min(k, tree.maxLevel(c.id)));
    } else if (frozen.has(c.id)) {
      base.set(c.id, p.previous.get(c.id) ?? c.currentResolution);
    } else {
      base.set(c.id, 0);
    }
  }

  // Carried frontier (F_prev with the base enforced): what is actually
  // rendered right now, and the reference for perturbation.
  const carried = new Map(base);
  let carriedNonEmpty = false;
  for (const c of ordered) {
    if (p.rawZone.has(c.id) || fixedLevels.has(c.id) || frozen.has(c.id)) continue;
    // Enforce a pin-max-level immediately: un-fold anything carried deeper than
    // its cap down to the cap (shallower summaries — its ancestors — are
    // guaranteed to exist). The intended divergence cost of tightening a pin.
    let lvl = p.previous.get(c.id) ?? 0;
    const cap = pinCaps.get(c.id);
    if (cap !== undefined && lvl > cap) lvl = Math.max(0, cap);
    carried.set(c.id, lvl);
  }
  for (const v of p.previous.values()) {
    if (v !== 0) { carriedNonEmpty = true; break; }
  }
  diagHist('carried(pre-projection)', carried, tree);
  // Hard-protected set for boundary-cut tolerance: raw zone + immovable
  // leaves render raw beside their group's recall and are exempt from
  // group-unanimity everywhere.
  const boundaryExempt = new Set<ChunkId>();
  for (const c of ordered) {
    if (p.rawZone.has(c.id) || immovable.has(c.id)) boundaryExempt.add(c.id);
  }
  projectToValidCut(carried, tree, ordered, frozen, fixedLevels, boundaryExempt);
  diagHist('carried(projected)', carried, tree);
  const carriedLayout = renderLayout(inputs, tree, carried);
  const carriedTokens = carriedLayout.totalTokens;

  // Shape prior: soft per-chunk depth caps (log-age band + pin caps), with the
  // −1 sentinel marking the hard-protected set (never folded by anything).
  const flatZoneChunks = p.rawZone.size;
  const caps = new Map<ChunkId, number>();
  for (const c of ordered) {
    let cap: number;
    if (p.rawZone.has(c.id) || immovable.has(c.id)) {
      cap = -1; // hard-protected sentinel: never folded, W notwithstanding
    } else {
      cap = foldDepthCap(c, p.now, p.rawZone, flatZoneChunks, mergeThreshold, maxFoldLevel);
      const pinCap = pinCaps.get(c.id);
      if (pinCap !== undefined) cap = Math.min(cap, Math.max(0, pinCap));
    }
    caps.set(c.id, cap);
  }

  // 1. The ideal cut — pure relevance, no P anywhere.
  const _t0 = typeof process !== 'undefined' && process.env?.KV_TIMING ? Date.now() : 0;
  const ideal = relevanceCut(
    inputs, tree, ordered, base, caps, pinCaps, p.rawZone, immovable, frozen, fixedLevels,
    p.targetTokens, p.windowTokens, maxFoldLevel,
  );
  if (_t0) console.error(`[kv-timing] relevanceCut ${Date.now() - _t0}ms idealTokens=${ideal.tokens}`);
  diagHist('ideal', ideal.F, tree);
  const idealLayout = renderLayout(inputs, tree, ideal.F);
  const idealLoss = relevanceLoss(ideal.F, ordered, p.rawZone, caps);
  const gapCeiling = (strictReach ? Number.POSITIVE_INFINITY : gapRatio) * Math.max(1, idealLoss);

  const flags = (F: ReadonlyMap<ChunkId, number>): { folded: boolean; expanded: boolean } => {
    let folded = false;
    let expanded = false;
    for (const c of ordered) {
      const prev = carried.get(c.id) ?? 0;
      const next = F.get(c.id) ?? 0;
      if (next > prev) folded = true;
      else if (next < prev) expanded = true;
      if (folded && expanded) break;
    }
    return { folded, expanded };
  };

  const adoptIdeal = (override?: ControlPlan['override']): ControlPlan => ({
    resolutions: ideal.F,
    tokens: ideal.tokens,
    ...flags(ideal.F),
    escalated: ideal.tokens > p.windowTokens,
    perturbation: kvCost(carriedLayout, idealLayout),
    ...(override ? { override } : {}),
    ...(strictReach && ideal.tokens > p.foldAtTokens
      ? { blocked: 'target-floor' as const }
      : {}),
  });

  // 2. Bootstrap: nothing carried → nothing to preserve; pure relevance solve.
  if (!carriedNonEmpty && p.previous.size === 0) { diagBranch('bootstrap'); return adoptIdeal('bootstrap'); }

  // 3. Dead band with self-heal: hold the carried frontier only when it is
  //    feasible, in band, AND not certifiably misallocated.
  const carriedLoss = relevanceLoss(carried, ordered, p.rawZone, caps);
  const inBand = carriedTokens <= p.foldAtTokens && carriedTokens >= expandAt;
  if (inBand && carriedTokens <= p.windowTokens && carriedLoss - idealLoss <= gapCeiling) {
    diagBranch(`hold (carried=${carriedTokens} band=[${expandAt},${p.foldAtTokens}])`);
    return {
      resolutions: carried,
      tokens: carriedTokens,
      ...flags(carried), // vs itself → both false unless projection moved it
      escalated: false,
      perturbation: 0,
    };
  }

  // 4. Within the trust region → adopt the ideal outright.
  const idealPert = kvCost(carriedLayout, idealLayout);
  if (idealPert <= P) { diagBranch(`adopt-ideal (pert=${idealPert} <= P=${P})`); return adoptIdeal(); }

  // 5. Suffix adoption: the ideal's newest changes only, within P.
  const partial = suffixAdopt(
    inputs, tree, ordered, carried, carriedLayout, ideal.F, frozen, fixedLevels, P, boundaryExempt,
  );
  const partialLoss = relevanceLoss(partial.F, ordered, p.rawZone, caps);
  // Progress guard: when a shed is REQUIRED (carried over foldAt), a partial
  // plan that neither reaches the band nor moves at all is not acceptable —
  // an under-folded profile scores zero misallocation loss, so the quality
  // gap alone cannot reject "do nothing forever". (P below the physical floor
  // — the tail that any fold must invalidate — lands here and overrides.)
  const mustShed = carriedTokens > p.foldAtTokens;
  const madeProgress =
    !mustShed || partial.tokens <= p.foldAtTokens || partial.perturbation > 0;
  if (partial.tokens <= p.windowTokens && partialLoss - idealLoss <= gapCeiling && madeProgress) {
    diagBranch(`suffix-adopt (pert=${partial.perturbation} tokens=${partial.tokens})`);
    diagHist('partial', partial.F, tree);
    return {
      resolutions: partial.F,
      tokens: partial.tokens,
      ...flags(partial.F),
      escalated: false,
      perturbation: partial.perturbation,
    };
  }

  if (strictReach && carriedTokens <= p.windowTokens) {
    return {
      resolutions: carried,
      tokens: carriedTokens,
      ...flags(carried),
      escalated: false,
      perturbation: 0,
      blocked: 'reach-floor',
    };
  }

  // Trust region priced out: feasibility or quality demands the ideal.
  diagBranch(partial.tokens > p.windowTokens ? 'override:infeasible' : 'override:quality-gap');
  return adoptIdeal(partial.tokens > p.windowTokens ? 'infeasible' : 'quality-gap');
}

/**
 * Run the controller over a session (the exported PickerInputs snapshot) as
 * growing history, measuring billed recompute and KV perturbation per turn.
 */
export function replayControlled(fullInputs: PickerInputs, opts: ControlOptions): ControlResult {
  const mergeThreshold = opts.mergeThreshold ?? 6;
  const markerCount = opts.markerCount ?? 4;
  const targetSteps = Math.max(1, opts.targetSteps ?? 120);
  const HW = opts.highWatermark ?? opts.budgetTokens;
  const LW = opts.lowWatermark ?? Math.round(0.8 * opts.budgetTokens);
  const reachTokens = opts.reachTokens ?? opts.budgetTokens;

  const fullTree = new SummaryTree(fullInputs);
  const availableAt = new Map<string, number>();
  for (const s of fullTree.allSummaries()) availableAt.set(s.id, s.lastSequence);

  const allChunks = [...fullInputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const seqValues = allChunks.map((c) => c.sequence);
  const stride = Math.max(1, Math.ceil(seqValues.length / targetSteps));
  const stepSeqs: number[] = [];
  for (let i = 0; i < seqValues.length; i += stride) stepSeqs.push(seqValues[i]);
  const last = seqValues[seqValues.length - 1];
  if (stepSeqs[stepSeqs.length - 1] !== last) stepSeqs.push(last);

  const steps: ControlStep[] = [];
  let fprev: Frontier = new Map<ChunkId, number>();
  const cache = new CacheStore({ ttlSteps: opts.cacheTtlSteps });
  let prevNow = -1;
  let totalRecomputed = 0;
  let totalBilled = 0;
  let totalCached = 0;
  let totalRendered = 0;
  let sumSqPerturb = 0;
  let maxPerturbation = 0;
  let foldEvents = 0;
  let escalations = 0;

  for (const now of stepSeqs) {
    const visible = allChunks.filter((c) => c.sequence <= now);
    const summaries = new Map<string, SummaryEntry>();
    const recallPairTokens = new Map<string, number>();
    for (const [id, s] of fullInputs.summaries) {
      const lastSeq = availableAt.get(id);
      if (lastSeq !== undefined && lastSeq >= 0 && lastSeq <= now) {
        summaries.set(id, s);
        const rp = fullInputs.recallPairTokens?.get(id);
        if (rp !== undefined) recallPairTokens.set(id, rp);
      }
    }
    const inputs: PickerInputs = {
      chunks: visible, summaries, recallPairTokens,
      headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
    };
    const tree = new SummaryTree(inputs);
    const flatZone = rawTailSet(visible, opts.attendedWindowTokens);
    // Plan this turn's frontier via the shared controller policy (the same code
    // KvStableStrategy runs): carry F_prev, hold the flat zone raw, fold to LW
    // when over HW, and un-fold to LW when under it — both reach-bounded, with
    // [LW, HW] a no-op dead band; never past the hard wall W.
    const plan = planControlledFrontier(inputs, tree, {
      previous: fprev, foldAtTokens: HW, expandAtTokens: LW, targetTokens: LW,
      windowTokens: opts.windowTokens, reachTokens, rawZone: flatZone, now, mergeThreshold,
    });
    const F = plan.resolutions;
    const folded = plan.folded || plan.expanded; // any active prefix change this turn
    const escalated = plan.escalated;

    const layout = renderLayout(inputs, tree, F);
    const hit = cache.read(layout);
    const recomputed = layout.totalTokens - hit.cachedTokens;

    // Perturbation = recompute beyond genuinely new content (prefix churn).
    let newContent = 0;
    for (const c of visible) if (c.sequence > prevNow) newContent += c.rawTokens;
    const perturbation = Math.max(0, recomputed - newContent);

    const billed = PRICE.miss * recomputed + PRICE.cacheRead * hit.cachedTokens;

    // Write breakpoints for future turns, hinting at the change boundary.
    const boundarySeq = earliestChangedSequence(fprev, F, visible);
    const boundaryUnitIndex = unitsBeforeSequence(layout, tree, boundarySeq);
    cache.write(layout, placeMarkers(layout, markerCount, { boundaryUnitIndex }));
    cache.tick();

    let deepestLevel = 0;
    for (const lvl of F.values()) if (lvl > deepestLevel) deepestLevel = lvl;

    steps.push({
      now, numChunks: visible.length, renderedTokens: layout.totalTokens,
      cachedTokens: hit.cachedTokens, recomputedTokens: recomputed, billed,
      perturbation, folded, escalated, deepestLevel,
    });
    totalRecomputed += recomputed;
    totalBilled += billed;
    totalCached += hit.cachedTokens;
    totalRendered += layout.totalTokens;
    sumSqPerturb += perturbation * perturbation;
    if (perturbation > maxPerturbation) maxPerturbation = perturbation;
    if (folded) foldEvents++;
    if (escalated) escalations++;

    fprev = F;
    prevNow = now;
  }

  return {
    steps,
    totalRecomputed,
    totalBilled,
    overallHitRate: totalRendered > 0 ? totalCached / totalRendered : 0,
    maxPerturbation,
    rmsPerturbation: Math.sqrt(sumSqPerturb / Math.max(1, steps.length)),
    foldEvents,
    escalations,
  };
}
