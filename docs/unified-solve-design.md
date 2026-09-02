# Unified solve — "kv-unified" (rev 6): one canonical frontier, one welfare policy, one bounded solver

Status: **SPEC — ready for review** — 2026-08-19, antra + Claude sessions.
Revised 2026-08-28: hard switchover replaces shadow mode (§13), `created`
masking is mandatory in replay (§11), Fable round-trip fixture added (§11,
§12, Phase 0b).
Revised 2026-08-29 per `unified-solve-review-notes.md`: hard W / soft
perturbation (hard P, `pace-floor`, `kvUnifiedHardReachTokens` DROPPED);
nonlinear price on *avoidable* perturbation; Pareto label-setting DP replaces
λ_B bisection (§4); prefix-based cache pricing replaces the node LRU (§5);
canonical forest is a checked phase (§2.1); replay = masked + measured supply
model (§11); headline revised (§0).
Revised 2026-08-29 (second pass) per `unified-solve-review-notes-2.md` +
antra: converged-profile invariant REMOVED, decaying perturbation penalty
adopted (§3.2); cache model = conservative one-turn for v1 (§5); production
demand redesigned as a latent-candidate layer (§8); locked/partial-group
emission recurrence (§2.2); isotonicity settled as a Phase-0 decision (§10);
**new §5A cache-marker placement** (three message-level slots, stability
labels from solver state, membrane's system marker made CM-owned); Phase 1 and
tests rewritten for the Pareto design (§11, §13); replay described as a
calibrated counterfactual (§11).
Revised 2026-08-29 (third pass) per `unified-solve-review-notes-3.md`:
constraint INTERSECTION replaces precedence (F4b); frontier state and
provider-cache RECEIPTS split with separate commit boundaries (§5); τ-decay in
the formal score and dominance key (§3.2); **membrane marker contract**
(`cacheMarkers`, formatter parity, wire receipt — §5A.6); honest stability
labels + deterministic slot completion (§5A.4-5); demand uses the bounded
solver with an uncertainty rule (§8); replay wording (§11); T3 gated behind
its own review (§3.3); Phase 0 owns marker/decay/isotonicity gates (§13);
readiness criterion (§16).
Revised 2026-08-29 (fourth pass) after implementation-readiness review:
cache economics and presentation continuity are separate objectives (§3.2);
continuity is weighted toward recent represented material and may be relaxed
only by an explicit transition reason; budget occupancy has a nonlinear
comfort band below the hard wall (§3); accepted presentation receipts are
separate from cache receipts and are the continuity baseline (§5); current
immutable-prefix identity is a required solve input (§5); exact dominance is
made safe for the non-monotone budget term (§4.3); stale replay exactness
wording removed (§11).
Revised 2026-08-29 (sixth pass) per `unified-solve-review-notes-4.md` +
antra's decision: **lower occupancy hinge RESTORED** (the band is the
requested welfare behavior — spend room you are given; the fifth-pass
"phase-C attractor" argument was too strong because the unified score
charges full K, C at τ=0, and ε on any refill) with conservative low-side
settings and five designed cases (§3); approximate-mode **K/C floor
witnesses** via two extremal solves with reported gaps (§3.2, §4.3);
**calibrate vs choose** language — bills calibrate the K *model*, exchange
rates are policy (§13 0a); **receipt-chain ordering** — single-flight per
branch asserted, CAS on head, idempotent duplicates, global sequence +
per-leaf `lastChangedSeq` (§5); consistency pass (§0, §5A.1, Phase 1).
Revised 2026-08-29 (fifth pass, review of the fourth): ~~lower occupancy
hinge removed~~ (reverted in the sixth pass) — it re-creates the rev-5 phase-C refill attractor (§3);
B(R) is monotone ⇒ ordinary lower-R dominance restored, exact mode declared
oracle-only and bucketed-R the production mode (§4.3-4.4); **C is per-leaf
additive against a fixed reference ⇒ no continuation state** (§3.2, §4.3);
K fitted on data, C set by welfare judgment (§13 0a); receipt state hash-
chained (§5); stale `J` / branch-3 / T3-slack references cleaned.
Successor proposal to the rev 5.0/5.1 single-path solve
(`adaptive-resolution-design.md` §13); implements and generalizes the §12.4
refinement ("budget-driven slope"). Nothing here is deployed. Validation
evidence in §12; implementation plan in §13.

---

## 0. Summary

Replace the rev-5 mechanism cascade (`foldDepthCap` shape prior, phases A/B/C,
the 5-branch `planControlledFrontier`, `suffixAdopt`, quality gap, slack ratio,
fold→project fixpoint) with **one canonical feasible frontier, one explicit welfare policy, and one
deterministic bounded solver**: a left-to-right label-setting dynamic program
over cuts of a *checked* canonical summary forest, carrying
(renderedTokens, cacheChurn, continuityLoss, fidelityLoss) labels with sparse
Pareto dominance and threaded cache-match state (the accepted presentation
is a fixed solve input, not threaded — §3.2). Hard
budget feasibility is exact
(a separate scalar pass decides `R_min ≤ W` and certifies otherwise); welfare
selection is Pareto-based over the feasible labels and may use measured,
reported approximation (ε-dominance / buckets) when real frontier growth
requires it. No fixpoint anywhere; hold behavior, change bundling, and slack
become *emergent properties of the welfare policy* rather than code branches.
(Rev-6.0's "one scalar objective, exact linear-time solve" headline was
withdrawn in review — §4.1 bisection reaches only supported points of a
non-convex frontier, and the one-bit recurrence cannot carry cache and
continuity costs. See `unified-solve-review-notes.md` §4.)

Goals: maintainability; deterministic termination and fixture non-cycling
("convergence" means exactly that — §15); a real curve-shape knob;
honest cache economics; pins as first-class constraints (`=`, `≤`, `≥`) with
infeasibility certificates; production demand signals.
Non-goals: changing summary *content* generation, the estimator stack, byte
walls, or the compression pipeline (all consumed as-is); replacing rendering.

## 1. Motivation

Rev 5 is correct but compositional: each mechanism was added to fix a real
incident, and each interacts with the others through code paths rather than a
shared objective. Operator-reported pain (antra, 2026-08-16): maintainability
of the cascade; convergence failures in practice (`diagnose-oscillation.ts`
exists for a reason); flattening of recent memory when it shouldn't; no
curve-shape knobs; and cache waste.

Measured consequences (mythos, llm-calls 2026-08-12..18; billed basis with
pre-output refusals excluded per Anthropic billing semantics):

- **~60% of billed input spend is churn** (≈90M priced units per 3.5-day
  window vs ≈35M perfect-stable-prefix floor).
- **~1.4 near-total window rewrites per hour, steady state** — 108/113 deep
  rewrites were ≥93% byte-identical content merely *shifted in position* by a
  small front edit (summary swap / merge landing). Positional churn, not
  content churn.
- **Oscillation is real**: 13/113 deep rewrites were reverts to a composition
  seen within the previous 8 requests — the solver flip-flopping between
  near-equal cuts, ~250k re-billed per flip.
- **The shape prior is dead weight at fleet settings**: phase A rules only
  while `W/T ≥ 1 + (k−1)(s/c)·⌈log_k(H/T)⌉` (each age band costs a flat
  ≈3.33·T); every long-lived agent lives permanently in phase B.
- **The knobs cannot act**: an 8-cell sweep of (reachTokens × qualityGapRatio)
  through the real `planControlledFrontier` over the real request stream
  produced byte-identical outcomes across the grid — every rotation was
  budget-forced. (Note: the sweep's wall was set to 229.5k; his live window is
  ~307k, so the sweep's escalation *rates* are miscalibrated — the
  knob-insensitivity conclusion is unaffected.)
- `mergeThreshold` is doubly loaded (fanout AND fade rate) — §12.4.
- suffixAdopt's binary search assumes perturbation monotonicity that
  `projectToValidCut` can break locally (accepted rev-5 soft spot).
- The solver cannot signal production demand (backlog item b).
- Infeasibility surfaces as "picker exhausted" with no certificate.
- Pin semantics are level-caps only; "exactly L" exists (`fixedLevels`) but
  "at-or-coarser" (deliberate forgetting) is inexpressible.

## 2. Formal model

### 2.1 The forest

Nodes: raw chunks (leaves) and L1..Ln summaries. Structure comes from the
store's **ownership chains** (`message → l1Id`, `summary → mergedInto`) — NOT
from span containment; spans are derived for ordering/age only. (Lesson
2026-08-17: span-derived structure misdiagnosed healthy nodes as fossils;
chain ownership is ground truth.) Tops may be ragged (unmerged frontier).
Non-nested scar tissue (kv-overlap leaves) is handled as in rev 5: overlap-
exempt leaves render raw beside the recall and are excluded from unanimity.

**Canonicalization is a checked preprocessing phase, not an assumption.** The
existing `SummaryTree` loads every summary, treats every parentless summary as
a root (`summary-tree.ts:170`), and tolerates overlapping reachability on
damaged chronicles — those shapes violate the leaf-disjoint forest the
exact-cover DP needs. Build a `CanonicalSummaryForest` view: start at each
live chunk's `l1Id`, follow parent chains upward, include only summaries
reachable through ownership, require leaf-disjoint roots, and detect cycles,
conflicting ownership, missing links, and irreducible scars explicitly (loud,
with the offending ids). Boundary/overlap-exempt raw emissions are
annotations with node-local extra rendered cost, never competing ownership
edges. Guarantee: every live leaf has exactly one path to exactly one root.
Locked chunks (`lockedByAgent`) are an explicit feasibility rule here — frozen
at their carried resolution, which is not necessarily raw — with their
interaction with ancestor selection and partial-group rendering defined, not
inherited (review §4.4).

