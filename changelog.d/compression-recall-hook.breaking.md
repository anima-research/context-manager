- **Strategy subclass authors:** the protected `separateRecallAnswers` hook now accepts an optional second
  `recallHeadersEnd` argument; overrides forwarding to `super` must forward it
  to retain the L1 source boundary. Overrides using their own second argument
  must adapt to this index. The default one-argument behavior for other callers remains unchanged.

- **Surgery receipt consumers:** `provenanceMode` is now `authored-request`, not
  `external-receipt-only`; update parsers to accept the new value. The restored
  message-digest compatibility aliases remain unchanged.
