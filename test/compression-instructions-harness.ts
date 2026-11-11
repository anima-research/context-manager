import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy, KnowledgeStrategy } from '../src/index.js';
import type { AutobiographicalOptions, CompressionInstructions, SummaryEntry, StrategyContext } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
export const instruction = (r: NormalizedRequest) => r.messages.at(-1)!.content
  .filter(b => b.type === 'text').map(b => b.text).join('\n');
export const texts = (r: NormalizedRequest) => r.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text));
export const custom: CompressionInstructions = {
  templates: {
    opening: 'CUSTOM OPEN',
    chunk: 'CUSTOM CHUNK {targetTokens}',
    witnessedChunk: 'CUSTOM WITNESS {targetTokens}',
    readingChunk: 'CUSTOM READ {totalTokens} {targetTokens}',
    merge: 'CUSTOM MERGE {sourceLevelShown} {targetLevel} {targetTokens}',
    witnessedMerge: 'CUSTOM WMERGE {sourceLevelShown} {targetLevel} {targetTokens}',
    readingMerge: 'CUSTOM RMERGE {sourceLevelShown} {targetLevel} {totalTokens} {targetTokens}',
    transition: 'CUSTOM TRANSITION {targetTokens}\n{context}',
  },
};
const options: AutobiographicalOptions = {
  compressionModel: 'mock-only', headWindowTokens: 0, recentWindowTokens: 0,
  targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99,
  autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0,
  compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
  compressionSplitFallback: true,
};
export class Probe extends AutobiographicalStrategy {
  pin(value: number) { this.config.witnessedBeforeSequence = value; }
  compress(chunk: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(chunk, ctx); }
  seed(s: SummaryEntry) { this.pushSummary(s); }
  async merge(ids: string[], ctx: StrategyContext, fallback = false, targetLevel: 2 | 3 = 2) {
    if (!fallback) return this.executeMerge(targetLevel, ids, ctx);
    this.compressionQueue = []; // Isolate the seeded merge from unrelated shard work.
    this.enqueueMerge({ level: targetLevel, sourceIds: ids });
    await this.tick(ctx);
    await this.tick(ctx);
    return this.summaries.some(s => s.level === targetLevel);
  }
  summariesNow() { return this.summaries; }
}

export class KnowledgeProbe extends KnowledgeStrategy {
  pin(value: number) { this.config.witnessedBeforeSequence = value; }
  compress(chunk: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(chunk, ctx); }
  seed(s: SummaryEntry) { this.pushSummary(s); }
  async merge(ids: string[], ctx: StrategyContext, fallback = false, targetLevel: 2 | 3 = 2) {
    if (!fallback) return this.executeMerge(targetLevel, ids, ctx);
    this.compressionQueue = []; // Isolate the seeded merge from unrelated shard work.
    this.enqueueMerge({ level: targetLevel, sourceIds: ids });
    await this.tick(ctx);
    await this.tick(ctx);
    return this.summaries.some(s => s.level === targetLevel);
  }
  summariesNow() { return this.summaries; }
}
export type Mode = 'chunk' | 'reading' | 'split' | 'readingSplit' | 'merge' | 'readingMerge' | 'fallback' | 'readingFallback' | 'transition';
export async function run(mode: Mode, pin: 'own' | 'mixed' | 'inherited', config?: CompressionInstructions,
  extra: AutobiographicalOptions = {}, Strategy: typeof Probe | typeof KnowledgeProbe = Probe, targetLevel: 2 | 3 = 2) {
  const path = mkdtempSync(join(tmpdir(), 'test-instructions-'));
  const calls: NormalizedRequest[] = [];
  let manager: ContextManager | undefined;
  try {
    const reading = mode.startsWith('reading');
    const split = mode === 'split' || mode === 'readingSplit';
    const strategy = new Strategy({ ...options, adaptiveResolution: reading,
      ...(mode === 'transition' ? { headWindowTokens: 1000 } : {}),
      ...extra, compressionInstructions: config });
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      // Canonical/source-only split requests have four raw records. Pieces have one.
      const rawCount = texts(request).filter(s => s.startsWith('raw-')).length;
      return (split && rawCount > 1) || (mode.toLowerCase().includes('fallback') && calls.length === 1)
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } }
        : { content: [text('A mock summary.')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    } };
    manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
    if (reading) {
      manager.addMessage('Reader', [text('raw-portion substantive shared text. '.repeat(200))]);
    } else {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Participant' : 'Other', [text(`raw-${i} {participant} {targetTokens} $& ` + 'substantive '.repeat(15))]);
    }
    const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const messages = ctx.messageStore.getAll();
    if (reading) assert.ok(messages.length > 8, 'fixture really is sharded');
    strategy.pin(pin === 'inherited' ? messages.at(-1)!.sequence + 1 : messages[pin === 'mixed' ? 2 : 0]!.sequence);
    const before = structuredClone(messages);
    if (['chunk', 'reading', 'split', 'readingSplit'].includes(mode)) {
      // reading/mixed is an inherited alias: its single shard precedes the pin.
      // Keep this historical fixture stable; readingSplit/mixed spans the pin.
      const chosen = reading && !split ? messages.slice(0, 1) : messages.slice(0, 4);
      await strategy.compress({ index: 0, startIndex: 0, endIndex: chosen.length,
        messages: chosen, tokens: 100, compressed: false }, ctx);
      assert.equal(strategy.summariesNow().length, 1, 'compression installed one native summary');
    } else if (mode === 'transition') {
      await strategy.generateTransitionSummary(ctx);
    } else {
      let sources = [0, 2].map((start, i): SummaryEntry => ({
        id: `L1-${100 + i}`, level: 1, content: `attributed source ${i}`, tokens: 20,
        sourceLevel: 0, sourceIds: messages.slice(start, start + 2).map(m => m.id),
        sourceRange: { first: messages[start]!.id, last: messages[start + 1]!.id }, created: 1,
        ...(pin === 'inherited' || (pin === 'mixed' && i === 0) ? { witnessed: true } : {}),
      }));
      for (const s of sources) strategy.seed(s);
      if (targetLevel === 3) {
        sources = sources.map((s, i) => ({ ...s, id: `L2-${200 + i}`, level: 2,
          sourceLevel: 1, sourceIds: [s.id] }));
        for (const s of sources) strategy.seed(s);
      }
      assert.equal(await strategy.merge(sources.map(s => s.id), ctx, mode.toLowerCase().includes('fallback'), targetLevel), true);
      const merged = strategy.summariesNow().find(s => s.level === targetLevel)!;
      assert.ok(merged, 'merge was actually installed');
      assert.equal(!!merged.witnessed, pin === 'inherited');
      assert.deepEqual(merged.sourceIds, sources.map(s => s.id));
    }
    assert.deepEqual(ctx.messageStore.getAll(), before, 'raw content and metadata untouched');
    assert.equal(calls.length, split ? 8 : mode.toLowerCase().includes('fallback') ? 2 : 1, 'only the expected mock calls');
    return calls;
  } finally {
    try { await manager?.close(); }
    finally { rmSync(path, { recursive: true, force: true }); }
  }
}
