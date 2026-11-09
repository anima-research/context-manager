- A removal (`removeMessage`, `removeMessages`) or a `viewFilter` that leaves
  most of an autobiographical store's chunk records naming no message in view
  no longer halts its compression. The chain-break guard now asks the store
  whether the first messages of the oldest and the newest of those records are
  on this branch's messages chain, through `onBranch`, an optional
  `MessageStoreView` method that `MessageStore`, `filterMessageStoreView`,
  `mergeMessageStoreViews` and the window a manager presents provide. It halts
  only where one isn't: a messages chain broken under chronicle before 0.5.0,
  or a store rebuilt under new ids. A store rebuilt in a fresh chronicle
  numbers its messages from 1 again, though, so its new messages can take
  the old ids, and the guard can't tell those from the records' own. A strategy that reads the store through a
  view without `onBranch` halts as before, and a read of the chain that fails
  halts that rebuild alone. The README's section on the
  autobiographical strategy names the states that hold message ids, for a
  store rebuilt under new ones.
- While the guard halts, no chunk, waiting or new, is sent to be
  summarized. Merges already queued still run and can queue the next level;
  only the open's merge check and the one after a drop wait, and the first
  tick after the guard clears runs them. `getCompressionDebt()` reads
  `critical` with `failure: 'chunk-records'`.
  Its `error` gives the cause and the first step, which changes nothing. The `FAIL-CLOSED` log line gives every step.
  `scripts/drain-autobiographical.ts` then stops before any step, with
  `stopped: 'chunk-records'`, and exits 1.
