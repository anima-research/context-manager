- kv-unified: a stale presentation receipt no longer makes the Pareto label
  count superlinear. Extension tokens are gone from the label state key (and
  the label): nothing in dominance or pricing read them — the cache-churn term
  recomputes extension from the rendered layout — so keying on them only split
  labels that should have collapsed. Separately, the first real presentation
  by a non-kv-unified folding strategy now supersedes a persisted
  `kvunified:presentation-receipt` (loading, previewing or dry-running with
  another strategy leaves it untouched), so a switch back to kv-unified starts
  from an empty chain instead of measuring against a days-old baseline. A
  kv-stable → kv-unified switch on a production store went from
  "exceeded ceiling 100000 at 125796" (and >5 GB at a 1M ceiling) to a
  309 ms / 434 MB solve under the same ceiling. (#97)
