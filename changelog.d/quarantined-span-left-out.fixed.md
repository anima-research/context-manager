- `AutobiographicalStrategy` no longer sends the messages of a chunk the
  compression quarantine holds in the requests that compress the chunks after
  it, or in merges over them. Those requests could carry the held chunk,
  which stays raw: between the head window and the chunk or merge range (the
  raw middle), and in the head window itself where the head had grown over
  the chunk. Where the summarizer had refused the held chunk for its content,
  it could refuse those requests too, and the recall-curve retries reuse the
  rest of the request, so unless `compressionSourceOnlyFallback` was on, the
  chunks after it could be quarantined in turn and stay raw. Those requests
  now leave the held chunk's messages out, as they already left out what a
  summary covers, including after a host removes one of its messages. A
  store whose quarantine holds no chunk sends the same requests as before.
  Once the quarantine no longer holds the chunk, as after
  `clearCompressionRefusalQuarantine()`, the requests after it no longer
  leave its messages out.
- A chunk quarantined because its request carried a held chunk now has a
  request of another shape, so its next compression is a fresh attempt,
  unless the quarantine already holds that request or its family, or the
  chunk has reached
  `AutobiographicalStrategy.CHUNK_QUARANTINE_SHAPE_CAP` quarantined shapes in
  its request regime.
- Once the chunks after a held chunk compress, merges can change the held
  chunk's own request, so it is tried again in each new shape, up to
  `CHUNK_QUARANTINE_SHAPE_CAP` (3) shapes in its request regime, after which
  it is held whatever its request. Each new shape the summarizer refuses
  costs its refused call, plus any fallback calls the ladder makes after it.
- A held chunk a host has removed a message from is a new chunk to tick, as
  it was before this change: its refusals are recorded under the messages it
  has left, which the paid-off sweep can clear as orphaned, so its own
  retries can go past the cap. It is tried again each time it is queued
  again, after each new message and at each reopen, as in 0.24.2, and
  each try the summarizer refuses costs its refused call, plus any
  fallback calls the ladder makes after it.
