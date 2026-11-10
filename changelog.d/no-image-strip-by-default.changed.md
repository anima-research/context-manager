- **No live image is stripped by default.** `maxLiveImages` (was 6),
  `imageStripDepthTokens` (was 30000) and `maxLiveImageBytes` (was 20 MiB)
  now default to 0 in the memory strategy and in windowed passthrough, so an
  image stays in the window until its message is folded or leaves the
  window. Replacing an already-sent image with the placeholder edits the
  prompt mid-history: the request misses the prompt cache from that message
  on, and a model that binds a reply's thinking to everything before it
  drops the thinking of every later reply, at each new image once a limit
  binds. The ceilings are unchanged (`imageCeiling` 500 images,
  `imageByteCeiling` 24 MiB) and still strip when a window reaches them. An
  image costs about 1,600 tokens of the budget while it is live. A host that
  wants the old behavior sets the three options to their old values;
  `imageStripHysteresisRatio` still spaces the strips of any limit that is
  set.
