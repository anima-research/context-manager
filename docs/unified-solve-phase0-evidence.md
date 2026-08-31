# kv-unified Phase-0 evidence — Fable

Status: implementation evidence, not a production policy.  Measurements in
this note calibrate mechanics where they can; they do not infer welfare
exchange rates from historical behavior.

## Inputs and custody

The raw request tapes and Chronicle store remain on `fable@b-sketch`.  Only
derived aggregates and picker exports are present in
`../tmp/fable-fixtures/`.  Their provenance and checksums are recorded in that
directory's `README.md`.

The request aggregates cover 2026-08-11T20:01:00Z through
2026-08-28T17:00:54Z.  They therefore mix the pre-keepalive and keepalive
eras and describe the old membrane-owned marker layout.  They are suitable
for workload shape and for finding model error; they are not a replay of the
new CM-owned four-marker contract.

## Policy-independent measurements

Across 1,592 Fable stream transitions in `thdig.json`:

| Quantity | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| Fresh input tokens, all calls | 1,289 | 8,976 | 13,407 | 24,235 | 30,915 |
| Fresh input tokens, end-append-shaped calls | 2,520 | 11,551 | 15,898 | 26,198 | 30,915 |

The end-append classification is structural: exactly one insert whose first
change is at or after 90% of the serialized request.  It selects 1,105 of
1,592 stream transitions.  The other 487 calls are not assumed to be solver
rotations; 199 of them first differ before 80% of the request.

For a 400k hard window, reserving one observed p95 append requires at least
3.97% headroom; one p99 append requires at least 6.55%.  Thus append volume
alone implies `W_high/W <= 0.960` at p95 or `<= 0.935` at p99.  This is only a
headroom-risk input.  Estimator uncertainty and the operator's tolerance for
back-to-back calls can require more room, while neither number chooses the
upper-hinge welfare price.

The current historical Fable export has 47,693 message leaves.  Strict
canonicalization reports non-contiguous ownership in several high summaries.
An **offline solver experiment** that excludes those ancestors has an exact
feasibility floor of 312,291 tokens on the current v2 export, and a representative bounded solve
completes in about 0.72 s on the development machine (10k token/continuity
buckets, 50k fidelity bucket, peak frontier 69 labels).  Exact floor
computation completes in about 0.05 s.  The 2026-08-24T05:00Z created-masked
export contains 11 non-contiguous summary nodes in strict mode; the same
exclusion experiment has a floor of 302,069 tokens.

This is **not Fable quarantine state**.  Her live recipe has no such setting,
her last generic compression-quarantine event is all-clear, and no merge
quarantine warning appears in the service log.  The implementation option
currently named `quarantineNonContiguousSummaries` is a solver-local prototype
that removes unusable ancestors from the solve; its name conflates that
experiment with the strategy's real compression/refusal quarantine.  These
measurements prove only that strict canonicalization rejects the export.  They
do not justify silently enabling ancestor exclusion for Fable.  Before pilot,
either diagnose/repair the ownership links or implement and review a genuine
treeification transform that preserves render semantics.

The subsequent ownership diagnosis found that exclusion is not the right
repair.  The persisted chunk records themselves do not overlap, but 170 stale
L1 generations remain in the summary archive; mutable parent pointers and
authored `sourceIds` disagree around some of those generations.  Two
record-backed L1s are intrinsically disjoint, and one L3 skipped a lower group
that landed four minutes later.  A simulated strict closure—keep the
record-backed L1 generation per span, retire authored parents whose child set
is no longer intact, split/re-author the two disjoint records, and retire the
one gap-crossing L3—leaves 1,799 usable authored nodes with zero
semantic-ownership mismatches.  Its exact pre-drain floor is 363,130 tokens.
That fits W=400k but does not leave enough operational margin to perform as a
live repair; the upper levels must be regenerated offline before activation.

An initial no-receipt sweep at W=400k, band [0.70, 0.935], and the provisional
hinge prices demonstrates why alpha cannot be adopted as a harmless default:

| Export | alpha | selected tokens | selected level counts (L0/L1/L2/L3/L4) |
|---|---:|---:|---:|
| current | 0.5 | 394,377 | 394 / 458 / 2,913 / 33,354 / 10,574 |
| current | 0.7 | 377,999 | 373 / 339 / 3,053 / 30,521 / 13,407 |
| current | 1.0 | 371,112 | 525 / 468 / 3,582 / 17,432 / 25,686 |
| 2026-08-24 masked | 0.5 | 386,502 | 301 / 370 / 4,106 / 32,236 / 0 |
| 2026-08-24 masked | 0.7 | 381,102 | 431 / 396 / 3,950 / 24,640 / 7,596 |
| 2026-08-24 masked | 1.0 | 369,398 | 435 / 392 / 3,950 / 18,829 / 13,407 |

