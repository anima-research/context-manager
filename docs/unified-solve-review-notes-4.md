# Unified solve review notes 4 — fifth-pass policy and implementation review

Date: 2026-08-29

Reviewed document: `docs/unified-solve-design.md`, rev 6 fifth pass.

## Recommendation

Do not begin the production solver yet. The fifth pass contains two useful
simplifications:

- continuity `C` is correctly recognized as additive against a fixed accepted-
  presentation reference, so only cache matching needs threaded continuation
  state; and
- exact frontier expansion is correctly demoted to an oracle, with bounded
  approximation expected in production.

Four points still need specification work. The first changes the requested
welfare policy in order to simplify dominance. The second affects whether the
solver can distinguish forced from avoidable change under the approximate mode
that production will actually use. The remaining two concern calibration and
receipt correctness.

## 1. Restore the lower occupancy hinge

### Finding

The fourth-pass requirement was a nonlinear comfort band: occupancy is
acceptable within a range and becomes increasingly undesirable when it is
either very low or very high. The fifth pass replaces that with an upper-only
headroom threshold and states that under-filling is never a cost in itself.
Phase 0 additionally requires a shed that lands well below `W_high` to never
refill.

That is not a solver clarification; it reverses the requested welfare policy.
An upper-only hinge can be a defensible policy, but it cannot be described as
implementing the earlier acceptable-band requirement.

### Why the phase-C analogy is too strong

Rev 5 phase C packed toward a target procedurally. It did so without charging
the full cache suffix, without a separate recent-material continuity term, and
without requiring a welfare improvement large enough to cross adoption
hysteresis. That unconditional refill mechanism is not equivalent to a soft
lower occupancy penalty inside the unified score.

With the current design, a downward budget transition behaves differently:

1. The hard wall forces a feasible shed regardless of cache or continuity.
2. The accepted shed becomes the new presentation reference.
3. On the next normal solve, undoing the shed pays full continuity and any
   available cache cost.
4. Adoption hysteresis rejects a marginal immediate reversal.
5. As the stability price decays, a persistent and sufficiently severe
   under-fill may eventually justify a refill.

That is desirable. It prevents an immediate A→B→A bounce without declaring
that a severely underfilled context should remain underfilled forever. It also
matches the intended semantics of the stability clock: continuity delays a
change; it does not make policy debt permanent unless the configured floor is
large enough to do so.

### Recommended policy

Restore the piecewise-quadratic comfort band while retaining the hard wall:

    0 ≤ W_low ≤ W_high ≤ W

    B(R) = λ_under · (max(0, W_low − R) / S_under)^2
         + λ_over  · (max(0, R − W_high) / S_over)^2

    subject to R ≤ W

The middle is flat. `λ_over` may be larger than `λ_under`; estimator risk and
the next append give the upper side a stronger operational justification. The
lower term should be strong only when occupancy is materially below the
acceptable range, not a one-token target attractor.

Do not require “must never refill after a shed.” Require these designed cases
instead:

- **No immediate rebound:** a forced A→B shed does not become B→A on the next
  ordinary accepted presentation.
- **Eventual correction:** a cut persistently far below `W_low` refills once
  fidelity plus under-fill welfare exceeds cache, continuity, and hysteresis.
- **Comfort-band neutrality:** two cuts inside the band receive the same `B`
  score.
- **No oscillation:** the Fable and Mythos fixtures do not enter A→B→A cycles.
- **Hard-wall priority:** no occupancy term or hysteresis can retain `R > W`.

If those tests reveal an immediate refill, fit the lower slope or adoption
margin first. A reason-coded, time-bounded post-transition cooldown is an
available fallback, but it should not be added unless the unified terms prove
insufficient; otherwise it would recreate the branch debt this design is
trying to remove.

### Solver consequence

A U-shaped `B(R)` means lower `R` is not globally a “no worse” dominance
direction. A lower-token partial label can finish below `W_low` while a higher-
token label finishes in the free band. Exact mode must therefore retain
separate `R` values and dominate only among equal-`R` labels, unless a stronger
continuation-independent proof is available.

