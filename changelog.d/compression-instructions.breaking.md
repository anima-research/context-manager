- **Strategy subclass authors:** `AutobiographicalStrategy` reserves two new
  protected hook names, `getCompressionOpening` and
  `getSourceMergeInstruction`; rename any member of your own with one of
  these names before upgrading. Overrides now receive optional arguments the
  base class always passes on their paths: `getMergeInstruction` and
  `getReadingMergeInstruction` the shown source level as a final argument,
  and, when building the canonical L1 request, `separateRecallAnswers` a
  second `recallHeadersEnd` and `applyMintCacheSeams` a fourth
  `recallPairsEnd`. An override of either of the last two that calls `super`
  without the bound reads recall pairs through the whole request, as before.
