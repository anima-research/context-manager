- A sharded `addMessage` records `shardCount`, its group's size, on every
  shard, and writes the shards in index order, so the id it returns is shard
  0's. Compile provenance counts a group that declared its size as complete
  only when every declared shard is stored and carried. A write that fails
  partway removes the shards it wrote from the store, so a retry writes one
  body. A group left short anyway (a crash mid-write, or a failed write whose
  shards couldn't be removed) is missing `shards`, before or after a reopen,
  even though its members can't be edited. For a group written before sizes
  were declared, `complete` keeps a weaker meaning: every member stored for it
  was carried. That does not prove the group was ever written whole. A
  chunking decision whose indices aren't exactly 0..n-1 is refused before
  anything is written.
