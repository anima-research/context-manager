import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '../src/types/index.js';
import * as contextManager from '../src/index.js';
import { concatBodyGroups, OverBudgetError } from '../src/index.js';
import { call, long, open, Probe, result, sum, text, thinking, type Layout } from './body-parts-harness.js';

const types = (m: { content: ContentBlock[] }): string[] => m.content.map((b) => b.type);
const recall = (): string => '';

describe('ingress keeps a reply\'s blocks from its first call on with its last part', () => {
  const SHAPES: Record<string, { content: ContentBlock[]; first: string[]; last: string[]; joined: string[] }> = {
    'thinking, text and a call': {
      content: [thinking('T'), text(long('A')), call('c1')],
      first: ['text', 'thinking'], last: ['text', 'tool_use'], joined: ['thinking', 'tool_use', 'text'],
    },
    'a reply answering its own call': {
      content: [thinking('T'), text(long('A')), call('c1'), result('c1', 'r'), text('after')],
      first: ['text', 'thinking'], last: ['text', 'tool_use', 'tool_result'], joined: ['thinking', 'tool_use', 'tool_result', 'text'],
    },
    'two calls with text between': {
      content: [thinking('T'), text(long('A')), call('c1'), text('and'), call('c2')],
      first: ['text', 'thinking'], last: ['text', 'tool_use', 'tool_use'], joined: ['thinking', 'tool_use', 'tool_use', 'text'],
    },
    'thinking and text, no call': {
      content: [thinking('T'), text(long('A'))],
      first: ['text', 'thinking'], last: ['text'], joined: ['thinking', 'text'],
    },
    'results and text': {
      content: [result('c0', 'r'), text(long('A'))],
      first: ['text', 'tool_result'], last: ['text'], joined: ['tool_result', 'text'],
    },
  };
  for (const [shape, c] of Object.entries(SHAPES)) {
    it(`${shape}: where each block is stored, and the parts joined send every block in stored order, ahead of the text`, async () => {
      const o = await open();
      try {
        const parts = o.add('a', c.content);
        const stored = parts.map((i) => o.all()[i]!);
        assert.ok(stored.length >= 6, `premise: stored in ${stored.length} parts`);
        assert.deepEqual([types(stored[0]!), types(stored.at(-1)!)], [c.first, c.last]);
        for (const middle of stored.slice(1, -1)) assert.deepEqual(types(middle), ['text']);
        const joined = concatBodyGroups(stored, recall);
        assert.equal(joined.length, 1);
        assert.deepEqual(types(joined[0]!), c.joined, 'concatBodyGroups joins them');
        const nonText = c.content.filter((b) => b.type !== 'text');
        assert.deepEqual(joined[0]!.content.slice(0, -1), nonText, 'in the order they were stored');
        const joinBodyParts = (contextManager as unknown as Record<string, unknown>).joinBodyParts as
          ((parts: ContentBlock[][]) => ContentBlock[]) | undefined;
        assert.equal(typeof joinBodyParts, 'function', 'the join is exported');
        assert.deepEqual(joinBodyParts!(stored.map((m) => m.content)), joined[0]!.content, 'the export is that join');
      } finally {
        await o.close();
      }
    });
  }
});

