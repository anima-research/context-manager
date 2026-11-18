- Preserve each queued row's admitting window when a legacy notification
  interrupts a mixed presentation drain. Stop obsolete drain and alarm
  continuations before probing branch currency again.
- Do not requeue a failed first presentation or retraction notification
  when building its context closes the manager. The window write still stands.
- Clarify how to recover from uncertain quarantine writes: reinitialize the
  intended branch through the manager, then inspect through a fresh host
  async scope without reusing or automatically resending old intent.
- Refuse initialization success after a reentrant close, preserve transition
  context when final reset throws a hostile value, and handle such values in
  health report formatting. Invalidate stale chunk ordering and ownership
  caches when record identity or load changes.
