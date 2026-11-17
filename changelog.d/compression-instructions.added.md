- Add JSON-compatible `compressionInstructions` templates to the base
  autobiographical instruction hooks, with strict validation and per-phase
  overrides. Omitted settings and the `default` preset preserve existing
  wording; host recipe use requires companion forwarding and validation.
- Export `validateCompressionInstructions`, `CompressionInstructions`,
  `CompressionInstructionTemplates`, and `CompressionInstructionValues`.
  Add protected `getCompressionOpening`, `getSourceMergeInstruction`, and
  `observeL1CompressionRequest` hooks (the observer runs before L1 dispatch,
  including carrier retries);
  existing ordinary and reading merge hook signatures and call arities remain
  unchanged, preserving subclass optional argument defaults. Custom merge
  templates infer the shown source level from the source entries.
- Keep source-level refusal retries on custom `merge`/`witnessedMerge` wording,
  including reading-mode merges; forward drain recipe instructions and report
  validation failures using value-free paths and reasons.
- Keep the source-retry hook limited to target level, sources and target tokens;
  reading-body token counts remain on the ordinary reading-merge hook only.
- Template settings require enumerable string keys and cloneable values;
  inherited outer strategy options are ignored; settings and templates require
  plain objects with Object.prototype or null prototypes. Combining `witnessedInstruction`
  (including an empty string) with `templates.witnessedChunk` is rejected.
  Reading slots take precedence over witnessed slots except on split pieces
  and source-level refusal retries.
- Instruction settings read own fields on plain objects and normalize internal inspection errors
  to value-free validation diagnostics. Existing skipped-level merge telemetry
  is preserved independently of custom template values.
- Keep recall-shaped custom compression openings from inserting a synthetic
  conversation-resumes turn between consecutive source turns.
- Instruction-setting inspection avoids absent proxy option descriptors, preserves
  unrelated option receivers, and reports instruction inspection failures without
  caller values. Unrelated outer-option failures keep their original errors.
