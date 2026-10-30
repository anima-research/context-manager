- `getCompressionDebt()` reports `compressionPause`, the compression lane's pause on the configured
  compression model: `null` when none binds, otherwise `{ until }`, the instant the lane may call
  again, or `until: null` when the pause holds until a restart, a change of membrane or model, or
  `releaseCompressionPause()` (a provider's stated wait that can't be held as an instant). A host can
  tell a pause that ends by itself from one that needs someone without reading `checkReadiness()`'s
  description. A report that failed outright carries it too, and `state` is decided as before.
