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

## Notes

- `solver.js` (bundle) and `data/` (real conversation content) are gitignored —
  regenerate them with the steps above. **Never commit `data/`** — it holds the
  agent's real recollections.
- On real Lena data, the token makeup shows L1 recalls taking a meaningful share
  of the budget (~22% at 40%, ~62% at 15%) — real folding economics. At tight
  budgets the stable solver can return *over* budget (granularity + KV
  stickiness); lowering λ helps. These are the kinds of behaviors the playground
  exists to surface.
