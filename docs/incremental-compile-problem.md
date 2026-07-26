# Compile cost scales with store size, not with what changed

**Status:** problem statement + design directions. Not a plan; nothing here is
decided, and the first action item is profiling rather than building.

**Written:** 2026-07-26, from black-box measurements taken while deploying the
context-settings panel. All timings are end-to-end HTTP against
`/debug/context` (which is `framework.previewActivation` — a real compile).
**Nobody has profiled the inside of a compile yet.** Treat every attribution
below as a hypothesis with a named way to test it.

---

## 1. The problem in one line

Every turn recompiles the whole context from the whole store. Cost therefore
grows with an agent's lifetime, monotonically and without bound, even when the
turn added one message to a context whose shape is otherwise identical.

That is the opposite of what the rest of the design wants. `kv-stable` exists
precisely because the *rendered prefix* is supposed to be stable turn over turn
(`docs/kv-stable-context-control.md`). If the output is nearly identical, the
work to produce it should be nearly zero. Today it is nearly full.

## 2. Measurements

Constant hardware (Mac Studio), six live agents, warm (second request):

| agent  | chunks | messages | tokens | compile |
|--------|-------:|---------:|-------:|--------:|
| aria   |     14 |      233 |   44 k |  0.04 s |
| tilde  |    181 |    2 699 |  980 k |  0.37 s |
| mica   |    226 |    4 124 | 1.21 M |  0.20 s |
| cairn  |    461 |    8 841 | 1.64 M |  0.78 s |
| lena   |    404 |    9 336 | 1.63 M |  0.23 s |
| sol    |  1 400 |   23 906 | 6.25 M |  4.22 s |

Production (Mythos, VPS):

| | value |
|---|---|
| messages / chunks | 14 279 / 800 |
| tokens across chunks | 2.81 M |
| **warm compile** | **22.5 s** (22.90, 22.44 — very repeatable) |
| CPU vs the Mac | **3.5× slower** (Haswell vCPU; alloc-heavy work 4–5× worse) |
| load average | 0.23 — not contention |

Normalising Mythos for hardware gives ~6.4 s local-equivalent for 14 279
messages, against Sol's 4.22 s for 23 906. So Mythos is ~2.5× worse per message
than Sol — real, but second-order. **The dominant term is simply "large store on
a slow box."**

Note the variance that makes single-point extrapolation useless: Cairn (8 841
msgs) takes 0.78 s while Lena (9 336 msgs) takes 0.23 s. Nearly identical scale,
3.4× apart. Something other than message count dominates and we do not yet know
what.

## 3. Why it matters

- **Latency floor.** 22.5 s of local CPU per turn before a single token of
  inference. Compounds with the known TTFT-grows-with-context effect.
- **It blocks the event loop.** `select()` is fully synchronous, so for those
  22.5 s the agent does nothing else — no heartbeat, no Discord, no MCPL. An
  agent under load is an agent that is intermittently absent.
- **It gets worse forever.** Nothing about the current design bends the curve;
  every agent is on a slow slide toward unusability as it accumulates history.
- **It taxes everything built on compile.** The new dry-run preview
  (`previewContext`) costs ~8 s on Mythos for exactly this reason, which makes a
  what-if UI feel broken and discourages the operator from checking before
  applying a budget change.

## 4. Where the cost plausibly is

Read from the code, not measured. Each needs confirming.

1. **`select()` unconditionally calls `rebuildChunks(store)`**
   (`autobiographical.ts:7492`). That clears `this.chunks` and
   `this.compressionQueue`, builds a `Map` of **every message in the store** by
   id, then walks every `chunkRecord` re-materialising its members from
   `sourceIds`. Pure re-derivation of state that changed by one message.
2. **`store.getAll()`** materialises the full message set. `1dc0104` memoised
   this by `(branch, head sequence)`, so it should be warm — but the memo is
   invalidated by *any* mutation, including unrelated state writes, and a turn
   always mutates.
