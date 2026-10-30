import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { MessageStoreView, StrategyContext } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'quarantined-span-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MARK = 'refused-span-mark';
const CONFIG = {
  compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
  autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0,
};

class ProbeStrategy extends AutobiographicalStrategy {
  closedChunks(): Chunk[] { return this.chunks; }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  head(store: MessageStoreView, pos: number): { start: number; end: number } { return this.headAsOf(store, pos); }
  merged(): number { return this.summaries.filter((s) => s.level >= 2).length; }
  queued(store: MessageStoreView): boolean { return this.compressionWorkQueued(store, 'hierarchical'); }
}

function summarizer() {
  const requests: string[] = [];
  const membrane = {
    complete: async (request: unknown) => {
      const text = JSON.stringify(request);
      requests.push(text);
      if (text.includes(MARK)) {
        return {
          content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
          raw: { response: { stop_details: { category: 'cyber' } } },
        };
      }
      return { content: [{ type: 'text', text: `a memory ${requests.length}` }], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
  return { membrane: membrane as never, requests };
}

const context = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

const label = (content: unknown) => `raw-${(JSON.stringify(content).match(/raw-(\d+) /) ?? [])[1]} `;

async function quarantinedFirst(name: string, config: Record<string, unknown> = {}) {
  const path = join(dir, name);
  const strategy = new ProbeStrategy({ ...CONFIG, ...config } as never);
  const { membrane, requests } = summarizer();
  const manager = await ContextManager.open({ path, strategy, membrane });
  for (let i = 0; i < 24; i++) {
    manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `${i === 0 ? `${MARK} ` : ''}raw-${i} ${'substantive '.repeat(12)}` }]);
  }
  await manager.compile();
  const chunks = strategy.closedChunks();
  assert.ok(chunks.length >= 4, `premise: four closed chunks (${chunks.length})`);
  assert.ok(chunks[0]!.messages.some((m) => JSON.stringify(m.content).includes(MARK)), 'premise: the first chunk carries the mark');
  assert.ok(chunks.slice(1).every((c) => !c.messages.some((m) => JSON.stringify(m.content).includes(MARK))), 'premise: no later chunk carries it');
  const ctx = context(manager);
  await strategy.run(chunks[0]!, ctx);
  assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'premise: the first chunk was refused into the quarantine');
  assert.ok(!chunks[0]!.compressed, 'premise: the first chunk stays raw');
  const spanIds = chunks[0]!.messages.map((m) => m.id);
  const spanTexts = chunks[0]!.messages.map((m) => label(m.content));
  return { path, strategy, manager, ctx, chunks, requests, spanIds, spanTexts };
}

async function reopenedWithHead(fx: Awaited<ReturnType<typeof quarantinedFirst>>, config: Record<string, unknown>) {
  await fx.manager.close();
  const strategy = new ProbeStrategy({ ...CONFIG, ...config, headWindowTokens: 150 } as never);
  const { membrane, requests } = summarizer();
  const manager = await ContextManager.open({ path: fx.path, strategy, membrane });
  await manager.compile();
  const chunks = strategy.closedChunks();
  assert.deepEqual(chunks[0]!.messages.map((m) => m.id), fx.spanIds, 'premise: the span is still the first chunk');
  assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'premise: and still quarantined');
  const ctx = context(manager);
  const all = ctx.messageStore.getAll();
  const at = (id: string) => all.findIndex((m) => m.id === id);
  const head = strategy.head(ctx.messageStore, at(chunks[1]!.messages[0]!.id));
  const marked = at(fx.spanIds[0]!);
  assert.ok(head.start <= marked && marked < head.end, `premise: the head window as of the second chunk holds the span's marked message ([${head.start},${head.end}) at ${marked})`);
  return { strategy, manager, ctx, chunks, requests };
}

