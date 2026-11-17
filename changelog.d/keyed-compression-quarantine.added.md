- Add optional metadata-only inspection and generation/load-bound single-key L1
  compression-quarantine waiver APIs on the loaded autobiographical strategy,
  with public capability types and explicit stale/unreadable/legacy outcomes.
  Inspection validates native digest metadata, reports coarse unreadable reasons
  without store error text, and includes per-record current-config shape-cap
  participation and same-regime counts. Unexpected projection errors propagate.
  Selected waivers require a valid native family digest, compare and clear under
  one native lock, and run lossless checkpoint hygiene before acknowledgement;
  branch/load binding is rechecked before progress mutation and after reentrant
  reads, hygiene, sync and postread; later failures remain uncertain. Capability
  detection narrows only to the two checked methods. A waiver is not coverage or a promise of a provider
  attempt; legacy optional-key clearing remains available.
- Inspection reports `branchUnavailable` when branch lookup fails, consistently
  with release. Historical source-only cap accounting is not a prediction of
  today's prepared request hash; short damaged ledgers have no immediate repair
  through inspection or release.
- Quarantine inspection and keyed release ignore history superseded by a checkpoint even before redaction, while resolving earlier legacy claims referenced by later exhaustion events.
- Inspection rejects reentrant branch changes during projection reads. Obsolete
  checkpoint work does not consume the current load's failure warning, and
  automatic-clear/status diagnostics omit store error payloads and do not
  assert that a failed maintenance pass left holds intact.
