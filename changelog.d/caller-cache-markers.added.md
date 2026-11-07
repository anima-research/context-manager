- `kvUnified.callerCacheMarkers` (0 to 3, 0 when unset, read when the
  strategy is built) declares the cache markers a caller's own request
  carries outside the messages, such as a membrane `beforeRequest` hook that
  marks the system prompt under `cacheMarkers: 'cm-owned'`. kv-unified then
  places at most 4 minus that many markers of its own (its history markers
  spread over the history's tokens, the tail end always marked), so the
  request stays within Anthropic's four, and sets a compile's cache
  reference only when its first accepted call's request carries as many
  markers as it placed plus the declared ones. When the compile's own
  request is never accepted and a later call takes the count check in its
  place, that call is held to the same count. Before,
  such a hook's marker made every call's marker count differ from the
  compile's, so kv-unified kept no cache reference and weighed no cache
  costs, and once its own four were in use the hook's was a fifth, and
  membrane refused the request. The line kv-unified logs when the counts
  differ now names the option.
