# Changelog

Notable changes to `@animalabs/context-manager`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.6.2 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/anima-research/context-manager/releases).

## Unreleased

### Changed

- The cache-breakpoint slot contract with membrane is now stated explicitly
  at `placeCacheMarkers` and enforced with a compile-time assertion: this
  strategy holds first claim on up to 3 message-level markers of Anthropic's
  4 `cache_control` slots; membrane is residual claimant on the remainder
  (tools/system fallback when no message markers arrive, and its tool-loop
  floating cache marker). The previous comment justified the 3-cap with a
  membrane behavior — an unconditional system-block marker — that membrane
  dropped some time ago, which left the fourth slot unclaimed and unnoticed
  while tool-loop suffixes went uncached (the qa-ops 2026-08-20 incident).
  No placement behavior changes; a future edit that emits a fourth marker
  now fails loudly at compile time instead of surfacing as a hard 400 or as
  membrane silently losing its float.

### Added

- `ContextManager.setSystemPrompt(text)` threads the host's live system prompt
  into memory-minting LLM requests — both L1 chunk compression and level
  merges — as the request's `system` field, ahead of the identity head, the
  same layout a live activation uses. On hosts whose identity and conduct live
  in system voice, a summarizer that never sees that prompt is a different
  agent from the one whose memory it writes: without it, memories were authored
  by a system-promptless variant of the agent and merges re-summarized those
  summaries upward. Note WHICH prompt a mint is served. The rest of the request
  is built as-of the span being compressed — same head, same recall ladder, no
  tail after the chunk — but the prompt is not: it lives in a single slot with
  no per-message history, so a mint gets the identity policy in force AT MINT
  TIME. That equals what the original instance was served exactly insofar as
  the host keeps the prompt stable across the compressed span; where it has
  changed, the memory is authored under the current policy and the older text
  is not recoverable from here. The hook mirrors `setToolDefinitions`: hosts
  push on every activation, an empty or `undefined` push never downgrades the
  recorded value. Opt-in — with the setter never called, mint requests keep
  their exact previous shape, carrying no `system` key at all, so canonical
  request hashes and compression quarantine identities are unchanged. Hosts
  that do set it also give a marker-less mint (first mint, capped ladder,
  markers off) a cache breakpoint on the system block via membrane's existing
  no-message-breakpoint fallback, which previously had nowhere to land on this
  lane.
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
