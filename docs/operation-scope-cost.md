# Operation-boundary cost (offline local sample)

The historical scoped versions below paid repeated AsyncLocalStorage
resolution, wrapper closures and guarded-field checks, even if the resident
never switched or reloaded. Round 16 below removes the history-proportional
fence work from the ordinary insertion fixture; it does not remove the fence. The earlier
raw-history-only benchmark neither created summaries nor awaited compile; it
could not establish compressed/adaptive cost.

## Reproduction and populations

The same `scripts/bench-operation-scope.mjs` from
`1eb75a95467279c39182ccc95d2521d0fe871181` was run against these built source trees:

- **Pre-scope:** `a8de6130211899f61d15de71ec8273ed66968e76`, immediately before
  operation scope was introduced.
- **Scoped:** `1eb75a95467279c39182ccc95d2521d0fe871181`.

Both used Node 22.23.3, Chronicle 0.7.0, Membrane 0.9.0 and the same probes.
Build each tree, then run the harness with its built entrypoint:

```sh
mkdir -p /tmp/c14b
git show 1eb75a95467279c39182ccc95d2521d0fe871181:scripts/bench-operation-scope.mjs \
  >/tmp/c14b/bench-operation-scope.mjs
systemd-run --user --scope -p MemoryMax=4G env TMPDIR=/tmp/c14b \
  node /tmp/c14b/bench-operation-scope.mjs <tree>/dist/src/index.js \
  --sizes=1024,4096 --modes=adaptive
```

Three sequential pre-scope/scoped pairs ran offline on a shared local CPU with
real Chronicle stores and deterministic in-process provider output. This
compares the complete source-tree changes, not isolated AsyncLocalStorage cost.
Each run creates actual L1/L2/L3 summaries, awaits compile, requires summary
rendering, and exercises `kv-stable` adaptive selection under a constrained
budget. These are larger populated **synthetic** histories, not production
traces. Setup/measurement at 1,024 / 4,096 messages produced 306 / 1,226
summaries and provider calls, 887,792 / 13,610,616 capped-message calls, and
195 / 655 picker builds. Those counts cover the whole run, not one compile.

## Results

Milliseconds; each cell is the median across three runs. Compile uses 30 samples
after 10 warmups per run; compression uses active two-tick rounds, including
local persistence but no provider latency. Add measures each insertion; reload
is one same-instance `setStrategy` after population.

| Messages | Add pre / scoped | Compile pre / scoped | Compression pre / scoped | Reload pre / scoped |
| ---: | ---: | ---: | ---: | ---: |
| 1,024 | 0.203 / 0.436 | 6.605 / 7.193 | 16.667 / 17.528 | 8.308 / 9.603 |
| 4,096 | 0.601 / 1.715 | 31.118 / 37.026 | 56.843 / 63.186 | 29.746 / 33.971 |

Across runs, warm compile medians ranged from 5.665–7.442 / 7.152–7.712 ms
at 1,024 messages, and 29.890–33.444 / 36.477–38.985 ms at 4,096.
At 4,096, process high-water RSS was 300–305 MiB pre-scope and 326–336 MiB
scoped (each process also ran the 1,024-message fixture first).

## Acceptance basis and limits

The earlier local fixture used a provisional ceiling of **10 ms extra median warm adaptive
compile and 2 ms extra median add at 4,096 messages** in exchange for retaining
origin checks on ordinary calls. These are historical results for the named
source tree, not qualification of the current head or an approved project cost
budget. The measured increases are 5.91 ms (19%) and
1.11 ms (185%), respectively. The add regression is substantial in relative
terms; it is not free or hidden by a provider call. Nor is this a fixed
per-entry boundary cost: rebuild loops repeatedly read guarded mirrors while
walking history, so per-insertion overhead grows with history. Compression and populated
reload also cost more in this sample. This is an explicit, limited safety/cost
tradeoff, not an established project-wide performance policy or host latency
SLA; latency-sensitive callback owners should qualify their actual resident
before rollout rather than assuming that never reloading avoids the cost.

No representative production workload, tail-latency bound, history above 4,096,
large hold population, kv-unified solver population, other adaptive policy or
Bun performance is established here. The smoke regression checks reachability
and compressed rendering, not unstable wall-clock thresholds. Broader cost
claims need those measurements, not a more elaborate fence on this evidence.

## Round 15b measurement (2026-11-18)

