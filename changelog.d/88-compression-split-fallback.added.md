- `compressionSplitFallback` (default off): a final L1 rung that, after every
  existing rung is refused, folds the chunk in halves at message boundaries
  (tool rounds indivisible) in source-only shape and installs the stitched
  pieces as one L1 over the chunk, with per-piece request/response/content
  hashes, aggregate usage, and per-chunk / sliding-window call caps; provider
  errors abort it. `compressionSplitPlaceholder` (default off) allows an
  operator-authored, structurally marked placeholder for a single message that
  refuses alone. Cap knobs: `compressionSplitMaxCallsPerChunk`,
  `compressionSplitMaxCallsPer10Min`.
