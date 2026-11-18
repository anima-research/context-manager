- Background drain and hook/repair terminal rejection handlers cannot throw,
  even when store lookups or host diagnostics fail. Genuine tick failures remain
  observable after a load change; explicit no-call/hold deferrals still stop
  obsolete work quietly. Continuation currency includes lifecycle entry
  epochs, before an asynchronous initialize override reaches `super`.
- Select/preview unwinding does not restore old mirrors into a replacement load;
  initialization releases preview latches/configuration. Guarded mirror fields
  use local epoch/generation checks; durable writers retain full branch checks.
  Discarded order caches detach without copying history-sized shells.
- Nested operation resolutions retain ancestor origins; reentrant branch
  observations do not lose the returned branch or overwrite newer switches.
  Replacement loads hand over held repair reports once. Reentrant provider
  error getters cannot apply obsolete pause decisions. Topology repair skips
  superseded legacy quarantine snapshots beside malformed ledgers.
- Final head-window reset failures report the stored transition and duplicate
  retry risk. Stale continuation errors have a distinct name and warn that
  earlier writes may have completed; they are not rollback acknowledgements.
