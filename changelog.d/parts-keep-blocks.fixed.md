- With `adaptiveResolution`, a message stored in parts keeps its other blocks
  in the adaptive middle. A run of a body's raw parts there used to go out as
  their text alone, so a long reply lost its thinking and its tool call, the
  call's result was then dropped by pairing repair, and a long user message
  lost its images. The middle, kv-unified's cache check, and the head and
  recent windows now join every run of a body's raw parts, a lone part
  included, with `joinBodyParts`, newly exported: their non-text blocks in
  stored order, then their text. A lone part used to go out as stored, text
  first. `concatBodyGroups` keeps non-text blocks in place of writing
  placeholders.
- The middle now sends and prices each raw part cut at `maxMessageTokens`, as
  the head and recent windows do. Where the cap is under a part's size, the
  middle's document text is cut where it used to go out whole.
- Each image is kept or stripped by the verdict of the part it's stored on.
- Ingress puts a split message's non-text blocks from its first `tool_use` on
  on its last part, and the others on its first, where it used to put them
  all on its first. A reply's call then sits next to its result, and the
  reply's earlier parts can fold apart from it. For a body stored before,
  with its call on its first part, the recent window's start, a compression
  hold, the head window's end and the chunker each keep the call's result
  with the whole body, as they keep a result with a call stored whole.
