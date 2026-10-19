/**
 * kv-unified records each cache marker as the solved layout's boundary where
 * the marker's entry ends (reconcileKvUnifiedMarkerIndices), and the layout
 * renders the head as one unit. So a marker can sit in the head only at the
 * head's end, and a body that the head and the recent window share, merged
 * into one entry, ends on its last shard. Each case compiles a store, then
 * accepts the request with one wire marker for each breakpoint, as membrane's
 * receipt names them under `cm-owned`. The breakpoints must sit on the
 * messages the case names, and the accepted cache reference must keep every
 * marker, each at the offset where its message ends.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { KvUnifiedReceiptChain } from '../src/adaptive/kv-unified-receipts.js';
import type { ContextEntry, StoredMessage } from '../src/types/index.js';

const KV_UNIFIED = {
  policy: {
    alpha: 0.7,
    budgetLowRatio: 0.5,
    budgetHighRatio: 0.9,
    budgetUnderLambda: 10,
    budgetOverLambda: 10,
    cacheLambda: 1,
    cacheScale: 1000,
    cacheReadPrice: 0.1,
    cacheWritePrice: 1.25,
    continuityLambda: 1,
    continuityScale: 1000,
    continuityRecencyHalfLifeTokens: 1000,
    continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10,
    continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100,
  continuityBucketSize: 100,
  fidelityBucketSize: 100,
  labelCeiling: 10_000,
  adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false,
  preserveGapBearingSummaries: false,
};

const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const PROSE = 'lorem ipsum dolor sit amet consectetur '.repeat(2_100);
// Ingress splits an 80,000-character body into seven shards; a message of
// 5,800 characters stays whole, at about 2,000 tokens.
const BODY = PROSE.slice(0, 80_000);
const plain = (k: number): string => `${k} ${PROSE.slice(0, 5_800)}`;

type Case = {
  /** The messages before the closing reply and question, alternating from the user. */
  messages: string[];
  config: Record<string, unknown>;
  /** Messages in the head window, raw in the middle, and in the recent window. */
  regions: [number, number, number];
  /** The messages on the wire that carry a breakpoint, by index. */
  marked: number[];
};

const CASES: Record<string, Case> = {
  'a body first, its shards across the head and the recent window: the body is marked': {
    messages: [BODY],
    config: { headWindowTokens: 9_000, recentWindowTokens: 20_000 },
    regions: [2, 0, 7],
    marked: [0, 2],
  },
  'a short exchange, then a body across the head and the recent window: the body is marked, the exchange is not': {
    messages: ['intro', 'hi', BODY],
    config: { headWindowTokens: 9_000, recentWindowTokens: 20_000 },
    regions: [4, 0, 7],
    marked: [2, 4],
  },
  "five messages in the head and nothing in the middle: only the head's last is marked": {
    messages: [0, 1, 2, 3, 4].map(plain),
    config: { headWindowTokens: 10_100, recentWindowTokens: 300 },
    regions: [5, 0, 2],
    marked: [4, 6],
  },
  "three messages in the head and three raw in the middle: the head's last and the middle are marked": {
    messages: [0, 1, 2, 3, 4, 5].map(plain),
    config: { headWindowTokens: 6_300, recentWindowTokens: 300 },
    regions: [3, 3, 2],
    marked: [2, 3, 5, 7],
  },
  'a body whole in the head: the body is marked': {
    messages: [BODY],
    config: { headWindowTokens: 27_700, recentWindowTokens: 300 },
    regions: [7, 0, 2],
    marked: [0, 2],
  },
  'everything in the recent window: only the last message is marked': {
    messages: [BODY],
    config: { headWindowTokens: 0, recentWindowTokens: 40_000 },
    regions: [0, 0, 9],
    marked: [2],
  },
};

const textLength = (content: ContentBlock[]): number =>
  content.reduce((sum, block) => sum + ((block as { text?: string }).text?.length ?? 0), 0);

const breakpointsOf = (messages: Array<{ cacheBreakpoint?: boolean }>): number[] =>
  messages.flatMap((message, i) => (message.cacheBreakpoint ? [i] : []));

function receipts(strategy: AutobiographicalStrategy): KvUnifiedReceiptChain {
  return (strategy as unknown as { kvUnifiedReceipts: KvUnifiedReceiptChain }).kvUnifiedReceipts;
}

function kvUnified(config: Record<string, unknown>): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } },
    ...config,
  });
}

