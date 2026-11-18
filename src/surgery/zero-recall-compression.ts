import { isDeepStrictEqual } from 'node:util';
import { recallHeaderId } from '../recall-header.js';
import { createHash } from 'node:crypto';
import type { NormalizedMessage, NormalizedRequest } from '@animalabs/membrane';

export interface ZeroRecallTransformResult {
  messages: NormalizedMessage[];
  removedRecallIds: string[];
  originalMessageCount: number;
  sentMessageCount: number;
  originalSha256: string;
  transformedSha256: string;
}

/** Snapshot ONLY inside the strategy's trusted L1 construction hook, never in
 * the proxy that edits a request. These are the actual constructed answers:
 * normalization, sanitization, seams, preparation and carrier retry have all
 * already run through the production path, so no parallel renderer can drift.
 * The caller must reject recall-shaped raw history before construction.
 */
export function captureZeroRecallConstruction(request: NormalizedRequest, recallIds: readonly string[]) {
  const snapshot = structuredClone(request);
  const expectedAnswers = snapshot.messages.flatMap((message, i) => {
    const id = recallHeaderId(message);
    if (id === undefined || !recallIds.includes(id)) return [];
    const answer = snapshot.messages[i + 1];
    if (!answer) throw new Error(`Missing constructed recall answer for ${id}`);
    return [{ id, answer: { participant: answer.participant, content: answer.content } }];
  });
  if (new Set(recallIds).size !== recallIds.length || expectedAnswers.length !== recallIds.length
    || recallIds.some(id => expectedAnswers.filter(answer => answer.id === id).length !== 1)) {
    throw new Error('Missing or ambiguous constructed recalls; refusing zero-recall surgery');
  }
  return { request: snapshot, expectedAnswers };
}

/** Bind an intercepted request to the trusted construction snapshot in full. */
export function assertZeroRecallConstruction(request: NormalizedRequest, snapshot: NormalizedRequest): void {
  if (!isDeepStrictEqual(request, snapshot)) {
    throw new Error('Request differs from trusted L1 construction; refusing zero-recall surgery');
  }
}

/** One construction-bound transform, including complete recalled-set coverage. */
export function transformConstructedZeroRecallCompression(
  request: NormalizedRequest, opening: string,
  construction: ReturnType<typeof captureZeroRecallConstruction>,
): ZeroRecallTransformResult {
  assertZeroRecallConstruction(request, construction.request);
  const result = transformZeroRecallCompression(request.messages, opening, construction.expectedAnswers);
  if (result.removedRecallIds.length !== construction.expectedAnswers.length) {
    throw new Error('Incomplete constructed recall removal; refusing zero-recall surgery');
  }
  return result;
}

/** Reject source histories that cannot be distinguished from synthetic recalls. */
export function assertZeroRecallSourceSafe(messages: readonly Pick<NormalizedMessage, 'participant' | 'content'>[], opening?: string): void {
  if (opening !== undefined && messages.some(message => message.participant === 'Context Manager'
    && message.content.some(block => block.type === 'text' && block.text === opening))) {
    throw new Error('Raw history collides with compression opening; refusing zero-recall surgery');
  }
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
 * history. They may instead be snapshotted in the trusted construction hook
 * after the production transformations, provided source safety is established.
 * Exact participant/content equality is required before any result.
 * The caller must establish that the prefix contains no raw recall-shaped history
 * or raw text equal to the opening (source safety can check both).
 * It does not annotate the request, generated summary, or prior turns; all
 * operation metadata belongs in the external receipt; the authoring strategy
 * hashes and persists the returned request as ordinary mint provenance.
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


  // Never leave a raw result whose matching use was deleted with a memory.
  // Match each result to its most recent preceding use, not an unrelated
  // earlier use with the same id. Reused ids must not mask deleted calls.
  const retainedUses = new Map<string, boolean>();
  for (const message of messages) {
    const retained = kept.includes(message);
    for (const block of message.content) {
      if (block.type === 'tool_use') retainedUses.set(block.id, retained);
      if (retained && block.type === 'tool_result' && retainedUses.get(block.toolUseId) === false) {
        throw new Error('Tool pair crosses recall deletion boundary; refusing zero-recall surgery');
      }
    }
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
