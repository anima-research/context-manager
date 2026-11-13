- **Existing compression-quarantine callers:** shared native hygiene checkpoints
  the gate's tolerant projection at 256 events even after damaged history, and
  retains all active holds above 1,024 rather than silently truncating them.
  Failed or stale hygiene is logged once per load; store/mutation failures still
  propagate. Ignored damage can be discarded by checkpoint redaction.
- Compression-quarantine episode-end logs replace `✅ ALL CLEAR — quarantine
  empty, debt paid` with `quarantine empty; coverage and debt payment not
  established; alarm stands down` (or `quarantine empty after operator waiver
  request; coverage and debt payment not established; alarm stands down`).
  Callbacks add optional `clearReason: 'quarantine-empty' |
  'operator-waiver-requested'` only at episode end; existing fields remain
  compatible. Empty quarantine is not evidence of coverage or paid debt.
