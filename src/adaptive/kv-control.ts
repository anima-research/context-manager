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
 * - The IDEAL CUT is built each turn by relevance, SEEDED from the carried
 *   frontier (`seedFromCarried`, default; `false` builds it from raw): fold
 *   in salience-then-age priority order, level by level, under the soft
 *   shape prior (`foldDepthCap`), past it if W demands, never past the hard
 *   protections (flat zone / pins / locked); then pack youngest-position-
 *   first back toward the target. Of a seeded cut's phases, A and B only
 *   deepen what is carried and only C un-folds. An inverted carried profile
 *   is lowered before the phases run so it heals in fold order (ascending
 *   salience, then oldest), a boundary-cut fold excepted; monotone
 *   over-depth is kept (the hysteresis that stops a band boundary from
 *   flapping with the balance of production and growth). Where a budget
 *   raise leaves the seeded cut paying nearly the whole from-scratch re-read
 *   anyway, the from-scratch cut is taken instead (`seedingReleased`).
 *   Bootstrap (nothing carried) is from scratch.
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

import type { Diagnostics } from '../diagnostics.js';
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
  /** Trust region P on per-turn perturbation, in tokens the provider would
   *  re-read (exact kvCost — design §13.4; NOT a spatial gate on which chunks
   *  may move). The primary cost↔continuity knob: smaller = gentler per-turn
   *  KV perturbation but slower convergence to the ideal cut (suffix adoption
   *  amortizes repairs across turns). Exceeded only via a recorded override
   *  (bootstrap / infeasible / quality-gap). Default = budgetTokens
   *  (effectively unbounded). */
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
  /** Seed each turn's ideal cut from the carried frontier, the production
   *  default (`ControlPlanParams.seedFromCarried` says when a budget raise
   *  takes the from-scratch cut instead). Forwarded to every
   *  `planControlledFrontier` call of the replay; `false` measures the
   *  from-scratch ideal. Default true. */
  seedFromCarried?: boolean;
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
 * Per-chunk fold-depth band from the saliency field: flat zone and pins are
 * raw (0); otherwise log-age banded against the base-k geometry. The "finest
 * requirement wins". This is the SOFT shape prior of the ideal cut (design
 * §13.3): phase A folds under it, phase B folds past it when W demands —
 * only the hard protections (−1 sentinel, assigned by the caller) and pin
 * caps are inviolable.
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
 * Counts by position over 0..n-1 (a Fenwick tree), for phase C's walk list:
 * `count(i, d)` adds d at position i, and `olderThan(i)` returns the largest
 * position below i whose count is positive, or -1 when there's none. Each
 * takes O(log n) steps, and `olderThan` calls `step` once for each of its
 * steps (#156 R6-1).
 */
export function listedCounts(n: number, step: () => void = () => {}): { count(i: number, d: number): void; olderThan(i: number): number } {
  const counts = new Int32Array(n + 1);
  let top = 1;
  while (top * 2 <= n) top *= 2;
  return {
    count(i: number, d: number): void {
      for (let x = i + 1; x <= n; x += x & -x) counts[x] += d;
    },
    olderThan(i: number): number {
      let k = 0; // counted positions before i
      for (let x = i; x > 0; x -= x & -x) { k += counts[x]; step(); }
      if (k === 0) return -1;
      let pos = 0; // the k-th counted position
      for (let half = top; half > 0; half >>= 1) {
        step();
        if (pos + half <= n && counts[pos + half] < k) { pos += half; k -= counts[pos]; }
      }
      return pos;
    },
  };
}

/**
 * Build the IDEAL CUT from `base` — pure relevance, no P anywhere (§13.4).
 * `base` is the carried frontier when seeded (the default), and raw on
 * bootstrap, with `seedFromCarried: false` and for the release's from-scratch
 * cut.
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
  log: Diagnostics,
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
  // disagrees are skipped by folds and stay at their own level beside the
  // recall — exactly the renderer's existing ownership-wins semantics for
  // boundary-cut members. Every pass decides it the same way, by the leaf's
  // own lineage at the node's level: a fold's eligibility and its moves, and
  // phase C's un-folds, count only the leaves the node renders, and the
  // validity projection exempts the rest (projectToValidCut). The plan's
  // `overlap` (findOverlap) reads the emitted frontier, not which folds ran,
  // so a plan built on carried folds reports them as a fresh one does.
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
  if (_tl) log.error(`[kv-timing] ledger-init ${Date.now() - _tl}ms tokens=${ledger.tokens}`);

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
      // than vetoing it. It renders at the level it's held at (raw for the raw
      // zone and a classic pin) alongside its group's recall ("ownership
      // wins"), so a boundary cutting through a group must not make the whole
      // group permanently unfoldable. Observed: calibration drift moved the
      // token-derived head boundary 2 messages into an L3's first chunk — the
      // 2-leaf overlap vetoed the entire 742-leaf group in every phase, and
      // the agent was OverBudget-wedged with its own L3 sitting unused.
      if (cap < 0) continue;
      // Nor does a leaf whose own lineage at this level is another node, or
      // none: the fold doesn't move it (see the marking loop below), so its
      // caps aren't this fold's to keep (§13.6 overlap).
      if (tree.ancestorAt(leafId, level)?.id !== nodeId) continue;
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
          if ((caps.get(leafId) ?? 0) < 0) continue; // protected: keeps its held level beside the recall
          // Overlap tolerance: only mark leaves whose own lineage renders as
          // part of THIS node at this level. Disagreeing leaves keep their
          // level (see the note above `priority`).
          const own = tree.ancestorAt(leafId, level);
          if (!own || own.id !== ancestor.id) continue;
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

  // Hard-protected leaves (−1 caps) are exempt from group unanimity here too —
  // without this, the final projection undoes every boundary-cut fold the
  // phases just made (monotone-lowering the whole group back toward carried).
  // A leaf whose lineage disagrees with a group needs no entry: the
  // projection leaves out of a group's unanimity every leaf whose own lineage
  // at that level isn't the group, and every leaf above the group's level,
  // the rule the carried frontier and suffix adoption are projected by.
  // Phase C reads the same set where it weighs an un-fold's landing levels.
  const projectionExempt = new Set<ChunkId>();
  for (const [id, cap] of caps) if (cap < 0) projectionExempt.add(id);

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
  //
  // Youngest by POSITION, whatever its level — not deepest level first.
  // Until 2026-10-09 the walk was `for level = max..1 { youngest-first }`,
  // which un-folded the youngest L3 group before any L1: on a chronological
  // layout that group sits right after the deep band, so every un-fold was a
  // front edit. Measured on Fable (fold-diff, 2026-10-07..09): the group at
  // the L2↔L3 boundary flapped L3→L2→L3 seven times in three days, each
  // direction re-reading ~300k tokens, while a fold confined to the seam cost
  // ~97k. The comment always said headroom goes to the most recent foldable
  // content; the loop now does what it says, so an un-fold lands where the
  // next fold will — at the seam — and the dead band can hold.
  if (ledger.tokens <= windowTokens && ledger.tokens < target) {
    // A group's un-fold verdict (eligibility + accept/revert) can only change
    // after the ledger moves — i.e. after some OTHER group's un-fold is
    // accepted. The naive loop re-attempted a just-reverted group for EVERY
    // remaining member chunk at that level: for a ~1.7k-leaf group the tail
    // boundary cuts through, that is ~1.7k attempts × 2×1.7k ledger moves
    // (try + revert) — the dominant term of the mythos 30s/turn leak.
    // `attempted` short-circuits repeats. An accept only raises the ledger
    // toward the target (one that lowers it, or leaves it, isn't closer), so
    // a group the accept test declined stays declined until a leaf its
    // verdict read moves: its members, whose levels decide eligibility, and
    // the members of each summary it would land on, whose levels decide the
    // landing and the units the ledger counts. Each key is filed under those
    // leaves, and an accept clears only the keys filed under what it moved.
    // Clearing every key re-tried each declined group once per accept, and
    // with the walk's restart that was quadratic again (#156 R5-1).
    const attempted = new Set<string>();
    const readers = new Map<ChunkId, string[]>();
    const fileReads = (key: string, nodeId: string, leafIds: readonly ChunkId[], level: number): void => {
      for (const id of leafIds) {
        // Only a leaf the summary renders at that level reaches the verdict:
        // eligibility, the landing veto and the ledger's units all skip the rest.
        if (tree.ancestorAt(id, level)?.id !== nodeId) continue;
        const keys = readers.get(id);
        if (keys) keys.push(key); else readers.set(id, [key]);
      }
    };
    // After every accepted un-fold the walk RESTARTS from the youngest
    // position, so the group that just stepped down is the first candidate
    // for its next step (L2→L1→raw) before any older group is tried. Walking
    // on from the accepting member instead reached the same group's next
    // level only through its other members — a group left with one live
    // member (store surgery) or whose accept came through its oldest member
    // waited for the next pass, and an older group took the headroom first
    // (#156 review, Greptile P1). Cost: each node/level is accepted at most
    // once, so passes are bounded by accepts + 1, and a rejected group is
    // tried again only after an accept moves a leaf its verdict read.
    // Phase C only lowers levels (an accept lowers its group, a revert puts
    // back levels of at least 1), so a chunk that is raw or protected stays
    // out of reach for the rest of the phase. The walk follows a list of the
    // chunks still at a level of at least 1 and unprotected, youngest first,
    // and an accept unlinks each member it takes raw. A group phase C declines
    // or can't take leaves the list too, until an accept moves a leaf its
    // verdict read, and a chunk with no summary at its level leaves it on its
    // first visit. Restarting at the
    // youngest position and skipping raw chunks one by one rescanned every
    // group earlier accepts had taken raw, quadratic in the groups a large
    // raise un-folds (#156 R4-1). Skipping only the raw run at the young end
    // still rescanned them behind a youngest group that stays declined.
    const n = ordered.length;
    const olderListed = new Int32Array(n); // the next older listed position, or -1
    const youngerListed = new Int32Array(n); // the next younger listed position, or n
    const listed = new Uint8Array(n);
    // Phase C's pass and visit counts (KV_TIMING). They come before
    // `listedCounts`, whose search counts each of its steps as a visit.
    let passes = 0;
    let visits = 0;
    // Listed counts by position (a Fenwick tree), so `relist` finds the next
    // older listed chunk in O(log n) rather than by scanning back over every
    // parked or raw one: one accept per pass can relist a group behind a long
    // unlisted run, and scanning it each time was quadratic in the run.
    // Each step of that search counts as a visit (KV_TIMING's `visits`), so
    // the tests that bound phase C's visits bound relist's search too (#156
    // R6-1).
    const { count, olderThan } = listedCounts(n, () => { visits++; });
    let youngestListed = -1;
    let oldestListed = n;
    for (let i = 0; i < n; i++) {
      const id = ordered[i].id;
      if ((F.get(id) ?? 0) < 1 || rawZone.has(id) || immovable.has(id)) continue;
      listed[i] = 1;
      count(i, 1);
      if (oldestListed === n) oldestListed = i;
      olderListed[i] = youngestListed;
      if (youngestListed >= 0) youngerListed[youngestListed] = i;
      youngestListed = i;
    }
    if (youngestListed >= 0) youngerListed[youngestListed] = n;
    const positionOf = new Map(ordered.map((c, i) => [c.id, i] as const));
    const unlist = (i: number): void => {
      if (!listed[i]) return;
      listed[i] = 0;
      count(i, -1);
      const older = olderListed[i];
      const younger = youngerListed[i];
      if (older >= 0) youngerListed[older] = younger;
      else oldestListed = younger;
      if (younger < n) olderListed[younger] = older;
      else youngestListed = older;
    };
    const relist = (i: number): void => {
      if (listed[i]) return;
      const older = olderThan(i);
      listed[i] = 1;
      count(i, 1);
      const younger = older >= 0 ? youngerListed[older] : oldestListed;
      olderListed[i] = older;
      youngerListed[i] = younger;
      if (older >= 0) youngerListed[older] = i;
      else oldestListed = i;
      if (younger < n) olderListed[younger] = i;
      else youngestListed = i;
    };
    // A declined or ineligible group's members leave the walk until its key
    // is cleared: they would only be visited to hit `attempted`.
    const parked = new Map<string, number[]>();
    const park = (key: string, nodeId: string, leafIds: readonly ChunkId[], level: number): void => {
      const at: number[] = [];
      for (const leafId of leafIds) {
        const i = positionOf.get(leafId);
        if (i === undefined || !listed[i]) continue;
        if ((F.get(leafId) ?? 0) !== level || tree.ancestorAt(leafId, level)?.id !== nodeId) continue;
        unlist(i);
        at.push(i);
      }
      if (at.length) parked.set(key, at);
    };
    const clearKey = (key: string): void => {
      if (!attempted.delete(key)) return;
      const at = parked.get(key);
      if (!at) return;
      parked.delete(key);
      for (const i of at) if ((F.get(ordered[i].id) ?? 0) >= 1) relist(i);
    };
    const _tc = typeof process !== 'undefined' && process.env?.KV_TIMING ? Date.now() : 0;
    let progressed = true;
    while (progressed && ledger.tokens < target) {
      progressed = false;
      passes++;
      for (let oi = youngestListed; oi >= 0; oi = olderListed[oi]) {
        if (ledger.tokens >= target) break;
        visits++;
        const c = ordered[oi]; // youngest-first, among the listed chunks
        const level = F.get(c.id) ?? 0;
        const node = tree.ancestorAt(c.id, level);
        if (!node) { unlist(oi); continue; } // static: no summary at its level
        const attemptKey = `${node.id}:${level}`;
        if (attempted.has(attemptKey)) continue;
        let eligible = true;
        for (const leafId of node.leafChunkIds) {
          // Protected members sit at the level they're held at beside the
          // recall (boundary-cut tolerance): they neither veto nor take part
          // in the un-fold.
          // Nor does a member whose own lineage at this level is another
          // node, or none: this node doesn't render it (§13.6 overlap).
          if (rawZone.has(leafId) || immovable.has(leafId)) continue;
          if (tree.ancestorAt(leafId, level)?.id !== node.id) continue;
          if ((F.get(leafId) ?? 0) !== level) {
            eligible = false;
            break;
          }
        }
        if (!eligible) { attempted.add(attemptKey); fileReads(attemptKey, node.id, node.leafChunkIds, level); park(attemptKey, node.id, node.leafChunkIds, level); continue; }
        const before = ledger.tokens;
        // Record exact prior levels for an honest revert: with boundary-cut
        // tolerance a group may hold members below `level` (protected raw,
        // frozen mid-levels) — hardcoded from/to drifts the ledger away from
        // renderLayout, and every later accept decision is made on corrupt
        // arithmetic (observed: phase C walked an L3 fold all the way back to
        // carried while its ledger believed it sat on target).
        // Each leaf moves one level down, or deeper, down to raw, while it has
        // no summary there (`SummaryTree.ancestorAt`) or a leaf below vetoes
        // its summary there, as projectToValidCut lowers an unheld leaf, so
        // the accept below weighs each leaf where the projection will put it.
        // Moved one level down regardless, a leaf under a summary that a leaf
        // below vetoes was priced at a recall the projection then took away:
        // an un-fold the ledger said fit was accepted, then rendered the leaf
        // lower, raw where it has no summary below. Only a leaf a summary
        // lists, whose own lineage there is that summary, can make it vetoed
        // by dropping below it, and below the summary being un-folded this
        // loop, like the projection, takes a leaf past such a summary only
        // where the summary is vetoed already. So the landing verdicts don't
        // change while the un-fold moves its leaves, or when the projection
        // runs after it. Eligibility put every leaf moved here at `level`.
        const vetoMemo = new Map<string, boolean>();
        const landings: Array<[{ id: string; leafChunkIds: readonly ChunkId[] }, number]> = [];
        const landingVetoed = (own: { id: string; leafChunkIds: readonly ChunkId[] }, at: number): boolean => {
          const key = `${own.id}:${at}`;
          let verdict = vetoMemo.get(key);
          if (verdict === undefined) {
            verdict = vetoed(tree, own, at, F, projectionExempt);
            vetoMemo.set(key, verdict);
            landings.push([own, at]);
          }
          return verdict;
        };
        const moved: Array<[ChunkId, number, number]> = [];
        for (const leafId of node.leafChunkIds) {
          if (rawZone.has(leafId) || immovable.has(leafId)) continue; // protected: not part of the fold
          if (tree.ancestorAt(leafId, level)?.id !== node.id) continue; // rendered by another node
          const from = F.get(leafId) ?? 0;
          let to = level - 1;
          for (; to > 0; to--) {
            const own = tree.ancestorAt(leafId, to);
            if (own && !landingVetoed(own, to)) break;
          }
          const leaf = byId.get(leafId);
          if (leaf) ledger.move(leaf, byId, from, to);
          F.set(leafId, to);
          moved.push([leafId, from, to]);
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
          // moves away from the target (or breaches W) → revert, each leaf
          // from the level it moved to
          for (const [leafId, from, to] of moved) {
            const leaf = byId.get(leafId);
            if (leaf) ledger.move(leaf, byId, to, from);
            F.set(leafId, from);
          }
          attempted.add(attemptKey);
          fileReads(attemptKey, node.id, node.leafChunkIds, level);
          for (const [own, at] of landings) fileReads(attemptKey, own.id, own.leafChunkIds, at);
          park(attemptKey, node.id, node.leafChunkIds, level);
        } else {
          // The ledger moved: a group whose verdict read a moved leaf may now
          // verdict differently, so it returns to the walk.
          for (const [leafId] of moved) {
            for (const key of readers.get(leafId) ?? []) clearKey(key);
            readers.delete(leafId);
          }
          for (const [leafId, , to] of moved) {
            if (to > 0) continue;
            const i = positionOf.get(leafId);
            if (i !== undefined) unlist(i);
          }
          progressed = true;
          break; // restart from the youngest position
        }
      }
    }
    if (_tc) log.error(`[kv-timing] phase-c ${Date.now() - _tc}ms passes=${passes} visits=${visits}`);
  }

  const _tp = typeof process !== 'undefined' && process.env?.KV_TIMING ? Date.now() : 0;
  projectToValidCut(F, tree, ordered, frozen, fixedLevels, projectionExempt);
  if (_tp) log.error(`[kv-timing] cut-projection ${Date.now() - _tp}ms`);
  // One authoritative render at the end (the ledger tracks it exactly, but the
  // projection may have moved leaves — recompute once, not per move).
  const tokens = renderLayout(inputs, tree, F).totalTokens;
  // Fits, or a full round made no progress, or round cap → done. Otherwise
  // re-fold on the projected frontier with a resynced ledger.
  if (tokens <= windowTokens || tokens >= projTokens || round >= 2) {
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
  exempt: ReadonlySet<ChunkId>,
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
 * Pinned (`fixedLevels`) and frozen (locked) leaves are held here rather than
 * lowered: pin-at-level fixes a whole node's leaves at its level, and a lock
 * keeps its carried level. The base sets both, each at a level where the
 * leaf has a summary (`SummaryTree.renderableLevel`).
 *
 * A leaf renders at its level through its own lineage there, and only where
 * that summary lists it (`SummaryTree.ancestorAt`), so a leaf with no such
 * summary at its level is lowered. A level carried from before the tree's
 * links changed can point through a summary that no longer lists the leaf,
 * and a level can be carried above the tree's top.
 *
 * A leaf the node lists vetoes its unanimity only when it renders in more
 * detail than the node, below the node's level, and the node is its own
 * lineage at that level: the node's recall would then render over it. A
 * hard-protected leaf (`exempt`) never vetoes. On a non-nested tree a node can
 * list a leaf whose own lineage at the node's level is another summary, or
 * none (§13.6 overlap tolerance). That leaf renders through its own lineage
 * whatever the node does, so it never vetoes the node. A leaf folded above the
 * node renders through a coarser summary of its own lineage, and that
 * summary's unanimity decides whether it stays there. Where it stays and the
 * node renders, the leaf is in both recalls. On a nested tree that can't last
 * for a leaf no protection holds: the coarser summary owns the node's leaves,
 * and those below its level veto it, bringing the leaf down to theirs, unless
 * every one of them is hard-protected, since those never veto. A held
 * leaf stays where the base put it. A pin-at-level holds a whole node's leaves
 * at one level, but a lock holds one chunk, so a lock above its group stays
 * there with the group's recall beside it, boundary-cut tolerance extended to
 * a lock. On a non-nested tree an unheld leaf can stay too, the overlap §13.6
 * tolerates. The rule depends only on the tree, the cut and the
 * hard-protected leaves, which every projection is given alike: the ideal
 * cut's, the carried frontier's and each suffix candidate's. A frontier the
 * planner emitted therefore projects to itself on unchanged inputs, and the
 * next compile starts from what this one rendered.
 */
function projectToValidCut(
  F: Map<ChunkId, number>,
  tree: SummaryTree,
  ordered: PickerChunk[],
  frozen: ReadonlySet<ChunkId>,
  fixedLevels: ReadonlyMap<ChunkId, number>,
  /** Hard-protected leaves (raw zone / pins / locked): rendered at the level
   *  they're held at (raw for the raw zone and a classic pin) beside their
   *  group's recall (ownership-wins), so they are exempt from the
   *  unanimity requirement — a boundary cutting through a group must not
   *  force the whole group back to raw (boundary-cut tolerance, 2026-07-27). */
  exempt: ReadonlySet<ChunkId>,
): void {
  // Each pass that changes anything lowers some leaf one level, so the deepest
  // level in F (not only in the tree: a carried level can sit above the
  // tree's top) bounds the passes, and the result projects to itself.
  let deepest = maxAvailableLevel(tree);
  for (const level of F.values()) if (level > deepest) deepest = level;
  const maxPasses = (ordered.length + 1) * (deepest + 2);
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
      if (frozen.has(c.id) || fixedLevels.has(c.id)) continue; // held where the base set it
      const node = tree.ancestorAt(c.id, lvl);
      let unanimous = false;
      if (node) {
        const key = `${node.id}:${lvl}`;
        const hit = unanimityMemo.get(key);
        if (hit !== undefined) {
          unanimous = hit;
        } else {
          unanimous = !vetoed(tree, node, lvl, F, exempt);
          unanimityMemo.set(key, unanimous);
        }
      }
      if (!unanimous) { F.set(c.id, lvl - 1); changed = true; } // un-fold one level
    }
  }
}

