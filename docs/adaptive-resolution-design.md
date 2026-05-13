# Adaptive Resolution for AutobiographicalStrategy

**Status:** Design draft (revision 2) · **Author(s):** antra-tess + Claude (Opus 4.7) · **Date:** 2026-05-12

## Changelog

- **rev 2 (2026-05-12)**: Major revision after design discussion. Switched from fixed L0–L3 levels to unbounded L_n. Replaced `RenderState` slot with on-chunk state. Replaced stored regions with derived runs over per-chunk state. Added `bodyGroupId` mechanism for sub-message chunking, used for documents *and* oversize chat messages. Added pluggable `FoldingStrategy` interface with `FlatProfileStrategy` as default. Corrected the cache analysis. Added migration recovery mode for over-folded chronicles.
- **rev 1 (2026-05-12)**: Initial draft.

## 1. Problem

`AutobiographicalStrategy` currently folds memories **opportunistically**: whenever `N` L1 summaries accumulate (default `N = 6`), `checkMergeThreshold()` enqueues an L1→L2 merge; whenever `N` L2s accumulate, an L2→L3 merge. The merge marks each source summary with `mergedInto: <parentId>`, and `selectHierarchical()` filters by `!mergedInto` — so a "merge" is in practice **a one-way display mutation**: the L1s disappear from the live view and are replaced by the L2's recall pair.

This contradicts the design spec ([`hermes-autobio/docs/hierarchical-autobiographical-memory.md`](../../hermes-autobio/docs/hierarchical-autobiographical-memory.md)), which is explicit that two operations must be **separate**:

> ### `summarize_chunk` — archive write
> Produces an L1 and writes it to the archive. **Does not touch the live view.**
> - Safe to run eagerly, including in the background.
>
> ### `fold_chunk` — display mutation
> Replaces a chunk in the live message list with a recall pair.
> - **This is the decision gated by pins, documents, and token pressure.**

And the spec frames the layered hierarchy as **adaptive resolution**:

> Layers are not fixed strata — they are adaptive resolution.
> [...] The memory landscape at any moment might look like:
> `...L3...L3...L2...L1...L1...L2...L3...L2...L1...L0 (tail)`
>
> The archive always has every layer available; the live view picks one resolution per region.

The TS implementation conflates archive-write with display-mutation, and uses **quantity** (count crossing threshold) rather than **pressure** (token budget) as the gating signal. Concrete consequence observed in a live Lena session (recipe `recentWindowTokens: 475000`, total conversation ~430K tokens — well under the recent budget):

```
L1: 3 live, 36 merged → L2-{13,15,20,27,34,41}
L2: 0 live, 6 merged  → L3-42
L3: 1 live
```

The entire conversation could comfortably fit at **L1 resolution** (36 × ~3K tokens = ~108K), but the strategy folded it all the way to a single L3 because count crossed threshold, not because the budget was tight. There is no path back to L1: `selectHierarchical` consults `mergedInto`, and once stamped the pointer is permanent.

A second class of problem motivates the chunking work in §3.6: an instance receiving a single 500K-token document as its initial context cannot reasonably be compressed to a 2K L1 summary, nor can it be split into separate API messages without destroying KV cache. The design must accommodate sub-message resolution.

## 2. Goals

This redesign must balance four forces:

1. **Adaptive resolution (per spec).** The live view picks a resolution per region. Folding happens *because* the tail is approaching budget, not because a counter crossed a literal. Regions that comfortably fit at a higher resolution stay there.

2. **Cache stickiness.** Anthropic prompt caching keys on exact-prefix match. Every change in the rendered prefix is a cache miss starting at that point. The picker should be **stingy**: fire only when truly needed, raise the minimum required, then go silent for many turns.

3. **Pluggable folding policy.** Different deployments have different priorities (oldest-first, flat-profile, content-importance, topic-coherence). The picker is a generic orchestrator; the policy is a separate object that any strategy can implement.

