- `provenance.requestHash` now identifies the request the transport actually
  ACCEPTED. In the carrier-transport degraded path both mint sites sent a
  reasoning-stripped copy of the request but hashed and persisted the
  original, so a summary authored by the stripped retry carried the hash of
  bytes the model never read: `sha256(preimage) === requestHash` verified
  green while the stored request was not the authoring one. L1 attempts and
  merges now hash, map and persist the accepted bytes.
