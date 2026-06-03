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

# 3. Export a real chronicle store → playground/data/<name>.json
#    (compile the script once, per scripts/README.md)
npx tsc scripts/export-picker-inputs.ts --outDir dist --target ES2022 \
  --module NodeNext --moduleResolution NodeNext --esModuleInterop \
  --skipLibCheck --resolveJsonModule
node dist/scripts/export-picker-inputs.js <store-path> --out playground/data/lena.json

# 4. Serve (fetch() needs http, not file://)
python3 -m http.server 8044 --directory playground
# → open http://localhost:8044
```

`index.html` currently fetches `./data/lena.json`. Point it at another payload
to explore a different agent.

To produce a store from a raw `{model, messages:[{role,content}]}` transcript,
use `scripts/migrate-llr.js <input.json> <store-path> --mock` first.

## Notes

- `solver.js` (bundle) and `data/` (real conversation content) are gitignored —
  regenerate them with the steps above.
- The Lena run shows the **coarse-granularity gap** in the wild: with λ up, the
  solver freezes a heavily-folded `F_prev` rather than pay KV cost to un-fold
  low-value old content — visible as under-fill (tokens ≪ budget, KV cost 0).
  Drop λ to watch it fill.
