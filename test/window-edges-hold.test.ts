/**
 * The head window's end and the recent window's start are counted in tokens,
 * at the live calibration multiplier, so a recalibration moves both. Chunk
 * records say where the two edges were when the chunks were laid: the first
 * message a chunk owns followed the head, the last one preceded the recent
 * window. These tests hold the edges there through a recalibration, and let
 * a window that was really widened grow over what chunks own.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-window-edges-hold';
const made: string[] = [];
after(() => {
  for (const p of made) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
});

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }];

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
    continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000,
  // The carried layout is kept whenever a select can keep it, so a change of
  // layout below is one the select was forced into.
  adoptEpsilon: 1e9, treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};

const SELECTS = {
  hierarchical: { hierarchical: true },
  'flat-profile': { adaptiveResolution: true, foldingStrategy: 'flat-profile' },
  'kv-unified': { adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } },
} as const;

class Held extends AutobiographicalStrategy {
  leftOut = 0;
  protected override summariesAcross(...args: Parameters<AutobiographicalStrategy['summariesAcross']>): ReturnType<AutobiographicalStrategy['summariesAcross']> {
    const across = super.summariesAcross(...args);
    this.leftOut = Math.max(this.leftOut, across.size);
    return across;
  }
  edges(ctx: StrategyContext): { headEnd: number; recentStart: number } {
    return { headEnd: this.getHeadWindowEnd(ctx.messageStore), recentStart: this.getRecentWindowStart(ctx.messageStore) };
  }
  owned(): Set<string> {
    return (this as unknown as { ownedMessageIds(): Set<string> }).ownedMessageIds();
  }
  leavesOf(id: string): Set<string> {
    const byId = new Map(this.summaries.map((s) => [s.id, s]));
    const out = new Set<string>();
    const summary = byId.get(id);
    if (summary) this.expandSummaryToLeafMessageIds(summary, byId, out);
    return out;
  }
  lastEstimate(): number {
    return (this as unknown as { _lastCompileEstimate: number })._lastCompileEstimate;
  }
  set(key: 'headWindowTokens' | 'recentWindowTokens', tokens: number): void {
    (this as unknown as { config: Record<string, number> }).config[key] = tokens;
  }
  seedL1(id: string, sourceIds: string[]): void {
    this.summaries.push({
      id, level: 1, content: `${id} recalls ${sourceIds.length} messages`, tokens: 8, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, created: Date.now(),
    } as never);
    for (const m of sourceIds) this.resolutions.set(m as never, 1);
  }
}

const contextOf = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: the queue did not converge within 500 ticks');
}

const OPENING = 8;
const EVENTS = 40;
const RECENT = 3;
let stores = 0;

/**
 * A store whose chunks were laid with the head window ending after the
 * opening and the recent window starting at the last three messages, each
 * window one token short of taking the next message a chunk owns: the
 * smallest fall of the multiplier moves the token count of either edge over
 * that message.
 */
