/**
 * A pin covers whole messages: under adaptive resolution, a pin or document
 * mark whose first or last id names a part of a message stored in parts
 * covers that message from its first part to its last, for every reader of
 * pins, the selects, compression and the summarizer's prompt alike, as a
 * pinRange over all its parts does where no part is locked (`pinPositions`):
 * a part locked with `lockChunk` outside the span the pin's ids name keeps
 * its lock. A compile that can't hold a whole message refuses, as for any
 * pin the budget can't hold, and the adaptive plan's refusal names the pin.
 *
 * The store: six history messages, then long messages that ingress stores
 * in parts (adaptive resolution with 1,500-token chunks), then 360 messages
 * of traffic. A head window of 500 tokens and a recent window of 8,000 leave
 * the long messages in the middle. With one 6,000-word message marked, its
 * first part alone fits at 22,000 tokens and the whole message needs about
 * 38,000; the tests use 30,000 for "can't be whole" and 42,000 or 60,000 for
 * "fits".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';
import type { AutobiographicalConfig } from '../src/index.js';

const words = (label: string, n: number): ContentBlock[] =>
  [{ type: 'text', text: `${label} ${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}` }];

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25, continuityLambda: 1,
    continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};

/** Reaches the strategy's pins and windows. */
class PinStore extends AutobiographicalStrategy {
  /** The fold bound each pinned position resolves to, as every reader of pins takes it. */
  boundsAt(messages: unknown[]): Map<number, unknown> {
    return this.resolvedPinBounds(messages as never);
  }
  /** The level bounds pins give, as the replay exporter reads them. */
  levelBounds(messages: unknown[]): Map<number, { level?: number; maxLevel?: number }> {
    return this.pinLevelBounds(messages as never);
  }
  /** The ids of the messages in compressed chunks. */
  summarizedIds(): Set<string> {
    const out = new Set<string>();
    for (const chunk of this.chunks) if (chunk.compressed) for (const m of chunk.messages) out.add(m.id);
    return out;
  }
  /** The ids of the messages in any chunk. */
  chunkedIds(): Set<string> {
    const out = new Set<string>();
    for (const chunk of this.chunks) for (const m of chunk.messages) out.add(m.id);
    return out;
  }
  /** Where the head window ends. */
  headEnd(store: never): number {
    return this.getHeadWindowEnd(store);
  }
  /** The stored resolution of a message (0 is raw). */
  resolutionOf(id: string): number {
    return this.resolutions.get(id) ?? 0;
  }
}

type Kind = 'adaptive' | 'kv-stable' | 'kv-unified';
const config = (kind: Kind, recentWindowTokens: number): AutobiographicalConfig => ({
  headWindowTokens: 500, recentWindowTokens, imageStripDepthTokens: 0, compressionModel: 'test-model',
  hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1500,
  ...(kind === 'kv-stable' ? { foldingStrategy: 'kv-stable' } : {}),
  ...(kind === 'kv-unified' ? { foldingStrategy: 'kv-unified', kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } } : {}),
} as AutobiographicalConfig);

function summarizer(words = 30): { membrane: never; calls: () => number; requests: string[] } {
  let n = 0;
  const requests: string[] = [];
  const membrane = {
    complete: async (request: unknown) => (requests.push(JSON.stringify(request)), {
      stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(words) }],
      usage: { input_tokens: 100, output_tokens: 40 },
    }),
  } as never;
  return { membrane, calls: () => n, requests };
}

async function open(dir: string, kind: Kind = 'adaptive', recentWindowTokens = 8000, extra: Partial<AutobiographicalConfig> = {}) {
  const strategy = new PinStore({ ...config(kind, recentWindowTokens), ...extra } as AutobiographicalConfig);
  const sum = summarizer();
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: sum.membrane });
  return { cm, strategy, calls: sum.calls, requests: sum.requests };
}

const budget = (maxTokens: number) => ({ maxTokens, reserveForResponse: 0 });
type Sent = { participant: string; content: ContentBlock[] };
const sent = (r: { messages: unknown[] }): Sent[] => r.messages as Sent[];
const textOf = (m: Sent): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
/** The raw words of a marked message the request carries, by their numbers. */
function rawWords(messages: Sent[], label: string): number[] {
  return messages.map(textOf)
    .filter((t) => t.startsWith(label) || /^\s*word\d+/.test(t))
    .flatMap((t) => [...t.matchAll(/\bword(\d+)\b/g)].map((m) => Number(m[1])))
    .sort((a, b) => a - b);
}
const allOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const ready = async (cm: ContextManager) => {
  for (let i = 0; i < 800 && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'compression caught up');
};