4. **V2 agent unfold/refold.** A future iteration gives the main agent explicit `unfold(chunkId)` / `refold(chunkId)` tools so it can pull a region back to higher resolution to look at something specific, then re-fold when done. V2 introduces *intentional* cache misses; V1's design must leave room for this without re-architecting.

Non-goals (V1):

- **Speculative unfolding to use spare budget.** Default V1 strategies are monotonic. Non-monotonic strategies are *permitted* by the architecture but not shipped.
- **Reordering folds.** Folds happen chronologically per the spec's "Compression is always chronological and never destructive" principle. Specific strategies may reorder; the default does not.
- **Removing summaries from the archive.** Summaries are write-once. Pre-computed L_n summaries are retained for future folds.

## 3. Model

### 3.1 The archive is monotonic; the live view is a projection.

This is the principle the spec opens with, and it's load-bearing here. Concretely:

- **Archive** = all summaries at all levels, indexed by `source_hash` (so re-summarizing the same chunk is idempotent). Append-only. Never deleted. Implemented as the `summaries` state slot.
- **Live view** = the output of `select()`, a sequence of `ContextEntry` objects rendered into the LLM request. Computed at compile time from message store + summaries + per-chunk resolution state.
- **Per-chunk resolution state** = the new addition. Each chunk carries its current display resolution as a small field on its `MessageEntry`. Persists across turns. Updated only by the picker (or, in V2, by an agent-driven strategy).

### 3.2 Chunks, levels, and resolutions

A **chunk** is the unit of fold operations. For chat messages under `chunkThreshold` (default 8K tokens), one chunk = the whole message. For larger messages — pasted documents, large tool-call results, dumped logs — a message is split into multiple chunks at ingestion (see §3.6).

A **level** is a non-negative integer:
- `L0` (level 0) = render the chunk's raw content.
- `L1` (level 1) = render the L1 summary covering this chunk (and possibly N-1 sibling chunks).
- `L_k` for `k > 1` = render the L_k summary covering this chunk's L_{k-1} ancestor (and that ancestor's siblings).

Levels are **unbounded**: there is no fixed `L3`-as-top. When the picker needs to fold further than existing summaries support, it produces L_{k+1} from N existing L_k summaries (default N = 6). This bounds the worst-case fold depth to `log_N(chunk_count)`, and means the picker can always make progress as long as there is more than one foldable group remaining.

A **region** at level k is not a stored object. It is the maximal contiguous run of chunks that share an L_k ancestor in the summary tree and all have `currentResolution = k`. Regions are derived at render time by scanning chunks left-to-right. Run-length encoding, not a table.

### 3.3 Per-chunk state

```typescript
interface MessageEntry {
  // ... existing fields (id, role, content, timestamps, etc.) ...

  /** The chunk's current display resolution. 0 = render raw; k > 0 = render
   *  the L_k ancestor's recall pair (collapsing this chunk and its
   *  L_k-sharing siblings into one rendered item). Default 0. */
  currentResolution: number;

  /** True if the agent explicitly fixed this chunk's resolution (V2). The
   *  picker must not change the resolution while this is true. Default false. */
  lockedByAgent: boolean;

  /** Sequence at which currentResolution was last set. Telemetry / debugging. */
  resolutionChangedAt?: Sequence;

  /** If this MessageEntry is a shard of a larger logical message, the group
   *  id shared with its sibling shards. See §3.6. Default null. */
  bodyGroupId?: string;
}
```

Edits to `currentResolution` follow the existing chronicle pattern (append a delta record; replay reconstructs state). The same pattern already supports `SummaryEntry.mergedInto` edits today, so the cost model is known.

### 3.4 The summary tree

`SummaryEntry.mergedInto` is renamed `parentId` and becomes **archive metadata only**:

