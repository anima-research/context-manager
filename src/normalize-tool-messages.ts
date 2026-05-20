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

/**
 * Strip `tool_use` blocks whose IDs have no matching `tool_result` anywhere
 * in the message list, and `tool_result` blocks whose IDs have no matching
 * `tool_use`. If stripping leaves a message with no blocks, replace its
 * content with a placeholder text block so the message stays structurally
 * valid (collapse/rendering paths assume non-empty content).
 *
 * Why this exists: the Anthropic API requires every `tool_use` to be
 * followed by its `tool_result` in the immediately-next message (and every
 * `tool_result` to follow its `tool_use`). Two ways this becomes a problem
 * in compression:
 *
 *   - chunk boundaries: the chunker can cut a cycle, leaving a `tool_use`
 *     at the tail of chunk N and its `tool_result` at the head of N+1.
 *     `rebuildChunks` defers closing on a `tool_use` to avoid this, but
 *     can't help when the `tool_use` is the very last message in the
 *     store (no next message to ride along).
 *   - any future call site that builds a request from raw messages without
 *     also handling cycle pairing.
 *
 * The placeholder is intentionally generic ("[tool call omitted]") rather
 * than naming a specific cause: this function fires for the chunk-boundary
 * case AND the very-last-message case AND any future not-yet-anticipated
 * source of unpaired blocks. Anything more specific would mislead the
 * debugger reading the compressed conversation later.
 */
export function stripUnpairedToolBlocks<T extends { participant: string; content: ContentBlock[] }>(
  messages: readonly T[],
): Array<{ participant: string; content: ContentBlock[] }> {
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') useIds.add((block as { id: string }).id);
      else if (block.type === 'tool_result') {
        resultIds.add((block as { toolUseId: string }).toolUseId);
      }
    }
  }
  return messages.map((msg) => {
    const trimmed = msg.content.filter((block) => {
      if (block.type === 'tool_use') {
        return resultIds.has((block as { id: string }).id);
      }
      if (block.type === 'tool_result') {
        return useIds.has((block as { toolUseId: string }).toolUseId);
      }
      return true;
    });
    if (trimmed.length === msg.content.length) {
      return { participant: msg.participant, content: msg.content };
    }
    return {
      participant: msg.participant,
      content: trimmed.length > 0
        ? trimmed
        : [{ type: 'text', text: '[tool call omitted]' }],
    };
  });
}
