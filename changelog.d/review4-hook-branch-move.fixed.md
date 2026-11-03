- A `presentRows` that puts a body back whole, whose `onRetracted` hook for
  the shards that leave moves the store's branch, sets a strategy, starts
  an initialization or closes the manager, no longer calls `onPresented`
  with rows it can't find (`undefined` rows, for a strategy with no
  `initialize`) or throws after its write landed (for one with an
  `initialize`): the body waits, as rows a hook stopped do, and is heard
  once the strategy is initialized, where the window of the branch it
  initialized on holds it. `retractRows`' second call, for rows the store
  no longer holds, waits the same way after such a hook of its first.
