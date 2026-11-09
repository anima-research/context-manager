import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext, SummaryEntry } from '../src/types/strategy.js';
import type { ContextEntry } from '../src/types/context.js';
import type { StoredMessage } from '../src/types/message.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-dearer-summaries';
const made: string[] = [];
after(() => {
  for (const p of made) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
});

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }];
const words = (n: number): string => 'substantive words about real happenings '.repeat(n);
const callBlock = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'lookup', input: { q: id } }) as ContentBlock;
const call = (id: string): ContentBlock[] => [{ type: 'text', text: words(8) }, callBlock(id)] as ContentBlock[];
const resultBlock = (id: string, note = 'found '): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: note + words(8) }) as ContentBlock;
const result = (id: string, note = 'found '): ContentBlock[] => [resultBlock(id, note)];
const STUB = "[this call's result isn't shown in this context.";
const MOVED = '[tool result moved during context repair]';

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
  seed(id: string, level: number, sources: string[], first: string, last: string): SummaryEntry {
    const s = {
      id, level, content: `${id} recalls what happened`, tokens: 8, sourceLevel: level - 1, sourceIds: sources,
      sourceRange: { first, last }, created: Date.now(),
    } as SummaryEntry;
    this.summaries.push(s);
    return s;
  }
  charge(s: SummaryEntry): number {
    return this.recallPairCost(s, this.buildRecallHeader(s));
  }
  answerCharge(s: SummaryEntry): number {
    return this.recallAnswerCost(s).cost;
  }
  rawPrice(ctx: StrategyContext, m: StoredMessage): number {
    return ctx.messageStore.estimateTokens(this.prunedForSend(ctx.messageStore, m));
  }
  stubPrice(ctx: StrategyContext, id: string): number {
    const stub = { type: 'tool_result', toolUseId: id, content: (AutobiographicalStrategy as unknown as Record<string, string>).STUB_TOOL_RESULT_TEXT } as ContentBlock;
    return ctx.messageStore.estimateTokens({ content: [stub] } as never);
  }
  regions(ctx: StrategyContext): { headStart: number; headEnd: number; recentStart: number } {
    const store = ctx.messageStore;
    return { headStart: this.getHeadWindowStartIndex(store), headEnd: this.getHeadWindowEnd(store), recentStart: this.getRecentWindowStart(store) };
  }
}

const contextOf = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

let stores = 0;

const issueStore = (manager: ContextManager): void => {
  for (let i = 0; i < 32; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
};

const keyOf = (b: ContentBlock): string | null => {
  const block = b as { type: string; id?: string; toolUseId?: string; content?: unknown; text?: string };
  if (block.type === 'tool_use') return `call ${block.id}`;
  if (block.type === 'tool_result') return typeof block.content === 'string' && block.content.startsWith(STUB) ? `stub ${block.toolUseId}` : `result ${block.toolUseId}`;
  if (block.type === 'text' && block.text === MOVED) return 'moved';
  return null;
};

async function built(extra: Record<string, unknown> = {}, write: (manager: ContextManager) => void = issueStore) {
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
  const ids = all.map((m) => m.id);
  const position = new Map(all.map((m, i) => [m.id, i]));
  const byId = new Map(all.map((m) => [m.id, m]));
  const rawOf = (leaves: readonly string[]): number => leaves.reduce((sum, id) => sum + strategy.rawPrice(ctx, byId.get(id)!), 0);
  const leavesOf = (s: SummaryEntry): string[] => strategy.leavesOf(s.id).sort((a, b) => position.get(a)! - position.get(b)!);
  const l1s = (): SummaryEntry[] => strategy.all().filter((s) => s.level === 1 && !s.mergedInto)
    .sort((a, b) => position.get(leavesOf(a)[0]!)! - position.get(leavesOf(b)[0]!)!);
  const estimate = (s: string): number => ctx.messageStore.estimateTokens({ content: text(s) } as never);
  const dearer = (s: SummaryEntry, factor = 2): void => {
    const phrase = 'a long recollection of everything said in those moments ';
    const raw = rawOf(leavesOf(s));
    s.content = phrase.repeat(Math.ceil((factor * raw) / (estimate(phrase.repeat(100)) / 100)));
    s.tokens = estimate(s.content);
    assert.ok(strategy.charge(s) > raw, `premise: ${s.id}'s pair (${strategy.charge(s)}) costs more than its messages (${raw})`);
  };
  const sent = async (maxTokens: number) => {
    const compiled = await manager.compile({ maxTokens, reserveForResponse: 0 });
    const sources = compiled.provenance!.messages;
    const rawList = sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : []));
    const summaries = new Set(sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.map((x) => x.id) : [])));
    const total = compiled.messages.reduce((sum, m) => sum + ctx.messageStore.estimateTokens({ content: m.content } as never), 0);
    const tools = compiled.messages.flatMap((m) => (m.content as ContentBlock[]).flatMap((b) => keyOf(b) ?? []));
    return { raw: new Set(rawList), rawList, summaries, total, tools, compiled, stats: compiled.renderStats };
  };
  const rawInOrder = (wide: Awaited<ReturnType<typeof sent>>, leaves: readonly string[]): void => {
    for (const id of leaves) assert.equal(wide.rawList.filter((x) => x === id).length, 1, `message ${position.get(id)} goes out raw once`);
    const order = leaves.map((id) => wide.rawList.indexOf(id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `in store order (${order.join(',')})`);
  };
  const keeps = (wide: Awaited<ReturnType<typeof sent>>, s: SummaryEntry): void => {
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of leavesOf(s)) assert.ok(!wide.raw.has(id), `message ${position.get(id)} doesn't go out raw`);
  };
  const swaps = (wide: Awaited<ReturnType<typeof sent>>, s: SummaryEntry): void => {
    assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    rawInOrder(wide, leavesOf(s));
  };
  return { manager, strategy, ctx, ids, position, byId, rawOf, leavesOf, l1s, dearer, sent, rawInOrder, keeps, swaps };
}
type Built = Awaited<ReturnType<typeof built>>;