async function laid(select: keyof typeof SELECTS) {
  const path = `${STORE}-${process.pid}-${stores++}`;
  made.push(path);
  let calls = 0;
  const membrane = {
    complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[summary ${++calls}] brief` }], usage: { input_tokens: 100, output_tokens: 10 } }),
  };
  const strategy = new Held({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 80,
    headWindowTokens: 1e9,
    recentWindowTokens: 0,
    mergeThreshold: 4,
    autoTickOnNewMessage: false,
    // The newest chunk gets its summary too, so the recent window's edge has one behind it.
    l1HoldbackChunks: 0,
    ...SELECTS[select],
  } as never);
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ctx = contextOf(manager);
  const store = ctx.messageStore;
  for (let i = 0; i < OPENING; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`OPENING_${i} ` + 'opening words of the chronicle '.repeat(3)));
  for (let i = 0; i < EVENTS; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + 'substantive words about real happenings '.repeat(8)));
  const price = (from: number, to: number): number => {
    const all = store.getAll();
    let tokens = 0;
    for (let i = from; i < to; i++) tokens += store.estimateTokens(all[i]!);
    return tokens;
  };
  const headTokens = price(0, OPENING + 1) - 1;
  strategy.set('headWindowTokens', headTokens);
  for (let i = 0; i < RECENT; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`latest ${i} ` + 'words of the turn that is going on now '.repeat(8)));
  const all = store.getAll();
  const total = all.length;
  const recentTokens = price(total - RECENT - 1, total) - 1;
  strategy.set('recentWindowTokens', recentTokens);
  await drain(manager);

  const owned = strategy.owned();
  const ownedAt = all.map((m, i) => (owned.has(m.id) ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual([ownedAt[0], ownedAt.at(-1)], [OPENING, total - RECENT - 1], 'premise: chunks own the events, from the first to the last');
  assert.deepStrictEqual(strategy.edges(ctx), { headEnd: OPENING, recentStart: total - RECENT }, 'premise: the windows end and start at what the chunks own');

  const position = new Map(all.map((m, i) => [m.id, i]));
  /** What a compile sends: the positions sent raw, and each summary sent. */
  const sent = async (maxTokens: number): Promise<{ raw: number[]; summaries: string[] }> => {
    const result = await manager.compile({ maxTokens, reserveForResponse: 0 });
    const sources = result.provenance!.messages;
    const raw = sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => position.get(b.messageId)!) : []));
    const summaries = sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.map((x) => x.id) : []));
    return { raw: raw.sort((a, b) => a - b), summaries: summaries.sort() };
  };
  /**
   * Report requests that came out `ratio` of their estimate until the
   * multiplier has moved to `until`. The hierarchical select keeps no
   * estimate to report against, so there the store is given a multiplier.
   */
  const recalibrate = async (maxTokens: number, ratio: number, until: (multiplier: number) => boolean): Promise<number> => {
    if (select === 'hierarchical') store.setTokenCalibration!(ratio < 1 ? 0.95 : 1.05);
    for (let i = 0; i < 40 && !until(store.getTokenCalibration!()); i++) {
      await manager.compile({ maxTokens, reserveForResponse: 0 });
      strategy.reportRealInputTokens(Math.round(ratio * strategy.lastEstimate()));
    }
    const multiplier = store.getTokenCalibration!();
    assert.ok(until(multiplier), `premise: the multiplier moved (to ${multiplier})`);
    return multiplier;
  };
  return { manager, strategy, ctx, store, total, headTokens, recentTokens, price, sent, recalibrate };
}

describe('a recalibration leaves both window edges where the chunks were laid', () => {
  for (const select of Object.keys(SELECTS) as Array<keyof typeof SELECTS>) {
    it(`${select}: a fall of the multiplier moves neither edge over a message a chunk owns, and nothing sent changes`, async () => {
      const { manager, strategy, ctx, total, sent, recalibrate } = await laid(select);
      const budget = 1500;
      const before = await sent(budget);
      assert.ok(before.summaries.length > 0, 'premise: the compile sends history through summaries');
      assert.deepStrictEqual(await sent(budget), before, 'premise: the same compile again sends the same');

      const multiplier = await recalibrate(budget, 0.94, (m) => m <= 0.97);
      assert.ok(multiplier > 0.85, `premise: a small fall (to ${multiplier})`);

      assert.deepStrictEqual(strategy.edges(ctx), { headEnd: OPENING, recentStart: total - RECENT }, 'both edges are where the chunks were laid');
      assert.deepStrictEqual(await sent(budget), before, 'the compile after the fall sends what the one before it sent');
      assert.strictEqual(strategy.leftOut, 0, 'no summary was left out for reaching into a window');
      await manager.close();
    });

    it(`${select}: a rise and the fall back move neither edge`, async () => {
      const { manager, strategy, ctx, total, recalibrate } = await laid(select);
      const at = { headEnd: OPENING, recentStart: total - RECENT };
      await recalibrate(1500, 1.06, (m) => m >= 1.03);
      assert.deepStrictEqual(strategy.edges(ctx), at, 'after the rise');
      await recalibrate(1500, 0.94, (m) => m <= 0.97);
      assert.deepStrictEqual(strategy.edges(ctx), at, 'after the fall');
      await manager.close();
    });
  }
});

describe('a window that was widened grows over what chunks own', () => {
  it('the head window: held while the head the chunks left is at least half the window, then by its token count', async () => {
    const { manager, strategy, ctx, price } = await laid('kv-unified');
    const opening = price(0, OPENING);
    strategy.set('headWindowTokens', 2 * opening);
    assert.strictEqual(strategy.edges(ctx).headEnd, OPENING, 'twice the head the chunks left: held');
    strategy.set('headWindowTokens', 2 * opening + 1);
    const widened = strategy.edges(ctx).headEnd;
    assert.ok(widened > OPENING, `a token more than twice: the window takes what its count says (ends at ${widened})`);
    assert.ok(price(0, widened) <= 2 * opening + 1 && price(0, widened + 1) > 2 * opening + 1, 'and ends where its count does');
    await manager.close();
  });

  it('the recent window: held while the window the chunks left is at least half the window, then by its token count', async () => {
    const { manager, strategy, ctx, total, price } = await laid('kv-unified');
    const latest = price(total - RECENT, total);
    strategy.set('recentWindowTokens', 2 * latest);
    assert.strictEqual(strategy.edges(ctx).recentStart, total - RECENT, 'twice the window the chunks left: held');
    strategy.set('recentWindowTokens', 2 * latest + 1);
    const widened = strategy.edges(ctx).recentStart;
    assert.ok(widened < total - RECENT, `a token more than twice: the window takes what its count says (starts at ${widened})`);
    assert.ok(price(widened, total) <= 2 * latest + 1 && price(widened - 1, total) > 2 * latest + 1, 'and starts where its count does');
    await manager.close();
  });

  it('a recent window wider than the whole store takes it all', async () => {
    const { manager, strategy, ctx, total, price } = await laid('kv-unified');
    strategy.set('recentWindowTokens', price(0, total) + 1);
    assert.strictEqual(strategy.edges(ctx).recentStart, 0);
    await manager.close();
  });
});

describe('a hold that would part a call from its result gives way', () => {
  async function calls() {
    const path = `${STORE}-${process.pid}-${stores++}`;
    made.push(path);
    const strategy = new Held({ targetChunkTokens: 1e9, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false, hierarchical: true } as never);
    const manager = await ContextManager.open({ path, strategy });
    const ctx = contextOf(manager);
    const said = (tag: string): string => `${tag} ` + 'words about what happened in this turn '.repeat(4);
    manager.addMessage('user', text(said('ask 0')));
    manager.addMessage('agent', [{ type: 'text', text: said('looking 1') }, { type: 'tool_use', id: 't0', name: 'search', input: { q: 'zero' } }] as never);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: 't0', content: said('result 2') }] as never);
    for (let i = 3; i < 9; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(said(`turn ${i}`)));
    manager.addMessage('agent', [{ type: 'text', text: said('looking 9') }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'one' } }] as never);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: 't1', content: said('result 10') }] as never);
    for (let i = 11; i < 14; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(said(`turn ${i}`)));
    const all = ctx.messageStore.getAll();
    const ids = (from: number, to: number): string[] => all.slice(from, to).map((m) => m.id);
    const tokens = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += ctx.messageStore.estimateTokens(all[i]!);
      return sum;
    };
    return { manager, strategy, ctx, ids, tokens };
  }

  it("the head window: the first owned message is a call's result, so the head goes by its count", async () => {
    const { manager, strategy, ctx, ids, tokens } = await calls();
    strategy.seedL1('L1-A', ids(2, 6));
    strategy.set('headWindowTokens', tokens(0, 4) - 1);
    assert.ok(tokens(0, 2) * 2 >= tokens(0, 4) - 1, 'premise: the head before the first owned message is at least half the window');
    assert.strictEqual(strategy.edges(ctx).headEnd, 3, 'the head ends where its count does, after the result');
    await manager.close();
  });

  it("the recent window: the message after the last owned one is its result, so the window goes by its count", async () => {
    const { manager, strategy, ctx, ids, tokens } = await calls();
    strategy.seedL1('L1-A', ids(6, 10));
    strategy.set('recentWindowTokens', tokens(10, 14) + 1);
    assert.strictEqual(strategy.edges(ctx).recentStart, 9, 'the window starts at the call, as its count and the pairing rule say');
    await manager.close();
  });

  it('with the call and its result both past the edge, each window holds', async () => {
    const { manager, strategy, ctx, ids, tokens } = await calls();
    strategy.seedL1('L1-A', ids(3, 9));
    strategy.set('headWindowTokens', tokens(0, 4));
    strategy.set('recentWindowTokens', tokens(8, 14));
    assert.deepStrictEqual(strategy.edges(ctx), { headEnd: 3, recentStart: 9 });
    await manager.close();
  });
});

describe('a store with no chunk in the way', () => {
  it('both windows go by their token counts', async () => {
    const path = `${STORE}-${process.pid}-${stores++}`;
    made.push(path);
    const strategy = new Held({ headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false, hierarchical: true } as never);
    const manager = await ContextManager.open({ path, strategy });
    const ctx = contextOf(manager);
    for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + 'substantive words about real happenings '.repeat(8)));
    const all = ctx.messageStore.getAll();
    const one = ctx.messageStore.estimateTokens(all[0]!);
    strategy.set('headWindowTokens', 3 * one);
    strategy.set('recentWindowTokens', 2 * one);
    assert.strictEqual(strategy.owned().size, 0, 'premise: nothing is chunked');
    assert.deepStrictEqual(strategy.edges(ctx), { headEnd: 3, recentStart: 10 });
    await manager.close();
  });
});
