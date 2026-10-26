- `flat-profile` and `oldest-first` no longer solve a second time where the
  second solve can't change the plan. In 0.22.1, when a solve that passes over
  ended over the hard budget, the solver solved again taking only the oldest
  chunk. A solve that passed no chunk over had already made exactly that rule's
  moves, so the second solve repeated it move for move, about doubling the
  planner's work for such compiles, those the plan check lets through within
  `overBudgetGraceRatio` included, and for the shadow pick at
  `productionBudgetTokens` when it hasn't converged. Such a solve's own plan is
  now judged at the line the compile refuses above, and the solver doesn't
  solve again. Where a solve's fewest-token plan is its last, that plan is no
  longer replayed. Plans, token counts and summary requests are unchanged.
- 0.22.1's entry said that fallback returns the plan the store got before. It
  returns the oldest-only rule's plan from the levels the store carries. That
  is the plan the store got before the upgrade only at the first compile after
  it.
- The `productionBudgetTokens` warning calls the target unreachable only when
  the solver's plan is over the line a compile at that budget refuses above
  (`overBudgetGraceRatio`). Within that line, where the plan check lets such a
  compile through, it says the plan is over the soft target but within the
  line. Both forms say the solver can fold no further with the summaries the
  store has now.
