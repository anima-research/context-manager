- `MessageStore`/`ContextManager` gain `queryByTime`/`queryByChannel`/
  `queryByTimeAndChannel`/`getChannelCounts`/`getChannelTokenStats`
  (`queryMessagesBy*`/`getChannelMessageCounts`/`getChannelTokenStats` on
  `ContextManager`), backed by chronicle's new native `/timestamp` and
  `/metadata/external/channelId` secondary field indexes (#99). O(log n + k)
  against the index, not a full-store scan; requires chronicle >= the
  version that ships `registerStateFieldIndex` — degrades to a clear error
  on an older chronicle build rather than a silent full scan.
