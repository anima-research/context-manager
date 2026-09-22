- Compile overhead on large stores: `mergeAdjacentBodyGroupRaw` no longer
  fetches every raw entry's message from chronicle (with blob resolution) to
  read two shard fields; it indexes the store's cached listing once (~0.7 s
  saved per compile on a 75k-message store). kv-unified latent-demand
  ranking (the what-if merge solves) is cached on the strategy and reused
  while the summary-root runs and budget are unchanged, so it runs once per
  mint/merge instead of once per turn. On a copy of Sill's store with the
  certificate on, an unchanged turn compiles in ~1.1 s (was ~1.8 s).
