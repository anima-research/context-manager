# KV-stable context control

Status: implemented. `KvStableStrategy` is selectable via
`config.foldingStrategy: 'kv-stable'`; the controller core (`kv-control.ts`) is
measured via `kv-replay` and the real-`ContextManager` harness
(`scripts/replay-strategy.ts`). The earlier half-life/λ best-fit solver
(`value-function` / `best-fit-solver` / `stable-frontier` / `BestFitStrategy`)
has been **removed** — it was a stepping-stone whose sliding-half-life value
model caused the churn the λ term then fought (see "Why this exists"). The
production baseline is now `flat-profile`; the playground compares it against
`kv-stable`.

## Why this exists

The adaptive context manager re-renders the prompt every turn as the
conversation grows into a fixed window. Each re-render that changes the
*prefix* invalidates the provider's KV cache from the first changed token on —
and, because attention propagates, **alters the keys/values the actively
attended region is computed against**. So prefix churn is not just a cost; it
perturbs the model's working substrate (functional continuity; KV perturbation
is the measurable).

The previous design expressed stability as `maximize Σ value(n) − λ·KVcost`,
with `value` driven by a recency half-life. Measuring it on real sessions (the
`kv-replay` harness with a persistent Anthropic-style cache) exposed three
structural problems:

1. **The half-life is non-stationary.** `halfLife = fraction × newestSequence`,
   so the entire recency curve rescales every turn — the fold frontier it
   implies is a moving target, which *creates* the churn the λ term then fights.
2. **λ is a made-up exchange rate** between information and compute, and the
   measured optimum was data-dependent and non-convex (λ≳0.25 plateaued at a
   *worse* recompute equilibrium on Lena) — the tell of optimizing the wrong
   objective.
3. **Per-step value is myopic.** Deep folding is *inevitable and accumulates*
   under unbounded growth + fixed budget; a greedy "cheapest change now" policy
   defers it into one rare, catastrophic deep re-fold (max recompute and max KV
   shock). This is the log-structured-merge / generational-GC shape: the only
   real question is the *schedule*.

## The reframe: one objective, everything else a constraint

Stop trading terms. Pick one objective and make the rest a feasible set. Because
state carries forward (cache contents, current resolutions), this is a
**receding-horizon controller**, not a per-turn solve.

**Objective:** minimize real billed recompute — tokens after the earliest
divergence from the live cache, at provider price multipliers (miss 1.0,
cache-read ~0.1, cache-write ~1.25).

**Constraint hierarchy.** Exactly one hard wall; everything else is a *shaped*
soft constraint (penalty ≈0 while satisfied, steeply rising once exceeded — a
barrier, **not** a linear λ-trade, so no routine selling of continuity for
cost):

| level | constraint | hardness |
|------|-----------|----------|
| hard wall | rendered tokens ≤ **W** (physical context window) | inviolable |
| steep | **flat zone**: attended window raw + byte-stable (append-only) | yields last |
| steep | **P**: per-turn KV perturbation ≤ cap | soft (shaped) |
| mid | **pins / saliency floor**: per-chunk max fold depth | soft (shaped) |
| mid | operating **budget B** (< W; the W−B band is maneuvering slack) | soft target |
| soft | saliency floor for un-pinned content | softest |

The steepness ranking *is* the graceful-degradation order under a shock: who
bends first when the feasible set tightens.

### Why soft P, not hard P (recursive feasibility)

A hard P can produce an **empty feasible set** under a shock (a huge pasted
doc, a burst of pins, growth outpacing P): the only way under W needs more than
P of change, so "never exceed P" becomes a lie or W overflows. Standard
constrained-control fix: only the physical wall W is hard; P is a soft
constraint with slack and a steep penalty, so it behaves like a cap in normal
operation but **yields minimally** when feasibility demands. When even folding
everything to its cap can't fit under W, the situation is genuinely terminal —
escalate explicitly (the existing `OverBudgetError` seam) rather than thrash.

## State

The controller is a policy over state, not a function of the current turn:

