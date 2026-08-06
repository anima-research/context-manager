# Adaptive Resolution for AutobiographicalStrategy

**Status:** Implemented (PR #19) · **Author(s):** antra-tess + Claude (Opus 4.7) · **Date:** 2026-05-12 (last reconciled 2026-05-15)

## Changelog

- **rev 5.1 (2026-08-05)**: Doc-truth reconciliation against the shipped solver (audited `fa8f938..ec34f2b`). §13.2 corrected: the shipped solve is a **lexicographic branch cascade**, not the drafted `+ λ·perturbation` minimization (no λ exists in `src/`); `relevance_loss` documented as what it is — a salience-weighted *misallocation comparator*, not a minimand; the enforced rejection wall documented as `W × (1 + overBudgetGraceRatio)` at the strategy layer. §13.4 pseudocode regenerated from `planControlledFrontier` (adds `strictReach`/`blocked`, the `madeProgress` guard, the exact bootstrap predicate). §13.5's "budget-driven depth by construction" claim corrected (phase B is W-gated; the shape prior still bounds depth in the [target, W] band). New **§13.6** documents the robustness machinery the solve grew in production (boundary-cut tolerance `de3d293`, overlap tolerance + fold→project fixpoint `b99fcc3`/`204431b`, deepest-first projection, phase-C overshoot acceptance, the `TokenLedger` invariant, memoization contracts). New **§13.7** documents prepared-window transitions (`goalTotalTokens`/`strictReach`/hot-context API). §12 marked historical; its phantom `best-fit` strategy bullet removed (deleted in `ea198a1`).

- **rev 5.0 (2026-07-12)**: The kv-stable controller is redesigned as a **single-path solve** — the emergency path, the reach *eligibility gate*, and the fold/expand pass pair are removed. One algorithm per turn: build the salience-weighted **ideal cut** (relevance only, W the sole hard wall), then reconcile it against the carried frontier under a **perturbation trust region** (P, the re-priced `reachTokens`) via suffix adoption, with a **quality-gap override** allowed to exceed P. Salience becomes a per-chunk *coefficient on information loss* (fold-cheap content: externalized code / tool output / images) rather than an eligibility rule. Motivated by the 2026-07-12 production incident (mythos): the emergency path + a reach-gated from-scratch pick manufactured an **inverted resolution profile** (oldest history at L1, the most recent days at L3) which the reach gate then made permanently unrepairable. See **section 13**, which supersedes 12.2 / 12.4 where they conflict.

- **rev 4.0 (2026-06-22)**: Reconciliation against the post-PR #19 solver evolution (shipped on `main`, `context-manager` >= 0.5.3). Three changes reshaped the picker and are documented in the new **section 12**, which is the current source of truth where it conflicts with sections 3.5/3.7/3.9/5: (a) a `best-fit` sequence-DP strategy was added and the earlier **half-life / value-minus-lambda-KVcost solver was removed** (`ea198a1`) -- flat-profile is the baseline, not a lambda solve; (b) a **`kv-stable`** controller (`kv-control.ts`) landed as the production default -- a receding-horizon policy under a constraint hierarchy that **replaces cache-as-a-cost-term with cache-as-a-structural-constraint** (the reach cap); (c) kv-stable is **bidirectional** (it un-folds to use budget headroom), so the "V1 ships only monotonic strategies" claim in section 3.9 no longer holds. A production limitation surfaced (opus4): the `foldDepthCap` saliency geometry is a hard per-chunk ceiling that mis-scales to the token wall -- see section 12.4.

- **rev 3.0 (2026-05-15)**: Reconciliation pass against the implementation that landed in PR #19. The architectural shape from rev 2.3 stood; this revision corrects the spots where the implementation diverged from or extended the doc — per-chunk state lives in dedicated state slots rather than on `MessageEntry` records, `mergedInto` is retained as a read-compat alias for `parentId` rather than removed, `FoldingState` is methods-not-fields, the picker returns `produced` ops for the strategy to route (not the picker itself), and the scope grew ~3× over the rev-2 estimate. Lock API simplified to strategy methods only.
- **rev 2.3 (2026-05-13)**: Replaced the three-step hard-fail escalation ladder (tail-shrink → head-truncate → throw) with throw-only. The strategy raises `OverBudgetError` when the picker is exhausted and the result still exceeds the hard budget; the host decides how to recover. See §3.10.
- **rev 2.2 (2026-05-13)**: Revised bodyGroup rendering. Rev 2 proposed one composite message with inline `[Section summary]` markers for folded portions; rev 2.2 switches to standard Q+A recall pairs interleaved with raw runs. Matches the existing agent experience for summaries. See §3.6.
- **rev 2.1 (2026-05-12)**: Settled outstanding decisions. Slack default = 10%. Speculative production = bottom-up background pre-producer, default-on. `lockedByAgent` programmatic API set-only in V1, no agent tool. Migration deferred to follow-up PR; V1 validates via re-ingest on fresh chronicles.
- **rev 2 (2026-05-12)**: Major revision after design discussion. Switched from fixed L0–L3 levels to unbounded L_n. Replaced `RenderState` slot with on-chunk state. Replaced stored regions with derived runs over per-chunk state. Added `bodyGroupId` mechanism for sub-message chunking, used for documents *and* oversize chat messages. Added pluggable `FoldingStrategy` interface with `FlatProfileStrategy` as default. Corrected the cache analysis.
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
  // ... existing fields (id, participant, content, timestamps, etc.) ...

  /** The chunk's current display resolution. 0 = render raw; k > 0 = render
   *  the L_k ancestor's recall pair (collapsing this chunk and its
   *  L_k-sharing siblings into one rendered item). Default 0. */
  currentResolution?: number;

  /** True if the picker is forbidden from changing currentResolution for
   *  this chunk. Set by `lockChunk()` (programmatic API) or, in V2, by the
   *  agent's `unfold` tool. Default false. */
  lockedByAgent?: boolean;

  /** If this MessageEntry is a shard of a larger logical message, the
   *  stable group id shared with its sibling shards. See §3.6. Default
   *  undefined. */
  bodyGroupId?: string;

  /** The shard's position within its bodyGroup, starting at 0. Only
   *  meaningful when bodyGroupId is set. Used to reassemble shards into
   *  byte-faithful order at render time. */
  shardIndex?: number;
}
```

All adaptive-resolution fields are optional so chronicles produced by the
pre-adaptive code path remain readable with no migration. The
`AutobiographicalStrategy` persists `currentResolution` and `lockedByAgent`
via dedicated state slots (`autobio:resolutions`, `autobio:locks`), keyed
by `MessageId`, rather than mutating the message records themselves.
Branching is therefore inherited for free from Chronicle's
copy-on-write state slots.

### 3.4 The summary tree

`SummaryEntry` gains a `parentId` field and reframes the existing
`mergedInto` field as **archive metadata only**:

- `parentId?: SummaryId` — the L_{k+1} summary this one is a source for, if produced. Multiple L_k summaries share a parent L_{k+1}. Set when the merge result is archived.
- `mergedInto?: SummaryId` — deprecated alias for `parentId`, retained for read compatibility with chronicles produced by the old threshold-driven path. New writes only set `parentId`; reads consult either via the `getSummaryParentId(s)` helper.
- `level: number` — the summary's level (1 for L1, 2 for L2, …).

Neither pointer is consulted by the render path under
`adaptiveResolution: true`; display decisions live in the
`currentResolution` slot indexed by `MessageId`. The dual-field setup
exists so a chronicle written by the pre-adaptive code path continues to
load and read correctly, with the picker treating it as a from-scratch
fresh chronicle for resolution purposes (see §6.1).

### 3.5 Pluggable folding solver

The picker is a thin validator/applier. Policy is delegated to a `FoldingSolver`,
which returns the COMPLETE target frontier in one call:

```typescript
interface ProduceRequest {
  level: number;        // summary level to produce (e.g., 2 for L2)
  range: ChunkRange;    // chunks the produced summary should cover
}

