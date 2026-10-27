- `renderAsNewest` gives `null` only for a message the next compile doesn't
  send: one the view leaves out, or one before windowed passthrough's
  anchor. Under the memory strategy it gave `null` for any message before
  the recent window or in a head window followed by other messages, though
  the compile sends those raw. So a batch bigger than the recent window
  came back partly `null` while the next compile sent all of it, in order,
  as its last messages (context-manager#275's review, R1-1). Each such
  message now comes back in the form the compile sends it, cut by the
  per-message cap and with the image limits counted over the batch as a
  compile counts them. Two kinds of message still differ, and the doc names
  both: a message a summary covers comes back raw where the compile's plan
  sends the summary, and a sharded body whose shards the compile doesn't
  send together comes back whole, as the windows join it. The adaptive
  middle sends its shards' text alone, uncut, and a body across the middle
  and a window, or across a reset head window's end, goes out in more than
  one entry. After a head-window reset the head is sent before the history
  from before the reset, and so is each system change stored before the
  head, so those messages render in the form the compile sends but aren't
  sent last. A render no longer releases a
  compression hold that has timed out, since where a window starts no
  longer changes what it gives; the next add, compile, tick or hold query
  releases it, as each did before.
- The doc says what else a render can't foresee. A batch's images can strip
  older images a request already carries. Tool blocks come back as the cap
  leaves them, while the memory strategy's hierarchical select leaves out a
  newest message that holds a `tool_use` with no result after it and its
  adaptive select refuses that compile, both drop a `tool_result` whose
  call isn't sent before it, and the manager splits a message other than a
  user's that holds a `tool_result` into several turns.
- The doc says whom the render is for: a caller that appends messages it
  has just stored to a compiled request, and one that renders messages its
  stream has already sent, as `noteRequestSent` does over a whole turn's
  rows.