async function history(cm: ContextManager): Promise<void> {
  for (let i = 0; i < 6; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
  await cm.compile(budget(42_000));
}
async function traffic(cm: ContextManager, n: number, label = 'event'): Promise<void> {
  for (let i = 0; i < n; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', words(`${label}${i}`, 200));
}

function warnings(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }): string[] {
  const out: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { out.push(String(args[0])); });
  return out;
}

type View = { getAll(): Array<{ id: string; bodyGroupId?: string }>; estimateTokens(message: unknown): number };
const viewOf = (cm: ContextManager): View => (cm as unknown as { strategyMessageView(): View }).strategyMessageView();
/** The ids of the parts of the message `id` is in, in store order. */
const partsOf = (cm: ContextManager, id: string): string[] => {
  const all = viewOf(cm).getAll();
  const group = all.find((m) => m.id === id)!.bodyGroupId;
  return all.filter((m) => m.bodyGroupId !== undefined && m.bodyGroupId === group).map((m) => m.id);
};
/** The word numbers of one stored part's own text. */
const wordsOfPart = (cm: ContextManager, id: string): number[] => {
  const part = (viewOf(cm).getAll() as unknown as Array<{ id: string; content: ContentBlock[] }>).find((m) => m.id === id)!;
  return part.content.flatMap((b) => (b.type === 'text' ? [...b.text.matchAll(/\bword(\d+)\b/g)].map((m) => Number(m[1])) : []));
};
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-whole-pins-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A store where a long message arrives, is chunked and summarized, and then is marked, as a store an earlier version marked reads now. */
async function markedAfterSummaries(dir: string, kind: Kind = 'adaptive') {
  const s = await open(dir, kind);
  await history(s.cm);
  const b = s.cm.addMessage('user', words('Bdoc', 6000));
  await traffic(s.cm, 360);
  await ready(s.cm);
  await s.cm.compile(budget(30_000));
  const parts = partsOf(s.cm, b);
  assert.ok(parts.slice(1).every((id) => s.strategy.summarizedIds().has(id)), 'the later parts are summarized');
  return { ...s, b, parts };
}

/** The compile's refusal, or a failure when it compiles. */
async function refusalOf(cm: ContextManager, maxTokens: number): Promise<OverBudgetError> {
  try {
    await cm.compile(budget(maxTokens));
  } catch (err) {
    if (err instanceof OverBudgetError) return err;
    throw err;
  }
  assert.fail(`the compile at ${maxTokens} went ahead`);
}

