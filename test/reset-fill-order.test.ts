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
          const full = await sent(m);
          assert.deepStrictEqual(full.slice(0, 5), ['TT', 'after1', 'after2', 'batch1', 'batch2'],
            'once a body no longer fits, the head goes first');
          assert.deepStrictEqual(full.slice(-1), ['new3']);
          const h0 = full.indexOf('hist0');
          assert.ok(h0 > full.indexOf('batch2') && h0 < full.indexOf('new3'), `the history sits between the head and the rest: ${full}`);
        }));

      it("the reset's own compile keeps the history's prefix and appends the transition", () =>
        withStore(make, async (m) => {
          const before = await history(m);
          await m.resetHeadWindow('A new topic.');
          const after = (await m.compile(BUDGET)).messages as unknown as Sent[];
          // Bytes, as the provider hashes them: where the cache markers go is
          // placeCacheMarkers' business.
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

      it('keeps a tool call with its result when the result does not fit the head', () =>
        withStore(make, async (m) => {
          await history(m);
          await m.resetHeadWindow('A new topic.');
          m.addMessage('user', words('ask', 5));
          m.addMessage('assistant', [{ type: 'text', text: 'call' }, { type: 'tool_use', id: 'c1', name: 'search', input: {} }]);
          m.addMessage('user', [{ type: 'tool_result', toolUseId: 'c1', content: textOf({ participant: '', content: words('result', 4000) }) }]);
          const order = (await sent(m)).filter((x) => x !== '');
          assert.deepStrictEqual(order.slice(0, 2 + H.length), ['TT', 'ask', ...H], `the call and its result follow the history together: ${order}`);
          assert.strictEqual(order[2 + H.length], 'call');
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

  it("refuses a budget a filling head doesn't fit as a head refusal under the hierarchical select, after the history", () =>
    withStore(SELECTS.hierarchical!, async (m) => {
      await history(m);
      await m.resetHeadWindow('A new topic.');
      for (let i = 0; i < 3; i++) m.addMessage(i % 2 ? 'assistant' : 'user', words(`new${i}`, 400));
      await m.compile(BUDGET);
      const stats = m.getRenderStats()!;
      // The history fits, and the head after it doesn't.
      const budget = stats.middleRaw.tokens + Math.floor(stats.head.tokens / 2);
      const error = await m.compile({ maxTokens: budget, reserveForResponse: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OverBudgetError, `refused as over budget, not as a dropped message: ${String(error)}`);
      assert.deepStrictEqual(error.clearedBy, [], 'only a larger budget clears a head');
      assert.ok(error.diagnostics.headTokens > 0 && error.diagnostics.middleTokens === stats.middleRaw.tokens,
        `head=${error.diagnostics.headTokens} middle=${error.diagnostics.middleTokens}`);
    }));

  it('names compression when folding the history sent before a filling head would make room for it', () =>
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
      assert.deepStrictEqual(error.clearedBy, ['compression'], 'queued compression would fold the history before the head');
    }));
});
