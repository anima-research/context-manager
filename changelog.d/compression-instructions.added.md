- Add a JSON-compatible `compressionInstructions` option to
  `AutobiographicalStrategy`: per-phase templates (`opening`, `chunk`,
  `witnessedChunk`, `readingChunk`, `merge`, `witnessedMerge`, `readingMerge`,
  `transition`) with a fixed set of placeholders, validated at construction.
  Omitting the option, `{}`, or `preset: 'default'` keeps today's requests
  byte-for-byte. See `docs/compression-instructions.md`.
  - Export `validateCompressionInstructions` and the `CompressionInstructions`,
    `CompressionInstructionTemplates` and `CompressionInstructionValues` types.
    Validation errors are `TypeError`s that name only an allowlisted path and
    reason, never a supplied value, key or placeholder name. Combining a
    nonempty `witnessedInstruction` with `templates.witnessedChunk` throws
    `Conflicting witnessed instruction configuration` at construction; an
    empty `witnessedInstruction` is ignored.
  - New protected hooks for subclass authors: `getCompressionOpening`, and
    `getSourceMergeInstruction` for the source-level merge retry (its base
    implementation uses `merge`/`witnessedMerge`, ignoring reading mode). The
    hooks `getMergeInstruction` and `getReadingMergeInstruction` take an
    optional shown-level argument, `separateRecallAnswers` an optional
    `recallHeadersEnd`, and `applyMintCacheSeams` an optional
    `recallPairsEnd`. A subclass that already defines a member with one of
    the new names should rename it before upgrading.
  - With a custom `opening` (any configured `templates.opening`, even one
    equal to the built-in text, or a `getCompressionOpening` override
    returning other text), L1 requests read a recall pair only when its
    header and answer both lie before the opening, for the resume separator,
    the cache seams and the refusal-curve retry. The zero-recall surgery
    script refuses a `strategyConfig` that sets `templates.opening`. The autobiographical drain and external-memory scripts forward
    `compressionInstructions` from its recipe; hosts must forward and validate
    the option themselves.
