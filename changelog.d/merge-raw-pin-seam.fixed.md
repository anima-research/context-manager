- No merge groups summaries across a message no chunk owns: a raw pin, a
  message an unpin freed before the chunker reached it, or a head window that
  `resetHeadWindow` left mid-stream. The merge grammar placed only
  chunk-owned messages, so the summaries on either side of such a message
  read as adjacent and merged into one summary that held history from both
  sides of a message rendered between them. Under kv-unified with neither
  `treeifyNonContiguousSummaries` nor `preserveGapBearingSummaries`, every
  compile then threw `CanonicalForestError` ("owns non-contiguous live
  leaves"): in probes, about 30 turns after a raw pin or a head-window reset,
  and after an unpin that came while a compression call was in flight. Every
  listed message now takes a merge position, so runs merge on each side of
  it. The load-time topology audit judges ownership as before, so a store
  holding a summary already minted across such a message loads as it did,
  and keeps that summary. Under kv-unified with neither option, such a
  store's compiles still throw until it treeifies or preserves gap-bearing
  summaries, as #96's recovery did.
