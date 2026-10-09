- `concatBodyGroups` reads its input in store order, where a body's shard
  indices rise: a shard whose index doesn't rise starts another body. It no
  longer sorts a run of one group id by `shardIndex`, which is what
  interleaved two copies of one document. Pass shards in the order the store
  returns them, as context-manager's own render does.
