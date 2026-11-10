- **A recalibration no longer moves a window's edge over messages a chunk
  owns.** The head window's end and the recent window's start are counted in
  tokens at the live calibration multiplier, so a fall of a few percent let
  either count reach one more message, one a chunk already owned. Sent raw
  from the window, that message left out every summary over it (the rule of
  0.24.1): the rest of its chunk went out raw, and each summary above gave way
  to the ones it had merged. At the head's end that changed the request from
  the head on, so it missed the prompt cache there, and a model that binds a
  reply's thinking to everything before it dropped the thinking of every
  reply. Chunks are only cut outside both windows, so chunk records say
  where each edge was when they were cut, and both edges now hold there: the
  head ends at the first message a chunk owns (it already extended to that
  message when a rise left it short, #122), and the recent window starts
  after the last. Each hold is bounded by a factor of two of the window's
  setting, so a window that was really widened takes what its count says: a
  `headWindowTokens` or `recentWindowTokens` raised to more than twice what
  the chunks left applies at once. A smaller raise of `recentWindowTokens`
  now fills from new messages, and a smaller change of `headWindowTokens`
  moves nothing. Neither hold parts a tool call from its result, and the
  head's doesn't apply where it would move a message no chunk owns out of
  the head, to be chunked late. A subclass turns the holds off by
  overriding `windowsHoldAtCoverage`.
