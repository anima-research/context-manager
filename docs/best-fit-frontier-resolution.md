# Adaptive Resolution V2 — Best-Fit Frontier Solver with KV-Stability

**Status: HISTORICAL (2026-08-05).** The DP solver this document specifies was
built and then **removed** (`ea198a1`) — its sliding-half-life value model
created the very churn its λ term fought (`kv-stable-context-control.md`,
"Why this exists"). No DP solver is pending; the production solver is the
rev 5.0 single-path solve (`adaptive-resolution-design.md` §13). Three live
descendants keep this document referenced from code:
- **V2 leveled pins** (§7) — `ProtectedRange.level` / `maxLevel`, honored by the picker and kv-stable;
- **the KV-cost model** (§4) — `render-offsets.ts` (`kvCost`), now the solver's exact perturbation measure;
- **the summary-tree substrate** (§3/§6/§11) — `summary-tree.ts`.

~~**Status:** Draft / design. Companion to `adaptive-resolution-design.md` (V1). Lands behind the
existing `foldingStrategy` flag; the greedy `flat-profile` stays default until this is validated.~~

---

## 1. Motivation

V1 adaptive resolution (`Picker` + `flat-profile` FoldingStrategy) is **monotonic**: a chunk's
`currentResolution` only ever increases ("memory-fading by construction", `adaptive/strategies/flat-profile.ts`).
Problems this causes in production:

- **Budget increases don't take effect.** When Tilde's compile budget went 100k→300k, her compiled
  context stayed at ~75k because flat-profile never un-folds; we had to manually wipe her
  `autobio:resolutions` state slot to force a refold from L0. Budget should self-adjust *both* directions.
- **Not best-fit.** Greedy single-step folding (`selectNextFold` returns one op per call) overshoots
  *below* the target (quantization) and leaves budget headroom unused.
- **Pinning is weak** — only pin-as-raw (`markDocument`/`pinRange`), no pin-at-level-k, effectively static.

**Goal:** reframe resolution as **best-fit frontier selection over the summary tree**, with **KV-cache
stability as a first-class term in the objective** (not a separate monotonic hack), supporting a
**dynamically changing pin set**.

---

## 2. Already in place (this is an extension, not a rewrite)

- `FoldOp` already has `'lower'` (un-fold) — `adaptive/folding-strategy.ts:88`, tagged
  *"V2; default V1 strategies don't emit this."*
- The `Picker` already **applies** `lower` — `adaptive/picker.ts:167`. Un-expansion is plumbed end-to-end;
  the only missing piece is a strategy that *emits* it.
- Pins/locks are already fixed constraints the picker honors — `pinRange`/`markDocument`/`lockChunk`/
  `ProtectedRange`/`lockedByAgent`; picker skips them (`adaptive/picker.ts:253, 298–301`).
- `compressionSlackRatio` is the crude, position-blind precursor of the KV-stability term (§4).

---

## 3. Problem formulation — optimal frontier selection (tree-knapsack)

Over the **foldable middle** (head + recent tail are fixed-raw, not foldable):

- Leaves = raw chunks (resolution 0).
- Internal node at level k = an L_k summary covering a contiguous chunk range (`sourceRange`/`parentId`).
- A **frontier** F is an antichain "cut": every chunk is covered by exactly one selected node — its raw
  leaf or some ancestor summary. Render: ancestor → recall pair, leaf → raw shard.
- Node n has token cost `tok(n)` and value `val(n)` (§5).

Choose F maximizing total value subject to budget + pins. This is **optimal tree pruning under a knapsack
budget** — polynomial via tree-DP (§6), *not* a hard CSP.

Constraints:
- **Budget:** `Σ_{n∈F} tok(n) + headTok + tailTok ≤ B·(1 − slack)`, B = compile budget.
- **Pins:** a pinned fragment fixes/bounds the cut through its range — pin-at-k (cut passes through that
  node), pin-raw (cut at leaves), pin-max-level (cut no higher than k).
- **Head/tail:** fixed raw within their windows.

---

## 4. KV-cache stability inside the objective

The decisive constraint, per design intent: *don't change KV unless the optimality gain outweighs the
cache loss.*

The compiled context is a token prefix; the provider caches the longest byte-identical prefix vs the
previous request. If F diverges from the previously-rendered frontier `F_prev` at message position p,
**every token from p onward is recomputed.** The cost is governed by the **earliest divergence position**
`d(F, F_prev)` — not by the number of changed nodes:

```
KVcost(F, F_prev) = tokens in the compiled context after position d(F, F_prev)
```

Changing a deep-old region (small d) is expensive (long invalidated suffix); changing near the tail (large
d) is cheap — and the tail is already invalidated each turn by appended messages, so churn there is free.

**Objective:**
```
maximize   Σ_{n∈F} val(n)  −  λ · KVcost(F, F_prev)
subject to budget + pins   (§3)
```

A re-solve that improves value by less than `λ · (invalidated suffix)` is rejected → the cached prefix is
preserved even when slightly suboptimal. `λ` tunes optimality ↔ stability. Monotonic flat-profile ≈ `λ→∞`
on lowering + greedy raising; V1 `slack` ≈ a flat, position-blind approximation of this term.

