# Unified solve rev 6 — final review changes

Status: **REQUIRED SPEC CHANGES** — 2026-08-29.

Companion to:

- `unified-solve-design.md`;
- `unified-solve-review-notes.md`; and
- `unified-solve-review-notes-2.md`.

This document converts the final review into concrete changes for the primary
specification. It also records the decision that membrane's cache-marker
behavior must become consistent across formatter paths before CM can own the
four-marker budget.

## 1. Constraint composition: intersect, never pick a winner

Replace F4b's `deepest-constraint-wins` rule with constraint intersection.
Pins and locks are absolute constraints; choosing one constraint by precedence
would silently violate another even if the violation were logged.

For each live leaf, canonicalization builds an allowed-level set:

    allowed(leaf) = produced levels on its ownership chain, including L0

Then intersect all applicable restrictions:

- head/tail/raw protection: `{0}`;
- compression quarantine: `{0}`;
- `lockedByAgent`: `{carriedResolution}`;
- exact pin `level = p`: `{p}`;
- maximum-level pin `level <= p`: all produced levels `<= p`;
- minimum-level pin `level >= p`: all produced levels `>= p`.

If the intersection is empty, the solve is infeasible. The certificate reports
the conflicting constraints and leaf IDs. No constraint is weakened, clamped,
or selected as a winner inside the solver.

Restrictions on different sibling leaves may still create a protected-hole
emission. Canonicalization annotates each ancestor action with:

- participating leaves rendered at the ancestor level;
- protected holes rendered at their individually required levels;
- the exact chronological unit sequence;
- recall and protected-emission token costs; and
- per-leaf fidelity levels.

The transformed action is local only after those values are fixed. Conflicts
on the same leaf remain infeasibility, not partial-group behavior.

### Required tests

- compatible `>=` and `<=` constraints intersect to an interval;
- exact pin plus matching lock succeeds;
- exact pin plus conflicting lock returns infeasibility;
- contradictory overlapping pins return infeasibility;
- different constraints on siblings compile into the expected protected-hole
  render; and
- no solve result violates any original constraint after canonicalization.

## 2. Separate frontier persistence from provider-cache receipts

The current draft commits marker state after a successful context render. That
is too early: compiling or rendering a request does not prove that the provider
accepted it or wrote its cache entries.

Split state into two independently committed records.

### 2.1 Carried frontier state

Committed when the strategy applies and persists the selected resolutions:

    `${ns}/kvunified:frontier`

Contains:

- ordered selected-node identity;
- per-chunk applied resolutions or a hash linking to the existing resolution
  state;
- solver-policy version; and
- compile timestamp/sequence.

This is the previous policy state. It may exist even if no provider request was
subsequently sent.

### 2.2 Observed provider-cache state

Committed only after membrane reports that the corresponding request reached
the provider cache boundary successfully:

    `${ns}/kvunified:cache-receipts`

Contains:

- request/layout hash;
- exact marked-prefix identities and offsets present on the wire;
- marker write timestamp and TTL;
- provider/formatter identity;
- request disposition sufficient to know that the request was accepted; and
- observed cache-read/cache-creation usage when available.

The context manager must not infer this record from compile success. It needs a
host/membrane callback analogous to `reportRealInputTokens`, for example:

    reportCacheReceipt({
      requestHash,
      layoutHash,
      markers,
      provider,
      acceptedAt,
      cacheReadTokens,
      cacheCreationTokens,
    })

The exact API name remains implementation-owned, but request identity must
prevent a receipt for one compile from being applied to another.

For the conservative one-turn v1 model, the next solve reads the newest valid
provider-cache receipt, not merely the newest compiled frontier. If no matching
receipt exists, it conservatively prices a miss.

### 2.3 Stability-clock semantics

Define τ in accepted provider renders, not compiler invocations. A preview,
abandoned compile, local render, rejected request, or production-only dry run
does not advance continuity time. A request accepted by the provider advances
τ even if the model later returns a refusal, because the input was presented
and may have populated cache.

If reliable provider acceptance cannot be distinguished from response
completion, use the narrowest observable receipt and document the resulting
conservative behavior.

### Required tests

- compile without send changes frontier state but not cache state;
- preview changes neither;
- rejected/transport-failed request writes no cache receipt;
- accepted request writes the exact wire markers under its request hash;
- an out-of-order receipt cannot replace a newer unrelated layout; and
- restart/branch change loads frontier and cache state independently.

## 3. Put region-specific decay into the formal objective and label state

The draft introduces a persisted τ per marker/region but leaves the terminal
score as `Loss + f(P_excess)`. Make the candidate's change region explicit.

For candidate cut `x`, define:

