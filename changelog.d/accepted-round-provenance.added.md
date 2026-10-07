- `compile()` returns `provenance` beside the messages. It holds a `compileId`, the
  namespace and branch the compile read (`{id, name, created}`), and one entry per
  compiled message naming what it carries: raw stored bodies (each marked
  `complete`, or listing what is `missing`: content, shards or tool pairing), the
  summaries it renders, a context injection, or other derived content. It also
  holds an immutable rendered layout for strategies that report one. The sources
  of a split message repeat on every part.
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
  - Receipts, the per-branch accepted layouts, and a once-minted store id are
    Chronicle typed records, so they are unbranched, survive branch deletion, and
    are written only after the store syncs.
  - Usage is the confirming round's own, with unreported fields `unknown`.
  - Query with `listFoldReceipts({ since, limit, branch })`, read a branch's whole
    record with `foldReceiptsFor(branch)`, subscribe with `onFoldReceipt`, and
    label receipts with `setReceiptSource`.
  - `getStoreId`, `currentBranchRef` and `describeRenderedForms` support hosts
    that export or explain them.