This cost is acceptable because the fifth pass already declares exact mode an
oracle and bucketed `R` the production representation. Production can retain
one or more nondominated labels per token bucket and report the induced
occupancy-score error. Ease of dominance should not choose the welfare policy.

## 2. Make avoidable-change floors sound in approximate mode

### Finding

The score defines:

    K_floor(W) = min K(x) over feasible cuts
    C_floor(W) = min C(x) over feasible cuts

and prices only excess above those floors. This is the right semantic model:
when a halved budget forces a large rewrite, the forced portion must not be
treated as an optional continuity violation.

However, the production solver is approximate, while the current terminal
procedure computes both floors from the labels that survive approximation.
If the true minimum-K or minimum-C label was bucketed or pruned away, the
surviving minimum is an upper bound on the real floor. The solver can then
misclassify some avoidable change as forced and underprice it.

This does not threaten hard-budget feasibility—the scalar feasibility pass
still guarantees a cut under `W`—but it does threaten the intended behavior
during precisely the large budget transitions that motivated the floors.

### Recommended production contract

Production should run or preserve two extremal solves in addition to the main
welfare frontier:

1. minimize `K` subject to structural feasibility and `R ≤ W`;
2. minimize `C` subject to structural feasibility and `R ≤ W`.

They may use the same deterministic token bucketing as the main solver. Their
feasible witnesses must be retained in the terminal label set even when normal
frontier pruning would remove them.

Name approximate results honestly:

    K_floor ≤ K_floor_hat
    C_floor ≤ C_floor_hat

and report a lower bound or maximum gap for each. Scoring against the feasible
witness (`floor_hat`) conservatively forgives at most the reported gap; it does
not charge a transition for change known to be unavoidable under the bounded
solver. Exact/oracle mode continues to use the true floors.

The approximation report must include:

- token bucket width and rounding direction;
- `K_floor_hat` and `C_floor_hat` witnesses;
- lower bounds and floor gaps;
- the maximum propagated score error through `f_K` and `f_C`;
- confirmation that the exact minimum-token feasibility incumbent was never
  dropped.

For quadratic or piecewise policies, the score bound also needs a bounded
slope over the reachable K/C range. “Reports an optimality bound” is not an
implementation until the rounding error is propagated through the nonlinear
terminal functions.

## 3. Separate measurement calibration from welfare choice

### Finding

The fifth pass correctly says continuity parameters cannot simply be learned
from ordinary replay traffic. It then says `λ_K`, `S_K`, `W_high`, and
`λ_over` can be fitted because they are bills. That overstates what billing
data identifies.

Billing data can calibrate the raw cache-cost model:

- which prefix actually survived;
- cache-read, cache-write, and miss prices;
- predicted versus observed cache tokens;
- marker-quantization error;
- append and estimator-error distributions.

It does not identify how much fidelity should be traded for one unit of cache
cost, nor whether an extra 50k of churn should be penalized linearly,
quadratically, or at a piecewise operational knee. Those are welfare choices
unless the term is explicitly defined as an expected future bill with no
additional risk preference.

The same distinction applies to the upper occupancy term. `W_high` can be
informed by append volume and estimator error. `λ_over` is fitted from bills
only if `B(R)` is derived as a calibrated expected next-turn cost. Otherwise
it is the chosen exchange rate between headroom risk and fidelity.

### K and C are not generally collinear

The claim that K and C are collinear in normal traffic is also too broad.
Their spatial preferences deliberately differ:

- an early/old change invalidates a long provider prefix suffix and tends to
  have high K;
- a late/recent change invalidates a shorter suffix and tends to have low K;
- the continuity model intentionally weights recent represented material more
  heavily, so the late/recent change can have high C.

Whole-window rotations may make the observed series correlated, but the terms
are neither mathematically collinear nor redundant. The contrast is one reason
to keep both dimensions.

### Recommended Phase-0 language

- **Calibrate** raw K prediction and headroom-risk inputs from provider and
  replay measurements.
