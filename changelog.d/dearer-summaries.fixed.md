- On the hierarchical select with positioned recall pairs (the default), a
  summary at any level goes out as its messages, raw, where they cost less
  than its recall pair, counting the stub result pairing repair gives a call
  of theirs that nothing in the conversation answers. It stays a summary where
  its messages aren't all in the view and contiguous, where one of them
  already goes out raw or under another summary the select chose, or where
  pairing repair on those messages alone would change anything but such stubs.
  The messages take the pair's place after the request's own pairing repair,
  so every other tool block goes out as that repair, run with the pair, left
  it. So the request carries no more than those messages and their stubs do,
  and a compile they fit is no longer refused (#407). In #407's probe, an L1
  whose recall pair cost 933 tokens went out in place of four messages that
  cost 456, and budgets the request would have fit with those messages raw
  were refused. This holds for every strategy built on the autobiographical
  one, `KnowledgeStrategy` included, whose `[LEAD]` marks are its summarizer's
  reading of the same messages. Under a `maxMessageTokens` cap, the messages
  are weighed and sent as the cap cuts them. With `positionedRecallPairs:
  false`, summaries stay in the combined answer as before. A store where a
  summary now goes out as its messages sends different requests from its first
  compile after the upgrade, so a provider's prompt cache serves them only up
  to where they first differ.