One fresh sequential pre-scope/submitted-source pair used the same harness,
Node 22.23.3, Chronicle 0.7.0 and Membrane 0.9.0, offline, under a
`MemoryMax=4G` scope with `TMPDIR=/tmp/c15b`. Pre-scope is the same
`a8de6130211899f61d15de71ec8273ed66968e76` tree. Submitted source is r15
`bd84c91ef019bfa7aac308a2e76c7d00c00a6f85` plus this round's error-recovery
patch (autobiographical source blob `5fa64b4bbcad17091b163fb0947aaba3447d94d2`;
operation-scope blob `5c6a855dee37d5b12f60c4faa5b70c96963a3f9a`;
unchanged harness blob `916a22ccc7be794e2ebc9be5f952e754cd3491a0`).
The fixture produced the same 306 / 1,226 summaries and calls at 1,024 / 4,096
messages. Milliseconds, with the same within-run sampling as above:

| Messages | Add pre / submitted | Compile pre / submitted | Compression pre / submitted | Reload pre / submitted |
| ---: | ---: | ---: | ---: | ---: |
| 1,024 | 0.188 / 0.453 | 5.948 / 8.108 | 16.815 / 17.707 | 9.247 / 9.877 |
| 4,096 | 0.550 / 1.820 | 31.085 / 36.421 | 60.268 / 59.974 | 32.299 / 34.881 |

At 4,096 messages, add increased **1.270 ms (+231%)** and warm compile
**5.336 ms (+17%)**. This does not supersede the historical three-pair
**+185%** add result with a new general estimate: it is only one pair on a
shared CPU, with regression tests also running during part of measurement.
It confirms substantial history-dependent overhead, not an approved budget or
production qualification. No speculative optimization was made; all population
and tail-latency limitations above still apply.

## Round 16: bound ordinary insertion fence work (2026-11-18)

### Attribution and change

Before editing, the unchanged fixture was CPU-profiled at both sizes on the
starting tip `6124e0dd00c58af5eeb367ab0f9702e78c34fdaa` (same source tree as
published `25ef0f10`). Among samples beneath `addMessage`, installed wrappers
accounted for 8.71% self time, guarded getters 6.19%, operation-context
resolution 4.19%, and wrapper work closures 3.52%. Async-hooks resource lookup
and `getStore` accounted for another 4.80% and 4.13%; these are sampled stacks,
not separately timed or perfectly isolated causes. Rebuild and send-form
pricing were the hot callers. A counting probe with the fixture's zero L1
holdback found 6,203 / 24,635 mirror checks and 16,036 / 63,652 context
resolutions in one add after 1,024 / 4,096 messages.

The change captures guarded collection shells once per rebuild/queue pass and
reuses helper bodies inside the **already established operation**. Send-form
pricing likewise holds its pruning decision, cache shell and helper calls for
one pass. It does not cache authorization across an epoch or replace the ALS
origin. Reentry detaches B's shells from the captured A shells; all remaining
mirror accesses, assignments and durable writers retain their guards. No
lifecycle method is unwrapped. Exact built-in Passthrough and
WindowedPassthrough instances opt out of the inapplicable boundary; unknown
subclasses/proxies still resolve it, and installing a fence revokes opt-out.

`test/branch-operation-cost.test.ts` counts context resolutions **including
helper wrappers**, and guarded mirror checks, rather than asserting elapsed
time. It uses real Chronicle stores, persisted chunk records and nonzero L1
holdback. One add after 1,024 / 4,096 messages has **183 / 183** resolutions
and **62 / 62** mirror checks (before: **16,550 / 65,702** and
**6,719 / 26,687**). The regression fails on the starting source. It also checks
that local helper calls still refuse stale mirror access and that fence
installation/proxies cannot accidentally inherit the unfenced fast path.

The existing exhaustive reentry replay remains: the two initializer trace pins
were adjusted for once-per-pass method lookup (nine fewer duplicate getter
occurrences, including one newly captured estimate-helper getter). No replay
mode or state-preservation assertion was removed.

### Comparable fixture and limits

The two historical round-16 timing triplets are omitted: their harness revision
was not recorded, and the checked-out harness cannot reproduce their exact
instrumentation. The insertion regression above checks work counts, not
relative timing against main.

This bounds the **additional fence work in the ordinary fixture**, not total
insertion complexity: main and this PR still rebuild/price history. Arbitrary
subclass overrides, external method instrumentation, other image/pruning
settings, holds, production traces, tails and larger histories are not
qualified by this sample. Origin fencing is still paid at operation/writer
boundaries; there is no unsafe global "never reloaded" authorization cache.

## Round 16b: remove repeated quarantine bookkeeping on add (2026-11-18)

The r16 fence counts above did **not** bound quarantine bookkeeping: each
`orderCompressionQueue` still rebuilt pending keys, pruned five failure/wait
maps, scanned queued merges and sorted failed work on every insertion.

Rebuild now reuses a cached fresh/failed **index partition**. The ordinary
record-backed append preserves chunk identities and indices; the existing
queue-construction pass visits fresh records, newly closed frontier chunks,
then failed records in their cached failure order. Those two record loops
visit exactly the same total number of records as main's single queue loop;
there is no second quarantine-sized traversal, key construction, map lookup
or sort on add. New frontier indices append to the fresh partition. Cache
validation uses constant-sized identity, sequence, size and length checks.
Additional bookkeeping is O(1) per ordinary append plus amortized O(new chunk
indices), independent of the failed/skipped population. The cache uses
O(chunks) memory. This does not make main's existing history reconstruction,
holdback or pricing passes constant-time.

