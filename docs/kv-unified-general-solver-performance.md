# General kv-unified solver performance

The previous solver propagated tens of millions of labels and eagerly rebuilt
and rescored thousands of complete frontiers. Sill's recorded compile took
244–286 seconds and 53–84 GB. A hysteresis certificate alone did not address
forced transitions, warm-cache cases, or protected holes.

This change accelerates the general solver. Every benchmark below disables
`hysteresisCertificate`. No policy weights, budget wall, bucket sizes,
adoption threshold, continuity multiplier, or label ceiling were relaxed.
There is no solve deadline. No live runtime or resident configuration has
been changed.

## Implementation

- Bucketed propagation selects the lexicographic extrema in one linear scan:
  fidelity, continuity, tokens, and maximum extension when a cache is relevant.
  Every priced dimension participates in tie-breaking, so each extremum is
  necessarily nondominated. Quadratic dominance filtering and repeated sorts
  are unnecessary in grid mode. Exact
  non-grid propagation still retains nondominated labels.
- Raw-run metrics are computed once per structural action. Select and emit
  are fused for broken/cold cache prefixes; immutable cache/envelope objects
  and singleton labels are shared. Idempotent re-pruning immediately after a
  child/root summary has pruned the same state is skipped. The DAG no longer
  performs giant BigInt leaf-mask operations for forced raw roots.
- Grid states use lossless numeric keys when the entire key range is safely
  representable; otherwise they use strings. An irrelevant cache has no state
  dimension. A broken relevant prefix retains its last matched marker because
  unmarked matches beyond that marker cannot affect future cache cost. Intact
  prefixes retain their full state. Following upstream #98, extension tokens
  are a priced dominance/envelope dimension and an extra warm-cache extremum,
  never an exact state-key dimension.
- Terminal evaluation precomputes per-leaf/per-level fidelity and continuity
  terms. Compact frontier ranges fill one reusable level vector. Sums follow
  exactly the oracle's forward-fidelity/reverse-continuity order. Cache pricing
  follows chronological first emissions, using current token offsets even
  when receipt costs differ. Full Maps and layouts are lazy; normal selection
  materializes only the selected frontier and any required tie/floor witness.
  Lazy results retain captured token costs if the input is later recalibrated.
- Internal protected holes now use the DAG's select/expand machinery instead
  of switching the automatic solver to the leaf-bitset reference engine.
  Selected summaries cover allowed participants, and their holes are solved
  through the children. Cache emissions use the first participating leaf and
  cannot flush past an unvisited ownership sibling, including nested gaps.
- Candidate scoring retains the existing cache/continuity floor normalization,
  score formula, tie-breaking, and hysteresis rule. Metric caches are reset
  between solves. Optional phase observations provide diagnostics without
  controlling selection or termination.

The existing bucket approximation is still an approximation. Coalescing
future-cost-equivalent cache states can change which approximate candidates
survive; this does not introduce a new criterion or a new approximation grid.
Explicit `engine: 'leaf'` remains a development/reference path; automatic
solves no longer select it for protected holes.

## Measurements on the saved Sill repro

Fixture: 73,918 leaves, 3,345 summaries. Bun 1.3.14 on this Mac. Policy and
10k/50k/100k token/continuity/fidelity buckets come from the recorded recipe.
RSS is measured process resident memory at completion, not a peak guarantee.
These measurements were collected at local revision `5c55a26`, before rebasing
onto the 0.10.1 release and incorporating #98's extension accounting.

| Scenario, certificate disabled | Time | RSS | Changed leaf resolutions |
| --- | ---: | ---: | ---: |
| Relevant cache, 528k wall | 8.96 s | 1.30 GB | 0 |
| Relevant cache, forced 500k wall | 8.48 s | 1.26 GB | 1,158 |
| Forced 400k wall | 4.19 s | 1.23 GB | 12,960 |
| Relevant cache, newly pinned folded leaf | 8.41 s | 1.30 GB | 170 |
| Relevant cache, 30k new protected tail tokens | 8.89 s | 1.26 GB | 1,158 |
| Initial solve without a presentation/cache receipt | 0.62 s | 0.88 GB | 2,540 |