describe("the chunker closes a stored reply's parts before its last as it closes a long message's", () => {
  it('the parts before the call\'s part close where they close without the call, and the call\'s part closes with its result', async () => {
    const cut = async (withCall: boolean): Promise<{ chunks: string[][]; reply: string[]; res: string }> => {
      const o = await open({ config: { headWindowTokens: 0, recentWindowTokens: 300 } });
      try {
        o.add('u', [text('intro')]);
        const reply = o.add('a', withCall ? [thinking('T'), text(long('A')), call('c1')] : [thinking('T'), text(long('A'))]);
        const [res] = o.add('u', withCall ? [result('c1', 'what the tool said')] : [text('what the tool said')]);
        for (let k = 0; k < 3; k++) o.add(k % 2 ? 'u' : 'a', [text(long(`after${k}`, 8_000))]);
        const ids = o.all().map((m) => m.id);
        return { chunks: o.strategy.chunkIds(o.view()), reply: reply.map((i) => ids[i]!), res: ids[res!]! };
      } finally {
        await o.close();
      }
    };
    const [stored, reference] = [await cut(true), await cut(false)];
    const chunkOf = (c: typeof stored, id: string) => c.chunks.findIndex((chunk) => chunk.includes(id));
    const lastPart = stored.reply.at(-1)!;
    const refLastPart = reference.reply.at(-1)!;
    assert.ok(chunkOf(stored, lastPart) >= 0, "premise: the call's part is chunked");
    assert.ok(reference.chunks.some((chunk) => chunk.at(-1) === refLastPart),
      'premise: without the call, a chunk closes on the reply\'s last part');
    assert.equal(chunkOf(stored, lastPart), chunkOf(stored, stored.res), 'the call\'s part closes with its result');
    for (let k = 0; k < stored.reply.length - 1; k++) {
      const mine = stored.chunks[chunkOf(stored, stored.reply[k]!)]!;
      const theirs = reference.chunks[chunkOf(reference, reference.reply[k]!)]!;
      assert.equal(mine.indexOf(stored.reply[k]!), theirs.indexOf(reference.reply[k]!), `part ${k} sits where it does without the call`);
    }
  });
});

describe('the edges around a reply stored in 19 parts, swept across every part', () => {
  async function nineteen(layout: Layout, config: Record<string, unknown>, persist = true) {
    const o = await open({ layout, persist, config });
    o.add('u', [text('intro')]);
    o.add('a', [text('hello')]);
    o.add('u', [text('go')]);
    const reply = o.add('a', [thinking('T'), text(long('A', 19 * 12_000 - 1_000)), call('c1')]);
    const [res] = o.add('u', [result('c1', 'what the tool said')]);
    for (let k = 0; k < 2; k++) o.add(k % 2 ? 'u' : 'a', [text(long(`after${k}`, 6_000))]);
    assert.equal(reply.length, 19, `premise: the reply is stored in ${reply.length} parts`);
    return { ...o, reply, res: res! };
  }

  for (const layout of ['new', 'old'] as const) {
    const label = layout === 'new' ? 'stored as ingress stores it now' : 'stored with its call on its first part';
    it(`${label}: the recent window's start`, async () => {
      const o = await nineteen(layout, { headWindowTokens: 0, recentWindowTokens: 10_000_000 });
      try {
        const prices = o.strategy.walkPrices(o.view());
        for (const k of [...o.reply, o.res]) {
          o.strategy.set({ recentWindowTokens: sum(prices, k) });
          const start = o.strategy.recentStart(o.view());
          if (layout === 'old') assert.equal(start, o.reply[0]!, `landing at ${k}: the window starts at the reply's first part`);
          else assert.equal(start, k === o.res ? o.reply.at(-1)! : k, `landing at ${k}: as for a message stored whole`);
        }
      } finally {
        await o.close();
      }
    });

    it(`${label}: the head window's end`, async () => {
      const o = await nineteen(layout, { headWindowTokens: 10_000_000, recentWindowTokens: 0 });
      try {
        const prices = o.estimates();
        for (const k of [...o.reply, o.res]) {
          o.strategy.set({ headWindowTokens: sum(prices, 0, k) });
          const end = o.strategy.headEnd(o.view());
          if (layout === 'old') assert.equal(end, o.reply[0]!, `landing at ${k}: the head ends before the reply's first part`);
          else assert.equal(end, k === o.res ? o.reply.at(-1)! : k, `landing at ${k}: as for a message stored whole`);
        }
      } finally {
        await o.close();
      }
    });

    it(`${label}: a compression hold`, async () => {
      const o = await nineteen(layout, { headWindowTokens: 0, recentWindowTokens: 10_000_000 });
      try {
        const ids = o.all().map((m) => m.id);
        for (const k of [...o.reply, o.res]) {
          o.manager.holdCompression([ids[k]!]);
          const start = o.strategy.holdStart(o.view());
          if (layout === 'old') assert.equal(start, o.reply[0]!, `holding ${k}: the hold starts at the reply's first part`);
          else assert.equal(start, k === o.res ? o.reply.at(-1)! : k, `holding ${k}: as for a message stored whole`);
          o.manager.releaseCompression([ids[k]!]);
        }
      } finally {
        await o.close();
      }
    });

    it(`${label}: the chunks`, async () => {
      const o = await nineteen(layout, { headWindowTokens: 0, recentWindowTokens: 300, attachmentsIgnoreSize: false }, false);
      try {
        const ids = o.all().map((m) => m.id);
        const prices = o.estimates();
        for (const k of o.reply) {
          o.strategy.set({ targetChunkTokens: sum(prices, 0, k) + Math.floor(prices[k]! / 2) });
          const chunks = o.strategy.chunkIds(o.view());
          const ends = chunks.map((c) => ids.indexOf(c.at(-1)!));
          const holder = ids[layout === 'new' ? o.reply.at(-1)! : o.reply[0]!]!;
          const callChunk = chunks.findIndex((c) => c.includes(holder));
          if (layout === 'old' || k === o.reply.at(-1)!) {
            assert.ok(callChunk >= 0, `premise, closing at ${k}: the call's part is chunked; chunks end at ${ends}`);
          }
          if (callChunk >= 0) assert.ok(chunks[callChunk]!.includes(ids[o.res]!), `closing at ${k}: the call's chunk holds its result; chunks end at ${ends}`);
          if (layout === 'new' && k < o.reply.at(-1)!) {
            assert.equal(ends[0], k, `closing at ${k}: the first chunk closes there, as for a long message's parts; chunks end at ${ends}`);
          }
        }
      } finally {
        await o.close();
      }
    });
  }
});

