- `getChannelCounts()` now reports the true unique message count per
  channel instead of summing the two channel-id metadata schemas'
  native index counts. A message that legitimately carries both
  `metadata.channelId` and `metadata.external.channelId` (a real shape
  produced by agent-framework's MCPL ingestion, which preserves an
  incoming `metadata.external` while also adding its own top-level
  `metadata.channelId`) was being counted twice.
