import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

// Residence-scoped source-only L1 compression (2026-08-25).
// The discriminator test below proves the wiring is load-bearing: with
// compressionSourceOnly on, the built L1 request contains ONLY the marker +
// target chunk + directive. Delete the `!sourceOnly` guards in
// compressChunkHierarchical and the head/recall reappear — this test fails.

const BASE = './test-source-only-l1';
const MARKER_SUBSTR = 'You will soon form a new memory';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
function cleanup(): void { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); }

function text(t: string): ContentBlock { return { type: 'text', text: t }; }

function capturingMembrane(stopReason: 'end_turn' | 'refusal' = 'end_turn') {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        if (stopReason === 'refusal') {
          return { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
            raw: { response: { stop_details: { category: 'cyber' } } } };
        }
        return { content: [text('memory body')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
      },
    } as never,
  };
}

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  runMerge(level: number, sourceIds: string[], ctx: StrategyContext): Promise<void> {
    return (this as unknown as { executeMerge(l: number, ids: string[], c: StrategyContext): Promise<void> })
      .executeMerge(level, sourceIds, ctx);
  }
}

function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

function summary(id: string, first: string, last: string, sourceIds: string[]): SummaryEntry {
  return { id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0, sourceIds, sourceRange: { first, last }, created: Number(id.replace(/\D/g, '')) || 1 };
}

function texts(req: NormalizedRequest): string[] {
  return req.messages.flatMap((m) => m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text));
}
function recallIds(req: NormalizedRequest): string[] {
  return texts(req).flatMap((t) => { const m = /^\[CM\] Recall memory (.+)\.$/.exec(t); return m ? [m[1]!] : []; });
}
function blockTypes(req: NormalizedRequest): Set<string> {
  const s = new Set<string>(); for (const m of req.messages) for (const b of m.content) s.add(b.type); return s;
}

interface Opts { sourceOnly?: boolean; sourceOnlyFallback?: boolean; fallbackLimit?: number; mergeSourceOnly?: boolean; systemPrompt?: string; extraChunkBlocks?: ContentBlock[]; tools?: ToolDefinition[]; cacheMarkers?: boolean; }

async function build(membrane: unknown, opts: Opts = {}) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model',
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 100_000, // large head so section 1 has content when NOT source-only
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    compressionRefusalCurveFallbacks: opts.fallbackLimit ?? 3,
    compressionSourceOnly: opts.sourceOnly,
    compressionMergeSourceOnly: opts.mergeSourceOnly,
    compressionSourceOnlyFallback: opts.sourceOnlyFallback,
    compressionCacheMarkers: opts.cacheMarkers,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  if (opts.tools) manager.setToolDefinitions(opts.tools);
  if (opts.systemPrompt !== undefined) manager.setSystemPrompt(opts.systemPrompt);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
  // seed a live L1 summary over the earliest pair -> becomes a recall pair when NOT source-only
  strategy.seed(summary('L1-100', ids[0]!, ids[1]!, [ids[0]!, ids[1]!]));
  // target chunk = the last two messages (+ optional extra blocks e.g. tool cycle / marker quote)
  const all = managerContext(manager).messageStore.getAll();
  const targetMessages = all.filter((m) => [ids[10]!, ids[11]!].includes(m.id));
  if (opts.extraChunkBlocks) targetMessages[0]!.content = [...targetMessages[0]!.content, ...opts.extraChunkBlocks];
  const target: Chunk = { index: 999, startIndex: 10, endIndex: 12, messages: targetMessages, tokens: 100, compressed: false };
  return { manager, strategy, ids, target };
}

