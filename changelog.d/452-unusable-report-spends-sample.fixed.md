- `AutobiographicalStrategy.reportRealInputTokens` now spends the compile's
  one calibration sample on a report whose total is 0, negative, NaN or
  infinite, and learns nothing from it. Before, such a report left the
  sample to the next report, which comes from a later call built on the
  same compile, whose request the turn's tool rounds and continuations have
  grown since. That sample compared the grown request with the compile's
  estimate, the comparison one sample per compile exists to prevent. The
  next compile still takes its own sample.
