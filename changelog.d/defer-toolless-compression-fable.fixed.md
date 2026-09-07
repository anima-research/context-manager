- Compression is now deferred until the host has pushed tool definitions
  when the summarizer is a Fable/Mythos-family model, not only when the
  chunk itself contains tool blocks. On those models a summarizer request
  with the memory marker and directive but no `tools` param is a
  deterministic `reasoning_extraction` input-block regardless of chunk
  content, so a pure-chat seeded agent's first speculative L1 — fired
  before the first `setToolDefinitions` — burned a doomed call and landed
  its opening slice in compression quarantine (Linn, 2026-09-05). Opus-family
  summarizers keep minting tools-less; deferred chunks are re-examined on the
  next ingestion/activation as before.
