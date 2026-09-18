/**
 * Tests for the summary table-of-contents API (`listSummariesInRange` /
 * `getMaxSummaryLevel`, `SummaryOverviewStrategy`).
 *
 * Read-only browse over the existing summary archive by time range — no
 * generation. Distinct from `searchSummaries` (search.test.ts), which
 * matches summary *content*; this lists summaries whose *source message
 * span* overlaps a wall-clock range, for a downstream "browse my history"
 * tool (agent-framework) that wants a table-of-contents rather than a
 * grep.
 *
 * Covers:
 *  - a summary fully inside the query range
 *  - a summary fully outside the range (excluded)
 *  - a summary that only partially overlaps a range boundary (included —
 *    interval overlap, not full-containment)
 *  - level filtering
 *  - getMaxSummaryLevel with zero and multiple summaries present
 *  - a non-autobiographical strategy (PassthroughStrategy) returning
 *    `[]`/`0` rather than throwing through the ContextManager passthrough
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';

const TEST_STORE_PATH = './test-summary-overview';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/**
 * Directly rewrite a stored message's timestamp via chronicle's raw
 * editStateItem — MessageStore.append() always stamps `Date.now()` and
 * exposes no public way to override it, but boundary tests need
 * deterministically spaced timestamps. Same helper as
 * test/message-store-history-index.test.ts.
 */
function setTimestamp(store: JsStore, stateId: string, index: number, ms: number): void {
  const item = store.getStateItemJson(stateId, index) as Record<string, unknown>;
  store.editStateItem(stateId, index, Buffer.from(JSON.stringify({ ...item, timestamp: ms })));
}

class SeedableStrategy extends AutobiographicalStrategy {
  seedSummary(
    content: string,
    level: SummaryLevel,
    sourceRange: { first: string; last: string },
    sourceIds: string[],
    parentId?: string,
  ): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L${level}-${this.nextSummaryIdCounter()}`,
      level,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds,
      sourceRange,
      created: Date.now(),
      ...(parentId ? { parentId } : {}),
    };
    this.pushSummary(entry);
    return entry;
  }
}

describe('SummaryOverviewStrategy — listSummariesInRange / getMaxSummaryLevel', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('includes a summary fully inside the range, excludes one fully outside', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({ store, strategy });

    // Messages 0,1 -> summary A's source span; messages 2,3 -> summary B's.
    const aFirst = manager.addMessage('User', textBlock('a1'));
    const aLast = manager.addMessage('User', textBlock('a2'));
    const bFirst = manager.addMessage('User', textBlock('b1'));
    const bLast = manager.addMessage('User', textBlock('b2'));
    setTimestamp(store, 'messages', 0, 1_000);
    setTimestamp(store, 'messages', 1, 2_000);
    setTimestamp(store, 'messages', 2, 100_000);
    setTimestamp(store, 'messages', 3, 101_000);

    const inside = strategy.seedSummary('inside range', 1, { first: aFirst, last: aLast }, [aFirst, aLast]);
    strategy.seedSummary('outside range', 1, { first: bFirst, last: bLast }, [bFirst, bLast]);

    const results = manager.getSummariesInRange({ fromMs: 0, toMs: 10_000 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, inside.id);
    assert.equal(results[0].startMs, 1_000);
    assert.equal(results[0].endMs, 2_000);
    assert.equal(results[0].content, 'inside range');
    assert.deepEqual(results[0].sourceIds, [aFirst, aLast]);

    manager.close();
    store.close();
  });

  it('includes a summary that only partially overlaps a range boundary', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({ store, strategy });

    const first = manager.addMessage('User', textBlock('m1'));
    const last = manager.addMessage('User', textBlock('m2'));
    setTimestamp(store, 'messages', 0, 5_000);
    setTimestamp(store, 'messages', 1, 15_000);

    strategy.seedSummary('straddles the upper boundary', 1, { first, last }, [first, last]);

    // Query range [0, 10_000] only overlaps the summary's [5_000, 15_000]
    // span, doesn't contain it — should still be returned.
    const overlapping = manager.getSummariesInRange({ fromMs: 0, toMs: 10_000 });
    assert.equal(overlapping.length, 1, 'partial overlap at a boundary must be included');

    // A range entirely before the summary's span must exclude it.
    const nonOverlapping = manager.getSummariesInRange({ fromMs: 0, toMs: 4_000 });
    assert.equal(nonOverlapping.length, 0);

    manager.close();
    store.close();
  });

  it('level filter restricts results to the requested level', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({ store, strategy });

    const m1 = manager.addMessage('User', textBlock('m1'));
    const m2 = manager.addMessage('User', textBlock('m2'));
    setTimestamp(store, 'messages', 0, 1_000);
    setTimestamp(store, 'messages', 1, 2_000);

    strategy.seedSummary('level 1 summary', 1, { first: m1, last: m2 }, [m1, m2]);
    strategy.seedSummary('level 2 summary', 2, { first: m1, last: m2 }, [m1, m2]);

    const all = manager.getSummariesInRange({});
    assert.equal(all.length, 2);

    const l2only = manager.getSummariesInRange({ level: 2 });
    assert.equal(l2only.length, 1);
    assert.equal(l2only[0].level, 2);
    assert.equal(l2only[0].content, 'level 2 summary');

    manager.close();
    store.close();
  });

  it('getMaxSummaryLevel is 0 with no summaries, and the true max once seeded', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({ store, strategy });

    assert.equal(manager.getMaxSummaryLevel(), 0);

    const m1 = manager.addMessage('User', textBlock('m1'));
    const m2 = manager.addMessage('User', textBlock('m2'));
    setTimestamp(store, 'messages', 0, 1_000);
    setTimestamp(store, 'messages', 1, 2_000);

    strategy.seedSummary('l1', 1, { first: m1, last: m2 }, [m1, m2]);
    strategy.seedSummary('l3', 3, { first: m1, last: m2 }, [m1, m2]);
    strategy.seedSummary('l2', 2, { first: m1, last: m2 }, [m1, m2]);

    assert.equal(manager.getMaxSummaryLevel(), 3);

    manager.close();
    store.close();
  });

  it('exposes parentId so a caller can detect a folded child superseded by a present parent', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({ store, strategy });

    const m1 = manager.addMessage('User', textBlock('m1'));
    const m2 = manager.addMessage('User', textBlock('m2'));
    setTimestamp(store, 'messages', 0, 1_000);
    setTimestamp(store, 'messages', 1, 2_000);

    const parent = strategy.seedSummary('level 2 rollup', 2, { first: m1, last: m2 }, [m1, m2]);
    const child = strategy.seedSummary('level 1 chunk', 1, { first: m1, last: m2 }, [m1, m2], parent.id);

    const results = manager.getSummariesInRange({});
    assert.equal(results.length, 2, 'both the folded child and its parent overlap the range and both come back — no fold-status filtering in this method');

    const childResult = results.find((r) => r.id === child.id);
    const parentResult = results.find((r) => r.id === parent.id);
    assert.equal(childResult?.parentId, parent.id);
    assert.equal(parentResult?.parentId, undefined, 'a root/unfolded summary has no parentId');

    manager.close();
    store.close();
  });

  it('a non-autobiographical strategy returns [] / 0 rather than throwing', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new PassthroughStrategy(),
    });

    assert.deepEqual(manager.getSummariesInRange({}), []);
    assert.equal(manager.getMaxSummaryLevel(), 0);

    manager.close();
  });
});
