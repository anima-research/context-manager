import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

// Split-stitch rung (compressionSplitFallback, 2026-09-05, princess): when every L1
// rung is refused, the chunk is folded in halves at message boundaries and the pieces
// are installed as ONE L1 over the chunk. The scripted membrane below refuses any
// request carrying two or more target messages and folds a single message cleanly,
// which is the cumulative-content refusal shape observed on Bedrock/Sonnet-4.5.

const BASE = './test-split-stitch-l1';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
function cleanup(): void { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); }
function text(t: string): ContentBlock { return { type: 'text', text: t }; }
function texts(req: NormalizedRequest): string[] {
  return req.messages.flatMap((m) => m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text));
}

/** Refuses when >= `refuseAt` target messages are present; optionally refuses one message forever. */
function cumulativeMembrane(opts: { refuseAt: number; alwaysRefuse?: string }) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        const targets = texts(request).filter((t) => /^raw-\d+ /.test(t));
        const refuse = targets.length >= opts.refuseAt || (opts.alwaysRefuse !== undefined && targets.some((t) => t.startsWith(opts.alwaysRefuse!)));
        if (refuse) {
          return { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
            raw: { response: { stop_details: { category: 'bio' } } } };
        }
        const which = targets.map((t) => t.split(' ')[0]).join('+');
        return { content: [text(`piece:${which}`)], rawAssistantText: `piece:${which}`, toolCalls: [], toolResults: [], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, details: {}, raw: { response: {} } };
      },
    } as never,
  };
}

class ProbeStrategy extends AutobiographicalStrategy {
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  entries(): SummaryEntry[] { return (this as unknown as { summaries: SummaryEntry[] }).summaries; }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

async function build(membrane: unknown, opts: { split?: boolean; placeholder?: boolean; n?: number } = {}) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
    compressionSplitFallback: opts.split, compressionSplitPlaceholder: opts.placeholder,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  const n = opts.n ?? 4;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
  const all = managerContext(manager).messageStore.getAll();
  const targetMessages = all.filter((m) => ids.includes(m.id));
  const target: Chunk = { index: 7, startIndex: 0, endIndex: n, messages: targetMessages, tokens: 100, compressed: false };
  return { manager, strategy, ids, target };
}

describe('split-stitch L1 fallback', () => {
  after(cleanup);

  it('OFF by default: a fully refused chunk installs nothing (quarantine path)', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 2 });
    const fx = await build(membrane, { split: false });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(fx.strategy.entries().length, 0, 'no summary installed');
    assert.ok(calls.every((c) => texts(c).filter((t) => /^raw-\d+ /.test(t)).length === 4), 'no sub-chunk requests were sent');
  });

  it('ON: refused chunk is folded in halves and installed as ONE L1 over the whole chunk', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 2 });
    const fx = await build(membrane, { split: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const entries = fx.strategy.entries();
    assert.equal(entries.length, 1, 'exactly one stitched L1');
    const e = entries[0]!;
    assert.deepEqual(e.sourceIds, fx.ids, 'owns the chunk\'s full contiguous range');
    assert.equal(e.sourceRange.first, fx.ids[0]); assert.equal(e.sourceRange.last, fx.ids[3]);
    for (const i of [0, 1, 2, 3]) assert.ok(e.content.includes(`piece:raw-${i}`), `piece for raw-${i} present in order`);
    assert.ok(e.content.indexOf('piece:raw-0') < e.content.indexOf('piece:raw-3'), 'pieces in chronological order');
    const stitched = e.stitched as { parts: Array<{ range: [number, number]; kind: string }>; placeholders: string[]; calls: number };
    assert.ok(stitched, 'stitched metadata recorded');
    assert.equal(stitched.placeholders.length, 0);
    assert.equal(stitched.parts.length, 4, 'four single-message pieces (pairs refuse)');
    assert.equal(e.provenance?.stopReason, 'end_turn');
    assert.ok(String(e.provenance?.requestHash).startsWith('stitched:'));
    // sub-requests are source-only shaped: marker + target subset + directive, no recall pairs
    const sub = calls.find((c) => texts(c).filter((t) => /^raw-\d+ /.test(t)).length === 1)!;
    assert.ok(texts(sub).some((t) => t.includes('You will soon form a new memory')), 'marker present on sub-request');
    assert.ok(!texts(sub).some((t) => /^\[CM\] Recall memory/.test(t)), 'no recall pairs on sub-request');
  });

  it('single message that refuses alone: placeholder only when compressionSplitPlaceholder is on', async () => {
    const off = await build(cumulativeMembrane({ refuseAt: 2, alwaysRefuse: 'raw-2' }).membrane, { split: true, placeholder: false });
    await off.strategy.run(off.target, managerContext(off.manager));
    assert.equal(off.strategy.entries().length, 0, 'without placeholder the chunk falls through to quarantine');

    const on = await build(cumulativeMembrane({ refuseAt: 2, alwaysRefuse: 'raw-2' }).membrane, { split: true, placeholder: true });
    await on.strategy.run(on.target, managerContext(on.manager));
    const e = on.strategy.entries()[0]!;
    assert.ok(e, 'stitched L1 installed with a placeholder');
    const stitched = e.stitched as { parts: Array<{ kind: string }>; placeholders: string[] };
    assert.deepEqual(stitched.placeholders, [on.ids[2]], 'placeholder names the refusing message id');
    assert.ok(e.content.includes(`message id ${on.ids[2]}`), 'placeholder text names the id');
    assert.equal(stitched.parts.filter((p) => p.kind === 'fold').length, 3);
  });
});
