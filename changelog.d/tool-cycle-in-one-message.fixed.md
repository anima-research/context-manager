- `AutobiographicalStrategy` and `KnowledgeStrategy` send a message that holds
  a tool call and, after it in its own content, that call's result, with that
  result, on the hierarchical and adaptive selects alike. Pairing repair
  (`enforceToolPairing`) judged each message whole, so it dropped such a
  result as answering no call before it and sent a stub for the call: a
  message the compile's split (`splitMixedToolMessages`, which `compile()`
  runs on every message) or membrane's normalizer would have sent with its
  results lost them in every compile. The repair now judges such a message in
  parts, each run of results that answers a call earlier in its own content,
  one no result there has answered yet, as one part and what follows it as
  another, and folds the parts back into the one message, so a result answers
  its call in its own message; a call its own results don't answer is answered
  as pairing repair answers any call: by its result moved up where the
  look-ahead finds one, else by a stub. This holds for a user message of that
  shape too, which membrane's normalizer re-roles. A compile holding no such
  message is repaired exactly as before. Compile provenance now reports such a
  message carried whole (`complete: true`) where nothing else alters it; it
  reported it incomplete, missing `content`.
- `toolResultMaxLastN` counts such a result as answering its call: a result
  answers the earliest call with its id before it, in its own message or an
  earlier one, that no result has answered yet. It answered none before, so it
  was never replaced, and in a store holding one, an older result of the same
  tool that was sent whole can now get its marker.
- The calibration's pricing epoch is 6, after the generated images' 5. The
  plan and the render stats priced such a message with its results while the
  request carried stubs, so a store holding one learned a multiplier low
  enough to make up for results it didn't send. In a store holding a message
  with a tool result that answers a tool call before it in its own content, a
  multiplier learned under an earlier pricing epoch, or with no stamp, is
  discarded at load: it restarts from a provisional 1, which the first
  provider sample within the calibration's band replaces. In any other store a
  multiplier is kept or discarded as before, so one stamped with epoch 5 is
  kept and re-stamped.
- A store holding such a message sends different requests after the upgrade,
  so its first request misses the prompt cache, and its window can move again
  when the first accepted sample replaces its provisional multiplier. Every
  other store sends what it sent.
