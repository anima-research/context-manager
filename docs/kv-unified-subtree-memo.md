# kv-unified: banded ages and the subtree-memoized engine

**Status:** implemented (`src/adaptive/kv-unified-subtree.ts`,
`policy.ageBandSteps`), on by default for a strategy built from a recipe.
Written 2026-10-18 against the measurements in §5. Closes the solver leg of
`incremental-compile-problem.md` (#45): after its §9.3 fixes, the one term of
a compile that still grew with the store was the kv-unified solve.

## 1. Why a solve could not reuse anything

The DAG engines (`kv-unified-pareto.ts` `solveDag`, `kv-unified-packed.ts`)
walk the ownership forest root by root and label by label. Everything they
accumulate is additive over leaves, and the forest's summary objects are
shared across compiles by `CanonicalSummaryForest.derive`, so a subtree that
nothing touched could in principle contribute the same thing it contributed
last turn. Nothing could be kept, though, because the per-leaf weights
themselves moved on every append:

- fidelity prices a leaf at `salience · age^(−α) · rawTokens`, with the age
  counted in sequences from the newest leaf (`fidelityLeafBase`);
- continuity decays with the token distance from the live edge (recency) and
  with the turns since the leaf last moved (stability)
  (`continuityLeafBase`).

Append one message and every leaf's age, recency and stability change, so
every subtree's contribution changes, so the whole forest is solved again.
That is the "cost scales with store size" of #45 in its remaining form: not
an accident of the implementation but a property of the objective.

## 2. Banded ages (`policy.ageBandSteps`)

`bandedAge(age, steps)` reads an age at the lower edge of the geometric band
it falls in, with `steps` bands per doubling: `2^(floor(log2(age)·steps)/steps)`.
A weight then changes only when its age crosses a band edge, O(log lifetime)
times per leaf, and the deep past stops changing.

Three ages are read through it, with two adjustments found in §5.2:

| age | read as | why |
|---|---|---|
| fidelity age (sequences) | banded at `steps` per doubling | the weight moves by at most `2^(α/steps)` per edge (12.5% at α 0.7, 4 steps) |
| recency (tokens from the live edge) | banded at `steps`; the floor from 8 half-lives out | past 8 half-lives the decayed share is < 2^-8 of the range, and every band edge there re-priced the old history for less than that |
| stability (turns since the leaf moved) | 1 for the first half half-life after a move, then whole doublings | a move resets this for its whole region at once; finer bands re-priced that region on each of its next turns (§5.2) |

The strategy built from a recipe fills in `ageBandSteps: 4` (a band is a
factor of 2^(1/4) ≈ 1.19 wide); `policy.ageBandSteps: 0` restores exact
ages. The solver-level policy default stays exact, so direct solver callers
and the oracle tests are unchanged. Every engine, the oracle, the terminal
evaluator and the certificate read ages through the same two policy
functions, so they stay consistent with each other.

This is a change to the policy the solver optimizes, the same kind of
approximation as the 10k/50k/100k label buckets (a stepwise reading of a
smooth preference), and it is the one part of this work that is not
bit-exact with what came before.

## 3. The subtree-memoized engine

`SubtreeMemoSolver` is the DAG engines' select/expand walk with one change:
what a summary subtree contributes to a label is computed once per summary
object and kept.

**Deltas.** A label's state is (tokens, extension, continuity, fidelity,
cache state, trace). For a label whose provider-cache prefix has already
broken, taking it through a subtree adds amounts that do not depend on the
label: the subtree's *delta set* is the set of labels its walk produces from
a zero label, pruned on the same grid the DAG engines use. Combining a label
with a subtree is then `label ⊕ delta` for each delta, pruned again at the
parent. The composition is exact Pareto algebra: with no grid the
nondominated set of a sum is the pruned Minkowski sum, so the engine's
terminal set equals the object engine's (test
`the subtree engine matches the object engine exactly without a grid`).
With a grid it is the same bucketed approximation, the same representatives
per cell and the same envelope accounting, placed from each subtree's origin
instead of the prefix's, so the retained candidates can differ within the
reported error bound (test `stays within the reported bound of the oracle`).

