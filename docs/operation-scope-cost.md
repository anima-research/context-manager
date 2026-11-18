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
systemd-run --user --scope -p MemoryMax=4G env TMPDIR=/tmp/c14b \
  node scripts/bench-operation-scope.mjs <tree>/dist/src/index.js \
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

The following measurements use the same real-store adaptive fixture at both
sizes. Main is the offline local `main` / merge base
`59043beb14365d1044a88f9aeeb0a2f1a735ad8b`; before is the starting tip above.
After is the r16 source in this change (autobiographical source blob
`2bee927dcaee88e829abafaba8c065639e8e5795`, operation-scope source blob
`b39e33cce169bc6c37f454ea49f915e962fe335c`). Node 22.23.3, Chronicle 0.7.0,
Membrane 0.9.0; all runs offline under `MemoryMax=4G`, `TMPDIR=/tmp/c16`.

Main predates `cappedForSend`, so the harness now records that probe as absent
instead of failing its reachability assertion. It still requires populated
summaries, summary rendering and adaptive picker reachability on every tree.
Main is an older, materially different tree, not an isolated no-fence build of
this PR. A main/head gap cannot all be attributed to the origin fence.

The default harness also wraps `cappedForSend` on the instance. Such external
instrumentation cannot be unwrapped as a library-owned helper, and adds its own
history-sized callback/context cost during insertion. A first default-harness
triplet gave add medians (main / before / after) of **0.132 / 0.454 / 0.274 ms**
at 1,024 and **0.480 / 1.798 / 0.840 ms** at 4,096. That after sample preceded
a small allocation-only cleanup of the non-batched compile path.

For the ordinary-add comparison below, `--probe-after-add` installs those same
probes **after** insertion, before compression/compile. Both options use the
same population and provider; this is not silently substituted for the older
instrumented numbers. Reproduce against each built entrypoint:

```sh
mkdir -p /tmp/c16
systemd-run --user --scope -p MemoryMax=4G env TMPDIR=/tmp/c16 \
  node scripts/bench-operation-scope.mjs <tree>/dist/src/index.js \
  --sizes=1024,4096 --modes=adaptive --probe-after-add
```

Milliseconds; each entry is **main / before / after**.

| Messages | Add | Warm compile | Compression | Reload |
| ---: | ---: | ---: | ---: | ---: |
| 1024 | 0.143 / 0.448 / 0.285 | 3.716 / 9.233 / 8.756 | 13.514 / 17.047 / 19.223 | 5.583 / 12.255 / 13.562 |
| 4096 | 0.520 / 1.882 / 0.641 | 21.143 / 47.566 / 36.025 | 47.964 / 67.492 / 59.267 | 19.880 / 37.761 / 31.643 |

The add gap above main falls from **0.141 ms** at 1,024 to **0.121 ms**
at 4,096 in this triplet, versus 0.305 / 1.362 ms before. At 4,096 the
after add is about **23% above main**, and **66% below before**. This is a
substantial improvement, not equality with main or a proven latency bound.

There was **one sequential main/before/after triplet**, not three independent
pairs or a confidence interval. Each process populated 1,024 then 4,096 messages.
Add is the median of all growing-history insertions, not a median of repeated
inserts into an already-full store. Compile has 30 samples after 10 warmups;
compression takes active two-tick rounds, and reload is a single observation.
The exhaustive fence replay overlapped main and part of before; other jobs also
ran on the shared host. Timing differences include CPU/JIT/GC noise. The earlier
profiled baseline run is not mixed into these latency medians.

Every tree produced 306 / 1,226 summaries and provider calls and 195 / 655 picker
builds. With deferred probes, before/after both recorded 362,992 / 5,219,960
capped-message calls (main has no such seam). At 4,096, process high-water RSS
was 275,040 / 341,012 / 347,412 KiB, including the preceding 1,024 fixture.

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

The earlier ordinary fence fixture now reports **177 / 177** context
resolutions and **62 / 62** mirror checks at 1,024 / 4,096 messages. Historical
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
