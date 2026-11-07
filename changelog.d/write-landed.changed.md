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
  error's message, so a check that the message contains or ends with it
  still matches; one that compares the whole message, or is anchored at its
  start, doesn't, and a check of the error's class meets the new classes
  instead. Every other failure of
  `addMessage` throws what it threw before.
- A sharded `addMessage` whose first shard's append threw, where the store
  couldn't be read to tell whether that shard landed, logged that removing
  what it wrote threw, though no removal ran. It logs that the read threw,
  so the shard may be stored.
- One failure point of an add is new: after the row lands, the manager's own
  add listener reads the window index, to tell whether a host presents rows
  on the branch (in legacy mode the strategy hears the row there). Where
  that read throws, an add that succeeded before fails after its row
  landed: `addMessage` throws `WriteLandedError` naming the row
  (`WriteOutcomeUnknownError`, with `unnamed` 1, where the read of whether
  the row landed throws too), the
  strategy isn't told the row entered, and an add listener registered
  after the manager's doesn't hear it.
- A sharded `addMessage` that fails partway where the store then can't say
  its branch removes nothing, as after a branch move, and logs the failed
  read: it throws `WriteLandedError` naming the shards stored, on the branch
  the write started on (`WriteOutcomeUnknownError`, with `unnamed` 1, where
  a shard's append threw). In legacy mode the strategy hears those shards
  once the store reads again. In 0.24.2 the branch wasn't read: the add
  removed what the current branch's tail held of the body group and threw
  the write's own error, which says none of the message was stored.
- `unnamed` is 1 only where a shard's append threw: a sharded `addMessage`
  that fails once every shard is stored (in legacy mode, the manager's own
  work telling the strategy of the body) and whose removal of them fails
  names every shard, with `WriteLandedError`.
- A sharded `addMessage` whose removal of the shards it stored fails after
  the strategy's `onCompressionHoldsReleased` hook, which that removal runs
  for a held shard, moved the store's branch throws
  `WriteOutcomeUnknownError`, naming every shard the write stored as
  `unknown`: which of them stayed is a question for the branch the write
  started on, which the store no longer reads. In 0.24.2 the add removed
  what the current branch's tail held of the body group (nothing of this
  write, after a move) and threw the write's own error.
- An `addMessage` of a message stored as one row whose append throws after
  a listener of its add moved the store's branch, or where the store then
  can't say its branch, throws `WriteOutcomeUnknownError` with `unnamed` 1:
  the row landed on the branch the add started on, if it did, which the
  store no longer reads, or may not. A host listener's throw is caught and
  logged, so this takes a log that throws too. In 0.24.2 a single-row add
  that failed threw the write's own error, whatever the store then held.
