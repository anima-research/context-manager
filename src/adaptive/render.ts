/**
 * Render helpers for the adaptive-resolution design.
 *
 * The main operation is "group consecutive same-bodyGroupId messages into
 * a single API message via body concatenation," which is how a chunked
 * document or large message is reassembled at the API boundary.
 *
 * See `docs/adaptive-resolution-design.md` §3.6.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '../types/message.js';

/**
 * Group consecutive messages that share a bodyGroupId into composite
 * messages whose body is the byte-faithful concatenation of the shards'
 * text content. Messages with a null/undefined bodyGroupId pass through
 * unchanged.
 *
 * For a shard at non-zero currentResolution, the shard's text in the
 * concatenation is replaced by `getRecallText(shard)`. The renderer is
 * responsible for providing recall content that's appropriate for the
 * level (an L_k recall pair, formatted however the deployment prefers).
 *
 * Properties:
 *  - **Byte-faithful** when all shards in a group are at L0 and getRecallText
 *    is not called: the concatenated body equals the original message body
 *    byte-for-byte. Verified by tests in test/adaptive/render.test.ts.
 *  - **One API message per group**, regardless of shard count. No turn
 *    markers between shards.
 *  - **Order preserved**: shards within a group are sorted by `shardIndex`
 *    before concatenation; if shardIndex is missing, the order in the input
 *    array is used.
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
    // Collect all consecutive messages with the same bodyGroupId.
    const groupId = m.bodyGroupId;
    const groupStart = i;
    while (i < messages.length && messages[i].bodyGroupId === groupId) {
      i++;
    }
    const group = messages.slice(groupStart, i);
    // Sort by shardIndex if present.
    const sorted = [...group].sort(
      (a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0)
    );

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
 * Extract text content from a message's content blocks. For shards we
 * expect (and require) all content to be text — they were produced by
 * the chunker, which only splits strings. If non-text blocks slip through,
 * they're stringified as best-effort.
 */
function extractTextContent(blocks: ContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push(b.text);
    } else {
      // Non-text content in a sharded body shouldn't happen, but if it
      // does, we serialize as a placeholder rather than crashing.
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
