- `planTopologyRepair` (`src/repair/topology.ts`) and `scripts/repair-topology.ts`:
  a general, regeneration-free repair for crossed summary ownership (the
  stores `topologyPolicy: 'reject'` refuses). A crossed summary keeps the run
  of children carrying the most leaves and detaches the rest as roots; a
  crossed L1 keeps its largest run and releases the stray messages from its
  chunk record; single-source parents dissolve; touched ancestors get their
  `sourceRange` recomputed; kv-stable resolutions are clamped to the leaf's
  remaining chain. `--release-head` removes detached opening L1s (and
  uncompressed prefix records) so the head window takes those messages back
  verbatim. Dry-run by default; `--apply` writes and re-opens the store under
  `'reject'` to verify. `scripts/audit-topology.ts` now prints summary,
  chunk and chunk→L1 link counts and warns when it has nothing to audit.
