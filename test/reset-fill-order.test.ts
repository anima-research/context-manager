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
 *   then whole bodies while they fit. A body that doesn't fit is sent whole
 *   after the history, and a tool call stays with its result.
 * - Without a reset (headStart 0) the head still ends where its tokens run out.
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
          // ~600-token messages: the head holds three of them, and the fourth
          // ends the fill.
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

      it('keeps store order and sends a held message raw when a hold sits inside a filling head', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          const held = m.addMessage('user', words('after1', 5));
          m.addMessage('assistant', words('after2', 5));
          m.holdCompression([held], { timeoutMs: 60_000 });
          assert.deepStrictEqual(await sent(m), [...H, 'TT', 'after1', 'after2']);
          m.releaseCompression([held]);
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
