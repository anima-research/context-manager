- Add optional metadata-only inspection and generation/load-bound single-key L1
  compression-quarantine waiver APIs on the loaded autobiographical strategy,
  through `inspectCompressionRefusalQuarantine` and
  `releaseCompressionRefusalQuarantine`, with explicit stale/unreadable/legacy
  outcomes. Export `isKeyedCompressionQuarantineStrategy` for feature detection
  and the `KeyedCompressionQuarantineStrategy`, `CompressionQuarantineBinding`,
  `CompressionQuarantineRecordView`, `CompressionQuarantineInspection`,
  `CompressionQuarantineReleaseSelection` and `CompressionQuarantineReleaseResult`
  types. The capability guard accepts ordinary or callable objects that have
  both methods, and narrows only to those two methods.
  - Inspection validates native digest metadata, reports coarse unreadable
    reasons without store error text, and includes per-record current-config
    shape-cap participation and same-regime counts. Historical source-only cap
    accounting is not a prediction of today's prepared request hash.
    Unexpected projection errors propagate.
  - Inspection and release ignore history superseded by a checkpoint, even
    before redaction, while resolving earlier legacy claims referenced by later
    exhaustion events. Both report `branchUnavailable` when the branch lookup
    fails, and both report a load lost during their projection reads rather
    than returning results from it.
  - A selected waiver requires a valid native family digest, compares and
    clears under one native lock, and runs lossless checkpoint hygiene before
    acknowledging. The branch/load binding is rechecked before progress
    mutation and after reentrant reads, hygiene, sync and the post-read, and
    `released` is returned only when the post-read no longer shows the
    selected generation; a failure after mutation is reported as uncertain.
    Raw store-handle switches the manager does not track (for example inside
    a store adapter's own branch read) are outside this guard: writes and the
    post-read can land on another branch, so no result says other branches
    are untouched, and with such an adapter `released` does not prove the
    bound branch was cleared. A waiver is not coverage or a promise of a
    provider attempt. Short damaged ledgers have no immediate
    repair through inspection or release. The existing optional-key
    `clearCompressionRefusalQuarantine` remains available.