3. **The picker's input is per-message, not per-chunk.** `pickerChunks.length`
   ≈ message count (14 279 on Mythos, vs 800 chunks). If the fold unit is really
   the chunk, the solver may be doing ~18× the necessary work.
4. **Blob / media resolution.** Mythos carries images. `80a5411` added a
   content-addressed blob cache for exactly this class of cost, and the
   `/curve` handler carries an explicit warning that resolving historical blobs
   can expand a Chronicle into gigabytes of heap.
5. **The kv-stable oscillation, Mythos-specific.** Every compile logs
   `[kv-stable] non-converging fold walk: op raise:L4-936 emitted >8 times —
   target frontier cuts through a group (ownership drift after store surgery?)`.
   The `887a90d` cycle guard bounds it, but the walk still burns the iterations
   before giving up, and the affected chunk never reaches its target level. This
   is the leading candidate for Mythos's ~2.5× residual **and** for why Mythos
   cannot fold under its own budget (it compiles to 292 166 against 283 616
   usable, surviving only on `overBudgetGraceRatio: 0.35`).

### Ruled out

So nobody re-treads these:

- **Chunk fragmentation.** Mythos averages 3 511 tokens/chunk, 780 of 800 chunks
  above 3 000. Healthy.
- **Folding strategy.** All six local agents and Mythos run `kv-stable`.
- **Tail size.** Sol runs a 200 k tail and is fast.
- **CPU contention.** Load 0.23.
- **Simple quadratic-in-messages.** Sol has 1.7× Mythos's messages and is faster
  after hardware normalisation. (An earlier version of this analysis claimed
  quadratic on the strength of a Cairn-only extrapolation. That was wrong —
  see the Cairn/Lena variance above.)

## 5. The principle

> Compile cost should scale with **what changed since the last compile**, not
> with the size of the store.

The happy path — one message appended, frontier unchanged — should be O(appended
tokens), not O(history). A cold start may pay O(store) once.

## 6. Design directions

Sketches, with the objection to each. Not mutually exclusive.

**A. Cache the derived chunk index.**
Key `chunks` / `chunkRecords` materialisation on `(branch, head sequence)` and
apply appends incrementally instead of rebuilding. Precedent: `1dc0104` did this
for message materialisation.
*Objection:* `rebuildChunks` is also the repair path — it re-derives truth after
store surgery, branch switches and record rewrites. Caching it means being able
to say precisely when the derivation is stale. Getting that wrong reintroduces
the ownership-drift class of bug rather than fixing it.

**B. Make the picker operate on chunks, not messages.**
If the fold unit is the chunk, an ~18× smaller solver input on Mythos.
*Objection:* head/tail windows are message-granular, and pins/locks are
per-message. The per-message representation may be load-bearing for exactly
those. Needs a read of `PickerInputs` semantics before believing the 18×.

