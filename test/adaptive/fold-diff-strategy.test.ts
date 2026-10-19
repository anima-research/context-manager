/**
 * [fold-diff] wiring in the real strategy, driven through
 * ContextManager.compile() with adaptiveResolution: the dry-run gate, the
 * per-compile reset, logging only once a compile that changed a saved level
 * commits, the attach on planVsActual, the divergence measured on the
 * entries placed, and observability never failing a compile (PR #157 review).
 *
 * The picker is replaced (buildPicker hook, as in hard-fail.test.ts) by one
 * whose plan the test sets per compile, over real L1 summaries produced by a
 * mock membrane; everything after picker.run is the production path.
 */

import { withNamespace } from '../../src/diagnostics.js';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';
import { accountFrontier, type PickerChunk, type PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { formatFoldDiff, type FoldDiff } from '../../src/adaptive/fold-diff.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { ContextEntry, MessageId } from '../../src/types/index.js';

const TEST_STORE_PATH = './test-adaptive-fold-diff-strategy-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

function makeMockMembrane() {
  let n = 0;
  return {
    complete: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: `[mock summary #${++n}]` }],
    }),
  };
}

/** Every middle chunk with an L1 at L1 ('fold'), everything raw ('raw'), the
 *  carried frontier unchanged ('carried', zero moves), or a level per chunk. */
type Plan = 'fold' | 'raw' | 'carried' | ((c: PickerChunk, inputs: PickerInputs) => number);

/** A strategy whose picker applies the plan the test sets. `lie` reports a
 *  1-token plan, so the plan check passes and the EMITTER refuses an
 *  over-budget frontier: a failure after the saved-level changes were staged.
 *  It keeps a copy of the entries each compile compared for its cache
 *  markers, which is what the fold diff measures. */
class PlannedStrategy extends AutobiographicalStrategy {
  plan: Plan = 'fold';
  lie = false;
  /** The moves the planned picker reported on its last run: the solver's own
   *  count, whatever `planVsActual.moves` counts. */
  pickedMoves = 0;
  placed: Array<Array<{ participant: string; content: ContentBlock[]; sourceMessageId?: MessageId }>> = [];
  /** Refuse the next compile after it has placed its cache markers, where the
   *  coverage check refuses. */
  refuseAfterMarkers = false;
  /** The cache-marker baseline the next compile compares with, by identity. */
  get baseline(): readonly string[] | undefined {
    return this._prevCacheKeys;
  }
  protected assertMiddleCoverage(): void {
    if (this.refuseAfterMarkers) {
      this.refuseAfterMarkers = false;
      throw new Error('refused after its markers were placed');
    }
    super.assertMiddleCoverage();
  }
  estimate(content: ContentBlock[]): number {
    return this.estimateTokens(content);
  }
  protected placeCacheMarkers(
    entries: ContextEntry[],
    head: ReadonlySet<MessageId>,
    tail: ReadonlySet<MessageId>,
  ): number | null {
    this.placed.push(entries.map((e) => ({
      participant: e.participant,
      content: structuredClone(e.content),
      ...(e.sourceMessageId ? { sourceMessageId: e.sourceMessageId } : {}),
    })));
    return super.placeCacheMarkers(entries, head, tail);
  }
  protected buildPicker(): any {
    return {
      solverName: 'test-plan',
      run: (inputs: PickerInputs, budget: { targetBudget: number }) => {
        const middle = (id: ChunkId) => !inputs.headChunkIds.has(id) && !inputs.tailChunkIds.has(id);
        const finalResolutions = new Map<ChunkId, number>();
        for (const c of inputs.chunks) {
          const plan = this.plan;
          const level = typeof plan === 'function'
            ? plan(c, inputs)
            : plan === 'carried'
              ? c.currentResolution
              : plan === 'fold' && middle(c.id) && c.l1Id ? 1 : 0;
          finalResolutions.set(c.id, level);
        }
        let moves = 0;
        for (const c of inputs.chunks) if ((finalResolutions.get(c.id) ?? 0) !== c.currentResolution) moves++;
        this.pickedMoves = moves;
        const finalTokens = this.lie ? 1 : accountFrontier(inputs, finalResolutions).tokens;
        return {
          finalResolutions,
          applied: [],
          produced: [],
          finalTokens,
          budgetMet: finalTokens <= budget.targetBudget,
          exhausted: false,
          iterations: 1,
          moves,
        };
      },
    };
  }
}

