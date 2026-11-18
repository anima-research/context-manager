- **Host callback owners using Autobiographical or Knowledge strategies:**
  operations now retain their load origin through context-preserving async work.
  A timer/interval or promise created inside a strategy callback can later
  refuse guarded access after initialize/detach. Catch errors and rejections in
  each callback, cancel obsolete work on lifecycle changes, and send intentional
  fresh work to a host-owned dispatcher created outside strategy callbacks (or
  a manager entrypoint), validating current intent rather than retrying old work.
  `StaleBranchOperationError` is internal and not exported; do not import it for
  `instanceof`. Its name is diagnostic, not a universal public result contract:
  mutations may instead reject with ordinary reinitialization/uncertain-outcome
  errors, and health reads return unknown/unreadable/unavailable results.
  `getCompressionDebt()` remains non-throwing, including its stale error path.
  Earlier writes may have completed: refusals do not imply rollback.
  This is not a sandbox for arbitrary host schedulers: event/abort listeners
  execute in the dispatching context, not their registration context, and host
  AsyncResources can replace context. Library-owned provider cancellation binds
  abort dispatch to its cancelled origin, but external dispatch is not covered.
- **Strategy authors reflecting on or instrumenting methods/fields:** prototype
  methods are installed as per-instance non-enumerable wrappers preserving name
  and arity; loaded fields are guarded accessors. Wrap the instance method rather
  than monkeypatching the prototype after construction, and adapt own-property
  descriptor checks to accessors. Public/protected signatures and subclass
  `super` calls are unchanged. Shared handler/report/episode metadata is not a
  branch mirror. There is no new cross-process transaction, lock or rollback.
- **Runtime integrators:** the new operation boundary uses `node:async_hooks`
  `AsyncLocalStorage` (Node ≥22.12; also required by the published Bun source
  export). Bun must implement Node-compatible propagation and class-field
  initialization; no Bun verification or browser build is provided here.
