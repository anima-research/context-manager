- With `adaptiveResolution` on, a message with a block that carries a provider
  item (an object `rawItem`, as a Responses reply's message parts and reasoning
  do) is stored whole, however long, rather than split into shards. Split, it
  lost the items on its text, such as a compaction item or a message item's
  `phase`, and its other items moved after the first shard's text. Such a
  message is one unit for folding. Messages already stored stay as they were
  stored.
