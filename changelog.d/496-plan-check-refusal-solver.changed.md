- **The refusal of an adaptive plan over the budget says which solver
  planned, and no longer says the picker was exhausted when it wasn't**
  (#496). That refusal tests the plan's size against the hard budget, not
  the solver's `exhausted`, but its message opened "Adaptive picker
  exhausted" whatever the solver had reported. It now opens, for example,
  "Adaptive plan check: kv-unified returned its plan (exhausted=false,
  label-ceiling fallback=false)", and its `OverBudgetDiagnostics` carry three new optional
  fields: `solver` (`kv-unified`, `kv-stable`, …), `solverExhausted` (the
  solver's own `exhausted`), and `labelCeilingFallback` (whether the plan is
  the minimum-token cut kv-unified takes past `labelCeiling`, #252). A host
  that matches the old opening words needs the new ones; `instanceof
  OverBudgetError`, `budget`, `actual`, `clearedBy` and every other
  diagnostic are as they were, as are the messages and diagnostics of every
  other refusal, which leave the three fields out.
