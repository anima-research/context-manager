# Unified solve rev 6 — review notes

Status: **REVIEW NOTES** — 2026-08-29.

Companion to `unified-solve-design.md`. These notes identify correctness gaps
in rev 6 and record the design direction that emerged during review. They are
not an implementation specification by themselves.

## 1. Working conclusions

1. **Keep the rendered-token wall hard.** A solve must return a cut with
   `R(x) <= W`, or return an infeasibility certificate proving that no such cut
   exists.
2. **Drop the hard perturbation cap.** A budget reduction can force an
   arbitrarily large transition. Perturbation is a welfare preference, not a
   feasibility constraint; there is no `pace-floor` outcome.
3. **Do not commit to a linear perturbation price yet.** The policy should be
   able to express nonlinear preferences over avoidable perturbation.
4. **Canonicalize the archive graph into an ownership forest before solving.**
   This is warranted if it turns exact-cover enforcement into a structural
   invariant and materially simplifies the solver.
5. **Separate feasible-candidate generation from welfare selection.** The
   recommended production algorithm is a sparse multiobjective label-setting
   DP over a tree-cut decision DAG, with deterministic approximation only if
   real frontier sizes require it.

## 2. Hard feasibility and soft perturbation

The only hard resource constraint should be:

    R(x) <= W

If the carried cut is no longer feasible—for example, because the context
budget was halved—the solver must choose another feasible cut regardless of
its transition cost. A perturbation preference must never authorize an
over-budget hold.

This removes the need for:

- `kvUnifiedHardReachTokens`;
- the Hard-P variant in rev 6 §4.4;
- `pace-floor` outcomes;
- hard-cap welfare claims and tests; and
- rollout assertions such as `p99 rotation size <= hard cap`.

Rotation-size percentiles remain important observability and alerting signals,
but not solver invariants.

### 2.1 Why a linear perturbation term is not yet justified

The initial proposal uses `lambda_P * Perturb`. That assumes a constant
welfare exchange rate between fidelity and every additional unit of churn.
The intended policy may instead distinguish among:

- routine small rotations;
- increasingly undesirable medium rotations;
- large rewrites forced by a new budget or feasibility condition; and
- extra improvements bundled into a rewrite that is already unavoidable.

A discrete tree-cut feasible set is non-convex. Linear scalarization selects
only supported points on its tradeoff frontier and may skip candidates that a
thresholded, quadratic, or lexicographic welfare policy would prefer.

The solver should therefore expose the attainable tradeoff frontier rather
than bake one linear exchange rate into its recurrence.

### 2.2 Price avoidable perturbation

For a given hard budget, define the perturbation floor:

    P_floor(W) = min Perturb(x) over cuts with R(x) <= W

Then apply the soft preference to avoidable perturbation:

    P_excess(x) = max(0, Perturb(x) - P_floor(W))

One plausible starting policy is a normalized quadratic:

    score(x) = FidelityLoss(x) + lambda * (P_excess(x) / S)^2

where `S` is an interpretable perturbation scale. This is a hypothesis to test,
not a settled choice. A piecewise function is preferable only if its
breakpoints correspond to meaningful welfare or operational regimes. Avoid
high-order polynomials whose tails and units are difficult to interpret.

The hard-budget behavior is then clean: if a budget reduction forces a 200k
transition, those 200k units establish the floor. The policy compares
candidates by the additional, avoidable perturbation they incur.

## 3. Recommended solver

### 3.1 Canonical forest to decision DAG

First construct a canonical ownership forest from live chunks:

1. Start at each live chunk's `l1Id`.
2. Follow the summary parent chain upward.
3. Include only summaries reachable through those ownership chains.
4. Require leaf-disjoint canonical roots.
5. Detect cycles, conflicting ownership, missing links, and irreducible scar
   shapes explicitly.
6. Represent boundary/overlap-exempt raw emissions as annotations and extra
   node-local rendering cost, rather than as competing ownership edges.

