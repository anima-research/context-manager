- With `foldingStrategy: 'kv-unified'`, each cache marker now goes where a
  message ends a unit of the solved layout, and is recorded at that boundary,
  so the cache reference an accepted presentation keeps says where each
  marker sits. The layout renders the head window as one unit, and two kinds
  of marker didn't fit it:
  - **A marker on a head message other than the head window's last** was
    recorded at the head window's end. Two or more of them were recorded at
    that one boundary, so the request carried more markers than the compile
    recorded, and the accepted presentation kept no cache reference: the next
    compile's solver weighed no cache costs. That could happen on every
    compile while the head window held several messages and nothing was yet
    in the middle. A marker now goes in the head window only on its last
    message.
  - **A body whose shards span the head and the recent window,** with nothing
    between them, goes out as one message, and its marker was recorded at the
    head window's end, short of where it sits by the body's shards in the
    recent window. It's now recorded where its last shard ends.
  - A request whose marker count differs from its compile's, which drops the
    reference, is now logged once per strategy (`[kv-unified] … cache markers
    where its compile marked …`), where before nothing said so. A request
    with no markers, as with prompt caching off, isn't logged.
