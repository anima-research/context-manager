- Autobiographical and Knowledge strategy operations now retain an immutable
  store/namespace/branch/load identity through synchronous reentrancy, promises,
  and scheduled continuations using Node's `AsyncLocalStorage` (Node ≥22.12;
  no browser build is provided). A reentrant `initialize()` runs in a separate
  scope; it cannot authorize the interrupted operation's writes or mirror
  updates. Stale operations may now reject earlier with a stale-branch error
  instead of continuing until the next explicit branch check. This is not a
  cross-process transaction or rollback of writes already completed on A.
- Public and protected method signatures, including standalone protected calls
  and subclass `super` calls, are unchanged. Strategy prototype methods are
  installed as per-instance non-enumerable scope wrappers (preserving name and
  arity); branch-derived fields use guarded accessors. Code reflecting on own
  method/property descriptors will therefore observe a different layout.
- An obsolete queued load-repair notification no longer runs against replacement
  mirrors; its report remains available for a later current handler invocation.
  Process-wide provider-route pause/resume behavior is unchanged.
- Post-construction prototype monkeypatches no longer replace existing instance
  methods; instrumentation should wrap the instance method instead.
