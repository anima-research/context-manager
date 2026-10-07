- `compile()` returns `provenance` beside the messages. It holds a `compileId`, the
  namespace and branch the compile read (`{id, name, created}`), and one entry per
  compiled message naming what it carries: raw stored bodies (each marked
  `complete`, or listing what is `missing`: content or shards), the
  summaries it renders, a context injection, or other derived content. It also
  holds an immutable rendered layout for strategies that report one. The sources
  of a split message repeat on every part. `rawSources` maps every raw body
  named there to the stored message the compile's view held, auxiliary-store
  messages included.
- Strategies can report their rendered layout. A strategy declares `renderedForms`
  and names the summaries behind derived entries in `ContextEntry.summaries`, with
  `describeRenderedSummaries(ids)` giving each summary's level, covered messages and
  method. `takeSelectionCause()` can explain the last committed selection.
  Passthrough, windowed passthrough and autobiographical (with its subclasses)
  report layouts, and autobiographical marks a summary whose rendered text a cap
  cut as `partial`.
- Fold receipts: `acceptRound({ provenance, usage })` accepts a compile whose
  provider round succeeded. It compares the layout with the last layout accepted
  on the compile's own branch, even when another branch has since been selected,
  over messages present in both. When any changed form (raw, partial raw, summary,
  a different summary, omitted), it appends a receipt naming each changed run's
  boundaries, forms, summaries and estimated tokens. It writes a baseline when the
  branch has no record. Arrivals are not folds.
  - Each acceptance commits the branch's new layout and its receipt as one
    Chronicle typed record, alongside a once-minted store-id record. These are
    unbranched, survive branch deletion, are written only after the store
    syncs, and a retry after an uncertain write can't duplicate a receipt.
  - Layout ranges carry exact membership, so a message missing from either
    view is never counted inside a range.
  - `presentation` (`verbatim`, `altered` or `unknown`) records how the
    confirming round carried the compile, as its producer reported.
  - Usage is the confirming round's own, with unreported fields `unknown`.
  - Query with `listFoldReceipts({ since, limit, branch })`, read a branch's whole
    record with `foldReceiptsFor(branch)`, subscribe with `onFoldReceipt`, and
    label receipts with `setReceiptSource`.
  - `getStoreId`, `currentBranchRef` and `describeRenderedForms` support hosts
    that export or explain them.
