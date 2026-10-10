- `[fold-diff]` observability for adaptive compiles: whenever the picker
  changes at least one resolution on a non-dry-run compile, the strategy logs
  which chunks moved between which levels, grouped into contiguous source-order
  runs with each run's rendered offset in the carried layout, plus the earliest
  layout divergence and the suffix the provider will re-read
  (`kvCost` semantics) — e.g.
  `[fold-diff] moves=860 (deepened=860 raised=0) rendered 382k→344k divergence@27k suffix=317k runs=2: L2→L3×792@27k[…] L0→L1×68@310k[…]`.
  The same record is attached to `RenderStats.planVsActual.foldDiff`.
  `describeFoldDiff` / `formatFoldDiff` are exported for hosts and replay
  tooling. Quiet compiles and dry runs are unchanged.
