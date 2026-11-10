- With `adaptiveResolution`, a message stored in parts keeps its other blocks
  in the adaptive middle. A run of a body's raw parts there used to go out as
  their text alone, so a long reply lost its thinking and its tool call, the
  call's result was then dropped by pairing repair, and a long user message
  lost its images. The middle, kv-unified's cache check, and the head and
  recent windows now join every run of a body's raw parts, a lone part
  included, with `joinBodyParts`, newly exported: their non-text blocks in
  stored order, then their text, left out where the joined text is empty. A
  lone part used to go out as stored, text first. `concatBodyGroups` keeps
  non-text blocks in place of writing placeholders, and leaves out the text
  block where the joined text is empty.
- The middle now sends and prices each raw part cut at `maxMessageTokens`, as
  the head and recent windows do. Where the cap is under a part's size, the
  middle's document text is cut where it used to go out whole, and a compile
  its uncut price refused can now fit.
- Each image is kept or stripped by the verdict of the part it's stored on.
- Ingress puts a split message's non-text blocks from its first `tool_use` on,
  or, in a message that holds a `tool_use`, from its first thinking on, on its
  last part, and the others on its first, where it used to put them all on its
  first. A reply's call then sits next to its result with the thinking that
  led to it, and the reply's earlier parts can fold apart from it. For a body
  stored before, with its call on its first part, the recent window's start, a
  compression hold, the head window's end and the chunker each keep the call's
  result with the whole body, as they keep a result with a call stored whole.
  One case keeps its old end: a chunk closed before the upgrade and not yet
  summarized. Where a chunk closed before the upgrade owns some of such a
  body's parts, a window's edge isn't held at the chunks' coverage where
  holding it there would part the call from its result. The recent window
  then starts at the latest edge before the hold that parts nothing, never
  after the body's first part and never before the start it has without the
  holds; the head keeps the end it has without the hold. Where the head
  reaches forward to the chunks' coverage, it reaches past the result, to the
  first message the chunks own where it parts no call from its result. Each
  summary over a message a window then takes in is left out, and all of that
  summary's messages go raw. Where the head's count lands inside such a body
  and the store's newest chunk, one closed before the upgrade, starts inside
  it and holds its result, the head ends before the body, and a selection
  that folds that chunk sends the call with a stub, its result in the
  chunk's summary.
- A message with a block that carries a provider item (an object `rawItem`, as
  a Responses reply's message parts and reasoning do) is stored whole, however
  long, with every item in its place. It's capped as one message, and folds as
  one unit where its parts used to fold apart. So where a newest such message,
  cut at `maxMessageTokens` where one is set, is too large to go raw with what
  else the compile must send, the compile now refuses, where its earlier parts
  used to fold.
- A compile refuses when structural repair trims the newest message, as it
  does when it trims a whole newest turn, even where an earlier part of the
  same body goes out. That's a newest reply whose last part holds a call with
  no result yet.
- Where messages each hold the result of the call before them and a call of
  their own, the recent window's start, a compression hold and the head
  window's end now move back to the run's first message, however long the run,
  the head window's end back to the head's own start at most, where they used
  to move back one message and part the call before it from its result.
  Messages that each answer their own call still move them back one message.
- **Hosts upgrading a store:** a body stored before with its call on its first
  part keeps more tokens raw for a while. While the recent window's start, or
  a compression hold, falls inside it or on its result, that window or hold
  takes the whole body (the head window gives such a body up whole). And if it
  isn't yet in a closed chunk when the host upgrades, the chunk that takes it
  closes only after its result, so the body stays raw until that chunk is
  summarized, where its earlier parts used to fold. A probe of the chunker's
  rule alone, on the previous release, measured this once: after compression,
  with no message after it, a 30,000-token reply stored that way kept about
  20,000 tokens more raw, and a compile at a 70,000-token budget was refused
  where the release without the rule compiled. A body stored after the upgrade
  doesn't pay this.
- **Hosts upgrading a store where a split message holds a block other than
  text, or a part the cap cuts:** the first compile after the upgrade can send
  that message differently. The provider's cached prefix then misses once,
  from the first message that changed; with thinking binding, thinking from
  that message on is left out, as after any change to history already sent;
  and kv-unified credits no cache marker past it. A calibration multiplier
  learned before the upgrade is set aside and learned again from the next
  sample.