describe('a pin covers whole messages, for every reader', () => {
  for (const kind of ['adaptive', 'kv-unified'] as const) {
    it(`${kind}: a document mark on a long message's first part is read as a range pin over all its parts: the same request, chunks and summarizer input`, async () => {
      const run = async (how: 'mark' | 'range') => {
        let out: { request: string[]; raw: number[]; chunked: boolean[]; prompts: Array<[boolean, boolean]> } | undefined;
        await withDir(async (dir) => {
          // A recent window of 20,000 holds the whole message as it arrives, so the pin is there before
          // compression chunks any part of it.
          const { cm, strategy, requests } = await open(dir, kind, 20_000);
          await history(cm);
          const b = cm.addMessage('user', words('Bdoc', 6000));
          const parts = partsOf(cm, b);
          assert.ok(parts.length > 2, 'the message is stored in parts');
          assert.deepStrictEqual(parts.filter((id) => strategy.chunkedIds().has(id)), [], 'no part is chunked yet');
          if (how === 'mark') cm.markDocument(b);
          else cm.pinRange(parts[0]!, parts.at(-1)!);
          await traffic(cm, 360);
          await ready(cm);
          const request = sent(await cm.compile(budget(60_000)));
          // The summarizer's requests for chunks long after the message: does each carry its first and last words raw?
          const later = requests.filter((r) => r.includes('"event300 word0'));
          assert.ok(later.length > 0, 'the chunk was summarized');
          out = {
            request: request.map(textOf), raw: rawWords(request, 'Bdoc'),
            chunked: parts.map((id) => strategy.chunkedIds().has(id)),
            prompts: later.map((r) => [r.includes('Bdoc word0 word1'), r.includes('word5999')]),
          };
          await cm.close();
        });
        return out!;
      };
      const mark = await run('mark');
      const range = await run('range');
      assert.deepStrictEqual(mark.raw, allOf(6000), 'the whole message goes out raw');
      assert.deepStrictEqual(mark.chunked, mark.chunked.map(() => false), 'compression leaves every part out');
      assert.ok(mark.prompts.every(([first, last]) => first && last), 'the summarizer\'s prompt carries the whole message raw');
      assert.deepStrictEqual(mark, range);
    });
  }

  it('a mark made after its message\'s early parts were chunked as it arrived sends the whole message raw', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir);
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      const parts = partsOf(cm, b);
      assert.ok(strategy.chunkedIds().has(parts[1]!), 'the second part was chunked before the mark');
      cm.markDocument(b);
      await traffic(cm, 360);
      await ready(cm);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('a mark on a long message whose other parts were summarized before it, as an earlier version left one, sends the whole message where it fits', async () => {
    await withDir(async (dir) => {
      const { cm, b } = await markedAfterSummaries(dir);
      assert.ok(rawWords(sent(await cm.compile(budget(30_000))), 'Bdoc').length < 6000, 'before the mark, the later parts fold');
      cm.markDocument(b);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('a range pin given its ends in reverse order covers the same whole message', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir, 'kv-unified');
      await history(cm);
      const parts = partsOf(cm, cm.addMessage('user', words('Bdoc', 6000)));
      cm.pinRange(parts[3]!, parts[1]!);
      const all = viewOf(cm).getAll();
      const bounds = strategy.boundsAt(all);
      const of = new Set(parts);
      assert.deepStrictEqual(all.flatMap((m, i) => (bounds.has(i) ? [m.id] : [])), all.filter((m) => of.has(m.id)).map((m) => m.id));
      await cm.close();
    });
  });

  it('a range pin over a part locked at a fold between its ids renders it raw over the lock, as before', async () => {
    await withDir(async (dir) => {
      const { cm, strategy, parts } = await markedAfterSummaries(dir);
      strategy.lockChunk(parts[3]!);
      assert.ok(strategy.resolutionOf(parts[3]!) > 0, 'locked at a fold');
      cm.pinRange(parts[1]!, parts[5]!);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('a range pin whose ends fall inside long messages covers both of them whole', async () => {
    await withDir(async (dir) => {
      const { cm } = await open(dir);
      await history(cm);
      const bParts = partsOf(cm, cm.addMessage('user', words('Bdoc', 2500)));
      const cParts = partsOf(cm, cm.addMessage('user', words('Cdoc', 2500)));
      assert.ok(bParts.length > 2 && cParts.length > 2, 'both messages are stored in parts');
      // From B's second part to C's second part.
      cm.pinRange(bParts[1]!, cParts[1]!);
      await traffic(cm, 360);
      await ready(cm);
      const request = sent(await cm.compile(budget(42_000)));
      assert.deepStrictEqual(rawWords(request, 'Bdoc'), allOf(2500));
      assert.deepStrictEqual(rawWords(request, 'Cdoc'), allOf(2500));
      await cm.close();
    });
  });

  it('a mark\'s level bound holds every part of its message', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir, 'kv-unified');
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      cm.markDocument(b, { maxLevel: 1 });
      const all = viewOf(cm).getAll();
      const parts = new Set(partsOf(cm, b));
      const at = all.flatMap((m, i) => (parts.has(m.id) ? [i] : []));
      assert.ok(at.length > 2, 'the message is stored in parts');
      const bounds = strategy.boundsAt(all);
      assert.deepStrictEqual(at.map((i) => bounds.get(i)), at.map(() => ({ maxLevel: 1 })));
      await cm.close();
    });
  });

  it('kv-unified: a mark\'s own part that another pin\'s whole reading holds at a level is summarized, so the compile is feasible', async () => {
    await withDir(async (dir) => {
      // A recent window of 20,000 holds the message as it arrives, so both pins are there before any part is chunked.
      const { cm, strategy } = await open(dir, 'kv-unified', 20_000);
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      const parts = partsOf(cm, b);
      // A raw mark on the first part; a range at level 1 from the second part to the third, which read whole covers
      // the first part too, where a bound takes a raw pin's place.
      cm.markDocument(b);
      cm.pinRange(parts[1]!, parts[2]!, { level: 1 });
      await traffic(cm, 360);
      await ready(cm);
      assert.ok(strategy.summarizedIds().has(parts[0]!), 'the first part is summarized');
      await cm.compile(budget(60_000));
      await cm.close();
    });
  });

  it('the summarizer\'s over-budget warning counts a mark\'s whole message and names the mark', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      // A head window of 3,000 holds the message's first part (about 2,070 tokens), where the mark's own id is.
      // Its later parts are raw history ahead of the traffic's chunks, more than the summarizer's recall budget of 2,000.
      const { cm, strategy, calls } = await open(dir, 'adaptive', 8000, { headWindowTokens: 3000, compressionRecallBudgetTokens: 2000 });
      cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)), { name: 'P' });
      await traffic(cm, 120);
      await ready(cm);
      assert.strictEqual(strategy.headEnd(viewOf(cm) as never), 1, 'the head holds the first part alone');
      assert.ok(calls() > 0, 'the summarizer was called');
      const over = out.filter((w) => w.includes('recalls the summaries its pins override'));
      assert.ok(over.length > 0, 'the warning was given');
      for (const w of over) {
        assert.ok(w.includes('pins: P)'), w);
        assert.ok(w.includes('Unpin them, or narrow a range pin to fewer messages (a pin on any part of a message stored in parts covers the rest of that message too, less a part locked with lockChunk outside the pin\'s ids)'), w);
      }
      await cm.close();
    });
  });

  it('a store opened without adaptive resolution reads a mark by its ids, as before', async () => {
    await withDir(async (dir) => {
      const first = await open(dir);
      await history(first.cm);
      const b = first.cm.addMessage('user', words('Bdoc', 6000));
      await traffic(first.cm, 360);
      await ready(first.cm);
      first.cm.markDocument(b);
      const summarized = first.strategy.summarizedIds();
      assert.ok(partsOf(first.cm, b).slice(1).every((id) => summarized.has(id)), 'the later parts are summarized');
      await first.cm.close();
      const { cm } = await open(dir, 'adaptive', 8000, { adaptiveResolution: false });
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), allOf(763));
      await cm.close();
    });
  });
});

