/**
 * What a compile sends after a head-window reset, under every select.
 *
 * - While the reset head fills (its window reaches the store's end), the
 *   compile sends store order: the history before the head, then the head, so
 *   the newest message is the last one sent and the history keeps its place
 *   at the front of the request.
 * - Once a body no longer fits, the head goes first again: the transition and
 *   the new topic's opening, then the history, then the rest.
 * - After a reset the head holds whole bodies: the transition's body always,
 *   then whole bodies while they fit, ending before a call's body rather than
 *   between a call and its result. A body that doesn't fit is sent whole
 *   after the history, unless the ratchet guard below keeps part of it.
 * - The ratchet guard's extension leaves out the pinned run at its end, from a
 *   body's start, back to the last message holding a tool result: a pinned
 *   message it could take whole, a pinned call, or the never-chunked first
 *   part of a message marked after its rest was chunked. A pinned call left
 *   out goes after the history ahead of its result, if any. It
 *   keeps a body's never-chunked first part that no pin holds, so that part
 *   isn't chunked out of order, and the pinned messages from the last one
 *   holding a tool result back, as without a reset (where the head can then
 *   end inside a body).
 * - Without a reset (headStart 0) the head still ends where its tokens run out,
 *   with the ratchet guard as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';

const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };
const words = (label: string, n: number): ContentBlock[] =>
  [{ type: 'text', text: `${label} ${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}` }];
const KVU = {
  policy: { alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10, cacheLambda: 1, cacheScale: 1000,
    cacheReadPrice: 0.1, cacheWritePrice: 1.25, continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000,
    continuityRecencyFloor: 0.2, continuityStableHalfLife: 10, continuityStableFloor: 0.25 },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};
const base = { headWindowTokens: 4000, recentWindowTokens: 1000, imageStripDepthTokens: 0, compressionModel: 'test-model' };
const SELECTS: Record<string, () => AutobiographicalStrategy> = {
  hierarchical: () => new AutobiographicalStrategy({ ...base, hierarchical: true }),
  adaptive: () => new AutobiographicalStrategy({ ...base, hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1500 }),
  'kv-unified': () => new AutobiographicalStrategy({ ...base, hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1500,
    foldingStrategy: 'kv-unified', kvUnified: { ...KVU, policy: { ...KVU.policy } } } as never),
};

type Sent = { participant: string; content: ContentBlock[] };
const textOf = (m: Sent): string =>
  m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
/** Each entry by its first word, the transition as TT, with its text's length. */
const label = (m: Sent): string => {
  const text = textOf(m);
  return text.startsWith('[Topic Transition]') ? 'TT' : text.split(' ')[0]!;
};
const H = ['hist0', 'hist1', 'hist2', 'hist3', 'hist4', 'hist5'];

