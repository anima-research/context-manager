# Unified solve rev 6 — second review notes

Status: **REVIEW NOTES** — 2026-08-29.

Companion to `unified-solve-design.md` and
`unified-solve-review-notes.md`. These notes review the 2026-08-29 revision
and extend the design discussion to cache-marker placement and marker-aware
solving. They do not modify the primary specification.

## 1. Review outcome

The revision resolves two central defects from the first review:

- hard perturbation is no longer a feasibility constraint; and
- lambda-price bisection is no longer presented as an exact constrained
  solver.

The canonical-forest, exact-feasibility, and sparse-Pareto direction is a much
stronger foundation. The remaining implementation blockers are:

1. production demand still describes the withdrawn lambda solver;
2. locked-leaf and partial-group rendering semantics are not formalized;
3. cache state does not yet model all active marked prefixes;
4. convergence claims exceed what the stationary perturbation policy implies;
5. Phase 1 and several tests still describe the retired algorithm;
6. replay still mixes exact and modeled-counterfactual claims; and
7. inversion is simultaneously optional in the model and prohibited by the
   success criteria.

Cache-marker placement is also part of the control problem. The current
placement heuristic does not distribute the four available breakpoints
through the mutable summary region and should not be inherited by
`kv-unified`.

## 2. Remaining findings

### 2.1 Production demand must be redesigned for the Pareto solver

Rev 6 §8 still refers to a final `lambda_B`, a scalar `J`, and one lifted-mask
pass. Those concepts were removed from the main solver.

There is a second problem: a summary that has not been produced is not merely
a masked stored node. Live operation has no summary ID, authored content, or
measured recall-pair cost for it. Production demand therefore needs an
explicit latent-candidate layer:

1. Generate producible candidates from the compression grammar: uncovered L1
   spans and eligible higher-level sibling groups.
2. Assign an estimated recall cost and uncertainty to each candidate.
3. Insert a candidate counterfactually into the canonical forest.
4. Measure the improvement under the same feasible-frontier and welfare
   policy used for cut selection.
5. Define whether marginal values are individual, conditional on a selected
   production set, or an approximate ranking score.

Lifting all absent nodes together does not produce an individual marginal
value for each node. Re-solving once per candidate may be too expensive, so
the design must identify an approximation, sensitivity pass, or bounded
candidate set. The lambda-relaxed solver may provide a cheap demand heuristic,
but its reduced costs must not be described as exact welfare improvement.

### 2.2 Locked leaves and partial groups need an emission recurrence

`lockedByAgent` freezes a chunk at its carried resolution, not necessarily at
raw. Consider a leaf locked at L1 inside an otherwise selectable L2 group.
The solver must choose one of two semantics:

- the locked leaf vetoes L2 selection for the whole group; or
- L2 is emitted for participating siblings while the locked L1 is emitted as
  a protected hole.

The second matches current partial-group behavior, but it is not a plain
one-selected-ancestor exact cover. The parent summary semantically overlaps
the protected child emission. If partial groups remain supported, canonical
preprocessing must annotate every selectable ancestor with its fixed protected
emissions and define:

- rendered token cost;
- fidelity level per participating and protected leaf;
- perturbation/render-unit order; and
- conflicts among multiple locks and pins.

Only after that transformation can `select(v)` be treated as one local DAG
edge. Merely stating that the interaction will be defined later leaves the
solver recurrence incomplete.

### 2.3 The cache model must choose exact multi-turn or conservative one-turn semantics

Provider cache entries survive across renders within their TTL. A candidate
may diverge from the immediately preceding cut and still match a complete
prefix marked several turns earlier. Persisting only markers from the last
committed render cannot reproduce that behavior.

There are two coherent v1 choices:

**Exact multi-turn model**

- retain every unexpired marked-prefix identity, position, and write time;
- match candidate prefixes against the complete active set; and
- price from the longest active marked prefix that matches.

**Conservative one-turn model**

- retain only the previous committed render's marker set;
- deliberately treat recovery of older prefixes as a miss; and
- describe predicted perturbation as an upper bound, calibrated against the
  persistent multi-turn simulator.

The current draft combines singular last-render state with language implying
exact provider pricing. It should select one contract explicitly.

### 2.4 A stationary transition penalty does not guarantee profile convergence

