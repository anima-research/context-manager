- **Strategy-view composition** (groundwork for tune-out,
  anima-research/agent-framework#77; all three inert until configured):
  `ContextManagerConfig.viewFilter` — strategy-facing exclusion applied at the
  single view choke point, so chunking, selection, emission, and the coverage
  invariants all see the same excluded-free world while the store and direct
  accessors keep everything; `ContextManagerConfig.auxiliaryMessageViews` —
  additional message slots merged read-only into the strategy view, interleaved
  by branch-global chronicle sequence (writes still target only the manager's
  own slot); standalone compositors `filterMessageStoreView` /
  `mergeMessageStoreViews` (#54).
- **`WindowedPassthroughStrategy`** — passthrough over a sequence-anchored
  window with coarse re-anchoring (jump to ~`reAnchorFraction` of budget on
  overflow, byte-stable prefix + appends between jumps, unlike a naively
  sliding front). Anchor persists in a `{ns}/windowed:anchor` snapshot slot and
  follows branches; `setAnchor()` is the external policy hook. Carries an
  optional `maxMessageTokens` so side-process agents mirror their principal's
  truncation ceiling (#54).