- `parentId?: SummaryId` — the L_{k+1} summary this one is a source for, if produced. Multiple L_k summaries share a parent L_{k+1}. Set once at archive-write time. Never used by the render path (which now consults per-chunk state instead).
- `level: number` — the summary's level (1 for L1, 2 for L2, …).

The rename is intentional: old code paths reading `mergedInto` to make display decisions will fail loudly. Display decisions live in `MessageEntry.currentResolution` now.

### 3.5 Pluggable folding strategy

The picker is a generic orchestrator. Decisions are delegated to a `FoldingStrategy`:

```typescript
type FoldOp =
  | { kind: 'raise'; groupRoot: SummaryId }       // group-fold up one level
  | { kind: 'lower'; groupRoot: SummaryId }       // refold down (non-monotonic)
  | { kind: 'produce'; level: number; range: ChunkRange };  // lazy production

interface FoldingState {
  chunks: Iterable<ChunkView>;       // ordered, includes resolution + lineage
  summaries: SummaryTree;             // archive lookup
  pins: Set<ChunkId>;
  head: ChunkRange;
  tail: ChunkRange;
  tokenCount(): number;
}

interface FoldingStrategy {
  /** Return the next fold operation, or null if no more folds needed. */
  selectNextFold(state: FoldingState, budget: TokenBudget): FoldOp | null;
}
```

The picker's loop:

```
let op = strategy.selectNextFold(state, budget)
while op:
  apply(op, state)
  op = strategy.selectNextFold(state, budget)
emit(state)
```

Strategies shipped in V1:

- **`FlatProfileStrategy`** (default). Aims for roughly-equal counts of *visible items* at each non-trivial level. Monotonic (only emits `raise`). See §3.7.
- **`OldestFirstStrategy`**. The behavior originally proposed in this doc's rev 1. Monotonic. Kept for comparison and as a fallback during early rollout.

Strategies envisioned for later (not V1 scope, but the interface accommodates them):

- `AgentDirectedStrategy` (V2) — honors `unfold`/`refold` operations from the agent; emits compensation `raise`/`lower` ops to keep within budget.
- `ContentImportanceStrategy` — uses content scoring (embeddings, heuristics) to prefer folding low-importance regions.
- `TopicCoherentStrategy` — folds contiguous regions of related content together.

### 3.6 Sub-message chunking via `bodyGroupId`

Any message whose token count exceeds `chunkThreshold` (default 8K) is split into shards at ingestion. Each shard is its own `MessageEntry` with:

- A stable `bodyGroupId` shared with its sibling shards.
- A `sourceHash` over the shard's content, for summary idempotency.
- The same `role` as the original message.
- A `range: { startByte, endByte }` into the original content, for byte-faithful reassembly.

**Chunker strategy** (V1, simple): structural-first (markdown headings, code-fence boundaries, JSON top-level keys), token-bucket fallback (default `chunkSize` = 4K tokens, no overlap). Deterministic: re-ingesting identical content produces identical shards with identical `sourceHash`es. Byte-faithful: concatenating shards in order reproduces the original message body byte-for-byte.

**Rendering**: before emitting to the API, the render path groups consecutive entries with the same `bodyGroupId` and concatenates their bodies into a single API message. The role is the group's role. For shards folded to a non-zero `currentResolution`, the shard's body in the concatenation is replaced by its L_k recall pair. The model sees one user message with a mix of raw and summarized content; there are no turn markers between shards because they're inside one message body.

This unifies docs and oversize chat messages: both go through the same chunker, both use `bodyGroupId`, both are foldable at sub-message granularity. The picker doesn't know which is which.

### 3.7 Flat profile strategy

The default strategy. Pseudocode:

