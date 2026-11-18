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
