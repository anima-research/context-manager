# Hysteresis certificate prototype

The certificate alone is insufficient for normal-operation latency. General
solver work and measurements, with this certificate disabled, are documented
in [General kv-unified solver performance](kv-unified-general-solver-performance.md).

This opt-in prototype avoids Pareto label propagation when the existing
`adoptEpsilon` rule provably selects the unchanged accepted presentation.
Enable it with `hysteresisCertificate: true` in `ParetoSolveOptions` or
`KvUnifiedOptions`. It is not enabled in any resident recipe or pinned runtime.

## Bound and selection proof

Let `S` be the score of a feasible carried cut and `epsilon = adoptEpsilon`.
The policy retains it when `S <= bestScore + epsilon`. Cache and continuity
penalties are nonnegative, so any lower bound `L <= min(F + B(T))` also bounds
`bestScore`. Thus `S - L <= epsilon` proves the policy's selection.

For the existing convex, two-sided budget penalty, every tangent is a global
lower bound:

```
B(T) >= B(t) + B'(t) * (T - t)
L(t) = min_cuts(F + B'(t) * T) + B(t) - B'(t) * t
```

The minimum of the linear objective is a bottom-up select/expand pass over
the canonical ownership forest. All constraints remain in that pass. Allowing
over-budget cuts only relaxes the optimization and lowers the bound. Fixed
head/tail costs are included once. Chronological gaps do not affect additive
token and fidelity accounting.

Start with a tangent at the carried token count, then bisect using the token
count of the linear minimizer. Each pass is independently valid. Stop as soon
as the certificate succeeds. After at most 32 unsuccessful bound-improvement
passes, use the existing Pareto solver; this limit never chooses a layout or
relaxes a criterion. No solve deadline or bucket approximation is introduced.
A conservative floating-point allowance is subtracted from each bound.

## Preconditions and scope

- The carried cut must obey current constraints and be structurally realizable
  under the hard token wall, with unchanged representation hashes.
- Old leaves stay at their accepted levels. New leaves (and summaries over
  them, such as a fresh L1) may take any level they allow, so every matching
  extension is enumerated and scored exactly, and the policy's carried
  candidate is the best of them. More than 256 extensions fall back.
- Carried continuity loss and actual cache churn must both be zero. These
  witnesses prove the global normalization floors are zero. In particular,
  checking the cache *excess* of a singleton candidate would be insufficient.
- Internal protected holes fall back. Externally accounted head/tail holes and
  preserved gap-bearing ownership are supported.
- Initial/blank-slate solves, forced budget transitions, and unsuccessful
  certificates retain the existing solver. This does not implement cost-to-go
  pruning for real transitions.

Successful results list every enumerated extension that fits the hard token
wall as `candidates` (one when no new leaf can fold) and carry a `certificate` with the bound, carried score,
improvement bound, epsilon, pass count, and roundoff allowance.
They have no Pareto `propagation` statistics. This is a proof of the exact
hysteresis policy, not an assertion that bucketed Pareto labels are exhaustive.

## Validation and reproduction

The new test file checks all carried cuts across 100 deterministic varied small
forests, including interleaved ownership. It compares successful certificates
with both the exhaustive oracle and the existing bucketed solver, checks every
lower bound against the exhaustive
minimum of `F+B`, and exercises cache, extensions, protected holes, stale hashes,
malformed hysteresis, and forced-budget fallback. The 57 certificate, forest,
policy, receipt, and live-adapter tests pass under Node after a TypeScript build.

The offline benchmark captures the inputs at the pinned runtime's first solver
call, then stops the compile. It uses no provider. Always supply a disposable,
checksum-verified store copy:

```sh
bun scripts/benchmark-kv-unified-certificate.mjs --capture \
  --runtime /path/to/pinned-runtime --store-copy /path/to/disposable-copy \
  --recipe /path/to/recipe.json --fixture /path/to/solver-inputs.json \
  --report /path/to/certificate-report.json

bun scripts/benchmark-kv-unified-certificate.mjs \
  --fixture /path/to/solver-inputs.json --baseline \
  --report /path/to/comparison-report.json

bun scripts/benchmark-kv-unified-certificate.mjs --compile \
  --runtime /path/to/pinned-runtime --store-copy /path/to/disposable-copy \
  --recipe /path/to/recipe.json --report /path/to/compile-report.json
```

The fixture serializes structural inputs, Maps and Sets, omitting summary
`content` and `responseContent`. It should still remain a local diagnostic
artifact. Reports contain aggregate metrics and a hash of the entire selected
frontier. The baseline comparison asserts frontier equality.
The full-compile mode injects the certificate at the pinned runtime's solver
boundary and stops loudly if any solve cannot certify. It does not silently
run an expensive fallback or contact a provider.

## Sill repro, 2026-09-20

On the captured 73,918-leaf / 3,345-summary repro, with a 528,000-token wall:

- Carried tokens: 507,298; carried score: 42,134.53830120611.
- Certified lower bound: 40,903.6602276459.
- Maximum possible improvement: 1,230.878073560205 < 2,000.
- Seven linear passes; maximum roundoff allowance: 0.003879 score units.
- Initial capture-process timings: 0.133–0.151 seconds for the certificate,
  0.346–0.367 seconds including forest construction. These are solver timings,
  not end-to-end store-open/compile timings; the capture process retains store
  memory, so its RSS is not an isolated solver-memory measurement.
- Fresh standalone certificate timings: 0.344–0.360 seconds including forest
  construction; RSS was 0.619 GB after the first run and 0.943 GB after the third.
- Complete offline compile: 1.052 seconds (after store open), 727 rendered
  messages, planned and actual tokens both 507,298, zero moves. It invoked
  one solver and that solve certified. The diagnostic `budgetMet=false` is
  unchanged from the baseline: the 507,298-token layout exceeds the target
  budget but remains within the 528,000-token hard wall.
- The entire 73,918-leaf selected frontier matches the fixture's saved
  resolutions, hash
  `e472784d56af59aca3e368044095b7014d7f7b4fe4f2983cc4c8034112c4fcc7`.
  The historical baseline receipt reported zero moves and the same score and
  token count. The new exhaustive small-forest comparisons also agree with the
  existing bucketed solver.

An additional baseline replay from the serialized structural fixture was
interrupted after more than 18 minutes without a result. It remained CPU-bound
and used tens of GB of memory; its slowdown relative to the recorded 244–286
second store-based baseline has not been diagnosed. There is no completed fresh
baseline timing or fresh full-repro solver-to-solver comparison to report.
This manual cancellation affected only the optional diagnostic process, not
the solver policy or the live resident. Do not use that incomplete run to
claim a measured speedup ratio. The full-frontier comparison above is against
the saved resolutions, not a result from the interrupted replay.

Local fixture and reports:
`/Users/antra/sill-cm/data/solver-fixtures/hysteresis-20260920.yXh4p1/`.
The original repro store and live resident were not modified.
