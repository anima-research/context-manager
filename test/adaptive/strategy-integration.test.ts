/**
 * Integration test for AutobiographicalStrategy with adaptiveResolution: true.
 *
 * Exercises the picker end-to-end through the real strategy: builds a
 * conversation, drives compression via a mocked membrane, then compiles with
 * various budgets and asserts the picker's effect on the rendered output.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

async function drain(manager: ContextManager): Promise<void> {
  for (let ticks = 0; ticks < 200 && !manager.isReady(); ticks++) await manager.tick();
  assert.ok(manager.isReady(), 'premise: compression settled within 200 ticks');
}

const TEST_STORE_PATH = './test-adaptive-strategy-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

/** Mock membrane that returns deterministic compressed summaries. */
function makeMockMembrane() {
  let callCount = 0;
  const responses: string[] = [];
  return {
    complete: async () => {
      callCount++;
      const text = `[mock summary #${callCount}] This is a summary of an earlier portion of the conversation.`;
      responses.push(text);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text }],
      };
    },
    get callCount() {
      return callCount;
    },
    get responses() {
      return responses;
    },
  };
}

describe('AutobiographicalStrategy — adaptiveResolution', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('flag on: compile produces output and runs picker', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',
      targetChunkTokens: 100,
      recentWindowTokens: 200,
      adaptiveResolution: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // Add enough messages for chunks to form.
    for (let i = 0; i < 12; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]);
    }
    await manager.tick();
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0, 'should compile with adaptive on');
    manager.close();
  });

  it('flag on + tight budget: picker raises resolution to fit', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',
      targetChunkTokens: 100,
      recentWindowTokens: 200,
      adaptiveResolution: true,
      compressionSlackRatio: 0.1,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // Many turns → enough L1s + L2s to fold deeply.
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]);
    }
    await manager.tick();

    // Compile with a generous budget first — observe baseline shape.
    const generous = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(generous.messages.length > 0);

    // Compile with a very tight budget — picker should fold middle to fit.
    const tight = await manager.compile({ maxTokens: 2000, reserveForResponse: 0 });
    assert.ok(tight.messages.length > 0, 'tight budget should still produce output');
    const tokens = (compiled: typeof tight) => compiled.messages.reduce((acc, m) => {
      const text = m.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      return acc + Math.ceil(text.length / 4);
    }, 0);
    const tightTokens = tokens(tight);
    assert.ok(tightTokens < tokens(generous), `the tight compile folds: ${tightTokens} tokens against ${tokens(generous)}`);
    assert.ok(tight.messages.some((m) => m.content.some((b: any) => b.type === 'text' && b.text.includes('[mock summary #'))), 'and sends a summary in place of what it folded');
    assert.ok(tightTokens <= 2000, `tight compile tokens ${tightTokens} should fit budget 2000`);
    manager.close();
  });

  it('flag on + lockChunk: locked message stays raw under pressure', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',
      targetChunkTokens: 100,
      recentWindowTokens: 200,
      adaptiveResolution: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    const messageIds: string[] = [];
    for (let i = 0; i < 18; i++) {
      const id = manager.addMessage('User', [{ type: 'text', text: `Turn ${i}: SECRET-${i.toString().padStart(2, '0')} ` + 'word '.repeat(40) }]);
      messageIds.push(id);
    }
    await drain(manager);

    // Lock an early message that would otherwise be folded.
    const lockedId = messageIds[3];
    strategy.lockChunk(lockedId);

    // Compile with tight budget to force picker to fold.
    const tight = await manager.compile({ maxTokens: 1200, reserveForResponse: 200 });

    const tightText = tight.messages
      .flatMap((m) => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    assert.ok(!tightText.includes('SECRET-04 '), 'premise: the budget folds the unlocked message beside it');
    assert.ok(tightText.includes(`Turn 3: SECRET-03 ${'word '.repeat(40)}`), 'the locked message is sent verbatim');
    manager.close();
  });

  it('flag on + speculativeProduction off: produce ops from picker are enqueued, not dropped', async () => {
    // When the speculative pre-producer is disabled, an L_n that the picker
    // requires must be enqueued in response to the picker's produce ops —
    // otherwise the next compile re-emits the same op and the strategy
    // never makes progress.
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',
      targetChunkTokens: 50,
      recentWindowTokens: 50,
      adaptiveResolution: true,
      speculativeProduction: false,
      mergeThreshold: 3,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    for (let i = 0; i < 12; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}. ` + 'word '.repeat(40) }]);
    }
    await drain(manager);

    const summariesByLevel = (): Record<number, number> => {
      const out: Record<number, number> = {};
      for (const s of (strategy as any).summaries as Array<{ level: number }>) {
        out[s.level] = (out[s.level] ?? 0) + 1;
      }
      return out;
    };

    // Synthesize a produce op as if the picker had requested an L2 over
    // the L1 range. handleProducedOps is the unit under test.
    const l1s = ((strategy as any).summaries as Array<{
      level: number;
      sourceRange: { first: string; last: string };
    }>).filter((s) => s.level === 1);

    assert.ok(l1s.length >= 2, `premise: the turns made two or more L1s (${l1s.length})`);
    assert.ok(l1s.length < 3, `premise: fewer L1s than the merge threshold, so the merge check queued no L2 over them (${l1s.length})`);
    const firstL1 = l1s[0];
    const lastL1 = l1s[l1s.length - 1];
    const queueBefore = ((strategy as any).mergeQueue as Array<{ level: number; sourceIds: string[] }>).length;

    (strategy as any).handleProducedOps([
      {
        kind: 'produce',
        level: 2,
        range: {
          firstChunkId: firstL1.sourceRange.first,
          lastChunkId: lastL1.sourceRange.last,
        },
      },
    ]);

    const queueAfter = ((strategy as any).mergeQueue as Array<{ level: number; sourceIds: string[] }>).length;
    assert.ok(
      queueAfter > queueBefore,
      `expected handleProducedOps to enqueue an L2 merge; queue went ${queueBefore} → ${queueAfter}`
    );

    await drain(manager);

    const counts = summariesByLevel();
    assert.ok(counts[2] >= 1, `expected at least one L2 to exist after draining; got ${JSON.stringify(counts)}`);

    manager.close();
  });

  it('flag on: monotonic resolution across multiple compiles (no thrashing)', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',
      targetChunkTokens: 100,
      recentWindowTokens: 200,
      adaptiveResolution: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    for (let i = 0; i < 24; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]);
    }
    await drain(manager);

    // First compile under tight budget — picker folds.
    await manager.compile({ maxTokens: 1200, reserveForResponse: 200 });
    // Snapshot resolutions
    const snap1 = new Map((strategy as any).resolutions);
    assert.ok(snap1.size > 0, 'premise: the first compile set resolutions to compare');

    // Second compile under same budget — should not lower anything.
    await manager.compile({ maxTokens: 1200, reserveForResponse: 200 });
    const snap2 = new Map((strategy as any).resolutions);

    // Monotonicity: every message's resolution in snap2 >= snap1.
    for (const [id, r1] of snap1.entries()) {
      const r2 = snap2.get(id) ?? 0;
      assert.ok((r2 as number) >= (r1 as number), `message ${id} resolution decreased: ${r1} → ${r2}`);
    }
    manager.close();
  });
});
