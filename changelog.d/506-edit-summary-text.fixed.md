- `editSummaryText` writes each entry that carries the edited summary up a
  level again, as its copy (text, tokens, `external`, no response blocks),
  in the same write as the summary, so that the two never part. In 0.29.0
  each carrier kept the old text. Before it writes, the edit checks the
  stored summaries and chunk records against the ones that the strategy
  holds. After another handle's write, or where that read fails, the edit is
  refused, dry or not. A write that throws says whether it landed, as the
  store reads back, and the strategy then holds what the store holds. Where
  the read back fails, the strategy refuses work until it is initialized
  again. An edit clears the strategy's memo of recall-answer prices, and so
  does taking up summaries from the store.
