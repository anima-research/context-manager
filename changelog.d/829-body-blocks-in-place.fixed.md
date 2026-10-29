- Where `adaptiveResolution` is on, a message ingress splits into shards
  goes out as it was given, wherever its shards render: every block in its
  place, and its text blocks with their own boundaries, in one entry. After
  a head-window reset, a body that leaves no call waiting and runs across
  the head's end still goes out in pieces around the history from before the
  reset, as before, and so can a reply that makes a call, in a store whose
  chunks begin partway through it, until the next reset. A text block cut
  across two shards comes back as one block of plain text, as cut text
  always did. The head and recent windows sent the body's other blocks ahead
  of its text and its text blocks as one, so a reply's tool call went out
  before its text. The adaptive middle sent its text alone, so a reply
  ending in a tool call lost the call and its result, an image went unsent,
  and a tool result whose message was split went out as the placeholder for
  a result that isn't shown. And a body whose shards fell in the middle and
  a window went out as two or three entries, which membrane's native
  formatter sends as one message with the body's text cut where the regions
  meet, so each time the recent window's edge crossed one of its seams the
  prompt was rewritten from that body on. The middle now sends each raw
  shard as any raw message is sent, cut at `maxMessageTokens` as the windows
  cut it and priced as the plan priced it, and the image strip judges each
  image at the shard that holds it.
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
  at the call's first shard that holds a `tool_use` or thinking, and, where
  parallel calls' results come one to a message, at the call those results
  answer. A message that answers only its own calls moves none of them back
  past its own start, and a result whose call is neither in the message
  before it nor among the parallel calls whose results come before it moves
  none of them: the recent window stepped back one message at any result,
  and the floor and the hold to the start of the message before one on its
  first shard. The recent window started at a split result message's later
  shard, leaving the result and its call out of the raw tail, and at a split
  call's last shard, leaving its `tool_use` out when the call was stored
  before blocks were kept in place. Tool-result pruning counts a sharded
  reply's calls as one turn, wherever they sit in it, and a result in its
  own call's message as answering nothing, on whichever of the message's
  shards the two sit, as it did for a message stored whole.
- The split fallback's cuts, the head window's end and the recent window's
  start now keep a tool call and all of its results on one side, wherever
  their shards hold the `tool_use` and the `tool_result`s: the call stays
  with each message after it that answers one of its calls, up to the first
  that answers none, as when parallel calls' results come in messages of
  their own, and a message that answers one and makes calls of its own adds
  them to those still waiting. Ingress keeps each block in place, so a
  result after a long text sits on its message's last shard, a call stored
  before blocks were kept in place has its `tool_use` on its first shard and
  its text on the shards after it, a call whose text follows its `tool_use`
  has the same shape, and a message that makes a call and answers it itself
  can hold the two on different shards. The head's end stepped back only
  past a message holding a `tool_use`, the recent window's start stepped
  back only from a message holding a result, and the split fallback kept
  together only a message holding a `tool_use` and the result messages right
  after it, so a piece or a window could end between a call and a result of
  it, and a recent window starting between parallel calls' results could
  refuse to compile (`UncoveredDropError`). Where each message answers the
  call before it and makes the next, the recent window's start steps back
  past the call its edge's result answers to the call before that one, and
  doesn't follow the chain further, since each step adds raw messages to the
  window: following a long chain to its start refused at budgets that
  compiled before. The earlier call is parted as before. The head's end
  stops outside a body that leaves a call waiting for a later result: where
  it would fall inside one, or just after one whose call sits on its last
  shard or is answered by the next message, it steps back to the body's
  start, every shard of it, where it stepped back one message. So after a
  head-window reset a reply that thinks and makes a call goes out whole
  after the history from before the reset. As before: a result that comes
  after a message answering none of the calls; a chunk closed where a pinned
  message, the head or an earlier chunk interrupts the compressible
  messages, and the Knowledge chunker's last, unclosed chunk; and the head's
  end moving forward to where chunks resume (#122). Chunk records and
  summaries already made are kept as they are; the Knowledge chunker, which
  keeps no chunk records, closes its chunks not yet summarized anew on each
  pass. In a store without shards, the head's end and the recent window's
  start move where they fell between a call and its results. Such a store,
  and one whose recent window's edge falls inside a call stored as shards,
  can rewrite its prompt once, from that edge, at its first compile after
  upgrading.
- A chunk's close after a call now waits until the whole message after it is
  in the chunk, every shard of it, and a message that makes a call and
  answers it itself keeps the two in one chunk across its shards. That is
  the rule for closing after a message that holds a `tool_use`, taken from a
  message to its shards. It waited one stored message, a single shard, so a
  result on a later shard of that message could fall in the next chunk; a
  compression request drops a `tool_result` whose call isn't in it, so such
  a result reached no summary. In a store without shards chunks close as
  before, parallel calls' results one to a message included.
