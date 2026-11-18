- Lifecycle methods (`initialize` and `detach`), including subclass overrides,
  are supported only through `ContextManager`. On that path their continuations
  stay bound to their own load generation, including before and after `super`.
  Direct lifecycle calls are unsupported and are not guaranteed to fail without
  effects: a direct arrow `initialize` calling `super.initialize` can invalidate
  the current load before throwing. Recover by reinitializing through
  `ContextManager.setStrategy`, not by retrying the direct call.
