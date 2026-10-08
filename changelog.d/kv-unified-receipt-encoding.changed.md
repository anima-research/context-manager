- The kv-unified presentation receipt is persisted in a columnar shape:
  the leaf ids once, then runs of `(rep, level, lastChangedSeq)` over
  them, about a tenth of the previous one-entry-per-leaf JSON (0.5 MB
  against 5 MB for a 75k-message history, appended to the store's record
  log after every accepted turn). Old receipts are read unchanged, and
  `kvUnified.receiptEncoding: 'v1'` keeps writing the previous shape.
