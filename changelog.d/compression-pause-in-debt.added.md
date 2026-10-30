- `getCompressionDebt()` reports `compressionPause`, the compression lane's pause on the configured
  compression model: `null` when none binds, otherwise `{ until, model }`. `until` is when the lane
  will try again by itself, in milliseconds since the Unix epoch: the later of its own backoff and
  the wait it was given, a provider's stated wait after a failed call, or after a deferral by the
  caller's provider admission, how long it keeps that answer before asking again (at most 30 s,
  less if the admission's deadline comes first). It's `null` only for a provider's stated wait that
  can't be held as an instant, which holds until a restart, `releaseCompressionPause()`, or a change
  of membrane or model once a tick sees it. `model` is the model the pause holds, or `null` when no
  compression model is configured, so a host can look up its own hold on that model beside it. A
  report that failed outright carries it too, and `state` is decided as before.
