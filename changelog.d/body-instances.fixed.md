- Two ingestions of one text are two bodies everywhere a sharded message is
  read as a whole. The chunker names a shard group by a hash of its text, so a
  document posted twice (or a write cut short and then retried) stores two
  runs of shards under one `bodyGroupId`. Readers that took the group id for
  the body ran the copies together:
  - the autobiographical render, and `concatBodyGroups`, sorted both runs by
    shard index and interleaved them;
  - merging adjacent raw shards in the head and recent windows did the same;
  - `removeBodyGroup` removed both copies, and `removeRange` refused a range
    ending between them;
  - `getMessageWindow` with `alignToBodyGroups` widened a window across them;
  - reading mode counted the document twice, and a chunk spanning both
    copies read as part of one document;
  - the compression-hold boundary stepped back over the earlier copy;
  - the newest-turn guard accepted an earlier copy for the newest one.

  In store order a message now continues the body before it only when it
  carries the same group id at a higher shard index (each ingestion writes
  its shards 0..n-1, so the next one starts again at 0). The rule is read
  pairwise, so it also holds where a render region begins inside a body: the
  cut body's remainder is never joined to the next copy. `continuesBody`,
  `bodyStart`, `bodyEnd`, `bodyBounds` and `bodyBoundsIn` give that reading
  to hosts. A stored conversation holding a reposted sharded document renders
  differently after the upgrade, so its first request misses the prompt cache.
- The newest-turn guard no longer refuses a render that kept the newest body
  in the middle region (which happens when its newest shard alone outgrows the
  recent window): it now also reads a composite's `sourceMessageIds`.
