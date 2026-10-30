- On chronicle 0.5.1 or later, which gives a stored object back with its keys
  in the order they were written, a message's content renders that way, at
  every level of a block. A text block written as `{"type":"text","text":"…"}`
  rendered as `{"text":"…","type":"text"}`, its keys sorted, and now renders
  as written, as do a `tool_use` block and an input `toolUseInputMaxTokens`
  leaves whole. An image, document, audio or video block with inline data is
  still rebuilt from its stored blob as `{type, source}`.
- A message stored on an earlier chronicle comes back as that chronicle
  stored it: sorted, for one appended there. One edited there can come back
  as written from the upgrade on. A request holding such a message then
  changes once, and so does its hash, so a compression refusal recorded
  against that request no longer matches it: the chunk can be sent for
  compression once more, unless its cap on quarantined shapes is already
  reached.
- The `_keys` of a `tool_use` input that `toolUseInputMaxTokens` truncates
  name its first five keys in its own key order (in a JavaScript object, its
  own property order), where they were its first five in sorted order. For an
  input stored on an earlier chronicle, that order is still sorted.
