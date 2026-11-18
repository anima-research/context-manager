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
- KnowledgeStrategy accepts non-null primitive JavaScript options; null is
  unsupported and throws in the superclass.
- Surgery family progress, quarantine and failure runs are isolated from ordinary
  recall-bearing compression, so their deterministic refusals cannot be reused
  across authoring modes. Attempt traces and compression logs track sent recalls by constructed header
  identity; subclass authoring that clones header blocks loses that identity.
- Surgery refuses deletion of a memory when it would orphan a raw tool result.
  The CLI emits recovery guidance before opening the store and requires a new
  receipt destination outside the disposable store (exclusive creation).


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
  store close or final receipt sync reports `uncertain` with backup-restoration guidance; if receipt persistence fails,
  stdout carries the final outcome without claiming a saved-file digest. Receipt
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
- One-shot receipts distinguish a failed tick or missing target summary from
  successful store closure. Surgery ticks leave unrelated merges queued, even
  when relief, failure ordering or the speculative cap would normally run them.
  Sanitized provider failures retain their class, HTTP status and error type for
  ladder classification and receipts; carrier fallback still cannot exceed the
  one-call cap.
- The standalone transform rejects crossing tool pairs in either direction,
  including a retained raw use whose result would be deleted with a recall.

- One-shot surgery disables SDK and Membrane retries and cache keepalive, and
  guards the SDK fetch transport against a second request (including redirects).
  Unknown SDK transport shapes fail closed. Local call-cap refusals withdraw
  compression rather than adding provider-failure streaks or lane pauses.
- Recovery requires a fresh, unused receiptPath in addition to a restored copy.
- Operational limits remain: combined quarantine diagnostics can count
  surgery-only outcomes as ordinary holds. Older package versions can interpret
  those outcomes as ordinary quarantine. Do not resume service or downgrade on
  the disposable treatment copy; rollback means restoring the untouched original
  backup, not reopening the treatment branch with older code.

- One-shot execution finalizes initial receipt-sync and transport-setup failures
  before store access, with recovery output and descriptor cleanup. A failed
  pre-call receipt save reports `not-sent` with an end time; local snapshot
  mismatches withdraw the call without provider-failure accounting.
- Failed recall-curve traces use the last authored/carrier-stripped dispatch's
  hash, size and recall identity. Branded pre-send withdrawals do not replace
  the preceding dispatched log snapshot. Split-piece scope is captured per
  dispatch even when the rung is refused, fails or waits for its window.
- L1 recall telemetry skips empty-ID lookups and reuses a per-operation lookup
  across retries. Nonempty lookups still scan the full persisted projection;
  no large-history benchmark or bounded-history claim is made. Unavailable
  recall totals are `null` with one bounded warning, not fabricated zeros.
  `prior_summary_token_estimate` identifies `stored-summary-estimate`,
  `text-content-estimate` (carrier-stripped retries), or `unavailable`.
  Text-content estimates retain pair/envelope overhead but are not sent-token
  measurements. Ordinary stored-summary estimates may include reasoning.
- Instruction validation names bounded, JSON-escaped unknown keys, presets and
  placeholders alongside supported alternatives; template bodies and participant
  values remain omitted. Malformed braces are diagnosed separately.
