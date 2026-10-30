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
  with its id before it, in its own message or an earlier one. Its doc said a
  result answers "the earliest call with its id, in an earlier message, that
  no result has answered yet", and an earlier entry, for a result in its
  call's own message, said "the earliest call with its id before it, in its own
  message or an earlier one, that no result has answered yet". Under that
  rule, where an earlier call with the id went unanswered, each later result
  counted toward the call before its own, so the newest call's result could go
  as the marker while an older result of the tool went whole.
- `stripUnpairedToolBlocks` pairs by the same rule: it keeps a call only if a
  result with its id follows it before the next call with that id, and a
  result only if a call with its id comes before it. It kept any call whose id
  some result in the list carried, and any result whose id some call carried,
  so a summariser's request could hold an earlier call with no result beside a
  later call reusing its id, or a result whose only call with that id came
  after it.
- A host that stores a call's result late, after a later call has reused the
  call's id, now has that result paired with the later call: the earlier call
  goes with a stub, and a second result after the later call is dropped as a
  further one. Under the earlier rule the late result answered the earlier
  call.
- A store in which a later call reuses a call's id before that call's result
  is stored can send different requests after the upgrade, and where it does,
  its first request misses the prompt cache. Every other store sends what it
  sent.
