- **Strategies with only `onNewMessage`:** when the manager can't read the
  store's branch or the window mode to deliver a stored row's notification,
  `addMessage` (and the other notifying calls) no longer throw after storing.
  The rows wait in memory, on this manager, until a later notification finds
  the scope readable, and are then delivered once each, in order; close
  discards them. Each notification makes one attempt, and the failure is
  logged once per failure episode, with one line when it recovers. A
  strategy member lookup (`onPresented`, `onNewMessage`, `onRetracted`) that
  throws is logged as a hook failure rather than failing the stored operation.
  `stats()` adds `pendingStrategyNotifications: { presented, retracted,
  presentationScopeFailing }` so a host can see an adapter that is stuck. A
  custom strategy that compresses from `onNewMessage` makes no progress while
  the lookup keeps failing. `AutobiographicalStrategy` and
  `KnowledgeStrategy` implement `onPresented` and don't take this path;
  `PassthroughStrategy` and `WindowedPassthroughStrategy` deliberately
  implement only `onNewMessage` (a no-op), so their rows can wait too.