Suppose the carried feasible cut A has higher fidelity loss than B, but B's
improvement is smaller than its avoidable-perturbation penalty. With no change
to history or policy, every later solve makes the same comparison and keeps A
forever. The policy therefore can alter the limiting profile, not just the
payment schedule.

The specification should either accept durable path dependence or introduce
a mechanism that eventually changes the comparison, such as:

- accumulated fidelity regret;
- a perturbation price that decays with stable time;
- scheduled restoration opportunities; or
- an explicit long-run/average-cost objective.

The normalized quadratic is also not, by itself, a bundling guarantee. Its
marginal penalty increases with perturbation. Structural suffix pricing makes
some edits after the first invalidation cheap, but whether additional changes
bundle depends on how those edits change the rendered suffix and on the shape
of `f`.

Until this is settled, remove claims that the welfare policy cannot change the
converged profile. If “guaranteed convergence” means algorithm termination
rather than convergence to a policy-independent memory profile, say so.

### 2.5 Phase 1 and the tests must match the Pareto design

The implementation plan still calls for “DP + bisection.” Phase 1 should name:

- canonical-forest construction and validation;
- the exact minimum-token feasibility pass;
- decision-DAG construction;
- sparse label propagation and dominance;
- deterministic resource ceilings and approximation;
- welfare selection over terminal labels;
- cache-prefix state; and
- the brute-force and CP-SAT/MILP oracles.

Tests should distinguish modes:

- **Exact mode:** agreement with brute force on small forests.
- **Approximate mode:** hard-budget compliance, deterministic output, retained
  feasible incumbent, and verification of the stated approximation bound.
- **Performance mode:** 100k-node runtime under a named production label
  ceiling and bucket configuration, not unconstrained exact Pareto expansion.

An arbitrary label ceiling does not create an optimality bound by itself. The
epsilon-dominance or rounding scheme must specify which dimensions round in
which direction and how the resulting token, perturbation, and welfare errors
are bounded. Token rounding must never admit an actually over-budget cut.

### 2.6 Replay is modeled, not exact

Historical `created` masking reproduces the old production trajectory. The
measured supply model is a useful counterfactual extension, but it is still a
model:

- demand consumes finite auxiliary-lane capacity and may delay speculative
  work that historical execution completed earlier;
- refusal and quarantine outcomes are stochastic or content-dependent; and
- a summary hypothetically produced earlier does not have a known actual
  token cost—the eventual stored summary's cost is a proxy.

Consequently, the supply difference is not necessarily one-directional, and
the replay cannot be described as reproducing live exactly. Report calibration
and uncertainty bands, then compare predicted and actual pilot behavior after
the switch.

### 2.7 Decide whether inversion is prohibited

The fidelity weights do not make age inversion structurally impossible. The
revised spec acknowledges this but leaves isotonicity optional while the
success criteria require zero inversion incidents.

Phase 0 must choose:

- If inversion is prohibited, add an explicit isotonic constraint and include
  it in canonicalization, feasibility, label propagation, and tests.
- If inversion is a preference, remove it from the zero-incident invariant and
  evaluate it as a replay/production profile metric.

## 3. Marker placement is a control problem

### 3.1 Why the current placement is inadequate

The current `placeMarkers` policy has four slots and prioritizes:

1. end of render;
2. the previous change boundary;
3. the head boundary; and
4. remaining evenly spaced seams by rendered-unit count.

When the first three are distinct, only one slot remains for systematic
coverage. Markers can cluster around the head, tail, or previous transition.
Unit-count spacing is also a poor proxy for exposure: one summary unit and one
raw unit can have very different token costs.

The previous change boundary is evidence about future hazard, not a location
that should automatically consume one quarter of the marker budget. A one-off
boundary can otherwise leave most of the summary depth unprotected.

### 3.2 Recommended v1 placement

Use all four breakpoints to cover chronological rendered-token depth:

- reserve the final marker at the end of the render for pure appends;
- place three interior markers through the mutable summary region;
- space by cumulative rendered or priced tokens, not by unit count; and
- snap each target offset to a legal render-unit boundary.

A simple baseline is approximately:

    25%, 50%, 75%, 100%

of rendered-token depth. Equal token spacing minimizes the worst unprotected
interval and bounds breakpoint quantization loss to roughly one quarter of the
window. The exact fractions may exclude a separately cached fixed system
prefix, but the four provider-visible slots and their accounting must be
explicit.

