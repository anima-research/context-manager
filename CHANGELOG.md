# Changelog

Notable changes to `@animalabs/context-manager`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them — see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.6.2 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/anima-research/context-manager/releases).

## Unreleased

### Added

- Compression and merge requests now carry prompt-cache breakpoints at their
  stability strata — end of head window, last level≥2 recall pair, last
  recall pair — with a 1h cache TTL (#37). The mint lane previously sent its
  entire recall prefix (~60–93% of input) uncached on every call. Markers are
  suppressed when the recall ladder was budget-capped (front-eviction shifts
  the prefix, making cache writes counterproductive), and stale block-level
  `cache_control` riding replayed imported content is stripped so the seams
  can never push a request past Anthropic's 4-breakpoint limit. New options:
  `compressionCacheMarkers` (default `true`) and `compressionCacheTtl`
  (default `'1h'`).
- Mint request preimages are now persisted by default, so
  `provenance.requestHash` is readable and not merely verifiable. The field's
  contract said the hash "keys the exact request in the llm-calls log" — a log
  this library never wrote: the only library-owned log is the JSONL telemetry
  behind `CONTEXT_MANAGER_COMPRESSION_LOG`, off unless a host sets it, and the
  `llm-calls` files are host-harness artifacts. On every accepted L1 and merge
  mint the authoring request is now stored as a blob in the same Chronicle
  store as the summary; because chronicle keys blobs by sha256 of their bytes —
  the same digest `requestHash` already is — the preimage lands under the hash
  the summary carries, deduplicated across retries, with no new format and no
  new filesystem convention. Read it with `getMintRequestByHash(store, hash)`
  or `getMintRequestPreimageBytes(store, hash)` (new public exports). Refused
  and quarantined attempts are not mints and are not stored. New option:
  `persistMintPreimages` (default `true`) for hosts that keep their own durable
  request log or accept unreadable provenance — mint requests are large.

### Fixed

- Compression-refusal fallback admission now uses provider-aware total input
  usage after the canonical call (including disjoint Anthropic/Bedrock cache
  counters without double-counting subset-style providers), fails closed on
  zero/partial/unknown usage, and versions the durable accounting contract so
  legacy byte-bound quarantines remain evidence without consuming the repaired
  per-chunk shape allowance.
- Append-only autobiographical compiles now preserve the previous request's
  endpoint as an explicit cache breakpoint, avoiding recent-tail cache misses
  when a tool-heavy turn appends more than the provider's 20-block lookback.
- Compression recall pairs now follow canonical message-store order rather
  than lexical source-ID order, preserving chronology and stable prompt-cache
  prefixes when decimal message IDs cross a width boundary (for example,
  `"99"` to `"100"`).

## 0.6.3 — 2026-08-03

### Added

- **`chunkBoundaryHint` — a subclass seam for semantic chunk boundaries.**
  Strategies with domain knowledge about conversation structure (chat-topic
  transitions, episode breaks) can close a chunk early at a semantic boundary
  without forking `rebuildChunks` — hinted closes persist chunk records and
  respect the minimum-size and tool_use-pairing guards exactly like size-based
  closes. Motivation: connectome-host's FrontdeskStrategy forked the whole
  chunker for topic-aware boundaries and silently bypassed chunk-record
  persistence and the fail-closed orphan guard.
- **Budget-saturation liveness gates** (`test/long-context-saturation.test.ts`)
  — the regression net for the 2026-08-03 production outage class (hierarchical
  renderer saturating its fixed budget into a terminal `UncoveredDropError`
  refusal loop): the adaptive path must compile every turn of a workload whose
  raw history is several times the budget, and under pathological pressure may
  refuse only with the recoverable `OverBudgetError` class, never an uncovered
  drop.

### Changed

- The adaptive path's tail-shortfall and newest-turn-retention refusals now
  name their stage (`Tail emission dropped reserved recent-window messages`,
  `Structural repair did not retain the newest turn`) instead of masquerading
  as picker exhaustion with impossible arithmetic ("742 tokens still exceed
  hard budget 11220").
