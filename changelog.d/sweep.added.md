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
  listed item's `sequence` (`getMessageAt`), on every branch cut before the
  pass, and in the summaries that the second limit below names.
  - `ContextManager.showSweep(entry)` lists what the entry would change in
    the slot the manager writes, on the open branch, read as the store holds
    it and not through the manager's view, and names each body that a pass
    would not rewrite, and why. It writes nothing, and its changes never
    give the old text: what an entry throws is reported by its class alone.
    A refusal is given as it reads, and can quote the content that the entry
    gave.
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
    parse are named (`unreadable`).
    No load of a manager makes a pass: its host asks for one.
  - `ContextManager.sweepReceipt(name)` says where the sweep stands on the
    open branch: the store's newest take, whether the branch finished it,
    and each pass with the bodies that it listed.
  - `derive` carries the applied list with the other states the manager
    owns.
  - `AutobiographicalStrategy`, and so `KnowledgeStrategy`, registers a new
    state, `<namespace>/autobio:sweep-cursor`, and every instance reads the
    applied list's length at initialize, before a live select, at each tick
    and before it writes an L1. Each instance keeps how far it has read,
    from the cursor that its namespace stored when the instance loaded its
    summaries; where a pass listed rows since, it lets go of what covers
    each: the L1 over it and every summary above, in either window mode, and
    an L1 in flight over it is not written. A chunk record that holds a
    listed row keeps its rows, but for the later shards that the pass
    removes, and is compressed again, so the resident's own compression
    folds the rewritten row again, at the cost of its summarizer calls.
    Nothing is let go of while any pass runs. A dry run lets go of nothing,
    so it can show what the next live select lets go of. An audit-only
    instance lets go of nothing, as it leaves rows that left the window
    under what covers them.
  - `MessageStore.rewriteBody(id, content)` writes a body's whole content at
    its first row, without the body group's fields;
    `MessageStore.checkRewrite(id, content)` throws what it would refuse,
    writing nothing; `MessageStore.bodiesAsStored()` lists the slot's bodies
    as stored, and `MessageStore.bodyAsStored(id)` gives one of them.
    `MessageStore.refuseToolPairSplit` takes an optional `last`,
    the last row the content replaces.
  - Three limits. A long note whose mended text is still long is not
    mended: it is refused, and stays owed. A summary of other rows, made
    before the pass, keeps any words that it took from a mended body that
    its request carried as context: a summary records no recall set, so no
    let-go finds it. An older context-manager reads no applied list: after a
    rollback, or beside a host that runs an older release, a namespace that
    no instance of this release has opened since a pass keeps its summaries
    of the old text, and renders them.
  - As after any edit, a rewrite changes what a branch sends before its
    later replies, so those replies' thinking is no longer sent to a
    provider that binds thinking to its request (`thinking-binding.ts`).
    The removed later shards leave the applying manager's window; another
    manager's window drops them when its host calls `retractRemoved` or
    `retractAbsentRows`, as after any removal through another manager.
