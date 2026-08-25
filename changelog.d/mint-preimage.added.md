- Mint request preimages are now persisted by default, so
  `provenance.requestHash` is readable and not merely verifiable. The field's
  contract said the hash "keys the exact request in the llm-calls log" — a log
  this library never wrote: the only library-owned log is the JSONL telemetry
  behind `CONTEXT_MANAGER_COMPRESSION_LOG`, off unless a host sets it, and the
  `llm-calls` files are host-harness artifacts. On every accepted L1 and merge
  mint the authoring request is now stored as a blob in the same Chronicle
  store as the summary; because chronicle keys blobs by sha256 of their bytes —
  the same digest `requestHash` already is — the preimage lands under the hash
  the summary carries, deduplicated across retries, with no new format and no
  new filesystem convention. Read it with `getMintRequestByHash(store, hash)`
  or `getMintRequestPreimageBytes(store, hash)` (new public exports). Refused
  and quarantined attempts are not mints and are not stored. Preimages are
  persisted best-effort: a store failure never blocks the mint and leaves no
  preimage, so a reader gets null — alongside the two other absence causes,
  pre-feature mints and `persistMintPreimages: false`. The hash on the entry
  stays verifiable either way. New option: `persistMintPreimages` (default
  `true`) for hosts that keep their own durable request log or accept
  unreadable provenance — mint requests are large.
- `provenance.requestHash` now identifies the request the transport actually
