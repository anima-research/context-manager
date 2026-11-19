import { describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsStore } from '@animalabs/chronicle';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

type Config = ConstructorParameters<typeof AutobiographicalStrategy>[0];
type Answer = { content: unknown[]; stopReason: string; usage: { inputTokens: number; outputTokens: number }; raw?: unknown };

const MODEL = 'test-compression-model';
const SUMS = 'default/autobio:summaries';
const CHUNKS = 'default/autobio:chunks';
const MERGE_QUEUE = 'default/autobio:mergeQueue';
const MERGE_QUARANTINE = 'default/autobio:merge-quarantine';
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const say = (i: number) => `message ${i}: ` + 'a considered sentence about the work at hand. '.repeat(3);
const OK: Answer = { content: [text('A summary of what happened.')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
const REFUSAL: Answer = {
  content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
  raw: { response: { stop_details: { category: 'reasoning_extraction' } } },
};

function membraneOf(handler: (request: NormalizedRequest) => Answer = () => OK) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        return handler(request);
      },
    } as never,
  };
}

function config(extra: Partial<Config> = {}): Config {
  return {
    compressionModel: MODEL,
    targetChunkTokens: 100,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    l1HoldbackChunks: 0,
    minChunkCharsForLLM: 0,
    ...extra,
  } as Config;
}

function storePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-persisted-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store');
}

function logged(method: 'warn' | 'error', t: TestContext): (pattern: RegExp) => number {
  const spy = mock.method(console, method, () => {});
  t.after(() => spy.mock.restore());
  return (pattern) => spy.mock.calls.filter((call) => pattern.test(String(call.arguments[0]))).length;
}

function pendingChunks(manager: ContextManager): number {
  const match = manager.getPendingWork()?.description.match(/(\d+) chunks/);
  return match ? Number(match[1]) : 0;
}

let said = 0;
function closeChunks(manager: ContextManager, n: number): void {
  const target = pendingChunks(manager) + n;
  for (let added = 0; pendingChunks(manager) < target; added++) {
    assert.ok(added < 50 * n, `premise: ${n} more chunk(s) close (${manager.getPendingWork()?.description})`);
    manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said))]);
    said++;
  }
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 300 && !manager.isReady(); i++) await manager.tick().catch(() => {});
  assert.ok(manager.isReady(), `premise: the queue drained (${manager.getPendingWork()?.description})`);
}

function l1(id: string, sourceIds: string[]) {
  return {
    id, level: 1, content: `memory ${id}`, tokens: 10, sourceLevel: 0, sourceIds,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] }, created: 1750000000000,
  };
}

async function seeded(t: TestContext, write: (store: JsStore, ids: string[]) => void, messages = 8): Promise<{ path: string; ids: string[] }> {
  const path = storePath(t);
  const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy({ compressionModel: MODEL, recentWindowTokens: 1_000_000 }) });
  const ids: string[] = [];
  for (let i = 0; i < messages; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(i))]));
  write(manager.getStore(), ids);
  manager.sync();
  manager.close();
  return { path, ids };
}

const ghosts = (n: number) => [`ghost-${n}-a`, `ghost-${n}-b`, `ghost-${n}-c`, `ghost-${n}-d`];

