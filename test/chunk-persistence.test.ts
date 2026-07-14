/**
 * Regression tests for chunk-boundary persistence + close-then-compress.
 *
 * Background (Mythos duplication incident, 2026-07; fleet audit):
 *   1. Chunk boundaries were recomputed from a running token sum on every
 *      rebuild; "already compressed" was recovered only by EXACT
 *      message-ID-set match against persisted L1 sourceIds. Any boundary
 *      shift (config change, restart, message mutation, chain break)
 *      re-keyed the tail → mass duplicate L1s over already-lived ground.
 *   2. The trailing PARTIAL chunk (>=4 messages, under targetChunkTokens)
 *      was compressed eagerly on every rebuild while it grew → families of
 *      prefix-generation L1s (same start, growing span), all retained, all
 *      merged upward into the same L2 (content multiplication).
 *
 * New contract pinned here:
 *   - A chunk is compressed only after it CLOSES (running sum reaches
 *     targetChunkTokens); the trailing partial chunk is never compressed.
 *   - Closing a chunk persists a ChunkRecord to the `autobio:chunks`
 *     chronicle state slot; persisted records OWN the past — rebuilds and
 *     restarts never re-chunk covered ground, regardless of config drift.
 *   - L1 production refuses to overlap an existing L1 (strict guard).
 *   - If most records resolve to zero live messages (chain-break
 *     signature), compression fails CLOSED (no re-chunking of history).
 *   - Stores from before this change migrate lazily: records are
 *     synthesized from existing L1 sourceIds, longest generation per
 *     prefix family.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const BASE = './test-chunk-persistence';
let storeSeq = 0;
function freshPath(): string {
  return `${BASE}-${storeSeq++}`;
}
function cleanup() {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

const SUMS = 'default/autobio:summaries';
const CHUNKS = 'default/autobio:chunks';
const TEST_COMPRESSION_MODEL = 'test-compression-model';

interface ApiMessage { participant: string; content: ContentBlock[] }

function mockMembrane() {
  const calls: Array<{ messages: ApiMessage[] }> = [];
  return {
    calls,
    membrane: {
      complete: async (request: { messages: ApiMessage[] }) => {
        calls.push({ messages: request.messages });
        const inputChars = request.messages
          .flatMap((m) => m.content)
          .map((b) => (b as { text?: string }).text ?? '')
          .join('').length;
        const text = `[mock summary inChars=${inputChars}] ` + 'x '.repeat(40);
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: Math.ceil(inputChars / 4), output_tokens: 25 },
        };
      },
    } as any,
  };
}

const t = (s: string): ContentBlock => ({ type: 'text', text: s });

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

function l1s(manager: ContextManager): Array<{ id: string; sourceIds: string[] }> {
  const stored = manager.getStore().getStateJson(SUMS);
  return (Array.isArray(stored) ? stored : []).filter(
    (s: any) => s && s.level === 1,
  );
}

function assertDisjointL1s(entries: Array<{ id: string; sourceIds: string[] }>) {
  const seen = new Map<string, string>();
  for (const s of entries) {
    for (const mid of s.sourceIds ?? []) {
      const prev = seen.get(mid);
      assert.ok(
        prev === undefined || prev === s.id,
        `message ${mid} covered by both ${prev} and ${s.id} — duplicate L1s over the same span`,
      );
      seen.set(mid, s.id);
    }
  }
}

/** ~10 tokens of text per message at estimateTokens' chars/4 heuristic. */
const filler = (i: number) => `message ${i} ` + 'word '.repeat(8);

