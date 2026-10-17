/**
 * Tests for AutobiographicalStrategy persistence + branch fork.
 *
 * Strategy state (summaries, summaryIdCounter, mergeQueue) was previously
 * in-memory only — first process restart wiped the entire L1/L2/L3 pyramid.
 * Forking the underlying chronicle branch silently shared state across
 * branches because nothing was actually branch-scoped.
 *
 * These tests cover:
 *  1. restart-and-resume: state survives close/reopen of the same path.
 *  2. branch fork: a forked branch has its own summary timeline.
 *  3. branch switch: switching back picks up the right branch's state.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { ChunkRecord } from '../src/strategies/autobiographical.js';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';

const TEST_STORE_PATH = './test-strategy-persistence';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/** A summary entry of any shape, for the persistence boundary. */
function rawSummary(id: string, level: number, sourceIds: unknown, sourceRange: unknown) {
  return { id, level, content: `text of ${id}`, tokens: 3, sourceLevel: level - 1, sourceIds, sourceRange, created: 1 };
}

/**
 * Test subclass that exposes the protected persistence helpers + lets the
 * test seed summaries through the same code path that production uses.
 */
class TestableStrategy extends AutobiographicalStrategy {
  seedL1(content: string, sourceIds: string[]): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L1-${this.nextSummaryIdCounter()}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds,
      sourceRange: {
        first: sourceIds[0] ?? '',
        last: sourceIds[sourceIds.length - 1] ?? '',
      },
      created: Date.now(),
    };
    this.pushSummary(entry);
    return entry;
  }

  seedL2(sourceL1Ids: string[], content = 'merged'): SummaryEntry {
    return this.seedParent(2, sourceL1Ids, content);
  }

  seedParent(level: SummaryLevel, sourceL1Ids: string[], content: string): SummaryEntry {
    const children = sourceL1Ids.map(id => this.summaries.find(summary => summary.id === id)!);
    const entry: SummaryEntry = {
      id: `L${level}-${this.nextSummaryIdCounter()}`,
      level,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: level - 1,
      sourceIds: sourceL1Ids,
      sourceRange: { first: children[0]?.sourceRange.first ?? '', last: children.at(-1)?.sourceRange.last ?? '' },
      created: Date.now(),
    };
    this.pushSummary(entry);
    for (const id of sourceL1Ids) {
      const src = this.summaries.find(s => s.id === id);
      if (src) this.setMergedInto(src, entry.id);
    }
    return entry;
  }

  seedMerge(level: SummaryLevel, sourceIds: string[]): void {
    this.enqueueMerge({ level, sourceIds });
  }

  persistRawSummaries(entries: unknown[]): void {
    this.store?.setStateJson(this.summariesStateId, entries);
  }

  persistRawMergeQueue(items: unknown[]): void {
    this.store?.setStateJson(this.mergeQueueStateId, items);
  }

  readPersistedSummaries(): SummaryEntry[] {
    return (this.store?.getStateJson(this.summariesStateId) as SummaryEntry[] | null) ?? [];
  }

  /** A summary through the persistence boundary, whatever its shape. */
  pushRaw(entry: unknown): void {
    this.pushSummary(entry as SummaryEntry);
  }

  persistRawChunks(records: ChunkRecord[]): void {
    this.store?.setStateJson(this.chunksStateId, records);
  }

  readPersistedChunks(): ChunkRecord[] {
    return (this.store?.getStateJson(this.chunksStateId) as ChunkRecord[] | null) ?? [];
  }

  readPersistedMergeQueue(): unknown[] {
    return (this.store?.getStateJson(this.mergeQueueStateId) as unknown[] | null) ?? [];
  }

  persistRawResolutions(levels: Record<string, number>, locked: string[] = []): void {
    this.store?.setStateJson(this.resolutionsStateId, levels);
    this.store?.setStateJson(this.locksStateId, locked);
  }

  persistRawCounter(value: number): void {
    this.store?.setStateJson(this.counterStateId, value);
  }

  readPersistedCounter(): unknown {
    return this.store?.getStateJson(this.counterStateId);
  }

  mintId(): number {
    return this.nextSummaryIdCounter();
  }

  reload(): void {
    this.loadPersistedState({ keepKvUnifiedPresentation: true });
  }

  /** The state ids the next load writes, in order. */
  stateWrites: string[] | null = null;

  stateIds(): { counter: string; summaries: string } {
    return { counter: this.counterStateId, summaries: this.summariesStateId };
  }

  protected override loadPersistedState(options: { keepKvUnifiedPresentation?: boolean } = {}): void {
    const store = this.store;
    if (!store || !this.stateWrites) return super.loadPersistedState(options);
    const writes = this.stateWrites;
    const own = Object.getOwnPropertyDescriptor(store, 'setStateJson');
    const write = store.setStateJson.bind(store);
    Object.defineProperty(store, 'setStateJson', {
      configurable: true,
      writable: true,
      value: (id: string, value: unknown) => {
        writes.push(id);
        return write(id, value);
      },
    });
    try {
      super.loadPersistedState(options);
    } finally {
      if (own) Object.defineProperty(store, 'setStateJson', own);
      else delete (store as { setStateJson?: unknown }).setStateJson;
    }
  }

  readPersistedResolutions(): Record<string, number> {
    return (this.store?.getStateJson(this.resolutionsStateId) as Record<string, number> | null) ?? {};
  }

  exactL1(ids: string[]): SummaryEntry | undefined {
    return (this as unknown as { findExactL1(key: string): SummaryEntry | undefined }).findExactL1(ids.join(':'));
  }

  reloadPersisted(): void { this.loadPersistedState(); }

  // Read-only views for assertions
  getSummariesView(): SummaryEntry[] { return [...this.summaries]; }
  getCounter(): number { return this.summaryIdCounter; }
  getMergeQueueView(): Array<{ level: SummaryLevel; sourceIds: string[] }> {
    return [...this.mergeQueue];
  }
}