**The intact label.** At most one label enters a subtree with its cache
prefix intact (the one that followed the receipt), and its deviations inside
the subtree are the intact path composed with the children's broken-entry
sets. On a chronological forest its delta set is memoized too, keyed by the
receipt units over the span and the entry unit (units before a span's first
leaf are fixed once the prefix is intact, so the key is well defined). On a
forest with gap-bearing ownership or internal protected holes the intact
label is walked directly with the DAG engines' buffered emissions
(`pending`, flushed at chronological boundaries) and hole restrictions, and
composes with the memoized broken sets at every child. Those forests are the
common case on real stores (the resident store copy carries two gap-bearing L2s), so
the engine runs on every forest; `engine: 'dag'` asks for the packed engine.

**Memo validity.** The memo lives in the solve's reuse holder
(`KvUnifiedReuse.subtree`), a `Map` keyed by summary id, so it survives a
full forest build (which makes new objects for unchanged summaries; a
forest with gap-bearing ownership is rebuilt on every summary arrival). A
solve without a holder uses a module-level `WeakMap` keyed by the summary
object instead. A latent-demand what-if starts from a copy of the live
holder's map and keeps its own, which goes with its holder when the
candidate is gone; a holder carried to the next compile starts again from
the live map as it is then, so it never recomputes a subtree the live solve
just did. An entry is valid while its *structure* (the summary's
level, recall cost, owned leaves and children, composed with every
descendant's, since a parent's sets are built from its children's), its
*solve key* (policy terms that enter propagation, the grid, the wall,
cache relevance, whether a presentation exists) and the *span hash* match; a reused set whose computation
needed more labels than the solve's ceiling allows is refused the way a
fresh computation would be. The structure is two independent 32-bit lanes
with the recall cost's float words entering each whole, and an entry
rebound to a new summary object after a full build also compares the
summary's own level, recall cost and child count exactly. The span hash is two 32-bit
lanes of a position-mixed hash over everything a delta reads from a leaf
(fidelity and continuity bases, accepted level and whether it still matches,
the allowed-level list, raw tokens, and the zone through what it sets: the
allowed-level list and the externally-accounted flag), kept as xor prefix arrays so a span's
hash is O(1); the per-solve preparation that fills them is one O(N) pass
with a small constant (~0.4 µs per leaf). At the end of a solve the memo
drops the ids of summaries no longer in the forest.

**Ceiling.** A subtree's sets are pruned against the wall from the
subtree's own origin, so a forest whose prefix fills most of the wall can
need more labels than the ceiling where the packed engine, pruning from
the absolute prefix, needs few (twelve L1 pairs under a 9,950-token head
and a 10,000 wall, no grid: the packed engine peaks at one label, the
subtree engine passes 1,000). With `engine: 'auto'` (the default) such a
solve runs once more on the packed engine and the stats say so
(`ceilingFallback`); `engine: 'subtree'` reports the ceiling instead. The
fallback still drops departed ids from the memo and reports the sets the
engine computed and reused before it gave up. A composition is pruned as
it grows: the product of the incoming labels and a summary's deltas is
pruned every time it passes the ceiling, so the labels held at once stay
within the ceiling plus one label's expansion (`peakTemporaryLabels`)
where two sets of ten thousand would otherwise be a hundred million
labels in memory before the ceiling was asked. Production grids keep the
per-origin cell count small, and the real-store replay never came near it.

**Stats.** `ParetoKvUnifiedPolicySolver.lastSubtreeStats` and
`KvUnifiedTimings.subtree` report the delta sets a solve computed and the
sets it read that an earlier solve computed. Propagation counters are
charged on reuse as well, so a solve reports the counts of the same solve
done cold and a certified-vs-uncertified comparison still deep-equals.
`KVU_SUBTREE_DIAG=1` prints per-level counts, label totals, composition
pairs and time, and which per-leaf arrays changed since the previous solve.

## 4. What still costs O(N) per compile

- the preparation pass (bases, hashes): ~10 ms at 25k leaves;
- the terminal evaluator's construction and the lazy refinement of the
  candidates the selection needs (`candidate()` walks a whole frontier);
- the strategy's own per-message passes before the solve (post-strip
  estimates, chunk rebuild, picker inputs), each a linear scan with a small
  constant and most already memoized on the listing.

