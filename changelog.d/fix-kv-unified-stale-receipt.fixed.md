- kv-unified: a stale presentation receipt no longer makes the Pareto label
  count superlinear in the DAG engine. Extension tokens (rendered tokens not
  covered by the accepted presentation) are no longer a state-key dimension;
  they are a dominance dimension while a provider cache is relevant (the
  cache term prices them) and a cover-envelope term reported in the
  a-posteriori error bound (`approximationCacheErrorBound`). The leaf engine
  (auto-selected when a pin or lock leaves a protected hole inside a summary)
  is fixed only while no provider cache is relevant; with one it has no
  representative cap and is barely improved (#107). Separately, the first
  successful non-dry-run adaptive presentation by a non-kv-unified folding
  strategy supersedes a persisted `kvunified:presentation-receipt`, so a
  switch back to kv-unified starts from an empty chain instead of measuring
  against a days-old baseline. Loading, a `dryRun` compile and a failed
  compile leave the receipt untouched; a host preview that runs a
  non-dry-run compile counts as a presentation, and
  `adaptiveResolution: false` never supersedes. A kv-stable → kv-unified
  switch on a production store went from "exceeded ceiling 100000 at 125796"
  (and >5 GB at a 1M ceiling) to a 332 ms / 436 MB solve under the same
  ceiling, measured with no relevant provider cache; with one, the same
  solve is dominated by #105, which this change does not address. (#97)
