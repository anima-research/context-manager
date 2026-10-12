- `compile()` returns `provenance` beside the messages. It holds a `compileId`, the
  namespace and branch the compile read (`{id, name, created}`), and one entry per
  compiled message naming what it carries: raw stored bodies (each marked
  `complete`, or listing what is `missing`: content or shards), the
  summaries it renders, a context injection, or other derived content. It also
  holds an immutable rendered layout for strategies that report one. Every
  compile builds it, whether or not the host accepts rounds, at a cost that
  grows with the history the compile reads. The sources
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
- Fold receipts: `acceptRound({ provenance, usage, presentation })` accepts a
  compile whose provider round succeeded. It compares the layout with the last
  layout accepted on the compile's own branch in its namespace, by any manager
  of that namespace on the store, even when another branch has since been
  selected, over messages present in both. When any message changed form
  (raw, partial raw, summary, a different summary, omitted), it appends a
  receipt naming each changed run's boundaries, forms, summaries and estimated
  tokens. It writes a baseline when the branch has no record, or when its
  newest record can't be read (another format, or a chain that doesn't
  rebuild), which is reported once. Arrivals are not folds.
  - Each acceptance, an unchanged layout included, commits the branch's new
    layout and its receipt as one Chronicle typed record, alongside a
    once-minted store-id record. Typed records are enumerable from any branch
    and survive branch deletion, though each takes the next sequence of the
    branch selected when it is written. The store syncs before the record is
    appended, so the state it names is durable first, and again after, so an
    acceptance is durable before `acceptRound` returns or announces it, or a
    query lists it. Each sync fsyncs the log and the store's metadata, even
    with nothing pending, so every accepted round pays two. A compile is
    accepted once: a retry writes nothing and returns what its first
    acceptance returned (its receipt, or null), whether that acceptance
    reported success or an uncertain failure, ran in another manager on the
    store, or ran before a reopen. The one exception is Chronicle's own: if
    the store's last record rots, open drops it, so a retry writes the
    acceptance again, and the lost record's id goes to the next record. A compile is accepted on
    the manager that compiled it: one of another namespace is refused with
    an error.
  - A layout persists as its members (message sequences, gap-coded, about
    1.3 bytes each) and its units (forms with counts), so a message missing
    from either view is never counted inside a range. An acceptance writes a
    delta on the branch's previous record, whose size follows what changed,
    or a snapshot of the whole layout once the records since the last
    snapshot would outweigh it, each counted whole, receipt included. So
    snapshots cost about as much again as the deltas between them, the bytes
    stored per acceptance don't grow with the history on average, though each
    snapshot holds the whole view's members, and rebuilding a layout reads at
    most about two snapshots' worth.
  - A use reads the records it needs rather than every record. An
    acceptance reads its branch's newest record and the chain that rebuilds
    its layout. A branch is found by reading back from the store's newest
    record, and every branch met on the way is noted, so the records present
    when the store opened are read at most once, by whichever lookups need
    them; a branch with no record yet, or a deleted branch looked up by
    name, may take that whole read. A compile carries where the journal
    stood (`provenance.journalMark`, a record known durable), so finding an
    earlier acceptance of the same compile reads only the records after it.
    Each record names its branch's previous receipt, so a branch's receipts
    are walked back reading only receipts. Every manager on one store
    object shares what has been read; the first use after the store opens
    lists the records' ids and syncs once, making every record present
    durable.
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
    whole record from its start; `since` is an ISO 8601 date, or a date
    and time with its offset (a bare number, or a time without an offset,
    is refused rather than guessed at). `branch` is a name, or a branch as
    receipts name it (`{ id, created }`), which reaches a deleted branch
    even when a live one has taken its name. A query returns its manager's
    namespace's receipts. A history that can't be read whole says so in
    `note`. Label receipts with `setReceiptSource`.
  - Subscribe with `onFoldReceipt`. A listener hears each receipt its
    manager's `acceptRound` returns, and, at that manager's next acceptance
    on a branch, the branch's newest receipt if the manager hasn't announced
    it: one whose write reported a failure, one another manager wrote, or one
    from before a reopen. So it can hear a receipt again, and needn't hear
    every receipt: key on the receipt's id and `compileId` (a receipt lost to
    Chronicle's rot exception can have its id go to a later receipt), and
    read `listFoldReceipts` for the whole record.
  - `getStoreId`, `currentBranchRef` and `describeRenderedForms` support hosts
    that export or explain them.
