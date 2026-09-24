# Packed propagation and selective exact scoring

These optimizations, originally developed in PR #112 and now combined into
PR #110, target label storage/grouping and repeated terminal leaf scans. They do not change policy
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

Selection, both floors, and scores are exact within the unchanged retained
candidate set; the existing bucket approximation is not removed. Public candidate
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

### Large structural fixture

On the 73,918-message / 3,345-summary fixture, paired fresh-process Bun 1.3.14 runs
against the object backend produced:

| Case | Object/full | Packed/selective | Reduction | Exact evaluations / retained cuts |
| --- | ---: | ---: | ---: | ---: |
| Warm cache, forced 500k budget | 8.721 s | 5.194 s | 40.4% | 3 / 6,719 |
| Warm cache, newly pinned middle leaf | 8.736 s | 5.229 s | 40.1% | 3 / 6,538 |
| Warm cache, 30k appended raw tokens | 9.149 s | 5.509 s | 39.8% | 3 / 6,648 |

The evaluation count includes the feasibility-witness check. All selected
frontier hashes, scores, floors, and pre-existing propagation/envelope
statistics match exactly. End-of-run RSS was 1.12–1.13 GB, versus 1.26–1.30 GB
for the object backend; these are process observations, not allocation limits.
An additional diagnostic run checked every one of the 6,538 pinned-case
estimates against its exact evaluation. These are single-run local timings,
not a cross-machine latency guarantee.

After merging `main` through #108 and #113, build and typecheck pass;
**838 tests pass / 0 fail**, versus **818 / 0** on that `main` head. The
four-chunk equal-score regression from #108 now checks both object and packed
storage (packed full and selective scoring). The tests and benchmarks do not
exercise provider calls or a live resident compile.

For a controlled sequential replay with differential decision checks:

```sh
bun scripts/replay-kv-unified-messages.mjs --fixture /path/to/solver-inputs.json \
  --metadata /path/to/replay-metadata.json --output /path/to/new-replay \
  --count 500 --verify-every 25
```

This verifies the selected frontier hash, all selected loss terms, both floors,
and score against the object engine at warm-up, every 25th message, and every
layout movement. Reference solves are excluded from measured solve time. It
uses a frozen summary catalogue, fresh atomic-layout cache markers, and accepted
results carried forward, not historical provider/cache-TTL reconstruction.

### 500-message replay

Revision `028b065` completed **500 / 500**, with **0 failures** and the
certificate disabled. Timings include canonical forest/solver construction,
solve, and selected frontier materialization. One warm-up is excluded;
percentiles use nearest rank.

| Statistic | Previous replay | Packed/selective | Reduction |
| --- | ---: | ---: | ---: |
| Minimum | 2.692 s | 1.815 s | 32.6% |
| Mean | 3.122 s | 2.044 s | 34.5% |
| Median | 2.837 s | 1.878 s | 33.8% |
| p90 | 3.544 s | 2.280 s | 35.7% |
| p95 | 4.959 s | 3.145 s | 36.6% |
| p99 | 8.069 s | 4.927 s | 38.9% |
| Maximum | 9.486 s | 5.611 s | 40.9% |

420 solves were under 2 seconds, 75 were between 2 and 5 seconds, and 5
were between 5 and 5.62 seconds. The last-100 median was 1.874 seconds.
Only 2–3 exact terminal evaluations were needed per measured solve.

All **23 reference checks** passed (22 measured samples plus warm-up),
including all four layout-changing solves. Those transitions changed
105 / 1,346 / 1,186 / 100 leaf resolutions and took
2.045 / 1.857 / 1.870 / 1.879 seconds. Reference checks compare frontier
hashes, selected loss terms, score, and both normalization floors. Tokens,
movement counts, terminal-label counts, and maximum labels per state match
the prior replay on every row. The old replay did not record frontier hashes
or scores, so full decision equality is claimed for the sampled reference
checks, not for all 500 historical rows.

The previous timing column is the archived pre-rebase `5c55a26` replay, not
a fresh 500-sample run of the #110 parent. The paired large-fixture table
above uses the current object backend. Replay high-water observed RSS was
3.285 GB, including the additional object-reference solves in the same
process; it is not a packed-only memory comparison.

After incorporating #108's frontier-based tie-break and extending it to packed
storage, a fresh forced-500k check took **8.686 s** with object storage and
**5.133 s** with packed/selective. Both selected the same 471,837-token
frontier, score, floors, and existing propagation statistics as each other
and as the earlier run. This is one fresh paired check; the 500-message replay
above predates the #108 merge.

Local receipts: `/Users/antra/sill-cm/data/solver-fixtures/packed-selective-20260921.t0hKsG/`.
The `replay-500/` directory contains `config.json`, `rows.jsonl`, and
`summary.json`. CI also passed on macOS and Ubuntu with Node 20 and 24.

The implementation is included in the combined PR #110; no live runtime or
resident configuration was changed.
