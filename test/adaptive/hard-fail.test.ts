/**
 * Tests that selectAdaptive throws OverBudgetError when the picker has
 * folded everything it can but the result still exceeds the hard budget.
 *
 * The strategy's philosophy: surface the overage rather than silently
 * dropping entries. The host decides how to recover.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';
import { OverBudgetError } from '../../src/adaptive/index.js';

const TEST_STORE_PATH = './test-adaptive-hard-fail-store';

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

describe('AutobiographicalStrategy — adaptive OverBudgetError', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('throws OverBudgetError when tail alone exceeds budget', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
      // Large tail window: everything we add will be tail-resident, NOT
      // foldable. The picker has nothing to do with it.
      recentWindowTokens: 100_000,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    // Add enough content that the tail alone is huge.
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(80) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    // Budget so tight that even the tail can't fit. Picker has nothing it
    // can fold (tail is treated as pinned).
    await assert.rejects(
      () => manager.compile({ maxTokens: 500, reserveForResponse: 100 }),
      (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, `expected OverBudgetError, got ${(err as Error)?.constructor?.name}`);
        const e = err as OverBudgetError;
        assert.ok(e.actual > e.budget, `actual ${e.actual} should exceed budget ${e.budget}`);
        assert.ok(e.diagnostics.tailTokens > 0, 'diagnostics should include tail tokens');
        return true;
      }
    );
    manager.close();
  });

  it('does not let a pending produce op bypass the hard budget', async () => {
    class PendingProduceStrategy extends AutobiographicalStrategy {
      protected buildPicker(): any {
        return {
          run: () => ({
            finalResolutions: new Map(),
            applied: [],
            produced: [{
              kind: 'produce',
              level: 1,
              range: { firstChunkId: 'missing-first', lastChunkId: 'missing-last' },
            }],
            finalTokens: 10_000,
            budgetMet: false,
            // This was the loophole: Picker reports false while production is
            // pending even though the current plan is not renderable.
            exhausted: false,
            iterations: 1,
          }),
        };
      }

      protected handleProducedOps(): void {}
    }

    const strategy = new PendingProduceStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 50,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    manager.addMessage('User', [{ type: 'text', text: 'triggering turn' }]);

    await assert.rejects(
      () => manager.compile({ maxTokens: 500, reserveForResponse: 100 }),
      OverBudgetError,
    );
    manager.close();
  });

  it('reserves the complete recent tail before emitting older raw history', async () => {
    class RawPlanStrategy extends AutobiographicalStrategy {
      protected buildPicker(): any {
        return {
          run: (inputs: any) => ({
            finalResolutions: new Map(inputs.chunks.map((chunk: any) => [chunk.id, 0])),
            applied: [],
            produced: [],
            finalTokens: 1,
            budgetMet: true,
            exhausted: false,
            iterations: 0,
          }),
        };
      }
    }

    const strategy = new RawPlanStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 40,
      maxMessageTokens: 0,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    for (let i = 0; i < 8; i++) {
      manager.addMessage('User', [{
        type: 'text',
        text: `history-${i} ${'.'.repeat(80)}`,
      }]);
    }
    manager.addMessage('User', [{
      type: 'text',
      text: `TRIGGERING-TURN ${'.'.repeat(80)}`,
    }]);

    const compiled = await manager.compile({ maxTokens: 80, reserveForResponse: 0 });
    const text = compiled.messages
      .flatMap(message => message.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    assert.match(text, /TRIGGERING-TURN/);
    manager.close();
  });

  it('does NOT throw when picker can fold its way under budget', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(40) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    // Tight but reachable budget — picker should fold middle content to fit.
    const compiled = await manager.compile({ maxTokens: 3000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0);
    manager.close();
  });

  it('does NOT throw under generous budget', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    for (let i = 0; i < 10; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Msg ${i}` }]);
    }
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0);
    manager.close();
  });

  it('allows an exhausted compile within the configured grace ratio', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
      recentWindowTokens: 100_000,
      overBudgetGraceRatio: 0.25,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    for (let i = 0; i < 12; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(20) }]);
    }

    // The tail is indivisible and slightly over the strict 400-token context
    // budget, but remains below its 500-token grace ceiling.
    const compiled = await manager.compile({ maxTokens: 500, reserveForResponse: 100 });
    assert.ok(compiled.messages.length > 0);
    manager.close();
  });

  it('error diagnostics include useful state info', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 200,
      recentWindowTokens: 100_000,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    for (let i = 0; i < 20; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(80) }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }

    let caught: OverBudgetError | null = null;
    try {
      await manager.compile({ maxTokens: 400, reserveForResponse: 100 });
    } catch (err) {
      if (err instanceof OverBudgetError) caught = err;
    }
    assert.ok(caught, 'should have caught OverBudgetError');
    if (!caught) {
      manager.close();
      return;
    }
    assert.equal(typeof caught.budget, 'number');
    assert.equal(typeof caught.actual, 'number');
    assert.equal(typeof caught.diagnostics.headTokens, 'number');
    assert.equal(typeof caught.diagnostics.tailTokens, 'number');
    assert.equal(typeof caught.diagnostics.middleTokens, 'number');
    assert.equal(typeof caught.diagnostics.deepestLevel, 'number');
    // The error message should be informative
    assert.ok(caught.message.includes('exhausted'));
    assert.ok(caught.message.includes('hard budget'));
    manager.close();
  });
});