The result must guarantee that every live leaf has exactly one path to exactly
one root. The raw archive-facing `SummaryTree` may remain available, but the
solver should consume a checked `CanonicalSummaryForest` view.

A canonical forest can be compiled into a linear-size decision DAG. At each
summary node:

- `select(v)` emits `v` and jumps past its descendants; or
- `expand(v)` enters its children in chronological order.

Leaves have only a select action. Existence, protected-zone, lock, and pin
rules enable, disable, or force actions. The prefix/cache state is threaded
through the DAG.

### 3.2 Sparse Pareto label-setting DP

Each partial path carries a label containing at least:

    (renderedTokens, perturbation, fidelityLoss)

For each `(DAG position, cache/prefix state)`, discard dominated labels. Label
`a` dominates label `b` when it has no greater rendered tokens, perturbation,
or fidelity loss, and is strictly better in at least one component.

At the terminal state:

1. discard labels with `renderedTokens > W`;
2. calculate `P_floor(W)` from the remaining labels;
3. apply the selected nonlinear welfare function to `P_excess`; and
4. use the total deterministic node-ID tie-break.

This keeps structural solving separate from welfare policy. Quadratic,
piecewise, knee-selection, and lexicographic policies can be evaluated without
rewriting the forest recurrence.

### 3.3 Worst-case control

Exact Pareto frontiers can grow exponentially. The implementation should:

1. begin with exact sparse dominance;
2. measure label counts and runtime on the Mythos and Fable fixtures;
3. impose a deterministic resource ceiling; and
4. if the ceiling is exceeded, rerun with documented epsilon-dominance or
   token/perturbation buckets.

Approximation may affect which feasible cut wins, but must never affect budget
compliance. Any approximate solve should report its bucket sizes, pruning
mode, and a useful optimality bound. Bucket granularity should be chosen from
replay evidence rather than fixed in the design in advance.

### 3.4 Exact feasibility pass

Run a separate scalar tree DP to compute:

    R_min = min R(x) over all structurally admissible cuts

At each subtree this pass chooses the cheaper admissible alternative between
selecting the parent and expanding its children. It provides:

- an exact feasibility decision;
- `floorTokens` for the certificate;
- the binding subtrees and constraints; and
- a guaranteed feasible incumbent whenever `R_min <= W`.

If `R_min > W`, return an infeasibility certificate. Otherwise the main solver
must return a cut under `W`, even when transition cost is large.

### 3.5 Development oracle

Maintain a CP-SAT or MILP formulation as an offline correctness oracle, not as
the initial production dependency. Use it to:

- compare random small forests with brute-force enumeration;
- validate the sparse DP on real snapshots;
- test dominance and approximation behavior; and
- explore alternative welfare functions.

The fast lambda-relaxed DP remains useful for lower bounds, warm starts, and
candidate generation, but not as proof of exact constrained optimality.

## 4. Correctness issues in rev 6

### 4.1 Budget-price bisection is not an exact constrained solver

For fixed `lambda_B`, the inner tree DP can exactly solve the relaxed scalar
objective. Bisecting `lambda_B` does not, however, guarantee the optimum under
`R(x) <= W`. It finds only supported points of the discrete token/value
frontier.

A minimal counterexample has two independent refinements:

| refinement | added tokens | added utility |
|---|---:|---:|
| A | 2 | 3 |
| B | 3 | 4 |

With budget 3, B alone is the constrained optimum. Under a linear token price,
the relaxed solver chooses both, A alone, or neither depending on the price; B
alone is never selected. Thus the bisection can miss the true feasible optimum.

The claimed one-group-quantum duality gap and bounded single-node repair do not
follow for a general tree cut. A repair can require coordinated swaps across
multiple subtrees.

### 4.2 The original hard-P recurrence was insufficient