This baseline should replace `end -> previous boundary -> head -> leftover
spacing` in kv-unified experiments.

### 3.3 Hazard-weighted placement

The eventual marker placer should use a predicted distribution over the next
leftmost invalidation seam. For a render of total priced size `T`, marker set
`M`, and divergence position `d`, the surviving breakpoint is:

    m(d) = latest m in M with m <= d and matching prefix

Expected recomputation is:

    sum_d Pr(divergence = d) * (T - offset(m(d)))

Choose at most four ordered marker seams minimizing this expectation. Candidate
seams are render-unit boundaries; likely landing boundaries, group completion,
tail migration, and the previous transition can contribute hazard mass. With
only four markers on a line, this is a small deterministic segmentation DP,
separate from the large cut solver.

If no event model is trusted, equal cumulative-token spacing remains the
preferred fallback.

## 4. The cut solver must be marker-aware

### 4.1 Current markers determine current transition cost

For candidate cut `x`, define:

    CachedPrefix(x) = max offset(m)
      over active markers m whose complete prefix matches x

Then derive total recomputation from that breakpoint:

    Recomputed(x) = TotalRendered(x) - CachedPrefix(x)

Churn for the welfare label subtracts the priced pure-append baseline; appended
content is not free on the bill, only excluded from avoidable churn.

The marker set creates a staircase cost surface. With markers around 25%, 50%,
75%, and 100%, a change immediately after 75% preserves roughly three quarters
of the prefix, while a change immediately before it falls back to the 50%
marker. A continuous “tokens after the changed node” estimate cannot represent
that discontinuity.

`P_floor(W)` and every terminal perturbation label must use this same
marker-aware cost.

### 4.2 Cache-prefix automaton

For exact multi-turn pricing, compile all active marked prefixes into a small
prefix-matching automaton or trie. As a candidate render is emitted
left-to-right:

- each label carries its cache-prefix automaton state;
- passing a marked terminal records the deepest matching cached breakpoint;
- candidate unit identities advance the automaton;
- once no active cached prefix can continue matching, the label moves to a
  dead/miss state; and
- terminal perturbation is derived from the deepest matched marker.

This replaces an `intact/broken relative to x_prev` bit. It permits a candidate
to recover a prefix cached several renders ago. Dominance remains scoped by
the complete cache state: labels in different automaton states cannot be
merged merely because their numeric triples match.

If the conservative one-turn model is chosen instead, the automaton contains
only the immediately previous render's four marked prefixes. That is simpler,
but it remains an explicit approximation.

### 4.3 Temporal ordering and ownership

Avoid circularity by separating the marker sets used for reading and writing:

1. Load all unexpired markers from prior committed renders.
2. Solve the current cut using those markers.
3. Render and successfully commit the selected cut.
4. Run the marker-placement pass over the committed layout.
5. Write and persist those marked-prefix identities and expirations for future
   solves.

Previews, failed renders, production-only dry runs, and auxiliary solves do not
write cache state.

### 4.4 Do not jointly optimize next markers in v1

The current cut determines which unit seams are available for new markers, and
new marker placement affects future churn. Joint cut/marker optimization is
therefore a valid eventual T3 extension.

It is unnecessary for v1 correctness. Initially:

- make cut selection aware of markers that already exist; and
- optimize the next four markers in a separate deterministic post-selection
  pass.

When T3 is enabled, the predicted value of the best marker placement available
on a candidate layout can become part of future-churn scoring. This coupling
should be measured before it is added to the main label state.

## 5. Required design-document changes

Before implementation, revise `unified-solve-design.md` to:

1. replace §8's final-lambda shadow-price algorithm;
2. formalize locked/protected partial-group edge cost and fidelity;
3. select exact multi-turn or conservative one-turn cache semantics;
4. remove or implement the converged-profile invariant;
5. rewrite Phase 1 and scope exact versus approximate tests;
6. describe replay and supply timing as calibrated counterfactual models;
7. settle isotonicity in Phase 0;
8. specify three distributed interior markers plus the end marker as the v1
   baseline;
9. define marker placement by rendered/priced token depth;
10. replace the previous-cut bit with the selected cache-prefix matching state;
    and
11. persist cache entries only after a successful committed render.
