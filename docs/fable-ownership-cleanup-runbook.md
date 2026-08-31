# Fable ownership cleanup runbook

Status: validated on an isolated 2026-08-31 snapshot; **not applied to the
live store**.  Commits `83b36a9`, `44712a4`, and `569f7e8` must be deployed
before any live cleanup so regenerated work uses strict ownership seams.

## Validated copied-store result

Test store:
`/home/fable/fable-cm/data/solver-fixtures/d784b4ca-kv-cleanup-test-20260831`

Final safe export:
`tmp/fable-fixtures/fable-picker-kv-cleanup-final-v2.json`

SHA-256:
`80eb181cb775f25da11c813e6cd46fab8fdcf6b61bb83a6fa94f6a7cdfb024aa`

- 47,693 messages; 1,833 authored summaries.
- Strict `CanonicalSummaryForest` construction succeeds with no exclusion or
  treeification.
- Authored coverage equals record ownership; the hardened repair dry run is a
  no-op and reports canonical closure.
- Zero pending chunks, queued merges, quarantines, or unrealizable carried
  resolutions.
- Exact minimum-token floor at W=400k: 184,046.
- Representative bounded solve: 380,387 tokens in about 0.74 s.

The original snapshot and live session were not modified.

## What the cleanup does

1. Retargets `L1-403` and chunk record `c-166` to the semantically correct
   later run `8097..8111`; changes only `L2-410`'s derived range.
2. Replaces fused `c-52`/`L1-267` ownership with two contiguous uncompressed
   records (`4..5` and `2132..2152`). The old authored node remains in
   Chronicle history but is removed from the active summary projection.
3. Prunes 170 stale duplicate L1 generations and closes removal upward through
   the parents' authored `sourceIds`, not merely mutable backlinks.
4. Explicitly retires gap-crossing `L3-569`.
5. Regenerates the resulting L1/merge debt with Fable's model and the 136-tool
   surface taken from her latest real request.
6. Clamps carried resolutions to surviving ancestry.

## Prevention that must land first

- Chunk formation closes at every live ownership/head/pin gap, even for a
  thin run.
- Merge formation requires strict adjacency in live message order. Deleted
  messages do not create a live gap; another representation does.
- A partially stale queued merge never reparents an authored child.
- Persisted old-grammar merge queues are discarded and rebuilt.
- Partially paid quarantine records self-clear so remaining orphans regroup.

## Copied-store procedure

Never hardlink a live Chronicle store. Stop the agent, make a full/reflinked
copy, and run every command against that copy first.

```sh
# Dry-run and apply the two reviewed L1 corrections.
bun dist/scripts/repair-fable-ownership.js <copy> agents/fable
bun dist/scripts/repair-fable-ownership.js <copy> agents/fable --apply

# Close stale authored ancestry. The floor-growth flag is acceptable only on
# the stopped copy because an offline drain follows before any restart.
bun dist/scripts/repair-pyramid.js <copy> agents/fable --retire=L3-569
bun dist/scripts/repair-pyramid.js <copy> agents/fable \
  --retire=L3-569 --apply --allow-floor-growth

# Real provider calls; reads the latest on-box stream tool schema and emits
# aggregate progress only.
set -a
. /home/fable/fable-cm/.env
set +a
bun dist/scripts/drain-autobiographical.js <copy> agents/fable --apply \
  --model=claude-fable-5 --participant=fable --max-steps=200 \
  --tools-log=/home/fable/fable-cm/data/llm-calls.2026-08-23T07-59-03-291Z.jsonl
```

If a structurally valid six-source merge exhausts its reviewed fallbacks,
inspect its receipt and source metadata. Do not blindly clear it. The copied
run had one content-hostile group that succeeded as two adjacent triads:

```sh
bun dist/scripts/split-merge-quarantine.js \
  <copy> agents/fable <full-reviewed-key> 3
bun dist/scripts/split-merge-quarantine.js \
  <copy> agents/fable <full-reviewed-key> 3 --apply
```

Resume the drain, then run `repair-pyramid` in dry mode again. It must report:

- prune/wipe/unmerge all zero;
- unowned coverage loss zero;
- canonical closure verified;
- merge queue zero; and
- quarantine zero from the drain result.

Apply one final no-op repair pass only when it reports carried resolution
clamps; export `PickerInputs`; then require strict forest construction, exact
floor headroom, zero unrealizable carried levels, and byte-consistent render
accounting.

## Live handoff boundary

Do not mutate the active session in place. With the service stopped, prepare
and validate a fresh copy of
`/home/fable/fable-cm/data/sessions/d784b4ca`, preserve the untouched directory
as the rollback artifact, and switch only after an explicit operator review of
the final receipts and metrics. The first accepted presentation is a reason-
coded surgery: continuity may be relaxed explicitly; cache state is cold if
the immutable tool/system prefix changed.

