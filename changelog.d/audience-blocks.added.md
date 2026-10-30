- Managers sharing messages that compile for different readers each need a
  `namespace` of their own. `viewReader` names the reader a manager compiles
  for, and a namespace records the first reader it's opened with as its
  strategy starts, keeping the record if that start fails. An empty
  namespace, an omitted one and `'default'` share one record, since an
  omitted namespace shares its context log with the empty one and its
  strategy state with `'default'`. An empty `viewReader` is refused, and an
  open, a `switchBranch` or `fork` onto a branch, a `derive`, or a
  `setStrategy` that would compile a manager for another reader is refused,
  naming both; an open, a `fork` and a `derive` are refused before they
  write anything. Writing the record is a state write, so messages stored on
  a branch after it's first written there (by an open, a switch, a fork, a
  derive or a `setStrategy`) carry sequence numbers one higher than they
  would without it.
- A namespace's summaries hold its reader's view, so an open with no
  `viewReader` on a namespace that records a reader compiles for that
  reader, and a manager compiling for no reader is refused a `switchBranch`,
  `fork` or `setStrategy` onto a branch where its namespace records one. A
  `compile`, `previewContext`, `tick`, `editMessage` and every read of the
  manager's messages through the view it hands its strategy, compression's
  included, are refused when the namespace's record on the store's current branch
  names another reader, or any reader for a manager compiling for none, as
  after a claim made once the manager opened or a branch switched through
  another handle; a compression already waiting on its model when the claim
  is made writes the summary it was making. A manager's
  read-only `viewReader` says the reader it compiles for: the one it was
  opened with or, opened with none, the one its namespace records;
  for a `derive` or a `reopenDerived`, the one its branch records; or none.
- A content block's `audience` names the readers it's for; `addMessage` and
  `editMessage` take such blocks (`ContentBlockWithAudience`). A manager's
  view keeps a block with no `audience` or one that names its reader,
  without the field, so its compiles, summaries, pins, `renderAsNewest`,
  compile provenance (`rawBodies`), thinking binding and its strategy's
  `onNewMessage` hold only what that reader may see, and it leaves out a
  message whose every block is someone else's; a block it leaves out gives
  up the raw replay forms it shares with the message's other blocks. An
  edited message's copies in the context log are written as the reader sees
  them, and removed where the reader sees nothing of it. Summaries written
  before a reader claims a namespace are kept, and that reader's compiles
  use them as written.
- An `editMessage` that may narrow a block's `audience`, hiding a block in
  place from a reader who saw it (blocks are compared by position), is
  refused, naming why, wherever compression may have read the block, since
  nothing takes a block out of a summary already written or a request
  already sent, a removal included. Away from the manager's own reader it's
  refused once a chunk holding the message or a later one has closed, or a
  compression request has read it. The namespace records that on each
  branch, through the new `StrategyContext.markCompressionRead`, whichever
  strategy or manager on it did the reading, and a reopen keeps it. So a
  manager that compiles for a reader refuses to start a strategy that
  doesn't declare the new `marksCompressionReads`, which says it records
  what compression reads before it reads; one that makes no such read
  declares it as it is. Away from any other reader, or from its own while
  another namespace on the branch records the same reader, it's always refused,
  since a manager can't see what another namespace's compression has read.
  So a block takes its audience when its message is added. The record is a
  state write, made by a manager that compiles for a reader as its
  strategy's chunks close, so it moves later sequence numbers too. A request
  never reads a message the record doesn't cover: while it can't be
  written, the strategy takes no chunk or merge from its queues.
- `resetHeadWindow()` without text, under a manager that compiles for a
  reader, stores the transition summary it makes from that reader's view
  for that reader alone, as a block whose `audience` names it; text a host
  gives is stored as given.
- A `derive`d child records its parent's `viewReader`; a child of a manager
  with no `viewReader` records what the parent's head records, a reader or
  none, whatever the checkpoint recorded. The child compiles for the reader
  its branch records, as `reopenDerived` compiles it. A head that records
  another reader refuses a `derive` by a manager with a `viewReader`, and a
  record that isn't a reader's name refuses any `derive`.
- A message holding a block with an `audience` is stored whole, never
  split into shards at ingress, so the view sees all of it at once.
- A store whose blocks declare no `audience`, opened with no `viewReader` on
  a namespace that records no reader, reads and compiles exactly as before
  while the namespace still records none, and while no slot a manager reads
  has held such a block (a slot that stored one stays marked for its store
  object after it's edited away), each listing read through the reader's
  view, and `sequenceOf`, answers as the slots do, asked at the read, so its
  writes don't list the slot. `contentForReader` is exported beside
  `filterMessageStoreView`.
