- `kvUnified.callerCacheMarkers` (0 to 3, 0 when unset, read when the
  strategy is built) declares the cache markers a caller's own request
  carries outside the messages, such as a membrane `beforeRequest` hook that
  marks the system prompt under `cacheMarkers: 'cm-owned'`. kv-unified then
  places at most 4 minus that many markers of its own (its history markers
  evenly spaced, the tail end always marked), so the request stays within
  Anthropic's four, and keeps a call's cache reference only when the request
  carries its markers plus the declared ones. Before, such a hook's marker
  made every call's marker count differ from the compile's, so kv-unified
  kept no cache reference and weighed no cache costs, and once its own four
  were in use the hook's was a fifth, which membrane's formatters doc says is
  refused. The line kv-unified logs when the counts differ now names the
  option.
