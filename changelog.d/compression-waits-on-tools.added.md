- `ContextManager.getWaitingWork()` names background work that waits on the
  host, such as for its tool definitions, with `waitingOn: 'tools'` and a
  description such as "4 chunks wait on the host's tool definitions"; it is
  `null` when nothing waits. `getPendingWork()` is unchanged. The new
  `WaitingWork` type is exported, and `ReadinessState` gains `waitingOn` and
  `waitingDescription`, set whenever anything waits.
- `AutobiographicalProgressSnapshot` gains `l1WaitingOnTools` and
  `mergesWaitingOnTools`, counting the work its queue lengths leave out.
