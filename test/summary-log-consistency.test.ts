/**
 * Regression tests for the setMergedInto index-desync clobber
 * (Lena chronicle, 2026-07: 4 summaries silently overwritten).
 *
 * `loadPersistedState` filters empty-content summaries out of the
 * in-memory array while they remain in the persisted log. The old
 * `setMergedInto` edited the log by IN-MEMORY index, so with any empty
 * entry in the log every merge-update landed one slot early —
 * overwriting a neighboring summary and leaving the intended entry as
 * a duplicate-id pair with diverging mergedInto.
 *
 * Invariants pinned here:
 *   1. setMergedInto edits the log slot with the matching ID, never a
 *      neighbor, even when in-memory indices are shifted.
 *   2. Load dedupes duplicate-id copies, preferring the merged one.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const TEST_STORE_PATH = './test-summary-log-consistency';
const SLOT = 'default/autobio:summaries';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function entry(id: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    level: 1,
    content,
    tokens: Math.max(1, Math.ceil(content.length / 4)),
    sourceLevel: 0,
    sourceIds: ['1', '2'],
    sourceRange: { first: '1', last: '2' },
    created: 1750000000000,
    ...extra,
  };
}

describe('Summary log consistency (clobber regression)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('setMergedInto edits the matching-ID slot, not a shifted neighbor', async () => {
    cleanup();
    // Seed a log whose in-memory view will be SHIFTED: an empty-content
    // entry (filtered on load) sits before two valid entries.
    {
      const strategy = new AutobiographicalStrategy({ recentWindowTokens: 1000 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const store = manager.getStore();
      store.appendToStateJson(SLOT, entry('L1-0', ''));            // empty → filtered on load
      store.appendToStateJson(SLOT, entry('L1-1', 'first real memory'));
      store.appendToStateJson(SLOT, entry('L1-2', 'second real memory'));
      manager.sync();
      await manager.close();
    }

    // Reopen: in-memory summaries = [L1-1, L1-2]; log = [L1-0, L1-1, L1-2].
    const strategy = new AutobiographicalStrategy({ recentWindowTokens: 1000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const s = strategy as any;
    assert.strictEqual(s.summaries.length, 2, 'empty entry filtered on load');

    const target = s.summaries.find((x: any) => x.id === 'L1-1');
    s.setMergedInto(target, 'L2-99');

    const stored = manager.getStore().getStateJson(SLOT) as any[];
    const byId = new Map(stored.map((x) => [x.id, x]));
    assert.strictEqual(stored.length, 3, 'no entries added or lost');
    assert.strictEqual(byId.get('L1-0')?.content, '', 'empty neighbor NOT clobbered');
    assert.strictEqual(byId.get('L1-1')?.mergedInto, 'L2-99', 'merge update landed on the right entry');
    assert.strictEqual(byId.get('L1-2')?.mergedInto, undefined, 'other neighbor untouched');
    await manager.close();
  });

  it('load dedupes duplicate-id copies, preferring the merged one', async () => {
    cleanup();
    {
      const strategy = new AutobiographicalStrategy({ recentWindowTokens: 1000 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const store = manager.getStore();
      // Simulate a clobber-era store: same id twice, merged copy first
      // (the observed shape from the incident), plain copy second.
      store.appendToStateJson(SLOT, entry('L1-5', 'the memory', { mergedInto: 'L2-7' }));
      store.appendToStateJson(SLOT, entry('L1-5', 'the memory'));
      store.appendToStateJson(SLOT, entry('L1-6', 'another memory'));
      manager.sync();
      await manager.close();
    }

    const strategy = new AutobiographicalStrategy({ recentWindowTokens: 1000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const s = strategy as any;
    const copies = s.summaries.filter((x: any) => x.id === 'L1-5');
    assert.strictEqual(copies.length, 1, 'duplicate id deduped on load');
    assert.strictEqual(copies[0].mergedInto, 'L2-7', 'merged copy preferred — plain dupe must not resurrect on the unmerged frontier');
    assert.strictEqual(s.summaries.length, 2);
    await manager.close();
  });
});