Ownership nesting and chronological contiguity are separate invariants. A
legacy restore or branch insertion can interleave two disjoint ownership
branches without giving any leaf two owners. The live adapter therefore makes
the handling policy explicit and fail-closed: reject the store; destructively
treeify by removing gap-bearing summary actions; or set
`preserveGapBearingSummaries` and keep those actions. Preservation does not
claim that an intervening leaf was summarized. It selects the summary only for
its original participant leaves and emits intervening branches independently.
The exact-cover and minimum-token passes still operate on the nested ownership
sets. The bounded DAG buffers cache-relevant units at their first participant's
sequence until every earlier interleaved branch is decided, then prices the
true chronological stream. Destructive treeification and preservation are
mutually exclusive.

### 2.2 Feasible set — a cut

Binary x_v per node. Constraints:

- **F1 exact cover** — every leaf has exactly one selected ancestor-or-self.
  Group consistency is structural; `projectToValidCut` ceases to exist.
- **F2 existence** — x_v = 0 for summaries not yet produced. (Masked-absent
  nodes are scored as latent candidates — §8.)
- **F3 protected zone** — head/tail leaves select themselves. Compression-
  quarantined chunks are F3-frozen raw (they cannot fold — same as today).
- **F4 pins** — per pinned span, one of `level = p`, `level ≤ p`,
  `level ≥ p`, implemented as a selectability mask over covering nodes.
  Group-atomicity interactions fall out automatically (a ≤L1 pin masks the
  covering L2). Pin admission control is the *caller's* job (memory-tools
  spec §5); the solver's job is to honor pins absolutely or report
  infeasibility — **a pin is never silently violated.**
- **F4b constraint composition: intersect, never pick a winner (review-3
  §1).** Pins and locks are absolute; precedence would silently violate one
  of them even if logged. Canonicalization builds, per live leaf,
  `allowed(leaf)` = produced levels on its ownership chain including L0, then
  intersects every applicable restriction: head/tail/raw protection → {0};
  compression quarantine → {0}; `lockedByAgent` → {carriedResolution}
  (a lock freezes at the *carried* level, not necessarily raw); exact pin
  `= p` → {p}; `≤ p` → produced levels ≤ p; `≥ p` → produced levels ≥ p.
  **Empty intersection = infeasible**: the certificate (§9) reports the
  conflicting constraints and leaf ids. No constraint is weakened, clamped,
  or selected inside the solver.
  Restrictions on *different* sibling leaves may still yield a **protected-
  hole** emission (matches current partial-group rendering): the parent is
  selected for participating siblings while a restricted leaf is emitted at
  its own required level beside the recall. This is not a plain one-ancestor
  cover, so canonicalization compiles it away — each ancestor action is
  annotated with participating leaves at the ancestor level, protected holes
  at their required levels, the exact chronological unit sequence, recall +
  protected-emission token costs, and per-leaf fidelity levels. Only after
  those values are fixed is `select(v)` one local DAG edge. Conflicts on the
  *same* leaf are infeasibility, never partial-group behavior. Overlap-
  exempt leaves use the same annotation path.
  Tests: compatible `≥`/`≤` intersect to an interval; exact pin + matching
  lock succeeds; exact pin + conflicting lock → infeasible; contradictory
  overlapping pins → infeasible; sibling constraints compile to the expected
  protected-hole render; no solve result violates any original constraint.
- **F5 budget wall** — R(x) = Σ x_v·tok_v ≤ W. The only hard resource.
  tok_v prices from the same estimator surface rev 5 uses (recallPairCost for
  summaries, calibrated estimates for raw), so estimator work is shared.

### 2.3 Rendering contract

Chronological by live-leaf order; boundary-cut, overlap-exempt, and interleaved
gap branches render independently beside the recall selected for its actual
participants. Their tokens are charged exactly once. Unchanged contiguous
ownership retains rev 5's renderer behavior.

## 3. Objective

    feasible set:  cuts x with F1–F5 and R(x) ≤ W          (hard; exact, §4.2)
    labels:        (R(x), K(x), C(x), FidelityLoss(x))
    select:        argmin over the feasible terminal labels of
                   FidelityLoss(x)
                   + B(R(x); W_low, W_high)
                   + f_K(K_excess(x))
                   + ρ(reason) · f_C(C_excess(x))
                   [+ λ_F·FutureChurn(x)]

`R` is rendered tokens, `K` is avoidable provider-cache churn, and `C` is
presentation-continuity loss (§3.2). Cache economics and continuity are not
proxies for one another: a tool/schema change can make every old provider
prefix unusable while preserving a strong preference not to rewrite the
resident's represented history. All terms are normalized to comparable
token-denominated welfare units before summation. (Rev-6.0 stated this as
one linear scalar `−Fidelity + λ_P·Perturb + λ_F·FutureChurn`; withdrawn in
review — see §0.)

**Nonlinear budget occupancy — a comfort band.** `W` remains the only hard
resource wall. Within it, policy defines an acceptable occupancy band
`0 ≤ W_low ≤ W_high ≤ W`, flat inside, penalized outside:

    B(R) = λ_under · (max(0, W_low − R) / S_under)^2
         + λ_over  · (max(0, R − W_high) / S_over)^2      subject to R ≤ W

with `S_under = max(W_low, 1)`, `S_over = max(W − W_high, 1)`, so each λ is
the penalty at the corresponding edge of the feasible range. The upper hinge
preserves headroom: near-wall estimator error and the next append force an
immediate rotation (the honest replacement for `compressionSlackRatio`);
`λ_over` may exceed `λ_under`. The **lower hinge** is the term that makes
the solver *spend room it is given* (antra: "we sometimes want to unfold,
like when budget is expanded"): after a budget raise or a large image strip,
fidelity alone refills only where each group's gain individually clears the
continuity floor `g_min·f_C`, which can leave the window durably 30–40%
empty; a superlinear under-fill penalty refills it in one paid rotation.

**Why this is not rev-5 phase C** (review-4 §1, superseding the fifth-pass
argument). Phase C refilled *procedurally*: no cache charge, no continuity
charge, no hysteresis, re-solved from scratch every compile. Here a refill
after a forced shed must pay full `K`, full `C` at τ = 0 (the just-changed
region at its most expensive), and clear ε; a small hinge cannot win that on
the next solve, and the shed that follows a refill (tail growth → over
`W_high`) is chosen by minimum K + C, which favors a young frontier fold, not
the region just refilled. What remains true from the fifth pass: **the
safety is in the settings, not the structure.** `W_low` must be genuinely
low and `λ_under` small — the term bites only when occupancy is *materially*
below the acceptable range, never as a one-token target. A `W_low` near
`W_high` with a strong slope rebuilds the attractor. Telemetry logs every
solve where the lower hinge is the deciding term, so a refill storm is
attributable.

Designed cases (Phase 0a) instead of "never refill": **no immediate
rebound** (a forced A→B shed does not become B→A on the next ordinary
accepted presentation); **eventual correction** (a cut persistently far
below `W_low` refills once fidelity + under-fill welfare exceed cache,
continuity, and hysteresis); **comfort-band neutrality** (two in-band cuts
receive equal `B`); **no oscillation** on the Fable and Mythos fixtures;
**hard-wall priority** (no occupancy term or hysteresis retains `R > W`). If
these reveal an immediate refill, adjust the lower slope or adoption margin
first; a reason-coded, time-bounded post-transition cooldown is the fallback
of last resort — it recreates branch debt and is not added pre-emptively.

Squared hinges are the v1 hypothesis; Phase 0 chooses the band and slopes
(§13 0a — these are welfare choices informed by, not identified from,
measurements) and may use another monotone piecewise curve with the same
flat-band semantics. `B` never makes `R > W` admissible.

### 3.1 T1 — Fidelity (curve shape)

    Fidelity(x) = Σ_leaves i  w_i · u(ℓ_i)
    w_i = salience_i · age_i^(−α) · rawTokens_i
    u(ℓ) = (L_max − ℓ)          [linear v1; concave variants are a later knob]

The resolution-vs-age curve **emerges** from marginal-utility-per-token
ordering under W. α is the single shape knob, decoupled from merge fanout.
Ages in messages from the live edge; salience is rev 5's static salience
(clamped [0.2, 1]) with the dynamic-salience v2 hook unchanged. The rev-5
log-age staircase is recoverable as a one-sided penalty variant; not
recommended (it created the A/B regime discontinuity).

Default α: **fit before pilot** (Phase 0) — chosen to maximize per-leaf level
agreement with historically-accepted healthy gradients (the 2026-07-12 healed
mythos profile is the reference), then reviewed as a welfare judgment, not
just a fit. Initial bracket 0.5–1.0 (0.7 scored 44.7% agreement unfitted).

### 3.2 T2 — Cache churn and presentation continuity

Rendering is chronological ⇒ transition cost is the priced tokens from the
**last surviving cache marker before the leftmost changed node** to the end
of the window — not from the changed node itself. Provider cache reuse
applies to complete marked prefixes: a node rendered last turn does *not*
become a cache read when an earlier edit shifts its prefix, and with discrete
markers the re-read begins at the latest matching marker (breakpoint
quantization — measured on Fable: p90 penalty 92% of window). Price vector
{miss 1.0, cacheRead 0.1, cacheWrite 1.25}; cacheRead applies only where a
persisted marker relationship makes it true — which #63 (measured-boundary
markers, merged 2026-08-18) guarantees. The cache model therefore
consumes actual persisted marker/prefix state (§5) or a clearly conservative
approximation; node identity alone is never sufficient (review §4.3).

