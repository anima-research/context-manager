- Record one payload-free L1 `compression:no-dispatch` outcome across the whole
  operation, including preparation and quarantine-read failures, tool deferrals,
  and normal returns that reuse durable outcomes without calling the provider.
  Normal outcomes distinguish no-op, quarantine and stopped work; obsolete
  pre-send branch work is a withdrawal, not a compression error.
- Keep failed compression-log diagnostics from suppressing later attempt records
  and the operation receipt when the warning sink also throws.
- Respect disabled merge scheduling during discovery as well as execution, and
  reject zero-recall tool pairs crossing deleted message positions even when
  the same message object is reused later.
