- Report extracted-empty hoist, source-only and split answers as unusable_empty
  in compression attempt diagnostics, and retain malformed-response error types.
  Summary selection and durable outcomes are unchanged.
- End an answered compression rung’s provider failure run before resuming its
  lane, so a throwing resume warning starts a fresh local-error run rather than
  extending the answered provider’s failure streak.
- Keep decided carrier-stripped failures visible when final-request diagnostic
  construction fails, using an explicitly marked planned-request fallback.
