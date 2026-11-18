- **Hosts matching the adaptive refusal's opening words:** update matches
  from "Adaptive picker exhausted" to "Adaptive plan check (solver)" (#496).
  The refusal now says which solver planned, and no longer says the picker
  was exhausted when it wasn't. That refusal tests the plan's size against the hard budget, not
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
  Ordinary dry-run compilation now takes the same plan gates as live
  compilation and throws when its first plan exceeds the hard budget,
  including after a provisional calibration retry drops the multiplier to 1.
  Previews report that refused plan without attempting a stub-room retry.
  A dry compile whose stub-room retry plan exceeds its reduced budget now
  throws the original stub refusal, as live compilation does.
  A preview whose stub-room retry plan exceeds its reduced budget now
  reports the original stub refusal and its fitting plan's exhaustion flag,
  just as a live compile discards that retry.
