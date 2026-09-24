- Reduce kv-unified solve time and memory for existing presentations and forced
  transitions by using linear bucket selection, equivalent broken-cache-prefix
  states, precomputed action costs, and lazy frontier materialization. Preserve
  the configured welfare policy, hard token wall, continuity pricing, and grids;
  no solve deadline is introduced.
- Handle internal protected holes in the automatic DAG solver and preserve
  chronological cache emissions across nested ownership gaps.
- Add an optional certified hysteresis exit for provable unchanged selections
  and phase diagnostics for offline solver profiling.
