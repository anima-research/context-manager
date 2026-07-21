# Long-Context Test Seam for `AutobiographicalStrategy`

**Status:** Landed · **Date:** 2026-05-28, revised 2026-07-21 · **Author(s):** antra-tess + Claude (Opus 4.7)

## Motivation

Uncommitted bench code in `bench/cache/` was already simulating multi-turn workloads through `ContextManager + Membrane(MockAdapter)` to measure cache-prefix efficiency. Around the same time, a tight, hand-crafted reproduction of the "stacking overlapping L1 summaries" bug (Bug A) had been written after the bug was found in production by reading a chronicle by hand. The question was whether the bench scaffolding could be reused to surface the same class of bug organically at scale, rather than relying on a hand-crafted setup that has to be written for each bug.

The answer is yes, and the underlying mechanism — replaying a deterministic synthetic workload through the real strategy with a mock summarizer — is the right abstraction for both performance (cache stats) and correctness (structural invariants on strategy state). What was needed was to lift that mechanism out of the bench driver and expose strategy-state snapshots so consumers other than the cache simulator could read it.

## What landed

### Shared harness — `test/_harness/`

- **`workload.ts`** — Moved verbatim from `bench/cache/workload.ts`. Same seeded RNG, same User/Claude alternation, same `tool_use → tool_result` pairing.
- **`strategy-runner.ts`** — New. Mechanism-only. Opens a temporary Chronicle, wires `Membrane` around a `MockAdapter` with `NativeFormatter`, drives the workload turn by turn, drains compression via `tick()`, captures the raw provider request, and after each turn snapshots `strategy.chunks` and `strategy.summaries` via the same protected-field cast pattern `test/adaptive/harness.ts` uses. Discrimination between agent calls and compression calls is by a sentinel in the system prompt; compression calls are routed to a caller-supplied `compressor` and recorded with their input messages and call index.

The harness deliberately does no analysis of its own — that lives in the consumer.

### Bench — `bench/cache/driver.ts`

Calls `runStrategyOnWorkload` from the harness, then layers cache-prefix analysis (`linearizeRequest`, `simulateCacheHit`, `CacheState`) on top of the per-turn captured requests.

### New invariants test — `test/long-context-invariants.test.ts`

Single `it()`. Runs a 200-turn workload tuned to produce trailing-partial-chunk-then-grow events (avg user 40 tok, asst 80 tok, target 500 tok — small messages relative to target so trailing chunks accumulate). For every per-turn snapshot it checks:

1. **No two active L1 summaries share any source message ID.** Direct catch for the stacked-overlap pattern — a source message belongs to exactly one chunk, which produces exactly one L1.
2. **No two active L1 summaries share `sourceRange.first`.** Same invariant restated; cheaper to assert; clearer error message when it pinpoints the bug.

After the run:

3. **Total compressions ≤ 2 × active L1s at end + 4.** Re-compression-loop ceiling. Generous so legitimate chunk reshapes pass; tight enough that an unbounded loop fails.
4. **Compile errors < 5% of turns.** Membrane composition survival; tolerates the known orphan-tool-use-at-recent-window-head edge case but flags broader regressions.

Configurable via `LONG_TURNS=…` and `LONG_VERBOSE=1`.

## What it caught

On May-era `src/` (Bug A still live), the test failed at **turn 14/200**: `source message 1 is claimed by both active L1 summaries L1-0 and L1-1` — the same overlap shape the hand-crafted reproduction produced, surfaced organically through the synthetic workload with no chunk-boundary-arithmetic setup.

Bug A has since been fixed on main by the July dedup/ownership work (tool-pair chunk guard + L1 dedup, compress-only-closed-chunks, one-to-one representation). The test now passes non-vacuously (18 disjoint active L1 summaries over 200 turns) and stays as the regression gate for the bug class. The hand-crafted reproduction did not survive the same changes — it asserted that a trailing *partial* chunk gets compressed and then re-queued after growth, a scenario compress-only-closed-chunks removed outright — so only the invariant test is landed here.

### Vacuous-pass trap: declare tool definitions

Since compression defers whenever history contains tool blocks but no tool definitions were declared (`setToolDefinitions`), any harness workload with `toolCallProbability > 0` MUST declare its synthetic tool, or zero compressions run and every invariant passes vacuously. The harness declares `fake_tool` right after opening the ContextManager. When adding new harness consumers, sanity-check `result.totalCompressions > 0` (the invariants test asserts this).

## What it does NOT catch

- **Membrane thinking-block signature delivery.** Separate bug, separate code path. The mock adapter doesn't model `thinking` blocks or Anthropic-side signature validation. Needs its own Membrane-side round-trip test.
- **Semantic compression quality.** The mock compressor returns a deterministic stub string. The bench can measure cache impact of compression sizing; it cannot judge whether a real LLM would produce a useful summary.
- **Cross-conversation persistence.** Each harness run opens a fresh Chronicle. Reload/resume bugs need a different test.
- **Real provider quirks.** No real network, no real rate limits, no real tokenizer. Token counts are estimated via `length / 4`.

## How to extend

Adding a new invariant is a per-turn check on `turn.snapshot` inside the existing loop. Adding a new workload shape is a separate `it()` calling `generateWorkload` with different parameters. Common extensions worth considering:

- **L2/L3 disjointness.** Same overlap check extended to higher levels — relevant once `mergeThreshold` is brought back below 999.
- **Chunk-message-ID disjointness.** Two chunks shouldn't claim the same message ID, regardless of compression status.
- **Compiled-output validity.** Run the per-turn `rawRequest` through `NativeFormatter` and assert no orphan `tool_use` / `tool_result` blocks. Currently this surfaces as the 5%-cap compile-error budget; a structural assertion would be tighter.
- **Pinned-range stability.** Add pins to the workload, assert pinned ranges never appear inside any summary's `sourceIds`.
- **Adaptive-resolution invariants.** Once chunks have `currentResolution` state, assert no two chunks at the same resolution claim overlapping ranges.

## Files

| Path                                              | Change           |
|---------------------------------------------------|------------------|
| `test/_harness/workload.ts`                       | Synthetic-workload generator (seeded RNG) |
| `test/_harness/strategy-runner.ts`                | New (~290 lines) |
| `bench/cache/driver.ts`                           | Bench driver; consumes the harness |
| `bench/cache/scenarios/passthrough-vs-autobio.ts` | Passthrough-vs-autobio cache scenario |
| `test/long-context-invariants.test.ts`            | New (~150 lines) |
| `docs/long-context-test-seam.md`                  | This document    |

## Related

- `claudeai-export/issues/bug-compression-loop.md` — Bug A field report from production chronicle inspection.
- `test/adaptive/harness.ts` — Prior precedent for shared test scaffolding inside `test/`.
- `docs/adaptive-resolution-design.md` — Adaptive-resolution design; future invariant extensions tie into its `currentResolution` per-chunk state.
