- With `adaptiveResolution` on, a message with a block that carries a provider
  item (an object `rawItem`, as a Responses reply's message parts and reasoning
  do, or an Anthropic server tool's call and result) is stored whole, however
  long, rather than split into shards. Split, it lost the items on its text,
  such as a compaction item or a message item's `phase`, and its other items
  moved after the first shard's text. Such a message is one unit for folding.
  One whose text would have been split goes out uncut past `maxMessageTokens`,
  as its shards did, so a long Responses reply keeps its message item. With a
  cap below a shard's size, that sends whole what was cut shard by shard, and a
  store that turns `adaptiveResolution` on after storing such a message whole
  sends it uncut too. Messages already stored stay as they were stored.
- With `maxMessageTokens` set, a raw message keeps a zero-width carrier past the
  cut, such as a Responses compaction item or an Anthropic server tool's call
  or result. That holds in the autobiographical strategy (and so the knowledge
  strategy) and in windowed passthrough. Before, the carrier was dropped with
  the text after it. A cut part of a Responses message item still gives up the
  item. An override of
  `truncateContent` that calls the base needs to pass `keepCarriers` on.
