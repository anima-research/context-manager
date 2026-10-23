- `reportRealInputTokens(realTotal, overhead?)` takes what the request sent
  besides the window, `{ system, tools }` (`RequestOverhead`), and prices it
  into the estimate the provider's total is compared with (#323). The
  provider counts the system prompt and the tool schemas and the compile
  estimate doesn't, so a tool-heavy agent's multiplier learned its schemas
  as a per-token rate and folded history the budget had room for, or sat at
  1.00 rejecting every sample as out of band. A caller that passes nothing
  gets the old comparison.
- With the overhead declared, three out-of-band calibration samples in a row
  whose implied multipliers agree within 10% are learned, outright, at the
  clamp edge, instead of being rejected for good. At 1.00 the ratio and the
  implied multiplier are the same number, so a store whose true ratio was
  past 1.8, where every pricing-epoch discard restarts, could never learn.
  Undeclared samples are rejected as before, and the rejection line says the
  caller may be leaving out the system prompt and tools it sends.
- **Host operators:** a multiplier learned before the caller declared its
  overhead holds that overhead, and steps back down over about ten compiles
  once samples declare it. To relearn in one sample, seed it as provisional
  on the stopped store: `setStateJson('<ns>/autobio:calibration',
  { multiplier, at, pricing, provisional: true })`.
