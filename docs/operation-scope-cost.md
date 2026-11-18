# Operation-boundary cost (offline local sample)

The old raw-history-only sample did not create summaries or exercise the picker;
it also did not await the asynchronous compile result. It did not establish the
cost of compression or adaptive selection. The expanded
`scripts/bench-operation-scope.mjs` awaits compile, builds actual L1/L2/L3 summaries
with a deterministic in-process provider, and checks that measured compressed
and adaptive compiles render summaries. Adaptive mode uses `kv-stable` with a
constrained budget. Probes require `cappedForSend` and `buildPicker` to run.

The same harness was run on the tree immediately before operation scope was
introduced, this round's starting tree, and the revised tree. Node 22.23.3,
real Chronicle stores, local CPU, MemoryMax=4G, short TMPDIR, no network. Timings
below are milliseconds. Compile is the median of 30 samples after 10 warmups;
compression is the median of active two-tick rounds (including local persistence,
not provider latency); reload is one same-instance setStrategy after population.
Each tree used identical instrumentation. This is a noisy local sample, not a
performance budget, latency qualification, or proof that overhead is negligible.

| Path | Messages | Compile before / start / revised | Compression before / start / revised | Reload before / start / revised |
| --- | ---: | ---: | ---: | ---: |
| raw | 32 | 0.334 / 0.305 / 0.279 | — / — / — | 0.963 / 0.933 / 0.740 |
| raw | 256 | 0.926 / 0.834 / 0.769 | — / — / — | 0.979 / 1.188 / 1.226 |
| raw | 1024 | 1.407 / 2.359 / 2.228 | — / — / — | 2.311 / 3.259 / 2.870 |
| compressed | 32 | 0.164 / 0.298 / 0.192 | 1.895 / 3.194 / 2.181 | 1.728 / 2.398 / 1.530 |
| compressed | 256 | 0.503 / 0.694 / 0.385 | 6.343 / 7.090 / 5.907 | 4.108 / 3.808 / 4.020 |
| compressed | 1024 | 0.663 / 0.909 / 0.765 | 17.633 / 19.089 / 16.152 | 6.589 / 7.338 / 6.812 |
| adaptive | 32 | 0.588 / 1.084 / 0.683 | 1.461 / 2.816 / 1.668 | 1.012 / 1.567 / 1.044 |
| adaptive | 256 | 2.021 / 3.034 / 2.085 | 4.998 / 7.121 / 5.317 | 2.899 / 3.277 / 3.848 |
| adaptive | 1024 | 6.457 / 8.073 / 6.959 | 17.327 / 19.733 / 16.235 | 7.079 / 9.786 / 8.199 |

The 32/256/1,024-message compressed/adaptive fixtures produced 9/75/306
summaries/provider calls, respectively; 1,024-message adaptive runs traversed
887,792 capped-message calls and 195 picker builds across setup and measurement.
The new boundary retains measurable hot-path overhead: at 1,024 messages this
sample shows roughly 0.50 ms extra warm adaptive compile time versus pre-scope.
This change keeps that cost for origin checks; it does not claim a new fast path.
The smoke regression checks path reachability and actual compressed rendering,
not unstable wall-clock thresholds. Results do not cover kv-unified solver
populations, all adaptive policies, provider latency, or Bun propagation.
