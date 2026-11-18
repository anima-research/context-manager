- Fence manager-to-AutobiographicalStrategy invocations before resolving and
  calling strategy methods, including instance functions, class-field arrows,
  late assignments and forwarding proxies. Library-owned Chronicle writers
  reject obsolete invocation origins before dispatch. Direct external calls to
  arbitrary instance functions outside ContextManager are not covered by this
  manager boundary; protected helper signatures are unchanged.
- Scope ContextManager's optional strategy-member checks, capability guards,
  initialization, presentation, preview and rendering metadata reads as well as
  method calls. Context-preserving async continuations started by those accessors or
  forwarding proxy traps cannot write a replacement AutobiographicalStrategy load through
  the library's guarded writers. Boundary-protocol lookup work is also fenced;
  protected calls made synchronously before that lookup resolves fail closed.
- The new per-invocation boundary includes lifecycle-entry epochs (before an
  asynchronous initialize override reaches `super`), ancestor origins and
  local generation checks for mirror access; durable writers retain branch
  checks. Preview/select unwind only their own current load, and initialization
  restores preview configuration and detaches discarded order caches without
  copying history-sized shells. Held repair reports and handlers are shared
  across loads; replacement initialization schedules delivery of pending reports.
  Provider cancellation dispatch preserves the cancelled origin. These are
  properties of the new boundary, not fixes to a previously released boundary.
- The new branch/load-generation checks preserve newer reentrant switch
  observations and reconcile returned-to branches.
- The internal boundary slot permits function-binding forwarding proxies;
  manager calls still capture an origin before invoking strategy members.

- Lifecycle methods (`initialize` and `detach`), including subclass overrides,
  are supported only through `ContextManager`. On that path their continuations
  stay bound to their own load generation, including before and after `super`.
  Direct lifecycle calls are unsupported and are not guaranteed to fail without
  effects: a direct arrow `initialize` calling `super.initialize` can invalidate
  the current load before throwing. Recover by reinitializing through
  `ContextManager.setStrategy`, not by retrying the direct call.
- Failed presentation-scope observations stop the pending-notification drain
  with rows retained, rather than retrying the same failed observation without
  bound. An unknown window mode does not grant legacy-branch delivery rights.
  Reconciled branch-name mismatches identify the observed selection and recovery
  without claiming that an initialization ran. Stale health reports name the
  unavailable report and request a fresh health read outside the obsolete scope.
