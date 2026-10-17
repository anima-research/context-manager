- **Strategy authors:** `AutobiographicalStrategy`'s protected
  `summaryAnswerContentCapped` and `combinedRecallAnswerContent` are removed.
  Since 0.15.0, compiles render the live window's recall answers through
  `renderSummaryAnswer` and `renderCombinedRecallAnswer`, so neither has
  changed what a compile sends. A subclass that calls either, or overrides
  one with the `override` keyword, stops compiling. A plain override still
  compiles and still does nothing, so remove it. A call becomes
  `renderSummaryAnswer(summary, maxTokens).content` or
  `renderCombinedRecallAnswer(summaries, maxTokens).content`. To change what
  a live-window recall answer says, override `liveWindowAnswerProse`, which
  both render methods and the budget's pricing read; overriding only a
  render method changes what is sent but not what is priced. The render
  methods, which return the layout's references with the content, are where
  to change how the cap cuts an answer. The recall pairs in merge and
  compression requests render through `summaryAnswerContent`, as before.
  Unchanged: what compiles render.
