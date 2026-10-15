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

## 0.14.1 — 2026-10-15

### Fixed

- A calibration record without a pricing stamp is no longer counted as epoch 1 and re-stamped on load (#179). 0.11.0 to 0.13.0 wrote such records, and so did every release before 0.11.0, whose pricing `CALIBRATION_EPOCH_REPRICES` doesn't model; nothing in the record tells them apart. Five production stores upgraded from pre-0.11 runtimes to 0.14.0 kept the multiplier they had learned under the flat signed-thinking price, four at the 1.8 ceiling and one at 1.45. One refused every compile with `OverBudgetError`, and the others ran folded, the worst to about 45% of the window it could hold. An unstamped multiplier is now **provisional**:
  - It is discarded at load, as before, when the store holds content the epochs since 1 repriced, and now also when it sits at a clamp edge (1.8 or 0.6): a residual pinned there corrected per-class rates that were off by more than the clamp allows, and says nothing about this release's. Otherwise it is kept, with one `console.warn`, and the record is left as it is: the stamp is written by the first sample, not the load.
  - A provisional multiplier above 1 that puts a compile over budget is dropped to 1 and the select runs again, so the first compile resolves instead of wedging, unless it is over budget at 1 as well. The drop is logged, persisted as `calibration.reset`, and shown in render stats. A provisional multiplier at or below 1 is never raised.
  - The first sample the sanity band accepts replaces a provisional multiplier outright (and writes the stamp); the learner's EMA steps only from there. The 1 any discard restarts from is provisional too, so one applied sample sets it rather than about ten, each repricing every message; it is persisted as provisional, so a restart before that sample keeps it a guess.
  - `RenderStats.calibration.provisional` is `true` meanwhile. `CalibrationReset.fromEpoch` is `null` for a record without a stamp (it is now typed `number | null`). A dry select or preview decides and falls back as a real compile would, at the picker's refusal too (which a dry run otherwise only reports as `fits: false`), so a budget preview says what the real compile will do; it writes no record and emits no calibration log.
  - **Operators:** this covers a record that is still unstamped. A store that already opened on 0.14.0 and ran a committing compile had its multiplier re-stamped as epoch 2, which is honoured as learned, as before; such a store keeps the folded window or the wedge and still needs the one-time reset in 0.14.0's notes.

- A dry compile that is the first compile after a message is removed no
  longer leaves later compiles reading message positions from before the
  removal. Those stale positions could make every later compile, dry or
  committing, throw `UncoveredDropError`, as they did with the middle one of
  three messages removed, until something rebuilt the order, such as setting
  the strategy again. The dry run had put the strategy's store order back
  without the listing it was built from. A regression in 0.14.0.

## 0.14.0 — 2026-10-13

### Added

- `blockAsStored(block)` gives a content block as the message store hands it back once stored: what `getMessage`, `getAllMessages` and `getMessageWindow` return for it with blobs resolved, live and after reopening. It needs no store and does no I/O, so a host can hash a body as the store will keep it before writing it, through a canonical serializer: the store's serialization (undefined fields dropped, key order, NaN and Infinity to null, -0 to 0, strings written as UTF-8) is outside it. Inline media comes back as its source alone, its base64 rewritten from the decoded bytes and an image relabeled by its bytes' signature (png, jpeg, gif, webp); a URL image and every other block come back as given. The store's own write and read are built from the same helpers, so the two can't disagree. It throws for a block the store refuses (inline media whose data the store can't read as base64, or without a media type: for an image, none declared and no recognized signature in its bytes) and for a `blob_ref`, which only the store can resolve. It covers one block's round trip: a strategy's ingress chunking can store one delivered message as several, which it doesn't predict. An image's stored form depends on the release's signature set, so a change to that set changes stored forms.
- `BlobManager.hasStorableMedia` and `BlobManager.estimateMediaSize` follow the store's own rule for which blocks become blobs: an image whose source isn't a URL, not only a base64 one.

- `imageStripHysteresisRatio` (opt-in, default off): when a live-image limit binds (`maxLiveImages`, `imageStripDepthTokens`, `maxLiveImageBytes`), trim to ratio × each limit and persist a watermark (a message sequence) below which images stay stripped. The stripped set then changes once per trim instead of once per new image. Each change rewrites the message it touches and invalidates the prompt cache from there on, which on a large window is a full-price rewrite per image. Rendering and budgeting (`postStripEstimates`) both honour the watermark, so they stay consistent; it survives reopen.

### Changed

- `concatBodyGroups` reads its input in store order, where a body's shard indices rise: a shard whose index doesn't rise starts another body. It no longer sorts a run of one group id by `shardIndex`, which is what interleaved two copies of one document. Pass shards in the order the store returns them.
- A host that groups stored messages into bodies by `bodyGroupId` alone should read them through `bodyBounds` or `continuesBody`, so a reposted document is two bodies there too.
- A listener added with `onMessage` must not add a message synchronously: it can run while a sharded add is still storing its remaining shards, and a message added there would split the body.

- Compression requests whose recall ladder is capped by
  `compressionRecallBudgetTokens` now carry one cache marker, at the end of
  the head window, instead of none. Front-eviction shifts the recall pairs on
  every mint, so their seams stay suppressed, but tools, system prompt and
  head window precede the ladder and repeat unchanged, except when image
  shedding replaces a head-window image for one payload and not for another
  (the head marker of uncapped requests has the same exposure). A capped
  request with no head window is unchanged (no marker, no `cacheTtl`). Capped
  requests that gain the marker change their canonical hash.

- **Estimator calibration is applied past a 2% dead band.** The closed-loop
  multiplier (`reportRealInputTokens`) is still an EMA of real/estimated, but
  it is applied to the store, persisted and logged only once the EMA is more
  than 2% from the applied value, so token estimates may lag the EMA by up to
  2%. Every applied change reprices every message and recall pair; a host
  reports once per compile, which moved the multiplier by a fraction of a
  percent each time and made the kv-unified forest, summary tree and
  certificate graph rebuild on every compile (a warm compile on a production
  store: 233 ms instead of 110 ms). A sample inside the band now leaves
  cross-compile reuse intact.

- Large-history compiles do less per-compile work over the whole store: the
  message listing survives receipt and resolution writes (it keyed on the
  store-global sequence), filtered views share one filtered array per
  listing, chunk rebuilds use one id-to-position map (extended in place on
  append) and record which chunk owns each position, pins and the picker
  inputs read those instead of building their own maps, and the L1-by-message
  index is rebuilt only when summaries change. The hysteresis certificate
  prices and scores its carried cut as a levels array instead of 75k id
  tuples and a frontier map; the terminal evaluator takes the forest's chunk
  order instead of re-sorting and factors the per-leaf loss terms out of the
  per-level loop (values are bit-identical). Layouts are unchanged.

- kv-unified reuses what did not change between compiles: the canonical
  forest, the receipt SummaryTree and the certificate's context DAG are
  derived from the previous compile when no summary, recall cost or L1 link
  changed; leaf representation hashes and positions live on the forest leaf;
  the certificate scores through the terminal evaluator with a linear
  compile; message token estimates, salience and the post-strip pass keep
  their caches across appends; receipt submission reuses unchanged leaves.
  Layouts are unchanged; a warm compile on a 75k-message history drops to
  roughly a third of its previous wall time.

- The kv-unified warm compile does less fixed work per turn. The hysteresis
  certificate walks its DAG as flat typed arrays (grown in place when leaves
  are appended), keys fully owned summary contexts by summary id instead of a
  serialized id list, and tests participants by allowed-level bits; the
  terminal evaluator keeps the per-leaf slot facts that depend only on the
  leaf and its receipt entry across compiles and recomputes only the
  age-dependent terms; the certificate and the evaluator share one receipt
  lookup per leaf. The minimum-token floor (every uncertified compile and
  every budget-wall turn of a pinned store) uses the same id keys and bit
  tests. Forest derive compares head/tail zones with one byte per leaf and
  reads unchanged leaves by position; the strategy's compile loops memoize
  L1-to-ancestor walks, read forest leaves by sequence, and check coverage
  by position. All sums run in the original order: layouts, resolutions,
  receipts and emitted entries are unchanged.

- The kv-unified compile keeps its per-compile structures across a
  summary arrival. When a compile adds summaries, re-parents children
  under them or owns more leaves, the forest is extended from the
  previous one: only the leaves whose ownership chain changed and the
  summaries on an old or new chain of such a leaf are rebuilt, every
  other leaf and summary object is shared, and the forest names its
  parent and what changed. The summary tree rebuilds only the nodes of
  new or re-parented summaries. The terminal evaluator translates the
  parent's slots instead of recomputing them, and the certificate DAG
  and the accepted-level cache keep the nodes of leaves and fully
  covered summaries the extension did not touch. A derive compares each
  leaf with its own record of the chunk it was built from, so a chunk
  changed in place (a pin, a lock, a token count) is seen; a kept
  cache-layout translation is reused only where the structure still
  holds the same leaf ids; a tree node built while a source was missing
  is rebuilt when that source arrives. Forests, trees, DAGs, labels,
  layouts, resolutions and receipts are unchanged.

- Avoid a nested action-cache Map for the first level of each immutable action
  array, allocating a fallback Map only when that array is used at more levels.
- Reuse a shared visitor function for internal packed trace references while
  preserving public detached-callable references, traversal order and lazy reads.
  These changes reduce specific lookup/function-allocation work; comparative
  wall-time, total allocation, peak-memory and GC improvements are unproven.

- The kv-unified compile does less fixed work when ownership changes (a
  new summary). The forest full build walks each L1's ownership chain
  once, resolves a chain to its summaries once, keeps leaf lists in
  position order (contiguity is a span check), shares level lists and
  summary hashes per chain, and copies an already ordered chunk list
  instead of sorting it. The summary tree walks each summary's leaves
  once per build and keeps ordered lists unsorted. The certificate DAG
  addresses leaves by forest position and takes a fully covered summary's
  participants from the forest's cached index array. The packed solver
  prices and emits actions through leaf positions its callers already
  hold. The strategy's coverage invariant remembers each emitted
  summary's store positions per store order. Forests, trees, DAGs,
  labels, layouts, resolutions and receipts are unchanged.

- kv-unified latent demand scores every what-if solve in one shared floor
  frame (the lowest cache and continuity floors any pool in the compile
  reached) and compares best-vs-best under adoptEpsilon, instead of
  subtracting selected scores measured against each solve's own floors.
  The expected-cost (p50) solve now runs only for candidates the
  conservative gate emits. Timings and the emitted requests are exposed on
  the strategy for diagnostics.

- kv-unified latent demand: a what-if solve derives its forest from the live
  forest (one parent added over existing summaries) instead of building every
  leaf again, and keeps its own forest and certificate graph in
  `KvUnifiedReuse.whatIf`, keyed by candidate and recall cost, for the next
  compile that scores the same candidate. A compile that ranks latent demand
  drops the holders of candidates it does not score, and a branch reset drops
  all of them; a compile that ranks nothing leaves them in place. Requests, evaluations and the emitted context
  are unchanged; on a 18.6k-message store the what-if time of a compile fell
  by about a third (1422 ms to 909 ms over seven compiles).

### Fixed

- The persisted estimator-calibration multiplier is stamped with the token-pricing epoch it was learned under (`AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH`), so when pricing changes, a multiplier learned under the old pricing is discarded on load (start from 1.0) instead of applied. The multiplier is a residual over the per-class rates, so it means nothing once they change: a store that had pinned 1.8 under the flat-600 signed-thinking price reopened on 0.11.0 estimating ~1.8× its real size. When that plan exceeded the hard budget, the first compile threw `OverBudgetError` before any inference, so no sample could ever decay the multiplier: a permanent startup crash loop. A record written before the stamp doesn't say which pricing it was learned under, so a store still in that loop takes the one-time reset under **Operators** below.
- The discard is persisted (`{multiplier: 1, pricing: <current epoch>}`) for records from an older epoch, so rolling back to a binary that ignores the stamp can't reload the stale multiplier. A record from a newer epoch is left on disk and not used, without a warning, until this binary's first applied sample writes its own record over it, reset included.
- A discard is no longer only one log line. It is a `console.warn` naming the size of the change and how to re-stamp the old value. It is also recorded as `reset: {discardedMultiplier, fromEpoch, at}` in the persisted calibration state, and exposed with the multiplier and epoch as `RenderStats.calibration` (so hosts that surface render stats, such as connectome-host's `/healthz` `contextComposition`, show it). The record survives restarts, later learning and a later epoch's re-stamp. A later discard replaces it, and an operator re-stamp without it clears it.
- An older-epoch multiplier is discarded only if the store holds content that some epoch since then repriced (`AutobiographicalStrategy.CALIBRATION_EPOCH_REPRICES`). Epoch 1 repriced signed `thinking` blocks that carry no stamped `tokenEstimate` (a stamped block is priced by its stamp in every epoch). Epoch 2 repriced membrane's XML-history carriers (`tool_attempt`, `tool_notice`), which had estimated as 0. Otherwise the residual still means what it did, and it is kept and re-stamped with one `console.warn`. An epoch without an entry counts as repricing everything.
- A preview or a dry compile decides the multiplier as a real compile would and prices by it, but writes and logs nothing, and leaves the strategy and the store's multiplier as it found them. The first real compile after it loads again and persists what it decides. A store view that can set its token calibration but not read it (`getTokenCalibration`) can't be put back, so a dry select through one throws before changing it. ContextManager's own views supply both methods, and a view with neither is unaffected.
- **Operators:** a record without a stamp counts as epoch 1, since 0.11.0 to 0.13.0 learned under that pricing and wrote no stamp. Upgrading keeps such a multiplier and re-stamps it, unless the store holds XML-history carriers, in which case it restarts from 1.0. Two kinds of store can then refuse every compile with `OverBudgetError` before inference. One kept a multiplier last learned before its host moved to 0.11.0, which has no stamp either: reset it once, with the host stopped, with `setStateJson('<ns>/autobio:calibration', { multiplier: 1, at: Date.now(), pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH })`. The other held carriers and a multiplier below 1, which the restart from 1.0 raised: check the old value against provider-billed input tokens, then re-stamp it the same way with that value. If a store holding unstamped signed thinking kept a multiplier last learned before 0.11.0 and still fits, it prices every message by that stale multiplier until the learner corrects it. From the 1.8 ceiling, that takes about ten applied steps, and each one reprices every message. Until then the window stays folded smaller than it needs to be. The same one-time reset avoids this. When bumping `CALIBRATION_PRICING_EPOCH`, add an entry naming what the new epoch reprices.

- Bound aggregate leaf memberships and identifier storage during KV-unified
  certificate context construction before allocating keys and child lists;
  excessive graphs decline conservatively to the existing solver.

- kv-unified no longer persists its presentation receipt as one `[id, leaf]` pair per presented chunk on every accepted call. The leaf table is now stored run-length encoded (consecutive chunks sharing a representative form one run, raw chunks with the same clock form one run with their `raw:<id>` hashes derived on load, ids gap-coded inside a run), and the head receipt's change list the same way, so a write costs bytes proportional to the number of summaries presented rather than the number of messages in the session. On a six-week production store the per-call write went from 1.68 MB to 48 KB; the old shape had put 2.8 GB of a 3.0 GB `records.log` into that one state (#148). Stores written by earlier releases still load; a persisted receipt of any other shape, or one whose runs are malformed, now fails loading loudly instead of silently restoring an empty continuity baseline. The in-memory `KvUnifiedReceiptChain` API is unchanged. Settled submission ids are now bounded in memory (256, as they already were on disk).
- `scripts/records-log-bytes-by-state.py` streams a Chronicle `records.log` and prints bytes per state and operation (and per day), without loading the store; it is how #148 was found.

- kv-unified: a receipt chain written back by a pre-format-2 build after a
  rollback loads again. Until that build advances the presentation (only
  keepalives or an unchanged layout were accepted), it persists the format-2
  head it loaded in the legacy shape, without `changes`, and the next format-2
  build threw in `serializeHead` on its first acceptance (#164). The head is
  decoded from its `changeRuns`; a legacy head with neither shape is refused
  as malformed.

- A compression that waited on another strategy instance's in-flight
  compression of the same family reloaded the strategy's persisted state to
  take up that result, and under `foldingStrategy: 'kv-unified'` that reload
  replaced the receipt chain and dropped the presentation in flight. A
  submission begun before the wait then failed its acceptance ("kv-unified
  callback … does not match the in-flight submission") (#166). The waiter now
  keeps its own kv-unified receipt chain, whose pending submission is never
  persisted, and its draft and pending layout, with the layout's marker indices
  and immutable prefix hash, which live only in memory. It no longer reads the
  store's receipt state there, so between initializations a kv-unified
  instance's chain is its own. Everything else reloads as before.

- Chronicle state registration failures now propagate instead of being treated as an existing state: from autobiographical strategy initialization, from `ContextManager.open` (the message, context-log and auxiliary-view slots), from the windowed-passthrough strategy, and from mint-preimage storage, whose failure `persistMintRequestPreimage` reports as before. Only `State already exists: <id>` for the same slot counts as already registered, and that slot is kept as it is, whatever strategy or cadence it was registered with. Reinitialization still preserves already-registered slots, and a failed open releases a store it opened.
- ContextManager refuses mutations and strategy execution while initialization is pending or failed; inspect the selected branch and recover explicitly with a successful `switchBranch` or `setStrategy`. Failed transitions remain nontransactional. The strategy-state queries refuse too, where they used to answer: `isReady`, `getPendingWork`, `getHotContextSettings`, `previewContext`, `listPins`, `searchSummaries`, `getSummary`, `getSummariesInRange`, `getMaxSummaryLevel` and `getRenderStats`. The refusal reads `ContextManager.<operation> requires successful strategy initialization`, replacing the strategy's `requires reinitialization for the current branch generation`.
- A `switchBranch()` or `fork()` whose strategy initialization a newer one supersedes rejects with the new `InitializationSupersededError`, whose `branch` names the branch the call selected or, for a fork, created.

- `MessageStore.append` no longer re-certifies an id index or materialized cache that was already stale before the append because a sibling `MessageStore` on the same store had removed or edited an earlier message. Stale state is left stale and rebuilt on the next lookup. Previously, after a sibling removed an earlier message and this instance appended, a lookup by id returned the wrong message under the right id while the stored slot was correct (reported by Astra, 2026-10-07; reachable with published chronicle 0.4.0).
- A `MessageStore`'s own edit or removal now stamps its materialized cache as current (when the cache was current before the write), so an edit or removal followed by an append no longer costs a whole-slot reload on the next read.

- Two ingestions of one text are two bodies everywhere a sharded message is
  read as a whole. The chunker names a shard group by a hash of its text, so a
  document posted twice (or a write cut short and then retried) stores two
  runs of shards under one `bodyGroupId`. Readers that took the group id for
  the body ran the copies together:
  - the autobiographical render, and `concatBodyGroups`, sorted both runs by
    shard index and interleaved them;
  - merging adjacent raw shards in the head and recent windows did the same;
  - `removeBodyGroup` removed both copies, and `removeRange` refused a range
    ending between them;
  - `getMessageWindow` with `alignToBodyGroups` widened a window across them;
  - reading mode counted the document twice, and a chunk spanning both
    copies read as part of one document;
  - the compression-hold boundary stepped back over the earlier copy;
  - the newest-turn guard accepted an earlier copy for the newest one.

  In store order a message now continues the body before it only when it
  carries the same group id at a higher shard index (each ingestion writes
  its shards 0..n-1, so the next one starts again at 0). The rule is read
  pairwise, so it also holds where a render region begins inside a body: the
  cut body's remainder is never joined to the next copy. `continuesBody`,
  `bodyStart`, `bodyEnd`, `bodyBounds` and `bodyBoundsIn` give that reading
  to hosts. A stored conversation holding a reposted sharded document renders
  differently after the upgrade, so its first request misses the prompt cache.
- The newest-turn guard no longer refuses a render that kept the newest body
  in the middle region (which happens when its newest shard alone outgrows the
  recent window): it now also reads a composite's `sourceMessageIds`.

- A dry compile (`ContextManager.compile(…, { dryRun: true })`, with `AutobiographicalStrategy`) now leaves what a select leaves behind as the last committing compile left it, on every path out, throws included. Before, only `previewContext` put part of it back. A plain dry compile changed what the next real compile sent: its stable-prefix cache marker was measured against the dry layout, and under kv-unified the next submission carried marker indices from it. A dry select (a preview's too) also recorded chunks and queued their compression: over another writer's messages, or at a preview's overridden chunk size, whose boundaries then stayed for good. And it left readers in between the dry run's `getHotContextSettings()` (`currentFrontierTokens`, `prepared`, `blocked`) and `getRenderStats()`, and replaced calibration's estimate, or armed a second sample, between a real compile and its usage reports.
- Chunk records an earlier dry select wrote stay as they are: they are valid chunks, sized by that preview, and compress like any other.
- The one thing a dry compile can still leave is the release of a compression hold whose deadline has passed: a hold ends at its deadline whoever looks, and the manager releases it at any compile or hold query.
- A dry select now refuses what a real compile refuses, with one exception: a plan over the budget isn't refused at the plan check. The stages after it still refuse what doesn't fit, so a dry compile of an adaptive plan whose middle doesn't fit throws when it emits the middle, and `previewContext` reports that plan as `fits: false`. A kv-unified plan that selects a level with no summary now throws on a dry run too. *(Corrected after release: this entry first said a dry select returns an over-budget plan.)*

- The context manager's edits now reach the wire on formatters that replay a block's raw form. membrane's XML (prefill) formatter replays a tool block's `rawXml`, and its OpenAI Responses formatter emits a block's `rawItem`, instead of rendering the block's fields. An edit made by spreading a block kept that raw form, so the original shipped in place of the edit. Affected: the `toolUseInputMaxTokens` cap, the `toolResultMaxLastN` marker, `maxMessageTokens` truncation in both the autobiographical and windowed strategies, the compression prompt's image cap inside tool results and its tool-prose hoist, the reasoning stripped from compression input, the recall envelope's tags, and pairing repair (orphan drop, result relocation, `stripUnpairedToolBlocks`). A dropped or moved block also kept shipping inside a sibling's shared raw form (one `<function_calls>` holds several invokes; one Responses message item gives each text part its block), and on the Responses path a cut part could ship twice, cut and uncut. Each edit now releases the raw forms it made untrue, from the edited block and from every block sharing them; on the Responses path, a reasoning item and the item it leads to are released together, so neither is replayed with an id whose partner is gone. Both then go out id-less, as membrane sends any history without raw items: reasoning with encrypted content as an id-less reasoning item, and reasoning without it, which has no id-less form, not at all. A raw form no edit touched still replays verbatim, and an opaque Responses item (membrane's zero-width carrier, such as an encrypted compaction item or a hosted tool's call) is never released or rewritten, since its raw item is its whole content. In a pairing it is an item like any other, so where the reasoning before it is stripped and it stays, as in the live-strip recall answer, it still ships whole with its id, as before. Compression requests strip the reasoning too, but drop opaque carriers along with other empty text blocks, as they always did, so there it doesn't ship at all. The one edit with nothing to release is the line appended to the compression instruction, which is context-manager's own block. One drop releases less: an empty text part dropped from a compression request while another part of its Responses item survives leaves that item as it was, since it still ships whole through the surviving part; an item none of whose parts survive releases the reasoning that led to it. Reported by Astra, 2026-10-08; reachable with published membrane 0.5.86 when a host uses the XML prefill formatter or a Responses provider and sets one of those caps, or wraps recalls on a Responses provider, and on every compression request on a Responses provider whose history holds reasoning or whose request hoists tool prose. On those formatters a capped request now differs from before: the caps' markers ship, and the `toolResultMaxLastN` marker names how many newer results follow, which changes as results arrive, so each new one re-sends what follows the oldest marked result, as on native-formatter hosts already.
- Compiling no longer writes the `toolUseInputMaxTokens` input marker or the `toolResultMaxLastN` marker into the message store's cached view. Where no `maxMessageTokens` cut had already copied a message's content, the edit went into the content array that `getAll()` hands every caller, so until the next write `getAllMessages()` returned the marker in place of the original, and the next compile started from the marker: with a cap below the marker's own size, each compile truncated the previous marker again, and its `_originalTokens` and `_keys` came to describe the marker rather than the input (found in review, 2026-10-08; reachable whenever a host sets either cap).

- With the `flat-profile` or `oldest-first` folding strategy, a classic pin (one without a `level` or `maxLevel`) added over a message those solvers had already folded now renders the message raw. It kept rendering its summary, though the plan priced it raw. While the pin stands it outranks an agent's lock on the message, as the plan's pricing already assumed. The fold the pin replaces is dropped from the stored resolutions, as `kv-stable` already does: after the pin is removed, the message stays raw until a fold takes it again, unless it was locked, when it returns to the level it was locked at. On the first compile after upgrading, each message pinned over a fold renders raw, so the prompt is written to the cache again from the first of them, once.

- With `imageStripHysteresisRatio` set, a `previewContext` call, or the select a dry compile runs, advances the image watermark for its own render only. It no longer writes the watermark or leaves it advanced, so a preview with stricter image limits can't change which images the next live compile strips, and a preview that changes only the ratio prices its images for that ratio. `getRenderStats`, when no compile has rendered on the current branch (before the first compile, or after a reopen or a branch switch), also reconstructs its window without changing or persisting the watermark or keeping the estimates priced under that temporary trim. Releasing a compression hold whose deadline has passed, which a dry compile does before its select, still commits as before, including the watermark advance made by the release's rebuild; the following dry select leaves that state unchanged.

- `scripts/inspect-store` is mutation-free strategy inspection. It used to open a live `AutobiographicalStrategy` under a `ContextManager` with a config that was not the resident's, which registers state for whatever namespace it is given and can chunk the frontier with the wrong window and chunk size. It also always ran a 50K-token sample compile, which is where a household's `OverBudgetError` came from. Now it opens the store with `JsStore.open` (it never creates one), reads the strategy's persisted state as stored, and, without `--sample-compile`, constructs no strategy or `ContextManager`, so it creates no strategy, chunk or namespace state. A store whose lock is held, such as a running resident's, is refused with exit 1 and a message saying so.
  - `--namespace <ns>` names the strategy namespace (`--ns` still works). A namespace without strategy state is reported, with the namespaces that have it, and nothing is inspected (exit 2).
  - The invocation is checked whole before anything is opened or written. An unknown or misspelled option, a stray argument, an option given twice (`--ns` counts as `--namespace`) or an option without its value is refused (exit 1), rather than read around or replaced by a default. That includes the old `--all`, `--summaries` and `--messages`, an empty `--namespace`, and a `--sample-compile` value that isn't a plain positive whole number.
  - `--message-slot isolated|shared` says where the resident keeps its messages (the `ContextManager`'s `isolate`), which the store doesn't record. Without it, the sole registered slot is read. When both `{namespace}/messages` and `messages` are registered, nothing is inspected until one is chosen (exit 2), because an isolated slot outlives a switch to shared messages. A chosen slot that isn't registered is refused (exit 2), never created. The overview, `messages.md` and the sample name the slot they read.
  - The sample compile runs only with an explicit `--sample-compile <tokens>`, and compiles the same message slot. That run is a live, audit-only sample using the tool's default strategy configuration, not the resident's own, and it writes: it registers the namespace's states, re-applies the message slot's registration (its snapshot cadence; the shared slot is store-global), may migrate legacy chunk records, and may rewrite the summaries state as the strategy repairs it on load. So use it on a copy; the written sample says so too. It is now `sample-compile-<tokens>.md`, named by the budget given, where it was always `sample-compile-50k.md`. With no message slot it is refused, since there is no history to compile.
  - It is mutation-free logically, not byte-for-byte. Chronicle has no read-only open: opening still takes the store's lock, so run it on a stopped resident's store or a copy. Reading messages re-registers the message slot's history indexes idempotently, rebuilding any that are missing or stale, and every close rewrites `state.bin`, `state-indexes.bin` and `branches.bin`, whose bytes can change even when what they hold doesn't. When the store wasn't closed cleanly, opening may also correct stale branch heads and truncate a torn tail from `records.log`; the tool reports such a truncation on stderr, even when the open then fails, since nothing records it afterwards. So copy a store before inspecting it if you need its files as they were, for forensics.
  - Summaries and resolutions are shown as stored, before the strategy's load-time repair. A summaries state that isn't a list, or a resolutions state that isn't a map of numbers, is reported on stderr and in the overview rather than read as empty.

- Allow the opt-in kv-unified hysteresis certificate to prove carried layouts
  with nested protected internal holes, using today's canonical cut recurrence.
  Preserve existing constraints, receipt scoring, adoption policy and fallback.

- kv-unified review fixes: a certified base solve no longer overstates a
  merge's benefit (the certificate lets the carried layout score up to
  `adoptEpsilon` above the best cut, so a merge that passes the gate
  against it is decided against the unrestricted base solve); the Pareto
  engines and the certificate price a forest not built from the current
  inputs with the current chunks; a kept cache-layout translation with an
  unknown unit is rebuilt once the forest holds that unit; a forest derive
  declines a placed summary deleted from the same input map; a solve's
  per-solve caches are scoped to that solve even when the caller reuses
  the options object; the whole-message token memo checks every block's
  identity; a branch switch drops the cross-compile holders.

- kv-unified latent demand: a certified what-if solve no longer decides the
  order of the merge requests. A certified what-if that passes the
  `adoptEpsilon` gate is solved again without the certificate when another
  passing candidate's gain lies within its certificate slack, and the
  expected-cost solve runs without the certificate for requests whose
  conservative gains tie. Before, the weaker of two merges could be
  summarized first. The requests are ordered by proven gains: when the
  uncertified solve prunes and scores worse than the certified pool, the
  certified pool is kept. That is the order of an exact solve, which a pruned
  uncertified solve does not always give.
- The expected-cost solve of an already decided candidate no longer runs
  again when a certified what-if is decided late (one extra solve per
  emitted candidate per pass). The emitted context is unchanged by both.

- `MessageStore` and `ContextLog` (whose estimate strategies receive as
  `ContextLogView.estimateTokens`) price membrane's XML-history carriers
  instead of counting them as 0. A `tool_attempt` (a tool-call block that
  dispatched nothing, replayed verbatim) is estimated from its `rawXml`. A
  `tool_notice` (the harness's notice about refused or warned invokes) is
  estimated from the `<tool_call_notice>` elements it replays as. Both are
  read structurally, so this works with any membrane version. Other
  unrecognized blocks still count as 0. The shared rule is
  `MessageStore.xmlHistoryCarrierTokens`, for strategies that price content
  themselves. The blocks come from membrane#101, persisted by
  agent-framework.

## 0.13.0 — 2026-10-03

### Added

- Optional compression-hold timeouts: `holdCompression(ids, { timeoutMs })`
  and `addMessage(..., { holdCompression: { timeoutMs } })`. A timed hold is
  released automatically once expired — checked lazily on `tick()`,
  `compile()` and hold queries (no timers) — through the same path as
  `releaseCompression` (strategy notified), with a warning naming the ids
  and how long they were held. Re-holding an id replaces its hold (timeout
  restarts; re-holding without `timeoutMs` makes it indefinite).
  `getCompressionHoldDetails()` reports `heldAt`/`expiresAt` per hold; the
  manager clock is injectable via `ContextManager.open({ now })`. Holds
  without a timeout behave exactly as before.
  Deadlines are per message id; one call or one sharded `addMessage` reads
  the clock once, so its ids share a deadline, and expiry releases only the
  ids past their own deadline (never the rest of a shard group). Expiry is
  also checked on `addMessage`.

### Fixed

- Key MessageStore message-ID indexes and materialized caches by native Chronicle branch ID, so deleting and recreating a branch under the same name cannot return stale content or edit/remove the wrong message.

- Budget refusals report the configured window, response reserve, and input budget alongside the effective hard limit. Diagnostics label adaptive picker-chunk counts, hierarchical selection-item/raw-message counts, and planned versus attempted depth explicitly; preflight refusals report that no fold plan was computed and count pre-head history after a reset. Available summary inventory remains separate, and KV escalation logs include planned and available depths.

- Recognize Bedrock-prefixed Fable/Mythos summarizer model IDs when deferring compression until the host supplies tool definitions.

- Apply tool pairing repair before result pruning in both adaptive and hierarchical rendering. Generated missing-result placeholders no longer consume last-N retention slots, while genuine output with identical text still counts. Displaced or duplicate results are counted only after repair.

- Coverage-repair warnings report the skipped summary counts and possible budget or interrupted-merge causes without diagnosing healthy stores as corrupt. Empty entries left by tool-result relocation now say the result moved during context repair.

## 0.12.0 — 2026-10-03

### Added

- Compression holds: `ContextManager.holdCompression(ids)` /
  `releaseCompression(ids)` / `getCompressionHolds()`, and
  `addMessage(..., { holdCompression: true })` to place the hold before the
  strategy sees the message. Autobiographical (and Knowledge) treat the
  earliest held message as the start of the protected recent window: it,
  everything after it, and the tool_use it answers stay raw and out of every
  chunk; a chunk that closed before a late hold waits for release. Intended
  for provisional content later replaced with `editMessage` (agent-framework's
  tool-result guard stages a placeholder tool_result) — edits never reach
  summaries, so edit while held, then release. Holds are in-memory only; a
  reopened manager starts with none. With no holds, chunking, compression
  requests and compiled context are unchanged.
  Held content is also kept out of compression, merge and transition-summary
  prompts' head context (a reset head window can sit past the hold), and
  hold checks cost nothing when no hold exists (one timeline scan per pass
  otherwise).
  Releasing a hold notifies the strategy (`onCompressionHoldsReleased`), which
  re-queues deferred chunks so `tick()` resumes without a new message. An L1
  or merge whose span gains a hold mid-request is discarded and retried after
  release; queued merges reaching a hold wait. A held tool_result keeps a
  sharded (adaptive-resolution) tool_use message's whole body group with it.
  Range removals drop holds on removed messages.
  Removing a held message also resumes deferred compression, and a release
  during branch (re)initialization never throws into the caller — the
  strategy is notified once initialization completes.

- `compressionToolProseFallback: { intoTool, fromTools, field?, result?, minChars? }`
  — an opt-in L1 compression fallback rung. Long prose kept in an argument of a
  private-reasoning tool (`skip_reply.reason`, `think.content`) makes replayed
  history read as a reasoning trace, and the memory-write is refused
  `reasoning_extraction` regardless of content. On a canonical **refusal** the
  request is retried once with each such argument moved into a call to
  `intoTool` — a note-taking tool the agent really has (agent-framework's
  `journal`) — placed as its own round just before the original call, with a
  short stub left behind; if the source-only final rung is enabled and also
  refuses, it gets the same rewrite once. Nothing the agent wrote is dropped.
  The rung is skipped unless `intoTool` is among the declared tools and at least
  one argument qualifies. Enabling or changing it is a new request regime, so
  already-quarantined chunks earn a fresh bounded attempt without a manual
  clear. Off by default: with the option unset, canonical requests, request
  hashes and quarantine identity are byte-identical.

- Store topology fails loudly. Every load audits the summary archive for
  crossed ownership (a summary whose leaves are not contiguous among
  chunk-owned messages in store order — issue #122's cross-era merges,
  restore/branch interleavings, hand surgery). `topologyPolicy: 'reject'`
  (default) throws `StoreTopologyError` from `initialize`, so
  `ContextManager.open` refuses the store until it is repaired;
  `'report'` logs the violations at error level and reports them through
  `getCompressionDebt().topologyViolations` (state `critical`). A kv-unified
  config that opts into gap handling (`preserveGapBearingSummaries` or
  `treeifyNonContiguousSummaries`) defaults to `'report'`.
  `scripts/audit-topology.ts` runs the same audit read-only on a store path.
- Merge adjacency is judged in store order, not chunk-record order, so a chunk
  minted late over an early message can no longer join the frontier's merge run
  (the second half of #122). Demand-path merges (`enqueueMergeForRange`, #95)
  are split into strictly adjacent runs like the threshold path. `executeMerge`
  refuses any group that is not one level below the target and strictly adjacent
  in store order: no model call, the entry moves into the merge quarantine with
  outcome `topology_violation`, and `getCompressionDebt().topologyRefusals` /
  state `critical` say so. A crossed node is never minted.

- `repair-topology --rebuild-since <messageId|ISO date>`: in rebuild mode,
  only crossed summaries whose span starts at or after that message are
  dissolved for the ladder to re-fold; older ones get the compact treatment,
  so regions that were repaired by hand are never re-summarized. The plan
  reports where the cutoff landed and how the crossed set split.
- compact mode adopts hole owners downward: a root of any lower level that
  owns a hole is taken into the descendant one level above it whose span is
  adjacent, so a small hole deep inside a tall tower closes where it is and
  nothing above unravels.

- `planTopologyRepair` (`src/repair/topology.ts`) and `scripts/repair-topology.ts`:
  a general, regeneration-free repair for crossed summary ownership (the
  stores `topologyPolicy: 'reject'` refuses). A crossed summary keeps the run
  of children carrying the most leaves and detaches the rest as roots; a
  crossed L1 keeps its largest run and releases the stray messages from its
  chunk record; single-source parents dissolve; touched ancestors get their
  `sourceRange` recomputed; kv-stable resolutions are clamped to the leaf's
  remaining chain. `--release-head` removes detached opening L1s (and
  uncompressed prefix records) so the head window takes those messages back
  verbatim. Dry-run by default; `--apply` writes and re-opens the store under
  `'reject'` to verify. `scripts/audit-topology.ts` now prints summary,
  chunk and chunk→L1 link counts and warns when it has nothing to audit.
- `auditOnly` strategy config: `initialize` loads and audits the store but
  never chunks the uncovered frontier, enqueues merges, or rewrites the
  persisted merge queue. The audit and repair scripts open stores this way;
  a plain open under a config that is not the resident's own mints chunk
  records with the wrong head window and chunk size, which the resident then
  compresses at its next boot. `--release-head=all` (with
  `--release-head-limit <n>`) also releases pre-existing prefix L1s.
- `--mode rebuild`: dissolves each crossed summary and its ancestors (plus,
  for a child run left without an unparented same-level neighbour, the
  tower over the smaller adjacent neighbour) back to roots, so the merge
  ladder re-folds the affected regions bottom-up with real summaries —
  faithful and compact, at the price of summarizer calls. Reports
  `dissolvedForRebuild` (≈ merges to regenerate) and `exposedL1Leaves`;
  re-fold offline with `drain-autobiographical` before restarting.

### Changed

- `kvUnified.hysteresisCertificate` is now a strategy config key (passed
  through by the adapter like the other `kvUnified` fields), so the certified
  hysteresis exit can be switched on from a recipe. The certificate also no
  longer declines when an appended leaf has a fold option (a freshly minted
  L1 over new messages): it enumerates every cut that keeps each accepted
  leaf at its accepted level (capped at 256, else it declines as before),
  scores them exactly, and certifies the best one — which is what the full
  solve's hysteresis rule selects. On a copy of Sill's store, 24 of 25
  unchanged turns certified at ~0.4 s instead of a 4–6 s solve.

- Compile overhead on large stores: `mergeAdjacentBodyGroupRaw` no longer
  fetches every raw entry's message from chronicle (with blob resolution) to
  read two shard fields; it indexes the caller's message listing once (~0.7 s
  saved per compile on a 75k-message store).

### Fixed

- `scripts/drain-autobiographical.ts` now passes the four split-fallback keys
  (`compressionSplitFallback`, `compressionSplitPlaceholder`,
  `compressionSplitMaxCallsPerChunk`, `compressionSplitMaxCallsPer10Min`)
  through from the recipe, so an offline drain honours them; previously they
  were silently dropped and a drain ran without the split-stitch rung even when
  the resident had it on. (`compressionToolProseFallback` is passed through too.)

- The head window no longer ratchets down under calibration drift (#122).
  When a calibration rise moved the token-derived head boundary onto
  messages no chunk owned, those messages were minted into small, late L1s
  that merged with the open frontier: summaries mixing the chronicle's
  opening with much later material, rendered at the opening's position. The
  boundary now extends over that uncovered run to the first owned message
  (bounded at 2× `headWindowTokens`). Stores with no coverage after the
  boundary, and heads that grew over owned messages, keep the stock boundary.

- Post-strip token estimates now subtract a stripped image at the store's
  calibrated price. `MessageStore.estimateTokens` prices every block as
  `round(raw × calibration)`, but `postStripEstimates` took the uncalibrated
  `tokenEstimate ?? 1600` (minus the placeholder) back off. With the
  calibration multiplier below ~0.995, an image-only message whose image had
  aged out of the live window came out NEGATIVE (e.g. 0.925: 1480 − 1591 =
  −111), and kv-unified's canonical-forest check rejected every compile with
  `chunk <id> has invalid raw cost -…` — a hard-down that could not heal,
  since calibration only updates after a successful call. Above 1.0 the same
  mismatch over-counted each stripped image (≈ 450 tokens at 1.28). Each
  per-message estimate is also clamped at zero.

- kv-unified latent demand keeps no ranking state between compiles: it is ranked on every compile, so appended messages, policy changes and branch switches always reach it. It has no candidates, and costs nothing, while fewer than `mergeThreshold` same-level summaries line up.

- kv-unified leaf engine: token buckets no longer let it drop a label with a different token count while reporting a zero error bound (#109). Reached only through an explicit `engine: 'leaf'`; the default route is unchanged. Such callers may need a larger `labelCeiling`, since the leaf engine now keeps more labels.
- kv-unified latent demand: `approximate` is now true only when the solve reports a nonzero score error bound, instead of whenever a bucket size is configured.

- kv-unified cache model: the raw tail now renders as one unit per message
  (keyed by chunk id, the same identity a message keeps after it slides into
  the middle) instead of one opaque `tail` unit. With the opaque unit every
  append shifted the tail's position — the messages leaving the tail became
  new raw units in front of it — so the end-of-tail marker fell outside the
  identical prefix and an unchanged layout was priced as the whole tail
  (~100k tokens on Sill) recomputed on every turn, although the wire bytes
  were identical. Selection was unaffected (the false churn was the same for
  every candidate and cancelled in the floor normalization), but reported
  churn and `cacheFloor` were wrong and the opt-in hysteresis certificate's
  zero-churn precondition could never hold in steady state. Applies to
  `renderLayout`, both solver storages and the terminal evaluator; cache
  markers on tail messages now map to that message's unit. Tail tokens not
  attributed to any tail chunk (synthetic inputs only) keep the opaque block,
  so token totals are unchanged. The first solve after upgrading sees the
  persisted opaque-tail layout diverge once; subsequent receipts are per-message.

- The L1 mint builder's compression-image byte cap now applies to the
  post-split wire messages instead of the pre-split `llmMessages` list.
  `splitMixedToolMessages`/collapse rebuild message objects, so the cap was
  logging its strips against copies the request never shipped — a mixed tool
  round carrying an image kept its image on the wire under ANY
  `maxCompressionImageBytes` (field repro 2026-09-21: "replaced 1 older
  image ... kept 0MB" logged while the same mint failed with the provider's
  image-input 400). The merge builder has always capped its post-split list;
  the L1 builder now matches it.

## 0.11.0 — 2026-09-25

### Changed

- Use reusable packed label records and bucket tables in the kv-unified DAG
  solver. Preserve the object implementation as a diagnostic reference.
- Select terminal candidates with conservative rounding bounds and exact cache
  accounting, refining all possible winners, ties, and normalization-floor
  witnesses. Keep the selected result exact and defer remaining diagnostic
  candidate-list evaluations until requested, without changing policy or grids.

### Fixed

- kv-unified: a relevant provider cache no longer multiplies the Pareto label
  set. A label's state key kept the unit at which it diverged from the cached
  layout after the divergence, though nothing prices that value, so labels
  that diverged at different units never competed and every compile from the
  second turn on grew with the forest. The key now carries it only while the
  cache is intact; the warm-prefix length a diverged label keeps, which the
  cache term prices, stays in the key. Bucketed representative ties now break
  on the frontier signature, as terminal selection does, instead of on that
  unit. Exact-mode selected scores are unchanged (an equal-score tie can
  resolve to a different cut, as it already could with no cache); bucketed
  selections stay within the reported bound. On a production store
  (≈270 chunks, 260k tokens) turns 2–4 select bit-identical scores in
  1.7–1.9 s and under 2 GB, down from 20–21 s and 12–23 GB (7.2M → 0.57M
  labels per compile). (#105)

- Reduce kv-unified solve time and memory for existing presentations and forced
  transitions by using linear bucket selection, equivalent broken-cache-prefix
  states, precomputed action costs, and lazy frontier materialization. Preserve
  the configured welfare policy, hard token wall, continuity pricing, and grids;
  no solve deadline is introduced.
- Handle internal protected holes in the automatic DAG solver and preserve
  chronological cache emissions across nested ownership gaps.
- Add an optional certified hysteresis exit for provable unchanged selections
  and phase diagnostics for offline solver profiling.

- Signed `thinking` blocks are priced by signature length (`MessageStore.SIGNATURE_CHARS_PER_TOKEN`, measured on Opus 4.8 via `count_tokens`) or the larger visible text, never by the flat 600-token default. On keep-all models (Opus ≥ 4.5, Sonnet ≥ 4.6, Fable/Mythos) prior thinking is replayed and billed as input at the full hidden chain of thought; the flat default under-priced long agentic histories ~10×, which pinned the calibration multiplier at its ceiling and left the compiled request far over budget. A per-block `tokenEstimate` stamped at creation still wins.
- Estimator calibration also accepts a sample whose implied raw multiplier is inside the clamp range, so a multiplier pinned at 1.8 by a wrong per-class rate can come back down once the rate is fixed (on the ratio alone every honest sample read 0.56 and was rejected forever).

- The autobiographical strategy prices rendered bodies (recall pairs, envelopes, merged entries, `maxMessageTokens` truncation) with the store's calibrated estimator instead of a strategy-local flat chars/4. Under `carrierPolicy: 'live-strip'`, where the exact mint `tokens` no longer floors the recall-pair price, the local rule under-priced dense summary prose by ~28% against `count_tokens` (526k planned vs 728k real on a 500-summary window); with parity the plan prices what it emits (real/est 1.02). The recall-pair price memo is also keyed by the calibration multiplier. `defaultTokenEstimator` / `jsonTokenEstimator` are now exported.

## 0.10.1 — 2026-09-21

### Fixed

- kv-unified: a stale presentation receipt no longer makes the Pareto label
  count superlinear in the DAG engine. Extension tokens (rendered tokens not
  covered by the accepted presentation) are no longer a state-key dimension;
  they are a dominance dimension while a provider cache is relevant (the
  cache term prices them) and a cover-envelope term reported in the
  a-posteriori error bound (`approximationCacheErrorBound`). The leaf engine
  (auto-selected when a pin or lock leaves a protected hole inside a summary)
  is fixed only while no provider cache is relevant; with one it has no
  representative cap and is barely improved (#107). Separately, the first
  successful non-dry-run adaptive presentation by a non-kv-unified folding
  strategy supersedes a persisted `kvunified:presentation-receipt`, so a
  switch back to kv-unified starts from an empty chain instead of measuring
  against a days-old baseline. Loading, a `dryRun` compile and a failed
  compile leave the receipt untouched; a host preview that runs a
  non-dry-run compile counts as a presentation, and
  `adaptiveResolution: false` never supersedes. A kv-stable → kv-unified
  switch on a production store went from "exceeded ceiling 100000 at 125796"
  (and >5 GB at a 1M ceiling) to a 332 ms / 436 MB solve under the same
  ceiling, measured with no relevant provider cache; with one, the same
  solve is dominated by #105, which this change does not address. (#97)

## 0.10.0 — 2026-09-18

### Added

- `ContextManager.getSummariesInRange`/`getMaxSummaryLevel` list existing
  compression summaries whose source span overlaps a time range — a
  read-only "browse my history" primitive, no generation, for a downstream
  agent-facing table-of-contents tool (see agent-framework's `HistoryModule`
  `overview` tool).

- `TimeRangeSummaryEntry` (from `getSummariesInRange`) now also exposes
  `firstMessageId`/`lastMessageId`/`firstSequence`/`lastSequence` — exact,
  tie-free identity/order boundaries for the covered span, alongside the
  existing millisecond `startMs`/`endMs`. Wall-clock timestamps aren't
  unique (two distinct messages can share a millisecond under rapid-fire
  appends); chronicle's per-record `sequence` is strictly monotonic and
  never ties, so a consumer doing fine-grained boundary work (e.g. a
  downstream "overview" tool distinguishing which of several
  same-millisecond messages actually belongs to a given summary) has an
  exact way to do it.

## 0.9.2 — 2026-09-17

### Fixed

- `getChannelCounts()` now reports the true unique message count per
  channel instead of summing the two channel-id metadata schemas'
  native index counts. A message that legitimately carries both
  `metadata.channelId` and `metadata.external.channelId` (a real shape
  produced by agent-framework's MCPL ingestion, which preserves an
  incoming `metadata.external` while also adding its own top-level
  `metadata.channelId`) was being counted twice.

## 0.9.1 — 2026-09-17

### Fixed

- `queryByChannel`/`queryByTimeAndChannel`/`getChannelCounts`/
  `getChannelTokenStats` now index and merge BOTH channel-id metadata
  shapes: `metadata.channelId` (what agent-framework's real MCPL
  ingestion actually writes) and `metadata.external.channelId` (the
  pre-existing convention). 0.9.0 only indexed the latter, so these
  methods silently found nothing for real framework-ingested history.

## 0.9.0 — 2026-09-17

### Added

- `MessageStore`/`ContextManager` gain `queryByTime`/`queryByChannel`/
  `queryByTimeAndChannel`/`getChannelCounts`/`getChannelTokenStats`
  (`queryMessagesBy*`/`getChannelMessageCounts`/`getChannelTokenStats` on
  `ContextManager`), backed by chronicle's new native `/timestamp` and
  `/metadata/external/channelId` secondary field indexes (#99). O(log n + k)
  against the index, not a full-store scan; requires chronicle >= the
  version that ships `registerStateFieldIndex` — degrades to a clear error
  on an older chronicle build rather than a silent full scan.

### Changed

- `compile()` now tags synthesized context messages with participant
  `system_context:{namespace}` instead of `injection:{namespace}`. The old
  name leaked verbatim into the rendered prompt (membrane formats messages
  as `{participant}: {text}`), and a speaker literally named "injection"
  tripped models' prompt-injection wariness on benign ambient context.
  Nothing keys off the prefix programmatically; transcripts and UI filters
  that grep for `injection:` should switch to `system_context:`.

### Fixed

- kv-unified: a new provider submission now supersedes an earlier flight that was never settled (a provider call that died before its usage event, then a retry) instead of throwing `kv-unified submission … is still in flight` and failing the retry as well. The superseded id is logged and later callbacks for it are no-ops.

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