async function withStore(make: () => AutobiographicalStrategy, body: (m: ContextManager) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reset-fill-order-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make() });
  try {
    await body(manager);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Six history messages, all raw, and one compile before the reset. */
async function history(m: ContextManager): Promise<Sent[]> {
  for (let i = 0; i < 6; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
  return (await m.compile(BUDGET)).messages as unknown as Sent[];
}
const sent = async (m: ContextManager): Promise<string[]> => ((await m.compile(BUDGET)).messages as unknown as Sent[]).map(label);

describe('what a compile sends after a head-window reset', () => {
  for (const [name, make] of Object.entries(SELECTS)) {
    describe(name, () => {
      it('sends store order while the head fills, the newest message last, then the head first once it is full', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          assert.deepStrictEqual(await sent(m), [...H, 'TT']);
          const after1 = m.addMessage('user', words('after1', 5));
          m.addMessage('assistant', words('after2', 5));
          assert.deepStrictEqual(await sent(m), [...H, 'TT', 'after1', 'after2']);
          m.addMessage('user', words('batch1', 5));
          m.addMessage('user', words('batch2', 5));
          assert.deepStrictEqual(await sent(m), [...H, 'TT', 'after1', 'after2', 'batch1', 'batch2']);
          // 400-word messages: the head holds three of them after the short
          // ones, and a fourth ends the fill (below).
          for (let i = 0; i < 3; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`new${i}`, 400));
          const filling = (await m.compile(BUDGET)).messages as unknown as Sent[];
          assert.deepStrictEqual(filling.slice(-4).map(label), ['batch2', 'new0', 'new1', 'new2']);
          // The head is now bigger than the recent window: it is still sent,
          // counted and rendered as the head, last.
          const stats = m.getRenderStats()!;
          assert.deepStrictEqual([stats.head.messages, stats.tail.messages], [8, 0], 'the filling head is counted as the head');
          const [forAfter1] = m.renderAsNewest([after1])!;
          assert.deepStrictEqual(forAfter1, filling.find((x) => label(x) === 'after1')!.content, 'a filling head message renders as it is sent');
          m.addMessage('assistant', words('new3', 400));
          assert.deepStrictEqual(await sent(m), ['TT', 'after1', 'after2', 'batch1', 'batch2', 'new0', 'new1', 'new2', ...H, 'new3'],
            'once a body no longer fits, the head goes first, then the history, then the rest');
        }));

      it("the reset's own compile keeps the history's prefix and appends the transition", () =>
        withStore(make, async (m) => {
          const before = await history(m);
          await m.resetHeadWindow('A new topic.');
          const after = (await m.compile(BUDGET)).messages as unknown as Sent[];
          // The messages' bytes. Where the cache markers go, and so what an XML
          // formatter packs between them, is the marker placement's business.
          const bytes = (ms: Sent[]): string[] => ms.map((x) => JSON.stringify([x.participant, x.content]));
          assert.deepStrictEqual(bytes(after.slice(0, before.length)), bytes(before), 'the history is sent as it was before the reset');
          assert.deepStrictEqual(after.slice(before.length).map(label), ['TT']);
        }));

      it('keeps a transition bigger than the head window whole, at the front, once a message follows it', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow(textOf({ participant: '', content: words('transition', 4000) }));
          m.addMessage('user', words('after1', 5));
          const order = await sent(m);
          assert.deepStrictEqual(order, ['TT', ...H, 'after1']);
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          assert.ok(textOf(out[0]!).endsWith('word3999'), 'the transition is sent whole, in one entry');
        }));

      it('sends a first message that does not fit the head whole, after the history', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('longfirst', 4000));
          m.addMessage('assistant', words('reply', 5));
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          assert.deepStrictEqual(out.map(label), ['TT', ...H, 'longfirst', 'reply']);
          assert.ok(textOf(out[H.length + 1]!).endsWith('word3999'), 'the long message is sent whole, in one entry');
        }));

      it('keeps store order with a compression hold inside a filling head', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          const held = m.addMessage('user', words('after1', 5));
          m.addMessage('assistant', words('after2', 5));
          m.holdCompression([held], { timeoutMs: 60_000 });
          try {
            assert.deepStrictEqual(await sent(m), [...H, 'TT', 'after1', 'after2']);
          } finally {
            m.releaseCompression([held]);
          }
        }));

      it('keeps a tool call with its result when the result does not fit the head', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('ask', 5));
          m.addMessage('assistant', [{ type: 'text', text: 'call' }, { type: 'tool_use', id: 'c1', name: 'search', input: {} }]);
          m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c1', content: textOf({ participant: '', content: words('result', 4000) }) }]);
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          assert.deepStrictEqual(out.slice(0, 2 + H.length).map(label), ['TT', 'ask', ...H]);
          const call = out[2 + H.length]!, result = out[3 + H.length]!;
          assert.ok(call.content.some((b) => b.type === 'tool_use'), 'the call follows the history');
          const block = result.content.find((b) => b.type === 'tool_result') as { toolUseId: string; content: unknown } | undefined;
          assert.ok(block && block.toolUseId === 'c1' && JSON.stringify(block.content).includes('word3999'),
            'its whole result follows it at once');
          assert.strictEqual(out.length, 4 + H.length);
        }));
    });
  }

  it("leaves the head's end where its tokens run out without a reset, inside a body", () =>
    withStore(SELECTS.adaptive!, async (m) => {
      m.addMessage('user', words('longfirst', 4000));
      m.addMessage('assistant', words('reply', 5));
      await m.compile(BUDGET);
      const strategy = (m as unknown as { strategy: Record<string, (v: never) => number> }).strategy;
      const view = (m as unknown as { strategyMessageView(): never }).strategyMessageView();
      const all = (view as unknown as { getAll(): Array<{ bodyGroupId?: string }> }).getAll();
      const headEnd = strategy.getHeadWindowEnd!(view);
      assert.ok(all.length > 2 && all[0]!.bodyGroupId, 'premise: the long first message is stored as shards');
      assert.ok(headEnd > 0 && all[headEnd]!.bodyGroupId === all[0]!.bodyGroupId, `the head ends inside the first body (at ${headEnd})`);
      assert.strictEqual(m.getRenderStats()!.head.messages, headEnd, 'the compile sends those shards as its head');
    }));

  it('names no smaller recent window when a filling reset head alone is over the budget', () =>
    withStore(SELECTS.adaptive!, async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      for (let i = 0; i < 3; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`new${i}`, 400));
      m.addMessage('user', words('newest', 5));
      assert.deepStrictEqual((await sent(m)).slice(-5), ['TT', 'new0', 'new1', 'new2', 'newest'], 'premise: the head is still filling');
      const error = await m.compile({ maxTokens: 1500, reserveForResponse: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OverBudgetError, `refused: ${String(error)}`);
      assert.deepStrictEqual(error.clearedBy, [], 'the reset head stays raw whatever the recent window');
      assert.ok(error.diagnostics.headTokens > 1500 && error.diagnostics.tailTokens === 0,
        `the refusal counts the filling head as the head: head=${error.diagnostics.headTokens} tail=${error.diagnostics.tailTokens}`);
    }));

  it('prices a filling head ahead of the history under the hierarchical select, so the history is held to what is left', () =>
    withStore(SELECTS.hierarchical!, async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      for (let i = 0; i < 3; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`new${i}`, 400));
      await m.compile(BUDGET);
      const stats = m.getRenderStats()!;
      // The history alone fits; beside the head it doesn't.
      const budget = stats.middleRaw.tokens + Math.floor(stats.head.tokens / 2);
      const error = await m.compile({ maxTokens: budget, reserveForResponse: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OverBudgetError, `refused as over budget, not as a dropped message: ${String(error)}`);
      assert.deepStrictEqual(error.clearedBy, [], 'no compression is queued');
      assert.strictEqual(error.diagnostics.headTokens, stats.head.tokens, 'the refusal counts the filling head as the head');
    }));

  it('refuses a filling head the budget alone can\'t hold as a head refusal, before the history, under the hierarchical select', () =>
    withStore(SELECTS.hierarchical!, async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      for (let i = 0; i < 3; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`new${i}`, 400));
      await m.compile(BUDGET);
      const head = m.getRenderStats()!.head.tokens;
      const error = await m.compile({ maxTokens: Math.floor(head / 2), reserveForResponse: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OverBudgetError, `refused: ${String(error)}`);
      assert.deepStrictEqual(error.clearedBy, [], 'only a larger budget clears a head');
      assert.ok(error.diagnostics.headTokens > 0 && error.diagnostics.middleTokens === 0 && error.diagnostics.headTokens <= head,
        `the head's walk refused before the history: head=${error.diagnostics.headTokens} middle=${error.diagnostics.middleTokens}`);
    }));

  it('names compression when folding the history would make room beside a filling head', () =>
    withStore(() => new AutobiographicalStrategy({ ...base, hierarchical: true, targetChunkTokens: 300 }), async (m) => {
      for (let i = 0; i < 12; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
      await m.compile(BUDGET);
      await m.resetHeadWindow('A new topic.');
      for (let i = 0; i < 3; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`new${i}`, 400));
      await m.compile(BUDGET);
      const stats = m.getRenderStats()!;
      const budget = stats.middleRaw.tokens + Math.floor(stats.head.tokens / 2);
      const error = await m.compile({ maxTokens: budget, reserveForResponse: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OverBudgetError, `refused: ${String(error)}`);
      assert.deepStrictEqual(error.clearedBy, ['compression'], 'queued compression would fold the history');
    }));

  it('marks the end of the history as the cache boundary while a reset head fills, under the hierarchical select', () =>
    withStore(SELECTS.hierarchical!, async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      m.addMessage('user', words('after1', 5));
      const filling = (await m.compile(BUDGET)).messages as unknown as Array<Sent & { cacheBreakpoint?: boolean }>;
      assert.deepStrictEqual(filling.map(label), [...H, 'TT', 'after1']);
      assert.deepStrictEqual(filling.flatMap((x, i) => (x.cacheBreakpoint ? [i] : [])), [H.length - 1], 'the history\'s last entry');
      m.addMessage('assistant', words('past', 2500));
      const full = (await m.compile(BUDGET)).messages as unknown as Array<Sent & { cacheBreakpoint?: boolean }>;
      assert.deepStrictEqual(full.map(label).slice(0, 2), ['TT', 'after1'], 'premise: the head goes first');
      assert.deepStrictEqual(full.flatMap((x, i) => (x.cacheBreakpoint ? [i] : [])), [1], "the head's last entry, as before");
    }));

  it('keeps the head after its start when a strategy reset names a later shard of a tool call', () =>
    withStore(SELECTS.adaptive!, async (m) => {
      await history(m);
      const call = m.addMessage('assistant', [...words('callbody', 4000), { type: 'tool_use', id: 'c9', name: 'search', input: {} }]);
      m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c9', content: textOf({ participant: '', content: words('result', 4000) }) }]);
      const view = (m as unknown as { strategyMessageView(): never }).strategyMessageView();
      const all = (view as unknown as { getAll(): Array<{ id: string; bodyGroupId?: string }> }).getAll();
      const at = all.findIndex((x) => x.id === call);
      assert.ok(all[at]!.bodyGroupId && all[at + 1]!.bodyGroupId === all[at]!.bodyGroupId, 'premise: the call is stored as shards');
      const strategy = (m as unknown as { strategy: { resetHeadWindow(id: string): void; getHeadWindowEnd(v: never): number } }).strategy;
      strategy.resetHeadWindow(all[at + 1]!.id);
      assert.ok(strategy.getHeadWindowEnd(view) >= at + 1, 'the head ends no earlier than it starts');
      const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
      const texts = out.map(textOf).join('\n');
      assert.strictEqual(texts.split('callbody word0 ').length - 1, 1, "the call's first shard is sent once");
      for (const name of H) assert.strictEqual(texts.split(`${name} word0 `).length - 1, 1, `${name} is sent once`);
    }));

  it('reports a filling head as the head in a preview and in a refusal of the plan', () =>
    withStore(SELECTS.adaptive!, async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      m.addMessage('user', words('after1', 50));
      await m.compile(BUDGET);
      const stats = m.getRenderStats()!;
      assert.ok(stats.head.tokens > 0 && stats.tail.tokens === 0, 'premise: the head is filling');
      const preview = m.previewContext(BUDGET)!;
      assert.deepStrictEqual([preview.headTokens, preview.tailTokens], [stats.head.tokens, 0], 'the preview counts it as the head');
      // The head fits the budget and the history beside it doesn't, with nothing to fold it.
      const error = await m.compile({ maxTokens: stats.head.tokens + 300, reserveForResponse: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OverBudgetError, `refused: ${String(error)}`);
      assert.deepStrictEqual([error.diagnostics.headTokens, error.diagnostics.tailTokens], [stats.head.tokens, 0], `the plan's refusal counts it as the head: ${error.message}`);
    }));

  it('walks back over a whole sharded call body, its tool_use on the first shard, when its result does not fit', () =>
    // Shards of ~1,000 tokens, so a call body that fits the head can be stored as several.
    withStore(() => new AutobiographicalStrategy({ ...base, hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1000 }), async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      const call = m.addMessage('assistant', [{ type: 'tool_use', id: 'c8', name: 'search', input: {} }, ...words('plan', 1300)]);
      m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c8', content: textOf({ participant: '', content: words('result', 4000) }) }]);
      const view = (m as unknown as { strategyMessageView(): never }).strategyMessageView();
      const all = (view as unknown as { getAll(): Array<{ id: string; bodyGroupId?: string; content: ContentBlock[] }> }).getAll();
      const at = all.findIndex((x) => x.id === call);
      const shards = all.filter((x) => x.bodyGroupId && x.bodyGroupId === all[at]!.bodyGroupId);
      assert.ok(shards.length > 1 && shards[0]!.content.some((b) => b.type === 'tool_use') && !shards[shards.length - 1]!.content.some((b) => b.type === 'tool_use'),
        `premise: the call body is stored as shards, its tool_use on the first only: ${JSON.stringify(all.slice(at, at + 6).map((x) => [x.bodyGroupId ?? null, x.content.map((b) => b.type)]))}`);
      const est = view as unknown as { estimateTokens(x: unknown): number };
      const headStart = (m as unknown as { strategy: { getHeadWindowStartIndex(v: never): number } }).strategy.getHeadWindowStartIndex(view);
      const throughCall = all.slice(headStart, at + shards.length).reduce((t, x) => t + est.estimateTokens(x), 0);
      assert.ok(throughCall <= 4000 && throughCall + est.estimateTokens(all[at + shards.length]) > 4000,
        `premise: the call body fits the head window and its result doesn't (${throughCall} through the call)`);
      const strategy = (m as unknown as { strategy: { getHeadWindowEnd(v: never): number } }).strategy;
      assert.strictEqual(strategy.getHeadWindowEnd(view), at, 'the head ends before the call body, which stays with its result');
    }));

  it("refuses a reset head's extension past twice the head window, counting the boundary's own message", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-fill-cap-'));
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'test-model', targetChunkTokens: 80, headWindowTokens: 1e9, recentWindowTokens: 0, mergeThreshold: 1000,
      hierarchical: true, autoTickOnNewMessage: false,
    } as never);
    let n = 0;
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(20) }],
      usage: { input_tokens: 100, output_tokens: 30 } }) };
    const m = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: membrane as never });
    try {
      for (let i = 0; i < 4; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 30));
      await m.resetHeadWindow('A new topic.');
      const big = m.addMessage('assistant', words('BIG', 600));
      m.addMessage('user', words('small', 5));
      const view = (m as unknown as { createStrategyContext(): { messageStore: never } }).createStrategyContext().messageStore;
      const store = view as unknown as { getAll(): Array<{ id: string }>; estimateTokens(x: unknown): number; setTokenCalibration(v: number): void };
      const s = strategy as unknown as Record<string, (v: never) => number> & { config: { headWindowTokens: number } };
      const headStart = s.getHeadWindowStartIndex!(view);
      const at = store.getAll().findIndex((x) => x.id === big);
      s.config.headWindowTokens = store.getAll().slice(headStart).reduce((t, x) => t + store.estimateTokens(x), 0);
      for (let i = 0; i < 40; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`event${i}`, 40));
      for (let i = 0; i < 500 && !m.isReady(); i++) await m.tick();
      await m.compile(BUDGET);
      assert.strictEqual(s.getHeadWindowEnd!(view), at + 2, 'premise: the head ends where calibrated');
      // At 3x, the head through the big message, and the small one after it,
      // pass twice the head window, though the transition and the small one alone don't.
      store.setTokenCalibration(3);
      assert.strictEqual(s.getHeadWindowEnd!(view), at, 'the guard keeps the boundary rather than extend past its cap');
    } finally {
      await m.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const name of ['adaptive', 'kv-unified'] as const) {
    describe(`a pinned run at a reset head's end that compression never took (${name})`, () => {
      // A pin or a document mark covers a message stored in parts whole, for compression as for the selects, so a
      // message pinned while it's recent is never chunked, and the ratchet guard can take it into the head whole. A
      // message whose later parts were chunked before it was marked (by a mark from before whole-message pins, or one
      // made after a head that ended inside it) keeps those chunks, and is built below by the second route.
      const make = () => new AutobiographicalStrategy({ ...base, recentWindowTokens: 30_000, hierarchical: false, adaptiveResolution: true,
        targetChunkTokens: 1500, ...(name === 'kv-unified' ? { foldingStrategy: 'kv-unified', kvUnified: { ...KVU, policy: { ...KVU.policy } } } : {}),
        compressionModel: 'test-model' } as never);
      const stub = () => {
        let n = 0;
        return { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(30) }],
          usage: { input_tokens: 100, output_tokens: 40 } }) } as never;
      };
      const open = async (body: (m: ContextManager, strategy: AutobiographicalStrategy) => Promise<void>) => {
        const dir = mkdtempSync(join(tmpdir(), 'reset-fill-pin-'));
        const strategy = make();
        const m = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: stub() });
        try { await body(m, strategy); } finally { await m.close(); rmSync(dir, { recursive: true, force: true }); }
      };
      type View = { getAll(): Array<{ id: string; bodyGroupId?: string }>; estimateTokens(x: unknown): number };
      const viewOf = (m: ContextManager) => (m as unknown as { strategyMessageView(): View }).strategyMessageView();
      const ownedOf = (strategy: AutobiographicalStrategy) => new Set((strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> })
        .chunks.flatMap((c) => c.messages.map((x) => x.id)));
      const headEnd = (strategy: AutobiographicalStrategy, view: View) =>
        (strategy as unknown as { getHeadWindowEnd(v: View): number }).getHeadWindowEnd(view);
      const headStart = (strategy: AutobiographicalStrategy, view: View) =>
        (strategy as unknown as { getHeadWindowStartIndex(v: View): number }).getHeadWindowStartIndex(view);
      /** The store positions of the message `id`'s parts, the first included. */
      const partsOf = (view: View, id: string): number[] => {
        const all = view.getAll();
        const first = all.findIndex((x) => x.id === id);
        const group = all[first]!.bodyGroupId;
        return group === undefined ? [first] : all.flatMap((x, i) => (x.bodyGroupId === group ? [i] : []));
      };
      const settle = async (m: ContextManager) => {
        for (let i = 0; i < 120; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`event${i}`, 200));
        for (let i = 0; i < 500 && !m.isReady(); i++) await m.tick();
        await m.compile(BUDGET);
      };

      /** After a reset: a short message, then B, pinned or marked while recent, then traffic that compression chunks.
       *  B is small enough for the ratchet guard to reach over it whole. */
      async function pinnedWhole(m: ContextManager, strategy: AutobiographicalStrategy, how: 'pin' | 'mark'): Promise<{ first: number; parts: number[]; view: View }> {
        await history(m);
        await m.resetHeadWindow('A new topic.');
        m.addMessage('user', words('after1', 20));
        const id = m.addMessage('assistant', words('Bbody', 1800));
        const view = viewOf(m);
        const parts = partsOf(view, id);
        assert.ok(parts.length > 1, 'premise: B is stored as parts');
        if (how === 'mark') m.markDocument(id);
        else m.pinRange(id, id);
        await settle(m);
        const all = view.getAll();
        const owned = ownedOf(strategy);
        assert.ok(parts.every((k) => !owned.has(all[k]!.id)) && owned.has(all[parts.at(-1)! + 1]!.id),
          'premise: no part of B is chunked, and coverage after the head starts right after it');
        return { first: parts[0]!, parts, view };
      }

      /** A head without a reset that ended inside B, after its first part, so compression chunked B's rest; then B
       *  marked, or not, and a strategy reset to the message before B. A mark from before whole-message pins leaves
       *  the same chunks. */
      async function chunkedRest(m: ContextManager, strategy: AutobiographicalStrategy, mark: boolean): Promise<{ first: number; parts: number[]; view: View }> {
        m.addMessage('user', words('hist0', 200));
        const after1 = m.addMessage('user', words('after1', 20));
        const id = m.addMessage('assistant', words('Bbody', 6000));
        const view = viewOf(m);
        const parts = partsOf(view, id);
        assert.strictEqual(headStart(strategy, view), 0, 'premise: no reset yet');
        assert.strictEqual(headEnd(strategy, view), parts[1], 'premise: the head ends inside B, after its first part');
        await settle(m);
        const all = view.getAll();
        const owned = ownedOf(strategy);
        assert.ok(!owned.has(all[parts[0]!]!.id) && parts.slice(1).every((k) => owned.has(all[k]!.id)),
          "premise: B's first part was never chunked, and its rest was");
        if (mark) m.markDocument(id);
        (strategy as unknown as { resetHeadWindow(id: string): void }).resetHeadWindow(after1);
        assert.strictEqual(headStart(strategy, view), parts[0]! - 1, 'premise: the head now starts at the message before B');
        return { first: parts[0]!, parts, view };
      }

      for (const how of ['pin', 'mark'] as const) {
        it(`leaves a ${how === 'mark' ? 'marked' : 'pinned'} message the guard reaches out of the head, and sends it whole after the history`, () =>
          open(async (m, strategy) => {
            const { first, view } = await pinnedWhole(m, strategy, how);
            assert.strictEqual(headEnd(strategy, view), first, 'the head stops at B\'s start rather than take B into it');
            const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
            assert.deepStrictEqual(out.slice(0, 2 + H.length).map(label), ['TT', 'after1', ...H]);
            const at = out.findIndex((x) => textOf(x).startsWith('Bbody word0 '));
            assert.strictEqual(at, 2 + H.length, 'B starts right after the history');
            // The compile joins a body's parts sent one after another into one message.
            assert.ok(textOf(out[at]!).endsWith(' word1799'), 'B is sent whole, as one message');
            assert.strictEqual(label(out[at + 1]!), 'event0', 'and the rest follows it');
          }));
      }

      it('leaves out a message marked after its later parts were chunked, so the head doesn\'t end inside it', () =>
        open(async (m, strategy) => {
          const { first, view } = await chunkedRest(m, strategy, true);
          assert.strictEqual(headEnd(strategy, view), first, 'the head stops at B\'s start rather than take its marked first part');
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          assert.strictEqual(label(out[0]!), 'after1', 'the head sends after1 alone');
          const at = out.findIndex((x) => textOf(x).startsWith('Bbody word0 '));
          assert.ok(at > 1 && label(out[at - 1]!) === 'hist0', "B's first part goes after the history, with the rest of B, not in the head");
        }));

      it('keeps the extension over a first part an earlier head kept out of chunks and no pin holds, so it is never chunked after the rest', () =>
        open(async (m, strategy) => {
          const { parts, view } = await chunkedRest(m, strategy, false);
          assert.strictEqual(headEnd(strategy, view), parts[1], 'the head keeps B\'s unpinned first part, up to where coverage starts');
          if (name === 'kv-unified') {
            // kv-unified reads pin bounds: a pin that lets the part fold keeps it no more out of chunks than none.
            const all0 = view.getAll();
            const bounded = m.pinRange(all0[parts[0]!]!.id, all0[parts[0]!]!.id, { maxLevel: 1 });
            assert.strictEqual(headEnd(strategy, view), parts[1], 'a bounded pin is no raw pin: the extension stands');
            m.unpin(bounded);
          }
          const before = ownedOf(strategy).size;
          for (let i = 120; i < 140; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`event${i}`, 200));
          for (let i = 0; i < 500 && !m.isReady(); i++) await m.tick();
          await m.compile(BUDGET);
          assert.ok(ownedOf(strategy).size > before, 'premise: compression chunked more after the head');
          const all = view.getAll();
          assert.ok(!ownedOf(strategy).has(all[parts[0]!]!.id), 'no chunk takes B\'s first part after the chunks of its rest');
        }));

      it("doesn't trim past the boundary into a pinned message the head already holds", () =>
        open(async (m, strategy) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          const a = m.addMessage('user', words('after1', 20));
          const id = m.addMessage('assistant', words('Bbody', 1800));
          m.pinRange(a, id);
          await settle(m);
          const view = viewOf(m);
          const parts = partsOf(view, id);
          const all = view.getAll();
          const owned = ownedOf(strategy);
          assert.ok(parts.every((k) => !owned.has(all[k]!.id)) && owned.has(all[parts.at(-1)! + 1]!.id),
            'premise: B stays out of chunks and coverage starts right after it, so the guard\'s extension reaches over it');
          assert.strictEqual(headEnd(strategy, view), parts[0], 'the pinned message that fits the head stays in it; only B is left out');
        }));

      it('leaves two pinned messages out of the head together', () =>
        open(async (m, strategy) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('after1', 20));
          const d = m.addMessage('assistant', words('Dbody', 1800));
          const id = m.addMessage('assistant', words('Bbody', 500));
          const view = viewOf(m);
          const dParts = partsOf(view, d);
          const bParts = partsOf(view, id);
          m.pinRange(d, d);
          m.pinRange(id, id);
          // A head window D just doesn't fit, so the guard reaches past D and B to their coverage.
          (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens =
            view.getAll().slice(headStart(strategy, view), bParts[0]).reduce((t, x) => t + view.estimateTokens(x), 0) - 1;
          await settle(m);
          const all = view.getAll();
          const owned = ownedOf(strategy);
          assert.ok([...dParts, ...bParts].every((k) => !owned.has(all[k]!.id)) && owned.has(all[bParts.at(-1)! + 1]!.id),
            'premise: D and B stay out of chunks, and coverage starts right after B');
          assert.strictEqual(headEnd(strategy, view), dParts[0], 'the head ends before D: both pinned messages are left out');
        }));

      it('leaves a run of pinned messages out of the head, and keeps an unpinned message before it', () =>
        open(async (m, strategy) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('after1', 20));
          const d = m.addMessage('assistant', words('Dbody', 1800));
          const id = m.addMessage('assistant', words('Bbody', 500));
          const view = viewOf(m);
          const dParts = partsOf(view, d);
          const bParts = partsOf(view, id);
          // D is pinned while recent, so compression never takes it, and its pin is removed after; B stays pinned.
          const dPin = m.pinRange(d, d);
          m.pinRange(id, id);
          (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens =
            view.getAll().slice(headStart(strategy, view), bParts[0]).reduce((t, x) => t + view.estimateTokens(x), 0) - 1;
          await settle(m);
          m.unpin(dPin);
          const all = view.getAll();
          const owned = ownedOf(strategy);
          assert.ok([...dParts, ...bParts].every((k) => !owned.has(all[k]!.id)) && owned.has(all[bParts.at(-1)! + 1]!.id),
            'premise: D and B stay out of chunks, and coverage starts right after B');
          assert.ok(headStart(strategy, view) < dParts[0]!, 'premise: D starts after the reset');
          assert.strictEqual(headEnd(strategy, view), bParts[0], 'the head keeps unpinned D and leaves pinned B out');
        }));

      it('keeps a parallel call\'s pinned result with its call', () =>
        open(async (m, strategy) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('assistant', [...words('calling', 5), { type: 'tool_use', id: 'p1', name: 'search', input: {} },
            { type: 'tool_use', id: 'p2', name: 'search', input: {} }]);
          m.addMessage('user', [{ type: 'tool_result', toolUseId: 'p1', content: 'First.' }]);
          const second = m.addMessage('user', [{ type: 'tool_result', toolUseId: 'p2', content: 'Second.' }, ...words('Rbody', 1800)]);
          const view = viewOf(m);
          const parts = partsOf(view, second);
          assert.ok(parts.length > 1, 'premise: the second result is stored as parts');
          m.pinRange(second, second);
          await settle(m);
          const all = view.getAll();
          const owned = ownedOf(strategy);
          assert.ok(parts.every((k) => !owned.has(all[k]!.id)) && owned.has(all[parts.at(-1)! + 1]!.id),
            'premise: the second result stays out of chunks, and coverage starts right after it');
          assert.strictEqual(headEnd(strategy, view), parts.at(-1)! + 1, 'the head keeps the second result whole, with the call it answers');
        }));

      it('keeps a call with its pinned result when the call is unpinned', () =>
        open(async (m, strategy) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('after1', 20));
          const call = m.addMessage('assistant', [...words('calling', 5), { type: 'tool_use', id: 'c6', name: 'search', input: {} }]);
          const result = m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c6', content: 'Sunny.' }, ...words('Rbody', 1800)]);
          const view = viewOf(m);
          const parts = partsOf(view, result);
          assert.ok(parts.length > 1, 'premise: the result is stored as parts');
          // The call and the result are pinned while recent, then the call's pin is removed.
          const callPin = m.pinRange(call, call);
          m.pinRange(result, result);
          await settle(m);
          m.unpin(callPin);
          const all = view.getAll();
          const owned = ownedOf(strategy);
          assert.ok(!owned.has(call) && parts.every((k) => !owned.has(all[k]!.id)) && owned.has(all[parts.at(-1)! + 1]!.id),
            'premise: the call and the result stay out of chunks, and coverage starts right after the result');
          assert.strictEqual(headEnd(strategy, view), parts.at(-1)! + 1, 'the head keeps the call and its result together');
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          const callAt = out.findIndex((x) => x.content.some((b) => b.type === 'tool_use'));
          assert.strictEqual(callAt, 2, 'the call is in the head');
          assert.ok(out[3]!.content.some((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'c6'), 'its result follows it at once');
        }));

      it('leaves a pinned call out of the head with its chunked result, both after a long history', () =>
        open(async (m, strategy) => {
          // Ten history messages: more than the pairing pass's look-ahead could reach from a call left in the head.
          for (let i = 0; i < 10; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('after1', 20));
          const call = m.addMessage('assistant', [...words('calling', 5), { type: 'tool_use', id: 'c7', name: 'search', input: {} }]);
          m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c7', content: textOf({ participant: '', content: words('result', 6000) }) }]);
          m.pinRange(call, call);
          for (let i = 0; i < 120; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`event${i}`, 200));
          for (let i = 0; i < 500 && !m.isReady(); i++) await m.tick();
          await m.compile(BUDGET);
          const view = (m as unknown as { strategyMessageView(): never }).strategyMessageView();
          const all = (view as unknown as { getAll(): Array<{ id: string }> }).getAll();
          const at = all.findIndex((x) => x.id === call);
          const owned = (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks.flatMap((c) => c.messages.map((x) => x.id));
          assert.ok(!owned.includes(call) && owned.includes(all[at + 1]!.id), 'premise: the call stays out of chunks, and its result is chunked');
          assert.strictEqual((strategy as unknown as { getHeadWindowEnd(v: never): number }).getHeadWindowEnd(view), at,
            'the head ends before the pinned call');
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          const callAt = out.findIndex((x) => x.content.some((b) => b.type === 'tool_use'));
          assert.strictEqual(callAt, 12, 'the call follows the ten history messages');
          assert.ok(out[callAt + 1]!.content.some((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'c7'
            && JSON.stringify((b as { content: unknown }).content).includes('word5999')), 'its real result follows it at once');
        }));

      it('leaves out the pinned run after the last pinned tool result, and keeps that result with its call', () =>
        open(async (m, strategy) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          // after1 is large enough that the guard's cap (twice the head window) takes in the call, its result and B.
          m.addMessage('user', words('after1', 900));
          const call = m.addMessage('assistant', [...words('calling', 5), { type: 'tool_use', id: 'c4', name: 'search', input: {} }]);
          const result = m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c4', content: 'Done.' }]);
          const id = m.addMessage('assistant', words('Bbody', 500));
          m.pinRange(call, id);
          const view = viewOf(m);
          const callAt = view.getAll().findIndex((x) => x.id === call);
          // The head window holds the transition and after1 exactly, so the call and its result are the guard's to extend over.
          (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens =
            view.getAll().slice(headStart(strategy, view), callAt).reduce((t, x) => t + view.estimateTokens(x), 0);
          await settle(m);
          const parts = partsOf(view, id);
          const all = view.getAll();
          const owned = ownedOf(strategy);
          assert.ok([call, result].every((x) => !owned.has(x)) && parts.every((k) => !owned.has(all[k]!.id)) && owned.has(all[parts.at(-1)! + 1]!.id),
            'premise: the call, its result and B stay out of chunks, and coverage starts right after B');
          assert.strictEqual(headEnd(strategy, view), parts[0],
            `the head keeps the call and its result, which it holds by the guard's extension alone, and leaves pinned B out (call at ${callAt}, B at ${parts[0]})`);
          const out = (await m.compile(BUDGET)).messages as unknown as Sent[];
          const at = out.findIndex((x) => x.content.some((b) => b.type === 'tool_use'));
          const kind = (x: Sent): string => (x.content.some((b) => b.type === 'tool_use') ? 'call'
            : x.content.some((b) => b.type === 'tool_result') ? 'result' : label(x));
          assert.deepStrictEqual(out.slice(0, at + 2).map(kind), ['TT', 'after1', 'call', 'result'],
            'the head sends the transition, after1, the call and its result, in order');
          assert.ok(textOf(out[at + 2 + H.length]!).startsWith('Bbody word0 '), 'B follows the history');
        }));

      it('leaves a pinned run in the extension when it holds a tool result, and leaves the same run out without one', async () => {
        const run = async (withResult: boolean): Promise<{ end: number; parts: number[] }> => {
          let found = { end: -1, parts: [] as number[] };
          await open(async (m, strategy) => {
            m.addMessage('user', words('hist0', 200));
            m.addMessage('assistant', [...words('hist1', 5), { type: 'tool_use', id: 'x1', name: 'search', input: {} }]);
            for (let i = 2; i < 6; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
            await m.resetHeadWindow('A new topic.');
            m.addMessage('user', words('after1', 20));
            const id = m.addMessage('user', [...(withResult ? [{ type: 'tool_result', toolUseId: 'x1', content: 'Late.' } as ContentBlock] : []), ...words('Bbody', 1800)]);
            m.pinRange(id, id);
            await settle(m);
            const view = viewOf(m);
            const parts = partsOf(view, id);
            const all = view.getAll();
            const owned = ownedOf(strategy);
            assert.ok(parts.length > 1 && parts.every((k) => !owned.has(all[k]!.id)) && owned.has(all[parts.at(-1)! + 1]!.id),
              'premise: B is stored as parts and stays out of chunks, and coverage starts right after it');
            found = { end: headEnd(strategy, view), parts };
          });
          return found;
        };
        const plain = await run(false);
        assert.strictEqual(plain.end, plain.parts[0], 'without a tool result, pinned B is left out and the head ends at its start');
        const result = await run(true);
        assert.strictEqual(result.end, result.parts.at(-1)! + 1, 'with a tool result on it, pinned B stays in the extension, whole');
      });
    });
  }

  for (const [name, sharded] of [['hierarchical', false], ['adaptive, with a sharded body in the head', true]] as const) {
    it(`keeps a reset head where coverage begins when calibration rises (${name})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'reset-fill-ratchet-'));
      const strategy = new AutobiographicalStrategy({
        compressionModel: 'test-model', targetChunkTokens: 80, headWindowTokens: 1e9, recentWindowTokens: 0, mergeThreshold: 1000,
        hierarchical: !sharded, adaptiveResolution: sharded, autoTickOnNewMessage: false,
      } as never);
      let n = 0;
      const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(20) }],
        usage: { input_tokens: 100, output_tokens: 30 } }) };
      const m = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: membrane as never });
      try {
        for (let i = 0; i < 4; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 30));
        await m.resetHeadWindow('A new topic.');
        for (let i = 0; i < 8; i++) {
          m.addMessage(i % 2 ? 'assistant' : 'user', words(`HEAD${i}`, sharded && i === 3 ? 900 : 20));
        }
        const view = (m as unknown as { createStrategyContext(): { messageStore: never } }).createStrategyContext().messageStore;
        const store = view as unknown as { getAll(): Array<{ bodyGroupId?: string }>; estimateTokens(x: unknown): number; setTokenCalibration(v: number): void };
        const s = strategy as unknown as Record<string, (v: never) => number> & { config: { headWindowTokens: number } };
        const headStart = s.getHeadWindowStartIndex!(view);
        const headEnd = store.getAll().length;
        if (sharded) assert.ok(store.getAll().some((x) => x.bodyGroupId), 'premise: a head body is stored as shards');
        // The head window is exactly the head as it stands, at calibration 1.
        s.config.headWindowTokens = store.getAll().slice(headStart).reduce((t, x) => t + store.estimateTokens(x), 0);
        for (let i = 0; i < 40; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`event${i}`, 40));
        for (let i = 0; i < 500 && !m.isReady(); i++) await m.tick();
        await m.compile(BUDGET);
        assert.strictEqual(s.getHeadWindowEnd!(view), headEnd, 'premise: the head ends where calibrated');
        store.setTokenCalibration(1.6);
        assert.strictEqual(s.getHeadWindowEnd!(view), headEnd, 'the head stays anchored to coverage, not shrunk');
      } finally {
        await m.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('a past reset head, as compression requests read it (headAsOf)', () => {
  it('ends by whole bodies, as the live reset head does: a long first message after an earlier transition is left out whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-fill-past-head-'));
    const strategy = new AutobiographicalStrategy({ ...base, hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1500 } as never);
    let n = 0;
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(30) }],
      usage: { input_tokens: 100, output_tokens: 40 } }) };
    const m = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: membrane as never });
    try {
      await history(m);
      await m.resetHeadWindow('Topic A.');
      const long = m.addMessage('user', words('Along', 6000));
      for (let i = 0; i < 20; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`a${i}`, 200));
      await m.resetHeadWindow('Topic B.');
      for (let i = 0; i < 40; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`b${i}`, 200));
      for (let i = 0; i < 500 && !m.isReady(); i++) await m.tick();
      const view = (m as unknown as { strategyMessageView(): never }).strategyMessageView();
      const all = (view as unknown as { getAll(): Array<{ id: string; bodyGroupId?: string }> }).getAll();
      const first = all.findIndex((x) => x.id === long);
      const shards = all.filter((x) => x.bodyGroupId !== undefined && x.bodyGroupId === all[first]!.bodyGroupId).length;
      assert.ok(shards > 2, 'premise: the long message is stored as shards, more than the head window holds');
      const s = strategy as unknown as { headAsOf(v: never, pos: number): { start: number; end: number }; getHeadWindowStartIndex(v: never): number };
      const pos = first + shards + 5;
      assert.ok(pos < s.getHeadWindowStartIndex(view), "premise: the position is in topic A's history, before the live head");
      assert.deepStrictEqual(s.headAsOf(view, pos), { start: first - 1, end: first },
        "topic A's head is its transition alone: the long message after it doesn't fit, so it's left out whole");
    } finally {
      await m.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
