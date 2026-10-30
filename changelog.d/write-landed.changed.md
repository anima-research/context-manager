- `addMessage` throws `WriteLandedError` where it threw the write's own error
  with some of the message stored: a message stored as one row whose append
  failed after the row landed, and a sharded write whose removal of the
  shards it stored failed. The write's own error is its `cause`, and its
  message ends with that error's message, so a check of the message still
  matches; a check of the error's class meets `WriteLandedError` instead.
  Every other failure of `addMessage` throws what it threw before.
