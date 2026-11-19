- **Hosts matching adaptive plan-check refusal text:** replace matches on
  “Adaptive picker exhausted” or “still exceed” for this refusal with the
  prefix `Adaptive plan check (` (#496). Prefer `instanceof OverBudgetError`
  with `diagnostics.solver !== undefined` for plan checks, and the class alone
  for budget refusals generally. Other refusals keep their text and diagnostics;
  keep any existing non-plan matches. The error class, `budget`, `actual`,
  and clearance advice are unchanged.
  - The message starts with the solver and the plan's token count and hard
    budget so they survive excerpting. The plan-only `pickerExhausted`
    (printed as `exhausted=`) preserves a supplied solver flag; otherwise
    it means no production was requested and the applied tokens are above
    the soft target. It is not proof that nothing remains to fold.
  - Only kv-unified reports `labelCeilingFallback` (#252), and the message
    prints it only when true. It identifies a minimum-token cut taken after
    hitting the search ceiling, not the reason for refusal. For example,
    with zero grace and no request limit, a 100.25-token cut can fit a
    100.5-token solve budget but exceed the floored rejection bound of 100,
    yielding a true fallback flag with false exhaustion.
  - An over-budget adaptive dry plan used to refuse at emission with an
    estimator-drift label and the emitted prefix's figures (#300). It now
    refuses at the plan check with the plan's figures and solver diagnostics.
    Match the plan-check prefix instead of the drift label for this case.
    `previewContext` reports `fits: false` without `entries` or `stats` on a
    final budget refusal, even with `render: true`.
  - A dry plan-check refusal can now trigger a provisional-calibration retry
    at multiplier 1. If the retry passes the remaining gates, the dry compile
    returns normally; otherwise the final refusal stands. Without an
    eligible retry, the first refusal stands. If a stub-room retry's plan
    exceeds its reduced budget, dry compilation throws the original stub
    refusal, as live compilation does. A preview reports that original
    refusal and its fitting plan's exhaustion flag.
  - If a live compile's dry leave probe fails the plan check, the fallback
    warning now includes the bounded plan-check error instead of the fixed
    “its plan is over the budget” explanation.
