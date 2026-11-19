import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { MessageStoreView, StoredMessage } from '../src/types/index.js';
import type { IngressChunkResult } from '../src/types/strategy.js';

export type Layout = 'new' | 'old';
export type Kind = 'adaptive' | 'kv-unified';

const PROSE = 'lorem ipsum dolor sit amet consectetur '.repeat(6_000);
export const long = (label: string, chars = 80_000): string => `${label} ${PROSE.slice(0, chars)}`;
export const text = (t: string): ContentBlock => ({ type: 'text', text: t });
export const thinking = (t: string): ContentBlock =>
  ({ type: 'thinking', thinking: t, signature: `signature of ${t}` }) as unknown as ContentBlock;
export const image = (data: string): ContentBlock =>
  ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data }, tokenEstimate: 1600 }) as unknown as ContentBlock;
export const call = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'lookup', input: { q: id } }) as unknown as ContentBlock;
export const result = (id: string, content: unknown): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content }) as unknown as ContentBlock;

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25, continuityLambda: 1,
    continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};

export class Probe extends AutobiographicalStrategy {
  layout: Layout = 'new';
  persist = true;

  override chunkIngressMessage(participant: string, content: ContentBlock[]): IngressChunkResult | null {
    const split = super.chunkIngressMessage(participant, content);
    if (!split || this.layout === 'new') return split;
    const others = content.filter((block) => block.type !== 'text');
    return {
      ...split,
      shards: split.shards.map((shard) => ({
        ...shard,
        content: [...shard.content.filter((block) => block.type === 'text'), ...(shard.shardIndex === 0 ? others : [])],
      })),
    };
  }

  protected override get chunkPersistenceEnabled(): boolean {
    return this.persist;
  }

  set(config: { headWindowTokens?: number; recentWindowTokens?: number; targetChunkTokens?: number; imageStripDepthTokens?: number }): void {
    Object.assign(this.config as object, config);
  }
  recentStart(store: MessageStoreView): number { return this.getRecentWindowStart(store); }
  headEnd(store: MessageStoreView): number { return this.getHeadWindowEnd(store); }
  holdStart(store: MessageStoreView): number { return this.holdBoundary(store); }
  walkPrices(store: MessageStoreView): number[] { return this.postStripEstimates(store); }
  compressibleIds(store: MessageStoreView): string[] { return this.getCompressibleMessages(store).map((m) => m.id); }
  chunkIds(store: MessageStoreView): string[][] {
    this.rebuildChunks(store);
    return this.chunks.map((chunk) => chunk.messages.map((m) => m.id));
  }
  endsOnCall(chunk: StoredMessage[], listing: readonly StoredMessage[], position: ReadonlyMap<string, number>): boolean {
    return this.chunkEndsOnCall(chunk, listing, position);
  }
}

export const freshObjects = (view: MessageStoreView): MessageStoreView => new Proxy(view, {
  get(target, key, receiver) {
    if (key === 'getAll') return () => target.getAll().map((m) => ({ ...m }));
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export async function open(o: { layout?: Layout; kind?: Kind; config?: Record<string, unknown>; persist?: boolean; dir?: string; membrane?: unknown; Strategy?: typeof Probe } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'cm-body-parts-'));
  const strategy = new (o.Strategy ?? Probe)({
    adaptiveResolution: true,
    compressionModel: 'mock',
    overBudgetGraceRatio: 0,
    imageStripDepthTokens: 0,
    ...(o.kind === 'kv-unified' ? { foldingStrategy: 'kv-unified', kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } } : {}),
    ...o.config,
  });
  strategy.layout = o.layout ?? 'new';
  strategy.persist = o.persist ?? true;
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, ...(o.membrane ? { membrane: o.membrane as never } : {}) });
  const view = (): MessageStoreView => (manager as unknown as { strategyMessageView(): MessageStoreView }).strategyMessageView();
  const all = (): StoredMessage[] => view().getAll();
  const add = (participant: string, content: ContentBlock[]): number[] => {
    const from = all().length;
    manager.addMessage(participant, content);
    return Array.from({ length: all().length - from }, (_, k) => from + k);
  };
  const estimates = (): number[] => all().map((m) => view().estimateTokens(m));
  const close = async (remove = true): Promise<void> => {
    await manager.close();
    if (remove) rmSync(dir, { recursive: true, force: true });
  };
  return { dir, manager, strategy, view, all, add, estimates, close };
}

export const sum = (prices: readonly number[], from: number, to = prices.length): number =>
  prices.slice(from, to).reduce((n, p) => n + p, 0);