async function open(messages: Array<[string, ContentBlock[]]>, config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-kv-marker-boundaries-'));
  const strategy = kvUnified(config);
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  for (const [participant, content] of messages) manager.addMessage(participant, content);
  const store = (manager as unknown as {
    messageStore: { estimateTokens(message: StoredMessage): number; getAll(): StoredMessage[] };
  }).messageStore;
  let submissions = 0;
  /** Compile, with the immutable prefix hash unless `hash` is false. */
  const compile = (hash = true) =>
    manager.compile(BIG, undefined, hash ? { kvUnifiedImmutablePrefixHash: 'v1' } : undefined);
  /** Begin the compiled request's submission, and name it. */
  const begin = (): string => {
    const id = `s${++submissions}`;
    strategy.beginKvUnifiedSubmission({ submissionId: id, requestHash: `wire-${id}`, layoutHash: `layout-${id}` });
    return id;
  };
  /** Accept a submission with `markers` markers on the wire, or with no wire receipt. */
  const accept = (id: string, markers: number | undefined): void => {
    strategy.reportKvUnifiedAccepted({
      submissionId: id,
      acceptedAt: submissions,
      ...(markers === undefined ? {} : {
        wireReceipt: {
          requestHash: `wire-${id}`,
          markers: Array.from({ length: markers }, (_, ordinal) => ({
            ordinal,
            prefixHash: `prefix-${ordinal}`,
            estimatedOffset: ordinal + 1,
          })),
        },
      }),
    });
  };
  const close = async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { manager, strategy, store, compile, begin, accept, close };
}

/** A case's messages, alternating from the user, then a reply and a question. */
const conversation = (c: Case): Array<[string, ContentBlock[]]> => [
  ...c.messages.map((text, i): [string, ContentBlock[]] => [i % 2 ? 'a' : 'u', [{ type: 'text', text }]]),
  ['a', [{ type: 'text', text: 'ok '.repeat(200) }]],
  ['u', [{ type: 'text', text: 'next' }]],
];

describe('kv-unified records each cache marker where its message ends', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(name, async () => {
      const o = await open(conversation(c), c.config);
      try {
        const compiled = await o.compile();
        const stats = o.manager.getRenderStats()!;
        assert.deepEqual([stats.head.messages, stats.middleRaw.messages, stats.tail.messages], c.regions,
          'premise: the messages render in the head, the middle and the recent window as named');
        const marked = breakpointsOf(compiled.messages);
        assert.deepEqual(marked, c.marked, 'the messages on the wire that carry a breakpoint');
        o.accept(o.begin(), marked.length);
        // Where each message on the wire ends, in tokens: the stored messages
        // it holds, in store order, each at the store's estimate.
        const stored = o.store.getAll();
        let next = 0;
        let offset = 0;
        const ends = compiled.messages.map((message) => {
          let chars = textLength(message.content);
          while (chars > 0 && next < stored.length) {
            chars -= textLength(stored[next]!.content);
            offset += o.store.estimateTokens(stored[next]!);
            next++;
          }
          assert.equal(chars, 0, 'premise: each message on the wire holds whole stored messages');
          return offset;
        });
        const expected = marked.map((i) => ends[i]!);
        const cache = receipts(o.strategy).cache;
        assert.ok(cache, 'the accepted presentation keeps a cache reference');
        assert.deepEqual(cache.markers.map((marker) => marker.offset), expected,
          `markers at ${JSON.stringify(cache.markers.map((marker) => marker.offset))}, breakpoints end at ${JSON.stringify(expected)}`);
      } finally {
        await o.close();
      }
    });
  }

  it("a head message with a tool call whose result isn't next: the repair after it doesn't make it the head's end", async () => {
    // enforceToolPairing splices a stub result, an entry with no source,
    // between the call and the next head message.
    const head: Array<[string, ContentBlock[]]> = [
      ['u', [{ type: 'text', text: plain(0) }]],
      ['a', [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } } as ContentBlock]],
      ['u', [{ type: 'text', text: plain(2) }]],
      ['a', [{ type: 'text', text: plain(3) }]],
      ['u', [{ type: 'text', text: plain(4) }]],
    ];
    const o = await open([
      ...head,
      ['a', [{ type: 'text', text: 'ok '.repeat(200) }]],
      ['u', [{ type: 'text', text: 'next' }]],
    ], { headWindowTokens: 8_100, recentWindowTokens: 300 });
    try {
      const compiled = await o.compile();
      const stats = o.manager.getRenderStats()!;
      assert.deepEqual([stats.head.messages, stats.middleRaw.messages, stats.tail.messages], [5, 0, 2],
        'premise: the five messages render in the head, and the reply and question in the recent window');
      assert.equal(compiled.messages.length, 8, 'premise: a stub result follows the tool call');
      assert.ok(compiled.messages[2]!.content.every((block) => block.type === 'tool_result'),
        'premise: the third message on the wire is the stub result');
      assert.deepEqual(breakpointsOf(compiled.messages), [5, 7], "only the head's last message and the question carry breakpoints");
      o.accept(o.begin(), 2);
      const stored = o.store.getAll();
      const headTokens = stored.slice(0, 5).reduce((sum, m) => sum + o.store.estimateTokens(m), 0);
      const total = stored.reduce((sum, m) => sum + o.store.estimateTokens(m), 0);
      const cache = receipts(o.strategy).cache;
      assert.ok(cache, 'the accepted presentation keeps a cache reference');
      assert.deepEqual(cache.markers.map((marker) => marker.offset), [headTokens, total]);
    } finally {
      await o.close();
    }
  });

  it('a recall question carries no marker, and its answer can', () => {
    // A question has no layout identity, and an answer's is its cacheLayoutKey.
    // The question ends where the first third's target is nearest, so a
    // question taken for a boundary would be marked there.
    const strategy = kvUnified({ headWindowTokens: 0, recentWindowTokens: 100 });
    const entry = (fields: Partial<ContextEntry>, chars: number): ContextEntry =>
      ({ participant: 'u', content: [{ type: 'text', text: 'x'.repeat(chars) }], ...fields } as ContextEntry);
    const entries = [
      entry({ sourceMessageId: 'h0', sourceRelation: 'copy' }, 40),
      entry({ participant: 'Context Manager', sourceRelation: 'derived' }, 400),
      entry({ participant: 'agent', sourceRelation: 'derived', cacheLayoutKey: 'S1' }, 40),
      entry({ sourceMessageId: 'm0', sourceRelation: 'copy' }, 400),
      entry({ sourceMessageId: 't0', sourceRelation: 'copy' }, 40),
    ];
    (strategy as unknown as {
      placeCacheMarkers(entries: ContextEntry[], head: ReadonlySet<string>, tail: ReadonlySet<string>): void;
    }).placeCacheMarkers(entries, new Set(['h0']), new Set(['t0']));
    assert.deepEqual(entries.flatMap((e, i) => (e.cacheMarker ? [i] : [])), [2, 3, 4]);
  });
});

