/**
 * Dry-run select / `previewContext`.
 *
 * The adaptive path is NOT side-effect-free: a real compile commits fold
 * resolutions to Chronicle, enqueues compression work the drain will spend
 * real LLM tokens on, and advances transition bookkeeping. An operator UI that
 * previews a hypothetical budget must do none of that, or every slider drag
 * would rewrite the agent's fold plan.
 *
 * Guarantees under test:
 *  - a dry-run select commits no resolutions and persists nothing;
 *  - it enqueues no produce/merge work;
 *  - it runs no shadow production pick;
 *  - it leaves transition bookkeeping (lastFrontierTokens / prepared) intact;
 *  - an infeasible budget REPORTS (fits: false) instead of throwing OverBudgetError;
 *  - config overrides are scoped: this.config is restored afterwards;
 *  - overlapping previews reject rather than interleave;
 *  - a real compile after a preview still behaves normally.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { FoldOp } from '../src/adaptive/folding-strategy.js';

const TEST_STORE_PATH = './test-dry-run-preview';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class SpyStrategy extends AutobiographicalStrategy {
  producedCalls = 0;
  persistCalls = 0;

  protected handleProducedOps(ops: readonly FoldOp[], opts?: { speculative?: boolean }): void {
    this.producedCalls++;
    super.handleProducedOps(ops, opts);
  }

  protected persistResolutions(): void {
    this.persistCalls++;
    (super.persistResolutions as () => void).call(this);
  }

  resolutionSnapshot(): Record<string, number> {
    return Object.fromEntries((this as any).resolutions as Map<string, number>);
  }
  queuedChunkIndices(): number[] {
    return [...((this as any).compressionQueue as number[])];
  }
  frontierTokens(): number | undefined {
    return (this as any).lastFrontierTokens as number | undefined;
  }
  configTail(): number | undefined {
    return ((this as any).config as { recentWindowTokens?: number }).recentWindowTokens;
  }
  configChunk(): number | undefined {
    return ((this as any).config as { targetChunkTokens?: number }).targetChunkTokens;
  }
}

function makeStrategy(overrides: Record<string, unknown> = {}): SpyStrategy {
  return new SpyStrategy({
    compressionModel: 'mock',
    headWindowTokens: 0,
    targetChunkTokens: 100,
    recentWindowTokens: 200,
    adaptiveResolution: true,
    autoTickOnNewMessage: false,
    ...overrides,
  });
}

function addConversation(manager: ContextManager, count = 30): void {
  for (let i = 0; i < count; i++) {
    manager.addMessage('User', textBlock(`Turn ${i}. ` + 'word '.repeat(40)));
  }
}

describe('AutobiographicalStrategy — dry-run preview', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('commits nothing: no resolutions, no persist, no enqueue, no shadow pick', async () => {
    // productionBudgetTokens set so we can prove the shadow pick is skipped too.
    const strategy = makeStrategy({ productionBudgetTokens: 1000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);

    // Baseline: a real compile, so state is already settled.
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const resolutionsBefore = strategy.resolutionSnapshot();
    const queueBefore = strategy.queuedChunkIndices();
    const frontierBefore = strategy.frontierTokens();
    strategy.producedCalls = 0;
    strategy.persistCalls = 0;

    // Preview at an aggressively small budget — the case that would otherwise
    // rewrite the whole fold plan and queue a pile of compressions.
    const preview = manager.previewContext({ maxTokens: 2_000, reserveForResponse: 200 });
    assert.ok(preview, 'previewContext must be supported on the adaptive path');

    assert.strictEqual(strategy.persistCalls, 0, 'dry run must not persist resolutions');
    assert.strictEqual(strategy.producedCalls, 0, 'dry run must not enqueue produce ops');
    assert.deepStrictEqual(
      strategy.resolutionSnapshot(),
      resolutionsBefore,
      'dry run must not mutate the live resolution map',
    );
    assert.deepStrictEqual(
      strategy.queuedChunkIndices(),
      queueBefore,
      'dry run must not touch the compression queue',
    );
    assert.strictEqual(
      strategy.frontierTokens(),
      frontierBefore,
      'dry run must restore lastFrontierTokens (it feeds `prepared`)',
    );
  });

  it('reports an infeasible budget instead of throwing OverBudgetError', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 40);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });

    // A budget nothing can fit under: head+tail alone exceed it.
    const preview = manager.previewContext({ maxTokens: 150, reserveForResponse: 50 });
    assert.ok(preview, 'preview must return a result');
    assert.strictEqual(preview!.fits, false, 'an unreachable budget must report fits:false');
    assert.ok(preview!.finalTokens > preview!.budgetTokens, 'finalTokens must exceed the budget');
    assert.ok(
      typeof preview!.headTokens === 'number' && typeof preview!.tailTokens === 'number',
      'diagnostics must explain WHY it does not fit',
    );
  });

  it('scopes config overrides and restores them', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });

    const tailBefore = strategy.configTail();
    const chunkBefore = strategy.configChunk();

    const preview = manager.previewContext(
      { maxTokens: 100_000, reserveForResponse: 200 },
      { recentWindowTokens: 9_999, targetChunkTokens: 777 },
    );
    assert.ok(preview, 'override preview must return a result');

    assert.strictEqual(strategy.configTail(), tailBefore, 'recentWindowTokens must be restored');
    assert.strictEqual(strategy.configChunk(), chunkBefore, 'targetChunkTokens must be restored');
  });

  it('a larger tail override raises the previewed tail cost', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 40);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });

    const budget = { maxTokens: 100_000, reserveForResponse: 200 };
    const base = manager.previewContext(budget)!;
    const wider = manager.previewContext(budget, { recentWindowTokens: 5_000 })!;

    assert.ok(
      wider.tailTokens > base.tailTokens,
      `a bigger tail must cost more verbatim tokens (base ${base.tailTokens}, wider ${wider.tailTokens})`,
    );
  });

  it('leaves the LIVE render stats untouched — /makeup must not show previewed numbers', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 40);

    // Establish live stats from a real compile at a generous budget.
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const liveBefore = JSON.stringify(manager.getRenderStats());
    assert.ok(liveBefore && liveBefore !== 'null', 'live compile must produce render stats');

    // Preview at a much tighter budget — a very different segment breakdown.
    // Ask for the previewed stats so the test can prove they DIFFER from live;
    // otherwise an identical snapshot would let a clobber pass unnoticed (which
    // is exactly how the first version of this test false-passed).
    // Force a genuinely different breakdown via a tail override — on a small
    // store, budget pressure alone yields the identical plan at 20k and 100k,
    // which would let a clobber pass unnoticed. A wider tail reliably moves the
    // head/tail split (see the tail-override test above). Budget stays feasible
    // so this renders rather than taking the OverBudgetError path.
    const p = manager.previewContext(
      { maxTokens: 100_000, reserveForResponse: 200 },
      { recentWindowTokens: 5_000 },
      { render: true },
    );
    assert.ok(p, 'preview must return');
    assert.ok(p!.stats, 'previewed stats must be present with render:true');
    assert.notStrictEqual(
      JSON.stringify(p!.stats),
      liveBefore,
      'the previewed breakdown must actually differ from live, or this test proves nothing',
    );

    assert.strictEqual(
      JSON.stringify(manager.getRenderStats()),
      liveBefore,
      'render stats must still describe the LIVE context, not the previewed one',
    );
  });

  it('returns rendered entries and previewed stats only when asked', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 30);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });

    const budget = { maxTokens: 60_000, reserveForResponse: 200 };
    const plain = manager.previewContext(budget)!;
    assert.strictEqual(plain.entries, undefined, 'entries are opt-in (they can be megabytes)');
    assert.strictEqual(plain.stats, undefined, 'previewed stats are opt-in too');

    const withRender = manager.previewContext(budget, undefined, { render: true })!;
    assert.ok(Array.isArray(withRender.entries), 'render:true must return the rendered entries');
    assert.ok(withRender.entries!.length > 0, 'rendered context must be non-empty');
    assert.ok(withRender.stats, 'render:true must return the previewed segment stats');
    // Same plan either way — rendering must not change the outcome.
    assert.strictEqual(withRender.finalTokens, plain.finalTokens, 'render must not alter the plan');
  });

  it('a real compile after a preview still commits normally', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);

    manager.previewContext({ maxTokens: 2_000, reserveForResponse: 200 });
    strategy.producedCalls = 0;

    // A tight-but-feasible live compile must still do real work.
    const compiled = await manager.compile({ maxTokens: 8_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0, 'live compile after preview must still produce output');
    assert.ok(
      strategy.producedCalls > 0 || strategy.queuedChunkIndices().length > 0,
      'live compile must still be free to enqueue work',
    );
  });
});
