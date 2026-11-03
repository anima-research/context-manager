- A sharded `addMessage` that fails partway takes a shard a host's
  `onMessage` listener presented out of the window as it removes the shards
  it stored, and tells the strategy (`onRetracted`, with `removed`), as
  `removeMessages` does. Before, such a shard kept its ordinal, and the
  strategy, which heard it enter, never heard it leave.
