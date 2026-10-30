- `ReadinessState.ready`, and `ContextManager.isReady()` and
  `checkReadiness()` with it, no longer count background work that waits on
  something only the host can give, such as its tool definitions, so a loop
  that ticks until ready ends on a host that never declares any.
  `ReadinessState.ready` was "Whether the strategy has no background work
  pending." and is now "Whether the strategy has no background work pending,
  other than work that waits on something only the host can give, such as its
  tool definitions: `waitingOn` names that."; `isReady()` was "Whether the
  strategy has no background work pending (its `checkReadiness()`)." and adds
  "other than work that waits on the host, such as for its tool definitions,
  which getWaitingWork() names."; `checkReadiness()` was "Whether the strategy
  has background work pending, with its info if so." and adds "and what waits
  on the host."
- `AutobiographicalProgressSnapshot.l1QueueLength` and `mergeQueueLength`
  leave out work waiting on the host's tool definitions: "Chunks queued for L1
  compression." and "Pending L1→L2 and L2→L3 merges." each add "less those
  waiting on the host's tool definitions." A loop that ticks while they are
  above 0 ends once only waiting work is left.
