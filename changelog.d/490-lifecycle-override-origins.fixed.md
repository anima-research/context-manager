- Keep subclass `initialize` and `detach` continuations bound to their own load
  generation, including before and after `super`, so a superseded lifecycle
  cannot mutate a replacement load's mirrors or invalidate its initialization.
