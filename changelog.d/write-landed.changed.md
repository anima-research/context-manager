- `addMessage` throws `WriteLandedError` where it threw the write's own error
  with some of the message stored: a message stored as one row whose append
  failed after the row landed, and a sharded write whose removal of the
  shards it stored failed. It throws `WriteOutcomeUnknownError` where it
  threw the write's own error and the store couldn't be read to tell whether
  some of the message was stored: the read of whether the failing append's
  row landed threw, for a message stored as one row, a sharded write's first
  shard, or a later shard where removing the shards before it failed too, or
  the read of which shards a failed removal left threw. The
  write's own error is the `cause` of both, and their messages end with that
  error's message, so a check of the message still matches; a check of the
  error's class meets the new classes instead. Every other failure of
  `addMessage` throws what it threw before.
- A sharded `addMessage` whose first shard's append threw, where the store
  couldn't be read to tell whether that shard landed, logged that removing
  what it wrote threw, though no removal ran. It logs that the read threw,
  so the shard may be stored.