describe('a lock holds against a pin\'s whole reading', () => {
  for (const kind of ['adaptive', 'kv-unified'] as const) {
    it(`${kind}: parts locked at a fold after the part a mark names keep their lock`, async () => {
      await withDir(async (dir) => {
        const { cm, strategy, b, parts } = await markedAfterSummaries(dir, kind);
        const later = parts.slice(1);
        for (const id of later) strategy.lockChunk(id);
        assert.ok(later.every((id) => strategy.resolutionOf(id) > 0), 'locked at a fold');
        cm.markDocument(b);
        assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), wordsOfPart(cm, b), 'only the part the mark names');
        await cm.close();
      });
    });

    it(`${kind}: parts locked at a fold before the part a mark names keep their lock`, async () => {
      await withDir(async (dir) => {
        const { cm, strategy, parts } = await markedAfterSummaries(dir, kind);
        const earlier = parts.slice(0, -1);
        for (const id of earlier) strategy.lockChunk(id);
        assert.ok(earlier.every((id) => strategy.resolutionOf(id) > 0), 'locked at a fold');
        cm.markDocument(parts.at(-1)!);
        assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), wordsOfPart(cm, parts.at(-1)!), 'only the part the mark names');
        await cm.close();
      });
    });
  }

  it('a level pin\'s bounds leave out a part locked with lockChunk that its ids don\'t name, as the replay exporter reads them', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir, 'kv-unified');
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      const parts = partsOf(cm, b);
      strategy.lockChunk(parts[3]!);
      cm.pinAtLevel(b, b, 1);
      const messages = viewOf(cm).getAll();
      const at = (id: string) => messages.findIndex((m) => m.id === id);
      const bounds = strategy.levelBounds(messages);
      assert.deepStrictEqual(parts.filter((id) => bounds.has(at(id))), parts.filter((_, i) => i !== 3));
      assert.deepStrictEqual(bounds.get(at(parts[0]!)), { level: 1 });
      await cm.close();
    });
  });

  it('a mark over its own part locked at a fold renders it raw over the lock, as before', async () => {
    await withDir(async (dir) => {
      const { cm, strategy, b } = await markedAfterSummaries(dir);
      assert.ok(strategy.resolutionOf(b) > 0, 'the first part folded');
      strategy.lockChunk(b);
      cm.markDocument(b);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });
});

