- Where a later tool call reuses an earlier call's id,
  `AutobiographicalStrategy` and `KnowledgeStrategy` pair each tool result with
  the nearest call before it with that id, as with distinct ids, in pairing
  repair (`enforceToolPairing`) and in `toolResultMaxLastN`'s count, and so does
  `stripUnpairedToolBlocks`, which every summariser request that carries tool blocks goes through. Where
  each of two responses streams one tool call without an id, membrane's
  OpenAI-compatible adapter gives both the id `call_1`. Where the earlier call
  had no result and the later call's result lay within the repair's look-ahead,
  the repair moved that result up to answer the earlier call and sent the later
  call, which made it, with a stub; now the earlier call goes with the stub.
  `toolResultMaxLastN`'s doc said a result answers the earliest call with its id
  before it that no result has answered.
- Where one message holds several calls with one id and no result with the id
  between them, pairing repair keeps only the last, with every result with the
  id after them, up to the next call with the id and within the repair's
  look-ahead. So `NativeFormatter`, which refused such a request, sends it, with
  the further results as `[duplicate tool_result for …]` text. Compile
  provenance reports such a message's body as not complete
  (`missing: ['content']`).
- Where a host stores a call's result after a later call has reused the call's
  id, that result now goes with the later call, beside the later call's own,
  and the earlier call goes with a stub. Where the earlier call's result was
  stored first, the later call now goes out with it first, where each call went
  with its own before; where the later call's was stored first, the two no
  longer go crossed.
- A store in which a later call reuses a call's id can compile a different
  request where a compile sends the earlier call without its own result, and
  where it does, the prompt cache can't serve that request from the first
  message that differs. A store with several calls with one id in one message
  now compiles requests membrane sends. Every other store compiles what it
  compiled. A summariser request changes only where the strip now drops a call
  or result it kept.