- **Choose** `f_K`, `f_C`, the lower/upper occupancy welfare curves, recency
  half-life/floor, representation-distance table, and stable-time floor as
  explicit policy judgments.
- **Validate** those choices on designed counterexamples and report the
  cost/fidelity/continuity frontier rather than claiming the chosen exchange
  rate was identified by historical bills.

The main design must also remove the remaining statements that `ψ` and the
continuity policy are fitted; the fifth-pass changelog, configuration table,
§3.2, and Phase 0 currently disagree.

## 4. Specify receipt-chain ordering and recovery

### Finding

Hash-chained presentation deltas are a good response to the O(leaves) state
size. A stability clock also does not need to be incremented for every leaf on
every request: store a global accepted-presentation sequence and, per changed
leaf, the sequence at which its representation last changed.

The current spec does not yet define how the chain behaves when callbacks are
duplicated, delayed, or observed out of order. Saying that an out-of-order
receipt cannot replace a newer layout is a test intention, not an ordering
algorithm. Without one, two accepted callbacks can fork the chain or apply a
delta against the wrong parent.

### Recommended receipt fields

Each accepted presentation record should include at least:

    branchId
    submissionSeq
    receiptHash
    parentReceiptHash
    requestHash
    layoutHash
    acceptedAt
    historyEnd
    changedLeaves: [{leafId, repHash, level, lastChangedSeq}]

A periodic snapshot contains the full live-leaf representation map plus the
current sequence. Deltas contain only appended, removed, or changed leaves.

### Required commit semantics

Choose and specify one of these models:

- **Single flight:** only one provider-bound request per branch may be in
  flight. The callback advances the chain head with compare-and-swap on the
  expected request and parent hash.
- **Ordered multi-flight:** assign `submissionSeq` before send, buffer
  callbacks as necessary, and advance the presentation head in the declared
  presentation order. A stale callback is idempotently recorded for telemetry
  but cannot become the continuity baseline.

In either model:

- duplicate callbacks are idempotent by `(branchId, requestHash)`;
- the commit compares against the current chain head;
- a delta is computed against the actual committed parent, not merely the
  receipt that existed when compilation began;
- snapshot cadence or maximum replay depth is configured and tested;
- hash or parent corruption fails loudly and falls back to a documented
  continuity-bootstrap policy;
- branch changes, restart, rollback, and garbage collection have fixtures.

If the runtime already guarantees single flight, state and assert that
invariant. It is considerably simpler than designing a reorder buffer.

## 5. Consistency cleanup

After the policy decision above, make one terminology pass before code:

- The summary says presentation state is threaded, while §3.2/§4.3 correctly
  say C is locally additive and needs no continuation state. The receipt is a
  fixed solve input; only cache-match state is threaded.
- Phase 1 repeats that accepted-presentation state is threaded.
- If the lower hinge remains removed, replace every remaining “occupancy
  band” reference with “upper headroom hinge/threshold.” If the lower hinge is
  restored, keep “band” and restore the corresponding configuration and tests.
- §5A.1 first says membrane always marks system, then correctly says native
  uses system only as a fallback. The opening should be scoped to the XML path
  used by Fable rather than stated as universal behavior.
- Replace stale Phase-0 language saying continuity is fitted with the chosen
  calibration-versus-welfare distinction from §3 above.
- Wrap the long Phase 1/2 and success-criterion lines while editing; several
  currently obscure the normative clauses.

## 6. Readiness decision

The canonical forest, hard feasibility pass, per-leaf continuity encoding,
cache/presentation separation, marker ownership contract, and bounded-solver
direction are sufficiently specified to begin isolated scaffolding and oracle
work.

The production selection policy is not yet ready to implement. Before coding
that layer:

1. decide the lower-hinge policy according to the intended welfare behavior,
   not dominance convenience;
2. specify approximate K/C floor witnesses and error propagation;
3. correct calibration language and designed cases; and
4. choose receipt-chain ordering semantics.

Once those are incorporated, the remaining work is Phase-0 validation rather
than another architecture redesign.