interface FoldingBudget {
  totalBudget: number;   // hard maximum
  targetBudget: number;  // soft target = totalBudget * (1 − slack)
  slack: number;
}

interface FoldingSolution {
  /** Target resolution per chunk (0 = raw, k = L_k). Must be REALIZABLE:
   *  every targeted level's ancestor summary exists. The picker verifies
   *  this and treats a violation as a loud solver bug. */
  frontier: ReadonlyMap<ChunkId, number>;
  /** Summaries the solver wanted but that don't exist yet. */
  produced: ProduceRequest[];
}

interface FoldingSolver {
  readonly name: string;
  solve(inputs: PickerInputs, budget: FoldingBudget): FoldingSolution;
}
```

> **History — the op walk (removed 2026-07-26).** Through 2026-07 this was an
> op protocol: `selectNextFold(state, budget)` returned one group-atomic
> `raise`/`lower`/`produce` op per call, and the picker looped, applying ops
> until convergence under an iteration bound. Group-atomic ops cannot express
> a frontier that cuts through a summary group — which V2 leveled pins
> (`ProtectedRange.level`) produce by design — so the walk oscillated on such
> targets (the 2026-07-25 Mythos outage; the `raise:L4-936` wedge), and its
> "nearest realizable" degradation silently diverged from the solve while
> plan-vs-actual metrics, anchored on the walked state, reported zero drift.
> The walk was removed deliberately and durably: solvers own the frontier;
> the picker owns validation, application, and accounting. Greedy policies
> iterate INSIDE their solve (`src/adaptive/greedy-fold.ts`) — the iteration
> is an implementation detail, never a protocol.

`produced` is returned to the caller (the strategy) rather than acted on
inside the picker — see §3.8 and §5.

Solvers shipped:

- **`KvStableStrategy`** (`foldingStrategy: 'kv-stable'`, the fleet default in practice). Closed-form bidirectional solve via `planControlledFrontier` — see §13.
- **`FlatProfileStrategy`** (default when no `foldingStrategy` is configured). Aims for roughly-equal counts of *visible items* at each non-trivial level. Greedy, monotonic. See §3.7.
- **`OldestFirstStrategy`**. The behavior originally proposed in this doc's rev 1. Greedy, monotonic. Kept for comparison.

### 3.6 Sub-message chunking via `bodyGroupId`

Any message whose token count exceeds `chunkThreshold` (default 8192 tokens) is split into shards at ingestion. Each shard is its own `MessageEntry` with:

- A stable `bodyGroupId` shared with its sibling shards.
- A `shardIndex` (0-based position within the group) for byte-faithful ordering at render time.
- The same `participant` as the original message.

The chunker (`src/adaptive/chunker.ts`) additionally computes a per-shard
`sourceHash` and `{ startByte, endByte }` range, but those live in the
chunker's `Shard` output, not on the persisted `MessageEntry`. The hash is
used at production time to make L1 archival idempotent on identical
content; the byte range is consumed at the same time and not needed
afterward since re-ingesting the original body deterministically reproduces
the same shard boundaries.

**Chunker strategy** (V1, simple): structural-first (markdown headings, code-fence boundaries, blank-line paragraph breaks), token-bucket fallback (default `chunkSize` = 4096 tokens, no overlap), last-resort hard split at the largest UTF-8-safe position when no structural seam exists. Deterministic: re-ingesting identical content produces identical shards with identical `sourceHash`es. Byte-faithful: concatenating shards in order reproduces the original message body byte-for-byte.

**Rendering** (revised — see §3.6.1 for the implemented model):
- **Unfolded run** of consecutive same-`bodyGroupId` shards at L0 → one composite API message whose body is the byte-faithful concatenation of those shards. The role is the group's role. KV cache preserved across the run.
- **Folded run** (consecutive shards under the same L_k ancestor) → emitted as a standard Q+A recall pair (one Context Manager question + one summaryParticipant answer carrying the summary text). The same format used for chat summaries elsewhere — consistent agent experience.

A bodyGroup with mixed resolutions therefore renders as multiple alternating entries: raw composite User message → recall pair → raw composite User message → recall pair → … The KV cache breaks at the fold boundaries (where the byte sequence changes anyway), but raw runs between folds stay cache-stable.

This was a deliberate departure from rev 2 of this doc, which proposed one composite message with inline `[Section summary (...)]` markers for folded portions. The Q+A format won out because:
1. The agent's existing experience of "remembered" content is the Q+A format — using the same format inside docs keeps semantics consistent.
2. The cache cost is the same: folding already invalidates cache at the fold boundary.
3. Inline markers were ad-hoc and made the rendered body harder to inspect / parse.

### 3.6.1 BodyGroup rendering algorithm

Within a single bodyGroup, walk shards in source order accumulating "runs":
- `raw` run = consecutive shards at L0; flushed as one User message with concatenated text.
- `summary` run = consecutive shards under the same L_k ancestor; flushed as a Q+A pair (deduped: same ancestor never emits twice).

A run breaks (and the previous run flushes) when:
- the resolution transitions L0 ↔ Lk
- the L_k ancestor changes

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

> *(rev 5.1)* The kv-stable solve generalized this from locked chunks to **all**
> hard-protected leaves (raw zone, pins, locked): a protected leaf inside a
> foldable group is excluded from the fold rather than vetoing it — boundary-cut
> tolerance, §13.6. Group atomicity means "every participating leaf".

**Producing missing summaries.** If `raiseGroup(groupRoot)` requires
L_{k+1} and no L_{k+1} exists yet, the strategy emits a `produce` op
instead of a `raise`. The picker collects produce ops in
`PickerResult.produced` and stops (one produce op per `run()` call). The
caller — `AutobiographicalStrategy.selectAdaptive` — routes each op via
`handleProducedOps`:

- `level === 1`: locate the chunks whose messages fall in `op.range` and
  ensure they are queued for L1 compression (`compressionQueue.push`).
- `level >= 2`: gather unmerged L_{level-1} summaries whose source ranges
  fall within `op.range` (deduped against entries already in
  `mergeQueue`) and enqueue a single L_{level} merge over them.

The actual LLM work runs asynchronously on the next `tick()` (or the
speculative drain kicked off from `onNewMessage`). The compile that
emitted the produce op returns whatever state was achievable; the next
compile sees the now-existing L_{k+1} and folds further. See §3.10 for
how this composes with the hard-fail check.

### 3.9 Cache stickiness, honestly

The rev-1 doc claimed monotonic raises preserve cache. That's true but oversold. Concretely:

- A given chunk's rendered content only ever moves up the level chain (raw → L1 → L2 → …), never reverses. So a chunk's *contribution* to the prefix is monotone-in-resolution.
- But the chunk's *position* in the prefix has different content over time. When the picker raises chunk C from L1 to L2, the byte sequence at C's position changes — cache miss propagates forward from there.
- The cache benefit comes from *between raises*. In steady state, the picker is a no-op (total ≤ budget × (1 − slack)) — full cache hit. The picker's job is to minimize how often raises happen at any given position.

Two design implications:

1. **Slack is essential, not nice-to-have.** Without slack, total bounces above and below budget each turn → picker fires every turn → cache rebuilt every turn. With slack: picker fires only when total exceeds budget, raises until total ≤ budget × (1 − slack), then is silent for many turns.

2. **Strategies should be stingy.** The default `FlatProfileStrategy` raises one group at a time and exits as soon as the budget is met, rather than aggressively folding to maximize headroom.

> **Superseded (rev 4.0):** the shipped `kv-stable` controller is already non-monotonic -- it un-folds toward raw to spend budget headroom (section 12.2). Cache continuity no longer rests on monotonicity but on the per-turn **reach cap**. The text below describes `flat-profile` only.

V2's agent-driven `unfold` violates monotonicity intentionally — the agent decided detail was worth a cache miss. The architecture permits non-monotonic strategies; V1 does not ship one.

### 3.10 Hard-fail behavior

When the picker exhausts itself (no more groups it can raise, no more L_{k+1}s it can request) and the result still exceeds the **hard** budget (not just the soft target), the strategy throws `OverBudgetError`.

No silent degradation. No automatic tail-shrink or head-truncate. The host is in a better position than the strategy to decide what to do — raise the budget, switch to a larger-context model, drop the head/tail windows for this call, surface a "context too large" error to the user. The strategy's job is to fit when it can and report cleanly when it can't.

Earlier revisions of this section proposed a three-step escalation ladder (shrink tail → truncate head → throw). That was rejected in favor of the throw-only behavior because:
- Tail-shrink and head-truncate are heuristic guesses about which content matters. The host has more context.
- Silent content loss obscures the underlying problem.
- The chronicle's existing `enforceBudget` config flag already establishes "surface the overage" as the project-level philosophy.

This case should be rare in practice with unbounded L_n: the picker can almost always fold further. Real triggers are:
- A `recentWindowTokens` larger than the hard budget (configuration error).
- A single non-foldable chunk (head, pinned, or locked) bigger than the budget.
- Hard budget set lower than the minimum-renderable head+tail size.

`OverBudgetError` carries diagnostic info: `{ budget, actual, diagnostics: { headTokens, tailTokens, middleTokens, middleChunkCount, deepestLevel } }`.

> *(rev 5.1 qualifications)* Two shipped behaviors refine "throw-only":
> **(a)** the enforced wall is the *grace-inflated* budget —
> `maxTokens × (1 + overBudgetGraceRatio)`, default ×1.02 — so a marginal
> overshoot from projection repairs (§13.6) doesn't refuse a turn (§13.2);
> **(b)** the recent-window emitter *can* evict tail messages under extreme
> pressure, but any such eviction that would silently lose content instead
> **refuses the turn** (`UncoveredDropError`) — pressure never ships silent
> loss. The philosophy stands: surface the overage, let the host decide.

### 3.11 Recent-window slide

The tail (recent window) is defined by token count from the latest chunk backward: `tail = the most recent K tokens worth of chunks`. As new chunks arrive, the tail's left edge slides forward, exposing previously-tail chunks to the picker.

Algorithm: chunks transitioning out of the tail default to `currentResolution: 0`. They become eligible for raising on the next compile if pressure requires it. No special handling beyond the picker's normal eligibility check.

Edge cases:
- **A single chunk larger than K tokens**: the tail expands to include the whole chunk, even past K. The picker can't fold the most recent chunk ever — only previous ones. Combined with `bodyGroupId` chunking at ingestion, this is bounded by `chunkSize`, not message size.
- **Chunks at the tail boundary mid-bodyGroup**: the tail is defined over chunks, not over logical messages. A bodyGroup may straddle the boundary — its newer shards are tail-protected, older shards are picker-eligible. Render concatenates them back into one API message regardless.

## 4. Operations

### 4.1 `summarize_chunk` — archive write, eager

`tick()` continues to walk the compression queue and produce L1 summaries
from raw chunks via the LLM. Idempotent by `sourceHash` (same input →
same shard boundaries → same archive entries). **No display change.**
This is the spec's archive write.

L_k summaries for `k > 1` come from two complementary paths in V1:

- **Speculative bottom-up pre-producer** (`config.speculativeProduction`,
  default-on under `adaptiveResolution`): when a new L_k lands, if N
  siblings now share a (would-be) L_{k+1} parent, the pre-producer
  enqueues the L_{k+1} merge immediately. Walks all levels recursively so
  the chain climbs as far as the source counts justify. Bounded by
  `maxSpeculativeL1s` to keep cost-sensitive deployments honest.
- **Reactive on `produce` op** (§3.8): if the picker requests an L_n the
  pre-producer hasn't reached yet (either because the deployment opted
  out, or because the speculation cap held it back), `handleProducedOps`
  enqueues the merge so the next `tick()` makes it.

Both paths feed the same `mergeQueue`. Idempotency on `sourceHash` means
the worst case for a duplicate enqueue is a no-op merge, not a divergent
archive.

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

The picker runs once per `compile()` under the `selectAdaptive` path.
Given:

- `totalBudget` = `TokenBudget.maxTokens - reserveForResponse - headTokens`
- `slack` = `compressionSlackRatio` (default 0.1)
- `solver` = configured `FoldingSolver` instance
- Chunk store, summary tree, head/tail sets

```
[picker.run]
1. { frontier, produced } = solver.solve(inputs, budget)
2. APPLY: per live chunk, final[id] = frontier[id] ?? 0 (clamped ≥ 0).
   Frontier entries for ids with no live chunk (store-surgery residue) are
   dropped and counted (deadFrontierIds) — never persisted.
