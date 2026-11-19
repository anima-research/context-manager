- `ContextManagerConfig.compressionMembrane`: a membrane for memory-writing
  calls only (L1 compression, merges, the retries and fallbacks after a
  refusal, the carrier-transport fallback, transition summaries), so a host can
  send them to another provider or credential than `membrane`. Unset, they use
  `membrane` as before. Exposed to strategies as
  `StrategyContext.compressionMembrane`; the compression lane's pause is kept
  for the membrane the calls go to. `derive` inherits the parent's unless given
  a `membrane` of its own; `reopenDerived` takes one; `getCompressionMembrane()`
  reports it.