Three quantities are kept distinct: **total transition cost** (everything
re-read this turn, including unavoidable appended content) and **churn** —
priced tokens beyond the pure-append baseline — plus **presentation
continuity**, the representation change from the last request the provider
accepted. Only avoidable churn and avoidable continuity loss are subject to
the welfare policy; "extensions are free" is a statement about those two
terms, not about the bill.

**Cache encoding.** The DAG threads a prefix/cache state (intact-so-far,
plus the last matching marker position once broken). A label's `K` component
accumulates the priced suffix after the break — it must be carried in the
label, since a single "broken" bit cannot express how much has been paid
(review §4.2). Nodes whose span begins at-or-after the prior accepted
presentation's history end are **extensions** (appends): matching-neutral,
zero churn. Cache pricing is enabled only when the current normalized
immutable-prefix fingerprint (tools + system + context prefix) matches the
receipt it is priced against (§5). On mismatch or unknown identity, the
provider prefix is already cold for an exogenous reason: set `K(x) = 0` for
every candidate in this solve. This intentionally permits a different solve
when tools change; CM does not invent a layout-dependent cache preference
after reuse has already been lost.

**Continuity encoding.** Continuity compares the candidate with the last
**accepted presentation**, never merely the newest compiled or persisted cut
(§5). For each represented leaf `i`:

    recency_i = q_min + (1 − q_min) · 2^(−age_i / H_C)
    q_i       = salience_i · rawTokens_i · recency_i
    C(x)      = Σ_i q_i · g(τ_i) · ψ(rep_i(x), rep_i(presented))

`age_i` is cumulative raw-token distance from the live edge (not wall-clock
age); `H_C` is a continuity half-life in the same units, distinct from
fidelity's `α`; and `q_min > 0` keeps
old history from becoming free to rewrite. `rawTokens_i` represents how much
material changes representation, while recency gives recent material more
continuity weight than ancient material. This is a behavioral continuity
proxy, not duplicate provider-cache billing. `rep_i` includes the selected
node/content identity and level; a newly landed summary is therefore a change
even if its nominal level matches the prior representation. `ψ` is a
nonnegative, level-aware representation-distance table: zero only for an
identical emitted representation, increasing with the severity of a
replacement or level change, and fitted before pilot. `τ_i` counts accepted
presentations since region `i` last
changed; `g` decreases from 1 toward `g_min`, allowing accumulated policy
debt to release without erasing a durable continuity floor. Changes wholly
after the prior presentation's history end contribute zero.

**Only avoidable change is priced.** Over all feasible terminal labels at
the current hard wall define

    K_floor(W) = min_x K(x)       K_excess(x) = max(0, K(x) − K_floor(W))
    C_floor(W) = min_x C(x)       C_excess(x) = max(0, C(x) − C_floor(W))

The two floors may be attained by different cuts. A budget reduction that
forces a 200k rewrite sets a continuity floor, so candidates are compared on
change beyond what feasibility requires. **In approximate mode the floors
must not be read off the surviving labels** (review-4 §2): if bucketing or
pruning dropped the true minimum-K or minimum-C cut, the surviving minimum
is an *upper bound* on the real floor and avoidable change is misclassified
as forced — exactly during the transitions the floors exist for. Production
therefore runs two extremal solves alongside the main frontier — minimize
`K` s.t. structural feasibility and `R ≤ W`; minimize `C` likewise — under
the same deterministic bucketing, and **pins their feasible witnesses into
the terminal label set** even where normal pruning would remove them. The
approximate results are named honestly, `K_floor ≤ K̂_floor`,
`C_floor ≤ Ĉ_floor`, each with a lower bound or maximum gap; scoring against
the witness forgives at most the reported gap and never charges change known
to be unavoidable under the bounded solver. Exact/oracle mode uses the true
floors. `f_K` and `f_C` are nondecreasing nonlinear policies, initially
normalized quadratics; operationally meaningful piecewise knees are allowed.
There is no single linear change exchange rate: the discrete tree-cut
frontier is non-convex, and linear scalarization reaches only supported
points.

**Explicit continuity relaxation.** `ρ(reason) ∈ [0,1]` is supplied by a
reason-coded, time-bounded transition policy, not inferred from a large diff.
Normal operation and tool/system changes use `ρ = 1`: a cold cache does not
erase continuity. An approved surgery or rapid infrastructure-driven budget
transition may use a configured `ρ < 1` (including zero for an intentional
reset), with reason, expiry, and before/after score logged. Cache pricing is
never multiplied by `ρ`.