describe('a quarantined span and the requests after it', () => {
  it("a later chunk's request leaves out the quarantined span, and the chunk compresses on its first call", async () => {
    const fx = await quarantinedFirst('later-chunk');
    const before = fx.requests.length;
    await fx.strategy.run(fx.chunks[1]!, fx.ctx);
    const sent = fx.requests.slice(before);
    assert.equal(sent.length, 1, `the second chunk took one call (${sent.length})`);
    for (const text of fx.spanTexts) assert.ok(!sent[0]!.includes(text), `its request leaves out the quarantined span's ${text.trim()}`);
    assert.ok(fx.chunks[1]!.compressed, 'the second chunk compressed');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'and the quarantine still holds only the first');
    await fx.manager.close();
  });

  it("ticks compress and merge the chunks after the quarantined span, quarantine none of them, and send it in no request", async () => {
    const fx = await quarantinedFirst('merge', { mergeThreshold: 2, hierarchical: true });
    const before = fx.requests.length;
    for (let i = 0; i < 30; i++) await fx.strategy.tick(fx.ctx);
    const after = fx.strategy.closedChunks();
    const compressed = after.map((c) => (c.compressed ? 1 : 0)).join('');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, `the quarantine still holds only the first chunk (compressed: ${compressed})`);
    assert.ok(!fx.strategy.queued(fx.ctx.messageStore), `no compression work is left queued (compressed: ${compressed})`);
    assert.ok(after[1]!.compressed, `the chunk after the span compressed (compressed: ${compressed})`);
    const sent = fx.requests.slice(before);
    for (const request of sent) for (const text of fx.spanTexts) assert.ok(!request.includes(text), `a request leaves out ${text.trim()}`);
    assert.ok(fx.strategy.merged() > 0, `a merge landed (${JSON.stringify(fx.strategy.getStats())})`);
    await fx.manager.close();
  });

  it("a later chunk's request leaves out a quarantined span its head window has grown over, and the chunk compresses on its first call", async () => {
    const fx = await quarantinedFirst('later-chunk-head');
    const re = await reopenedWithHead(fx, {});
    await re.strategy.run(re.chunks[1]!, re.ctx);
    assert.equal(re.requests.length, 1, `the second chunk took one call (${re.requests.length})`);
    for (const text of fx.spanTexts) assert.ok(!re.requests[0]!.includes(text), `its request leaves out the quarantined span's ${text.trim()}`);
    assert.ok(re.chunks[1]!.compressed, 'the second chunk compressed');
    await re.manager.close();
  });

  it("a merge's request leaves out a quarantined span its head window has grown over, and the merge lands", async () => {
    const fx = await quarantinedFirst('merge-head', { hierarchical: true });
    for (const chunk of fx.chunks.slice(1)) await fx.strategy.run(chunk, fx.ctx);
    assert.ok(fx.chunks.slice(1).every((c) => c.compressed), 'every chunk after the span compressed');
    const re = await reopenedWithHead(fx, { hierarchical: true, mergeThreshold: 2 });
    for (let i = 0; i < 6; i++) await re.strategy.tick(re.ctx);
    assert.ok(re.requests.length > 0, 'a merge was asked');
    for (const request of re.requests) for (const text of fx.spanTexts) assert.ok(!request.includes(text), `a merge request leaves out ${text.trim()}`);
    assert.ok(re.strategy.merged() > 0, `a merge landed (${JSON.stringify(re.strategy.getStats())})`);
    await re.manager.close();
  });

  it("a quarantined chunk with one of its messages removed is still left out of the later chunks' requests, every message it has left", async () => {
    const fx = await quarantinedFirst('removal');
    const removed = fx.chunks[0]!.messages[1]!;
    assert.ok(!JSON.stringify(removed.content).includes(MARK), 'premise: the removed message is not the marked one');
    fx.manager.removeMessage(removed.id);
    await fx.manager.compile();
    const chunks = fx.strategy.closedChunks();
    assert.ok(chunks[0]!.messages.some((m) => JSON.stringify(m.content).includes(MARK)), 'premise: the first chunk still holds the marked message');
    const heldTexts = chunks[0]!.messages.map((m) => label(m.content));
    const laterTexts = chunks.slice(1).flatMap((c) => c.messages.map((m) => label(m.content)));
    const before = fx.requests.length;
    for (let i = 0; i < 12; i++) await fx.strategy.tick(context(fx.manager));
    const later = fx.requests.slice(before).filter((request) => laterTexts.some((text) => request.includes(text)));
    assert.ok(later.length > 0, 'premise: a later chunk was asked');
    for (const request of later) for (const text of heldTexts) assert.ok(!request.includes(text), `a later chunk's request leaves out the held chunk's ${text.trim()}`);
    assert.ok(fx.strategy.closedChunks()[1]!.compressed, 'the chunk after it compressed');
    await fx.manager.close();
  });

  it("a chunk quarantined while its request carried another chunk, quarantined later, compresses on its next attempt without it", async () => {
    const path = join(dir, 'earlier-shape');
    const strategy = new ProbeStrategy(CONFIG as never);
    const { membrane, requests } = summarizer();
    const manager = await ContextManager.open({ path, strategy, membrane });
    for (let i = 0; i < 24; i++) {
      manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `${i === 0 ? `${MARK} ` : ''}raw-${i} ${'substantive '.repeat(12)}` }]);
    }
    await manager.compile();
    const chunks = strategy.closedChunks();
    const ctx = context(manager);
    await strategy.run(chunks[1]!, ctx);
    assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'premise: the second chunk, its request carrying the first, was quarantined');
    await strategy.run(chunks[0]!, ctx);
    assert.equal(strategy.getCompressionQuarantineStatus().count, 2, 'premise: then the first was quarantined too');
    const spanTexts = chunks[0]!.messages.map((m) => label(m.content));
    const before = requests.length;
    await strategy.run(chunks[1]!, ctx);
    const sent = requests.slice(before);
    assert.equal(sent.length, 1, `the second chunk took one call (${sent.length})`);
    for (const text of spanTexts) assert.ok(!sent[0]!.includes(text), `its request leaves out the first chunk's ${text.trim()}`);
    assert.ok(chunks[1]!.compressed, 'the second chunk compressed');
    assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'and the quarantine holds only the first again');
    await manager.close();
  });

  it("with no tools declared, a later chunk whose only tool blocks before it are in a quarantined chunk counts as queued work, and compresses", async () => {
    const path = join(dir, 'tools');
    const first = new ProbeStrategy(CONFIG as never);
    const one = summarizer();
    const declared = await ContextManager.open({ path, strategy: first, membrane: one.membrane });
    declared.setToolDefinitions([{ name: 'probe', description: 'probe', inputSchema: { type: 'object', properties: {} } }]);
    declared.addMessage('Claude', [{ type: 'text', text: `${MARK} raw-0 ${'substantive '.repeat(12)}` }, { type: 'tool_use', id: 'call-1', name: 'probe', input: {} } as ContentBlock]);
    declared.addMessage('User', [{ type: 'tool_result', toolUseId: 'call-1', content: `raw-1 ${'substantive '.repeat(12)}` } as ContentBlock]);
    for (let i = 2; i < 24; i++) {
      declared.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
    }
    await declared.compile();
    const firstChunks = first.closedChunks();
    assert.ok(firstChunks[0]!.messages.some((m) => m.content.some((b) => b.type === 'tool_use')), 'premise: the first chunk holds the tool call');
    assert.ok(firstChunks.slice(1).every((c) => !c.messages.some((m) => m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result'))), 'premise: no later chunk holds a tool block');
    await first.run(firstChunks[0]!, context(declared));
    assert.equal(first.getCompressionQuarantineStatus().count, 1, 'premise: the first chunk was refused into the quarantine');
    await declared.close();
    const strategy = new ProbeStrategy(CONFIG as never);
    const { membrane, requests } = summarizer();
    const manager = await ContextManager.open({ path, strategy, membrane });
    await manager.compile();
    const ctx = context(manager);
    assert.ok(!(ctx.tools?.length), 'premise: no tools are declared');
    assert.ok(strategy.queued(ctx.messageStore), 'a later chunk counts as queued compression work');
    const chunks = strategy.closedChunks();
    await strategy.run(chunks[1]!, ctx);
    assert.equal(requests.length, 1, `the second chunk took one call (${requests.length})`);
    assert.ok(chunks[1]!.compressed, 'the second chunk compressed');
    await manager.close();
  });

  it("a message no summary covers and no quarantine holds still goes out in a later chunk's raw middle", async () => {
    const strategy = new ProbeStrategy(CONFIG as never);
    const { membrane, requests } = summarizer();
    const manager = await ContextManager.open({ path: join(dir, 'unquarantined'), strategy, membrane });
    for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
    await manager.compile();
    const chunks = strategy.closedChunks();
    assert.ok(chunks.length >= 2, 'premise: two closed chunks');
    await strategy.run(chunks[1]!, context(manager));
    assert.equal(strategy.getCompressionQuarantineStatus().count, 0, 'premise: nothing is quarantined');
    assert.ok(!chunks[0]!.compressed, 'premise: the first chunk is raw');
    for (const m of chunks[0]!.messages) {
      const text = label(m.content);
      assert.ok(requests[0]!.includes(text), `the second chunk's request carries the first chunk's ${text.trim()}`);
    }
    await manager.close();
  });

  it("once the quarantine is cleared, the span is back in a later chunk's raw middle", async () => {
    const fx = await quarantinedFirst('cleared');
    await fx.strategy.clearCompressionRefusalQuarantine();
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, 'premise: the clear emptied the quarantine');
    const before = fx.requests.length;
    await fx.strategy.run(fx.chunks[1]!, fx.ctx);
    const first = fx.requests[before];
    assert.ok(first !== undefined, 'the second chunk asked');
    for (const text of fx.spanTexts) assert.ok(first.includes(text), `its first request carries the span's ${text.trim()} again`);
    await fx.manager.close();
  });
});
