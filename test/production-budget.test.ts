/**
 * Standing production target (`productionBudgetTokens`).
 *
 * After the live adaptive pick, the strategy runs a SHADOW pick against the
 * production budget on the same inputs — pure CPU, no LLM, no state commit —
 * and enqueues only its produce ops, so the drain keeps the summary forest
 * deep enough to lower the live budget to the target at any time.
 *
 * Behavioral guarantees under test:
 *  - the shadow pick runs against the production budget and its produce ops
 *    are enqueued speculatively (never marked as live demand);
 *  - guards: no shadow pick when the target is unset, non-positive, or not
 *    below the live budget;
 *  - a throwing shadow pick never breaks the live compile;
 *  - an unreachable target (exhausted shadow with nothing to produce) warns
 *    loudly instead of failing silently at descent time;
 *  - speculative demand does not punch through the L1 holdback window.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { Picker, PickerInputs } from '../src/adaptive/picker.js';
import type { FoldOp, FoldingBudget } from '../src/adaptive/folding-strategy.js';

const TEST_STORE_PATH = './test-production-budget';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/** Records every picker run's totalBudget and every handleProducedOps call;
 *  can be armed to throw when a run arrives at a specific budget (to simulate
 *  a failing shadow pick without touching the live one). */
class SpyStrategy extends AutobiographicalStrategy {
  pickerRunBudgets: number[] = [];
  producedCalls: Array<{ ops: number; speculative: boolean }> = [];
  failOnBudget?: number;

  protected buildPicker(
    inputs: PickerInputs,
    preparedBudget?: { totalBudget: number; targetBudget: number },
  ): Picker {
    const real = super.buildPicker(inputs, preparedBudget);
    const spy = this;
    const wrapper = {
      run(runInputs: PickerInputs, budget: FoldingBudget) {
        spy.pickerRunBudgets.push(budget.totalBudget);
        if (spy.failOnBudget !== undefined && budget.totalBudget === spy.failOnBudget) {
          throw new Error('synthetic shadow-pick failure');
        }
        return real.run(runInputs, budget);
      },
    };
    return wrapper as unknown as Picker;
  }

  protected handleProducedOps(
    ops: readonly FoldOp[],
    opts?: { speculative?: boolean },
  ): void {
    this.producedCalls.push({ ops: ops.length, speculative: opts?.speculative === true });
    super.handleProducedOps(ops, opts);
  }

  demandedL1Count(): number {
    return (this as any)._demandedL1Chunks.size as number;
  }
  queuedChunkIndices(): number[] {
    return [...(this as any).compressionQueue] as number[];
  }
  closedChunks(): Chunk[] {
    return (this as any).chunks as Chunk[];
  }
  enqueueRange(firstId: string, lastId: string, opts?: { speculative?: boolean }): void {
    (this as any).enqueueL1ForRange(firstId, lastId, opts);
  }
}

function makeStrategy(overrides: Record<string, unknown> = {}): SpyStrategy {
  return new SpyStrategy({
    compressionModel: 'mock',
    headWindowTokens: 0,
    targetChunkTokens: 100,
    recentWindowTokens: 200,
    adaptiveResolution: true,
    autoTickOnNewMessage: false, // inspect queues without draining them
    ...overrides,
  });
}

/** Enough chunky messages that the middle region far exceeds the production
 *  budget used in the tests (~50 tokens each). */
function addConversation(manager: ContextManager, count = 30): void {
  for (let i = 0; i < count; i++) {
    manager.addMessage('User', textBlock(`Turn ${i}. ` + 'word '.repeat(40)));
  }
}

