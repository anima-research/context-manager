- Under `positionedRecallPairs: false` (with `adaptiveResolution` off, the
  only path that reads it), the combined recall answer cuts each summary to
  `maxMessageTokens` on its own, as a positioned recall answer is cut, in
  every `recallEnvelope` mode. Before, the whole answer was cut as one
  message at `maxMessageTokens`, so what the summaries past the cut held,
  with `'none'` their text, since the cut passed their other blocks through,
  and in the enveloped modes all of it, went out as one
  `[content omitted: this message reached its token limit]` block, and the
  compile counted the history under them as sent. A compile whose answer
  fits the cap sends the same bytes as before, unless a strategy overrides
  `liveWindowAnswerContent` or `truncateContent`: with `recallEnvelope` at
  `'none'`, its default, the answer was built from `liveWindowAnswerContent`
  and cut as one message, and in every mode it is now built from
  `liveWindowAnswerProse`, with each summary's prose cut by
  `truncateContent` to the whole cap, as a positioned answer is. Past the
  cap, the answer holds every selected summary except any whose own cut
  leaves nothing of it that holds anything, and can be longer than
  `maxMessageTokens`; past the grace window it refuses with
  `OverBudgetError`, as a positioned pair does, and where it leaves the
  recent window too little room within the grace window, the compile refuses
  with `UncoveredDropError` for the recent messages it can't send. The
  compile's layout, and so the fold journal, names each summary the answer
  holds, whole or partial by its own cut, where the old cut named the later
  ones partial or left them out. The first compile after upgrading that is
  past the cap can change the request from the recall pair on, which then
  misses the prompt cache from there. `maxMessageTokens`' doc adds: "The
  combined recall answer of `positionedRecallPairs: false` is the exception.
  Each summary in it is cut to this limit, as a positioned recall answer is,
  so the answer as a whole can pass it."
- The coverage check counts only the summaries the combined recall answer
  lists. A summary left out of it, by a strategy's own
  `renderCombinedRecallAnswer` or because its own cut leaves nothing of it
  that holds anything (leading blank text that fills `maxMessageTokens` by
  itself), now refuses the compile with `UncoveredDropError` unless the
  compile sends its messages some other way, raw or in another summary.
  Before, the compile went out without that history.
