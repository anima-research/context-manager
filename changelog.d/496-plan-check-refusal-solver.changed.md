- **The refusal of an adaptive plan over the budget says which solver
  planned, and no longer says the picker was exhausted when it wasn't**
  (#496). That refusal tests the plan's size against the hard budget, not
  the solver's `exhausted`, but its message opened "Adaptive picker
  exhausted" regardless of the picker's exhaustion flag. It now opens, for example,
  "Adaptive plan check (kv-unified): N tokens exceed hard budget M (head=…"
  so bounded excerpts keep the token figures; `exhausted` follows the figures,
  and `label-ceiling fallback` is printed only when true. Its
  `OverBudgetDiagnostics` carry three new optional
  fields: `solver` (`kv-unified`, `kv-stable`, …), `pickerExhausted` (the
  solver's `exhausted` when supplied, otherwise derived by the picker as no
  production requests and applied tokens above the soft target; solver-specific
  semantics do not generally mean nothing remains to fold), and `labelCeilingFallback` (whether the plan is
  the minimum-token cut kv-unified takes past `labelCeiling`, #252; absent
  for other solvers). The exported `PreviewResult.exhausted` documentation
  now describes the solver-owned flag, not proof that no folds remain, and
  notes that pre-plan refusals set it true without running a solver. In the
  real solver, an infeasible minimum frontier returns before search, while
  a ceiling fallback takes an already-feasible minimum cut; the fallback
  flag is telemetry, not a reason for the plan check to refuse. A true flag
  at this refusal indicates disagreement between plan and solver accounting.
  Synthetic
  failure injection covers forwarding a true fallback flag on refusal, not
  reachability of that combination in a real solve. A host
  that matches the old opening words needs the new ones; `instanceof
  OverBudgetError`, `budget`, `actual`, `clearedBy` and every other
  diagnostic are as they were, as are the messages and diagnostics of every
  other refusal, which leave the three fields out.
