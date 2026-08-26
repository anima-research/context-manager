- **`OverBudgetError`, `UncoveredDropError` (and `OverBudgetDiagnostics`) are
  exported from the package root** (#41). Both errors are cross-package
  behavioral surface — agent-framework gates its OverBudget drain breaker and
  `context_refusal` classification on them (AF PR #58,
  `classifyInferenceError`) but could only match `err.name` across the
  boundary. Consumers now get a real `instanceof`; the constructors' message
  wording stops being implicitly load-bearing. Additive, no behavior change.