### 4.1 Longest-stable-prefix reformulation (makes it tractable + literal)

Because KV cost depends only on the earliest divergence `d`, the solve decomposes:

- For each candidate stable-prefix boundary `S` (a chunk/message boundary), **fix F = F_prev for positions
  `< S`** and solve the budget-optimal frontier for positions `≥ S` (a sub-tree-knapsack).
- Score(S) = value(best suffix frontier | prefix fixed) − λ·(tokens after S).
- Pick the `S` maximizing Score. Candidate `S` are few and cluster near the tail → cheap, incremental.

This is exactly "keep the cached prefix; only re-optimize the suffix, and only when worth it."

---

## 5. Value function (what "best fit" optimizes)

`val(n)` = information retained by rendering n vs its fully-expanded descendants.

- Marginal value of detail is **recency/importance-weighted** so budget is spent where it matters
  (recency kernel over chunk position × any salience signal).
- Recency weighting + the position-aware KV term jointly reproduce "memory fading" as a *budget-pressure
  continuum*: under pressure fold oldest/least-salient first; under surplus expand to fill — no one-way ratchet.
- Pins override: pinned-expanded → forces inclusion at level; pinned-folded → caps it.

Exact `val` is the main empirical knob (§9). Defensible v1: uniform value-per-token-saved × a recency
multiplier; refine against real chronicles.

---

## 6. Algorithm

Tree-knapsack DP per foldable region / bodyGroup:

- For subtree rooted at node n: `best[n][b]` = max value within budget b, choosing {emit n collapsed} vs
  {recurse into children, partition b}. Standard tree-DP; pseudo-polynomial in b — bucketize b, or use
  **Lagrangian relaxation** on a budget multiplier μ (drop the budget dimension; binary-search μ to hit B).
- Apply the §4.1 prefix split for the KV term: solve only the suffix region, anchored on `F_prev`.
- Pins: clamp the DP at constrained nodes.
- Output: target frontier → diff vs current `currentResolution` → emit the `raise`/`lower` ops the Picker
  already applies. Either a global-solve entry on `Picker.run`, or a `'best-fit'` FoldingStrategy whose
  `selectNextFold` walks toward the precomputed target.

---

## 7. Dynamic pins

- Pin set is mutable (agent- and user-driven), stored as `ProtectedRange[]`. Extend with an optional
  `level`/`maxLevel` to express pin-at-k vs today's pin-raw.
- Adding a pin in an old region forces divergence there → pays the KV suffix cost: the explicit, intended
  price of pinning. Removing a pin returns the region to the optimization (re-fold under stickiness).
- Re-solve triggers on pin-set change, budget change, or tail growth; §4.1 keeps each re-solve incremental.

---

## 8. Integration points (concrete)

- New `FoldingStrategy` `'best-fit'` — `foldingStrategy` is already pluggable
  (`'flat-profile' | 'oldest-first' | custom`, `types/strategy.ts`). Default stays `flat-profile`.
- `adaptive/picker.ts`: today a greedy `selectNextFold` loop applying one op until null. Add a global-solve
  mode — strategy returns a target frontier; picker emits raise/lower ops to reach it (both already applied).
- `F_prev` = the persisted `resolutions` map (already loaded/persisted: `resolutionsStateId`,
  `persistResolutions`, `autobiographical.ts`).
- Place the `cacheBreakpoint`/`cacheMarker` at the stable-prefix boundary `S` so the provider caches exactly
  the preserved prefix.
- Extend `ProtectedRange` with an optional level bound; add `pinAtLevel(id, k)` / extend `markDocument`.

---

## 9. Open questions / risks

- **`lower` path is V2/untested** — best-fit is its first real exerciser. Needs byte-faithful re-expansion
  tests (un-folding a recall pair back to raw shards) and cache-breakpoint correctness under un-folding.
- **Value function** (§5) is the principal empirical unknown — start simple, tune.
- **λ tuning** — optimality↔KV weight; express in "value-tokens per cache-token" and make it configurable
  (generalizes / replaces `compressionSlackRatio`).
- **Determinism** — picker must avoid `Date.now`/`Math.random` (the DP is deterministic).
- **Cost** — per-compile re-solve must stay cheap; §4.1 incremental split + Lagrangian budget handling keep
  it sub-ms for thousands of chunks.
- **Speculative production interplay** — un-folding to L_k needs that summary to exist (raising may request
  production via the existing `produce` path); un-folding to raw is always available (chunks retained).

---

## 10. Validation matrix

> Run **once against the complete (λ-on) system**, not as sequential release gates — see §11
> for build order and why this isn't phased.

1. Land `'best-fit'` behind `foldingStrategy`; flat-profile stays default.
2. **Unit:** tree-DP optimality on synthetic trees; pin/level constraints; KV-cost prefix preservation;
   `lower` byte-faithful round-trip.
3. **Integration:** replay Tilde's store at budgets 100k/180k/300k → self-adjusting fill *without* a
   resolution reset; a budget *drop* re-folds oldest-first; a mid-history pin invalidates only its suffix.
