# Compression request baseline and deliberate recaptures

`compression-main-a81.json` was first captured from public **pre-feature** source
`a81d20656d8991f4d5963719535cab11703ff879`, not the feature PR. The filename retains
that historical baseline name. `source` is provenance, not a forever-pinned SHA.
New captures also record `sourceTree`. The original fixture is unchanged since
its first capture. The single-key object `{ "$cmGoldenUndefined": true }` encodes an explicit
`undefined` value: strict comparison checks own-property presence and discards
no request fields or text. All content is synthetic; no provider, private
history, or resident store is used.

Coverage: 93 recorded sets / 243 requests, including rejected calls and split
pieces. There are 9 modes × 3 pin labels × {base, base + identity reminders,
KnowledgeStrategy} = 81 sets, plus base L3 {merge, readingMerge, fallback,
readingFallback} × 3 pins = 12. **`reading/mixed` is an inherited duplicate/alias**
in each variant: its single shard precedes the pin. Thus there are 90 unique
scenario cases after those 3 explicit aliases (not 93 distinct pin situations,
and not necessarily 90 distinct request bodies). `readingSplit/mixed` really
spans the pin. No strategy behavior, fixture keys, or request bodies were
changed to invent straddling coverage. Tests compare full requests, including
system/config and all messages, under omitted, empty and explicit-default
settings. This is not a real-provider or full-suite claim.

## Capture policy (same as the sibling recall-envelope golden)

Capture a compatibility baseline from the **pre-change** tree first. A future
intentional default-render/request change may recapture from its **committed
post-change** tree, with the reason and expected request diff reviewed alongside
the fixture. Never recapture an unexpected red test merely to make it green.
Retain/review the old baseline and compare full requests before accepting a
new one. No narrowing/normalization of the request comparison is intended.

## Offline reproduction / sanctioned intentional capture

Use an explicit, clean Git source worktree root, not an archive or a `dist`
folder. The generator validates that root equals Git's top-level (so an archive
under a PR checkout cannot acquire its parent's HEAD), ignores ambient `GIT_*`
overrides, and records that worktree's actual HEAD/tree. It refuses tracked
edits anywhere and untracked (including ignored) files under `src`, `test`, and `scripts`; commit deliberate
source changes first. Among non-ignored untracked files, only `test/compression-instructions-harness.ts`
is allowed for legacy instrumentation. Ignored build/dependency artifacts outside
those source directories are trusted inputs, not audited source; do not import untracked helpers. Tracked source bytes are also compared with HEAD, independently
of index flags. The generator builds into a fresh temporary output directory
with the recorded compiler, then removes that directory after capture.

For example, create a **local detached worktree** at the chosen public commit
(no fetch/push needed). Keep it and its build artifacts for review:

```sh
# Run from this repository; choose pre-change or deliberate post-change commit.
SOURCE_SHA=a81d20656d8991f4d5963719535cab11703ff879
SOURCE_ROOT="$PWD/node_modules/.cache/cm486/source-$SOURCE_SHA"
mkdir -p "$(dirname "$SOURCE_ROOT")"
git -c core.autocrlf=false -c core.eol=lf worktree add --detach "$SOURCE_ROOT" "$SOURCE_SHA"
ln -s "$PWD/node_modules" "$SOURCE_ROOT/node_modules"
```

Tracked symlinks require real symlink support (on Windows, enable Developer Mode or the required privilege) and a fresh checkout with `core.symlinks=true`. A `core.symlinks=false` regular-file checkout cannot reproduce symlink provenance.

Reuse the same locked compiler/dependencies, installed with scripts disabled.
**Modern source already containing the option and harness needs no port.**
Copy the synthetic harness whenever the selected source lacks it (including
feature-era commits). Port it only when the option itself is absent:

```sh
if [ ! -f "$SOURCE_ROOT/test/compression-instructions-harness.ts" ]; then
  cp test/compression-instructions-harness.ts "$SOURCE_ROOT/test/"
fi
if [ ! -f "$SOURCE_ROOT/src/compression-instructions.ts" ]; then
  python3 - "$SOURCE_ROOT/test/compression-instructions-harness.ts" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read().replace('AutobiographicalOptions, CompressionInstructions, SummaryEntry',
                         'AutobiographicalOptions, SummaryEntry')
s = 'type CompressionInstructions = unknown;\n' + s
old = '...extra, ...(config === undefined ? {} : { compressionInstructions: config })'
assert s.count(old) == 1, 'Legacy harness port no longer matches; inspect before retrying'
s = s.replace(old, '...extra')
open(p, 'w').write(s)
PY
fi
# GNU coreutils supplies timeout on Linux; on macOS install coreutils and use gtimeout.
TIMEOUT=timeout
command -v "$TIMEOUT" >/dev/null || TIMEOUT=gtimeout
"$TIMEOUT" 120s npm run build
"$TIMEOUT" 300s node scripts/generate-compression-main-golden.mjs "$SOURCE_ROOT" /tmp/compression-candidate.json
```

The legacy port removes only the unavailable type and constructor property; no
strategy source is patched. The producer loads the built harness/product from
`SOURCE_ROOT`, and scenario enumeration from this checkout. It records the source lockfile and the installed node_modules/.package-lock.json
separately (including when node_modules is linked), compiler version, source and
freshly compiled harness hashes, and the actual loaded scenario-module hash.
Both source/harness and producer scenarios are built into fresh temporary output;
preexisting producer `dist` scenarios are not imported.
The installed lock is npm installation metadata, not a cryptographic inventory
of every dependency file; use an unmodified npm ci installation. Do not mutate
the compiler, dependencies, or harness during capture. Compare the candidate's requests
strictly with the retained baseline, inspect metadata separately, and replace
the fixture only under the intentional-change policy above. Use per-command
bounds; no model API, live store, npm pack/lifecycle, or dependency re-resolution
is required by capture.
