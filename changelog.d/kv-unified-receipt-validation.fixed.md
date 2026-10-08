- Reject malformed kv-unified v2 presentation receipts during loading,
  validating run fields and bounds before expanding leaves so invalid
  representation references cannot corrupt continuity and oversized counts
  cannot stall reopening the store.
