- Optional compression-hold timeouts: `holdCompression(ids, { timeoutMs })`
  and `addMessage(..., { holdCompression: { timeoutMs } })`. A timed hold is
  released automatically once expired — checked lazily on `tick()`,
  `compile()` and hold queries (no timers) — through the same path as
  `releaseCompression` (strategy notified), with a warning naming the ids
  and how long they were held. Re-holding an id replaces its hold (timeout
  restarts; re-holding without `timeoutMs` makes it indefinite).
  `getCompressionHoldDetails()` reports `heldAt`/`expiresAt` per hold; the
  manager clock is injectable via `ContextManager.open({ now })`. Holds
  without a timeout behave exactly as before.
  Deadlines are per message id; one call or one sharded `addMessage` reads
  the clock once, so its ids share a deadline, and expiry releases only the
  ids past their own deadline (never the rest of a shard group). Expiry is
  also checked on `addMessage`.
