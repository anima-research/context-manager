- Mint request preimages can now be persisted, so
  `provenance.requestHash` is readable and not merely verifiable. With the
  option on, every accepted L1 and merge mint stores its authoring request in
  the same Chronicle store as the summary, retrievable by the hash the summary
  already carries. Read it with `getMintRequestByHash(store, hash)` or
  `getMintRequestPreimageBytes(store, hash)`. Refused and quarantined attempts
  are not mints and are not stored.
- New option: `persistMintPreimages`, **opt-in, default `false`**. Absent
  config means off — only an explicit `true` enables it. Preimage text is real
  growth at mint cadence, and this library ships no retention knob for it yet,
  so a fleet that deploys from a checkout would otherwise have every resident
  begin writing preimages on the next pull. Turning it on is a deliberate act,
  taken with an eye on store size.
- Inline media is stored by reference, not re-embedded. Media-bearing
  preimages store the request JSON as an envelope of literal spans and
  content-addressed media blob references. Media already extracted by
  `MessageStore` reuses its existing blob; other inline media is stored once.
  Reads restore the exact original base64 spelling and verify the materialized
  bytes against `requestHash`. Text-only preimages remain plain request blobs,
  and a damaged envelope raises `MintPreimageMaterializationError`.
- Preimages are persisted best-effort: a store failure never blocks the mint
  and leaves no preimage, so a reader gets null — alongside pre-feature mints
  and persistence left off. The hash on the entry stays verifiable either way.
