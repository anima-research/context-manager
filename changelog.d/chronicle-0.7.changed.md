- **Hosts:** context-manager accepts `@animalabs/chronicle`
  `^0.6.0 || ^0.7.0` (was `^0.6.0`), so a host whose own chronicle is 0.7.0
  shares it with context-manager, where before context-manager installed its
  own 0.6.0 beside it. A lockfile's 0.6.0 is still admitted. chronicle
  0.7.0's notes say what its breaking changes ask of a host.
  context-manager's own code stores no chunked blob, checks no chronicle
  error's `code`, and matches none of the messages those changes rename.
