import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext, SummaryEntry } from '../src/types/strategy.js';
import type { StoredMessage } from '../src/types/message.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-dearer-summaries';
const made: string[] = [];
after(() => {
  for (const p of made) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
});

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }];
const words = (n: number): string => 'substantive words about real happenings '.repeat(n);

class Summaries extends AutobiographicalStrategy {
  all(): SummaryEntry[] {
    return this.summaries;
  }
  leavesOf(id: string): string[] {
    const byId = new Map(this.summaries.map((s) => [s.id, s]));
    const out = new Set<string>();
    const summary = byId.get(id);
    if (summary) this.expandSummaryToLeafMessageIds(summary, byId, out);
    return [...out];
  }
  seedL1(id: string, sourceIds: string[]): SummaryEntry {
    const s = {
      id, level: 1, content: `${id} recalls ${sourceIds.length} messages`, tokens: 8, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! }, created: Date.now(),
    } as SummaryEntry;
    this.summaries.push(s);
    return s;
  }
  sentEstimate(ctx: StrategyContext, msg: StoredMessage): number {
    return ctx.messageStore.estimateTokens(this.prunedForSend(ctx.messageStore, msg));
  }
}

const contextOf = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

let stores = 0;

async function built(
  extra: Record<string, unknown> = {},
  write: (manager: ContextManager) => void = (manager) => {
    for (let i = 0; i < 32; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
  },
) {
  const path = `${STORE}-${process.pid}-${stores++}`;
  made.push(path);
  let calls = 0;
  const membrane = {
    complete: async () => ({ stopReason: 'end_turn', content: text(`[summary ${++calls}] brief`), usage: { input_tokens: 100, output_tokens: 10 } }),
  };
  const strategy = new Summaries({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    mergeThreshold: 100,
    autoTickOnNewMessage: false,
    hierarchical: true,
    overBudgetGraceRatio: 0,
    ...extra,
  } as never);
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ctx = contextOf(manager);
  write(manager);
  for (let i = 0; i < 2000 && !manager.isReady(); i++) await manager.tick();
  assert.ok(manager.isReady(), 'premise: compression converged');
  const all = ctx.messageStore.getAll();
  const position = new Map(all.map((m, i) => [m.id, i]));
  const byId = new Map(all.map((m) => [m.id, m]));
  const estimate = (s: string): number => ctx.messageStore.estimateTokens({ content: text(s) } as never);
  const rawOf = (ids: readonly string[]): number => ids.reduce((sum, id) => sum + ctx.messageStore.estimateTokens(byId.get(id)!), 0);
  const pairOf = (s: SummaryEntry): number => estimate(`[Recall ${s.id}]`) + estimate(s.content);
  const level = (n: number): SummaryEntry[] =>
    strategy.all().filter((s) => s.level === n && !s.mergedInto)
      .sort((a, b) => position.get(strategy.leavesOf(a.id)[0]!)! - position.get(strategy.leavesOf(b.id)[0]!)!);
  const rewrite = (s: SummaryEntry, content: string): void => {
    s.content = content;
    s.tokens = estimate(content);
  };
  const shape = (): string => JSON.stringify({
    l1: strategy.all().filter((s) => s.level === 1).map((s) => `${s.id}${s.mergedInto ? '>' + s.mergedInto : ''}:${strategy.leavesOf(s.id).map((id) => position.get(id)).join(',')}`),
    chunks: (strategy as unknown as { chunks: Array<{ compressed: boolean; messages: Array<{ id: string }> }> }).chunks.map((c) => `${c.compressed ? 'c' : 'u'}:${c.messages.map((m) => position.get(m.id)).join(',')}`),
  });
  const sent = async (maxTokens: number) => {
    const result = await manager.compile({ maxTokens, reserveForResponse: 0 });
    const sources = result.provenance!.messages;
    const raw = new Set(sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : [])));
    const summaries = new Set(sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.map((x) => x.id) : [])));
    const inSummaries = new Set([...summaries].flatMap((id) => strategy.leavesOf(id)));
    const order = sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : m.kind === 'summary' ? m.summaries.map((x) => x.id) : []));
    return { raw, summaries, inSummaries, order };
  };
  return { manager, strategy, ctx, all, position, estimate, rawOf, pairOf, level, rewrite, sent, shape };
}

