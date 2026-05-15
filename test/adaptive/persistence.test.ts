/**
 * Tests that adaptive-resolution state (currentResolution + lockedByAgent)
 * survives a close-and-reopen of the ContextManager.
 *
 * Without these slots persisted, a process restart would re-run the picker
 * from scratch on first compile, almost certainly producing a different
 * fold pattern → full KV invalidation. The chronicle slots ensure the
 * picker resumes where it left off.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-persistence-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function makeMockMembrane() {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      return {
        content: [{ type: 'text', text: `[mock summary #${callCount}]` }],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

describe('AutobiographicalStrategy — adaptive state persistence', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('resolutions survive close + reopen', async () => {
    // Phase 1: open, ingest, compile under pressure, capture resolutions
    const mock1 = makeMockMembrane();
    const strategy1 = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager1 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy1,
      membrane: mock1 as any,
    });
    for (let i = 0; i < 40; i++) {
      manager1.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(60) }]);
    }
    while (!manager1.isReady()) {
      await manager1.tick();
    }
    // Force folding with a tight budget
    await manager1.compile({ maxTokens: 1500, reserveForResponse: 200 });
    const phase1Resolutions = new Map((strategy1 as any).resolutions);
    // Debug: log what we have
    if (phase1Resolutions.size === 0) {
      const stats = (strategy1 as any).getStats?.() ?? {};
      console.error('phase 1 resolutions empty; stats:', stats);
    }
    assert.ok(phase1Resolutions.size > 0, `phase 1 should have folded at least some messages; got ${phase1Resolutions.size}`);
    manager1.close();

    // Phase 2: reopen with a fresh strategy instance, verify resolutions restored
    const mock2 = makeMockMembrane();
    const strategy2 = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager2 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy2,
      membrane: mock2 as any,
    });
    // Without compiling, the strategy.resolutions should already be populated from chronicle
    const phase2Resolutions = new Map((strategy2 as any).resolutions);
    assert.equal(
      phase2Resolutions.size,
      phase1Resolutions.size,
      `phase 2 should have ${phase1Resolutions.size} resolutions; got ${phase2Resolutions.size}`
    );
    for (const [id, level] of phase1Resolutions) {
      assert.equal(
        phase2Resolutions.get(id),
        level,
        `message ${id}: phase 1 had L${level}, phase 2 has L${phase2Resolutions.get(id)}`
      );
    }
    manager2.close();
  });

  it('locks survive close + reopen', async () => {
    const mock1 = makeMockMembrane();
    const strategy1 = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager1 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy1,
      membrane: mock1 as any,
    });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(manager1.addMessage('User', [{ type: 'text', text: `Turn ${i}` }]));
    }
    // Lock a couple of messages
    strategy1.lockChunk(ids[2]);
    strategy1.lockChunk(ids[5]);
    manager1.close();

    // Reopen
    const mock2 = makeMockMembrane();
    const strategy2 = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager2 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy2,
      membrane: mock2 as any,
    });
    const lockedAfterReopen = (strategy2 as any).locked as Set<string>;
    assert.equal(lockedAfterReopen.size, 2);
    assert.ok(lockedAfterReopen.has(ids[2]), `${ids[2]} should be locked after reopen`);
    assert.ok(lockedAfterReopen.has(ids[5]), `${ids[5]} should be locked after reopen`);
    manager2.close();
  });

  it('unlocking persists too', async () => {
    const mock1 = makeMockMembrane();
    const strategy1 = new AutobiographicalStrategy({
      adaptiveResolution: true,
    });
    const manager1 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy1,
      membrane: mock1 as any,
    });
    const id = manager1.addMessage('User', [{ type: 'text', text: 'msg' }]);
    strategy1.lockChunk(id);
    strategy1.unlockChunk(id);
    manager1.close();

    const strategy2 = new AutobiographicalStrategy({ adaptiveResolution: true });
    const manager2 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy2,
      membrane: makeMockMembrane() as any,
    });
    const lockedAfter = (strategy2 as any).locked as Set<string>;
    assert.equal(lockedAfter.size, 0, 'after lock+unlock+reopen, no locks should remain');
    manager2.close();
  });

  it('compile after reopen produces same fold pattern (no thrashing)', async () => {
    // Phase 1: drive compression and folding
    const mock1 = makeMockMembrane();
    const strategy1 = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager1 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy1,
      membrane: mock1 as any,
    });
    for (let i = 0; i < 18; i++) {
      manager1.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]);
    }
    while (!manager1.isReady()) {
      await manager1.tick();
    }
    const compileA = await manager1.compile({ maxTokens: 3000, reserveForResponse: 200 });
    const resolutionsA = new Map((strategy1 as any).resolutions);
    manager1.close();

    // Phase 2: reopen, compile with same budget
    const mock2 = makeMockMembrane();
    const strategy2 = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager2 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy2,
      membrane: mock2 as any,
    });
    while (!manager2.isReady()) {
      await manager2.tick();
    }
    const compileB = await manager2.compile({ maxTokens: 3000, reserveForResponse: 200 });
    const resolutionsB = new Map((strategy2 as any).resolutions);

    // Resolutions should be identical — no thrashing across the reopen.
    for (const [id, levelA] of resolutionsA) {
      const levelB = resolutionsB.get(id);
      assert.equal(
        levelB,
        levelA,
        `after reopen, message ${id} should still be at L${levelA}, got L${levelB}`
      );
    }

    // Compile output should also be substantially equivalent — same number of
    // entries with same participants in same order. (Exact text may differ
    // because the mock LLM uses an incrementing callCount.)
    assert.equal(
      compileB.messages.length,
      compileA.messages.length,
      `compile entry count differs after reopen (was ${compileA.messages.length}, now ${compileB.messages.length})`
    );
    manager2.close();
  });
});
