- `compressionToolProseFallback: { intoTool, fromTools, field?, result?, minChars? }`
  — an opt-in L1 compression fallback rung. Long prose kept in an argument of a
  private-reasoning tool (`skip_reply.reason`, `think.content`) makes replayed
  history read as a reasoning trace, and the memory-write is refused
  `reasoning_extraction` regardless of content. On a canonical **refusal** the
  request is retried once with each such argument moved into a call to
  `intoTool` — a note-taking tool the agent really has (agent-framework's
  `journal`) — placed as its own round just before the original call, with a
  short stub left behind; if the source-only final rung is enabled and also
  refuses, it gets the same rewrite once. Nothing the agent wrote is dropped.
  The rung is skipped unless `intoTool` is among the declared tools and at least
  one argument qualifies. Enabling or changing it is a new request regime, so
  already-quarantined chunks earn a fresh bounded attempt without a manual
  clear. Off by default: with the option unset, canonical requests, request
  hashes and quarantine identity are byte-identical.
