- `AutobiographicalStrategy` and `KnowledgeStrategy` pair a tool result with
  the nearest call before it with its id where a later call reuses an earlier
  call's id, as with distinct ids. A provider that leaves a streamed call's id
  out can get the same id in every response: membrane's OpenAI-compatible
  adapter names such a call `call_1` each time. Where the earlier call had no
  result, pairing repair (`enforceToolPairing`) moved the later call's result
  up to answer the earlier call, and sent the later call, which made it, with
  a stub in place of its result. The repair's look-ahead now ends at the next
  call with the id, so the earlier call goes with a stub and the later call
  with its own result.
- `toolResultMaxLastN` counts a result toward that same call: the nearest call
  with its id before it, in its own message or an earlier one. This replaces
  the rule that a result answers "the earliest call with its id before it, in
  its own message or an earlier one, that no result has answered yet". Under
  that rule, where an earlier call with the id went unanswered, each later
  result counted toward the call before its own, so the newest call's result
  could go as the marker while an older result of the tool went whole.
- A host that stores a call's result late, after a later call has reused the
  call's id, now has that result paired with the later call: the earlier call
  goes with a stub, and a second result after the later call is dropped as a
  further one. Under the earlier rule the late result answered the earlier
  call.
- A store holding a call whose id a later call reuses while the earlier call
  has no result sends different requests after the upgrade, so its first
  request misses the prompt cache. Every other store sends what it sent.
