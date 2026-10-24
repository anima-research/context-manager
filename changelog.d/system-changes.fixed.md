- A summarizer request no longer carries an empty turn, or a `---` separator
  with nothing after it, where a message left empty for it sat, as one of
  thinking alone was: merging consecutive messages passes over an empty one,
  and its neighbours join as they would without it.
- With the head window disabled (`headWindowTokens: 0`), a compile after
  `resetHeadWindow` under `adaptiveResolution` no longer sends history from
  before the reset twice, and under kv-unified no longer throws
  `CanonicalForestError` (`duplicate-chunk-id`) for it: the middle's ranges
  overlapped each other, and the recent window when it starts before the
  reset.
- A `WindowedPassthroughStrategy` compile that refuses no longer moves the
  window's anchor; only a compile that sends does. So a retry with a larger
  budget still sends the older turns that fit.
- A `KnowledgeStrategy` chunk no longer runs into or across an L1 summary's
  span once a removal moves where its walk closes, which left the chunk after
  it uncompressed for good and its messages sent raw beside the summary: a
  chunk now closes where the L1 summary covering its messages changes, except
  between a call and the result right after it.
