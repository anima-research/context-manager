/**
 * The layout bodies were stored in before ingress kept each block in place:
 * the message's text joined into one block, cut across the shards, and every
 * other block on the first shard after its text, with no `continuesBlock`.
 * Tests of bodies stored that way rewrite a chunking decision with it, so
 * there is one copy of what that stored format was.
 */
import type { ContentBlock } from '@animalabs/membrane';
import type { IngressChunkResult } from '../../src/types/strategy.js';

export function legacyIngress(decision: IngressChunkResult | null, content: readonly ContentBlock[]): IngressChunkResult | null {
  if (!decision) return decision;
  const others = content.filter((block) => block.type !== 'text');
  return {
    bodyGroupId: decision.bodyGroupId,
    shards: decision.shards.map((shard, k) => ({
      shardIndex: shard.shardIndex,
      content: [
        { type: 'text', text: shard.content.map((block) => (block.type === 'text' ? block.text : '')).join('') } as ContentBlock,
        ...(k === 0 ? others : []),
      ],
    })),
  };
}
