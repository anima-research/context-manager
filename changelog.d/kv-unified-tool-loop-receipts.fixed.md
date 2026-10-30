- kv-unified: only the first accepted call of a compile sets its cache
  reference. The native tool loop's later calls in the same turn each report a
  receipt. Under `cacheMarkers: 'cm-owned'`, a membrane that floats a marker
  onto the newest round adds one or two to those calls where slots are free,
  so their marker count differs from the compile's. Every accepted call took
  the count check before, so each such call would clear the reference, with at
  most one marker-mismatch line per strategy, and the next compile would weigh
  no cache costs. Now, once one of a compile's calls is accepted, later calls
  leave the reference, and the recorded wire receipt, as that call set them.
  If the compile's own request is never accepted (superseded or failed), the
  first accepted later call takes the count check in its place. A floated
  call with more markers than the compile's fails it, so that compile holds no
  reference. With all four slots in use the float takes the earliest message
  marker's slot, the count matches, and the reference credits that earliest
  marker, whose entry the compile's own request may never have written. Only
  a compile's own request logs a marker mismatch: a tool loop's later call
  doesn't.
