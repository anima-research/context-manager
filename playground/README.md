# KV-stable context playground

A zero-backend browser explorer for the **kv-stable** context controller. Loads
a real chronicle as `PickerInputs` and re-plans **in the browser** on every
slider move (pure, deterministic JS). (The earlier λ/half-life best-fit solver
was removed — see `docs/kv-stable-context-control.md`.)

Tweak **budget**, **reach P** (the per-turn perturbation cap), and the **tail
kept raw** (flat zone); watch the frontier filmstrip (raw → L1 → L2 → L3), the
tokens/KV-cost metrics, the boundary `S`, and the diff vs `F_prev`. The live
panel drives `planControlledFrontier` (the same policy `KvStableStrategy` runs).

## Build & run

```bash
# 1. Build the library
npm run build

# 2. Bundle the solver subgraph for the browser (no chunker / node:crypto)
npx esbuild playground/entry.mjs --bundle --format=esm --platform=browser \
  --outfile=playground/solver.js

# 3. Export a REAL agent's chronicle → playground/data/<name>.json
#    Compile the script once (per scripts/README.md):
npx tsc scripts/export-picker-inputs.ts --outDir dist --target ES2022 \
  --module NodeNext --moduleResolution NodeNext --esModuleInterop \
  --skipLibCheck --resolveJsonModule
#    Snapshot the live store read-only (avoid touching the running agent's lock),
#    then export with the deployment's namespace. For Lena (local lena-cm deploy):
cp -R ~/lena-cm/data/sessions/<session-id> /tmp/lena-real && rm -f /tmp/lena-real/LOCK
node dist/scripts/export-picker-inputs.js /tmp/lena-real --ns agents/lena \
  --out playground/data/lena.json
#    The namespace is the agent's state prefix (grep the store's records.log for
#    "autobio:summaries" to discover it). Summaries are REAL recollections with
#    real token sizes — do NOT mock-migrate (mock summaries are ~33 tokens and
#    make folding look ~50× cheaper than reality).

# 4. Serve (fetch() needs http, not file://)
python3 -m http.server 8044 --directory playground
# → open http://localhost:8044
```

`index.html` currently fetches `./data/lena.json`. Point it at another payload
to explore a different agent.

## Replay — flat-profile vs kv-stable

The **replay** controls measure KV stability over a *growing* session, the real
production loop: each step re-plans carrying `F_prev` forward and scores the
provider cache. It models the **Anthropic prompt cache** as a *persistent,
content-keyed* store: ≤4 `cache_control` breakpoints per turn in a cache that
**lives across turns** (TTL-bounded). Each turn reads the longest live stored
prefix still byte-identical to the current render — including prefixes cached
many turns ago — then writes its new breakpoints back. So a prefix frozen long
ago is still a hit today, and a frontier that diverges and later reverts re-hits
its old entry (a single-turn "diff against the previous render" check can't model
either; see `evaluateCacheHit` vs `CacheStore`).

It runs the session twice — the **flat-profile baseline** (the production
default, `replaySession`) vs the **kv-stable controller** (`replayControlled`) —
and charts per-step cache-hit% for both, with a strip for the controller's
per-turn perturbation. Set budget (shared with the live panel), window `W`,
attended/flat-zone (= tail kept raw), reach `P`, marker count, and steps, then
*Run replay*; it re-runs live after the first run.

Engine: `src/adaptive/kv-cache-sim.ts` (`placeMarkers`, `CacheStore`,
single-turn `evaluateCacheHit`), `src/adaptive/kv-replay.ts` (`replaySession` —
flat-profile baseline), `src/adaptive/kv-control.ts` (`planControlledFrontier` +
`replayControlled` — the controller); all pure, deterministic, and unit-tested.
Each step reports `cacheAgeSteps` — on real data hits are routinely served by
writes several turns back, which is why a persistent store is needed. A summary
is only "available" once its youngest covered message has happened
(`lastSequence <= now`) — deep summaries appear as the conversation grows.

### Real-strategy trace
The *Load Node-harness trace* button loads `lena-{kv,flat}-trace.json` written
by `scripts/replay-strategy.js`, which drives the **real `ContextManager`**
turn-by-turn (real windows / production / merges / markers) with `KvStableStrategy`
vs `FlatProfileStrategy`. Headline finding there: **marker placement is the
dominant cache lever** — the strategy's old single head breakpoint gave ~2% hit;
well-placed ≤4 breakpoints (`AutobiographicalStrategy.placeCacheMarkers`) take it
to ~48%, after which the folding policy is a second-order (continuity) win.

## Notes

- `solver.js` (bundle), `data/`, and the `*-trace.json` files are gitignored —
  regenerate them with the steps above. **Never commit `data/`** — it holds the
  agent's real recollections.
- At tight budgets with a small reach `P`, the single-shot plan can return *over*
  budget (the reach cap bounds how far folding reaches in one step) — raise reach
  or budget. These are the kinds of behaviors the playground exists to surface.