State changes still pay for a full ordering/pruning pass: changed sources or
record decisions, merge-queue changes, or changed failure order invalidate the
partition. Initialization and non-append rebuilds retain the full path, as do
subclasses that opt out of persisted chunk boundaries. Dry selects do not
mutate the saved partition and restore it with the other queue state. A
reentrant lane change discards the captured partition before publication.
No work is deferred to a timer or removed from the compression eligibility
rules. Fresh queue order, least-recently-failed order, holdback, demand and
failure-run pruning are unchanged.

`test/compression-queue-cost.test.ts` uses real Chronicle stores and public
`ContextManager.addMessage`, with background ticking disabled. It seeds the
same private failure-order representation that tick gives failed or
quarantine-skipped chunks, together with pending failure runs, not-before
waits and queued merge failure state. This is deterministic bookkeeping
qualification, **not** 1,000 end-to-end provider refusals. At populations
**10 / 100 / 1,000**, each of **eight** subsequent adds records:

| Per add | 10 | 100 | 1,000 |
| --- | ---: | ---: | ---: |
| Chunk-key calls | 0 | 0 | 0 |
| Failure/wait map get/has calls | 0 | 0 | 0 |
| Failure/wait map entries visited | 0 | 0 | 0 |
| Queue-ordering calls / queued-merge visits | 0 / 0 | 0 / 0 | 0 / 0 |

The eight adds cross two chunk closures and holdback releases; assertions
also check the complete resulting queue order. Constant-time map-size probes
are not counted as entry visits. The second test checks decision/merge
invalidation, pruning, removed-source recuts and agreement with full ordering.
Against archived `6124e0dd`, the first test fails as expected on its first add
at population 10: **23** chunk-key calls, **11** map get/has calls, **50** map
entry visits, **1** ordering call and **10** queued-merge visits.

The earlier 177/62 claim was false: exact-tip remeasurement found **178 / 178**
context resolutions and **63 / 63** mirror checks at 1,024 / 4,096 messages. Historical
r16 latency samples above were not rerun and are not new latency claims.
The exhaustive reentry initializer trace pins retain their lengths (378 and
406); one duplicate chunk-key return is replaced by the persistence-capability
check when constructing the partition. All replay modes and preservation
assertions remain enabled.

## Round 17 audit (2026-11-18)

The round-15b response's description of its numbers as covering "this submitted
error-recovery source" was false: its recorded autobiographical blob differs
from the reviewed head. That unprovided intermediate patch is **not a
reproducible head qualification**. The old table is retained only as historical
reported measurements, not evidence of this head's latency or an approved
budget. No new wall-time benchmark or production qualification is claimed here.

The round-16 insertion fix is already in starting tip
`3258da9412a5fc680b44d564638360475ed3b42d` (tree equal to published `16f62d80`).
Rebuilding that exact tip and running the ordinary-add counter regression with
only sample printing added measured **178 context resolutions / 63 mirror
checks** after **both 1,024 and 4,096 messages**. The earlier response's 177/62
was false. These are not the 183/62 counts from the earlier round-16 source
snapshot above. The safety fence remains enabled without reload; the insertion
fix bounds its repeated history-walk work rather than bypassing authorization.

## Round 18: current resident adaptive select/compile and picker (2026-11-18)

The earlier answer that insertion counts made the compile concern moot was
false. The raw adaptive path still resolves the installed `cappedForSend`
wrapper per message (twice per message in this fixture), and other wrapped
helpers and guarded mirrors contribute history-proportional work too. We retain
these checks for origin safety; **the compile fence cost is not bounded
independently of history**, and no production latency budget is approved here.
This audit reports the overhead rather than bypassing the fence.

Reproduce offline after `npm run build` with
`node scripts/bench-operation-select.mjs`. This new, checked-in harness uses
real Chronicle stores, no provider, a live adaptive `kv-stable` strategy, raw
messages of 110 repeated words, zero configured head/recent/holdback windows,
and a budget large enough to emit the history. It measures direct `select`,
manager `compile`, and the actual `picker.run` called inside each; assertions
require picker execution and history pricing. Each row uses 3 warmups and 10
measured samples. Counter instrumentation wraps the original installed
`cappedForSend`, `context`, and mirror guard, and times picker.run; the wrapper
and counter costs are INCLUDED, not isolated fence-only latency. Direct select
omits manager rendering, while compile includes it. No reload or insertion is
timed, and no compressed-provider latency is implied.

