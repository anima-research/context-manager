# Pinned MAIN compression requests

`compression-main-a81.json` contains complete, unnormalized mock requests from
public source `a81d20656d8991f4d5963719535cab11703ff879`, not requests from the PR.
The single-key object `{ "$cmGoldenUndefined": true }` encodes an explicit
`undefined` value so strict comparison also checks own-property presence; no
request fields or text are discarded.
All content is synthetic. No provider, private history, or resident store is used.

Coverage: 9 modes × 3 pins × {base, base + identity reminders, KnowledgeStrategy}
= 81 request sets, plus base L3 {merge, readingMerge, fallback, readingFallback}
× 3 pins = 12 more. Each set includes every mock call (including rejected calls
and split pieces). The test compares the full requests, including system/config
and all message fields, with omitted, empty, and explicit-default settings.
This says nothing about real-provider quality or the full repository suite.

## Offline reproduction

From the repository root, using the lockfile-installed Node/compiler/dependencies
(the producer records their versions and SHA-256 provenance in the JSON):

```sh
mkdir -p node_modules/.cache/cm486/main-a81
git archive a81d20656d8991f4d5963719535cab11703ff879 | tar -x -C node_modules/.cache/cm486/main-a81
ln -s ../../.. node_modules/.cache/cm486/main-a81/node_modules
cp test/compression-instructions-harness.ts node_modules/.cache/cm486/main-a81/test/
python3 - <<'PY'
p = 'node_modules/.cache/cm486/main-a81/test/compression-instructions-harness.ts'
s = open(p).read().replace('AutobiographicalOptions, CompressionInstructions, SummaryEntry',
                         'AutobiographicalOptions, SummaryEntry')
s = 'type CompressionInstructions = unknown;\n' + s
s = s.replace('...extra, compressionInstructions: config', '...extra')
open(p, 'w').write(s)
PY
(cd node_modules/.cache/cm486/main-a81 && npm run build)
npm run build
node scripts/generate-compression-main-golden.mjs node_modules/.cache/cm486/main-a81 test/fixtures/compression-main-a81.json
```

The only harness port removes the unavailable option type and constructor
property on MAIN; no MAIN strategy source is patched. Both builds use exactly
the same `node_modules` (no second dependency resolution). Use per-command
timeouts when running these steps. Do not regenerate the fixture from PR code
to resolve a mismatch. Build/test caches stay in `node_modules/.cache`/`dist`; remove the
synthetic `node_modules/.cache/cm486/main-a81` copy after use if not retaining local evidence.
