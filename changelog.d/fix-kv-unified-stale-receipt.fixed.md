- kv-unified: a stale presentation receipt no longer makes the Pareto label
  count superlinear. Extension tokens (rendered tokens not covered by the
  accepted presentation) are no longer a state-key dimension; they are a
  dominance dimension while a provider cache is relevant (the cache term
  prices them) and a cover-envelope term reported in the a-posteriori error
  bound (`approximationCacheErrorBound`). Separately, the first successful
  presentation by a non-kv-unified folding strategy supersedes a persisted
  `kvunified:presentation-receipt` (loading, previewing, dry-running or a
  failed compile leave it untouched), so a switch back to kv-unified starts
  from an empty chain instead of measuring against a days-old baseline. A
  kv-stable → kv-unified switch on a production store went from
  "exceeded ceiling 100000 at 125796" (and >5 GB at a 1M ceiling) to a
  332 ms / 436 MB solve under the same ceiling. (#97)
