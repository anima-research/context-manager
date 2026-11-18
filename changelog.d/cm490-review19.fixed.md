- Preserve each row's legacy-window eligibility across failed presentation
  observations and pending-notification drains, so public add notifications are
  retried without loss or duplicate storage. Refuse initialization success when
  the final branch lookup starts a newer initialization attempt.
