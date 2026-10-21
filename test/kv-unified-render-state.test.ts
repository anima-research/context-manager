/**
 * kv-unified credits a cached prefix through the accepted request's markers,
 * matching the reference's units by kind and key. A message under an
 * unchanged key can still render differently from the request that cached
 * it: an edit rewrites it, an image is stripped once newer ones reach
 * maxLiveImages or it falls past imageStripDepthTokens, a tool result is
 * replaced once newer results of its tool reach toolResultMaxLastN, or a late
 * result moves up over the stub pairing repair put after its call. A provider
 * serves a marker's prefix only while every byte before it is unchanged.
 *
 * The cut cases compile, accept with one wire marker per breakpoint, change
 * something, and compile again: the selected cut's churn must be what the
 * wire allows, which is everything the reference carried less the prefix
 * through the last accepted breakpoint before the first message whose bytes
 * changed. The tie cases accept, append without changing anything in place,
 * and compile again: every marker must still be credited, so a rebuild that
 * renders a message differently from the emission fails here instead of
 * quietly dropping markers. And wherever a compile here keeps the accepted
 * presentation, the strategy's self-check compares its rebuild with what it
 * sent: no test here may make it warn, unless it expects to.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { KvUnifiedReceiptChain } from '../src/adaptive/kv-unified-receipts.js';

/** Every [kv-unified] warning a test here gives, in order. A test that
 *  expects one takes it from here; the self-check's fails any other test. */
const kvWarnings: string[] = [];
const SELF_CHECK = 'the cache check rebuilt the prefix through';
const consoleWarn = console.warn;
before(() => {
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('[kv-unified]')) kvWarnings.push(line);
    consoleWarn(...args);
  };
});
after(() => {
  console.warn = consoleWarn;
});
afterEach(() => {
  const seen = kvWarnings.splice(0).filter((line) => line.includes(SELF_CHECK));
  assert.deepEqual(seen, [], 'no compile here finds its rebuild differing from what it sent');
});
/** Takes the warnings holding `needle`, leaving the rest for afterEach. */
const taken = (needle: string): string[] => {
  const hits = kvWarnings.filter((line) => line.includes(needle));
  const rest = kvWarnings.filter((line) => !line.includes(needle));
  kvWarnings.splice(0, kvWarnings.length, ...rest);
  return hits;
};

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
const CHURN_PRICE = Math.max(0, KV_UNIFIED.policy.cacheWritePrice - KV_UNIFIED.policy.cacheReadPrice);
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const HASH = { kvUnifiedImmutablePrefixHash: 'immutable-v1' };

const PROSE = 'lorem ipsum dolor sit amet consectetur '.repeat(2_100);
const plain = (k: number): string => `${k} ${PROSE.slice(0, 5_800)}`;
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const image = (): ContentBlock =>
  ({ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' }, tokenEstimate: 1600 } as unknown as ContentBlock);
const call = (id: string, q: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'lookup', input: { q } } as unknown as ContentBlock);
const result = (id: string, content: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content } as unknown as ContentBlock);

const replayed = (t: string, id: string): ContentBlock =>
  ({ type: 'text', text: t, rawItem: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text: t }] } } as unknown as ContentBlock);

type Msg = [string, ContentBlock[]];
type Manager = Awaited<ReturnType<typeof ContextManager.open>>;
type Wire = { participant: string; content: ContentBlock[]; cacheBreakpoint?: boolean };
type Unit = { kind: string; key: string; tokens: number; offset: number };
type Layout = { units: Unit[]; totalTokens: number };
type Cache = { layout: Layout; markers: Array<{ unitIndex: number; offset: number }>; render?: unknown };
type Solved = { feasible: boolean; cacheRelevant?: boolean; selected?: { layout: Layout; cacheChurn: number } };

const MIDDLE: Msg[] = [
  ['u', [text(plain(0))]], ['a', [text(plain(1))]], ['u', [text(plain(2))]], ['a', [text(plain(3))]],
];
const CLOSE: Msg[] = [['u', [text('q')]], ['a', [text('ok')]], ['u', [text('next')]]];
const SMALL: Msg[] = [['a', [text('ok2')]], ['u', [text('next2')]]];

const bytes = (m: Wire): string => JSON.stringify({ participant: m.participant, content: m.content });
const breakpoints = (wire: Wire[]): number[] => wire.flatMap((m, i) => (m.cacheBreakpoint ? [i] : []));
const firstChange = (before: Wire[], after: Wire[]): number => {
  let i = 0;
  while (i < before.length && i < after.length && bytes(before[i]!) === bytes(after[i]!)) i++;
  return i;
};

const internals = (s: AutobiographicalStrategy) => s as unknown as {
  kvUnifiedReceipts: KvUnifiedReceiptChain;
  kvUnifiedSolveCache: Cache | null;
  kvUnifiedDraft: { render?: unknown } | null;
  _lastKvUnified: { lastResult?: Solved } | null;
  store: { getStateJson(id: string): unknown; setStateJson(id: string, value: unknown): void };
  kvUnifiedReceiptStateId: string;
};
const reference = (s: AutobiographicalStrategy): Cache | null =>
  internals(s).kvUnifiedReceipts.cache as unknown as Cache | null;
const solved = (s: AutobiographicalStrategy): Solved | undefined => internals(s)._lastKvUnified?.lastResult;
/** How many of the reference's markers the solve gets: the check's output,
 *  or the reference itself in a build without the check, as a red-first run
 *  against the base has. */
const solveMarkers = (s: AutobiographicalStrategy): number | undefined =>
  'kvUnifiedSolveCache' in s ? internals(s).kvUnifiedSolveCache?.markers.length : reference(s)?.markers.length;

let submissions = 0;
function begin(s: AutobiographicalStrategy): string {
  const id = `s${++submissions}`;
  s.beginKvUnifiedSubmission({ submissionId: id, requestHash: `wire-${id}`, layoutHash: `layout-${id}` });
  return id;
}
function settle(s: AutobiographicalStrategy, id: string, wire: Wire[]): void {
  s.reportKvUnifiedAccepted({
    submissionId: id,
    acceptedAt: submissions,
    wireReceipt: {
      requestHash: `wire-${id}`,
      markers: breakpoints(wire).map((_, ordinal) => ({ ordinal, prefixHash: `p${ordinal}`, estimatedOffset: ordinal + 1 })),
    },
  });
}
const accept = (s: AutobiographicalStrategy, wire: Wire[]): void => settle(s, begin(s), wire);

/** The churn the wire allows for the selected cut: the reference's markers in
 *  order are the accepted request's breakpoints in order, and one survives
 *  when its breakpoint comes before the first message whose bytes changed. */
