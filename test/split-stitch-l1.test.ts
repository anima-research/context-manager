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
function cumulativeMembrane(opts: { refuseAt: number; alwaysRefuse?: string; throwOn?: string }) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        const targets = texts(request).filter((t) => /^raw-\d+ /.test(t));
        if (opts.throwOn !== undefined && targets.length === 1 && targets[0]!.startsWith(opts.throwOn)) throw new Error('transport-down');
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
  attempted() { return (this as unknown as { lastSplitAttempted?: { calls: number; refused: number; errors: number; inputTokens: number; outputTokens: number; complete: boolean } }).lastSplitAttempted; }
  entries(): SummaryEntry[] { return (this as unknown as { summaries: SummaryEntry[] }).summaries; }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

async function build(membrane: unknown, opts: { split?: boolean; placeholder?: boolean; n?: number; toolRound?: boolean; windowCap?: number; participant2?: string; spoof2?: string } = {}) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
    compressionSplitFallback: opts.split, compressionSplitPlaceholder: opts.placeholder,
    ...(opts.windowCap !== undefined ? { compressionSplitMaxCallsPer10Min: opts.windowCap } : {}),
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  const n = opts.n ?? 4;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    if (opts.toolRound && i === 1) { ids.push(manager.addMessage('Claude', [text(`raw-${i} ` + 'substantive '.repeat(12)), { type: 'tool_use', id: 'tu-1', name: 'look', input: {} } as ContentBlock])); continue; }
    if (opts.toolRound && i === 2) { ids.push(manager.addMessage('User', [{ type: 'tool_result', tool_use_id: 'tu-1', content: [text('result')] } as unknown as ContentBlock, text(`raw-${i} ` + 'substantive '.repeat(12))])); continue; }
    if (i === 2 && (opts.participant2 || opts.spoof2)) { ids.push(manager.addMessage(opts.participant2 ?? 'User', [text(`raw-${i} ${opts.spoof2 ?? ''}` + 'substantive '.repeat(12))])); continue; }
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
  }
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
    const stitched = e.stitched as { parts: Array<{ range: [number, number]; kind: string }>; placeholders: unknown[]; calls: number };
    assert.ok(stitched, 'stitched metadata recorded');
    assert.equal(stitched.placeholders.length, 0);
    assert.equal(stitched.parts.length, 4, 'four single-message pieces (pairs refuse)');
    assert.equal(e.provenance?.stopReason, 'end_turn');
    assert.equal(e.provenance?.requestHash, (e.stitched as { compositeHash: string }).compositeHash, 'provenance requestHash = composite hash');
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
    const stitched = e.stitched as { parts: Array<{ kind: string }>; placeholders: Array<{ messageId: string }> };
    assert.deepEqual(stitched.placeholders.map((p) => p.messageId), [on.ids[2]], 'placeholder names the refusing message id');
    assert.ok(e.content.includes(`message id ${on.ids[2]}`), 'placeholder text names the id');
    assert.equal(stitched.parts.filter((p) => p.kind === 'fold').length, 3);
  });

  it('records content/response/composite hashes on the stitched entry', async () => {
    const fx = await build(cumulativeMembrane({ refuseAt: 2 }).membrane, { split: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const e = fx.strategy.entries()[0]!;
    const st = e.stitched as { contentHash: string; compositeHash: string; parts: Array<{ requestHash?: string; responseContentHash?: string; contentHash: string }> };
    const { createHash } = await import('node:crypto');
    const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    assert.equal(st.contentHash, sha(e.content), 'contentHash is the SHA-256 of the installed content');
    assert.equal(e.provenance?.requestHash, st.compositeHash, 'provenance requestHash is the composite hash');
    for (const p of st.parts) { assert.ok(p.contentHash); assert.ok(p.requestHash); assert.ok(p.responseContentHash); }
    const att = (e.stitched as { attempted: { calls: number; refused: number; inputTokens: number; outputTokens: number } }).attempted;
    assert.ok(att.calls >= 4 && att.refused >= 1, 'attempted spend includes refused leaves');
    assert.ok(att.inputTokens > 0);
  });

  it('a whole-chunk tool round is indivisible: refused pair installs nothing and sends no sub-request', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 1 }); // refuse everything
    const fx = await build(membrane, { split: true, placeholder: true, n: 3, toolRound: true });
    // chunk = [raw-0 user][raw-1 assistant + tool_use][raw-2 tool_result]; only lawful cut is after raw-0
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(fx.strategy.entries().length, 0, 'nothing installed');
    const subs = calls.filter((c) => texts(c).filter((t) => /^raw-\d+ /.test(t)).length < 3);
    // sub-requests may cover [raw-0] and [raw-1..raw-2]; never [raw-1] or [raw-2] alone
    for (const c of subs) {
      const t = texts(c).filter((x) => /^raw-\d+ /.test(x)).map((x) => x.split(' ')[0]);
      assert.ok(!(t.length === 1 && (t[0] === 'raw-1' || t[0] === 'raw-2')), `tool round split apart: ${t.join(',')}`);
    }
  });

  it('a provider error on a sub-request aborts the rung: nothing installed, no further sub-calls', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 2, throwOn: 'raw-1' });
    const fx = await build(membrane, { split: true, placeholder: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(fx.strategy.entries().length, 0, 'nothing installed after a transport error');
    const subs = calls.filter((c) => texts(c).filter((t) => /^raw-\d+ /.test(t)).length < 4);
    const idx = subs.findIndex((c) => texts(c).some((t) => t.startsWith('raw-1 ')) && texts(c).filter((t) => /^raw-\d+ /.test(t)).length === 1);
    assert.ok(idx >= 0, 'the erroring sub-request was attempted');
    assert.equal(subs.length, idx + 1, 'no sub-request after the error');
    const att = fx.strategy.attempted()!;
    assert.equal(att.calls, subs.length, 'attempted.calls counts the thrown sub-call too');
    assert.equal(att.errors, 1);
    assert.equal(att.complete, false);
  });

  it('per-window call cap aborts the rung and installs nothing', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 2 });
    const fx = await build(membrane, { split: true, placeholder: true, windowCap: 2 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(fx.strategy.entries().length, 0, 'nothing installed under the cap');
    const subs = calls.filter((c) => texts(c).filter((t) => /^raw-\d+ /.test(t)).length < 4);
    assert.equal(subs.length, 2, 'exactly the capped number of sub-calls');
  });

  it('placeholder is structurally marked as operator-authored and its text says so', async () => {
    const fx = await build(cumulativeMembrane({ refuseAt: 2, alwaysRefuse: 'raw-2' }).membrane, { split: true, placeholder: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const e = fx.strategy.entries()[0]!;
    const st = e.stitched as { placeholders: Array<{ messageId: string; author: string; text: string; contentHash: string }> };
    assert.equal(st.placeholders.length, 1);
    assert.equal(st.placeholders[0]!.author, 'operator:compressionSplitPlaceholder');
    assert.ok(st.placeholders[0]!.text.startsWith('[Operator note — not the resident\'s words: one preserved message'));
    assert.ok(!st.placeholders[0]!.text.includes('one line'), 'no false "one line" claim');
    assert.ok(e.content.includes(st.placeholders[0]!.text));
  });

  it('crash after summary append but before the chunk record is marked: reopen adopts, no duplicate mint, no extra calls', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 2 });
    const fx = await build(membrane, { split: true });
    // simulate the crash seam: markChunkRecordCompressed throws after pushSummary persisted the entry
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(fx.strategy)) as { markChunkRecordCompressed: (...a: unknown[]) => void };
    const original = proto.markChunkRecordCompressed;
    proto.markChunkRecordCompressed = function () { throw new Error('simulated crash after append'); };
    let threw = false;
    try { await fx.strategy.run(fx.target, managerContext(fx.manager)); } catch { threw = true; } finally { proto.markChunkRecordCompressed = original; }
    assert.ok(threw, 'crash surfaced');
    assert.equal(fx.strategy.entries().length, 1, 'the appended entry is persisted once');
    const callsBefore = calls.length;
    // "reopen": a fresh strategy over the same store must adopt the persisted L1 without new provider calls
    const path = (fx.manager as unknown as { store: { path?: string } }).store.path;
    await fx.manager.close();
    const strategy2 = new ProbeStrategy({ compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true, compressionSplitFallback: true } as never);
    const manager2 = await ContextManager.open({ path: path ?? paths[paths.length - 1]!, strategy: strategy2, membrane: membrane as never });
    const all = managerContext(manager2).messageStore.getAll();
    const target2: Chunk = { index: 7, startIndex: 0, endIndex: 4, messages: all.filter((m) => fx.ids.includes(m.id)), tokens: 100, compressed: false };
    await strategy2.run(target2, managerContext(manager2));
    assert.equal(calls.length, callsBefore, 'no provider calls on reopen: exact L1 adopted');
    assert.equal(strategy2.entries().filter((x) => x.sourceIds.join(':') === fx.ids.join(':')).length, 1, 'exactly one L1 over these sources');
    assert.ok(target2.compressed, 'chunk marked compressed by adoption');
    await manager2.close();
  });

  it('a second attempt over the same sources after a committed stitch adopts instead of minting again', async () => {
    const { calls, membrane } = cumulativeMembrane({ refuseAt: 2 });
    const fx = await build(membrane, { split: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const n = calls.length;
    const again: Chunk = { ...fx.target, compressed: false, summaryId: undefined };
    await fx.strategy.run(again, managerContext(fx.manager));
    assert.equal(calls.length, n, 'no new provider calls');
    assert.equal(fx.strategy.entries().length, 1, 'still exactly one entry');
  });

  it('placeholder author is structural: a spoofed "Alice:" in the text is ignored; a real participant is used; generic roles are omitted', async () => {
    const spoof = await build(cumulativeMembrane({ refuseAt: 2, alwaysRefuse: 'raw-2' }).membrane, { split: true, placeholder: true, spoof2: 'Alice: ' });
    await spoof.strategy.run(spoof.target, managerContext(spoof.manager));
    const e1 = spoof.strategy.entries()[0]!; const p1 = (e1.stitched as { placeholders: Array<{ text: string }> }).placeholders[0]!;
    assert.ok(!p1.text.includes('Alice'), 'quoted/spoofed author never attributed');
    assert.ok(p1.text.includes('one preserved message at this point'), 'generic role → author omitted');
    const real = await build(cumulativeMembrane({ refuseAt: 2, alwaysRefuse: 'raw-2' }).membrane, { split: true, placeholder: true, participant2: 'Sill5' });
    await real.strategy.run(real.target, managerContext(real.manager));
    const e2 = real.strategy.entries()[0]!; const p2 = (e2.stitched as { placeholders: Array<{ text: string }> }).placeholders[0]!;
    assert.ok(p2.text.includes('one preserved message from Sill5 at this point'), 'structural participant used');
  });

  it('synthetic details are aggregate, not a copy of the last leaf', async () => {
    const fx = await build(cumulativeMembrane({ refuseAt: 2 }).membrane, { split: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const att = fx.strategy.attempted()!;
    assert.equal(att.complete, true);
    assert.ok(att.calls >= 4 && att.inputTokens === att.calls * 100, 'attempted input sums every sub-call at 100 each');
  });
});