**C. Incremental render — the big one.**
When the frontier is unchanged, reuse the previously rendered entries and splice
only the new tail. This is *already the premise of kv-stable*: if the prefix is
byte-stable for cache purposes, it is byte-stable for reuse purposes too.
*Objection:* the coverage invariant (`d3fc1f7`, "no message is ever dropped —
emit within grace or refuse") is currently enforced by a whole-context walk. An
incremental renderer must prove coverage without re-walking, or the invariant
weakens from checked to assumed — and that invariant exists because silent
middle-loss actually happened.

**D. Get compile off the event loop.**
Doesn't reduce cost; removes the "agent is absent for 22 s" symptom.
*Objection:* Chronicle is a native module; worker-thread safety is unknown, and
the store is shared with sibling instances (`8f681af`). Probably the wrong first
move — it hides the problem and adds a concurrency surface.

**E. Amortise.**
Cap recomputation per turn and spread the rest across turns.
*Objection:* makes latency unpredictable rather than lower, and interacts badly
with the paced-descent transition machinery, which already spreads work over
compiles.

## 7. What to do first — profile, don't build

Every number above is black-box. Before choosing a direction, get a per-phase
breakdown of one Mythos compile:

1. `store.getAll()` materialisation (cold vs warm)
2. `rebuildChunks` — and how much is the by-id `Map` vs record re-materialisation
3. blob/media resolution
4. picker `solve()` + fold walk, with iteration counts
5. entry emission / render
6. *(excluded from the agent path)* membrane normalisation and JSON
   serialisation — `/debug/context` returns 2.7 MB of JSON, which inflates the
   HTTP timings above relative to what a turn actually pays. **The agent path
   does not serialise to JSON, so the real per-turn number is lower than 22.5 s
   and is not yet known.**

`KV_TIMING` already exists (`src/adaptive/kv-control.ts:290,376,719`) and may
cover part of (4).

Two cheap experiments alongside:

- **Is the oscillation the residual?** Pin or lock the chunk behind `L4-936`,
  recompile, compare. If Mythos's time drops toward Sol-normalised, the
  oscillation is the residual and is worth fixing on its own merits.
- **Is media the residual?** Compare a compile on an image-heavy store against a
  text-only store of matched message count.

## 8. Constraints any fix must respect

1. **Coverage invariant** — a compile refuses rather than shipping a context with
   unrepresented messages (`d3fc1f7`, `76e95a0`).
2. **KV stability** — the rendered prefix must stay byte-stable; an optimisation
   that perturbs it trades local CPU for provider-side cache invalidation, which
   is the more expensive resource.
3. **Branch- and sibling-safety** — caches key on `(branch, head sequence)`.
   An instance-local version counter was tried and broke multi-instance sharing
   (`8f681af`, and the comment it left in `message-store.ts`).
4. **Dry-run stays non-committing** — `previewContext` must not persist
   resolutions, enqueue compression, or advance transition bookkeeping.
   *Caveat:* it currently calls `select()`, which calls `rebuildChunks`, which
   mutates in-memory `chunks` / `compressionQueue`. That is idempotent against
   persisted records, so it is believed safe — but it is asserted, not tested,
   and an incremental-compile change would alter the reasoning.

## 9. Profiling results (2026-07-26, evening) — the hypotheses, ranked

The profiling in §7 has now been done: `scripts/profile-compile.ts` (real
`ContextManager.compile()` over a store copy, production Mythos config:
budget 300k / reserve 16 384 / tail 80k, mock membrane, no compression) run
under `node --cpu-prof` **on the Mythos box itself** against an on-box copy,
plus matched runs on Cairn and Lena copies on the Mac.
Analyzer: `scripts/analyze-cpuprofile.mjs`.

**Headline: the warm agent-path compile on Mythos is ~4.6 s, not 22.5 s.**
The HTTP number bundles membrane normalization + 2.7 MB JSON serialization
(§7 item 6 was right to exclude them; the ~18 s delta is that leg, not yet
itself broken down). Still 4.6 s of synchronous event-loop block per turn.

Warm-compile breakdown, Mythos box (~4.6 s total; self-time from cpuprofile
averaged over 3 warm runs + method wall timers):

| cost | ms/compile | hypothesis |
|---|---:|---|
| `projectToValidCut` (kv-control) | **~3 100** | #5 — the dominant term |
| `postStripEstimates` — called **4×/compile** | ~510 | (new) |
| `relevanceCut` + ledger init | ~630 | #3 |
| `rebuildChunks` | ~330 | #1 |
| `applyImageStripping` | ~230 | #4 (window leg) |
| `getCompressibleMessages` | ~210 | #1 |

- **Hypothesis #5 (oscillation) confirmed as the mechanism, magnified by #3
  (per-message picker input).** Every Mythos compile logs the `raise:L4-936`
  non-convergence and runs `iterations=18` of the fold walk (Cairn/Lena:
  `iterations=0`). Each iteration's `suffixAdopt` binary-searches boundaries,
  and every probe calls `projectToValidCut` — which per pass sorts all ~14.3k
  picker chunks and scans every leaf of each folded leaf's ancestor group
  (L4 groups span ~1.7k messages → O(N·groupSize) per pass). That product is
  the 3.1 s.
- **Hypothesis #2 (getAll memo) is stale as written**: materialization is now
  per-stateId write-versioned with write-through on append
  (`message-store.ts:31,283`), and warm compiles hit it. The cost is real but
  lives at **open(): ~18 s on the box** — `resolveBlobs`/`cachedBlobBase64`
  8.3 s (hypothesis #4's real home: 5.2 G blob dir), `loadPersistedState` 6 s,
  `getAllInternal` 4.7 s. Paid per boot and per cache invalidation
  (edit/remove/branch switch), not per turn.
- **New finding: `postStripEstimates` runs 4× per compile** (selectAdaptive +
  `getRecentWindowStart` call sites), each a full O(store) token re-estimation
  — ~0.5 s/compile on Mythos.
- **The Cairn/Lena 3.4× mystery does not reproduce** at matched config: both
  compile in ~250 ms warm on the Mac (Cairn's hot spot `projectToValidCut`,
  Lena's the fold ledger). The §2 variance was live-config/serialization
  artifact, not store structure. Single-point HTTP timings of `/debug/context`
  should not be trusted for attribution again.
- RSS grows ~50–80 MB per repeated compile in the harness (unbounded-heap
  leg of §5, not yet chased); process RSS ~2 GB with the Mythos store open.

Implications for §6, in order of measured leverage:

1. **Fix the L4-936 oscillation** (ownership drift repair, or pin the group)
   — removes ~18× fold-walk iterations; likely the bulk of the 3.1 s.
2. **Make `projectToValidCut` incremental** — visit only groups whose leaves
   changed, keep a per-group consistency count instead of re-scanning every
   leaf every pass; removes the O(N·groupSize·passes) shape that any future
   oscillation re-triggers.
3. **Cache `postStripEstimates`** (stamp per-message estimates, invalidate on
   calibration change) — ~0.5 s/compile, easy.
4. Direction B (settled zone / chunk-level picker input) then bounds the
   whole pipeline as stores grow; A (event-maintained chunk index) is real
   but third-order per-turn (~0.3 s).
5. The open()-time blob resolution (~8 s/boot on Mythos) deserves its own
   ticket: lazy blob resolution would also cut the ~2 GB RSS.

### 9.1 The oscillation, root-caused (same evening)

Diagnosed offline with `scripts/diagnose-oscillation.ts` (captures the live
solve's `PickerInputs` + target from a store copy) and
`scripts/replay-plan.ts` + `KV_DIAG_GROUP` stage histograms in `kv-control.ts`
(replays `planControlledFrontier` bit-exactly: 14 316/14 316 resolutions match).

**It is not ownership drift and not store surgery** (the guard's guess — both
membership views agree for every oscillating chunk). It is the **V2 leveled-pin
feature meeting the group-atomic op walk**:

1. The store carries 8 operator pins inside one era: `pin(level:4)` over
   msgs 22799–23255, six `pin(level:3)` ranges, one `pin(level:1)`.
2. `KvStableStrategy.solve()` expands `pin(level:4)` group-consistently to its
   whole L4 node — **all 4 203 leaves of `L4-936` become `fixedLevels`**, the
   finer pins winning inside their sub-ranges: 3 217 @ L4, 960 @ L3, 26 @ L1.
3. The plan is *correct*: it honors every pin (branch `adopt-ideal`, tokens
   258 847 — comfortably under the 283 616 budget). The target legitimately
   cuts through `L4-936`; rendering supports that (per-leaf units).
4. The walk cannot realize it: `nextOp` doesn't skip leveled-pin chunks (only
   classic `pinned`/locked), and `applyRaise`/`applyLower` move the **whole**
   downward leaf set, blind to `pinLevel`/`fixedLevels`. Raising for a
   tgt-4 leaf drags the pin-3/pin-1 leaves to 4; the pin-1 leaf then emits
   `lower:L4-936`, dragging the 3 217 tgt-4 leaves back down. 8× raise + 8×
   lower until the cycle guard trips both keys.
5. Consequence: the pinned cut is never realized — the group renders at the
   nearest realizable frontier (~L3), 295 527 actual vs 258 847 planned →
   **the entire "Mythos can't fold under its own budget / exhausted +
   grace-survival" symptom is this bug**, on top of the wasted iterations.

Fleet-wide implication: **any leveled pin placed under an existing deeper
ancestor summary reproduces this** — it is a live bug in the op layer, not
Mythos-specific data damage. The 07-25 outage that motivated the cycle guard
(`b44819a`) was almost certainly the same mechanism firing unbounded.

**FIXED (same night, branch `refactor/retire-fold-walk`): the walk was
removed entirely** — the protocol is now `FoldingSolver.solve() → frontier`,
applied directly by the picker with loud validation (`[picker-unrealizable]`,
`[picker-dead-ids]`); greedy strategies iterate internally
(`greedy-fold.ts`). Verified on a copy of this exact store: no oscillation,
plan applied bit-exactly (`moves=6453` once, then 0), **295 527 → 258 847
tokens (in band — the exhausted/grace symptom gone)**, warm compile
770 ms on the Mac vs a pre-fix Mac-equivalent ~1.3 s — the wedged carried
state was also inflating the solve itself (cut-projection 350→64 ms,
relevanceCut 600→95 ms). Cairn/Lena plans bit-identical before/after.
Regression fixtures: `test/adaptive/mixed-cut-application.test.ts`.
Note for deploy: the first compile on Mythos realizes the pinned cut — a
one-time KV invalidation of that era (plan perturbation ~248 k tokens).

### 9.2 Post-deploy measurements (2026-07-26 ~21:00Z, Mythos live)

Deployed to Mythos (`9679e2d` on main; pull + tsc + idle restart 20:59Z).
First live compile realized the pinned cut (`moves=3217`, one-time), then
steady state: **`planned=actual=253766 budgetMet=true exhausted=false
moves=0`** — the over-budget/grace wedge is gone on the live agent.

Timing, same-day before/after on the live process:

| instrument | pre-deploy | post-deploy |
|---|---:|---:|
| `/debug/context` warm | 26.9–28.2 s | 29–34 s (unchanged) |
| `/debug/context/makeup` | — | 27–32 s (≈ same as full) |
| dedicated-process warm compile (harness, on box) | 4.6 s | **3.8 s** |

The endpoint timings did NOT improve because they never measured compile:
log-growth polling during a timed probe shows the compile's own log lines
landing at the very END of a ~32 s request — the ~30 s is spent BEFORE/
inside `select()`, and `makeup` (no big JSON) costs the same as the full
endpoint. Given the dedicated process pays 29 s at open() (blob resolution
+ materialization) and 3.8 s per warm compile, the live process is paying
**cold materialization on every preview** — its `getAll()` cache is not
staying warm between requests. This also explains why the original 22.5 s
was "very repeatable," and it plausibly applies to real turns as well.

**Next dominant target, in order:**
1. Why the live process's message-materialization cache goes cold between
   compiles (sibling-instance write-version bumps? a second MessageStore
   over the same chronicle in-process? preview-specific view churn?) —
   worth ~25 s/request on Mythos hardware.
2. `postStripEstimates` ×4/compile (~0.5 s), `rebuildChunks` per
   `onNewMessage` (§9), image-strip scans — the residual 3.8 s.
3. Lazy blob resolution (open() 29 s, ~2 GB RSS).

## 10. Related

- `docs/kv-stable-context-control.md` — prefix-stability goal
- `docs/adaptive-resolution-design.md` §13 — picker / trust region
- `887a90d` — kv-stable fold-walk oscillation guard + quadratic ingest fix
- `1dc0104` — message-store materialisation memo, the nearest precedent
- `8f681af` — sibling-instance freshness; why caches key on head sequence
- `80a5411` — content-addressed blob cache
- `d3fc1f7` / `76e95a0` — the coverage invariant
