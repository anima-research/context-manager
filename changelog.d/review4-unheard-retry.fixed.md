- The calls that waited for a strategy's initialization are no longer lost
  when their delivery can't read the window. A delivery whose read throws
  keeps what it didn't make, logged, and the strategy's next notification
  makes those calls before its own, which waits behind them, so the
  strategy hears calls in the order they came. Before, the queues were
  emptied before the read, so one read that threw lost every waiting call,
  and a throw from the presented rows' mode read failed the
  initialization.
