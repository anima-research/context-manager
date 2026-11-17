import type { ContentBlock } from '@animalabs/membrane';

/** The summary id a `[CM] Recall memory <id>.` header names, or undefined for
 *  any other message. A recall pair is such a header and the answer after it. */
export function recallHeaderId(message: { participant: string; content: ContentBlock[] }): string | undefined {
  if (message.participant !== 'Context Manager' || message.content.length !== 1) return undefined;
  const block = message.content[0];
  if (block?.type !== 'text') return undefined;
  return /^\[CM\] Recall memory (.+)\.$/.exec(block.text)?.[1];
}

