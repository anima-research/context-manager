/**
 * #193: under kv-unified, a level pin whose level no summary supplies yet
 * used to make every compile fail ("kv-unified constraints are infeasible"),
 * until compression and merging happened to produce the level or the pin was
 * released. The forest now holds such a message at the deepest level below
 * the pinned one that a summary over it supplies, raw when none does, and
 * moves it to the pinned level once that exists, as kv-stable's clamp does;
 * the strategy logs when it starts and stops holding a pin.
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
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

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

/** console.warn lines about held level pins while `fn` runs. */
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
    assert.equal(lines[1], 'autobio: kv-unified no longer holds pin pin-0 ("recent") below its L2.');
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
      'autobio: kv-unified holds pin pin-0 ("probe"), pinned at L2, at L1 in 8 message(s): no summary supplies L2 over them yet. They move to L2 once one does.',
    ]);
    const reached = await holdLines(async () => {
      await growUntil(store, pinned, 2);
      await store.cm.compile();
    });
    assert.deepEqual(reached, ['autobio: kv-unified no longer holds pin pin-0 ("probe") below its L2.']);

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
    assert.equal(removed[1], 'autobio: pin pin-1 ("later"), held below its L3 by kv-unified, was removed.');
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
      'autobio: kv-unified holds pin pin-1 ("fine"), pinned at L2, at L1 in 8 message(s): no summary supplies L2 over them yet. They move to L2 once one does.',
    ]);
    store.cm.close();
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
