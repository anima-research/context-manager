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
import type { ProduceRequest } from '../src/adaptive/folding-strategy.js';
import type { Picker, PickerInputs } from '../src/adaptive/picker.js';

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
  /** Solver name of every picker built — attribution for the clobber test. */
  pickerSolverNames: string[] = [];

  protected buildPicker(
    inputs: PickerInputs,
    preparedBudget?: { totalBudget: number; targetBudget: number },
  ): Picker {
    const picker = super.buildPicker(inputs, preparedBudget);
    this.pickerSolverNames.push(picker.solverName);
    return picker;
  }

  protected handleProducedOps(ops: readonly ProduceRequest[], opts?: { speculative?: boolean }): void {
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

  it('drops explicit undefined/null overrides instead of clobbering live keys', async () => {
    const strategy = makeStrategy({ foldingStrategy: 'kv-stable' });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });

    // The live compile must both run kv-stable and REPORT it (planVsActual
    // is the fleet's only from-outside solver check, via /debug/context/makeup).
    const stats = (strategy as unknown as {
      getRenderStats: (s: unknown) => { planVsActual?: { solver?: string } } | null;
    }).getRenderStats(undefined);
    assert.strictEqual(
      stats?.planVsActual?.solver, 'kv-stable',
      'planVsActual must expose the solver that planned the compile',
    );

    // A JSON-driven caller (fleet hub, panel form) can serialize absent form
    // fields as explicit undefined/null. Spreading those into the config would
    // ERASE the live foldingStrategy and silently run this preview's compile
    // on flat-profile — the exact drift the 2026-08-07 fable investigation
    // could not attribute. They must be dropped, not spread.
    strategy.pickerSolverNames.length = 0;
    const preview = manager.previewContext(
      { maxTokens: 100_000, reserveForResponse: 200 },
      {
        foldingStrategy: undefined,
        compressionSlackRatio: null as unknown as number,
        targetChunkTokens: 777,
      },
    );
    assert.ok(preview, 'preview with sparse overrides must succeed');
    assert.ok(strategy.pickerSolverNames.length > 0, 'preview must have built a picker');
    for (const name of strategy.pickerSolverNames) {
      assert.strictEqual(
        name, 'kv-stable',
        'undefined/null overrides must not downgrade the solver for the previewed compile',
      );
    }
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

describe('AutobiographicalStrategy — a plain dry compile commits nothing', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  // A compile with `{ dryRun: true }` and no previewContext around it: what
  // agent-framework's previews, a host's seed of a fork and a panel's render
  // use. Messages added between the real compile and the dry one make the dry
  // run's frontier, stats and estimate differ from the real one's, so a dry
  // run that left its own behind would show.
  const calibration = (s: AutobiographicalStrategy) => ({
    estimate: (s as unknown as { _lastCompileEstimate: number })._lastCompileEstimate,
    armed: (s as unknown as { _calibrationArmed: boolean })._calibrationArmed,
  });

  it('leaves the transition status as the last committing compile left it', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 30);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const frontier = strategy.frontierTokens();
    const status = JSON.stringify(manager.getHotContextSettings());
    addConversation(manager, 10);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.strictEqual(strategy.frontierTokens(), frontier, 'the dry run\u2019s frontier must not stand');
    assert.strictEqual(JSON.stringify(manager.getHotContextSettings()), status);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(strategy.frontierTokens()! > frontier!, 'a real compile at that point does move it, or this test proves nothing');
  });

  it('leaves the live render stats', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 30);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const live = JSON.stringify(manager.getRenderStats());
    addConversation(manager, 10);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.strictEqual(JSON.stringify(manager.getRenderStats()), live);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.notStrictEqual(JSON.stringify(manager.getRenderStats()), live, 'a real compile there changes them, or this test proves nothing');
  });

  it('leaves calibration to the compile its usage report is for, and never re-arms it', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 30);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const armed = calibration(strategy);
    assert.strictEqual(armed.armed, true);
    // Mid-turn: the turn's messages arrive, and something renders dry.
    addConversation(manager, 10);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.deepStrictEqual(calibration(strategy), armed, 'the usage report must still be compared with the real compile');
    // The report takes the one sample; a dry run after it must not arm another.
    strategy.reportRealInputTokens(armed.estimate);
    const spent = calibration(strategy);
    assert.strictEqual(spent.armed, false);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.deepStrictEqual(calibration(strategy), spent);
  });

  it('leaves the next real compile\u2019s cache markers where the last sent request ended', async () => {
    // The stable-prefix marker measures against the previous compile's
    // entries: a dry layout must not become that baseline.
    const markersOfNextRealCompile = async (dryBetween: boolean): Promise<number[]> => {
      cleanup();
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: makeStrategy() });
      addConversation(manager, 30);
      await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
      addConversation(manager, 4);
      if (dryBetween) {
        await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
      }
      addConversation(manager, 3);
      const next = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
      manager.close();
      return next.messages.flatMap((m, i) => ((m as { cacheBreakpoint?: boolean }).cacheBreakpoint ? [i] : []));
    };
    const without = await markersOfNextRealCompile(false);
    assert.ok(without.length > 1, 'the compile places markers, or this test proves nothing');
    assert.deepStrictEqual(await markersOfNextRealCompile(true), without);
  });

  const chunkRecords = (s: AutobiographicalStrategy): number =>
    (s as unknown as { chunkRecords: unknown[] }).chunkRecords.length;
  const persistedChunkRecords = (s: AutobiographicalStrategy): number => {
    const internals = s as unknown as { store: { getStateJson(id: string): unknown }; chunksStateId: string };
    const stored = internals.store.getStateJson(internals.chunksStateId);
    return Array.isArray(stored) ? stored.length : 0;
  };

  // A strategy chunks its own messages as they arrive (onNewMessage); another
  // writer's, in an auxiliary slot, it first chunks at its next select, so a
  // dry one is where a dry run could cut chunks for good.
  const besideAnotherWriter = async (strategy: AutobiographicalStrategy) => {
    const main = await ContextManager.open({ path: TEST_STORE_PATH, strategy: makeStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy, auxiliaryMessageViews: [{}],
    });
    return { main, side };
  };

  it('records no chunk and queues no compression', async () => {
    const strategy = makeStrategy();
    const { main, side } = await besideAnotherWriter(strategy);
    addConversation(main, 30);
    await side.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const recordsBefore = chunkRecords(strategy);
    const queueBefore = strategy.queuedChunkIndices();
    addConversation(main, 40);
    await side.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.strictEqual(chunkRecords(strategy), recordsBefore, 'no chunk record from a dry run');
    assert.strictEqual(persistedChunkRecords(strategy), recordsBefore, 'and none written to the store');
    assert.deepStrictEqual(strategy.queuedChunkIndices(), queueBefore, 'no compression queued by a dry run');
    await side.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(chunkRecords(strategy) > recordsBefore, 'a real compile closes those chunks, or this test proves nothing');
    side.close();
    main.close();
  });

  it('records no chunk at a preview\u2019s overridden chunk size', async () => {
    const strategy = makeStrategy();
    const { main, side } = await besideAnotherWriter(strategy);
    addConversation(main, 30);
    await side.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const recordsBefore = chunkRecords(strategy);
    addConversation(main, 40);
    const chunksBefore = (strategy as unknown as { chunks: unknown }).chunks;
    side.previewContext({ maxTokens: 100_000, reserveForResponse: 200 }, { targetChunkTokens: 50 });
    assert.strictEqual(chunkRecords(strategy), recordsBefore, 'a boundary cut at the preview\u2019s size would be kept for good');
    assert.strictEqual(persistedChunkRecords(strategy), recordsBefore);
    assert.strictEqual((strategy as unknown as { chunks: unknown }).chunks, chunksBefore, 'the chunks are the last real rebuild\u2019s');
    // A real compile at the preview's chunk size closes chunks here, or this test proves nothing.
    (strategy as unknown as { config: { targetChunkTokens: number } }).config.targetChunkTokens = 50;
    await side.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(chunkRecords(strategy) > recordsBefore, 'the 50-token size closes chunks');
    side.close();
    main.close();
  });

  it('leaves a hierarchical strategy\u2019s render stats too', async () => {
    const strategy = makeStrategy({ adaptiveResolution: false });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 30);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    const live = JSON.stringify(manager.getRenderStats());
    addConversation(manager, 10);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.strictEqual(JSON.stringify(manager.getRenderStats()), live);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.notStrictEqual(JSON.stringify(manager.getRenderStats()), live, 'a real compile changes them, or this test proves nothing');
  });

  it('puts back whatever a dry select wrote, on a throw too', async () => {
    // Whatever writes a select path makes to these, now or later, the dry run
    // must not leave them: the select path below writes every one and, on
    // request, throws after writing.
    class Writer extends SpyStrategy {
      throwAfter = false;
      protected selectAdaptive(...args: Parameters<AutobiographicalStrategy['selectAdaptive']>) {
        const out = super.selectAdaptive(...args);
        if (args[2]?.dryRun) {
          const self = this as unknown as Record<string, unknown>;
          self.chunks = [];
          self.compressionQueue = [99];
          self.chunkRecordsOrphaned = true;
          self._orphanWarned = true;
          self._prevCacheKeys = ['zz'];
          self.lastFrontierTokens = 1;
          self.transitionBlocked = 'transition-pace-floor';
          self._lastRenderStats = null;
          self._lastCompileEstimate = 1;
          self._calibrationArmed = true;
          self._calibrationLoaded = false;
          self._calibration = 1.5;
          self._calibrationReset = { discardedMultiplier: 9, fromEpoch: 0, at: 1 };
          // The multiplier the store prices by, which the dry load applies.
          (args[0] as { setTokenCalibration?(factor: number): void }).setTokenCalibration?.(3);
          self._storeView = {};
          self._storeOrder = new Map();
          self._storeOrderSource = [];
          self._cachedHeadStartIndex = { id: 'zz', msgCount: 1, result: 0 };
          self._imageWatermark = 99;
          self._postStripMemo = { zz: true };
          if (this.throwAfter) throw new Error('zz-after-writing');
        }
        return out;
      }
    }
    const strategy = new Writer({
      compressionModel: 'mock', headWindowTokens: 0, targetChunkTokens: 100, recentWindowTokens: 200,
      adaptiveResolution: true, autoTickOnNewMessage: false,
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    addConversation(manager, 30);
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    strategy.reportRealInputTokens(calibration(strategy).estimate);
    const before = () => JSON.stringify([manager.getHotContextSettings(), manager.getRenderStats(), calibration(strategy)]);
    const expected = before();
    // Every field select() saves and restores, read by identity.
    const fields = [
      'chunks', 'compressionQueue', 'chunkRecordsOrphaned', '_orphanWarned', '_prevCacheKeys', 'lastFrontierTokens',
      'transitionBlocked', '_lastRenderStats', '_lastCompileEstimate', '_calibrationArmed', '_calibrationLoaded',
      '_calibration', '_calibrationReset', '_storeView', '_storeOrder', '_storeOrderSource', '_cachedHeadStartIndex',
      '_imageWatermark', '_postStripMemo',
    ];
    const storeCalibration = () =>
      (manager as unknown as { messageStore: { getTokenCalibration(): number } }).messageStore.getTokenCalibration();
    const raw = () => [
      ...fields.map((f) => (strategy as unknown as Record<string, unknown>)[f]),
      storeCalibration(),
    ];
    const rawBefore = raw();
    const assertRestored = (when: string) => raw().forEach((value, i) =>
      assert.strictEqual(value, rawBefore[i], `${fields[i] ?? 'the store\'s token calibration'} is put back ${when}`));
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.strictEqual(before(), expected);
    assertRestored('after a dry compile');
    strategy.throwAfter = true;
    await assert.rejects(
      manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true }),
      /zz-after-writing/,
    );
    assert.strictEqual(before(), expected);
    assertRestored('after a dry compile that throws');
  });

  // The store order holds each message's position in the listing it was
  // built from, and nothing else.
  type OrderState = { _storeOrder: Map<string, number>; _storeOrderSource: ReadonlyArray<{ id: string }> };
  const assertOrderMatchesItsListing = (strategy: AutobiographicalStrategy, label: string) => {
    const self = strategy as unknown as OrderState;
    const expected = new Map<string, number>();
    self._storeOrderSource.forEach((m, i) => expected.set(m.id, i));
    assert.deepStrictEqual(self._storeOrder, expected, `${label}: the store order matches its listing`);
  };
  const budget = { maxTokens: 100_000, reserveForResponse: 1_000 };

  it('leaves later compiles working when it is the first compile after a removal', async () => {
    // The first compile after a removal builds the store order from the
    // shorter listing. A dry one puts the order back, and must put back the
    // listing it was built from too: an order from before the removal,
    // beside the listing from after it, reads as current. With the middle of
    // three messages removed, every later select then left the last message
    // unrendered and refused the compile (UncoveredDropError); in the other
    // layouts here the positions were stale without a throw.
    const layouts = [{ count: 3, remove: 1 }, { count: 3, remove: 0 }, { count: 3, remove: 2 }, { count: 5, remove: 2 }];
    for (const adaptiveResolution of [false, true]) {
      for (const { count, remove } of layouts) {
        for (const compiledBefore of [false, true]) {
          for (const next of ['dry', 'commit'] as const) {
            const label = `${count} messages, m${remove + 1} removed${compiledBefore ? ' after a compile' : ''}, ` +
              `adaptiveResolution ${adaptiveResolution}, then ${next} compiles`;
            cleanup();
            const strategy = new AutobiographicalStrategy({ recentWindowTokens: 30_000, adaptiveResolution });
            const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
            try {
              const ids = Array.from({ length: count }, (_, i) => manager.addMessage('user', textBlock(`m${i + 1}`)));
              if (compiledBefore) await manager.compile(budget);
              manager.removeMessage(ids[remove]);
              const kept = ids.filter((_, i) => i !== remove);
              const first = await manager.compile(budget, undefined, { dryRun: true });
              assert.strictEqual(first.messages.length, count - 1, label);
              assertOrderMatchesItsListing(strategy, label);
              for (let i = 1; i <= 2; i++) {
                const r = await manager.compile(budget, undefined, { dryRun: next === 'dry' });
                assert.strictEqual(r.messages.length, count - 1, `${label} (${i})`);
                assertOrderMatchesItsListing(strategy, `${label} (${i})`);
                if (next === 'commit') {
                  const listed = (strategy as unknown as OrderState)._storeOrderSource.map((m) => m.id);
                  assert.deepStrictEqual(listed, kept, `${label} (${i}): a committing compile orders the current listing`);
                }
              }
            } finally {
              manager.close();
            }
          }
        }
      }
    }
  });

  it('extends a copy of the store order when a dry select reads a longer listing', async () => {
    // refreshStoreOrder extends the order in place when the listing it's given
    // starts with the one the order was built from. A dry select puts the
    // order it found back by reference, so a dry refresh must extend a copy:
    // written into in place, the order put back would hold a position for a
    // message its listing doesn't have.
    cleanup();
    const strategy = new AutobiographicalStrategy({ recentWindowTokens: 30_000 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    type Refresh = OrderState & {
      _dryRunSelect: boolean;
      refreshStoreOrder(messages: ReadonlyArray<{ id: string }>): void;
    };
    const self = strategy as unknown as Refresh;
    try {
      manager.addMessage('user', textBlock('m1'));
      manager.addMessage('user', textBlock('m2'));
      await manager.compile(budget);
      const committedListing = self._storeOrderSource;
      const order = self._storeOrder;
      const entries = new Map(order);
      const longer = [...committedListing, { id: 'appended' }];
      self._dryRunSelect = true;
      try {
        self.refreshStoreOrder(longer);
      } finally {
        self._dryRunSelect = false;
      }
      assert.deepStrictEqual(order, entries, 'a dry refresh leaves the order it found as it was');
      assert.strictEqual(self._storeOrder.get('appended'), 2, 'and orders the longer listing');
      // What the dry select does on its way out:
      self._storeOrder = order;
      self._storeOrderSource = committedListing;
      self.refreshStoreOrder(longer);
      assert.strictEqual(self._storeOrder, order, 'a committing refresh still extends the order in place');
      assert.strictEqual(self._storeOrder.get('appended'), 2);
    } finally {
      manager.close();
    }
  });
});