describe('compression lifecycle: persisted state', () => {
  it('three chunk records, two naming no live message, fail the rebuild closed, logged once however many rebuilds follow', async (t) => {
    const { path } = await seeded(t, (store, ids) => {
      store.appendToStateJson(CHUNKS, { id: 'c-0', sourceIds: ghosts(0), compressed: true, summaryId: 'L1-0' });
      store.appendToStateJson(CHUNKS, { id: 'c-1', sourceIds: ghosts(1), compressed: true, summaryId: 'L1-1' });
      store.appendToStateJson(CHUNKS, { id: 'c-2', sourceIds: ids.slice(0, 4), compressed: false });
    });
    const failClosed = logged('error', t);
    const { membrane, calls } = membraneOf();
    const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config()), membrane });
    for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(100 + i))]);
    await drain(manager);
    assert.equal(calls.length, 0, 'no compression until an operator looks');
    assert.equal(failClosed(/FAIL-CLOSED/), 1);
    manager.close();
  });

  it('a chunk record fully covered by summaries under other boundaries is left uncompressed in the store as a breadcrumb', async (t) => {
    const { path } = await seeded(t, (store, ids) => {
      store.appendToStateJson(CHUNKS, { id: 'c-0', sourceIds: ids.slice(0, 4), compressed: false });
      store.appendToStateJson(SUMS, l1('L1-90', ids.slice(0, 2)));
      store.appendToStateJson(SUMS, l1('L1-91', ids.slice(2, 4)));
    });
    const dropped = logged('warn', t);
    const { membrane, calls } = membraneOf();
    const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config()), membrane });
    await manager.tick();
    assert.equal(dropped(/dedup guard: chunk c-0 is fully covered/), 1, 'premise: the chunk was dropped as covered');
    assert.equal(calls.length, 0);
    const records = manager.getStore().getStateJson(CHUNKS) as Array<{ id: string; compressed: boolean }>;
    assert.equal(records.find((r) => r.id === 'c-0')?.compressed, false);
    manager.close();
  });

  it('a chunk the overlap guard keeps out of the queue counts as pending compression debt', async (t) => {
    const { path } = await seeded(t, (store, ids) => {
      store.appendToStateJson(CHUNKS, { id: 'c-0', sourceIds: ids.slice(0, 4), compressed: false });
      store.appendToStateJson(CHUNKS, { id: 'c-1', sourceIds: ids.slice(4, 8), compressed: false });
      store.appendToStateJson(SUMS, l1('L1-90', ids.slice(2, 4)));
    });
    const overlap = logged('error', t);
    const strategy = new AutobiographicalStrategy(config());
    const manager = await ContextManager.open({ path, strategy, membrane: membraneOf().membrane });
    await drain(manager);
    assert.equal(overlap(/OVERLAP GUARD: refusing to compress chunk c-0/), 1, 'premise: the guard refused the partly covered chunk');
    assert.equal(strategy.getCompressionDebt().pendingChunks, 1);
    manager.close();
  });

  it('a strategy without chunk records logs the overlap guard once for a chunk it refuses on every attempt', async (t) => {
    class NoChunkRecords extends AutobiographicalStrategy {
      protected override get chunkPersistenceEnabled(): boolean {
        return false;
      }
    }
    const { path } = await seeded(t, (store, ids) => {
      store.appendToStateJson(SUMS, l1('L1-90', ids.slice(2, 6)));
    });
    const overlap = logged('error', t);
    const { membrane, calls } = membraneOf();
    const manager = await ContextManager.open({ path, strategy: new NoChunkRecords(config()), membrane });
    for (let i = 0; i < 3; i++) {
      manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(200 + i))]);
      await manager.tick();
    }
    assert.equal(calls.length, 0, 'premise: each tick met the partly covered chunk first');
    assert.equal(overlap(/OVERLAP GUARD/), 1);
    manager.close();
  });

  it('the paid-off sweep clears a quarantine record whose chunk record is compressed', async (t) => {
    const path = storePath(t);
    logged('error', t);
    const first = new AutobiographicalStrategy(config({ compressionRefusalCurveFallbacks: 0 }));
    let manager = await ContextManager.open({ path, strategy: first, membrane: membraneOf(() => REFUSAL).membrane });
    closeChunks(manager, 1);
    await manager.tick();
    assert.equal(first.getCompressionQuarantineStatus().count, 1, 'premise: the refused chunk is quarantined');
    manager.close();
    const second = new AutobiographicalStrategy(config({ compressionRefusalCurveFallbacks: 0, summaryTargetTokens: 1500 }));
    manager = await ContextManager.open({ path, strategy: second, membrane: membraneOf().membrane });
    const store = manager.getStore();
    const append = store.appendToStateJsonWithIdentity.bind(store);
    let faults = 0;
    mock.method(store, 'appendToStateJsonWithIdentity', (...args: Parameters<typeof append>) => {
      if (faults === 0 && (args[1] as { kind?: string } | null)?.kind === 'clear') {
        faults++;
        throw new Error('zz store fault');
      }
      return append(...args);
    });
    await manager.tick();
    assert.equal(faults, 1, 'premise: the clear after the chunk compressed failed');
    assert.equal(second.getCompressionQuarantineStatus().count, 1, 'premise: the record stands beside its compressed chunk record');
    await manager.tick();
    assert.equal(second.getCompressionQuarantineStatus().count, 0);
    manager.close();
  });

  it('a merge-quarantine topology record goes, with a log line, once its group queues as a valid merge', async (t) => {
    const path = storePath(t);
    {
      const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config({ hierarchical: true, mergeThreshold: 99 })), membrane: membraneOf().membrane });
      closeChunks(manager, 3);
      await drain(manager);
      manager.close();
    }
    {
      const probe = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config({ hierarchical: true, mergeThreshold: 2 })) });
      const store = probe.getStore();
      const queued = store.getStateJson(MERGE_QUEUE) as Array<{ level: number; sourceIds: string[] }>;
      assert.equal(queued?.length, 1, `premise: one merge queued (${JSON.stringify(queued)})`);
      const group = queued[0]!;
      store.setStateJson(MERGE_QUEUE, []);
      store.setStateJson(MERGE_QUARANTINE, [{
        key: createHash('sha256').update(JSON.stringify(group.sourceIds), 'utf8').digest('hex'),
        level: group.level,
        sourceIds: group.sourceIds,
        attempts: 1,
        lastOutcome: 'topology_violation',
        quarantinedAt: Date.now(),
      }]);
      probe.sync();
      probe.close();
    }
    const cleared = logged('warn', t);
    const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config({ hierarchical: true, mergeThreshold: 2 })) });
    assert.equal(cleared(/\[merge-quarantine\] cleared topology record/), 1);
    assert.deepEqual(manager.getStore().getStateJson(MERGE_QUARANTINE), []);
    manager.close();
  });

  it('an auditOnly open keeps a persisted merge the current grammar refuses', async (t) => {
    const path = storePath(t);
    {
      const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config({ hierarchical: true, mergeThreshold: 99 })), membrane: membraneOf().membrane });
      closeChunks(manager, 3);
      await drain(manager);
      const [first, , third] = (manager.getStore().getStateJson(SUMS) as Array<{ id: string; level: number }>).filter((s) => s.level === 1);
      assert.ok(first && third, 'premise: three L1s');
      manager.getStore().setStateJson(MERGE_QUEUE, [{ level: 2, sourceIds: [first.id, third.id], attempts: 0 }]);
      manager.sync();
      manager.close();
    }
    const discarded = logged('warn', t);
    const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config({ hierarchical: true, mergeThreshold: 99, auditOnly: true })) });
    assert.equal(discarded(/discarded \d+ stale\/non-contiguous persisted merge queue/), 0);
    assert.equal((manager.getStore().getStateJson(MERGE_QUEUE) as unknown[]).length, 1);
    manager.close();
  });
});
