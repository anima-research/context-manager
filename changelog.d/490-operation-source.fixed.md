- Compression maintenance captures its source load before reentrant branch
  lookups and retains it through nested clears; failed maintenance lookups no
  longer turn successful compression into failure. Legacy clear reports stale
  authorization rather than acknowledging an unapplied clear. Carrier fallback stops when
  progress persistence loses its source branch.
- Non-list ledgers do not read superseded legacy snapshots, and quarantine
  alarms no longer claim retained records alone prove raw debt.
