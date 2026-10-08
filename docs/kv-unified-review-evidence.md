# KV-unified review evidence

This candidate is for review and should remain unmerged while the open
correctness and performance questions are evaluated. It follows the
[certificate report in #131](https://github.com/anima-research/context-manager/issues/131#issuecomment-6021629553).
The starting revision is `537d921` (v0.13.0).

## Reproduce the public checks

After installing the lockfile dependencies with `npm ci`:

```sh
npm run build
npm run typecheck
node scripts/verify-kv-unified-offline.mjs
```

The offline runner excludes only `test/autobiographical.test.ts`, which creates
a real Anthropic provider. The combined source previously passed 954 tests in
121 files, with zero failures or cancellations under Node 22.22.3. The final
publish copy was freshly built and typechecked, and passed 46 focused tests
(including changelog checks) with zero failures or cancellations. Its 208
TypeScript/build input files and emitted runtime JavaScript match the validated
combined source byte for byte. The full offline suite was not repeated for
the publication-only documentation and runner changes. These are offline
results; the provider integration was not exercised.

The focused checks can also be run after building:

```sh
node --test --test-concurrency=1 \
  dist/test/adaptive/kv-unified-certificate*.test.js \
  dist/test/adaptive/kv-unified-internal-evaluation.test.js
```

The fixtures are generated from small deterministic inputs in the test files.
They cover nested holes, pins and locks, ownership gaps, current and stale
receipts, fresh L1 summaries, refolding, numeric boundaries and context,
extension and depth caps. The independent checker uses Cartesian leaf-level
assignments and a global atomic-coverage predicate, rather than the canonical
select/expand recurrence; it checks 310 carried cuts and their lower bounds.
Eight evolving turns cover changing accepted history and constraints.

Internal evaluation checks cover SameValueZero cache keys, multiple levels and
array identities, iterator exceptions and reentry, independent trace ancestry
across arena page growth, detached public visitors, and delayed exact and lazy
reads. These tests do not establish a general reentrancy contract for every
shared-scratch evaluator operation.

## PR143 review follow-up — 2026-10-07

The context-node cap did not bound aggregate active-leaf sets or repeated long
identifier serialization. Context compilation now checks separate linear
membership and identifier-work budgets before constructing each key or child
lists, including memo hits. Exceeding either declines conservatively to the
existing solver. Two adversarial regressions observe key inputs on a 60-level
chain with 20 leaves per pin level and a shorter chain with a repeated long ID;
both reproduced budget overruns on the previous certificate code. The long-ID
case also checks exact full-solver fallback, including candidates and bounds.

The previous combined lazy-layout test had no matching cache receipt and
compared empty unit lists. It now checks cache-relevant raw and summary actions
sharing an ID array, distinct churn, raw units and one deduplicated recall beside
a raw leaf after input changes. This strengthens coverage; the existing terminal
evaluator passes without a runtime change.

The final code was freshly built and typechecked under Node 22.22.3. Focused
certificate/evaluation/changelog checks passed **48 tests, 0 failures**. The
full offline suite passed **956 tests, 0 failures, cancellations or skips**;
only the real Anthropic provider test was excluded. These are correctness and
resource-guard checks, not new latency, allocation, RSS or GC measurements.
The earlier timing cohorts below predate these storage guards and do not
establish performance for this revision.

**One policy change, always on.** Latent demand scores every what-if solve in
one shared floor frame (fixing the sign error of the per-solve frames) and
emits a merge only when the best-vs-best improvement exceeds `adoptEpsilon`;
`main` emits any merge with improvement above 0. The emitted context is
unchanged, but the set of requested merges is not: a request that `main`
scored negative and this head scores positive is new, and one with an
improvement in `(0, adoptEpsilon]` is dropped. With `speculativeProduction:
false` the difference reaches the store (different summaries and ids). A
differential harness run by a reviewer (about 2,500 compiles, histories of
50 to 5,021 messages, certificate on and off, epsilon 0 and 50) found no
divergence in emitted messages, layouts, receipts, state or selection under
the default configuration, and divergences in produced requests only. The
maintainer decides whether this lands as is or behind a flag.

## Earlier certificate-only timing

These are the earlier A/B measurements reported in #131, before the two
microoptimizations were combined into this candidate. They compare the
internal-hole certificate candidate with `537d921`, with the certificate
enabled on both sides. They are not a timing comparison of the final combined
PR.

The input was one synthetic/scrubbed pinned Nemo snapshot with no latent-demand
candidates, on Bun 1.4.2. There was one warmup and three measured solver repeats.
The table uses the median bare `solve()` entry time, excluding fixture decode,
forest construction and solver construction. Full-compile rows are separately
observed cold/warm runs, including recorded capture instrumentation.

| Measurement | Baseline | Certificate candidate |
| --- | ---: | ---: |
| Mac M1 Max solver-entry median | 0.790 s | 0.287 s |
| OVH Haswell solver-entry median | 2.649 s | 0.847 s |
| Mac warm compile, one observation | 1.936 s | 1.224 s |
| Haswell warm compile, one observation | 6.559 s | 4.604 s |
| Haswell cold compile, one observation | 6.294 s | 6.466 s |

The carried layout had 451,141 tokens and score 73,222.332559. The certificate's
maximum possible improvement was 867.130557, below the existing epsilon of
2,000. The measured outputs had identical frontiers, token counts, scores,
normalization floors and rendered content. The speed difference comes from
certified early exit, not acceleration of the full propagation search.

Observed maximum Mac process RSS rose from 2,074 to 2,403 MB in that campaign.
This was not an isolated solver-memory experiment and does not establish a
consistent allocation or GC cost. Three solver repeats and individual compile
observations do not establish general latency or production behavior.
The private snapshot, store data and raw machine logs are not published here.

### Separate myserv package-02 result

A later certificate-only package-02 run used the same pinned input/configuration
and Bun 1.4.2, with matching runtime, dependency and harness identities and
semantic-output parity. Each build had one warmup and three measured solver
samples. Median bare solver entry was **1.548 s baseline / 0.601 s candidate**.
Warm compile was **4.212 s / 3.619 s**, one observation per build. Cold compile
was **4.628 s / 6.547 s**, also one observation per build; cold improvement is
not established. This later bundle includes the certificate ownership-depth
guard and predates the internal cache/visitor changes. It is a separate cohort
from the Mac/Haswell table and does not measure the final combined PR.

## Why include the internal evaluation changes

The first-level action cache avoids a nested Map lookup/allocation for ordinary
single-level action arrays. Other levels still use a lazy fallback Map; those
arrays also retain an entry object. Internal packed references share one
visitor function and still allocate reference objects and retain their arena.
Public detached-callable references preserve their existing behavior.

These are specific reductions in repeated work, included for review by the
author's choice. There is no demonstrated comparative wall-time, total
allocation, peak-RSS or GC gain for either change or their combination.

## Further investigations and next steps

Through EXP-51, a count-only buffered-key reduction failed a cache-marker
counterexample in general compiled emit/flush state. Reachability at the same
pruning point was not established. The full CM131 buffered-key proposal remains
unproved rather than disproved. Immutable
forest cost views preserved tested results but did not establish acceleration.
Cover-metric reuse had mixed timing and was parked. Further action/range and
child-order caches, outer action handles, and clone/concat changes were rejected
or deprioritized after counters and profiling found insufficient evidence for
another useful variant. None is included in this PR.

The remaining work is label growth, pruning/representative cover, repeated
terminal walks and distinct counterfactual solves. The next proposed step is
to establish sufficient state for more complex exact pruning and test it
against cache-prefix/emission counterexamples. Then implement one isolated
change, verify survivors, traces, ties and error envelopes against an
independent oracle and current solver, and run bounded performance tests.
This is a plan, not work already completed. Demand scenario selection is
unchanged apart from the shared frame and the epsilon gate above; joint
demand, skipping scenarios and emergency fallback require separate behavioral
evaluation.