3. ACCOUNT + VALIDATE: rendered-token total via the renderer's unit model
   (accountFrontier). A chunk targeting a level whose ancestor summary does
   not exist is a SOLVER BUG: accounted as raw, counted (unrealizable), and
   reported loudly ([picker-unrealizable]) — never silently skipped.
4. Return { finalResolutions, produced, finalTokens,
            budgetMet, exhausted, moves, deadFrontierIds, unrealizable }.

[selectAdaptive — strategy side, after picker.run]
5. Commit finalResolutions to strategy state; persist if changed.
6. If produced.length > 0: handleProducedOps to route into compression
   queue / merge queue (§3.8).
7. If finalTokens > rejectionBudget — the hard budget × (1 +
   overBudgetGraceRatio), default ×1.02 — and this is not a dry-run
   preview: throw OverBudgetError. (Rev 5.1: the throw no longer
   consults `exhausted`, which is solver-owned telemetry — see §13.2.)
8. Walk middle messages and emit context entries, grouping bodyGroup
   shards via the rendering algorithm in §3.6.1.
```

`moves` is the number of chunks whose resolution changed vs the carried
state (it replaced the op walk's `iterations` in `PlanVsActual` and the
preview surfaces when the walk was retired — see §3.5 history note).

Token counting: each chunk's `rawTokens` is computed at picker-input
construction time (delegated to `MessageStoreView.estimateTokens`); each
summary's `tokens` comes from its production record, with a `+20` overhead
for the recall-pair label. Render-time total = sum of (raw chunks at L0)
+ (one recall pair per distinct L_k ancestor among non-L0 chunks) +
pinned chunks + head + tail.

## 6. Migration

### 6.1 V1 strategy: re-ingest, don't migrate

Migration of existing chronicles is **deferred to a follow-up PR**. The target deployment (Lena's chronicle) will be validated by re-ingesting its starting state into a fresh chronicle on a new instance, exercising the picker from scratch. This sidesteps the migration's hardest case (over-folded chronicles whose original raw chunks are still in the archive but whose `mergedInto` chains point at lossy summaries) and lets us validate the picker against a real workload before committing to a migration algorithm.

What V1 ships for compatibility:

1. **Field rename `mergedInto` → `parentId`.** Purely a schema change; `parentId` is archive metadata, not consulted by render.
2. **Legacy chronicle reads.** When `adaptiveResolution: true` and a chronicle has chunks without `currentResolution`, default to 0. The picker treats the chronicle as if from-scratch: existing L_n summaries in the archive are reusable (idempotent on `sourceHash`), so the picker doesn't need to re-summarize. First compile after enabling the flag is effectively a re-fold from L0; one-time KV miss propagates from the head.
3. **No automatic conversion of `mergedInto` chains to `currentResolution`.** Old pointers stay readable but unused by the render path.

This means existing chronicles upgrading to the new strategy take a one-time KV miss on first compile, then converge to whatever the picker chooses for ongoing pressure. For chronicles where this is unacceptable (e.g., production deployments where the agent's working memory matters), don't enable the flag — keep them on the threshold-driven path until a proper migration ships.

### 6.2 What a future migration PR needs to handle

The deferred migration work splits into two paths, both keyed on the operator's intent for a given chronicle:

- **Preserve current display** — synthesize `currentResolution` from the topmost-null ancestor in each `mergedInto` chain. No re-render. Most conservative; appropriate when the existing folded shape is what the agent has been remembering.
- **Re-resolve to current budget** — set all chunks to L0, run the configured strategy. Recovers from over-folding (Lena's case) at the cost of changing the prefix the agent sees on its next compile.

Postponing this lets the picker prove itself on workloads where the choice is easy (fresh chronicles, re-ingested chronicles) before tackling chronicles where it's loaded.

### 6.3 Rollout phases

**Phase 1 — Ship behind feature flag.**
- Add `bodyGroupId`, chunker, on-chunk state, picker, strategies, lazy production, background pre-producer, hard-fail fallback.
- Feature flag `config.adaptiveResolution: true` activates the new path.
- Existing chronicles continue rendering via the threshold-driven code until the flag is enabled.
- `checkMergeThreshold` keeps running on chunks without `bodyGroupId` until Phase 2.

**Phase 2 — Switch default; deprecate threshold path.**
- Default `adaptiveResolution: true`.
- `checkMergeThreshold` becomes a no-op (emits deprecation warning).
- Ship the migration PR (§6.2) so existing chronicles can convert.

**Phase 3 — Delete threshold path.**
- Remove `checkMergeThreshold`, related tests.

## 7. Settled decisions

These were debated during the rev-2 revision and are now locked unless implementation surprises force revisit:

1. **Slack default = 10%.** `compressionSlackRatio: 0.1`. Configurable. Conservative enough to leave headroom for small turn-over-turn fluctuations. Re-tune from real workload data after a few weeks of running.

2. **Speculative production: background pre-producer, default-on.** When a new L_k summary lands, if N siblings exist that would share an L_{k+1} parent, the pre-producer enqueues the L_{k+1} summary immediately. Bottom-up, bounded, idempotent on `sourceHash`. Avoids first-fold latency at the cost of LLM tokens that may not be used. Disable via `config.speculativeProduction: false` for cost-sensitive deployments.

3. **`lockedByAgent` programmatic API in V1: set-only.**
   `AutobiographicalStrategy` exposes `lockChunk(id)` / `unlockChunk(id)`
   methods that persist via the `autobio:locks` state slot. The picker
   honors `PickerChunk.lockedByAgent`. No agent-facing tool until V2, but
   the lock is settable by module code so content-aware strategies can
   experiment now. (An earlier draft proposed a separate `lock-api.ts`
   surface with an `InMemoryLockStore`; that was removed in favor of the
   strategy methods as the single canonical surface.)

4. **Migration deferred (§6).** V1 ships compatibility for *reading* legacy chronicles without active migration. Re-ingest is the validation path.

## 8. Open questions

1. **Token counting fidelity.** Picker decisions hinge on token counts. Per-chunk and per-summary cached counts (from tokenizer at production time) vs estimate (4 chars ≈ 1 token) vs real-tokenize-on-every-compile. Cached counts are accurate and cheap as long as we always use the same tokenizer; recommend that, but confirm tokenizer choice before implementation (Anthropic's tokenizer for accuracy, tiktoken for speed/portability, or a hybrid).

2. **Recall pair format consistency across levels.** Under adaptive resolution, the same chunk might be rendered as an L_k recall on one turn and L_{k+1} on a later turn. Each summary is faithful to its own as-of moment, so this is *monotonic memory fading* by construction (more detail → less detail, never reverse) — promote to design property in §3.9 if reviewers agree.

3. **Pins interaction.** Spec says pins are display locks, not write locks. The picker must skip pinned chunks. If the only way to fit budget is folding a pinned chunk, the spec implies accept being over budget rather than violate a pin → fallback in §3.10 kicks in. Confirm.

4. **Branching semantics for on-chunk state.** New chronicle branches inherit chunk state at the fork point via the existing branch-scoped slot model. An agent unfold on branch A does not leak into branch B. Believed to come for free from existing chronicle copy-on-write, but verify with an explicit test.

5. **Telemetry.** `getRenderStats()` needs extension. Suggested: per-level chunk counts, picker iterations and fold ops this compile, lazy production queue depth, background pre-producer queue depth, total raises since chronicle start. The `RenderStats` interface (PR #16) needs updating.

## 9. Implementation scope

> *(rev 5.1)* This table is a PR #19 artifact, kept for the historical record.
> The integration surface has kept growing since — `autobiographical.ts` alone
> is now ~9,100 lines.

Implemented breakdown vs original estimate (PR #19; `git diff main..feat/adaptive-resolution --stat`):

| Component | Estimated | Actual |
|---|---:|---:|
| `src/adaptive/chunker.ts` (structural + token-bucket, ingestion-time) | ~80 | ~320 |
| `src/adaptive/folding-strategy.ts` (interface + types) | — | ~130 |
| `src/adaptive/picker.ts` (orchestrator + OverBudgetError + state) | ~80 | ~440 |
| `src/adaptive/strategies/flat-profile.ts` + `oldest-first.ts` | ~200 | ~140 |
| `src/adaptive/render.ts` (bodyGroup concat) | ~30 | ~115 |
| `src/types/message.ts`, `src/types/strategy.ts` (state fields) | ~70 | ~160 |
| `src/strategies/autobiographical.ts` wiring (selectAdaptive, ingestion, persistence, handleProducedOps, deep-level merges) | ~250 | ~1620 |
| `src/message-store.ts` (sharded-ingestion path, bodyGroup support) | ~20 | ~155 |
| `src/context-manager.ts` (compile path glue) | — | ~30 |
| Tests (`test/adaptive/**`) | ~400 | ~3400 |

The implementation overshot the design's ~1100 LOC estimate by roughly 3×.
Most of the overrun lives in `autobiographical.ts` (selectAdaptive plus
the ingestion/persistence/merge plumbing that the design treated as a
trivial wire-up), the test suite (~8× the estimate, covering shard
immutability, persistence, branching, doc-plus-chat interleaving, deep
levels, and a long-chronicle stress run), and prompt-engineering work
that emerged during implementation (reading-mode prompts for sharded
bodies, KV-preserving merge prompts — see PR #19). The design's
architectural shape stayed intact; the cost was in the integration
surface, not in the model.

Feature flag (`config.adaptiveResolution`) controls rollout. Migration
code remains deferred to a follow-up PR (§6.2).

## 10. Related work

- [`hermes-autobio/docs/hierarchical-autobiographical-memory.md`](../../hermes-autobio/docs/hierarchical-autobiographical-memory.md) — the canonical spec this design implements.
- PR #14 — branch-scoped persistence model; on-chunk state is branched naturally via the same mechanism.
- PR #15 — autobio spec gaps (positioned recall, pins, search). Established the type-guard pattern this design uses.
- PR #16 — fixed silent-message-drop on `compile()` in hierarchical mode.
- PR #17 — fixed `MessageStore.get` returning slot index as sequence; chained branching now works.

## 11. Status

Implemented in PR #19 (`feat/adaptive-resolution`, anima-research/context-manager). All §7 architectural decisions held through implementation. Resolution of the §8 open questions in the as-shipped system:

1. **Token counting** — picker uses `MessageStoreView.estimateTokens` for raw chunks and stored `SummaryEntry.tokens` for summaries, plus a +20 overhead for recall-pair labels. No bespoke tokenizer integration; the chars-per-token approximation is consistent with the chronicle's existing accounting.
2. **Recall pair format consistency** — promoted to a design property in §3.9 (monotonic memory fading by construction).
3. **Pins interaction** — pins always render raw; picker's `foldableMiddle()` excludes pinned chunks. If a pin pushes total over the hard budget, `OverBudgetError` fires (§3.10).
4. **Branching semantics** — chunk state lives in branch-scoped Chronicle state slots (`autobio:resolutions`, `autobio:locks`); branching inherits the slots via Chronicle's copy-on-write. Verified by `test/adaptive/branching.test.ts`.
5. **Telemetry** — `getStats()` exposes per-level summary counts and compression count; the picker returns `finalResolutions`, `produced`, `finalTokens`, `budgetMet`, `exhausted`, `moves`, `deadFrontierIds`, `unrealizable` for observability at the call site *(rev 5.1: `iterations`/`applied` died with the op walk — `moves` replaced them; see §5)*. A formal `RenderStats` extension is still pending.

**Note (rev 4.0):** the as-shipped solver has since evolved well past this PR #19 snapshot -- `best-fit` and `kv-stable` strategies, cache-as-reach-cap, bidirectional folding. See **section 12** for the current controller and its open calibration question.

Out of scope for V1, still pending for follow-up:

- Migration of existing chronicles with `mergedInto` chains (§6.2). The deployment validation path remains re-ingestion on a fresh chronicle.
- Phase 2/3 rollout (§6.3): switching default to `adaptiveResolution: true` and deleting the threshold path.
- V2 agent-driven unfold/refold tools (§4.3) and `AgentDirectedStrategy`.


## 12. Post-PR #19: the kv-stable controller — **HISTORICAL (superseded by §13)**

> **Historical (rev 5.1).** §12.2–§12.4 describe the two-path controller
> (polite fold-within-reach + emergency) that ran between rev 4.0 and rev 5.0
> and **no longer exists** — `foldWithinReach` / `shedToTarget` have no
> occurrences in `src/`. They are kept as the record of *why* rev 5.0 exists.
> Only two things in this section remain live: the strategy lineup (§12.1,
> corrected below) and the `foldDepthCap` formula (§12.3), which survives as
> the *soft shape prior* inside the §13 solve — no longer a hard ceiling.

Rev 3.0 documented the PR #19 picker with `FlatProfileStrategy` as the only shipped strategy. Three changes since (all on `main`) reshaped the solver. **Where this section conflicts with sections 3.5 / 3.7 / 3.9 / 5, this section is current** — and §13 supersedes this section in turn.

### 12.1 Strategy lineup (`config.foldingStrategy`)

- **`flat-profile`** -- the library default. Level-equalizing: when over the soft target, raise the most-populous level, oldest-first, and exit as soon as the budget is met. Monotonic (raises only). No per-chunk depth ceiling, so it descends to whatever level fits the budget.
- **`oldest-first`** -- chronological variant of the same shedder.
- **`kv-stable`** -- the production controller the deployed agents run (connectome-host recipes select it). Described in §13.

The config union is exactly `'flat-profile' | 'oldest-first' | 'kv-stable'`
(`types/strategy.ts`). *(rev 5.1: an earlier revision of this list advertised a
`best-fit` sequence-DP strategy as shipped; that solver was built on a branch
and deleted in `ea198a1` — it never joined the union. See
`docs/best-fit-frontier-resolution.md` for what survived of it.)*

### 12.2 kv-stable: a constraint hierarchy, not a cost solve

`KvStableStrategy` (`src/adaptive/kv-control.ts: planControlledFrontier`) is a receding-horizon controller. It **deliberately replaces** the value-minus-lambda-KVcost solve -- that approach made what the model implies a moving target, *creating* the churn the lambda term then fought (see `docs/kv-stable-context-control.md`, "Why this exists"). `CacheStore` / `PRICE` survive only in the *sim* (`kv-cache-sim.ts`) to **measure** churn, never to drive the plan.

The plan is a layered constraint hierarchy:

- **W -- hard token wall** (`windowTokens`): the only hard constraint. Folding may go as deep as needed to stay under W.
- **P -- per-turn KV-perturbation reach cap** (`reachTokens`, soft): bounds how far back from the live end the frontier may move per turn. **This is the entire cache-stability mechanism** -- structural, not a cost. Lifted (emergency) only when folding within reach cannot meet W.
- **Saliency field -- per-chunk max fold depth** (soft, shaping): the *relevance* gradient (recent fine, old coarse). See section 12.3.

Bidirectional, within a hysteresis band `[expandAt, foldAt]`:
- tokens **> foldAt** -> fold/deepen, oldest-first;
- tokens **< expandAt** -> **un-fold** toward raw, youngest-first, spending budget headroom on recent fidelity.

So kv-stable emits `lower` ops -- **breaking the rev-3.0 / section 3.9 "monotonic only" property.** Continuity is preserved by the reach cap bounding movement in *both* directions, not by monotonicity.

### 12.3 The saliency field (`foldDepthCap`)

Per-chunk depth ceiling handed to the shedder:

```
foldDepthCap = 0                                      if pinned or in the flat (raw) zone
             = min(MAX_FOLD_LEVEL,                    otherwise
                   floor(log_k(age / flatZoneChunks)) + 1)      k = mergeThreshold (default 6)
```

Intent: a scale-free raw->L1->L2->L3 banding matching the base-k summary-tree geometry -- recent content stays fine, old fades logarithmically. It produces the *relevance* gradient; it is **not** the cache mechanism (that is the reach cap, section 12.2).

### 12.4 Known limitation: the saliency cap is a hard ceiling, mis-scaled to the wall

Surfaced in production (opus4, ~600-message conversation against opus-4's 200k window):

- The cap is enforced as a **hard** ceiling the shedder may not exceed, and the emergency path lifts only **reach (P)**, never depth. So when "fold everything to its cap" still exceeds W, the picker throws `OverBudgetError` ("deepest fold level=L2") -- even when deeper summaries (L3) already exist and would fit. `flat-profile` (no per-chunk ceiling) descends to L3 on the same store and fits.
- The base `k = mergeThreshold = 6` couples the *fade rate* to the *merge fanout* -- unrelated quantities -- and makes L3 require `age >= k^2 * flatZone ~= 36 flat-zones` of history, more than a window-bound conversation can hold. So kv-stable caps at L2 and floors out around the window size.
- This contradicts the design's own framing: W is the only **hard** constraint; P and the saliency cap are **soft (shaped)**, and "base-k is not imposed -- it emerges and bends." The cap is currently rigid.

**Cache stability already comes from the reach cap**, so the saliency depth ceiling is doing only relevance shaping.

**Update (`feat/best-fit-frontier`, PR #28, `cd4d56a`) -- the feasibility/crash is fixed.** The W emergency now lifts *both* the reach cap **and** the depth cap (`foldWithinReach(Infinity, ignoreCaps=true)` in `shedToTarget`): the saliency cap is soft under W, never a feasibility wall. Only the truly hard-protected set -- flat zone / pins / locked, marked with a `-1` sentinel -- stays raw even in the emergency; the age-extended-raw band (cap 0) becomes foldable under pressure. kv-stable now descends to L3 and fits where it previously threw `OverBudgetError` at L2 (verified on the real Lena store: fits at cap 0.10/0.12, escalates *legitimately* at 0.08 where the 30k recent window alone busts the budget and `flat-profile` can't fit either). W is again the only hard constraint, as the hierarchy claims.

Still open -- a normal-path **fidelity calibration**, no longer a crash: the cap's *steepness* couples the fade rate to `mergeThreshold`, so L3 needs ~`k^2` = 36 flat-zones of history and the gradient floors at L2 under the *soft* target even when L3 would pack more fidelity per token. Option (a) -- make the steepness budget-driven (solve the slope so "fold to shape" meets the soft target by construction; likely also fixes the non-convergence seen when the fixed base was naively lowered) -- remains the principled refinement. Option (b), dropping the ceiling, is now effectively what the *emergency* path does.



## 13. Rev 5.0: the single-path solve (supersedes 12.2 / 12.4 where they conflict)

### 13.1 The incident that forced this (mythos, 2026-07-12)

A day-long image-heavy session pushed compression-merge requests over the API's
32MB byte cap; every L2 merge 413'd for ~7 hours, summary production stalled
while ingest continued, and the fully-folded floor of the middle grew past the
hard budget — `OverBudgetError` on every wake. Recovery involved a summary-tree
repair and a **resolution-state reset**. The first pick after the reset ran with
an empty carried frontier:

1. Everything started raw — far over W.
2. The polite pass folded **only inside the reach band** (the newest ~400k raw
   tokens), crushing the most recent days to L3 while forbidden from touching
   anything older.
3. Still over W → the **emergency** lifted reach and folded the *old* history
   oldest-first, level-by-level, **returning at first fit** — old content
   reached only L1.

Result: an **inverted resolution profile** — June at L1 (dozens of fine recall
slices, many of them low-value duplication-era fossils), the most recent and
most relevant days collapsed into four L3 mega-summaries directly behind the
raw tail. The profile then froze: the dead band meant the expander never ran,
and the reach gate made the L3 groups (whose oldest leaves lie beyond reach)
categorically ineligible for un-folding. A misallocated frontier with no path
back — while ~60k of window paid for fine-grained ancient history.

Two design errors compound here, and both are *structural*, not tuning:

- **Cache-protection expressed as eligibility.** The reach cap is an
  *incremental-turn* concept. Applied to a from-scratch pick (no cache exists)
  or inside the emergency (cache already forfeited by the reach lift itself),
  it only distorts the outcome — there is nothing left to protect.
- **A second solver for the hard case.** The emergency is a different algorithm
  with different semantics that runs precisely when the stakes are highest, and
  it optimizes for a cache it has already destroyed (first-fit, inherited
  pre-pass wreckage).

### 13.2 The model

One solve, every turn. One hard constraint. Cache is a *priced quantity*, never
an eligibility rule.

```
build       ideal = relevanceCut(tree, target, W)   -- pure relevance, no P anywhere
reconcile   hold F_prev | adopt ideal | adopt a suffix of ideal | override
subject to  render(F) ≤ W·(1+grace)   -- the enforced wall (see below)
            perturbation(F, F_prev) ≤ P   -- trust region: soft, default-on,
                                          -- overridable with cause
```

**There is no scalar objective.** Rev 5.0 was drafted as
`minimize relevance_loss + λ·perturbation`; what shipped is deliberately
λ-free — a **lexicographic branch cascade** (§13.4): feasibility first,
perturbation bounded by P second, with relevance quality used only as a
*comparator* to reject certifiably bad plans. Information and perturbation are
never traded through an exchange rate — a made-up λ was a named failure mode
of the pre-rev-5 solver (`kv-stable-context-control.md`, "Why this exists"),
and re-introducing one via the objective notation would repeat it.

- `relevance_loss(F)` — salience-weighted **misallocation**, not absolute
  information loss: `Σ salience(c) · max(0, level_F(c) − shapeCap(c))` over
  foldable chunks — the excess fold depth beyond what the log-age shape prior
  would assign. Zero for any cut that folds nothing past its prior; positive
  exactly where fidelity is spent in the wrong place; recency-aware by
  construction (the cap grows with age), so an inverted profile scores high
  even when a naive Σ level would tie it with the correct gradient. Meaningful
  only for comparing cuts of the same tree — it feeds the quality-gap tests
  and nothing else. The ideal cut is *constructed* (greedy, priority-ordered),
  not obtained by minimizing this function.
- `perturbation(F, F_prev)` — exact, not modeled: rendered tokens from the
  earliest position where `F`'s layout diverges from `F_prev`'s to the end
  (`kvCost` in `render-offsets.ts`) — precisely what the provider will re-read.
- `P` (`reachTokens`, re-priced) — a **trust region on per-turn divergence**,
  not a spatial eligibility gate. It bounds how much perturbation an ordinary
  turn may take; it never determines *which* chunks may move.
- `W` — the physical wall, with two qualifications the original rev 5.0 text
  lacked:
  - the ideal-cut construction is **best-effort**: on a damaged (non-nested)
    tree it can return an over-W frontier with `escalated` set rather than
    throwing — the fold→project fixpoint is round-capped (§13.6);
  - the **enforced** rejection wall lives in the strategy layer, one grace
    band above W: `rejectionBudget = floor(maxTokens · (1 +
    overBudgetGraceRatio))`, default ratio 0.02 → ×1.02
    (`autobiographical.ts`). `OverBudgetError` fires on
    `finalTokens > rejectionBudget` — regardless of the solver's `exhausted`
    flag, which is now solver-owned telemetry (`446c28c`) — correctly
    pointing at summary *production*, not allocation.

**Override rule (what replaces the emergency).** The trust region may be
exceeded, same algorithm, same code path, when either:

1. **Infeasible within P** — no frontier within P of `F_prev` fits under W.
   Mandatory and automatic: feasibility beats continuity, always.
2. **Quality gap** — the best frontier within P is certifiably bad:
   `relevance_loss(best_within_P) − relevance_loss(ideal)` exceeds
   `qualityGapRatio · max(1, relevance_loss(ideal))` (default ratio 0.35).
   The solver takes the ideal and pays the perturbation. This is the
   self-healing property: a stuck misallocated profile *is* a persistent
   quality gap, so it repairs itself instead of fossilizing. Disabled under
   `strictReach` (§13.7).
3. **Bootstrap** — nothing carried: no persisted frontier exists (`previous`
   is literally empty) and the carried frontier is all-raw. Perturbation is
   undefined, P never enters; pure relevance solve. (A *non-empty* all-zeros
   `previous` — a store that has genuinely never folded — does **not**
   bootstrap; it holds or folds normally.)

Every override is loud: the plan reports `override: 'infeasible' | 'quality-gap'
| 'bootstrap'` plus the exact perturbation, and the strategy layer logs a
`[kv-escalation]` line. Silence was half of the incident.

### 13.3 Salience as a coefficient (not a cap)

`foldDepthCap`'s log-age banding survives only as the *shape prior* inside the
ideal cut. The load-bearing relevance signal is per-chunk **salience** — the
weight on that chunk's information loss:

- **Static prior — "is the window the only copy?"** Content whose payload is
  externalized folds cheap: code that lives on disk/git, tool_results
  (re-derivable), logs, URL link-drops, images (the file/CDN retains them).
  Conversation exists nowhere but the chronicle — folding it destroys the only
  copy — so it stays expensive. Computed from composition (fraction of tool
  blocks / code fences / images / bare links). *(rev 5.1, as-shipped: computed
  per compile at picker-input construction, memoized in a `WeakMap` keyed on
  the stored message (`eb7d794`) — there is no persisted salience field.
  The strategy clamps its prior to `[0.2, 1]`; the solver re-clamps to
  `[0, 1]` and defaults missing values to 1.)*
- **Dynamic modulation (v2 — unimplemented)** — a multiplier over the static prior: chunks
  coupled to the *current* activity (same files, same locus, same task; recent
  recall hits) are boosted above their prior; the boost decays when the
  activity closes. "While coding, recent code is hot; once done, it folds
  soon" — implemented as decay plus the λ term (a refold happens when the
  relevance gain covers its perturbation bill), not as a state machine.
- **v2 source upgrade (unimplemented)**: the summarizer already reads every
  chunk at compression time — it can emit a salience annotation and "payload
  externalized to <path>" flags as metadata, riding a call we already pay for.
- The image-strip post-pass (`imageStripDepthTokens` / `maxLiveImages`) is a
  hardcoded special case of this coefficient (images = maximal static
  cheapness, fastest decay) and should eventually dissolve into it — fixing,
  in passing, its known tail-starvation bug (the recent-window boundary is
  computed pre-strip and never refilled after stripping).

Hard protections are unchanged and are the only remaining eligibility rules:
flat zone / head / tail raw, pins (classic, pin-at-level-k, pin-max-level),
locked chunks. Salience never overrides a pin.

*(rev 5.1 amendment — boundary-cut tolerance, `de3d293`.)* A hard protection
protects its **leaf**, no longer its whole group: a protected leaf inside a
foldable group is *excluded from the fold* rather than vetoing it, and renders
raw beside the group's recall (the renderer's "ownership wins" semantics).
Without this, a head/tail boundary cutting two messages into a 742-leaf L3
group made the entire group permanently unfoldable and OverBudget-wedged the
agent with its own L3 sitting unused. Details and the related unanimity
exemptions in §13.6.

### 13.4 The per-turn algorithm

As shipped (`planControlledFrontier`, `kv-control.ts` — regenerated rev 5.1):

```
solve(tree, F_prev, W, P):
  ideal = relevanceCut(tree, target, W)
      -- from scratch, no P anywhere:
      -- phase A: fold in salience-then-age priority order, level-by-level,
      --   under the shape prior, toward the target;
      -- phase B: if still over W, keep folding past the prior (never past
      --   hard protections);
      -- phase C: pack — un-fold youngest-first back toward the target,
      --   accepting an un-fold that overshoots the target when it lands
      --   CLOSER to it and stays under W (§13.6);
      -- project to a valid group-consistent cut and iterate fold→project
      --   to a fixpoint (§13.6). BEST-EFFORT: on a damaged tree this can
      --   return over-W with `escalated` set — it does not throw.

  gapCeiling = qualityGapRatio · max(1, loss(ideal))      -- ∞ under strictReach

  F_prev empty (no persisted frontier) → ideal            (bootstrap)

  carried in [expandAt, foldAt], carried ≤ W,
    loss(carried) − loss(ideal) ≤ gapCeiling → F_prev     (hold, zero cost;
      a LARGE gap falls through — a stuck misallocated profile self-heals)

  Δ = perturbation(ideal, F_prev)                         (exact, kvCost)
  Δ ≤ P → ideal                                           (ordinary turn)

  partial = suffixAdopt(ideal, F_prev, P)
      -- adopt ideal's changes newest-first only: keep F_prev before boundary
      -- B, take ideal after it; binary-search B oldest-ward until P is
      -- spent. Perturbation is prefix-based, so partial adoption is exactly
      -- a suffix cut — no combinatorial search. Each candidate is projected
      -- to a valid cut before costing.
  partial ≤ W, gap(partial, ideal) ≤ gapCeiling,
    and madeProgress → partial
      -- receding-horizon repair: the next turns keep adopting, P at a time.
      -- madeProgress guard: when a shed is REQUIRED (carried > foldAt), a
      -- partial plan must reach the band or at least move (perturbation
      -- > 0). An under-folded profile scores ZERO misallocation loss, so
      -- the quality gap alone cannot reject "do nothing forever"; a P below
      -- the physical floor (the tail any fold must invalidate) lands here
      -- and falls through to an override.

  strictReach and carried ≤ W → F_prev, blocked='reach-floor'
      -- paced transitions never pay a big perturbation for quality (§13.7)

  otherwise → ideal, override recorded             (infeasible / quality-gap)
      -- under strictReach, an adopted ideal still above the goal band
      -- additionally reports blocked='target-floor'

[strategy layer, after picker.run:]
  finalTokens > W·(1 + overBudgetGraceRatio) and not a dry-run preview
      → OverBudgetError (loud)
```

Properties: on a quiet turn `ideal ≈ F_prev` + a tail fold, Δ is naturally
small, and the solve is indistinguishable from the old polite pass — nothing
is legislated. The old behaviors (dead band, reach, emergency) are all regions
of one parameter space instead of three code paths. A from-scratch solve is
age/salience-monotone **by construction** (fold order = priority order), so
the inversion class of bug cannot be produced.

**Cheap-moment scheduling (v2).** The quality-gap threshold makes "repair now
vs amortize" explicit; a future refinement schedules big adoptions onto turns
whose cache is already cold (restart, config change, model swap — visible as
`cache_creation >> cache_read` on the previous call), making restoration free.

### 13.5 What §12 language this retires

- "Emergency", "reach is lifted", `foldWithinReach(Infinity, ignoreCaps)` —
  gone; overrides are the same algorithm with the trust region priced out.
- Reach as "how far back a fold may edit" — reach (`reachTokens`) is now P,
  a perturbation trust region in tokens re-read, direction-free.
- The §12.4 "Option (a) budget-driven steepness" calibration question is
  **narrowed, not absorbed** *(corrected rev 5.1)*. `mergeThreshold` no longer
  bounds *feasibility*: phase B folds past the shape prior whenever W demands,
  and depth is bounded by the deepest *produced* level
  (`maxAvailableLevel(tree)`), not a constant. But phase B is **W-gated** —
  when "fold to shape" cannot reach the soft target yet the result fits under
  W, the solve rests in the [target, W] band at prior-bounded depth, so the
  log-age banding (base `k = mergeThreshold`) still shapes achievable depth
  there. What survives of §12.4 is a fidelity-allocation question in that
  band, no longer a crash or feasibility question.
- The fold/expand watermark pair remains only as the dead-band boundary of
  the trust-region logic (`foldAtTokens` / `expandAtTokens` keep their config
  meaning).

### 13.6 Solving on imperfect trees (2026-07-27 → 2026-08-03)

§13.4's construction assumes a cleanly nested summary tree whose group
boundaries respect protection boundaries. Production stores violate both —
store surgery, calibration drift, and repair history leave trees where the
clean algorithm wedges or lies. Four mechanisms make the solve total over real
stores; all are load-bearing and none appeared in the original rev 5.0 text.

**Boundary-cut tolerance** (`de3d293`). A hard-protected leaf (−1 sentinel:
raw zone / pins / locked) inside a foldable group is *excluded from the fold*
rather than vetoing it, and is exempt from group unanimity in the validity
projection. The renderer already draws protected messages raw beside their
chunk's recall ("ownership wins"), so a boundary cutting through a group must
not make the group permanently unfoldable. Trigger: calibration drift moved
the token-derived head boundary two messages into an L3's first chunk — the
2-leaf overlap vetoed the whole 742-leaf group in every phase, and the agent
OverBudget-wedged with its own L3 unused. Consequence for §3.8: group
atomicity now means "every *participating* leaf", not "every leaf".

**Overlap tolerance** (`b99fcc3`, `204431b`). After surgery a summary "tree"
can be **non-nested**: a group's `leafChunkIds` may include leaves whose own
lineage tops out below the group's level or climbs through a different family.
Folding such a leaf plants an unrenderable mark; the projection then
monotone-lowers the whole group around it — observed: one disagreeing leaf
un-folded a 200-leaf group, 615 leaves cascaded (+24k tokens), and the solve
returned an over-W frontier while a produced L4/L5 layer sat unused (opus4).
Now leaves whose lineage disagrees are skipped by folds and exempted from
unanimity: they render raw beside the covering recall. **This is a degraded
mode, not a feature** — every exempted leaf means messages are semantically
*double-represented* in the window (rendered raw or via their own chain while
a covering recall also renders). The solve proceeding is the mitigation; the
topology is the disease. `[kv-overlap]` warns on **every** affected compile
until the store gets nesting repair.

**Fold→project fixpoint** (`b99fcc3`). The validity projection can only lower
levels; on a non-nested tree its repairs *add* tokens after the phases stopped
at target — and a single projection pass used to be final, returning an over-W
frontier ("W is the only physics", violated by its own solver). The phases now
iterate on the projected frontier — the `TokenLedger` rebuilt each round —
until the render fits under W, a round makes no progress, or the round cap
(two extra rounds) is reached. Hence "best-effort" in §13.2/§13.4.

**Deepest-first projection** (`1074ec6`). Within each projection pass, deeper
disagreeing leaves are lowered toward their shallower group-mates before the
shallow ones are judged. Shallowest-first overshot: a leaf un-folded to its
pin cap (L1) among still-deeper siblings (L2) was pushed past the cap to raw
in pass 1, before the siblings descended to meet it — the group converged at
raw instead of at the cap. Still monotone (only lowers) → terminates.

**Phase C accepts overshoot toward the target.** Merge groups are coarse
quanta (8–15k tokens on production trees); accept-only-if-under-target strands
real headroom un-spent whenever every remaining quantum overshoots (mythos:
134k rendered of a 183.6k hard budget). An un-fold that lands past the target
is accepted when it gets *closer* to it and stays under W. The target stays
the attractor; W stays the only wall.

**The ledger invariant.** All phase arithmetic runs on an incremental
`TokenLedger` — O(group) per move instead of O(n) re-renders (the mythos
0.5s→16s compile leak, `incremental-compile-problem.md` §9.3). Its
correctness contract: `ledger.tokens` equals `renderLayout(...).totalTokens`
for the same frontier — both share the missing-ancestor→raw fallback and the
unit identity (siblings share one recall unit). Phase C therefore records
*exact prior levels* for honest reverts: with boundary-cut tolerance a group
may hold members below the fold level, and a hardcoded from/to drifts the
ledger off the render — after which every later accept decision runs on
corrupt arithmetic (observed: phase C walked an L3 fold all the way back to
carried while its ledger believed it sat on target). Anyone editing the
phases is editing against this invariant.

**Memoization contracts** (`1c4c436`, `7f2d5e1`). Three memos are
correctness-relevant, not just performance: group *eligibility* is memoized
per (node, level, phase) — valid because the verdict is a pure function of
static caps shared by every member; projection *unanimity* per (node, level)
per pass — valid because a pass only lowers, which cannot make a group
unanimous at that level; and phase C's `attempted` set short-circuits
re-tries but is **cleared on every accepted un-fold**, so the accept sequence
is exactly the naive one. Breaking any of these validity arguments either
reintroduces the O(groupSize²) compile leak or silently changes the solve.

### 13.7 Prepared windows and paced transitions

The solver's parameter surface supports walking an agent toward a *different*
window size without a KV catastrophe — preparing a smaller frontier ahead of
a model swap or budget cut while compiles continue against the current window:

- **Goal watermarks** — `KvStableOptions.goalTotalTokens` /
  `goalTargetTokens` re-aim `foldAtTokens` / `targetTokens` at the future
  window while `windowTokens` stays the current hard budget. The solve treats
  the goal as its attractor while remaining feasible against today's wall.
- **`strictReach`** — turns P from a soft trust region into a hard transition
  *pace*: the quality-gap override is disabled (`gapCeiling = ∞`), and when no
  realizable change fits within P the solver **holds** the carried frontier
  and reports `blocked: 'reach-floor'` instead of paying a large
  perturbation. An adopted ideal that still exceeds the goal band reports
  `blocked: 'target-floor'` (the goal is not yet reachable).
- **Strategy surface** — `blocked` maps to
  `transitionBlocked: 'transition-pace-floor' | 'prepared-window-floor'`
  (`autobiographical.ts`), and the whole loop is driven through the
  hot-reloadable settings API: `HotContextSettings` /
  `getHotContextSettings()` / `updateHotContextSettings()`
  (`types/strategy.ts`), with `preparedWindowTokens` (the future usable
  window), `transitionPaceTokens` (the per-compile re-read allowance), and a
  `prepared: true` status once the selected frontier fits the prepared
  window. A dry-run preview path reports infeasibility of an aggressive goal
  via `_lastPreview.fits` — without taking the outage that learning it live
  would cost.
