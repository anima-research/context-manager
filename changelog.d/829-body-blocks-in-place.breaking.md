- **Hosts that join a sharded body's stored shards themselves:** where
  `adaptiveResolution` is on, a message ingress splits into shards now keeps
  each of its blocks in place. Each shard holds its slice of the message's
  blocks, in order: its text blocks keep their own boundaries, cut where a
  seam falls inside one, and every other block (an image, a document,
  thinking, a tool call or result) is on the shard holding its place in the
  text, so a reply ending in a tool call has the call on its last shard.
  Every shard after the first declares `continuesBlock`, whether the seam
  before it fell inside a text block. Before, a body's text was joined into
  one block across its shards and every other block was on its first shard,
  after its text.
  - **Who needs to act:** whatever renders a body from its stored shards
    rather than from a compile. Join them with `joinBodyContent`, now
    exported, as the strategy's raw renders do. It gives a body stored this
    way back as it was given, from shards that keep their `continuesBlock`,
    and one stored before as the windows always sent it: its other blocks
    first, then its text as one block. Where a caller joined shards that way
    (`[...others, { type: 'text', text }]`), that is now
    `joinBodyContent(shards)`. A caller that merged adjacent text blocks
    across shards gets one block where two text blocks were given, and on
    moving to `joinBodyContent` shows a body stored before in the windows'
    order rather than in its shards' order.
  - **Two such callers:** agent-framework's `asCompiled`, which carries a
    deferred write's drained copy as later compiles render it, joins as the
    windows did, so for a body stored this way it puts the other blocks
    ahead of all the text, where compiles send the body as given. Its change
    is `joinBodyContent(landed)`, with each stored copy carrying
    `continuesBlock`. connectome-host's Web UI (`coalesceAndFlatten`) merges
    every adjacent pair of text blocks across a body's shards, so it shows
    two given text blocks as one. Its change is to carry `continuesBlock` on
    its message type, to take a body's run as the shards that continue it
    (`continuesBody`, pairwise in store order) rather than every adjacent
    shard with an equal `bodyGroupId`, and to join each run with
    `joinBodyContent`. The same text ingested twice in a row shares one
    `bodyGroupId`, so grouped by that id the two bodies go to one join.
  - **Refused:** an override of `chunkIngressMessage` whose shards declare
    `continuesBlock` on some shards after the first and not others is
    refused before any shard is written. A first shard's declaration is
    stored as given, and no join uses it.
  - **Unchanged:** bodies stored before keep their shards as they are. The
    seams fall where they did, so each shard holds the same text as before,
    and a body keeps its `bodyGroupId`. `concatBodyGroups` still renders a
    body as text alone, with a placeholder for each other block. A release
    before this one renders a body stored this way as it renders its own
    sharded bodies: in the windows its other blocks first and its text
    joined, and in the middle its text alone.
