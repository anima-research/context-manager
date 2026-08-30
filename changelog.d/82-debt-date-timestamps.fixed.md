- `getCompressionDebt()` accepts `Date` message timestamps (the live
  `StoredMessage` shape) when deriving `oldestPendingAgeMs`; the number-only
  filter had made the degraded(>1h)/critical(>6h) staleness ladder
  unreachable in production (#82).
