import type { ContentBlock } from '@animalabs/membrane';

/**
 * Anthropic-API shape requires `tool_use` blocks in assistant turns and
 * `tool_result` blocks in user turns, with each tool_result in the message
 * *immediately following* its tool_use. claude.ai exports bundle the entire
 * tool cycle into a single assistant message, and any downstream consumer
 * that ferries those messages through unchanged hits a 400.
 *
 * This helper walks a list of messages and, for every non-user message
 * containing one or more `tool_result` blocks, splits it so:
 *
 *   - blocks before the first tool_result stay under the original participant
 *   - each run of consecutive tool_results becomes its own `user` message
 *   - blocks after the tool_results go back to the original participant
 *
 * Messages that are already user-side or that don't contain tool_results
 * pass through unchanged. The participant-name check is case-insensitive
 * (matching the convention used elsewhere in CM) so it works regardless
 * of whether the session uses 'user', 'User', or some custom label.
 *
 * Called by:
 *   - `ContextManager.compile()` — live session path, prevents the
 *     bundled-cycle 400 for already-imported sessions.
 *   - `AutobiographicalStrategy.compressChunkHierarchical()` — defense in
 *     depth at the compression LLM call site.
 *   - `AutobiographicalStrategy.executeMerge()` — same, at the merge call site.
 *
 * For new imports, conhost's `scripts/import-claudeai-export.ts` already
 * splits at ingest time so Chronicle stores hold API-shape messages. This
 * runtime pass handles legacy sessions imported before that fix landed,
 * and acts as a safety net for any future bundling source.
 */
export function splitMixedToolMessages<T extends { participant: string; content: ContentBlock[] }>(
  messages: readonly T[],
): Array<{ participant: string; content: ContentBlock[] }> {
  const out: Array<{ participant: string; content: ContentBlock[] }> = [];
  for (const msg of messages) {
    const isUser = msg.participant.toLowerCase() === 'user';
    if (isUser || !msg.content.some((b) => b.type === 'tool_result')) {
      out.push({ participant: msg.participant, content: msg.content });
      continue;
    }
    let preTool: ContentBlock[] = [];
    let pendingResults: ContentBlock[] = [];
    const flushPre = () => {
      if (preTool.length > 0) {
        out.push({ participant: msg.participant, content: preTool });
        preTool = [];
      }
    };
    const flushResults = () => {
      if (pendingResults.length > 0) {
        out.push({ participant: 'user', content: pendingResults });
        pendingResults = [];
      }
    };
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        flushPre();
        pendingResults.push(block);
      } else {
        flushResults();
        preTool.push(block);
      }
    }
    flushResults();
    flushPre();
  }
  return out;
}
