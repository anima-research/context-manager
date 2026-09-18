- `TimeRangeSummaryEntry` (from `getSummariesInRange`) now also exposes
  `firstMessageId`/`lastMessageId`/`firstSequence`/`lastSequence` — exact,
  tie-free identity/order boundaries for the covered span, alongside the
  existing millisecond `startMs`/`endMs`. Wall-clock timestamps aren't
  unique (two distinct messages can share a millisecond under rapid-fire
  appends); chronicle's per-record `sequence` is strictly monotonic and
  never ties, so a consumer doing fine-grained boundary work (e.g. a
  downstream "overview" tool distinguishing which of several
  same-millisecond messages actually belongs to a given summary) has an
  exact way to do it.
