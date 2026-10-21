import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';
import type { StoredMessage, SummaryEntry, SummaryLevel } from '../src/types/index.js';
import { Picker, type PickerInputs } from '../src/adaptive/picker.js';
import type { FoldingBudget } from '../src/adaptive/folding-strategy.js';
import type { ContentBlock, Membrane } from '@animalabs/membrane';

class DiagnosticStrategy extends AutobiographicalStrategy {
  // A host that compresses names its model; a test of one that doesn't passes `compressionModel: undefined`.
  constructor(config: ConstructorParameters<typeof AutobiographicalStrategy>[0] = {}) {
    super({ compressionModel: 'zz-model', ...config });
  }

  level = 1;
  drift = false;
  /** When set, the plan says it's over the budget whatever it renders, as a planner that overestimates does. */
  overstate = false;
  useRealPicker = false;
  /** When set, the fixture solver asks for an L1 over the middle, as a plan with summaries still to produce does. */
  produce = false;
  /** Puts the unmerged L1s past maxSpeculativeL1s, so the cap holds L1 production while an L1 merge is queued. */
  atCap = false;
  /** Blocks every queued merge, as a hold on a message its sources cover does. */
  holdBlocksMerges = false;
  /** When false, chunks keep no records, as a subclass with its own chunking does. */
  persistChunks = true;
  /** Each picker run's chunks, with the L1 each folds through. */
  pickerL1s: (string | undefined)[][] = [];

  protected get chunkPersistenceEnabled(): boolean {
    // Read during construction too, before the field is set.
    return this.persistChunks !== false;
  }

  protected isAtSpeculativeCap(): boolean {
    return this.atCap || super.isAtSpeculativeCap();
  }

  protected mergeBlockedByHold(...args: Parameters<AutobiographicalStrategy['mergeBlockedByHold']>): boolean {
    return this.holdBlocksMerges || super.mergeBlockedByHold(...args);
  }

  /** How many times the hold boundary has been read with a hold in place (holdBoundaryScans). */
  boundaryScans(): number {
    return this.holdBoundaryScans;
  }

  /**
   * Marks a compression in flight with nothing recorded beside it
   * (pendingCompressionWork stays null), as a subclass that sets
   * pendingCompression itself leaves it: the case the count answers as it
   * did, whatever the work would fold.
   */
  startCompressing(): void {
    this.pendingCompression = Promise.resolve();
  }

  /** The message ids tick recorded for the chunk it's compressing, or undefined when no chunk is in flight. */
  chunkInFlight(): readonly string[] | undefined {
    const work = this.pendingCompressionWork;
    return work !== null && 'chunk' in work ? work.chunk.messages.map((m) => m.id) : undefined;
  }

  /** Whether the call for the chunk in flight has skipped it for the quarantine, or undefined when no chunk is in flight. */
  chunkInFlightSkipped(): boolean | undefined {
    const work = this.pendingCompressionWork;
    return work !== null && 'chunk' in work ? work.skipped === true : undefined;
  }

  /** Whether the chunk tick is compressing has landed its result (its compressed flag), or undefined when no chunk is in flight. */
  chunkInFlightCompressed(): boolean | undefined {
    const work = this.pendingCompressionWork;
    return work !== null && 'chunk' in work ? work.chunk.compressed : undefined;
  }

  /** Queues a merge of summaries that aren't in memory, as a merge queued before its sources were dropped is. */
  queueMerge(): void {
    this.enqueueMerge({ level: 2, sourceIds: ['L1-queued-a', 'L1-queued-b'] });
  }

  /** An L1 over the given messages, as a compression writes one, merged into `parent` when one is given. */
  seedL1(id: string, sourceIds: string[], parent?: string): void {
    this.pushSummary({
      id, level: 1, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
      content: 'summary '.repeat(100), tokens: 200, created: 0,
      ...(parent ? { mergedInto: parent } : {}),
    });
  }

  /** An L2 over the given L1s in memory, spanning their messages, as a merge writes one. */
  seedL2(id: string, l1Ids: string[]): void {
    const sources = l1Ids.map((l1) => this.summaries.find((summary) => summary.id === l1));
    assert.ok(sources.every((source) => source !== undefined), 'the L1s are in memory');
    this.pushSummary({
      id, level: 2, sourceLevel: 1, sourceIds: l1Ids,
      sourceRange: { first: sources[0]!.sourceRange.first, last: sources[sources.length - 1]!.sourceRange.last },
      content: 'summary '.repeat(100), tokens: 200, created: 0,
    });
  }

  /** An L1 shorter than any message here, so a plan that folds anything through it gets smaller. */
  seedShortL1(id: string, sourceIds: string[]): void {
    this.pushSummary({
      id, level: 1, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
      content: 'a short summary', tokens: 4, created: 0,
    });
  }

  /** Queues a merge of real summaries, an L2 unless another level is given. */
  queueMergeOf(sourceIds: string[], level: SummaryLevel = 2): void {
    this.enqueueMerge({ level, sourceIds });
  }

  /** An L1 over the given messages that only the store holds, as another instance over the same store writes one. */
  seedStoredL1(id: string, sourceIds: string[]): void {
    const persisted = this.store?.getStateJson(this.summariesStateId);
    this.store?.setStateJson(this.summariesStateId, [...(Array.isArray(persisted) ? persisted : []), {
      id, level: 1, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
      content: 'summary '.repeat(100), tokens: 200, created: 0,
    }]);
  }

  /** The ids of the summaries in memory. */
  summaryIds(): string[] {
    return this.summaries.map((summary) => summary.id);
  }

  /** Sets the thin-chunk guard's threshold, as a host restarted with another configuration does. */
  setMinChunkChars(chars: number): void {
    this.config.minChunkCharsForLLM = chars;
  }

  /** Sets compressionContextBudgetTokens, as a host restarted with another configuration does. */
  setContextBudget(tokens: number): void {
    this.config.compressionContextBudgetTokens = tokens;
  }

  /** Sets the head window's size, as a host restarted with another configuration does. */
  setHeadWindowTokens(tokens: number): void {
    this.config.headWindowTokens = tokens;
  }

  /** Sets the recent window's size, as a host restarted with another configuration does. */
  setRecentWindowTokens(tokens: number): void {
    this.config.recentWindowTokens = tokens;
  }

  /** Turns hierarchical merging on or off, as a host restarted with another configuration does. */
  setHierarchical(on: boolean): void {
    this.config.hierarchical = on;
  }

  /** How many merges are queued. */
  queuedMergeCount(): number {
    return this.mergeQueue.length;
  }

  /** Makes the durable compression quarantine unreadable, as a ledger state that won't parse does. */
  breakQuarantineRead(): void {
    const store = this.store!;
    const ledger = this.compressionRefusalQuarantineLedgerStateId;
    const read = store.getStateJson.bind(store);
    store.getStateJson = ((id: string) => {
      if (id === ledger) throw new Error('zz the quarantine ledger cannot be read');
      return read(id);
    }) as typeof store.getStateJson;
  }

  /** The store view the last count read. */
  private countedView: Parameters<AutobiographicalStrategy['compressionWorkQueued']>[0] | undefined;

  protected compressionWorkQueued(...args: Parameters<AutobiographicalStrategy['compressionWorkQueued']>): boolean {
    this.countedView = args[0];
    return super.compressionWorkQueued(...args);
  }

  /** Run the moment a call skips its chunk for the quarantine, before the call yields and tick's finally runs. */
  onQuarantineSkipProbe: (() => void) | undefined;

  protected override compressChunkHierarchical(...args: Parameters<AutobiographicalStrategy['compressChunkHierarchical']>): Promise<void> {
    const [chunk, ctx, onSkip, onRequestStopped, onJoinedWorkDiscarded] = args;
    const probe = this.onQuarantineSkipProbe;
    return super.compressChunkHierarchical(chunk, ctx, probe ? () => { onSkip?.(); probe(); } : onSkip, onRequestStopped, onJoinedWorkDiscarded);
  }

  /** Whether a hierarchical refusal's count would name compression now, over the store view the last refusal read. */
  countsCompressionWork(): boolean {
    assert.ok(this.countedView, 'a refusal has counted');
    return super.compressionWorkQueued(this.countedView, 'hierarchical');
  }

  /**
   * Each message's index in the store view the last refusal read, with the
   * head window's start and end there, where the recent window starts, and
   * where the hold region begins (the store's length with nothing held).
   */
  placement(ids: string[]): { indices: number[]; headStart: number; headEnd: number; recentStart: number; holdStart: number } {
    assert.ok(this.countedView, 'a refusal has counted');
    const all = this.countedView.getAll();
    return {
      indices: ids.map((id) => all.findIndex((message) => message.id === id)),
      headStart: this.getHeadWindowStartIndex(this.countedView),
      headEnd: this.getHeadWindowEnd(this.countedView),
      recentStart: this.getRecentWindowStart(this.countedView),
      holdStart: this.holdBoundary(this.countedView),
    };
  }