- `d(x)`: the earliest rendered region whose emitted unit sequence differs
  from the carried frontier;
- `tau(d)`: accepted renders since a rotation last touched region `d`; and
- `g(tau)`: the fitted decreasing multiplier with floor `g_min`.

The v1 score becomes:

    score(x) = FidelityLoss(x)
             + g(tau(d(x))) * f(P_excess(x))

For a no-change candidate, perturbation is zero and `d(x)` is absent.

The cache/prefix state carried by a label must identify `d(x)` once divergence
occurs. Dominance is valid only among labels whose future scoring state is
equivalent. At minimum, the dominance key contains:

    (DAG position, cache-match state, earliest-change region)

If `g` varies per region, labels with equal numeric `(R, P, Loss)` but different
earliest-change regions cannot be merged.

The specification must also weaken the τ-release property to match `g_min`:
a held cut rotates eventually only when its accumulated fidelity advantage is
large enough to beat the floor-priced transition. A nonzero `g_min` explicitly
allows durable continuity preferences.

### Required tests

- equal-cost labels with different τ regions remain distinct;
- increasing τ can release a designed held cut;
- regret below the `g_min` threshold remains held by design;
- forced budget transitions ignore the perturbation preference for
  feasibility; and
- replay and restart preserve τ by region.

## 4. Membrane cache-marker consistency contract

CM-owned placement requires one marker contract across every membrane
formatter. Today the paths are inconsistent:

- the native formatter treats the system marker as a fallback when message
  markers exist;
- the XML formatter marks system whenever prompt caching is enabled;
- a `contextPrefix` may create another automatic marker; and
- imported block-level `cache_control` values may pass through independently.

The decision is to make membrane consistent rather than encode formatter-
specific slot arithmetic in context-manager.

### 4.1 Configuration modes

Define one normalized request option with identical meaning everywhere:

    cacheMarkers: 'membrane-system' | 'cm-owned'

`membrane-system` preserves the compatibility default:

- membrane may place its normal system/context-prefix fallback marker;
- caller message breakpoints remain supported; and
- the request builder validates the global provider limit loudly.

`cm-owned` means:

- membrane adds no automatic system marker;
- membrane adds no automatic context-prefix marker;
- only caller-supplied normalized message breakpoints become new
  `cache_control` blocks;
- tools/system/context prefix remain part of the cached prefix when an ensuing
  message breakpoint is marked;
- stale imported block-level markers are either rejected/stripped at a named
  normalization boundary or counted as caller-owned markers—never invisible;
- the raw request must contain at most the provider limit; and
- membrane returns the exact marker receipt used for cache-state persistence.

The treatment of stale imported markers must be one explicit policy. The
recommended CM-owned behavior is to reject them before request construction,
because CM cannot optimize a slot budget containing hidden markers. The
existing loud data-defect behavior may remain in `membrane-system` mode.

### 4.2 Formatter parity

Apply the same normalized marker policy to:

- native Anthropic formatting;
- Anthropic XML/prefill formatting;
- Bedrock formatting and TTL rewriting;
- context-prefix handling;
- tool-in-system and tool-in-conversation modes; and
- any provider adapter that passes normalized `cacheBreakpoint` state.

No formatter may independently decide to spend an extra slot after normalized
marker planning.

### 4.3 Wire receipt

After formatting, membrane computes a receipt from the raw request:

    {
      requestHash,
      formatter,
      provider,
      markers: [
        { ordinal, prefixHash, estimatedOffset, source }
      ]
    }

`source` distinguishes CM message markers, compatibility fallbacks, context
prefixes, and imported passthroughs. In `cm-owned` mode every source must be
CM-owned or the request is rejected before provider submission.

The context manager persists only a receipt corresponding to an accepted
request. Estimated offsets can later be reconciled with provider token usage;
prefix identity must be based on the exact normalized/wire content, not only a
summary-node ID.

### 4.4 Marker-budget tests

For every formatter/provider combination, capture the raw request and assert:

- `cm-owned` with four CM breakpoints produces exactly four
  `cache_control` blocks;
- no automatic system or context-prefix marker is added;
- tools and system are included in the prefix protected by the first CM
  marker;
- `membrane-system` retains compatibility behavior;
- stale imported markers follow the selected explicit policy;
- duplicate requested seams are deduplicated deterministically before the
  wire boundary;
- zero, one, and four requested markers behave consistently;
- five markers fail before network submission with diagnostics listing their
  sources; and
- native, XML, and Bedrock builds return equivalent marker receipts for
  equivalent normalized requests.

## 5. Marker-placement cleanup

Retain the new marker-placement direction, with these corrections.

### 5.1 Use honest stability labels