None of these grows with a heavy constant; the term #45 was about was the
solve, and that now follows what changed.

## 5. Measurements

### 5.1 Synthetic (`scratch-kvu/turns-memo.mjs`)

5M raw tokens, 25k leaves in L1s of ~16 and 4-ary merges to L6, head 4k,
tail 100k, wall 300k, resident policy and 50k/50k/100k buckets; 20 turns of
2k-token appends with a synthetic summarizer; one `reuse` holder across turns
(the strategy's path). Turn 0 is cold; turn 1 is the cold-to-warm rewrite
the earlier campaign noted.

| configuration | warm mean ms (turns 1–20) | max |
|---|---:|---:|
| packed DAG, exact ages | 140 | 242 |
| packed DAG, 4 bands | 158 (156 on the review rerun) | 250 |
| subtree, 4 bands | 94 | 172 |
| subtree, 4 bands, after review | 72 | 141 |
| subtree, 4 bands, certificate on | 131 | 245 |

Before the review fixes, warm turns with nothing but an append settled at 75–85 ms, with ~200 of
~2,270 delta sets computed and ~250 reused (the rest are reached only
through a parent that was reused whole). The remaining time is §4's floor
plus the spine: the ancestors of the newest leaf are recomputed every turn,
and each is a fold over its children's sets.

### 5.2 What the measurements changed

- Stability read at doublings of tau invalidated a moved cohort at tau = 1,
  2, 4, 8 and 16 (five times in sixteen turns after a move); the first half
  half-life is now read as 1.
- Recency band edges past 8 half-lives re-priced the deep history for a
  weight change below 2^-8 of the range; it is now the floor there.
- The tail units were rebuilt per final label and a subtree's span looked
  up a leaf per leaf per visit; both were the first profile's top entries.
- The solve result was built by spreading the selectively scored result,
  which ran its lazy `candidates` getter and dropped its non-enumerable
  `bestScoreUnder`: every terminal candidate was scored on every solve.
  Building the result as the packed engine does (review) took the warm
  mean from 94 to 72 ms; after that the terminal evaluation is the bound
  scoring the packed engine pays too.

### 5.3 Real store (`scratch-kvu/kr-replay-memo.mjs`)

The resident store capture (16.8k leaves, 8.66M raw tokens, 835 summaries, gap-bearing
ownership), replayed over its last 600 messages in steps of 4 with each
summary admitted at its recorded time, no latent demand, one holder per
variant; 150 steps, solve time of the trajectory-driving solve.

| configuration | mean ms | p50 | p90 | max |
|---|---:|---:|---:|---:|
| packed DAG, exact ages | 41 | 37 | 52 | 122 |
| packed DAG, 4 bands | 48 | 44 | 62 | 133 |
| subtree, 4 bands | 38 | 34 | 50 | 95 |
| subtree, 4 bands, after review | 35 | 30 | 47 | 97 |
| subtree, 4 bands, certificate on | 30 | | | 112 |

The resident's solve was already small (94k labels, the Oct 1 campaign), so the engine
is at parity with the packed one there: of a 34 ms step, the delta
computation and composition are ~6 ms, and the rest is §4's floor (the
preparation pass, the terminal evaluator, GC over the label objects). Each
step reads ~200 delta sets from the holder and computes ~85, mostly L1s
whose leaves crossed a fidelity band. Before the memo was keyed by id in
the holder, every summary arrival (a full forest build on a gap-bearing
forest, since `extend` declines it) recomputed all ~830 sets.

The gain grows with the forest: at 25k leaves and 2,270 summaries (§5.1)
the packed engine's warm solve is 140–158 ms and the memoized one 72 (94 before the review fixes).

## 6. Not verified

- No live agent has run this engine; the resident replay is a capture of the
  solver's inputs, not a compile through the strategy.
- The approximation differs from the packed engine's within the bound; the
  differential harness of #143 (certificate on/off over ~2,500 compiles) has
  not been rerun against it.
- Buffered forests with cache-relevant receipts are covered by the random
  differential tests (90 forests, a third gap-bearing, a quarter with a
  pinned hole) and not by a production receipt.
