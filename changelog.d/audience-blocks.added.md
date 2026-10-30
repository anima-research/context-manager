- Managers sharing messages that compile for different readers each need a
  `namespace` of their own: `viewReader` names the reader a manager compiles
  for, a namespace records the first reader it's opened with as its strategy
  starts, and keeps the record if that start fails (setting it to null
  through the store, on each branch it should open on, counts as never
  claimed); an empty namespace, an omitted one and `'default'` share one
  record, since an omitted namespace shares its context log with the empty
  one and its strategy state with `'default'`; an empty `viewReader` is
  refused; and an open, a `switchBranch` or `fork` onto a branch, a
  `derive`, or a `setStrategy` that would compile it for another is refused,
  naming both; an open, a `fork` and a `derive` are refused before they
  write anything. Writing the record is a state write, so messages stored on
  a branch after it's first written there (by an open, a switch, a fork, a
  derive or a `setStrategy`) carry sequence numbers one higher than they
  would without it. A content block's `audience` names the readers it's for;
  `addMessage` and `editMessage` take such blocks
  (`ContentBlockWithAudience`). A manager's view keeps a block with no
  `audience` or one that names its `viewReader`, without the field, so its
  compiles, summaries, pins, `renderAsNewest`, compile provenance
  (`rawBodies`), thinking binding and its strategy's `onNewMessage` hold
  only what that reader may see, and leaves out a message whose every block
  is someone else's; a block it leaves out gives up the raw replay forms it
  shares with the message's other blocks. With no `viewReader` the view
  keeps no block that has an `audience`, and the open isn't refused. An
  edited message's copies in the context log are written as the reader sees
  them, and removed where the reader sees nothing of it. Summaries written
  before a reader claims a namespace are kept, and that reader's compiles
  use them as written. A manager `derive`s a child that compiles for its
  parent's `viewReader`. The child records its parent's `viewReader`; a
  child of a manager with no `viewReader` records what the parent's head
  records, a reader or none, whatever the checkpoint recorded. A head that
  records another reader refuses a `derive` by a manager with a
  `viewReader`, and a record that isn't a reader's name refuses any
  `derive`. `reopenDerived` compiles for the reader the branch recorded. An
  `audience` is read on a message's own blocks other than tool calls, tool
  results, system changes and inline media, which the store keeps as a blob;
  a write that puts one on those, on a block inside another, or in a context
  entry, or one that isn't a list of reader names, is refused, saying why,
  and so is a compile given one in an injection or in `messageInjections`,
  or a preview given one in `messageInjections`. A message holding a block
  with an `audience` is stored whole, never split into shards at ingress. A
  store whose blocks declare no `audience`, opened with no `viewReader`,
  reads and compiles exactly as before, and while no slot a manager reads
  has held such a block (a slot that stored one stays marked for its store
  object after it's edited away), each listing read through the reader's
  view, and `sequenceOf`, answers as the slots do, asked at the read, so its
  writes don't list the slot. `contentForReader` is exported beside
  `filterMessageStoreView`, and a manager's read-only `viewReader` says the
  reader it compiles for: the one it was opened with, its parent's for a
  `derive`, the branch's record for a `reopenDerived`, or none.