function wireChurn(before: Wire[], after: Wire[], ref: Cache, layout: Layout): number {
  const points = breakpoints(before);
  assert.equal(points.length, ref.markers.length, "premise: one recorded marker per breakpoint on the accepted request's wire");
  const changed = firstChange(before, after);
  const end = (k: number): number => (k === 0 ? 0 : layout.units[k - 1]!.offset + layout.units[k - 1]!.tokens);
  const cached = Math.max(0, ...ref.markers.filter((_, i) => points[i]! < changed).map((m) => end(m.unitIndex)));
  const carried = layout.units.slice(0, ref.layout.units.length).reduce((n, u) => n + u.tokens, 0);
  return Math.max(0, carried - cached) * CHURN_PRICE;
}

function strategyFor(config: Record<string, unknown>): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    compressionModel: 'mock',
    kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } },
    imageStripDepthTokens: 0,
    ...config,
  });
}

async function open(config: Record<string, unknown>, dir = mkdtempSync(join(tmpdir(), 'cm-kv-render-state-')), membrane?: unknown) {
  const strategy = strategyFor(config);
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, ...(membrane ? { membrane: membrane as never } : {}) });
  return { dir, strategy, manager };
}
const add = (manager: Manager, messages: Msg[]): void => {
  for (const [p, content] of messages) manager.addMessage(p, content);
};
const compile = async (manager: Manager, dryRun = false): Promise<Wire[]> =>
  (await manager.compile(BIG, undefined, dryRun ? { ...HASH, dryRun: true } : HASH)).messages as Wire[];
const ids = (manager: Manager): string[] =>
  (manager as unknown as { messageStore: { getAll(): Array<{ id: string }> } }).messageStore.getAll().map((m) => m.id);

type CutCase = {
  config: Record<string, unknown>;
  first: Msg[];
  /** What happens between the two compiles. */
  change: (manager: Manager) => void;
  regions: [number, number, number];
  changed: number | null;
};