describe("the newest turn a refusal names as the floor", () => {
  it('a result after a reply stored as ingress stores it now needs only the call\'s part kept raw with it', async () => {
    const o = await open({ config: { headWindowTokens: 0, recentWindowTokens: 10_000_000 } });
    try {
      o.add('u', [text('intro')]);
      const reply = o.add('a', [thinking('T'), text(long('A')), call('c1')]);
      o.add('u', [result('c1', 'what the tool said')]);
      const prices = o.strategy.walkPrices(o.view());
      const floor = sum(prices, reply.at(-1)!);
      assert.ok(sum(prices, reply[0]!) > floor + 1, 'premise: the whole reply costs more than its last part');
      const refused = await o.manager.compile({ maxTokens: floor + 1, reserveForResponse: 0 }).then(() => undefined, (e: unknown) => e);
      assert.ok(refused instanceof OverBudgetError, 'premise: the whole recent window is over the budget');
      assert.deepEqual(refused.clearedBy, ['smaller-recent-window'], 'a smaller recent window would clear it');
    } finally {
      await o.close();
    }
  });
});

describe("a subclass's lastMessageContainsToolUse still decides where the chunker may not close", () => {
  class Holds extends Probe {
    protected lastMessageContainsToolUse(chunk: StoredMessage[]): boolean {
      return chunk.at(-1)!.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('HOLD'));
    }
  }
  for (const [name, Strategy, closesAt] of [['the base', Probe, 3], ['a subclass holding at its marker', Holds, 4]] as const) {
    it(`${name}: the first chunk closes at message ${closesAt}`, async () => {
      const o = await open({ Strategy, persist: false, config: { headWindowTokens: 0, recentWindowTokens: 300, attachmentsIgnoreSize: false } });
      try {
        for (let k = 0; k < 8; k++) o.add(k % 2 ? 'a' : 'u', [text(`${k === 3 ? 'HOLD' : 'turn'} ${k} ${long('T', 4_000)}`)]);
        o.strategy.set({ targetChunkTokens: sum(o.estimates(), 0, 3) + 1 });
        const ids = o.all().map((m) => m.id);
        const first = o.strategy.chunkIds(o.view())[0]!;
        assert.equal(ids.indexOf(first.at(-1)!), closesAt);
      } finally {
        await o.close();
      }
    });
  }
});
