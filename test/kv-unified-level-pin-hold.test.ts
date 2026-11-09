/**
 * #193: under kv-unified, a level pin whose level no summary supplies yet
 * used to make every compile fail ("kv-unified constraints are infeasible"),
 * until compression and merging happened to produce the level or the pin was
 * released. The forest now holds such a message at the deepest level below
 * the pinned one that a summary over it supplies, raw when none does, and
 * moves it to the pinned level once that exists; the strategy logs when it
 * starts and stops holding a pin.
 *
 * Each message here is about 150 tokens, so a chunk closes at its fourth
 * message (targetChunkTokens 200, at least four messages), and the newest
 * closed chunk waits for the next (l1HoldbackChunks 1): 24 messages give six
 * chunks and five L1s, under mergeThreshold 6.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy, OverBudgetError } from '../src/index.js';
import type { AutobiographicalConfig } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'kv-unified-level-pin-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
    continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
} as never;

interface Summary { id: string; level: number; content: string; sourceRange: { first: string; last: string }; sourceIds: string[]; mergedInto?: string; parentId?: string }

let stores = 0;

async function open(path: string, overrides: Record<string, unknown> = {}) {
  let summaries = 0;
  const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `Summary ${++summaries}: ordinary events.` }], usage: { inputTokens: 500, outputTokens: 100 } }) };
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, summaryParticipant: 'Claude',
    hierarchical: true, mergeThreshold: 6, adaptiveResolution: true,
    foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED,
    ...overrides,
  });
  const cm = await ContextManager.open({ path, strategy, membrane: membrane as never });
  return { cm, strategy, calls: () => summaries };
}

/** A store with `count` messages, compressed as far as ticks take it. */
async function conversation(count: number, overrides: Record<string, unknown> = {}) {
  const path = join(dir, `store-${stores++}`);
  const opened = await open(path, overrides);
  const ids: string[] = [];
  const text = (i: number) => `MSG-${i} ${'word '.repeat(110)}`;
  const add = (n: number) => {
    for (let k = 0; k < n; k++) ids.push(opened.cm.addMessage(ids.length % 2 ? 'Claude' : 'User', [{ type: 'text', text: text(ids.length) }]));
  };
  /** Compile and tick until a round calls the summarizer no more; every compile must go through. */
  const settle = async () => {
    for (let round = 0; round < 60; round++) {
      const before = opened.calls();
      await opened.cm.compile();
      await opened.cm.tick();
      await opened.cm.tick();
      if (opened.calls() === before) return;
    }
    assert.fail('compression did not settle');
  };
  add(count);
  await settle();
  return { ...opened, path, ids, add, settle };
}

function summariesOf(strategy: AutobiographicalStrategy): Summary[] {
  return (strategy as unknown as { summaries: Summary[] }).summaries;
}

/** The level each message renders at in a compile: 0 for its raw text, or the level of the summary shown over it. */
function renderedLevels(compiled: unknown, strategy: AutobiographicalStrategy, ids: string[], positions: number[]): number[] {
  const text = JSON.stringify(compiled);
  const summaries = summariesOf(strategy);
  return positions.map((p) => {
    if (text.includes(`MSG-${p} `)) return 0;
    const shown = summaries.filter((s) =>
      text.includes(s.content) && ids.indexOf(s.sourceRange.first) <= p && p <= ids.indexOf(s.sourceRange.last));
    assert.equal(shown.length, 1, `message ${p} is shown once`);
    return shown[0].level;
  });
}

/** Whether a summary at `level` covers every message in positions. */
function supplied(strategy: AutobiographicalStrategy, ids: string[], positions: number[], level: number): boolean {
  return positions.every((p) => summariesOf(strategy).some((s) =>
    s.level === level && ids.indexOf(s.sourceRange.first) <= p && p <= ids.indexOf(s.sourceRange.last)));
}

const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, k) => first + k);

