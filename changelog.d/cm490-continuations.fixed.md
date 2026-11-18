- Background drain and hook/repair terminal rejection handlers cannot throw,
  even when store lookups or host diagnostics fail. Genuine tick failures remain
  observable after a load change; explicit no-call/hold deferrals stop obsolete
  work quietly. Final head-window reset failures report the stored transition
  and duplicate retry risk, retaining the original failure as their cause.
- Topology repair skips superseded legacy quarantine snapshots beside malformed
  ledgers. Reentrant provider error getters cannot apply obsolete pause decisions.
- Unreadable-quarantine alarms ask operators to check backing-store access and
  diagnostics to restore monitoring, without exposing thrown payloads.
