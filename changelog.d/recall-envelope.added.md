- **`recallEnvelope` — opt-in structural delimiting for recall answers.**
  A recall answer has never had an end delimiter: the Q-side label opens the
  memory and the turn boundary is all that closes it, and instances have been
  observed reading past the end of a recalled memory into unrelated content.
  With `recallEnvelope: 'xml'` every recall answer's prose is fenced by
  `<cm-recall id="…" level="…" span="…">` … `</cm-recall>`, on the presented
  window (both select paths) and on the mint/merge recall ladders alike.
  Attributes are sourced from the summary record and omitted when it cannot
  answer for one; content is never entity-escaped (the envelope is a
  collision-tolerant delimiter convention, not parseable XML); reasoning
  carriers are left byte-identical; Q-side labels are unchanged in both modes,
  so zero-recall surgery keys on exactly what it always did. The recall-pair
  budget prices each summary's actual envelope string. Under
  `maxMessageTokens` a capped answer is truncated as prose and enveloped
  afterwards, so opener and closer survive every cap. Default `'none'`
  renders byte-identically to before.