/** Add messages one at a time until `level` covers `positions`, compiling after each; returns how many it took. */
async function growUntil(store: Awaited<ReturnType<typeof conversation>>, positions: number[], level: number, limit = 60): Promise<number> {
  for (let added = 1; added <= limit; added++) {
    store.add(1);
    await store.settle();
    if (supplied(store.strategy, store.ids, positions, level)) return added;
  }
  return assert.fail(`L${level} never covered the pinned messages`);
}

/** console.warn lines about held level pins while `fn` runs, as the strategy's diagnostics write them, with its namespace. */
async function holdLines(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (/holds pin|no longer holds pin|was removed/.test(line)) lines.push(line);
  };
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return lines;
}

describe('kv-unified holds a level pin until its level exists (#193)', () => {
  it('placed over two unmerged L1s: compiles go through at L1, then the pin renders at L2', async () => {
    const store = await conversation(24);
    const pinned = range(0, 7);
    assert.ok(supplied(store.strategy, store.ids, pinned, 1) && !supplied(store.strategy, store.ids, pinned, 2), 'setup: L1s and no L2');
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 2, { name: 'probe' });
    for (let round = 0; round < 12; round++) {
      assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(8).fill(1));
      await store.cm.tick();
    }
    await growUntil(store, pinned, 2);
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(8).fill(2));
    store.cm.close();
  });

  it('inside one L1: held at that L1, then at L2', async () => {
    const store = await conversation(24);
    const pinned = range(0, 3);
    store.cm.pinAtLevel(store.ids[0], store.ids[3], 2);
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(4).fill(1));
    await growUntil(store, pinned, 2);
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(4).fill(2));
    store.cm.close();
  });

  it('two levels up: held at L1, then at L2, then at the pinned L3', async () => {
    const store = await conversation(12, { mergeThreshold: 3 });
    const pinned = range(0, 7);
    assert.ok(supplied(store.strategy, store.ids, pinned, 1) && !supplied(store.strategy, store.ids, pinned, 2), 'setup: L1s and no L2');
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 3);
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(8).fill(1));
    await growUntil(store, pinned, 2);
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(8).fill(2));
    await growUntil(store, pinned, 3);
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(8).fill(3));
    store.cm.close();
  });

  it('a stored pin compiles when the store opens again', async () => {
    const store = await conversation(24);
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 2);
    store.cm.close();
    const reopened = await open(store.path);
    assert.deepEqual(reopened.cm.listPins().map((pin) => pin.level), [2], 'setup: the pin was stored');
    assert.deepEqual(renderedLevels(await reopened.cm.compile(), reopened.strategy, store.ids, range(0, 7)), Array(8).fill(1));
    reopened.cm.close();
  });

  it('placed in the recent window, the pin is held when its range leaves it, and reaches its level', async () => {
    const store = await conversation(24, { recentWindowTokens: 1200 });
    const pinned = range(20, 23);
    assert.ok(!supplied(store.strategy, store.ids, pinned, 1), 'setup: the range is in the recent window, uncompressed');
    const lines = await holdLines(async () => {
      store.cm.pinAtLevel(store.ids[20], store.ids[23], 2, { name: 'recent' });
      await store.cm.compile();
      await growUntil(store, pinned, 2);
      await store.cm.compile();
    });
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /^autobio: kv-unified holds pin pin-0 \("recent"\), pinned at L2, at (raw|L1|raw and L1) in [1-4] message\(s\)/);
    assert.equal(lines[1], 'autobio: kv-unified no longer holds pin pin-0 ("recent") below its L2. ns=default');
    assert.deepEqual(renderedLevels(await store.cm.compile(), store.strategy, store.ids, pinned), Array(4).fill(2));
    store.cm.close();
  });

  it('logs a hold once when it starts and once when it ends, and nothing from a dry run', async () => {
    const store = await conversation(24);
    const pinned = range(0, 7);
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 2, { name: 'probe' });
    const preview = await holdLines(async () => {
      await store.cm.compile(undefined, undefined, { dryRun: true });
    });
    assert.deepEqual(preview, [], 'a dry run reports nothing');
    const held = await holdLines(async () => {
      for (let round = 0; round < 5; round++) await store.cm.compile();
    });
    assert.deepEqual(held, [
      'autobio: kv-unified holds pin pin-0 ("probe"), pinned at L2, at L1 in 8 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
    ]);
    const reached = await holdLines(async () => {
      await growUntil(store, pinned, 2);
      await store.cm.compile();
    });
    assert.deepEqual(reached, ['autobio: kv-unified no longer holds pin pin-0 ("probe") below its L2. ns=default']);

    // A pin removed while it is held.
    store.cm.pinAtLevel(store.ids[store.ids.length - 12], store.ids[store.ids.length - 9], 3, { name: 'later' });
    const removed = await holdLines(async () => {
      await store.cm.compile();
      store.cm.unpin('pin-1');
      await store.cm.compile();
      await store.cm.compile();
    });
    assert.equal(removed.length, 2, removed.join('\n'));
    assert.match(removed[0], /^autobio: kv-unified holds pin pin-1 \("later"\), pinned at L3, at /);
    assert.equal(removed[1], 'autobio: pin pin-1 ("later"), held below its L3 by kv-unified, was removed. ns=default');
    store.cm.close();
  });

  // The report runs after the solve and before the frontier is presented, so
  // a compile refused as over budget has already said which ranges it holds
  // finer than pinned, which can be why the range was too large.
  it('logs a hold before a compile is refused as over budget', async () => {
    const store = await conversation(24);
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 2, { name: 'tight' });
    const lines = await holdLines(async () => {
      await assert.rejects(store.cm.compile({ maxTokens: 600, reserveForResponse: 0 }), OverBudgetError);
    });
    assert.deepEqual(lines, [
      'autobio: kv-unified holds pin pin-0 ("tight"), pinned at L2, at L1 in 8 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
    ]);
    store.cm.close();
  });

  it('reports only the pin whose level a message takes, where pins overlap', async () => {
    const store = await conversation(24);
    // Over the same messages the lowest level wins, so the L2 pin binds and
    // the L3 pin isn't the one being held.
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 3, { name: 'coarse' });
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 2, { name: 'fine' });
    const lines = await holdLines(async () => { await store.cm.compile(); });
    assert.deepEqual(lines, [
      'autobio: kv-unified holds pin pin-1 ("fine"), pinned at L2, at L1 in 8 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
    ]);
    store.cm.close();
  });

  it('leaves a message of system changes out of the hold and its count: the strategy keeps it raw under any pin', async () => {
    const path = join(dir, `store-${stores++}`);
    const opened = await open(path);
    const change = { type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock;
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) {
      if (i === 4) ids.push(opened.cm.addMessage('Harness', [change]));
      ids.push(opened.cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `MSG-${i} ${'word '.repeat(110)}` }]));
    }
    for (let round = 0; round < 60; round++) {
      const before = opened.calls();
      await opened.cm.compile();
      await opened.cm.tick();
      await opened.cm.tick();
      if (opened.calls() === before) break;
    }
    // The first pin spans eight messages and the change between them; the
    // second covers the change alone.
    opened.cm.pinAtLevel(ids[0], ids[8], 2, { name: 'around-change' });
    opened.cm.pinAtLevel(ids[4], ids[4], 2, { name: 'change-only' });
    const lines = await holdLines(async () => { await opened.cm.compile(); });
    assert.deepEqual(lines, [
      'autobio: kv-unified holds pin pin-0 ("around-change"), pinned at L2, at L1 in 8 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
    ]);
    opened.cm.close();
  });

  it('starts over on each branch, so a pin on another branch is not reported removed', async () => {
    const store = await conversation(24);
    store.cm.pinAtLevel(store.ids[0], store.ids[7], 2, { name: 'shared' });
    const main = store.cm.currentBranch().name;
    const lines = await holdLines(async () => {
      await store.cm.compile();
      await store.cm.fork('side');
      store.cm.pinAtLevel(store.ids[8], store.ids[11], 3, { name: 'side-only' });
      await store.cm.compile();
      await store.cm.switchBranch(main);
      await store.cm.compile();
    });
    assert.deepEqual(lines.map((line) => line.replace(/, pinned at .*/, '')), [
      'autobio: kv-unified holds pin pin-0 ("shared")',
      'autobio: kv-unified holds pin pin-0 ("shared")',
      'autobio: kv-unified holds pin pin-1 ("side-only")',
      'autobio: kv-unified holds pin pin-0 ("shared")',
    ]);
    store.cm.close();
  });
});

