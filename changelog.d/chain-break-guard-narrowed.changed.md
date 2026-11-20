- A removal (`removeMessage`, `removeMessages`) or a `viewFilter` that leaves
  most of an autobiographical store's chunk records naming no message in view
  no longer halts its compression, read through a view with `onBranch`.
  0.25.0's entry for `retractRemoved` and `retractAbsentRows` says a large
  removal halts the compression of a reader not told of it (`FAIL-CLOSED`);
  read through such a view, it no longer does. The
  chain-break guard now asks the store whether the first messages of the
  oldest and the newest of those records are on this branch's messages chain,
  through `onBranch`, an optional `MessageStoreView` method that
  `MessageStore`, `filterMessageStoreView`, `mergeMessageStoreViews` and the
  window a manager presents provide. It halts only where one isn't: a messages
  chain broken under chronicle before 0.5.0, or a store rebuilt under new ids.
  A store rebuilt in a fresh chronicle numbers its messages from 1 again,
  though, so its new messages can take the old ids, and the guard can't tell
  those from the records' own. Nor can it tell the same history appended again
  under new ids after a removal from new conversation, since the removed
  messages stay on the chain. A strategy that reads the store through a view
  without `onBranch` halts as before, and a read of the chain that fails halts
  that rebuild alone. The README's section on the autobiographical strategy
  names the states that hold message ids, for a store rebuilt under new ones.
- While the guard halts, no chunk, waiting or new, is sent to be summarized,
  and demand queues none. A chunk already sent when it trips isn't called
  back: its attempt runs to its end, a later rung of its ladder included.
  Merges run as usual, the merge check and merge-quarantine sweep at open and
  after a drop included, which earlier releases skipped while the guard
  halted. `getCompressionDebt()`
  reads `critical` with `failure: 'chunk-records'`. Its `error` gives the
  cause and the first step, which changes nothing. The `FAIL-CLOSED` log line
  gives every step. `scripts/drain-autobiographical.ts` takes no step once it
  finds the guard holding, with `stopped: 'chunk-records'`, and exits 1.