```
selectNextFold(state, budget):
  if state.tokenCount() <= budget * (1 - slack):
    return null   // we're below target — no fold needed

  // Count visible items at each level currently in use.
  counts = map<level, int>
  for chunk in state.foldableMiddle():
    counts[chunk.currentResolution] += 1
  // Note: a group of N chunks at level k contributes N to counts[k],
  // but renders as a single recall pair — adjust to count rendered items.
  // For each level k, the number of *rendered items* at level k is
  // the number of distinct L_k ancestors among chunks at currentResolution = k.
  visible = map<level, int>
  for chunk in state.foldableMiddle():
    visible[chunk.currentResolution].add(chunk.ancestorAt(chunk.currentResolution))
  visibleCounts = { k: len(visible[k]) for k in visible }

  // Pick the most-populous level. Tiebreak: lower level (so we fold
  // older fragmented detail before consolidating coarser regions).
  k = argmax(visibleCounts)
  // Within that level, pick the oldest group eligible to raise.
  groupRoot = oldestRaisableGroupAtLevel(state, k)
  if !groupRoot:
    // Try to produce the next level.
    return { kind: 'produce', level: k+1, range: oldestGroupRange(state, k) }
  return { kind: 'raise', groupRoot: groupRoot }
```

Properties:
- **Even distribution across levels in steady state.** With enough budget pressure, the picker spreads the fold depth roughly evenly: more recent regions at lower levels, older regions at higher levels, with no sudden cliffs.
- **Oldest-first behavior preserved *within* a level**, so the narrative property "memory fades chronologically" still holds.
- **Cache cost: bounded re-raises.** A chunk is raised at level k once when level k becomes the most-populous, then again at level k+1 only after k+1 becomes the most populous in turn — typically many turns later.

### 3.8 Group-fold semantics

The atomic operation is `raiseGroup(groupRoot: SummaryId)`:

```
raiseGroup(groupRoot):
  for chunk in chunksUnder(groupRoot):
    if chunk.lockedByAgent:
      continue   // skip locked chunks; group fold becomes partial
    chunk.currentResolution = max(chunk.currentResolution, groupRoot.level)
    chunk.resolutionChangedAt = now()
```

`chunksUnder(groupRoot)` walks the summary tree down from `groupRoot` to all leaf chunks under it. The `max` matters: a chunk already at a higher resolution isn't lowered when an intermediate group containing it is folded later.

**Locked chunks block group-fold partially.** If chunk C is `lockedByAgent: true` and the picker raises C's level-k ancestor group, every chunk in the group *except* C flips to level k. C stays at its current resolution. The rendered output then has a hole inside what was a contiguous group — strategy must handle this in its eligibility check (only consider a group raisable if at least one chunk inside is unlocked, ideally most).

**Producing missing summaries.** If `raiseGroup(groupRoot)` requires L_{k+1} and no L_{k+1} exists yet, the strategy returns a `produce` op instead. The picker enqueues background summarization and returns null (defer fold to next compile). The compile emits at the current state, possibly over budget for one turn — see §3.10 for the fallback when over-budget can't be tolerated.

### 3.9 Cache stickiness, honestly

The rev-1 doc claimed monotonic raises preserve cache. That's true but oversold. Concretely:

- A given chunk's rendered content only ever moves up the level chain (raw → L1 → L2 → …), never reverses. So a chunk's *contribution* to the prefix is monotone-in-resolution.
- But the chunk's *position* in the prefix has different content over time. When the picker raises chunk C from L1 to L2, the byte sequence at C's position changes — cache miss propagates forward from there.
- The cache benefit comes from *between raises*. In steady state, the picker is a no-op (total ≤ budget × (1 − slack)) — full cache hit. The picker's job is to minimize how often raises happen at any given position.

Two design implications:

1. **Slack is essential, not nice-to-have.** Without slack, total bounces above and below budget each turn → picker fires every turn → cache rebuilt every turn. With slack: picker fires only when total exceeds budget, raises until total ≤ budget × (1 − slack), then is silent for many turns.

2. **Strategies should be stingy.** The default `FlatProfileStrategy` raises one group at a time and exits as soon as the budget is met, rather than aggressively folding to maximize headroom.