Source: round-18 working tree based on `3c622c8f02ac645906e0e0f4572993621d270c25`
(tree equal to published `51463fa2`); pricing/fence algorithms unchanged by this
round. Node 22.23.3, Chronicle 0.7.0, Membrane 0.9.0, Linux x64. The harness blob
and strategy/scope blobs are recorded below so this is not another unlabelled
historical fixture. Wall time is one local synthetic run, not a CI threshold.

| Messages | select median ms | picker within select ms | compile median ms | picker within compile ms | compile context resolutions | compile mirror checks | capped calls per select/compile |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,024 | 5.236 | 1.301 | 5.692 | 0.927 | 23,987 | 7,349 | 2,048 |
| 4,096 | 21.220 | 4.624 | 22.621 | 4.149 | 94,643 | 28,853 | 8,192 |
| 16,384 | 104.752 | 23.212 | 135.300 | 23.573 | 377,267 | 114,869 | 32,768 |

Direct select context/mirror counts: 23,973/7,345; 94,629/28,849;
377,253/114,865. Exactly one real picker run occurred per sample. Counts show
remaining fence overhead scales with history; timing includes ordinary picker,
rendering and estimation work and does not identify a fence-only percentage.
Historical main/tree timings above cannot substitute for these current paths.

Harness blob: `ae237f404d5414e72b591030493109dc28e6fbf7`; strategy blob: `25e65e89996e9b5f0777c8a88ca385c19701f4c3`; scope blob: `b39e33cce169bc6c37f454ea49f915e962fe335c`.

The expanded insertion regression now measures eight consecutive positions at
both history sizes, including two chunk closures/holdback releases per group.
Its extra phase-observation mirror reads are included: within-chunk samples
range 172–180 context resolutions and 63–65 mirror checks; closure/release
samples are 227/73, identically at both sizes. These are instrumentation-specific
phase counts, not a revision of the earlier two-position exact-tip 178/63 audit.

## Round 20: enabled AsyncLocalStorage instances after close

On Node 22.23.3, at baseline `ba376e2b` with the lockfile dependencies,
`scripts/bench-operation-scope-lifecycle.mjs` opened and closed fresh
AutobiographicalStrategy managers sequentially on one empty, host-owned
Chronicle store. Each row uses two fresh processes; the control disables just
the per-strategy ALS after each close in this callback-free fixture. After GC,
the probe times 20,000 sequential unrelated awaits (median of five samples
after one warmup) and reads V8 heap before the timing loop.

```sh
npm run build
for n in 0 100 500 1000; do
  for mode in retain disable; do
    node --expose-gc scripts/bench-operation-scope-lifecycle.mjs "$n" "$mode"
  done
done
```

| Closed managers | Await time, retained / disabled (ms) | V8 heap, retained / disabled (MiB) |
| ---: | ---: | ---: |
| 0 | 3.28 / 2.51 | 13.22 / 13.22 |
| 100 | 138.56 / 3.51 | 13.84 / 13.82 |
| 500 | 595.58 / 4.31 | 14.05 / 13.99 |
| 1,000 | 1,498.31 / 3.14 | 14.15 / 14.03 |

This shows substantial unrelated async-event cost on this Node runtime even
without stored history. Heap differences are one post-GC process sample per
configuration, not an isolated retained-size measurement; neither the timings
nor the heap numbers qualify production hosts or other runtimes.

The control is not a safe reclamation policy. Close/detach cannot prove that
host timers, promises, or bound callbacks have stopped. Some can outlive a
settled tick or detach and call a reattached strategy; disabling its storage
would remove the very origin used to distinguish their work from fresh calls.
Counting outstanding manager calls alone cannot establish that quiescence.
There is no automatic disable in this round.

## Round 21: selection fence cost

Selection uses the same fence as `ba376e2b`. There is no row window or
historical-row exemption: when selection visits a row, wrapped helpers and
guarded mirrors still check origin. This trades proportional fence work for
keeping the ordinary checks and strategy receiver throughout the window.

On Node 22.23.3 with lockfile dependencies, the offline warm adaptive
`kv-stable` text fixture described in Round 18 sent all rows and ran the
picker once per sample. The table counts context resolutions and binding
guard calls (including guarded mirror accesses), not tokenization or
rendering operations. The two counters can overlap; do not add them.

| Rows | Select context resolutions | Select binding guards | Compile context resolutions | Compile binding guards |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 655 | 247 | 669 | 251 |
| 100 | 2,721 | 877 | 2,735 | 881 |
| 1,000 | 23,421 | 7,177 | 23,435 | 7,181 |

Reproduce after building with `node scripts/bench-operation-select.mjs 10 100 1000`.
In this fixture the counts grow roughly in proportion to the rows visited,
plus setup work. Other row shapes and selection paths can have different
counts. This is not a fixed budget or a production latency measurement.
