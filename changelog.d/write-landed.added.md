- `WriteLandedError` and `WriteOutcomeUnknownError`, exported from the root:
  what `addMessage` throws when it fails with some of the message stored, or
  can't tell whether some is (agent-framework #844). What a failed
  `addMessage` throws tells a host which of three things happened:
  `WriteLandedError` means the store holds the rows of the message its
  `landed` names, in store order, and no others; `WriteOutcomeUnknownError`
  means the manager can't tell whether the store holds some row of the
  message, because the read of the store that would tell threw; any other
  error means the store holds none of the message, so a host that stores the
  message another way when an add throws can do so then, and not store it
  twice. Both carry the write's own error as their `cause`, and their
  messages end with the cause's message.
  - `WriteLandedError` is thrown when a row stays: a message stored as one
    row, whose append failed after the row landed (the manager's own store
    listener failing inside it; a host's `onMessage` listener can't fail a
    write), or the shards of a sharded write that failed partway and whose
    removal of what it stored failed too, a body short of its `shardCount`.
  - `WriteOutcomeUnknownError` names what the manager knows: `landed`, the
    rows it knows are stored, possibly none; `unknown`, rows the write
    stored that a removal that threw may have taken out, where the store
    can't be read to tell which stayed (the removal is one write, so all of
    them stayed or none did); and `unnamed`, 1 where the store can't be read
    to tell whether the row of the append that failed the write landed (an
    append that throws returns no id), else 0. It is thrown for a message
    stored as one row, or a sharded write's first shard, whose append threw
    where the store can't be read to tell whether its row landed (nothing is
    removed, and the failed read is logged), and for a sharded write that
    stored shards before the failing one, where that read failed and the
    removal of what it stored failed too, or the read of what that removal
    left failed. A read of the store, once it reads, tells the rest.
  - A write that fails before a row lands throws its own error, unwrapped: a
    refusal of the message or of a shard as chunked (`MalformedContentError`),
    a chunking the manager refuses, a strategy not initialized, a store that
    refuses the first append. So does a sharded write that fails partway,
    once it has removed the shards it stored: the removal takes the failing
    shard's row out with them where it landed, whether or not the store
    could be read to tell that it did.
  - The add may have gone unheard: a failure in the manager's own listener
    ends the event before a host's `onMessage` listener hears it. Once a host
    presents rows, the rows are out of the window until it presents them
    (`presentRows(landed)`), and a `holdCompression` hold the add placed on
    them stays until `releaseCompression(landed)`. `resetHeadWindow` rejects
    with either error when its transition's add fails so, without resetting
    the head window.