Rename structurally terminal summary groups from `immutable` to
`production-complete`. Inability to produce a deeper parent does not prove the
cut will remain unchanged: τ decay, age weights, pins, and budgets can still
change selection.

A seam is `stable(horizon)` only if the planner finds no known transition at or
before it within the placement horizon, considering:

- pending production;
- held-versus-ideal regret and τ release;
- append/tail migration;
- age-driven policy changes;
- known pin/config changes; and
- current budget-transition state.

Global exogenous events remain unpredicted and are handled by distributed
coverage, not by an `immutable` label.

### 5.2 Deterministic slot completion

The candidate seams `deep`, `mid`, `historyEnd`, and `end` may coincide, be
unavailable, or appear out of order. Specify:

1. generate labelled candidate seams;
2. clamp and sort by chronological rendered offset;
3. deduplicate equal wire boundaries;
4. retain mandatory `historyEnd` and `end` when distinct and admissible;
5. fill unused slots from equal cumulative-priced-token targets over uncovered
   intervals; and
6. emit no more than four distinct markers.

The post-selection placement pass returns both chosen seams and reasons so the
marker-stability dashboard can distinguish planned placement from fallback.

## 6. Production-demand corrections

Replace “exact Pareto re-solves” with “the same bounded Pareto solver used for
cut selection.” Each candidate evaluation reports:

- exact versus approximate mode;
- approximation/bucket parameters;
- estimated recall cost distribution;
- welfare improvement under the point estimate; and
- a conservative or uncertainty-adjusted improvement used for ranking.

Define the no-candidate baseline as the solver-selected feasible frontier under
the current policy, not simply the committed cut. The candidate's marginal
value is:

    demandValue(c) = score(best frontier without c)
                   - score(best frontier with c)

Both sides use the same cache state, hard budget, welfare policy, and
approximation configuration. A candidate with an uncertain cost should not be
called beneficial without stating the risk rule; v1 should use a conservative
upper cost quantile or report expected and conservative ranks separately.

The lambda-relaxed reduced-cost pass remains a heuristic pre-filter only.

## 7. Replay wording changes

Delete the stale statements that created-time masking reproduces live exactly
and that its error is one-directional. Replace them with:

> Created-time masking prevents future-complete replay but reproduces only the
> historical supply trajectory. The measured supply queue is a calibrated
> counterfactual for kv-unified demand; it is not an exact reconstruction.
> Demand may accelerate selected summaries and delay competing speculative
> work. Hypothetical summary cost and refusal behavior remain modeled. Replay
> results therefore carry calibration and uncertainty bands, and the pilot's
> predicted-versus-actual series is the final validation.

The replay harness must also use the same normalized marker contract and
receipt semantics as the live formatter. Simulating four CM markers while the
wire path silently adds a fifth is not a valid replay.

## 8. T3 remains gated behind a separate formal review

T3 is disabled in v1. Before Phase 4, specify:

- whether future churn is folded into fidelity loss or carried as another
  Pareto dimension;
- how overlapping predicted suffix rewrites avoid double-counting;
- how future marker placement contributes to the term;
- how uncertainty in event time affects discounting; and
- dominance rules when two labels have different future-event exposure.

Do not enable `lambda_F` merely because the interface exists. Phase 4 needs
brute-force/oracle agreement on small event-annotated forests and replay
evidence that the term improves calibrated future cost.

## 9. Primary-document reconciliation

Make these editorial/plan changes alongside the substantive corrections:

1. In §7, remove “rendering, emission ... untouched”; marker emission and one
   membrane option change deliberately.
2. In Phase 0a, fit and record `lambda`, `S`, `H`, and `g_min`, including the
   release and durable-hold cases.
3. In Phase 0c, explicitly record the isotonicity decision and update the
   success criteria in the same change.
4. Add a Phase 0 marker gate: raw-request parity across native/XML/Bedrock,
   marker survival replay, and provider-limit validation.
5. Scope “guaranteed convergence” to deterministic solver termination and
   fixture non-cycling, as §15 already does.
6. State that all cache-cost evidence produced under old marker placement is
   indicative until rerun under the CM-owned four-marker contract.

## 10. Readiness criterion

The v1 specification is implementation-ready when:

- constraint conflicts produce infeasibility rather than precedence;
- frontier and provider-cache state have separate commit boundaries;
- τ decay is part of the formal score and label state;
- membrane exposes one tested CM-owned marker contract across all formatter
  paths;
- marker state is persisted from accepted wire receipts;
- replay contains no exactness/one-directionality contradiction;
- candidate demand uses the bounded solver and an explicit uncertainty rule;
  and
- Phase 0 owns the marker, decay, and isotonicity decisions it gates.
