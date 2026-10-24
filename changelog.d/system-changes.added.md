- System changes: a message holding only membrane's `system_change` blocks
  (`SystemChangeContent`, membrane's release that adds them) changes the tools
  and system text the model is offered from its place on, and every strategy
  compiles it unaltered, in its place among the raw messages. (Under the
  autobiographical strategy's `positionedRecallPairs: false`, the middle's
  summaries go ahead of its raw messages, as they always have.) The
  autobiographical strategy, and with it `KnowledgeStrategy`, keeps it raw as
  a pin keeps a message, so no fold takes it and no chunk holds or spans it;
  after a head-window reset that leaves messages in the head window, the
  changes stored before the new head are part of the head, ahead of the head
  window, in order. `PassthroughStrategy` and
  `WindowedPassthroughStrategy` keep one that falls before their window,
  ahead of the window and priced into it, and the windowed strategy sizes a
  re-anchored window as its fraction of the room the changes leave. None is
  dropped: when the changes alone exceed the budget (beyond the
  autobiographical strategy's grace, and on its hierarchical path only where
  `enforceBudget` is on), every strategy refuses with `OverBudgetError`,
  `clearedBy` empty, until the caller consolidates them into `tools` and
  `system`; a dry compile reports where the strategy's other refusals do,
  which for the passthrough strategies is nowhere. They also refuse when the
  newest conversation message doesn't fit beside the changes, naming
  `newer-message` while they leave room for one.
  Compression never reads one. It's priced from its JSON. A write refuses one
  beside other blocks or inside a tool result, and one whose `removeTools` or
  `addSystem` isn't an array of strings, or whose `defineTools` isn't an array
  of tool definitions, each with a non-empty string `name`, a string
  `description` and an object `inputSchema` whose `type` is `'object'`; a read
  leaves such a change out. A write also refuses a change while one of the
  nearest calls before it has no result between it and the change (counting
  back over other changes and over results, by id, to the nearest message
  holding a call, every shard of it),
  a tool result answering a call that a change already follows, and an edit
  giving a message a `tool_use` that a change follows before its results:
  membrane sends a change there after the result anyway, so write it after
  the result. Ingress sharding never splits a message of them, since it holds
  no text block.
  Only membrane's `NativeFormatter`, on an adapter that sends system changes,
  sends one; elsewhere membrane refuses the request. Rolling back to a
  release without them isn't supported once a store holds one.
- `CompileResult.firstChanged`, optional: on a committing compile, the index
  of the first compiled message, injections included, whose participant or
  content bytes differ from the last committing compile's message at that
  index, or that has none there, so after appends alone it is the first
  appended index; an injection placed beside the newest user message moves
  with each new user message, so after one it's that injection's old index.
  It compares bytes, so it holds across a branch switch or a new strategy,
  and it's `null` only for the manager's first committing compile. A dry
  compile leaves it out and doesn't move it. It's compared when read,
  so a compile whose caller never reads it serializes only its injections.
