- **Hosts:** context-manager accepts `@animalabs/chronicle`
  `^0.6.0 || ^0.7.0` (was `^0.6.0`), so a host whose own chronicle is 0.7.0
  shares it with context-manager, where before context-manager installed its
  own 0.6.0 beside it. A lockfile's 0.6.0 is still admitted. A host with no
  chronicle of its own now gets 0.7.0 on a fresh install, where it got
  0.6.0, and opens its existing store with it: 0.7.0 opens and reads a store
  0.6.0 wrote, and context-manager stores no chunked blob, so a store it
  writes on 0.7.0 still opens on 0.6.0. chronicle 0.7.0's notes say what its
  breaking changes ask of a host. context-manager's own code checks no
  chronicle error's `code`, and matches none of the messages those changes
  rename.
