- Refuse missing Chronicle writer methods instead of acknowledging a no-op;
  sync dispatch uses the captured store and the same final origin guard as
  writes. Already-dispatched writes still may have landed before a refusal.
- Reconcile reentrant branch observations after a switch back, and refuse
  repeated unstable observations rather than recursing without a bound.
- Contain strategy presentation-hook lookup failures after storing a message,
  returning its ID instead of encouraging a duplicate add on retry.
- Alarm continuations recheck their origin after status and branch reads before
  changing shared episode metadata or notifying. Episode identity remains
  namespace/branch names only, not backing-store identity; another store with
  the same names can end an episode or inherit its waiver intent.
- Quarantine maintenance diagnostics acknowledge uncertain writes, missing-chunk
  heuristic clears and adoption of existing L1s without claiming proven drift
  or a new provider request. Superseded legacy snapshots are not inspected.
