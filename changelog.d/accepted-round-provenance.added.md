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
  unaltered, and a tool result that pairing repair moved next to its tool_use
  still counts as carried there. A body is one ingestion: the same text
  ingested twice is two bodies, though a group id (a hash of the content)
  names both. `rawBodies` maps each raw body's head to its stored messages as
  the compile read them (head first, then every shard of that ingestion,
  including any the view filter hid), auxiliary-store messages included.
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
    once-minted store-id record. Typed records are enumerable from any branch
    and survive branch deletion, though each takes the next sequence of the
    branch selected when it is written. The store syncs before the record is
    appended, so the state it names is durable first, and again after, so an
    acceptance is durable before `acceptRound` returns or announces it. A
    compile is accepted once: a retry writes nothing, whether its first
    acceptance reported success or an uncertain failure, ran in another
    manager on the store, or ran before a reopen.
  - A layout persists as its members (message sequences, gap-coded, about
    1.3 bytes each) and its units (forms with counts), so a message missing
    from either view is never counted inside a range, and a record's size
    follows what changed and what was rendered, not the history behind the
    window. An acceptance writes a delta on the branch's previous record
    until the deltas since the last snapshot would outweigh it; then a
    snapshot.
  - Every manager on one store object shares an index of these records: the
    first acceptance or receipt query after the store opens lists and reads
    them once, and each manager adds its own records as it writes them. The
    index keeps record ids and acceptance times; a receipt is read from the
    store when a query returns it.
  - Layouts persist base token estimates, taken before the store's
    calibration, so identical content costs the same in every compile. A
    receipt's estimated token counts apply the calibration its compile
    captured to both sides, and count each summary once per side, in the
    first changed run that names it.
  - `presentation` (`verbatim`, `altered` or `unknown`) records how the
    confirming round carried the compile, as its producer reported.
  - Usage is the confirming round's own, with unreported fields `unknown`.
  - Query with `listFoldReceipts({ afterId, since, limit, branch })`:
    newest first, or with `afterId` (a receipt id) oldest first from just
    after it, so a reader pages forward from the last receipt it got, with
    `more` saying whether there is more, and `afterId: '0'` pages a branch's
    whole record from its start; `since` is an ISO 8601 time (a bare number
    is refused rather than guessed at). Subscribe with `onFoldReceipt`, and
    label receipts with `setReceiptSource`.
  - `getStoreId`, `currentBranchRef` and `describeRenderedForms` support hosts
    that export or explain them.