V2's agent-driven `unfold` violates monotonicity intentionally — the agent decided detail was worth a cache miss. The architecture permits non-monotonic strategies; V1 does not ship one.

### 3.10 Hard-fail fallback

If the strategy returns null while total still exceeds the model's hard context limit (not just the soft budget), the picker enters fallback:

1. **Shrink the tail from its left edge.** Truncate the oldest chunks of the recent window. Each truncated chunk's source content stays in the archive (L0 still exists in the chunk store), so this is reversible if conditions change later.
2. **If the tail can't shrink further** (e.g., it's at minimum size, or the most recent message alone exceeds the limit): truncate the head from the right edge. Last resort because the head is usually pinned for instruction-following reasons.
3. **If neither can give**: raise an `OverBudgetError` to the strategy host. Application-level handling at this point; we've done all we can.

This case should be unreachable in practice with unbounded L_n: only one chunk shouldn't fit on its own, and even then, lower-level shards via `bodyGroupId` chunking break it up.

### 3.11 Recent-window slide

The tail (recent window) is defined by token count from the latest chunk backward: `tail = the most recent K tokens worth of chunks`. As new chunks arrive, the tail's left edge slides forward, exposing previously-tail chunks to the picker.

Algorithm: chunks transitioning out of the tail default to `currentResolution: 0`. They become eligible for raising on the next compile if pressure requires it. No special handling beyond the picker's normal eligibility check.

Edge cases:
- **A single chunk larger than K tokens**: the tail expands to include the whole chunk, even past K. The picker can't fold the most recent chunk ever — only previous ones. Combined with `bodyGroupId` chunking at ingestion, this is bounded by `chunkSize`, not message size.
- **Chunks at the tail boundary mid-bodyGroup**: the tail is defined over chunks, not over logical messages. A bodyGroup may straddle the boundary — its newer shards are tail-protected, older shards are picker-eligible. Render concatenates them back into one API message regardless.

## 4. Operations

### 4.1 `summarize_chunk` — archive write, eager

`tick()` continues to walk the compression queue and produce L1 summaries from raw chunks via the LLM. Idempotent by `sourceHash`. **No display change.** This is the spec's archive write.

L_k summaries for `k > 1` are produced **lazily on strategy request** (a `produce` op from `selectNextFold`). A background loop *may* speculatively produce higher-level summaries ahead of demand to avoid picker latency; the spec endorses speculative archive work. Whether to ship the speculative loop in V1 is an open question (§7).

### 4.2 `fold` — display mutation

```typescript
function fold(groupRoot: SummaryId): void {
  // Walk the summary tree down from groupRoot; set every unlocked leaf
  // chunk's currentResolution to max(current, groupRoot.level).
  // No LLM call. No archive change.
}
```

### 4.3 `unfold` (V2 hook, sketch only)

```typescript
function unfold(chunkId: ChunkId, opts?: { lock?: boolean }): void {
  // Lower this chunk's currentResolution by one step (or to 0 if requested).
  // If opts.lock (default true), set lockedByAgent so the picker won't
  // re-raise it on the next compile without the agent's consent.
  // The picker is then run; if over budget, it folds something else to compensate.
}
```

V2 exposes this as a tool the agent can call. V1 has the internal function (used only by migration today) but no agent-facing tool. Default `lock: true` — explicit unfolds are meaningful, casual ones are rare.

### 4.4 `select` — render path

Walk chunks in source order. For each chunk:
- If `currentResolution == 0`: emit raw content.
- If `currentResolution == k > 0`: emit the L_k recall pair for the chunk's L_k ancestor. (Adjacent chunks sharing the same L_k ancestor emit the recall pair once.)

After this walk, group consecutive entries with the same `bodyGroupId` and concatenate their bodies into a single API message. Pinned chunks (`pins` slot) always render at L0 regardless of `currentResolution`.

