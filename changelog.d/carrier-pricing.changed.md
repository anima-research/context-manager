- A zero-width carrier, membrane's `{ type: 'text', text: '', rawItem }` for a
  provider item it has no block for (a Responses compaction item or hosted tool
  call, an Anthropic server-tool block such as a web search's results), is
  priced as the item it is sent as. Before, it was priced as its empty text.
  - The item's JSON is priced at the JSON rate.
  - A compaction item's `encrypted_content` is priced at the encrypted carrier
    rate, `MessageStore.ENCRYPTED_CARRIER_CHARS_PER_TOKEN`.
  - Each of a web search's results has its `encrypted_content` priced at
    `MessageStore.WEB_SEARCH_RESULT_CIPHERTEXT_CHARS_PER_TOKEN`, 2.8 characters
    a token, measured with `count_tokens`.

  The store's estimator, the context log's and the autobiographical strategy's
  own price a carrier the same way. A route that leaves a carrier out, such as a
  Responses item on Anthropic, is over-counted by it.
- The pricing epoch stays 6, and a learned multiplier is kept: agent-framework
  releases from 0.6.5 on, before the one that carries
  anima-research/agent-framework#988, leave carriers out of a turn's first
  request, the one a sample is taken from.
- **Host operators:** take this with the agent-framework release that carries
  anima-research/agent-framework#988, which sends carriers in a turn's first
  request.
  - **Taken alone:** a window is priced for carriers its request still leaves
    out, such as a web search's results, so calibration learns a lower
    multiplier.
  - **Prompt cache:** a store holding carriers prices its window higher after
    the upgrade, so its first request can differ and miss the prompt cache.
