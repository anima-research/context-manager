/**
 * A resident's settings as offline tooling reads them: its strategy options
 * from a recipe's `agent.strategy`, and its tool definitions from a log of
 * its requests. Shared by drain-autobiographical and external-memory.
 */

import type { ToolDefinition } from '@animalabs/membrane';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

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
] as const;

/** The strategy options of a resident with this recipe strategy, model and participant. */
export function residentStrategyOptions(
  recipeStrategy: Record<string, unknown>,
  model: string,
  participant: string,
): Record<string, unknown> {
  const recipeOptions: Record<string, unknown> = {};
  for (const key of passthroughKeys) {
    if (recipeStrategy[key] !== undefined) recipeOptions[key] = recipeStrategy[key];
  }
  return {
    ...recipeOptions,
    adaptiveResolution: true,
    hierarchical: true,
    speculativeProduction: recipeStrategy.speculativeProduction !== false,
    autoTickOnNewMessage: false,
    headWindowTokens: Number(recipeStrategy.headWindowTokens ?? 4_000),
    recentWindowTokens: Number(recipeStrategy.recentWindowTokens ?? 100_000),
    maxMessageTokens: Number(recipeStrategy.maxMessageTokens ?? 10_000),
    mergeThreshold: Number(recipeStrategy.mergeThreshold ?? 6),
    maxSpeculativeL1s: Number(recipeStrategy.maxSpeculativeL1s ?? 36),
    compressionModel: model,
    summaryParticipant: participant,
    enforceBudget: true,
  };
}

/** The tool definitions of the last streamed request in a log of a resident's requests. */
export function latestToolsFromAnthropicLog(path: string): ToolDefinition[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let bytes = 4 * 1024 * 1024; bytes <= 64 * 1024 * 1024; bytes *= 2) {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      if (size > length) lines.shift(); // discard a partial first record
      for (let index = lines.length - 1; index >= 0; index--) {
        let row: {
          type?: unknown;
          kind?: unknown;
          rawRequest?: { tools?: unknown };
        };
        try { row = JSON.parse(lines[index]!); } catch { continue; }
        if (row.type !== 'call' || row.kind !== 'stream' || !Array.isArray(row.rawRequest?.tools)) {
          continue;
        }
        const normalized: ToolDefinition[] = [];
        for (const candidate of row.rawRequest.tools) {
          if (!candidate || typeof candidate !== 'object') continue;
          const raw = candidate as {
            name?: unknown;
            description?: unknown;
            input_schema?: unknown;
          };
          if (
            typeof raw.name !== 'string' ||
            typeof raw.description !== 'string' ||
            !raw.input_schema ||
            typeof raw.input_schema !== 'object'
          ) continue;
          normalized.push({
            name: raw.name,
            description: raw.description,
            inputSchema: raw.input_schema as ToolDefinition['inputSchema'],
          });
        }
        if (normalized.length > 0) return normalized;
      }
      if (length === size) break;
    }
  } finally {
    closeSync(fd);
  }
  throw new Error(`no stream-call tool definition found in the last 64 MiB of ${path}`);
}
