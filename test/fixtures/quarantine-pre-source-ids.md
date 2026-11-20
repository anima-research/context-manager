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

The test also embeds this historical record in snapshot and claim/exhaustion
containers to test their projection rules; those containers are synthetic,
not claimed to be an older runtime capture. No real user/provider data is used.