/**
 * Under adaptive resolution a long message is stored in parts, and a pin
 * naming any part covers the whole message (`pinPositions`), for the forest
 * and for the report alike. These stores follow whole-body-pins.test.ts: six
 * history messages, a 6,000-word message that ingress stores in nine parts
 * (1,500-token chunks), then traffic; a head window of 500 tokens and a recent
 * window of 8,000.
 */
describe('the hold report reads a pin over a message stored in parts as the forest does', () => {
  const words = (label: string, n: number): ContentBlock[] =>
    [{ type: 'text', text: `${label} ${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}` }];
  const budget = { maxTokens: 60_000, reserveForResponse: 0 };
  type View = { getAll(): Array<{ id: string; bodyGroupId?: string }> };
  const allIds = (cm: ContextManager): string[] =>
    (cm as unknown as { strategyMessageView(): View }).strategyMessageView().getAll().map((m) => m.id);
  /** The ids of the parts of the message `id` is in, in store order. */
  const partsOf = (cm: ContextManager, id: string): string[] => {
    const all = (cm as unknown as { strategyMessageView(): View }).strategyMessageView().getAll();
    const group = all.find((m) => m.id === id)!.bodyGroupId;
    return all.filter((m) => m.bodyGroupId !== undefined && m.bodyGroupId === group).map((m) => m.id);
  };
  /** The levels of the summaries over the message `id`, as a set. */
  const levelsOver = (cm: ContextManager, strategy: AutobiographicalStrategy, id: string): Set<number> => {
    const all = allIds(cm);
    const at = all.indexOf(id);
    return new Set(summariesOf(strategy)
      .filter((s) => all.indexOf(s.sourceRange.first) <= at && at <= all.indexOf(s.sourceRange.last))
      .map((s) => s.level));
  };
  const ready = async (cm: ContextManager) => {
    for (let i = 0; i < 800 && !cm.isReady(); i++) await cm.tick();
    assert.ok(cm.isReady(), 'compression caught up');
  };

  async function longMessage(extra: Partial<AutobiographicalConfig> = {}) {
    const path = join(dir, `store-${stores++}`);
    let n = 0;
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(30) }], usage: { input_tokens: 100, output_tokens: 40 } }) };
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 500, recentWindowTokens: 8000, imageStripDepthTokens: 0, compressionModel: 'test-model',
      hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1500,
      foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED, ...extra,
    } as AutobiographicalConfig);
    const cm = await ContextManager.open({ path, strategy, membrane: membrane as never });
    for (let i = 0; i < 6; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
    await cm.compile(budget);
    const long = cm.addMessage('user', words('Bdoc', 6000));
    const parts = partsOf(cm, long);
    assert.equal(parts.length, 9, 'setup: the message is stored in nine parts');
    let traffic = 0;
    const add = async (n: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++, traffic++) ids.push(cm.addMessage(traffic % 2 ? 'assistant' : 'user', words(`event${traffic}`, 200)));
      await ready(cm);
      return ids;
    };
    return { cm, strategy, parts, add };
  }

  it('counts a message stored in parts once, beside a plain message the same pin covers, and each pin over its own span', async () => {
    const { cm, strategy, parts, add } = await longMessage();
    const after = await add(120);
    assert.ok(parts.every((id) => levelsOver(cm, strategy, id).has(1)), 'setup: every part is summarized at L1');
    // Named by its fourth part, the first pin covers the whole message, all
    // nine parts held at L1: two messages, not the seven positions its ids
    // name. The second, at the same level over three plain messages, counts
    // only those.
    cm.pinRange(parts[3], after[0], { level: 2 });
    cm.pinRange(after[10], after[12], { level: 2 });
    const lines = await holdLines(async () => { await cm.compile(budget); });
    assert.deepEqual(lines, [
      'autobio: kv-unified holds pin pin-0, pinned at L2, at L1 in 2 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
      'autobio: kv-unified holds pin pin-1, pinned at L2, at L1 in 3 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
    ]);
    cm.close();
  });

  it('reports a pin held over the parts outside the recent window when the part it names is still inside it', async () => {
    const { cm, parts, add } = await longMessage();
    await add(4);
    cm.pinRange(parts.at(-1)!, parts.at(-1)!, { level: 2 });
    const lines = await holdLines(async () => { await cm.compile(budget); });
    assert.deepEqual(lines, [
      'autobio: kv-unified holds pin pin-0, pinned at L2, at raw in 1 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default',
    ]);
    cm.close();
  });

  it('keeps reporting the hold while the level reaches the part the pin names before the rest', async () => {
    // With mergeThreshold 2, the first L2 covers the message's first parts
    // before its last ones.
    const { cm, strategy, parts, add } = await longMessage({ hierarchical: true, mergeThreshold: 2 });
    cm.markDocument(parts[0], { level: 2, name: 'doc' });
    const steps: Array<{ lines: string[]; first: boolean; all: boolean }> = [];
    for (let step = 0; step < 60; step++) {
      await add(1);
      const lines = await holdLines(async () => { await cm.compile(budget); });
      const first = levelsOver(cm, strategy, parts[0]).has(2);
      const all = parts.every((id) => levelsOver(cm, strategy, id).has(2));
      steps.push({ lines, first, all });
      if (all) break;
    }
    assert.ok(steps.some((s) => s.first && !s.all), 'setup: L2 reaches the named part before the rest');
    const said = steps.flatMap((s, k) => s.lines.map((line) => ({ line, k })));
    assert.equal(said.length, 2, said.map((s) => s.line).join('\n'));
    assert.equal(said[0].line, 'autobio: kv-unified holds pin pin-0 ("doc"), pinned at L2, at raw in 1 message(s): no summary supplies L2 over them yet. They move to L2 once one does. ns=default');
    assert.equal(said[1].line, 'autobio: kv-unified no longer holds pin pin-0 ("doc") below its L2. ns=default');
    assert.ok(steps[said[1].k].all, 'the hold ends when L2 covers every part');
    cm.close();
  });

  it('names every level the parts of a held message are held at', async () => {
    // Twenty messages on, with mergeThreshold 2, the message's first parts
    // have L1 and L2, the next ones L1 alone, and the last ones no summary,
    // all of them in the folded middle.
    const { cm, strategy, parts, add } = await longMessage({ hierarchical: true, mergeThreshold: 2 });
    await add(20);
    assert.deepEqual(parts.map((id) => Math.max(0, ...levelsOver(cm, strategy, id))), [2, 2, 2, 1, 1, 1, 1, 0, 0], 'setup: the deepest level over each part');
    const view = (cm as unknown as { strategyMessageView(): never }).strategyMessageView();
    const recentStart = (strategy as unknown as { getRecentWindowStart(view: never): number }).getRecentWindowStart(view);
    assert.ok(parts.every((id) => allIds(cm).indexOf(id) < recentStart), 'setup: every part is before the recent window, so the parts with no summary are held raw in the folded middle');
    cm.markDocument(parts[0], { level: 3 });
    const lines = await holdLines(async () => { await cm.compile(budget); });
    assert.deepEqual(lines, [
      'autobio: kv-unified holds pin pin-0, pinned at L3, at raw and L1 and L2 in 1 message(s): no summary supplies L3 over them yet. They move to L3 once one does. ns=default',
    ]);
    cm.close();
  });
});
