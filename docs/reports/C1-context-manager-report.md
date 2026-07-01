# Report — C1 Context Manager: Best-Fit Frontier V2 (item 8)

**Status:** done (scoped) — validated the existing solver, then implemented the one genuinely-missing
piece (dynamic pin-at-level-k). Strictly opt-in; default behavior unchanged.
**Branch:** `context-manager@feat/best-fit-frontier-solver` (based on `dev`, NOT the stale
`feat/best-fit-frontier`) — committed locally, **NOT pushed**.
**Date:** 2026-06-30

---

## Headline for the integrators

**`foldingStrategy: 'kv-stable'` on `dev` *is* the "proper Context Manager."** The literal Best-Fit
Frontier V2 λ-solver from `best-fit-frontier-resolution.md` (the `value − λ·KVcost` tree-knapsack DP
with a half-life value model) **was built and then deliberately removed** (commit `ea198a1`), because
measurement showed the half-life value model *created* the churn the λ term then fought
(`kv-stable-context-control.md`, "Why this exists"). It was replaced by the KV-stable receding-horizon
controller, which already delivers the three C1 goals — **bidirectional fold/un-fold, KV-stability as
the objective, pins honored** — and is on `dev`, wired, and tested. **Do not resurrect the λ-solver.**

Given that, C1 became: (1) **prove** the controller actually holds the three properties the plan cares
about, then (2) close the one real gap — **dynamic pin-at-level-k** (`ProtectedRange.level`/`maxLevel`),
the CM-ready seam the design says to add now (§7, §11). Both are done.

The first-deliverable scope analysis (what was already implemented vs missing, and the decision this
raised) is preserved in git history / was surfaced to the user, who chose: validate-first, then
implement pin-at-level-k, do not touch the removed λ-solver.

## What changed

- **`src/types/strategy.ts`** — added optional `level?` / `maxLevel?` to `ProtectedRange` (pin-at-k /
  pin-max-level), a `PinLevelOptions` type, and widened `PinnableStrategy.pinRange`/`markDocument` to
  accept it. Additive; classic pins (no bound) are byte-identical to before.
- **`src/types/index.ts`** — re-export `PinLevelOptions`.
- **`src/adaptive/picker.ts`** — added optional `pinLevel?` / `pinMaxLevel?` to `PickerChunk` (data
  the KV-stable controller reads; ignored by other strategies).
- **`src/adaptive/kv-control.ts`** — `planControlledFrontier` now honors two new params:
  `fixedLevels` (chunks fixed at exactly level k — immovable, the frontier cut passes through that
  node) and `pinCaps` (a **hard** max-fold-depth per chunk, enforced in normal **and** the W-emergency
  shed, and a carried resolution deeper than the cap is un-folded to it at plan start). The `expand`
  pass now skips a unified `immovable` set (locked ∪ fixed-level); `shed` takes `pinCaps`.
- **`src/adaptive/strategies/kv-stable.ts`** — `solve()` builds `fixedLevels`/`pinCaps` from the new
  PickerChunk fields, and **group-expands** a single-chunk pin-at-k to its whole L_k node's leaf set
  (an L_k recall pair is atomic over its range — fixing one sub-chunk while siblings render raw is an
  unrenderable, non-converging frontier). Clamps k to the deepest produced level.
- **`src/strategies/autobiographical.ts`** — `pinRange`/`markDocument` accept + persist the bounds
  (validated via a new `normalizePinLevels`: non-negative integers only; `level` suppresses `maxLevel`);
  new `pinAtLevel(...)` convenience; new `pinLevelBounds()` resolver (positions → `{level,maxLevel}`,
  finest-requirement-wins on overlap); the adaptive PickerChunk build marks a leveled pin
  `pinned:false` carrying its bound (a classic raw pin stays `pinned:true`). `pinnedPositions` is
  untouched, so the legacy/hierarchical select paths are unaffected.
- **`src/context-manager.ts`** — `pinRange`/`markDocument` accept `PinLevelOptions`; new `pinAtLevel`
  passthrough.
- **`scripts/validate-kv-stable.ts`** (new) — the §10 integration matrix harness (below).
- **`test/adaptive/pin-at-level.test.ts`** (new, 6 tests) + **`test/pins.test.ts`** (+2 tests) — cover
  the new mechanism and API contract.

## Why (root cause the design fixes)

V1 `flat-profile` is **monotonic** — it only ever folds, so a budget *increase* never un-folds; Tilde
stayed ~75k when her budget went 100k→300k until her resolution slot was manually wiped. The KV-stable
controller reframes resolution as a bidirectional receding-horizon policy (hysteresis band
`[expandAt, foldAt]`; un-fold youngest-first to use headroom; fold oldest-first under a per-turn reach
cap; W the only hard wall). Pins were previously pin-as-raw only; pin-at-level-k makes the pin set a
first-class, dynamic, level-aware constraint (the substrate a future CM agent drives).

## How I tested it (observed results)

**Unit / integration suite:** `npm run build` clean; **`node --test` → 274 tests, 0 fail** (was 266
before my additions; +8 new). Includes the pre-existing kv-stable coverage (bidirectional un-fold,
byte-parity, position-aware KV cost, convergence, perturbation ≤ flat baseline) plus my new
pin-at-level tests.

**§10 budget-sweep matrix** — `scripts/validate-kv-stable.ts` drives the **real `ContextManager` +
`AutobiographicalStrategy`** compression pipeline (real chunker / background production / merges,
building a genuine raw→L1→L2 tree from a ~305k-token session) and compiles the *same* accumulated
state at ascending budgets, kv-stable vs the `flat-profile` default. Full output:
`docs/reports/C1-validation-output.txt`. Result:

