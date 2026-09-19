import type { ContentBlock } from '@animalabs/membrane';

/**
 * Tool-prose hoist (2026-09-19, sill).
 *
 * Observed: an L1 compression request whose replayed history contains a
 * tool_use carrying LONG prose in an argument of a "private reasoning" tool
 * (sill's `skip_reply.reason`, used as a 2–3KB diary) is refused
 * `reasoning_extraction` in ~1s. Canary-established on the logged refused
 * requests, one variable at a time:
 *   - content-INDEPENDENT (2.3KB of tea filler in the same field refuses;
 *     ≤ ~100 chars passes; 400 chars refuses), and independent of the
 *     tool_result text and of the call's position in the chunk;
 *   - sensitive to the tool's NAME/semantics, not to having a destination:
 *     `think{content}` refuses in every arrangement, `skip_reply{reason|note}`
 *     refuses, while `send_message`, `workspace--write`, and a note-taking
 *     tool (`journal{content}`, 8/8 real requests with the tool declared) pass.
 *
 * The rewrite therefore moves the prose into a call to a tool THE AGENT
 * REALLY HAS (`intoTool`), placed as its own round immediately before the
 * original call, and leaves a short stub in the original argument. Nothing the
 * agent wrote is dropped. The target must be a real tool because a summarizer
 * is the agent itself: whatever shape it sees itself using, it may use again
 * after waking. A shape it cannot actually perform (plain assistant text that
 * would be routed to a channel, a framework-voiced annotation, a file write
 * that never happened) teaches a habit that leaks or fails. The caller is
 * responsible for checking `intoTool` is among the declared tools.
 *
 * Pure function over wire-shape messages. Only top-level string arguments are
 * considered. A call whose tool_result cannot be found is left untouched.
 * Inserted tool ids are derived from the original id, so the rewritten request
 * (and its hash) is deterministic.
 */
export interface ToolProseHoistOptions {
  /** Name of the real tool that receives the prose, exactly as declared. */
  intoTool: string;
  /** Argument of `intoTool` that receives the prose. */
  field: string;
  /** tool_result content recorded for each inserted call. */
  result: string;
  /** Rewrite string arguments strictly longer than this many characters. */
  minChars: number;
  /**
   * Tools to rewrite FROM. A name matches exactly or as the final
   * `--`-separated segment. Required and never defaulted to "all": moving a
   * `send_message` body into a journal would author a false memory.
   */
  fromTools: readonly string[];
}

export const DEFAULT_TOOL_PROSE_MIN_CHARS = 100;
export const DEFAULT_TOOL_PROSE_FIELD = 'content';
export const DEFAULT_TOOL_PROSE_RESULT =
  '{"recorded":true,"note":"Journal entry recorded (private — not sent anywhere)."}';

export function toolProseStub(intoTool: string, chars: number): string {
  return `(written to ${intoTool} just before this — ${chars} chars)`;
}

export function toolNameMatches(name: string, tools: readonly string[]): boolean {
  return tools.some((t) => name === t || name.endsWith(`--${t}`));
}

type WireMessage = { participant: string; content: ContentBlock[] };
type ToolUse = ContentBlock & { type: 'tool_use'; id: string; name: string; input: unknown };

export function hoistToolProse<T extends WireMessage>(
  messages: readonly T[],
  options: ToolProseHoistOptions,
): { messages: WireMessage[]; hoisted: number } {
  // tool_use id -> participant of the message carrying its tool_result.
  const resultParticipant = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        resultParticipant.set((block as { toolUseId: string }).toolUseId, message.participant);
      }
    }
  }

  let hoisted = 0;
  const out: WireMessage[] = [];
  for (const message of messages) {
    const rounds: WireMessage[] = [];
    const content = message.content.map((block) => {
      if (block.type !== 'tool_use') return block;
      const use = block as ToolUse;
      if (use.name === options.intoTool || !toolNameMatches(use.name, options.fromTools)) return block;
      const resultSide = resultParticipant.get(use.id);
      if (resultSide === undefined) return block;
      if (!use.input || typeof use.input !== 'object' || Array.isArray(use.input)) return block;
      let changed = false;
      const input: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(use.input as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.length <= options.minChars) {
          input[field] = value;
          continue;
        }
        const id = `${use.id}_${hoisted}`;
        rounds.push(
          {
            participant: message.participant,
            content: [{ type: 'tool_use', id, name: options.intoTool, input: { [options.field]: value } } as ContentBlock],
          },
          {
            participant: resultSide,
            content: [{ type: 'tool_result', toolUseId: id, content: options.result } as ContentBlock],
          },
        );
        input[field] = toolProseStub(options.intoTool, value.length);
        changed = true;
        hoisted++;
      }
      return changed ? ({ ...use, input } as ContentBlock) : block;
    });
    if (rounds.length === 0) {
      out.push(message);
      continue;
    }
    out.push(...rounds, { ...message, content });
  }
  return { messages: out, hoisted };
}
