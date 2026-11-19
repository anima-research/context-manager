- Sweeps: a named repair of bodies that a store already holds (`src/sweep.ts`).
  A `SweepEntry` has a `name`, a `line` that says what it mends, and a pure
  `mend(body)` that gives a body's new content, or `null` for a body that it
  leaves. A body is one stored message with its writer, time and metadata,
  read without blobs; a message stored as shards is given whole. A block that
  `mend` gives back as the same object keeps its raw replay forms (`rawItem`,
  `rawXml`); a block that it changes, and every block that shares a raw form
  with one, gives that form up, so a spread block never replays its old text.
  - `ContextManager.showSweep(entry)` lists what the entry would change in
    the slot the manager writes, on the open branch, read as the store holds
    it and not through the manager's view, and names each body that a pass
    would not rewrite, and why. It writes nothing, and it never gives the old
    text: what an entry throws is reported by its type alone.
  - `ContextManager.takeSweep(name)` records once, for the whole store, that
    it took the sweep: a `context-manager/sweep-take` typed record, which
    every branch sees. It rewrites nothing.
  - `ContextManager.applySweeps(entries)` makes a pass for the slot the
    manager writes, on a branch that hasn't finished the sweep's newest
    take. Before it rewrites, it appends what it will rewrite to the
    branch's applied list (`context-manager/sweeps-applied`, read with
    `sweepsApplied`). A body stored as one row is edited. A body stored as
    shards becomes one row at its first shard's place, with that shard's id,
    and its later shards are removed as `removeMessages` removes rows; a
    pass that stopped between the two is finished by the next one, and those
    later shards are never asked of an entry. A rewrite never makes one row
    of content that the strategy would store as shards
    (`chunkIngressMessage`), since nothing shards a stored row again: such a
    body is refused, unless it was such a row already. A body that is
    refused, stored short (fewer shards than it declares), or on which the
    entry throws is reported and not listed, and the sweep stays owed. One
    pass at a time runs on a store; a listener of its writes that moves the
    store to another branch or closes the manager stops it (`stopped`), and
    list items or take records that don't parse are named (`unreadable`).
    No load of a manager makes a pass: its host asks for one.
  - `ContextManager.sweepReceipt(name)` says where the sweep stands on the
    open branch: the store's newest take, whether the branch finished it,
    and each pass with the bodies that it listed.
  - `derive` carries the applied list with the other states the manager
    owns.
  - `AutobiographicalStrategy`, and so `KnowledgeStrategy`, registers a new
    state, `<namespace>/autobio:sweep-cursor`, and every instance reads the
    applied list's length at initialize, before a live select and at each
    tick. Each instance keeps how far it has read; where a pass listed rows
    since, it lets go of what covers each: the L1 over it and every summary
    above, in either window mode. A chunk record that holds a listed row
    keeps its rows and is compressed again, so the resident's own
    compression folds the rewritten row again, at the cost of its summarizer
    calls. Nothing is let go of while a pass runs on the store. An
    audit-only instance lets go of nothing, as it leaves rows that left the
    window under what covers them.
  - `MessageStore.rewriteBody(id, content)` writes a body's whole content at
    its first row, without the body group's fields;
    `MessageStore.checkRewrite(id, content)` throws what it would refuse,
    writing nothing; `MessageStore.bodiesAsStored()` lists the slot's bodies
    as stored. `MessageStore.refuseToolPairSplit` takes an optional `last`,
    the last row the content replaces.
  - Two limits. A long note whose mended text is still long is not mended:
    it is refused, and stays owed. A summary of other rows, made before the
    pass, keeps any words that it took from a mended body that its request
    carried as context: a summary records no recall set, so no let-go finds
    it.
  - As after any edit, a rewrite changes what a branch sends before its
    later replies, so those replies' thinking is no longer sent to a
    provider that binds thinking to its request (`thinking-binding.ts`).
    The removed later shards leave the applying manager's window; another
    manager's window drops them when its host calls `retractRemoved` or
    `retractAbsentRows`, as after any removal through another manager.
