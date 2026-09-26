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
- `auditOnly` strategy config: `initialize` loads and audits the store but
  never chunks the uncovered frontier, enqueues merges, or rewrites the
  persisted merge queue. The audit and repair scripts open stores this way;
  a plain open under a config that is not the resident's own mints chunk
  records with the wrong head window and chunk size, which the resident then
  compresses at its next boot. `--release-head=all` (with
  `--release-head-limit <n>`) also releases pre-existing prefix L1s.
