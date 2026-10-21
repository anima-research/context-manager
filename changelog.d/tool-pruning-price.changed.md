- `toolResultMaxLastN` counts each tool's answered calls over the whole
  conversation, where it counted only the results a compile rendered raw. So
  a raw result with N newer answered calls of its tool, fewer than N of their
  results sent raw and the rest folded into summaries or not sent at all, is
  now replaced, where it rendered whole until enough of them were sent.
  Folding never brings a replaced result back, so a fold no longer changes
  the request before it.
  - A result answers the earliest call with its id, in an earlier message,
    that no result has answered yet, and a further result for an answered
    call goes with that call. Calls are ordered by the message that made
    them, and calls made in one message by where their results are stored,
    which is the order the render sends them in, except where pairing
    repair moves the batch's results: it sends those first, in call order.
    It moves them when a recall pair or pin comes between the calls and
    their results, and moves the part of a batch stored in a later message.
  - A per-tool limit that isn't a number of 0 or more, such as null, sets no
    limit. `main` read a value that isn't a number by arithmetic: a null
    replaced every result of its tool, a string such as "2" all but two, and
    true all but one. A null for every tool, which threw, sets no limit too.
  - The marker's text is unchanged. In a message the cap
    (`maxMessageTokens`) still cuts after the replacement, the cap can cut
    or omit the marker as it would any result.
  - Where the limit replaces a result or `toolUseInputMaxTokens` truncates an
    input, a compile's window is priced as sent. That's lower, except where a
    marker, or a truncated input's summary of itself, is longer than what it
    replaces. At the upgrade, a store's render can change once (its window
    holds more, and a result whose newer results are folded becomes its
    marker), and its prompt cache is written again from the first change on.