4. **Cache:** across simulated turns with a growing tail, assert the stable prefix length matches §4.1 and
   breakpoints land at `S`.
5. Promote to default once parity + cache behavior are validated on Lena/Cairn/Tilde.

---

## 11. Implementation scope & build order

Built as **one unit behind `foldingStrategy: 'best-fit'`** (flat-profile stays default — the flag is
the rollout boundary, so no phased *release* is needed for safety). Deliberately **not** split into
shippable phases: a best-fit solve without the `λ·KVcost` term (§4) is not a state anyone runs, and its
acceptance criteria are invalidated the moment λ lands — so phase-gating would mean authoring and then
discarding integration tests for a configuration that never ships.

### Build order (bottom-up; each pure module unit-tested as written)

1. **`SummaryTree` view** over existing data — children from `SummaryEntry.sourceIds`, `tok(n)` from
   `.tokens`, ranges from `.sourceRange`/`parentId`. A typed view, not new persistence (the tree is
   already navigable).
2. **Rendered-token offset accounting** — `render.ts` only does byte-faithful reconstruction
   (`concatBodyGroups`/`getRecallText`); it does **not** expose per-emit rendered-token offsets. Add a
   small pass: rendered tokens per emitted unit (raw shard → `rawTokens`; recall pair → summary `.tokens`
   + pair-header overhead) in frontier order → cumulative offsets. Required for KVcost suffix sums (§4.1).
3. **Value function** (§5) — recency-weighted `val`-per-token-saved, pluggable, with a **salience hook**
   seam (unused this iteration; the CM fills it next — see below).
4. **Tree-knapsack DP** (§6) — `best[n][b]` collapse-vs-recurse; Lagrangian on a budget multiplier μ to
   drop the budget dimension. Deterministic (no `Date.now`/`Math.random`).
5. **KVcost / longest-stable-prefix** (§4.1) — earliest divergence `d` vs `F_prev`; score each candidate
   boundary `S`; pick max. `λ=0` is a **dev-time isolation knob** (debug DP optimality separately from the
   KV term), never a shipped phase.
6. **Frontier → ops diff** — target vs `currentResolution` → ordered `raise`/`lower`/`produce`.

### Integration — strategy-walk (no picker change)

Implement `'best-fit'` as a `FoldingStrategy` that **global-solves once, then walks**: on the first
`selectNextFold` (state == `F_prev`) it runs the DP, memoizes the target frontier, and thereafter emits
one op per call toward it, returning `null` when reached. `Picker.run` already applies `raise`/`lower`
(`picker.ts:167`) and records `produce` (stops + retry), so **no picker change is needed**; un-fold-to-L_k
where the summary is missing routes through the existing `produce` path. (Alternative: a parallel
global-solve entrypoint on the picker — more invasive; avoid unless the walk proves awkward.)

### Interface extensions (additive, behind the flag)

- `BestFitConfig` (λ, value-fn params) on `FoldingBudget` or the strategy ctor.
- `F_prev` snapshot captured at run start (the strategy's first `selectNextFold`).
- `ProtectedRange.level` / `maxLevel` for pin-at-k (data only; the picker already skips pinned).
- `cacheBreakpoint` placed at boundary `S` in the render / `autobiographical` layer.

### Testing

Unit-test the pure modules as written (DP optimality on synthetic trees; KVcost prefix math; `lower`
byte-faithful round-trip — best-fit is its first real exerciser). Then run the §10 matrix **once** against
the complete λ-on system. The "budget increase still self-adjusts at the chosen λ" check is a test in that
suite — it guards the load-bearing risk that too-high λ silently reintroduces the V1 "budget increase has
no effect" bug.

### Context Manager (CM) instance — next iteration, not this one

V2 best-fit is the deterministic **mechanism**; a CM agent is the LLM **policy** that decides what to
pin / unfold / weight. The CM op vocabulary (`UNCOMPRESS` / `REFOLD` / `MARK_DOCUMENT`, PIN/UNPIN) maps
directly onto this mechanism (lower-to-raw / raise / pin-raw / pin-at-k), so V2 *is* the substrate the CM
drives: build the substrate first, define the seams, add the controller next. Two **CM-ready seams are
added now** (cheap now, expensive to retrofit): `ProtectedRange.level`/`maxLevel` (pin-at-k vocabulary)
and the salience hook in `val(n)`. Everything else the CM needs is already plain data it can emit.

---

## Appendix — relation to V1

| V1 (flat-profile)                          | V2 (best-fit)                                            |
|--------------------------------------------|----------------------------------------------------------|
| Monotonic; raise-only                      | Bidirectional; raise + `lower` (already plumbed)         |
| Greedy single-op, overshoots below target  | Global DP, optimal fill under budget                     |
| `compressionSlackRatio` = flat hysteresis  | Position-aware KV term `λ·KVcost`, longest-stable-prefix |
| Budget change needs manual resolution wipe | Budget change self-adjusts                               |
| Pin-as-raw, static                         | Pin-at-level-k, dynamic set                              |
| Fading = one-way ratchet                   | Fading = budget-pressure continuum (recency-weighted)    |