The unmodified presentation's entire frontier matches the saved resolutions:
`e472784d56af59aca3e368044095b7014d7f7b4fe4f2983cc4c8034112c4fcc7`.
Its score remains `42134.53830120611`, at 507,298 rendered tokens.

The complete pinned-runtime offline compile, injecting this solver at its
solver boundary, took **6.911 seconds after store open** (6.123 seconds in
the general solver, with an irrelevant cache). It rendered 727
messages and 507,298 tokens, with zero moves and no certificate. Process RSS
was 7.61 GB including the opened resident store. The historical `budgetMet=false`
is unchanged: this layout is above the target but within the 528k hard wall.

These are measured operating cases, not a worst-case runtime proof for arbitrary
store sizes, bucket widths, or pin patterns. Live multi-turn operation,
compression/model calls, cross-platform performance, and deployment have not
been tested. The optional serialized-input baseline from the certificate-only
work was interrupted without a result; it is not used for a fresh speedup ratio.

## 500-message replay (pre-rebase)

The same benchmark revision completed 500/500 sequential message-prefix solves
with no failures and with the certificate disabled:

| Statistic | Seconds |
| --- | ---: |
| Minimum | 2.69 |
| Mean | 3.12 |
| Median | 2.84 |
| p90 | 3.54 |
| p95 | 4.96 |
| p99 | 8.07 |
| Maximum | 9.49 |

Nearest-rank percentiles exclude one initial warm-up. 475 solves were below
five seconds; the other 25 were the first 25 measured solves. Four solves
changed layout, taking 2.76–3.04 seconds.

This controlled replay covers the last 500 messages of the saved snapshot
(September 12–19): a 528k wall, moving 100k tail, snapshot summary catalogue
with future-source summaries excluded, and acceptance of each selected layout
before the next message. It does not reconstruct historical compression calls,
provider traffic, or cache TTL expiration. Timings include forest/solver
construction and selected-frontier materialization, not input preparation or
receipt generation. Raw data remains local under `replay-500/` in the receipt
directory. The full 500-message run has not been repeated after the rebase.

## Verification and reproduction

Tests compare prepared metrics, selected frontiers, scores, and both floors
with the exhaustive oracle across 120 cache/gap/hole/extension cases and 80
nested protected-hole/interleaved-ownership cases. Existing varied-forest,
policy, receipt, and integration tests also pass. A deterministic work-count
regression generates 22,435 candidates from 64 leaves: the original solver
reads source token costs 5,384,010 times, while the new solver reads them 2,112
times, with the same selected score. Lazy-layout snapshot behavior is also
tested. After rebasing onto `b272434` (0.10.1), the TypeScript build and typecheck
pass. The full Node suite passes: **813 passed, 0 failed**, compared with
**802 passed, 0 failed** on that `main` baseline. This includes upstream's
stale-receipt growth, extension-dominance, and cache-error-envelope tests.

A fresh post-rebase check of the saved fixture with a relevant cache and a
500k hard wall took **8.740 seconds**, at **1.278 GB RSS**, changing 1,158 leaf
resolutions. The selected frontier, score, cache floor, and continuity floor
all exactly match the pre-rebase run of that case.

All local fixtures and receipts are under:
`/Users/antra/sill-cm/data/solver-fixtures/hysteresis-20260920.yXh4p1/`.
Use `reduced-*.json`, `reduced-compile-report.json`, and
`general-tests-release.log`. The preceding `final-*.json`/`general-*.json`
timings predate removal of redundant prune passes. All six scenarios retained
identical frontiers, scores, and floors across that final optimization.

```sh
bun scripts/benchmark-kv-unified-general.mjs \
  --fixture /path/to/solver-inputs.json --warm --budget 500000 \
  --report /path/to/report.json
```

Additional independent scenarios use `--pin`, `--append-tokens 30000`, or
`--initial`. The script always disables the certificate. Its optional
`--stop-after-propagation` is a diagnostic-only exit that selects no layout;
it was not used in the final measurements.

For the complete offline compile, use a disposable, verified store copy:

```sh
bun scripts/benchmark-kv-unified-certificate.mjs --compile --general \
  --runtime /path/to/pinned-runtime --store-copy /path/to/disposable-copy \
  --recipe /path/to/recipe.json --report /path/to/compile-report.json
```

Do not open a live store for these diagnostics. The original Sill repro and
the live kv-stable resident were left untouched.
