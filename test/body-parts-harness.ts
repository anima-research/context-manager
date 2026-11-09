/**
 * What the tests of a message stored in parts share (parts-keep-blocks,
 * parts-call-edges): content to split, a strategy that can also store a split
 * message the way ingress stored one before a reply's calls went on its last
 * part, and readers of the windows' edges and the chunks.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { MessageStoreView, StoredMessage } from '../src/types/index.js';
import type { IngressChunkResult } from '../src/types/strategy.js';

/** `new`: as ingress stores a split message now. `old`: every non-text block
 *  on the first part, after its text, as ingress stored one before. */
export type Layout = 'new' | 'old';
export type Kind = 'adaptive' | 'kv-unified';

const PROSE = 'lorem ipsum dolor sit amet consectetur '.repeat(6_000);
/** `chars` characters of text that ingress splits into parts of about 12,000
 *  characters (the default targetChunkTokens at four characters a token),
 *  starting with `label` so a test can find it. */
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
  /** Each message as the recent window's walk prices it. */
  walkPrices(store: MessageStoreView): number[] { return this.postStripEstimates(store); }
  /** The messages a chunk may take now, as ids. */
  compressibleIds(store: MessageStoreView): string[] { return this.getCompressibleMessages(store).map((m) => m.id); }
  /** The chunks a rebuild cuts now, as message ids. */
  chunkIds(store: MessageStoreView): string[][] {
    this.rebuildChunks(store);
    return this.chunks.map((chunk) => chunk.messages.map((m) => m.id));
  }
}

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
  /** Adds a message and gives the positions of its parts. */
  const add = (participant: string, content: ContentBlock[]): number[] => {
    const from = all().length;
    manager.addMessage(participant, content);
    return Array.from({ length: all().length - from }, (_, k) => from + k);
  };
  /** The store's estimate of each stored message, as the head's walk and the image strip's depth price it. */
  const estimates = (): number[] => all().map((m) => view().estimateTokens(m));
  const close = async (remove = true): Promise<void> => {
    await manager.close();
    if (remove) rmSync(dir, { recursive: true, force: true });
  };
  return { dir, manager, strategy, view, all, add, estimates, close };
}

/** The sum of `prices` from `from` up to (not including) `to`. */
export const sum = (prices: readonly number[], from: number, to = prices.length): number =>
  prices.slice(from, to).reduce((n, p) => n + p, 0);
