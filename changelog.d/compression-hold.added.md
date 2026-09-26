- Compression holds: `ContextManager.holdCompression(ids)` /
  `releaseCompression(ids)` / `getCompressionHolds()`, and
  `addMessage(..., { holdCompression: true })` to place the hold before the
  strategy sees the message. Autobiographical (and Knowledge) treat the
  earliest held message as the start of the protected recent window: it,
  everything after it, and the tool_use it answers stay raw and out of every
  chunk; a chunk that closed before a late hold waits for release. Intended
  for provisional content later replaced with `editMessage` (agent-framework's
  tool-result guard stages a placeholder tool_result) — edits never reach
  summaries, so edit while held, then release. Holds are in-memory only; a
  reopened manager starts with none. With no holds, chunking, compression
  requests and compiled context are unchanged.
  Held content is also kept out of compression, merge and transition-summary
  prompts' head context (a reset head window can sit past the hold), and
  hold checks cost nothing when no hold exists (one timeline scan per pass
  otherwise).