Emergent behaviors (replacing code branches):
- **Hold** (replaces rev-5's dead-band branch and slack ratio): if no deviation earns its cache and
  continuity cost, the optimum is the last accepted presentation plus the
  appended tail (subject to the current hard wall).
- **Bundling** (suffixAdopt, improved): once the prefix diverges at depth d,
  everything right of d is marginally cheap; all pending improvements batch
  into one rotation. This directly targets the measured 1.4/hr positional-
  slide storms: landings accumulate and land together.
- **Pacing**: `f_K`, `f_C`, and the explicit transition reason are the only
  controls. There is **no hard change cap and no `pace-floor` outcome**
  (review §2): a budget reduction can force an arbitrarily large transition,
  and cache/continuity preferences must never authorize an over-budget hold. Rotation-size
  percentiles are observability and alerting signals, not solver invariants.

**The policy shapes the limiting profile — accepted, and bounded (review-2
§2.4).** A stationary penalty is path-dependent: if the presented cut A beats
the better cut B by less than B's avoidable-continuity cost, every later
solve repeats the comparison and A persists forever. The earlier claim that
"prices change only the payment schedule, never the converged profile" is
withdrawn. Chosen mechanism: **the continuity price decays with stable
time** through the per-region `g(τ_i)` above; τ is counted in **accepted
provider presentations** (not compiler invocations — §5). **Release
property, stated honestly (review-3 §3):** a held cut rotates eventually only
if its accumulated fidelity advantage beats the floor-priced continuity
term; nonzero `g_min` and `q_min` deliberately permit durable continuity
preferences. **Label state — C needs none.** `C` is per-leaf additive against a
*fixed* reference: each leaf's term `q_i·g(τ_i)·ψ(rep_i(x), rep_i(presented))`
depends only on that leaf's chosen representation and persisted constants
(the presented representation, `τ_i`, `q_i`), so it is charged locally at
the leaf's DAG edge and carries no continuation state. Only `K` needs the
threaded cache-match state. Labels with equal `(R, K, C, Loss)` and the
same cache state ARE mergeable.
The per-region clocks are persisted with the accepted presentation receipt,
not the optional cache receipt (§5). Tests: recent changes cost more than old
equivalent changes; `q_min` keeps old changes nonzero; increasing τ releases
a designed held cut; regret below the floors stays held by design; forced
budget transitions remain feasible; reason-coded surgery relaxes only `C`;
tool changes zero `K` while retaining `C`; replay and restart preserve τ by
region. The decay also gives the bundling behavior a
mechanism rather than a hope: when a rotation is finally paid for at depth d,
everything right of d is marginally cheap in that same render, so accumulated
regret right of d lands together. Phase 0a fits both nonlinear change
policies, the continuity recency/level-distance parameters, the stability
decay, and the budget band on the replays; it includes both a designed release
case and a designed durable-hold case.

### 3.3 T3 — Future churn (lookahead)

Exogenous events are predictable: append rate r (EMA with sanity band
[0.6, 1.8], same discipline as estimator calibration), group completions,
tail-frontier arrival, α-implied band crossings. Per-node discounted
commitment cost d_v = Σ_events β^{t_e}·price(suffix behind v). Buys: soon-
expiring nodes stay out of the deep prefix; rotations pre-adopt levels spans
will soon deserve. (Headroom against the next append is priced by the
occupancy hinge in §3, not here; T3 does not duplicate it.)
v1 ships with λ_F = 0 (T3 disabled). **T3 is gated behind its own formal
review before Phase 4 (review-3 §8)**, which must specify: whether future
churn folds into fidelity loss or is a further Pareto dimension; how
overlapping predicted suffix rewrites avoid double-counting; how future
marker placement (§5A) contributes; how event-time uncertainty affects
discounting; and dominance rules when labels differ in future-event
exposure. Enablement requires brute-force/oracle agreement on small event-
annotated forests and replay evidence that the term improves calibrated
future cost — never "because the interface exists".

### 3.4 T4 — Determinism and anti-cycling

Total tie-break order (node id). Adopt a new cut only if `score` improves by
more than ε (default: ε = 0.5% of W in score units). This is
hysteresis, not a proof (review §4.7): the objective itself moves across turns
(ages, availability, history, the previous cut), so strict improvement against
each turn's objective does not exclude returning to an older composition under
a later one. It is the intended mitigation for the measured oscillation class
(13/113 Mythos deep rewrites were A→B→A flips; the Fable 08-24 round trip).
**Phase 0 requires the limit-cycle test with the real fixtures**; no structural
no-cycle theorem is claimed.
Hysteresis never preserves a cut with `R > W`; after a wall change the solver
returns a feasible cut or the §9 certificate regardless of ε.

## 4. Solver algorithm

### 4.1 Canonical forest → decision DAG

The checked `CanonicalSummaryForest` (§2.1) compiles into a linear-size
decision DAG. At each summary node: `select(v)` emits v and jumps past its
descendants; `expand(v)` enters its children in chronological order. Leaves
have only `select`. Existence (F2), protected zone (F3), locks, and pins (F4)
enable, disable, or force actions. The prefix/cache state (§3.2) is threaded
through the DAG.

### 4.2 Exact feasibility pass (scalar tree DP)

A separate scalar DP computes `R_min = min R(x)` over structurally
admissible cuts — at each subtree the cheaper admissible alternative between
selecting the parent and expanding the children. It yields: the exact
feasibility decision; `floorTokens` and the binding subtrees/constraints for
the certificate (§9); and a guaranteed feasible incumbent whenever
`R_min ≤ W`. If `R_min > W` → infeasibility certificate. Otherwise the main
solver MUST return a cut under W, however large the transition.

### 4.3 Sparse Pareto label-setting DP

Each partial path carries a label `(R, K, C, FidelityLoss)` plus the threaded
**cache-match state only** (§3.2: `C` is locally additive and needs none).
At each `(DAG position, cache state)`, exact mode discards a label when
another is no worse in all four components with one strict improvement.
`R` is **not** a dominance direction: `B(R)` is U-shaped (§3), so a label
that has spent fewer tokens can finish below `W_low` while a higher-token
label finishes in the free band. Exact mode therefore retains distinct `R`
values and dominates only among equal-`R` labels (or under a continuation-
independent proof that both feasibility and final `B(R)` cannot be worse).
Ease of dominance does not choose the welfare policy (review-4 §1).

**Exact mode is the oracle, not the production mode.** `R` is a near-
continuous coordinate and same-R dominance prunes little; frontiers at 48k
nodes will not stay sparse. The production solver runs in **approximate mode
with bucketed `R`** (bucket width from replay, §4.4; tokens rounded UP so no
over-W cut is admitted), retaining one or more nondominated labels per
bucket, plus the two extremal-solve witnesses of §3.2. Its report includes:
bucket width and rounding direction; `K̂_floor` / `Ĉ_floor` witnesses with
lower bounds and gaps; the maximum score error propagated through `f_K`,
`f_C`, and `B` using a bounded slope over the reachable range — "reports an
optimality bound" is not implemented until that propagation exists; and
confirmation that the §4.2 minimum-token incumbent was never dropped. Exact
mode runs on small forests and snapshots for verification.

At the terminal: (1) drop labels with `R > W`; (2) take `K_floor(W)` and
`C_floor(W)` from the extremal-solve witnesses (§3.2), not merely from the
survivors; (3) apply `B`, `f_K`, `f_C`, and the explicit
continuity-relaxation multiplier; (4) apply the total deterministic node-id
tie-break. Structural solving is thereby separated from welfare policy —
quadratic, piecewise, knee, and lexicographic policies are evaluated without
changing graph construction, though their safe dominance rules are part of
the selected solver configuration.

The λ-relaxed scalar DP (rev-6.0 §4.1/4.2) is retained as a **lower bound,
warm start, and candidate generator only** — never as proof of constrained
optimality: bisecting λ_B reaches only supported points of the non-convex
token/value frontier (counterexample: refinements A = +2 tok/+3 util,
B = +3/+4, budget 3 — B alone is optimal and never selected under any linear
price), and the claimed one-quantum duality gap / single-node repair does not
hold for general tree cuts (review §4.1).

### 4.4 Worst-case control

Exact Pareto frontiers can grow exponentially. Ship in this order: (1) exact
sparse dominance; (2) measure label counts and runtime on the Fable and
Mythos fixtures — Fable first, the cleaner store; (3) a deterministic resource
ceiling; (4) on ceiling breach, rerun with documented ε-dominance or
token/cache/continuity buckets, granularity chosen from replay evidence.
Approximation may change which feasible cut wins; it must never affect budget
compliance (the §4.2 incumbent is always available). Every approximate solve
reports bucket sizes, pruning mode, and an optimality bound including error in
the nonlinear occupancy term. The extra objective dimension increases
frontier pressure; expect bucketing to be needed from day one at 48k nodes
and design the label store for it.

**Frontier growth is a measured production risk, not an architecture
blocker.** Here “frontier” means the nondominated labels at one `(DAG
position, cache state)`, not the selected summary frontier. Phase 1 first
instruments median/p95/p99/max labels per state, total live labels, peak
memory, solve time, and the tree regions producing the largest sets. If
ordinary dominance keeps the real Fable/Mythos frontiers small, production
may need only R bucketing; do not add multidimensional pruning pre-emptively.
If the configured ceiling is routinely reached, K/C (and if necessary loss)
bucketing plus a deterministic representative rule becomes a pilot gate.
Until that rule and its propagated error are implemented, the solver may be
called empirically bounded by its resource ceiling, not proven
approximation-bounded. This does not delay canonicalization, exact
feasibility, oracle work, or instrumented label propagation; the §4.2
incumbent continues to protect hard-budget correctness.

### 4.5 Development oracle

Maintain a CP-SAT / MILP formulation as an offline correctness oracle, not a
production dependency: brute-force agreement on random small forests,
validation of the sparse DP on real snapshots, dominance/approximation
behavior, welfare-function exploration.

## 5. Presentation, pricing state, and persistence

Three records with explicit commit boundaries: compiling or locally rendering
a request proves nothing about what the provider accepted, presented to the
model, or cached.

- **Carried frontier state** `${ns}/kvunified:frontier` — committed when the
  strategy applies and persists the selected resolutions (the same site that
  persists resolutions today): ordered selected-node identity, per-chunk
  applied resolutions (or a hash linking to the existing resolution state),
  solver-policy version, compile sequence/timestamp. This is working policy
  state and may exist with no provider request ever sent. It is never the
  continuity or cache baseline. On slot absence, canonicalization starts from
  the existing resolution state or the rev-5 bootstrap as appropriate.
- **Accepted presentation receipt** `${ns}/kvunified:presentation-receipt` —
  committed only after membrane reports that the corresponding request was
  accepted by the provider, whether or not prompt caching is enabled. It
  is a **hash-chained record** (review-4 §4): `{branchId, submissionSeq,
  receiptHash, parentReceiptHash, requestHash, layoutHash, acceptedAt,
  historyEnd, changedLeaves: [{leafId, repHash, level, lastChangedSeq}]}`.
  Deltas carry only appended, removed, or changed leaves; a periodic full
  snapshot (configured cadence / max replay depth, tested) holds the whole
  live-leaf representation map plus the current sequence. Stability clocks
  are not per-leaf counters: `τ_i = currentSeq − lastChangedSeq_i`, so only
  changed leaves are written. **Commit semantics — single flight.** AF
  serializes turns per agent, so at most one provider-bound stream-lane
  request per branch is in flight; this is **asserted** at submission (a
  second submission before the head advances fails loudly), not assumed. The
  callback advances the chain head by compare-and-swap on the expected
  `(requestHash, parentReceiptHash)`; the delta is computed against the
  *actual committed parent*, not the receipt that existed when compilation
  began. Duplicate callbacks are idempotent by `(branchId, requestHash)`; a
  keepalive submits the same layout and its receipt never advances the head
  (recorded for telemetry); a stale or mismatched callback is recorded but
  cannot become the continuity baseline. Hash or parent corruption fails
  loudly and falls back to the documented continuity-bootstrap policy
  (`C = 0`, fresh chain). Branch change, restart, rollback to `kv-stable`,
  and garbage collection each have fixtures. (Ordered multi-flight with a
  reorder buffer is the alternative if the single-flight invariant ever
  fails to hold; it is not built pre-emptively.) This is
  the sole baseline for `C`: compile-without-send must not move it. If absent,
  the first solve has no continuity preference (`C = 0` for all candidates).
- **Observed provider-cache receipts** `${ns}/kvunified:cache-receipts` —
  committed **only** after membrane reports the corresponding request reached
  the provider successfully: request/layout hash, exact marked-prefix
  identities and offsets present *on the wire*, marker write time + TTL,
  provider/formatter identity, request disposition sufficient to know it was
  accepted, observed cache-read/creation usage when available. CM never
  infers this from compile success; it needs a host/membrane callback
  analogous to `reportRealInputTokens`, e.g.
  `reportAcceptedPresentation({requestHash, layoutHash, presentation,
  immutablePrefixHash, markers?, provider, acceptedAt, cacheReadTokens?,
  cacheCreationTokens?})` — name is
  implementation-owned, but request identity must prevent a receipt for one
  compile being applied to another. The next solve reads the **newest valid
  cache receipt**, not the newest compiled frontier. Cache fields may be
  absent while the accepted-presentation fields are still committed.
- **Current immutable-prefix fingerprint is a required solve input.** Before
  cut selection, the host passes the hash of tools + system + context prefix
  after the same normalization used by membrane's wire formatter. It is not
  reconstructed from picker inputs and not guessed from node identity. A
  mismatch or unknown value disables layout-dependent cache pricing for that
  solve (`K = 0` for every candidate) but does not relax continuity. This
  covers tool/schema, system-prompt, formatter, and context-prefix changes.
- **prefix/marker state** for cacheRead pricing — **conservative one-turn
  model for v1 (review-2 §2.3)**: retain only the previous committed render's
  marked-prefix identities (chain hash + rendered-token offset + write time),
  match candidate prefixes against that set, price from the deepest matching
  marker, and treat recovery of any older prefix as a miss. Predicted cache
  churn is therefore an **upper bound**, calibrated against the
  persistent multi-turn simulator (§11). Data basis: on Fable's tape the
  surviving marker on big writes sits at median 3% / p90 7.6% depth — older-
  prefix recovery essentially never occurs on current geometry, so the exact
  multi-turn automaton (all unexpired marked prefixes in a trie, labels
  carrying automaton state) is deferred to the T3 era and specified in
  review-2 §4.2. NOT a node-id LRU — cache reuse is a property of complete
  marked prefixes (review §4.3). When the receipt is absent, expired, or has
  an immutable-prefix mismatch, report the full request as a cold write in
  total-cost telemetry but set layout-dependent `K = 0` for every candidate:
  no feasible cut can preserve reuse that is already unavailable.
- **stability clock τ** per region (§3.2): counted in **accepted provider
  renders**. A preview, abandoned compile, local render, rejected/transport-
  failed request, or production dry run does not advance τ. A request the
  provider accepted advances τ even if the model then refused — the input was
  presented and may have populated cache. If acceptance cannot be told apart
  from completion, use the narrowest observable receipt and document the
  conservative behavior. Persisted with the presentation receipt; cache
  state may be disabled or absent.
- Tests: compile-without-send changes working frontier state but neither
  accepted-presentation nor cache state;
  preview changes neither; rejected/transport-failed request writes no
  receipt; accepted request updates presentation even with caching off and
  writes exact wire markers when present; a duplicate callback is a no-op; a
  callback whose `(requestHash, parentReceiptHash)` does not match the head is
  recorded and rejected as baseline; a second in-flight submission on one
  branch fails the single-flight assertion; keepalive receipts never advance
  the head; snapshot-then-deltas replay to the same map; immutable-prefix mismatch gives `K = 0`
  and normal `C`; restart/branch change loads working frontier, presentation,
  and cache state independently.
- **Commit boundaries (review §5.2, review-3 §2)**: working frontier state
  commits at the resolution-persist site; accepted presentation and any cache
  receipt commit only on the matching membrane callback.
  Neither is touched by previews (`previewContext`), failed compiles,
  production-planning dry runs, or auxiliary solves. Behavior across branch
  changes and on rollback to `kv-stable` is specified with the slots (slots
  are additive; `kv-stable` ignores them).
- **append-rate EMA** (for T3): persisted, clamped, loud on rejection —
  identical pattern to `reportRealInputTokens`.

## 5A. Cache-marker placement (v1 baseline + stability-labelled placement)

Marker placement is part of the control problem (review-2 §3) and is NOT
inherited from rev 5.

### 5A.1 The slot budget and what runs today

The provider allows **4 `cache_control` blocks per request including the
system block.** On the XML formatter path Fable runs, membrane marks the
system block unconditionally whenever prompt caching is on, leaving
**three** message-level slots (native differs — see below). The live rev-5
placer is `placeCacheMarkers` (`autobiographical.ts:7335`; the
`render-offsets.ts` `placeMarkers` the first review-2 draft described is the
replay harness's, not the emitter's). It computes head / mid-history /
`historyEnd` / end, and when the limit binds — always, once folds exist — it
**drops the mid-history seam and keeps the head marker** (`:7372`), which
protects a ~4k-token head sitting directly behind the system marker. Result
on Fable: markers at ~3%, ~75% (`historyEnd`), 100% — a 3%→75% desert; the
surviving marker on big writes is at median 3% depth (breakpoint-quantization
penalty p90 92% of window). Independently observed by Assay ("3 blocks, one
80%-of-window desert").

Membrane's marker behavior is **inconsistent across formatters today**
(verified 08-29): the native formatter caches the system block only as a
*fallback* when no message breakpoint is marked (`native.ts:198-204`, and
recounts imported block-level `cache_control` passthroughs at `:278-287`);
the XML formatter marks system **unconditionally** whenever prompt caching is
on (`anthropic-xml.ts:201`) and adds another marker on `contextPrefix`
(`:211`); Bedrock strips `ttl` and keeps the marker (`bedrock.ts:140-148`).
Fable runs XML (her 39.5k cached prefix = the marked system block with tools
injected), so the "3 message-level slots" arithmetic in `placeCacheMarkers`
is right for her and wrong for native residents, who could carry four. This
is why §5A.6 makes membrane consistent rather than teaching CM formatter-
specific slot arithmetic.

### 5A.2 Where hazard lives after rev 6

Every marker figure computed on today's tapes is sized on a solver that was
itself the main hazard; do not design from those numbers. After rev 6:
- `historyEnd` remains the routine seam — every frontier fold lands exactly
  there, and a marker at last render's `historyEnd` survives it (the new
  summary lands just after). Highest-value marker; keep.
- **end** buys pure-append reuse; keep.
- **mid-history** changes become scheduled events (L2/L3 landings, re-cuts),
  no longer hourly; its value drops but does not vanish.
- the **deep band** (≥L4, complete groups at the span cap) becomes genuinely
  quiet; a marker after it covers system + tools + the whole band in one
  slot and bounds the rare deep landing or exogenous budget change to the
  suffix. The system-only marker's marginal value (40k tokens, only when the
  band changes) shrinks to ~nothing under prefix semantics.
