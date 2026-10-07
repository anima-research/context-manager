- `compile()` returns `provenance` beside the messages. It holds a `compileId`, the
  namespace and branch the compile read (`{id, name, created}`), and one entry per
  compiled message naming what it carries: raw stored bodies (each marked
  `complete`, or listing what is `missing`: content or shards), the
  summaries it renders, a context injection, or other derived content. It also
  holds an immutable rendered layout for strategies that report one. The sources
  of a split message repeat on every part. A raw body is judged as stored: its
  id is shard 0's (the id `addMessage` returned), and a shard the view filter
  hid from the strategy counts as missing. A composite that merged a body's
  shards is complete when it carries their text in order and their media
  unaltered. `rawSources` maps every raw body named there to the stored
  messages the compile read (its head and every shard, including any the view
  filter hid), auxiliary-store messages included.
- Strategies can report their rendered layout. A strategy declares `renderedForms`
  and names the summaries behind derived entries in `ContextEntry.summaries`, with
  `describeRenderedSummaries(ids)` giving each summary's level, covered messages and
  method. `takeSelectionCause()` can explain the last committed selection.
  Passthrough, windowed passthrough and autobiographical (with its subclasses)
  report layouts, and autobiographical marks a summary whose rendered text a cap
  cut as `partial`.
- Fold receipts: `acceptRound({ provenance, usage })` accepts a compile whose
  provider round succeeded. It compares the layout with the last layout accepted
  on the compile's own branch, by any manager on the store, even when another
  branch has since been selected, over messages present in both. When any
  changed form (raw, partial raw, summary, a different summary, omitted), it
  appends a receipt naming each changed run's boundaries, forms, summaries and
  estimated tokens. It writes a baseline when the branch has no record.
  Arrivals are not folds.
  - Each acceptance, an unchanged layout included, commits the branch's new
    layout and its receipt as one Chronicle typed record, alongside a
    once-minted store-id record. These are unbranched, survive branch
    deletion, and are written only after the store syncs. A compile is
    accepted once: a retry writes nothing, whether its first acceptance
    reported success or an uncertain failure, ran in another manager on the
    store, or ran before a reopen.
  - Every manager on one store object shares an index of these records. The
    first acceptance or receipt query after the store opens reads every
    record once; later ones read only the records added since.
  - Layout ranges carry exact membership, so a message missing from either
    view is never counted inside a range.
  - Layout tokens are base estimates, taken before the store's calibration, so
    identical content costs the same in every compile. A receipt counts each
    summary once per side, in the first changed run that names it.
  - `presentation` (`verbatim`, `altered` or `unknown`) records how the
    confirming round carried the compile, as its producer reported.
  - Usage is the confirming round's own, with unreported fields `unknown`.
  - Query with `listFoldReceipts({ since, limit, branch })`, read a branch's whole
    record with `foldReceiptsFor(branch)`, subscribe with `onFoldReceipt`, and
    label receipts with `setReceiptSource`.
  - `getStoreId`, `currentBranchRef` and `describeRenderedForms` support hosts
    that export or explain them.
