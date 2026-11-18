# Operation-boundary cost (offline local sample)

Every ordinary Autobiographical/Knowledge call still pays AsyncLocalStorage
resolution, wrapper closures and guarded-field checks, even if the resident
never switches or reloads. There is no no-reload fast path. The earlier
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

For this PR's local fixture, we accept up to **10 ms extra median warm adaptive
compile and 2 ms extra median add at 4,096 messages** in exchange for retaining
origin checks on ordinary calls. The measured increases are 5.91 ms (19%) and
1.11 ms (185%), respectively. The add regression is substantial in relative
terms; it is not free or hidden by a provider call. Compression and populated
reload also cost more in this sample. This is an explicit, limited safety/cost
tradeoff, not an established project-wide performance policy or host latency
SLA; latency-sensitive callback owners should qualify their actual resident
before rollout rather than assuming that never reloading avoids the cost.

No representative production workload, tail-latency bound, history above 4,096,
large hold population, kv-unified solver population, other adaptive policy or
Bun performance is established here. The smoke regression checks reachability
and compressed rendering, not unstable wall-clock thresholds. Broader cost
claims need those measurements, not a more elaborate fence on this evidence.
