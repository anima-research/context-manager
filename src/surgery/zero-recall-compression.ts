import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '@animalabs/membrane';

export interface ZeroRecallTransformResult {
  messages: NormalizedMessage[];
  removedRecallIds: string[];
  originalMessageCount: number;
  sentMessageCount: number;
  originalSha256: string;
  transformedSha256: string;
}

function textOf(message: NormalizedMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Explicit surgical transform for ONE compression request.
 *
 * Removes complete `[CM] Recall memory …` marker/answer pairs only.
 * It does not annotate the request, generated summary, or prior turns; all
 * operation provenance belongs in the caller's external receipt.
 * It never edits Chronicle or any source message. Callers must bind its use to
 * an exact stopped store, branch, chunk, request hash and one-shot receipt.
 */
export function transformZeroRecallCompression(messages: readonly NormalizedMessage[]): ZeroRecallTransformResult {
  const kept: NormalizedMessage[] = [];
  const removedRecallIds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const marker = message.participant === 'Context Manager'
      ? textOf(message).match(/^\[CM\] Recall memory ([^.]+)\./)
      : null;
    if (!marker) {
      kept.push(message);
      continue;
    }

    const answer = messages[i + 1];
    if (!answer || answer.participant === 'Context Manager') {
      throw new Error(`Malformed recall pair for ${marker[1]}: missing assistant answer`);
    }
    removedRecallIds.push(marker[1]);
    i++;
  }

  if (removedRecallIds.length === 0) {
    throw new Error('No recall pairs found; refusing zero-recall surgery');
  }


  const originalJson = JSON.stringify(messages);
  const transformedJson = JSON.stringify(kept);
  return {
    messages: kept,
    removedRecallIds,
    originalMessageCount: messages.length,
    sentMessageCount: kept.length,
    originalSha256: createHash('sha256').update(originalJson).digest('hex'),
    transformedSha256: createHash('sha256').update(transformedJson).digest('hex'),
  };
}