describe('a compile that can\'t hold a whole message refuses, naming the pins that keep raw tokens in the middle', () => {
  for (const kind of ['adaptive', 'kv-stable', 'kv-unified'] as const) {
    it(`${kind}: names the mark, its whole message and its tokens; unpinned, the compile goes ahead`, async () => {
      await withDir(async (dir) => {
        const { cm, b, parts } = await markedAfterSummaries(dir, kind);
        const mark = cm.markDocument(b, { name: 'the spec' });
        const refusal = await refusalOf(cm, 30_000);
        const raw = refusal.diagnostics.rawPins!;
        assert.deepStrictEqual(raw.pins.map(({ tokens, ...pin }) => pin), [{
          pinId: mark, kind: 'document', name: 'the spec', firstMessageId: b, lastMessageId: b, parts: parts.length,
        }]);
        assert.ok(raw.tokens > 10_000 && raw.pins[0]!.tokens === raw.tokens, `the whole message's tokens: ${raw.tokens}`);
        assert.ok(raw.tokens <= refusal.diagnostics.middleTokens, `no more than the middle holds: ${raw.tokens} of ${refusal.diagnostics.middleTokens}`);
        assert.match(refusal.message, /exceed hard budget/, 'the phrase agent-framework matches stays');
        assert.ok(refusal.message.endsWith(
          `). A pin keeps ~${raw.tokens} tokens raw in the middle: document mark "the spec" (${mark}), message ${b}, ` +
          `covering ${parts.length} stored parts of its message. Whoever manages pins can unpin it, freeing up to those tokens; ` +
          `whoever sets the hard budget can raise it if the model's window allows.`), refusal.message);
        assert.ok(cm.unpin(mark));
        await cm.compile(budget(30_000));
        await cm.close();
      });
    });
  }

  it('counts the parts a mark covers, less a part locked with lockChunk that it doesn\'t name', async () => {
    await withDir(async (dir) => {
      const { cm, strategy, b, parts } = await markedAfterSummaries(dir);
      strategy.lockChunk(parts[3]!);
      const mark = cm.markDocument(b);
      const refusal = await refusalOf(cm, 30_000);
      assert.deepStrictEqual(refusal.diagnostics.rawPins!.pins.map((p) => [p.pinId, p.parts]), [[mark, parts.length - 1]]);
      assert.match(refusal.message, new RegExp(`covering ${parts.length - 1} stored parts of its message`));
      await cm.close();
    });
  });

  it('adaptive: prices a pinned message the cap cuts as the select sends it, cut', async () => {
    await withDir(async (dir) => {
      // A message of about 1,000 tokens, under the size at which ingress stores a message in parts, cut at 300.
      const { cm } = await open(dir, 'adaptive', 8000, { maxMessageTokens: 300 });
      await history(cm);
      const m = cm.addMessage('user', words('Mlong', 280));
      await traffic(cm, 360);
      await ready(cm);
      const pin = cm.pinRange(m, m);
      let raw: NonNullable<OverBudgetError['diagnostics']['rawPins']> | undefined;
      for (const maxTokens of [12_000, 9_000, 7_000, 5_000, 4_000, 3_000, 2_000, 1_500, 1_000, 700]) {
        try {
          await cm.compile(budget(maxTokens));
        } catch (err) {
          if (!(err instanceof OverBudgetError)) throw err;
          raw = err.diagnostics.rawPins;
          if (raw) break;
        }
      }
      assert.ok(raw, 'a refusal named the pin');
      assert.deepStrictEqual(raw.pins.map((p) => p.pinId), [pin]);
      assert.ok(raw.pins[0]!.tokens > 0 && raw.pins[0]!.tokens < 450, `priced cut: ${raw.pins[0]!.tokens}`);
      await cm.close();
    });
  });

  it('prices a marked message\'s parts uncut, as the plan sends a run of them joined', async () => {
    await withDir(async (dir) => {
      // Parts of about 2,000 tokens, each over a cap of 300 that the plan doesn't apply to them.
      const { cm } = await open(dir, 'adaptive', 8000, { maxMessageTokens: 300 });
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      await traffic(cm, 360);
      await ready(cm);
      const mark = cm.markDocument(b);
      let raw: NonNullable<OverBudgetError['diagnostics']['rawPins']> | undefined;
      for (const maxTokens of [30_000, 25_000, 20_000, 15_000]) {
        try {
          await cm.compile(budget(maxTokens));
        } catch (err) {
          if (!(err instanceof OverBudgetError)) throw err;
          raw = err.diagnostics.rawPins;
          if (raw) break;
        }
      }
      assert.ok(raw, 'a refusal named the mark');
      assert.deepStrictEqual(raw.pins.map((p) => p.pinId), [mark]);
      assert.ok(raw.tokens > 10_000, `priced uncut: ${raw.tokens}`);
      await cm.close();
    });
  });

  it('names every pin keeping raw tokens in the middle, counting a message two pins cover once, and none in the recent window', async () => {
    await withDir(async (dir) => {
      const { cm, b, parts } = await markedAfterSummaries(dir);
      const all = viewOf(cm).getAll();
      const at = all.findIndex((m) => m.id === parts.at(-1));
      const mark = cm.markDocument(b);
      // A range over B's third and fourth parts, which read whole covers all of B, as the mark does.
      const inside = cm.pinRange(parts[2]!, parts[3]!);
      // A range over two traffic messages in the middle, and a pin on the newest message, in the recent window.
      const traffic2 = cm.pinRange(all[at + 10]!.id, all[at + 11]!.id, { name: 'two events' });
      cm.pinRange(all.at(-1)!.id, all.at(-1)!.id);
      const refusal = await refusalOf(cm, 30_000);
      const raw = refusal.diagnostics.rawPins!;
      assert.deepStrictEqual(raw.pins.map((p) => [p.pinId, p.parts]), [[mark, parts.length], [inside, parts.length], [traffic2, undefined]]);
      const [m, i, t] = raw.pins;
      assert.strictEqual(m!.tokens, i!.tokens, 'both cover the whole message');
      assert.strictEqual(raw.tokens, m!.tokens + t!.tokens, 'the message both cover counts once');
      assert.ok(refusal.message.endsWith('Whoever manages pins can unpin them, freeing up to those tokens; whoever sets the hard budget can raise it if the model\'s window allows.'), refusal.message);
      await cm.close();
    });
  });

  it('a pin in the head window isn\'t named, since the head is sent raw either way', async () => {
    await withDir(async (dir) => {
      // A head window of 3,000 holds the first history messages.
      const { cm, strategy } = await open(dir, 'adaptive', 8000, { headWindowTokens: 3000 });
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      await traffic(cm, 360);
      await ready(cm);
      const all = viewOf(cm).getAll();
      assert.ok(strategy.headEnd(viewOf(cm) as never) > 0, 'the head window holds the first message');
      cm.pinRange(all[0]!.id, all[0]!.id);
      const mark = cm.markDocument(b);
      const raw = (await refusalOf(cm, 30_000)).diagnostics.rawPins!;
      assert.deepStrictEqual(raw.pins.map((p) => p.pinId), [mark]);
      await cm.close();
    });
  });

  it('after a head reset, names a pin in the history before the new head, which the select folds as middle', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await markedAfterSummaries(dir);
      const all = viewOf(cm).getAll();
      // The head now starts at the newest message, so the recent window reaches back before it: the history before
      // the head, recent messages included, is the select's middle.
      strategy.resetHeadWindow(all.at(-1)!.id);
      const pin = cm.pinRange(all.at(-3)!.id, all.at(-3)!.id);
      const raw = (await refusalOf(cm, 3_000)).diagnostics.rawPins;
      assert.deepStrictEqual(raw?.pins.map((p) => p.pinId), [pin]);
      await cm.close();
    });
  });

  it('with the head window disabled, a head reset leaves the recent messages before the head in the tail, so a pin there isn\'t named', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir, 'adaptive', 8000, { headWindowTokens: 0 });
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      await traffic(cm, 360);
      await ready(cm);
      const mark = cm.markDocument(b);
      const all = viewOf(cm).getAll();
      strategy.resetHeadWindow(all.at(-1)!.id);
      cm.pinRange(all.at(-3)!.id, all.at(-3)!.id);
      const refusal = await refusalOf(cm, 30_000);
      assert.match(refusal.message, /^Adaptive picker exhausted/);
      assert.deepStrictEqual(refusal.diagnostics.rawPins?.pins.map((p) => p.pinId), [mark]);
      await cm.close();
    });
  });

  it('kv-stable: names a raw pin but not a pin with a level or a cap that overlaps it, which keeps nothing raw', async () => {
    await withDir(async (dir) => {
      const { cm, b } = await markedAfterSummaries(dir, 'kv-stable');
      const mark = cm.markDocument(b, { level: 0 });
      cm.pinAtLevel(b, b, 2);
      cm.pinRange(b, b, { maxLevel: 2 });
      const raw = (await refusalOf(cm, 30_000)).diagnostics.rawPins!;
      assert.deepStrictEqual(raw.pins.map((p) => p.pinId), [mark]);
      await cm.close();
    });
  });

  it('kv-unified: doesn\'t count toward a raw range the message a level pin holds inside it', async () => {
    await withDir(async (dir) => {
      const { cm } = await open(dir, 'kv-unified');
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 3000));
      const c = cm.addMessage('user', words('Cdoc', 3000));
      await traffic(cm, 360);
      await ready(cm);
      // The range keeps B and C raw; a level, which takes a classic pin's place, holds C at level 1.
      const range = cm.pinRange(b, c);
      cm.pinAtLevel(c, c, 1);
      let raw: NonNullable<OverBudgetError['diagnostics']['rawPins']> | undefined;
      const seen: string[] = [];
      for (const maxTokens of [30_000, 25_000, 20_000, 15_000, 12_000]) {
        try {
          await cm.compile(budget(maxTokens));
          seen.push(`${maxTokens}: compiled`);
        } catch (err) {
          if (!(err instanceof OverBudgetError)) throw err;
          seen.push(`${maxTokens}: ${err.message.slice(0, 120)}`);
          raw = err.diagnostics.rawPins;
          if (raw) break;
        }
      }
      assert.ok(raw, `a refusal named the range: ${seen.join(' | ')}`);
      assert.deepStrictEqual(raw.pins.map((p) => p.pinId), [range]);
      assert.strictEqual(raw.pins[0]!.tokens, raw.tokens, 'the range keeps raw only what the total counts');
      // B and C are the same size, so B alone is about half of both.
      const ids = new Set([...partsOf(cm, b), ...partsOf(cm, c)]);
      const both = viewOf(cm).getAll().filter((m) => ids.has(m.id)).reduce((n, m) => n + viewOf(cm).estimateTokens(m), 0);
      assert.ok(raw.tokens < both * 0.6, `${raw.tokens} of ${both}: C, held at a level, isn't counted`);
      await cm.close();
    });
  });

  it('under a solver that reads no bounds, names a mark with a level, which renders raw there', async () => {
    await withDir(async (dir) => {
      const { cm, b } = await markedAfterSummaries(dir);
      const mark = cm.markDocument(b, { level: 2 });
      const raw = (await refusalOf(cm, 30_000)).diagnostics.rawPins!;
      assert.deepStrictEqual(raw.pins.map((p) => p.pinId), [mark]);
      await cm.close();
    });
  });

  it('counts a part locked raw inside a pin\'s span, as every raw position in the middle', async () => {
    const named = async (lock: boolean) => {
      let tokens = 0;
      await withDir(async (dir) => {
        const { cm, strategy } = await open(dir);
        await history(cm);
        const b = cm.addMessage('user', words('Bdoc', 6000));
        await traffic(cm, 360);
        await ready(cm);
        const parts = partsOf(cm, b);
        // No compile has folded it yet, so the lock holds it raw.
        if (lock) strategy.lockChunk(parts[4]!);
        assert.strictEqual(strategy.resolutionOf(parts[4]!), 0);
        // A range over every part, so the locked one is inside the span its ids name and the pin covers it.
        cm.pinRange(parts[0]!, parts.at(-1)!);
        tokens = (await refusalOf(cm, 30_000)).diagnostics.rawPins!.tokens;
        await cm.close();
      });
      return tokens;
    };
    assert.strictEqual(await named(true), await named(false));
  });

  it('a mark held at a level keeps nothing raw, so a refusal in the middle names no pin, as before', async () => {
    await withDir(async (dir) => {
      const { cm, b } = await markedAfterSummaries(dir, 'kv-stable');
      cm.markDocument(b, { level: 1 });
      const refusal = await refusalOf(cm, 10_000);
      assert.match(refusal.message, /^Adaptive picker exhausted/, 'the plan\'s refusal, the one that names pins');
      assert.strictEqual(refusal.diagnostics.rawPins, undefined);
      assert.ok(refusal.message.endsWith(')'), refusal.message);
      await cm.close();
    });
  });

  it('a refusal of the head and recent windows alone names no pin, since unpinning wouldn\'t clear it', async () => {
    await withDir(async (dir) => {
      const { cm, b } = await markedAfterSummaries(dir);
      cm.markDocument(b);
      const refusal = await refusalOf(cm, 5_000);
      assert.match(refusal.message, /^Head\/tail reservation exceeded budget/);
      assert.strictEqual(refusal.diagnostics.rawPins, undefined);
      await cm.close();
    });
  });

  it('a hierarchical refusal names no pin, as before: only the adaptive plan\'s refusal does', async () => {
    await withDir(async (dir) => {
      const strategy = new AutobiographicalStrategy({
        compressionModel: 'test-model', adaptiveResolution: false, targetChunkTokens: 40, headWindowTokens: 0,
        recentWindowTokens: 0, overBudgetGraceRatio: 0.25, autoTickOnNewMessage: false, speculativeProduction: false,
      } as AutobiographicalConfig);
      const cm = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: summarizer().membrane });
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(cm.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      cm.pinRange(ids[2]!, ids[3]!);
      const refusal = await refusalOf(cm, 100);
      assert.match(refusal.message, /^Hierarchical emission overran the budget/);
      assert.strictEqual(refusal.diagnostics.rawPins, undefined);
      assert.ok(refusal.message.endsWith(')'), refusal.message);
      cm.close();
    });
  });
});