The prefix bit records whether divergence has occurred. It does not record the
priced suffix accumulated after divergence, so it cannot enforce
`Perturb(x) <= P`. Candidate-dependent suffix cost cannot generally be reduced
to a static selectability mask.

Dropping hard P removes this feasibility defect. A nonlinear soft policy still
requires perturbation to remain in the candidate label; the one-bit, O(n)
scalar recurrence is no longer a complete solver for that policy.

### 4.3 Cache pricing must operate on prefixes, not node identity

Provider cache reuse applies to complete marked prefixes. A node rendered
before does not become a cache read when an earlier edit shifts its prefix.
Accordingly, a bounded LRU of rendered node IDs cannot determine cache-read
pricing.

The perturbation model must use actual persisted marker/prefix state or a
clearly conservative approximation. With discrete markers, recomputation may
begin at the latest matching marker before the changed node, rather than at
the changed node itself. Multi-turn recovery of an older cached prefix also
depends on prefix content, not individual node membership.

The design must additionally distinguish total transition cost from churn in
excess of unavoidable appended content. Calling the former exact while never
charging extensions is inconsistent.

### 4.4 Locked chunks are absent from F1-F5

`lockedByAgent` freezes a chunk at its carried resolution; it does not
necessarily force raw rendering. This persisted invariant needs an explicit
feasibility rule. The canonical forest representation must define how frozen
leaves interact with ancestor selection and existing partial-group/boundary
exemption rendering semantics.

### 4.5 The existing SummaryTree is not already a canonical forest

The current tree view loads every summary, treats every parentless summary as
a root, and acknowledges overlapping reachability in damaged chronicles.
Those shapes violate the leaf-disjoint tree assumption required by the
proposed exact-cover DP. Canonical treeification must be an explicit checked
preprocessing phase; consuming the existing roots unchanged is unsafe.

### 4.6 The monotone-fidelity guarantee does not follow

The proposed weight

    salience_i * age_i^(-alpha) * rawTokens_i

is not monotone in age when salience and chunk size vary. Even monotone weights
would not prevent inversions when groups have different summary costs,
compression ratios, existence constraints, or pins. If "recent coarse,
ancient fine is unrepresentable" is a welfare requirement, enforce it as an
explicit isotonic constraint. Otherwise state it as a tendency to validate in
replay. Define age with a positive floor to avoid `age = 0` producing infinity.

### 4.7 The anti-cycle margin is hysteresis, not a proof

The objective changes across turns as ages, availability, history, and the
previous cut change. Strict improvement against each turn's current objective
does not rule out returning to an older composition under a later objective.
The epsilon margin is useful hysteresis, and the Fable fixture is a valuable
regression gate, but neither establishes a structural no-cycle theorem.

## 5. Replay and integration gaps

### 5.1 Historical creation-time masking is not closed-loop replay

The new demand list changes when summaries are produced. Masking a final export
at historically recorded creation times reproduces the old policy's supply
trajectory, not the trajectory caused by kv-unified demand. A replay that is
intended to replace live shadow validation must execute demand through a model
of queueing, production latency, refusal, quarantine, and merge availability.

There is also a schema naming mismatch: the persisted `SummaryEntry` field is
`created`, not `createdAt`.

### 5.2 Persistent state needs an explicit commit boundary

`prev-cut` must mean the last successfully committed render. It must not be
updated by previews, failed compiles, production-planning dry runs, or any
extra shadow solve. The implementation specification should name:

- the owner that registers and loads unified-solver state;
- the point after successful rendering that commits it;
- behavior across branch changes and rollback to `kv-stable`; and
- which marker/cache state is stored alongside the cut.

## 6. Suggested revised headline

The rev 6 headline currently promises one scalar objective and an exact
linear-time solve. The reviewed direction is more accurately summarized as:

> One canonical feasible frontier, one explicit welfare policy, and one
> deterministic bounded solver. Hard budget feasibility is exact; welfare
> selection is Pareto-based and may use measured, reported approximation when
> real frontier growth requires it.