- a mid-**tail** marker protects ~12% of window against events that almost
  never land there (tool_result edits, injection splices); never worth a slot.

### 5A.3 v1 layout

    system+deep-band | mid-history | historyEnd | end

- **CM owns all four slots.** Membrane's unconditional system marker becomes
  config (`cacheMarkers: 'cm-owned'`), and CM places the first marker after
  the last node of the production-complete/stable prefix (§5A.4) — which contains the
  system and tools blocks by construction. Caveat recorded: with the system
  slot moved, an idle expiry kills the tools entry together with the window;
  irrelevant with keepalives on, remember if they are ever off.
- Placement is by **cumulative rendered (priced) tokens**, never by unit
  count (one summary unit and one raw unit differ by an order of magnitude),
  snapped to legal render-unit boundaries.
- Rev-5 interim (independent of the solver work, one line at `:7372`): when
  the limit binds, **drop the head seam, keep mid-history.** Worth ~$10/day
  on Fable's current tape; more importantly it removes the desert while rev 6
  is built.

### 5A.4 Stability labels — placement from solver state, not a fitted curve

Stability of a seam = "no change lands at or before it in the next few
renders." Its causes fall into three classes of very different knowability;
the placer labels each render-unit seam left-to-right and places by label.

1. **Scheduled — known from solver state (deterministic).**
   - *Pending production the cut would adopt*: the demand list (§8) says
     which summaries are being made; the welfare policy says whether the cut
     takes them once they exist. A span with a wanted-and-pending merge is
     `pending` (with an expected landing time from the supply model); a span
     whose covering group is complete, merged, and at the deepest producible
     level (span cap) is `production-complete` — nothing can *arrive* to
     change it. (Not "immutable": τ release, age weights, pins, and budget
     changes can still change its selection — review-3 §5.1.)
   - *Held-vs-ideal gap*: positions where the last accepted presentation
     differs from the cache/continuity-free ideal carry regret and will rotate
     when paid for (or when the continuity clock releases them).
   A seam is **`stable(horizon)`** only if the planner finds no known
   transition at or before it within the placement horizon, considering:
   pending production; held-vs-ideal regret and continuity release; append/tail
   migration; age-driven policy changes; known pin/config changes; and the
   current budget-transition state. Global exogenous events are handled by
   distributed coverage, never by a label.
   - *Frontier arithmetic*: the next tail chunk closes at a known token count
     and the append-rate EMA gives when; group completion (the k-th L1 of a
     base-k group) likewise. The next `historyEnd` fold is a scheduled event.
2. **Exogenous, localized — known where, not when**: injection splices,
   image strips, tool_result rewrites, quarantine flips. Positions follow
   policy (tail zone, strip-depth rule); they define `volatile` zones not to
   place a marker directly before — not a probability to fit.
3. **Exogenous, global — unpredictable**: budget changes, model swaps,
   tool/schema changes, surgery. Not predicted. The deep-band marker bounds
   the layout-driven suffix rewrite only when the immutable prefix survives;
   a tool/system/formatter-prefix mismatch invalidates provider reuse outright
   (§3.2, §5), though continuity remains unless an explicit transition reason
   relaxes it.

Placement rule (v1, deterministic):
- deep marker = end of the `production-complete`/`stable(horizon)` prefix;
- mid marker = just **before** the earliest `pending` landing in the middle
  (so the landing costs only its suffix), else the token midpoint of the
  stable stretch;
- `historyEnd`; end.

**Deterministic slot completion (review-3 §5.2).** The candidate seams may
coincide, be unavailable, or appear out of order: (1) generate labelled
candidate seams; (2) clamp and sort by chronological rendered offset;
(3) deduplicate equal wire boundaries; (4) retain mandatory `historyEnd` and
`end` when distinct and admissible; (5) fill unused slots from equal
cumulative-priced-token targets over the uncovered intervals; (6) emit at
most four distinct markers. The pass returns the chosen seams **with
reasons** (planned vs fallback) for the marker-stability dashboard.
When a landing is scheduled, **bundle it**: adopt it and move the marker past
it in the same render. This is review-2 §3.3's hazard-weighted segmentation
with the hazard supplied by the plan (demand list + planned cut + append
model) instead of a fitted distribution; the segmentation DP over at most
four seams is small and separate from the cut solver (review-2 §4.4: no
joint cut/marker optimization in v1 — cut selection is aware of *existing*
markers via §5; next markers are a post-selection pass).

