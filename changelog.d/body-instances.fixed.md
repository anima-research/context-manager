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
  `bodyEnd`, `bodyBounds` and `bodyBoundsIn` give that reading to hosts.
