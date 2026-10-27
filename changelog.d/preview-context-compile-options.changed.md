- A dry select, a preview's or a `dryRun` compile's, logs no
  `[kv-continuity-relaxation]` line: neither the error-level line for a
  relaxation applied nor the warning for one rejected as invalid or expired,
  since a dry run isn't the live state. The committing compile still logs
  each.