These runs omit an accepted-presentation/cache reference, so they are shape
checks rather than transition-policy replays.  They show that the 0.5–1.0 fit
bracket materially changes both occupancy and which history remains fine.

The original analytic approximation certificate was not useful at this scale:
it summed a bucket width per decision node and reported a score bound above
2 billion for the representative 10k/10k/50k grid.  Narrowing all buckets to
1k cost about 6.8 s per current-Fable solve and still left a very loose global
bound.  The implementation now propagates one-sided error envelopes through
the representatives actually retained at each prune.  On the same current
Fable solve it preserves the selected frontier, runs in about 0.48 s, and
reports a 60,216 score-unit bound decomposed as 6,736 rendered tokens, zero
continuity units (there is no presentation in this shape sweep), and 58,142
fidelity units.  Twenty varied small-forest cases, including warm-cache
transitions, verify the reported bound against exhaustive welfare regret.
This is materially informative rather than vacuous, though replay must still
decide what production bound is acceptable.

## Estimator evidence and a fixed measurement bug

The append-only `service-stderr.log` contains 49 estimator-calibration samples
without timestamps.  The last 20 have `real/est` in [1.10, 1.14] (p50 1.12).
The full set has extreme old outliers up to 9.94 and must not be pooled: the
framework was treating membrane's cumulative tool-loop usage events as
per-provider-call samples.  That inflated later-round observations.  Commit
`8c3b2cc` in agent-framework now differences cumulative counters before
calibration while retaining cumulative turn totals for observability.

Because the log has no timestamps and the corrected code has not yet produced
a clean run, the residual 10–14% tail is a warning, not a calibrated error
distribution.  A post-fix run is required before setting headroom from
estimator risk.

## Cache-model result: old evidence fails the new gate

On the 1,595 stream calls in `erasim.json`/`erasim_cf.json`, the old-marker
content simulator's absolute cache-write prediction error has p50 3,246
tokens, p90 391,002, and p95 458,770.  Relative error is ill-conditioned on
small observed writes and has a very large tail.  This is useful negative
evidence: the old three-marker/formatter-dependent simulation is not accurate
enough to choose `f_K`, and its last-breakpoint depth (usually near request
end) is a description of the old emitter rather than an optimal placement.

The counterfactual “hold mid-window” simulation shows nonzero possible
savings, but it is also evaluated under that obsolete marker contract.  Per
the design's Phase 0d, billed calibration must be rerun after CM-owned marker
receipts exist.  Until then, cache price ratios `{miss 1.0, read 0.1, write
1.25}` are provider mechanics; `cacheLambda`, `cacheScale`, and curve shape
remain explicit policy choices.

## What the measurements do and do not choose

They support:

- a preliminary upper occupancy boundary no higher than about 0.935 if one
  p99 append is the desired buffer at W=400k; and
- refusing to calibrate the new cache term from the old marker simulation.

They do not choose:

- the lower occupancy boundary or either squared-hinge welfare price;
- cache-versus-fidelity or continuity-versus-fidelity exchange rates;
- continuity recency/stable-time half-lives and floors;
- adoption epsilon; or
- alpha, which still requires the healed-profile reference named by the spec.

Those are normative choices to be displayed as frontier tradeoffs.  The live
strategy intentionally has no fallback recipe: `foldingStrategy:
"kv-unified"` without every policy, approximation, adoption, and structural-
handling field throws before a solve can select or persist a frontier.  That
fail-closed gate does not make the current ancestor-exclusion prototype an
approved Fable policy.

## Gates remaining before a Fable switch

1. Collect corrected per-call estimator samples and rerun the cache simulator
   from accepted CM-owned four-marker wire receipts.
2. Replay the 2026-08-24 03:11/03:59 round trip as two accepted-presentation
   transitions, rather than relying only on its unit-hash identity proof.
3. Choose and record the welfare surface and alpha/isotonicity decision, then
   run the designed occupancy, surgery, tool-prefix, and no-cycle cases.
4. Finish score-ranked latent higher-level production demand and feed its
   pending spans into stability-labelled marker placement.  The current live
   adapter only demands missing L1 coverage when the exact hard floor is over
   budget; that prevents a deadlock but is not the complete §8 ranking layer.
5. Resolve the non-contiguous ownership findings without calling them Fable
   quarantine: establish whether they are exporter artifacts, repairable store
   scars, or inputs requiring a semantics-preserving treeification transform.
