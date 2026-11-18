- Zero-recall surgery snapshots the trusted L1 construction path after sanitization,
  cache stripping, media preparation and carrier fallback, rather than independently
  rendering stored answers. Intercepted requests must match the full snapshot.
  Preview validates instruction settings, not store/source safety. Receipt digest
  fields are now explicitly named message-array hashes.
  The construction-bound transform requires removal of the entire recalled set;
  raw opening collisions and summaries that normalize into multiple tool turns
  are refused rather than risking partial removal.
- Failed one-shot operations include backup-restoration guidance in their receipt
  even if a provider call was recorded before failure.

- Zero-recall surgery removes recalls during L1 request authoring, before the
  accepted request is hashed or its mint preimage persisted. Summary provenance
  now describes the full request sent to the provider; the transport only
  validates that authored snapshot and enforces the one-call cap.
- Surgery refuses normalized recall answers containing raw tool results, avoiding
  deletion of source results collapsed into a user-participant memory.
- Surgery forwards the strategy's formatter and cancellation signal. Receipt
  message digests use the explicit originalMessagesSha256 and
  transformedMessagesSha256 names. The public originalRequestSha256 and
  transformedRequestSha256 fields remain compatibility aliases, respectively:
  SHA-256 of JSON.stringify(messages) before surgery and as actually sent, not
  hashes of the full request objects.
- KnowledgeStrategy retains default construction for primitive JavaScript options.
- Surgery family progress, quarantine and failure runs are isolated from ordinary
  recall-bearing compression, so their deterministic refusals cannot be reused
  across authoring modes. Attempt traces and compression logs describe sent recalls.
- Surgery refuses deletion of a memory when it would orphan a raw tool result.
  The CLI emits recovery guidance before opening the store and requires a new
  receipt destination outside the disposable store (exclusive creation).
- **Surgery receipt consumers:** `provenanceMode` is now `authored-request`, not
  `external-receipt-only`; update parsers to accept the new value. The restored
  message-digest compatibility aliases remain unchanged.

- One-shot execution now validates the quarantine key's chunk-source identity on
  both parent and fork. It reserves and syncs an external preflight receipt
  before opening the store, and syncs the attempted-call metadata before dispatch.
  Early failures retain recovery guidance; dangling receipt symlinks refuse before
  mutation. Provider error messages are omitted to avoid echoing source content.
- **Ordinary compression telemetry also changes:** L1 attempt traces and logs
  report sent recalls, including headers in collapsed CM turns and child summaries
  on recall-curve retries. Recall token totals include pair/envelope overhead on
  prose and no-tools retries, rather than only bare summary-body tokens.
- Inherited instruction settings cannot supply templates or create witnessed conflicts.

- One-shot receipts report `finished` only after store close succeeds. A failed
  final sync reports `uncertain` with backup-restoration guidance. Receipt
  digests hash the saved bytes rather than rereading a mutable destination path.
- Surgery uses ordinary quarantine for head and raw-history selection; only its
  own outcome records and queued-outcome accounting use the surgery namespace.
- Compression-log preparation is best effort, including after store closure;
  a pre-dispatch refusal no longer logs a planned request as sent.
- The public `AutobiographicalStrategy.assertCompressionQuarantineChunk(key,
  chunkIndex)` validates a quarantine key against a chunk and throws for an
  unreadable ledger, missing chunk/key, or mismatched source identity.
- `dump-compression-prompt` now uses the current default reading instruction,
  changes its heading, and warns that this is approximate reconstruction:
  custom instruction wording is not reconstructed.
- Ordinary L1 `compress_l1` log `messages` and `system` payloads describe the
  last dispatched attempt, including prose, no-tools, recall-curve and carrier
  retries, not the original canonical plan.
- Sent-recall telemetry tracks constructed header blocks, not raw Context Manager
  quotes, without adding metadata to requests. Ordinary repair/rebuild ignores
  surgery-only quarantine outcomes in both legacy snapshots and event ledgers.
