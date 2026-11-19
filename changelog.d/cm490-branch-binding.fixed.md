- Compression-quarantine appends, family-progress writes and checkpoint
  hygiene stay bound to the branch the caller checked, across reentrant store
  reads and branch changes the manager tracks or its branch reads observe, so
  stale work can no longer write an old branch's holds or progress into a
  branch that is initializing. A store adapter that hides raw handle switches
  can still redirect those writes and the release's post-write reread.
  Progress sync stays on the store that received the write, and branch guards
  recheck the strategy generation after reentrant branch lookups. No new locks or cross-process guarantees.
- Topology repair no longer reads or warns about a legacy quarantine snapshot
  that a checkpoint superseded, or one beside a ledger that holds no list.
- `switchBranch()` and `fork()` invalidate the loaded strategy as soon as the
  store has switched, before the bookkeeping that can fail or reenter. A
  selection that a reentrant switch superseded is rejected, as is one whose
  branch reconciliation finds another name; an uncertain one says so and
  names the recovery (`switchBranch()` or `setStrategy()`). Initialization no
  longer reports success when its final branch reads close the manager or
  start a newer initialization. Branch observation reconciles a switch made
  inside the store's own branch read, and refuses one that never stabilizes
  instead of looping.
- A notification whose hook context can't be built because the manager closed
  is no longer queued after close, and its log line says the manager is closed
  rather than promising a later delivery. A retraction retry that encounters
  close also discards undelivered work instead of requeuing it. A strategy-detach diagnostic whose
  strategy name or log sink throws no longer escapes as an unhandled
  rejection.
