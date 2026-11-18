- **Existing compression-quarantine callers:** shared native hygiene checkpoints
  the gate's tolerant projection at 256 events even after damaged history, and
  retains all active holds above 1,024 rather than silently truncating them.
  Hygiene failures or mid-pass loss of currency are logged once per load;
  work already stale on entry is skipped silently; store/mutation failures still
  propagate. Ignored damage can be discarded by checkpoint redaction.
- Compression-quarantine episode-end logs replace `✅ ALL CLEAR — quarantine
  empty, debt paid` with `quarantine empty; coverage and debt payment not
  established; alarm stands down` (or `quarantine empty after operator waiver
  request; coverage and debt payment not established; alarm stands down`).
  Callbacks add optional `clearReason: 'quarantine-empty' |
  'operator-waiver-requested'` only at episode end; existing fields remain
  compatible. Empty quarantine is not evidence of coverage or paid debt.
- Native paid-off and success-clear loops retain each observed exhaustion
  generation across earlier asynchronous clears, leaving replacement holds
  for a fresh decision. These automatic clears now use a private generation-bound
  helper rather than the public `clearCompressionRefusalQuarantine` method;
  overrides/wrappers of that public method no longer intercept automatic clears.
  Checkpoints supersede legacy snapshots even when the
  obsolete snapshot is damaged; retained checkpoint entries still validate.
- Quarantine status and automatic-clear failure diagnostics no longer include
  thrown error payloads (which can contain private paths or content), and no
  longer assert that an incomplete clear left holds intact. Status alarms log
  a fixed failure message at most once per interval, replacing the raw read
  error described in the historical changelog. Maintenance warnings describe
  an unspecified failure, not necessarily a store failure; success-clear
  warnings ask for inspection rather than promising an unscheduled reread.
- Alarm text formerly saying `their spans stay raw and WILL eventually exhaust
  the context budget` now says retained quarantine records are not proof of raw
  debt and requests inspection. Former `paid-off sweep failed` and
  `success-clear failed` maintenance lines now report incomplete maintenance or
  a landed clear with uncertain hygiene; inspect before retrying.
