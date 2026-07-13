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
    const entry: SummaryEntry = {
      id: `L2-${this.nextSummaryIdCounter()}`,
      level: 2,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 1,
      sourceIds: sourceL1Ids,
      sourceRange: { first: 'a', last: 'z' },
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

  persistRawSummaries(entries: SummaryEntry[]): void {
    this.store?.setStateJson(this.summariesStateId, entries);
  }

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

      manager.addMessage('User', textBlock('hello'));
      const m2 = manager.addMessage('Claude', textBlock('hi back'));

      strategy.seedL1('summary one', ['a', 'b']);
      strategy.seedL1('summary two', ['c', 'd']);
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
