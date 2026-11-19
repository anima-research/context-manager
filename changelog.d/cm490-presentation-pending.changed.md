- **Strategies with only `onNewMessage`:** when the `onNewMessage` delivery
  adapter can't read the store's branch or the window mode to deliver a stored
  row's notification, `addMessage` (and the other notifying calls) no longer
  throw after storing. The add listener's own window-mode read runs before
  that adapter and is not guarded: if it throws, `addMessage` still throws
  after storing (`WriteLandedError`, or `WriteOutcomeUnknownError` when the
  row can't be read back) and the row is not queued. Queued rows wait in
  memory, on this manager, until a later notification finds the scope
  readable; the retry then delivers, once each and in window order, the
  queued rows still in the window, and a row that left the window meanwhile
  gets no call. Close discards the rows waiting when it runs. Each
  notification makes one attempt, and the failure is logged once per failure
  episode, including window reads in the presentation
  retry drain, with one recovery line on a successful adapter observation. A
  strategy member lookup (`onPresented`, `onNewMessage`, `onRetracted`) that
  throws is logged as a hook failure rather than failing the stored operation;
  a retraction whose `onRetracted` lookup throws is consumed, not queued for a
  later notification as it was when the throw propagated.
  `stats()` adds `pendingStrategyNotifications: { presented, retracted,
  presentationScopeFailing }` so a host can see an adapter that is stuck. A
  custom strategy that compresses from `onNewMessage` makes no progress while
  the lookup keeps failing. `AutobiographicalStrategy` and
  `KnowledgeStrategy` implement `onPresented` and don't take this path;
  `PassthroughStrategy` and `WindowedPassthroughStrategy` deliberately
  implement only `onNewMessage` (a no-op), so their rows can wait too.
