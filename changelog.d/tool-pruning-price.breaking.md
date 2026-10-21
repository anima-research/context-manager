- **Strategy authors:** `AutobiographicalStrategy`'s protected
  `pruneToolEntries` is removed. Tool blocks are now pruned as each raw
  message is sent, from a decision taken over the whole conversation.
  Override `toolPruning` to change which results are replaced or the input
  cap, or `prunedForSend` to change how a message is pruned; the plan prices
  what the override sends. A subclass that calls `pruneToolEntries`, or
  overrides it with the `override` keyword, stops compiling. A plain
  override still compiles and is never called, so move what it does.
