- With `adaptiveResolution` on, a message with a block that carries a provider
  item (an object `rawItem`, as a Responses reply's message parts and reasoning
  do) is stored whole, however long, rather than split into shards. Split, it
  lost the items on its text, such as a compaction item or a message item's
  `phase`, and its other items moved after the first shard's text. Such a
  message is one unit for folding. Messages already stored stay as they were
  stored.
- With `maxMessageTokens` set, a raw message keeps a zero-width carrier past the
  cut, such as a Responses compaction item or an Anthropic server tool's call
  or result. That holds in the autobiographical strategy (and so the knowledge
  strategy) and in windowed passthrough. Before, the carrier was dropped with
  the text after it. A long message that carries an item is stored whole, so
  past the cap its text is cut, where its shards went out uncut before. A cut
  part of a Responses message item still gives up the item. An override of
  `truncateContent` that calls the base needs to pass `keepCarriers` on.
