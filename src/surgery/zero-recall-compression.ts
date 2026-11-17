import { isDeepStrictEqual } from 'node:util';
import { recallHeaderId } from '../recall-header.js';
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

/** Reject source histories that cannot be distinguished from synthetic recalls. */
export function assertZeroRecallSourceSafe(messages: readonly Pick<NormalizedMessage, 'participant' | 'content'>[]): void {
  if (messages.some(message => message.participant === 'Context Manager'
    && message.content.some(block => block.type === 'text' && block.text.includes('[CM] Recall memory ')))) {
    throw new Error('Raw recall-shaped Context Manager history; refusing zero-recall surgery');
  }
}

/**
 * Explicit surgical transform for ONE compression request.
 *
 * Removes complete `[CM] Recall memory …` marker/answer pairs before the
 * configured opening only. Ambiguous, collapsed or missing recall geometry fails closed. The
 * expectedAnswers must come from the strategy's summaries, NOT be inferred from
 * the request being edited: even an unfenced single text block can contain raw
 * history. Exact participant/content equality is required before any result.
 * The caller must establish that the prefix contains no raw recall-shaped history.
 * It does not annotate the request, generated summary, or prior turns; all
 * operation provenance belongs in the caller's external receipt.
 * It never edits Chronicle or any source message. Callers must bind its use to
 * an exact stopped store, branch, chunk, request hash and one-shot receipt.
 */
export function transformZeroRecallCompression(
  messages: readonly NormalizedMessage[], opening: string,
  expectedAnswers: readonly { id: string; answer: Pick<NormalizedMessage, 'participant' | 'content'> }[] = [],
): ZeroRecallTransformResult {
  const boundaries = messages.flatMap((message, i) => message.participant === 'Context Manager'
    ? message.content.filter(block => block.type === 'text' && block.text === opening).map(() => i)
    : []);
  if (!opening.trim() || boundaries.length !== 1) {
    throw new Error('Missing or ambiguous compression opening; refusing zero-recall surgery');
  }
  const recallEnd = boundaries[0]!;
  const kept: NormalizedMessage[] = [];
  const removedRecallIds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const id = i < recallEnd ? recallHeaderId(message) : undefined;
    // Collapse can join a synthetic header to a raw CM turn (or the
    // opening). Without provenance, deleting that turn would delete history.
    // Refuse the entire transform rather than silently retaining a memory.
    if (i <= recallEnd && message.participant === 'Context Manager'
      && message.content.some(block => block.type === 'text' && block.text !== opening
        && block.text.includes('[CM] Recall memory ')) && id === undefined) {
      throw new Error('Collapsed or unrecognized recall header; refusing zero-recall surgery');
    }
    if (id === undefined) {
      kept.push(message);
      continue;
    }

    const answer = messages[i + 1];
    if (i + 1 >= recallEnd || !answer || answer.participant === 'Context Manager') {
      throw new Error(`Malformed recall pair for ${id}: missing assistant answer`);
    }
    if (message.content[0]?.type !== 'text'
      || message.content[0].text !== `[CM] Recall memory ${id}.`) {
      throw new Error('Collapsed or unrecognized recall header; refusing zero-recall surgery');
    }
    const matches = expectedAnswers.filter(expected => expected.id === id);
    if (removedRecallIds.includes(id) || matches.length !== 1
      || !isDeepStrictEqual({ participant: answer.participant, content: answer.content }, matches[0]!.answer)) {
      throw new Error(`Unmatched or ambiguous recall answer for ${id}; refusing zero-recall surgery`);
    }
    removedRecallIds.push(id);
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
