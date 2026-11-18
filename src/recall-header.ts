import type { ContentBlock } from '@animalabs/membrane';

/** The summary id a `[CM] Recall memory <id>.` header names, or undefined for
 *  any other message. A recall pair is such a header and the answer after it. */
export function recallHeaderId(message: { participant: string; content: ContentBlock[] }): string | undefined {
  if (message.participant !== 'Context Manager' || message.content.length !== 1) return undefined;
  const block = message.content[0];
  if (block?.type !== 'text') return undefined;
  return /^\[CM\] Recall memory (.+)\.$/.exec(block.text)?.[1];
}


/** Construction identity stays off the wire. Normalization and collapse retain
 * these text blocks, including on the carrier-stripped retry. Raw history can
 * quote identical bytes but cannot acquire this identity. */
const constructedHeaders = new WeakMap<ContentBlock, string>();

export function constructedRecallHeader(id: string): ContentBlock {
  const block: ContentBlock = { type: 'text', text: `[CM] Recall memory ${id}.` };
  constructedHeaders.set(block, id);
  return block;
}

/** Telemetry only: count constructed headers that survive request authoring,
 * not header-shaped text in raw history. Never used to authorize deletion. */
export function sentRecallHeaderIds(message: { participant: string; content: ContentBlock[] }): string[] {
  if (message.participant !== 'Context Manager') return [];
  return message.content.flatMap(block => {
    const id = constructedHeaders.get(block);
    return id === undefined ? [] : [id];
  });
}
