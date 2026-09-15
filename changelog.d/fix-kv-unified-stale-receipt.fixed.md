- kv-unified: a stale presentation receipt no longer makes the Pareto label
  count superlinear. Extension tokens are keyed at token-bucket resolution and
  only while a provider cache is relevant (they feed only the cache-churn term),
  and a non-kv-unified folding strategy now supersedes a persisted
  `kvunified:presentation-receipt` on load, so a switch back to kv-unified
  starts from an empty chain instead of measuring against a days-old baseline.
  A kv-stable → kv-unified switch on a production store went from
  "exceeded ceiling 100000 at 125796" (and >5 GB at a 1M ceiling) to a
  332 ms / 423 MB solve under the same ceiling. (#97)