  /** The ids of the messages in the chunk holding the given one. */
  chunkHolding(id: string): string[] {
    const chunk = (this as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks.find((c) => c.messages.some((m) => m.id === id));
    assert.ok(chunk, `a chunk holds ${id}`);
    return chunk.messages.map((m) => m.id);
  }

  /**
   * Whether tick's request carries a tool block, as the count reads it, for
   * the chunk holding each given message, asked in this order of one
   * reading, over the store view the last refusal read.
   */
  carriesToolBlocks(messageIds: string[]): boolean[] {
    assert.ok(this.countedView, 'a refusal has counted');
    const self = this as unknown as {
      requestCarriesToolBlocks(store: Parameters<AutobiographicalStrategy['compressionWorkQueued']>[0]): (chunk: { messages: Array<{ id: string }> }) => boolean;
      chunks: Array<{ messages: Array<{ id: string }> }>;
    };
    const carries = self.requestCarriesToolBlocks(this.countedView);
    return messageIds.map((id) => {
      const chunk = self.chunks.find((c) => c.messages.some((m) => m.id === id));
      assert.ok(chunk, `a chunk holds ${id}`);
      return carries(chunk);
    });
  }

  /**
   * Rewrites the durable compression quarantine as a store an older release
   * wrote holds it: each record under budget accounting version 1. A record's
   * key and family key hash its normalized config, accounting version
   * included (compressionRefusalQuarantineRecord), so an older release's keys
   * match none tick computes now; a 'v1:' prefix on each stands in for that.
   */
  ageQuarantine(): void {
    const id = this.compressionRefusalQuarantineLedgerStateId;
    const ledger = this.store?.getStateJson(id);
    const events = structuredClone(Array.isArray(ledger) ? ledger : []) as Array<Record<string, any>>;
    const age = (record: Record<string, any> | undefined) => {
      if (!record) return;
      record.key = `v1:${record.key}`;
      record.familyKey = `v1:${record.familyKey}`;
      record.normalizedConfig = { ...record.normalizedConfig, accountingVersion: 1 };
    };
    for (const event of events) {
      if (typeof event.key === 'string') event.key = `v1:${event.key}`;
      age(event.record);
      for (const item of Array.isArray(event.active) ? event.active : []) age(item?.record);
    }
    this.store?.setStateJson(id, events);
  }

  /** When set, the reserved tail's emission reports one message fewer, as an emission that ran out of room does. */
  dropTailMessage = false;

  /** When set, the compression preflight says no, as a host that schedules compression itself does. */
  preflightNo = false;

  protected shouldCompressPreflight(): boolean {
    return !this.preflightNo && super.shouldCompressPreflight();
  }

  /** The message ids of each queued chunk, in queue order. */
  queuedChunkIds(): string[][] {
    return this.compressionQueue.map((index) => this.chunks[index]!.messages.map((m) => m.id));
  }

  protected emitRecentNewestFirst(...args: Parameters<AutobiographicalStrategy['emitRecentNewestFirst']>): ReturnType<AutobiographicalStrategy['emitRecentNewestFirst']> {
    const stats = super.emitRecentNewestFirst(...args);
    return this.dropTailMessage ? { ...stats, messages: stats.messages - 1 } : stats;
  }

  seedPyramid(ids: string[], depth: number): void {
    for (let level = 1; level <= depth; level++) {
      const content = 'summary '.repeat(100);
      const summary: SummaryEntry = {
        id: `L${level}-diagnostic`,
        level: level as SummaryLevel,
        sourceLevel: (level - 1) as SummaryLevel,
        sourceIds: level === 1 ? ids : [`L${level - 1}-diagnostic`],
        sourceRange: { first: ids[0], last: ids[ids.length - 1] },
        content,
        tokens: 200,
        created: 0,
        ...(level < depth ? { mergedInto: `L${level + 1}-diagnostic` } : {}),
      };
      this.pushSummary(summary);
    }
  }

  protected buildPicker(inputs: PickerInputs): Picker {
    this.pickerL1s.push(inputs.chunks.map((chunk) => chunk.l1Id));
    if (this.useRealPicker) return super.buildPicker(inputs);
    const level = this.level;
    const produce = this.produce;
    class DriftPicker extends Picker {
      run(inputs: PickerInputs, budget: FoldingBudget) {
        const result = super.run(inputs, budget);
        return { ...result, finalTokens: 1, budgetMet: true };
      }
    }
    class OverstatePicker extends Picker {
      run(inputs: PickerInputs, budget: FoldingBudget) {
        const result = super.run(inputs, budget);
        return { ...result, finalTokens: 10_000, budgetMet: false };
      }
    }
    const Constructor = this.drift ? DriftPicker : this.overstate ? OverstatePicker : Picker;
    return new Constructor({
      name: 'diagnostic-fixture',
      solve: (inputs) => ({
        frontier: new Map(inputs.chunks.map(chunk => [chunk.id, chunk.pinned || !chunk.l1Id ? 0 : level])),
        produced: produce && inputs.chunks.length > 0
          ? [{ level: 1, range: { firstChunkId: inputs.chunks[0].id, lastChunkId: inputs.chunks[inputs.chunks.length - 1].id } }]
          : [],
      }),
    });
  }
}

/** A membrane whose every model call is counted and fails. */
function countingMembrane(calls: { n: number }): Membrane {
  return { complete: async () => { calls.n++; throw new Error('no model in this test'); } } as unknown as Membrane;
}

/**
 * A membrane whose model call waits until the test lets it go: `called` settles at its first call,
 * `calls` counts them, and `release` rejects every call still waiting.
 */
function waitingMembrane(): { membrane: Membrane; called: Promise<void>; calls: { n: number }; release: () => void } {
  let first!: () => void;
  const called = new Promise<void>((resolve) => { first = resolve; });
  const calls = { n: 0 };
  const waiting: Array<(error: Error) => void> = [];
  const membrane = {
    complete: () => new Promise((_, reject) => {
      calls.n++;
      waiting.push(reject);
      first();
    }),
  } as unknown as Membrane;
  return { membrane, called, calls, release: () => { for (const reject of waiting.splice(0)) reject(new Error('released by the test')); } };
}

/**
 * A membrane that answers end_turn. On its first call it yields a macrotask, so tick has set
 * pendingCompression, then runs `during`, as a host acting while the request is out does.
 */
function answeringMembrane(during: () => void | Promise<void>): { membrane: Membrane; calls: { n: number } } {
  const calls = { n: 0 };
  const membrane = {
    complete: async () => {
      calls.n++;
      if (calls.n === 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await during();
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls.n}` }] };
    },
  } as unknown as Membrane;
  return { membrane, calls };
}

async function withManager(
  strategy: AutobiographicalStrategy,
  run: (manager: ContextManager) => Promise<void>,
  opts?: { membrane?: true | Membrane; namespace?: string },
) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-budget-diagnostics-'));
  // A stub is enough for tick to adopt an exact L1, which calls no model.
  const membrane = opts?.membrane ? { membrane: opts.membrane === true ? ({} as unknown as Membrane) : opts.membrane } : {};
  const namespace = opts?.namespace === undefined ? {} : { namespace: opts.namespace };
  const manager = await ContextManager.open({ path: join(directory, 'store'), strategy, ...membrane, ...namespace });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function refusal(manager: ContextManager, opts?: { dryRun?: boolean }): Promise<OverBudgetError> {
  try {
    await manager.compile({ maxTokens: 100, reserveForResponse: 20 }, undefined, opts);
    assert.fail('compile should refuse');
  } catch (error) {
    assert.ok(error instanceof OverBudgetError);
    return error;
  }
}

function checkBudget(error: OverBudgetError): void {
  // Runtime shape assertions also run against the old implementation.
  assert.equal(Reflect.get(error.diagnostics, 'configuredBudget'), 100);
  assert.equal(Reflect.get(error.diagnostics, 'reserveForResponse'), 20);
  assert.equal(Reflect.get(error.diagnostics, 'inputBudget'), 80);
  assert.equal(error.budget, 100, '25% grace applies to the 80-token input budget');
  assert.match(error.message, /configured=100, response reserve=20, input budget=80/);
}

describe('OverBudgetError diagnostics', () => {
  for (const adaptiveResolution of [true, false]) {
    it(`reports budget arithmetic and empty inventory for an early ${adaptiveResolution ? 'adaptive' : 'hierarchical'} refusal`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution,
        headWindowTokens: 10_000,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
        const error = await refusal(manager);
        checkBudget(error);
        assert.deepEqual(error.clearedBy, [], 'the head alone is over: only a larger budget clears it');
        assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 0);
        assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), {});
        assert.match(error.message, /summary inventory: empty/);
        if (adaptiveResolution) {
          assert.match(error.message, /^Head\/tail reservation exceeded budget/);
          assert.match(error.message, /fold plan=not computed/);
          assert.doesNotMatch(error.message, /deepest planned level/);
        } else {
          assert.match(error.message, /^Hierarchical emission overran the budget/);
          assert.match(error.message, /attempted representation level=L0/);
        }
      });
    });
  }

  it('counts pre-head middle messages in a refusal before planning after a head reset', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 100_000,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      strategy.resetHeadWindow(ids[4]);
      const error = await refusal(manager);
      assert.equal(error.diagnostics.middleChunkCount, 4, 'the four messages before the reset head are middle too');
      assert.deepEqual(error.clearedBy, [], 'the head alone is over');
      assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'unplanned');
      assert.match(error.message, /middle picker chunks=4/);
      assert.match(error.message, /fold plan=not computed/);
      assert.doesNotMatch(error.message, /deepest planned level/);
    });
  });

  for (const positionedRecallPairs of [true, false]) {
    it(`labels hierarchical ${positionedRecallPairs ? 'selection items' : 'raw-message fallback'} and attempted depth`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        positionedRecallPairs,
        targetChunkTokens: 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 2 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(positionedRecallPairs ? ids : ids.slice(1), 1);
        const error = await refusal(manager);
        assert.equal(error.diagnostics.middleChunkCount, 1);
        assert.deepEqual(error.clearedBy, [], 'no closed chunk waits for compression');
        assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'attempted');
        assert.equal(Reflect.get(error.diagnostics, 'middleCountUnit'), positionedRecallPairs ? 'selection-items' : 'raw-messages');
        assert.match(error.message, positionedRecallPairs
          ? /selected middle representations=1, attempted representation level=L1/
          : /middle raw messages=1, attempted representation level=L0/);
        assert.doesNotMatch(error.message, /deepest planned level|picker chunks/);
      });
    });
  }

  for (const level of [1, 5]) {
    it(`distinguishes planned L${level} from available L5 and picker chunks from summaries`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.level = level;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 12 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(ids, 5);
        // A locked planned representation still counts toward the plan's depth.
        for (const id of ids) strategy.lockChunk(id);
        const error = await refusal(manager);
        checkBudget(error);
        assert.equal(error.diagnostics.deepestLevel, level);
        assert.deepEqual(error.clearedBy, [], 'the plan has no summaries left to produce');
        assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 5);
        assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
        assert.equal(error.diagnostics.middleChunkCount, 12);
        assert.equal(Reflect.get(error.diagnostics, 'middleCountUnit'), 'picker-chunks');
        assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'planned');
        assert.match(error.message, /middle picker chunks=12/);
        assert.match(error.message, new RegExp(`deepest planned level=L${level}, deepest available level=L5`));
        assert.match(error.message, /summary inventory: L1=1 L2=1 L3=1 L4=1 L5=1/);
      });
    });
  }

  it('enriches emission-stage failures as well as picker-stage failures', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.level = 5;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'raw '.repeat(200) }]);
      const id = manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      strategy.seedPyramid([id], 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Emission overran the plan/);
      checkBudget(error);
      assert.deepEqual(error.clearedBy, [], 'the plan has no summaries left to produce');
      assert.equal(error.diagnostics.deepestLevel, 5, 'the first raw emission fails, but the complete plan reaches L5');
      assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'planned');
      assert.match(error.message, /deepest planned level=L5/);
      assert.doesNotMatch(error.message, /attempted representation level/);
      assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 5);
      assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    });
  });

  it('logs both depths when the real kv-stable solver escalates', async (t) => {
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.map(String).join(' ')));
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      foldingStrategy: 'kv-stable',
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.useRealPicker = true;
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, () =>
        manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]));
      strategy.seedPyramid(ids, 5);
      const error = await refusal(manager);
      const escalation = logs.find(line => line.startsWith('[kv-escalation]'));
      assert.ok(escalation, 'fixture must exercise an actual solver override');
      assert.deepEqual(error.clearedBy, [], 'no closed chunk waits for compression');
      assert.match(escalation, new RegExp(`deepestPlannedLevel=L${error.diagnostics.deepestLevel}`));
      assert.match(escalation, /deepestAvailableLevel=L5/);
      // Its namespace ends the line (#239), so one process's strategies' lines can be told apart.
      assert.match(escalation, / deepestAvailableLevel=L5 \(see adaptive-resolution-design\.md §13\.4\) ns=agents\/wren$/);
    }, { namespace: 'agents/wren' });
  });

  it('keeps the original external constructor shape usable without inventing inventory', () => {
    const diagnostics = { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 4, deepestLevel: 0 };
    const error = new OverBudgetError({ actual: 6, budget: 5, diagnostics });
    assert.strictEqual(error.diagnostics, diagnostics);
    assert.equal(error.name, 'OverBudgetError');
    assert.match(error.message, /across 4 chunks/);
    assert.match(error.message, /deepest fold level=L0/);
    assert.doesNotMatch(error.message, /planned|attempted|picker chunks/);
    assert.doesNotMatch(error.message, /available|inventory|configured|undefined/);
  });
});

describe('OverBudgetError.clearedBy', () => {
  it('is empty and frozen when the thrower names nothing', () => {
    const error = new OverBudgetError({
      budget: 10,
      actual: 20,
      diagnostics: { headTokens: 0, tailTokens: 20, middleTokens: 0, middleChunkCount: 0, deepestLevel: 0 },
    });
    assert.deepEqual(error.clearedBy, []);
    assert.ok(Object.isFrozen(error.clearedBy));
  });

  const recentOnly = (recentWindowTokens: number) => new AutobiographicalStrategy({
    adaptiveResolution: true,
    headWindowTokens: 0,
    recentWindowTokens,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
  });

  it('names a smaller recent window when the raw recent window is what is over and the newest message fits', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  it('names a smaller window when a message split into shards is over but its newest shard fits, since its earlier shards can fold', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 20,
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      // Over twice targetChunkTokens, so ingress splits it into shards of about 20 tokens.
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      const shards = manager.getAllMessages();
      assert.ok(shards.length > 4, `the message is stored as shards (got ${shards.length})`);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.ok(error.diagnostics.tailTokens > error.budget, 'the whole body is over the budget');
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  const toolTurn = (manager: ContextManager, id: string, callWords: number, resultWords: number): void => {
    manager.addMessage('agent', [
      { type: 'text', text: 'calling ' + 'word '.repeat(callWords) },
      { type: 'tool_use', id, name: 'read', input: {} },
    ]);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: id, content: 'result ' + 'word '.repeat(resultWords) }]);
  };

  it('counts a newest tool_result with the tool_use before it, since no window splits the pair', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      // The result alone fits the budget, but its call and it together don't.
      toolTurn(manager, 't1', 150, 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, [], 'the newest turn the compile must keep raw is the call and its result');
    });
  });

  it('names a smaller window when the newest tool_result and its call fit together', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      toolTurn(manager, 't1', 10, 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  for (const [callWords, expected] of [[200, []], [30, ['smaller-recent-window']]] as const) {
    it(`counts a call split into shards from its first shard, which holds the tool_use, before the newest tool_result (${expected.length ? 'names a smaller window when the whole call and its result fit' : 'names nothing when only its last shard and the result would'})`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true,
        targetChunkTokens: 10,
        headWindowTokens: 0,
        recentWindowTokens: 100_000,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const before = manager.getAllMessages().length;
        // Over twice targetChunkTokens, so ingress splits the call into shards.
        toolTurn(manager, 't1', callWords, 5);
        const stored = manager.getAllMessages();
        const shards = stored.slice(before, -1);
        assert.ok(shards.length > 1, `the call is stored as shards (got ${shards.length})`);
        assert.ok(shards[0]!.content.some((block) => block.type === 'tool_use'), 'its first shard holds the tool_use');
        assert.ok(!shards.at(-1)!.content.some((block) => block.type === 'tool_use'), 'its last shard holds none');
        const error = await refusal(manager);
        assert.match(error.message, /^Head\/tail reservation exceeded budget/);
        assert.deepEqual(error.clearedBy, expected);
      });
    });
  }

  for (const [resultWords, callWords, expected, when] of [
    [200, 0, [], 'names nothing when only its last shard would fit'],
    [30, 0, ['smaller-recent-window'], 'names a smaller window when they fit'],
    [30, 60, [], 'names nothing when its body alone would fit but not with its call'],
  ] as const) {
    it(`counts a result split into shards with its whole body and its call, since its first shard holds the tool_result (${when})`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true,
        targetChunkTokens: 10,
        headWindowTokens: 0,
        recentWindowTokens: 100_000,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const beforeCall = manager.getAllMessages().length;
        manager.addMessage('agent', [{ type: 'text', text: 'calling ' + 'word '.repeat(callWords) }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
        const before = manager.getAllMessages().length;
        if (callWords > 0) assert.ok(before - beforeCall > 1, 'the call is stored as shards too');
        // Over twice targetChunkTokens, so ingress splits the result into shards.
        manager.addMessage('user', [
          { type: 'tool_result', toolUseId: 't1', content: 'ok' },
          { type: 'text', text: 'result ' + 'word '.repeat(resultWords) },
        ]);
        const shards = manager.getAllMessages().slice(before);
        assert.ok(shards.length > 1, `the result is stored as shards (got ${shards.length})`);
        assert.ok(shards[0]!.content.some((block) => block.type === 'tool_result'), 'its first shard holds the tool_result');
        assert.ok(!shards.at(-1)!.content.some((block) => block.type === 'tool_result'), 'its last shard holds none');
        const error = await refusal(manager);
        assert.match(error.message, /^Head\/tail reservation exceeded budget/);
        assert.deepEqual(error.clearedBy, expected);
      });
    });
  }

  it('clears the head/tail refusal at the smaller window it names (the next refusal can be the picker\'s)', async () => {
    const strategy = recentOnly(100_000);
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const first = await refusal(manager);
      assert.deepEqual(first.clearedBy, ['smaller-recent-window']);
      // The newest turn is the newest message: a window that holds only it.
      strategy.updateHotContextSettings({ tailTokens: 1 });
      const next = await refusal(manager);
      assert.doesNotMatch(next.message, /^Head\/tail reservation exceeded budget/, 'the raw windows now fit');
      assert.match(next.message, /^Adaptive picker exhausted/, 'the next refusal is the picker\'s, with no summaries to fold through');
    });
  });

  it('names nothing when a hold inside the head leaves every window\'s tail at the head\'s end', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 30,
      recentWindowTokens: 100_000,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 6 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(20) }]));
      const unheld = await refusal(manager);
      assert.deepEqual(unheld.clearedBy, ['smaller-recent-window'], 'the head and the newest message fit');
      manager.holdCompression([ids[0]], { timeoutMs: 60_000 });
      const held = await refusal(manager);
      assert.match(held.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(held.clearedBy, [], 'no window starts after the hold, so every tail starts at the head\'s end');
      manager.releaseCompression([ids[0]]);
    });
  });

  it('names nothing when the newest message alone is over, since it stays raw whatever the window', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(10) }]);
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, []);
    });
  });

  it('names nothing when a hold inside the window would stop a smaller one short of fitting', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      const ids = Array.from({ length: 6 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      manager.holdCompression([ids[3]], { timeoutMs: 60_000 });
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, [], 'no window starts after the hold, and messages 3 to 5 are over the budget');
      manager.releaseCompression([ids[3]]);
    });
  });

  it('names nothing when a compression hold is what keeps the recent window this large', async () => {
    await withManager(recentOnly(60), async (manager) => {
      const ids = Array.from({ length: 6 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      manager.holdCompression([ids[0]], { timeoutMs: 60_000 });
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, []);
      manager.releaseCompression([ids[0]]);
    });
  });

  /** What a compile with room sends, as the store estimates it. */
  async function sentTotal(manager: ContextManager): Promise<number> {
    const store = (manager as unknown as { messageStore: { estimateTokens(message: StoredMessage): number } }).messageStore;
    const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    return compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as StoredMessage), 0);
  }

  it('prices the newest turn as it renders under the cap, and names a smaller window when the head and that turn fit', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      maxMessageTokens: 50,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      // Each message is over the cap, so each costs what its first 200
      // characters and the cut's suffix estimate at: the newest alone fits
      // the 100-token budget, and six are over it.
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(200) }]);
      const sent = await sentTotal(manager);
      // The six messages are the same length, so each sends a sixth of it.
      assert.ok(sent / 6 <= 100, `premise: the newest turn alone fits: ${sent / 6}`);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.equal(error.budget, 100);
      assert.equal(error.diagnostics.tailTokens, sent);
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  it('names no smaller window when the newest turn renders past the budget, though the cap alone would have priced it within', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      maxMessageTokens: 50,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      // The newest message is over the cap and carries an image, which the cap
      // keeps whole: it renders past the budget, where the cap plus 50 was 100.
      for (let i = 0; i < 5; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(200) }]);
      manager.addMessage('user', [
        { type: 'text', text: 'message 5 ' + 'word '.repeat(200) },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock,
      ]);
      const sent = await sentTotal(manager);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.equal(error.diagnostics.tailTokens, sent);
      // The newest turn's image alone is the store's 1,600 tokens.
      assert.deepEqual(error.clearedBy, [], 'a smaller recent window still holds the newest turn');
    });
  });

  for (const [closed, produce, expected] of [
    [true, true, ['compression']],
    [false, true, []],
    [true, false, []],
  ] as const) {
    it(`names compression for the picker only when its plan has summaries to produce and chunks are there to make them (${closed ? 'closed chunks' : 'the unclosed trailing span'}, ${produce ? 'summaries to produce' : 'none to produce'})`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        // Small chunks close as messages arrive; large ones leave every message
        // in the unclosed span, where a produce op enqueues nothing.
        targetChunkTokens: closed ? 40 : 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.produce = produce;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const error = await refusal(manager);
        assert.match(error.message, /^Adaptive picker exhausted/);
        assert.deepEqual(error.clearedBy, expected);
      });
    });
  }

  it('names compression at the emission refusal while its plan has summaries to produce and a compression runs', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.level = 5;
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'raw '.repeat(200) }]);
      const id = manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      strategy.seedPyramid([id], 5);
      strategy.startCompressing();
      const error = await refusal(manager);
      assert.match(error.message, /^Emission overran the plan/);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  it('names the plan\'s list at the tail-check refusal', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 30,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.produce = true;
    strategy.dropTailMessage = true;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(10) }]);
      strategy.startCompressing();
      const error = await refusal(manager);
      assert.match(error.message, /^Tail emission dropped reserved recent-window messages/);
      assert.deepEqual(error.clearedBy, ['compression']);
      strategy.produce = false;
      const without = await refusal(manager);
      assert.match(without.message, /^Tail emission dropped reserved recent-window messages/);
      assert.deepEqual(without.clearedBy, [], 'a plan with nothing to produce names nothing');
    });
  });

  it('carries the refusal\'s list into a preview that doesn\'t fit', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const preview = manager.previewContext({ maxTokens: 100, reserveForResponse: 20 });
      assert.ok(preview);
      assert.equal(preview.fits, false);
      assert.deepEqual(preview.clearedBy, ['smaller-recent-window']);
    });
  });

  for (const running of [true, false]) {
    it(`carries the plan's list into a preview whose plan is over though its render fits (${running ? 'a compression runs' : 'no compression work'})`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.overstate = true;
      strategy.produce = true;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(10) }]);
        if (running) strategy.startCompressing();
        // A dry run reports a plan over the budget rather than refusing it,
        // and this one renders within the budget, so nothing later throws:
        // the dry compile resolves, and the preview is the one the plan recorded.
        await manager.compile({ maxTokens: 100, reserveForResponse: 20 }, undefined, { dryRun: true });
        const preview = manager.previewContext({ maxTokens: 100, reserveForResponse: 20 });
        assert.ok(preview);
        assert.equal(preview.fits, false);
        assert.equal(preview.finalTokens, 10_000, 'the preview is the plan\'s, not a later refusal\'s');
        assert.deepEqual(preview.clearedBy, running ? ['compression'] : []);
        // The live compile refuses the same plan at the picker's gate, with the same list.
        const live = await refusal(manager);
        assert.match(live.message, /^Adaptive picker exhausted/);
        assert.deepEqual(live.clearedBy, running ? ['compression'] : []);
      });
    });
  }

  it('keeps the plan\'s list and numbers in a preview whose plan is over when a later stage refuses with another', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.overstate = true;
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'message ' + 'word '.repeat(10) }]);
      // An unanswered call is the newest turn; the structural repair trims it
      // and then refuses, naming nothing.
      manager.addMessage('agent', [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
      strategy.startCompressing();
      const dry = await refusal(manager, { dryRun: true });
      assert.match(dry.message, /^Structural repair did not retain the newest turn/);
      assert.deepEqual(dry.clearedBy, []);
      // The live compile refuses the plan at its gate first, so the preview
      // names what that refusal names.
      const preview = manager.previewContext({ maxTokens: 100, reserveForResponse: 20 });
      assert.ok(preview);
      assert.equal(preview.fits, false);
      assert.deepEqual(preview.clearedBy, ['compression']);
      const live = await refusal(manager);
      assert.match(live.message, /^Adaptive picker exhausted/);
      assert.deepEqual(live.clearedBy, ['compression']);
      // The preview's numbers are that refusal's too, not the later stage's.
      assert.equal(preview.finalTokens, live.actual);
      assert.equal(preview.budgetTokens, live.budget);
      assert.notEqual(dry.actual, live.actual, 'the later stage measured something else');
    });
  });

  it('reports a calibration retry\'s head/tail refusal in a preview, as the live compile does, not the discarded attempt\'s plan', async () => {
    // A provisional multiplier above 1 is dropped to 1 when its compile is
    // refused, and the select runs again (#179). At 1 the head window holds
    // more messages, so the retry can refuse at the head/tail check, before
    // its plan records a preview, where the first attempt's plan was over.
    const directory = mkdtempSync(join(tmpdir(), 'cm-budget-diagnostics-'));
    const path = join(directory, 'store');
    const options = {
      adaptiveResolution: true,
      targetChunkTokens: 100_000, // no message is split, and no chunk closes
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    } as const;
    type Internals = { store: { setStateJson(id: string, value: unknown): void } | null; calibrationStateId: string };
    try {
      // One message's estimate at 1, with every message in the head.
      const measuring = new DiagnosticStrategy({ ...options, headWindowTokens: 1_000_000_000 });
      const opened = await ContextManager.open({ path, strategy: measuring });
      for (let i = 0; i < 8; i++) opened.addMessage('user', [{ type: 'text', text: 'word '.repeat(400) }]);
      const each = opened.previewContext({ maxTokens: 2_000_000_000, reserveForResponse: 20 })!.headTokens / 8;
      // A multiplier without a pricing stamp loads as provisional.
      const internals = measuring as unknown as Internals;
      internals.store!.setStateJson(internals.calibrationStateId, { multiplier: 1.45, at: Date.now() });
      await opened.close();

      // A head window of 2.5 messages holds one at 1.45 and two at 1, and a
      // rejection budget of 1.75 lies between them.
      const strategy = new DiagnosticStrategy({ ...options, headWindowTokens: Math.round(2.5 * each) });
      strategy.produce = true;
      const manager = await ContextManager.open({ path, strategy });
      try {
        strategy.startCompressing(); // compression runs, so a plan's list names it
        const budget = { maxTokens: Math.round((1.75 * each) / 1.25) + 20, reserveForResponse: 20 };
        const preview = manager.previewContext(budget);
        assert.ok(preview);
        const live = await manager.compile(budget).then(() => assert.fail('compile should refuse'), (e: unknown) => e);
        assert.ok(live instanceof OverBudgetError);
        assert.match(live.message, /^Head\/tail reservation exceeded budget/);
        assert.equal(live.diagnostics.headTokens, 2 * each, 'the retry ran at 1, where the head holds two messages');
        assert.deepEqual(live.clearedBy, []);
        assert.equal(preview.fits, false);
        assert.deepEqual(
          [preview.finalTokens, preview.budgetTokens, preview.headTokens, preview.clearedBy],
          [live.actual, live.budget, live.diagnostics.headTokens, live.clearedBy],
          'the preview is the retry\'s refusal',
        );
      } finally {
        await manager.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('carries no list in a preview that fits, with compression work running', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(10) }]);
      strategy.startCompressing();
      const preview = manager.previewContext({ maxTokens: 100_000, reserveForResponse: 20 });
      assert.ok(preview);
      assert.equal(preview.fits, true);
      assert.equal('clearedBy' in preview, false);
    });
  });

  it('names compression in a dry run only for work queued without its plan\'s ops', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      // One closed chunk, which the holdback keeps out of the queue until a
      // produce op demands it. A dry run never enqueues its plan's ops.
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const dry = await refusal(manager, { dryRun: true });
      assert.match(dry.message, /^Emission overran the plan/);
      assert.deepEqual(dry.clearedBy, []);
      const live = await refusal(manager);
      assert.match(live.message, /^Emission overran the plan/);
      assert.deepEqual(live.clearedBy, ['compression'], 'the live compile demands the chunk first');
    });
  });

  it('names compression for a hierarchical refusal of history that chunks waiting for compression cover', async () => {
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'zz-model',
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      assert.equal(strategy.checkReadiness().ready, false, 'chunks are waiting for compression');
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  it('names nothing for queued chunks that need a model call while the compression quarantine holds them, which tick skips without one', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      compressionModel: 'zz-model',
      compressionRefusalCurveFallbacks: 0,
      minChunkCharsForLLM: 0,
    });
    const calls = { n: 0 };
    // Every request is refused, so each chunk's family exhausts into the quarantine.
    const refusing = {
      complete: async () => {
        calls.n++;
        return { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
      },
    } as unknown as Membrane;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'before the drain, the queued chunks are compression work');
      for (let round = 1; round <= 3; round++) {
        const before = calls.n;
        for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        if (round > 1) assert.equal(calls.n, before, `round ${round}: tick asks no model about a quarantined chunk`);
        assert.ok(strategy.getCompressionQuarantineStatus().count > 0, `round ${round}: chunks are quarantined`);
        const error = await refusal(manager);
        assert.ok(strategy.queuedChunkIds().length > 0, `round ${round}: the compile queued the quarantined chunks again`);
        assert.deepEqual(error.clearedBy, [], `round ${round}: nothing tick will do clears it`);
      }
    }, { membrane: refusing });
  });

  /**
   * A strategy whose every chunk needs a model call, a membrane that refuses
   * every request, and a drive that ticks every queued chunk into the
   * compression quarantine and answers the chunks a compile queues again.
   */
  const quarantining = () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      compressionModel: 'zz-model',
      compressionRefusalCurveFallbacks: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 1000,
    });
    const calls = { n: 0 };
    const membrane = {
      complete: async () => {
        calls.n++;
        return { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
      },
    } as unknown as Membrane;
    const drive = async (manager: ContextManager): Promise<string[][]> => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      await refusal(manager);
      for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.ok(strategy.getCompressionQuarantineStatus().count > 0, 'chunks are quarantined');
      assert.deepEqual((await refusal(manager)).clearedBy, [], 'the quarantine holds the queued chunks');
      const queued = strategy.queuedChunkIds();
      assert.ok(queued.length > 0, 'the compile queued the quarantined chunks again');
      return queued;
    };
    return { strategy, calls, membrane, drive };
  };

  it("names nothing for a quarantined chunk while tick's call yields after skipping it", async () => {
    const { strategy, membrane, drive } = quarantining();
    await withManager(strategy, async (manager) => {
      const queued = await drive(manager);
      // The count while tick's call yields after skipping the chunk, before tick's finally clears the
      // work in flight: a timer set at the skip fires ahead of the hop, which tick schedules only once
      // the call returns.
      const seen: Array<{ inFlight: readonly string[] | undefined; skipped: boolean | undefined; counts: boolean }> = [];
      strategy.onQuarantineSkipProbe = () => {
        setTimeout(() => {
          seen.push({ inFlight: strategy.chunkInFlight(), skipped: strategy.chunkInFlightSkipped(), counts: strategy.countsCompressionWork() });
        }, 0);
      };
      await manager.tick();
      strategy.onQuarantineSkipProbe = undefined;
      assert.ok(seen.length >= 1, 'premise: tick took a chunk, which the quarantine skipped');
      assert.deepEqual(seen[0]!.inFlight, queued[0], 'premise: the first chunk queued');
      for (const [i, at] of seen.entries()) {
        assert.deepEqual({ skipped: at.skipped, counts: at.counts }, { skipped: true, counts: false }, `skip ${i}: a chunk its call skipped frees no room while the call yields`);
      }
      assert.equal(strategy.chunkInFlight(), undefined, 'premise: the call has ended');
      assert.equal(strategy.countsCompressionWork(), false, 'premise: with nothing in flight, the quarantined chunks queued count nothing');
    }, { membrane });
  });

  it("names compression for a quarantined chunk whose call goes out, a new request family's fresh attempt, while the call runs", async () => {
    const { strategy, drive } = quarantining();
    // Refuses at once, as quarantining's membrane does, until `held` is set; then holds the call open.
    let held: { reached: () => void; release?: () => void } | undefined;
    const membrane = {
      complete: async () => {
        const at = held;
        if (at) {
          at.reached();
          await new Promise<void>((resolve) => { at.release = resolve; });
        }
        return { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
      },
    } as unknown as Membrane;
    await withManager(strategy, async (manager) => {
      const queued = await drive(manager);
      // A new context budget is a new request family, and the chunk's one quarantine record is under the shape
      // cap, so tick's gate gives the chunk a fresh call, though the quarantine holds its source hash.
      strategy.setContextBudget(123_456);
      let reached!: () => void;
      const out = new Promise<void>((resolve) => { reached = resolve; });
      const hold: { reached: () => void; release?: () => void } = { reached };
      held = hold;
      const ticking = manager.tick();
      await out;
      assert.deepEqual(strategy.chunkInFlight(), queued[0], 'premise: tick took the quarantined chunk, and its call is out');
      assert.equal(strategy.chunkInFlightSkipped(), false, "premise: its call wasn't skipped");
      assert.equal(strategy.countsCompressionWork(), true, 'its call counts while it runs');
      held = undefined;
      hold.release!();
      await ticking;
    }, { membrane });
  });

  for (const settle of ['adopts', 'stubs'] as const) {
    it(`names compression for quarantined chunks tick ${settle === 'adopts' ? 'adopts an exact L1 for' : 'stubs'} without a model call, before it reads the quarantine`, async () => {
      const { strategy, calls, membrane, drive } = quarantining();
      await withManager(strategy, async (manager) => {
        const queued = await drive(manager);
        if (settle === 'adopts') queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
        else strategy.setMinChunkChars(100_000);
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
        // The premise: tick settles each one without a model call, though the quarantine holds it.
        const before = calls.n;
        const summaries = strategy.summaryIds().length;
        for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.equal(calls.n, before, 'no model call');
        assert.equal(strategy.summaryIds().length, summaries + queued.length, `an L1 for each chunk, ${settle === 'adopts' ? 'adopted' : 'a stub'}`);
      }, { membrane });
    });
  }

  it('names compression for quarantined chunks an in-memory exact L1 covers, which tick adopts before it reads the quarantine', async () => {
    const { strategy, calls, membrane, drive } = quarantining();
    await withManager(strategy, async (manager) => {
      const queued = await drive(manager);
      queued.forEach((ids, i) => strategy.seedL1(`L1-memory-${i}`, ids));
      assert.deepEqual(strategy.queuedChunkIds(), queued, 'the quarantined chunks are still queued');
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      // The premise: tick adopts each chunk's L1 without a model call, though the quarantine holds it.
      const before = calls.n;
      const summaries = strategy.summaryIds().length;
      for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.equal(calls.n, before, 'no model call');
      assert.equal(strategy.summaryIds().length, summaries, 'each adopted the L1 seeded for it, and none was written');
    }, { membrane });
  });

  for (const thin of [false, true]) {
    it(`when the compression quarantine can't be read, names ${thin ? 'compression for chunks tick stubs before it reads it' : 'nothing for chunks that need a model call, since tick\'s read throws first'}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        mergeThreshold: 1000,
        minChunkCharsForLLM: thin ? 100_000 : 0,
      });
      const calls = { n: 0 };
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        strategy.breakQuarantineRead();
        // The refusal is still the over-budget one, with the count's list.
        assert.deepEqual((await refusal(manager)).clearedBy, thin ? ['compression'] : []);
        if (thin) {
          // The premise: tick stubs each chunk before it would read the quarantine.
          for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
          assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
          assert.equal(strategy.summaryIds().length, queued.length, 'a stub for each chunk');
        } else {
          // The premise: tick's own read throws before any model call.
          await assert.rejects(manager.tick(), /the quarantine ledger cannot be read/);
        }
        assert.equal(calls.n, 0, 'no model call');
      }, { membrane: countingMembrane(calls) });
    });
  }

  /** The config of a strategy whose chunks each need a model call, unless a test settles one another way. */
  const modelCallChunks = (extra: Record<string, unknown> = {}) => new DiagnosticStrategy({
    adaptiveResolution: false,
    targetChunkTokens: 40,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
    mergeThreshold: 1000,
    minChunkCharsForLLM: 0,
    ...extra,
  });

  /** A host's tick loop, as agent-framework's maintenance pass and its breaker run it: one try around every tick. */
  const hostTicks = async (manager: ContextManager, strategy: DiagnosticStrategy): Promise<void> => {
    for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
  };

  for (const cause of ['no model', 'unreadable quarantine'] as const) {
    it(`names nothing for a chunk tick adopts an L1 for, queued behind one that needs a model call ${cause === 'no model' ? 'without a compression model' : 'while the compression quarantine can\'t be read'}, since tick throws at that one first and a host's tick loop ends there`, async () => {
      const strategy = modelCallChunks(cause === 'no model' ? { compressionModel: undefined } : {});
      const calls = { n: 0 };
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        assert.ok(queued.length >= 2, 'two chunks or more are queued');
        const last = queued.at(-1)!;
        strategy.seedStoredL1('L1-stored-last', last);
        if (cause === 'unreadable quarantine') strategy.breakQuarantineRead();
        assert.deepEqual((await refusal(manager)).clearedBy, []);
        assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile queued the same chunks, in the same order');
        // The premise: the host's loop ends at the first chunk, and tick never reaches the last.
        const summaries = strategy.summaryIds().length;
        await assert.rejects(hostTicks(manager, strategy), cause === 'no model' ? /compressionModel is NOT configured/ : /the quarantine ledger cannot be read/);
        // A failure that didn't decide the chunk puts it back, behind the work that hasn't failed.
        assert.deepEqual(strategy.queuedChunkIds(), [...queued.slice(1), queued[0]], 'tick took the first chunk only, and put it back behind the others');
        assert.equal(strategy.summaryIds().length, summaries, 'tick adopted nothing');
        assert.equal(calls.n, 0, 'no model call');
      }, { membrane: countingMembrane(calls) });
    });
  }

  it('without a compression model, names nothing for a chunk tick adopts an L1 for, queued behind one whose only tool block is unpaired, which tick strips and then throws at', async () => {
    const strategy = modelCallChunks({ compressionModel: undefined });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      // A call stored without its result: tick strips it, so it doesn't defer the chunk for the host's tools.
      const callId = manager.addMessage('assistant', [{ type: 'text', text: 'message 0 ' + 'word '.repeat(30) }, { type: 'tool_use', id: 'zz-lone', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]);
      for (let i = 1; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      assert.ok(queued[0]!.includes(callId), 'the first queued chunk holds the call');
      strategy.seedStoredL1('L1-stored-last', queued.at(-1)!);
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      // The premise: tick doesn't defer the first chunk for the host's tools; it throws for want of a model.
      const summaries = strategy.summaryIds().length;
      await assert.rejects(hostTicks(manager, strategy), /compressionModel is NOT configured/);
      assert.equal(strategy.summaryIds().length, summaries, 'tick adopted nothing');
      assert.equal(calls.n, 0, 'no model call');
    }, { membrane: countingMembrane(calls) });
  });

  it('names nothing for a merge queued behind a chunk that needs a model call while the compression quarantine can\'t be read, since tick takes queued chunks before merges and throws at that one', async () => {
    const strategy = modelCallChunks({ hierarchical: true, positionedRecallPairs: true });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 24; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      // Two L1s over messages of the last two queued chunks, and their merge; the first chunk holds neither.
      assert.ok(queued.length >= 3, 'three chunks or more are queued');
      strategy.seedL1('L1-a', [queued.at(-2)![0]!]);
      strategy.seedL1('L1-b', [queued.at(-1)![0]!]);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      strategy.breakQuarantineRead();
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      // The premise: the host's loop ends at a chunk before tick reaches the merge.
      const summaries = strategy.summaryIds().length;
      await assert.rejects(hostTicks(manager, strategy), /the quarantine ledger cannot be read/);
      assert.equal(strategy.summaryIds().length, summaries, 'no merge ran');
      assert.equal(calls.n, 0, 'no model call');
    }, { membrane: countingMembrane(calls) });
  });

  it('names compression for a chunk tick adopts an L1 for, queued behind chunks the compression quarantine holds, which tick skips without a model call', async () => {
    const { strategy, calls, membrane, drive } = quarantining();
    await withManager(strategy, async (manager) => {
      const queued = await drive(manager);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      strategy.seedStoredL1('L1-stored-last', queued.at(-1)!);
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      // The premise: tick skips the quarantined chunks without a model call or a throw, and adopts the last one's L1.
      const before = calls.n;
      const summaries = strategy.summaryIds().length;
      await hostTicks(manager, strategy);
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.equal(calls.n, before, 'no model call');
      assert.equal(strategy.summaryIds().length, summaries + 1, 'the last chunk adopted its L1');
    }, { membrane });
  });

  it('names compression for a chunk tick adopts an L1 for, queued behind chunks it defers until the host declares its tools', async () => {
    const strategy = modelCallChunks();
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) {
        manager.addMessage('assistant', [{ type: 'tool_use', id: `zz-call-${i}`, name: 'zz_tool', input: { q: 'word '.repeat(20) } } as ContentBlock]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: `zz-call-${i}`, content: 'zz result' } as ContentBlock, { type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      }
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      strategy.seedStoredL1('L1-stored-last', queued.at(-1)!);
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      // The premise: tick defers the others without a model call or a throw, and adopts the last one's L1.
      const summaries = strategy.summaryIds().length;
      await hostTicks(manager, strategy);
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.equal(calls.n, 0, 'no model call');
      assert.equal(strategy.summaryIds().length, summaries + 1, 'the last chunk adopted its L1');
    }, { membrane: countingMembrane(calls) });
  });

  it('names compression for quarantined chunks whose records an older budget accounting wrote, which tick tries again', async () => {
    const { strategy, calls, membrane, drive } = quarantining();
    await withManager(strategy, async (manager) => {
      await drive(manager);
      strategy.ageQuarantine();
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      // The premise: tick asks the model about them again.
      const before = calls.n;
      for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.ok(calls.n > before, 'tick asked the model again');
    }, { membrane });
  });

  for (const settle of ['stubs', 'adopts'] as const) {
    it(`names compression before the host declares its tools for chunks tick ${settle === 'stubs' ? 'stubs under a Fable summarizer' : 'adopts an exact L1 for though they hold tool blocks'}, since it settles them before it defers`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        mergeThreshold: 1000,
        ...(settle === 'stubs' ? { compressionModel: 'claude-fable-5-1', minChunkCharsForLLM: 100_000 } : { minChunkCharsForLLM: 0 }),
      });
      // Without chunk records, adoption doesn't shrink a covered chunk, so the
      // count reads the store's L1s for its own sake here.
      if (settle === 'adopts') strategy.persistChunks = false;
      const calls = { n: 0 };
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) {
          const words: ContentBlock = { type: 'text', text: `message ${i} ` + 'word '.repeat(30) };
          if (settle === 'stubs') {
            manager.addMessage('user', [words]);
            continue;
          }
          manager.addMessage('assistant', [{ type: 'tool_use', id: `zz-call-${i}`, name: 'zz_tool', input: { q: 'word '.repeat(20) } } as ContentBlock]);
          manager.addMessage('user', [{ type: 'tool_result', toolUseId: `zz-call-${i}`, content: 'zz result' } as ContentBlock, words]);
        }
        const queued = await settledQueue(manager, strategy);
        if (settle === 'adopts') queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
        // The premise: with no tools declared, tick settles every queued chunk without a model call.
        for (let i = 0; i < 30 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.equal(calls.n, 0, 'tick asked no model');
        assert.equal(strategy.summaryIds().length, queued.length, `an L1 for each chunk, ${settle === 'adopts' ? 'adopted' : 'a stub'}`);
      }, { membrane: countingMembrane(calls) });
    });
  }

  const cycleAt = {
    'head window': 'in the head window, which tick\'s request carries',
    middle: 'in an earlier queued chunk, which tick\'s request carries as its raw middle',
    'reset head': 'in an earlier queued chunk below a reset head start, with the head window off, which tick\'s raw middle still carries',
    'covered head': 'in the head window that an L1 covers, which tick\'s request carries as that L1\'s recall pair',
    'source-only': 'in the head window, which a source-only request leaves out',
  } as const;
  for (const place of Object.keys(cycleAt) as (keyof typeof cycleAt)[]) {
    const counts = place === 'source-only' || place === 'covered head';
    const inChunk = place === 'middle' || place === 'reset head';
    it(`names ${counts ? 'compression' : 'nothing'} before the host declares its tools for text chunks after a tool cycle ${cycleAt[place]}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: inChunk ? 0 : 60,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        minChunkCharsForLLM: 0,
        ...(place === 'source-only' ? { compressionSourceOnly: true } : {}),
      });
      const calls = { n: 0 };
      await withManager(strategy, async (manager) => {
        // The conversation opens with a tool cycle.
        const cycle = [
          manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-open', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
          manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-open', content: 'zz result' } as ContentBlock]),
        ];
        const texts: string[] = [];
        for (let i = 0; i < 12; i++) texts.push(manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (place === 'reset head') strategy.resetHeadWindow(texts[6]);
        if (place === 'covered head') strategy.seedL1('L1-cycle', cycle);
        const error = await refusal(manager);
        const queued = strategy.queuedChunkIds();
        const textOnly = queued.filter((ids) => !ids.some((id) => cycle.includes(id)));
        assert.ok(textOnly.length > 0, 'text chunks are queued');
        if (inChunk) assert.ok(textOnly.length < queued.length, 'the cycle is in a queued chunk');
        else assert.equal(textOnly.length, queued.length, 'the cycle is in the head window, not a chunk');
        if (counts) {
          assert.deepEqual(error.clearedBy, ['compression']);
          // The premise: tick asks the model, tools or none, and the counting membrane throws.
          await assert.rejects(manager.tick(), /no model in this test/);
          assert.equal(calls.n, 1, 'tick asked the model');
          return;
        }
        assert.deepEqual(error.clearedBy, [], 'nothing tick will do clears it');
        // The premise: tick defers every queued chunk, with no model call.
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.equal(calls.n, 0, 'tick asked no model');
        manager.setToolDefinitions([{ name: 'zz_tool', description: 'zz', inputSchema: { type: 'object' } }]);
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'with the tools declared, they count');
      }, { membrane: countingMembrane(calls) });
    });
  }

  it('before the host declares its tools, counts no queued chunk that starts inside the head window when the head carries a tool cycle after the chunk\'s start, which tick\'s head carries raw', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      mergeThreshold: 1000,
      minChunkCharsForLLM: 0,
    });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      const add = (from: number) => {
        for (let i = from; i < from + 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      };
      add(0);
      const cycle = [
        manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-later', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-later', content: 'zz result' } as ContentBlock]),
      ];
      add(6);
      // The chunks close with the head window off; widening it then puts them
      // inside the head, as a host restarted with a larger window finds them.
      const queued = await settledQueue(manager, strategy);
      assert.ok(!queued[0].some((id) => cycle.includes(id)), 'the first queued chunk is text ahead of the cycle');
      strategy.setHeadWindowTokens(100_000);
      assert.equal(strategy.countsCompressionWork(), false, 'tick defers every queued chunk until the tools come');
      // The premise: tick's head carries the cycle raw, so it defers each queued chunk, with no model call.
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.equal(calls.n, 0, 'tick asked no model');
      assert.deepEqual(strategy.summaryIds(), [], 'and compressed none');
    }, { membrane: countingMembrane(calls) });
  });

  // The chunks the test above widens the head over lie wholly inside it, so they fold nothing and don't count
  // whatever the tools say. A chunk that lies before a reset head start folds, and the head after it, which
  // tick's request carries raw, is what holds it back: a tool message in the head lies past the chunk's start.
  it('before the host declares its tools, counts no queued chunk that lies before a reset head start when the head carries a tool cycle, which tick\'s request carries raw though it lies after the chunk', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 60,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      mergeThreshold: 1000,
      minChunkCharsForLLM: 0,
    });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      // The head starts at a text message, and a tool cycle follows it inside the head.
      const headStartId = manager.addMessage('user', [{ type: 'text', text: 'the head starts here' }]);
      const cycle = [
        manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-head', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-head', content: 'zz result' } as ContentBlock]),
      ];
      for (let i = 6; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      strategy.resetHeadWindow(headStartId);
      const error = await refusal(manager);
      const queued = strategy.queuedChunkIds();
      assert.ok(queued.length > 0, 'chunks are queued');
      const { indices, headStart, headEnd } = strategy.placement([...queued[0]!, ...cycle]);
      const chunkAt = indices.slice(0, queued[0]!.length);
      const cycleAt = indices.slice(queued[0]!.length);
      assert.ok(chunkAt.every((i) => i >= 0 && i < headStart), 'the premise: the first queued chunk lies before the head window\'s start, so it folds');
      assert.ok(!queued[0]!.some((id) => cycle.includes(id)), 'the premise: and holds no tool block of its own');
      assert.ok(cycleAt.every((i) => i >= headStart && i < headEnd), 'the premise: the cycle sits in the head window, past the chunk\'s start');
      assert.deepEqual(error.clearedBy, [], 'tick defers every queued chunk until the tools come');
      // The premise: tick's request carries the head raw, cycle included, so it defers each queued chunk, with no model call.
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.equal(calls.n, 0, 'tick asked no model');
      assert.deepEqual(strategy.summaryIds(), [], 'and compressed none');
      manager.setToolDefinitions([{ name: 'zz_tool', description: 'zz', inputSchema: { type: 'object' } }]);
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'with the tools declared, they count');
    }, { membrane: countingMembrane(calls) });
  });

  const pinnedCycleAt = {
    'head window': 'in the head window, which tick\'s head then carries raw',
    'reset head': 'before a reset head start, which tick\'s request then carries raw though it lies before the head',
  } as const;
  for (const place of Object.keys(pinnedCycleAt) as (keyof typeof pinnedCycleAt)[]) {
    it(`names nothing before the host declares its tools once a pin opens the L1 that covers a tool cycle ${pinnedCycleAt[place]}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: 60,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        minChunkCharsForLLM: 0,
      });
      const calls = { n: 0 };
      await withManager(strategy, async (manager) => {
        // The conversation opens with a tool cycle, which an L1 covers.
        const cycle = [
          manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-pinned', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
          manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-pinned', content: 'zz result' } as ContentBlock]),
        ];
        const texts: string[] = [];
        for (let i = 0; i < 12; i++) texts.push(manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (place === 'reset head') strategy.resetHeadWindow(texts[6]!);
        strategy.seedL1('L1-cycle', cycle);
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'the premise: covered, the cycle holds no chunk back');
        const { indices, headStart, headEnd } = strategy.placement(cycle);
        if (place === 'head window') assert.ok(indices.every((i) => i >= headStart && i < headEnd), 'the premise: the cycle sits in the head window');
        else assert.ok(indices.every((i) => i >= 0 && i < headStart), 'the premise: the cycle sits before the head window\'s start');
        // A pin on the call opens the L1 for every chunk after it, so tick's request carries the cycle raw.
        manager.pinRange(cycle[0]!, cycle[0]!, { name: 'zz-pin' });
        const error = await refusal(manager);
        assert.ok(strategy.queuedChunkIds().length > 0, 'text chunks are queued');
        assert.deepEqual(error.clearedBy, [], 'nothing tick will do clears it');
        // The premise: tick defers every queued chunk, with no model call.
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.equal(calls.n, 0, 'tick asked no model');
        manager.setToolDefinitions([{ name: 'zz_tool', description: 'zz', inputSchema: { type: 'object' } }]);
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'with the tools declared, they count');
      }, { membrane: countingMembrane(calls) });
    });
  }

  for (const pinned of [false, true]) {
    it(`names ${pinned ? 'nothing' : 'compression'} before the host declares its tools for text chunks after a tool cycle no L1 covers, before the head window's start, ${pinned ? 'pinned, which tick\'s request then carries raw' : 'which tick\'s request leaves out'}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: 60,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        minChunkCharsForLLM: 0,
      });
      const calls = { n: 0 };
      await withManager(strategy, async (manager) => {
        // The conversation opens with a tool cycle, and the head window starts after it.
        const cycle = [
          manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-before-head', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
          manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-before-head', content: 'zz result' } as ContentBlock]),
        ];
        const texts: string[] = [];
        for (let i = 0; i < 12; i++) texts.push(manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.resetHeadWindow(texts[6]!);
        if (pinned) manager.pinRange(cycle[0]!, cycle[1]!, { name: 'zz-pin' });
        const error = await refusal(manager);
        const { indices, headStart } = strategy.placement(cycle);
        assert.ok(indices.every((i) => i >= 0 && i < headStart), 'the premise: the cycle sits before the head window\'s start');
        const queued = strategy.queuedChunkIds();
        assert.ok(queued.some((ids) => !ids.some((id) => cycle.includes(id))), 'text chunks are queued');
        if (!pinned) {
          assert.deepEqual(error.clearedBy, ['compression']);
          // The premise: tick's request leaves the cycle out, so tick asks the model, and the counting membrane throws.
          await assert.rejects(async () => {
            for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
          }, /no model in this test/);
          assert.equal(calls.n, 1, 'tick asked the model');
          return;
        }
        assert.deepEqual(error.clearedBy, [], 'nothing tick will do clears it');
        // The premise: tick's request carries the pinned cycle raw, so tick defers every queued chunk, with no model call.
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.equal(calls.n, 0, 'tick asked no model');
        manager.setToolDefinitions([{ name: 'zz_tool', description: 'zz', inputSchema: { type: 'object' } }]);
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'with the tools declared, they count');
      }, { membrane: countingMembrane(calls) });
    });
  }

  it('reads the pins before each chunk: a pinned tool cycle before the head window\'s start is carried for a chunk after it, not for one before it, in either order of asking', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 60,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      minChunkCharsForLLM: 0,
    });
    await withManager(strategy, async (manager) => {
      const text = (i: number): string => manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const before = [0, 1, 2, 3, 4, 5, 6, 7].map(text);
      const cycle = [
        manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-between', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-between', content: 'zz result' } as ContentBlock]),
      ];
      const after = [8, 9, 10, 11, 12, 13, 14, 15].map(text);
      strategy.resetHeadWindow(after[6]!);
      manager.pinRange(cycle[0]!, cycle[1]!, { name: 'zz-pin' });
      await refusal(manager);
      const { indices, headStart } = strategy.placement([before[1]!, ...cycle, after[1]!]);
      assert.ok(indices.every((i) => i >= 0 && i < headStart), 'the premise: all of them sit before the head window\'s start');
      for (const id of [before[1]!, after[1]!]) {
        assert.ok(!strategy.chunkHolding(id).some((m) => cycle.includes(m)), `the premise: the chunk holding ${id} holds none of the cycle`);
      }
      // One reading answers each count of pins before a chunk once: the chunk before the pin sees none,
      // the chunk after it sees the pinned cycle, whichever is asked first.
      assert.deepEqual(strategy.carriesToolBlocks([before[1]!, after[1]!]), [false, true]);
      assert.deepEqual(strategy.carriesToolBlocks([after[1]!, before[1]!]), [true, false]);
    });
  });

  it('ends the head at a compression hold, as tick\'s request does: a tool cycle the hold protects inside the head window isn\'t carried for a chunk before its start', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 200,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      minChunkCharsForLLM: 0,
    });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      const text = (i: number): string => manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const early = [0, 1, 2, 3, 4, 5, 6, 7].map(text);
      const head = text(8);
      // What the hold protects is short, so the raw head and the held messages fit the budget, and the refusal is the middle's.
      const held = manager.addMessage('user', [{ type: 'text', text: 'held' }]);
      const cycle = [
        manager.addMessage('assistant', [{ type: 'tool_use', id: 'zz-held', name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]),
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'zz-held', content: 'zz' } as ContentBlock]),
      ];
      strategy.resetHeadWindow(head);
      manager.holdCompression([held], { timeoutMs: 60_000 });
      const error = await refusal(manager);
      const { indices, headStart, headEnd, holdStart } = strategy.placement([early[0]!, held, ...cycle]);
      const [chunkAt, heldAt, ...cycleAt] = indices as [number, number, number, number];
      assert.ok(chunkAt < headStart, 'the premise: the chunk lies before the head window\'s start');
      assert.equal(holdStart, heldAt, 'the premise: the hold region begins at the held message, inside the head window');
      assert.ok(cycleAt.every((i) => i > holdStart && i < headEnd), `the premise: the cycle lies past the hold, inside the head window as it would end without it: ${JSON.stringify({ cycleAt, holdStart, headEnd })}`);
      assert.ok(error.clearedBy.includes('compression'), `names compression: ${JSON.stringify(error.clearedBy)}`);
      // The premise: tick's request ends the head at the hold, so tick asks the model, and the counting membrane throws.
      await assert.rejects(async () => {
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      }, /no model in this test/);
      assert.equal(calls.n, 1, 'tick asked the model');
      manager.releaseCompression([held]);
    }, { membrane: countingMembrane(calls) });
  });

  for (const fable of [false, true]) {
    it(`names nothing for chunks tick defers until the host declares its tools (${fable ? 'a Fable summarizer, text alone' : 'chunks holding tool blocks'}), and compression once it has`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        // No chunk is thin enough to stub, so each needs a model call.
        minChunkCharsForLLM: 0,
        ...(fable ? { compressionModel: 'claude-fable-5-1' } : {}),
      });
      const calls = { n: 0 };
      const counting = { complete: async () => { calls.n++; throw new Error('zz no model call expected'); } } as unknown as Membrane;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) {
          const words: ContentBlock = { type: 'text', text: `message ${i} ` + 'word '.repeat(30) };
          if (fable) {
            manager.addMessage('user', [words]);
            continue;
          }
          // A call and its result, paired, as tick keeps them after stripping unpaired tool blocks.
          manager.addMessage('assistant', [{ type: 'tool_use', id: `zz-call-${i}`, name: 'zz_tool', input: { q: 'word '.repeat(20) } } as ContentBlock]);
          manager.addMessage('user', [{ type: 'tool_result', toolUseId: `zz-call-${i}`, content: 'zz result' } as ContentBlock, words]);
        }
        const error = await refusal(manager);
        assert.ok(strategy.queuedChunkIds().length > 0, 'chunks are queued');
        assert.deepEqual(error.clearedBy, [], 'nothing tick will do clears it');
        // The premise: tick defers every queued chunk, with no model call.
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.equal(calls.n, 0, 'tick asked no model');
        manager.setToolDefinitions([{ name: 'zz_tool', description: 'zz', inputSchema: { type: 'object' } }]);
        assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'with the tools declared, they count');
      }, { membrane: counting });
    });
  }

  for (const thin of [false, true]) {
    it(`without a compression model, names compression only for chunks the thin-chunk guard stubs (${thin ? 'every chunk thin' : 'no chunk thin'})`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        minChunkCharsForLLM: thin ? 100_000 : 0,
        compressionModel: undefined,
      });
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        assert.ok(strategy.queuedChunkIds().length > 0, 'chunks are queued');
        assert.deepEqual((await refusal(manager)).clearedBy, thin ? ['compression'] : []);
      }, { membrane: true });
    });
  }

  it('without a compression model, names nothing for short chunks holding tool blocks, which the thin-chunk guard never stubs', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      // Every chunk's text is far below the threshold.
      minChunkCharsForLLM: 100_000,
      compressionModel: undefined,
    });
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) {
        manager.addMessage('assistant', [{ type: 'tool_use', id: `zz-call-${i}`, name: 'zz_tool', input: { q: 'zz' } } as ContentBlock]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: `zz-call-${i}`, content: 'zz result' } as ContentBlock, { type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      }
      assert.ok(strategy.queuedChunkIds().length > 0, 'chunks are queued');
      assert.deepEqual((await refusal(manager)).clearedBy, []);
    }, { membrane: true });
  });

  const queuedChunks = (extra: Record<string, unknown> = {}) => new DiagnosticStrategy({
    adaptiveResolution: false,
    targetChunkTokens: 40,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
    ...extra,
  });

  it('names nothing for queued chunks an L1 already covers under other boundaries, which tick drops without compressing', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      assert.ok(strategy.queuedChunkIds().length > 0, 'chunks are queued');
      // One L1 over every message: each queued chunk is covered, none exactly.
      strategy.seedL1('L1-covering', ids);
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, []);
      // Tick drops each one without compressing it: the stub membrane has no
      // model to call, and no L1 is added.
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.deepEqual(strategy.summaryIds(), ['L1-covering']);
    }, { membrane: true });
  });

  for (const adaptiveResolution of [false, true]) {
    it(`names nothing on the ${adaptiveResolution ? 'adaptive' : 'hierarchical'} path for queued chunks an L1 covers only partly, which tick refuses`, async () => {
      const calls = { n: 0 };
      const strategy = new DiagnosticStrategy({
        adaptiveResolution,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.produce = true;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        // An L1 over each queued chunk's first message only: every queued
        // chunk is partly covered, none exactly.
        queued.forEach((ids, i) => strategy.seedL1(`L1-part-${i}`, [ids[0]!]));
        const error = await refusal(manager);
        assert.match(error.message, adaptiveResolution ? /^Adaptive picker exhausted/ : /^Hierarchical emission overran the budget/);
        assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile closed no new chunk');
        assert.deepEqual(error.clearedBy, []);
        // Tick refuses each one without compressing it: no model call, and
        // no L1 is added.
        const l1s = strategy.summaryIds();
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.deepEqual(strategy.summaryIds(), l1s);
        assert.equal(calls.n, 0, 'no model call');
      }, { membrane: countingMembrane(calls) });
    });
  }

  it('names compression for queued chunks an in-memory L1 covers partly when the store holds their exact L1s, and tick adopts them', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => {
        strategy.seedL1(`L1-part-${i}`, [ids[0]!]);
        strategy.seedStoredL1(`L1-stored-${i}`, ids);
      });
      assert.ok(!strategy.summaryIds().some((id) => id.startsWith('L1-stored-')), 'no exact L1 is in memory');
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      for (let i = 0; i < queued.length; i++) assert.ok(strategy.summaryIds().includes(`L1-stored-${i}`), `tick adopted L1-stored-${i}`);
    }, { membrane: true });
  });

  it('names nothing for queued chunks an in-memory L1 covers partly when the store holds their exact L1s, if chunks keep no records', async () => {
    const strategy = queuedChunks();
    strategy.persistChunks = false;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => {
        strategy.seedL1(`L1-part-${i}`, [ids[0]!]);
        strategy.seedStoredL1(`L1-stored-${i}`, ids);
      });
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, [], 'adoption doesn\'t persist, so the stored L1s shrink nothing');
    }, { membrane: true });
  });

  for (const modelled of [true, false]) {
    it(`names compression for queued chunks whose exact L1s only the store holds, and tick adopts them without a model call (${modelled ? 'a compression model named' : 'no compression model, which adoption needs none of'})`, async () => {
      const strategy = queuedChunks(modelled ? {} : { compressionModel: undefined });
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
        assert.deepEqual(strategy.summaryIds(), [], 'no L1 is in memory');
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(error.clearedBy, ['compression']);
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.deepEqual([...strategy.summaryIds()].sort(), queued.map((_, i) => `L1-stored-${i}`).sort(), 'tick adopted each stored L1');
      }, { membrane: true });
    });
  }

  /** The queued chunks once a compile has closed every chunk the messages make. */
  const settledQueue = async (manager: ContextManager, strategy: DiagnosticStrategy): Promise<string[][]> => {
    await refusal(manager);
    const queued = strategy.queuedChunkIds();
    assert.ok(queued.length > 0, 'chunks are queued');
    return queued;
  };

  /** Ticks until tick has taken every queued chunk; each adopts its exact L1 without a model call. */
  const adoptAll = async (manager: ContextManager, strategy: DiagnosticStrategy): Promise<void> => {
    for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
  };

  for (const persistChunks of [true, false]) {
    it(`names ${persistChunks ? 'compression' : 'nothing'} on the hierarchical path for queued chunks L1s match exactly${persistChunks ? ', since adoption ends their raw fallback' : ' when chunks keep no records, since adoption doesn\'t persist'}`, async () => {
      const strategy = queuedChunks();
      strategy.persistChunks = persistChunks;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        queued.forEach((ids, i) => strategy.seedL1(`L1-exact-${i}`, ids));
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile closed no new chunk');
        assert.deepEqual(error.clearedBy, persistChunks ? ['compression'] : []);
        if (!persistChunks) return;
        // The premise: adopting the exact L1s makes the hierarchical render smaller.
        const before = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 20 })).messages.length;
        await adoptAll(manager, strategy);
        const after = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 20 })).messages.length;
        assert.deepEqual(strategy.queuedChunkIds(), [], 'the adoptions persisted, so the rebuild queued nothing');
        assert.ok(after < before, `the render went from ${before} to ${after} messages`);
      }, { membrane: true });
    });
  }

  it('names nothing on the adaptive path for queued chunks L1s match exactly, since the picker already folds through them', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => strategy.seedL1(`L1-exact-${i}`, ids));
      const error = await refusal(manager);
      assert.match(error.message, /^Adaptive picker exhausted/);
      assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile closed no new chunk');
      assert.deepEqual(error.clearedBy, []);
      // The premise: the picker folds each message through the same L1 before and after adoption.
      const before = strategy.pickerL1s.at(-1);
      const runs = strategy.pickerL1s.length;
      await adoptAll(manager, strategy);
      const after = await refusal(manager);
      assert.match(after.message, /^Adaptive picker exhausted/);
      assert.ok(strategy.pickerL1s.length > runs, 'the picker ran again after the adoptions');
      assert.deepEqual(strategy.queuedChunkIds(), [], 'the adoptions persisted, so the rebuild queued nothing');
      assert.deepEqual(strategy.pickerL1s.at(-1), before);
      assert.ok(before?.some((id) => id !== undefined), 'the picker saw the L1s');
    }, { membrane: true });
  });

  it('names compression on the adaptive path without a compression model for queued chunks whose exact L1s only the store holds, which tick adopts without one', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      compressionModel: undefined,
    });
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
      assert.deepEqual(strategy.summaryIds(), [], 'no L1 is in memory, so the picker can fold none of them');
      const error = await refusal(manager);
      assert.match(error.message, /^Adaptive picker exhausted/);
      assert.deepEqual(error.clearedBy, ['compression']);
      await adoptAll(manager, strategy);
      assert.deepEqual([...strategy.summaryIds()].sort(), queued.map((_, i) => `L1-stored-${i}`).sort(), 'tick adopted each stored L1');
    }, { membrane: true });
  });

  for (const merge of [false, true]) {
    it(`names compression when the compression preflight says no${merge ? ', for the merge too' : ''}, since a host's tick takes the queue whatever it says`, async () => {
      const strategy = queuedChunks();
      strategy.preflightNo = true;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 12 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (merge) {
          strategy.seedL1('L1-a', [ids[0]!]);
          strategy.seedL1('L1-b', [ids[1]!]);
          strategy.queueMergeOf(['L1-a', 'L1-b']);
          // At the cap the drain takes no chunk, so only the merge can count.
          strategy.atCap = true;
        }
        const error = await refusal(manager);
        assert.deepEqual(error.clearedBy, ['compression']);
      });
    });
  }

  for (const [held, modelled] of [[false, true], [true, true], [false, false]] as const) {
    const label = held ? 'while a real hold covers one of its sources' : modelled ? 'with no hold' : 'without a compression model, which a merge needs';
    it(`names ${!held && modelled ? 'compression' : 'nothing'} for a queued merge of real summaries ${label}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        hierarchical: true,
        positionedRecallPairs: true,
        targetChunkTokens: 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
        compressionModel: modelled ? 'zz-model' : undefined,
      });
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 2 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedL1('L1-a', [ids[0]!]);
        strategy.seedL1('L1-b', [ids[1]!]);
        strategy.queueMergeOf(['L1-a', 'L1-b']);
        if (held) manager.holdCompression([ids[1]!], { timeoutMs: 60_000 });
        const error = await refusal(manager);
        assert.deepEqual(error.clearedBy, !held && modelled ? ['compression'] : []);
        if (held) manager.releaseCompression([ids[1]!]);
      });
    });
  }

  it('counts no queued merge with hierarchical merging off, since tick runs merges only with it on', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      hierarchical: true,
      positionedRecallPairs: true,
      targetChunkTokens: 100_000,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 2 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      strategy.seedL1('L1-a', [ids[0]!]);
      strategy.seedL1('L1-b', [ids[1]!]);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'the premise: with it on, the merge counts');
      strategy.setHierarchical(false);
      assert.equal(strategy.countsCompressionWork(), false);
      // The premise: tick leaves the merge queued and calls no model.
      await manager.tick();
      assert.equal(strategy.queuedMergeCount(), 1, 'tick ran no merge');
      assert.equal(calls.n, 0, 'tick called no model');
      // With it on again, the same tick asks the model for the merge.
      strategy.setHierarchical(true);
      await assert.rejects(manager.tick(), /no model in this test/);
      assert.equal(calls.n, 1);
    }, { membrane: countingMembrane(calls) });
  });

  it('names compression for a queued merge tick drops as stale without a model call, until tick has dropped it', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      hierarchical: true,
      positionedRecallPairs: true,
      targetChunkTokens: 100_000,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 2 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      strategy.seedL1('L1-a', [ids[0]!]);
      strategy.seedL1('L1-b', [ids[1]!]);
      // One source isn't loaded, so executeMerge drops the entry.
      strategy.queueMergeOf(['L1-a', 'L1-gone']);
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      await manager.tick();
      assert.equal(calls.n, 0, 'tick called no model');
      assert.equal(strategy.queuedMergeCount(), 0, 'tick dropped the merge');
      assert.deepEqual((await refusal(manager)).clearedBy, []);
    }, { membrane: countingMembrane(calls) });
  });

  it('names compression for a queued chunk behind a merge a hold blocks, since tick takes chunks before any merge', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      hierarchical: true,
      positionedRecallPairs: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      const queued = await settledQueue(manager, strategy);
      strategy.seedL1('L1-a', [ids[0]!]);
      strategy.seedL1('L1-b', [ids[1]!]);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      // A hold on a source blocks the merge; this one leaves the windows and
      // the chunks as they are.
      strategy.holdBlocksMerges = true;
      // The first queued chunk holds both sources; the others hold neither.
      assert.ok(queued.slice(1).some((chunk) => !chunk.includes(ids[0]!) && !chunk.includes(ids[1]!)), 'a queued chunk the L1s leave alone');
      const error = await refusal(manager);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  for (const positionedRecallPairs of [true, false]) {
    for (const work of ['running', 'merge'] as const) {
      it(`names compression at the hierarchical ${positionedRecallPairs ? 'recall pair' : 'raw-message fallback'} refusal while ${work === 'running' ? 'a compression runs' : 'a merge is queued'}`, async () => {
        const strategy = new DiagnosticStrategy({
          adaptiveResolution: false,
          hierarchical: true,
          positionedRecallPairs,
          targetChunkTokens: 100_000,
          headWindowTokens: 0,
          recentWindowTokens: 0,
          overBudgetGraceRatio: 0.25,
          autoTickOnNewMessage: false,
          speculativeProduction: false,
        });
        await withManager(strategy, async (manager) => {
          const ids = Array.from({ length: 2 }, (_, i) =>
            manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
          strategy.seedPyramid(positionedRecallPairs ? ids : ids.slice(1), 1);
          if (work === 'running') strategy.startCompressing();
          // A merge whose source in memory covers a message the compile can fold.
          else strategy.queueMergeOf(['L1-diagnostic']);
          const error = await refusal(manager);
          assert.match(error.message, positionedRecallPairs
            ? /selected middle representations=1, attempted representation level=L1/
            : /middle raw messages=1, attempted representation level=L0/);
          assert.deepEqual(error.clearedBy, ['compression']);
        });
      });
    }
  }

  for (const lateHold of [false, true]) {
    it(`names ${lateHold ? 'nothing' : 'compression'} for the chunk the picker's plan demands ${lateHold ? 'when a hold placed after it closed covers it, since tick skips it' : 'with no hold'}`, async () => {
      const strategy = new AutobiographicalStrategy({
        compressionModel: 'zz-model',
        adaptiveResolution: true,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        // Messages 0 to 3 close into one chunk, which the holdback keeps out of
        // the queue until the plan's produce op demands it.
        const ids = Array.from({ length: 5 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (lateHold) manager.holdCompression([ids[3]], { timeoutMs: 60_000 });
        let error: OverBudgetError | undefined;
        try {
          await manager.compile({ maxTokens: 200, reserveForResponse: 20 });
        } catch (caught) {
          if (!(caught instanceof OverBudgetError)) throw caught;
          error = caught;
        }
        assert.ok(error, 'compile should refuse');
        assert.match(error.message, /^Adaptive picker exhausted/);
        assert.deepEqual(error.clearedBy, lateHold ? [] : ['compression']);
        if (lateHold) manager.releaseCompression([ids[3]]);
      });
    });
  }

  for (const positionedRecallPairs of [true, false]) {
    it(`names nothing at the hierarchical ${positionedRecallPairs ? 'recall pair' : 'raw-message fallback'} refusal while a hold blocks the only queued merge`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        hierarchical: true,
        positionedRecallPairs,
        targetChunkTokens: 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.holdBlocksMerges = true;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 2 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(positionedRecallPairs ? ids : ids.slice(1), 1);
        // A merge whose source in memory covers a message the compile can fold, so only the hold stops it.
        strategy.queueMergeOf(['L1-diagnostic']);
        assert.equal(strategy.checkReadiness().ready, false, 'the merge is queued');
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(error.clearedBy, [], 'tick stops at a blocked merge until the hold is released');
      });
    });
  }

  // Past the speculative cap, the cap holds the queued chunks only while an
  // L1 merge is queued to relieve it (speculativeCapHolds, #240). With none
  // queued, nothing the cap waits for can come, so the chunks count. With one
  // queued, they wait for it: the merge counts, or nothing does while a hold
  // blocks it.
  for (const merge of ['none', 'queued', 'blocked'] as const) {
    const named = merge === 'blocked' ? 'nothing' : 'compression';
    const when = {
      none: 'with no merge queued, since the cap holds nothing then',
      queued: 'when a merge is queued to relieve it',
      blocked: 'while the merge queued to relieve it is blocked',
    }[merge];
    it(`names ${named} for queued chunks past the speculative cap ${when}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        hierarchical: true,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.atCap = true;
      strategy.holdBlocksMerges = merge === 'blocked';
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 12 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (merge !== 'none') {
          // A merge whose sources in memory cover messages the compile can fold.
          strategy.seedL1('L1-a', [ids[0]!]);
          strategy.seedL1('L1-b', [ids[1]!]);
          strategy.queueMergeOf(['L1-a', 'L1-b']);
        }
        assert.equal(strategy.checkReadiness().ready, false, 'chunks are queued');
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(error.clearedBy, merge === 'blocked' ? [] : ['compression']);
      });
    });
  }

  // A queued chunk the compile can fold none of frees no room once it has an
  // L1: the head and recent windows render raw, and so does a message a pin
  // keeps raw (getCompressibleMessages). Tick still takes the chunk, so the
  // count goes past it where tick does, and stops at it where tick throws.
  const foldingChunks = () => new DiagnosticStrategy({
    adaptiveResolution: true,
    targetChunkTokens: 400,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
  });

  /** Twelve messages of one size, none split into shards at a 400-token chunk size: three chunks of four close. */
  const twelveEven = (manager: ContextManager): string[] =>
    Array.from({ length: 12 }, (_, i) => manager.addMessage('user', [{ type: 'text', text: `message ${String(i).padStart(2, '0')} ` + 'word '.repeat(120) }]));

  /** Pins each chunk's messages from its first to its `last`th (its last when left out). */
  const pinChunks = (manager: ContextManager, chunks: string[][], last?: number): void => {
    for (const chunk of chunks) manager.pinRange(chunk[0]!, chunk[last ?? chunk.length - 1]!, { name: 'zz-pin' });
  };

  for (const pinned of [false, true]) {
    it(`names ${pinned ? 'nothing' : 'compression'} on the adaptive path for queued chunks that need a model call${pinned ? ', every message of which a pin keeps raw, since their L1s fold nothing' : ''}`, async () => {
      const strategy = foldingChunks();
      strategy.produce = true;
      await withManager(strategy, async (manager) => {
        twelveEven(manager);
        const queued = await settledQueue(manager, strategy);
        assert.equal(queued.length, 3, 'three chunks of four are queued');
        if (pinned) pinChunks(manager, queued);
        const error = await refusal(manager);
        assert.match(error.message, /^Adaptive picker exhausted/);
        assert.deepEqual(strategy.queuedChunkIds(), queued, 'the chunks stay queued, pinned or not');
        assert.deepEqual(error.clearedBy, pinned ? [] : ['compression']);
        // The premise: their L1s, as compression writes them, make the plan smaller only where no pin keeps every message raw.
        queued.forEach((ids, i) => strategy.seedShortL1(`L1-folding-${i}`, ids));
        const after = await refusal(manager);
        if (pinned) assert.equal(after.actual, error.actual, 'the L1s folded nothing');
        else assert.ok(after.actual < error.actual, `the plan went from ${error.actual} to ${after.actual} tokens`);
      });
    });
  }

  it('names compression on the adaptive path for queued chunks a pin keeps only partly raw, since their other messages fold through their L1s', async () => {
    const strategy = foldingChunks();
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      twelveEven(manager);
      const queued = await settledQueue(manager, strategy);
      pinChunks(manager, queued, 1);
      const error = await refusal(manager);
      assert.match(error.message, /^Adaptive picker exhausted/);
      assert.deepEqual(error.clearedBy, ['compression']);
      queued.forEach((ids, i) => strategy.seedShortL1(`L1-partly-${i}`, ids));
      const after = await refusal(manager);
      assert.ok(after.actual < error.actual, `the plan went from ${error.actual} to ${after.actual} tokens`);
    });
  });

  for (const where of ['head', 'recent'] as const) {
    for (const whole of [true, false]) {
      it(`names ${whole ? 'nothing' : 'compression'} on the adaptive path for a queued chunk lying ${whole ? 'wholly' : 'partly'} in ${where === 'head' ? 'a grown head window' : 'a raised recent window'}${whole ? ', which renders raw whatever its L1' : ', since its other messages fold through its L1'}`, async () => {
        const strategy = foldingChunks();
        strategy.produce = true;
        await withManager(strategy, async (manager) => {
          twelveEven(manager);
          const queued = await settledQueue(manager, strategy);
          assert.equal(queued.length, 3, 'three chunks of four are queued');
          const inWindow = where === 'head' ? queued[0]! : queued[2]!;
          // Every other queued chunk gets its L1, so the one in the window is the only work left.
          queued.forEach((ids, i) => { if (ids !== inWindow) strategy.seedL1(`L1-other-${i}`, ids); });
          // Each message's estimate, from a head that holds them all.
          strategy.setHeadWindowTokens(1_000_000_000);
          const each = manager.previewContext({ maxTokens: 2_000_000_000, reserveForResponse: 20 })!.headTokens / 12;
          strategy.setHeadWindowTokens(0);
          // Four and a half messages hold the chunk whole; three and a half, only part of it.
          const tokens = Math.round((whole ? 4.5 : 3.5) * each);
          if (where === 'head') strategy.setHeadWindowTokens(tokens);
          else strategy.setRecentWindowTokens(tokens);
          // The plan says it's over the budget, so the picker refuses and takes the list, with the window inside the budget.
          strategy.overstate = true;
          const error = await manager.compile({ maxTokens: 2_000, reserveForResponse: 20 }).then(
            () => assert.fail('compile should refuse'),
            (e: unknown) => e,
          );
          strategy.overstate = false;
          assert.ok(error instanceof OverBudgetError);
          assert.match(error.message, /^Adaptive picker exhausted/);
          assert.deepEqual(strategy.queuedChunkIds(), queued, 'the chunks stay queued');
          const { indices, headEnd, recentStart } = strategy.placement(inWindow);
          const inside = indices.filter((i) => (where === 'head' ? i < headEnd : i >= recentStart)).length;
          assert.equal(inside, whole ? 4 : 3, `the window holds ${whole ? 'the whole chunk' : 'three of its four messages'}`);
          assert.deepEqual(error.clearedBy, whole ? [] : ['compression']);
          // The premise: its L1 makes the plan smaller only when part of the chunk lies outside the window.
          const big = { maxTokens: 2_000_000_000, reserveForResponse: 20 };
          const before = manager.previewContext(big)!.finalTokens;
          strategy.seedShortL1('L1-in-window', inWindow);
          const after = manager.previewContext(big)!.finalTokens;
          if (whole) assert.equal(after, before, 'its L1 folded nothing');
          else assert.ok(after < before, `the plan went from ${before} to ${after} tokens`);
        });
      });
    }
  }

  it('without a compression model, names nothing for chunks the thin-chunk guard stubs when a pin keeps every message of them raw', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
      minChunkCharsForLLM: 100_000,
      compressionModel: undefined,
    });
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      pinChunks(manager, queued);
      const error = await refusal(manager);
      assert.deepEqual(strategy.queuedChunkIds(), queued, 'the pinned chunks stay queued');
      assert.deepEqual(error.clearedBy, []);
    }, { membrane: true });
  });

  it('names nothing for queued chunks every message of which a pin keeps raw, whose exact L1s only the store holds, though tick adopts them without a model call', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
      pinChunks(manager, queued);
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, []);
      // The premise: tick still takes them, adopting each stored L1.
      await adoptAll(manager, strategy);
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.deepEqual([...strategy.summaryIds()].sort(), queued.map((_, i) => `L1-stored-${i}`).sort(), 'tick adopted each stored L1');
    }, { membrane: true });
  });

  it('names nothing on the hierarchical path for queued chunks L1s match exactly when a pin keeps every message of them raw, since adoption ends no raw fallback for them', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => strategy.seedL1(`L1-exact-${i}`, ids));
      pinChunks(manager, queued);
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, []);
      // The premise: adopting the exact L1s leaves the render as it was, where unpinned chunks' adoption shrinks it.
      const before = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 20 })).messages.length;
      await adoptAll(manager, strategy);
      const after = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 20 })).messages.length;
      assert.deepEqual(strategy.queuedChunkIds(), [], 'the adoptions persisted, so the rebuild queued nothing');
      assert.equal(after, before, `the render stayed at ${before} messages`);
    }, { membrane: true });
  });

  it('without a compression model, names nothing for chunks tick adopts an L1 for, queued behind one a pin keeps wholly raw that needs a model call, since tick throws at that one first', async () => {
    const strategy = modelCallChunks({ compressionModel: undefined });
    const calls = { n: 0 };
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      pinChunks(manager, queued.slice(0, 1));
      queued.slice(1).forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile queued the same chunks, in the same order');
      // The premise: tick takes the pinned chunk first, and the host's loop ends there.
      await assert.rejects(hostTicks(manager, strategy), /compressionModel is NOT configured/);
      // A failure that didn't decide the chunk puts it back, behind the work that hasn't failed.
      assert.deepEqual(strategy.queuedChunkIds(), [...queued.slice(1), queued[0]], 'tick took the first chunk only, and put it back behind the others');
      assert.equal(calls.n, 0, 'no model call');
    }, { membrane: countingMembrane(calls) });
  });

  // Round 18: a queued merge, and the work in flight, count only when they fold something now, as a
  // queued chunk does; and the walk goes past a chunk that folds nothing wherever tick moves on.
  const mergeOfTwo = () => new DiagnosticStrategy({
    adaptiveResolution: false,
    hierarchical: true,
    positionedRecallPairs: true,
    targetChunkTokens: 100_000,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
  });

  /** Two messages, each an L1's source, and a merge of the two L1s queued. */
  const twoSummariesMerged = (manager: ContextManager, strategy: DiagnosticStrategy): string[] => {
    const ids = Array.from({ length: 2 }, (_, i) =>
      manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(60) }]));
    strategy.seedL1('L1-a', [ids[0]!]);
    strategy.seedL1('L1-b', [ids[1]!]);
    strategy.queueMergeOf(['L1-a', 'L1-b']);
    return ids;
  };

  for (const pinned of [false, true]) {
    it(`names ${pinned ? 'nothing' : 'compression'} for a queued merge of real summaries${pinned ? ' whose messages a pin keeps raw, since its L2 would fold nothing' : ' whose messages the compile can fold'}`, async () => {
      const strategy = mergeOfTwo();
      await withManager(strategy, async (manager) => {
        const ids = twoSummariesMerged(manager, strategy);
        if (pinned) manager.pinRange(ids[0]!, ids[1]!, { name: 'zz-pin' });
        assert.deepEqual((await refusal(manager)).clearedBy, pinned ? [] : ['compression']);
      });
    });
  }

  it('names nothing for a queued merge none of whose sources is in memory, since it covers no message', async () => {
    const strategy = mergeOfTwo();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(60) }]);
      strategy.queueMerge();
      assert.equal(strategy.queuedMergeCount(), 1, 'the merge is queued');
      assert.deepEqual((await refusal(manager)).clearedBy, []);
    });
  });

  for (const pinned of [false, true]) {
    it(`names ${pinned ? 'nothing' : 'compression'} at the cap while tick compresses a chunk${pinned ? ' every message of which a pin keeps raw' : ''}, the work in flight being all that can count`, async () => {
      const strategy = modelCallChunks();
      const model = waitingMembrane();
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        if (pinned) pinChunks(manager, queued);
        const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
        await Promise.race([model.called, ticking]);
        assert.equal(model.calls.n, 1, 'premise: tick asked the model for the first chunk, and waits');
        // Past the cap with an L1 merge queued, one that covers no message and
        // so counts nothing, the cap holds and the walk takes no queued chunk:
        // only the work in flight can count.
        strategy.atCap = true;
        strategy.queueMerge();
        assert.deepEqual((await refusal(manager)).clearedBy, pinned ? [] : ['compression']);
        model.release();
        assert.match(String(await ticking), /released by the test/);
      }, { membrane: model.membrane });
    });
  }

  for (const pinned of [false, true]) {
    it(`names ${pinned ? 'nothing' : 'compression'} while tick runs a merge${pinned ? ' whose messages a pin keeps raw' : ''}, the merge in flight being all that can count`, async () => {
      const strategy = mergeOfTwo();
      const model = waitingMembrane();
      await withManager(strategy, async (manager) => {
        const ids = twoSummariesMerged(manager, strategy);
        if (pinned) manager.pinRange(ids[0]!, ids[1]!, { name: 'zz-pin' });
        const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
        await Promise.race([model.called, ticking]);
        assert.equal(model.calls.n, 1, 'premise: tick asked the model for the merge, and waits');
        assert.deepEqual((await refusal(manager)).clearedBy, pinned ? [] : ['compression']);
        model.release();
        await ticking;
      }, { membrane: model.membrane });
    });
  }

  it('names compression on the hierarchical path for a chunk an exact L1 in memory covers, queued behind one a pin keeps wholly raw, since the walk goes past the first where tick adopts it', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      queued.forEach((ids, i) => strategy.seedL1(`L1-exact-${i}`, ids));
      pinChunks(manager, queued.slice(0, 1));
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
    }, { membrane: true });
  });

  it('names compression for a chunk whose exact L1 only the store holds, queued behind one a pin keeps wholly raw, since the walk goes past the first where tick adopts it', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
      pinChunks(manager, queued.slice(0, 1));
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
    }, { membrane: true });
  });

  it('names compression for a chunk that needs a model call, queued behind one a pin keeps wholly raw, since the walk goes past the first where tick compresses it', async () => {
    const strategy = modelCallChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      pinChunks(manager, queued.slice(0, 1));
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  // Rounds 19 and 20: the count walks the merge queue as tick takes it, past a merge that folds nothing,
  // ending at one a hold blocks, a merge in flight still the head; it goes on to the queue past work in
  // flight that folds nothing, below the cap; and work in flight that a hold placed since reaches
  // doesn't count, since its landing discards what the call returns.

  /** Four messages, each an L1's source (L1-a to L1-d), parented to the named L2s when given. */
  const fourSummaries = (manager: ContextManager, strategy: DiagnosticStrategy, parents: (string | undefined)[] = []): string[] => {
    const ids = Array.from({ length: 4 }, (_, i) =>
      manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(60) }]));
    ['L1-a', 'L1-b', 'L1-c', 'L1-d'].forEach((l1, i) => strategy.seedL1(l1, [ids[i]!], parents[i]));
    return ids;
  };

  it('names compression for a folding merge queued behind a head merge that folds nothing, since tick runs the head and then takes the next', async () => {
    const strategy = mergeOfTwo();
    await withManager(strategy, async (manager) => {
      const ids = fourSummaries(manager, strategy);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      strategy.queueMergeOf(['L1-c', 'L1-d']);
      manager.pinRange(ids[0]!, ids[1]!, { name: 'zz-pin' });
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
    });
  });

  it('names compression for a folding merge queued behind a merge in flight that folds nothing, since tick takes the next merge once that call ends', async () => {
    const strategy = mergeOfTwo();
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      const ids = fourSummaries(manager, strategy);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      strategy.queueMergeOf(['L1-c', 'L1-d']);
      manager.pinRange(ids[0]!, ids[1]!, { name: 'zz-pin' });
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      // tick takes only the head merge, which the pin leaves folding nothing.
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the head merge, and waits');
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      model.release();
      await ticking;
    }, { membrane: model.membrane });
  });

  it('names nothing for a folding merge queued behind a merge in flight that a hold placed since blocks, since tick discards what the call returns and stops at the held head', async () => {
    const strategy = mergeOfTwo();
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      const ids = fourSummaries(manager, strategy);
      // The head covers the later messages, so a hold on the last blocks it and not the merge behind it.
      strategy.queueMergeOf(['L1-c', 'L1-d']);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      manager.pinRange(ids[2]!, ids[3]!, { name: 'zz-pin' });
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      // tick takes only the head merge, which the pin leaves folding nothing.
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the head merge, and waits');
      manager.holdCompression([ids[3]!], { timeoutMs: 60_000 });
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      const { indices, holdStart } = strategy.placement(ids);
      assert.ok(indices[1]! < holdStart && indices[3]! >= holdStart, 'premise: the hold reaches the merge in flight and not the merge behind it');
      model.release();
      await ticking;
      manager.releaseCompression([ids[3]!]);
    }, { membrane: model.membrane });
  });

  it('names nothing while tick runs a folding merge that a hold placed since blocks, since its landing discards the L2 and the merge stays at the head', async () => {
    const strategy = mergeOfTwo();
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      const ids = twoSummariesMerged(manager, strategy);
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the merge, and waits');
      manager.holdCompression([ids[1]!], { timeoutMs: 60_000 });
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      const { indices, headEnd, holdStart } = strategy.placement(ids);
      assert.ok(indices[0]! >= headEnd && indices[0]! < holdStart && indices[1]! >= holdStart,
        'premise: the merge would fold its first message, and the hold reaches its second');
      model.release();
      await ticking;
      manager.releaseCompression([ids[1]!]);
    }, { membrane: model.membrane });
  });

  it('names compression while tick runs a folding merge, though the walk stops at a queued chunk that needs a model call while the compression quarantine can\'t be read, since the merge in flight lands whatever the walk reads', async () => {
    const strategy = modelCallChunks({ hierarchical: true, positionedRecallPairs: true });
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 24; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      // Two L1s over adjacent messages of the last queued chunk, and their merge; the first chunk holds neither.
      assert.ok(queued.length >= 3 && queued.at(-1)!.length >= 2, 'three chunks or more are queued, the last of two messages or more');
      strategy.seedL1('L1-a', [queued.at(-1)![0]!]);
      strategy.seedL1('L1-b', [queued.at(-1)![1]!]);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      // At the cap tick runs merges only, so it takes the merge with chunks queued; below the cap again,
      // the count walks those chunks, as it does when chunks queue while a merge is out.
      strategy.atCap = true;
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the merge, and waits');
      assert.equal(strategy.chunkInFlight(), undefined, 'premise: the work in flight is the merge');
      strategy.atCap = false;
      strategy.breakQuarantineRead();
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      model.release();
      await ticking;
      // The control: with nothing in flight, the same fixture names nothing, since the walk stops at the
      // first queued chunk, which needs a model call, ahead of the merge still queued.
      assert.equal(strategy.queuedMergeCount(), 1, 'premise: the merge stays queued, its call rejected by the test');
      assert.deepEqual((await refusal(manager)).clearedBy, []);
    }, { membrane: model.membrane });
  });

  // The landing's hold check the rule for work in flight rests on: executeMerge reads the hold again once the
  // model has answered. The chunk's landing is main's G1 test (compression-hold.test.ts).
  for (const hold of [false, true]) {
    it(hold
      ? 'discards a merge\'s answer when a hold placed during its call reaches it: tick writes no L2 and keeps the merge at the head, and its next call makes no model call'
      : 'lands a merge whose call no hold reaches, writing its L2 and leaving the queue (the control)', async () => {
      const strategy = mergeOfTwo();
      let manager!: ContextManager;
      let ids: string[] = [];
      const { membrane, calls } = answeringMembrane(() => {
        if (hold) manager.holdCompression([ids[3]!], { timeoutMs: 60_000 });
      });
      await withManager(strategy, async (m) => {
        manager = m;
        ids = fourSummaries(manager, strategy);
        strategy.queueMergeOf(['L1-c', 'L1-d']);
        const summaries = strategy.summaryIds().length;
        if (hold) {
          // Nothing failed: tick keeps the answer out and returns, the merge still queued.
          await manager.tick();
          assert.equal(calls.n, 1, 'premise: tick asked the model once, and the hold reached its answer');
          assert.equal(strategy.summaryIds().length, summaries, 'no L2 is written');
          assert.equal(strategy.queuedMergeCount(), 1, 'the merge stays at the head');
          const lane = strategy as unknown as { mergeFailureOrder: Map<string, number>; mergeFailureRuns: Map<string, unknown>; compressionPause: unknown };
          assert.deepEqual(
            { order: lane.mergeFailureOrder.size, runs: lane.mergeFailureRuns.size, pause: lane.compressionPause },
            { order: 0, runs: 0, pause: null },
            'and the discard counts no failure: no failure order, no failure run, no pause',
          );
          await manager.tick();
          assert.equal(calls.n, 1, 'the next tick returns at the held head without a model call');
          manager.releaseCompression([ids[3]!]);
        } else {
          await manager.tick();
          assert.equal(calls.n, 1, 'premise: tick asked the model once');
          assert.equal(strategy.summaryIds().length, summaries + 1, 'the L2 is written');
          assert.equal(strategy.queuedMergeCount(), 0, 'and the merge leaves the queue');
        }
      }, { membrane });
    });
  }

  it('reads the hold boundary no more often in a count that walks more merges, or with one in flight, since each merge\'s hold check takes the hold set the count read', async () => {
    const strategy = mergeOfTwo();
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      const ids = fourSummaries(manager, strategy);
      const later = manager.addMessage('user', [{ type: 'text', text: 'message 4 ' + 'word '.repeat(60) }]);
      // Every merge folds nothing, so the walk reads each, and a hold on a later message blocks none.
      manager.pinRange(ids[0]!, ids[3]!, { name: 'zz-pin' });
      manager.holdCompression([later], { timeoutMs: 60_000 });
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      const scans = (): number => {
        const before = strategy.boundaryScans();
        assert.equal(strategy.countsCompressionWork(), false);
        return strategy.boundaryScans() - before;
      };
      const withOne = scans();
      assert.ok(withOne > 0, 'premise: a count reads the boundary with the hold in place');
      strategy.queueMergeOf(['L1-c', 'L1-d']);
      strategy.queueMergeOf(['L1-b', 'L1-c']);
      assert.equal(strategy.queuedMergeCount(), 3, 'premise: three merges are queued');
      assert.equal(scans(), withOne, 'two merges more cost no read of the boundary');
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the head merge, and waits');
      assert.equal(scans(), withOne, 'nor does the merge in flight');
      model.release();
      await ticking;
      manager.releaseCompression([later]);
    }, { membrane: model.membrane });
  });

  it('names nothing while tick finishes a chunk whose L1 has landed, though its call hasn\'t ended, since the compile folds through that L1', async () => {
    const strategy = modelCallChunks();
    const { membrane } = answeringMembrane(() => undefined);
    let landed!: () => void;
    const atLanding = new Promise<void>((resolve) => { landed = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      // Every chunk after the first is pinned wholly raw, so the first is all that can count.
      pinChunks(manager, queued.slice(1));
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression'], 'before tick, the first chunk counts');
      // The success path's quarantine clean-up, held open as a store write for a matching record holds it.
      (strategy as unknown as { clearQuarantineForCompressedChunk: () => Promise<void> }).clearQuarantineForCompressedChunk = () => {
        landed();
        return gate;
      };
      const ticking = manager.tick();
      await atLanding;
      assert.deepEqual(strategy.chunkInFlight(), queued[0], 'premise: the chunk in flight is the first queued');
      assert.equal(strategy.chunkInFlightCompressed(), true, 'premise: its result has landed, the chunk compressed');
      assert.equal(strategy.summaryIds().length, 1, 'premise: and its L1 is in memory');
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      open();
      await ticking;
      assert.deepEqual((await refusal(manager)).clearedBy, [], 'nor once the call has ended');
    }, { membrane });
  });

  it('names nothing while tick compresses a chunk that a hold placed since reaches, since its landing discards the L1', async () => {
    const strategy = modelCallChunks();
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the first chunk, and waits');
      assert.deepEqual(strategy.chunkInFlight(), queued[0], 'premise: the chunk in flight is the first queued');
      // A hold on the chunk's last message reaches it, and every chunk queued after it, while its
      // earlier messages stay foldable, so the hold is what keeps it from counting.
      const last = queued[0]![queued[0]!.length - 1]!;
      manager.holdCompression([last], { timeoutMs: 60_000 });
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      const { indices, headEnd, holdStart } = strategy.placement(queued[0]!);
      assert.ok(indices[0]! >= headEnd && indices[0]! < holdStart && indices.at(-1)! >= holdStart,
        'premise: the chunk would fold its first message, and the hold reaches its last');
      model.release();
      assert.match(String(await ticking), /released by the test/);
      manager.releaseCompression([last]);
    }, { membrane: model.membrane });
  });

  it('names nothing for a folding merge queued behind a head merge a hold blocks, since tick returns at a held head', async () => {
    const strategy = mergeOfTwo();
    await withManager(strategy, async (manager) => {
      const ids = fourSummaries(manager, strategy);
      // The head covers the later messages, so a hold on the last blocks it and not the merge behind it.
      strategy.queueMergeOf(['L1-c', 'L1-d']);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      manager.holdCompression([ids[3]!], { timeoutMs: 60_000 });
      assert.deepEqual((await refusal(manager)).clearedBy, []);
      manager.releaseCompression([ids[3]!]);
    });
  });

  it('names compression below the cap while tick compresses a chunk a pin keeps wholly raw, for a chunk queued behind it that folds', async () => {
    const strategy = modelCallChunks();
    const model = waitingMembrane();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      assert.ok(queued.length >= 2, 'two chunks or more are queued');
      pinChunks(manager, queued.slice(0, 1));
      const ticking = manager.tick().then(() => undefined, (error: unknown) => error);
      await Promise.race([model.called, ticking]);
      assert.equal(model.calls.n, 1, 'premise: tick asked the model for the first chunk, and waits');
      assert.deepEqual(strategy.chunkInFlight(), queued[0], 'premise: the chunk in flight is the one the pin keeps raw');
      assert.deepEqual((await refusal(manager)).clearedBy, ['compression']);
      model.release();
      assert.match(String(await ticking), /released by the test/);
    }, { membrane: model.membrane });
  });

  for (const pinned of [false, true]) {
    it(`names ${pinned ? 'nothing' : 'compression'} for a queued merge of two L2s${pinned ? ' every leaf of which a pin keeps raw' : ' whose leaves the compile can fold'}, its leaves read through the L1s in memory`, async () => {
      const strategy = mergeOfTwo();
      await withManager(strategy, async (manager) => {
        const ids = fourSummaries(manager, strategy, ['L2-x', 'L2-x', 'L2-y', 'L2-y']);
        strategy.seedL2('L2-x', ['L1-a', 'L1-b']);
        strategy.seedL2('L2-y', ['L1-c', 'L1-d']);
        strategy.queueMergeOf(['L2-x', 'L2-y'], 3);
        if (pinned) manager.pinRange(ids[0]!, ids[3]!, { name: 'zz-pin' });
        assert.deepEqual((await refusal(manager)).clearedBy, pinned ? [] : ['compression']);
      });
    });
  }
});