describe('source-only L1 compression', () => {
  after(cleanup);

  it('DISCRIMINATOR: sourceOnly builds only marker + target + directive (one call, no head, no recall)', async () => {
    const { calls, membrane } = capturingMembrane();
    const fx = await build(membrane, { sourceOnly: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls.length, 1, 'exactly one direct call (no refusal ladder)');
    const req = calls[0]!;
    assert.deepEqual(recallIds(req), [], 'NO recall pairs under source-only');
    assert.ok(texts(req).some((t) => t.includes(MARKER_SUBSTR)), 'compression marker present (structural)');
    assert.ok(texts(req).some((t) => /memory/i.test(t) && !t.includes(MARKER_SUBSTR)), 'write-memory directive present');
    for (const ct of ['raw-10', 'raw-11']) assert.ok(texts(req).some((t) => t.includes(ct)), `target chunk message ${ct} present`);
    // The load-bearing assertions — head + non-target raw are gone. Deleting the
    // `!sourceOnly` guards makes these fail (raw-0 head message reappears).
    assert.ok(!texts(req).some((t) => t.includes('raw-0 ')), 'head window ABSENT under source-only');
    assert.ok(!texts(req).some((t) => t.includes('raw-2 ')), 'non-target raw ABSENT under source-only');
  });

  it('LOAD-BEARING: default (sourceOnly off) DOES include head + recall', async () => {
    const { calls, membrane } = capturingMembrane();
    const fx = await build(membrane, { sourceOnly: false });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const req = calls[0]!;
    assert.ok(recallIds(req).length > 0, 'recall pairs present when flag off');
    // raw-2 is an uncovered head message (raw-0/raw-1 are covered by seeded L1-100
    // and render as a recall pair). Its presence proves the head is emitted when off.
    assert.ok(texts(req).some((t) => t.includes('raw-2 ')), 'raw head present when flag off');
  });

  it('NEGATIVE: a chunk that QUOTES the marker text does not break the structural build', async () => {
    const { calls, membrane } = capturingMembrane();
    // chunk contains the marker string as ordinary content — must not be treated as a boundary
    const fx = await build(membrane, { sourceOnly: true, extraChunkBlocks: [text(`quoting: ${MARKER_SUBSTR} inside chunk`)] });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const req = calls[0]!;
    assert.equal(calls.length, 1);
    assert.deepEqual(recallIds(req), [], 'still no recall despite marker quote');
    for (const ct of ['raw-10', 'raw-11']) assert.ok(texts(req).some((t) => t.includes(ct)), 'target chunk intact');
    assert.ok(!texts(req).some((t) => t.includes('raw-0 ')), 'head still absent (quote did not shift boundary)');
  });

  it('NEGATIVE: tools are KEPT and raw thinking is stripped under source-only', async () => {
    const tools: ToolDefinition[] = [{ name: 'demo', description: 'd', inputSchema: { type: 'object', properties: {} } } as never];
    const { calls, membrane } = capturingMembrane();
    // chunk carries a signed-thinking block + a paired tool cycle
    const fx = await build(membrane, {
      sourceOnly: true, tools,
      extraChunkBlocks: [
        { type: 'thinking', thinking: 'private', signature: 'sig' } as ContentBlock,
      ],
    });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const req = calls[0]!;
    assert.ok(Array.isArray(req.tools) && req.tools.length === 1, 'tools kept (reasoning_extraction guard)');
    assert.ok(!blockTypes(req).has('thinking'), 'raw thinking stripped from source-only request');
  });

  it('INVARIANT: primary compile is byte-identical with the flag on vs off', async () => {
    const a = await build(capturingMembrane().membrane, { sourceOnly: true });
    const b = await build(capturingMembrane().membrane, { sourceOnly: false });
    const reqA = await a.manager.compile({ maxTokens: 200_000, reserveForResponse: 16_000 });
    const reqB = await b.manager.compile({ maxTokens: 200_000, reserveForResponse: 16_000 });
    assert.equal(JSON.stringify(reqA.messages), JSON.stringify(reqB.messages), 'compile output unaffected by compressionSourceOnly');
  });

  it('BOUNDED: a source-only refusal makes exactly ONE call and quarantines (fail quiet, no storm)', async () => {
    const { calls, membrane } = capturingMembrane('refusal');
    const fx = await build(membrane, { sourceOnly: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    // Empty recall set -> buildRecallCurveVariants has no frontier to expand ->
    // no recall-expansion variants. Refusal (not tool_use) -> no no-tools/toolless
    // retry. Exactly one canonical call, then a normal quarantine.
    assert.equal(calls.length, 1, 'exactly one provider call — no fallback storm');
    assert.deepEqual(recallIds(calls[0]!), [], 'the one call carried no recall pairs');
    const q = fx.strategy.getCompressionQuarantineStatus();
    assert.ok(q.count >= 1, 'chunk family quarantined (normal receipt)');
  });


  it('FINAL FALLBACK: canonical runs first; one source-only call runs only after refusal', async () => {
    const calls: NormalizedRequest[] = []; let n = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request)); n++;
      return n === 1
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
        : { content: [text('fallback memory')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
    } } as never;
    const fx = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls.length, 2);
    assert.ok(recallIds(calls[0]!).length > 0);
    assert.ok(texts(calls[0]!).some((t) => t.includes('raw-2 ')));
    assert.deepEqual(recallIds(calls[1]!), []);
    assert.ok(!texts(calls[1]!).some((t) => t.includes('raw-2 ')));
    for (const ct of ['raw-10', 'raw-11']) assert.ok(texts(calls[1]!).some((t) => t.includes(ct)));
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
  });


  it('FINAL FALLBACK ORDER: configured recall variant runs before source-only', async () => {
    const calls: NormalizedRequest[] = []; let n = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request)); n++;
      return n < 3
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
        : { content: [text('source-only succeeds last')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
    } } as never;
    const fx = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 1 });
    const childA = summary('L1-300', fx.ids[4]!, fx.ids[5]!, [fx.ids[4]!, fx.ids[5]!]);
    const childB = summary('L1-301', fx.ids[6]!, fx.ids[7]!, [fx.ids[6]!, fx.ids[7]!]);
    childA.mergedInto = 'L2-302'; childB.mergedInto = 'L2-302';
    const parent: SummaryEntry = {
      id: 'L2-302', level: 2, content: 'authored parent', tokens: 20, sourceLevel: 1,
      sourceIds: ['L1-300', 'L1-301'], sourceRange: { first: fx.ids[4]!, last: fx.ids[7]! }, created: 302,
    };
    fx.strategy.seed(childA); fx.strategy.seed(childB); fx.strategy.seed(parent);
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls.length, 3, 'canonical, one recall variant, one source-only final');
    assert.ok(recallIds(calls[0]!).includes('L2-302'), 'canonical carries parent recall');
    assert.ok(recallIds(calls[1]!).includes('L1-300') && recallIds(calls[1]!).includes('L1-301'), 'variant expands parent to children');
    assert.deepEqual(recallIds(calls[2]!), [], 'source-only is strictly last');
    assert.ok(!texts(calls[2]!).some((t) => t.includes('raw-2 ')), 'source-only omits unrelated head');
  });

  it('FINAL FALLBACK: canonical success suppresses source-only', async () => {
    const { calls, membrane } = capturingMembrane('end_turn');
    const fx = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls.length, 1);
    assert.ok(recallIds(calls[0]!).length > 0);
  });

  it('FINAL FALLBACK: final refusal is bounded and quarantines', async () => {
    const { calls, membrane } = capturingMembrane('refusal');
    const fx = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls.length, 2);
    assert.ok(recallIds(calls[0]!).length > 0);
    assert.deepEqual(recallIds(calls[1]!), []);
    assert.ok(fx.strategy.getCompressionQuarantineStatus().count >= 1);
  });


  it('FINAL FALLBACK SHAPE: system/config/tools/messages equal legacy direct source-only', async () => {
    const tools: ToolDefinition[] = [{ name: 'demo', description: 'd', inputSchema: { type: 'object', properties: {} } } as never];
    const directCapture = capturingMembrane('end_turn');
    const direct = await build(directCapture.membrane, { sourceOnly: true, systemPrompt: 'resident identity', tools });
    await direct.strategy.run(direct.target, managerContext(direct.manager));

    const calls: NormalizedRequest[] = []; let n = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request)); n++;
      return n === 1
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
        : { content: [text('fallback memory')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
    } } as never;
    const fallback = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 0, systemPrompt: 'resident identity', tools });
    await fallback.strategy.run(fallback.target, managerContext(fallback.manager));
    assert.deepEqual(calls[1], directCapture.calls[0], 'final fallback is exact legacy source-only wire shape');
  });

  it('FINAL FALLBACK SHAPE: stale cache_control sanitation matches legacy direct source-only', async () => {
    const stale = { type: 'text', text: 'imported cache carrier', cache_control: { type: 'ephemeral' } } as never;
    for (const cacheMarkers of [true, false]) {
      const directCapture = capturingMembrane('end_turn');
      const direct = await build(directCapture.membrane, { sourceOnly: true, cacheMarkers, extraChunkBlocks: [stale] });
      await direct.strategy.run(direct.target, managerContext(direct.manager));

      const calls: NormalizedRequest[] = []; let n = 0;
      const membrane = { complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request)); n++;
        return n === 1
          ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
          : { content: [text('fallback memory')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
      } } as never;
      const fallback = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 0, cacheMarkers, extraChunkBlocks: [stale] });
      await fallback.strategy.run(fallback.target, managerContext(fallback.manager));
      assert.deepEqual(calls[1], directCapture.calls[0], `cache marker kill-switch=${cacheMarkers} preserves exact legacy wire shape`);
      const cacheControls = calls[1]!.messages.flatMap((m) => m.content).filter((b) => (b as { cache_control?: unknown }).cache_control !== undefined);
      assert.equal(cacheControls.length, cacheMarkers ? 0 : 1, cacheMarkers ? 'enabled sanitizer strips stale block cache_control' : 'kill switch preserves stale passthrough');
    }
  });

  it('FINAL FALLBACK: thinking-wrapped final output quarantines without a later canonical retry', async () => {
    const calls: NormalizedRequest[] = []; let n = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request)); n++;
      return n === 1
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
        : { content: [text('<thinking>only wrapper</thinking>')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
    } } as never;
    const fx = await build(membrane, { sourceOnlyFallback: true, fallbackLimit: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls.length, 2, 'no canonical/plain-prose request after source-only-final');
    assert.ok(fx.strategy.getCompressionQuarantineStatus().count >= 1, 'empty stripped final output quarantines');
  });

  it('FINAL FALLBACK FAMILY: enabling it invalidates old quarantine without manual clear', async () => {
    const path = freshPath();
    const cfg = (fallback: boolean) => ({
      compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000,
      autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: fallback,
    } as never);
    const refused = capturingMembrane('refusal');
    const s1 = new ProbeStrategy(cfg(false));
    const m1 = await ContextManager.open({ path, strategy: s1, membrane: refused.membrane as never });
    const ids: string[] = []; for (let i = 0; i < 12; i++) ids.push(m1.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
    s1.seed(summary('L1-100', ids[0]!, ids[1]!, [ids[0]!, ids[1]!]));
    const target1: Chunk = { index: 999, startIndex: 10, endIndex: 12, messages: managerContext(m1).messageStore.getAll().filter(m => [ids[10]!, ids[11]!].includes(m.id)), tokens: 100, compressed: false };
    await s1.run(target1, managerContext(m1));
    assert.ok(s1.getCompressionQuarantineStatus().count >= 1, 'old ladder quarantined');
    m1.close();

    const calls: NormalizedRequest[] = []; let n = 0;
    const membrane = { complete: async (request: NormalizedRequest) => { calls.push(structuredClone(request)); n++; return n === 1
      ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
      : { content: [text('fresh-family fallback')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } }; } } as never;
    const s2 = new ProbeStrategy(cfg(true));
    const m2 = await ContextManager.open({ path, strategy: s2, membrane });
    const target2: Chunk = { index: 999, startIndex: 10, endIndex: 12, messages: managerContext(m2).messageStore.getAll().filter(m => [ids[10]!, ids[11]!].includes(m.id)), tokens: 100, compressed: false };
    await s2.run(target2, managerContext(m2));
    assert.equal(calls.length, 2, 'new family ran canonical then final fallback without manual clear');
    m2.close();
  });


  it('FINAL FALLBACK FAMILY CAP: old-regime cap does not block new regime; new-regime cap remains sticky', async () => {
    const seedStore = async (path: string) => {
      const s = new ProbeStrategy({ compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0 } as never);
      const m = await ContextManager.open({ path, strategy: s, membrane: capturingMembrane('refusal').membrane as never });
      const ids: string[] = []; for (let i = 0; i < 12; i++) ids.push(m.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
      s.seed(summary('L1-100', ids[0]!, ids[1]!, [ids[0]!, ids[1]!])); m.close(); return ids;
    };
    const run = async (path: string, ids: string[], fallback: boolean, budget: number, outcomes: Array<'refusal'|'end_turn'>) => {
      const calls: NormalizedRequest[] = []; let n = 0;
      const membrane = { complete: async (request: NormalizedRequest) => { calls.push(structuredClone(request)); const outcome = outcomes[Math.min(n++, outcomes.length - 1)]!; return outcome === 'end_turn'
        ? { content: [text('memory')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } }
        : { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }; } } as never;
      const strategy = new ProbeStrategy({ compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0, compressionContextBudgetTokens: budget, compressionSourceOnlyFallback: fallback } as never);
      const manager = await ContextManager.open({ path, strategy, membrane });
      const target: Chunk = { index: 999, startIndex: 10, endIndex: 12, messages: managerContext(manager).messageStore.getAll().filter(m => [ids[10]!, ids[11]!].includes(m.id)), tokens: 100, compressed: false };
      await strategy.run(target, managerContext(manager)); const count = strategy.getCompressionQuarantineStatus().count; manager.close(); return { calls, count };
    };

    const oldPath = freshPath(); const oldIds = await seedStore(oldPath);
    for (const budget of [100_000, 101_000, 102_000]) await run(oldPath, oldIds, false, budget, ['refusal']);
    const fresh = await run(oldPath, oldIds, true, 100_000, ['refusal', 'end_turn']);
    assert.equal(fresh.calls.length, 2, 'fallback-enabled regime earns canonical + final despite old-regime cap');

    const newPath = freshPath(); const newIds = await seedStore(newPath);
    for (const budget of [100_000, 101_000, 102_000]) await run(newPath, newIds, true, budget, ['refusal', 'refusal']);
    const capped = await run(newPath, newIds, true, 103_000, ['refusal', 'refusal']);
    assert.equal(capped.calls.length, 0, 'fourth request shape in same fallback regime is suppressed by cap');
  });

  it('MERGE INVARIANT: executeMerge builds a byte-identical request with the flag on vs off', async () => {
    async function mergeReq(sourceOnly: boolean): Promise<NormalizedRequest> {
      const { calls, membrane } = capturingMembrane('end_turn');
      const fx = await build(membrane, { sourceOnly });
      // seed two adjacent L1s over uncovered messages, then merge them into an L2
      fx.strategy.seed(summary('L1-200', fx.ids[4]!, fx.ids[5]!, [fx.ids[4]!, fx.ids[5]!]));
      fx.strategy.seed(summary('L1-201', fx.ids[6]!, fx.ids[7]!, [fx.ids[6]!, fx.ids[7]!]));
      await fx.strategy.runMerge(2, ['L1-200', 'L1-201'], managerContext(fx.manager));
      assert.ok(calls.length >= 1, 'merge issued a request');
      return calls[0]!;
    }
    const on = await mergeReq(true);
    const off = await mergeReq(false);
    assert.equal(JSON.stringify(on), JSON.stringify(off), 'merge request identical regardless of compressionSourceOnly');
  });

  it('MERGE FINAL FALLBACK: last persisted attempt matches legacy target-only wire shape', async () => {
    async function mergeReq(mode: 'ordinary' | 'legacy' | 'final', attempts: number): Promise<NormalizedRequest> {
      const { calls, membrane } = capturingMembrane('end_turn');
      const strategy = new ProbeStrategy({ compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, mergeAttemptLimit: 5, compressionMergeSourceOnly: mode === 'legacy', compressionMergeSourceOnlyFallback: mode === 'final' } as never);
      const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
      manager.setSystemPrompt('resident identity');
      const ids: string[] = []; for (let i = 0; i < 12; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
      strategy.seed(summary('L1-200', ids[4]!, ids[5]!, [ids[4]!, ids[5]!])); strategy.seed(summary('L1-201', ids[6]!, ids[7]!, [ids[6]!, ids[7]!]));
      const sourceIds = ['L1-200', 'L1-201'];
      (strategy as unknown as { mergeQueue: unknown[] }).mergeQueue = [{ level: 2, sourceIds, attempts }];
      await strategy.runMerge(2, sourceIds, managerContext(manager)); assert.equal(calls.length, 1); return calls[0]!;
    }
    const legacy = await mergeReq('legacy', 0);
    const final = await mergeReq('final', 4);
    const beforeFinal = await mergeReq('final', 3);
    assert.deepEqual(final, legacy, 'terminal merge fallback equals legacy target-only wire shape');
    assert.notDeepEqual(beforeFinal, legacy, 'merge remains canonical/recall-aware before final persisted attempt');
  });

});


describe('source-only hierarchical merge', () => {
  after(cleanup);

  async function mergeRequest(mergeSourceOnly: boolean, tools: ToolDefinition[] = []): Promise<NormalizedRequest> {
    const { calls, membrane } = capturingMembrane('end_turn');
    const fx = await build(membrane, { sourceOnly: false, mergeSourceOnly, tools });
    fx.strategy.seed(summary('L1-200', fx.ids[4]!, fx.ids[5]!, [fx.ids[4]!, fx.ids[5]!]));
    fx.strategy.seed(summary('L1-201', fx.ids[6]!, fx.ids[7]!, [fx.ids[6]!, fx.ids[7]!]));
    await fx.strategy.runMerge(2, ['L1-200', 'L1-201'], managerContext(fx.manager));
    assert.equal(calls.length, 1);
    return calls[0]!;
  }

  it('DISCRIMINATOR: merge source-only keeps exact target + directive + tools, omits unrelated autobiography', async () => {
    const tools: ToolDefinition[] = [{ name: 'demo', description: 'd', inputSchema: { type: 'object', properties: {} } } as never];
    const req = await mergeRequest(true, tools);
    assert.ok(Array.isArray(req.tools) && req.tools.length === 1, 'live tool catalog retained');
    for (const id of ['raw-4 ', 'raw-5 ', 'raw-6 ', 'raw-7 ']) {
      assert.ok(texts(req).some((t) => t.includes(id)), `target ${id} present`);
    }
    assert.ok(!texts(req).some((t) => t.includes('raw-2 ')), 'unrelated head absent');
    assert.ok(!texts(req).some((t) => t.includes('raw-8 ')), 'unrelated raw middle/tail absent');
    assert.deepEqual(recallIds(req), [], 'no unrelated prior recalls in L2 raw expansion');
    assert.ok(texts(req).some((t) => t.includes('Attribution discipline: preserve who made each claim.')), 'attribution guard present');
  });

  it('LOAD-BEARING: default merge path still contains autobiographical prefix and no attribution guard', async () => {
    const req = await mergeRequest(false);
    assert.ok(texts(req).some((t) => t.includes('raw-2 ')) || recallIds(req).length > 0, 'ordinary merge prefix retained');
    assert.ok(!texts(req).some((t) => t.includes('Attribution discipline: preserve who made each claim.')), 'ordinary merge bytes unchanged');
  });

  it('INVARIANT: primary compile is byte-identical with merge source-only on vs off', async () => {
    const a = await build(capturingMembrane().membrane, { mergeSourceOnly: true });
    const b = await build(capturingMembrane().membrane, { mergeSourceOnly: false });
    const reqA = await a.manager.compile({ maxTokens: 200_000, reserveForResponse: 16_000 });
    const reqB = await b.manager.compile({ maxTokens: 200_000, reserveForResponse: 16_000 });
    assert.equal(JSON.stringify(reqA.messages), JSON.stringify(reqB.messages));
  });
});
