- Under adaptive resolution, `AutobiographicalStrategy`'s queued merges no
  longer wait behind every queued L1 (#412, #415). `tick()` runs one
  compression at a time and ran each queued chunk's L1 before any merge, so
  an agent closing chunks as fast as calls completed, such as one reading a
  document a tool result at a time, kept a chunk queued at every tick and no
  merge ran for as long as it read: the pyramid stopped deepening, unmerged
  L1s filled the middle, and compiles refused at their deepest available
  level until the agent went idle. Now the merge at the head of the queue
  goes first when it would take more off the plan's floor than the next
  chunk's L1: its sources' recall pairs less the one its parent renders as,
  against the chunk's raw tokens less the pair its L1 renders as, each new
  summary priced at the mean of the latest at its level. With the default
  `summaryTargetTokens` of 2,000 and 3,000-token chunks, that is nearly
  always the merge. A merge that has failed or been refused before, or
  waits on a hold or on the host's tools, keeps its place behind the L1s,
  as does every merge under `scripts/drain-autobiographical.ts`. The calls made are the same; only
  their order changes, and only while both kinds of work are queued.
