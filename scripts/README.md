# Adaptive-resolution migration scripts

## migrate-llr.ts

Migrate an llr-format JSON transcript (`{ model, messages: [...] }`) into a
fresh chronicle using the adaptive-resolution strategy. Compiles probes at
several budgets to demonstrate picker behavior.

```bash
# Mock LLM (fast, no API calls)
node dist/scripts/migrate-llr.js <input.json> <store-path>

# Real LLM (requires ANTHROPIC_API_KEY)
node dist/scripts/migrate-llr.js <input.json> <store-path> --real
```

## reopen-test.ts

Open an existing chronicle twice and verify adaptive state persists
identically across the close/reopen.

```bash
node dist/scripts/reopen-test.js <store-path>
```

`npm run build` compiles both, with the other TypeScript scripts in
`scripts/`, into `dist/scripts/`, using the project's own `tsconfig.json`:

```bash
npm run build
```

## records-log-bytes-by-state.py

Stream a Chronicle `records.log` and print bytes per state, per (state,
operation) and per UTC day, without opening the store. Use it when a store is
larger than its content explains (#148).

```bash
python3 scripts/records-log-bytes-by-state.py <store-dir-or-records.log> [--top 25]
```