const CUTS: Record<string, CutCase> = {
  'everything in the recent window: the oldest message loses its image to a newer one': {
    config: { headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1 },
    first: [['u', [image(), text('A ' + plain(0))]], ['a', [text(plain(1))]], ['u', [text(plain(2))]], ['a', [text('ok')]], ['u', [text('next')]]],
    change: (m) => add(m, [['a', [text(plain(3))]], ['u', [image(), text('B ' + plain(4))]], ...SMALL]),
    regions: [0, 0, 9],
    changed: 0,
  },
  'everything in the recent window: the oldest message falls past the strip depth and loses its image': {
    // The depth walk sums from the newest message and strips the one that
    // takes it over the depth. With the image's message it reaches about
    // 7,600 tokens at the first compile, under 9,000, and about 11,600 at the
    // second, over it.
    config: { headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 0, imageStripDepthTokens: 9_000 },
    first: [['u', [image(), text('A ' + plain(0))]], ['a', [text(plain(1))]], ['u', [text(plain(2))]], ['a', [text('ok')]], ['u', [text('next')]]],
    change: (m) => add(m, [['a', [text(plain(3))]], ['u', [text('B ' + plain(4))]], ...SMALL]),
    regions: [0, 0, 9],
    changed: 0,
  },
  'raw in the middle: the fifth message loses its image to a newer one': {
    config: { headWindowTokens: 0, recentWindowTokens: 300, maxLiveImages: 1 },
    first: [...MIDDLE, ['u', [image(), text('A ' + plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => add(m, [['a', [text(plain(6))]], ['u', [image(), text('B ' + plain(7))]], ...SMALL]),
    regions: [0, 11, 2],
    changed: 4,
  },
  "raw in the middle: the fifth message's image no longer fits maxLiveImageBytes beside a newer one": {
    config: { headWindowTokens: 0, recentWindowTokens: 300, maxLiveImages: 0, maxLiveImageBytes: 5 },
    first: [...MIDDLE, ['u', [image(), text('A ' + plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => add(m, [['a', [text(plain(6))]], ['u', [image(), text('B ' + plain(7))]], ...SMALL]),
    regions: [0, 11, 2],
    changed: 4,
  },
  "raw in the middle: the fifth message's tool result is replaced by a newer one of the same tool": {
    config: { headWindowTokens: 0, recentWindowTokens: 300, toolResultMaxLastN: 1 },
    first: [...MIDDLE.slice(0, 3), ['a', [call('call-1', 'first')]], ['u', [result('call-1', plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => add(m, [['a', [call('call-2', 'second')]], ['u', [result('call-2', plain(7))]], ...SMALL]),
    regions: [0, 11, 2],
    changed: 4,
  },
  'raw in the middle: the third message is edited in place': {
    config: { headWindowTokens: 0, recentWindowTokens: 300 },
    first: [...MIDDLE, ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => {
      m.editMessage(ids(m)[2]!, [text('edited ' + plain(2))]);
      add(m, [['a', [text(plain(6))]], ['u', [text(plain(7))]], ...SMALL]);
    },
    regions: [0, 11, 2],
    changed: 2,
  },
  "raw in the middle: an edit changes only the third message's raw replay form": {
    config: { headWindowTokens: 0, recentWindowTokens: 300 },
    first: [...MIDDLE.slice(0, 2), ['u', [replayed(plain(2), 'msg-1')]], ...MIDDLE.slice(3), ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => {
      m.editMessage(ids(m)[2]!, [replayed(plain(2), 'msg-2')]);
      add(m, [['a', [text(plain(6))]], ['u', [text(plain(7))]], ...SMALL]);
    },
    regions: [0, 11, 2],
    changed: 2,
  },
  'raw in the middle: an edit before an image stripped later decides the cut': {
    config: { headWindowTokens: 0, recentWindowTokens: 300, maxLiveImages: 1 },
    first: [...MIDDLE, ['u', [image(), text('A ' + plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => {
      m.editMessage(ids(m)[2]!, [text('edited ' + plain(2))]);
      add(m, [['a', [text(plain(6))]], ['u', [image(), text('B ' + plain(7))]], ...SMALL]);
    },
    regions: [0, 11, 2],
    changed: 2,
  },
  "a tool call's late result moves up over the stub after it": {
    config: { headWindowTokens: 0, recentWindowTokens: 300 },
    first: [...MIDDLE, ['u', [text(plain(4))]], ['a', [text(plain(5))]], ['u', [text('q')]], ['a', [call('call-1', 'late')]], ['u', [text('next')]]],
    change: (m) => add(m, [['u', [result('call-1', 'the late result')]], ...SMALL]),
    regions: [0, 6, 6],
    changed: 8,
  },
  'the head window: its message loses its image to a newer one': {
    config: { headWindowTokens: 1_700, recentWindowTokens: 300, maxLiveImages: 1 },
    first: [['u', [image(), text('A')]], ['a', [text(plain(1))]], ['u', [text(plain(2))]], ['a', [text(plain(3))]], ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => add(m, [['a', [text(plain(6))]], ['u', [image(), text('B ' + plain(7))]], ...SMALL]),
    regions: [1, 10, 2],
    changed: 0,
  },
  "the head window: its tool result is replaced by a newer one of the same tool": {
    config: { headWindowTokens: 2_700, recentWindowTokens: 300, toolResultMaxLastN: 1 },
    first: [['u', [text('look it up')]], ['a', [call('call-1', 'first')]], ['u', [result('call-1', plain(2))]], ['a', [text(plain(3))]], ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => add(m, [['a', [call('call-2', 'second')]], ['u', [result('call-2', plain(7))]], ...SMALL]),
    regions: [3, 8, 2],
    changed: 2,
  },
  'nothing changes in place: every marker is credited': {
    config: { headWindowTokens: 0, recentWindowTokens: 300, maxLiveImages: 1 },
    first: [...MIDDLE, ['u', [image(), text('A ' + plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    change: (m) => add(m, [['a', [text(plain(6))]], ['u', [text('B ' + plain(7))]], ...SMALL]),
    regions: [0, 11, 2],
    changed: null,
  },
};

describe('kv-unified credits only a prefix whose bytes are unchanged', () => {
  for (const [name, c] of Object.entries(CUTS)) {
    it(name, async () => {
      const { dir, strategy, manager } = await open(c.config);
      try {
        add(manager, c.first);
        const one = await compile(manager);
        accept(strategy, one);
        const ref = reference(strategy);
        assert.ok(ref, 'premise: the accepted request keeps a cache reference');
        c.change(manager);
        const two = await compile(manager);
        const stats = manager.getRenderStats()!;
        assert.deepEqual([stats.head.messages, stats.middleRaw.messages, stats.tail.messages], c.regions,
          'premise: the messages render in the head window, the middle and the recent window as named');
        const changed = firstChange(one, two);
        assert.equal(changed === one.length ? null : changed, c.changed, 'premise: the first message whose bytes change');
        const solve = solved(strategy);
        assert.ok(solve?.feasible && solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
        assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

type TieCase = { config: Record<string, unknown>; first: Msg[]; premise: (wire: Wire[]) => boolean; what: string };
const has = (wire: Wire[], test: (block: ContentBlock) => boolean): boolean => wire.some((m) => m.content.some(test));
const textOf = (block: ContentBlock): string => {
  const b = block as { type: string; text?: string; content?: unknown };
  return b.type === 'text' ? b.text ?? '' : b.type === 'tool_result' && typeof b.content === 'string' ? b.content : '';
};

const TIES: Record<string, TieCase> = {
  'an image stripped before the request was accepted': {
    config: { headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1 },
    first: [['u', [image(), text('A ' + plain(0))]], ['a', [text(plain(1))]], ['u', [image(), text('B ' + plain(2))]], ...CLOSE],
    premise: (w) => has(w, (b) => textOf(b).includes('image not shown')),
    what: 'a stripped image',
  },
  'a tool result last-N replaced before the request was accepted': {
    config: { headWindowTokens: 0, recentWindowTokens: 300, toolResultMaxLastN: 1 },
    first: [...MIDDLE.slice(0, 1), ['a', [call('call-1', 'one')]], ['u', [result('call-1', plain(2))]], ['a', [call('call-2', 'two')]], ['u', [result('call-2', plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    premise: (w) => has(w, (b) => textOf(b).includes("left out: this context shows only the tool's last result")),
    what: 'a replaced tool result',
  },
  'a tool call whose result never came, stubbed by pairing repair': {
    config: { headWindowTokens: 0, recentWindowTokens: 300 },
    first: [...MIDDLE.slice(0, 1), ['a', [call('call-1', 'lost')]], ['u', [text(plain(2))]], ['a', [text(plain(3))]], ...CLOSE],
    premise: (w) => has(w, (b) => textOf(b).includes("this call's result isn't shown in this context")),
    what: 'a pairing stub',
  },
  'a message the cap cuts': {
    config: { headWindowTokens: 0, recentWindowTokens: 300, maxMessageTokens: 500 },
    first: [...MIDDLE, ...CLOSE],
    premise: (w) => has(w, (b) => textOf(b).includes('[truncated')),
    what: 'a cut message',
  },
  "a body's raw shards in the middle, the first holding an image the composite leaves out": {
    config: { headWindowTokens: 0, recentWindowTokens: 300 },
    first: [['u', [text('intro')]], ['a', [text('hi')]], ['u', [image(), text(PROSE.slice(0, 80_000))]], ['a', [text(plain(1))]], ...CLOSE],
    premise: (w) => w.some((m) => m.content.length === 1 && textOf(m.content[0]!).length >= 70_000) &&
      !has(w, (b) => (b as { type: string }).type === 'image'),
    what: 'a middle composite of text alone',
  },
  "a body's raw shards in the recent window, which the merge joins": {
    config: { headWindowTokens: 0, recentWindowTokens: 1_000_000 },
    first: [['u', [text('intro')]], ['a', [text('hi')]], ['u', [text(PROSE.slice(0, 80_000))]], ['a', [text(plain(1))]], ...CLOSE],
    premise: (w) => w.some((m) => m.content.some((b) => textOf(b).length >= 70_000)),
    what: 'a merged body',
  },
  "a tool call whose input toolUseInputMaxTokens cuts": {
    config: { headWindowTokens: 0, recentWindowTokens: 300, toolUseInputMaxTokens: 50 },
    first: [...MIDDLE.slice(0, 1), ['a', [call('call-1', 'x'.repeat(4_000))]], ['u', [result('call-1', plain(2))]], ['a', [text(plain(3))]], ...CLOSE],
    premise: (w) => has(w, (b) => (b as { type: string; input?: { _truncated?: boolean } }).type === 'tool_use' &&
      (b as { input?: { _truncated?: boolean } }).input?._truncated === true),
    what: 'a cut tool input',
  },
  "the head window ending in a body's shards, which the merge joins": {
    // 28,000 tokens hold the two short messages and the body's seven shards,
    // and not the message after it.
    config: { headWindowTokens: 28_000, recentWindowTokens: 300 },
    first: [['u', [text('intro')]], ['a', [text('hi')]], ['u', [text(PROSE.slice(0, 80_000))]], ['a', [text(plain(1))]], ...CLOSE],
    premise: (w) => w[2]?.cacheBreakpoint === true && textOf(w[2].content[0]!).length >= 70_000,
    what: "a marker on the merged body that ends the head",
  },
  'the head window, with an image and a tool call and result': {
    config: { headWindowTokens: 6_000, recentWindowTokens: 300, maxLiveImages: 1 },
    first: [['u', [image(), text('A')]], ['a', [call('call-1', 'head')]], ['u', [result('call-1', plain(2))]], ['a', [text(plain(3))]], ['u', [image(), text('B ' + plain(4))]], ['a', [text(plain(5))]], ...CLOSE],
    premise: (w) => has(w, (b) => textOf(b).includes('image not shown')) && has(w, (b) => (b as { type: string }).type === 'tool_result'),
    what: 'the head window',
  },
};

describe('with nothing changed in place, every marker is still credited', () => {
  for (const [name, c] of Object.entries(TIES)) {
    it(name, async () => {
      const { dir, strategy, manager } = await open(c.config);
      try {
        add(manager, c.first);
        const one = await compile(manager);
        assert.ok(c.premise(one), `premise: the accepted request holds ${c.what}`);
        accept(strategy, one);
        const ref = reference(strategy);
        assert.ok(ref && ref.markers.length > 0, 'premise: a reference with markers');
        add(manager, SMALL);
        const two = await compile(manager);
        assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
        assert.equal(solveMarkers(strategy), ref.markers.length, 'every marker survives the check');
        const solve = solved(strategy);
        assert.ok(solve?.feasible && solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
        assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout), 'every marker is credited');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('with history folded', () => {
  // A mock membrane writes the summaries. Everything renders raw at the first
  // compile, so the history forms chunks to summarize; at a smaller budget the
  // solve folds the oldest chunks into recall pairs.
  const membrane = {
    complete: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'summary ' + 'word '.repeat(20) }],
      usage: { inputTokens: 100, outputTokens: 30 },
    }),
  };
  const turn = (k: number): Msg => [k % 2 ? 'a' : 'u', [text(`turn ${k} ` + 'word '.repeat(60))]];
  const FOLDED = { headWindowTokens: 0, recentWindowTokens: 600, targetChunkTokens: 60 };
  const BODY = 'lorem ipsum dolor sit amet consectetur '.repeat(400);
  /** Forty turns (and a body after the sixth when asked), compiled raw, then
   *  summarized. */
  async function folded(config: Record<string, unknown>, body: boolean, dir?: string) {
    const opened = await open({ ...FOLDED, ...config }, dir, membrane);
    if (dir === undefined) {
      for (let k = 0; k < 40; k++) {
        if (body && k === 6) opened.manager.addMessage('u', [text(BODY)]);
        add(opened.manager, [turn(k)]);
      }
      await compile(opened.manager);
      for (let i = 0; i < 16; i++) await opened.manager.tick();
    }
    return opened;
  }
  const at = (maxTokens: number) => ({ maxTokens, reserveForResponse: 0 });
  const unitOf = (ref: Cache, m: { unitIndex: number }) => ref.layout.units[m.unitIndex - 1];

  type FoldCase = { budget: number; pin?: number; body?: boolean; premise: (ref: Cache, manager: Manager) => string | null };
  const FOLDS: Record<string, FoldCase> = {
    'a marker on a recall answer is still credited when nothing changed in place': {
      // The first third's marker lands on a recall answer.
      budget: 2_000,
      premise: (ref) => (ref.markers.some((m) => unitOf(ref, m)?.kind === 'recall') ? null : 'a marker sits on a recall unit'),
    },
    'a marker on a recall answer after a raw unit, with a message pinned raw, is still credited': {
      // Pinning the third message raw puts a raw unit between the recall units.
      budget: 2_000,
      pin: 2,
      premise: (ref) => (ref.markers.some((m) => unitOf(ref, m)?.kind === 'recall' &&
        ref.layout.units.slice(0, m.unitIndex - 1).some((unit) => unit.kind === 'raw'))
        ? null : 'a marker sits on a recall unit after a raw unit'),
    },
    "a body whose first shards are folded and the rest raw is still credited": {
      budget: 6_200,
      body: true,
      premise: (ref, manager) => {
        const shards = new Set((manager as unknown as { messageStore: { getAll(): Array<{ id: string; bodyGroupId?: string }> } })
          .messageStore.getAll().filter((m) => m.bodyGroupId).map((m) => m.id));
        const raw = ref.layout.units.filter((unit) => unit.kind === 'raw' && shards.has(unit.key)).length;
        return raw > 0 && raw < shards.size && ref.layout.units.some((unit) => unit.kind === 'recall')
          ? null : 'some of the body\'s shards are raw units and the rest folded';
      },
    },
  };
  for (const [name, c] of Object.entries(FOLDS)) {
    it(name, async () => {
      const { dir, strategy, manager } = await folded({}, c.body === true);
      try {
        if (c.pin !== undefined) manager.pinRange(ids(manager)[c.pin]!, ids(manager)[c.pin]!);
        const one = (await manager.compile(at(c.budget), undefined, HASH)).messages as Wire[];
        accept(strategy, one);
        const ref = reference(strategy)!;
        const missing = c.premise(ref, manager);
        assert.equal(missing, null, `premise: ${missing}`);
        add(manager, [turn(40), turn(41)]);
        const two = (await manager.compile(at(c.budget), undefined, HASH)).messages as Wire[];
        assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
        assert.equal(solveMarkers(strategy), ref.markers.length, 'every marker survives the check');
        const solve = solved(strategy)!;
        assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
        assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('a recall answer under another summary participant is not credited', async () => {
    const first = await folded({}, false);
    let { strategy, manager } = first;
    try {
      const one = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.equal(ref.layout.units[0]?.kind, 'recall', 'premise: the request opens with a recall pair');
      await manager.close();
      ({ strategy, manager } = await folded({ summaryParticipant: 'Assistant' }, false, first.dir));
      add(manager, [turn(40), turn(41)]);
      const two = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      assert.equal(firstChange(one, two), 1, 'premise: the first recall answer changed, and its question did not');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
      assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  it('a marker past an L2 recall answer is still credited when nothing changed in place', async () => {
    // A tight budget folds the oldest turns to their L2, whose messages the
    // rebuild reaches through its L1 sources.
    let found = false;
    for (const budget of [1_700, 1_650, 1_750, 1_800, 1_600]) {
      const { dir, strategy, manager } = await folded({}, false);
      try {
        const one = (await manager.compile(at(budget), undefined, HASH)).messages as Wire[];
        accept(strategy, one);
        const ref = reference(strategy)!;
        const level = (key: string) => (strategy as unknown as { summaries: Array<{ id: string; level: number }> })
          .summaries.find((x) => x.id === key)?.level ?? 0;
        const deep = ref.layout.units.findIndex((unit) => unit.kind === 'recall' && level(unit.key) >= 2);
        if (deep < 0 || !ref.markers.some((m) => m.unitIndex > deep + 1)) continue;
        add(manager, [turn(40), turn(41)]);
        let two: Wire[];
        try {
          two = (await manager.compile(at(budget), undefined, HASH)).messages as Wire[];
        } catch (error) {
          // Two more turns may not fit this budget; anything else fails the test.
          if ((error as Error).name !== 'OverBudgetError') throw error;
          continue;
        }
        found = true;
        assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
        assert.equal(solveMarkers(strategy), ref.markers.length, 'every marker survives the check');
        const solve = solved(strategy)!;
        assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
        assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
      if (found) break;
    }
    assert.ok(found, 'premise: at some budget, a marker past an L2 recall unit, and room for two more turns');
  });

  it('with every raw unit after the last recall unit removed, and a new turn after, still credits the marker on that recall unit', async () => {
    // Whether a message renders folded is decided by which summaries cover
    // it, so a rewind of the messages after the folded history leaves it folded.
    let found: { budget: number; j: number } | null = null;
    for (const budget of [2_000, 2_400, 3_000, 1_800, 3_600]) {
      const { dir, strategy, manager } = await folded({}, false);
      try {
        const one = (await manager.compile(at(budget), undefined, HASH)).messages as Wire[];
        accept(strategy, one);
        const ref = reference(strategy)!;
        const j = ref.layout.units.map((unit) => unit.kind).lastIndexOf('recall');
        if (j < 0 || !ref.markers.some((m) => m.unitIndex === j + 1)) continue;
        found = { budget, j };
        const after = ref.layout.units.slice(j + 1);
        assert.ok(after.length > 0 && after.every((unit) => unit.kind === 'raw'), 'premise: raw units after it');
        assert.ok(ref.markers.some((m) => m.unitIndex > j + 1), 'premise: a marker past it too, which the check must drop');
        manager.removeMessages(after[0]!.key, after.at(-1)!.key);
        add(manager, [['u', [text('again ' + 'word '.repeat(700))]]]);
        const hooks = strategy as unknown as { kvUnifiedKeepEntries(...args: unknown[]): unknown };
        const keep = hooks.kvUnifiedKeepEntries.bind(strategy);
        let rebuilt = 0;
        hooks.kvUnifiedKeepEntries = (...args) => { rebuilt++; return keep(...args); };
        await manager.compile(at(budget), undefined, HASH);
        assert.ok(rebuilt > 0, 'premise: the check rebuilt');
        const kept = internals(strategy).kvUnifiedSolveCache?.markers.map((m) => (m as { unitIndex: number }).unitIndex);
        assert.deepEqual(kept, ref.markers.filter((m) => m.unitIndex <= j + 1).map((m) => m.unitIndex),
          'the markers through the recall unit are credited, and none past it');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
      break;
    }
    assert.ok(found, 'premise: at some budget, a marker sits on the last recall unit');
  });

  it('with the messages of the first of several recall units removed, credits no marker past it', async () => {
    // The emission renders no pair for a summary none of whose messages remain,
    // so the rebuild mustn't either, though later pairs share its place.
    const { dir, strategy, manager } = await folded({}, false);
    try {
      const one = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.deepEqual(ref.layout.units.slice(0, 2).map((unit) => unit.kind), ['recall', 'recall'], 'premise: two recall units open the layout');
      assert.ok(ref.markers.length > 0 && ref.markers.every((m) => m.unitIndex > 1), 'premise: every marker past the first');
      const first = (strategy as unknown as { summaries: Array<{ id: string; sourceIds: string[]; level: number }> })
        .summaries.find((x) => x.id === ref.layout.units[0]!.key)!;
      assert.equal(first.level, 1, 'premise: an L1, whose sources are messages');
      for (const id of first.sourceIds) manager.removeMessage(id);
      add(manager, [turn(40), turn(41)]);
      await manager.compile(at(2_000), undefined, HASH);
      assert.equal(solveMarkers(strategy), 0, 'no marker past the removed pair is credited');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with one message of a recall unit removed, still credits every marker past it', async () => {
    // The unit renders through its other messages, with its pair unchanged.
    const { dir, strategy, manager } = await folded({}, false);
    try {
      const one = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.equal(ref.layout.units[0]?.kind, 'recall', 'premise: a recall unit opens the layout');
      assert.ok(ref.markers.length > 0 && ref.markers.every((m) => m.unitIndex > 1), 'premise: every marker past it');
      const first = (strategy as unknown as { summaries: Array<{ id: string; sourceIds: string[] }> })
        .summaries.find((x) => x.id === ref.layout.units[0]!.key)!;
      assert.ok(first.sourceIds.length > 1, 'premise: it covers more than one message');
      manager.removeMessage(first.sourceIds[1]!);
      add(manager, [turn(40), turn(41)]);
      const two = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
      assert.equal(solveMarkers(strategy), ref.markers.length, 'every marker survives the check');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
      assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with the reference naming a summary that no longer exists, credits the markers before it and none from it on", async () => {
    // The forest check refuses a store whose chunks point at a missing
    // summary, so the reference is what names one here, as it would after
    // the summary it accepted has gone from the store.
    const { dir, strategy, manager } = await folded({}, false);
    try {
      // Pinning the third message raw puts a raw unit, and a marker, between recall units.
      manager.pinRange(ids(manager)[2]!, ids(manager)[2]!);
      const one = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      const ref = reference(strategy)!;
      const j = ref.layout.units.findIndex((unit, i) => unit.kind === 'recall' &&
        ref.markers.some((m) => m.unitIndex <= i) && ref.markers.some((m) => m.unitIndex > i));
      assert.ok(j > 0, 'premise: a recall unit between two markers');
      (ref.layout.units[j] as { key: string }).key = 'L1-gone';
      add(manager, [turn(40), turn(41)]);
      const two = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      assert.ok(two.length > 0, 'the compile goes on');
      const kept = internals(strategy).kvUnifiedSolveCache?.markers.map((m) => (m as { unitIndex: number }).unitIndex);
      assert.deepEqual(kept, ref.markers.filter((m) => m.unitIndex <= j).map((m) => m.unitIndex),
        'the markers before it are credited, and none from it on');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a recall pair the check can't render drops the markers from it on, says so once, and doesn't refuse the compile", async () => {
    const { dir, strategy, manager } = await folded({}, false);
    try {
      // Pinning the third message raw puts a raw unit, and a marker, between recall units.
      manager.pinRange(ids(manager)[2]!, ids(manager)[2]!);
      const one = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      const ref = reference(strategy)!;
      // A recall unit with a marker before it and one after it.
      const j = ref.layout.units.findIndex((unit, i) => unit.kind === 'recall' &&
        ref.markers.some((m) => m.unitIndex <= i) && ref.markers.some((m) => m.unitIndex > i));
      assert.ok(j > 0, `premise: a recall unit between two markers (${ref.layout.units.map((u) => u.kind[0] + u.kind[1]).join(' ')}; markers ${ref.markers.map((m) => m.unitIndex)})`);
      const target = ref.layout.units[j]!.key;
      // The emission renders its pairs as before; only the check's rebuild fails on that one.
      const s = strategy as unknown as {
        kvUnifiedKeepEntries(...args: unknown[]): unknown;
        recallPairEntries(summary: { id: string }, ...args: unknown[]): unknown;
      };
      const keep = s.kvUnifiedKeepEntries.bind(strategy);
      const pair = s.recallPairEntries.bind(strategy);
      let rebuilding = false;
      s.kvUnifiedKeepEntries = (...args) => { rebuilding = true; try { return keep(...args); } finally { rebuilding = false; } };
      s.recallPairEntries = (summary, ...args) => {
        if (rebuilding && summary.id === target) throw new Error('unrenderable');
        return pair(summary, ...args);
      };
      add(manager, [turn(40), turn(41)]);
      const two = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      assert.ok(two.length > 0, 'the compile goes on');
      assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
      const kept = internals(strategy).kvUnifiedSolveCache?.markers.map((m) => (m as { unitIndex: number }).unitIndex);
      assert.deepEqual(kept, ref.markers.filter((m) => m.unitIndex <= j).map((m) => m.unitIndex),
        'the markers before the pair are credited, and none from it on');
      add(manager, [turn(42), turn(43)]);
      await manager.compile(at(2_000), undefined, HASH);
      assert.equal(taken("couldn't render recall").length, 1, 'said once over two compiles');
      // The rebuild without the pair isn't what was sent, which the self-check sees too.
      assert.equal(taken(SELF_CHECK).length, 1, 'and the self-check says so, once');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a recall pair rendered under another summary label is not credited', async () => {
    const first = await folded({}, false);
    let { strategy, manager } = first;
    try {
      const one = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.equal(ref.layout.units[0]?.kind, 'recall', 'premise: the request opens with a recall pair');
      await manager.close();
      ({ strategy, manager } = await folded({ summaryContextLabel: 'And before that?' }, false, first.dir));
      add(manager, [turn(40), turn(41)]);
      const two = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
      assert.equal(firstChange(one, two), 0, 'premise: the first recall question changed');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
      assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  it('reuses the hashes of what an append leaves unchanged', async () => {
    const { dir, strategy, manager } = await open({ headWindowTokens: 0, recentWindowTokens: 1_000_000 });
    try {
      add(manager, [...MIDDLE, ...CLOSE]);
      accept(strategy, await compile(manager));
      const s = strategy as unknown as { kvUnifiedHash(object: object, compute: () => string): string };
      const original = s.kvUnifiedHash.bind(strategy);
      let computed = 0;
      s.kvUnifiedHash = (object, compute) => original(object, () => { computed++; return compute(); });
      add(manager, SMALL);
      await compile(manager);
      // Each new message's content array and its one block, perhaps once in
      // the check and once in the record; the seven unchanged messages none.
      assert.ok(computed > 0 && computed <= 4 * SMALL.length, `only what the append brought is hashed (${computed})`);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the memo to what the last two compiles fingerprinted', async () => {
    const { dir, strategy, manager } = await folded({}, false);
    try {
      const store = (manager as unknown as { messageStore: { getAll(): Array<{ id: string; content: ContentBlock[] }> } }).messageStore;
      const oldest = store.getAll()[0]!.content;
      const memo = () => (strategy as unknown as { kvUnifiedHashes: { current: Map<object, string>; previous: Map<object, string> } }).kvUnifiedHashes;
      const one = (await manager.compile(BIG, undefined, HASH)).messages as Wire[];
      accept(strategy, one);
      assert.ok(memo().current.has(oldest), 'premise: a raw compile fingerprints the oldest message');
      // The first folded compile's check still rebuilds the raw reference, so
      // the oldest message is fingerprinted there; two compiles later it's gone.
      for (let k = 0; k < 3; k++) {
        const wire = (await manager.compile(at(2_000), undefined, HASH)).messages as Wire[];
        accept(strategy, wire);
      }
      assert.ok(reference(strategy)!.layout.units[0]?.kind === 'recall', 'premise: the oldest message is folded now');
      assert.ok(!memo().current.has(oldest) && !memo().previous.has(oldest), 'what no longer renders leaves the memo');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the head window', () => {
  it('starting past the first message, after a reset, keeps every marker when nothing changed', async () => {
    const { dir, strategy, manager } = await open({ headWindowTokens: 1_700, recentWindowTokens: 300 });
    try {
      add(manager, MIDDLE);
      await manager.resetHeadWindow('a new topic');
      add(manager, [['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE]);
      const one = await compile(manager);
      assert.ok((internals(strategy) as unknown as { getHeadWindowStartIndex(s: unknown): number })
        .getHeadWindowStartIndex((manager as unknown as { messageStore: unknown }).messageStore) > 0, 'premise: the head starts past the first message');
      accept(strategy, one);
      const ref = reference(strategy)!;
      add(manager, SMALL);
      const two = await compile(manager);
      assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
      assert.equal(solveMarkers(strategy), ref.markers.length, 'every marker survives the check');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
      assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shrunk so its old last message is in the recent window does not credit the old head marker', async () => {
    // The head holds two messages and the recent window everything after it.
    // A smaller headWindowTokens then puts the second in the recent window:
    // the reference's head unit no longer ends where its marker sat.
    const first = await open({ headWindowTokens: 4_500, recentWindowTokens: 1_000_000 });
    let { strategy, manager } = first;
    try {
      add(manager, [['u', [text('A ' + plain(0))]], ['a', [text(plain(1))]], ['u', [text(plain(2))]], ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.equal(manager.getRenderStats()!.head.messages, 2, 'premise: the head holds two messages');
      assert.equal(ref.markers[0]?.unitIndex, 1, 'premise: the first marker ends the head');
      await manager.close();
      ({ strategy, manager } = await open({ headWindowTokens: 2_500, recentWindowTokens: 1_000_000 }, first.dir));
      add(manager, SMALL);
      const two = await compile(manager);
      assert.equal(manager.getRenderStats()!.head.messages, 1, 'premise: the head holds one message now');
      assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
      // The solve is handed every marker but the head's.
      const kept = internals(strategy).kvUnifiedSolveCache?.markers.map((m) => (m as { unitIndex: number }).unitIndex);
      assert.deepEqual(kept, ref.markers.slice(1).map((m) => m.unitIndex), "every marker but the head's survives the check");
    } finally {
      await manager.close();
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  it('reset after the request was accepted is not credited past where the request changed', async () => {
    const { dir, strategy, manager } = await open({ headWindowTokens: 1_700, recentWindowTokens: 300 });
    try {
      add(manager, [...MIDDLE, ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      await manager.resetHeadWindow('a new topic');
      add(manager, SMALL);
      const two = await compile(manager);
      assert.equal(firstChange(one, two), 0, 'premise: the reset changed what is sent from its first message');
      assert.ok(ref.markers.length > 0, 'premise: the accepted request kept markers');
      // The layout's units change with the head, so the wire's prefix maps to
      // no unit boundary of it: nothing is credited.
      assert.equal(solveMarkers(strategy), 0, 'no marker is credited');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant && solve.selected.cacheChurn > 0, 'the solve prices the rewrite');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('grown over an edited message does not credit the old head marker for the larger head', async () => {
    // The head holds the first two messages. A larger headWindowTokens then
    // puts the next two in the head too, and the third is edited: the
    // provider serves only the first two messages' prefix, which no longer
    // ends a unit.
    const first = await open({ headWindowTokens: 4_500, recentWindowTokens: 300 });
    let { strategy, manager } = first;
    try {
      add(manager, [['u', [text('A ' + plain(0))]], ...MIDDLE.slice(1), ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.equal(manager.getRenderStats()!.head.messages, 2, 'premise: the head holds two messages');
      assert.equal(ref.markers[0]?.unitIndex, 1, 'premise: the first marker ends the head');
      await manager.close();
      ({ strategy, manager } = await open({ headWindowTokens: 8_500, recentWindowTokens: 300 }, first.dir));
      manager.editMessage(ids(manager)[2]!, [text('edited ' + plain(2))]);
      add(manager, SMALL);
      const two = await compile(manager);
      assert.equal(manager.getRenderStats()!.head.messages, 4, 'premise: the head holds four messages now');
      assert.equal(firstChange(one, two), 2, 'premise: the third message changed');
      assert.equal(solveMarkers(strategy), 0, 'no marker is credited');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant && solve.selected.cacheChurn > 0, 'the solve prices the rewrite');
    } finally {
      await manager.close();
      rmSync(first.dir, { recursive: true, force: true });
    }
  });
});

describe('the self-check, where a compile keeps the accepted presentation', () => {
  type Hooks = {
    kvUnifiedKeepEntries(...args: unknown[]): unknown;
    applyImageStripping(...args: unknown[]): unknown;
  };
  /** Runs `during` in place of `method` while the check rebuilds, so the
   *  rebuild drifts from the emission and the emission doesn't. */
  function drift(s: AutobiographicalStrategy, change: (hooks: Hooks, rebuilding: () => boolean) => void): void {
    const hooks = s as unknown as Hooks;
    const keep = hooks.kvUnifiedKeepEntries.bind(s);
    let rebuilding = false;
    hooks.kvUnifiedKeepEntries = (...args) => { rebuilding = true; try { return keep(...args); } finally { rebuilding = false; } };
    change(hooks, () => rebuilding);
  }

  it('says once when the rebuild misses a change the emission made, which it would otherwise credit', async () => {
    const { dir, strategy, manager } = await open({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1 });
    try {
      add(manager, [['u', [image(), text('A ' + plain(0))]], ['a', [text(plain(1))]], ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      // The rebuild lacks the strip, as it would lack a pass the emission gained.
      drift(strategy, (hooks, rebuilding) => {
        const strip = hooks.applyImageStripping.bind(strategy);
        hooks.applyImageStripping = (...args) => (rebuilding() ? undefined : strip(...args));
      });
      add(manager, [['a', [text('ok2')]], ['u', [image(), text('B ' + plain(2))]]]);
      const two = await compile(manager);
      assert.equal(firstChange(one, two), 0, 'premise: the newer image stripped the first');
      assert.equal(solveMarkers(strategy), ref.markers.length, 'premise: the drifted rebuild credits every marker');
      add(manager, SMALL);
      await compile(manager);
      assert.equal(taken(SELF_CHECK).length, 1, 'said once over two compiles');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the record holding only the markers' prefixes, so the next change is still caught", async () => {
    const { dir, strategy, manager } = await open({ headWindowTokens: 0, recentWindowTokens: 1_000_000, maxLiveImages: 1 });
    try {
      add(manager, [['u', [image(), text('A ' + plain(0))]], ['a', [text(plain(1))]], ...CLOSE]);
      accept(strategy, await compile(manager));
      // This compile keeps the presentation, so its record step also compares.
      add(manager, [...SMALL, ['a', [text(plain(3))]], ['u', [text(plain(4))]]]);
      const two = await compile(manager);
      accept(strategy, two);
      const ref = reference(strategy)!;
      assert.equal((ref as unknown as { render: { prefixes: unknown[] } }).render.prefixes.length, ref.markers.length,
        'one prefix per marker');
      add(manager, [['a', [text('ok5')]], ['u', [image(), text('B ' + plain(5))]]]);
      const three = await compile(manager);
      assert.equal(firstChange(two, three), 0, 'premise: the newer image stripped the first');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
      assert.equal(solve.selected.cacheChurn, wireChurn(two, three, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with the newest messages removed after acceptance, credits the markers on what remains', async () => {
    // The middle's thirds carry markers, and the tail one sits on the newest message.
    const { dir, strategy, manager } = await open({ headWindowTokens: 0, recentWindowTokens: 300 });
    try {
      add(manager, [...MIDDLE, ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      // Removing the last two messages takes the tail marker's message with them.
      const all = ids(manager);
      manager.removeMessages(all[all.length - 2]!, all[all.length - 1]!);
      const remaining = new Set(ids(manager));
      const hooks = strategy as unknown as { kvUnifiedSelfCheck(...args: unknown[]): unknown };
      const check = hooks.kvUnifiedSelfCheck.bind(strategy);
      let compared = 0;
      hooks.kvUnifiedSelfCheck = (...args) => { compared++; return check(...args); };
      const two = await compile(manager);
      assert.equal(compared, 1, 'the self-check compares the shortened presentation');
      assert.equal(firstChange(one, two), two.length, 'premise: what remains is sent as it was');
      const units = (l: Layout) => l.units.map((unit) => `${unit.kind}:${unit.key}`);
      const now = units(solved(strategy)!.selected!.layout);
      assert.deepEqual(now, units(ref.layout).slice(0, now.length), "premise: the reference's first units, so the self-check compares");
      assert.ok(now.length < ref.layout.units.length, 'premise: fewer of them');
      // Each marker ends on the message its record prefix names.
      const through = (ref as unknown as { render: { prefixes: { through: string }[] } }).render.prefixes.map((p) => p.through);
      const expected = ref.markers.filter((_, i) => remaining.has(through[i]!));
      assert.ok(expected.length > 0 && expected.length < ref.markers.length,
        `premise: markers on both sides of the cut (${through.map((id) => (remaining.has(id) ? 'kept' : 'removed')).join(', ')})`);
      const kept = internals(strategy).kvUnifiedSolveCache?.markers.map((m) => (m as { unitIndex: number }).unitIndex);
      assert.deepEqual(kept, expected.map((m) => m.unitIndex), 'the markers on what remains are credited, and only those');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says once when the rebuild renders a message differently, here the last marker\'s, which drops that marker', async () => {
    const { dir, strategy, manager } = await open({ headWindowTokens: 0, recentWindowTokens: 300 });
    try {
      add(manager, [...MIDDLE, ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      assert.ok(ref.markers.length > 1, 'premise: several markers, so the difference is past the first');
      const last = (ref as unknown as { render: { prefixes: { through: string }[] } }).render.prefixes.at(-1)!.through;
      drift(strategy, (hooks) => {
        const keep = hooks.kvUnifiedKeepEntries;
        hooks.kvUnifiedKeepEntries = (...args) => {
          const entries = keep(...args) as Array<{ content: ContentBlock[]; sourceMessageId?: string; sourceMessageIds?: string[] }>;
          const at = entries.findIndex((e) => (e.sourceMessageId ?? e.sourceMessageIds?.at(-1)) === last);
          entries[at] = { ...entries[at]!, content: [...entries[at]!.content, text('drift')] };
          return entries;
        };
      });
      add(manager, SMALL);
      const two = await compile(manager);
      assert.equal(firstChange(one, two), one.length, 'premise: nothing the accepted request sent changes');
      assert.equal(solveMarkers(strategy), ref.markers.length - 1, 'premise: the drifted rebuild drops the last marker alone');
      add(manager, [['a', [text('ok3')]], ['u', [text('next3')]]]);
      await compile(manager);
      assert.equal(taken(SELF_CHECK).length, 1, 'said once over two compiles');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the render record across submissions and dry runs', () => {
  const c = CUTS['raw in the middle: the fifth message loses its image to a newer one']!;

  it('a compile without an immutable prefix hash takes no record, since acceptance keeps no reference', async () => {
    const { dir, strategy, manager } = await open(c.config);
    try {
      add(manager, c.first);
      await manager.compile(BIG);
      assert.ok(internals(strategy).kvUnifiedDraft, 'premise: the compile made a draft');
      assert.equal(internals(strategy).kvUnifiedDraft?.render, undefined);
      await compile(manager);
      assert.ok(internals(strategy).kvUnifiedDraft?.render, 'premise: with the hash, the draft takes one');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dry compile leaves the draft\'s record as the real compile made it', async () => {
    const { dir, strategy, manager } = await open(c.config);
    try {
      add(manager, c.first);
      await compile(manager);
      const record = internals(strategy).kvUnifiedDraft?.render;
      assert.ok(record, 'premise: the real compile made a record');
      c.change(manager);
      await compile(manager, true);
      assert.equal(internals(strategy).kvUnifiedDraft?.render, record);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acceptance keeps the record taken when its submission began, not a later compile\'s', async () => {
    const { dir, strategy, manager } = await open(c.config);
    try {
      add(manager, c.first);
      const one = await compile(manager);
      const id = begin(strategy);
      const record = internals(strategy).kvUnifiedDraft?.render;
      c.change(manager);
      await compile(manager);
      assert.notEqual(internals(strategy).kvUnifiedDraft?.render, record, 'premise: the later compile made its own record');
      settle(strategy, id, one);
      assert.equal(reference(strategy)?.render, record);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a reference loaded from the store', () => {
  const c = CUTS['everything in the recent window: the oldest message loses its image to a newer one']!;

  it('keeps its render record: an unchanged prefix keeps every marker, and a changed one is not credited', async () => {
    const first = await open(c.config);
    let { strategy, manager } = first;
    try {
      add(manager, c.first);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      await manager.close();
      ({ strategy, manager } = await open(c.config, first.dir));
      add(manager, SMALL);
      await compile(manager);
      assert.equal(solveMarkers(strategy), ref.markers.length, 'an unchanged prefix keeps every marker');
      assert.equal(solved(strategy)?.cacheRelevant, true, 'the solve weighs the cache');
      assert.equal(solved(strategy)?.selected?.cacheChurn, 0);
      await manager.close();
      ({ strategy, manager } = await open(c.config, first.dir));
      c.change(manager);
      const two = await compile(manager);
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.selected.cacheChurn > 0, 'premise: the image was stripped, so nothing is cached');
      assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  it('cut by a lower maxMessageTokens after a reopen is not credited past the first message cut', async () => {
    const config = { headWindowTokens: 0, recentWindowTokens: 300 };
    const first = await open(config);
    let { strategy, manager } = first;
    try {
      add(manager, [...MIDDLE, ['u', [text(plain(4))]], ['a', [text(plain(5))]], ...CLOSE]);
      const one = await compile(manager);
      accept(strategy, one);
      const ref = reference(strategy)!;
      await manager.close();
      ({ strategy, manager } = await open({ ...config, maxMessageTokens: 500 }, first.dir));
      add(manager, SMALL);
      const two = await compile(manager);
      assert.equal(firstChange(one, two), 0, 'premise: the cap cuts the first message');
      const solve = solved(strategy)!;
      assert.ok(solve.selected && solve.cacheRelevant, 'premise: a solve that weighs the cache');
      assert.equal(solve.selected.cacheChurn, wireChurn(one, two, ref, solve.selected.layout));
    } finally {
      await manager.close();
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  const RECORDS: Record<string, (render: { prefixes: unknown[] }) => unknown> = {
    'without a render record, as an earlier version wrote it,': () => undefined,
    'with a record that has fewer prefixes than markers': (render) => ({ prefixes: render.prefixes.slice(0, 1) }),
    'with a record of another shape': () => ({ headIds: [], markerHashes: ['x'] }),
    'with a record holding a null prefix': (render) => ({ prefixes: [null, ...render.prefixes.slice(1)] }),
    'with a record holding a null prefix after a good one': (render) => ({ prefixes: render.prefixes.map((p, i) => (i === 1 ? null : p)) }),
    "with a record whose hashes aren't strings": (render) => ({ prefixes: render.prefixes.map((p) => ({ ...(p as object), hash: 5 })) }),
  };
  const m = CUTS['raw in the middle: the fifth message loses its image to a newer one']!;
  for (const [name, persist] of Object.entries(RECORDS)) {
    it(`${name} is credited as before once`, async () => {
      const first = await open(m.config);
      let { strategy, manager } = first;
      try {
        add(manager, m.first);
        const one = await compile(manager);
        accept(strategy, one);
        const { store, kvUnifiedReceiptStateId: id } = internals(strategy);
        const persisted = store.getStateJson(id) as { cache: { render?: { prefixes: unknown[] } } };
        assert.ok(persisted.cache.render && persisted.cache.render.prefixes.length > 1, 'premise: this version persists a record of several prefixes');
        const replaced = persist(persisted.cache.render);
        if (replaced === undefined) delete persisted.cache.render;
        else persisted.cache.render = replaced as { prefixes: unknown[] };
        store.setStateJson(id, persisted);
        await manager.close();
        ({ strategy, manager } = await open(m.config, first.dir));
        m.change(manager);
        const two = await compile(manager);
        assert.equal(firstChange(one, two), 4, 'premise: the fifth message lost its image');
        assert.equal(solved(strategy)?.cacheRelevant, true, 'the reference still takes part in the solve');
        assert.equal(solved(strategy)?.selected?.cacheChurn, 0, 'every marker is credited, as before this check');
        assert.ok(wireChurn(one, two, internals(strategy).kvUnifiedReceipts.cache as unknown as Cache, solved(strategy)!.selected!.layout) > 0,
          'the wire allows less than that: the fallback over-credits this once');
        // The next acceptance writes a record, and the next change is caught.
        accept(strategy, two);
        const ref = reference(strategy)!;
        add(manager, [['a', [text(plain(8))]], ['u', [image(), text('C ' + plain(9))]], ...SMALL]);
        const three = await compile(manager);
        const solve = solved(strategy)!;
        assert.ok(firstChange(two, three) < two.length, 'premise: the second image was stripped');
        assert.equal(solve.selected!.cacheChurn, wireChurn(two, three, ref, solve.selected!.layout));
      } finally {
        await manager.close();
        rmSync(first.dir, { recursive: true, force: true });
      }
    });
  }
});
