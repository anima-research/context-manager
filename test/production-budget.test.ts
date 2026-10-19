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
 *  - speculative demand does not punch through the L1 holdback window;
 *  - `[kv-overlap]` reports the compile's own plan, once, and never the
 *    shadow pick's, which no compile renders.
 */

import { describe, it, before, after, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/index.js';
import type { Picker, PickerInputs } from '../src/adaptive/picker.js';
import type { ProduceRequest, FoldingBudget } from '../src/adaptive/folding-strategy.js';

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
  /** Each picker run's level for each chunk, in run order. */
  pickerRunLevels: Array<Map<string, number>> = [];
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
        const result = real.run(runInputs, budget);
        spy.pickerRunLevels.push(new Map(runInputs.chunks.map((c) => [c.id, result.levelAt(c.sequence, c.id)])));
        return result;
      },
    };
    return wrapper as unknown as Picker;
  }

  /** A summary written as is, with no model call. */
  seed(entry: Omit<SummaryEntry, 'created'>): void {
    this.pushSummary({ ...entry, created: 0 });
  }

  protected handleProducedOps(
    ops: readonly ProduceRequest[],
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

  // N1 lists x and y, while y's own L1 is N2, the first L1 that lists it: a
  // plan that folds x to L1 renders N1, whose recall covers y while y renders
  // through its own lineage or raw, so y is in the window twice.
  const overlapOptions = { foldingStrategy: 'kv-stable', recentWindowTokens: 8, speculativeProduction: false };
  function seedOverlap(manager: ContextManager, strategy: SpyStrategy): { x: string; y: string } {
    const x = manager.addMessage('user', textBlock('x ' + 'word '.repeat(100)));
    const y = manager.addMessage('user', textBlock('y ' + 'word '.repeat(100)));
    manager.addMessage('user', textBlock('z latest ' + 'word '.repeat(20)));
    strategy.seed({
      id: 'N2', level: 1, content: 'summary of y', tokens: 6,
      sourceLevel: 0, sourceIds: [y], sourceRange: { first: y, last: y },
    });
    strategy.seed({
      id: 'N1', level: 1, content: 'summary of x and y', tokens: 8,
      sourceLevel: 0, sourceIds: [x, y], sourceRange: { first: x, last: y },
    });
    return { x, y };
  }
  function catchOverlapLines(t: TestContext): string[] {
    const lines: string[] = [];
    const original = console.error.bind(console);
    t.mock.method(console, 'error', (...args: unknown[]) => {
      if (String(args[0]).includes('[kv-overlap]')) lines.push(String(args[0]));
      else original(...args);
    });
    return lines;
  }

  it('logs [kv-overlap] for the compile\'s own plan with no production budget set', async (t) => {
    const lines = catchOverlapLines(t);
    const strategy = makeStrategy(overlapOptions);
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const { x, y } = seedOverlap(manager, strategy);

    await manager.compile({ maxTokens: 260, reserveForResponse: 0 });
    assert.deepStrictEqual(strategy.pickerRunBudgets, [260], 'the live pick alone');
    assert.strictEqual(strategy.pickerRunLevels[0]!.get(x), 1, 'the plan renders N1, through x');
    assert.strictEqual(lines.length, 1, lines.join('\n'));
    assert.match(lines[0]!, new RegExp(`sample=${y} ns=default$`));
    manager.close();
  });

  // #239: a process can host several strategies, each in its own namespace, and their lines
  // interleave on stderr; each diagnostic of the compile names the namespace it was logged for,
  // after its fields, so a grep for its prefix still matches. The planner's [kv-timing] lines,
  // which KV_TIMING turns on, come through the strategy's solver and name it too.
  it('names the strategy\'s namespace on the compile\'s [kv-overlap], [plan-vs-actual] and [kv-timing] lines', async (t) => {
    const logged: string[] = [];
    const original = console.error.bind(console);
    t.mock.method(console, 'error', (...args: unknown[]) => {
      const line = String(args[0]);
      if (/^\[(kv-overlap|plan-vs-actual|kv-timing)\]/.test(line)) logged.push(line);
      else original(...args);
    });
    const timing = process.env.KV_TIMING;
    process.env.KV_TIMING = '1';
    t.after(() => {
      if (timing === undefined) delete process.env.KV_TIMING;
      else process.env.KV_TIMING = timing;
    });
    const strategy = makeStrategy(overlapOptions);
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, namespace: 'agents/tern' });
    const { y } = seedOverlap(manager, strategy);

    await manager.compile({ maxTokens: 260, reserveForResponse: 0 });
    const of = (tag: string) => logged.filter((line) => line.startsWith(`[${tag}]`));
    assert.strictEqual(of('kv-overlap').length, 1, logged.join('\n'));
    assert.match(of('kv-overlap')[0]!, new RegExp(`sample=${y} ns=agents/tern$`));
    assert.strictEqual(of('plan-vs-actual').length, 1, logged.join('\n'));
    // After its fields, solver= and those that follow it.
    assert.match(of('plan-vs-actual')[0]!, / solver=\S+(?: \w+=\S+)* ns=agents\/tern$/);
    assert.ok(of('kv-timing').length > 0, logged.join('\n'));
    for (const line of of('kv-timing')) assert.match(line, / ns=agents\/tern$/);
    manager.close();
  });

  it('logs no [kv-overlap] about the shadow pick\'s plan, which no compile renders', async (t) => {
    const lines = catchOverlapLines(t);
    const strategy = makeStrategy({ ...overlapOptions, productionBudgetTokens: 250 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const { x } = seedOverlap(manager, strategy);

    await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    assert.deepStrictEqual(strategy.pickerRunBudgets, [100_000, 250], 'the live pick, then the shadow pick');
    assert.ok(
      [...strategy.pickerRunLevels[0]!.values()].every((level) => level === 0),
      'the live plan renders no summary',
    );
    assert.strictEqual(strategy.pickerRunLevels[1]!.get(x), 1, 'the shadow plan renders N1, through x');
    assert.deepStrictEqual(lines, []);
    manager.close();
  });

  it('logs [kv-overlap] once, for the compile\'s own plan, when the shadow pick plans the same summary', async (t) => {
    const lines = catchOverlapLines(t);
    const strategy = makeStrategy({ ...overlapOptions, productionBudgetTokens: 200 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const { x, y } = seedOverlap(manager, strategy);

    await manager.compile({ maxTokens: 260, reserveForResponse: 0 });
    assert.deepStrictEqual(strategy.pickerRunBudgets, [260, 200], 'the live pick, then the shadow pick');
    assert.strictEqual(strategy.pickerRunLevels[0]!.get(x), 1, 'the live plan renders N1, through x');
    assert.strictEqual(strategy.pickerRunLevels[1]!.get(x), 1, 'and so does the shadow plan');
    assert.strictEqual(lines.length, 1, lines.join('\n'));
    assert.match(lines[0]!, /1 leaf\(s\) with conflicting lineage/);
    assert.match(lines[0]!, new RegExp(`sample=${y} ns=default$`));
    manager.close();
  });

  it('a dry run logs [kv-overlap] for the plan it previews, and makes no shadow pick', async (t) => {
    const lines = catchOverlapLines(t);
    const strategy = makeStrategy({ ...overlapOptions, productionBudgetTokens: 200 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const { x } = seedOverlap(manager, strategy);

    await manager.compile({ maxTokens: 260, reserveForResponse: 0 }, undefined, { dryRun: true });
    assert.deepStrictEqual(strategy.pickerRunBudgets, [260], 'the dry run\'s own pick alone');
    assert.strictEqual(strategy.pickerRunLevels[0]!.get(x), 1, 'its plan renders N1, through x');
    assert.strictEqual(lines.length, 1, lines.join('\n'));
    manager.close();
  });
});
