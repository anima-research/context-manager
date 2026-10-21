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

## 0.17.1 — 2026-10-19

### Fixed

- A compile's provenance no longer reads a stored message to learn where it
  sits. Attribution looks up the sequence of each raw run's first message,
  and since 0.16.0 that lookup was `get(id)`, which deserializes the whole
  message through chronicle to report one field: on a long-lived store with a
  few hundred raw runs per compile, that was about 100 ms of every compile.
  `MessageStoreView` gains an optional `sequenceOf(id)`, which `MessageStore`
  answers from its id index and the listing the compile has just read, and
  merged views pass through; a view without it is still asked through `get`
  (#273).

## 0.17.0 — 2026-10-19

### Added

- The `[plan-vs-actual]` line, logged by every adaptive compile that returns, dry runs and previews included, now carries `messages=<n>` after `solver=`, the messages in the strategy's view of the branch the compile read (after the view filter, auxiliary slots included), and then `compileMs=<n>`, the time in the base `AutobiographicalStrategy.select()` up to the line in whole milliseconds. Under `foldingStrategy: 'kv-unified'` it also carries `solveMs=<n>`, the forest build, solve and latent-demand ranking of the compile's final pick inside it (not the `productionBudgetTokens` shadow pick). A dry run or preview, which skips work a live compile does, adds ` dryRun=true`, so a journal comparison can leave them out. `compileMs` excludes a subclass's own `select()` override and the `ContextManager` work around the call. It includes a `productionBudgetTokens` shadow pick, whose solve `solveMs` leaves out, and after a provisional-calibration retry the refused first attempt. `RenderStats.planVsActual` carries all four as optional `messages`, `compileMs`, `solveMs` and `dryRun`, so a host can read them without parsing logs. Everything before the new fields is unchanged.

- kv-unified solves every forest with a subtree-memoized engine
  (`engine: 'subtree'`, the `auto` default; `engine: 'dag'` asks for the
  packed DAG engine; `auto` runs a solve the subtree engine cannot fit under
  the label ceiling once more on the packed engine). What a summary subtree contributes to a label is a
  set of deltas pruned on the same grid as before, computed once per
  summary and kept in the solve's reuse holder (by summary id, across full
  forest builds) while nothing under it changed: its leaves' weights,
  constraints, zone and receipt entries, its own and its descendants'
  structure and recall costs, and the solve's policy, grid and wall. With ages read in bands, a compile re-solves only the
  subtrees an append, a band crossing, a new summary or a move touched and
  combines the rest, so the solve's cost follows what changed instead of
  the store's size (#45). Without a grid the composition is exact Pareto
  algebra and matches the object engine's nondominated terminal set; on a
  grid it is the same kind of bucketed approximation with the same error
  bound, placed from each subtree's origin, so the retained candidates can
  differ within that bound. `KvUnifiedTimings.subtree` reports the delta
  sets a solve computed and reused.

- `mergeHoldSummaryIds`: operator merge holds. Listed summaries are never offered as merge sources by any scheduler, so while a summary that hasn't merged is held (e.g. awaiting review), no summary above it forms; like quarantined sources, held summaries split the frontier into runs, so later history still merges around them. They count as unmerged summaries: a held L1 toward `maxSpeculativeL1s`, and every held summary toward its level's `mergeThreshold`. The run of same-level summaries just before a held one can't grow past it, so it merges as a run between two summaries does, which can be at two, below `mergeThreshold`. Lifting a hold doesn't undo the merges formed around the held summary: it can then merge only with an unmerged summary of its level beside it, and one with none beside it stays at its level. Holds are deliberate, so they don't change `getCompressionDebt().state`, but they're listed in `mergeHeldIds`. Hosts must pass the option through (connectome-host companion PR).

- `witnessedIdentityReminder` is a separate identity reminder for wholly
  inherited targets: L1 chunks entirely before `witnessedBeforeSequence`,
  and merges whose every source is witnessed. Every other target keeps
  `identityReminder`, including a chunk that spans the pin, each piece the
  split rung folds such a chunk into, and a merge of inherited and lived
  sources. Such a mixed request shows inherited and lived material
  together under the live instruction and reminder, with no label saying
  which is which, so after a rename the new live reminder reaches the
  inherited material in it. The protection is opt-in. With only
  `identityReminder` set, the library appends it, current name included,
  to wholly inherited targets too, so an inherited-history migration
  should set `witnessedIdentityReminder`. The offline drain script passes
  it from the recipe. Unset, requests are unchanged.

### Changed

- Stderr diagnostics about one namespace now name it, as
  ` ns=<namespace>` at the end of their message's first line, after their
  fields, so the lines of several managers in one process, such as
  agent-framework's agents on one store, can be told apart (#239).
  Arguments after a message, such as an error, print after it as before.
  A grep for a line's prefix still matches. A reader that took a line's
  end as its last field, such as `[kv-overlap]`'s `sample=`, now finds
  ` ns=` there.
  - The strategy's lines, `[plan-vs-actual]`, `[kv-overlap]`,
    `[kv-unified]` and `[kv-escalation]` among them, the manager's, and
    the planner's, picker's, fold journal's, mint preimage's and windowed
    strategy's lines that run for one namespace name the manager's,
    `default` when it has none. A strategy no manager has initialized
    names none.
  - A message slot's lines, its cadence retune at open and `[cm-cache]`
    lines among them, and a context log's name the namespace the slot or
    log belongs to, such as an isolated or an auxiliary slot's. The
    shared message slot's, and those of a context log with no namespace,
    name none, as do lines about the store as a whole, such as the fold
    journal's index warnings.
- The JSON diagnostics `config:effective` and
  `compression:quarantine-alert`, each `[debugLogContext]` entry, and each
  entry of the compression log (`CONTEXT_MANAGER_COMPRESSION_LOG`) gain a
  `namespace` field.
- `persistMintRequestPreimage` takes an optional fourth argument, a
  `Diagnostics`, now exported as a type, which its lines go through.
  `AutobiographicalStrategy` has a new protected `diag`, the strategy's
  diagnostics, which a subclass can log through to name its namespace. A
  subclass's own member named `diag` now conflicts with it.

- Cache-marker placement on the adaptive compile, for every strategy but
  `kv-unified`: the first message-level breakpoint now sits at the end of
  the **deep band**, the leading run of recall pairs after the head
  rendered at the deepest level the compile emitted, instead of at the
  last head message. The level is the deepest over the whole middle, so a
  shallower leading run in front of a deeper summary leaves no band, and
  the head marker stays. Nothing that arrives rewrites the band: a new
  max-level summary lands after it, and a merge one level up is the rare
  exception. A deeper summary landing after it ends the band without
  changing a byte of it, and that turn marks the furthest entry the
  previous request marked that is still unchanged: the old band end, or a
  later mark. The solver can also re-cut the band's youngest group to a
  shallower level. Measured on a long-lived resident (2026-10-06), the
  head marker cached 244 tokens of bootstrap messages while 14 complete L3
  pairs (~73k tokens) sat unmarked behind it, and 24 of 51 large rewrites
  in a week re-read exactly the system+tools prefix. The band comes after
  the head, so the first slot's prefix contains the head and is never
  shorter than before. When the first slot moves, with a band before or
  after, the measured-stable-prefix marker goes to the furthest entry the
  previous request marked that is still in the unchanged prefix, unless
  the first slot already marks it, so the turn still reads what that
  request wrote: for example the head when a fold forms the band right
  after it, the band's old end when the group after the band deepens to
  its level or the band goes, or a later marker of the previous request
  when the change comes after it. Otherwise the measured-stable-prefix and
  end markers are unchanged, and the 3-marker first claim still holds.
  Repair stubs right after a head that ends in an unanswered tool call
  don't cost the band, until the call's genuine result is placed there
  instead. When neither a compile nor the one before it has a band,
  placement is byte-identical to before.
  **Trade on membrane's native formatter:** native marks the system block
  only when zero message markers arrive, so the head marker was the one
  marker covering tools+system+head there, and every turn read at least
  that from cache. With the band marker, a turn whose band changes inside
  it reads from cache on native only what an earlier request marked within
  what survived, usually *nothing* (before, it read tools+system+head). On
  the XML formatter membrane marks the system block itself on these
  requests, so a band change still reads tools+system.
  `kv-unified` keeps its 33/66/100 thirds.

