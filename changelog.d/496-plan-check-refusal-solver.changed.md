- **The refusal of an adaptive plan over the budget says which solver
  planned, and no longer says the picker was exhausted when it wasn't**
  (#496). That refusal tests the plan's size against the hard budget, not
  the solver's `exhausted`, but its message opened "Adaptive picker
  exhausted" regardless of the picker's exhaustion flag. It now opens, for example,
  "Adaptive plan check: kv-unified returned its plan (solver-reported/picker-derived exhausted=true,
  label-ceiling fallback=false)", and its `OverBudgetDiagnostics` carry three new optional
  fields: `solver` (`kv-unified`, `kv-stable`, …), `pickerExhausted` (the
  solver's `exhausted` when supplied, otherwise derived by the picker as no
  production requests and applied tokens above the soft target; solver-specific
  semantics do not generally mean nothing remains to fold), and `labelCeilingFallback` (whether the plan is
  the minimum-token cut kv-unified takes past `labelCeiling`, #252). In the
  real solver, an infeasible minimum frontier returns before search, while
  a ceiling fallback takes an already-feasible minimum cut; the fallback
  flag is telemetry, not a reason for the plan check to refuse. Synthetic
  failure injection covers forwarding a true fallback flag on refusal, not
  reachability of that combination in a real solve. A host
  that matches the old opening words needs the new ones; `instanceof
  OverBudgetError`, `budget`, `actual`, `clearedBy` and every other
  diagnostic are as they were, as are the messages and diagnostics of every
  other refusal, which leave the three fields out.