describe('AutobiographicalStrategy — persistence', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('restores summaries, counter, and merge queue across close/reopen', async () => {
    // Phase 1: build state
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const m1 = manager.addMessage('User', textBlock('hello'));
      const m2 = manager.addMessage('Claude', textBlock('hi back'));

      strategy.seedL1('summary one', [m1]);
      strategy.seedL1('summary two', [m2]);
      strategy.seedMerge(2, ['L1-0', 'L1-1']);

      assert.equal(strategy.getSummariesView().length, 2);
      assert.equal(strategy.getCounter(), 2);
      assert.equal(strategy.getMergeQueueView().length, 1);

      manager.sync();
      manager.close();
    }

    // Phase 2: reopen, verify reload
    {
      const strategy2 = new TestableStrategy({ targetChunkTokens: 300 });
      const manager2 = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: strategy2,
      });

      const summaries = strategy2.getSummariesView();
      assert.equal(summaries.length, 2, 'summaries should reload from chronicle');
      assert.equal(summaries[0].content, 'summary one');
      assert.equal(summaries[1].content, 'summary two');
      assert.equal(strategy2.getCounter(), 2, 'counter should reload');

      const queue = strategy2.getMergeQueueView();
      assert.equal(queue.length, 1, 'merge queue should reload');
      assert.equal(queue[0].level, 2);
      assert.deepEqual(queue[0].sourceIds, ['L1-0', 'L1-1']);

      manager2.close();
    }
  });

  it('persists mergedInto edits so merged sources stay merged after restart', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const a = strategy.seedL1('a', ['m1']);
      const b = strategy.seedL1('b', ['m2']);
      const merged = strategy.seedL2([a.id, b.id], 'merged a+b');

      const summaries = strategy.getSummariesView();
      assert.ok(summaries[0].mergedInto === merged.id);
      assert.ok(summaries[1].mergedInto === merged.id);

      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const summaries = strategy.getSummariesView();
      assert.equal(summaries.length, 3);
      assert.equal(summaries[0].mergedInto, 'L2-2', 'L1 mergedInto must persist');
      assert.equal(summaries[1].mergedInto, 'L2-2');
      assert.equal(summaries[2].mergedInto, undefined);

      manager.close();
    }
  });

  it('rejects empty summaries at the persistence boundary', async () => {
    const strategy = new TestableStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    assert.throws(
      () => strategy.seedL1('   ', ['m1']),
      /refusing to persist empty summary L1-0 at L1/,
    );
    assert.equal(strategy.getSummariesView().length, 0);

    manager.close();
  });

  it('refuses a summary whose sources, or above L1 whose range, readers cannot use, at the persistence boundary', async () => {
    const strategy = new TestableStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      // #130's shape: an L1 whose sources are null.
      assert.throws(
        () => strategy.pushRaw(rawSummary('L1-0', 1, null, { first: 'm1', last: 'm2' })),
        /refusing to persist summary L1-0 at L1, a bug in the code that built it: its sourceIds is null, where readers need a non-empty list of ids/,
      );
      assert.throws(() => strategy.pushRaw(rawSummary('L1-5', 1, [], { first: 'm1', last: 'm2' })), /L1-5 at L1.*its sourceIds is \[\],/);
      assert.throws(() => strategy.pushRaw(rawSummary('L1-7', 1, 'm1', { first: 'm1', last: 'm1' })), /L1-7 at L1.*its sourceIds is "m1",/);
      assert.throws(() => strategy.pushRaw(rawSummary('L2-6', 2, ['L1-a', null], { first: 'm1', last: 'm2' })), /L2-6 at L2.*its sourceIds is \["L1-a",null\],/);
      assert.throws(() => strategy.pushRaw(rawSummary('L2-8', 2, ['L1-a', ''], { first: 'm1', last: 'm2' })), /L2-8 at L2.*its sourceIds is \["L1-a",""\],/);
      // A sparse list, whose empty slot `every` would skip and the store can't write.
      const sparse = new Array<string>(2);
      sparse[1] = 'm1';
      assert.throws(() => strategy.pushRaw(rawSummary('L1-11', 1, sparse, { first: 'm1', last: 'm1' })), /L1-11 at L1.*its sourceIds is \[null,"m1"\],/);
      assert.throws(
        () => strategy.pushRaw(rawSummary('L2-1', 2, ['L1-a', 'L1-b'], { first: 'm1' })),
        /refusing to persist summary L2-1 at L2, a bug in the code that built it: its sourceRange is \{"first":"m1"\}, where readers need two message ids/,
      );
      assert.throws(() => strategy.pushRaw(rawSummary('L2-9', 2, ['L1-a'], { last: 'm2' })), /L2-9 at L2.*its sourceRange is \{"last":"m2"\},/);
      assert.throws(() => strategy.pushRaw(rawSummary('L2-10', 2, ['L1-a'], null)), /L2-10 at L2.*its sourceRange is null,/);
      assert.deepEqual(strategy.getSummariesView(), [], 'none of them is held');
      assert.deepEqual(strategy.readPersistedSummaries(), [], 'or stored');
      // A summary readers can use is taken, with the range it holds above L1.
      strategy.pushRaw(rawSummary('L1-3', 1, ['m1', 'm2'], { first: 'm1', last: 'm2' }));
      strategy.pushRaw(rawSummary('L2-4', 2, ['L1-3'], { first: 'm1', last: 'm2' }));
      assert.deepEqual(strategy.readPersistedSummaries().map((s) => [s.id, s.sourceRange]), [
        ['L1-3', { first: 'm1', last: 'm2' }],
        ['L2-4', { first: 'm1', last: 'm2' }],
      ]);
    } finally {
      manager.close();
    }
  });

  it('stores an L1 with its range set to its sources\' ends, as the open would make it, and warns', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    const ranges = {
      'L1-0': { first: 'm1', last: 'm3' },
      'L1-1': { first: 'm4', last: 'm4' },
      'L1-2': { first: 'm5', last: 'm6' },
      'L1-3': { first: 'm7', last: 'm8' },
    };
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        strategy.pushRaw(rawSummary('L1-0', 1, ['m1', 'm2', 'm3'], { first: 'm1', last: 'm2' }));
        strategy.pushRaw(rawSummary('L1-1', 1, ['m4'], null));
        strategy.pushRaw(rawSummary('L1-2', 1, ['m5', 'm6'], { first: 'm5', last: 'm6' }));
        strategy.pushRaw(rawSummary('L1-3', 1, ['m7', 'm8'], { first: 'm6', last: 'm8' }));
        const rangesOf = (summaries: SummaryEntry[]) => Object.fromEntries(summaries.map((s) => [s.id, s.sourceRange]));
        assert.deepEqual(rangesOf(strategy.getSummariesView()), ranges, 'held with its sources\' ends');
        assert.deepEqual(rangesOf(strategy.readPersistedSummaries()), ranges, 'and stored so');
        assert.deepEqual(warnings.filter((w) => w.includes('storing summary')), [
          '[autobiographical] storing summary L1-0 at L1 with its sourceRange set to its first and last source, a bug in the code that built it: it held {"first":"m1","last":"m2"}',
          '[autobiographical] storing summary L1-1 at L1 with its sourceRange set to its first and last source, a bug in the code that built it: it held null',
          '[autobiographical] storing summary L1-3 at L1 with its sourceRange set to its first and last source, a bug in the code that built it: it held {"first":"m6","last":"m8"}',
        ]);
        manager.sync();
      } finally {
        manager.close();
      }
    }
    warnings.length = 0;
    const strategy = new TestableStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      assert.equal(warnings.find((w) => w.includes('repaired summary state')), undefined, 'an open has nothing to rebuild: ' + warnings.join('\n'));
    } finally {
      manager.close();
    }
  });

  it('takes what the package\'s own writers push, the L1 stub, an L1 compression and a merge, as they built it', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    const membrane = {
      complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'memory body' }], usage: { inputTokens: 10, outputTokens: 5 } }),
    };
    const strategy = new TestableStrategy({
      targetChunkTokens: 20, recentWindowTokens: 0, compressionModel: 'test-model', autoTickOnNewMessage: false, mergeThreshold: 2,
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
    try {
      // A thin chunk, stubbed without a model call, then chunks the model
      // compresses; the newest closed chunk is held back.
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock('word '.repeat(8)));
      for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock(`MSG${i} ` + 'word '.repeat(60)));
      for (let i = 0; i < 100 && !manager.isReady(); i++) await manager.tick();
      assert.ok(manager.isReady(), 'the queues drained');
      const summaries = strategy.getSummariesView();
      assert.ok(summaries.some((s) => s.level === 1 && s.content.startsWith('(A quiet stretch')), 'the stub');
      assert.ok(summaries.some((s) => s.level === 1 && s.content === 'memory body'), 'an L1 compression');
      assert.ok(summaries.some((s) => s.level === 2 && s.content === 'memory body'), 'a merge');
      assert.deepEqual(warnings.filter((w) => w.includes('storing summary')), [], 'no write repaired a range');
    } finally {
      manager.close();
    }
  });

  it('removes empty legacy parents and clears their child pointers on load', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const a = strategy.seedL1('summary a', ['m1']);
      const b = strategy.seedL1('summary b', ['m2']);
      const parent = strategy.seedL2([a.id, b.id], 'valid before legacy corruption');
      const corrupted = strategy.getSummariesView().map((summary) =>
        summary.id === parent.id ? { ...summary, content: '', tokens: 0 } : summary,
      );
      strategy.persistRawSummaries(corrupted);
      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const summaries = strategy.getSummariesView();
      assert.equal(summaries.length, 2, 'empty parent should be removed');
      assert.ok(summaries.every(summary => summary.content.trim().length > 0));
      assert.ok(summaries.every(summary => summary.mergedInto === undefined));

      manager.close();
    }
  });

  it('drops summaries whose sourceIds are not a list of ids on load, and repairs what pointed at them', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const a = strategy.seedL1('summary a', ['m1']);
      const b = strategy.seedL1('summary b', ['m2']);
      const parent = strategy.seedL2([a.id, b.id], 'parent whose sources were lost');
      const kept = strategy.seedL1('summary c', ['m3']);
      const other = strategy.seedL2([kept.id], 'parent of c');
      const view = strategy.getSummariesView();
      const corrupted: SummaryEntry[] = [
        ...view.map((summary) =>
          summary.id === parent.id ? ({ ...summary, sourceIds: null } as unknown as SummaryEntry) : summary),
        // A superseded L1 with no sources, whose parent doesn't list it.
        { ...kept, id: 'L1-lost', content: 'superseded', sourceIds: null, mergedInto: other.id } as unknown as SummaryEntry,
        // Sources that aren't a list, or hold something other than ids.
        { ...kept, id: 'L1-string', content: 'string sources', sourceIds: 'm3' } as unknown as SummaryEntry,
        { ...kept, id: 'L1-mixed', content: 'mixed sources', sourceIds: ['m3', 7] } as unknown as SummaryEntry,
        { ...kept, id: 'L1-none', content: 'no sources', sourceIds: [] } as unknown as SummaryEntry,
      ];
      strategy.persistRawSummaries(corrupted);
      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const summaries = strategy.getSummariesView();
      assert.deepEqual(summaries.map((s) => s.id).sort(), ['L1-0', 'L1-1', 'L1-3', 'L2-4']);
      assert.ok(summaries.every((s) => Array.isArray(s.sourceIds) && s.sourceIds.length > 0));
      // The dropped parent's children are free to merge again; the kept parent's child stays merged.
      assert.equal(summaries.find((s) => s.id === 'L1-0')?.mergedInto, undefined);
      assert.equal(summaries.find((s) => s.id === 'L1-1')?.mergedInto, undefined);
      assert.equal(summaries.find((s) => s.id === 'L1-3')?.mergedInto, 'L2-4');
      assert.deepEqual(
        strategy.readPersistedSummaries().map((s) => s.id).sort(),
        ['L1-0', 'L1-1', 'L1-3', 'L2-4'],
        'the repair is persisted, so it does not run again on the next open',
      );
      manager.close();
    }
  });

  it('drops a merge queue item whose sourceIds are not a list on load', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const m1 = manager.addMessage('User', textBlock('hello'));
      const m2 = manager.addMessage('Claude', textBlock('hi back'));
      const a = strategy.seedL1('summary a', [m1]);
      const b = strategy.seedL1('summary b', [m2]);
      strategy.persistRawMergeQueue([{ level: 2, sourceIds: null }, { level: 2, sourceIds: [a.id, b.id] }]);
      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      assert.deepEqual(strategy.getMergeQueueView(), [{ level: 2, sourceIds: ['L1-0', 'L1-1'] }]);
      manager.close();
    }
  });

  for (const [label, options] of [
    ['hierarchical', {}],
    ['adaptive, default solver', { adaptiveResolution: true }],
    ['adaptive, kv-stable', { adaptiveResolution: true, foldingStrategy: 'kv-stable' }],
  ] as const) {
    it(`compiles a store that held an L1 with null sourceIds, after a reopen (${label})`, async () => {
      let parentId = '';
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, ...options });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        const ids = ['one', 'two', 'three', 'four'].map((text, i) => manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', textBlock(text)));
        const good = strategy.seedL1('summary of one and two', ids.slice(0, 2));
        const parent = strategy.seedL2([good.id], 'parent of the good one');
        parentId = parent.id;
        strategy.persistRawSummaries([
          ...strategy.getSummariesView(),
          // A superseded L1 that no chunk record points at, whose parent doesn't list it.
          { ...good, id: 'L1-lost', content: 'superseded', sourceIds: null, mergedInto: parent.id } as unknown as SummaryEntry,
        ]);
        manager.sync();
        manager.close();
      }

      const strategy = new TestableStrategy({ targetChunkTokens: 300, ...options });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        assert.ok(compiled.messages.length > 0);
        assert.ok(strategy.getSummariesView().some(summary => summary.id === 'L1-0' && summary.content === 'summary of one and two'), 'the readable L1 survives');
        assert.ok(strategy.getSummariesView().some(summary => summary.id === parentId), 'so does its parent');
        const dry = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun: true });
        assert.ok(dry.messages.length > 0);
        for (const context of [compiled, dry]) {
          const texts = context.messages.flatMap(message => message.content).map(block => (block as { text?: string }).text);
          for (const text of ['one', 'two', 'three', 'four']) assert.equal(texts.filter(value => value === text).length, 1, JSON.stringify(texts));
          const parents = texts.filter(value => value === 'parent of the good one').length;
          // Adaptive resolution may render the parent's L1 in its place.
          if ('adaptiveResolution' in options) assert.ok(parents <= 1, JSON.stringify(texts));
          else assert.equal(parents, 1);
        }
        assert.ok(!strategy.getSummariesView().some((s) => s.id === 'L1-lost'), 'the record is dropped on load');
        assert.ok(!strategy.readPersistedSummaries().some((s) => s.id === 'L1-lost'), 'and the drop is persisted, with nothing else to repair');
      } finally {
        manager.close();
      }
    });
  }

  const kvUnified = {
    foldingStrategy: 'kv-unified',
    kvUnified: {
      policy: {
        alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
        cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
        continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
        continuityStableHalfLife: 10, continuityStableFloor: 0.25,
      },
      tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
      treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
    },
  } as const;
  for (const [label, options] of [
    ['default solver', {}],
    ['oldest-first', { foldingStrategy: 'oldest-first' }],
    ['kv-stable', { foldingStrategy: 'kv-stable' }],
    ['kv-unified', kvUnified],
  ] as const) {
    it(`plans a message whose saved level names a dropped summary from the summaries still over it (${label})`, async (t) => {
      t.mock.method(console, 'warn', () => {});
      t.mock.method(console, 'error', () => {});
      const config = { targetChunkTokens: 300, adaptiveResolution: true, recentWindowTokens: 40, ...options };
      let ids: string[] = [];
      // Group 0: L1 B under an L2 that also names a missing L1, saved at 2.
      // Group 1: L1 C under L2 Q, saved at 2, which it still reaches.
      // Group 2: L1 D under L2 R, saved at 1.
      // Group 3: L1 E under L2 S under an L3 that also names a missing L2,
      // saved at 3. The load drops the two summaries naming missing ones.
      const saved = [2, 2, 1, 3];
      const level = (i: number) => saved[Math.floor(i / 4)]!;
      {
        const strategy = new TestableStrategy(config);
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        ids = Array.from({ length: 16 }, (_, i) => manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock(`MSG${i} ` + 'word '.repeat(60))));
        manager.addMessage('User', textBlock('TAIL'));
        const groups = [0, 1, 2, 3].map((g) => ids.slice(4 * g, 4 * g + 4));
        const l1s = groups.map((group, g) => strategy.seedL1(`${'BCDE'[g]}-SUMMARY`, group));
        const l2s = l1s.map((l1, g) => strategy.seedL2([l1.id], `${'PQRS'[g]}-SUMMARY`));
        const l3 = strategy.seedParent(3, [l2s[3]!.id], 'T-SUMMARY');
        const view = new Map(strategy.getSummariesView().map((summary) => [summary.id, summary]));
        strategy.persistRawSummaries([
          ...l1s.map((l1) => view.get(l1.id)!),
          ...l2s.map((l2, g) => (g === 0 ? { ...view.get(l2.id)!, sourceIds: ['L1-gone', l2.sourceIds[0]!] } : view.get(l2.id)!)),
          { ...view.get(l3.id)!, sourceIds: [l2s[3]!.id, 'L2-gone'] },
        ]);
        strategy.persistRawChunks(l1s.map((l1, g) => ({ id: `c-${g}`, sourceIds: groups[g]!, compressed: true, summaryId: l1.id })));
        // One message of group 0 and every message of the others are locked,
        // so every solver keeps the levels they are planned from.
        strategy.persistRawResolutions(Object.fromEntries(ids.map((id, i) => [id, level(i)])), [ids[3]!, ...ids.slice(4)]);
        manager.sync();
        manager.close();
      }
      const strategy = new TestableStrategy(config);
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const kept = strategy.getSummariesView().map((s) => s.content).sort();
        assert.deepEqual(kept, ['B-SUMMARY', 'C-SUMMARY', 'D-SUMMARY', 'E-SUMMARY', 'Q-SUMMARY', 'R-SUMMARY', 'S-SUMMARY'], 'the two summaries naming missing ones are dropped');
        const before = Object.fromEntries(ids.map((id, i) => [id, level(i)]));
        // Raw, group 0's messages are over this budget; its L1's recall is far under it.
        const dry = await manager.compile({ maxTokens: 150, reserveForResponse: 0 }, undefined, { dryRun: true });
        assert.deepEqual(strategy.readPersistedResolutions(), before, 'a dry compile saves no level');
        const live = await manager.compile({ maxTokens: 150, reserveForResponse: 0 });
        for (const context of [dry, live]) {
          const texts = context.messages.flatMap((message) => message.content).map((block) => (block as { text?: string }).text ?? '');
          // Group 0 renders through B, group 1 through Q, group 2 through D, and
          // group 3 through S, the deepest summary over it at or below 3.
          for (const [text, count] of [
            ['B-SUMMARY', 1], ['Q-SUMMARY', 1], ['D-SUMMARY', 1], ['S-SUMMARY', 1],
            ['C-SUMMARY', 0], ['R-SUMMARY', 0], ['E-SUMMARY', 0],
          ] as const) {
            assert.equal(texts.filter((value) => value === text).length, count, text + ' in ' + JSON.stringify(texts));
          }
          assert.ok(!texts.some((text) => text.startsWith('MSG')), JSON.stringify(texts));
        }
        assert.deepEqual(
          strategy.readPersistedResolutions(),
          { ...before, [ids[0]!]: 1, [ids[1]!]: 1, [ids[2]!]: 1 },
          'the compile saves the level it presented, and a locked message keeps its own',
        );
      } finally {
        manager.close();
      }
    });
  }


  for (const [label, shape] of [
    ['null', null], ['missing', undefined], ['string', 'lost'], ['empty', []], ['mixed', ['lost', 7]],
  ] as const) {
    it('rebuilds an L1 with ' + label + ' sources from its compressed chunk record', async (t) => {
      const warnings: string[] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
      let sourceIds: string[] = [];
      let parentId = '';
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        sourceIds = ['chunk-first', 'chunk-last'].map(text => manager.addMessage('User', textBlock(text)));
        const l1 = strategy.seedL1('KEEP THIS CONTENT', sourceIds);
        const parent = strategy.seedL2([l1.id], 'its parent');
        parentId = parent.id;
        strategy.persistRawChunks([{ id: 'c-0', sourceIds, compressed: true, summaryId: l1.id }]);
        strategy.persistRawSummaries([{ ...l1, sourceIds: shape, sourceRange: { first: 'lost', last: 'lost' } }, parent]);
        manager.sync();
        manager.close();
      }
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const [l1, parent] = strategy.getSummariesView();
        assert.ok(l1, 'recoverable content survives');
        assert.equal(l1.content, 'KEEP THIS CONTENT');
        assert.deepEqual(l1.sourceIds, sourceIds);
        assert.deepEqual(l1.sourceRange, { first: sourceIds[0], last: sourceIds[1] });
        assert.equal(l1.level, 1);
        assert.equal(l1.mergedInto, parentId, 'the rebuilt L1 stays merged into its parent');
        assert.equal(parent?.id, parentId, 'and the parent is kept');
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        assert.ok(strategy.readPersistedChunks().some(record => record.summaryId === l1.id && record.compressed));
        assert.ok(warnings.some(line => /rebuilt/.test(line) && line.includes(l1.id)), warnings.join('\n'));
      } finally { manager.close(); }
    });
  }


  for (const invalid of ['uncompressed', 'non-id-chunk', 'non-L1'] as const) {
    it('drops unreadable provenance when its chunk link is ' + invalid, async (t) => {
      t.mock.method(console, 'warn', () => {});
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const id = manager.addMessage('User', textBlock('chunk message'));
        const l1 = strategy.seedL1('cannot safely rebuild', [id]);
        strategy.persistRawSummaries([{ ...l1, level: invalid === 'non-L1' ? 2 : 1, sourceIds: null }]);
        strategy.persistRawChunks([{
          id: 'c-0', sourceIds: invalid === 'non-id-chunk' ? [id, 7] as unknown as string[] : [id],
          compressed: invalid !== 'uncompressed', summaryId: l1.id,
        }]);
        // Exercise the loader before later chunk materialization can alter the record.
        strategy.reloadPersisted();
        assert.deepEqual(strategy.getSummariesView(), []);
        assert.deepEqual(strategy.readPersistedSummaries(), []);
      } finally { manager.close(); }
    });
  }

  it('dedupes before validating sources and borrows the donor range without losing merge state', async () => {
    let expectedIds: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      expectedIds = ['first', 'last'].map(text => manager.addMessage('User', textBlock(text)));
      const child = strategy.seedL1('PLAIN COPY', expectedIds);
      const plain = { ...child };
      const parent = strategy.seedL2([child.id], 'parent');
      const selected = { ...strategy.getSummariesView()[0], content: 'SELECTED MERGED COPY', sourceIds: null, sourceRange: { first: 'wrong', last: 'wrong' } };
      strategy.persistRawSummaries([plain, selected, { ...plain, content: '' }, { ...plain }, parent]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const summaries = strategy.getSummariesView();
      assert.equal(summaries.length, 2);
      const child = summaries.find(summary => summary.level === 1)!;
      assert.equal(child.content, 'SELECTED MERGED COPY');
      assert.equal(child.mergedInto, 'L2-1');
      assert.deepEqual(child.sourceIds, expectedIds);
      assert.deepEqual(child.sourceRange, { first: expectedIds[0], last: expectedIds[1] });
      assert.deepEqual(strategy.readPersistedSummaries(), summaries);
    } finally { manager.close(); }
  });

  it('gives each summary one parent that lists it, from any copy, and clears the pointers that name none, once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    const ids: Record<string, string> = {};
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      // The parent covers A and C, which are next to each other; B and D come after them.
      const markers = ['PTR-A', 'PTR-C', 'PTR-B', 'PTR-D'];
      const l1s = markers.map((marker) => strategy.seedL1(marker, [manager.addMessage('User', textBlock(marker))]));
      markers.forEach((marker, i) => { ids[marker] = l1s[i]!.id; });
      const parent = strategy.seedL2([ids['PTR-A']!, ids['PTR-C']!], 'PTR-A PTR-C');
      parentId = parent.id;
      const plain = (id: string) => {
        const summary = { ...strategy.getSummariesView().find((s) => s.id === id)! };
        delete (summary as { mergedInto?: string }).mergedInto;
        return summary;
      };
      strategy.persistRawSummaries([
        // A's text copy names a parent that's gone and an empty one; its empty copy names the kept parent.
        { ...plain(ids['PTR-A']!), parentId: 'L2-gone', mergedInto: '' },
        { ...plain(ids['PTR-A']!), content: '', parentId: parent.id, mergedInto: parent.id },
        // B names a kept parent that doesn't list it, and a number.
        { ...plain(ids['PTR-B']!), parentId: 5, mergedInto: parent.id },
        // C's text copy has null pointers; its empty copy names the kept parent.
        { ...plain(ids['PTR-C']!), parentId: null, mergedInto: null },
        { ...plain(ids['PTR-C']!), content: '', mergedInto: parent.id },
        // D has no parent: a null parentId and a pointer to a summary that's gone.
        { ...plain(ids['PTR-D']!), parentId: null, mergedInto: 'L2-gone' },
        parent,
      ]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const kept = new Map(strategy.getSummariesView().map((summary) => [summary.id, summary]));
        const a = kept.get(ids['PTR-A']!)!;
        assert.equal(a.parentId, parentId, 'a dangling parentId takes the parent another copy names');
        assert.equal(a.mergedInto, parentId, 'and so does an empty-string mergedInto');
        const b = kept.get(ids['PTR-B']!)!;
        assert.equal(b.mergedInto, undefined, 'a kept parent that does not list the summary is no parent');
        assert.equal((b as { parentId?: unknown }).parentId, undefined, 'a number is no parent');
        const c = kept.get(ids['PTR-C']!)!;
        assert.equal(c.mergedInto, parentId, 'a null pointer takes the parent another copy names');
        assert.strictEqual((c as { parentId?: unknown }).parentId, null, 'a null parentId beside it is left as it is');
        const d = kept.get(ids['PTR-D']!)!;
        assert.equal(d.mergedInto, undefined, 'with no parent, a dangling pointer is cleared');
        assert.strictEqual((d as { parentId?: unknown }).parentId, null, 'and a null one is left as it is');
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        if (open === 0) {
          const line = warnings.find((w) => w.includes('repaired summary state')) ?? '';
          const cleared = line.match(/cleared the parent pointers of \[([^\]]*)\]/)?.[1]?.split(', ').sort();
          assert.deepEqual(cleared, [ids['PTR-B'], ids['PTR-D']].sort(), line);
          const reparented = line.match(/set the parent of \[([^\]]*)\]/)?.[1]?.split(', ').sort();
          assert.deepEqual(reparented, [ids['PTR-A'], ids['PTR-C']].sort(), line);
        } else {
          assert.ok(!warnings.some((w) => w.includes('repaired summary state')), warnings.join('\n'));
        }
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        const rendered = JSON.stringify(compiled.messages.map((message) => message.content));
        for (const marker of ['PTR-A', 'PTR-B', 'PTR-C', 'PTR-D']) assert.equal(rendered.split(marker).length - 1, 1, rendered);
      } finally { manager.close(); }
    }
  });

  it('gives a summary whose parent only parentId names the same mergedInto, once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    let childId = '';
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const child = strategy.seedL1('only parentId', [manager.addMessage('User', textBlock('only parentId'))]);
      const parent = strategy.seedL2([child.id], 'its parent');
      childId = child.id;
      parentId = parent.id;
      const plain = { ...strategy.getSummariesView().find((s) => s.id === child.id)! };
      delete (plain as { mergedInto?: string }).mergedInto;
      strategy.persistRawSummaries([{ ...plain, parentId: parent.id }, parent]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const child = strategy.readPersistedSummaries().find((s) => s.id === childId)!;
        assert.equal(child.mergedInto, parentId);
        assert.equal(child.parentId, parentId);
        const line = warnings.find((w) => w.includes('repaired summary state'));
        if (open === 0) assert.match(line ?? '', new RegExp('set the parent of \\[' + childId + '\\]'), warnings.join('\n'));
        else assert.equal(line, undefined, warnings.join('\n'));
      } finally { manager.close(); }
    }
  });

  const textsOf = (context: { messages: Array<{ content: unknown[] }> }) =>
    context.messages.flatMap((message) => message.content).map((block) => (block as { text?: string }).text ?? '');

  it('drops two summaries at one level that list each other, so each message renders once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    const config = { targetChunkTokens: 300, recentWindowTokens: 40 };
    let l1Id = '';
    let lowerId = '';
    {
      const strategy = new TestableStrategy(config);
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = [0, 1].map((i) => manager.addMessage(i ? 'Claude' : 'User', textBlock(`MSG${i} ` + 'word '.repeat(60))));
      manager.addMessage('User', textBlock('TAIL'));
      const l1 = strategy.seedL1('L1-TEXT', ids);
      const lower = strategy.seedL2([l1.id], 'LOWER');
      l1Id = l1.id;
      lowerId = lower.id;
      // Two summaries at one level that list each other and point at each other.
      strategy.persistRawSummaries([
        { ...l1, mergedInto: lower.id },
        { ...lower, sourceIds: [l1.id, 'L2-same'], mergedInto: 'L2-same' },
        { ...lower, id: 'L2-same', content: 'SAME', sourceIds: [lower.id], mergedInto: lower.id },
      ]);
      strategy.persistRawChunks([{ id: 'c-0', sourceIds: ids, compressed: true, summaryId: l1.id }]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy(config);
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const stored = strategy.readPersistedSummaries();
      assert.deepEqual(stored.map((s) => s.id), [l1Id], 'a summary listing one at its own level is dropped, and so is the other');
      assert.equal(stored[0]!.mergedInto, undefined, 'and the L1 under them has no parent left');
      const line = warnings.find((w) => w.includes('repaired summary state')) ?? '';
      assert.deepEqual(line.match(/naming one not below it \[([^\]]*)\]/)?.[1]?.split(', ').sort(), [lowerId, 'L2-same'].sort(), line);
      assert.match(line, /naming a missing summary \[\]/, 'whichever the pass reaches first: ' + line);
      const dry = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun: true });
      const live = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      for (const context of [dry, live]) {
        const texts = textsOf(context);
        assert.equal(texts.filter((text) => text === 'L1-TEXT').length, 1, JSON.stringify(texts));
        assert.ok(!texts.some((text) => text === 'LOWER' || text === 'SAME' || text.startsWith('MSG')), JSON.stringify(texts));
      }
    } finally { manager.close(); }
  });

  it('drops a summary that lists one above it, as naming one not below it', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    let upId = '';
    let bId = '';
    let besideId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true, topologyPolicy: 'report' });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const [a, b] = ['a', 'b'].map((text) => strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]));
      const mid = strategy.seedL2([a!.id], 'mid');
      const top = strategy.seedParent(3, [mid.id], 'top');
      const up = strategy.seedL2([b!.id], 'up');
      upId = up.id;
      bId = b!.id;
      const [c, d] = ['c', 'd'].map((text) => strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]));
      const emptyL2 = strategy.seedL2([d!.id], 'empty');
      const beside = strategy.seedL2([c!.id], 'beside');
      besideId = beside.id;
      // An L2 that lists the L3 above it beside its own L1, and one that lists
      // an L2 the load drops as empty.
      strategy.persistRawSummaries(strategy.getSummariesView().map((s) => {
        if (s.id === up.id) return { ...s, sourceIds: [b!.id, top.id] };
        if (s.id === beside.id) return { ...s, sourceIds: [c!.id, emptyL2.id] };
        if (s.id === emptyL2.id) return { ...s, content: '' };
        return s;
      }));
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true, topologyPolicy: 'report' });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const stored = new Map(strategy.readPersistedSummaries().map((s) => [s.id, s]));
      assert.ok(!stored.has(upId), 'the summary listing one above it is dropped');
      assert.ok(!stored.has(besideId), 'and so is the one listing an L2 the load drops as empty');
      assert.ok(stored.has(bId), 'its L1 is kept');
      assert.equal(stored.get(bId)!.mergedInto, undefined, 'and has no parent left');
      const line = warnings.find((w) => w.includes('repaired summary state')) ?? '';
      assert.deepEqual(line.match(/naming one not below it \[([^\]]*)\]/)?.[1]?.split(', ').sort(), [upId, besideId].sort(), 'whatever dropped what it lists: ' + line);
    } finally { manager.close(); }
  });

  it('gives a summary whose pointer names its grandparent the parent a level up that lists it, so the grandparent renders once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    t.mock.method(console, 'error', () => {});
    const config = { targetChunkTokens: 300, adaptiveResolution: true, recentWindowTokens: 40 };
    let ids: string[] = [];
    let aId = '';
    let pId = '';
    {
      const strategy = new TestableStrategy(config);
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = Array.from({ length: 8 }, (_, i) => manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock(`MSG${i} ` + 'word '.repeat(60))));
      manager.addMessage('User', textBlock('TAIL'));
      const groups = [0, 1, 2, 3].map((g) => ids.slice(2 * g, 2 * g + 2));
      const l1s = groups.map((group, g) => strategy.seedL1(`${'ABCD'[g]}-TEXT`, group));
      const p = strategy.seedL2([l1s[0]!.id, l1s[1]!.id], 'P-TEXT');
      const q = strategy.seedL2([l1s[2]!.id, l1s[3]!.id], 'Q-TEXT');
      const r = strategy.seedParent(3, [p.id, q.id], 'CHEAP ROOT');
      aId = l1s[0]!.id;
      pId = p.id;
      // A's pointer names its grandparent, which doesn't list it; its parent does.
      strategy.persistRawSummaries(strategy.getSummariesView().map((s) => (s.id === aId ? { ...s, mergedInto: r.id } : s)));
      strategy.persistRawChunks(groups.map((group, g) => ({ id: `c-${g}`, sourceIds: group, compressed: true, summaryId: l1s[g]!.id })));
      strategy.persistRawResolutions(Object.fromEntries(ids.map((id) => [id, 3])));
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy(config);
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      assert.equal(strategy.readPersistedSummaries().find((s) => s.id === aId)?.mergedInto, pId, 'the L2 that lists it is its parent');
      const line = warnings.find((w) => w.includes('repaired summary state')) ?? '';
      assert.deepEqual(line.match(/set the parent of \[([^\]]*)\]/)?.[1], aId, line);
      // Raw, the messages are far over this budget; the root's recall is under it.
      const dry = await manager.compile({ maxTokens: 100, reserveForResponse: 0 }, undefined, { dryRun: true });
      const live = await manager.compile({ maxTokens: 100, reserveForResponse: 0 });
      for (const context of [dry, live]) {
        const texts = textsOf(context);
        assert.equal(texts.filter((text) => text === 'CHEAP ROOT').length, 1, JSON.stringify(texts));
        assert.ok(!texts.some((text) => /^[ABCDPQ]-TEXT$/.test(text) || text.startsWith('MSG')), JSON.stringify(texts));
      }
    } finally { manager.close(); }
  });

  it('gives a summary no pointer names the one summary a level up that lists it, no parent when two do, and the one another copy names', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let xId = '';
    let wId = '';
    let wParentId = '';
    let uId = '';
    let uParentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true, topologyPolicy: 'report' });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const [x, y, z, w, v, u, s1, s2] = ['x', 'y', 'z', 'w', 'v', 'u', 's1', 's2'].map((text) => strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]));
      // x and u are each listed by two L2s; only u has a copy whose pointer
      // names one of them. w is listed by one L2, and directly by an L3 above it.
      const first = strategy.seedL2([x!.id, y!.id], 'first');
      const second = strategy.seedL2([x!.id, z!.id], 'second');
      const third = strategy.seedL2([u!.id, s1!.id], 'third');
      const fourth = strategy.seedL2([u!.id, s2!.id], 'fourth');
      uId = u!.id;
      uParentId = fourth.id;
      const wParent = strategy.seedL2([w!.id, v!.id], 'w parent');
      const skipping = strategy.seedParent(3, [wParent.id, w!.id], 'skips a level');
      xId = x!.id;
      wId = w!.id;
      wParentId = wParent.id;
      const unpointed = (summary: SummaryEntry) => {
        const copy = { ...summary };
        delete (copy as { mergedInto?: string }).mergedInto;
        return copy;
      };
      const view = new Map(strategy.getSummariesView().map((s) => [s.id, s]));
      strategy.persistRawSummaries([
        unpointed(view.get(x!.id)!), view.get(y!.id)!, view.get(z!.id)!, unpointed(view.get(w!.id)!), view.get(v!.id)!,
        unpointed(view.get(u!.id)!), { ...unpointed(view.get(u!.id)!), content: '', mergedInto: fourth.id },
        view.get(s1!.id)!, view.get(s2!.id)!,
        view.get(first.id)!, view.get(second.id)!, view.get(third.id)!, view.get(fourth.id)!, view.get(wParent.id)!, view.get(skipping.id)!,
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true, topologyPolicy: 'report' });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const stored = new Map(strategy.readPersistedSummaries().map((s) => [s.id, s]));
      assert.ok(stored.has(xId));
      assert.equal(stored.get(xId)!.mergedInto, undefined, 'with two parents listing it, neither is chosen');
      assert.equal(stored.get(wId)?.mergedInto, wParentId, 'the summary listing it a level up is its parent; the one two levels up is not');
      assert.equal(stored.get(uId)?.mergedInto, uParentId, 'of two listing it, the one another copy names is its parent');
    } finally { manager.close(); }
  });

  it('takes parentId before mergedInto, counts once a summary listing a child twice, and takes no parent at the child\'s level', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const ids: Record<string, string> = {};
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true, topologyPolicy: 'report' });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const l1 = (text: string) => strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]);
      const [tc, a1, b1, rc, c1, kc] = ['tc', 'a1', 'b1', 'rc', 'c1', 'kc'].map(l1);
      const pa = strategy.seedL2([tc!.id, a1!.id], 'pa');
      const pb = strategy.seedL2([tc!.id, b1!.id], 'pb');
      const rr = strategy.seedL2([rc!.id, c1!.id], 'rr');
      Object.assign(ids, { tc: tc!.id, pa: pa.id, rc: rc!.id, rr: rr.id, kc: kc!.id });
      const view = new Map(strategy.getSummariesView().map((s) => [s.id, s]));
      const plain = (id: string) => {
        const copy = { ...view.get(id)! };
        delete (copy as { mergedInto?: string }).mergedInto;
        return copy;
      };
      strategy.persistRawSummaries([
        // tc's parentId and mergedInto name two kept summaries that both list it.
        { ...plain(tc!.id), parentId: pa.id, mergedInto: pb.id },
        view.get(a1!.id)!, view.get(b1!.id)!,
        // rc has no pointer, and one summary lists it twice.
        plain(rc!.id), view.get(c1!.id)!,
        // kc points at an L1 that lists it.
        { ...plain(kc!.id), mergedInto: 'L1-kk' },
        { ...plain(kc!.id), id: 'L1-kk', content: 'kk', sourceIds: [kc!.id] },
        view.get(pa.id)!, view.get(pb.id)!,
        { ...view.get(rr.id)!, sourceIds: [rc!.id, rc!.id, c1!.id] },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true, topologyPolicy: 'report' });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const stored = new Map(strategy.readPersistedSummaries().map((s) => [s.id, s]));
      assert.equal(stored.get(ids.tc!)?.parentId, ids.pa, 'parentId is read first');
      assert.equal(stored.get(ids.tc!)?.mergedInto, ids.pa, 'and mergedInto is set to the same parent');
      assert.equal(stored.get(ids.rc!)?.mergedInto, ids.rr, 'a summary listing it twice is one parent');
      assert.ok(stored.has(ids.kc!));
      assert.equal(stored.get(ids.kc!)!.mergedInto, undefined, 'a summary at its own level is no parent, though it lists it');
    } finally { manager.close(); }
  });

  it('keeps the summary-id counter past every id the store holds, whatever counter it stored', async (t) => {
    t.mock.method(console, 'warn', () => {});
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      for (const text of ['one', 'two']) strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]);
      // Another instance on the store wrote the counter it held, an older one.
      strategy.persistRawCounter(0);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      assert.deepEqual(strategy.getSummariesView().map((s) => s.id), ['L1-0', 'L1-1']);
      assert.equal(strategy.getCounter(), 2, 'the next id repeats none in the store');
      assert.equal(strategy.readPersistedCounter(), 2, 'and the open stores the counter it raised');
    } finally { manager.close(); }
  });

  it('stores a raised counter before the repair removes the summary whose id raised it, and a second open writes nothing', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      for (const text of ['one', 'two']) strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]);
      // The highest id is empty, so the open drops it; the stored counter trails it.
      strategy.persistRawSummaries(strategy.getSummariesView().map((s) => (s.id === 'L1-1' ? { ...s, content: '' } : s)));
      strategy.persistRawCounter(1);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    strategy.stateWrites = [];
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const { counter, summaries } = strategy.stateIds();
      assert.deepEqual(strategy.readPersistedSummaries().map((s) => s.id), ['L1-0'], 'the empty L1 is dropped');
      assert.equal(strategy.readPersistedCounter(), 2);
      const writes = strategy.stateWrites;
      assert.ok(writes.includes(counter) && writes.includes(summaries), JSON.stringify(writes));
      assert.ok(writes.indexOf(counter) < writes.indexOf(summaries), 'an open stopped between the two writes still has the counter: ' + JSON.stringify(writes));
      assert.ok(warnings.some((w) => w.includes('raised the summary-id counter from 1 to 2')), JSON.stringify(warnings));
    } finally { manager.close(); }
    const again = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    again.stateWrites = [];
    const reopened = await ContextManager.open({ path: TEST_STORE_PATH, strategy: again });
    try {
      assert.deepEqual(again.stateWrites, [], 'the repaired store needs no write, the counter included');
      assert.equal(again.getCounter(), 2);
    } finally { reopened.close(); }
  });

  it('mints no id twice across instances on one store, or across a reload', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const first = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: first });
    const second = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const secondManager = await ContextManager.open({ store: manager.getStore(), strategy: second });
    try {
      // Both loaded the same counter; the second mints after the first, with no reload between.
      const minted = [first.mintId(), second.mintId(), first.mintId()];
      // The first reloads while an id it minted has no summary in the store yet.
      first.reload();
      minted.push(first.mintId(), second.mintId());
      assert.equal(new Set(minted).size, minted.length, 'every minted id is new: ' + JSON.stringify(minted));
      assert.equal(first.readPersistedCounter(), Math.max(...minted) + 1, 'the stored counter only rises');
    } finally {
      secondManager.close();
      manager.close();
    }
  });

  it('keeps the text of a copy whose pointer names a parent that lists it, over copies whose pointer is empty, dangling or names a summary that does not list it', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let id = '';
    let parentId = '';
    let secondId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      // The parent's three L1s come first, so its leaves are contiguous.
      const [l1, other, byParentId, third] = ['copy one', 'copy two', 'copy four', 'copy three'].map((text) => strategy.seedL1(text, [manager.addMessage('User', textBlock(text))]));
      const parent = strategy.seedL2([l1!.id, other!.id, byParentId!.id], 'parent');
      const side = strategy.seedL2([third!.id], 'side');
      secondId = byParentId!.id;
      id = l1!.id;
      parentId = parent.id;
      const view = new Map(strategy.getSummariesView().map((s) => [s.id, s]));
      const plain = { ...view.get(id)! };
      delete (plain as { mergedInto?: string }).mergedInto;
      strategy.persistRawSummaries([
        { ...plain, content: 'STALE, EMPTY POINTER', parentId: '' },
        { ...plain, content: 'STALE, DANGLING POINTER', mergedInto: 'L2-gone' },
        { ...plain, content: 'STALE, POINTER TO A SUMMARY THAT DOES NOT LIST IT', mergedInto: side.id },
        { ...plain, content: 'FRESH', mergedInto: parent.id },
        // The second summary's fresh copy names its parent through parentId.
        { ...view.get(byParentId!.id)!, mergedInto: undefined, content: 'STALE, NO POINTER' },
        { ...view.get(byParentId!.id)!, mergedInto: undefined, content: 'FRESH BY PARENTID', parentId: parent.id },
        view.get(other!.id)!,
        view.get(third!.id)!,
        view.get(parent.id)!,
        view.get(side.id)!,
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const kept = strategy.readPersistedSummaries().find((s) => s.id === id)!;
      assert.equal(kept.content, 'FRESH');
      assert.equal(kept.mergedInto, parentId);
      const second = strategy.readPersistedSummaries().find((s) => s.id === secondId)!;
      assert.equal(second.content, 'FRESH BY PARENTID');
      assert.equal(second.mergedInto, parentId);
    } finally { manager.close(); }
  });

  it('a store whose only defect is a dangling parent pointer is repaired and persisted once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const id = manager.addMessage('User', textBlock('alone'));
      const l1 = strategy.seedL1('alone', [id]);
      strategy.persistRawSummaries([{ ...l1, mergedInto: 'L2-gone' }]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        assert.equal(strategy.readPersistedSummaries()[0]!.mergedInto, undefined);
        assert.equal(warnings.some((line) => line.includes('repaired summary state')), open === 0, warnings.join('\n'));
      } finally { manager.close(); }
    }
  });

  it('takes the sources and range of a summary above L1 together from a readable copy', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['up-a', 'up-b'].map((text) => manager.addMessage('User', textBlock(text)));
      const children = ids.map((id, i) => strategy.seedL1('child ' + i, [id]));
      const parent = strategy.seedL2(children.map((child) => child.id), 'parent text');
      parentId = parent.id;
      strategy.persistRawSummaries([
        ...strategy.getSummariesView().filter((summary) => summary.id !== parent.id),
        { ...parent, sourceIds: null, sourceRange: undefined },
        { ...parent, content: 'older parent text' },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const parent = strategy.getSummariesView().find((summary) => summary.id === parentId)!;
      assert.equal(parent.content, 'parent text');
      assert.deepEqual(parent.sourceIds, ['L1-0', 'L1-1']);
      assert.deepEqual(parent.sourceRange, { first: ids[0], last: ids[1] });
    } finally { manager.close(); }
  });

  it('keeps an L1 own sources over its chunk record, and rebuilds a range that is not their ends', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['own-a', 'own-b', 'own-c'].map((text) => manager.addMessage('User', textBlock(text)));
      const l1 = strategy.seedL1('own sources', ids.slice(0, 2));
      strategy.persistRawChunks([{ id: 'c-0', sourceIds: ids, compressed: true, summaryId: l1.id }]);
      strategy.persistRawSummaries([{ ...l1, sourceRange: { first: ids[0]!, last: ids[2]! } }]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const [l1] = strategy.getSummariesView();
      assert.deepEqual(l1.sourceIds, ids.slice(0, 2));
      assert.deepEqual(l1.sourceRange, { first: ids[0], last: ids[1] });
    } finally { manager.close(); }
  });

  it('keeps the parent pointer of an empty merged copy, so its plain copy renders only through its parent', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let childId = '';
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const id = manager.addMessage('User', textBlock('DUP-A'));
      const child = strategy.seedL1('DUP-A', [id]);
      const plain = { ...child };
      const parent = strategy.seedL2([child.id], 'DUP-A');
      childId = child.id;
      parentId = parent.id;
      strategy.persistRawSummaries([plain, { ...child, content: '' }, parent]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const child = strategy.getSummariesView().find(summary => summary.id === childId)!;
      assert.equal(child.content, 'DUP-A');
      assert.equal(child.mergedInto, parentId);
      assert.ok(strategy.getSummariesView().some(summary => summary.id === parentId));
      assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
      for (const dryRun of [false, true]) {
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun });
        const rendered = JSON.stringify(compiled.messages.map(message => message.content));
        assert.equal(rendered.split('DUP-A').length - 1, 1, rendered);
      }
    } finally { manager.close(); }
  });

  it('derives an L1 range from its sources, and drops a summary above L1 whose range no copy can supply', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    let summaryIds: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['range-a', 'range-b', 'range-c'].map(text => manager.addMessage('User', textBlock(text)));
      const [a, b, c] = ids.map((id, i) => strategy.seedL1('summary ' + i, [id]));
      const parent = strategy.seedL2([c.id], 'parent without a range');
      summaryIds = [a.id, b.id, c.id, parent.id];
      strategy.persistRawSummaries([
        { ...a, sourceIds: null, sourceRange: { first: 'lost', last: 'lost' } },
        { ...a, sourceRange: undefined },
        { ...b, sourceRange: {} },
        c,
        { ...parent, sourceRange: undefined },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const [a, b, c, parentId] = summaryIds;
      const kept = new Map(strategy.getSummariesView().map(summary => [summary.id, summary]));
      assert.deepEqual([...kept.keys()], [a, b, c], 'the parent with no readable range is dropped');
      assert.deepEqual(kept.get(a)!.sourceIds, [ids[0]], 'sources from the copy that has them');
      assert.deepEqual(kept.get(a)!.sourceRange, { first: ids[0], last: ids[0] }, 'range from those sources');
      assert.deepEqual(kept.get(b)!.sourceRange, { first: ids[1], last: ids[1] });
      assert.equal(kept.get(c)!.mergedInto, undefined, `its child no longer points at ${parentId}`);
      assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
    } finally { manager.close(); }
  });

  it('takes an L1 sources from its compressed chunk record before a copy of the L1', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['record-first', 'record-last'].map(text => manager.addMessage('User', textBlock(text)));
      const l1 = strategy.seedL1('recorded summary', ids);
      strategy.persistRawChunks([{ id: 'c-0', sourceIds: ids, compressed: true, summaryId: l1.id }]);
      strategy.persistRawSummaries([{ ...l1, sourceIds: null }, { ...l1, sourceIds: [ids[1]] }]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const [l1] = strategy.getSummariesView();
      assert.deepEqual(l1.sourceIds, ids);
      assert.deepEqual(l1.sourceRange, { first: ids[0], last: ids[1] });
    } finally { manager.close(); }
  });

  it('drops a summary that names one an earlier open removed, with what is queued on it, once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    let survivorId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = ['GONE-A', 'GONE-B'].map(text => manager.addMessage('User', textBlock(text)));
      const [lost, survivor] = ids.map((id, i) => strategy.seedL1(['GONE-A', 'GONE-B'][i], [id]));
      const parent = strategy.seedL2([lost.id, survivor.id], 'GONE-A GONE-B');
      const grandparent = strategy.seedParent(3, [parent.id], 'GONE-A GONE-B');
      survivorId = survivor.id;
      // As an earlier version leaves a store after dropping an empty L1. The
      // survivor also carries the newer parent pointer, which readers take first.
      strategy.persistRawSummaries(strategy.getSummariesView()
        .filter(summary => summary.id !== lost.id)
        .map(summary => summary.id === survivor.id ? { ...summary, parentId: parent.id } : summary));
      // One merge names the grandparent, which only the cascade drops; the
      // other names the L1 that was already gone.
      strategy.persistRawMergeQueue([{ level: 4, sourceIds: [grandparent.id] }, { level: 2, sourceIds: [lost.id, survivor.id] }]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        assert.deepEqual(strategy.getSummariesView().map(summary => summary.id), [survivorId]);
        assert.equal(strategy.getSummariesView()[0].mergedInto, undefined);
        assert.equal(strategy.getSummariesView()[0].parentId, undefined);
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        assert.deepEqual(strategy.readPersistedMergeQueue(), []);
        if (open === 1) assert.ok(!warnings.some(line => line.includes('repaired summary state')), warnings.join('\n'));
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        const rendered = JSON.stringify(compiled.messages.map(message => message.content));
        for (const marker of ['GONE-A', 'GONE-B']) assert.equal(rendered.split(marker).length - 1, 1, rendered);
      } finally { manager.close(); }
    }
  });

  for (const defect of ['null-parent', 'empty-parent', 'empty-child'] as const) {
    it('cascades ' + defect + ' drops upward, repairs descendants and renders each source once', async (t) => {
      const markers = ['CASCADE-A', 'CASCADE-B', 'CASCADE-C'];
      let childIds: string[] = [];
      let safeParentId = '';
      let dropIds: Record<'parent' | 'child0' | 'grandparent' | 'top', string> = { parent: '', child0: '', grandparent: '', top: '' };
      const warnings: string[] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        const ids = markers.map(text => manager.addMessage('User', textBlock(text)));
        const children = ids.map((id, i) => strategy.seedL1(markers[i], [id]));
        childIds = children.map(child => child.id);
        const parent = strategy.seedL2(childIds.slice(0, 2), markers.slice(0, 2).join(' '));
        const safeParent = strategy.seedL2([childIds[2]], markers[2]);
        safeParentId = safeParent.id;
        const grandparent = strategy.seedParent(3, [parent.id, safeParent.id], markers.join(' '));
        const top = strategy.seedParent(4, [grandparent.id], markers.join(' '));
        dropIds = { parent: parent.id, child0: childIds[0]!, grandparent: grandparent.id, top: top.id };
        // Only the cascade drops the grandparent, in every case.
        strategy.persistRawMergeQueue([{ level: 4, sourceIds: [grandparent.id] }]);
        strategy.persistRawChunks(children.map((child, i) => ({ id: 'c-' + i, sourceIds: [ids[i]], compressed: true, summaryId: child.id })));
        const brokenId = defect === 'empty-child' ? childIds[0] : parent.id;
        const records = strategy.getSummariesView().map(summary => summary.id !== brokenId ? summary
          : defect === 'null-parent' ? { ...summary, sourceIds: null }
          : { ...summary, content: ' ', tokens: 0 });
        // Visit the ancestors before the initial defect, so a single pass is insufficient.
        const ordered = records.reverse();
        // A grandparent copy with no sources first: rebuilt from the other copy, then dropped by the cascade.
        ordered.splice(ordered.findIndex(s => s.id === grandparent.id), 0, { ...grandparent, sourceIds: null });
        strategy.persistRawSummaries(ordered);
        manager.sync();
        manager.close();
      }
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const kept = [...(defect === 'empty-child' ? childIds.slice(1) : childIds), safeParentId];
        assert.deepEqual(strategy.getSummariesView().map(summary => summary.id).sort(), [...kept].sort());
        for (const summary of strategy.getSummariesView()) {
          assert.equal(summary.mergedInto, summary.id === childIds[2] ? safeParentId : undefined);
        }
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        assert.deepEqual(strategy.readPersistedMergeQueue(), [], 'the merge queued on a dropped ancestor is removed');
        const line = warnings.find(w => w.includes('repaired summary state')) ?? '';
        const listed = (label: string) => (line.match(new RegExp(label + ' \\[([^\\]]*)\\]'))?.[1] ?? '').split(', ').filter(Boolean).sort();
        assert.deepEqual(listed('dropped empty'), defect === 'null-parent' ? [] : [defect === 'empty-child' ? dropIds.child0 : dropIds.parent], line);
        assert.deepEqual(listed('with unreadable sources or range'), defect === 'null-parent' ? [dropIds.parent] : [], line);
        assert.deepEqual(listed('naming a missing summary'),
          [...(defect === 'empty-child' ? [dropIds.parent] : []), dropIds.grandparent, dropIds.top].sort(), line);
        assert.deepEqual(listed('rebuilt sources or range of'), [], 'the grandparent rebuilt and then dropped is not listed');
        if (defect === 'empty-child') {
          const reopened = strategy.readPersistedChunks().find(record => record.id === 'c-0')!;
          assert.equal(reopened.compressed, false);
          assert.equal(reopened.summaryId, undefined);
        }
        for (const dryRun of [false, true]) {
          const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun });
          const rendered = JSON.stringify(compiled.messages.map(message => message.content));
          for (const marker of markers) assert.equal(rendered.split(marker).length - 1, 1, rendered);
        }
      } finally { manager.close(); }
    });
  }

  it('removes malformed queued merges and merges naming a dropped summary, even in auditOnly', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = ['first', 'last'].map(text => manager.addMessage('User', textBlock(text)));
      const a = strategy.seedL1('a', [ids[0]]);
      const b = strategy.seedL1('b', [ids[1]]);
      strategy.persistRawSummaries([...strategy.getSummariesView(), { ...a, id: 'L2-dropped', level: 2, sourceLevel: 1, sourceIds: null }]);
      strategy.persistRawMergeQueue([
        null, 7, 'primitive', { level: 2, sourceIds: null }, { level: 2, sourceIds: 'string' },
        { level: 2, sourceIds: [] }, { level: 2, sourceIds: [a.id, 7] }, { level: 2, sourceIds: [a.id, ''] },
        { level: 3, sourceIds: ['L2-dropped'] }, { level: 2, sourceIds: [a.id, b.id] },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const expected = [{ level: 2, sourceIds: ['L1-0', 'L1-1'] }];
      assert.deepEqual(strategy.getMergeQueueView(), expected);
      assert.deepEqual(strategy.readPersistedMergeQueue(), expected);
    } finally { manager.close(); }
  });

  it('persists and logs a null-only summary repair once', async (t) => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      strategy.persistRawSummaries([null]);
      manager.sync();
      manager.close();
    }
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    for (let open = 0; open < 2; open++) {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        assert.deepEqual(strategy.readPersistedSummaries(), []);
        if (open === 0) assert.ok(warnings.some(line => /(?:dropped|removed) 1/.test(line)), warnings.join('\n'));
        else assert.equal(warnings.length, 0, 'a canonical store needs no second repair');
      } finally { manager.close(); warnings.length = 0; }
    }
  });

  it('takes up the store\'s summaries when the live lookup finds another instance\'s L1', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const ids = ['live one', 'live two', 'other chunk'].map((text) => manager.addMessage('User', textBlock(text)));
      const key = ids.slice(0, 2);
      const base = { id: 'L1-live', level: 1, content: 'live', tokens: 1, sourceLevel: 0, sourceRange: { first: ids[0], last: ids[1] }, created: 0 };
      // What another instance wrote after this one loaded: two L1s and the L2
      // it merged them into, beside entries readers can't use.
      strategy.persistRawSummaries([
        { ...base, id: 'L1-other-chunk', sourceIds: [ids[2]], sourceRange: { first: ids[2], last: ids[2] }, mergedInto: 'L2-other-instance' },
        { ...base, id: 'L1-string', sourceIds: ids[0] },
        { ...base, id: 'L1-empty', sourceIds: key, content: ' ' },
        { ...base, sourceIds: key, sourceRange: undefined, mergedInto: 'L2-other-instance' },
        { id: 'L2-other-instance', level: 2, content: 'above both', tokens: 1, sourceLevel: 1, sourceIds: ['L1-live', 'L1-other-chunk'], sourceRange: { first: ids[0], last: ids[2] }, created: 0 },
      ]);
      const latches = strategy as unknown as { chunkRecordsOrphaned: boolean; _overlapBlocked: Set<string> };
      latches.chunkRecordsOrphaned = true;
      latches._overlapBlocked.add('refused-chunk');
      const found = strategy.exactL1(key);
      assert.equal(latches.chunkRecordsOrphaned, true, 'the reload leaves the orphaned-records halt to rebuildChunks');
      assert.ok(!latches._overlapBlocked.has('refused-chunk'), 'and clears the overlap refusals, which the summaries it took up can end');
      latches.chunkRecordsOrphaned = false;
      assert.equal(found?.id, 'L1-live');
      assert.deepEqual(found?.sourceRange, { first: ids[0], last: ids[1] }, 'its range is derived from its sources, as the loader derives it');
      assert.equal(found?.mergedInto, 'L2-other-instance');
      const held = new Map(strategy.getSummariesView().map((s) => [s.id, s]));
      assert.ok(held.has('L2-other-instance'), 'the parent its pointer names is held too');
      assert.equal(held.get('L1-other-chunk')?.mergedInto, 'L2-other-instance', 'and so is the rest of what the other instance wrote');
      assert.ok(!held.has('L1-string') && !held.has('L1-empty'), 'what readers can\'t use is dropped, as on an open');
      assert.equal(strategy.exactL1([ids[2]!])?.id, 'L1-other-chunk', 'each chunk finds its own L1');
      assert.equal(strategy.exactL1(['not written']), undefined);
    } finally { manager.close(); }
  });

  it('compiles under kv-unified after the live lookup finds an L1 that another instance merged', async (t) => {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const strategy = new TestableStrategy({ targetChunkTokens: 300, adaptiveResolution: true, recentWindowTokens: 40, ...kvUnified });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const ids = Array.from({ length: 8 }, (_, i) => manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock(`MSG${i} ` + 'word '.repeat(60))));
      manager.addMessage('User', textBlock('TAIL'));
      const groups = [ids.slice(0, 4), ids.slice(4)];
      // After this instance loaded, another compressed both chunks and merged their L1s.
      const l1 = (g: number, content: string) => ({
        id: `L1-other-${g}`, level: 1, content, tokens: 3, sourceLevel: 0, sourceIds: groups[g]!,
        sourceRange: { first: groups[g]![0]!, last: groups[g]![3]! }, created: 0, mergedInto: 'L2-other',
      });
      strategy.persistRawSummaries([
        l1(0, 'B-SUMMARY'), l1(1, 'C-SUMMARY'),
        { id: 'L2-other', level: 2, content: 'P-SUMMARY', tokens: 3, sourceLevel: 1, sourceIds: ['L1-other-0', 'L1-other-1'], sourceRange: { first: ids[0]!, last: ids[7]! }, created: 0 },
      ]);
      strategy.persistRawChunks(groups.map((group, g) => ({ id: `c-${g}`, sourceIds: group, compressed: true, summaryId: `L1-other-${g}` })));
      assert.equal(strategy.exactL1(groups[0]!)?.id, 'L1-other-0');
      for (const dryRun of [true, false]) {
        // Raw, the eight messages are far over this budget; their summaries are under it.
        const texts = textsOf(await manager.compile({ maxTokens: 150, reserveForResponse: 0 }, undefined, { dryRun }));
        const count = (text: string) => texts.filter((value) => value === text).length;
        assert.ok(!texts.some((text) => text.startsWith('MSG')), JSON.stringify(texts));
        assert.ok(
          (count('P-SUMMARY') === 1 && count('B-SUMMARY') + count('C-SUMMARY') === 0) ||
            (count('P-SUMMARY') === 0 && count('B-SUMMARY') === 1 && count('C-SUMMARY') === 1),
          'each message renders once: ' + JSON.stringify(texts),
        );
      }
    } finally { manager.close(); }
  });

  it('refuses as infeasible, under kv-unified, a range pinned at a level only a dropped summary supplied, until the pin is released', async (t) => {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const config = { targetChunkTokens: 300, adaptiveResolution: true, recentWindowTokens: 40, ...kvUnified };
    let pinId = '';
    {
      const strategy = new TestableStrategy(config);
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = Array.from({ length: 12 }, (_, i) => manager.addMessage(i % 2 ? 'Claude' : 'User', textBlock(`MSG${i} ` + 'word '.repeat(20))));
      const pairs = [[0, 1], [2, 3], [4, 5]].map(([a, b]) => [ids[a]!, ids[b]!]);
      const l1 = (g: number) => ({
        id: `L1-${g}`, level: 1, content: `L1-SUMMARY-${g}`, tokens: 3, sourceLevel: 0, sourceIds: pairs[g]!,
        sourceRange: { first: pairs[g]![0]!, last: pairs[g]![1]! }, created: 0, mergedInto: 'L2-0',
      });
      // As an earlier version leaves a store after dropping the L1 over the
      // third pair: the L2 still lists it.
      strategy.persistRawSummaries([
        l1(0), l1(1),
        { id: 'L2-0', level: 2, content: 'L2-SUMMARY', tokens: 3, sourceLevel: 1, sourceIds: ['L1-0', 'L1-1', 'L1-2'], sourceRange: { first: ids[0]!, last: ids[5]! }, created: 0 },
      ]);
      strategy.persistRawChunks(pairs.map((group, g) => ({ id: `c-${g}`, sourceIds: group, compressed: true, summaryId: `L1-${g}` })));
      pinId = manager.pinAtLevel(ids[0]!, ids[3]!, 2, { name: 'at-two' });
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy(config);
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      assert.ok(!strategy.getSummariesView().some((summary) => summary.level === 2), 'the open drops the L2, which names a missing summary');
      // kv-unified holds a range pinned at a level exactly there, and no
      // summary supplies level 2 now, whatever the budget.
      await assert.rejects(manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }), /kv-unified constraints are infeasible/);
      assert.ok(manager.unpin(pinId), 'the pin is released');
      assert.ok(textsOf(await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).length > 0, 'it compiles without the pin');
      // Pinned at a level the surviving L1s supply, it compiles too.
      const survivors = new Map(strategy.getSummariesView().map((summary) => [summary.id, summary]));
      manager.pinAtLevel(survivors.get('L1-0')!.sourceIds[0]!, survivors.get('L1-1')!.sourceIds[1]!, 1, { name: 'at-one' });
      assert.ok(textsOf(await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).length > 0, 'it compiles pinned at L1');
    } finally { manager.close(); }
  });

  it('isolates summary state per chronicle branch (fork)', async () => {
    const strategy = new TestableStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Build pre-fork state, then fork at current head so the forked branch
    // inherits everything we've written so far.
    manager.addMessage('User', textBlock('m1'));
    manager.addMessage('Claude', textBlock('m2'));
    strategy.seedL1('common L1 (pre-fork)', ['m1', 'm2']);

    const mainBranchName = manager.currentBranch().name;

    const forkedName = await manager.fork('experimental');
    assert.equal(forkedName, 'experimental');
    assert.notEqual(forkedName, mainBranchName);

    // On the forked branch, add a divergent summary
    const strategyAfterFork = manager.getStrategy() as TestableStrategy;
    assert.equal(
      strategyAfterFork.getSummariesView().length,
      1,
      'forked branch should start with the pre-fork summary',
    );
    strategyAfterFork.seedL1('divergent on fork', ['x', 'y']);
    assert.equal(strategyAfterFork.getSummariesView().length, 2);

    // Switch back to main: should see only the pre-fork summary
    await manager.switchBranch(mainBranchName);
    const mainStrategy = manager.getStrategy() as TestableStrategy;
    const mainSummaries = mainStrategy.getSummariesView();
    assert.equal(
      mainSummaries.length,
      1,
      'main branch must NOT see summaries created on fork',
    );
    assert.equal(mainSummaries[0].content, 'common L1 (pre-fork)');

    // Add a summary unique to main
    mainStrategy.seedL1('unique to main', ['p', 'q']);
    assert.equal(mainStrategy.getSummariesView().length, 2);

    // Switch back to fork: should still have its own divergent state
    await manager.switchBranch(forkedName);
    const forkStrategy = manager.getStrategy() as TestableStrategy;
    const forkSummaries = forkStrategy.getSummariesView();
    assert.equal(forkSummaries.length, 2, 'fork branch should still have 2 summaries');
    assert.equal(forkSummaries[1].content, 'divergent on fork');
    assert.ok(
      !forkSummaries.some(s => s.content === 'unique to main'),
      'fork must not see main-only summary',
    );

    manager.close();
  });

  it('keeps merge queue intact when executeMerge throws (no eager dequeue)', async () => {
    // Regression test for the eager-dequeue footgun: dequeueMerge() used to
    // run *before* the LLM call, so a transient failure (429, network drop,
    // timeout) would silently drop the merge from the persisted queue
    // forever. The fix is peek + shift-on-success — these assertions lock
    // that contract in.
    class FailingMergeStrategy extends TestableStrategy {
      executeMergeError = new Error('simulated LLM failure');

      protected override async executeMerge(
        _level: SummaryLevel,
        _sourceIds: string[],
        _ctx: import('../src/types/index.js').StrategyContext,
      ): Promise<void> {
        throw this.executeMergeError;
      }
    }

    const stubMembrane = {} as unknown as import('@animalabs/membrane').Membrane;

    // Phase 1: enqueue a merge, force tick to fail, verify queue intact
    {
      const strategy = new FailingMergeStrategy({
        targetChunkTokens: 300,
        hierarchical: true,
      });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
        membrane: stubMembrane,
      });

      const m1 = manager.addMessage('User', textBlock('source one'));
      const m2 = manager.addMessage('Claude', textBlock('source two'));
      strategy.seedL1('summary one', [m1]);
      strategy.seedL1('summary two', [m2]);
      strategy.seedMerge(2, ['L1-0', 'L1-1']);
      assert.equal(strategy.getMergeQueueView().length, 1, 'merge enqueued');

      // tick() will pick up the merge, invoke (our failing) executeMerge,
      // and surface the error. The queue must still be intact afterward.
      await assert.rejects(
        () => manager.tick(),
        /simulated LLM failure/,
        'tick should propagate the LLM failure',
      );

      const queue = strategy.getMergeQueueView();
      assert.equal(queue.length, 1, 'merge MUST remain in queue after failure');
      assert.equal(queue[0].level, 2);
      assert.deepEqual(queue[0].sourceIds, ['L1-0', 'L1-1']);

      manager.sync();
      manager.close();
    }

    // Phase 2: reopen the store; the un-merged entry must still be there.
    // This is the part that mattered most pre-fix — the failure was *durable*
    // because dequeueMerge persisted the shorter queue before the LLM call.
    {
      const strategy = new TestableStrategy({
        targetChunkTokens: 300,
        hierarchical: true,
      });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const queue = strategy.getMergeQueueView();
      assert.equal(queue.length, 1, 'merge MUST survive close/reopen');
      assert.equal(queue[0].level, 2);
      assert.deepEqual(queue[0].sourceIds, ['L1-0', 'L1-1']);

      manager.close();
    }
  });
});
