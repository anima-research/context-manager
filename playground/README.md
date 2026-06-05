# Best-fit folding playground

A zero-backend browser explorer for the V2 best-fit frontier solver. Loads a
real chronicle as `PickerInputs` and re-solves **in the browser** on every
slider move (the solver is pure, deterministic JS — ~8 ms for 1000 chunks).

Tweak budget, λ (KV stability), recency half-life, min-weight, and the
raw-tail size; watch the frontier filmstrip (raw → L1 → L2 → L3), the
tokens/value/KV-cost metrics, the boundary `S`, and the diff vs `F_prev`.

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

## Replay & KV cache simulation

The **replay (KV stability)** controls measure what the λ-stability term actually
buys on a real session. A single slider solve is one-shot; replay reconstructs
the session as *growing* history and re-solves each step carrying `F_prev`
forward — the real production loop. It models the **Anthropic prompt cache** as
a *persistent, content-keyed* store: ≤4 `cache_control` breakpoints per turn,
written into a cache that **lives across turns** (TTL-bounded). Each turn reads
the longest live stored prefix still byte-identical to the current render —
including prefixes cached many turns ago — then writes its new breakpoints back.
So a prefix the stable solver froze long ago is still a hit today, and a
frontier that diverges and later reverts re-hits its old entry (a single-turn
"diff against the previous render" check can't model either; see
`evaluateCacheHit` vs `CacheStore`). Everything after the match is recomputed at
full input price. Set the **fixed budget cap** (the realistic case: a long
conversation grows into a fixed window), the **cache marker** count (1–4), and
**steps**, then hit *Run replay*. It runs the session twice — current λ
(stable) vs λ=0 (naive re-solve) — and charts per-step cache-hit% for both, with
a churn strip where folding broke the cached prefix. Recency / min-weight / tail
/ solver knobs are shared with the live solver above.

Engine: `src/adaptive/kv-cache-sim.ts` (`placeMarkers`, `CacheStore`, and the
single-turn `evaluateCacheHit`) and `src/adaptive/kv-replay.ts`
(`replaySession`); all pure, deterministic, and unit-tested in `test/adaptive/`
(including the cross-turn "revert" case). Each replay step reports
`cacheAgeSteps` — how old the entry that served its hit is; on real data hits are
routinely served by writes several turns back, which is exactly why a persistent
store is needed. A summary is only "available" at a replay step once its youngest
covered message has happened (`lastSequence <= now`) — so deep summaries appear
as the conversation grows, mirroring bottom-up compression.

- **Finding (Lena):** the win is *data-dependent and λ has an optimum*. At a 25%
  cap, λ≈0.05 is best (~89% hit, least recompute), but λ≳0.25 saturates at a
  *worse* fixed equilibrium — the "too-high λ freezes the prefix" risk
  (`stable-frontier.ts`) showing up as churn at growth boundaries. On `llr`,
  λ=0.5 already cuts recompute ~30%. Sweep λ in the replay to find the knee.

## Notes

- `solver.js` (bundle) and `data/` (real conversation content) are gitignored —
  regenerate them with the steps above. **Never commit `data/`** — it holds the
  agent's real recollections.
- On real Lena data, the token makeup shows L1 recalls taking a meaningful share
  of the budget (~22% at 40%, ~62% at 15%) — real folding economics. At tight
  budgets the stable solver can return *over* budget (granularity + KV
  stickiness); lowering λ helps. These are the kinds of behaviors the playground
  exists to surface.