describe("a request whose marker count differs from its compile's", () => {
  it('keeps no cache reference and is logged once; nothing else is logged', async () => {
    const c = CASES['everything in the recent window: only the last message is marked']!;
    const o = await open(conversation(c), c.config);
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[kv-unified]') && line.includes('cache markers where')) logged.push(line);
      else original(...args);
    };
    try {
      // One breakpoint per compile in this store.
      await o.compile();
      o.accept(o.begin(), 1);
      assert.ok(receipts(o.strategy).cache, 'a request whose markers match keeps its reference');
      await o.compile();
      o.accept(o.begin(), undefined);
      await o.compile();
      o.accept(o.begin(), 0);
      assert.equal(receipts(o.strategy).cache, null, 'a request with no markers keeps no reference');
      // A late callback for a settled submission is the receipt chain's duplicate.
      await o.compile();
      const settled = o.begin();
      o.accept(settled, 1);
      await o.compile();
      o.begin();
      o.accept(settled, 3);
      // A compile with no immutable prefix hash keeps no reference whatever its markers.
      await o.compile(false);
      o.accept(o.begin(), 3);
      assert.deepEqual(logged, [], 'nothing is logged for a match, no wire receipt, no markers, a late callback or no hash');
      await o.compile();
      o.accept(o.begin(), 3);
      assert.equal(receipts(o.strategy).cache, null, 'two markers more than the compile marked keep no reference');
      assert.equal(logged.length, 1);
      assert.match(logged[0]!, /carried 3 cache markers where its compile marked 1 layout boundary,/);
      await o.compile();
      o.accept(o.begin(), 2);
      assert.equal(logged.length, 1, 'a second mismatch is not logged again');
    } finally {
      console.error = original;
      await o.close();
    }
  });

  it('names the boundaries in the plural', async () => {
    const c = CASES['a body first, its shards across the head and the recent window: the body is marked']!;
    const o = await open(conversation(c), c.config);
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[kv-unified]') && line.includes('cache markers where')) logged.push(line);
      else original(...args);
    };
    try {
      await o.compile();
      o.accept(o.begin(), 3);
      assert.equal(logged.length, 1);
      assert.match(logged[0]!, /carried 3 cache markers where its compile marked 2 layout boundaries,/);
    } finally {
      console.error = original;
      await o.close();
    }
  });
});
