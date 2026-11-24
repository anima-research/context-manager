- Sweeps: a named repair of bodies that a store already holds (`src/sweep.ts`).
  A `SweepEntry` has a `name`, a `line` that says what it mends, and a pure
  `mend(body)` that gives a body's new content, or `null` for a body that it
  leaves. A body is one stored message with its writer, time and metadata,
  read without blobs; a message stored as shards is given whole, its other
  blocks first and then its joined text, as `AutobiographicalStrategy`
  renders a sharded body in its head and recent windows. A block that `mend` gives back as
  the same object keeps its raw replay forms (`rawItem`, `rawXml`); a block
  that it changes, and every block that shares a raw form with one, gives
  that form up, so a spread block never replays its old text. An opaque
  carrier keeps its raw item, which is its whole content: an entry mends one
  by its `rawItem`. An entry can't empty a body: a result with no block, or
  with only text blocks that hold nothing, is reported. A sweep repairs what
  the store gives and erases nothing: the old text stays readable at each
  listed item's `sequence` (`getMessageAt`), on a branch cut before the pass
  until a pass runs there, in each old summary until its namespace's second
  act, and in the summaries that the second limit below names.
  - `ContextManager.showSweep(entry)` lists what the entry would change in
    the slot the manager writes, on the open branch, read as the store holds
    it and not through the manager's view, and names each body that a pass
    would not rewrite, and why. It writes nothing, and its changes never
    give the old text: what an entry throws is reported by its class alone.
    A refusal is given as it reads, and can quote the content that the entry
    gave. Its `oldSummaries` counts, at each level, the summaries of the
    manager's strategy that a pass of the changes would leave old. Its
    `writeDrops` gives what the pass would drop itself, where it joins a
    long note (below): the summaries at each level, the chunk records that
    keep a row and are folded again, the estimated tokens of the rows under
    them that stand, the first row at its new size, and the change in the
    strategy's floor that the write makes (`SummaryDropCost`, below). It
    counts a note whose later shards an earlier
    pass left standing too, since the next pass removes them first. A
    summary is counted in one of the two, never in both.
  - `ContextManager.takeSweep(name)` records once, for the whole store, that
    it took the sweep: a `context-manager/sweep-take` typed record, which
    every branch sees. It rewrites nothing. No call takes a take back, so
    an entry stays in its host's code while any store that took it may
    still have a branch, a derived context or a slot that hasn't finished
    it: where the entry no longer ships, each pass there reports the sweep
    `unknown`.
  - `ContextManager.applySweeps(entries)` makes a pass for the slot the
    manager writes, on a branch that hasn't finished the sweep's newest
    take. Before it rewrites, it appends what it will rewrite to the
    branch's applied list (`context-manager/sweeps-applied`, read with
    `sweepsApplied`). A body stored as one row is edited. A body stored as
    shards becomes one row at its first shard's place, with that shard's id,
    and its later shards are removed as `removeMessages` removes rows; a
    pass that stopped between the two is finished by the next one, which
    lists those later shards again before it removes them, so a strategy
    that folded them since lets go of that. Later shards are never asked of
    an entry. A rewrite never makes one row
    of content that the strategy would store as shards
    (`chunkIngressMessage`), since nothing shards a stored row again: such a
    body is refused, unless it was such a row already. A body that is
    refused, stored short (fewer shards than it declares), or on which the
    entry throws or gives no content is reported and not listed, and the
    sweep stays owed; so is a body that changed during the pass, after it
    was listed, which is left as it stands. One pass at a time runs, on any
    store; a listener of its writes that moves the store to another branch
    or closes the manager stops it, and so does a write to the applied list
    that throws (`stopped`), and list items or take records that don't
    parse are named (`unreadable`). Its report gives what the manager's
    strategy dropped during the pass (`dropped`, a `SummaryDropCost`), or
    null where a listener moved the store to another branch or closed the
    manager.
    No load of a manager makes a pass: its host asks for one.
  - `ContextManager.sweepReceipt(name)` says where the sweep stands on the
    open branch: the store's newest take, whether the branch finished it,
    each pass with the bodies that it listed, each marked `joined` once a
    pass joined it and none of its later shards is stored, and
    `oldSummaries`, the strategy's old summaries at each level over the rows
    those passes listed. An old summary is a summary written before a pass
    listed a row under it, at any level, or a summary above one. A summary
    written before this release counts as old; a later one carries the
    store's sequence when it was written (`SummaryEntry.writtenAtSequence`),
    which is compared with the list item's `sequence`. A summary that a
    pass's join of a long note drops is none. The show, the receipt and the
    two calls below need an initialized manager, and read its strategy as it
    last read the store.
  - `ContextManager.oldSummaryCost(name)` gives what the second act would
    drop and writes nothing: the old summaries at each level, the chunk
    records under them, which the strategy's compression folds again, the
    estimated tokens of the rows under them, which render raw until it has,
    and the change in the strategy's floor that the act makes
    (`SummaryDropCost`).
  - `ContextManager.dropOldSummaries(name)` is the second act: the manager's
    strategy drops its old summaries of the sweep, with every summary above
    them, and gives what it dropped. It is done when the call returns, and
    no compile of that manager after it, dry or live, holds one of them.
    Each chunk record under them keeps its rows and is compressed again. A
    second call drops nothing, and other namespaces keep theirs. It then
    appends to the applied list that the namespace made the act (an item of
    kind `dropped`), so another instance of the namespace takes up the
    store at its next initialize, live select, tick or L1; until then, a
    dry compile of that instance can still hold a dropped summary. A call
    that throws lists nothing, and a call made again lists the act. An
    audit-only strategy refuses it, and writes nothing. A strategy declares
    it, with `oldSummaryCost`, `writeDropCost` and `beforeSweepPass`, as
    optional members of `ContextStrategy`; for a strategy without them, the
    manager reports no old summaries and drops none.
  - `derive` carries the applied list with the other states the manager
    owns.
  - `AutobiographicalStrategy`, and so `KnowledgeStrategy`, reads the
    branch's applied list at initialize, before a live select, at each tick,
    before it writes an L1 and, in the manager that made the pass, as the
    pass ends (the function that `beforeSweepPass` gives). Each instance
    keeps in memory how far it has read, and reads the list from its start
    at each initialize. A summary over a row that a pass edited in place
    stays: no read of the list drops it, so such an edit doesn't make the
    resident's context larger, and a dry compile and a live one show the
    same summaries. It goes at the second act, or as any summary goes when
    its row leaves the window. A joined note loses its summaries at once,
    in either window mode: each summary over a removed later shard, each L1
    over its first row written before its join was listed, and every
    summary above one. The chunk record that held a shard keeps its other
    rows, the record over the first row keeps its rows, and each is
    compressed again, the first row from its new text. A listed later shard
    that still stands, after a pass that stopped before its removal, keeps
    what covers it, and so does the first row, until a pass removes the
    shard. An L1 written over the joined row after its join stays. An L1 in
    flight over a listed row is not written, and its chunk is folded again
    from the new text. Nothing is read while any pass runs. Another
    manager's strategy lets go of a joined note's summaries at its next
    live select, tick or L1, and until then a dry compile of it can still
    show them. An audit-only instance lets go of nothing, as it leaves rows
    that left the window under what covers them, and it refuses a pass
    before any write.
  - `MessageStore.rewriteBody(id, content)` writes a body's whole content at
    its first row, without the body group's fields;
    `MessageStore.checkRewrite(id, content)` throws what it would refuse,
    writing nothing; `MessageStore.bodiesAsStored()` lists the slot's bodies
    as stored, and `MessageStore.bodyAsStored(id)` gives one of them.
    `MessageStore.refuseToolPairSplit` takes an optional `last`,
    the last row the content replaces.
  - The second act can cost the resident its turns for a time. The rows
    under the dropped summaries render raw until compression folds them
    again, and a compile whose budget can't hold them refuses until then.
    Where a fault runs through much of an old history, the act makes most
    of it raw. `oldSummaryCost` gives the change in the floor before the
    act (`floorChange`, below).
  - A write that joins a long note can cost the resident its turns for a
    time too. A summary left without its parent renders again at its own
    level until compression merges it again, and the rows under a dropped
    L1 render raw until compression folds them again; a compile whose
    budget can't hold them refuses until then. The same happens on each
    other branch when a pass there joins the note, with no show before it.
    `showSweep` gives the change in the floor on the open branch before the
    write (`writeDrops.floorChange`), and each pass reports what it dropped
    and the change it made (`dropped`).
  - `SummaryDropCost.floorChange` (`FloorChange`) says how much more room,
    or less, a compile needs after the write: the change in the strategy's
    floor, the fewest tokens that the compile's plan can reach for the open
    branch. With the over-budget grace, the floor says the least `maxTokens`
    at which a compile fits, so a compile whose budget held the old floor
    can refuse once it grows. It counts the write as it lands, before
    compression folds anything again, and is below zero where the floor
    shrinks, as on a flat store, where the dropped summaries' own tokens
    leave the compile. `rawTokens` is the text that compression folds
    again, not that change. The change is not known, with the reason, where
    it could be wrong: the strategy selects without adaptive resolution; a
    row that the write rewrites or removes lies in or next to the head or
    the recent window, which then moves, or holds a tool call or result; a
    summary lies across a raw window, where a compile can take it and fit
    below the floor; a row that it prices is pinned or, under kv-unified,
    locked, or holds an image; a chunk record names a summary that the
    strategy doesn't hold; the instance hasn't read what another instance
    of its namespace or a pass on the branch changed; a row was added, or a
    summary written or changed, during the pass; under a folding strategy other than
    kv-unified, a summary that it prices costs more than the rows under it;
    or the strategy doesn't price its floor.
  - Four limits. A long note whose mended text is still long is not mended:
    it is refused, and stays owed. A summary of other rows, made before the
    pass, keeps any words that it took from a mended body that its request
    carried as context: a summary records no recall set, so the second act
    doesn't find it. Every namespace keeps its old summaries until its own
    second act; an older context-manager makes none, and reads no applied
    list, so beside a host that runs one a namespace keeps its summaries
    over a joined note until an instance of this release opens it. A summary
    that an older release writes carries no sequence, so this release reads
    it as written before every pass. A context copied from a compile between
    a pass and the second act, as rows of its own, keeps the old summaries'
    words for good: no second act reaches a copy.
  - As after any edit, a rewrite changes what a branch sends before its
    later replies, so those replies' thinking is no longer sent to a
    provider that binds thinking to its request (`thinking-binding.ts`).
    The removed later shards leave the applying manager's window; another
    manager's window drops them when its host calls `retractRemoved` or
    `retractAbsentRows`, as after any removal through another manager.
