- `ContextManager.renderAsNewest(ids)`, with the optional
  `ContextStrategy.renderAsNewest?(store, ids)` behind it, which both
  strategies implement: what the next compile sends for messages just
  stored, among the newest of the window. Each comes back cut by the
  per-message cap, as one message where the compile joins a body's shards
  into one, and with every image decision the strategy makes there: its
  count, depth and byte limits, counted newest-first from the oldest of
  these messages to the newest stored. It's for a caller that appends
  messages it has just stored to a compiled request without recompiling,
  such as a turn's mid-turn injections, so that what it appends is what the
  next compile sends. The manager answers `undefined` when its strategy has
  no such hook, and `null` for a message the next compile doesn't send
  among its newest: one the view leaves out, or one it sends elsewhere,
  such as a body too big for the window's recent part. It refuses an id no
  stored message has, and, like a compile, releases compression holds that
  have timed out before it renders. What the next compile decides from its budget isn't
  foreseen: windowed passthrough's re-anchor, or its refusal of a newest
  message bigger than the budget; the memory strategy's refusal of a recent
  window over budget, or the adaptive select's drop of a provisional
  calibration that puts it over budget. Rendering doesn't change what a
  later compile sends.
