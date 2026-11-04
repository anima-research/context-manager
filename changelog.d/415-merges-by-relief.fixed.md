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
  against the chunk's messages as the last compile priced them to send
  (pruned, capped and stripped, a message a raw pin keeps raw at nothing)
  less the pair its L1 renders as, each new summary priced at the mean of
  the latest at its level. With the default `summaryTargetTokens` of 2,000
  and 3,000-token chunks, that is nearly always the merge. A merge whose
  last attempt was rejected, cut off or refused, or whose call failed, gives
  the lane to one L1 and then competes again, so a failure costs one L1's
  turn and not the rest of the backlog; `mergeAttemptLimit` still bounds a
  merge that keeps failing. A merge that waits on a hold or on the host's
  tools, or holds a source a hold or a merge-quarantine record keeps out,
  keeps its place behind the L1s, as does every merge under
  `scripts/drain-autobiographical.ts` except while its `maxSpeculativeL1s`
  cap holds. The same code paths run, in a different order, and only while
  both kinds of work are queued; a merge that lands before an L1 changes
  what that L1's request recalls.
- Each merge that lands logs `[autobiographical] L<n> merge landed over <k>
  summaries`, ending `, ahead of queued L1 work (relief | after a failed L1
  | speculative cap)` where it ran before queued L1 work, and a failed merge
  giving the lane to one L1 logs `[autobiographical] L<n> merge gives the
  lane to one L1 after …`, so a journal shows the merges and why each ran
  when it did.
