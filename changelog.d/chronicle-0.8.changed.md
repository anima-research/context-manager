- **Hosts:** context-manager accepts `@animalabs/chronicle`
  `^0.6.0 || ^0.7.0 || ^0.8.0` (was `^0.6.0 || ^0.7.0`), so a host whose own
  chronicle is 0.8.0 shares it with context-manager, where before
  context-manager installed its own 0.7 beside it. A manager that opens a
  store by its path then opens it with 0.8.0. A lockfile's 0.6 or 0.7 is still
  admitted. A host with no chronicle of its own now gets 0.8.0 on a fresh
  install, where it got 0.7, and opens its existing store with it: 0.8.0 opens
  and reads a store that 0.6 or 0.7 wrote. 0.8.0 adds saved length checks to
  `state.bin`, which 0.6 and 0.7 don't read, so a store that context-manager
  writes on 0.8.0 still opens on them, and opens again on 0.8.0 after it took
  writes there. chronicle 0.8.0's breaking changes reach a host through
  context-manager: an open fsyncs the log before it returns, and refuses a
  used store that has lost its log; a write first retries a failed fsync of
  the log; and a branch call whose checkpoint fails undoes its change. Their
  full notes are in
  [chronicle 0.8.0's release](https://github.com/anima-research/chronicle/releases/tag/v0.8.0).
  context-manager's code checks for none of the errors that these changes add
  or change, so none of its own handling depends on them.
- **Branch calls on chronicle 0.8.0:** when the store's switch throws in
  `switchBranch` or `fork`, the store stays on the branch that it was on
  before the call. When the store's branch creation throws in `derive`, `fork`
  or `branchAt`, no new branch is left behind. A `fork` whose switch throws
  keeps the branch that it created. With chronicle 0.6 or 0.7, the store can
  still hold the switch or the new branch after such a throw.
