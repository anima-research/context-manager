- Label adaptive floor warnings as dry or live and deduplicate the two lanes
  independently, including when a warning handler calls `renderAsNewest`
  or `previewContext`.
  Each lane retains up to 64 fixed-size keys in FIFO order and clears only
  its own keys on recovery. An evicted cause can warn again. Normalization
  (including of changing UUIDs) affects only the keys, not the logged cause.
- Shadow production warnings report the selected plan's token count, that
  no production was requested, and whether the plan exceeds the shadow
  rejection bound. They identify the provisional multiplier used for that
  attempt, without predicting a live refusal stage or claiming no other
  cut can fit. Selection behavior is unchanged.