Empirical fallback and calibration: per-seam survival by depth and level,
measured from the agent's own tape by the simulator. If seams labelled
`stable` keep breaking, either the solver is not minimizing change or a
class-2 policy is unrecorded — a dashboard finding, not a bill.
Equal cumulative-token spacing is the fallback when no plan state is trusted.

### 5A.5 Temporal ordering (review-2 §4.3)

1. normalize tools/system/context prefix and compute the immutable-prefix
fingerprint; 2. load the last accepted presentation and any valid unexpired
cache receipt; 3. solve the cut against both; 4. render the candidate layout;
5. place markers over that layout and format the raw request; 6. only after
provider acceptance, atomically advance the presentation receipt and, when
applicable, the cache receipt and continuity clocks. Working frontier state
may persist earlier at the existing resolution-persist boundary (§5), but it
is not a presentation. Previews, failed renders, production dry runs, and
auxiliary solves never write accepted-presentation or cache state.

### 5A.6 Membrane cache-marker contract (review-3 §4)

CM-owned placement needs **one** marker contract across every membrane
formatter; membrane is made consistent rather than CM learning per-formatter
slot arithmetic.

**Modes** — one normalized request option, identical meaning everywhere:

    cacheMarkers: 'membrane-system' | 'cm-owned'

`membrane-system` (compatibility default): membrane may place its system /
context-prefix fallback marker; caller message breakpoints remain supported;
the request builder validates the provider limit loudly.
`cm-owned`: no automatic system marker; no automatic context-prefix marker;
only caller-supplied normalized message breakpoints become `cache_control`
blocks; tools/system/context prefix are covered by the first CM marker's
prefix; **stale imported block-level markers are rejected at a named
normalization boundary before request construction** (CM cannot optimize a
slot budget containing hidden markers; the loud data-defect behavior stays
in `membrane-system` mode); the raw request carries at most the provider
limit; membrane returns the exact wire receipt.

**Formatter parity** — the same normalized policy applies to native
Anthropic, Anthropic XML/prefill, Bedrock (incl. its ttl rewrite), context-
prefix handling, tool-in-system and tool-in-conversation modes, and any
adapter that passes normalized `cacheBreakpoint` state. No formatter may
spend an extra slot after normalized marker planning.

**Wire receipt** — computed from the raw request after formatting:
`{requestHash, layoutHash, immutablePrefixHash, presentationHash, formatter,
provider, markers: [{ordinal, prefixHash, estimatedOffset, source}]}`,
`source` ∈ {cm, system-fallback,
context-prefix, imported}. In `cm-owned` mode every source must be `cm` or
the request is rejected before submission. CM persists a receipt only for an
accepted request (§5); `prefixHash` is over the exact normalized wire
content, not a summary-node id; estimated offsets are reconciled later
against provider usage. The immutable-prefix hash is computed from the same
normalized blocks passed into the solver; parity is asserted, not assumed.

**Marker-budget tests** (per formatter × provider, on the captured raw
request): `cm-owned` with four CM breakpoints → exactly four `cache_control`
blocks; no automatic system/context-prefix marker; tools + system inside the
first CM marker's prefix; `membrane-system` unchanged; stale imported markers
follow the explicit policy; duplicate seams deduplicated deterministically
before the wire boundary; zero/one/four markers consistent; **five markers
fail before network submission** with sources listed; native, XML, and
Bedrock return equivalent receipts for equivalent normalized requests.

## 6. Configuration surface

| Knob | Default | Plane | Meaning |
|---|---|---|---|
| `foldingStrategy: "kv-unified"` | off | recipe | opt-in selector |
| `kvUnifiedAlpha` | fitted (Phase 0) | recipe + hot | curve shape |
| `kvUnifiedCachePolicy` / `kvUnifiedContinuityPolicy` | `quadratic` | recipe | nonlinear policies on avoidable cache churn and continuity loss (§3.2) |
| `kvUnifiedCacheLambda` / `kvUnifiedCacheScale` | chosen (Phase 0) | recipe + hot | cache policy λ and scale (the K *model* is calibrated; the exchange rate is policy) |
| `kvUnifiedContinuityLambda` / `kvUnifiedContinuityScale` | chosen (Phase 0) | recipe + hot | continuity policy λ and scale |
| `kvUnifiedContinuityRecencyHalfLife` / `kvUnifiedContinuityRecencyFloor` | chosen (Phase 0) | recipe + hot | recent-vs-old continuity weighting (§3.2) |
| `kvUnifiedContinuityStableHalfLife` / `kvUnifiedContinuityStableFloor` | chosen (Phase 0) / 0.25 | recipe + hot | accepted-presentation stability-clock decay (§3.2) |
| `kvUnifiedBudgetLowRatio` / `kvUnifiedBudgetHighRatio` | chosen (Phase 0); low side conservative | recipe + hot | flat occupancy band as fractions of W (§3) |
| `kvUnifiedBudgetUnderLambda` / `kvUnifiedBudgetOverLambda` | chosen (Phase 0); under small | recipe + hot | squared-hinge prices outside the band (§3) |
| `kvUnifiedLambdaF` | 0 (v1) | recipe | future-churn price |
| `kvUnifiedBeta` | 0.9/event | recipe | churn discount |
| `kvUnifiedAdoptEpsilon` | 0.005·W | recipe | anti-cycle margin |
| `cacheMarkers` | `membrane-system` | recipe | `cm-owned` hands all four slots to CM (§5A.3) |
| W (`contextBudgetTokens`) | existing | existing | the wall |

Retired when active: `foldDepthCap` path, `compressionSlackRatio`,
`kvStableReachTokens`, `kvStableQualityGapRatio`, phases A/B/C, branch
cascade. `mergeThreshold` remains (merge fanout only — its fade-rate double
duty ends). All existing estimator, byte-wall, and production knobs are
consumed unchanged.

## 7. Integration

New `src/adaptive/kv-unified.ts` + strategy wrapper selected by
`foldingStrategy`, consuming the existing `PickerInputs`/`SummaryTree` plus
the accepted-presentation receipt, optional cache receipt, and normalized
immutable-prefix fingerprint required by §5, and emitting the same
`resolutions` map the picker applies — so **flipping the
flag back to `kv-stable` is always safe** (shared state formats; the unified
slots are additive). Hard-wall computation and estimator calibration are
untouched; the occupancy band is selection policy inside that wall. **Marker
emission and one membrane option (`cacheMarkers`) change deliberately**
(§5A.6).
Continuity relaxation arrives as an audited per-transition input
`{reason, multiplier, expiresAt}`. It defaults to normal operation with
`multiplier = 1`; any value below 1 requires a future expiry;
fingerprint mismatch may classify cache state as cold but cannot lower the
multiplier. Surgery and rapid-budget callers must opt in explicitly, and an
expired or malformed relaxation fails closed to `ρ = 1`.
fkm passthrough for the new keys mirrors the existing pattern (remember the
2026-07-12 lesson: a knob absent from `PASSTHROUGH_KEYS` is a silent no-op —
add keys and a passthrough test in the same commit).

## 8. Production demand (latent candidates)

An unproduced summary is not a masked stored node: live operation has no id,
no authored content, and no measured recall-pair cost for it (review-2 §2.1).
Demand therefore has an explicit **latent-candidate layer**:

