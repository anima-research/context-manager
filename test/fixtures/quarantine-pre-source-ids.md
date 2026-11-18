# Historical quarantine fixture

`quarantine-pre-source-ids.json` contains actual exhaustion/alert events and
checkpoint output from `274f7a88bb323699324994fefbe878f275b10aed`, before
`sourceIds` was added to quarantine records. The old checkpoint writer used
`.slice(0, MAX_COMPRESSION_QUARANTINE_RECORDS)`; this fixture has one hold,
not an over-limit population. It pins format compatibility, not recovery of
records already discarded by that writer.

Generated locally using that revision's `src/` compiled with the current
lockfile dependencies, a fresh Chronicle store, and a fake provider returning
empty content, `stopReason: refusal`, and 100 input / 0 output tokens.
Configuration: model `historical-fixture`, targetChunkTokens 100,
recentWindowTokens/headWindowTokens 0, autoTickOnNewMessage false,
minChunkCharsForLLM 0, mergeThreshold 99, compressionRefusalCurveFallbacks 0.
Sixteen alternating User/Claude messages contain `Historical synthetic message
${i} ` followed by `substantive ` repeated 12 times. After compile, run native
compression on the first chunk. Capture the events, append native
`alert_pending` events to reach 256, then call that revision's native checkpoint
writer and capture its ledger. No current record/checkpoint builder is involved.

No real user/provider data is used.

Round 17 adds two independent native writer captures rather than embedding
that later record in synthetic old containers:

- `quarantine-legacy-claim.json`: `2ce952df` (`fix: harden compression recall
  curve fallback`), whose native writer emitted claim/exhaustion/alert events.
- `quarantine-legacy-snapshot.json`: `bdbfc57f` (`feat: add compression
  recall-curve refusal fallback`), whose writer emitted the snapshot list.

Both use exactly the sixteen-message synthetic population above. Build the
named revision's `src/` with the local lockfile dependencies (the historical
config needs explicit `types: ["node"]` when built under node_modules), then:

```sh
node scripts/capture-quarantine-legacy.mjs <historical>/dist/src/index.js claim test/fixtures/quarantine-legacy-claim.json
node scripts/capture-quarantine-legacy.mjs <historical>/dist/src/index.js snapshot test/fixtures/quarantine-legacy-snapshot.json
```

The capture script invokes the historical native compressor; it does not
construct the containers. The real claim record has no family key and is
therefore inspectable and enforced by the tolerant gate, but not selectable
for keyed release. Strict inspection and the tolerant native gate are checked
against every captured format, including post-release absence for selectable
ones. Timestamps and event identities are capture outputs, not fixtures made
from the current writer.
