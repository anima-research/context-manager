- Store topology fails loudly. Every load audits the summary archive for
  crossed ownership (a summary whose leaves are not contiguous among
  chunk-owned messages in store order — issue #122's cross-era merges,
  restore/branch interleavings, hand surgery). `topologyPolicy: 'reject'`
  (default) throws `StoreTopologyError` from `initialize`, so
  `ContextManager.open` refuses the store until it is repaired;
  `'report'` logs the violations at error level and reports them through
  `getCompressionDebt().topologyViolations` (state `critical`). A kv-unified
  config that opts into gap handling (`preserveGapBearingSummaries` or
  `treeifyNonContiguousSummaries`) defaults to `'report'`.
  `scripts/audit-topology.ts` runs the same audit read-only on a store path.
- Merge adjacency is judged in store order, not chunk-record order, so a chunk
  minted late over an early message can no longer join the frontier's merge run
  (the second half of #122). Demand-path merges (`enqueueMergeForRange`, #95)
  are split into strictly adjacent runs like the threshold path. `executeMerge`
  refuses any group that is not one level below the target and strictly adjacent
  in store order: no model call, the entry moves into the merge quarantine with
  outcome `topology_violation`, and `getCompressionDebt().topologyRefusals` /
  state `critical` say so. A crossed node is never minted.
