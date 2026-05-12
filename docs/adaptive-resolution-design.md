# Adaptive Resolution for AutobiographicalStrategy

**Status:** Design draft · **Author(s):** antra-tess + Claude (Opus 4.7) · **Date:** 2026-05-12

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

## 2. Goals

This redesign must balance three forces:

1. **Adaptive resolution (per spec).** The live view picks a resolution per region. Folding happens *because* the tail is approaching budget, not because a counter crossed a literal. Regions that comfortably fit at a higher resolution stay there.

2. **Cache stickiness.** Anthropic prompt caching keys on exact-prefix match. Every change in the rendered prefix is a cache miss starting at that point. Folding decisions therefore must be **monotonic in the common case** — once a region is folded, it stays folded even if hypothetical budget would permit unfolding. Speculative unfold = cache trash. Pressure-driven unfold = never (V1).

3. **V2 agent unfold/refold.** A future iteration gives the main agent explicit `unfold(summaryId)` / `refold(summaryId)` tools so it can pull a region back to higher resolution to look at something specific, then re-fold when done. V2 introduces *intentional* cache misses; V1's design must leave room for this without re-architecting.

Non-goals (V1):

- **Speculative unfolding to use spare budget.** Even if the tail is small enough that folded regions could be unfolded back to L0, V1 leaves them folded. Cache stickiness wins. (V2's agent-driven unfold is the path for "I want to see this in detail.")
- **Reordering folds.** Folds happen chronologically from oldest to newest, per the spec's "Compression is always chronological and never destructive" principle. The data model permits non-chronological folds but the picker doesn't issue them.
- **Removing summaries from the archive.** Summaries are write-once. Even regions currently rendered at L0 keep their pre-computed L1/L2/L3 in the archive (or schedule them for background production) so future folds are free.

## 3. Model

### 3.1 The archive is monotonic; the live view is a projection.

This is the principle the spec opens with, and it's load-bearing here. Concretely:

- **Archive** = all summaries at all levels, indexed by `source_hash` (so re-summarizing the same chunk is idempotent). Append-only. Never deleted. Already implemented as the `summaries` state slot.
- **Live view** = the output of `select()`, a sequence of `ContextEntry` objects rendered into the LLM request. Computed at compile time from message store + summaries + render state.
- **Render state** = the new addition. A per-region resolution table that says "for region R, show level L." Persists across turns. Updated only by the fold/unfold algorithm below.

### 3.2 Regions and resolutions

A **region** is a contiguous range of source messages identified by `(firstMessageId, lastMessageId)`. Regions partition the conversation: every message is in exactly one region.

A **resolution** is one of `L0 | L1 | L2 | L3`:

- `L0` = render raw messages
- `L1` = render the L1 summary's recall pair
- `L2` = render the L2 summary's recall pair (covers what was multiple L1 regions)
- `L3` = render the L3 summary's recall pair (covers what was multiple L2 regions)

A region's resolution determines two things: what gets emitted in the live view (raw messages vs. a recall pair), and which other regions are subsumed (an `L2` region covers what was previously multiple `L1` regions; those `L1` regions collapse into the parent).

Region boundaries can shift up the hierarchy (when folding deeper) but the boundaries themselves are derivable from the archive's summary tree: if `L2-15` was built from `L1-{6..11}`, an `L2` region for `L2-15` covers the union of source ranges of those L1s.

### 3.3 Pressure-driven, chronologically-ordered fold

When `compile()` is invoked:

1. Walk the messages. Identify the **tail** (recent window) — keep everything in it at `L0`. Same as today.
2. Identify the **head** (configurable preserve-verbatim region at the start) — also `L0`.
3. **Compute current rendered tokens** at the current per-region resolution.
4. **If total ≤ budget**: nothing to do. Emit.
5. **If total > budget**: pick the oldest region whose resolution can be raised (L0 → L1 → L2 → L3), raise it by one step, recompute, loop. Stop when the budget fits or no more regions can be folded.

The "raise by one step" rule preserves cache: an existing fold at L1 either stays at L1 (cache-hit) or moves to L2 (cache miss starts from that point, propagates forward). It never reverses (no spontaneous unfold).

Pseudocode:

```typescript
function pickResolutions(state: RenderState, budget: number): RenderState {
  let total = state.totalTokens();
  while (total > budget) {
    const target = state.oldestRegionAtResolution(['L0', 'L1', 'L2'])
      ?.firstWhere(r => !r.lockedByAgent);
    if (!target) break;                                // can't fold further
    state.raiseResolution(target);                     // L0→L1 or L1→L2 or L2→L3
    total = state.totalTokens();
  }
  return state;
}
```

### 3.4 Cache-stickiness

The pressure picker is monotonic by construction: it only raises resolutions, never lowers them. So the **prefix of folds at any compile is a superset of the prefix of folds at any earlier compile**. Cache hits across turns are preserved at every prefix length up to the most-recently-folded boundary.

Counter-example to watch for: the head and tail windows themselves can shift (e.g., as new messages arrive, the recent-window's left edge advances). When the recent window slides past a message, that message becomes part of the compressible middle and gets a fresh resolution decision. If the picker assigns it `L0` initially (region still fits) and later raises to `L1` (region forced over budget), that's a cache miss at that message's position — but it's a *one-time* miss, propagated forward forever. Re-folds don't oscillate.

### 3.5 Slack for stability

To prevent the picker from sitting just below budget and folding on every minor token fluctuation, two knobs:

- **Hysteresis target**: the picker folds until total tokens ≤ `budget * (1 - slack)`, e.g. 90% of budget. Once below, no further folds until the tail grows enough to cross the budget line again.
- **Fold granularity**: the picker doesn't fold one message at a time; it folds whole regions (the source range of one summary at a level). So crossing the threshold by 1 token still triggers a region-sized fold — but that's the natural unit, not a problem.

The slack value should be configurable (config: `compressionSlackRatio`, default `0.1`). Lower → more aggressive folding (more cache stability, less resolution). Higher → less aggressive (less stability, more resolution).

## 4. Data model

### 4.1 What `mergedInto` becomes

`SummaryEntry.mergedInto` was carrying two meanings: "this summary has a parent in the archive" AND "this summary is hidden from the live view." Split these:

- **Hierarchy** (archive metadata, immutable once written): `SummaryEntry.parentId?: SummaryId` — the L_{n+1} summary this one was a source for, if any. Multiple L1s share a parent L2; multiple L2s share a parent L3. Renamed from `mergedInto` to make the new meaning explicit (and so older code paths reading the old field name fail loudly).
- **Render state** (a new state slot, branch-scoped per PR #14): `agents/<agent>/autobio:renderState`, an array of region records, each:

```typescript
interface RegionRecord {
  /** Stable region identifier. For an L1 region: the L1's id. For an L2
   *  region: the L2's id. For an L0 region: the messageId range start. */
  regionId: string;
  /** First and last source-message IDs covered by this region. */
  firstMessageId: MessageId;
  lastMessageId: MessageId;
  /** Current display resolution. */
  resolution: 'L0' | 'L1' | 'L2' | 'L3';
  /** True if the agent explicitly unfolded this region (V2) — picker must
   *  not refold it without the agent's consent. */
  lockedByAgent: boolean;
  /** Sequence at which this region's resolution was last changed.
   *  Used for telemetry / debugging. */
  lastChangedAt: Sequence;
}
```

The render-state slot is an `append_log` with `editStateItem` semantics: each fold/unfold writes a new entry; `getStateJson` returns the latest array. Branch-scoped, so forks inherit the resolution choices at the fork point.

### 4.2 Backward compatibility

Existing chronicles have `SummaryEntry.mergedInto` populated. On strategy `initialize()`:

1. Detect any `mergedInto` pointers.
2. Synthesize a `RenderState` matching their effect: for each chain `L1 → L2 → L3`, emit a `RegionRecord` with `resolution: L3` covering the union of the L1's source ranges, `lockedByAgent: false`.
3. **Migrate-in-place** by writing the synthesized render-state to the slot, then ignoring `mergedInto` thereafter (treat as advisory hint that can be lifted in V2's unfold).

This means: **existing Lena chronicles continue to render the same way after the change**, but new folds are pressure-driven and the agent (V2) can eventually unfold the pre-stamped regions.

## 5. Operations

### 5.1 `summarize_chunk` (archive write, unchanged in spirit)

`tick()` continues to walk the compression queue and produce L1 summaries from raw chunks via the LLM. Idempotent by `source_hash`. **No render-state change.** This is the spec's archive write.

L2 and L3 summaries are no longer produced by `checkMergeThreshold` on quantity. Instead, they're produced lazily: when the picker decides to raise a region to L2 (or L3) and no archive summary exists yet for that range, the picker enqueues a summarize_chunk-at-level work item and falls back to a lower resolution for THIS compile. Next tick produces the L2; next compile uses it.

Optional optimization (V2-friendly): a background loop that speculatively produces L2s and L3s ahead of time so the picker never has to wait. Cheap LLM calls, and the spec endorses speculative archive work.

### 5.2 `fold` (live-view mutation, new entry point)

Internal function called by the picker. Signature:

```typescript
function fold(region: RegionRecord, toResolution: Resolution): void {
  // Update render state: region's resolution = toResolution.
  // Append a state record to autobio:renderState.
  // No LLM call. No archive change.
}
```

Folding a region to `L2` collapses the L1 regions it covered into the single L2 region (the underlying summary tree dictates the cover). Folding to `L3` collapses L2 regions analogously.

### 5.3 `unfold` (V2 hook, sketch only)

```typescript
function unfold(regionId: string, opts?: { lock?: boolean }): void {
  // Lower this region's resolution by one step (or to L0 if requested).
  // If opts.lock, set lockedByAgent so the picker won't refold it
  // without the agent's consent.
  // Re-render budget; if over budget, fold something ELSE to compensate.
}
```

V2 exposes this as a tool the agent can call. The fold-to-compensate part is the spec's "trading resolution in one region for resolution in another." V1 stubs unfold but doesn't expose a tool yet.

### 5.4 `select` (changed)

The hierarchical select path consults `RenderState` instead of `mergedInto`. For each region in chronological order:

- `L0` → emit raw messages
- `L1` → emit L1's recall pair
- `L2` → emit L2's recall pair
- `L3` → emit L3's recall pair

Head and tail are special-cased to always `L0`. The picker has already raised middle regions as needed.

The existing positioned-recall-pair logic (PR #15 gap #2) survives intact — it interleaves summary recall pairs with raw pinned messages in chronological position. With `RenderState`, that interleaving is computed from the same per-region table.

## 6. The picker algorithm in detail

The picker runs once per `compile()`. Given:

- `totalBudget`: max tokens (from `TokenBudget.maxTokens - reserveForResponse`)
- `slack`: `compressionSlackRatio` (default 0.1)
- `targetBudget = totalBudget * (1 - slack)` (the hysteresis target)
- `renderState`: the persisted per-region resolutions (read at compile start)
- `messageStore`, `summaries`, `pins`, etc.

```
1. Identify the head window (first M tokens, kept raw)
2. Identify the tail window (last K tokens, kept raw)
3. Initialize a workingState from renderState:
   - For any new region (region not yet in renderState — typically the
     newest L1 that just landed in the middle), default to L0
4. Loop:
   - Compute total tokens of the would-be-rendered context with
     workingState's current resolutions
   - If total ≤ targetBudget: break (we have headroom)
   - Find the OLDEST region in workingState whose resolution can be
     raised (L0 → L1 if an L1 summary exists or can be queued; same
     for L1 → L2; same for L2 → L3)
   - If no such region exists: break (we've folded everything we can)
   - Raise that region's resolution by one step
5. If workingState differs from renderState, persist the diffs to
   autobio:renderState (one append per changed region)
6. Render using workingState
```

The "raise by one step" rule is critical for caching: a region only ever moves up the hierarchy, not down. Concretely the cache-miss boundary moves *forward in conversation position* monotonically (the new fold is the leftmost mismatch from the previous compile's render), and once a prefix is committed it survives unchanged across turns until the next region in front of it folds.

If a region needs to be raised but the next-level summary doesn't exist in the archive yet:

- **Option A**: enqueue the summary for next tick and leave this region at its current resolution. The compile may then go over budget for this turn; we accept that and rely on subsequent turns to catch up.
- **Option B**: synchronously summarize before completing the compile. This is the original "compile awaits compression" behavior we explicitly moved away from in `3e42e98` for latency reasons.

V1 ships Option A. (V2 might add a third option: emit at the lower resolution but truncate the tail until summaries are ready — another lever the spec implicitly allows by saying "or accepting a shorter tail.")

## 7. Cache implications, made explicit

Cache behavior of the picker, conversation turn by conversation turn:

```
Turn 1, 50K tokens, all L0:           [head][raw....][tail]
Turn 2, 70K tokens, all L0:           [head][raw.......][tail]
Turn 3, 90K tokens, all L0:           [head][raw..........][tail]
Turn 4, 120K tokens, BUDGET 100K:     [head][L1][raw....][tail]
                                            ^ cache miss starts here
Turn 5, 140K tokens, all L0+1×L1:     [head][L1][raw......][tail]
                                            cache hits up to here
Turn 6, 170K tokens, fold deeper:     [head][L1][L1][raw...][tail]
                                                ^ second fold, cache miss starts here
Turn 7-10, more L1 folds at oldest:   [head][L1][L1][L1][L1][raw..][tail]
Turn 11, enough L1s for L2 to help:   [head][L2  ][L1][L1][raw..][tail]
                                            ^ third type of cache miss
```

Key properties:

- **Cache hit width grows over time** until pressure forces a new fold.
- **Each fold creates one cache-miss boundary** at the fold position, but the *new* prefix becomes the cache key for subsequent turns.
- **An L1→L2 fold-up** (consolidating multiple existing L1 regions into one L2 region) is a single cache miss at the start of the affected L1 range. It's strictly better than re-folding multiple L1s into multiple new L1s of different sizes (which the current threshold-driven implementation does at every merge boundary).
- **The picker never inserts a fold in the middle** — folds always happen at the chronologically-oldest unfolded region. So mid-conversation cache rebuilds don't occur.

V2's agent-driven `unfold` violates this monotonicity intentionally, and the cache cost is taken explicitly (the agent decided that seeing the detail was worth a cache miss). V2 should also expose pressure-driven refold so that an agent who unfolded too much can have the picker re-fold the agent's region — but only if `lockedByAgent` is false, since agent locks survive the next picker run.

## 8. V2 considerations folded into V1 design

The data model above already accommodates V2:

- `lockedByAgent` field on `RegionRecord` is the agent-control hook. V1 always writes `false`; V2 exposes a `lock: true` option on `unfold`.
- `unfold(regionId)` is the V2 tool. V1 has the internal function (used only by migration today) but no agent-facing tool.
- The picker's "find oldest non-locked region" skip honors agent locks once V2 introduces them, with no other code changes needed.
- The render-state slot is branch-scoped (PR #14's persistence model), so an agent's unfold on a branch doesn't leak into other branches. This matters because V2 might want to fork "let me look at this in detail" branches without polluting the main timeline.

What V2 adds beyond V1:

- The `unfold` / `refold` tools, plus their delegation to the picker for compensation folds.
- A "soft pressure" mode where the picker can suggest unfolds to the agent rather than fold automatically — useful for "I have unused budget; want to see anything in higher detail?"
- Possibly: per-region pin metadata that says "this region is high-value, refold last." Currently we have one pin layer (`agents/<agent>/autobio:pins`) for keep-raw-no-matter-what; V2 might add a softer prefer-detailed-resolution hint.

## 9. Migration plan

The change is invasive. Suggested rollout:

### Phase 1 — Add the new state slot + picker, dual-write

- Add `RenderState` slot, populate on initialize from existing `mergedInto` pointers.
- Wire picker into `select()`, gated behind a feature flag (`config.adaptiveResolution: true`). Default off.
- `checkMergeThreshold` and `mergedInto` continue to operate as today.
- A/B test: same conversation rendered with old logic vs. picker, compare outputs.

### Phase 2 — Switch default; deprecate the threshold path

- Default `adaptiveResolution: true`.
- `checkMergeThreshold` becomes a no-op (or emits a deprecation warning when invoked).
- `mergedInto` is no longer written by new merges (existing pointers remain for back-compat in render).

### Phase 3 — Remove the threshold path

- Delete `checkMergeThreshold`, `mergedInto` writes, related tests.
- Migrate any remaining chronicles forward (one-time migration script).

This staging keeps existing deployments stable while we validate the picker against real workloads.

## 10. Open questions

1. **Region boundaries when L1s overlap on the same chunk.** Can two L1s ever cover the same source range? Today they shouldn't (production is idempotent on `source_hash`), but defensive checks in the picker need a tie-breaker.

2. **Pins interaction.** The spec says pins are display locks, not write locks. The picker must skip pinned regions when selecting fold targets. But what if the only way to fit budget is folding a pinned region? Spec implies: accept being over budget rather than violate a pin. Confirm.

3. **Recall-pair format consistency.** Today recall pairs for L1/L2/L3 are formatted slightly differently (level-specific headers). Under adaptive resolution, the same chunk might render as an L1 recall on turn 5 and an L2 recall on turn 11. The agent sees a different summary content for what it remembers as "the same memory" — does this break the as-of invariant from the spec? Probably not (each summary is faithful to its own as-of moment), but worth thinking through.

4. **L2/L3 production lag.** If picker decides to raise to L2 and the L2 summary doesn't exist yet, V1 ships Option A (defer fold, accept over-budget for this turn). What's the recovery story if the deferral compounds (more turns push tokens higher, but L2 never gets produced fast enough)? Probably: prioritize fold-imminent summaries in the background tick queue.

5. **Default `slack`.** 10% seems reasonable but is plucked from intuition. Should be tuned against real conversation data.

6. **Migration for in-flight branches.** Some users may have multiple existing branches with different `mergedInto` states. Phase 1 migration synthesizes RenderState per branch — but the synthesized state assumes "show what was being shown." If a user expects unfold to recover what was originally raw, they're disappointed (the original raw chunks are in the archive, but their region was stamped to L3 already). V2's unfold helps here. Document.

7. **Telemetry.** What should `getRenderStats()` report under the new model? At minimum: per-resolution live region counts, total folds since last compile, picker iterations. The `RenderStats` interface (added in PR #16) needs extension.

## 11. Implementation scope estimate

- New state slot + types: ~80 LOC
- Picker algorithm: ~150 LOC
- Integration in `select()` (mostly subtraction from existing code): ~50 LOC net
- Migration on `initialize`: ~60 LOC
- Tests: ~250 LOC (picker behaviors, migration, cache-stickiness over a turn sequence, V2 hooks plumbed but not exposed)
- Deprecation glue for phase 1/2: ~30 LOC

Total: ~600 LOC of new + ~80 LOC deleted, with a feature flag controlling the rollout.

## 12. Related work

- [`hermes-autobio/docs/hierarchical-autobiographical-memory.md`](../../hermes-autobio/docs/hierarchical-autobiographical-memory.md) — the canonical spec this design implements.
- PR #15 — added the autobio spec gaps (positioned recall, pins, search, etc.); established the type-guard pattern this design uses for `RenderState`.
- PR #16 — fixed the silent-message-drop on `compile()` in hierarchical mode; the picker's "fold the oldest" logic depends on the raw-fallback for uncompressed chunks still being there.
- PR #17 — fixed `MessageStore.get` returning slot index as sequence; chained branching now works, which the picker relies on when navigating region boundaries across forks.

## 13. Decision needed

This design is concrete enough to either implement or critique. Specifically, please weigh in on:

- **The migration story.** Is it acceptable for existing chronicles to render the same way they do today (just via the new state slot), with unfold only available in V2? Or do we need to preserve the option to recover original-raw NOW?
- **The slack value default.** 10%? 15%?
- **The deferred-L2/L3-production policy** (Option A vs B vs C in §6). V1 ships Option A, but if any of you run a workload where compile latency isn't the bottleneck and budget-overage is, B might be acceptable.
- **`lockedByAgent` semantics.** Is the V1 stub (always-false) enough? Or should we expose at least a programmatic API (no tool yet) so module hosts can set locks?
