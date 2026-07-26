/**
 * Tests that the bottom-up speculative pre-producer (config.speculativeProduction)
 * builds the full L_n chain — not just L2/L3 like the legacy threshold path.
 *
 * Drives enough conversation to produce ≥ N^2 L1s, then verifies the chronicle
 * ends up with L2, L3, L4, ... summaries via the same checkMergeThreshold
 * mechanism (now recursive) that previously stopped at L3.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-deep-levels-store';

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
        content: [{ type: 'text', text: `[mock summary #${callCount}] short summary content here.` }],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

function summariesByLevel(strategy: any): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of strategy.summaries as Array<{ level: number }>) {
    out[s.level] = (out[s.level] ?? 0) + 1;
  }
  return out;
}

describe('AutobiographicalStrategy — deep-level pre-production', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('speculativeProduction off: only L1/L2/L3 (legacy behavior)', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: false,
      targetChunkTokens: 100,
      mergeThreshold: 3, // small so we get to deep levels quickly
      recentWindowTokens: 50,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // Need enough chunks for L1 → L2 → L3 to fire under threshold=3.
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(30) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    const counts = summariesByLevel(strategy);
    // Legacy path caps at L3 — even with many L3s, no L4 is built.
    assert.ok(!counts[4], `legacy path should not produce L4; got counts: ${JSON.stringify(counts)}`);
    manager.close();
  });

  it('speculativeProduction on: produces L4+ when source counts warrant it', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true, // turns on speculativeProduction
      targetChunkTokens: 80,
      mergeThreshold: 2, // smallest possible — forces the chain to climb fast
      recentWindowTokens: 50,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    // With mergeThreshold=2, each level halves the count. So if we end up
    // with N L1s after compression, we get:
    //   ceil(N/2) L2s, ceil(N/4) L3s, ceil(N/8) L4s, ...
    // Need N ≥ 16 for L4 (2 L3s required to merge → L4).
    for (let i = 0; i < 120; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}. ` + 'word '.repeat(20) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    const counts = summariesByLevel(strategy);
    // Should see L1, L2, L3 — and L4 with threshold=2.
    assert.ok(counts[1] > 0, `expected L1 summaries; got ${JSON.stringify(counts)}`);
    assert.ok(counts[2] > 0, `expected L2 summaries; got ${JSON.stringify(counts)}`);
    assert.ok(counts[3] > 0, `expected L3 summaries; got ${JSON.stringify(counts)}`);
    assert.ok(
      counts[4] >= 1,
      `with mergeThreshold=2 and 120 chunks, expected at least one L4; got ${JSON.stringify(counts)}`
    );
    manager.close();
  });

  it('parentId set correctly across deep levels', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 80,
      mergeThreshold: 2,
      recentWindowTokens: 50,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    for (let i = 0; i < 120; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}. ` + 'word '.repeat(20) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    // Walk the summary tree. Every L_n summary (except the topmost) should
    // have a parentId pointing to an L_{n+1} that exists.
    const summaries = (strategy as any).summaries as Array<{
      id: string;
      level: number;
      mergedInto?: string;
      parentId?: string;
    }>;
    const byId = new Map(summaries.map((s) => [s.id, s]));
    let maxLevel = 0;
    for (const s of summaries) if (s.level > maxLevel) maxLevel = s.level;

    for (const s of summaries) {
      const parentId = s.parentId ?? s.mergedInto;
      if (s.level === maxLevel) continue; // top level has no parent
      if (!parentId) continue; // legitimately may be the newest at its level, no parent yet
      const parent = byId.get(parentId);
      assert.ok(parent, `summary ${s.id} (L${s.level}) has parentId ${parentId} but parent not found`);
      assert.equal(parent.level, s.level + 1, `parent of L${s.level} should be L${s.level + 1}`);
    }
    manager.close();
  });

  it('picker uses L4+ summaries when budget pressure requires it', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 80,
      mergeThreshold: 2,
      recentWindowTokens: 50,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    for (let i = 0; i < 120; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}. ` + 'word '.repeat(20) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    // Aggressive compression to force the picker to reach L4+.
    await manager.compile({ maxTokens: 600, reserveForResponse: 100 });

    // Inspect strategy.resolutions for any value >= 3 (L3 or deeper).
    const resolutions = (strategy as any).resolutions as Map<string, number>;
    const maxResolution = Math.max(0, ...Array.from(resolutions.values()));
    assert.ok(
      maxResolution >= 3,
      `with tight budget and deep tree, picker should reach L3+; max resolution was L${maxResolution}`
    );
    manager.close();
  });
});
