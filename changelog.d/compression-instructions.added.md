- Add JSON-compatible `compressionInstructions` templates to the base
  autobiographical instruction hooks, with strict validation and per-phase
  overrides. Omitted settings and the `default` preset preserve existing
  wording; host recipe use requires companion forwarding and validation.
- Export `validateCompressionInstructions`, `CompressionInstructions`,
  `CompressionInstructionTemplates`, and `CompressionInstructionValues`.
  Add protected `getCompressionOpening` and `getSourceMergeInstruction` hooks,
  plus an optional shown-level argument on `getMergeInstruction` and
  `getReadingMergeInstruction` for subclass authors.
- Keep source-level refusal retries on custom `merge`/`witnessedMerge` wording,
  including reading-mode merges; forward drain recipe instructions and report
  validation failures using value-free paths and reasons.
- Keep the source-retry hook limited to target level, sources and target tokens;
  reading-body token counts remain on the ordinary reading-merge hook only.
