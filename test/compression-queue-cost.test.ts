import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../src/context-manager.js';
import { AutobiographicalStrategy, type Chunk } from '../src/strategies/autobiographical.js';

type Lane = {
  chunks: Chunk[];
  compressionQueue: number[];
  compressionFailureOrder: Map<string, number>;
  compressionNotBefore: Map<string, number>;
  compressionFailureRuns: Map<string, unknown>;
  mergeFailureOrder: Map<string, number>;
  mergeFailureRuns: Map<string, unknown>;
  mergeQueue: Array<{ level: number; sourceIds: string[] }>;
  chunkKey(chunk: Chunk): string;
  orderCompressionQueue(): void;
};

it('public add does no population-sized failure bookkeeping at 10, 100 and 1000 skipped chunks', async (t) => {
  const samples: unknown[] = [];
  for (const population of [10, 100, 1000]) {
    const dir = mkdtempSync(join(tmpdir(), 'queue-cost-'));
    const strategy = new AutobiographicalStrategy({
      autoTickOnNewMessage: false, compressionModel: 'offline', targetChunkTokens: 100,
      headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 1, quarantineAlarmIntervalMs: 0,
    });
    const manager = await ContextManager.open({ path: dir, strategy });
    const lane = strategy as unknown as Lane;
    let message = 0;
    const add = () => manager.addMessage(message++ % 2 ? 'Claude' : 'User', [
      { type: 'text', text: 'word '.repeat(110) },
    ]);
    try {
      for (let i = 0; i < (population + 2) * 4; i++) add();
      // Same in-memory representation tick gives quarantine-skipped work.
      // Seed it deterministically, not by making 1000 provider calls. Include
      // live failure runs, window waits and queued merges, not just orders.
      const failed = lane.chunks.slice(0, population);
      for (let i = 0; i < failed.length; i++) {
        const key = lane.chunkKey(failed[i]!);
        lane.compressionFailureOrder.set(key, population - i);
        lane.compressionNotBefore.set(key, Date.now() + 60_000);
        lane.compressionFailureRuns.set(key, { chunkKey: key, run: { key, domain: 'offline', failures: 1, atLanded: 0 } });
        const merge = { level: 2, sourceIds: [`source-${i}`] };
        const mergeKey = `2\0source-${i}`;
        lane.mergeQueue.push(merge);
        lane.mergeFailureOrder.set(mergeKey, population - i);
        lane.mergeFailureRuns.set(mergeKey, { key: mergeKey, domain: 'offline', failures: 1, atLanded: 0 });
      }
      lane.orderCompressionQueue(); // State-change maintenance, outside add.
      let keys = 0, mapReads = 0, visits = 0, orders = 0, mergeVisits = 0;
      const chunkKey = lane.chunkKey;
      lane.chunkKey = function (chunk) { keys++; return chunkKey.call(this, chunk); };
      const order = lane.orderCompressionQueue;
      lane.orderCompressionQueue = function () { orders++; return order.call(this); };
      for (const map of [lane.compressionFailureOrder, lane.compressionNotBefore,
        lane.compressionFailureRuns, lane.mergeFailureOrder, lane.mergeFailureRuns]) {
        for (const method of ['get', 'has'] as const) {
          const original = map[method];
          Object.defineProperty(map, method, { value(key: string) { mapReads++; return original.call(map, key); } });
        }
        for (const method of ['keys', 'values', 'entries', Symbol.iterator] as const) {
          const original = (map as any)[method];
          Object.defineProperty(map, method, { value: function* () {
            for (const item of original.call(map)) { visits++; yield item; }
          } });
        }
      }
      const iterateMerges = lane.mergeQueue[Symbol.iterator];
      Object.defineProperty(lane.mergeQueue, Symbol.iterator, { value: function* () {
        for (const merge of iterateMerges.call(lane.mergeQueue)) { mergeVisits++; yield merge; }
      } });
      const mapMerges = lane.mergeQueue.map;
      Object.defineProperty(lane.mergeQueue, 'map', { value(callback: (merge: unknown, index: number, array: unknown[]) => unknown) {
        return mapMerges.call(lane.mergeQueue, (merge, index, array) => {
          mergeVisits++; return callback(merge, index, array);
        });
      } });
      const before = lane.chunks.length;
      // Cross two chunk closures AND holdback releases, so this is not merely
      // a cache hit on an insertion that leaves queue membership unchanged.
      for (let i = 0; i < 8; i++) {
        keys = mapReads = visits = orders = mergeVisits = 0;
        add();
        const sample = { population, insertion: i, keys, mapReads, visits, orders, mergeVisits };
        samples.push(sample);
        assert.deepEqual({ keys, mapReads, visits, orders, mergeVisits },
          { keys: 0, mapReads: 0, visits: 0, orders: 0, mergeVisits: 0 }, JSON.stringify(sample));
      }
      assert.equal(lane.chunks.length, before + 2);
      const expected = lane.chunks.slice(0, -1).map((chunk) => chunk.index)
        .filter((index) => index >= population).concat(failed.map((chunk) => chunk.index).reverse());
      assert.deepEqual(lane.compressionQueue, expected, 'fresh/new work then least-recently-failed work, with holdback intact');
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  t.diagnostic(JSON.stringify(samples));
});

it('a cached rebuild still prunes decided chunks and withdrawn merges, and recuts removed sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-invalidation-'));
  const strategy = new AutobiographicalStrategy({
    autoTickOnNewMessage: false, compressionModel: 'offline', targetChunkTokens: 100,
    headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0,
  });
  const manager = await ContextManager.open({ path: dir, strategy });
  const lane = strategy as unknown as Lane & {
    markChunkRecordCompressed(recordId: string | undefined, summaryId: string): void;
    dequeueMerge(): unknown;
  };
  let sequence = 0;
  const add = () => manager.addMessage(sequence++ % 2 ? 'Claude' : 'User', [
    { type: 'text', text: 'word '.repeat(110) },
  ]);
  const seed = (chunk: Chunk) => {
    const key = lane.chunkKey(chunk);
    lane.compressionFailureOrder.set(key, 1);
    lane.compressionNotBefore.set(key, Date.now() + 60_000);
    lane.compressionFailureRuns.set(key, { chunkKey: key, run: { key, domain: 'offline', failures: 1, atLanded: 0 } });
    return key;
  };
  try {
    for (let i = 0; i < 24; i++) add();
    const decided = lane.chunks[0]!;
    const removed = lane.chunks[1]!;
    const decidedKey = seed(decided), removedKey = seed(removed);
    lane.mergeQueue.push({ level: 2, sourceIds: ['old-merge'] });
    const mergeKey = '2\0old-merge';
    lane.mergeFailureOrder.set(mergeKey, 1);
    lane.mergeFailureRuns.set(mergeKey, {});
    lane.orderCompressionQueue();
    add(); // cached
    lane.markChunkRecordCompressed(decided.recordId, 'decided-summary');
    lane.dequeueMerge();
    add(); // dirty: must prune before publishing the next queue
    assert.equal(lane.compressionFailureOrder.has(decidedKey), false);
    assert.equal(lane.compressionNotBefore.has(decidedKey), false);
    assert.equal(lane.compressionFailureRuns.has(decidedKey), false);
    assert.equal(lane.mergeFailureOrder.has(mergeKey), false);
    assert.equal(lane.mergeFailureRuns.has(mergeKey), false);
    assert.equal(lane.compressionFailureOrder.has(removedKey), true);
    manager.removeMessage(removed.messages[0]!.id);
    add();
    assert.equal(lane.compressionFailureOrder.has(removedKey), false);
    assert.equal(lane.compressionNotBefore.has(removedKey), false);
    assert.equal(lane.compressionFailureRuns.has(removedKey), false);
    const ordered = lane.compressionQueue.slice();
    lane.orderCompressionQueue();
    assert.deepEqual(lane.compressionQueue, ordered, 'cached and full ordering agree after recut');
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
