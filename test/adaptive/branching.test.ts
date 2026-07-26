/**
 * Tests that branching a chronicle correctly inherits and diverges
 * adaptive-resolution state.
 *
 * Per the design doc §8 open question #4: "Branching semantics for on-chunk
 * state. New chronicle branches inherit chunk state at the fork point via
 * the existing branch-scoped slot model. An agent unfold on branch A does
 * not leak into branch B."
 *
 * Adaptive state lives in two places:
 *   - On the StoredMessage itself (bodyGroupId, shardIndex, currentResolution,
 *     lockedByAgent — set at append time, immutable for that record)
 *   - In strategy state slots (autobio:resolutions, autobio:locks,
 *     autobio:summaries)
 *
 * The chronicle's branch model copy-on-writes the state slots, so the fork
 * sees state-at-fork-point and can diverge without affecting the parent.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-branching-store';

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

describe('AutobiographicalStrategy — branching semantics', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('fork inherits resolutions at fork point; divergence does not leak back', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    // Build up some history
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]));
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    // Force some folds
    await manager.compile({ maxTokens: 3000, reserveForResponse: 200 });
    const parentResolutions = new Map((strategy as any).resolutions);
    const parentBranchName = (manager as any).store.currentBranch().name;

    // Fork
    const forkName = await manager.fork('test-fork');
    const forkResolutions = new Map((strategy as any).resolutions);

    // Fork should inherit parent's resolutions at fork point
    assert.equal(forkResolutions.size, parentResolutions.size);
    for (const [id, level] of parentResolutions) {
      assert.equal(forkResolutions.get(id), level, `fork should inherit resolution for ${id}`);
    }

    // Diverge on the fork — add more turns, force deeper folding
    for (let i = 20; i < 40; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Fork-only turn ${i}. ` + 'word '.repeat(40) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    await manager.compile({ maxTokens: 2000, reserveForResponse: 200 });
    const forkDivergedResolutions = new Map((strategy as any).resolutions);
    const forkDivergedMessageCount = manager.getAllMessages().length;

    // Switch back to parent
    await manager.switchBranch(parentBranchName);
    const parentResolutionsAfterSwitch = new Map((strategy as any).resolutions);
    const parentMessageCount = manager.getAllMessages().length;

    // Parent should still have its ORIGINAL state — the fork's divergence
    // didn't leak back.
    assert.equal(parentMessageCount, 20, 'parent should still have 20 messages');
    assert.notEqual(parentMessageCount, forkDivergedMessageCount);
    assert.equal(parentResolutionsAfterSwitch.size, parentResolutions.size);
    for (const [id, level] of parentResolutions) {
      assert.equal(
        parentResolutionsAfterSwitch.get(id),
        level,
        `parent ${id}: expected unchanged resolution L${level} after fork diverged`
      );
    }

    manager.close();
  });

  it('locks on fork do not affect parent', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 100,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(manager.addMessage('User', [{ type: 'text', text: `M${i}` }]));
    }

    const parentBranch = (manager as any).store.currentBranch().name;
    await manager.fork('lock-fork');
    // Lock on the fork
    strategy.lockChunk(ids[3]);
    strategy.lockChunk(ids[7]);
    const forkLocks = new Set((strategy as any).locked as Set<string>);
    assert.equal(forkLocks.size, 2);

    // Switch back to parent — locks should be empty
    await manager.switchBranch(parentBranch);
    const parentLocks = (strategy as any).locked as Set<string>;
    assert.equal(parentLocks.size, 0, 'parent should not see fork-only locks');

    // Switch back to fork — locks should still be there
    await manager.switchBranch('lock-fork');
    const forkLocksAfter = (strategy as any).locked as Set<string>;
    assert.equal(forkLocksAfter.size, 2);
    assert.ok(forkLocksAfter.has(ids[3]));
    assert.ok(forkLocksAfter.has(ids[7]));
    manager.close();
  });

  it('summaries on fork do not affect parent', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 80,
      mergeThreshold: 3,
      recentWindowTokens: 50,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // Build enough for some summaries
    for (let i = 0; i < 20; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}. ` + 'word '.repeat(20) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    const parentSummaryCount = ((strategy as any).summaries as Array<unknown>).length;
    const parentBranch = (manager as any).store.currentBranch().name;

    // Fork and add more content → more summaries on fork only
    await manager.fork('sum-fork');
    for (let i = 20; i < 50; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}. ` + 'word '.repeat(20) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    const forkSummaryCount = ((strategy as any).summaries as Array<unknown>).length;
    assert.ok(forkSummaryCount > parentSummaryCount, `fork should have more summaries (${forkSummaryCount}) than parent (${parentSummaryCount})`);

    // Switch back to parent
    await manager.switchBranch(parentBranch);
    const parentSummaryCountAfter = ((strategy as any).summaries as Array<unknown>).length;
    assert.equal(
      parentSummaryCountAfter,
      parentSummaryCount,
      `parent should still have ${parentSummaryCount} summaries after fork diverged`
    );
    manager.close();
  });
});
