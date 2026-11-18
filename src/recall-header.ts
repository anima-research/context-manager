import type { ContentBlock } from '@animalabs/membrane';

/** The summary id a `[CM] Recall memory <id>.` header names, or undefined for
 *  any other message. A recall pair is such a header and the answer after it. */
export function recallHeaderId(message: { participant: string; content: ContentBlock[] }): string | undefined {
  if (message.participant !== 'Context Manager' || message.content.length !== 1) return undefined;
  const block = message.content[0];
  if (block?.type !== 'text') return undefined;
  return /^\[CM\] Recall memory (.+)\.$/.exec(block.text)?.[1];
}


/** Telemetry only: collapse retains recall headers as individual text blocks.
 * Do not use this looser recognition to authorize surgery deletion. */
export function sentRecallHeaderIds(message: { participant: string; content: ContentBlock[] }): string[] {
  if (message.participant !== 'Context Manager') return [];
  return message.content.flatMap(block => block.type === 'text'
    ? [...block.text.matchAll(/^\[CM\] Recall memory (.+)\.$/gm)].map(match => match[1]!) : []);
}
