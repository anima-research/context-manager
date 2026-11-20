- **Existing compression-quarantine callers:** shared native hygiene checkpoints
  the gate's tolerant projection at 256 events even after damaged history, and
  retains all active holds above 1,024 rather than silently truncating them.
  Hygiene failures, and losses of branch currency it notices mid-pass, are
  logged at most once per load, and an earlier load's stale work can use up
  the current load's warning. Work already stale on entry is skipped
  silently, as is a loss during the ledger-length read when no checkpoint is
  due; store/mutation failures still propagate. Ignored damage can be discarded by checkpoint redaction.
- Compression-quarantine episode-end logs replace `✅ ALL CLEAR — quarantine
  empty, debt paid` with `quarantine empty; coverage and debt payment not
  established; alarm stands down` (or `quarantine empty after operator waiver
  request; coverage and debt payment not established; alarm stands down`).
  Callbacks add optional `clearReason: 'quarantine-empty' |
  'operator-waiver-requested'` only at episode end; existing fields remain
  compatible. Empty quarantine is not evidence of coverage or paid debt.
- Native paid-off and success-clear loops retain the load that decided coverage
  and each observed exhaustion generation across earlier asynchronous clears,
  leaving replacement holds for a fresh decision. Success-clear logs branch-read
  failures as maintenance failures rather than rejecting on them.
  These automatic clears now use a private generation-bound
  helper rather than the public `clearCompressionRefusalQuarantine` method;
  overrides/wrappers of that public method no longer intercept automatic clears.
  Checkpoints supersede legacy snapshots even when the
  obsolete snapshot is damaged; retained checkpoint entries still validate.
- Quarantine status and automatic-clear failure diagnostics no longer include
  thrown error payloads (which can contain private paths or content), and no
  longer assert that an incomplete clear left holds intact. Status alarms log
  a fixed failure message at most once per interval, where 0.17.0 logged the
  read's error. Maintenance warnings describe an unspecified failure, not
  necessarily a store failure, and the former `paid-off sweep failed` and
  `success-clear failed` lines now report incomplete maintenance whose clear
  may have landed; inspect before retrying.
- Alarm text formerly saying `their spans stay raw and WILL eventually exhaust
  the context budget` now says unresolved raw spans may exhaust the budget and
  stale holds may remain after coverage: retained quarantine records are not
  proof of raw debt. The quarantine span and alarm-interval type docs say the
  same (`closedAgeMs` is time since the chunk closed, and holds from earlier
  request regimes stay active), clarifying the 0.17.0 description.
