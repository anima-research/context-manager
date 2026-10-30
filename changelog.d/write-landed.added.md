- `WriteLandedError`, exported from the root: what `addMessage` throws when
  it fails after storing some of the message (agent-framework #844). Its
  `landed` holds the ids of the message's rows the store holds, in store
  order, and its `cause` is the write's own error; its message ends with the
  cause's message. Any other error from `addMessage` means the manager found
  none of the message in the store, so a host that stores the message
  another way when an add throws can do so only then, and not store it
  twice.
  - It is thrown when a row stays: a message stored as one row, whose append
    failed after the row landed (the manager's own store listener failing
    inside it; a host's `onMessage` listener can't fail a write), or the
    shards of a sharded write that failed partway and whose removal of what
    it stored failed too, a body short of its `shardCount`.
  - A write that fails before a row lands throws its own error, unwrapped: a
    refusal of the message or of a shard as chunked (`MalformedContentError`),
    a chunking the manager refuses, a strategy not initialized, a store that
    refuses the first append. So does a sharded write that fails partway,
    once it has removed the shards it stored.
  - Where the store can't be read to tell what stayed, the error goes by the
    rows the manager knows the write stored: after a failed removal it names
    all of them, and where it knows of none, the write's own error is thrown
    and the manager logs that the message may be stored.
  - The add may have gone unheard: a failure in the manager's own listener
    ends the event before a host's `onMessage` listener hears it. Once a host
    presents rows, the rows are out of the window until it presents them
    (`presentRows(landed)`), and a `holdCompression` hold the add placed on
    them stays until `releaseCompression(landed)`. `resetHeadWindow` rejects
    with it when its transition's add fails so, without resetting the head
    window.
