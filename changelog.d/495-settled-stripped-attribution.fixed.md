- Attribute compression failures to the current attempt rather than to a reused
  error object, including primitive thrown values. Provider failures during a
  carrier-stripped retry count against the stripped request; local errors after
  it answers count against the unstripped rung instead of inheriting a prior
  stripped failure identity. This can change retries and the persistent-failure
  outcomes that contribute to quarantine. As in the previous release, reusing a
  carrier rejection resets the unstripped run, including stale provider failures
  left by another strategy. Repeated post-answer local errors on that reuse path
  therefore restart rather than accumulate toward the persistent-failure bound;
  those errors alone do not advance the rung toward quarantine.
