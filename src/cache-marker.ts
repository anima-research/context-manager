import type { ContentBlock } from '@animalabs/membrane';

export function withoutCacheMarker(block: ContentBlock): Record<string, unknown> {
  const marked = block as unknown as Record<string, unknown>;
  if (!('cache_control' in marked) && !('cacheControl' in marked)) return marked;
  const { cache_control: _snake, cacheControl: _camel, ...rest } = marked;
  return rest;
}