```
                 budget:  64k(op)   100k     180k     300k    drop→100k
  flat-profile rendered:  50,944   50,944   50,944   50,944   50,944     (util 17% @300k — STUCK)
  kv-stable    rendered:  51,417   85,474  158,261  263,936   81,986     (util 89% @300k)

  [PASS] A1 kv-stable un-folds on budget increase (85,474 → 158,261 → 263,936)
  [PASS] A2 flat-profile stays stuck on budget increase (100k 50,944 → 300k 50,944, Δ 0%)   ← the bug, reproduced
  [PASS] A3 kv-stable re-folds on budget drop (263,936 → 81,986)
  [PASS] B  kv-stable fills 300k headroom better than flat (util 89% vs 17%)
  [PASS] C1 kv-stable sweep is monotone (no oscillation)
  [PASS] C2 all compiles converged (no picker iteration-bound throw)
  [PASS] C3 re-compiling identical state is deterministic (byte-stable render)
```

This proves, on a real folding pipeline: **(a) a budget increase actually un-folds** (the headline
C1 fix) while flat-profile is frozen at 50,944 across every budget; **(b) the controller beats the
greedy flat baseline on headroom utilization**; **(c) no thrash** (monotone, converged, deterministic).

**pin-at-level-k** (`test/adaptive/pin-at-level.test.ts`): a chunk pinned at L2 stays exactly L2 under
both generous and tight budgets; a level clamps to the deepest produced level; a `maxLevel` cap holds
even under the W-emergency deep fold while an un-capped neighbor folds deeper; a carried resolution
deeper than a new cap is un-folded to it; the KvStableStrategy walks the picker to a pin-at-k target
and converges; the pin holds across a full budget sweep. API round-trip + persistence in
`test/pins.test.ts`.

## What the eval CANNOT prove (honest limits)

- **No named production chronicle was available on this box.** `playground/data/` is gitignored
  ("never commit — holds the agent's real recollections"), and the only live store (scout,
  `connectome-host/data/sessions`) is 96K, fresh today, with **zero summaries** — no foldable tree.
  So the matrix runs on **synthetic message content at realistic sizes through the real folding
  pipeline** — the same fidelity `scripts/replay-strategy.ts` uses (it, too, only reads real *sizes*).
  Token geometry and fold structure are real; *which specific text* surfaces is not from a real agent.
- **The synthetic tree reached L2, not L3** at this scale — the properties are level-agnostic, but I
  did not exercise a 4+-level pyramid end-to-end here (the unit tests do cover deeper logic).
- **"Does the *right* detail surface" has no ground truth** and is untested — that is a retrieval/
  quality question (the future CM-agent policy layer), explicitly out of scope for this mechanism
  (design §11 "CM instance — next iteration").
- **"No output-looping regression" is proven only by proxy** (monotone sweep, picker convergence,
  deterministic byte-stable render, and the pre-existing "perturbation ≤ flat baseline" replay test).
  True output-looping is a live-model KV-collapse phenomenon; confirming it needs a running host with a
  real provider cache — which the plan itself acknowledges. I did not run a live host.
- **Group granularity of pin-at-k:** pinning one chunk at L_k fixes its **whole L_k node** (siblings
  included), because the recall pair is atomic. This is the correct "cut through the node" semantics
  but is coarser than per-chunk; documented in code.

## Anomalies & surprises

- **The plan's base branch is obsolete.** `feat/best-fit-frontier` is 40 commits behind `dev`; its one
  unique commit (`cd4d56a`) is duplicated on `dev` (`04c3f59`). I branched off `dev` (which strictly
  contains it), consistent with the plan's "rebase onto dev" allowance.
- **The plan's cited anchors are pre-kv-stable.** `adaptive/folding-strategy.ts:88` / `picker.ts:167`
  (the `'lower'` op) still exist and are exercised, but the "missing strategy that emits `lower`" is
  no longer missing — `KvStableStrategy` emits it. The `BestFitStrategy` / `value-function` /
  `tree-knapsack DP` the plan describes exist only in *code comments* now (historical references).
- `summary-tree.ts` and `render-offsets.ts` (V2 build-order modules 1–2, incl. the KVcost/divergence
  math) survived the λ-solver removal and are the shared substrate the controller uses.

## Cross-repo / coordination notes

- **New public API surface on `context-manager`** the integrators should be aware of before
  merge/publish: `ContextManager.pinAtLevel()`, `pinRange`/`markDocument` now accept
  `{ level?, maxLevel? }`, and `ProtectedRange` gains optional `level`/`maxLevel`. All additive and
  backward-compatible (existing callers and persisted pins are unaffected; the fields are honored only
  under `foldingStrategy: 'kv-stable'`). No `agent-framework` change is required to consume the default.
- No membrane/chronicle changes; no default-behavior change (default stays `flat-profile`).

## Follow-ups & open questions (for the integrators)

1. **Promotion decision:** the §10 matrix step 5 ("promote kv-stable to default once parity + cache
   behavior validated on Lena/Cairn/Tilde") still needs a **real named store** — run
   `scripts/replay-strategy.js <name>` and `scripts/validate-kv-stable.js` against an exported Tilde/
   Lena/Cairn snapshot on a box that has one, before flipping the default.
2. **Live output-looping check** on a running host with a real provider cache (the one thing simulation
   can't cover).
3. **CM-agent policy layer** (next iteration) can now drive pin-at-k / maxLevel via the new seam.

## Confidence

**High** on the findings and on the code (git history + live code + 274 green tests + the reproduced
budget-sweep bug/fix are unambiguous). **Medium** on production-readiness of promoting kv-stable to
default — that needs the real-store validation in follow-up #1, which this box couldn't provide.
