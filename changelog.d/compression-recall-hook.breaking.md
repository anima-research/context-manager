- **Strategy subclass authors:** the protected `separateRecallAnswers` hook now accepts an optional second
  `recallHeadersEnd` argument; overrides forwarding to `super` must forward it
  to retain the L1 source boundary. Overrides using their own second argument
  must adapt to this index. One-argument calls now recognize only construction-tagged recall headers, not freshly built or cloned recall-shaped text. Preserve the original constructed header block objects through `separateRecallAnswers`, `collapseConsecutiveMessages`, and `prepareCompressionRequest`; cloning them loses recall provenance for separators, cache seams, recall-curve expansion, and sent-recall accounting.

- **Surgery receipt consumers:** `provenanceMode` is now `authored-request`, not
  `external-receipt-only`; update parsers to accept the new value. The restored
  message-digest compatibility aliases remain unchanged.

- **Subclass name collisions:** new protected hooks `compressionOutcomeNamespace`,
  `authorL1CompressionRequest`, and `getCompressionOpening`, and public method
  `assertCompressionQuarantineChunk` reserve these names. Rename pre-existing
  private helpers or adapt compatible overrides before upgrading; otherwise
  compilation can fail or an existing method can become an unintended override.
