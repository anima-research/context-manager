- **Hosts:** context-manager accepts `@animalabs/membrane`
  `^0.8.0 || ^0.9.0 || ^0.10.0` (was `^0.8.0 || ^0.9.0`), so a host whose
  own membrane is 0.10.0 shares it with context-manager, where before
  context-manager installed its own 0.9.0 beside it. A lockfile's 0.8.0 or
  0.9.0 is still admitted. membrane 0.10.0 is the release whose system
  changes carry `effort`, which an effort-only system change needs to reach
  the model; membrane 0.9.0 leaves such a block out as empty. membrane's
  changelog for 0.10.0 lists its other changes.
