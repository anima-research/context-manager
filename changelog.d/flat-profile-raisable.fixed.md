- `flat-profile`, the default folding solver, and `oldest-first` now raise the
  oldest chunk at a level that can rise, passing over a chunk with no summary
  above it. They tried only the oldest chunk. So a summary no merge could take
  as the store stood, such as an operator-held L1, a quarantined merge's
  sources or a summary stranded beside a hole, stopped every raise at its
  level. Once that held at every level, a compile the younger chunks'
  summaries fit was refused ("Adaptive picker exhausted"). The first compile
  after upgrading can plan differently, which rewrites the request once, from
  the first unit that changes, on a store where the oldest chunk at a level
  the solve tries can't rise while a younger one can, and the plan that passes
  over fits: one holding such a summary, or a chunk not yet summarized behind
  newer summaries. Under `oldest-first` that includes ordinary stores, whose
  oldest chunk reaches the top of its lineage. Other stores that compile today
  are planned as before.
- When a solve that passes over ends over the hard budget, the solver solves
  again taking only the oldest chunk, as before this release, and returns that
  plan wherever the compile accepts it (within the budget and its
  `overBudgetGraceRatio`), which is the plan the store got before. So where
  the plan that passes over doesn't fit, a store that compiled before still
  compiles, with the same plan. Otherwise it returns the plan with the fewest
  tokens that either solve passed through, with that solve's request for a
  missing summary, and the compile refuses it if it is over. A raise folds
  only the group's unprotected leaves, and the summary takes their place, so
  where the rest of the group was pinned, locked or in the head or tail, a
  raise could grow the plan and take a solve over a budget that a plan on its
  way, or its start, had fit.