describe('Chunk persistence: close-then-compress', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('never compresses an unclosed (trailing partial) chunk', async () => {
    const path = freshPath();
    const { membrane, calls } = mockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 1000, // far above what 6 tiny messages reach
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({ path, strategy, membrane });

    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
    await drain(manager);

    assert.strictEqual(
      calls.length,
      0,
      'partial tail chunk (under targetChunkTokens) must not be compressed',
    );
    assert.strictEqual(l1s(manager).length, 0);
    await manager.close();
  });

  it('a growing tail never produces prefix-generation L1 families', async () => {
    const path = freshPath();
    const { membrane } = mockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 120,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({ path, strategy, membrane });

    // Grow in small increments with a full drain between each — the exact
    // pattern that used to mint one L1 generation per drain.
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 4; i++) {
        manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(batch * 4 + i))]);
      }
      await drain(manager);
    }

    const entries = l1s(manager);
    assert.ok(entries.length > 0, 'expected some closed chunks to compress');
    assertDisjointL1s(entries);
    // No two L1s may share a starting message (prefix-family signature).
    const starts = entries.map((s) => s.sourceIds[0]);
    assert.strictEqual(
      new Set(starts).size,
      starts.length,
      'two L1s share a starting message — prefix-generation family detected',
    );
    await manager.close();
  });

  it('persists chunk records when chunks close', async () => {
    const path = freshPath();
    const { membrane } = mockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 100,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      l1HoldbackChunks: 0, // this test asserts EVERY record compresses after drain
    });
    const manager = await ContextManager.open({ path, strategy, membrane });
    for (let i = 0; i < 40; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
    await drain(manager);

    const records = manager.getStore().getStateJson(CHUNKS) as any[];
    assert.ok(Array.isArray(records) && records.length > 0, 'chunk records persisted');
    for (const r of records) {
      assert.ok(typeof r.id === 'string' && r.id.length > 0);
      assert.ok(Array.isArray(r.sourceIds) && r.sourceIds.length >= 4);
      assert.strictEqual(r.compressed, true, `record ${r.id} compressed after drain`);
      assert.ok(typeof r.summaryId === 'string', `record ${r.id} linked to its L1`);
    }
    const l1 = l1s(manager);
    assert.strictEqual(records.length, l1.length, 'one record per L1');
    await manager.close();
  });

  it('restart + config drift does not re-compress covered ground', async () => {
    const path = freshPath();
    const { membrane } = mockMembrane();
    {
      const strategy = new AutobiographicalStrategy({
        compressionModel: TEST_COMPRESSION_MODEL,
        targetChunkTokens: 100,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        hierarchical: true,
      });
      const manager = await ContextManager.open({ path, strategy, membrane });
      for (let i = 0; i < 60; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
      await drain(manager);
      assert.ok(l1s(manager).length >= 3, 'seed store built several L1s');
      await manager.close();
    }

    // Restart with SHIFTED boundary inputs — the pre-fix code re-keys every
    // chunk (exact sourceIds match fails) and re-compresses all of history.
    const fresh = mockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 170, // drifted
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path,
      strategy,
      membrane: fresh.membrane,
    });
    await drain(manager);

    const entries = l1s(manager);
    assertDisjointL1s(entries);
    assert.strictEqual(
      fresh.calls.length,
      0,
      `restart with drifted config re-compressed covered ground (${fresh.calls.length} calls)`,
    );
    await manager.close();
  });

  it('fails closed when chunk records mass-orphan (chain-break signature)', async () => {
    const path = freshPath();
    const { membrane, calls } = mockMembrane();
    // Seed: chunk records referencing message ids that do NOT exist (as after
    // a messages chain break / renumbering), while live messages are present.
    {
      const strategy = new AutobiographicalStrategy({
        compressionModel: TEST_COMPRESSION_MODEL,
        recentWindowTokens: 1000,
      });
      const manager = await ContextManager.open({ path, strategy, membrane });
      const store = manager.getStore();
      try {
        store.registerState({ id: CHUNKS, strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 10 });
      } catch { /* registered by strategy already */ }
      for (let c = 0; c < 4; c++) {
        store.appendToStateJson(CHUNKS, {
          id: `c-${c}`,
          sourceIds: [`ghost-${c}-a`, `ghost-${c}-b`, `ghost-${c}-c`, `ghost-${c}-d`],
          compressed: true,
          summaryId: `L1-${c}`,
        });
      }
      manager.sync();
      await manager.close();
    }

    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 100,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({ path, strategy, membrane });
    for (let i = 0; i < 60; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
    await drain(manager);

    assert.strictEqual(
      calls.length,
      0,
      'mass-orphaned records must fail closed: no compression until an operator looks',
    );
    assert.strictEqual(l1s(manager).length, 0);
    await manager.close();
  });

  it('migrates legacy stores: synthesizes records, collapses prefix families, no recompression', async () => {
    const path = freshPath();
    const { membrane, calls } = mockMembrane();
    // Seed a LEGACY store: messages + L1 summaries, NO chunks slot.
    // Includes a prefix family (L1-1 ⊂ L1-2) from the old partial-tail bug.
    {
      const strategy = new AutobiographicalStrategy({
        compressionModel: TEST_COMPRESSION_MODEL,
        recentWindowTokens: 100000,
      });
      const manager = await ContextManager.open({ path, strategy, membrane });
      const store = manager.getStore();
      const ids: string[] = [];
      for (let i = 0; i < 16; i++) {
        const m = manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
        ids.push((m as any).id ?? String(i));
      }
      const mk = (id: string, src: string[], extra: Record<string, unknown> = {}) => ({
        id,
        level: 1,
        content: `memory ${id}`,
        tokens: 10,
        sourceLevel: 0,
        sourceIds: src,
        sourceRange: { first: src[0], last: src[src.length - 1] },
        created: 1750000000000,
        ...extra,
      });
      store.appendToStateJson(SUMS, mk('L1-0', ids.slice(0, 6)));
      store.appendToStateJson(SUMS, mk('L1-1', ids.slice(6, 10)));  // stale generation
      store.appendToStateJson(SUMS, mk('L1-2', ids.slice(6, 14)));  // superset, same start
      manager.sync();
      await manager.close();
    }

    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 100,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({ path, strategy, membrane });
    await drain(manager);

    const records = manager.getStore().getStateJson(CHUNKS) as any[];
    assert.ok(Array.isArray(records), 'migration created the chunks slot');
    const bySummary = new Map(records.map((r: any) => [r.summaryId, r]));
    assert.ok(bySummary.has('L1-0'), 'record synthesized for L1-0');
    assert.ok(bySummary.has('L1-2'), 'record synthesized for longest generation L1-2');
    assert.ok(!bySummary.has('L1-1'), 'stale prefix generation L1-1 gets NO record');
    // Covered ground must not be re-compressed; only the uncovered tail
    // (ids[14..15], 2 messages — under min chunk length) may ever compress,
    // and it cannot close here, so: zero calls.
    assert.strictEqual(calls.length, 0, 'migration must not trigger recompression');
    await manager.close();
  });
});
