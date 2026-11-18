- **Host callback owners using Autobiographical or Knowledge strategies:**
  operations now retain their load origin through context-preserving async work.
  A timer/interval or promise created inside a strategy callback can later
  refuse guarded access after initialize/detach. This also includes the
  callback's own continuation after `await manager.fork(...)` or
  `await manager.switchBranch(...)`: awaiting a lifecycle call does not rebind
  the rest of that callback to the new load, even without a timer or separately
  scheduled promise. Use a ContextManager entrypoint for intentional new-load
  work; do not continue using the old strategy scope. Catch errors/rejections
  in each callback and cancel obsolete work on lifecycle changes. A host dispatcher
  is fresh only if it actually executes outside the old async context: merely
  creating `const dispatch = f => setImmediate(f)` at startup does not help,
  since calling it inside the callback creates the immediate in that callback's
  context. Hosts implementing their own dispatch can create an `AsyncResource`
  outside strategy callbacks and use its `runInAsyncScope` to dispatch intent.
  Validate current intent rather than retrying obsolete work.
  `StaleBranchOperationError` is internal and not exported; do not import it for
  `instanceof`. Its name is diagnostic, not a universal public result contract:
  mutations may instead reject with ordinary reinitialization/uncertain-outcome
  errors, and health reads return unknown/unreadable/unavailable results.
  `getCompressionDebt()` returns unknown on its stale error path, but synchronous
  reentry during private boundary-symbol resolution can throw before the report
  body runs; defer instrumentation from that proxy lookup. Fresh debt/stranded
  reads need host-owned dispatch to the strategy, not a manager health method.
  Earlier writes may have completed: refusals do not imply rollback.
  This is not a sandbox for arbitrary host schedulers: event/abort listeners
  execute in the dispatching context, not their registration context, and host
  AsyncResources can replace context. Library-owned provider cancellation binds
  abort dispatch to its cancelled origin, but external dispatch is not covered.
- **Strategy authors reflecting on or instrumenting methods/fields:** prototype
  methods are installed as per-instance wrappers preserving name, arity and the
  original descriptor's enumerability (normally non-enumerable class methods;
  assigned enumerable prototype methods become enumerable own wrappers).
  Loaded fields are guarded accessors. Wrap the instance method rather
  than monkeypatching the prototype after construction, and adapt own-property
  descriptor checks to accessors. Manager calls now probe a private boundary
  symbol: forwarding proxies must forward symbol lookups (returning `undefined`
  for absent properties), not throw on unrecognized symbols. Lookup failures
  are deliberately not swallowed as a fallback to unscoped work. Lifecycle
  methods (`initialize`/`detach`), including subclass overrides, are supported
  only through ContextManager. Direct calls are unsupported: a direct arrow
  `initialize` calling `super.initialize` can invalidate the current load before
  throwing. Recover through `ContextManager.setStrategy`. Within manager lifecycle calls,
  prototype and class-field overrides may call `super`; signatures are unchanged.
  Subclasses must not redeclare guarded loaded mirrors as fields: derived field
  initialization replaces the accessors and defeats that isolation. Shared
  handler/report/episode metadata is not a branch mirror. There is no new cross-process transaction, lock or rollback.
- **Runtime integrators:** the new operation boundary uses `node:async_hooks`
  `AsyncLocalStorage` (Node ≥22.12; also required by the published Bun source
  export). Bun must implement Node-compatible propagation and class-field
  initialization. Boundary/cancellation regressions run on pinned Bun 1.4.4
  as well as Node; this is not a claim about other Bun versions or a browser
  build.
- **Hosts catching reset errors:** a final strategy `resetHeadWindow` failure
  is wrapped in an ordinary Error to report the stored transition and duplicate
  retry risk. Its `cause` is the original thrown value, preserving its identity
  and type there; catch the wrapper and inspect `cause` rather than relying on
  top-level `instanceof`. The stored transition is not rolled back.
- **Subclass authors overriding send-form helpers:** pricing may pass an optional
  operation-local `SendForms` cache as the third `prunedForSend` argument and
  fourth `cappedForSend` argument. Existing calls may omit it. Overrides should
  tolerate/forward that extra argument rather than require an exact arguments
  count; this also applies to KnowledgeStrategy subclasses. The fence itself
  does not add a scope parameter to protected helper calls.
