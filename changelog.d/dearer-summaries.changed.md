- The hierarchical select weighs each summary's recall pair against all the
  messages it covers sent raw, messages a pin keeps raw included, at every
  level. Where the summary costs more, the select sends those messages in
  its place, and none of the summaries under it. The per-level summary
  budgets pick the summaries they picked before, and the share a replaced
  summary took goes to no other summary, so by the store's estimate the
  request carries fewer tokens wherever the select would have sent the
  summary, and a compile that would fit with them in the summary's place now
  fits. One case differs: where the select that leaves out the summaries
  over a window's messages didn't fit before, so the compile took them and
  sent those messages twice, the savings can now let it fit; it's then
  chosen, as it would be at a larger budget, and that request can be larger
  than before, though within the budget. A summary is left as it was where a
  summary under it isn't marked as merged into it, as in a merge a failed
  store write stopped part-way, until the next open repairs it; where a
  summary outside its own tree also holds one of its messages; where sending
  its messages raw would part a tool call from its result, would put any of
  them between a call and a result with its id in the order the request
  sends them, or would let a call sent before them take a result among them
  that answers another call; where a tool call or result among its messages
  is answered or answers in the head or the recent window; where, read in
  the parts pairing repair reads a message in, a tool call among its
  messages isn't answered in the part right after it, a result there doesn't
  answer a call in the part right before it, or two results there answer one
  call, which pairing repair would change if they went raw. Repair cuts a
  message holding a tool call and, after it, that call's result before and
  after that result, so the result answers its call inside the message, and
  a summary over such a message can be replaced. An L2 or L3 that costs more
  than its children as pairs but less than its messages raw goes out as
  before. So a message a pin keeps raw still goes out beside the summary
  over its chunk where that summary costs no more than all the chunk's
  messages; where it costs more, the summary can be left out and the chunk's
  other messages sent raw. A message is priced at the larger of its stored
  and sent forms, so a summary that costs less than its messages whole isn't
  swapped for messages whose tool results pruning replaces; one that costs
  more than them whole can be, and the replaced results go out as pruning's
  markers. The pair is priced at its estimate as it is sent, cut by
  `maxMessageTokens` where the cut applies; emission charges a summary with
  a measured size at that size where it's larger, which only makes a
  replaced summary dearer still. So the choice reads no budget, and the
  calibration multiplier moves it only by rounding, where `maxMessageTokens`
  cuts the summary or a message, and through the recent window, which the
  multiplier moves for the whole select. The adaptive selects and
  `positionedRecallPairs: false` are unchanged. A store where the select now
  replaces a summary it would have sent sends different requests from its
  first compile after the upgrade.
- Where the hierarchical select now sends an L1's messages raw in its
  place, an over-budget refusal from it doesn't name `compression` in
  `clearedBy` for adopting that L1 as a queued chunk's exact L1: the select
  sends those messages raw whether or not the L1 is adopted, so adopting it
  frees nothing.
