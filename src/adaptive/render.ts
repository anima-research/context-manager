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
 * Join each body's consecutive shards into one composite message whose body
 * is the byte-faithful concatenation of the shards' text content: a render of
 * the body as text alone. To join a body's blocks, as the strategy's raw
 * renders send it, use joinBodyContent (body-runs.ts). A body is
 * one ingestion: a later ingestion of the same text carries the same
 * bodyGroupId and is a body of its own (see body-runs.ts). Messages with a
 * null/undefined bodyGroupId pass through unchanged.
 *
 * For a shard at non-zero currentResolution, the shard's text in the
 * concatenation is replaced by `getRecallText(shard)`. The renderer is
 * responsible for providing recall content that's appropriate for the
 * level (an L_k recall pair, formatted however the deployment prefers).
 *
 * Properties:
 *  - **Byte-faithful** when all shards in a group are at L0 and getRecallText
 *    is not called: the concatenated text equals the original message's text
 *    byte-for-byte. Verified by tests in test/adaptive/render.test.ts. Its
 *    other blocks come back as placeholders (extractTextContent).
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

    const concatenated = sorted.map((shard) => {
      const res = shard.currentResolution ?? 0;
      if (res === 0) {
        return extractTextContent(shard.content);
      }
      return getRecallText(shard);
    }).join('');

    // Build the composite message. Inherit id/participant/timestamp from
    // the first shard; combine metadata; build a single text content block.
    const composite: StoredMessage = {
      id: sorted[0].id,
      sequence: sorted[0].sequence,
      participant: sorted[0].participant,
      content: [{ type: 'text', text: concatenated } as ContentBlock],
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
 * Extract text content from a message's content blocks.
 */
function extractTextContent(blocks: ContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push(b.text);
    } else {
      out.push(`[non-text content: ${b.type}]`);
    }
  }
  return out.join('');
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