/**
 * Whether a leaf the node lists vetoes the node at a level: a leaf below that
 * level, rendered in more detail than the node, whose own lineage there is
 * the node, and that no hard protection exempts. The node's recall would
 * render over it. A leaf above the node renders through a coarser summary of
 * its own lineage, which that summary's verdict decides. projectToValidCut
 * lowers a vetoed node's leaves, and phase C passes such a node by.
 */
function vetoed(
  tree: SummaryTree,
  node: { id: string; leafChunkIds: readonly ChunkId[] },
  level: number,
  F: ReadonlyMap<ChunkId, number>,
  exempt: ReadonlySet<ChunkId>,
): boolean {
  for (const leafId of node.leafChunkIds) {
    if (exempt.has(leafId)) continue;
    if ((F.get(leafId) ?? 0) < level && tree.ancestorAt(leafId, level)?.id === node.id) return true;
  }
  return false;
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
function diagHist(
  label: string,
  F: ReadonlyMap<ChunkId, number>,
  tree: SummaryTree,
  log: Diagnostics,
): void {
  if (!DIAG_GROUP) return;
  const node = tree.summary(DIAG_GROUP);
  if (!node) return;
  const hist = new Map<number, number>();
  for (const id of node.leafChunkIds) {
    const l = F.get(id) ?? 0;
    hist.set(l, (hist.get(l) ?? 0) + 1);
  }
  log.error(`[kv-diag] ${label}: levels ${JSON.stringify([...hist.entries()].sort((a, b) => a[0] - b[0]))}`);
}
function diagBranch(label: string, log: Diagnostics): void {
  if (DIAG_GROUP) log.error(`[kv-diag] branch: ${label}`);
}

export interface ControlPlanParams {
  /** Carried frontier (F_prev). */
  previous: ReadonlyMap<ChunkId, number>;
  /**
   * Where the planner's `[kv-timing]` and `[kv-diag]` lines go: a strategy's
   * diagnostics, which name its namespace (#239). A replay of one agent's
   * turns gives none, and they go to the console as they are.
   */
  diagnostics?: Diagnostics;
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
  /**
   * Seed the ideal cut from the carried frontier instead of from raw: phases
   * A/B only deepen what is carried (same salience-then-oldest, level-by-level
   * order), and only phase C — youngest position first — un-folds. The
   * from-scratch cut re-decides every band boundary from the current balance
   * of production and growth, so a deep group near a boundary is raised when
   * a new mid-level summary lands and re-deepened when growth crosses W —
   * each direction a front edit (#156 review, Major 2). An inverted carried
   * profile (a chunk deeper than an older unprotected chunk) is still lowered
   * to the older level so phase A re-folds it in its own order (ascending
   * salience, then oldest) — the quality-gap self-heal keeps working. An
   * older chunk is weighed only against younger chunks at or above the next
   * level its group can render at, so one already at its group's deepest
   * level, or whose lineage skips past the younger chunk's level, is no
   * evidence of inversion, and a boundary-cut fold isn't lowered. Where the
   * carried frontier is under expandAt and the seeded cut would pay nearly
   * the whole from-scratch re-read anyway, the from-scratch cut is taken
   * instead (`ControlPlan.seedingReleased`). Seeding doesn't apply to
   * bootstrap (nothing carried). Default true; `false` builds the ideal from
   * raw every turn, keeping phase C's walk by youngest position.
   */
  seedFromCarried?: boolean;
  /** Quality-gap override threshold (§13.4): a plan within P is rejected — and
   *  the ideal adopted, paying the perturbation — when its relevance loss
   *  exceeds the ideal's by more than this fraction of the ideal's loss.
   *  Also bounds how misallocated a dead-band hold may be before the solver
   *  self-heals. Default 0.35. */
  qualityGapRatio?: number;
  /** Chunks forced to raw and never folded (flat zone / head / tail / pinned). */
  rawZone: ReadonlySet<ChunkId>;
  /**
   * Chunks kept at their carried resolution (locked), never folded or
   * un-folded by the solve. The base lowers a lock to its pin-max-level when
   * that is shallower, and to the next level down where the chunk has a
   * summary (`SummaryTree.renderableLevel`), when it has none at the lock's
   * level.
   */
  frozen?: ReadonlySet<ChunkId>;
  /**
   * V2 pin-at-level-k: chunks fixed to render at the given fold level
   * (0 = raw). Held there and never folded or un-folded — the frontier cut
   * passes through that L_k node. A level where the chunk has no summary
   * (`SummaryTree.ancestorAt`): deeper than the tree has produced, one its
   * lineage skips, or one whose summary doesn't list it, is lowered to the
   * next level down where it has one, or to raw.
   * (`ProtectedRange.level`.)
   */
  fixedLevels?: ReadonlyMap<ChunkId, number>;
  /**
   * V2 pin-max-level: per-chunk HARD cap on fold depth — the chunk may fold no
   * deeper than this level, enforced in normal AND emergency shedding, and any
   * carried resolution deeper than the cap, a locked chunk's included, is
   * un-folded to it at plan start. A chunk in `fixedLevels` keeps its fixed
   * level instead: kv-stable fixes a pin-at-level's whole node there, a capped
   * leaf of it included. (`ProtectedRange.maxLevel`.)
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
   *  tokens the provider will re-read for this plan's choices (0 on a
   *  hold/pure-append turn). A change every plan must make, such as a pin
   *  tightened since the last compile, is in the carried frontier already,
   *  so it isn't counted here. */
  perturbation: number;
  /** Set when the trust region P did not bind normally (§13.4). Callers should
   *  log these loudly (`[kv-escalation]`):
   *  - 'bootstrap': no carried frontier — pure relevance solve, P not applicable;
   *  - 'infeasible': nothing within P fits under W — feasibility beats P;
   *  - 'quality-gap': the best plan within P was certifiably bad vs the ideal. */
  override?: 'bootstrap' | 'infeasible' | 'quality-gap';
  /** Seeded solve only: the from-scratch cut was taken instead of the
   *  carried-seeded one. That's weighed only while the carried frontier is
   *  under expandAt, as after a budget raise, and taken when the seeded plan
   *  pays a re-read and would already pay ≥ 90% of the from-scratch one,
   *  which may be none: keeping the tight-budget allocation buys nothing then
   *  (#156 R2-3, R3-3; #186 R3-2). Past the trust region, a plan that adopts
   *  the whole cut through an override, or its newest part (step 5), reports
   *  it too; one that adopts none of it, where no part fits, doesn't. */
  seedingReleased?: boolean;
  /** No realizable progress fits inside a strict trust region. */
  blocked?: 'reach-floor' | 'target-floor';
  /** The leaves that a summary this plan renders lists while their own
   *  summary at its level (`SummaryTree.ancestorAt`) is another one, or none,
   *  where the store's summary tree is non-nested (findOverlap). A caller
   *  that presents the plan logs them loudly (`[kv-overlap]`, reportOverlap),
   *  as a compile does for its own plan and replayControlled for each turn.
   *  Empty when nothing the plan renders disagrees. */
  overlap: readonly ChunkId[];
}

/**
 * Plan one turn's frontier — the rev 5.0 single-path solve (§13.4), shared by
 * the replay harness (`replayControlled`) and `KvStableStrategy`.
 *
 *   1. Build the IDEAL CUT by pure relevance (W the only wall), seeded from
 *      the carried frontier by default (`seedFromCarried`; from raw on
 *      bootstrap or when `false`).
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
 * It logs nothing about the overlap it finds: the plan carries it as
 * `overlap`, for a caller that presents the plan to log with reportOverlap,
 * as a compile does for its own plan beside `override`'s `[kv-escalation]`.
 * So kv-stable's shadow production pick, which presents nothing, says
 * nothing. Pure and deterministic.
 */
export function planControlledFrontier(
  inputs: PickerInputs,
  tree: SummaryTree,
  p: ControlPlanParams,
): ControlPlan {
  const plan = planUnreported(inputs, tree, p);
  return { ...plan, overlap: findOverlap(tree, inputs.chunks, plan.resolutions) };
}

/**
 * The leaves that a summary the frontier F renders lists while their own
 * summary at that level (`SummaryTree.ancestorAt`) is another one, or none
 * (two lineages over one span): the summary's recall covers them while they
 * render through their own lineage or raw, so the store's summary tree is
 * NON-NESTED there. It reads the frontier the plan emits, so a plan that
 * keeps carried folds reports them as one that makes them does. A leaf that
 * a lock or a pin holds beside a summary of its own lineage that lists it
 * renders in both recalls too, and goes unreported: a protection put it
 * there, not the topology.
 */
function findOverlap(
  tree: SummaryTree,
  chunks: readonly PickerChunk[],
  F: ReadonlyMap<ChunkId, number>,
): ControlPlan['overlap'] {
  const rendered = new Set<string>();
  const overlap = new Set<ChunkId>();
  for (const c of chunks) {
    const level = F.get(c.id) ?? 0;
    if (level < 1) continue;
    const node = tree.ancestorAt(c.id, level);
    if (!node || rendered.has(node.id)) continue;
    rendered.add(node.id);
    for (const leafId of node.leafChunkIds) {
      if (tree.ancestorAt(leafId, level)?.id !== node.id) overlap.add(leafId);
    }
  }
  return [...overlap];
}

/**
 * NEVER QUIET (2026-08-03): overlap tolerance is a degraded mode, not a
 * feature. A plan's `overlap` means the store's summary tree is NON-NESTED
 * where the plan renders it, and messages are SEMANTICALLY DOUBLE-REPRESENTED
 * in the window. The solve proceeding is the mitigation; the topology is the
 * disease. So every compile whose plan renders such a summary says so, until
 * the store is repaired (nesting reconciler, see the 2026-08-03 opus4
 * incident).
 * AutobiographicalStrategy calls this with its compile's own plan, beside
 * `[kv-escalation]`, and replayControlled with each turn's. The planner
 * doesn't, since kv-stable's shadow production pick plans the same way and
 * renders nothing. The strategy gives its diagnostics, whose line names its
 * namespace (#239); a replay of one agent's turns gives none.
 */
export function reportOverlap(
  overlap: ControlPlan['overlap'],
  log: Diagnostics = console,
): void {
  if (overlap.length === 0) return;
  log.error(
    `[kv-overlap] ⚠️ non-nested summary tree: ${overlap.length} leaf(s) with ` +
      `conflicting lineage tolerated this compile (double-representation in window). ` +
      `Store needs nesting repair. sample=${overlap.slice(0, 5).join(',')}`,
  );
}

function planUnreported(
  inputs: PickerInputs,
  tree: SummaryTree,
  p: ControlPlanParams,
): Omit<ControlPlan, 'overlap'> {
  const log = p.diagnostics ?? console;
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
  // the carried frontier and the ideal cut both build on this base. The
  // projection never lowers a held leaf, so a held level where the leaf has
  // no summary (links changed since it was carried, a pin above the tree's
  // top, or a level the lineage skips) is lowered here, to the next level
  // down where it has one (`SummaryTree.renderableLevel`).
  const base = new Map<ChunkId, number>();
  for (const c of ordered) {
    if (p.rawZone.has(c.id)) {
      base.set(c.id, 0);
    } else if (fixedLevels.has(c.id)) {
      // Pin-at-k: fix to k, lowered to a level where this chunk has a summary
      // (it can't render through a summary that doesn't exist or doesn't
      // list it).
      const k = Math.max(0, fixedLevels.get(c.id)!);
      base.set(c.id, tree.renderableLevel(c.id, k));
    } else if (frozen.has(c.id)) {
      // A lock keeps its carried level, lowered to a pin-max-level below it
      // (kv-stable passes both for a capped, locked chunk) and to a level
      // where it has a summary.
      const held = p.previous.get(c.id) ?? c.currentResolution;
      const cap = pinCaps.get(c.id);
      base.set(c.id, tree.renderableLevel(c.id, cap === undefined ? held : Math.min(held, Math.max(0, cap))));
    } else {
      base.set(c.id, 0);
    }
  }

  // Carried frontier: F_prev with the changes every plan must make applied
  // first (the base, a pin-max-level tightened since, and the projection to a
  // valid cut of this tree). On unchanged inputs it is what the last compile
  // rendered. It is the reference for perturbation and the trust region, so
  // neither counts a change no plan can avoid.
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
  diagHist('carried(pre-projection)', carried, tree, log);
  // Hard-protected set for boundary-cut tolerance: raw-zone and immovable
  // leaves render at their held level beside their group's recall (raw for the
  // raw zone) and are exempt from group-unanimity everywhere. A leaf whose
  // lineage disagrees with a group (overlap tolerance) needs no entry: the
  // projection leaves it out of that group's unanimity by its lineage, exactly
  // as for the ideal cut.
  const boundaryExempt = new Set<ChunkId>();
  for (const c of ordered) {
    if (p.rawZone.has(c.id) || immovable.has(c.id)) boundaryExempt.add(c.id);
  }
  projectToValidCut(carried, tree, ordered, frozen, fixedLevels, boundaryExempt);
  diagHist('carried(projected)', carried, tree, log);
  const carriedLayout = renderLayout(inputs, tree, carried);
  const carriedTokens = carriedLayout.totalTokens;
  // Receding-horizon seeding (the default): the ideal starts where the
  // carried frontier is, so A/B never un-fold and the only raises are phase
  // C's seam-first ones — EXCEPT where the carried profile is inverted (a
  // chunk carried deeper than some OLDER unprotected chunk): those are
  // lowered to the older chunk's level so phase A re-folds the region in its
  // own order (ascending salience, then oldest) and the inversion heals (the
  // quality-gap self-heal's purpose). Monotone
  // over-depth — the boundary group a new mid-level summary made
  // unnecessary — is kept, which is the hysteresis the from-scratch cut
  // lacks. Protected/base levels are already in `carried`.
  let idealBase = base;
  const seeded = (p.seedFromCarried ?? true) && carriedNonEmpty;
  if (seeded) {
    idealBase = new Map(carried);
    // Per-node memo for the pin-cap scan below: the verdict depends only on
    // the node, and every member chunk would otherwise rescan the node's
    // leaves (O(N·groupSize) per compile on a 36k-message store).
    const nodeFoldable = new Map<SummaryId, boolean>();
    const canRenderAt = (node: { id: SummaryId; leafChunkIds: readonly ChunkId[] }, k: number): boolean => {
      const hit = nodeFoldable.get(node.id);
      if (hit !== undefined) return hit;
      let ok = true;
      for (const leafId of node.leafChunkIds) {
        if (p.rawZone.has(leafId) || immovable.has(leafId)) continue;
        // A listed leaf whose own lineage at this level is another node, or
        // none, takes no part in the group's fold (groupEligible skips it),
        // so its pin-max-level doesn't cap the group (#186 R3-3).
        if (tree.ancestorAt(leafId, k)?.id !== node.id) continue;
        const cap = pinCaps.get(leafId);
        if (cap !== undefined && cap < k) { ok = false; break; }
      }
      nodeFoldable.set(node.id, ok);
      return ok;
    };
    // A chunk whose group at its carried level has a hard-protected member
    // (in the raw zone, pinned or locked) is part of a boundary-cut fold: the
    // group's other members fold with the protected ones held, so a younger
    // one can sit folded beside older raw chunks without being an inversion.
    // So it isn't lowered as inverted, which moved the plan once on unchanged
    // inputs after such a fold (R3-4). The group is the chunk's lineage at its
    // carried level, which lists it, since the carried frontier was projected
    // to a valid cut above. Its members are the leaves whose own lineage there
    // is that node, as for canRenderAt: a protected leaf the node lists under
    // another lineage takes no part in its fold. Each node's members are read
    // once.
    const boundaryCutMemo = new Map<SummaryId, boolean>();
    const boundaryCut = (chunkId: ChunkId, lvl: number): boolean => {
      const node = tree.ancestorAt(chunkId, lvl);
      if (!node) return false;
      let cut = boundaryCutMemo.get(node.id);
      if (cut === undefined) {
        cut = node.leafChunkIds.some((leafId) => (p.rawZone.has(leafId) || immovable.has(leafId))
          && tree.ancestorAt(leafId, lvl)?.id === node.id);
        boundaryCutMemo.set(node.id, cut);
      }
      return cut;
    };
    // An older chunk is evidence that a younger, deeper chunk is inverted
    // only if it could fold deeper without passing the younger chunk's level:
    // it is weighed against younger chunks at or above `next`, the lowest
    // level above its own where a summary lists it and its group can render. olderMinAt[k] is
    // the lowest carried level among older unprotected chunks whose `next` is
    // k. On a nested tree `next` is the chunk's own level plus one, and a
    // younger chunk deeper than any older chunk is lowered to the lowest such
    // older level. A lineage can skip levels for a chunk, though: an L1
    // listed directly by an L4 and dropped from its L2 can't fold to L2 or L3,
    // and weighed against every younger L2 and L3 it lowered the whole younger
    // band on every seeded compile (#156 R4-2). An older chunk already at the
    // deepest level its GROUP can render at has no `next`, so it is no
    // evidence at all (#156 R2-1: a parentless L1 beside an L3, or a
    // pin-max-level on a group-mate, otherwise re-lowered the band on every
    // compile, a two-cycle re-reading the whole layout, and the deep-band
    // flap back under a pin). A level counts only where its summary lists the
    // chunk (R3-2), which `ancestorAt` checks, and where no pin-max-level
    // among the group's foldable leaves caps it (`canRenderAt`).
    const olderMinAt: number[] = [];
    for (const c of ordered) { // oldest first
      if (p.rawZone.has(c.id) || immovable.has(c.id)) continue;
      const lvl = carried.get(c.id) ?? 0;
      let olderMin = Number.POSITIVE_INFINITY;
      for (let k = 1; k <= lvl && k < olderMinAt.length; k++) {
        const m = olderMinAt[k];
        if (m !== undefined && m < olderMin) olderMin = m;
      }
      if (lvl > olderMin && !boundaryCut(c.id, lvl)) idealBase.set(c.id, olderMin);
      let next = 0;
      for (let k = lvl + 1, top = tree.maxLevel(c.id); k <= top; k++) {
        const node = tree.ancestorAt(c.id, k);
        if (node && canRenderAt(node, k)) { next = k; break; }
      }
      const prev = olderMinAt[next];
      if (next > 0 && (prev === undefined || lvl < prev)) olderMinAt[next] = lvl;
    }
  }

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
  let ideal = relevanceCut(inputs, tree, ordered, idealBase, caps, pinCaps, p.rawZone, immovable, frozen, fixedLevels,
    p.targetTokens, p.windowTokens, maxFoldLevel, log);
  // The hysteresis has a cost the quality-gap check cannot see: relevance
  // loss scores only depth past the age cap, and the seeded ideal keeps the
  // carried depth, so a budget raise can leave L4s in place that a
  // from-scratch cut would open — while the seeded plan still pays most of
  // the rewrite (the seam below the band churns either way). So where the
  // carried frontier has headroom, under expandAt as after a raise, a seeded
  // ideal that pays a re-read is set beside the from-scratch cut, and when it
  // would already pay ≥ 90% of the from-scratch re-read, the from-scratch cut
  // is taken: the hysteresis is buying nothing but a worse allocation. That
  // includes a from-scratch cut that re-reads nothing, where the seeded ideal
  // would re-lay a plan on unchanged inputs. A seeded ideal that re-reads
  // nothing is kept without building the other cut. Past the trust region P,
  // the from-scratch cut is adopted as any ideal past P is: its newest part
  // that fits within P (step 5), and that plan reports the release if it takes
  // any of it, or the whole cut where the infeasible or quality-gap override
  // applies. Above expandAt (a shed, a hold, a fold at the seam) the seeded
  // plan is kept. (#156 R2-3, R3-3; #186 R3-2)
  let seedingReleased = false;
  if (seeded && carriedTokens < expandAt) {
    const seededPert = kvCost(carriedLayout, renderLayout(inputs, tree, ideal.F));
    if (seededPert > 0) {
      const scratch = relevanceCut(inputs, tree, ordered, base, caps, pinCaps, p.rawZone, immovable, frozen, fixedLevels,
        p.targetTokens, p.windowTokens, maxFoldLevel, log);
      const scratchPert = kvCost(carriedLayout, renderLayout(inputs, tree, scratch.F));
      if (seededPert >= 0.9 * scratchPert) {
        ideal = scratch;
        seedingReleased = true;
      }
    }
  }
  if (_t0) log.error(`[kv-timing] relevanceCut ${Date.now() - _t0}ms idealTokens=${ideal.tokens}`);
  diagHist('ideal', ideal.F, tree, log);
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

  const adoptIdeal = (override?: ControlPlan['override']): Omit<ControlPlan, 'overlap'> => ({
    resolutions: ideal.F,
    tokens: ideal.tokens,
    ...flags(ideal.F),
    escalated: ideal.tokens > p.windowTokens,
    perturbation: kvCost(carriedLayout, idealLayout),
    ...(override ? { override } : {}),
    ...(seedingReleased ? { seedingReleased: true } : {}),
    ...(strictReach && ideal.tokens > p.foldAtTokens
      ? { blocked: 'target-floor' as const }
      : {}),
  });

  // 2. Bootstrap: nothing carried → nothing to preserve; pure relevance solve.
  if (!carriedNonEmpty && p.previous.size === 0) { diagBranch('bootstrap', log); return adoptIdeal('bootstrap'); }

  // 3. Dead band with self-heal: hold the carried frontier only when it is
  //    feasible, in band, AND not certifiably misallocated.
  const carriedLoss = relevanceLoss(carried, ordered, p.rawZone, caps);
  const inBand = carriedTokens <= p.foldAtTokens && carriedTokens >= expandAt;
  if (inBand && carriedTokens <= p.windowTokens && carriedLoss - idealLoss <= gapCeiling) {
    diagBranch(`hold (carried=${carriedTokens} band=[${expandAt},${p.foldAtTokens}])`, log);
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
  if (idealPert <= P) { diagBranch(`adopt-ideal (pert=${idealPert} <= P=${P})`, log); return adoptIdeal(); }

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
    diagBranch(`suffix-adopt (pert=${partial.perturbation} tokens=${partial.tokens})`, log);
    diagHist('partial', partial.F, tree, log);
    const moved = flags(partial.F);
    return {
      resolutions: partial.F,
      tokens: partial.tokens,
      ...moved,
      escalated: false,
      perturbation: partial.perturbation,
      ...(seedingReleased && (moved.folded || moved.expanded) ? { seedingReleased: true } : {}),
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
  diagBranch(partial.tokens > p.windowTokens ? 'override:infeasible' : 'override:quality-gap', log);
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
      seedFromCarried: opts.seedFromCarried,
    });
    // The replay renders each turn's plan, so it reports the plan's overlap.
    reportOverlap(plan.overlap);
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
