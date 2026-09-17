- `queryByChannel`/`queryByTimeAndChannel`/`getChannelCounts`/
  `getChannelTokenStats` now index and merge BOTH channel-id metadata
  shapes: `metadata.channelId` (what agent-framework's real MCPL
  ingestion actually writes) and `metadata.external.channelId` (the
  pre-existing convention). 0.9.0 only indexed the latter, so these
  methods silently found nothing for real framework-ingested history.
