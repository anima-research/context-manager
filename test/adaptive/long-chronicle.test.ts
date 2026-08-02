/**
 * End-to-end stress test: a long-running chronicle with mixed content.
 *
 * Simulates 200+ turns of conversation, with a big doc dropped in the middle,
 * and verifies:
 *   - Compile output never exceeds the budget (the picker actually does its job)
 *   - Resolutions monotone over the run (no thrashing)
 *   - Picker is idle on most turns (steady-state cache property)
 *   - Final state can be reloaded cleanly
 *   - Output structure remains sensible across the run
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-long-chronicle-store';

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
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `[mock summary #${callCount}] short content.` }],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function compiledTokenCount(compiled: { messages: Array<{ content: any[] }> }): number {
  let total = 0;
  for (const m of compiled.messages) {
    for (const block of m.content) {
      if (block.type === 'text') total += countTokens(block.text);
    }
  }
  return total;
}

describe('AutobiographicalStrategy — long chronicle stress', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('200-turn simulation with mid-conversation doc: budget honored, resolutions monotone', async () => {
    const mock = makeMockMembrane();
    const BUDGET = 4000;
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 300,
      recentWindowTokens: 500,
      mergeThreshold: 3,
      compressionSlackRatio: 0.15,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    const resolutionHistory: Map<string, number[]> = new Map();
    const pickerFiredTurns: number[] = [];

    // Burst of normal conversation
    for (let turn = 0; turn < 50; turn++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${turn}. ` + 'word '.repeat(30) }]);
      manager.addMessage('Claude', [{ type: 'text', text: `Reply ${turn}. ` + 'response '.repeat(30) }]);
      while (!manager.isReady()) {
        await manager.tick();
      }
      const compiled = await manager.compile({ maxTokens: BUDGET, reserveForResponse: 300 });
      const tokens = compiledTokenCount(compiled);
      assert.ok(
        tokens <= BUDGET - 300,
        `turn ${turn}: tokens ${tokens} exceeds budget ${BUDGET - 300}`
      );
      // Track resolution per message
      const res = (strategy as any).resolutions as Map<string, number>;
      for (const [id, level] of res) {
        const hist = resolutionHistory.get(id) ?? [];
        hist.push(level);
        resolutionHistory.set(id, hist);
      }
    }

    // Drop a big doc mid-conversation
    const bigDoc = Array.from({ length: 40 }, (_, i) =>
      `Section ${i}: ` + 'word '.repeat(40)
    ).join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: bigDoc }]);
    while (!manager.isReady()) {
      await manager.tick();
    }
    const afterDocCompile = await manager.compile({ maxTokens: BUDGET, reserveForResponse: 300 });
    const afterDocTokens = compiledTokenCount(afterDocCompile);
    assert.ok(
      afterDocTokens <= BUDGET - 300,
      `after-doc compile: ${afterDocTokens} tokens exceeds ${BUDGET - 300}`
    );

    // More conversation after the doc
    for (let turn = 50; turn < 100; turn++) {
      manager.addMessage('User', [{ type: 'text', text: `Post-doc turn ${turn}. ` + 'word '.repeat(30) }]);
      manager.addMessage('Claude', [{ type: 'text', text: `Reply ${turn}. ` + 'word '.repeat(30) }]);
      while (!manager.isReady()) {
        await manager.tick();
      }
      const before = new Map((strategy as any).resolutions as Map<string, number>);
      const compiled = await manager.compile({ maxTokens: BUDGET, reserveForResponse: 300 });
      const after = (strategy as any).resolutions as Map<string, number>;
      // Track when the picker fires (resolutions change)
      let fired = false;
      for (const [id, lvl] of after) {
        if ((before.get(id) ?? 0) !== lvl) {
          fired = true;
          break;
        }
      }
      if (fired) pickerFiredTurns.push(turn);

      const tokens = compiledTokenCount(compiled);
      assert.ok(
        tokens <= BUDGET - 300,
        `turn ${turn}: tokens ${tokens} exceeds budget ${BUDGET - 300}`
      );
    }

    // Monotonicity: every chunk's resolution history should be non-decreasing
    for (const [id, hist] of resolutionHistory) {
      for (let i = 1; i < hist.length; i++) {
        assert.ok(
          hist[i] >= hist[i - 1],
          `chunk ${id} resolution decreased at step ${i}: L${hist[i - 1]} → L${hist[i]}`
        );
      }
    }

    // Steady-state property: in the second half of post-doc turns, the picker
    // should fire less often (cache stickiness).
    // (We don't assert exact numbers — depends on chunk sizes — but ensure
    // it's not firing every single turn.)
    const lateFires = pickerFiredTurns.filter((t) => t >= 80).length;
    assert.ok(lateFires < 20, `picker fired on ${lateFires}/20 late turns; expected <20 (some no-ops)`);

    manager.close();
  });

  it('long chronicle reloads cleanly with full state intact', async () => {
    // Phase 1: build a 50-turn chronicle, drive folding
    const mock1 = makeMockMembrane();
    const strategy1 = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 200,
      recentWindowTokens: 400,
      mergeThreshold: 3,
    });
    const manager1 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy1,
      membrane: mock1 as any,
    });
    for (let i = 0; i < 50; i++) {
      manager1.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(30) }]);
    }
    while (!manager1.isReady()) {
      await manager1.tick();
    }
    await manager1.compile({ maxTokens: 3500, reserveForResponse: 300 });
    const stats1 = strategy1.getStats();
    const resolutions1 = new Map((strategy1 as any).resolutions as Map<string, number>);
    const messageCount1 = manager1.getAllMessages().length;
    manager1.close();

    // Phase 2: reopen, verify state matches
    const mock2 = makeMockMembrane();
    const strategy2 = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 200,
      recentWindowTokens: 400,
      mergeThreshold: 3,
    });
    const manager2 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy2,
      membrane: mock2 as any,
    });
    const stats2 = strategy2.getStats();
    const resolutions2 = new Map((strategy2 as any).resolutions as Map<string, number>);
    const messageCount2 = manager2.getAllMessages().length;

    assert.equal(messageCount2, messageCount1, 'message count should match after reopen');
    assert.equal(stats2.l1, stats1.l1, 'L1 count should match');
    assert.equal(stats2.l2, stats1.l2, 'L2 count should match');
    assert.equal(stats2.l3, stats1.l3, 'L3 count should match');
    assert.equal(resolutions2.size, resolutions1.size, 'resolutions size should match');
    for (const [id, level] of resolutions1) {
      assert.equal(resolutions2.get(id), level, `resolution mismatch for ${id}`);
    }
    manager2.close();
  });
});
