- `editSummaryText` writes each entry that carries the edited summary up a
  level again, as its copy (text, tokens, `external`, no response blocks),
  in the same write as the summary, so that the two never part. In 0.29.0
  each carrier kept the old text. The edit is refused, dry or not, before
  anything is written, where the stored summaries or chunk records can't be
  shown to be as the strategy holds them: after another handle's write, or
  where reading them fails. A write that throws says whether it landed, as
  the store reads back, and the strategy then holds what the store holds.
  Where the read back fails, the strategy refuses work until it is
  initialized again. The memo of recall-answer prices is cleared after an
  edit, and when the strategy takes up summaries from the store.
