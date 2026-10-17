- `moves`, in the `[plan-vs-actual]` line, `planVsActual` and a preview's
  result, now counts the chunks whose saved fold level the compile changes,
  which are the levels it commits (#195). A dry run counts the levels it
  would commit, and a preview counts the levels its layout changes, whether
  or not the layout fits. It was the picker's count, of chunks whose solved
  level differs from the level they were planned from, and the two differ in
  two cases. A classic pin renders a locked chunk at another level while the
  commit keeps the locked one, so that chunk counted as a move on every
  compile for as long as the pin stood. A chunk whose saved level's summary
  is gone is planned from the level its summaries still reach, so the
  compile that saves that level didn't count it. A `moves=` histogram loses
  the first and gains the second. `PickerResult.moves` is unchanged.