The positioned-recall-pair logic from PR #15 survives: pins are interleaved with non-pinned regions in chronological order. The grouping is now driven by `currentResolution` + `bodyGroupId` instead of `mergedInto`.

## 5. The picker, in detail

The picker runs once per `compile()`. Given:

- `totalBudget` = `TokenBudget.maxTokens - reserveForResponse`
- `slack` = `compressionSlackRatio` (default 0.1; see §7 open question)
- `strategy` = configured `FoldingStrategy` instance
- Chunk store, summary tree, pins, head/tail bounds

```
1. Build FoldingState (read-only view over chunks + summaries).
2. op = strategy.selectNextFold(state, totalBudget)
3. While op:
   - if op.kind == 'raise':   fold(op.groupRoot); update chunk state
   - if op.kind == 'lower':   (V2 only) lower one step; update chunk state
   - if op.kind == 'produce': enqueue background summarization; break
   - op = strategy.selectNextFold(state, totalBudget)
4. If any chunk state changed, persist via delta records.
5. If still over hard limit, invoke fallback (§3.10).
6. Render using updated state.
```

Token counting (§7 open question): each chunk has a cached `tokensL0` from ingestion-time tokenization. Each summary has `tokensRecallPair` from its production. Render-time total = sum of (raw chunks at L0) + (one recall pair per distinct L_k ancestor among non-L0 chunks) + pinned chunks + head + tail.

## 6. Migration

### 6.1 Schema migration

Existing chronicles have `SummaryEntry.mergedInto` populated and `MessageEntry.currentResolution` absent. On strategy `initialize()`:

1. **Default mode (conservative)** — preserves the chronicle's current rendered shape. For each `mergedInto` chain `L1 → L2 → L3`, walk down to leaf chunks and set their `currentResolution` to the level of the topmost ancestor that has `mergedInto == null` (i.e., the level actually rendered today).
2. **Recovery mode (`config.migrationRecoveryMode: true`)** — recomputes resolution from current budget. Sets all chunks to `currentResolution: 0`, then runs the configured strategy until budget is met. For over-folded chronicles like Lena's, this produces the resolution the picker would have chosen if it had been running all along.
3. **Rename `mergedInto` → `parentId`.** Field rename, automatic write on any read. Old reads of `mergedInto` for display purposes are now bugs that surface loudly.

Recovery mode is opt-in because it costs LLM calls to produce missing L_k summaries (if not already in the archive) and changes the prefix the agent sees on its next compile — both worth a deliberate operator decision.

### 6.2 Rollout phases

**Phase 1 — Default off behind feature flag.**
- Add `bodyGroupId`, chunker, on-chunk state, picker, strategies, lazy production, hard-fail fallback, migration code.
- Feature flag `config.adaptiveResolution: true` activates the new path.
- Existing chronicles keep rendering as today (default migration mode). New chronicles can opt in.
- `checkMergeThreshold` continues to run on non-`bodyGroupId` chunks for backward compat.

**Phase 2 — Switch default; deprecate threshold path.**
- Default `adaptiveResolution: true`.
- `checkMergeThreshold` becomes a no-op (emits deprecation warning).
- New merges go through the picker.

**Phase 3 — Delete threshold path.**
- Remove `checkMergeThreshold`, related tests.
- One-time forward migration of any remaining unmigrated chronicles.

## 7. Open questions

