- `MessageStore` and `ContextLog` (whose estimate strategies receive as
  `ContextLogView.estimateTokens`) price membrane's XML-history carriers
  instead of counting them as 0. A `tool_attempt` (a tool-call block that
  dispatched nothing, replayed verbatim) is estimated from its `rawXml`. A
  `tool_notice` (the harness's notice about refused or warned invokes) is
  estimated from the `<tool_call_notice>` elements it replays as. Both are
  read structurally, so this works with any membrane version. Other
  unrecognized blocks still count as 0. The shared rule is
  `MessageStore.xmlHistoryCarrierTokens`, for strategies that price content
  themselves. The blocks come from membrane#101, persisted by
  agent-framework.
