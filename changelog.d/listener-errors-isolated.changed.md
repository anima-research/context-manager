- A listener added with `onMessage` that throws no longer fails the write
  that emitted its event: the error is logged, the write stands, and the
  other listeners are still told. Before, the write threw after it had
  landed, so a caller that retried wrote it twice, and a sharded
  `addMessage` stopped partway through its body. The log line names the
  message the listener missed. Each `onMessage` call now registers its own
  listener and returns its own unsubscribe, so a function registered twice
  hears each event twice; before, the second registration was ignored, and
  either unsubscribe removed both.