describe('AutobiographicalStrategy — productionBudgetTokens', () => {
  let warnings: string[] = [];
  const origWarn = console.warn;

  before(cleanup);
  after(() => {
    console.warn = origWarn;
    cleanup();
  });
  beforeEach(() => {
    cleanup();
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.warn = origWarn;
  });

  it('runs a shadow pick against the production budget and enqueues its produce ops speculatively', async () => {
    const strategy = makeStrategy({ productionBudgetTokens: 1000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0, 'live compile must produce output');

    assert.strictEqual(
      strategy.pickerRunBudgets.length,
      2,
      `expected live + shadow picker runs, got budgets [${strategy.pickerRunBudgets}]`,
    );
    assert.strictEqual(
      strategy.pickerRunBudgets[1],
      1000,
      'shadow pick must run against the production budget',
    );

    const speculative = strategy.producedCalls.filter((c) => c.speculative);
    assert.strictEqual(speculative.length, 1, 'shadow produce ops must be forwarded');
    assert.ok(speculative[0].ops > 0, 'shadow pick against a tight budget must demand folds');
    assert.strictEqual(
      strategy.demandedL1Count(),
      0,
      'speculative production must not mark chunks as live-demanded',
    );
    manager.close();
  });

  it('no shadow pick when the target is unset', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);

    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.strictEqual(strategy.pickerRunBudgets.length, 1, 'only the live pick must run');
    assert.strictEqual(strategy.producedCalls.filter((c) => c.speculative).length, 0);
    manager.close();
  });

  it('no shadow pick when the target is not below the live budget', async () => {
    const strategy = makeStrategy({ productionBudgetTokens: 200_000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);

    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.strictEqual(strategy.pickerRunBudgets.length, 1, 'only the live pick must run');
    manager.close();
  });

  it('no shadow pick for a non-positive target', async () => {
    for (const bad of [0, -5]) {
      cleanup();
      const strategy = makeStrategy({ productionBudgetTokens: bad });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      addConversation(manager);

      await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
      assert.strictEqual(
        strategy.pickerRunBudgets.length,
        1,
        `productionBudgetTokens: ${bad} must not trigger a shadow pick`,
      );
      manager.close();
    }
  });

  it('a throwing shadow pick warns but never breaks the live compile', async () => {
    const strategy = makeStrategy({ productionBudgetTokens: 1000 });
    strategy.failOnBudget = 1000;
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0, 'live compile must survive the shadow failure');
    assert.ok(
      warnings.some((w) => w.includes('shadow production pick failed')),
      `expected a shadow-failure warning, got: ${JSON.stringify(warnings)}`,
    );
    manager.close();
  });

  it('an unreachable target warns on every compile instead of failing silently', async () => {
    // Everything fits in the recent window: the middle is empty, so the
    // shadow pick has nothing to fold and nothing to produce, yet head+tail
    // alone exceed the target — the exact "exhausted" state that would
    // hard-fail at descent time.
    const strategy = makeStrategy({
      recentWindowTokens: 100_000,
      productionBudgetTokens: 100,
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 10);

    const compiled = await manager.compile({ maxTokens: 50_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0, 'live compile must still succeed');
    assert.ok(
      warnings.some((w) => w.includes('unreachable')),
      `expected an unreachable-target warning, got: ${JSON.stringify(warnings)}`,
    );
    manager.close();
  });

  it('speculative demand does not punch through the L1 holdback window', async () => {
    const strategy = makeStrategy({ recentWindowTokens: 5, targetChunkTokens: 20 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    let guard = 0;
    while (strategy.closedChunks().length < 2 && guard++ < 200) {
      manager.addMessage('user', textBlock(`m-${guard} hello world padding`));
      await new Promise((r) => setTimeout(r, 1));
    }
    const chunks = strategy.closedChunks();
    assert.ok(chunks.length >= 2, 'expected ≥2 closed chunks');
    const newest = chunks[chunks.length - 1];
    assert.ok(
      !strategy.queuedChunkIndices().includes(newest.index),
      'sanity: newest chunk held back before any demand',
    );

    strategy.enqueueRange(
      newest.messages[0].id,
      newest.messages[newest.messages.length - 1].id,
      { speculative: true },
    );
    assert.ok(
      !strategy.queuedChunkIndices().includes(newest.index),
      'speculative demand must not enqueue a held-back chunk',
    );
    assert.strictEqual(strategy.demandedL1Count(), 0, 'speculative demand must not mark chunks');

    // Live demand on the same range still overrides the holdback.
    strategy.enqueueRange(
      newest.messages[0].id,
      newest.messages[newest.messages.length - 1].id,
    );
    assert.ok(
      strategy.queuedChunkIndices().includes(newest.index),
      'live demand must still punch through the holdback',
    );
    assert.ok(strategy.demandedL1Count() > 0, 'live demand must mark the chunk');
    manager.close();
  });
});
