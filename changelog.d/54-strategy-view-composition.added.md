- **Strategy-view composition** (groundwork for tune-out,
  anima-research/agent-framework#77; all three inert until configured):
  `ContextManagerConfig.viewFilter` — strategy-facing exclusion applied at the
  single view choke point, so chunking, selection, emission, and the coverage
  invariants all see the same excluded-free world while the store and direct
  accessors keep everything (documented as non-retroactive over persisted
  summaries and not a confidentiality boundary — excise by branching);
  `ContextManagerConfig.auxiliaryMessageViews` — additional message slots
  merged read-only into the strategy view, interleaved by branch-global
  chronicle sequence (writes still target only the manager's own slot; an
  entry naming the manager's own slot is refused, repeats merge once);
  standalone compositors `filterMessageStoreView` / `mergeMessageStoreViews`
  (#54).
- **`WindowedPassthroughStrategy`** — passthrough over a sequence-anchored
  window with coarse re-anchoring (jump to ~`reAnchorFraction` of budget on
  overflow, byte-stable prefix + appends between jumps, unlike a naively
  sliding front). The anchor persists in a `{ns}/windowed:anchor` snapshot
  slot, follows branches, and is re-derived whenever the store's branch is
  observed to change (host undo/redo included); `setAnchor()` is the external
  policy hook. Places ≤ 2 message-level cache markers (measured stable prefix
  + end) under the shared ≤ 3 first-claim contract. Applies `maxMessageTokens`
  truncation and the autobiographical live-image policy (`maxLiveImages`,
  `imageStripDepthTokens`, `maxLiveImageBytes`) itself, and refuses with
  `OverBudgetError` when the newest message alone exceeds the usable budget
  (#54).
