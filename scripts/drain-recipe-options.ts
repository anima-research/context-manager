/** Internal recipe forwarding for the drain; constructor validates forwarded options. */
export function drainRecipeOptions(recipeStrategy: Record<string, unknown>): Record<string, unknown> {
  const passthroughKeys = [
    'compressionMaxTokens',
    'compressionRefusalCurveFallbacks',
    'compressionContextBudgetTokens',
    'compressionSourceOnly',
    'compressionSourceOnlyFallback',
    'compressionMergeSourceOnly',
    'compressionMergeSourceOnlyFallback',
    'compressionToolProseFallback',
    'compressionSplitFallback',
    'compressionSplitPlaceholder',
    'compressionSplitMaxCallsPerChunk',
    'compressionSplitMaxCallsPer10Min',
    'compressionRecallBudgetTokens',
    'recoverLiteralThinkingWrappedCompression',
    'mergeHoldSummaryIds',
    'mergeMaxSourceSpanMessages',
    'l1HoldbackChunks',
    'summaryTargetTokens',
    'identityReminder',
    'witnessedIdentityReminder',
    'witnessedBeforeSequence',
    'witnessedInstruction',
    'compressionInstructions',
  ] as const;
  const recipeOptions: Record<string, unknown> = {};
  for (const key of passthroughKeys) {
    if (recipeStrategy[key] !== undefined) recipeOptions[key] = recipeStrategy[key];
  }
  return recipeOptions;
}
