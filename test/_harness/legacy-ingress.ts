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
