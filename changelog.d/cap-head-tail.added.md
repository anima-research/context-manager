- `ContextManager.capMeasuredText({ id, toolUseId? })` returns the text the
  per-message cap measures for a stored message or a summary, read through
  this agent's view: a message's text blocks and string tool results as the
  strategy sends them before the cut, a summary's answer prose, or with
  `toolUseId` that call's input as JSON. A capped message's marker gives
  offsets into it, so a reader paging it from the marker's first offset
  reads exactly what the cap elided. It returns null for a row the view
  doesn't hold, an id nothing has, a call the message doesn't hold, and
  under a strategy with no per-message cap. Strategies answer it through
  the optional `ContextStrategy.capMeasuredText`, which the autobiographical
  (so knowledge) and windowed passthrough strategies implement.
- `capReadHint` (`AutobiographicalConfig`, `WindowedPassthroughOptions`), of
  type `CapReadHint`, is the host's clause for reading what the cap elided,
  written after `; ` before each marker's `]`: called with the stored id
  and the first elided offset (`offsetChars`), or with the call's id
  (`toolUseId`) for a cut tool input. It must be pure, since every compile
  writes it into the request again. Without it a marker names the stored
  message or summary by id alone.
