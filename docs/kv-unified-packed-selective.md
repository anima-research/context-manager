# Packed propagation and selective exact scoring

This follow-up to PR #110 targets the two remaining measured costs: label
storage/grouping and repeated terminal leaf scans. It does not change policy
weights, grids, hard budgets, adoption thresholds, or label ceilings, and it
does not introduce a solve deadline. The certificate remains disabled in the
performance checks.

## Storage

The default DAG engine uses integer label handles and fixed-size binary64
records. Branches copy one contiguous record; transforms own their handles;
pruning returns rejected slots to a free list. Cache keys and comparison
fields are grouped in the first half of each record. Traces are immutable
parent/action indices in paged uint32 storage; pending assignments are only
materialized when needed by a surviving path or a branch.

Bucket lookup reuses generation-stamped numeric tables. Group membership and
representative handles are stored in reusable integer arrays, so each prune
does not allocate a Map entry and member array for every bucket. Unbounded or
non-numeric key spaces use sparse lookup with the same packed members; the
dense allocation limit only chooses storage and never changes the candidate
set or stops a solve.

Packed batches own their handles. Branching clones before either path can
mutate the original. Pruning reads every source envelope before updating a
retained representative, then releases only discarded handles. The object
engine remains available as `storage: 'objects'` for differential checks.

## Exact selection without every leaf scan

Each trace action caches its per-leaf fidelity/continuity sum, identity match,
and first emitted index for each render unit. A candidate estimate combines
those action sums instead of rescanning every leaf.

The cache cost is **exact**, not an estimate from propagation state: emitted
units are deduplicated, their earliest assigned leaf indices are sorted, and
the current token offsets and extension costs are accumulated in the same
chronological order as the exact evaluator. This handles gap-bearing ownership,
protected holes, changed receipt token costs, and fractional token counts.

Fidelity and continuity use conservative binary64 intervals. Both the grouped
sum and the exact evaluator sum the same nonnegative, precomputed floating-point
leaf terms. For a complete disjoint cut of n leaves, grouping uses at most 2n
additions and the exact evaluation at most n. The bound uses
`16 * Number.EPSILON * (n + 1)`, an outward-rounded error and endpoints, and a
subnormal allowance. If the bound is not usable, exact evaluation is used.
This is a rounding bound on a specific retained cut, not the solver's much
larger bucket-approximation error bound.

Selection proceeds in three stages:

1. Compute the exact cache floor. Refine every candidate whose continuity
   interval could lower the best exact continuity floor, even if that candidate
   is otherwise a welfare loser.
2. With both floors fixed, evaluate score intervals using the same monotone
   nonnegative score expression as the original scorer. Find upper bounds for
   the best candidate and the best candidate matching the accepted presentation.
3. Exactly evaluate every candidate whose lower bound could meet either upper
   bound. Apply the original score/token/frontier tie-break and hysteresis rule.

The selected candidate, both floors, and its score are exact. Public candidate
list inspection performs any remaining exact evaluations and returns the
complete sorted list, including the same selected object. Normal solving does
not inspect that diagnostic list. Captured budgets and token costs are retained
if callers later mutate the inputs.

`terminalEvaluation: 'full'` forces exhaustive rescoring on the packed engine.
`exactTerminalEvaluations` reports evaluations needed during the solve, before
later diagnostic-list inspection.

## Validation and benchmarking

Differential tests compare object storage, packed/full, and packed/selective
on varied forests, including every retained candidate, both normalization
floors, selected scores/frontiers, and all existing approximation-envelope
statistics. They also check intervals against every feasible small-forest cut,
cache corrections against full rendering, floor-setting welfare losers, exact
ties and hysteresis boundaries, non-finite fallback behavior, snapshots, and
label-slot reuse and growth.

Use the saved structural fixture without opening a resident store:

```sh
bun scripts/benchmark-kv-unified-general.mjs --fixture /path/to/solver-inputs.json \
  --objects --warm --budget 500000 --report /path/to/reference.json
bun scripts/benchmark-kv-unified-general.mjs --fixture /path/to/solver-inputs.json \
  --full-scoring --warm --budget 500000 --report /path/to/packed-full.json
bun scripts/benchmark-kv-unified-general.mjs --fixture /path/to/solver-inputs.json \
  --warm --budget 500000 --report /path/to/packed-selective.json
```

`--verify-estimates` exactly evaluates every estimate and asserts that its
fidelity/continuity intervals contain the exact result and that cache churn
and presentation identity match. Its timing is diagnostic, not the normal
selective-scoring timing.

The implementation is on a separate follow-up branch; no live runtime or
resident configuration was changed.
