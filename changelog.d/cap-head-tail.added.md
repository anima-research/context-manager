- `ContextManager.capMeasuredText({ id, toolUseId? })` returns the text the
  per-message cap measures for a stored message or a summary, read through
  this agent's view: a message's text blocks and string tool results as the
  strategy sends them before the cut, a summary's answer prose, or with
  `toolUseId` that call's input as JSON. A capped message's marker gives
  offsets into it, `chars H to T of M`, in UTF-16 code units (JavaScript
  string indices) from 0, so a reader paging it from H reads exactly what
  the cap elided. They index the text as the compile that wrote the marker
  sent it: where tool pruning has since replaced a result of that message,
  the text read now differs, so a reader whose text's length isn't M
  doesn't page it; a replacement of the same length passes that check. It returns null for a row the view
  doesn't hold, an id nothing has, a call the message doesn't hold, any
  call under windowed passthrough, which cuts no call's input, and under a
  strategy with no per-message cap. Strategies answer it through
  the optional `ContextStrategy.capMeasuredText`, which the autobiographical
  (so knowledge) and windowed passthrough strategies implement.
- `capReadHint` (`AutobiographicalConfig`, `WindowedPassthroughOptions`), of
  type `CapReadHint`, is the host's clause for reading what the cap elided,
  written after `; ` before each marker's `]`: called with the stored id
  and the first elided offset (`offsetChars`), or with the call's id
  (`toolUseId`) for a cut tool input. It must be pure, since every compile
  writes it into the request again. Without it a marker names the stored
  message or summary by id alone, and so does a marker it throws for: a
  hint that throws fails no compile, and the strategy logs its first
  throw.
