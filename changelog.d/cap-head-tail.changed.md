- A message over `maxMessageTokens` keeps its head and its tail, about 60%
  and 40% of what it keeps, each end moved to a line break within half its
  share, around one marker that says which characters it elided and where
  the whole is stored. The marker's characters index the text the cap
  measures, a message's text blocks and string tool results joined, which
  `ContextManager.capMeasuredText` returns (see `.added`). What residents
  read changes:
  - Old: the kept head, then `[truncated — original was N tokens]`.
    New: the head, then `[truncated — chars H to T of M elided here; the
    whole is stored message ID]`, or `stored summary ID` for a recall
    answer's summary, with the host's `capReadHint` clause before the `]`,
    then the tail.
  - Old: `[content omitted: this message reached its token limit]` where the
    first dropped text block was. New: no such block. Text blocks wholly in
    the middle are dropped, and the one marker stands where the middle
    starts. The old text remains only as a combined recall answer that holds
    no summary.
  - Old: a string tool result past the cap became `[content omitted: this
    message reached its token limit before this result]`. New: one wholly
    in the middle becomes `[truncated — this result is elided; the whole is
    stored message ID]`, and one the tail starts in begins `[truncated —
    this result's start is elided; the whole is stored message ID]` before
    its kept end. Where the middle starts in a string tool result, the
    marker is in that result's content, so the result keeps its pairing.
  - Old: a `tool_use` input over `toolUseInputMaxTokens` became
    `{ "_truncated": true, "_originalTokens": N, "_keys": [...] }`. New: it
    gains `"_whole": "[truncated — this call's input, M chars, is elided;
    the whole is stored message ID, call TOOL_USE_ID]"`, with the hint's
    clause before the `]`. The input's text is still not kept. An input
    over the cap whose stub would be no shorter than it now goes whole,
    where `main` sent the stub.
  - `maxMessageTokens`' doc. Old: "Messages exceeding this limit have their
    text/tool_result content truncated." New: "A message exceeding this
    limit keeps the head and the tail of its text and string tool results,
    around one marker naming the characters it elided and the stored
    message whose whole holds them (`capContent`). Each summary in a recall
    answer is cut so too, its marker naming the summary, so the combined
    recall answer of `positionedRecallPairs: false` can pass the limit as a
    whole."
- The cut measures what it keeps by the strategy's own estimate, asked of
  the kept text blocks and the marker alone, where it kept four characters
  a token. So a long thinking block still doesn't shrink the text kept, the
  marker counts against the cap, and content whose text fits by characters
  but whose estimate, rounded up block by block, passes the cap is now cut.
  Text blocks that hold nothing are left out at no loss: where leaving
  them out brings a message under the cap, it comes back without them and
  nothing else is cut. `main` left out such a block only once it passed
  the cap's characters, and then cut away the text after it. A cap
  smaller than the cut that keeps nothing, the marker and a notice for each
  later string tool result, sends that cut, over the cap, with any block
  the cut passes through, such as thinking, though a cut keeping a short
  result whole could fit. That cut is never longer than the whole: where
  the marker and those notices estimate at least as much as the text they
  would stand for, the message goes whole. The cut halves over how much it
  keeps, and keeping more can cost less, so it can keep less than the
  largest cut that fits. A text block that holds nothing, or an opaque
  carrier, at the end is now kept in the tail, where past the cap it was
  left out. A strategy's `truncateContent` override gains a `whole`
  argument naming the stored message or summary; an override that doesn't
  pass it on gets markers that name none.
- Under `positionedRecallPairs: false` (with `adaptiveResolution` off, the
  only path that reads it), the combined recall answer cuts each summary on
  its own, head and tail, as a positioned recall answer is cut, in every
  `recallEnvelope` mode. Before, the whole answer was cut as one message,
  so what the summaries past the cut held, with `'none'` their text, since
  the cut passed their other blocks through, and in the enveloped modes all
  of it, went out as one omission block, and the compile counted the
  history under them as sent. A compile whose answer fits the cap sends the
  same bytes as before, unless a strategy overrides
  `liveWindowAnswerContent` or `truncateContent`: with `recallEnvelope` at
  `'none'`, its default, the answer was built from
  `liveWindowAnswerContent` and cut as one message, and in every mode it is
  now built from `liveWindowAnswerProse`, with each summary's prose cut by
  `truncateContent`, as a positioned answer is. Past the cap,
  the answer holds every selected summary except any whose head and tail
  hold nothing, and can be longer than `maxMessageTokens`; past the grace
  window it refuses with `OverBudgetError`, as a positioned pair does, and
  where it leaves the recent window too little room within the grace
  window, the compile refuses with `UncoveredDropError` for the recent
  messages it can't send. The coverage check counts only the summaries the
  answer lists, so a summary left out of it, by a strategy's own
  `renderCombinedRecallAnswer` or because its head and tail hold nothing (a
  cap smaller than the marker leaves every summary longer than its marker
  so, unless a block such as thinking survives its cut), refuses the
  compile with `UncoveredDropError` unless the compile sends its messages
  some other way. The compile's layout, and so the fold journal, names each
  summary the answer holds, whole or partial by its own cut. A positioned
  recall answer keeps a summary its cut leaves as the marker alone, listed
  as partial, as it keeps any summary it cuts.
- Prompt cache: a request changes from the first capped message, cut
  summary or cut tool input this version renders differently from the
  version before, once, the first compile after upgrading, and again from
  the first marker or stub where a host starts supplying `capReadHint`.
