- Where `adaptiveResolution` is on, a message ingress splits into shards
  goes out as it was given, wherever its shards render: every block in its
  place, and its text blocks with their own boundaries, in one entry. A text
  block cut across two shards comes back as one block of plain text, as cut
  text always did. The head and recent windows sent the body's other blocks
  ahead of its text and its text blocks as one, so a reply's tool call went
  out before its text. The adaptive middle sent its text alone, so a reply
  ending in a tool call lost the call and its result, an image went unsent,
  and a tool result whose message was split went out as the placeholder for
  a result that isn't shown. And a body whose shards fell in the middle and a
  window went out as two or three entries, which membrane's native formatter
  sends as one message with the body's text cut where the regions meet, so
  each time the recent window's edge crossed one of its seams the prompt was
  rewritten from that body on. The middle now sends each raw shard as any raw
  message is sent, cut at `maxMessageTokens` as the windows cut it and
  priced as the plan priced it, and the image strip judges each image at the
  shard that holds it.
- A body stored before renders as it did wherever the head and recent
  windows hold it. In the middle it now sends its other blocks as the
  windows always did, ahead of its text, and across the middle and a window
  it is one entry. A stored window holding such a body raw in the middle
  with other blocks, or across the middle and a window, misses the prompt
  cache from that body on, on its first request after the upgrade, and so
  does one whose recent window starts at a tool result whose call is such a
  body, or whose edge falls on a later shard of a split tool-result message
  (next item).
- The recent window's start, the head and tail reservation's floor and the
  compression hold's boundary keep a tool result with its call wherever the
  message at the boundary holds the result, on any of its shards, starting
  at the call's first shard that holds a `tool_use` or thinking. The recent
  window started at a split result message's later shard, leaving the result
  and its call out of the raw tail, and at a split call's last shard,
  leaving its `tool_use` out when the call was stored before blocks were
  kept in place. Tool-result pruning counts a sharded reply's calls as one
  turn, wherever they sit in it.
- Compression keeps a tool call and the message answering it in one
  chunk, and the head window's end leaves them on one side, wherever in
  their shards the `tool_use` and the `tool_result` sit: a result after a
  long text now sits on its message's last shard, and a call stored before
  blocks were kept in place has its `tool_use` on its first shard and its
  text on the shards after it. A chunk's close waited only one message past
  a `tool_use`, and the head's end stepped back only past a message holding
  one, so such a call's text shards could end a chunk, or the head, with its
  result after them. A compression request drops a `tool_result` whose call
  isn't in it, so a result parted that way from its call by a chunk reached
  no summary.