describe('the refusal\'s words for the pins it names', () => {
  const diagnostics = { headTokens: 0, tailTokens: 10, middleTokens: 90, middleChunkCount: 3, deepestLevel: 1 };
  it('names one pin, a range read whole, and a pin with no name', () => {
    const error = new OverBudgetError({
      budget: 50, actual: 100,
      diagnostics: { ...diagnostics, rawPins: { tokens: 70, pins: [{ pinId: 'pin-1', kind: 'pin', firstMessageId: 'a', lastMessageId: 'c', parts: 5, tokens: 70 }] } },
    });
    assert.ok(error.message.endsWith(
      '). A pin keeps ~70 tokens raw in the middle: pin pin-1, messages a to c, covering 5 stored messages. ' +
      'Whoever manages pins can unpin it, freeing up to those tokens; whoever sets the hard budget can raise it if the model\'s window allows.'), error.message);
  });
  it('names several pins, and says nothing of pins without any', () => {
    const error = new OverBudgetError({
      budget: 50, actual: 100,
      diagnostics: {
        ...diagnostics,
        rawPins: { tokens: 80, pins: [
          { pinId: 'pin-0', kind: 'document', name: 'notes', firstMessageId: 'm', lastMessageId: 'm', tokens: 50 },
          { pinId: 'pin-2', kind: 'pin', firstMessageId: 'x', lastMessageId: 'x', tokens: 30 },
        ] },
      },
    });
    assert.ok(error.message.endsWith(
      '). Pins keep ~80 tokens raw in the middle: document mark "notes" (pin-0), message m, ~50 tokens; pin pin-2, message x, ~30 tokens. ' +
      'Whoever manages pins can unpin them, freeing up to those tokens; whoever sets the hard budget can raise it if the model\'s window allows.'), error.message);
    assert.ok(new OverBudgetError({ budget: 50, actual: 100, diagnostics }).message.endsWith(')'));
  });
  it('ends with a remedy short enough to stay whole in the last quarter of a 600-character cut', () => {
    for (const n of [1, 2]) {
      const pins = Array.from({ length: n }, (_, i) => ({ pinId: `pin-${i}`, kind: 'pin' as const, name: 'x'.repeat(400), firstMessageId: 'm', lastMessageId: 'm', tokens: 10 }));
      const message = new OverBudgetError({ budget: 50, actual: 100, diagnostics: { ...diagnostics, rawPins: { tokens: 10 * n, pins } } }).message;
      // agent-framework quotes a compile error cut at 600 characters, keeping the head and the last 140.
      const remedy = message.lastIndexOf(' Whoever manages pins');
      assert.ok(message.length > 600 && remedy >= 0, message);
      assert.ok(message.length - remedy <= 140, message);
    }
  });
});
