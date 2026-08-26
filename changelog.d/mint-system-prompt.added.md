- `ContextManager.setSystemPrompt(text)` threads the host's live system prompt
  into memory-minting LLM requests — both L1 chunk compression and level
  merges — as the request's `system` field, ahead of the identity head, the
  same layout a live activation uses. On hosts whose identity and conduct live
  in system voice, a summarizer that never sees that prompt is a different
  agent from the one whose memory it writes: without it, memories were authored
  by a system-promptless variant of the agent and merges re-summarized those
  summaries upward. Note WHICH prompt a mint is served. The rest of the request
  is built as-of the span being compressed — same head, same recall ladder, no
  tail after the chunk — but the prompt is not: it lives in a single slot with
  no per-message history, so a mint gets the identity policy in force AT MINT
  TIME. That equals what the original instance was served exactly insofar as
  the host keeps the prompt stable across the compressed span; where it has
  changed, the memory is authored under the current policy and the older text
  is not recoverable from here. The hook mirrors `setToolDefinitions`: hosts
  push on every activation, an empty or `undefined` push never downgrades the
  recorded value. Opt-in — with the setter never called, mint requests keep
  their exact previous shape, carrying no `system` key at all, so canonical
  request hashes and compression quarantine identities are unchanged. Hosts
  that do set it also give a marker-less mint (first mint, capped ladder,
  markers off) a cache breakpoint on the system block via membrane's existing
  no-message-breakpoint fallback, which previously had nowhere to land on this
  lane.
