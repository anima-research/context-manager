- A sharded `addMessage` keeps a body's shards together, as one body:
  - It refuses a `chunkIngressMessage` decision whose `bodyGroupId` is empty
    or not a string, before any shard is stored. Such shards didn't read as
    one body, so a write that failed partway removed only the first of them
    and threw as if none stayed.
  - An `addMessage` on the same manager made while a sharded `addMessage` of
    its stores its shards (from an `onMessage` listener of a shard's add, or
    a strategy hook that listener runs by presenting a shard) is refused (one
    through another manager sharing the slot isn't: `onMessage`'s contract
    rules it out, as the listener's to avoid), with an error that says
    its row would land between the shards and split the body. Before, it
    landed there, and the cleanup of a write that then failed left the
    shards after it stored.
  - In legacy mode the strategy hears a sharded body once every shard is
    stored, in one `onPresented` call with every shard, as `presentRows`
    gives a body (a strategy with only `onNewMessage` hears each shard in
    turn then). It heard each shard from inside that shard's append, so a
    hook of its could add a message or move the store between the shards. A
    sharded write that fails tells it only of the shards it leaves stored
    (`WriteLandedError`), once it has tried to remove them, in one call: on a
    branch the write's listener moved to, once the strategy is initialized
    there, where that branch's window holds them; where the manager's own
    work telling it fails (the context it builds), they wait for its next
    notification. Where the manager can't
    tell which shards stayed (`WriteOutcomeUnknownError`), every shard the
    window took in waits, and the strategy hears, in one call, those the
    window's listing holds when they are delivered: at once where the store
    reads, and at its next notification where it doesn't.
  - A listener that moves the store's branch between shards stops the write
    before the next shard, and `addMessage` throws `WriteLandedError` naming
    the shards stored, which stay on the branch the write started on, with a
    `cause` that says the branch moved (`WriteOutcomeUnknownError`, with
    `unnamed` 1, where a shard's append threw after the move). Before, the
    later shards landed on the other branch, and the cleanup of a write that
    failed looked for the first shard there.
  - A `removeMessage` or `removeMessages` on the same manager made while a
    sharded `addMessage` of its stores its shards (from an `onMessage`
    listener of a shard's add) is refused (one through another manager
    sharing the slot isn't: `onMessage`'s contract rules it out), with an
    error that says a removal then could split the body or
    move the rows the write removes if it fails. Before, it was taken: the
    body's later shards stayed with no first shard, and a write that then
    failed left them stored and threw as if none stayed.
  - A `branchAt` or `branchSequenceOf` on the same manager made then (from
    such a listener, after it presents a shard) is refused too, with an error
    that says the cut would come before the body's later shards. Before, the
    cut was taken over the shards stored so far, so the new branch's record
    held part of the body, though `branchAt` promises the whole body. So are
    a `fork` and a `derive` on the same manager made then, before either
    makes a branch: each cuts at the head, which holds only the shards stored
    so far. Before, a fork moved the store, so the body's later shards landed
    on the new branch and the branch the write started on kept only the
    first, and a derive's child held part of the body.
