- A sharded `addMessage` records `shardCount`, its group's size, on every
  shard. Compile provenance counts a group that declared its size as complete
  only when every declared shard is stored and carried. A group that an
  interrupted write left short (before or after a reopen) is missing `shards`
  even though its members can't be edited. For a group written before sizes
  were declared, `complete` keeps its weaker, view-relative meaning: every
  member the view holds was carried. That does not prove the group was ever
  written whole. A chunking decision whose indices aren't exactly 0..n-1 is
  refused before anything is written.