const frontier = (write: (manager: ContextManager) => void, extra: Record<string, unknown> = {}) => built({ targetChunkTokens: 1e9, ...extra }, (manager) => {
  for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
  write(manager);
  for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
});

describe('a summary weighed against its messages sent raw, on the hierarchical select', () => {
  it("#407: sends an L1's messages raw in its place where its pair costs more than they do, and fits the budget they need", async () => {
    const f = await built();
    const l1s = f.l1s();
    assert.ok(l1s.length >= 3, `premise: several L1s (${l1s.length})`);
    const dear = l1s[1]!;
    f.dearer(dear);

    const wide = await f.sent(1_000_000);
    f.swaps(wide, dear);
    for (const s of l1s) if (s !== dear) assert.ok(wide.summaries.has(s.id), `${s.id}, cheaper than its messages, goes out`);
    const fits = await f.sent(wide.total);
    assert.ok(!fits.summaries.has(dear.id), `a budget of what that sends (${wide.total}) compiles`);
    await f.manager.close();
  });

  it('sends a summary whose pair costs exactly what its messages do as its pair, and one a token dearer as those messages', async () => {
    const f = await built();
    const s = f.l1s()[1]!;
    const leaves = f.leavesOf(s);
    const raw = f.rawOf(leaves);
    s.responseContent = text('in brief');
    s.tokens = 1;
    const label = f.strategy.charge(s) - f.strategy.answerCharge(s);
    for (const [tokens, swapped] of [[raw - label, false], [raw - label + 1, true]] as const) {
      s.tokens = tokens;
      assert.equal(f.strategy.charge(s), swapped ? raw + 1 : raw, `premise: the pair costs ${swapped ? 'a token more than' : 'what'} its messages do`);
      const wide = await f.sent(1_000_000);
      if (swapped) f.swaps(wide, s);
      else f.keeps(wide, s);
    }
    await f.manager.close();
  });

  it('sends an L2 whose pair costs more than all its messages as those messages, with none of the summaries under it', async () => {
    const f = await frontier((manager) => {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8)));
    });
    const leaves = f.ids.slice(4, 12);
    const first = f.strategy.seed('L1-first', 1, leaves.slice(0, 4), leaves[0]!, leaves[3]!);
    const second = f.strategy.seed('L1-second', 1, leaves.slice(4), leaves[4]!, leaves[7]!);
    const l2 = f.strategy.seed('L2-over-both', 2, [first.id, second.id], leaves[0]!, leaves[7]!);
    first.mergedInto = second.mergedInto = l2.id;
    f.dearer(l2);

    const wide = await f.sent(1_000_000);
    for (const s of [first, second]) assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    f.swaps(wide, l2);
    await f.manager.close();
  });

  it('sends each message once where an L2 whose L1s overlap costs more than its messages', async () => {
    const f = await frontier((manager) => {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8)));
    });
    const leaves = f.ids.slice(4, 10);
    const first = f.strategy.seed('L1-first', 1, leaves.slice(0, 4), leaves[0]!, leaves[3]!);
    const second = f.strategy.seed('L1-second', 1, leaves.slice(2), leaves[2]!, leaves[5]!);
    const l2 = f.strategy.seed('L2-over-both', 2, [first.id, second.id], leaves[0]!, leaves[5]!);
    first.mergedInto = second.mergedInto = l2.id;
    f.dearer(l2);

    const wide = await f.sent(1_000_000);
    f.swaps(wide, l2);
    await f.manager.close();
  });

  it('keeps an L1 and the L2 that the select also sends over its messages, where either or both cost more than their messages', async () => {
    for (const bothDear of [false, true]) {
      const f = await frontier((manager) => {
        for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8)));
      });
      const leaves = f.ids.slice(4, 12);
      const unmerged = f.strategy.seed('L1-unmerged', 1, leaves.slice(0, 4), leaves[0]!, leaves[3]!);
      const merged = f.strategy.seed('L1-merged', 1, leaves.slice(4), leaves[4]!, leaves[7]!);
      const l2 = f.strategy.seed('L2-over-both', 2, [unmerged.id, merged.id], leaves[0]!, leaves[7]!);
      merged.mergedInto = l2.id;
      const before = await f.sent(1_000_000);
      assert.ok(before.summaries.has(l2.id) && before.summaries.has(unmerged.id), 'premise: the select sends the L2 and the L1 it never marked as merged into it');
      f.dearer(unmerged);
      if (bothDear) f.dearer(l2);
      const wide = await f.sent(1_000_000);
      assert.ok(wide.summaries.has(unmerged.id), 'L1-unmerged goes out');
      f.keeps(wide, l2);
      await f.manager.close();
    }
  });

  it('keeps a summary that costs more than its messages in the combined answer with positionedRecallPairs false, with a cap or without', async () => {
    for (const cap of [undefined, 1_000_000]) {
      const f = await built({ positionedRecallPairs: false, ...(cap !== undefined ? { maxMessageTokens: cap } : {}) });
      const dear = f.l1s()[1]!;
      f.dearer(dear);
      f.keeps(await f.sent(1_000_000), dear);
      await f.manager.close();
    }
  });

  it("keeps a summary one of whose messages is no longer in the store's view", async () => {
    const f = await built();
    const dear = f.l1s()[1]!;
    const leaves = f.leavesOf(dear);
    f.dearer(dear);
    f.manager.removeMessage(leaves[1]! as never);
    assert.equal((f.manager as unknown as { windowMode(): string }).windowMode(), 'legacy', 'premise: the removal leaves what folded the message');
    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(dear.id), `${dear.id} goes out`);
    for (const id of leaves) if (id !== leaves[1]) assert.ok(!wide.raw.has(id), `message ${f.position.get(id)} doesn't go out raw`);
    await f.manager.close();
  });

  it('keeps a summary one of whose messages already goes out raw, as a pin', async () => {
    let ids: string[] = [];
    const f = await frontier((manager) => {
      ids = [0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8))));
      manager.pinRange(ids[1]!, ids[1]!);
    });
    const s = f.strategy.seed('L1-pinned', 1, ids, ids[0]!, ids[3]!);
    f.dearer(s);
    const wide = await f.sent(1_000_000);
    assert.ok(wide.raw.has(ids[1]!), 'premise: the pinned message goes out raw');
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of ids) assert.ok(wide.rawList.filter((x) => x === id).length <= 1, `message ${f.position.get(id)} goes out raw once at most`);
    await f.manager.close();
  });

  const shapes: Array<{ shape: string; swaps: boolean; tools?: string[]; write: (manager: ContextManager) => string[]; seed: (f: Built, ids: string[]) => SummaryEntry }> = [
    { shape: 'a result answering a call in another summary', swaps: false,
      write: (manager) => {
        const ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-x'))];
        const meanwhile = manager.addMessage('user', text('meanwhile ' + words(8)));
        manager.pinRange(meanwhile, meanwhile);
        return [...ids, meanwhile, manager.addMessage('user', result('call-x')), manager.addMessage('agent', text('so ' + words(8)))];
      },
      seed: (f, ids) => {
        f.strategy.seed('L1-calls', 1, ids.slice(0, 2), ids[0]!, ids[1]!);
        return f.strategy.seed('L1-answers', 1, ids.slice(3), ids[3]!, ids[4]!);
      } },
    { shape: 'a result answering a call in the summary beside it', swaps: false,
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-c')),
        manager.addMessage('user', result('call-c')), manager.addMessage('agent', text('so ' + words(8)))],
      seed: (f, ids) => {
        f.strategy.seed('L1-calls', 1, ids.slice(0, 2), ids[0]!, ids[1]!);
        return f.strategy.seed('L1-answers', 1, ids.slice(2), ids[2]!, ids[3]!);
      } },
    { shape: 'a call whose result is in the summary beside it', swaps: false,
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-c')),
        manager.addMessage('user', result('call-c')), manager.addMessage('agent', text('so ' + words(8)))],
      seed: (f, ids) => {
        f.strategy.seed('L1-answers', 1, ids.slice(2), ids[2]!, ids[3]!);
        return f.strategy.seed('L1-calls', 1, ids.slice(0, 2), ids[0]!, ids[1]!);
      } },
    { shape: 'a call answered right after them by a message no summary covers', swaps: false,
      write: (manager) => {
        const ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-n'))];
        manager.addMessage('user', result('call-n'));
        return ids;
      },
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'a call, a message, then its result', swaps: false,
      write: (manager) => [manager.addMessage('agent', call('call-l')), manager.addMessage('user', text('meanwhile ' + words(8))), manager.addMessage('user', result('call-l'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[2]!) },
    { shape: 'a result that answers no call', swaps: false,
      write: (manager) => [manager.addMessage('agent', text('before ' + words(8))), manager.addMessage('user', result('call-gone'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'two results for one call', swaps: false,
      write: (manager) => [manager.addMessage('agent', call('call-d')),
        manager.addMessage('user', [resultBlock('call-d'), resultBlock('call-d', 'found again ')] as ContentBlock[])],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'messages between a call and its result that no summary covers', swaps: false,
      write: (manager) => [
        manager.addMessage('user', text('before ' + words(8))),
        manager.addMessage('agent', call('call-gap')),
        ...[0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`meanwhile ${i} ` + words(8)))),
        manager.addMessage('user', result('call-gap')),
        manager.addMessage('agent', text('after ' + words(8))),
      ],
      seed: (f, ids) => {
        const children = [f.strategy.seed('L1-a', 1, [ids[0]!], ids[0]!, ids[0]!), f.strategy.seed('L1-b', 1, ids.slice(2, 6), ids[2]!, ids[5]!), f.strategy.seed('L1-c', 1, [ids[7]!], ids[7]!, ids[7]!)];
        const l2 = f.strategy.seed('L2-around-a-call', 2, children.map((c) => c.id), ids[0]!, ids[7]!);
        for (const c of children) c.mergedInto = l2.id;
        return l2;
      } },
    { shape: 'a result answering the call before them, a call and its result, and a call answered after them, all in one message', swaps: false,
      write: (manager) => {
        manager.addMessage('agent', call('call-p1'));
        const ids = [manager.addMessage('user', [resultBlock('call-p1'), ...call('call-p2'), resultBlock('call-p2'), callBlock('call-p3')] as ContentBlock[])];
        manager.addMessage('user', result('call-p3'));
        return ids;
      },
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[0]!) },
    { shape: 'two calls sharing an id in one message, then a result', swaps: false,
      write: (manager) => [
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [...call('call-twice'), callBlock('call-twice')] as ContentBlock[]),
        manager.addMessage('user', result('call-twice')),
        manager.addMessage('agent', text('so ' + words(8))),
      ],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[3]!) },
    { shape: 'two calls and the first one\'s result in one message, the second one\'s result in the next, which no summary covers', swaps: false,
      write: (manager) => {
        const ids = [manager.addMessage('user', text('ask ' + words(8))),
          manager.addMessage('agent', [...call('call-a'), callBlock('call-b'), resultBlock('call-a')] as ContentBlock[])];
        manager.addMessage('user', result('call-b'));
        return ids;
      },
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'two calls and the first one\'s result in one message, then the second one\'s result', swaps: false,
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [...call('call-a'), callBlock('call-b'), resultBlock('call-a')] as ContentBlock[]),
        manager.addMessage('user', result('call-b'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[2]!) },
    { shape: 'a call and its result, between a cycle before them and one after', swaps: true,
      tools: ['call call-before', 'result call-before', 'call call-own', 'result call-own', 'call call-after', 'result call-after'],
      write: (manager) => {
        manager.addMessage('agent', call('call-before'));
        manager.addMessage('user', result('call-before'));
        const ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-own')),
          manager.addMessage('user', result('call-own')), manager.addMessage('agent', text('so ' + words(8)))];
        manager.addMessage('agent', call('call-after'));
        manager.addMessage('user', result('call-after'));
        return ids;
      },
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[3]!) },
    { shape: 'a call nothing in the view answers, with a message after it', swaps: true,
      tools: ['call call-none', 'stub call-none'],
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-none')),
        manager.addMessage('user', text('then ' + words(8)))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[2]!) },
    { shape: 'a call nothing in the view answers, with the view going on after it', swaps: true,
      tools: ['call call-none', 'stub call-none'],
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-none'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
  ];
  for (const { shape, swaps, tools, write, seed } of shapes) {
    it(`${swaps ? 'sends as its messages' : 'keeps'} a summary that costs more than its messages where they hold ${shape}`, async () => {
      let ids: string[] = [];
      const f = await frontier((manager) => { ids = write(manager); });
      const s = seed(f, ids);
      f.dearer(s);
      const wide = await f.sent(1_000_000);
      if (swaps) f.swaps(wide, s);
      else f.keeps(wide, s);
      if (tools) assert.deepEqual(wide.tools, tools, 'the tool blocks the request carries');
      await f.manager.close();
    });
  }

  it('sends a summary over a call nothing answers, at the end of a store with no recent window, as its messages with a stub after the call', async () => {
    let ids: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-last'))];
    });
    const s = f.strategy.seed('L1-tail', 1, ids, ids[0]!, ids[1]!);
    f.dearer(s);
    const wide = await f.sent(1_000_000);
    f.swaps(wide, s);
    assert.deepEqual(wide.tools, ['call call-last', 'stub call-last'], 'the call goes out with a stub after it');
    const last = wide.compiled.messages.at(-1)!.content as ContentBlock[];
    assert.equal(keyOf(last.at(-1)!), 'stub call-last', 'the request ends with the stub');
    await f.manager.close();
  });

  it('keeps a summary over a call whose result is in the recent window', async () => {
    let ids: string[] = [];
    const f = await built({ targetChunkTokens: 1e9 }, (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
      ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-t'))];
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
      manager.addMessage('user', result('call-t'));
    });
    const at = f.ids.length - 1;
    (f.strategy as unknown as { config: { recentWindowTokens: number } }).config.recentWindowTokens = 2 * f.rawOf([f.ids[at]!]);
    const { recentStart } = f.strategy.regions(f.ctx);
    assert.ok(recentStart <= at && recentStart > f.position.get(ids[1]!)!, `premise: the result (${at}) is in the recent window (${recentStart}) and the call isn't`);
    const s = f.strategy.seed('L1-calls', 1, ids, ids[0]!, ids[1]!);
    f.dearer(s);
    f.keeps(await f.sent(1_000_000), s);
    await f.manager.close();
  });

  it('weighs the stub result of a call nothing answers with its messages: it keeps a summary that costs less only without it', async () => {
    let ids: string[] = [];
    const f = await frontier((manager) => {
      ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-stubbed'))];
    });
    const s = f.strategy.seed('L1-stubbed', 1, ids, ids[0]!, ids[1]!);
    s.responseContent = text('in brief');
    s.tokens = 1;
    const label = f.strategy.charge(s) - f.strategy.answerCharge(s);
    const raw = f.rawOf(ids);
    const stub = f.strategy.stubPrice(f.ctx, 'call-stubbed');
    assert.ok(stub > 1, `premise: a stub costs tokens (${stub})`);
    for (const [tokens, swapped] of [[raw - label + 1, false], [raw + stub - label + 1, true]] as const) {
      s.tokens = tokens;
      const wide = await f.sent(1_000_000);
      if (swapped) {
        assert.equal(f.strategy.charge(s), raw + stub + 1, 'premise: the pair costs a token more than the messages and the stub');
        f.swaps(wide, s);
      } else {
        assert.equal(f.strategy.charge(s), raw + 1, 'premise: the pair costs a token more than the messages, and less than them with the stub');
        f.keeps(wide, s);
      }
    }
    await f.manager.close();
  });

  it('counts the messages it sends in place of a summary as raw in the render stats, and the summary not at all', async () => {
    let ids: string[] = [];
    const f = await frontier((manager) => {
      ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-own')),
        manager.addMessage('user', result('call-own')), manager.addMessage('agent', text('so ' + words(8)))];
    });
    const s = f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[3]!);
    f.dearer(s);
    const wide = await f.sent(1_000_000);
    f.swaps(wide, s);
    const stats = wide.stats!;
    assert.equal(stats.summaries.l1.count, 0, 'no L1 is counted');
    assert.equal(stats.middleRaw.messages, f.ids.length, 'every message is counted as raw in the middle');
    assert.equal(stats.middleRaw.tokens, f.rawOf(f.ids), 'at its raw price');
    await f.manager.close();
  });

  it("sends a summary between a call and its result as its messages, and the result stays where repair moved it beside its call", async () => {
    let ids: string[] = [];
    const f = await frontier((manager) => {
      manager.addMessage('agent', call('call-w'));
      ids = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`aside ${i} ` + words(8))));
      manager.addMessage('user', result('call-w'));
    });
    const s = f.strategy.seed('L1-aside', 1, ids, ids[0]!, ids[7]!);
    const before = await f.sent(1_000_000);
    assert.deepEqual(before.tools, ['call call-w', 'result call-w', 'moved'], "premise: with the pair between them, repair moves the result beside its call");
    f.dearer(s);
    const wide = await f.sent(1_000_000);
    f.swaps(wide, s);
    assert.deepEqual(wide.tools, ['call call-w', 'result call-w', 'moved'], 'the result still goes out beside its call');
    await f.manager.close();
  });

  const reset = (write: (manager: ContextManager) => { ask: string[]; head: string[] }, after = false) => async () => {
    let shape: { ask: string[]; head: string[] } = { ask: [], head: [] };
    const f = await frontier((manager) => { shape = write(manager); });
    (f.strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens = shape.head.reduce((sum, id) => sum + f.ctx.messageStore.estimateTokens(f.byId.get(id)!), 0);
    f.strategy.resetHeadWindow(shape.head[0]!);
    const { headStart, headEnd } = f.strategy.regions(f.ctx);
    assert.ok(headStart === f.position.get(shape.head[0]!) && headEnd >= headStart + shape.head.length, `premise: a head window [${headStart}, ${headEnd}) from the reset holds the head's messages`);
    for (const id of shape.ask) {
      const at = f.position.get(id)!;
      assert.ok(after ? at >= headEnd : at < headStart, `premise: message ${at} lies ${after ? 'after' : 'before'} the head`);
    }
    return { f, s: f.strategy.seed(after ? 'L1-after-head' : 'L1-before-head', 1, shape.ask, shape.ask[0]!, shape.ask.at(-1)!) };
  };

  it('keeps a summary over a call whose result begins the head after a reset', async () => {
    const { f, s } = await reset((manager) => {
      const ask = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-h'))];
      return { ask, head: [manager.addMessage('user', result('call-h'))] };
    })();
    f.dearer(s);
    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(s.id), `${s.id} goes out`);
    for (const id of f.leavesOf(s)) assert.ok(wide.rawList.filter((x) => x === id).length <= 1, `message ${f.position.get(id)} goes out raw once at most`);
    await f.manager.close();
  });

  it('sends a summary after the head after a reset as its messages, and the head as before', async () => {
    const { f, s } = await reset((manager) => {
      const head = [manager.addMessage('agent', call('call-k')), manager.addMessage('user', result('call-k'))];
      return { ask: [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', text('so ' + words(8)))], head };
    }, true)();
    const before = await f.sent(1_000_000);
    f.dearer(s);
    const wide = await f.sent(1_000_000);
    f.swaps(wide, s);
    assert.deepEqual(wide.tools, before.tools, 'the request carries the same tool blocks as with the pair');
    assert.deepEqual(wide.tools, ['call call-k', 'result call-k'], "premise: the head's cycle");
    await f.manager.close();
  });

  it("refuses the compile where a recall pair it sends as its messages isn't where emission put it after repair", async () => {
    let ids: string[] = [];
    const f = await frontier((manager) => {
      ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', text('so ' + words(8)))];
    });
    const s = f.strategy.seed('L1-moved', 1, ids, ids[0]!, ids[1]!);
    f.dearer(s);
    const internals = f.strategy as unknown as { postProcessToolEntries(entries: ContextEntry[]): void };
    const repair = internals.postProcessToolEntries.bind(f.strategy);
    internals.postProcessToolEntries = (entries: ContextEntry[]) => {
      repair(entries);
      const q = entries.findIndex((e) => e.participant === 'Context Manager');
      if (q >= 0) entries.splice(q + 1, 0, { index: q + 1, participant: 'user', content: text('between'), sourceRelation: 'derived' } as ContextEntry);
    };
    await assert.rejects(f.sent(1_000_000), /recall pair/, 'the compile is refused');
    await f.manager.close();
  });
});
