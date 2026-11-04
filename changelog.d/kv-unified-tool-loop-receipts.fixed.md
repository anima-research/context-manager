- kv-unified: only the first accepted call of a compile sets its cache
  reference. The native tool loop's later calls in the same turn each report a
  receipt. Under `cacheMarkers: 'cm-owned'`, membrane can float markers of its
  own onto those calls (membrane's `floatingCacheMarker` says when;
  antra-tess/membrane#239 brings it to `cm-owned`), so their marker count can
  differ from the compile's. Every accepted call took the count check before,
  so each such call would clear the reference, with at most one
  marker-mismatch line per strategy, and the next compile would weigh no cache
  costs. Now, once one of a compile's calls is accepted, later calls leave the
  reference and the recorded wire receipt as they stood once that call was
  accepted.
  If the compile's own request is never accepted (superseded or failed), the
  first accepted later call takes the count check in its place: one whose
  count differs from the compile's fails it, so that compile holds no
  reference. The check counts markers, not where they sit. A compile's calls
  are those begun after it and before the next compile; one still in flight
  when the next compile runs stays its own compile's. Calls begun after the
  next compile are that compile's: the first of them accepted before the
  compile's own request begins is its first accepted call, so its count
  check sets the reference or none, its wire receipt is the one recorded,
  and the compile's own request then leaves both. A call whose count
  differs, such as a floated one, then leaves that compile no reference. One
  still in flight when the compile's own request begins is superseded, so
  that request, once accepted, is the first accepted call.
  agent-framework starts a stream only when the agent is idle, so its tool
  loop's calls end before its next stream compiles. Only a draft's first
  submission logs a marker mismatch.
