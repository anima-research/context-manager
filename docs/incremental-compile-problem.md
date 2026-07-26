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

## 9. Related

- `docs/kv-stable-context-control.md` — prefix-stability goal
- `docs/adaptive-resolution-design.md` §13 — picker / trust region
- `887a90d` — kv-stable fold-walk oscillation guard + quadratic ingest fix
- `1dc0104` — message-store materialisation memo, the nearest precedent
- `8f681af` — sibling-instance freshness; why caches key on head sequence
- `80a5411` — content-addressed blob cache
- `d3fc1f7` / `76e95a0` — the coverage invariant
