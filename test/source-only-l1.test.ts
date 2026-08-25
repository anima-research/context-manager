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

interface Opts { sourceOnly?: boolean; mergeSourceOnly?: boolean; extraChunkBlocks?: ContentBlock[]; tools?: ToolDefinition[]; }

async function build(membrane: unknown, opts: Opts = {}) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model',
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 100_000, // large head so section 1 has content when NOT source-only
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 3,
    compressionSourceOnly: opts.sourceOnly,
    compressionMergeSourceOnly: opts.mergeSourceOnly,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  if (opts.tools) manager.setToolDefinitions(opts.tools);
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
