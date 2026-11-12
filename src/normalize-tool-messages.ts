import type { ContentBlock } from '@animalabs/membrane';
import { releaseEditedRawForms } from './raw-forms.js';

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
 * Which call each tool result answers, for blocks in send order. A result
 * answers the nearest call before it with its id. So a call is answered only
 * by results that come before the next call with its id, and a result with no
 * call before it with its id answers none. Ids can repeat: a provider that
 * leaves a streamed call's id out can mint the same id in every response.
 *
 * Returns, for each block, the index of the call it answers, or undefined for
 * a call, a result that answers none, and any other block. The count of
 * answered calls, this module's strip and pairing repair's look-ahead all
 * pair by it.
 */
export function answeredCallIndexes(blocks: readonly ContentBlock[]): Array<number | undefined> {
  const latest = new Map<string, number>();
  return blocks.map((block, i) => {
    if (block.type === 'tool_use') {
      latest.set((block as { id: string }).id, i);
      return undefined;
    }
    return block.type === 'tool_result' ? latest.get((block as { toolUseId: string }).toolUseId) : undefined;
  });
}

/**
 * Where a window over these messages may start: `starts[i]` is true when no
 * `tool_result` in message `i` or after it answers (answeredCallIndexes) a
 * `tool_use` in a message before `i`. So a window from such an index holds
 * the call of every result it holds that the messages answer. Index 0 and
 * `messages.length` are always true.
 */
export function cleanStarts(messages: ReadonlyArray<{ content: readonly ContentBlock[] }>): boolean[] {
  const owner: number[] = [];
  const blocks: ContentBlock[] = [];
  messages.forEach((msg, m) => {
    for (const block of msg.content) {
      blocks.push(block);
      owner.push(m);
    }
  });
  const opened = new Array<number>(messages.length + 2).fill(0);
  answeredCallIndexes(blocks).forEach((call, at) => {
    if (call === undefined) return;
    opened[owner[call]! + 1]!++;
    opened[owner[at]! + 1]!--;
  });
  const starts: boolean[] = [];
  let open = 0;
  for (let i = 0; i <= messages.length; i++) {
    open += opened[i]!;
    starts.push(open === 0);
  }
  return starts;
}

/**
 * Strip each `tool_use` that no `tool_result` in the message list answers,
 * and each `tool_result` that answers no `tool_use` there. A result answers
 * the nearest call before it with its id (answeredCallIndexes), so a call is
 * kept only if a result with its id follows it before the next call with
 * that id, and a result only if a call with its id comes before it. If
 * stripping leaves a message with no blocks, replace its content with a
 * placeholder text block so the message stays structurally valid
 * (collapse/rendering paths assume non-empty content).
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
 *
 * With `{ keepCalls: true }`, every `tool_use` stays, and only each
 * `tool_result` that answers no call before it goes, its raw form given up
 * and an emptied message given the same placeholder. Each message the strip
 * leaves whole comes back as itself, and one it changes as a plain object
 * with its own fields and the new content. Where it changes none, it
 * returns `messages` itself. A message stored with no blocks is left whole.
 */
export function stripUnpairedToolBlocks<T extends { participant: string; content: ContentBlock[] }>(
  messages: readonly T[],
  options: { keepCalls: true },
): readonly T[];
// Last, since Parameters<> and ReturnType<> read the last overload: the one-argument form stays what they give.
export function stripUnpairedToolBlocks<T extends { participant: string; content: ContentBlock[] }>(
  messages: readonly T[],
): Array<{ participant: string; content: ContentBlock[] }>;
export function stripUnpairedToolBlocks<T extends { participant: string; content: ContentBlock[] }>(
  messages: readonly T[],
  options?: { keepCalls?: boolean },
): ReadonlyArray<T | { participant: string; content: ContentBlock[] }> {
  const keepCalls = options?.keepCalls === true;
  const starts: number[] = [];
  const blocks: ContentBlock[] = [];
  for (const msg of messages) {
    starts.push(blocks.length);
    for (const block of msg.content) blocks.push(block);
  }
  const paired = new Set<number>();
  answeredCallIndexes(blocks).forEach((call, at) => {
    if (call === undefined) return;
    paired.add(call);
    paired.add(at);
  });
  let changed = false;
  const out = messages.map((msg, m) => {
    const trimmed = msg.content.filter((block, b) => (block.type === 'tool_result' || (block.type === 'tool_use' && !keepCalls) ? paired.has(starts[m]! + b) : true));
    if (trimmed.length === msg.content.length) {
      return keepCalls ? msg : { participant: msg.participant, content: msg.content };
    }
    changed = true;
    // A dropped block may share its raw replay form with a block that stays
    // (one <function_calls> holds several invokes); the survivors give it up
    // so the dropped block doesn't ship with them (see raw-forms.ts).
    const content: ContentBlock[] = trimmed.length > 0
      ? releaseEditedRawForms(msg.content, trimmed)
      : [{ type: 'text', text: '[tool call omitted]' }];
    return keepCalls ? { ...msg, content } : { participant: msg.participant, content };
  });
  return keepCalls && !changed ? messages : out;
}