type Stats = { planVsActual?: { actual?: number; moves?: number; foldDiff?: FoldDiff } } | null;

describe('AutobiographicalStrategy — [fold-diff] wiring', () => {
  let errors: string[] = [];
  let warnings: string[] = [];
  let origError: typeof console.error;
  let origWarn: typeof console.warn;
  const foldLines = () => errors.filter((l) => l.startsWith('[fold-diff]'));

  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => {
    cleanup();
    errors = [];
    warnings = [];
    origError = console.error;
    origWarn = console.warn;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  });
  afterEach(() => {
    console.error = origError;
    console.warn = origWarn;
  });

  async function open(): Promise<{ manager: ContextManager; strategy: PlannedStrategy; ids: MessageId[] }> {
    const strategy = new PlannedStrategy({
      compressionModel: 'mock',
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });
    const ids: MessageId[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(40) }]));
    }
    while (!manager.isReady()) await manager.tick();
    errors = [];
    warnings = [];
    return { manager, strategy, ids };
  }

  /** Where two compiles' entries first differ, found here, apart from the strategy's own search. */
  function firstDifference(before: PlannedStrategy['placed'][number], now: PlannedStrategy['placed'][number]): number {
    let first = 0;
    while (first < now.length && first < before.length && JSON.stringify(now[first]) === JSON.stringify(before[first])) {
      first++;
    }
    return first;
  }

  const BIG = { maxTokens: 100_000, reserveForResponse: 200 };
  const stats = (m: ContextManager): Stats => m.getRenderStats() as Stats;

  it('a committed compile that moved logs exactly once and attaches the same record', async () => {
    const { manager } = await open();
    await manager.compile(BIG);
    const lines = foldLines();
    assert.equal(lines.length, 1, `one [fold-diff] line, got ${JSON.stringify(lines)}`);
    const diff = stats(manager)?.planVsActual?.foldDiff;
    assert.ok(diff, 'foldDiff attached to planVsActual');
    assert.ok(diff.moves > 0 && diff.deepened === diff.moves, 'the fold plan deepened chunks');
    assert.equal(withNamespace(formatFoldDiff(diff), 'default'), lines[0], 'the attached record is the one logged, naming its namespace (#239)');
    // The strategy's first compile has nothing earlier to compare with.
    assert.equal(diff.divergenceOffset, null);
    assert.equal(diff.suffixTokens, null);
    assert.match(lines[0], /no earlier compile to compare/);
    manager.close();
  });

  it('a later compile reports where its request first differs from the one before, measured on the entries placed', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    errors = [];
    // Raise only the last folded chunk: what comes before it is sent as before.
    strategy.plan = (c, inputs) => {
      const folded = inputs.chunks.filter((x) => x.currentResolution === 1);
      return c.id === folded.at(-1)?.id ? 0 : c.currentResolution;
    };
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1);
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    assert.equal(diff.moves, 1);
    assert.equal(diff.raised, 1);

    const [before, now] = strategy.placed.slice(-2);
    const first = firstDifference(before, now);
    const tokens = now.map((e) => strategy.estimate(e.content));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.ok(first > 0 && first < now.length, `fixture: the change falls inside the request (entry ${first} of ${now.length})`);
    assert.equal(diff.divergenceOffset, sum(tokens.slice(0, first)));
    assert.equal(diff.suffixTokens, sum(tokens.slice(first)));
    manager.close();
  });

  it('a message edited in place before the fold moves the divergence to the edit (R1-5)', async () => {
    const { manager, strategy, ids } = await open();
    // Fold only the later half, so the earlier messages are sent raw.
    const laterHalf = (c: PickerChunk) => c.sequence >= 15 && c.l1Id ? 1 : 0;
    strategy.plan = (c, inputs) => (!inputs.headChunkIds.has(c.id) && !inputs.tailChunkIds.has(c.id) ? laterHalf(c) : 0);
    await manager.compile(BIG);
    const edited = ids[3];
    assert.ok(strategy.placed.at(-1)!.some((e) => e.sourceMessageId === edited), 'fixture: the edited message is sent raw');
    manager.editMessage(edited, [{ type: 'text', text: 'Msg 3, edited in place. ' + 'word '.repeat(40) }]);
    errors = [];
    // A fold far after the edit: raise the last folded chunk.
    strategy.plan = (c, inputs) => {
      const folded = inputs.chunks.filter((x) => x.currentResolution === 1);
      return c.id === folded.at(-1)?.id ? 0 : c.currentResolution;
    };
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1);
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    const [before, now] = strategy.placed.slice(-2);
    const first = firstDifference(before, now);
    assert.equal(now[first].sourceMessageId, edited, 'the request first differs at the edited message');
    const tokens = now.map((e) => strategy.estimate(e.content));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.equal(diff.divergenceOffset, sum(tokens.slice(0, first)));
    assert.equal(diff.suffixTokens, sum(tokens.slice(first)));
    manager.close();
  });

  it('a compile refused after placing its markers leaves the last request returned as the one the next compile compares with', async () => {
    const { manager, strategy, ids } = await open();
    strategy.plan = (c, inputs) =>
      (!inputs.headChunkIds.has(c.id) && !inputs.tailChunkIds.has(c.id) && c.sequence >= 15 && c.l1Id ? 1 : 0);
    await manager.compile(BIG);
    const returned = strategy.baseline;
    const placedBefore = strategy.placed.length;
    const edited = ids[3];
    assert.ok(strategy.placed.at(-1)!.some((e) => e.sourceMessageId === edited), 'fixture: the edited message is sent raw');
    // The refused compile carries the edit, so measured against it the next
    // compile would first differ at its fold, far later.
    manager.editMessage(edited, [{ type: 'text', text: 'Msg 3, edited in place. ' + 'word '.repeat(40) }]);
    strategy.refuseAfterMarkers = true;
    await assert.rejects(manager.compile(BIG), /refused after its markers were placed/);
    assert.equal(strategy.placed.length, placedBefore + 1, 'fixture: the refused compile placed its markers');
    assert.strictEqual(strategy.baseline, returned, 'the baseline is the last request returned');
    errors = [];
    strategy.plan = (c, inputs) => {
      const folded = inputs.chunks.filter((x) => x.currentResolution === 1);
      return c.id === folded.at(-1)?.id ? 0 : c.currentResolution;
    };
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1);
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    const [last, , now] = strategy.placed.slice(-3);
    const first = firstDifference(last, now);
    assert.equal(now[first].sourceMessageId, edited, 'the request first differs from the last one returned at the edit');
    const tokens = now.map((e) => strategy.estimate(e.content));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.equal(diff.divergenceOffset, sum(tokens.slice(0, first)));
    assert.equal(diff.suffixTokens, sum(tokens.slice(first)));
    manager.close();
  });

  it('a pin added since the previous request shows in the divergence, not in the runs', async () => {
    const { manager, strategy, ids } = await open();
    await manager.compile(BIG);
    const before = strategy.placed.at(-1)!;
    // The first folded message: everything before it is sent raw, so its
    // chunk's summary is where the pin first changes the request.
    const pinned = ids.find((id) => !before.some((e) => e.sourceMessageId === id))!;
    assert.ok(pinned, 'fixture: some message is folded');
    manager.pinRange(pinned, pinned);
    errors = [];
    // As the solvers do, a pinned chunk is planned raw; the last folded
    // chunk is raised, a move far after the pin.
    strategy.plan = (c, inputs) => {
      const folded = inputs.chunks.filter((x) => x.currentResolution === 1 && !x.pinned);
      return c.pinned || c.id === folded.at(-1)?.id ? 0 : c.currentResolution;
    };
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1);
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    assert.equal(diff.moves, 1, 'the raised chunk is the one move: the pinned chunk rendered raw on both sides');
    assert.deepEqual(diff.runs.map((r) => [r.from, r.to, r.count]), [[1, 0, 1]]);
    const now = strategy.placed.at(-1)!;
    const first = firstDifference(before, now);
    assert.equal(now[first].sourceMessageId, pinned, 'the request first differs at the pinned message');
    const tokens = now.map((e) => strategy.estimate(e.content));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.equal(diff.divergenceOffset, sum(tokens.slice(0, first)));
    manager.close();
  });

  it('after a branch switch, the divergence compares with the last request returned, the other branch\'s', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const main = manager.currentBranch().name;
    const onMain = strategy.placed.at(-1)!;
    // The fork raises its first folded chunk, which main's saved levels keep folded.
    await manager.fork('fold-diff-fork');
    strategy.plan = (c, inputs) => {
      const folded = inputs.chunks.filter((x) => x.currentResolution === 1);
      return c.id === folded[0]?.id ? 0 : c.currentResolution;
    };
    await manager.compile(BIG);
    const onFork = strategy.placed.at(-1)!;
    // Back on main, raise its last folded chunk.
    await manager.switchBranch(main);
    errors = [];
    strategy.plan = (c, inputs) => {
      const folded = inputs.chunks.filter((x) => x.currentResolution === 1);
      return c.id === folded.at(-1)?.id ? 0 : c.currentResolution;
    };
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1);
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    const now = strategy.placed.at(-1)!;
    const fromFork = firstDifference(onFork, now);
    const fromMain = firstDifference(onMain, now);
    assert.ok(fromFork < fromMain, `fixture: the fork's request and main's own first differ from this one at different entries (${fromFork}, ${fromMain})`);
    const tokens = now.map((e) => strategy.estimate(e.content));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.equal(diff.divergenceOffset, sum(tokens.slice(0, fromFork)), "measured from the fork's request, the last one returned");
    manager.close();
  });

  it('a compile that changes no saved level logs nothing, though its solver moved a locked chunk', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const locked = stats(manager)!.planVsActual!.foldDiff!.runs[0].firstChunkId;
    strategy.lockChunk(locked);
    errors = [];
    // The commit loop skips a locked chunk, so this plan changes no saved
    // level, though the solver reports it as a move.
    strategy.plan = (c) => (c.id === locked ? 0 : c.currentResolution);
    await manager.compile(BIG);
    assert.equal(strategy.pickedMoves, 1, 'fixture: the solver moved the locked chunk');
    assert.ok(stats(manager)?.planVsActual, 'planVsActual reported');
    assert.deepEqual(foldLines(), []);
    assert.equal(stats(manager)?.planVsActual?.foldDiff, undefined);
    manager.close();
  });

  it('a compile with no moves neither logs nor keeps the previous compile’s foldDiff', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    assert.ok(stats(manager)?.planVsActual?.foldDiff);
    errors = [];
    strategy.plan = 'carried';
    await manager.compile(BIG);
    assert.deepEqual(foldLines(), []);
    assert.ok(stats(manager)?.planVsActual, 'planVsActual still reported');
    assert.equal(stats(manager)?.planVsActual?.foldDiff, undefined);
    manager.close();
  });

  it('a dry run neither logs nor attaches, and leaves the live stats alone', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const live = stats(manager)?.planVsActual?.foldDiff;
    assert.ok(live);
    errors = [];
    strategy.plan = 'raw'; // would move every folded chunk
    const preview = manager.previewContext(BIG, undefined, { render: true });
    assert.ok(preview?.stats, 'the dry run produced stats of its own');
    assert.ok((preview.stats as Stats)?.planVsActual, 'preview stats carry planVsActual');
    assert.equal((preview.stats as Stats)?.planVsActual?.foldDiff, undefined);
    assert.deepEqual(foldLines(), []);
    assert.equal(stats(manager)?.planVsActual?.foldDiff, live, 'live stats unchanged by the preview');
    manager.close();
  });

  it('a plan the emitter refuses logs nothing; the retry that commits logs once', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const folded = stats(manager)!.planVsActual!;
    // Fits folded, not raw: the raw plan lies its way past the plan check and
    // the emitter refuses it.
    const tight = { maxTokens: folded.actual! + 400, reserveForResponse: 0 };
    errors = [];
    strategy.plan = 'raw';
    strategy.lie = true;
    await assert.rejects(() => manager.compile(tight), /Emission overran the plan/);
    assert.deepEqual(foldLines(), [], 'a refused plan is not a fold the resident saw');
    strategy.lie = false;
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1, 'the committed retry logs once');
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    assert.equal(diff.raised, folded.foldDiff!.deepened, 'the failed plan committed nothing');
    manager.close();
  });

  it('a throw inside the fold diff leaves the compile succeeding', async () => {
    const { manager } = await open();
    const original = SummaryTree.prototype.ancestorAt;
    SummaryTree.prototype.ancestorAt = function () {
      throw new Error('boom');
    };
    try {
      const compiled = await manager.compile(BIG);
      assert.ok(compiled.messages.length > 0);
    } finally {
      SummaryTree.prototype.ancestorAt = original;
    }
    assert.deepEqual(foldLines(), []);
    assert.ok(warnings.some((w) => w.startsWith('[fold-diff] unavailable')), 'the failure is reported');
    assert.equal(stats(manager)?.planVsActual?.foldDiff, undefined);
    assert.ok(stats(manager)?.planVsActual?.moves, 'the fold itself committed');
    manager.close();
  });
});
