/**
 * Render helpers for the adaptive-resolution design.
 *
 * The main operation is "join each body's consecutive shards into a single
 * API message via body concatenation," which is how a chunked document or
 * large message is reassembled at the API boundary. A body is read by the
 * pairwise rule in body-runs.ts, not by group id alone.
 *
 * See `docs/adaptive-resolution-design.md` §3.6.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '../types/message.js';
import { bodyEnd } from '../body-runs.js';

/**
 * A body's parts joined into one message's content: every non-text block of
 * the parts, in part order and each part's own order, then their text joined
 * into one text block. Non-text blocks go first because a turn's tool results
 * must lead it for the API to pair them with the call before, and a reply's
 * thinking leads its turn. Each part is given as it is to be sent: a raw
 * part's content, cut as its region cuts it, or a folded part's recall text
 * as a text block. The adaptive strategy joins every run of a body's raw
 * parts it sends with this, one part included.
 */
export function joinBodyParts(parts: readonly (readonly ContentBlock[])[]): ContentBlock[] {
  const others: ContentBlock[] = [];
  const text: string[] = [];
  for (const part of parts) {
    for (const block of part) {
      if (block.type === 'text') text.push(block.text);
      else others.push(block);
    }
  }
  return [...others, { type: 'text', text: text.join('') } as ContentBlock];
}

/**
 * Join each body's consecutive shards into one composite message, its
 * content the shards joined by joinBodyParts: a raw shard as stored, a shard
 * at non-zero currentResolution as `getRecallText(shard)`. A body is one
 * ingestion: a later ingestion of the same text carries the same
 * bodyGroupId and is a body of its own (see body-runs.ts). Messages with a
 * null/undefined bodyGroupId pass through unchanged.
 *
 * The renderer is responsible for providing recall content that's
 * appropriate for the level (an L_k recall pair, formatted however the
 * deployment prefers).
 *
 * Properties:
 *  - **Byte-faithful** when all shards in a group are at L0 and getRecallText
 *    is not called: the composite's text equals the original message's text
 *    byte-for-byte. Verified by tests in test/adaptive/render.test.ts.
 *  - **One API message per body**, regardless of shard count. No turn
 *    markers between shards.
 *  - **Store order**: `messages` is read in store order, where a body's
 *    shard indices rise. A shard whose index doesn't rise starts another
 *    body, so a cut through a body, or a second copy right after it, is
 *    never joined to it.
 */
export function concatBodyGroups(
  messages: readonly StoredMessage[],
  getRecallText: (shard: StoredMessage) => string
): StoredMessage[] {
  const out: StoredMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m.bodyGroupId) {
      out.push(m);
      i++;
      continue;
    }
    // Collect this body's consecutive shards.
    const groupId = m.bodyGroupId;
    const groupStart = i;
    i = bodyEnd(messages.length, (k) => messages[k], groupStart) + 1;
    // A body's shards are already in rising shard order (body-runs.ts).
    const sorted = messages.slice(groupStart, i);

    // Build the composite message. Inherit id/participant/timestamp from
    // the first shard; combine metadata.
    const composite: StoredMessage = {
      id: sorted[0].id,
      sequence: sorted[0].sequence,
      participant: sorted[0].participant,
      content: joinBodyParts(sorted.map((shard) => ((shard.currentResolution ?? 0) === 0
        ? shard.content
        : [{ type: 'text', text: getRecallText(shard) } as ContentBlock]))),
      metadata: {
        ...(sorted[0].metadata ?? {}),
        bodyGroupId: groupId,
        shardCount: sorted.length,
      },
      timestamp: sorted[0].timestamp,
    };
    out.push(composite);
  }
  return out;
}

/**
 * Default getRecallText for testing or when the strategy hasn't provided
 * a custom one. Returns a simple "[summary of N tokens]" placeholder so
 * the concat doesn't accidentally include the raw shard text.
 */
export function placeholderRecallText(shard: StoredMessage): string {
  const level = shard.currentResolution ?? 0;
  return `\n[L${level} recall of chunk ${shard.id}]\n`;
}
