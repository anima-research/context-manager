- `scripts/drain-autobiographical.ts` now passes the four split-fallback keys
  (`compressionSplitFallback`, `compressionSplitPlaceholder`,
  `compressionSplitMaxCallsPerChunk`, `compressionSplitMaxCallsPer10Min`)
  through from the recipe, so an offline drain honours them; previously they
  were silently dropped and a drain ran without the split-stitch rung even when
  the resident had it on. (`compressionToolProseFallback` is passed through too.)
