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

## 0.8.0 — 2026-09-07

### Added

- **Strategy-view composition** (groundwork for tune-out,
  anima-research/agent-framework#77; all three inert until configured):
  `ContextManagerConfig.viewFilter` — strategy-facing exclusion applied at the
  single view choke point, so chunking, selection, emission, and the coverage
  invariants all see the same excluded-free world while the store and direct
  accessors keep everything (documented as non-retroactive over persisted
  summaries and not a confidentiality boundary — excise by branching);
  `ContextManagerConfig.auxiliaryMessageViews` — additional message slots
  merged read-only into the strategy view, interleaved by branch-global
  chronicle sequence (writes still target only the manager's own slot; an
  entry naming the manager's own slot is refused, repeats merge once);
  standalone compositors `filterMessageStoreView` / `mergeMessageStoreViews`
  (#54).
- **`WindowedPassthroughStrategy`** — passthrough over a sequence-anchored
  window with coarse re-anchoring (jump to ~`reAnchorFraction` of budget on
  overflow, byte-stable prefix + appends between jumps, unlike a naively
  sliding front). The anchor persists in a `{ns}/windowed:anchor` snapshot
  slot, follows branches, and is re-derived whenever the store's branch is
  observed to change (host undo/redo included); `setAnchor()` is the external
  policy hook. Places ≤ 2 message-level cache markers (measured stable prefix
  + end) under the shared ≤ 3 first-claim contract. Applies `maxMessageTokens`
  truncation and the autobiographical live-image policy (`maxLiveImages`,
  `imageStripDepthTokens`, `maxLiveImageBytes`) itself, and refuses with
  `OverBudgetError` when the newest message alone exceeds the usable budget
  (#54).

- `compressionSplitFallback` (default off): a final L1 rung that, after every
  existing rung is refused, folds the chunk in halves at message boundaries
  (tool rounds indivisible) in source-only shape and installs the stitched
  pieces as one L1 over the chunk, with per-piece request/response/content
  hashes, aggregate usage, and per-chunk / sliding-window call caps; provider
  errors abort it. `compressionSplitPlaceholder` (default off) allows an
  operator-authored, structurally marked placeholder for a single message that
  refuses alone. Cap knobs: `compressionSplitMaxCallsPerChunk`,
  `compressionSplitMaxCallsPer10Min`.

- `carrierPolicy: 'full' | 'live-strip'` (default `'full'`) chooses where a
  summary's captured reasoning carriers replay. `'live-strip'` omits the
  signed `thinking` / `redacted_thinking` blocks from the LIVE WINDOW only —
  the surface where an agent reads its own memory back and inhabits the
  archivist's task-cognition at the remembered span's slot. Mint and merge
  recall pairs keep their carriers unconditionally under either value, whole
  and byte-verbatim, because that is where the anti-refusal duty is measured.
  Stripping omits whole blocks and never rewrites one, so signatures still
  verify on the mint side; a carrier-only entry falls back to its `content`
  prose rather than rendering an empty turn; and the fold planner prices a
  recall pair for the render the policy will actually emit.

- Add the fail-closed `kv-unified` context solver with exact feasibility certificates, bounded Pareto welfare selection, accepted-presentation/cache receipts, expiring continuity relaxation, score-ranked latent summary demand, and token-weighted 33/66/100 history markers plus a tail marker.
- Add aggregate-only Fable replay tooling and canonical ownership repair/prevention for stale, crossed, and non-contiguous summary ancestry.

- Mint request preimages can now be persisted, so
  `provenance.requestHash` is readable and not merely verifiable. With the
  option on, every accepted L1 and merge mint stores its authoring request in
  the same Chronicle store as the summary, retrievable by the hash the summary
  already carries. Read it with `getMintRequestByHash(store, hash)` or
  `getMintRequestPreimageBytes(store, hash)`. Refused and quarantined attempts
  are not mints and are not stored.
- New option: `persistMintPreimages`, **opt-in, default `false`**. Absent
  config means off — only an explicit `true` enables it. Preimage text is real
  growth at mint cadence, and this library ships no retention knob for it yet,
  so a fleet that deploys from a checkout would otherwise have every resident
  begin writing preimages on the next pull. Turning it on is a deliberate act,
  taken with an eye on store size.
- Inline media is stored by reference, not re-embedded. Media-bearing
  preimages store the request JSON as an envelope of literal spans and
  content-addressed media blob references. Media already extracted by
  `MessageStore` reuses its existing blob; other inline media is stored once.
  Reads restore the exact original base64 spelling and verify the materialized
  bytes against `requestHash`. Text-only preimages remain plain request blobs,
  and a damaged envelope raises `MintPreimageMaterializationError`.
- Preimages are persisted best-effort: a store failure never blocks the mint
  and leaves no preimage, so a reader gets null — alongside pre-feature mints
  and persistence left off. The hash on the entry stays verifiable either way.

### Fixed

- Compression is now deferred until the host has pushed tool definitions
  when the summarizer is a Fable/Mythos-family model, not only when the
  chunk itself contains tool blocks. On those models a summarizer request
  with the memory marker and directive but no `tools` param is a
  deterministic `reasoning_extraction` input-block regardless of chunk
  content, so a pure-chat seeded agent's first speculative L1 — fired
  before the first `setToolDefinitions` — burned a doomed call and landed
  its opening slice in compression quarantine (Linn, 2026-09-05). Opus-family
  summarizers keep minting tools-less; deferred chunks are re-examined on the
  next ingestion/activation as before.

- Preserve explicitly allowed gap-bearing summary ownership without regenerating
  historical prose, while retaining exact chronological cache accounting.
- Price replayed signed-thinking summaries from their stored provider output
  counts instead of replacing exact measurements with the legacy fallback.

- `provenance.requestHash` now identifies the request the transport actually
  ACCEPTED. In the carrier-transport degraded path both mint sites sent a
  reasoning-stripped copy of the request but hashed and persisted the
  original, so a summary authored by the stripped retry carried the hash of
  bytes the model never read: `sha256(preimage) === requestHash` verified
  green while the stored request was not the authoring one. L1 attempts and
  merges now hash, map and persist the accepted bytes. A split-stitched L1
  (`compressionSplitFallback`) records each fold part's accepted request hash
  and, with `persistMintPreimages: true`, persists every leaf's preimage — its
  own `requestHash` is a composite over the parts, not a request.

## 0.7.0 — 2026-09-01

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

- **`OverBudgetError`, `UncoveredDropError` (and `OverBudgetDiagnostics`) are
  exported from the package root** (#41). Both errors are cross-package
  behavioral surface — agent-framework gates its OverBudget drain breaker and
  `context_refusal` classification on them (AF PR #58,
  `classifyInferenceError`) but could only match `err.name` across the
  boundary. Consumers now get a real `instanceof`; the constructors' message
  wording stops being implicitly load-bearing. Additive, no behavior change.

- Autobiographical L1 compression can opt into default-off `compressionSourceOnly` mode, which scopes the auxiliary mint request to the compression marker, exact target chunk, and write-memory directive while leaving primary and merge requests unchanged. The residence-scoped mode preserves source and stored memory, keeps tool definitions for tool-bearing history, and fails quiet with one quarantined call on refusal (#75).

- Effective configuration is now readable, with the layer that supplied each
  key: `resolveEffectiveConfig(layers, semantics)` collapses ordered named
  layers into `{ effective, provenance }`, and `strategy.configProvenance`
  exposes that map for an autobiographical or knowledge instance
  (`'library-default'`, `'caller'`, `'knowledge-enforced'`, or whatever a host
  names its own layers). Values previously coalesced through `??`-chains across
  52 default sites, so the effective value of a key was recoverable only by
  reconstructing the chain by hand and the layer that supplied it was not
  recoverable at all. `semantics` is stated per call rather than assumed:
  `'skip-nullish'` reads a layer's `undefined`/`null` as "not supplied" (the
  `??` rule, and what a host stacking env/profile layers wants), while
  `'spread-fidelity'` lets a layer's own keys win exactly as
  `{ ...defaults, ...caller }` assigns them. The strategies resolve with
  spread fidelity, which is what their constructors always did, so no caller's
  effective config changed — including callers passing an explicit `undefined`
  or `null`, where the two readings differ.
- New option `logEffectiveConfig` (default `false`): one structured
  `config:effective` line on stderr carrying every effective key with its
  source, for operators who want the resolved picture in their logs rather than
  through a debugger. It is emitted at strategy initialization rather than at
  construction, so a subclass instance reports the strategy it actually is.
  The line carries a third field, `presentAsUndefined`: keys a caller supplied
  as explicit `undefined` stay present in the effective config but cannot
  survive JSON, so they are named there instead — every provenance key is
  either valued in `effective` or listed in `presentAsUndefined`, never both.

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

- **`recallEnvelope` — opt-in structural delimiting for recall answers.**
  A recall answer has never had an end delimiter: the Q-side label opens the
  memory and the turn boundary is all that closes it, and instances have been
  observed reading past the end of a recalled memory into unrelated content.
  With `recallEnvelope: 'xml'` every recall answer's prose is fenced by
  `<cm-recall id="…" level="…" span="…">` … `</cm-recall>`, on the presented
  window (both select paths) and on the mint/merge recall ladders alike.
  Attributes are sourced from the summary record and omitted when it cannot
  answer for one; content is never entity-escaped (the envelope is a
  collision-tolerant delimiter convention, not parseable XML); reasoning
  carriers are left byte-identical; Q-side labels are unchanged in both modes,
  so zero-recall surgery keys on exactly what it always did. The recall-pair
  budget prices each summary's actual envelope string. Under
  `maxMessageTokens` a capped answer is truncated as prose and enveloped
  afterwards, so opener and closer survive every cap. Default `'none'`
  renders byte-identically to before.

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

- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.

- Autobiographical L1 compression can opt into `compressionSourceOnlyFallback`, which preserves the ordinary canonical request and configured recall-curve attempts, then makes exactly one marker+target+directive source-only call only after every earlier bounded attempt fails. The legacy `compressionSourceOnly` first-choice switch remains compatible; source-only no longer has to become permanent default geometry when it is intended as an emergency last rung.
- Merge compression can likewise opt into `compressionMergeSourceOnlyFallback`: ordinary persisted retry shapes run first, and the final permitted merge attempt uses the exact legacy target-only wire shape. Legacy `compressionMergeSourceOnly` first-choice behavior remains compatible.

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

- Rebuild the message ID-to-index lookup after a Chronicle branch switch, so
  message mutations and `branchAt(messageId)` cannot use slot positions cached
  from a differently shaped sibling branch.

- `getCompressionDebt()` accepts `Date` message timestamps (the live
  `StoredMessage` shape) when deriving `oldestPendingAgeMs`; the number-only
  filter had made the degraded(>1h)/critical(>6h) staleness ladder
  unreachable in production (#82).

- Base64 raster images now derive PNG, JPEG, GIF, or WebP MIME from byte magic on ingress and again when resolving legacy blob references. Incorrect transport metadata can no longer persist into provider requests and hard-down a residence with repeatable image-type 400s; blob bytes and unknown media types remain unchanged.

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