- current frontier `F` (per-chunk resolution);
- **cache contents** (live prefixes + ages) — sets action cost (`CacheStore`);
- flat-zone position;
- accumulated per-level fold-debt;
- the **saliency field** (below).

## Saliency field (replaces the sliding half-life)

A stationary resolution-target field over sequence position, combining
heterogeneous sources, fed to the controller as a per-chunk **max fold depth**
(the finest requirement wins):

- **Recency** is an *edge* field, not a kernel, and **logarithmic in age**, not
  exponential: allowed fold depth ≈ `floor(log_k(age / flatZone))`, matching the
  base-`k` (mergeThreshold) summary geometry → scale-free (no half-life to
  tune), producing a self-similar raw→L1→L2→L3 banding. A **large enforced flat
  zone** (the attended window) is raw; folding begins, smoothly, only past it.
- **Pins / references / CM importance** are *localized* kernels (KDE-style
  superposition), smooth so the gradient around a pin tapers rather than cliffs.
  A reference is recency teleported: a recency-strength kernel at the cited
  position.
- Combine as a **max / soft-max (log-sum-exp) envelope**, not a sum — we want
  "the finest resolution any reason demands," capped at raw — and LSE keeps it
  C¹-smooth (the γ smoothness term becomes cosmetic).

## Scheduling: amortize the inevitable deep work

Cost of a change = tokens after its **earliest** divergence depth `d`.
Corollaries:

- Work *downstream* of `d` (positions ≥ d) recomputes anyway → **free** to flush
  in the same event. Work *upstream* moves `d` earlier → expensive.
- So: when you pay for a deep `d`, sweep all pending shallower deepening in
  `[d,end)`; never pay a deep `d` for only shallow gain.

The **soft P cap forces look-ahead for free**: deep work accumulates and can't
be executed in one turn under P, so a feasibility-preserving controller must
start deepening *early*, at ≤P/turn. Lead time falls out:
`begin when tokens > B − growth_rate × (work_to_do / P)`. Greedy isn't merely
suboptimal under P — it's infeasible.

Note the convergence: bounding the *maximum* divergence depth per event is good
for **both** axes — it caps worst-case recompute *and* worst-case per-turn KV
lurch (convex/variance continuity loves a bounded max). The cost↔continuity
opposition is only about baseline small-vs-large folding; on deep scheduling
they agree.

Consequently **base-`k` is not imposed — it emerges and bends.** Nothing applies
a fixed cadence; the controller deepens when cost-min-under-constraints says to.
Pins live in the feasible set → deepening routes around them. Cache lives in the
cost → a still-cached deep prefix (revert) is cheap to return to. Base-`k` is
only the optimum when costs are uniform and there are no pins.

## Prototype (this repo)

`src/adaptive/kv-control.ts` implements a tractable first cut:

- **Hysteresis band [LW, HW]** as the controllable knob (band width ≈ the
  frequency/amplitude operating point): append every turn; when tokens exceed
  HW, shed down to ≤ LW; otherwise do nothing (pure append, zero perturbation,
  full cache hit). HW ≤ B keeps slack to W.
- **Shed = oldest-first, leveled** (L1 groups, then L2, then L3), each chunk
  capped by the saliency field, never the flat zone or pins — base-`k` grouping
  driven by budget, not a clock.
- **W hard wall + escalation** when caps can't fit under W.
- **`replayControlled`** runs it over a session with the persistent `CacheStore`,
  reporting per-turn `recomputed`, `cachedTokens`, `perturbation`
  (= recompute beyond genuinely new content), plus `maxPerturbation` and
  `rmsPerturbation` — the continuity axis.

Sweeping band width traces the **cost-vs-continuity frontier** (total billed
recompute vs max/RMS per-turn perturbation), benchmarkable against the current
`solveStableFrontier` swept over λ.

### Not yet (future work)
- Adaptive HW from a value-to-go on remaining slack (true recursive-feasibility
  insurance) instead of a fixed band.
- LSE saliency with reference/CM-importance kernels (prototype uses log-age +
  flat zone + pins).
- Real cache-write premium in the billed figure; explicit multi-step lookahead.
