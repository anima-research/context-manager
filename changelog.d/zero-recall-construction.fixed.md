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

- Surgery receipt readers should migrate `call.originalRequestSha256` to `call.originalMessagesSha256` and `call.transformedRequestSha256` to `call.transformedMessagesSha256`. Both old names remain transitional aliases; all four hash message arrays, not whole requests.