describe('a summary weighed against what it covers, on the hierarchical select', () => {
  it('sends the messages raw in place of an L1 that costs more than they do, and fits a budget that L1 could not', async () => {
    const f = await built();
    const l1s = f.level(1);
    assert.ok(l1s.length >= 3, `premise: several L1s (${l1s.length})`);
    const dear = l1s[1]!;
    const leaves = f.strategy.leavesOf(dear.id);
    const everything = f.rawOf(f.all.map((m) => m.id));
    f.rewrite(dear, 'a long recollection of everything said in those moments '.repeat(Math.ceil((everything * 4 * 1.5) / 57)));
    assert.ok(f.pairOf(dear) > everything, `premise: the L1's pair alone (${f.pairOf(dear)}) costs more than every message in the store (${everything})`);

    const wide = await f.sent(1_000_000);
    assert.ok(!wide.summaries.has(dear.id), 'no recall pair for the dearer L1');
    for (const id of leaves) assert.ok(wide.raw.has(id), `its message ${id} goes out raw`);
    for (const s of l1s) if (s !== dear) assert.ok(wide.summaries.has(s.id), `${s.id}, cheaper than its messages, still goes out`);

    const narrow = await f.sent(everything);
    assert.ok(!narrow.summaries.has(dear.id) && leaves.every((id) => narrow.raw.has(id)), 'at a budget of every message in the store, the compile sends the messages and fits');
    await f.manager.close();
  });

  it('sends every summary that costs less than its messages, and none of their messages raw', async () => {
    const f = await built();
    const l1s = f.level(1);
    assert.ok(l1s.length >= 3, `premise: several L1s (${l1s.length})`);
    for (const s of l1s) assert.ok(f.pairOf(s) * 4 < f.rawOf(f.strategy.leavesOf(s.id)), `premise: ${s.id} costs well under its messages`);
    const wide = await f.sent(1_000_000);
    for (const s of l1s) {
      assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
      for (const id of f.strategy.leavesOf(s.id)) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    }
    await f.manager.close();
  });

  const pinCases = [
    { dearer: false, title: 'sends an L1 beside the messages a pin keeps raw where it costs less than all its messages, though more than the rest' },
    { dearer: true, title: 'sends the messages raw in place of an L1 over messages a pin keeps raw where it costs more than all its messages' },
  ];
  for (const { dearer, title } of pinCases) {
    it(title, async () => {
      const f = await built();
      const s = f.level(1)[1]!;
      const leaves = f.strategy.leavesOf(s.id).sort((x, y) => f.position.get(x)! - f.position.get(y)!);
      assert.ok(leaves.length >= 4, `premise: the L1 holds four messages or more (${f.shape()})`);
      const pinned = leaves.slice(1, 3);
      f.manager.pinRange(pinned[0]!, pinned[1]!);
      const rest = leaves.filter((id) => !pinned.includes(id));
      const phrase = 'what those moments held, in brief ';
      const size = dearer ? 1.6 * f.rawOf(leaves) : Math.sqrt(f.rawOf(rest) * f.rawOf(leaves));
      f.rewrite(s, phrase.repeat(Math.round(size / (f.estimate(phrase.repeat(100)) / 100))));
      if (dearer) {
        assert.ok(f.pairOf(s) > 1.25 * f.rawOf(leaves), `premise: the L1 (${f.pairOf(s)}) costs well over all its messages (${f.rawOf(leaves)})`);
      } else {
        assert.ok(f.rawOf(rest) * 1.25 < f.pairOf(s) && f.pairOf(s) * 1.25 < f.rawOf(leaves),
          `premise: the L1 (${f.pairOf(s)}) costs well over its unpinned messages (${f.rawOf(rest)}) and well under all its messages (${f.rawOf(leaves)})`);
      }

      const wide = await f.sent(1_000_000);
      for (const id of pinned) assert.ok(wide.raw.has(id), `premise: the pinned ${id} goes out raw`);
      if (dearer) {
        assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
        for (const id of rest) assert.ok(wide.raw.has(id), `${id} goes out raw`);
      } else {
        assert.ok(wide.summaries.has(s.id), `${s.id} goes out beside the pin`);
        for (const id of rest) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
      }
      await f.manager.close();
    });
  }

  it('keeps an L2 that costs more than its L1s as pairs, though less than its messages', async () => {
    const f = await built({ mergeThreshold: 4 });
    const l2 = f.level(2)[0];
    assert.ok(l2, 'premise: an unmerged L2');
    const children = l2.sourceIds.map((id) => f.strategy.all().find((s) => s.id === id)!);
    const childPairs = children.reduce((sum, c) => sum + f.pairOf(c), 0);
    const leaves = f.strategy.leavesOf(l2.id);
    const raw = f.rawOf(leaves);
    f.rewrite(l2, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4) / 3 / 38)));
    assert.ok(f.pairOf(l2) > 3 * childPairs, `premise: the L2 (${f.pairOf(l2)}) costs well over its L1s (${childPairs})`);
    assert.ok(f.pairOf(l2) * 1.5 < raw, `premise: the L2 (${f.pairOf(l2)}) costs well under its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(l2.id), 'the L2 goes out');
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('sends an L2 that costs more than all its messages as those messages, with none of the summaries under it', async () => {
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const ids = f.all.map((m) => m.id);
    const first = f.strategy.seedL1('L1-first', ids.slice(4, 8));
    const second = f.strategy.seedL1('L1-second', ids.slice(8, 12));
    const parent = {
      id: 'L2-over-both', level: 2, content: '', tokens: 0, sourceLevel: 1,
      sourceIds: [first.id, second.id], sourceRange: { first: first.sourceRange.first, last: second.sourceRange.last }, created: Date.now(),
    } as SummaryEntry;
    f.strategy.all().push(parent);
    first.mergedInto = parent.id;
    second.mergedInto = parent.id;
    for (const [c, leaves] of [[first, ids.slice(4, 8)], [second, ids.slice(8, 12)]] as const) {
      assert.ok(f.pairOf(c) * 2 < f.rawOf(leaves), `premise: ${c.id} costs well under its messages`);
    }
    const raw = f.rawOf(ids.slice(4, 12));
    f.rewrite(parent, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 38)));
    assert.ok(f.pairOf(parent) > 1.5 * raw, `premise: the L2 (${f.pairOf(parent)}) costs well over all its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    for (const s of [parent, first, second]) assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    for (const id of ids.slice(4, 12)) assert.ok(wide.raw.has(id), `${id} goes out raw`);
    await f.manager.close();
  });

  it('sends an L3 that costs more than all its messages as those messages, with none of the summaries under it', async () => {
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const ids = f.all.map((m) => m.id);
    const l1s = [0, 1, 2, 3].map((k) => f.strategy.seedL1(`L1-${k}`, ids.slice(4 + 4 * k, 8 + 4 * k)));
    const merged = (id: string, level: number, sources: SummaryEntry[]): SummaryEntry => {
      const s = {
        id, level, content: '', tokens: 0, sourceLevel: level - 1, sourceIds: sources.map((c) => c.id),
        sourceRange: { first: sources[0]!.sourceRange.first, last: sources[sources.length - 1]!.sourceRange.last }, created: Date.now(),
      } as SummaryEntry;
      f.strategy.all().push(s);
      for (const c of sources) c.mergedInto = id;
      return s;
    };
    const l2s = [merged('L2-0', 2, l1s.slice(0, 2)), merged('L2-1', 2, l1s.slice(2, 4))];
    const top = merged('L3-top', 3, l2s);
    for (const s of l2s) f.rewrite(s, 'those hours in brief');
    for (const s of [...l1s, ...l2s]) assert.ok(f.pairOf(s) * 2 < f.rawOf(f.strategy.leavesOf(s.id)), `premise: ${s.id} costs well under its messages`);
    const raw = f.rawOf(ids.slice(4, 20));
    f.rewrite(top, 'what those days held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 37)));
    assert.ok(f.pairOf(top) > 1.5 * raw, `premise: the L3 (${f.pairOf(top)}) costs well over all its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    for (const s of [top, ...l2s, ...l1s]) assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    for (const id of ids.slice(4, 20)) assert.ok(wide.raw.has(id), `${id} goes out raw`);
    await f.manager.close();
  });

  it('sends an L3 as main does where an L1 under it was never marked as merged into its L2, though it costs more than its messages', async () => {
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const ids = f.all.map((m) => m.id);
    const l1s = [0, 1, 2, 3].map((k) => f.strategy.seedL1(`L1-${k}`, ids.slice(4 + 4 * k, 8 + 4 * k)));
    const merged = (id: string, level: number, sources: SummaryEntry[]): SummaryEntry => {
      const s = {
        id, level, content: '', tokens: 0, sourceLevel: level - 1, sourceIds: sources.map((c) => c.id),
        sourceRange: { first: sources[0]!.sourceRange.first, last: sources[sources.length - 1]!.sourceRange.last }, created: Date.now(),
      } as SummaryEntry;
      f.strategy.all().push(s);
      for (const c of sources) c.mergedInto = id;
      return s;
    };
    const l2s = [merged('L2-0', 2, l1s.slice(0, 2)), merged('L2-1', 2, l1s.slice(2, 4))];
    const top = merged('L3-top', 3, l2s);
    delete l1s[3]!.mergedInto;
    for (const s of l2s) f.rewrite(s, 'those hours in brief');
    const raw = f.rawOf(ids.slice(4, 20));
    f.rewrite(top, 'what those days held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 37)));
    assert.ok(f.pairOf(top) > 1.5 * raw, `premise: the L3 (${f.pairOf(top)}) costs well over all its messages (${raw})`);
    assert.ok(l2s.every((s) => s.mergedInto === top.id) && !l1s[3]!.mergedInto, 'premise: both L2s are marked, and one L1 under them isn\'t');

    const wide = await f.sent(1_000_000);
    for (const s of [top, l1s[3]!]) assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of ids.slice(4, 20)) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('sends an L3 as main does where an L2 under it was never marked as merged into it, though it costs more than its messages', async () => {
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const ids = f.all.map((m) => m.id);
    const l1s = [0, 1, 2, 3].map((k) => f.strategy.seedL1(`L1-${k}`, ids.slice(4 + 4 * k, 8 + 4 * k)));
    const merged = (id: string, level: number, sources: SummaryEntry[]): SummaryEntry => {
      const s = {
        id, level, content: '', tokens: 0, sourceLevel: level - 1, sourceIds: sources.map((c) => c.id),
        sourceRange: { first: sources[0]!.sourceRange.first, last: sources[sources.length - 1]!.sourceRange.last }, created: Date.now(),
      } as SummaryEntry;
      f.strategy.all().push(s);
      for (const c of sources) c.mergedInto = id;
      return s;
    };
    const l2s = [merged('L2-0', 2, l1s.slice(0, 2)), merged('L2-1', 2, l1s.slice(2, 4))];
    const top = merged('L3-top', 3, l2s);
    delete l2s[1]!.mergedInto;
    for (const s of l2s) f.rewrite(s, 'those hours in brief');
    const raw = f.rawOf(ids.slice(4, 20));
    f.rewrite(top, 'what those days held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 37)));
    assert.ok(f.pairOf(top) > 1.5 * raw, `premise: the L3 (${f.pairOf(top)}) costs well over all its messages (${raw})`);
    assert.ok(l2s[0]!.mergedInto === top.id && !l2s[1]!.mergedInto && l1s.every((s) => s.mergedInto), 'premise: one L2 is marked, the other isn\'t, and every L1 is');

    const wide = await f.sent(1_000_000);
    for (const s of [top, l2s[1]!]) assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of ids.slice(4, 20)) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('doesn\'t spend the L1 budget a replaced L1 held on a summary that budget left out beside messages a pin keeps raw', async () => {
    const scene = async (dear: boolean) => {
      const f = await built({ targetChunkTokens: 1e9, l1BudgetTokens: 1000, l2BudgetTokens: 0, l3BudgetTokens: 0 }, (manager) => {
        for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      });
      const ids = f.all.map((m) => m.id);
      const first = f.strategy.seedL1('L1-first', ids.slice(4, 8));
      const overPins = f.strategy.seedL1('L1-over-pins', ids.slice(8, 12));
      f.manager.pinRange(ids[8]!, ids[11]!);
      const raw = f.rawOf(ids.slice(4, 8));
      if (dear) {
        f.rewrite(first, 'a long recollection of everything said in those moments '.repeat(Math.ceil((raw * 4 * 2) / 57)));
        assert.ok(f.pairOf(first) > 1.5 * raw, `premise: the first L1 (${f.pairOf(first)}) costs well over its messages (${raw})`);
      } else {
        assert.ok(f.pairOf(first) * 2 < raw, 'premise: the first L1 costs well under its messages');
      }
      first.tokens = 600;
      overPins.tokens = 600;
      assert.ok(f.pairOf(overPins) * 2 < f.rawOf(ids.slice(8, 12)), 'premise: the L1 over pinned messages costs well under them');
      const sent = await f.sent(1_000_000);
      await f.manager.close();
      return { sent, first, overPins, ids };
    };
    const cheap = await scene(false);
    assert.ok(cheap.sent.summaries.has(cheap.first.id) && !cheap.sent.summaries.has(cheap.overPins.id), 'premise: where the first L1 costs less, the L1 budget takes it and leaves out the one over pinned messages');

    const { sent, first, overPins, ids } = await scene(true);
    assert.ok(!sent.summaries.has(first.id), 'no recall pair for the dearer L1');
    for (const id of ids.slice(4, 8)) assert.ok(sent.raw.has(id), `${id} goes out raw`);
    assert.ok(!sent.summaries.has(overPins.id), 'the L1 over pinned messages stays out');
    for (const id of ids.slice(8, 12)) assert.ok(sent.raw.has(id), `premise: the pinned ${id} goes out raw`);
  });

  it('doesn\'t carry the L2 budget a replaced L2 held into the L1 budget for a summary left out beside messages a pin keeps raw', async () => {
    const scene = async (dear: boolean) => {
      const f = await built({ targetChunkTokens: 1e9, l1BudgetTokens: 100, l2BudgetTokens: 600, l3BudgetTokens: 0 }, (manager) => {
        for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      });
      const ids = f.all.map((m) => m.id);
      const first = f.strategy.seedL1('L1-first', ids.slice(4, 8));
      const second = f.strategy.seedL1('L1-second', ids.slice(8, 12));
      const parent = {
        id: 'L2-replaced', level: 2, content: 'those hours in brief', tokens: 0, sourceLevel: 1,
        sourceIds: [first.id, second.id], sourceRange: { first: first.sourceRange.first, last: second.sourceRange.last }, created: Date.now(),
      } as SummaryEntry;
      f.strategy.all().push(parent);
      first.mergedInto = parent.id;
      second.mergedInto = parent.id;
      const overPins = f.strategy.seedL1('L1-over-pins', ids.slice(12, 16));
      f.manager.pinRange(ids[12]!, ids[15]!);
      const raw = f.rawOf(ids.slice(4, 12));
      if (dear) {
        f.rewrite(parent, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 38)));
        assert.ok(f.pairOf(parent) > 1.5 * raw, `premise: the L2 (${f.pairOf(parent)}) costs well over all its messages (${raw})`);
      } else {
        assert.ok(f.pairOf(parent) * 2 < raw, 'premise: the L2 costs well under its messages');
      }
      parent.tokens = 600;
      overPins.tokens = 600;
      assert.ok(f.pairOf(overPins) * 2 < f.rawOf(ids.slice(12, 16)), 'premise: the L1 over pinned messages costs well under them');
      const sent = await f.sent(1_000_000);
      await f.manager.close();
      return { sent, parent, first, second, overPins, ids };
    };
    const cheap = await scene(false);
    assert.ok(cheap.sent.summaries.has(cheap.parent.id) && !cheap.sent.summaries.has(cheap.overPins.id), 'premise: where the L2 costs less, the L2 budget takes it and the L1 budget leaves out the one over pinned messages');

    const { sent, parent, first, second, overPins, ids } = await scene(true);
    for (const s of [parent, first, second]) assert.ok(!sent.summaries.has(s.id), `no recall pair for ${s.id}`);
    for (const id of ids.slice(4, 12)) assert.ok(sent.raw.has(id), `${id} goes out raw`);
    assert.ok(!sent.summaries.has(overPins.id), 'the L1 over pinned messages stays out');
  });

  it('doesn\'t bring a replaced L1 back to cover its messages where the budget left it out', async () => {
    const f = await built({ targetChunkTokens: 1e9, l1BudgetTokens: 0, l2BudgetTokens: 0, l3BudgetTokens: 0 }, (manager) => {
      for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const ids = f.all.map((m) => m.id);
    const replaced = f.strategy.seedL1('L1-replaced', ids.slice(4, 8));
    const kept = f.strategy.seedL1('L1-kept', ids.slice(8, 12));
    const raw = f.rawOf(ids.slice(4, 8));
    f.rewrite(replaced, 'a long recollection of everything said in those moments '.repeat(Math.ceil((raw * 4 * 2) / 57)));
    assert.ok(f.pairOf(replaced) > 1.5 * raw, `premise: the first L1 (${f.pairOf(replaced)}) costs well over its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(kept.id), 'premise: coverage brings back the L1 the budget left out');
    assert.ok(!wide.summaries.has(replaced.id), 'coverage doesn\'t bring back the dearer L1');
    for (const id of ids.slice(4, 8)) assert.ok(wide.raw.has(id), `${id} goes out raw`);
    await f.manager.close();
  });

  it('sends a merge that marked none of its sources as main does, its L1s going out, though it costs more than its messages', async () => {
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const ids = f.all.map((m) => m.id);
    const first = f.strategy.seedL1('L1-first', ids.slice(4, 8));
    const second = f.strategy.seedL1('L1-second', ids.slice(8, 12));
    const parent = {
      id: 'L2-interrupted', level: 2, content: '', tokens: 0, sourceLevel: 1,
      sourceIds: [first.id, second.id], sourceRange: { first: first.sourceRange.first, last: second.sourceRange.last }, created: Date.now(),
    } as SummaryEntry;
    f.strategy.all().push(parent);
    assert.ok(!first.mergedInto && !second.mergedInto, 'premise: the merge was interrupted, so neither L1 is merged into it');
    for (const [c, leaves] of [[first, ids.slice(4, 8)], [second, ids.slice(8, 12)]] as const) {
      assert.ok(f.pairOf(c) * 2 < f.rawOf(leaves), `premise: ${c.id} costs well under its messages`);
    }
    const raw = f.rawOf(ids.slice(4, 12));
    f.rewrite(parent, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 38)));
    assert.ok(f.pairOf(parent) > 1.5 * raw, `premise: the merged summary (${f.pairOf(parent)}) costs well over all its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    for (const c of [first, second]) assert.ok(wide.summaries.has(c.id), `${c.id} goes out`);
    assert.ok(!wide.summaries.has(parent.id), 'the merged summary doesn\'t go out beside them');
    for (const id of ids.slice(4, 12)) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('sends a merge that marked only some of its sources as main does, so a call isn\'t sent raw while its result stays in a summary', async () => {
    let held: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      held = [
        manager.addMessage('user', text('before ' + words(8))),
        manager.addMessage('agent', text('then ' + words(8))),
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-p', name: 'lookup', input: { q: 'p' } }] as ContentBlock[]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-p', content: 'found ' + words(8) }] as ContentBlock[]),
        manager.addMessage('agent', text('so ' + words(8))),
        manager.addMessage('user', text('next ' + words(8))),
        manager.addMessage('agent', text('done ' + words(8))),
      ];
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const marked = f.strategy.seedL1('L1-marked', held.slice(0, 4));
    const unmarked = f.strategy.seedL1('L1-unmarked', held.slice(4, 8));
    const parent = {
      id: 'L2-part-marked', level: 2, content: '', tokens: 0, sourceLevel: 1,
      sourceIds: [marked.id, unmarked.id], sourceRange: { first: marked.sourceRange.first, last: unmarked.sourceRange.last }, created: Date.now(),
    } as SummaryEntry;
    f.strategy.all().push(parent);
    marked.mergedInto = parent.id;
    assert.ok(!unmarked.mergedInto, 'premise: the merge stopped before marking its second source');
    const raw = f.rawOf(held);
    f.rewrite(parent, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 38)));
    assert.ok(f.pairOf(parent) > 1.5 * raw, `premise: the merged summary (${f.pairOf(parent)}) costs well over all its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    for (const s of [parent, unmarked]) assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of held) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L2 that costs more than its messages where one of them is a call answered inside another summary', async () => {
    let calling: string[] = [];
    let answering: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      calling = [
        manager.addMessage('user', text('before ' + words(8))),
        manager.addMessage('agent', text('then ' + words(8))),
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-m', name: 'lookup', input: { q: 'm' } }] as ContentBlock[]),
      ];
      answering = [
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-m', content: 'found ' + words(8) }] as ContentBlock[]),
        manager.addMessage('agent', text('so ' + words(8))),
      ];
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const low = f.strategy.seedL1('L1-low', calling.slice(0, 2));
    const high = f.strategy.seedL1('L1-high', calling.slice(2, 4));
    f.strategy.seedL1('L1-answers', answering);
    const parent = {
      id: 'L2-calls', level: 2, content: '', tokens: 0, sourceLevel: 1,
      sourceIds: [low.id, high.id], sourceRange: { first: low.sourceRange.first, last: high.sourceRange.last }, created: Date.now(),
    } as SummaryEntry;
    f.strategy.all().push(parent);
    low.mergedInto = parent.id;
    high.mergedInto = parent.id;
    const raw = f.rawOf(calling);
    f.rewrite(parent, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 38)));
    assert.ok(f.pairOf(parent) > 1.5 * raw, `premise: the L2 (${f.pairOf(parent)}) costs well over all its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(parent.id), 'the L2 goes out');
    for (const id of calling) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it("keeps an L1 that another summary also holds, so none of its messages goes out twice", async () => {
    const f = await built();
    const [, a, b] = f.level(1);
    assert.ok(a && b, 'premise: two adjacent L1s');
    f.strategy.all().push({
      id: 'L2-interrupted', level: 2, content: 'an interrupted merge of two recollections', tokens: 10, sourceLevel: 1,
      sourceIds: [a.id, b.id], sourceRange: { first: a.sourceRange.first, last: b.sourceRange.last }, created: Date.now(),
    } as SummaryEntry);
    const leaves = f.strategy.leavesOf(a.id);
    f.rewrite(a, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(a) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    const twice = [...wide.raw].filter((id) => wide.inSummaries.has(id));
    assert.deepStrictEqual(twice, [], 'no message goes out both raw and inside a summary');
    for (const id of leaves) assert.ok(wide.inSummaries.has(id), `its message ${id} goes out inside a summary`);
    await f.manager.close();
  });

  it('keeps an L1 that a summary listed ahead of it also holds, so none of its messages goes out twice', async () => {
    const f = await built();
    const [, a, b] = f.level(1);
    assert.ok(a && b, 'premise: two adjacent L1s');
    const merged = {
      id: 'L2-interrupted', level: 2, content: '', tokens: 0, sourceLevel: 1,
      sourceIds: [a.id, b.id], sourceRange: { first: a.sourceRange.first, last: b.sourceRange.last }, created: Date.now(),
    } as SummaryEntry;
    f.strategy.all().unshift(merged);
    const leaves = f.strategy.leavesOf(a.id);
    f.rewrite(a, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(a) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');
    f.rewrite(merged, 'an interrupted merge of two recollections');
    const all = f.rawOf([...leaves, ...f.strategy.leavesOf(b.id)]);
    assert.ok(f.pairOf(merged) * 2 < all, `premise: the merged summary (${f.pairOf(merged)}) costs well under all its messages (${all})`);
    assert.strictEqual(f.strategy.all()[0], merged, 'premise: the merged summary is listed ahead of its L1s');

    const wide = await f.sent(1_000_000);
    const twice = [...wide.raw].filter((id) => wide.inSummaries.has(id));
    assert.deepStrictEqual(twice, [], 'no message goes out both raw and inside a summary');
    for (const id of leaves) assert.ok(wide.inSummaries.has(id), `its message ${id} goes out inside a summary`);
    await f.manager.close();
  });

  it('keeps an L1 whose result answers a call inside another summary, so the result never goes out raw apart from its call', async () => {
    let call = '';
    let result = '';
    const f = await built({}, (manager) => {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      call = manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-x', name: 'lookup', input: { q: 'x' } }] as ContentBlock[]);
      const meanwhile = manager.addMessage('user', text('meanwhile ' + words(8)));
      manager.pinRange(meanwhile, meanwhile);
      result = manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-x', content: 'found ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'user' : 'agent', text(`later ${i} ` + words(8)));
    });
    const holding = (id: string) => f.strategy.all().find((s) => s.level === 1 && f.strategy.leavesOf(s.id).includes(id));
    const callers = holding(call);
    const answers = holding(result);
    assert.ok(callers && answers && callers !== answers && !answers.mergedInto,
      `premise: the call and its result sit in two L1s, the result's unmerged (${f.shape()}; call ${f.position.get(call)}, result ${f.position.get(result)})`);
    const leaves = f.strategy.leavesOf(answers.id);
    f.rewrite(answers, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(answers) > 2 * f.rawOf(leaves), "premise: the result's L1 costs more than twice its messages");

    const wide = await f.sent(1_000_000);
    assert.ok(wide.inSummaries.has(call), 'premise: the call goes out inside a summary');
    assert.ok(!wide.raw.has(result) && wide.inSummaries.has(result), 'the result goes out inside its summary, not raw');
    await f.manager.close();
  });

  const shapes: Array<{ shape: string; kept: boolean; pinnedAt?: number; write: (manager: ContextManager) => string[] }> = [
    { shape: 'a call answered in the message after it', kept: false, write: (manager) => [
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-s', name: 'lookup', input: { q: 's' } }] as ContentBlock[]),
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-s', content: 'found ' + words(8) }] as ContentBlock[]),
    ] },
    { shape: 'an answered call kept raw by a pin', kept: false, pinnedAt: 0, write: (manager) => [
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-k', name: 'lookup', input: { q: 'k' } }] as ContentBlock[]),
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-k', content: 'found ' + words(8) }] as ContentBlock[]),
    ] },
    { shape: 'a call and its result in one message', kept: false, write: (manager) => [
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-b', name: 'lookup', input: { q: 'b' } }, { type: 'tool_result', toolUseId: 'call-b', content: 'found ' + words(8) }] as ContentBlock[]),
      manager.addMessage('user', text('next ' + words(8))),
    ] },
    { shape: 'a result that answers no call', kept: true, write: (manager) => [
      manager.addMessage('agent', text('before ' + words(8))),
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-gone', content: 'found ' + words(8) }] as ContentBlock[]),
    ] },
    { shape: 'a result that answers no call, kept raw by a pin', kept: true, pinnedAt: 1, write: (manager) => [
      manager.addMessage('agent', text('before ' + words(8))),
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-pinned', content: 'found ' + words(8) }] as ContentBlock[]),
      manager.addMessage('agent', text('after ' + words(8))),
    ] },
    { shape: 'two results for one call', kept: true, write: (manager) => [
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-d', name: 'lookup', input: { q: 'd' } }] as ContentBlock[]),
      manager.addMessage('user', [
        { type: 'tool_result', toolUseId: 'call-d', content: 'found ' + words(8) },
        { type: 'tool_result', toolUseId: 'call-d', content: 'found again ' + words(8) },
      ] as ContentBlock[]),
    ] },
    { shape: 'a call answered right after them by a message no summary covers', kept: false, write: (manager) => {
      const leaves = [
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-n', name: 'lookup', input: { q: 'n' } }] as ContentBlock[]),
      ];
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-n', content: 'found ' + words(8) }] as ContentBlock[]);
      return leaves;
    } },
    { shape: 'a result answering a call right before them in a message no summary covers', kept: false, write: (manager) => {
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-v', name: 'lookup', input: { q: 'v' } }] as ContentBlock[]);
      return [
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-v', content: 'found ' + words(8) }] as ContentBlock[]),
        manager.addMessage('agent', text('so ' + words(8))),
      ];
    } },
    { shape: 'a result answering the call before them, a call and its result, and a call answered after them, all in one message', kept: false, write: (manager) => {
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-p1', name: 'lookup', input: { q: 'p1' } }] as ContentBlock[]);
      const leaves = [
        manager.addMessage('user', [
          { type: 'tool_result', toolUseId: 'call-p1', content: 'found ' + words(8) },
          { type: 'text', text: words(8) },
          { type: 'tool_use', id: 'call-p2', name: 'lookup', input: { q: 'p2' } },
          { type: 'tool_result', toolUseId: 'call-p2', content: 'found ' + words(8) },
          { type: 'tool_use', id: 'call-p3', name: 'lookup', input: { q: 'p3' } },
        ] as ContentBlock[]),
      ];
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-p3', content: 'found ' + words(8) }] as ContentBlock[]);
      return leaves;
    } },
    { shape: 'a result answering the last of two calls of its id in the message before them, which answers a call between the two itself', kept: true, write: (manager) => {
      manager.addMessage('agent', [
        { type: 'tool_use', id: 'call-r', name: 'lookup', input: { q: 'r1' } },
        { type: 'tool_use', id: 'call-s2', name: 'lookup', input: { q: 's2' } },
        { type: 'tool_result', toolUseId: 'call-s2', content: 'found ' + words(8) },
        { type: 'tool_use', id: 'call-r', name: 'lookup', input: { q: 'r2' } },
      ] as ContentBlock[]);
      return [
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-r', content: 'found ' + words(8) }] as ContentBlock[]),
        manager.addMessage('agent', text('so ' + words(8))),
      ];
    } },
    { shape: 'a result a message after the one past its call', kept: true, write: (manager) => [
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-l', name: 'lookup', input: { q: 'l' } }] as ContentBlock[]),
      manager.addMessage('user', text('meanwhile ' + words(8))),
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-l', content: 'found ' + words(8) }] as ContentBlock[]),
    ] },
    { shape: 'a call whose result comes after a message past them', kept: true, write: (manager) => {
      const leaves = [
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-o', name: 'lookup', input: { q: 'o' } }] as ContentBlock[]),
      ];
      manager.addMessage('user', text('meanwhile ' + words(8)));
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-o', content: 'found ' + words(8) }] as ContentBlock[]);
      return leaves;
    } },
  ];
  for (const { shape, kept, pinnedAt, write } of shapes) {
    it(`${kept ? 'keeps' : 'replaces'} an L1 that costs more than its messages where they hold ${shape}`, async () => {
      let leaves: string[] = [];
      const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
        leaves = write(manager);
        if (pinnedAt !== undefined) manager.pinRange(leaves[pinnedAt]!, leaves[pinnedAt]!);
        for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
      });
      const s = f.strategy.seedL1('L1-cycle', leaves);
      f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
      assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

      const wide = await f.sent(1_000_000);
      if (kept) {
        assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
        if (pinnedAt === undefined) for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
        else assert.ok(wide.raw.has(leaves[pinnedAt]!), 'the pin keeps its message raw');
      } else {
        assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
        for (const id of leaves) assert.ok(wide.raw.has(id), `${id} goes out raw`);
      }
      await f.manager.close();
    });
  }

  it('keeps an L1 whose messages sit between a call and its result', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-slow', name: 'lookup', input: { q: 'slow' } }] as ContentBlock[]);
      leaves = [0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`meanwhile ${i} ` + words(8))));
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-slow', content: 'found ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-between', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('replaces an L1 between a result and a later call of its id, since a call after its result spans nothing', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-after', content: 'found early ' + words(8) }] as ContentBlock[]);
      leaves = [0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'user' : 'agent', text(`meanwhile ${i} ` + words(8))));
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-after', name: 'lookup', input: { q: 'after' } }] as ContentBlock[]);
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-after', content: 'found ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-after-an-early-result', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    for (const id of leaves) assert.ok(wide.raw.has(id), `${id} goes out raw`);
    await f.manager.close();
  });

  it('keeps an L1 whose messages sit between a call and its result where a result before them answers a call after them', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-later', content: 'found early ' + words(8) }] as ContentBlock[]);
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-slow', name: 'lookup', input: { q: 'slow' } }] as ContentBlock[]);
      leaves = [0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`meanwhile ${i} ` + words(8))));
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-slow', content: 'found ' + words(8) }] as ContentBlock[]);
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-later', name: 'lookup', input: { q: 'later' } }] as ContentBlock[]);
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-later', content: 'found ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-between-and-inside-a-reversed-pair', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L1 whose messages sit between a call and a result of its id that a later call reusing the id answers', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'first' } }] as ContentBlock[]);
      leaves = [0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`meanwhile ${i} ` + words(8))));
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'again' } }] as ContentBlock[]);
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-0', content: 'found ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-between-reused', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L1 holding a call and its result where an unanswered call before it has their id', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'lost' } }] as ContentBlock[]);
      manager.addMessage('user', text('never mind that ' + words(8)));
      leaves = [
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'again' } }] as ContentBlock[]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-0', content: 'found ' + words(8) }] as ContentBlock[]),
        ...[0, 1].map((i) => manager.addMessage(i % 2 ? 'user' : 'agent', text(`then ${i} ` + words(8)))),
      ];
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-holding-a-reused-id', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L1 holding a call and its result in one message where the message before it calls their id', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'lost' } }] as ContentBlock[]);
      leaves = [
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'again' } }, { type: 'tool_result', toolUseId: 'call-0', content: 'found ' + words(8) }] as ContentBlock[]),
        ...[0, 1].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`then ${i} ` + words(8)))),
      ];
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-after-a-call-of-its-id', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L1 holding a call and its result where a call after it reuses their id, since their id\'s first call is its own', async () => {
    let leaves: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      leaves = [
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'first' } }] as ContentBlock[]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-0', content: 'found ' + words(8) }] as ContentBlock[]),
        ...[0, 1].map((i) => manager.addMessage(i % 2 ? 'user' : 'agent', text(`then ${i} ` + words(8)))),
      ];
      manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-0', name: 'lookup', input: { q: 'again' } }] as ContentBlock[]);
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-0', content: 'found again ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const s = f.strategy.seedL1('L1-before-a-reuse', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L2 whose messages include some between a call and its result that no summary covers', async () => {
    let ids: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      ids = [
        manager.addMessage('user', text('before ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-gap', name: 'lookup', input: { q: 'gap' } }] as ContentBlock[]),
        ...[0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`meanwhile ${i} ` + words(8)))),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-gap', content: 'found ' + words(8) }] as ContentBlock[]),
        manager.addMessage('agent', text('after ' + words(8))),
      ];
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const l1s = [f.strategy.seedL1('L1-a', [ids[0]!]), f.strategy.seedL1('L1-b', ids.slice(2, 6)), f.strategy.seedL1('L1-c', [ids[7]!])];
    const parent = {
      id: 'L2-around-a-call', level: 2, content: '', tokens: 0, sourceLevel: 1,
      sourceIds: l1s.map((c) => c.id), sourceRange: { first: ids[0]!, last: ids[7]! }, created: Date.now(),
    } as SummaryEntry;
    f.strategy.all().push(parent);
    for (const c of l1s) c.mergedInto = parent.id;
    const leaves = [ids[0]!, ...ids.slice(2, 6), ids[7]!];
    const raw = f.rawOf(leaves);
    f.rewrite(parent, 'what those hours held, told at length '.repeat(Math.ceil((raw * 4 * 2) / 38)));
    assert.ok(f.pairOf(parent) > 1.5 * raw, `premise: the L2 (${f.pairOf(parent)}) costs well over all its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(parent.id), 'the L2 goes out');
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L1 that sits, as sent, between a call at the start of a head reset to after it and the call\'s result after the head', async () => {
    let leaves: string[] = [];
    let call = '';
    let result = '';
    const f = await built({ targetChunkTokens: 1e9, headWindowTokens: 300 }, (manager) => {
      leaves = [0, 1, 2, 3, 4, 5, 6].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`earlier ${i} ` + words(8))));
      call = manager.addMessage('agent', [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call-reset', name: 'lookup', input: { q: 'r' } }] as ContentBlock[]);
      manager.addMessage('user', text('meanwhile, briefly'));
      result = manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-reset', content: 'found ' + words(60) }] as ContentBlock[]);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    f.strategy.resetHeadWindow(call);
    const s = f.strategy.seedL1('L1-before-the-head', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.raw.has(call) && !wide.inSummaries.has(call), 'premise: the head sends the call raw');
    const at = (id: string): number => wide.order.indexOf(id);
    const place = [s.id, ...leaves].map(at).filter((i) => i >= 0);
    assert.ok(at(call) < Math.min(...place), 'premise: the call goes out before the L1\'s place');
    assert.ok(wide.raw.has(result) && at(result) > Math.max(...place), 'premise: the result goes out after the head, past the L1\'s place');
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    await f.manager.close();
  });

  it('keeps an L1 whose last call is answered by the first message of a head reset to after it, since the head goes out before them', async () => {
    let leaves: string[] = [];
    let answer = '';
    const f = await built({ targetChunkTokens: 1e9, headWindowTokens: 200 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      leaves = [
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-h', name: 'lookup', input: { q: 'h' } }] as ContentBlock[]),
      ];
      answer = manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-h', content: 'found ' + words(8) }] as ContentBlock[]);
      for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    f.strategy.resetHeadWindow(answer);
    const s = f.strategy.seedL1('L1-before-head', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(leaves) * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * f.rawOf(leaves), 'premise: the L1 costs more than twice its messages');

    const wide = await f.sent(1_000_000);
    assert.ok(wide.raw.has(answer) && !wide.inSummaries.has(answer), 'premise: the head sends the answer raw');
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    await f.manager.close();
  });

  it('keeps an L1 whose last call is answered by a result a pin keeps raw, where another summary holds that result, so no recall pair can come between the raw call and its result', async () => {
    let calling: string[] = [];
    let answering: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      calling = [
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-p', name: 'lookup', input: { q: 'p' } }] as ContentBlock[]),
      ];
      answering = [
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-p', content: 'found ' + words(8) }] as ContentBlock[]),
        manager.addMessage('agent', text('so ' + words(8))),
      ];
      manager.pinRange(answering[0]!, answering[0]!);
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const dear = f.strategy.seedL1('L1-calls', calling);
    const cheap = f.strategy.seedL1('L1-answers', answering);
    f.rewrite(dear, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(calling) * 4 * 3) / 57)));
    f.rewrite(cheap, 'what came back');
    assert.ok(f.pairOf(dear) > 2 * f.rawOf(calling), `premise: ${dear.id} costs more than twice its messages`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.raw.has(answering[0]!), 'premise: the pin keeps the result raw');
    assert.ok(wide.summaries.has(cheap.id), `premise: ${cheap.id} goes out beside the pin`);
    assert.ok(wide.summaries.has(dear.id), `${dear.id} goes out`);
    await f.manager.close();
  });

  for (const side of ['call', 'result'] as const) {
    it(`keeps an L1 whose ${side === 'call' ? "call is answered" : "result answers a call"} inside another summary next to it, so neither goes out raw apart from the other`, async () => {
      let calling: string[] = [];
      let answering: string[] = [];
      const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
        calling = [
          manager.addMessage('user', text('ask ' + words(8))),
          manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-c', name: 'lookup', input: { q: 'c' } }] as ContentBlock[]),
        ];
        answering = [
          manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-c', content: 'found ' + words(8) }] as ContentBlock[]),
          manager.addMessage('agent', text('so ' + words(8))),
        ];
        for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
      });
      const callers = f.strategy.seedL1('L1-calls', calling);
      const answers = f.strategy.seedL1('L1-answers', answering);
      const [dear, cheap, dearLeaves, cheapLeaves] = side === 'call' ? [callers, answers, calling, answering] : [answers, callers, answering, calling];
      f.rewrite(dear, 'a long recollection of everything said in those moments '.repeat(Math.ceil((f.rawOf(dearLeaves) * 4 * 3) / 57)));
      assert.ok(f.pairOf(dear) > 2 * f.rawOf(dearLeaves), `premise: ${dear.id} costs more than twice its messages`);
      assert.ok(f.pairOf(cheap) * 2 < f.rawOf(cheapLeaves), `premise: ${cheap.id} costs well under its messages`);

      const wide = await f.sent(1_000_000);
      assert.ok(wide.summaries.has(cheap.id), `premise: ${cheap.id} goes out`);
      assert.ok(wide.summaries.has(dear.id), `${dear.id} goes out`);
      for (const id of dearLeaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
      await f.manager.close();
    });
  }

  it("doesn't move a summary's choice with the token calibration", async () => {
    const f = await built();
    const s = f.level(1)[1]!;
    const leaves = f.strategy.leavesOf(s.id);
    const raw = f.rawOf(leaves);
    assert.ok(f.pairOf(s) * 4 < raw, `premise: by estimate, ${s.id} (${f.pairOf(s)}) costs well under its messages (${raw})`);
    s.responseContent = text(s.content);
    s.tokens = raw;
    for (const calibration of [0.3, 1, 3.5]) {
      f.ctx.messageStore.setTokenCalibration!(calibration);
      const wide = await f.sent(10_000_000);
      assert.strictEqual(f.ctx.messageStore.getTokenCalibration!(), calibration, `premise: the compile ran at calibration ${calibration}`);
      assert.ok(wide.summaries.has(s.id), `at calibration ${calibration}, ${s.id} goes out`);
      for (const id of leaves) assert.ok(!wide.raw.has(id), `at calibration ${calibration}, ${id} doesn't go out raw`);
    }
    await f.manager.close();
  });

  for (const dearer of [false, true]) {
    it(dearer
      ? 'sends the messages raw in place of a summary that costs more than them whole, with the marker for each result left out of the context'
      : 'keeps a summary of messages whose results are left out of the context, where the whole messages cost more', async () => {
      const f = await built({ toolResultMaxLastN: 0, targetChunkTokens: 1e9 }, (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
        manager.addMessage('agent', [{ type: 'text', text: words(8) }, { type: 'tool_use', id: 'call-big', name: 'fetch', input: { q: 'y' } }] as ContentBlock[]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-big', content: 'a line of what the fetch returned '.repeat(240) }] as ContentBlock[]);
        for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'user' : 'agent', text(`later ${i} ` + words(8)));
      });
      const leaves = f.all.slice(4, 8).map((m) => m.id);
      const whole = f.rawOf(leaves);
      const asSent = f.all.slice(4, 8).reduce((sum, m) => sum + f.strategy.sentEstimate(f.ctx, m), 0);
      const s = f.strategy.seedL1('L1-fetch', leaves);
      const phrase = 'what the fetch turned up, in brief ';
      const size = dearer ? 1.6 * whole : Math.sqrt(asSent * whole);
      f.rewrite(s, phrase.repeat(Math.round(size / (f.estimate(phrase.repeat(100)) / 100))));
      if (dearer) {
        assert.ok(f.pairOf(s) > 1.25 * whole, `premise: the L1 (${f.pairOf(s)}) costs well over its messages whole (${whole})`);
      } else {
        assert.ok(asSent * 1.5 < f.pairOf(s) && f.pairOf(s) * 1.5 < whole,
          `premise: the L1 (${f.pairOf(s)}) costs well over its messages as sent (${asSent}) and well under them whole (${whole})`);
      }

      const wide = await f.sent(1_000_000);
      if (dearer) {
        assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
        for (const id of leaves) assert.ok(wide.raw.has(id), `${id} goes out raw`);
        const { messages } = await f.manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        assert.ok(messages.some((m) => JSON.stringify(m.content).includes("left out: this context shows none of its results")), "the fetch's result goes out as the marker");
      } else {
        assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
        for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
      }
      await f.manager.close();
    });
  }

  it('keeps a summary of messages whose tool results cost less than the markers that replace them, where the messages as sent cost more than it does', async () => {
    const f = await built({ toolResultMaxLastN: 0, targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      for (let k = 0; k < 4; k++) {
        manager.addMessage('agent', [{ type: 'tool_use', id: `call-t${k}`, name: 'lookup', input: { q: `t${k}` } }] as ContentBlock[]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: `call-t${k}`, content: 'ok' }] as ContentBlock[]);
      }
      for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
    });
    const leaves = f.all.slice(4, 12).map((m) => m.id);
    const whole = f.rawOf(leaves);
    const asSent = f.all.slice(4, 12).reduce((sum, m) => sum + f.strategy.sentEstimate(f.ctx, m), 0);
    const s = f.strategy.seedL1('L1-lookups', leaves);
    const phrase = 'what the lookups returned ';
    f.rewrite(s, phrase.repeat(Math.round(Math.sqrt(whole * asSent) / (f.estimate(phrase.repeat(100)) / 100))));
    assert.ok(whole * 1.1 < f.pairOf(s) && f.pairOf(s) * 1.1 < asSent,
      `premise: the L1 (${f.pairOf(s)}) costs well over its messages as stored (${whole}) and well under them as sent (${asSent})`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps an L1 that costs more than its messages whole, where maxMessageTokens cuts it to well under them', async () => {
    const cap = 200;
    const f = await built({ maxMessageTokens: cap, targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
    });
    const leaves = f.all.slice(4, 16).map((m) => m.id);
    for (const id of leaves) assert.ok(f.rawOf([id]) < cap, `premise: message ${id} (${f.rawOf([id])}) is under the cap`);
    const raw = f.rawOf(leaves);
    const s = f.strategy.seedL1('L1-cut', leaves);
    f.rewrite(s, 'a long recollection of everything said in those moments '.repeat(Math.ceil((raw * 4 * 3) / 57)));
    assert.ok(f.pairOf(s) > 2 * raw, `premise: the L1 uncut (${f.pairOf(s)}) costs more than twice its messages (${raw})`);
    assert.ok((cap + 50) * 1.5 < raw, `premise: the L1 cut to the cap, with its header and marker, costs well under its messages (${raw})`);

    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leaves) assert.ok(!wide.raw.has(id), `${id} doesn't go out raw`);
    const { messages } = await f.manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    assert.ok(messages.some((m) => JSON.stringify(m.content).includes('[truncated')), 'premise: the L1 goes out cut');
    await f.manager.close();
  });
});