1. **Slack default value.** 10% (rev 1's guess) vs 15% vs adaptive (based on observed turn-over-turn token delta variance). Probably 10% is fine but should be tuned against real workloads.

2. **Token counting fidelity.** Picker decisions hinge on token counts. Per-chunk and per-summary cached counts (from tokenizer at production time) vs estimate (4 chars ≈ 1 token) vs real-tokenize-on-every-compile. Cached counts are accurate and cheap as long as we always use the same tokenizer; recommend that.

3. **Speculative L_{k+1} production.** Whether V1 ships a background loop that produces higher-level summaries ahead of demand, or only produces them on strategy request. Background pre-production avoids picker latency at first fold but spends LLM tokens that might never be needed. Default V1: lazy only. Background opt-in via `config.speculativeProduction: true`.

4. **Recall pair format consistency across levels.** Under adaptive resolution, the same chunk might be rendered as an L_k recall on one turn and L_{k+1} on a later turn. Each summary is faithful to its own as-of moment, so this is *monotonic memory fading* by construction (more detail → less detail, never reverse) — promote to design property in §3.9 if reviewers agree.

5. **Pins interaction.** Spec says pins are display locks, not write locks. The picker must skip pinned chunks. If the only way to fit budget is folding a pinned chunk, the spec implies accept being over budget rather than violate a pin → fallback in §3.10 kicks in. Confirm.

6. **Branching semantics for on-chunk state.** New chronicle branches inherit chunk state at the fork point via the existing branch-scoped slot model. An agent unfold on branch A does not leak into branch B. Believed to come for free from existing chronicle copy-on-write, but verify with an explicit test.

7. **Telemetry.** `getRenderStats()` needs extension. Suggested: per-level chunk counts, picker iterations and fold ops this compile, lazy production queue depth, total raises since chronicle start. The `RenderStats` interface (PR #16) needs updating.

8. **`lockedByAgent` programmatic API in V1.** V1 ships no agent tool, but should the field be settable via a programmatic strategy-host API so module developers can experiment? Lean: yes, set-only (no agent-facing tool until V2).

## 8. Implementation scope

Estimated breakdown:

| Component | LOC |
|---|---|
| `bodyGroupId` field + render concat | ~30 |
| Chunker module (structural + token-bucket, ingestion-time) | ~80 |
| On-chunk state fields + edit-record plumbing | ~40 |
| `FoldingStrategy` interface + `FlatProfileStrategy` + `OldestFirstStrategy` | ~200 |
| Picker orchestrator loop | ~30 |
| Lazy summary production at arbitrary level | ~80 |
| Token-counting cache on chunks and summaries | ~40 |
| Recent-window-slide handling in eligibility check | ~20 |
| Hard-fail fallback (tail shrink, head truncate, error) | ~40 |
| Migration code (default + recovery mode) | ~100 |
| Deprecation glue for phase 1/2 | ~30 |
| Tests | ~400 |

**Total: ~1100 LOC new + ~80 LOC deleted.** Feature flag controls rollout.

Realistic timeline: 2 weeks of focused implementation + 1 week of integration testing on real chronicles + migration day.

## 9. Related work

- [`hermes-autobio/docs/hierarchical-autobiographical-memory.md`](../../hermes-autobio/docs/hierarchical-autobiographical-memory.md) — the canonical spec this design implements.
- PR #14 — branch-scoped persistence model; on-chunk state is branched naturally via the same mechanism.
- PR #15 — autobio spec gaps (positioned recall, pins, search). Established the type-guard pattern this design uses.
- PR #16 — fixed silent-message-drop on `compile()` in hierarchical mode.
- PR #17 — fixed `MessageStore.get` returning slot index as sequence; chained branching now works.

## 10. Decisions still owed

This design is concrete enough to either implement or critique. Specifically, please weigh in on:

- **Recovery mode for over-folded chronicles.** §6.1 ships it as opt-in. Lena's chronicle is the obvious target. Confirm: opt-in only, or default-on for chronicles where the picker-recomputed resolution would meaningfully differ from the as-stored resolution?
- **Slack default.** §7 #1 — 10%, 15%, or adaptive?
- **Speculative production.** §7 #3 — lazy-only in V1, or also ship the background pre-producer?
- **`lockedByAgent` programmatic API in V1.** §7 #8 — set-only programmatic API even without a tool?

Once these are settled the design is implementation-ready.
