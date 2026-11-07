- `ContextManager.generateTransitionSummary()`: the transition summary
  `resetHeadWindow()` would write of the head window as it stands, storing
  nothing (the strategy's `generateTransitionSummary` over the manager's own
  strategy context, which a host reached before only through a cast). It
  refuses as `resetHeadWindow()` does, before the manager is initialized and
  for a strategy that can't reset its head window, and also when the manager
  is initialized again or its branch moves while the summary is written. A
  host that checks its own conditions between this call and
  `resetHeadWindow(summary)` (an idle agent, nothing moved) stores a
  transition only when they hold.
