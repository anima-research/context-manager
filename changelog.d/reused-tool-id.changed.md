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
  no result has answered yet", and 0.24.2's changelog, for a result in its
  call's own message, said "a result answers the earliest call with its id
  before it, in its own message or an earlier one, that no result has answered
  yet". Under that rule, where an earlier call with the id went unanswered,
  each later result counted toward the call before its own, so the newest
  call's result could go as the marker while an older result of the tool went
  whole.
- `stripUnpairedToolBlocks` pairs by the same rule: it keeps a call only if a
  result with its id follows it before the next call with that id, and a
  result only if a call with its id comes before it. It kept any call whose id
  some result in the list carried, and any result whose id some call carried,
  so a summariser's request could hold an earlier call with no result beside a
  later call reusing its id, or a result whose only call with that id came
  after it.
- Where one message holds several calls with one id and no result with the id
  between them, pairing repair keeps only the last, the nearest call before
  every result after them, with every result with the id after them, up to the
  next call with the id and within the repair's look-ahead, gathered into the
  entry that answers it. Membrane's `NativeFormatter` sends the first as the
  call's result and the rest as `[duplicate tool_result for …]` text, with any
  image in them as a placeholder, which the image strip still counts as live,
  as it did when the repair dropped those results. `AnthropicXmlFormatter`
  sends the rest as further results after the one call, and
  `OpenAIResponsesFormatter` as further outputs for its `call_id`. The repair
  kept every call, and `NativeFormatter` refuses two calls with one id in one
  assistant turn, so a request holding such a message couldn't be sent.
- A host that stores a call's result late, after a later call has reused the
  call's id, now has that result paired with the later call: the earlier call
  goes with a stub. Every other result with the id after the later call, up to
  the next call with the id and within the repair's look-ahead, goes with the
  later call too, as for several calls with one id in one message, so none of
  them is dropped. Under the earlier rule the first such result answered the
  earlier call, and the next answered the later call.
- A store in which a later call reuses a call's id can compile different
  requests after the upgrade wherever a compile sends the earlier call
  without its own result, whether that result was stored after the later
  call or the selection leaves it out, and where it does, its first request
  misses the prompt cache. A store with two calls with one id in one message
  now compiles requests membrane sends. Every other store compiles what it
  compiled. A summariser's request changes where its messages hold a call
  that no result with its id follows before the next call with that id,
  while some result elsewhere carries the id, or a result that no call with
  its id comes before, while a later call has that id.
