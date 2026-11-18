- **Hosts matching adaptive refusal messages, using dry compiles, or rendering
  previews:** update message matches from "Adaptive picker exhausted" to
  the stable prefix `"Adaptive plan check ("` (#496), for example with
  `error.message.startsWith("Adaptive plan check (")`. The parentheses
  contain the actual solver name, not the literal word `solver`. Prefer
  `instanceof OverBudgetError` and `diagnostics.solver !== undefined`
  to recognise this refusal without parsing its message.
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
  real solver, an infeasible minimum frontier returns before search, while a
  ceiling fallback takes a minimum cut that fits the unfloored solve budget.
  The compile tests against the floored, grace-expanded input budget, capped
  by the remaining request allowance if a request limit is set. With zero
  grace and no request limit, a 100.25-token cut fits a 100.5-token solve
  budget yet fails the
  hard bound of 100 with matching accounting and `pickerExhausted=false`,
  even after a real ceiling fallback. Fractional provider
  `usage.outputTokens` can produce fractional summary costs. The fallback
  flag describes the selected plan, not the reason for refusal. A host
  that matches the old opening words needs the new ones; `instanceof
  OverBudgetError`, `budget`, `actual`, `clearedBy` and every other
  diagnostic are as they were, as are the messages and diagnostics of every
  other refusal, which leave the three fields out.
  Ordinary dry-run compilation now takes the same plan gates as live
  compilation: an over-budget first plan can trigger a provisional-calibration
  retry at multiplier 1. If that retry fits and passes the remaining gates,
  the dry compile returns normally; otherwise it throws. Without an eligible
  retry, an over-budget first plan throws immediately.
  Hosts using `compile(..., { dryRun: true })` must now catch
  `OverBudgetError`, or use `previewContext` to inspect infeasibility via
  `fits: false` rather than consuming entries from a refused plan.
  Previews report that refused plan without attempting a stub-room retry;
  even with `render: true`, they return no `entries` or `stats`, since the
  plan gate refuses before rendering. Render-preview consumers must handle
  those fields being absent; fitting previews still render on request.
  A dry compile whose stub-room retry plan exceeds its reduced budget now
  throws the original stub refusal, as live compilation does.
  A preview whose stub-room retry plan exceeds its reduced budget now
  reports the original stub refusal and its fitting plan's exhaustion flag,
  just as a live compile discards that retry.