1. **Generate** producible candidates from the compression grammar: uncovered
   L1 spans (chunks are deterministic, L1 is 1:1) and eligible higher-level
   sibling groups (base-k, under #64's level-scaled span limit).
2. **Estimate** each candidate's recall cost with an uncertainty: the level's
   calibrated `summaryTargetTokens` × carrier overhead, priced through the
   same estimator surface as real nodes; uncertainty from the level's
   historical cost distribution on this store.
3. **Insert** the candidate counterfactually into the canonical forest (it
   is F2-admissible for the counterfactual only).
4. **Measure** the improvement under the same feasible frontier and welfare
   policy used for cut selection — i.e. the terminal `score` with the
   candidate available vs without.
5. **Rank** (review-3 §6). The no-candidate baseline is the **solver-
   selected feasible frontier under the current policy**, not simply the
   last accepted presentation:

       demandValue(c) = score(best frontier without c)
                      − score(best frontier with c)

   both sides under the same cache and presentation state, hard budget,
   occupancy band, welfare policy, and approximation configuration, evaluated with **the same bounded Pareto
   solver used for cut selection** (not a separate "exact" solve). v1
   marginal values are individual (one candidate at a time), not conditional
   on a production set — a documented approximation. Each evaluation reports:
   exact vs approximate mode; bucket parameters; the estimated recall-cost
   distribution; the improvement at the point estimate; and a **conservative
   improvement used for ranking** — v1 rule: cost at an upper quantile
   (default p80), with expected and conservative ranks reported separately.
   A candidate is never called beneficial without the risk rule stated. The
   λ-relaxed reduced-cost pass is a heuristic pre-filter only (bounded set,
   default 16).

Emit as a ranked `produce` demand list consumed by the existing supply
pipeline alongside the speculative producer; the same list feeds the marker
placer's `pending` labels (§5A.4). Closes backlog item (b); the natural
driver for L(n+1) merges.

## 9. Infeasibility certificates

When F1–F5 admit no cut ≤ W, the DP identifies the binding subtrees and
constraints. Report `{floorTokens, bindingPins[], protectedTokens,
missingLevels[], suggestion}` through `OverBudgetError.diagnostics` — e.g.
"release one of pins {a,b} or raise W by 12k". Pin-admission dry-runs
(memory-tools) reuse the same report.

## 10. Welfare constraints (first-class, not tuning)

- **Cache churn and continuity are welfare preferences, not feasibility
  constraints** (review §2). Their separate nonlinear policies (§3.2) and the
  occupancy band (§3) shape the selected feasible cut; a hard change cap
  would authorize over-budget holds. Tail metrics (p95/p99 rotation size) are
  logged and alerted on, not asserted by the solver.
- **Inversion-free profiles**: the T1 weight `salience·age^(−α)·rawTokens`
  is NOT monotone in age when salience and chunk size vary, and even monotone
  weights do not prevent inversions under differing summary costs, existence
  constraints, or pins (review §4.6). If "recent coarse / ancient fine is
  unrepresentable" is a welfare requirement, it is an explicit isotonic
  constraint in F1–F5; otherwise it is a tendency validated in replay. Age
  has a positive floor (no `age = 0` singularity). **Phase 0c decides which**
  (review-2 §2.7) and the success criteria follow that decision: if
  prohibited, isotonicity enters canonicalization, feasibility, label
  propagation, and tests; if a preference, "inversion" leaves §15's
  zero-incident invariant and becomes a replay/production profile metric.
- **On-policy invariant untouched**: the solver never generates content;
  summaries remain the resident's own model's writing.
- **No silent loss**: pins never silently violated; every exclusion,
  override, forced rotation, and certificate is logged loudly.

## 11. Testing plan

Tests are scoped by **mode** (review-2 §2.5):

**Exact mode** — canonical-forest construction and validation on constructed
scars (cycles, conflicting ownership, missing links, overlap); feasibility
pass `R_min` vs brute force; Pareto DP vs brute-force enumeration on random
small forests (≤12 leaves) — full frontier agreement, not just the chosen
cut; welfare selection over terminal labels for each cache, continuity, and
budget policy (quadratic, piecewise, lexicographic); the same-R
dominance counterexample for the U-shaped budget term (a lower-R label that
would wrongly prune an in-band finisher); the five occupancy designed cases
(§3: no immediate rebound, eventual correction, band neutrality, no
oscillation, hard-wall priority); extremal-solve floor witnesses retained
under pruning and the floor gap reported; prefix-state semantics
(append neutrality, first-divergence accounting, marker-staircase cost);
accepted-presentation continuity (recency ordering, old-material floor,
level distance, stable-time decay); immutable-prefix mismatch disabling only
K; transition-reason relaxation affecting only C; pin algebra incl. ≥; locked-
leaf protected-hole cost/fidelity; certificate correctness on constructed
infeasibility; determinism (same inputs ⇒ identical cut); commit boundary
(previews/failed renders never write state); CP-SAT/MILP oracle agreement on
real snapshots.

**Approximate mode** — under ε-dominance / buckets: hard-budget compliance
(token rounding must never admit an over-W cut — round tokens UP),
deterministic output, the §4.2 feasible incumbent always retained, and the
stated optimality bound verified against exact mode on forests small enough
to run both. The rounding scheme names which dimensions round in which
direction and bounds token, cache, continuity, occupancy, and total welfare
error; a label
ceiling alone is not a bound.

**Performance mode** — 100k-node synthetic forest < 1s **under the named
production label ceiling and bucket configuration**, not unconstrained exact
Pareto expansion.

**Property** — limit-cycle test under monotone append streams with landings
(T4 hysteresis; real fixtures below); continuity-clock release test (a held
cut with sufficient regret rotates, while a below-floor case remains held);
normal/tool-change/surgery/budget-transition reason matrix; flag round-trip (kv-stable ↔
kv-unified state safety); marker placement: labelled-stable seams survive the
next render on replay ≥ 95%, bundling moves the marker past a landing in the
same render.
Regression: replay harness (`~/replay-mythos/`) as a fixture — solve the real
exported store at pinned configs and snapshot profile + priced-cache,
continuity, occupancy, and total-score series; CI-diffable.

**Production-time masking (mandatory).** A replay MUST mask every summary by
its `created` timestamp (`SummaryEntry.created`, `strategy.ts:932`): at solve
time t, only nodes produced before t exist (F2).
Replaying against the final export makes every summary available from the
start — a future-complete tree the live solver never saw — and a pass under
that condition is not a pass. Masking reconstructs the historical availability
boundary only; it does not make the replay exact or close the production loop.

**Masking alone is not closed-loop (review §5.1, review-3 §7).** Created-time
masking prevents future-complete replay but reproduces only the historical
supply trajectory. The measured supply queue below is a calibrated
counterfactual for kv-unified demand; it is not an exact reconstruction.
Demand may accelerate selected summaries and delay competing speculative
work. Hypothetical summary cost and refusal behavior remain modeled. Replay
results therefore carry calibration and uncertainty bands, and the pilot's
predicted-versus-actual series is the final validation. The replay gate
executes the demand list through a **measured supply model**:
production latency (produce request → `created`), refusal rate, quarantine
dwell, and merge availability, all estimated from the agent's own aux-lane
llm-calls (kind=`complete`), applied as a queue with the historical
speculative producer running alongside. Summaries the model would have
produced by t are admitted with the eventual stored summary's cost as a
proxy. (Why it is a model, review-2 §2.6: demand consumes finite aux-lane capacity
and may delay speculative work that historically finished earlier; refusal
and quarantine are content-dependent; a hypothetically-earlier summary's
cost is a proxy.) **The replay harness uses the same normalized marker
contract and receipt semantics as the live formatter (§5A.6)** — simulating
four CM markers while the wire path silently adds a fifth is not a valid
replay.

Supply-lag test: masked replay plus an injected production delay (e.g. L1
availability shifted +2h over a 6h span); assert the solver returns a feasible
cut under W or a certificate, never fabricates a rotation onto a node that
does not exist yet.

**Fable round-trip fixture (limit-cycle regression).** Recorded production
limit cycle on `fable@b-sketch`, rev-5 kv-stable, 2026-08-24: compile at
03:11:11Z folded units `prev[113:124]` (6 L1 recall pairs → their L2) and the
compile at 03:59:57Z un-folded `cur[113:124]` back — same 11 unit hashes,
same slot, prefix `[:113]` byte-identical, ~$10 each way (session probe
`/tmp/pairchk.py`; structural probe `/tmp/thdig.py`: 78×`(11→1)` +
60×`(1→11)` mid-window over 17 days, fold and un-fold in the same compile at
different depths). Export the picker inputs + summaries spanning
2026-08-24T02:00Z–05:00Z as a fixture; the T4 property test replays it
(masked) and asserts zero reverts to a composition seen within the previous
8 solves. This is the Phase 0b harness's real-data case; the synthetic
stream is the second case, not the only one.

## 12. Evidence to date (all pre-implementation)

- Toy (Pinwake, identical synthetic streams): unified 36.2k vs greedy 79.6k
  mean recompute/tick; 82% holds; correct λ_P dose-response; 5.8ms/solve.
  (Measured under the withdrawn linear-λ_P / bisection form; indicative only.)
- Real store, real request stream (Aug 13–17): unified+solver-aware markers ≈
  −14% priced cost vs held-greedy baseline in-sim; hold discipline captures
  most of the churn win; unified adds 3–6% at that cadence plus everything
  structural. (Cache-sim absolute numbers are billed-basis corrected as of
  2026-08-17; the earlier "2×" headline reads ≈1.5–1.6× billed.)
- Production corroboration post-#63/#64 deploy (2026-08-18): full-window
  zero-write cache reads observed live once markers were honest — supporting
  T2's premise that stable prefixes convert writes to 0.1× reads.
- Second agent, same oscillation class (Fable, 2026-08-28 diagnosis,
  `~/connectome-local/tmp/diagnose-thinking-replay-REPORT.md`): rev-5 with
  `kvStableReachTokens` unset (P = W, `kv-control.ts:819`) and the window over
  target on 892/1070 compiles → dead-band hold skipped, from-scratch ideal
  adopted every hourly wake; phase C's youngest-first pack un-folds one L2
  while phase A sheds another → L1/L2 boundary hunts by one merge quantum at
  40–60% depth. 353 compiles with moves>0, 291 with ≥100 moves,
  `[kv-escalation]` ×0. Counterfactual content-true sim (read-calibrated
  0.15% median, bp-only): holding the mid-window profile recovers
  **$56–65/day post-keepalive** (pre-KA $32–54/day; hourly heartbeat sat at
  3602 s vs the 3600 s TTL). Under T2 the 0.37-depth un-fold is ~60% of a 400k
  window of avoidable cache churn and continuity loss against a one-group
  fidelity gain — held by a wide margin under plausible monotone policies.

## 13. Implementation plan

**Phase 0 — rigor debts (before code)**
0a. Welfare-policy designed controls (cases where cache, continuity, and
    occupancy terms each MUST change the chosen cut). Three verbs, kept
    distinct (review-4 §3): **Calibrate** from provider and replay
    measurements the raw K *prediction* (which prefix survived, read/write/
    miss prices, predicted-vs-observed cache tokens, marker-quantization
    error) and the headroom-risk inputs (append volume, estimator-error
    distribution) — these are bills and identify the cost model, nothing
    more. **Choose** as explicit policy judgments `f_K` and `f_C` (exchange
    rates and curve shape), the band `[W_low, W_high]` and both slopes
    (`λ_over` is derivable from bills only if `B` is defined as calibrated
    expected next-turn cost), recency half-life/floor, `ψ`, and the stable-
    time floor. **Validate** the choices on designed counterexamples and
    report the cost/fidelity/continuity frontier rather than claiming the
    exchange rate was identified by history. (K and C are not collinear per
    candidate — an early change has high K and low recency-weighted C, a
    late change the reverse — which is why both dimensions exist; the
    series correlate under whole-window rotations, which is why C's rate
    has no replay ground truth.) Designed cases: release and durable-hold,
    recent-vs-old equivalent changes, a tool-prefix invalidation, a surgery
    relaxation, a forced budget transition, and the five occupancy cases of
    §3.
0b. Limit-cycle property test harness (drives T4's ε default) — must include
    the Fable round-trip fixture (§11) as a real-data case, replayed with
    `created` masking and the measured supply model.
0c. α fit vs healed-profile reference; welfare review of the fitted value;
    **record the isotonicity decision (§10) and update §15 in the same
    change.**
0d. Re-run cache sims on billed basis; pin the numbers quoted anywhere. All
    cache-cost evidence produced under old marker placement (§12, §5A) is
    **indicative only until rerun under the CM-owned four-marker contract**.
0e. **Marker gate**: raw-request parity across native/XML/Bedrock under
    `cacheMarkers: 'cm-owned'` (§5A.6 tests), marker-survival replay under
    the receipt semantics, immutable-prefix hash parity between solve input
    and raw wire receipt, accepted-presentation callbacks with caching off,
    compile-without-send isolation, and provider-limit validation failing
    before submission.
Exit: all five written down in this doc's changelog.

**Phase 1 — implement behind flag** (cm + one membrane flag)
In this order, each landing with its exact-mode tests: (1) canonical-forest
construction + validation (§2.1, F4b compilation); (2) exact minimum-token
feasibility pass + certificates (§4.2, §9); (3) decision-DAG construction
(§4.1); (4) sparse `(R,K,C,Loss)` label propagation with cache-match state
threaded and the accepted presentation as a fixed input (§4.3, §5), plus the
two extremal floor solves (§3.2); (5) deterministic resource ceiling + ε-dominance /
buckets with reported bounds (§4.4); (6) welfare selection over terminal
labels incl. occupancy band, avoidable floors, stability decay, and transition
reason (§3); (7) working-frontier, accepted-presentation, and cache persistence
slots + commit boundaries + immutable-prefix solve input (§5);
(8) latent-candidate demand (§8); (9) marker placer with stability labels
(§5A) + membrane `cacheMarkers: 'cm-owned'`; (10) brute-force and CP-SAT/MILP
oracles (§4.5); strategy wrapper, config plumbing + fkm passthrough +
passthrough test. The λ-relaxed scalar DP is implemented only as the §8
pre-filter and a lower-bound check. Items (1)–(2) land first and are replayed
on both stores before (3)+: they surface scar tissue regardless of solver.
Exit: full suite green in all three test modes; flag off by default
everywhere.

**Phase 2 — replay gate** (no live traffic; replaces shadow mode)
Rationale (antra, 2026-08-28): everything shadow mode would show is available
from sims and masked replay, and shadow mode does not close the production
loop either (its demand list is never executed), so it buys a week of dual
solves for nothing replay cannot give. Gate, per exported store (Mythos AND
Fable — the second, dirtier-vs-cleaner store is the insurance shadow mode was
meant to buy):
- masked replay + measured supply model (§11) at pinned config: predicted
  priced cache churn ≤ rev-5's on ≥90% of cache-relevant solves; continuity
  and occupancy distributions stay inside their Phase-0-approved bands; zero cycle events (T4 test
  incl. the Fable fixture); no certificate false-positives; fidelity gap vs
  the rev-5 profile within the α-fit tolerance; supply-lag test passes;
  label-count/runtime ceiling respected (§4.4) with any approximation
  reported.
- the counterfactual cache sim on the agent's own llm-calls tape (bp-only
  and 20-block-lookback variants) agrees with the replay's predicted cache-
  churn series within calibration error; tool-prefix changes disable cache
  preference without suppressing measured continuity.
Exit: both stores green; numbers recorded in this doc's changelog.

**Phase 3 — hard switchover, Fable first**
Flag on for Fable (`foldingStrategy: "kv-unified"`, welfare policies and
budget band at their Phase-0-fitted values, λ_F = 0). No dual-solve period. Fable goes first:
full payload logging, a calibrated content-true sim on her tape, the
round-trip fixture is hers, and her rev-5 failure mode is cheap and boring
(hunting, not inversion). Same-window control = the masked replay series
for the identical compiles. Watch, from llm-calls alone: `[plan-vs-actual]`
moves histogram (expect ≥100-move compiles → 0 outside genuine landings),
op-shape probe (expect zero mid-window `(1→N)` un-folds not earned by a
budget change), predicted-vs-actual cache churn per accepted request,
continuity loss by recency band, occupancy-band position, p99 rotation
size (alerting, not invariant), refusal rate unchanged (payload shapes are unchanged),
oscillation count 0. Rollback = flag flip (state formats shared).
Then Mythos, with the welfare conversation the spec already requires — he
brings the scarred tree; better as the second agent once the first switch
has a week of clean numbers.

**Phase 4 — enable T3, then fleet**
λ_F on after the masked-replay event model validates on the switched agents;
then per-agent rollout with the same watch list; retire dead rev5 knobs from
recipes as agents move.

## 14. Risks and open questions

- α is a welfare judgment wearing a math costume — fitting gets a starting
  point, not an answer; revisit with residents' input.
- Estimator drift moves tok_v under the solver; mitigated by shared pricing
  surface + the calibration sanity band; the masked replay gate (Phase 2) and the
  post-switch predicted-vs-actual series show sensitivity.
- The occupancy band is a genuine policy preference. A badly chosen upper
  hinge over-compresses; a badly chosen lower hinge (`W_low` near `W_high`,
  strong slope) rebuilds the rev-5 refill attractor. Phase 0 chooses both
  against the five designed cases; production logs the term and flags every
  solve the lower hinge decided.
- Continuity recency and fidelity age both favor recent material but answer
  different questions (change from the last presentation vs value of the
  resulting representation). Correlated weights are expected; ablations in
  Phase 0 must show that continuity still prevents unearned recent rewrites
  after cache is cold without making old history free.
- Bursty append rates (image storms) can whip T3's EMA — clamped, and T3 is
  the last phase for exactly this reason.
- Scarred stores: ownership-chain forest + overlap exemptions are believed
  sufficient (they were for the clone), but the Phase 2 replay gate runs on a
  second store (Fable) as cheap insurance.
- Marker ownership moves to CM (`cacheMarkers: 'cm-owned'`): a mis-placed
  first marker now exposes the tools block too. Mitigated by the stable-
  prefix rule (§5A.4) and the marker-health criterion (§15.5); the membrane
  default stays `membrane-system` until an agent opts in.
- Stability labels are only as honest as the solver's change-minimization;
  §15.5's ≥95% survival is the canary. If it fails, suspect an unrecorded
  class-2 policy before suspecting the placer.
- Quarantined-raw spans (F3-frozen) act like permanent pins; a long refusal
  streak (cf. 2026-08-18) shrinks feasible headroom — certificates make this
  visible, but the *triage* remains an operator/welfare process outside the
  solver.

## 15. Success criteria

1. Zero solver-loop incidents (oscillation, wedge; inversion only if Phase
   0c makes it a constraint) on pilot+fleet over a quarter — the
   maintainability goal made falsifiable. "Convergence" here means the
   algorithm terminates deterministically and does not cycle on the fixtures;
   convergence to a policy-independent memory profile is NOT claimed
   (§3.2).
2. Billed cache waste on pilot ≤ 60% of its pre-#63 baseline at equal
   fidelity (α-fit tolerance), attributable via waste.py.
3. Recent-material continuity loss is lower than an age-blind continuity
   baseline at equal fidelity and cache cost; tool-prefix changes preserve
   that behavior, while audited surgery/budget-transition relaxations affect
   only their declared window.
4. Occupancy lies in `[W_low, W_high]` on ≥95% of steady-state accepted
   requests where a feasible in-band cut exists; under/over excursions and
   their score are reported, and lower-hinge-decided solves are counted.
   `R > W` remains zero-tolerance.
5. p99 single-turn rotation tracked and alerted (no solver cap — review
   §2); no silent pin violations ever; every infeasibility carries a
   certificate.
6. relevance/oscillation diagnostics replaced by: one decomposed welfare score, one
   Pareto frontier size, one certificate type, one demand list, one marker
   stability map — legible in /curve. Where approximation was used, its bound
   is on the same page.
7. Marker health: seams labelled `stable(horizon)` survive the next render ≥ 95% on
   the switched agents; breakpoint-quantization penalty (surviving-marker
   depth on rewrites) p50 ≥ 30% of window, vs 3% on Fable today.

## 16. Readiness criterion (review-3 §10)

The v1 specification is implementation-ready when: constraint conflicts
produce infeasibility rather than precedence (F4b); working frontier,
accepted presentation, and provider-cache state have the stated independent
commit boundaries (§5); the current normalized immutable-prefix fingerprint
is a required solve input; cache churn and recency-weighted continuity are
separate label dimensions; normal/tool/surgery/budget-transition reasons have
tested semantics; the nonlinear occupancy band has safe dominance rules
(§3, §4.3); membrane exposes one tested CM-owned marker contract across all
formatter paths (§5A.6); marker state is persisted from accepted wire
receipts (§5); replay contains no exactness / one-directionality
contradiction (§11); candidate demand uses the bounded solver and an explicit
uncertainty rule (§8); and Phase 0 owns the marker, welfare, and isotonicity
decisions it gates (§13). As of this revision every item is specified; none
is yet fitted or tested.