- kv-unified reads ages in geometric bands: a strategy built from a recipe
  prices a leaf's fidelity age, continuity recency and stability at the
  lower edge of the band they fall in, 4 bands per doubling (a band is a
  factor of about 1.19 wide), so a leaf's weight changes only when it
  crosses a band edge instead of on every append. Exact ages moved every
  leaf's weight on every compile, which is what kept a solve from reusing
  any score from the compile before (#45). With banding on, continuity
  recency is at its floor from eight half-lives out, and stability is 1 for
  the first half of a half-life after a move and then read at whole
  doublings, whatever the band count. `policy.ageBandSteps: 0` in the
  recipe's `kvUnified` block restores exact ages; the solver-level policy
  treats an absent value as exact, so direct solver callers are unchanged.

- kv-unified latent demand measures the producible merges jointly by
  default: one what-if solve with every candidate present at its
  conservative recall cost, demanding the merges the pool's best cut in the
  frame it shares with the live solve uses, when that cut beats the live
  one by more than `adoptEpsilon`. A compile with a
  merge backlog paid two full solves per candidate (up to 16 candidates,
  the multi-second compiles of #131); it now pays one extra solve, and the
  gain gating a demand is the set's, measured once, instead of per-candidate
  differences at the approximation's noise floor. `latentDemandMode:
  'individual'` in the recipe's `kvUnified` block restores the per-candidate
  ranking; the solver-level `latentDemand.mode` treats an absent value as
  `individual`. A merge in the strategy's merge quarantine is not a
  candidate in either mode (`latentDemand.blocked`): its request would be
  refused at the queue, and a joint cut that used it would hide the merge
  it would otherwise demand.

- The compression-quarantine alarm and `getCompressionQuarantineStatus()` name each quarantined span once. A span can hold one quarantine record per request shape it exhausted, up to three, so the alarm's count of records overstated how many spans were stuck, and its keys didn't say which messages. The status gains `spans`, the longest waiting first: each span's first and last message ids, `closedAgeMs`, its age since its chunk closed (from its messages' timestamps, not its records, so a chunk re-cut into new records still shows how long its messages have stayed raw), `quarantinedAt`, when its earliest record was made, its records, the requests a provider answered for them (the canonical request, its no-tools and tools-less retries, and each fallback after them; a recall variant planned over the context budget, recorded as `admission_rejected` and never sent, isn't counted, and neither is a rung its failures decided, `provider_error:persistent-<class>`, which no provider gave as an answer), and the newest record's last outcome (such as `refusal`, `provider_error:invalid_request` or `provider_error:persistent-server:503`, null when that record holds none). To count each answer, a family's quarantine record now keeps every outcome the family recorded, its canonical stage's and a carrier rejection's among them, however its ladder ended, where it kept one outcome for the whole canonical stage; a record written before this keeps its one, so its canonical stage counts once. The alarm line starts with the number of spans, gives the number of records beside it, and lists each span with those figures. Its two clocks are labelled: "closed 2.3 h ago" is the time since its chunk closed, which can be longer than the time since it was first quarantined, and "refusing since 2026-10-15T10:21Z" is when its earliest record was made. `count` and `keys` are unchanged.

### Fixed

- A `MessageStore` no longer re-materializes its whole message slot at its
  next read after another `MessageStore` on the same store appends to it
  (#251). A sibling's append moved the write version the instances share,
  and every read took that as a reason to reload the slot. Where only
  appends happened since its cache was built, a read now fetches the
  appended records by point lookup and adds them, and the instance's own
  append after a sibling's keeps its cache for that read instead of
  dropping it. A sibling's edit or removal, or a branch switch, still costs
  a reload. On chronicle 0.4.0, a point lookup of any record but the newest
  after a write rebuilds chronicle's per-item cache, so a read after one
  append costs a point lookup, and a read after several still pays that
  rebuild. Like the cache's revalidation before it, this relies on the slot
  being written only through `MessageStore`: a write outside it, beside a
  sibling's edit or removal, can now leave a reader's listing stale, and an
  edit or removal through that listing can reach another record.

- A kv-unified compile no longer fails when a label search exceeds
  `labelCeiling` (#252): the ceiling bounds a search, not the turn.
  Where the live solve exceeds it, on the engine a recipe names or after
  the subtree engine's retry on the packed one, the compile takes the
  minimum-token cut, which the solve's feasibility check computes before
  any search, and demands no merge. An autobiographical strategy's first
  solve that exceeds it, in any pick, warns, naming the ceiling, the
  labels the search stopped at and the engine. A latent-demand search
  that exceeds it measures nothing, and the demand goes on with what the
  searches that fit showed: a conservative what-if's candidate isn't
  demanded, as one with no feasible cut isn't; a certified what-if whose
  re-solve without the certificate is stopped stands at its certified
  gain; an expected-cost solve that's stopped leaves the conservative
  gain to order its request; and a joint forest that's stopped has its
  candidates ranked one at a time. A stopped what-if or joint search
  isn't run again while the inputs that decide its label count hold.
  Where the base solve without the certificate, which a merge that
  passes the gate against the certified base is decided against, exceeds
  it, no merge is demanded that compile, and the joint ranking no longer
  takes that for its own forest's failure. A compile where the ceiling
  stopped something carries `ceiling=` on `[plan-vs-actual]` and in its
  stats (`live`, `joint`, `gate`, `whatIfs:N`), and
  `KvUnifiedStrategy`'s `lastTimings.ceiling` reports it;
  `onCeilingFallback` tells a host of a live fallback.
  `ParetoKvUnifiedPolicySolver` itself still throws
  `SparseLabelCeilingError`. A compile whose searches stay within the
  ceiling is unchanged.

- kv-unified's forest owns a leaf through a summary only where each summary on the leaf's chain lists the one below it, so it owns a leaf at a level only where the renderer's layout renders it there (#234): a summary whose parent doesn't list it is a root, and a chunk whose L1 doesn't list it is ownerless. Where a parent pointer named a summary written again without that branch, every kv-unified engine planned the branch's leaves at that summary, while the rendered layout showed them raw (#253). Such a branch's leaves are now offered no level above the one their listed chain reaches. A pin or lock at a level above it makes the solve refuse, as it refuses any pin at a level a chunk's chain doesn't supply. A parent that stops listing a child inside its span leaves the parent's leaves non-contiguous, which the forest refuses, unless `treeifyNonContiguousSummaries` or `preserveGapBearingSummaries` is set, as the store's own reopen refuses such a store. With `treeifyNonContiguousSummaries` set, kv-unified now builds the forest in full on every compile whose last forest treeified a summary, instead of deriving it from that forest, since a listing change, an edit in place or a removal around a summary treeification cuts could pass a derive unseen; on a large store that is CPU on each such compile.

- The kv-unified solver's packed and object DAG engines report an
  `approximationScoreErrorBound` that covers the cuts their grid prunes
  (#254). A pruned partial cut's error was charged to the representative
  cheapest to stand in for it, which could have more tokens than the cut and
  be pruned at the wall later, taking that error with it, where the cut's own
  continuation would have fit. The bound could then read 0 beside a cut 37%
  worse than the exact solver's. A cut is now charged only to a
  representative with no more tokens than its own, as the subtree engine
  already does. The cut each engine selects is unchanged.

- A kv-unified solve that scores every terminal label exactly no longer dies
  with `RangeError: Maximum call stack size exceeded` below its label ceiling
  when it leaves more terminal labels than a call takes as spread arguments
  (about 125,000 on Node 22 and 24). Such a solve has
  `terminalEvaluation: 'full'`, `storage: 'objects'` or `engine: 'leaf'`, or is
  `ExactKvUnifiedPolicySolver.solve` with `candidateSource: 'labels'`. A solve
  with `storage: 'objects'` also no longer dies when one prune group keeps more
  labels than that. The exact scorer takes its floors in a loop, and the
  object-storage engine's prune appends each group's labels one by one (#255).
  The strategy built from a `kvUnified` recipe adds none of these, and the
  recipe's type declares none of them.

- kv-unified's infeasibility certificate suggests producing the missing levels
  only where producing them would clear every conflict it lists, and otherwise
  reads "Release or reconcile the listed constraints." A lock against a pin at
  another level, for example, no longer tells the operator to produce levels
  (#256).

- A store with a summary whose child covers more messages than a call takes as
  spread arguments (about 125,000 on Node 22 and 24) now opens: the topology
  audit that runs at load threw `RangeError` on it. `planTopologyRepair()` no
  longer throws on such a store either, and compression's recall curve now
  collects its leaves the same way.
  `getCompressionDebt()` reports a store with more summaries, or more pending
  merge groups, than that limit, where the `RangeError` inside it used to come
  back as its empty report: state `healthy`, with no last mint (#258).

- The compression-quarantine alarm no longer announces "ALL CLEAR — quarantine empty, debt paid", or calls its handler with a count of 0, while the quarantine its alarm last sounded on may still hold debt. It did when the quarantine couldn't be read, and when the strategy had moved to another branch whose quarantine was empty. A status whose read failed now has `unreadable: true`, with `count`, `keys` and `spans` empty, and the alarm logs the read's error at most once an interval and stays as it was until a read succeeds. The alarm now speaks of the quarantine the strategy is reading: an episode follows the namespace and branch its alarm last sounded on, stays up while the strategy reads another one whose quarantine is empty, saying so at the alarm's interval with no handler call, and ends with the all-clear when the strategy reads its own quarantine empty.
- A quarantine ledger entry whose record isn't an object with a string `key` and `chunkSourceHash`, whose record carries another entry's key, or whose generation isn't a non-empty string, is left out of the quarantine, and a warning names its key, where it has one, once per load. It no longer holds its chunk back, so a chunk no other entry holds is tried again, and a refusal records it afresh. A record-less entry made the quarantine check before each L1 summary request throw, and made a clear of every record throw. No clear reaches a left-out entry: it stays in the ledger, read past, until a checkpoint rewrites the ledger, which needs 256 events in it. `count`, `keys` and `getCompressionDebt()`'s `compressionQuarantineCount` no longer include it, and an outcome list is read as the outcomes in it. A ledger or legacy snapshot whose value isn't a list is read as holding nothing, as a ledger that isn't a list already was, and the legacy snapshot isn't read beside a ledger like that; a stored null reads as no value. A checkpoint, whatever its key, replaces the entries before it with its list, and one that holds no list replaces them with nothing. A warning names each value or checkpoint that holds no list once per load. No version writes any of these, so they take a ledger edited by hand or damaged.

- Maintenance ticks skip quarantined chunks to reach eligible compression or merges. Each tick visits its initially queued source identities at most once, using current queue entries after rebuilds. The scan yields between quarantine checks so inbound events can run. Attempted work still consumes the tick. A chunk a tick skipped is ordered behind the chunks and merges that haven't failed, as a failed chunk is, so after the rebuild that every inbound message makes, tick builds their requests before it builds the skipped chunk's again. The strategy warns once per skipped source identity on each branch it loads. Quarantine-family matching is unchanged; the retry policy's changes are in the transient-ladder entry.

- Transient provider failures no longer spend the L1 compression ladder or exhaust a request family by their kind. By its kind alone, a failure is evidence about the request only when it is a deterministic rejection (`context_length`, `invalid_request`, `safety`, `unsupported`); any other failure is evidence only by the company it keeps, below. Capacity, transport, credential and unclassified failures used to be recorded as a rung's `provider_error` while the ladder carried on, so an outage could quarantine a viable family. Now such a failure stops the ladder at that rung and keeps what the ladder had learned, and a later tick resumes there.
  - Durable family progress (branch-scoped state `autobio:compression-family-progress`, separate from the quarantine ledger): every deterministic answer a request has given is written and synced before the next rung's call, so neither a restart nor a resumed tick pays again for the canonical or for a rung whose outcome is known. It is one record shared by every strategy on the store and namespace: each read is fresh and each write is a read-merge-write of its own family, so a sibling strategy sees another's progress and no write drops another's families. It is dropped when the chunk mints or its span is covered otherwise (an existing L1 adopted, a sibling's coalesced result, or the dedup guard finding every message already summarized), when the family exhausts into quarantine, and when an operator clears that quarantine. A sweep from the maintenance tick, every 10 minutes at most and independent of the quarantine alarm, also drops progress whose chunk record is compressed, progress whose chunk record is missing when every message of its span is covered by an L1 or one is gone from the store, and progress nothing has advanced for 30 days (with no chunk records at all, only age decides). A ladder never writes back a family whose progress was dropped while it ran (minted, cleared or swept), nor quarantines it: the opt-in compression log says `compression:family-dropped`, and the next attempt pays afresh. In one process only a family's own ladder writes its progress, and a second ladder on the same family, namespace and branch joins the first. A drop before a ladder first sees its family's progress isn't seen: where sibling strategies with different families share a store, one's mint of a span can leave the other's ladder to write progress, or an exhausted record, for a span that's covered. The record's one-shot alert goes out with it, and the record stands until the quarantine alarm's paid-off sweep finds the span's chunk compressed or gone, or an operator clears it. A family that another process has already quarantined under the same key keeps that record: the ladder writes nothing and forgets its progress. Across processes nothing else coordinates. A recorded deterministic answer belongs to its request (its bytes, the model included) and is reused on any route and in any later process, which is what keeps it paid once. After a known route change, an answer that only the old backend would give (an `unsupported` from a missing feature, a stricter `safety` filter, a proxy's size limit read as `invalid_request`) still stands for its family, and the family can exhaust where the new route would have answered its canonical; `clearCompressionRefusalQuarantine()` asks it again from its canonical, with its recorded answers dropped. A family whose ladder is still in progress keeps its answers, and may mint from a lesser rung than the new route would have answered.
  - The plain-prose retry (after an answer whose whole text was a `<thinking>` wrapper) is a rung of the same ladder: the empty answer is recorded against the rung that gave it (the canonical, or its no-tools or tools-less retry), a rejection of the retry is its outcome, and a transient failure resumes at the retry.
  - The degraded text-only retry after a transport rejects a request's reasoning carriers is entered only for a failure classified as a request-attributable rejection (a transient failure that merely mentions thinking interrupts the ladder instead), and the rejection is recorded under its own identity, so a resumed ladder goes straight to the stripped request instead of sending the rejected one again. Merges apply the same classification before their degraded retry.
  - A request-attributable rejection of the canonical (including its no-tools or tools-less retries) skips the recall variants and the canonical hoist. Each variant reuses the rejected request and only expands recall. The rejection goes to source-only-final once, when configured, and otherwise exhausts the family.
  - A failure that is not a rejection says nothing about the request by its kind, but it is evidence by the company it keeps on its own route. A subject's first failure starts a run, and each later one counts against it (an L1 chunk's rung, or a merge) only when some other compression has landed in the same domain since the subject's last failure there: the membrane instance the call went through and the model it named, as this process knows them. Another model's or another route's landings say nothing about this one. A landing is a compression the provider answered and whose result is written (an L1 pushed and its chunk record marked, or a merged summary written); a thin-chunk stub, an adopted L1, a span found covered and a merge entry skipped with no call are none. Failures of any class count. An L1 run is keyed by the chunk's rung, not by the bytes it sent, because every L1 that lands changes a pending chunk's request (its recall frontier grows), so the run goes on across that. The rung is named by the chunk's sources, their ids and their content, and by its label: a source edited in place starts a new run, and a late failure of the old content leaves the new content's run alone. Each content of a chunk has one run, whichever of its request families the ladder sends, and an answer or a decision ends it. The 8th failure in a run, the first and seven more each after a landing, decides the rung like a rejection: the ladder tries source-only-final once, when configured, and otherwise the family is exhausted and quarantined like any other. It stays quarantined until its chunk compresses, the paid-off sweep clears it, an operator does, or its ledger entry is found unusable. So an outage, in which nothing lands, adds at most one failure to each subject's run however long it lasts, and decides a rung only where that failure is a run's eighth, while a subject that keeps failing as other work lands on its route is decided. If each call failed independently 30% of the time, a given eight attempts would all fail 0.007% of the time (0.3⁸); a decision also needs a landing between each pair, so it is rarer still. For operators: a run is this process's evidence, kept in memory, so a restart starts every count again, and a span still failing after a restart holds no merges around it until it fails again. A process that restarts before it collects eight counts keeps retrying a request that fails on its own while other work lands, paced, with no decision. Routing below membrane (a proxy that picks a backend per call) is invisible here. And strategies that fail one subject through different routes in turn start each other's run again, since a failure in another domain starts a new one, so they don't decide it. Split-stitch is one atomic retry unit: a transient failure inside it re-runs the whole rung later, paying again for the pieces it had settled, within its per-attempt call caps. Its window cap (`compressionSplitMaxCallsPer10Min`) is a local throttle, not an answer: a rung starts only when the window has room for a whole attempt. Otherwise its chunk waits, with nothing recorded and nothing counted, while the tick goes on to the work behind it, and the first tick after the window has room takes it up (the strategy schedules no tick of its own). A piece's call that the caller's provider admission defers takes no place in the window. An attempt that alone needs more calls than the window allows still ends the rung, as the per-attempt cap does.
- Compression is paced across ticks after a transient failure, in L1 or a merge, on the membrane and compression model it failed on. No compression call is made there and no further queue item is consumed until both the provider's stated `retryAfterMs` and a local backoff of 5 s doubling to 10 minutes have passed. A chunk a failing tick was trying goes behind the chunks that haven't failed, so they run once the pause ends, and a failing merge goes behind the other queued merges. The order lives in the process and every rebuild applies it, so an inbound message doesn't put a failed chunk back at the head, and a failed chunk gives its turn to a queued merge that hasn't failed since, so a lone failing chunk doesn't keep merges, and the landings they bring, from running. A chunk is put back by its source identity, only while it is still uncompressed; a rebuild during the call re-decides its eligibility, and work that rebuild withdrew stays withdrawn. After a deferral by the caller's provider admission, an abort or a host's withdrawal (`CompressionWithdrawn`), which say nothing, the chunk keeps its place: at the head, or among the failed if it failed before, and a withdrawal pauses nothing. A merge spanning a chunk that was put back after a failure waits for it: a run of summaries before a hole that a pending retry will fill isn't consolidated early as a stranded interior run (a run whose chunk a rebuild re-cut holds nothing). Past the speculative cap (`maxSpeculativeL1s`) such a run waits as below it, since compressing chunks into L1s waits there only while an L1 merge is queued, so the retry still comes, once the count is back under the cap or no L1 merge is left queued.
  - A subject that fails while nothing else lands in its domain has nothing to compare against, so it is counted no further than its first failure and backs off indefinitely. While the lane is paused, `checkReadiness()` names what failed last and its failure class beside the pause, and `getCompressionDebt()` turns `degraded` once the oldest closed chunk has waited over an hour.
  - A stated wait is a non-negative `retryAfterMs` (NaN, or any value that isn't a non-negative number, states none) and is never shortened. One that cannot be held as an instant (Infinity, or past the last instant a Date can hold) is an explicit hold until a restart, a model change, or a release.
  - Any provider answer to one of the lane's calls resets its route's pause, the pause of the membrane instance and model it went through, a merge's answer included (a refusal is an answer), whatever the branch: the pause is the route's. Another route's answer leaves it.
  - The pause is in process and scoped to the membrane instance and to the model the failed call was dispatched with: another model ignores and clears it. A restart-stable provider deadline belongs to the caller's provider admission. Discarded or stale-branch work installs nothing. `checkReadiness()` names a pause only while it binds the configured model.
  - `releaseCompressionPause(model?)` releases the provider's stated wait (agent-framework calls it when an operator releases a provider wait). The lane's own backoff stays, so the lane resumes once that has passed too, and the failure count stays (a release is not an answer from the provider).
  - A refusal by the caller's provider admission (`providerAdmission: 'deferred'`: agent-framework holding a model, no call made) counts no failure and adds no backoff; any genuine backoff already in force is left as it was. The admission stays the authority: its answer is cached until the deadline it gave or for at most 30 s (`COMPRESSION_ADMISSION_RECHECK_MS`), whichever is sooner, and the lane then asks it again. Asking makes no provider call. The cached answer expires within 30 s, and the next otherwise-eligible tick asks the admission again (a genuine backoff, or the maintenance cadence, can postpone that tick), so a condition that clears with no release reaching this instance (a recovered journal, a release made in another process) is observed without one; `releaseCompressionPause` still resumes at once. A deferral never shortens a wait a provider stated after a real call.
  - A strategy that joined another instance's call for the same request (a coalesced wait), and gets back that call's transient failure, takes the wait the provider stated after that call, so it doesn't send the same request inside that wait. None of its own calls failed, so it counts no failure and adds no backoff, and with no stated wait it pauses nothing. A deferral by the caller's provider admission, which made no call, pauses nothing either: the joining strategy's next attempt asks the admission itself.
  - One warning per pause, a `compression:lane-paused` log event, and `checkReadiness()` names the pause while it lasts. A hold by the caller's provider admission warns, and logs `compression:lane-held-by-admission`, once per hold and again when its deadline changes, though the lane asks the admission again every 30 s at most.
- The merge lane routes only request-attributable rejections through its bounded attempt policy. A non-retryable failure that says nothing about the request (an expired key, a spent quota) now pauses the lane instead of spending attempts toward quarantine. Any other failure counts under the same evidence rule as L1's: the 8th failure in a run (the first, and seven more each after a landing in its domain) is a bounded-policy attempt, which pauses nothing (as in L1, the deciding failure is the request's own), so the policy's smaller retry is asked at the next tick. A rejection is recognized by its type whatever value is thrown, and any answer ends the entry's run. A merge whose answer a compression hold placed during the call keeps out is no failure: it stays queued for the release, pausing nothing and counting nothing. A queued merge that is skipped with no call (a source missing or already parented, or a crossed merge refused) is dropped from the queue as before, but it is neither an answer that ends the pause nor a landing. For subclasses: the protected `executeMerge` now resolves `true` when it wrote the merged parent and `false` when it skipped, and an override must resolve `true` for a merge it wrote. The merge entry's persisted server-error streak is gone, so the merge lane no longer counts 12 consecutive server errors in an outage, and a merge's run, like an L1 chunk's, is kept in memory.
- Compression failure logs (`Failed to compress chunk`, `Failed to merge summaries`, the speculative-drain error) print a bounded string instead of the error object, and the L1 and merge `CONTEXT_MANAGER_COMPRESSION_LOG` records bound their `error` field to 2,000 characters. A provider error's `rawRequest` is the whole request that failed, and printing the object wrote it out in full.

- A store closed under the speculative drain no longer ends the host's process. The drain runs each next tick from a timer that no caller awaits, so when the store closed while that tick waited, as a host's stop() closes one, the tick's `Store has been closed` was an uncaught exception, which exits the process under Bun and Node. A tick that comes due on a closed store now doesn't run, and the drain ends quietly, as on a withdrawal. Whatever else a tick throws there, such as an override of `shouldCompressPreflight()` that throws, is logged as a `speculative-drain error`, as the drain's other errors are.

- A quarantined merge no longer freezes the whole summary pyramid. Merge candidate selection always offered the oldest contiguous run; when that exact group was quarantined, `enqueueMerge` silently declined it on every pass and no later group was ever considered (observed: one refused L2 merge left 322 newer L1s unmerged for 16 days, with zero merge calls). While a quarantined merge's group could still be retried as it stands, its sources are now left out of the merge candidates, so they split the frontier like a hole: the summaries on each side merge as usual, a run that ends at the hole can merge at two, as one between two summaries can, and no summary above crosses it. A record holds nothing once its group can't be retried as it stands (a source gone or parented, or the group no longer a valid merge), nor for a topology refusal, and its sources then merge in valid groups. A topology refusal's own group, offered once it is a valid merge again, queues and its record goes. `clearMergeQuarantine` queues a held group again, unless one of its sources is still held or already queued. A group cleared after merges formed around it merges into one summary, which stays below its neighbours' level when nothing beside it was left unmerged. A store whose merging had stopped this way merges its backlog after the upgrade. The merge-quarantine klaxon's line now counts the records that hold their sources.
- Merge eligibility is enforced in one place for every scheduler: `enqueueMerge` refuses any group containing a held source (previously only an exact quarantined set). The adaptive produce path (`enqueueMergeForRange`, which the greedy solvers and kv-unified's latent demand use) also leaves such sources out and takes the longest run beside them; before this it re-requested the exact quarantined group on every pick, so the freeze above still occurred on stores using it. A queued merge holding such a source, as a queue from an older version can, is skipped when it reaches the head, and its other summaries are offered again.
- Stale merge-quarantine records (sources merged or repaired while the store was closed) are swept at load, not only when the alarm fires.
- `getCompressionDebt()` reports `mergeQuarantineKeys` and `mergeHeldIds`.

- With `foldingStrategy: 'kv-unified'`, `reportKvUnifiedAccepted` or
  `reportKvUnifiedFailed` for a submission that is no longer in flight,
  already settled or superseded by a later one, no longer clears the
  in-flight submission's pending compile. The receipt chain already takes
  such a callback as a duplicate that changes nothing, but the strategy
  cleared its pending state whatever the id, so the in-flight submission's
  acceptance kept no cache reference and the next compile's solver weighed
  no cache costs, with nothing logged. By our reading no current host sends
  such a callback while another submission is in flight: agent-framework
  settles each submission in the order its receipts arrive, and fails a
  previous activation's open ones before the next activation compiles.

- With `foldingStrategy: 'kv-unified'`, each cache marker now goes where a
  message ends a unit of the solved layout, and is recorded at that boundary,
  so the cache reference an accepted presentation keeps says where each
  marker sits. The layout renders the head window as one unit, and two kinds
  of marker didn't fit it:
  - **A marker on a head message other than the head window's last** was
    recorded at the head window's end. Two or more of them were recorded at
    that one boundary, so the request carried more markers than the compile
    recorded, and the accepted presentation kept no cache reference: the next
    compile's solver weighed no cache costs. That could happen on every
    compile while the head window held several messages and nothing was yet
    in the middle. A marker now goes in the head window only on its last
    message.
  - **A body whose shards span the head and the recent window,** with nothing
    between them, goes out as one message, and its marker was recorded at the
    head window's end, short of where it sits by the body's shards in the
    recent window. It's now recorded where its last shard ends.
  - A request whose marker count differs from its compile's, which drops the
    reference, is now logged once per strategy (`[kv-unified] … cache markers
    where its compile marked …`), where before nothing said so. A request
    with no markers, as with prompt caching off, isn't logged.

- With `foldingStrategy: 'kv-unified'`, the solver no longer counts as cached
  a prefix whose bytes changed after the request that cached it while its
  messages kept their place in the solved layout. A message changes in place
  when `ContextManager.editMessage` rewrites it; when its image is stripped,
  once newer images reach `maxLiveImages` or leave it no room in
  `maxLiveImageBytes`, or once the conversation from it on runs past
  `imageStripDepthTokens` (all on by default); when its tool result is
  replaced, once newer results of the same tool reach `toolResultMaxLastN`;
  when a late result moves up over the stub pairing repair had put after its
  call; or when a different `maxMessageTokens` cuts it. A recall pair changes
  in place under a different `maxMessageTokens`, `recallEnvelope`,
  `carrierPolicy`, `summaryContextLabel` or `summaryParticipant`. The provider
  serves nothing past such a change, but every cache marker after it was still
  credited, so the solver priced no churn for a rewrite the provider charges.
  An accepted request's cache reference now records, for each marker, a hash
  of the entries up to it as the strategy emitted them. Before each solve, a
  marker whose prefix no longer renders that way is left out of the reference
  the solver weighs, and so is a marker on the head window's end once the head
  window no longer ends at its message. The check renders the presentation the
  reference kept, so a candidate that renders raw a message the reference had
  folded, holding an image or a tool result newer than an earlier raw one, can
  change that earlier one and still be credited. `beforeUser` and `afterUser`
  injections, which `compile` adds after the strategy's selection, are outside
  the record. A reference written before this release has no record, and its
  markers are credited as before until the next request is accepted. Two new
  warnings, each logged at most once per strategy instance, mean the check
  itself has gone wrong: `[kv-unified] the cache check couldn't render recall
  …`, after which the markers past that recall pair aren't credited, and
  `[kv-unified] the cache check rebuilt the prefix through …`, when a compile
  that kept the accepted presentation sent something other than the check
  rebuilt.

- `mergeMessageStoreViews` builds the merged listing once per combination of
  source listings and serves it from a memo while every source returns the
  same array, instead of concatenating and sorting every slot on each
  `getAll`, `getFrom` and `getTail`. A manager with `auxiliaryMessageViews`
  paid that O(n log n) merge on every read of a compile (two for the
  windowed strategy, ten-odd for the autobiographical one), and the strategy's
  listing-keyed memos (post-strip estimates, the chunk index) never hit over
  a merged view because each read returned a new array (#45).
- An `AutobiographicalStrategy` instance set again while its merge's call was
  still out, as by `setStrategy()` with the same instance or by a new manager
  opened with it after `close()`, no longer writes two summaries over the same
  sources. When the earlier call settled, it cleared the mark of the new
  generation's merge, so the next tick started a second merge of the same
  sources while that one was still out. Both wrote, and `compile()` returned
  both summaries. A tick now clears only its own mark, so nothing starts beside
  the new generation's merge (#138).

## 0.16.0 — 2026-10-19

### Breaking

- **TypeScript callers that write to a compile's provenance:** its `layout`
  (`RenderedLayout`, `LayoutUnit`), its `branch` and every other `BranchRef`,
  its `journalMark`, and its `compileId`, `namespace` and `strategy` are
  read-only. Code that assigns to them, changes their arrays, or passes one of
  their arrays where a mutable array is expected stops compiling. Acceptance
  reads and records what they say, and the mark steers its search for an
  earlier acceptance, so such a write before accepting changed what it
  recorded. Copy before changing. Unchanged: the per-message sources in
  `messages` stay writable, and reading these parts compiles as before.

- **Strategy authors:** `AutobiographicalStrategy`'s protected
  `summaryAnswerContentCapped` and `combinedRecallAnswerContent` are removed.
  Since 0.15.0, compiles render the live window's recall answers through
  `renderSummaryAnswer` and `renderCombinedRecallAnswer`, so neither has
  changed what a compile sends. A subclass that calls either, or overrides
  one with the `override` keyword, stops compiling. A plain override still
  compiles and still does nothing, so remove it. A call becomes
  `renderSummaryAnswer(summary, maxTokens).content` or
  `renderCombinedRecallAnswer(summaries, maxTokens).content`. To change what
  a live-window recall answer says, override `liveWindowAnswerProse`, which
  both render methods and the budget's pricing read; overriding only a
  render method changes what is sent but not what is priced. The render
  methods, which return the layout's references with the content, are where
  to change how the cap cuts an answer. The recall pairs in merge and
  compression requests render through `summaryAnswerContent`, as before.
  Unchanged: what compiles render.

- **Host operators:** take `@animalabs/membrane` 0.6.0 or later in your own range with this release. context-manager now requires `^0.6.0`, where it required `^0.5.69`, and it counts a compression attempt's prompt through `ctx.membrane`, the host's own instance, which that range doesn't bind: npm installs context-manager's own 0.6.0 nested beside a host's older membrane without complaint. 0.6.0 is the first release that states Gemini's cached input apart from its fresh input (antra-tess/membrane#109), and it also adds Gemini's tool-use prompt tokens, which Google's own tools such as code execution add to a prompt, to the input count (antra-tess/membrane#125). A host whose own membrane is older passes Gemini's counts raw, with the cached span inside the input count. Below 0.5.81 it passes OpenAI's raw too, and OpenRouter's on routes that report OpenAI's `cached_tokens`. This release counts that span twice there: a compression fallback that fits can be `admission_rejected`, and its chunk can go to quarantine.
  - **Migration:** raise the host's own `@animalabs/membrane` range to `^0.6.0`.
  - **Unchanged:** context-manager's API, its options and what it stores, and how it counts Anthropic's and Bedrock's input, which it already summed with their cache counts.

- **Hosts that write content they didn't build,** such as a channel's
  messages: `addMessage`, `editMessage`, `MessageStore.append` and `edit`,
  `ContextLog.append`, `edit` and `replaceAll`, and `blockAsStored` for its
  one block, now refuse content that doesn't match `ContentBlock` where its
  readers read it, and store nothing of it. Before, such content was stored,
  and a reader written against `ContentBlock` could throw on it from then
  on, except inline media the store couldn't keep, whose write threw. What's
  refused: content that isn't an array; a block that isn't an object, is an
  array, or has no string `type`; a text or thinking block whose `text` or
  `thinking` isn't a string; a `tool_result` whose content is neither a
  string nor an array of such blocks, at any depth; an image, document,
  audio or video block whose `source` isn't an object, such as MCP's form of
  an image or audio, which carries `data` and `mimeType` on the block (a
  write takes it as `source: { type: 'base64', data, mediaType }`, as
  agent-framework converts it); inline media the store can't keep as a blob,
  where its own write threw an error naming neither the block nor the field:
  a document, audio or video block, or an image other than a URL one, in the
  content itself, not inside a `tool_result`, whose `source.data` the
  store's read of base64 can't take, which only data that isn't a string can
  be, or that has no media type, neither a declared `source.mediaType` nor,
  for an image, a png, jpeg, gif or webp signature in its data (data outside
  membrane's string type, such as a `Buffer`, is read for this as the store
  reads it, a copy the store's write then makes again); a generated image
  whose `data` or `mimeType` isn't a string; a `tool_use` whose `input` is
  given, isn't an object and has no JSON form, such as a `bigint`, unless
  the block already carries a string `unparseableInput`, which is kept; and
  a `blob_ref`, which only the store writes. A host that copies messages
  from one store to another copies them as read with blobs resolved, the
  default: a read with `resolveBlobs: false` gives `blob_ref`s. The refusal
  is a `MalformedContentError`. Its message names each place by its path,
  such as `Message refused: content[1] is a string, not a content block.`,
  and its `places` lists them. `malformedContentPlaces(content)` lists the
  same places without throwing, for content as JSON gives it nested no
  deeper than the call stack allows, so a host can check content before it
  writes or queues it, and drop a write this refuses rather than requeue it.
  `addMessage` refuses such a message before anything else happens: no
  compression hold expires or is placed, and the strategy's ingress chunking
  never reads it. A shard of a strategy's chunking that doesn't match is
  refused before any shard is stored, with an error naming the shard, though
  by then expired holds have been released, as at any add; and
  `ContextLog.replaceAll` refuses an entry holding such content before it
  clears the log.

- **Anyone running context-manager on Node 20 or 21, or on Node 22 before 22.12:** context-manager now declares `engines.node` `>=22.12.0`, where it declared `>=20.0.0`, and CI tests at Node 22.12.0 exactly, at 24 and at the newest Node, where it tested the newest 20.x and 24. Node 20 reached end of life on 2026-04-30. npm warns when it installs context-manager on an older Node, and refuses only with `engine-strict` set. Nothing in context-manager's code changes with this; older Node versions are simply no longer tested.
  - **Migration:** run Node 22.12 or later.
  - **Unchanged:** context-manager's API, what it stores, and what it compiles.

### Added

- `[fold-diff]` observability for adaptive compiles: when a compile that
  changed at least one saved level commits, the strategy logs once which
  chunks moved between which levels, grouped into contiguous source-order
  runs, and where its request's entries first differ from those of the last
  request the strategy returned, with the tokens from there to the end, which
  no cached prefix can cover — e.g.
  `[fold-diff] moves=18 (deepened=18 raised=0) divergence@20k suffix=32k runs=1: L0→L1×18[636..656]`.
  A compile that commits no saved-level change prints nothing, whatever else
  changed in its request, and neither does a dry run or a plan refused before
  the commit. The same record is attached to
  `RenderStats.planVsActual.foldDiff`, with at most eight runs and
  `runsTotal` counting them all, and describes only the compile it is
  attached to.
- The runs compare the carried frontier with the new one, both at the levels
  chunks render at under this compile's pins and summaries: a pinned chunk
  counts as raw whatever it carries, and locked chunks are skipped as the
  commit loop skips them. So the runs describe what the commit changes, and a
  pin added or removed, a summary lost or a lock released since the previous
  request changes the request without a run; the divergence shows where. A
  compile that only saves a lower level for a chunk whose summary is gone
  logs a line with no move. A move can leave the request unchanged, when the
  summary it moves to already renders for its siblings and the one it leaves
  still renders for theirs.
- The divergence is measured: it is where this request's entries first
  differ in their bytes from the previous request's, the comparison that
  places the stable-prefix cache marker, which now also runs under
  kv-unified. A pin, an appended message or a message edited in place since
  the previous request shows where it lands; after a branch switch, the
  previous request is the other branch's. Its offsets count the entries'
  tokens only: the system prompt and tools come before them and are neither
  compared nor counted. Nor are the injections `compile()` adds after the
  comparison: one placed before the last user message moves with it, so
  where nothing earlier differs, the request first differs at the injection,
  a message before the divergence the line reports. The strategy's first
  compile after the process starts has nothing to compare with, and its line
  says so.

- `OverBudgetError.clearedBy` names what clears an over-budget refusal at run time besides a larger budget, which clears any of them: `'compression'` while compression work that would shrink the context is running or queued for the drain to take, which a compression hold or the speculative cap can stop (for the adaptive picker, only while its plan still has summaries to produce), `'newer-message'` when the newest message alone is over (windowed passthrough) and a newer one that fits would move past it, and `'smaller-recent-window'` when the raw recent window is what's over and the head fits beside the newest turn as the compile must keep it raw: the newest message (for one split into shards, its newest shard), or, when the newest message's body holds a `tool_result`, that whole body and the call before it, or everything from a compression hold that starts earlier. It doesn't name compression for a chunk that needs a model call while the compression quarantine holds it (tick skips it, though a request of a new shape gets a fresh attempt), for a chunk tick defers until the host declares its tools, for a queued chunk or merge, or the work in flight, none of whose messages the compile can fold (each lies in the raw head or recent window, or a pin keeps it raw; a merge's messages are the leaves of its sources), whose summary would free no room though tick still takes it, for work in flight that a compression hold placed since reaches, whose landing discards what the call returns, for a chunk in flight whose summary has landed before its call ends, which the compile already folds through, or, without a compression model, for a merge or a chunk only a model call settles. With a model, the count walks the queued merges in `tick`'s order, a merge in flight still among them at the head, past one that folds nothing, which `tick` runs before it takes the next once that call lands or drops it, as far as one a compression hold blocks, where `tick` stops. A call that fails, is refused or is withdrawn leaves its merge at the head, so the count can name work behind it that `tick` reaches only after that. A merge counts even when `tick` will drop it as stale without a model call, because a source isn't loaded or is already merged into another summary, or its sources fail the merge's topology check (`tick` then quarantines it), until `tick` reaches it and drops it, while a source in memory covers a message the compile can fold; one with no source in memory names nothing. When there's no compression model or the quarantine can't be read, it doesn't name compression for anything queued behind a chunk only a model call settles: tick throws at such a chunk, and a host's tick loop ends there. Where tick would instead defer that chunk until the host declares its tools and go on, the count stops there too, since reading tool blocks as stored it can't always tell. It's empty when nothing else is known to clear the refusal. A dry run's `PreviewResult.clearedBy` carries the list for a layout that doesn't fit, the plan's own when the plan is over the budget; it names compression only for work queued when the dry run takes the list, not for what its plan's own ops would queue. A host can now tell whether compression work that can make room is under way without reading the message, though whether that work is enough to fit isn't checked. The list's type is exported as `OverBudgetClearedBy`; the messages are unchanged.

### Changed

- A `tool_use` whose `input` isn't an object, as membrane 0.5.87's adapters
  can give it, is now stored with `input: {}`, and `unparseableInput`, where
  membrane keeps arguments whose JSON didn't parse, keeps the value as JSON.
  One with no `input` at all is stored with `{}` and no marker, and a string
  marker the block already carries is kept. A block that shares a raw replay
  form (`rawXml`, `rawItem`) with a mended one gives the form up, as after
  any edit, so a write stores what a read of the same content gives. Before,
  such a block was stored as given. Reads mend it the same way in a store
  written before. They also mend a signed thinking block whose `thinking`
  isn't a string, which keeps its signature with `thinking: ''`, as membrane
  gives a signature-only block; media in MCP's form, with its `data` and
  `mimeType` on the block and no `source`, which reads with them as its
  base64 source, as agent-framework converts MCP's media; and a
  `tool_result` whose content is a lone block or a number, which reads as an
  array of that block, when the read keeps the block, or as the number's
  text.

- A message cut at `maxMessageTokens` now says that content was left out. The first text block past the cap that holds anything, text or an opaque item such as a Responses carrier, becomes one `[content omitted: this message reached its token limit]` block, in the autobiographical and windowed-passthrough strategies alike, where those blocks used to be dropped without a trace, so a message read as ending at the cut. A text block that holds nothing, empty or only whitespace, is left out across the cap as it already was past it, with no marker, where one crossing the cap used to be cut and given a truncation suffix; the cap ends there, as at a cut. A message whose every block is such a text block now carries the omission block alone when the cap leaves one of them out, where its whitespace was cut and given the suffix. Leaving one out no longer makes the summary it belongs to partial in the combined recall answer's layout, unless it gives up an item that a kept reasoning part pairs with: that part then goes out without its raw form, as after a cut, and the summary is listed partial. A summary the cap took something from that held anything, of which only text blocks that hold nothing reached the answer, is no longer listed in the combined recall answer's layout, with `recallEnvelope: 'xml'` or without, where it was listed partial: it shows the resident none of its history. A tool result whose content is a string already carried its own marker past the cap; an empty one now stays as it is, since it loses nothing. In the legacy combined recall answer (`positionedRecallPairs: false`), the marker goes where the first dropped block that held anything was, as in any message; with `recallEnvelope: 'xml'`, which spends the cap summary by summary, it goes once after the last answer when the cap leaves out a summary that holds anything, unless that answer's own cut already wrote it inside its envelope. That answer ends where the cap ended, even where the blocks the cap left out spent none of it, and a summary isn't admitted where the cap reaches it and leaves nothing of it that holds anything. An answer the cap admits no summary to is the omission block alone. A message the cap cuts nothing from, though its estimate passed the cap, comes back as it was and is no longer treated as cut: the xml combined answer lists such a summary as shown whole, where it listed it as partial. In the windowed-passthrough strategy, a message the cap looks at but cuts nothing from is now priced at its full estimate, as it renders, where it was priced at `min(estimate, cap + 50)`. The two differ only when such a message's estimate passes `cap + 50`, as one with a large tool call can, and the window's total then rises by the difference. The combined recall answer is priced as rendered, so a capped one now costs the marker's tokens more. The first compile after upgrading changes the bytes of these messages, and misses the prompt cache from the first of them on: one the cap drops a block that holds anything from, which gains the marker; one with a text block that holds nothing across the cap, or whose blocks all hold nothing, once the cap leaves one of them out; one with an empty string tool result past the cap; one in which the cap leaves out a part of a Responses item that holds nothing while a part it keeps carries the same item, which now keeps its raw form; and a combined recall answer that admits a summary differently, as above. Any other message from which the cap leaves out only text blocks that hold nothing, past the cap, comes out as it did. In the windowed-passthrough strategy, the new price can also move the window's start, which changes the prompt from there on too.

- The markers context-manager writes into a compiled context now say what happened, and the stub for a missing tool result says what the agent can do. The first compile after upgrading renders the new text wherever a marker appears, so a provider's prompt cache misses from the first such marker on, once. In the adaptive selector, a stripped image is priced at its placeholder's length, 14 tokens where it cost 9, so that compile can also fit slightly different entries. The other markers' lengths enter no budget, so a result left out under `toolResultMaxLastN` still counts at its original size. The exception is a message `maxMessageTokens` cuts, whose cut is priced as it renders, its notices included.
  - An image the context doesn't carry reads "[image not shown: this context keeps only some images]", in both strategies and in the compression prompt's image cap. It names no particular limit, since the count, byte and depth limits, the hysteresis watermark and the compression request's byte cap all write it.
  - A tool call whose result isn't in the rendered context gets "[this call's result isn't shown in this context. If you need its output and the tool only reads, call it again; you'll get what it returns now.]".
  - A result replaced under `toolResultMaxLastN` reads "[result of tool '<name>' left out: this context shows only the tool's last result]" for a limit of 1, "… the tool's last N results" for a larger one, or "… this context shows none of its results" for a limit of 0. It said "Result truncated", though the whole result is replaced, and counted later results that were replaced too.
  - A tool result past a message's `maxMessageTokens` reads "[content omitted: this message reached its token limit before this result]", where it blamed the context budget.

- In 0.15.0, under `foldingStrategy: 'kv-stable'` (connectome-host's default) and `'kv-unified'`, with `adaptiveResolution`, a pin or document whose `level`, or without a `level` whose `maxLevel`, is above 0 stopped keeping its messages out of compression; 0.15.0's notes list it under Fixed. Those messages are compressed, since only a summary can supply that level, and the selector holds them at `level`, or no deeper than `maxLevel`, so `markDocument(id, { maxLevel })` lets a document fold, but no deeper than that level. Under kv-unified, a pinned level on a message between the head window and the recent window that no summary supplies yet fails every compile until one does, as 0.15.0's notes say. The comments of `pinRange`, `markDocument`, `PinnableStrategy` and `ProtectedRange` now say so, and that where pins overlap at a message, the bound `ProtectedRange` names holds it, which can compress a message a raw pin covers.

### Fixed

- `acceptRound` refuses a compile whose branch its store doesn't know, live or
  recorded in the manager's namespace, as it already refused one of another
  namespace. Another store's compile in the same namespace used to land as a
  receipt for a branch that store never had, announced to its listeners. A
  compile of a branch deleted before any of its compiles was accepted is
  refused the same way; a deleted branch with readable records still takes
  one.
- `listFoldReceipts` stops where a receipt's link leaves its namespace or
  branch, and its `note` says so, instead of listing the other branch's
  receipts as this one's. An acceptance no longer announces another branch's
  receipt that such a link names.
- `acceptRound` refuses a layout whose members aren't in ascending order,
  whose units' counts aren't positive whole numbers adding up to its members,
  or that doesn't have one id for each member, as a layout changed after
  `compile()` returned it can be, instead of writing
  a record that later fails to rebuild and starts its branch again from a
  baseline. A change that keeps that shape can't be told from the layout
  `compile()` returned, and is recorded as written.
- The fold journal keeps its own copy of each layout and branch it accepts,
  and a compile's `journalMark` and the branch `listFoldReceipts` returns are
  copies. So changing a compile's provenance after accepting it no longer
  changes the layout the journal diffs the next acceptance against, the
  branch it lists receipts under, or where it looks for an earlier
  acceptance.

- A compression attempt's provider input count adds cache writes and cache reads to `inputTokens` for every provider, not only for Anthropic and Bedrock (#182). membrane states those three counts as disjoint wherever it knows the convention, so on the other providers that report cache reads, OpenAI's adapters, OpenRouter and, from membrane 0.6.0, Gemini, the count left out the cached span. A refused or incomplete compression's fallback plan then took a baseline too small, and could send an expanded fallback that doesn't fit the compression budget instead of recording it as `admission_rejected`. A successful attempt's `renderedTokens` under-reported its prompt by the same span.
  - **Host operators:** on those providers, a fallback that doesn't fit is now `admission_rejected` and not sent, as on Anthropic and Bedrock, so a chunk can go to quarantine where before the fallback was sent. `renderedTokens` includes the cached span. A full cache hit, no fresh input beside a positive cache read, now counts as the provider's count of the prompt there too, where before the complete request bound stood in for it. A provider's omitted prompt total beside cache reads counts the same way, since membrane's adapters other than Anthropic's and Bedrock's report an omitted count as zero.
  - Quarantine records written before this release go on holding their chunks, and the upgrade releases none. On OpenAI's adapters or OpenRouter, or on Gemini through membrane 0.6.0, the old count may have planned a held chunk's fallbacks wrongly, so the chunk may compress now. Clearing each of that chunk's records with `clearCompressionRefusalQuarantine(key)`, by the `quarantine_key` each of its `compression:quarantine-alert` events names beside the chunk's `chunk_hash`, gives it a fresh attempt under the corrected count. Called with no key, it clears every chunk's records.

- A store holding content that doesn't match `ContentBlock` where its
  readers read it no longer wedges its agent. Such content is content that
  isn't an array; a block that isn't an object, is an array, or has no
  string `type`; a text block whose `text`, or a thinking block whose
  `thinking`, isn't a string; a `tool_use` whose `input` isn't an object; a
  `tool_result` whose content is neither a string nor an array of such
  blocks, at any depth; an image, document, audio or video block whose
  `source` isn't an object; a generated image whose `data` or `mimeType`
  isn't a string; or a `blob_ref` whose `ref` has no string `hash`, or whose
  `originalType` isn't image, document, audio or video. Readers written
  against `ContentBlock` throw on it. A store holding a block that isn't an
  object, or a `blob_ref` without its `ref` or with any other
  `originalType`, threw on every compile under the passthrough and windowed
  strategies, after a reopen too. Under the autobiographical strategy,
  opening such a store threw, and so did opening one holding a text or
  thinking block without its `text` or `thinking`. Membrane 0.5.87 throws
  while building a request that carries an image block without a `source` at
  the top level, or inside a `tool_result` in xml tool mode. In native tool
  mode, it replaces such an image inside a `tool_result` with a note that
  its media type "undefined" isn't accepted, so the model loses it. Its
  native formatter throws on audio without a `source` at the top level too.
  Reads (`MessageStore`'s messages and `ContextLog`'s entries) now leave
  such content out, or mend it so that it matches, before anything reads it,
  blob resolution included, and log one line per message or context entry
  naming each place, once per `MessageStore` or `ContextLog`. An entry that
  comes to have another's index gets a line of its own unless the same
  places are wrong in it. A `tool_use` is mended as a write now mends it. A
  `tool_result` keeps its block with the blocks of its content that match,
  or with an empty array in place of content that is neither a string, an
  array, a lone block nor a number, so the pair they make survives. A
  message whose content isn't an array, or all of whose blocks are left out,
  reads with empty content. The store keeps the content as written, and
  `editMessage` can replace it. In the message's content, and in each
  `tool_result`'s content within it, a block that shares a raw replay form
  (`rawXml`, `rawItem`) with a block a read changes or leaves out gives that
  form up, as after any edit.

- kv-stable: a pin-at-level at a level its chunk's lineage skips, where a
  summary's parent is more than one level up, now holds the chunk at the next
  level down where it has a summary. It was kept there and rendered raw, and
  the picker reported its level as one it can't realize. A context that holds
  such a pin compiles differently once after the upgrade, which rewrites its
  prompt cache from where the compiled context first changes (#194).
- flat-profile and oldest-first: a chunk's summary at a level is now one that
  lists it, as for kv-stable. Where a summary's parent pointer named a summary
  written again without its branch, they could choose that summary for the
  chunk, raise the summary's own leaves and leave the chunk where it was, and
  choose it again on every step until the solve threw "greedy fold solver
  exceeded internal bound". Raising a summary now moves the leaves whose own
  summary at its level it is, as kv-stable's folds decide: a leaf it lists
  through another lineage keeps its level, where it used to be raised too,
  even to a level where its own lineage has no summary. On a store whose
  summary tree isn't nested this changes their plans, and oldest-first, which
  chooses a summary only for the oldest chunk, can meet its target less often.
  A chunk carried at a level whose summary doesn't list it now starts at the
  next level down where it has one. And a step raises a chunk past a level
  where it has no summary, one its lineage skips or one whose summary doesn't
  list it, through the next summary up that lists it. Past a level its
  lineage skips, it used to ask for a summary at that level, which the
  strategy can't produce for a chunk whose lineage already links past it, and
  stop there, short of its target, on every compile (#194).

- `moves`, in the `[plan-vs-actual]` line, `planVsActual` and a preview's
  result, now counts the chunks whose saved fold level the compile changes,
  which are the levels it commits (#195). A dry run counts the levels it
  would commit, and a preview counts the levels its layout changes, whether
  or not the layout fits. It was the picker's count, of chunks whose solved
  level differs from the level they were planned from, and the two differ in
  two cases. A classic pin renders a locked chunk at another level while the
  commit keeps the locked one, so that chunk counted as a move on every
  compile for as long as the pin stood. A chunk whose saved level's summary
  is gone is planned from the level its summaries still reach, so the
  compile that saves that level didn't count it. A `moves=` histogram loses
  the first and gains the second. `PickerResult.moves` is unchanged.

- A split-stitch compression's `details.usage.discardedAttempts` now carries the cache counts its discarded calls (refused, incomplete or empty) reported, `cacheCreationTokens` and `cacheReadTokens`, beside their input and output counts (#199). It counted only input and output, so on providers that cache, the discarded spend's cached span was missing. The counts appear once some discarded call has reported cache counts, as the stitched usage's appear once some successful leaf has. The `attempted` totals in the split-stitch log events and in the stitched entry's split metadata gain the same two sums over every completed call, once some call has reported them.

- A `beforeUser` injection passed to `compile()` now reaches the agent when
  no compiled message has the participant `user`, in any letter case, as
  when messages are stored under their authors' names: it goes at the end,
  ahead of any `afterUser` injection, which already fell back to the end
  there. Before, it was dropped without a log line or a trace. Its provenance
  source and its tokens in the rendered layout come with it (#220).

- kv-stable: a compile no longer logs `[kv-overlap]` about the shadow
  production pick's plan, which no compile renders. A compile that isn't a dry
  run makes that pick when `productionBudgetTokens` is set below its budget,
  and the pick planned the same way and logged a warning about its own plan.
  So a compile whose own plan rendered no such summary could warn, and one
  whose plan did could warn twice (#222).

- A message `maxMessageTokens` cuts is now priced, in both strategies, at its
  uncapped price plus the store's estimate of what the cut changed, so the
  cut is priced as it renders (#223). It was priced at no more than the cap
  plus 50 tokens. But the cap cuts only text and string tool results, so a
  capped message's images, tool calls and thinking went out whole beyond that
  price. And the cap keeps four characters a token, which the store prices at
  its own rates: a string tool result cut at a 10,000-token cap estimates at
  about 17,400 tokens, and prose at about 13,800. At small caps the price
  falls instead: a message of text alone cut at a cap of 1 estimates at about
  15 tokens, where it was priced at 51. In the autobiographical strategy, a
  message the cap leaves whole is priced as it is with no cap, where it was
  priced at no more than the cap plus 50. In the adaptive selection's middle,
  a body sharded at ingress is priced uncut where the plan keeps it raw,
  since the middle sends its text uncut, where a cap smaller than a shard had
  the plan count it cut, so emission could overrun the plan by what the cut
  left out and refuse. A compile's render
  stats count each message at its new price. A `maxMessageTokens` that isn't
  a positive number, such as NaN, is no cap in the windowed strategy too,
  which cut away a message's text and left the cap's notices in its place.
  - Where `maxMessageTokens` is set, a compile fits fewer raw messages in its
    budget wherever a capped message sends more than the cap plus 50. A
    prose block cut at connectome-host's cap of 10,000 does at calibration
    multipliers above about 0.73, and a string tool result cut there does at
    any the clamp allows. At any cap a message's images, tool calls or
    thinking can take it past.
    The autobiographical strategy then folds or evicts sooner, and can refuse
    with `OverBudgetError` where it sent a window over its budget. The
    windowed strategy re-anchors sooner, and refuses a newest message that
    renders past the budget, where it sent it. At small caps, a capped
    message that keeps little beside its cut text is priced lower, so a
    compile fits more of them.
  - The estimator's calibration starts pricing epoch 3. A multiplier learned
    where capped messages were under-priced made up for that price, so kept,
    it would run high, and a compile it put over the hard budget would stay
    refused. So the first compile discards the multiplier in a store holding
    a message whose estimate the cut's test puts past the cap, or one the old
    price could have limited, with an `[estimator-calibration]` warning and
    `calibration.reset` in the render stats, and the first provider sample
    sets it again. A store with no cap, or nothing near it, keeps its
    multiplier, where its view reports the multiplier it estimates at, as
    `MessageStore`'s does. One that doesn't is read at 0.6, so its store can
    be counted for a message well under the cap.
  - The hierarchical selection, which runs when `adaptiveResolution` is off
    (the default), prices raw messages before the image strip. So a capped
    message whose image the strip replaces is now priced with that image
    whole, as an uncapped message there already is, where it was priced at
    no more than the cap plus 50. Such a window can be refused where its
    rendered size fits the budget.
  - A window this moves misses the prompt cache on its first request after the
    upgrade, and, in a store whose calibration restarts, can miss it again
    once the first provider sample sets the multiplier.

- Past `maxSpeculativeL1s`, compressing chunks into L1s now waits only while
  an L1 merge is queued to bring the count of unmerged L1s back down (#240).
  With none queued, it goes on. Compression used to stop for good, with
  chunks still queued and nothing able to start it again, wherever no such
  merge could come: with the cap below `mergeThreshold - 1`; with unmerged L1s
  that can't merge filling the cap, as after a merge goes to the merge
  quarantine; or with `hierarchical` false, where no merge runs. A host whose
  compression had stopped this way compresses its queued chunks after the
  upgrade, as it would have when they formed.
- The option's documentation said the cap counted queued chunks too and held
  back only the auto-tick. It counts produced, unmerged L1s, and its hold
  applies in `tick` itself, background or manual.

- `compile()` no longer groups every stored message into bodies to attribute
  its raw entries. Provenance now finds each body a raw entry names, through a
  store lookup when it doesn't follow the last body found, and reads the
  stored messages only around it. The rendered layout still walks the
  strategy's view, since it records every message of the view. Sources, their
  completeness and `rawBodies` are unchanged.

- Reads leave out a stored `blob_ref` of a document, audio or video whose
  reference has no string `mediaType`, and log the line naming it, such as
  `content[2].ref.mediaType is undefined, not a string`, as they do one whose
  `originalType` isn't image, document, audio or video. Before, it read back
  as media without a string media type, which the store's write can't keep,
  so a host copying messages as read with blobs resolved couldn't store that
  message. The store's own writes don't make such a reference: it keeps media
  as a blob only at the top of a message's or context entry's content, where
  every write path refuses media it can't give a type. An image's reference
  still reads back with the type its bytes' signature names, whatever its
  `mediaType` holds, and with that `mediaType` when its bytes carry no png,
  jpeg, gif or webp signature.

- kv-stable: on a store whose summary tree isn't nested (where
  `[kv-overlap]` warns), the next compile no longer un-folds a summary around
  a leaf that the summary lists but whose own lineage doesn't run through it,
  or around a leaf of its own folded above it. The validity projection now
  decides both from the tree, for the carried frontier and each
  suffix-adoption candidate as for the ideal cut: a leaf vetoes a summary
  only when it renders below the summary's level and the summary is its own
  lineage there. Before, a plan that held re-laid the window from that
  summary on, on unchanged inputs, and reported a perturbation of 0; a plan
  that adopted the same frontier again reported a fold and a perturbation it
  hadn't made; and suffix adoption could never take such a summary. On such
  a store a plan can now also keep a summary folded where it used to render
  that summary's leaves raw, since the solve's own exemption covered only
  the leaves its folds had met. LariTesserae's #130 named the re-layout.
- kv-stable: a compile no longer leaves a leaf at a level whose own-lineage
  summary doesn't list it, on any store. A level carried from before a
  summary was written again without one of its sources, a lock or a pin
  could point there, and so could a fresh plan's passes on a store whose tree
  isn't nested. The leaf's recall didn't hold it, and where no other recall
  did, the turn was refused with `UncoveredDropError`. The projection now
  lowers such a leaf, and the base lowers a locked or pinned leaf's level the
  same way, so a lock or a pin can now render below the level it holds when
  the summary there doesn't list the leaf. For a pin-at-level
  (`pinAtLevel`, `ProtectedRange.level`), kv-stable now lowers the level the
  same way before it holds the pin's summary there, so a summary it holds for
  the pin lists the pinned chunk, and the chunk is held with that summary's
  other leaves. It used to hold the leaves of the summary that doesn't list
  the chunk, which nothing pins, and leave the pinned chunk unheld, so it
  rendered raw when there was room.
- kv-stable: where two pins-at-level overlap a chunk, it is now held at the
  finer of the levels the two pins hold it at, whichever pin kv-stable reads
  second; a pin whose chunk has no summary at or below its level holds the
  chunk raw. A pin at a level where the chunk's lineage had no summary used
  to set that level for the chunk, replacing a finer pin's level when
  kv-stable read it second, and the chunk rendered raw, with the picker
  reporting a level it can't realize.
- kv-stable: on a store whose summary tree isn't nested, the solve's
  un-fold pass now moves the leaves a summary renders, decided by each
  leaf's own lineage as the projection decides. It used to leave out any
  leaf that some fold in the same compile had met under another lineage,
  and could then settle on a plan above `foldAt`, the same on every
  compile. A fold decides the same way: a listed leaf of another lineage,
  which the fold doesn't move, no longer vetoes it with its pin-max-level or
  its fold-depth cap.
- kv-stable: the solve's un-fold pass now weighs each leaf it moves where the
  projection will put it: one level down, or deeper, past a level where the
  leaf's lineage has no summary and past a summary that a leaf below it
  vetoes, down to the next level whose summary of the leaf's own lineage lists
  it and isn't vetoed, or to raw. It weighed every leaf one level down. Where
  a summary in the leaf's lineage names a parent more than one level up, so
  its lineage has no summary there, it counted the leaf as raw and could
  decline an un-fold that would have brought the plan closer to its target.
  Where a leaf below vetoed the summary there, the plan it took wasn't the one
  the projection rendered, and a compile could end exhausted where a plan fit.
- kv-stable: `[kv-overlap]` now reads the frontier the plan emits. It warns
  for every compile whose plan renders a summary that lists a leaf of another
  lineage, and only then. It used to report the folds the compile made, so a
  plan that kept the carried folds could render the overlap without a
  warning, and a plan that didn't render it could still warn. A lock or a pin
  can still hold a leaf beside a summary of its own lineage that lists it,
  which renders the leaf in both recalls without a warning.
- kv-stable: a locked chunk with a pin-max-level is lowered to the cap at
  plan start, as the cap promises. It used to keep its carried level above
  the cap. A chunk under another range's pin-at-level keeps that level, as
  before, since kv-stable fixes the pin's whole node there.
- kv-stable: an unlocked chunk's level carried far above the summary tree's
  top is now lowered in one compile to a level its summaries render. A plan
  that held it could emit a level with no summary, which renders raw, and
  the next compile then rendered the summary while reporting a perturbation
  of 0.

- A host can withdraw a compression or merge call it doesn't want made, such as one arriving while it holds the store or stops, by throwing `CompressionWithdrawn`, newly exported, or an error extending it, from the membrane it hands the strategy. Every rung of the L1 compression ladder (the tool-prose hoist, the recall fallbacks, source-only and split-stitch parts) and the merge path rethrow it unchanged and record no outcome, so a withdrawal never counts toward a quarantine. Before, each rung recorded it as a `provider_error`, and a ladder whose remaining rungs failed that way quarantined the chunk. `tick` puts a withdrawn chunk back at the head of its queue, unless a rebuild while the call was out decided the queue afresh, and a withdrawn merge stays at the head of its own. An L1 call whose branch moved while it was out discards the withdrawal, as it discards any error. A withdrawal isn't reported on the console as a failure, the opt-in compression log marks its receipt `withdrawn`, and it stops the speculative drain quietly. The strategy recognises it by a brand that subclasses and other copies of this package carry, not by its name.

- In hierarchical mode, two kept summaries that list one summary no longer both render. Two instances on one store can merge the same run, since compression coalesces across instances and merges don't, and the store then holds two summaries over the same sources: each rendered, covering the same messages twice. Opening a store now drops every summary that lists one it isn't the parent of, with the summaries above it, as it drops a summary that names a missing one. A summary's parent is chosen as before, so of two merges of one run, the one all the run's pointers name is kept, and a source only the other listed merges again. When the run's pointers are split between the two, as a crash partway through the later merge's pointer writes leaves them, both are dropped and the run merges again. A summary that two list while its pointers name neither has no parent, so both are dropped and it merges again. The repair is persisted, so a second open changes nothing, and the open's log line names the summaries it dropped this way under "naming one it isn't the parent of".

- `pushSummary` refuses a summary whose `sourceIds` isn't a non-empty list of ids, or, above L1, whose `sourceRange` isn't two message ids. The error names the summary and the value it holds, and nothing is held or stored. Before, such a summary was stored as written, and only a later open dropped or rebuilt it, with nothing to say where it came from; the summary with null `sourceIds` found in a real store (#130) has no known writer. An L1 whose range doesn't run from its first source to its last is now stored with that range, as the open would rebuild it, with a warning that names the summary and the range it held. This package's compressions and merges write readable sources, and an L1's range from its first source to its last, so only a summary built some other way, such as by a subclass calling `pushSummary`, meets the error or the warning.

- The stable-prefix cache marker is placed against the last request the
  strategy returned: a compile refused after it placed its markers no longer
  becomes the request the next compile compares with.

- The image-strip watermark (`imageStripHysteresisRatio`) registers its state slot when the strategy opens with the option on. Before, the slot was never registered, and its first write created it. A store whose slot was created that way keeps its watermark. A watermark write that fails is now logged once per strategy instance, naming the slot and the error, where before it was swallowed. The watermark still holds in memory until the strategy next loads its state (`initialize`), as a restart, a branch switch or fork, or `setStrategy` does.

- An L1 prompt shows pinned history raw only when the request fits `compressionContextBudgetTokens` with the longer of the lines that the no-tools and plain-prose retries add to its instruction, so either retry of an admitted request fits too. The request used to be priced without that line, so a pinned request admitted within a few dozen tokens of the budget could go over it on a retry. The over-budget warning and the `compression:pinned-raw-over-budget` event's `requestTokens` give the price with the line, and the warning says so: "counting the line a retry adds".

- With `witnessedBeforeSequence` set, a quiet stretch before the pin (a chunk of text only, with too little text to summarize, stored as a mechanical stub without a model call) is now stamped `witnessed`, as an L1 summary of the same chunk is. A merge of inherited summaries that included one used to take the live merge instruction, where `getMergeInstruction`, and the retry after a refusal, give a merge of all-witnessed sources the witnessed one; its result, and every merge above it, went unstamped. Such merges now take the witnessed merge instruction. The stamp is written when a stub is made, so summaries already stored keep what they were written with: a merge made after the upgrade over a quiet stretch stored before it still takes the live instruction. Deployments without `witnessedBeforeSequence` are unchanged.

- An L1 compression prompt or a merge prompt no longer joins the agent's own raw turn to the recall answer just before it. The prompt collapsed the two into one message with a `---` separator, and the formatter merges consecutive messages of one role at the wire in any case, so the summarizer read the raw turn as the end of the memory it had just recalled. That happened wherever the agent's raw turn followed a recall pair, directly or past messages with no content, which a request leaves out: in the L1 prompt, at an opened chunk that starts on the agent's turn and at the raw middle; in a merge prompt, at an L2 target or the raw middle. A Context Manager turn, `[CM] The conversation resumes.`, now comes between them. The answer is the memory alone again, so a summary just before such a chunk keeps its refusal-fallback variant, which matches the answer exactly. The one-shot zero-recall surgery (`scripts/one-shot-zero-recall-surgery.ts`), which takes the recall pairs out of a compression request, is unchanged, but it dropped that raw turn along with the answer it was joined to. Given a request built now, it keeps the turn, and the Context Manager's turn before it. A prompt without that adjacency is unchanged.

- Compression's data-URL matcher bounds what comes before a payload, so a string that almost matches no longer throws. In 0.15.0 the media type and its parameters had no bound, and a text holding `data:` and a run of nine million characters with no slash, or one parameter value that long, overflowed V8's regex stack and threw a `RangeError` from the compression request's preparation. Now the type's two names and each parameter name take at most 127 characters, as RFC 6838 bounds them, and there are at most 16 parameters with values of at most 1,024 characters, bounds of the matcher's own. A data URL past them isn't matched, and its payload stays in the prompt, so any compression request holding one can be refused for context length.
- A replaced payload ends where its encoding does, except after a full-width last line. 0.15.0 took any escape inside a payload as part of it, so the text after a payload could be replaced with it: in the review's cases, a path, a URL or a few words. Now a payload wrapped at 60, 64 or 76 characters with escaped line breaks (`\n` and the like), as Ruby's `Base64.encode64`, PEM and MIME wrap it, is matched across them, and an escaped base64 character such as `\/` counts as one character of its line. Any other escape ends the payload, as do an escaped break after a line of another width and any raw line break, so the text after it stays. A payload whose last line is 60, 64 or 76 characters long can't be told from one that goes on, so it takes the base64 characters after its break with it. A payload wrapped at another width, which 0.15.0 replaced along with the text after it, now ends at its first break: with that first line under the 4096 floor nothing is replaced and the payload stays in the prompt, and otherwise only that line is. The floor counts the characters the payload takes in the text, escapes and breaks included.
- The marker names the media type only when the decoded type reads as one, since a `\u` escape can spell any character into it. Otherwise the payload is still replaced, and the marker leaves the type out.
- The split rung weighs each part's share of the summary target by what the part sends, priced as the store prices it: its text, its tool results and tool calls, and its images, with its thinking left out and its serialized media priced as their markers. So a part holding a data URL no longer takes nearly the whole target from its siblings, and a part holding a long tool result or images no longer falls to the 100-token floor. Each image counts at the store's estimate, though a request's inline image cap can replace some with placeholders, and a tool block whose partner is outside the chunk counts, though the request drops it, so such a part is weighed above what it sends.
- An L1 request with raw pins priced the pinned raw, and the whole request, with their serialized media's payloads, against the recall budget and `compressionContextBudgetTokens`. So a pin whose raw carried a data URL, or one beside a chunk that did, could be dropped for recall even when the request as sent fit. Both are now priced as sent, with the media replaced: the pinned raw without its thinking, which the request strips from raw messages, and the request with the signed reasoning its recall answers carry, which it sends. Images are priced at the store's estimate, above what is sent where the request's inline image cap replaces some, and the pinned raw's charge against the recall budget also counts a tool block whose partner the request drops, so the gate errs toward recall.
- A sharded body's size, which decides whether a chunk of it is compressed as reading and is quoted in the reading instruction, for an L1 and for a merge, is now priced as sent too, with serialized media as its markers and thinking left out. Pricing each shard scans its text, and a body's size is read for every chunk of it, so within one strategy context a shard's price is kept until one of its blocks changes. So is the transition summary's head, which kept 8,000 characters of its messages' text with their payloads in it and now keeps their markers in their place; the payloads its markers replace in the text it carries are logged with the transition request, as a compression request logs its own.
- The tool-prose hoists (`compressionToolProseFallback`) are admitted against `compressionContextBudgetTokens` as a recall-curve variant is, where 0.15.0 sent them unpriced: the provider's count of the request each one rewrites (the canonical, or the source-only fallback for its own hoist), plus what the hoist adds, read from both requests with each block priced as its route sends it, plus the output reserve. The whole bound counts a block's raw replay forms (`rawXml`, `rawItem`) beside its fields, and the hoist's edit releases its call's, so a difference of the two whole bounds credited a released `rawXml`, which no route sends, against what the hoist adds. A recall-curve variant's delta is read the same way. A `redacted_thinking` block carrying a reasoning item is priced as that item alone, as both Responses routes send it (on the API route, membrane sends compression requests through its `openai-responses` formatter whatever formatter they name), and every other block by its fields. Two places where a route sends more than that are known, so what a rung adds there is priced low: such a reasoning block on Anthropic, which sends it whole and would meet one only where a compression model moved there from a Responses route replays its earlier answers (whether Anthropic accepts the block at all is unchecked), and a block whose `rawItem` outweighs its fields on the Responses API route, which sends the item, by the item's own overhead (unmeasured). Where that request has no count, or the provider counted only the copy stripped of reasoning that a transport rejection made it go as, the hoist is admitted on its own bound, and so is a recall-curve variant whose canonical went as that copy. A hoist over the budget is recorded as `admission_rejected` in the attempt's outcomes and traces, with its admitted tokens and the budget, and isn't sent. Each argument a hoist moves adds two messages, which the bound prices at 128 tokens each before their bytes, so near the budget a hoist can be skipped where it would have fit.
- 0.15.0's entry says what preparation replaced in a request is logged when the request is sent. It's logged when the request is first sent: the retries an L1 attempt makes from a sent request (the no-tools, tools-less and carrier-stripped ones) log nothing again, and a merge retried after a `tool_use` rejection is built from its sources again on a later tick, so what preparation replaced in it is logged again.
- **Upgrading a store from before 0.15.0:** a merge that serialized media pushed past the provider's context limit before 0.15.0 stays quarantined, since a merge quarantine record is keyed by the merge's sources alone. Records with `lastErrorType: 'context_length'` made before 0.15.0 may be such merges: `getMergeQuarantineStatus()` lists every quarantine record with its `lastErrorType`, and `clearMergeQuarantine(key)` clears one, after which the merge is retried with its serialized media replaced where the matcher reads it. A merge whose media this release leaves in the prompt, a data URL past the bounds or a payload wrapped at another width, can be refused on context length and quarantined again; another compression request holding such media can be refused the same way. A compression request whose payload this release ends or replaces differently from 0.15.0 changes its bytes, so it misses the prompt cache once after the upgrade. So does an L1 or merge of a sharded body whose size, quoted in its reading instruction, the new pricing changes, a split part, whose target, quoted in its instruction, now follows what the part sends rather than its text's length, a request whose pinned raw the pins gate now admits differently, and a transition summary request whose head held serialized media, which its markers now replace.

- In the adaptive selection's middle, a run of a sharded body's raw shards,
  which goes out joined into one text block, is now counted as the shards it
  joins, each by the store's estimate of it, as the plan already counted them
  and as the head and recent windows already did. It was counted as the
  joined block, which the store's default estimator prices at the rate its
  first 2,000 characters set, so where the shards' densities differed, the
  middle's count left the plan's. A run whose first 2,000 characters were
  denser than the rest of it was counted over the plan, so a compile whose
  plan fit could refuse with `OverBudgetError` ("Emission overran the plan"),
  and refused again on every compile until the budget or the store changed:
  with an 80,000-character body that opens with 12,000 characters of JSON raw
  in the middle, a compile planned at 28,670 tokens was counted at 34,786. A
  run whose first characters were the lighter was counted under the plan: the
  same characters the other way round, planned at 28,670, were counted at
  27,590. A compile that went out before sends the same bytes; one refused
  this way now goes out.
  - The render stats, which the calibration sample compares with provider
    usage, count such a run at its new price. A store whose recent samples
    had such a body raw in the middle learned its multiplier against the old
    count, and over its next samples the multiplier moves to where the plan's
    own prices put it, as it already did whenever such a body left the
    middle. Until then, a multiplier learned against a count over the plan's
    runs low: when one such body is the whole window, the plan prices that
    store's requests up to about a fifth under what they cost, and a compile
    refused at a budget between the plan and the old count can now go out
    costing up to about a quarter more than its budget. One learned against a
    count under the plan's runs high, so the plan folds more than it needs to,
    as it did before. No calibration epoch starts, since no plan price
    changes: the first compile after the upgrade plans as the last one before
    it did.

- With `compressionToolProseFallback` set, the compression quarantine holds a
  quarantined chunk by its family and by the per-chunk shape cap, as it does
  with the rung off. The gate compared a hash of the rung's options in
  each stored record with a hash of the current ones, and the store gives
  those options back with their keys in another order, so no stored record
  was ever in the current request regime, and only an exact key match held
  the chunk. Where the provider had counted the chunk's request, the key
  never matched either, and every pass that reached the chunk called the
  model for it again, without recording a new exhaustion. Each new shape of
  the request, such as one at a moved recall frontier, was attempted with no
  cap. The options are now compared whatever the order of their keys. With
  the rung on, the cap now holds a chunk after three refused shapes until the
  quarantine is cleared, a switch of compression model included, as with the
  rung off.

## 0.15.0 — 2026-10-16

### Added

- `compile()` returns `provenance` beside the messages. It holds a `compileId`, the
  namespace and branch the compile read (`{id, name, created}`), and one entry per
  compiled message naming what it carries: raw stored bodies (each marked
  `complete`, or listing what is `missing`: content or shards), the
  summaries it renders, a context injection, or other derived content. It also
  holds an immutable rendered layout for strategies that report one. Every
  compile builds it, whether or not the host accepts rounds, at a cost that
  grows with the history the compile reads. The sources
  of a split message repeat on every part. A raw body is judged as stored: its
  id is shard 0's (the id `addMessage` returned), and a shard the view filter
  hid from the strategy counts as missing. A composite that merged a body's
  shards is complete when it carries their text in order and their media
  unaltered, and a tool result that pairing repair moved next to its tool_use
  still counts as carried there. A body is one ingestion: the same text
  ingested twice is two bodies, though a group id (a hash of the content)
  names both. `rawBodies` maps each raw body's head to its stored messages as
  the compile read them (head first, then every shard of that ingestion,
  including any the view filter hid), auxiliary-store messages included.
- Strategies can report their rendered layout. A strategy declares `renderedForms`
  and names the summaries behind derived entries in `ContextEntry.summaries`, with
  `describeRenderedSummaries(ids)` giving each summary's level, covered messages and
  method. `takeSelectionCause()` can explain the last committed selection.
  Passthrough, windowed passthrough and autobiographical (with its subclasses)
  report layouts, and autobiographical marks a summary whose rendered text a cap
  cut as `partial`.
- Fold receipts: `acceptRound({ provenance, usage, presentation })` accepts a
  compile whose provider round succeeded. It compares the layout with the last
  layout accepted on the compile's own branch in its namespace, by any manager
  of that namespace on the store, even when another branch has since been
  selected, over messages present in both. When any message changed form
  (raw, partial raw, summary, a different summary, omitted), it appends a
  receipt naming each changed run's boundaries, forms, summaries and estimated
  tokens. It writes a baseline when the branch has no record, or when its
  newest record can't be read (another format, or a chain that doesn't
  rebuild), which is reported once. Arrivals are not folds.
  - Each acceptance, an unchanged layout included, commits the branch's new
    layout and its receipt as one Chronicle typed record, alongside a
    once-minted store-id record. Typed records are enumerable from any branch
    and survive branch deletion, though each takes the next sequence of the
    branch selected when it is written. The store syncs before the record is
    appended, so the state it names is durable first, and again after, so an
    acceptance is durable before `acceptRound` returns or announces it, or a
    query lists it. Each sync fsyncs the log and the store's metadata, even
    with nothing pending, so every accepted round pays two. A compile is
    accepted once: a retry writes nothing and returns what its first
    acceptance returned (its receipt, or null), whether that acceptance
    reported success or an uncertain failure, ran in another manager on the
    store, or ran before a reopen. The one exception is Chronicle's own: if
    the store's last record rots, open drops it, so a retry writes the
    acceptance again, and the lost record's id goes to the next record. A compile is accepted on
    the manager that compiled it: one of another namespace is refused with
    an error.
  - A layout persists as its members (message sequences, gap-coded, about
    1.3 bytes each) and its units (forms with counts), so a message missing
    from either view is never counted inside a range. An acceptance writes a
    delta on the branch's previous record, holding the members that changed
    and the units from the first that changed to the last, or a snapshot of
    the whole layout once the records since the last snapshot would outweigh
    it, each counted whole, receipt included. So snapshots are amortized
    against the deltas between them, and on average the bytes stored per
    acceptance stay bounded while the deltas do, as when messages arrive
    and a fold changes one stretch of the view. Changes far apart re-send the
    units between them, so a change at each end of a long view re-sends all
    of it. Each snapshot holds the whole view's members, and rebuilding a
    layout reads at most about two snapshots' worth.
  - A use reads the records it needs rather than every record. An
    acceptance reads its branch's newest record and the chain that rebuilds
    its layout. A branch is found by reading back from the store's newest
    record, and every branch met on the way is noted, so the records present
    when the store opened are read at most once, by whichever lookups need
    them; a branch with no record yet, or a deleted branch looked up by
    name, may take that whole read. A compile carries where the journal
    stood (`provenance.journalMark`, a record known durable), so finding an
    earlier acceptance of the same compile reads only the records after it.
    Each record names its branch's previous receipt, so a branch's receipts
    are walked back reading only receipts. Every manager on one store
    object shares what has been read; the first use after the store opens
    lists the records' ids and, when there are any, syncs once, making every
    record present durable.
  - Layouts persist base token estimates, taken before the store's
    calibration, so identical content costs the same in every compile. A
    receipt's estimated token counts apply the calibration its compile
    captured to both sides, and count each summary once per side, in the
    first changed run that names it.
  - `presentation` (`verbatim`, `altered` or `unknown`) records how the
    confirming round carried the compile, as its producer reported.
  - Usage is the confirming round's own, with unreported fields `unknown`.
  - Query with `listFoldReceipts({ afterId, since, limit, branch })`:
    newest first, or with `afterId` (a receipt id) oldest first from just
    after it, so a reader pages forward from the last receipt it got, with
    `more` saying whether there is more, and `afterId: '0'` pages a branch's
    whole record from its start; `since` is an ISO 8601 date, or a date
    and time with its offset (a bare number, or a time without an offset,
    is refused rather than guessed at). `branch` is a name, or a branch as
    receipts name it (`{ id, created }`), which reaches a deleted branch
    even when a live one has taken its name. A query returns its manager's
    namespace's receipts. A history that can't be read whole says so in
    `note`. Label receipts with `setReceiptSource`.
  - Subscribe with `onFoldReceipt`. A listener hears each receipt its
    manager's `acceptRound` returns, and, at that manager's next acceptance
    on a branch, the branch's newest receipt if the manager hasn't announced
    it: one whose write reported a failure, one another manager wrote, or one
    from before a reopen. So it can hear a receipt again, and needn't hear
    every receipt: key on the receipt's id and `compileId` (a receipt lost to
    Chronicle's rot exception can have its id go to a later receipt), and
    read `listFoldReceipts` for the whole record.
  - `getStoreId`, `currentBranchRef` and `describeRenderedForms` support hosts
    that export or explain them.

- A sharded `addMessage` records `shardCount`, its group's size, on every
  shard, and writes the shards in index order, so the id it returns is shard
  0's. Compile provenance counts a group that declared its size as complete
  only when every declared shard is stored and carried. A write that fails
  partway removes the shards it wrote from the store, so a retry writes one
  body. A group left short anyway (a crash mid-write, or a failed write whose
  shards couldn't be removed) is missing `shards`, before or after a reopen,
  even though its members can't be edited. For a group written before sizes
  were declared, `complete` keeps a weaker meaning: every member stored for it
  was carried. That does not prove the group was ever written whole. A
  chunking decision whose indices aren't exactly 0..n-1 is refused before
  anything is written.

### Changed

- The kv-unified hysteresis certificate is on by default for a strategy built
  from a recipe: a `kvUnified` block without `hysteresisCertificate` now takes
  the certified exit, and `hysteresisCertificate: false` restores the full
  solver on every compile. The certificate only skips the full solve when it
  proves the carried layout is what the `adoptEpsilon` rule selects, and
  declines to the full solver on a turn it cannot prove (changed ownership,
  pins or locks, cache churn, a forced budget transition, or a cap), so
  eligibility, adoption and fallback are unchanged; a certified result proves
  the hysteresis policy, not identity with the bucketed solver's pick. The
  solver-level `ParetoSolveOptions` flag keeps its absent-means-off reading.

- A listener added with `onMessage` that throws no longer fails the write
  that emitted its event: the error is logged, the write stands, and the
  other listeners are still told. Before, the write threw after it had
  landed, so a caller that retried wrote it twice, and a sharded
  `addMessage` stopped partway through its body. The log line names the
  message the listener missed. Each `onMessage` call now registers its own
  listener and returns its own unsubscribe, so a function registered twice
  hears each event twice; before, the second registration was ignored, and
  either unsubscribe removed both.

- context-manager builds and typechecks with TypeScript 7 (`^7.0.2`, a devDependency). Built from the same source, the published `.js` is byte-identical to TypeScript 5.9's output; a few `.d.ts` files differ only in the quote style of string-literal types, and source maps differ in their `mappings`. A build now needs TypeScript 7's native compiler for the platform: one of its optional `@typescript/typescript-<os>-<cpu>` packages, which npm installs where TypeScript publishes one. So neither a checkout nor a git dependency's `prepare` builds on a platform with none, and a checkout installed without optional dependencies (`npm ci --omit=optional`) fails in its `prepare` build. A git dependency still builds under an outer `--omit=optional`, since npm installs its dependencies with optional ones included before its `prepare` runs. A build also needs Node 20.10 or later on the 20 line, since Node 20.0 to 20.9 refuses 7's launcher (`ERR_UNKNOWN_FILE_EXTENSION`). Installing the published package is unaffected.

### Fixed

- Compression prompts replace serialized `data:<mime>;base64,…` URLs whose payload has at least 4096 characters with a marker naming the media type and the payload's length. Imported tool output can carry a whole image as text, which the image-byte cap can't see and which is priced as prose: a 1 MiB image is about 1.4 million base64 characters. Text blocks, tool results (string or block array) and a tool call's input (its strings, or the text of arguments that didn't parse) are covered. MIME parameters before `;base64`, JSON escapes (escaped slashes however many times the text was serialized, `\u` escapes in the type and in parameter values, and escapes inside the payload such as wrapped lines) and any letter case are matched. Bare base64 isn't, nor is a data URL with a parameter value holding a quote, a backslash other than a `\u` escape, or (unquoted) a colon. Chronicle content is never changed.
- Every compression request is prepared the same way before its admission, hash and dispatch: canonical and source-only L1 requests, recall-curve fallbacks, split parts, the tool-prose rewrite and the no-tools retries, merges and transition summaries. A request gets its own message wrappers and copies of what preparation changes, so preparing one never edits a stored message or another request, and preparing a prepared request changes nothing. Recall-curve fallbacks are built from the unprepared answers and prepared on their own, so a parent answer carrying a data URL keeps its fallback, and the children's answers are prepared too.
- A block that preparation edits gives up its replay form (`rawXml`, `rawItem`), and so do the blocks in its message that share one with it and a reasoning item paired with it, so the old payload can't be replayed in place of the marker. Other blocks keep their identities and replay forms.
- The compression image cap counts every inline image block a prompt can carry: a base64 source, a `data:` URL source, and a `data` field beside `mimeType`, as MCP image blocks in tool results and generated images have. Generated images are now capped too. The live window's image strip is unchanged.
- What preparation replaced in a request is logged when the request is sent, naming it: one line counts the data URLs replaced, and the image cap's line states its inline image budget and what it kept, in MiB.

- The canonical L1 compression prompt shows a message a pin keeps raw as raw, as the live view does, where the pins fit its budgets (next item); it used to recall the summary covering it. A frontier summary that covers such a message is descended rather than recalled: its children take its place, so only the branch holding the pin opens, sibling branches stay recall pairs, and the raw a pin adds is its own L1 chunk. An opened chunk renders raw wherever it lies before the chunk being compressed, including before the head window. The head window always comes first; after it, recall pairs and raw messages go in source order, so the summarizer doesn't read old turns as coming after later memories. Empty-content frontier summaries above L1 are descended the same way, and an empty L1 that holds no pin stays covered, as before. Only opened chunks lose coverage: a merged L1 that its parent doesn't list stays covered, as before, unless a pin opens it. Only pins before the chunk being compressed count, so a summary after it is recalled as before. Merge recall, L3+ merge inputs and transition summaries do not consult pins, and the source-only L1 shows no history for them to change.
- An L1 prompt shows pinned history raw only when it fits. The raw that pins add is spent from `compressionRecallBudgetTokens` first, and recall pairs get the rest, oldest dropped first as before. The request with it must also fit `compressionContextBudgetTokens`, priced as the message store prices the messages it would send, with the system prompt, tools and output reserve. When either fails, that compression lays history out as it would without pins: it recalls the summaries the pins override, and pinned history before the head window that no summary covers is left out, as before. A warning and a `compression:pinned-raw-over-budget` log event name the pins, the sizes and the limit. Waiting instead would stall every later L1, since the pinned history precedes each of them. The live view still shows the pins raw, and a canonical request without pins is still always attempted. A compression's warnings, this one and those for head ownership and the recall cap, are logged once it goes ahead, after the deferral for missing tool definitions, the quarantine skip and in-flight coalescing.
- A pin resolves once, for compression, chunking and every selector (the strategy's `resolvedPinBounds`). Level bounds are read only under `foldingStrategy: 'kv-stable'` and `'kv-unified'` with `adaptiveResolution`, with kv-stable's precedence: where pins overlap at a message, a bound takes a classic pin's place, `level` takes `maxLevel`'s, and the lowest of each kind wins; a level or cap of 0 is raw. Under every other selector a pinned message is raw, as `pinAtLevel` documents, so the flat-profile and oldest-first folders no longer fold a message pinned with a level. Picker chunks carry one reading: a raw pin, a level or cap of 0 included, is `pinned`, so kv-unified no longer asks for an L1 of a chunk pinned at level 0, and `pinLevel` and `pinMaxLevel` are set only above 0. kv-unified's constraint source for such a chunk is now `raw-pin` (it was `classic-pin`). Under kv-unified, a `level` and a `maxLevel` that overlap no longer conflict: the `level` applies, as under kv-stable. Under kv-stable and kv-unified, a message pinned at a level or cap above 0 before it was compressed is now compressed, since only a summary can supply its level; before, the chunker skipped every pinned message, so no summary ever covered it. Under kv-unified, a pinned level on a message between the head window and the recent window that no summary supplies yet is a constraint conflict, and every compile fails until one does, as before. A message pinned that way before this change, whose neighbours have since been compressed and merged, gets an L1 of its own that nothing merges, so kv-stable renders it at L1, while kv-unified's compiles keep failing, as before.

- A store holding a summary whose `sourceIds` is null no longer throws on every compile under adaptive resolution. Opening a store now repairs summaries whose text, sources or range readers can't use: empty text, sources that aren't a list of ids (null, a string, an empty list, or a list holding something other than ids), or a range that isn't two ids. An L1 with unreadable sources takes them from the compressed chunk record that names it, as that record now names them, or else from another copy of itself, and its range is always its sources' ends; a summary above L1 takes sources and range together from another copy. Copies of one id keep the text of a non-empty copy, preferring one whose pointer names a summary above it that lists it. A summary's parent is the first pointer on any of its copies, `parentId` before `mergedInto`, that names a kept summary listing it among its sources; without one, it is the kept summary one level up that lists it, when exactly one does. `mergedInto` is set to that parent, and so is a `parentId` naming anything else. A summary that can't be recovered is dropped, and so is every summary above it that names a summary no longer in the store, including one an earlier version dropped: on upgrade, a store where an earlier version dropped an empty summary loses the summaries above it from its active summaries once, and their surviving sources merge again. A summary that names one at its own level or above is dropped too, since no merge writes one, and two such summaries can cover each other's messages. A parent pointer that names no such parent is cleared, and a null one counts as none. Chunk records whose L1 is gone are reopened, and queued merges naming a missing summary are removed. The repair is persisted, so a second open changes nothing, also when the store is opened with `auditOnly`; its log line names the summaries dropped, for each reason, those rebuilt, those given a parent and those whose parent pointers it cleared. When the live lookup finds an L1 that another instance wrote after this one loaded, this instance reloads the store's summaries, repaired as an open repairs them, so it holds the L1 with the summaries above it. The open's topology audit doesn't run on that reload, as it didn't when the lookup adopted the L1 alone. Adopting the L1 alone left its parent pointer naming a summary this instance didn't hold, which kv-unified's canonical forest refused on every compile (#176). A message whose saved fold level names a summary that is gone is planned from the deepest summary still over it at or below that level, so the solvers fold it to its surviving L1 instead of rendering it raw. The next compile that commits saves the level it presented, except for a locked message, which keeps its saved level. Where the budget can't hold the summaries still over such messages, a compile is refused as over budget, as for any store whose summaries outgrow its budget. Under kv-unified, a range pinned at a level that only a dropped summary supplied is refused as infeasible instead, whatever the budget; releasing the pin, or pinning the range at a level its surviving summaries supply, lets it compile.

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
