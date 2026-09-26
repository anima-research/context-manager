- Compile overhead on large stores: `mergeAdjacentBodyGroupRaw` no longer
  fetches every raw entry's message from chronicle (with blob resolution) to
  read two shard fields; it indexes the caller's message listing once (~0.7 s
  saved per compile on a 75k-message store).
