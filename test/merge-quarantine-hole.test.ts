/**
 * A quarantined merge's sources leave a hole in the merge candidates.
 *
 * Once a merge went to the merge quarantine, contiguousMergeCandidates kept
 * offering its group whenever that group was the oldest run that qualified,
 * and enqueueMerge refused it, so no merge that would form after it at its
 * level ever formed: a live store's L1s piled up unmerged until an operator
 * cleared the record. The candidates now leave out the sources of a record
 * that holds them, one whose group could be retried as it stands. The runs on
 * each side merge by the usual rules, and clearMergeQuarantine retries the
 * group.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

const PATH = './test-merge-quarantine-hole';
function cleanup(): void {
  if (existsSync(PATH)) rmSync(PATH, { recursive: true, force: true });
}

/**
 * A provider that refuses the merges whose 1-based order `refuse` names and
 * answers every other call. A merge is told by its instruction's opening.
 */
function provider(refuse: number[]) {
  const state = { merges: 0, refusing: true };
  const membrane = {
    complete: async (request: unknown) => {
      if (JSON.stringify(request).includes('You have just reviewed')) {
        state.merges++;
        if (state.refusing && refuse.includes(state.merges)) {
          return { stopReason: 'refusal', content: [{ type: 'text', text: 'I would rather not.' }] };
        }
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'a summary' }] };
    },
  };
  return { membrane, state };
}

class Lane extends AutobiographicalStrategy {
  get all(): SummaryEntry[] { return this.summaries; }
  get queue(): Array<{ level: number; sourceIds: string[] }> { return this.mergeQueue; }
  quarantinedGroups(): string[][] { return [...this.mergeQuarantine.values()].map((r) => [...r.sourceIds]); }
  queueMerge(level: number, sourceIds: string[]): void { this.enqueueMerge({ level, sourceIds }); }
  produceMerge(level: number, first: string, last: string): void { this.enqueueMergeForRange(level, first, last); }
  /** Set after the L1s exist, so none merged as they formed. */
  setThreshold(n: number): void { (this.config as { mergeThreshold?: number }).mergeThreshold = n; }
  heldIds(): Set<string> { return this.mergeHeldSourceIds(); }
  /** Write the persisted merge queue as a store from an older version could hold it. */
  persistQueue(entries: Array<{ level: number; sourceIds: string[] }>): void {
    this.store?.setStateJson(this.mergeQueueStateId, entries);
  }
  /** Drop a summary, as store surgery or a repair can. */
  drop(id: string): void {
    const i = this.summaries.findIndex((s) => s.id === id);
    if (i >= 0) this.summaries.splice(i, 1);
  }
  /** Give a summary a parent, as store surgery or a repair can. */
  reparent(id: string, parent: string | undefined): void {
    const s = this.summaries.find((x) => x.id === id);
    if (s) s.mergedInto = parent;
  }
  /** Move a summary's first covered message, as store surgery can. */
  retarget(id: string, first: string): void {
    const s = this.summaries.find((x) => x.id === id);
    if (s) s.sourceRange = { ...s.sourceRange, first };
  }
  recordKey(sourceIds: string[]): string | undefined {
    return [...this.mergeQuarantine.values()].find((r) => r.sourceIds.join() === sourceIds.join())?.key;
  }
  /** The merge-quarantine records, as stored. */
  records(): Array<Record<string, unknown>> {
    return [...this.mergeQuarantine.values()].map((r) => ({ ...r }));
  }
  /** Write the persisted merge quarantine as a store from an older version could hold it. */
  persistQuarantine(records: Array<Record<string, unknown>>): void {
    this.store?.setStateJson(this.mergeQuarantineStateId, records);
  }
  /** Set operator merge holds after the summaries exist. */
  holdForReview(ids: string[]): void { (this.config as { mergeHoldSummaryIds?: string[] }).mergeHoldSummaryIds = ids; }
}

/** A merge-quarantine record's key: sha256 of its source ids, as the strategy keys one. */
const keyOf = (sourceIds: string[]): string => createHash('sha256').update(JSON.stringify(sourceIds), 'utf8').digest('hex');

/** The L1s in store order. */
function inOrder(strategy: Lane, manager: ContextManager): string[] {
  const pos = new Map(manager.getAllMessages().map((m, i) => [m.id, i] as const));
  return strategy.all
    .filter((s) => s.level === 1)
    .sort((a, b) => pos.get(a.sourceRange.first)! - pos.get(b.sourceRange.first)!)
    .map((s) => s.id);
}

/** Ticks with the strategy's warnings and a refused merge's error kept quiet. */
async function ticks(manager: ContextManager, n: number): Promise<void> {
  const warn = console.warn, error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    for (let t = 0; t < n; t++) {
      try { await manager.tick(); } catch { /* a refused merge can throw */ }
    }
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

function lane(extra: Record<string, unknown> = {}): Lane {
  return new Lane({
    headWindowTokens: 0,
    recentWindowTokens: 5,
    targetChunkTokens: 20,
    l1HoldbackChunks: 0,
    autoTickOnNewMessage: false,
    compressionModel: 'mock',
    mergeThreshold: 3,
    mergeAttemptLimit: 1,
    hierarchical: true,
    quarantineAlarmIntervalMs: 0,
    ...extra,
  });
}

/** Messages arrive as a live agent's do: five at a time, ticks between, so each merge runs as it forms. */
async function arrive(manager: ContextManager, batches: number, from = 0): Promise<string[]> {
  const ids: string[] = [];
  const warn = console.warn, error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    for (let b = 0; b < batches; b++) {
      for (let i = 0; i < 5; i++) ids.push(manager.addMessage('user', [{ type: 'text', text: `m-${from + b * 5 + i} hello world` }]));
      for (let t = 0; t < 5; t++) {
        try { await manager.tick(); } catch { /* a refused merge can throw */ }
      }
    }
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return ids;
}

/** A compile, as a live host runs one each turn; it reads the store's order afresh. */
async function compile(manager: ContextManager): Promise<void> {
  const warn = console.warn;
  console.warn = () => {};
  try { await manager.compile(); } finally { console.warn = warn; }
}

const parented = (s: SummaryEntry | undefined): boolean =>
  Boolean(s && (s.mergedInto || (s as { parentId?: string }).parentId));

describe('AutobiographicalStrategy: a quarantined merge leaves a hole, and merges form around it', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  for (const speculativeProduction of [false, true]) {
    it(`merges the L1s after a quarantined merge, which stay out until it is cleared${speculativeProduction ? ', under speculativeProduction' : ''}`, async () => {
      const { membrane, state } = provider([1]);
      const strategy = lane({ speculativeProduction });
      const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
      await arrive(manager, 24);
      const groups = strategy.quarantinedGroups();
      assert.equal(groups.length, 1, 'premise: the refused merge is quarantined');
      const held = new Set(groups[0]);
      const l2s = strategy.all.filter((s) => s.level === 2);
      assert.ok(l2s.length >= 2, `L1s after the quarantined group merge (${l2s.length} L2s)`);
      for (const l2 of l2s) {
        assert.ok(!l2.sourceIds.some((id) => held.has(id)), `${l2.id} takes no quarantined L1`);
      }
      for (const id of held) assert.equal(parented(strategy.all.find((s) => s.id === id)), false, `${id} stays unmerged`);

      state.refusing = false;
      const warn = console.warn;
      console.warn = () => {};
      try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
      await arrive(manager, 2, 1000);
      assert.equal(strategy.quarantinedGroups().length, 0, 'the clear empties the quarantine');
      for (const id of held) assert.equal(parented(strategy.all.find((s) => s.id === id)), true, `after the clear, ${id} merges`);
      manager.close();
    });
  }

  it('merges around the hole under a maxSpeculativeL1s that the held L1s and a run short of the threshold pass', async () => {
    const { membrane } = provider([1]);
    // Three held L1s and a run one short of the threshold of 3 pass a cap of 4.
    // With no L1 merge queued the cap holds nothing (speculativeCapHolds), so
    // compression goes on and the run reaches the threshold.
    const strategy = lane({ maxSpeculativeL1s: 4 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 24);
    const groups = strategy.quarantinedGroups();
    assert.equal(groups.length, 1, 'premise: the refused merge is quarantined');
    const held = new Set(groups[0]);
    const l2s = strategy.all.filter((s) => s.level === 2);
    assert.ok(l2s.length >= 2, `L1s after the quarantined group merge (${l2s.length} L2s)`);
    for (const l2 of l2s) assert.ok(!l2.sourceIds.some((id) => held.has(id)), `${l2.id} takes no quarantined L1`);
    manager.close();
  });

  it('offers the runs beside a new hole as soon as the record is written, with no new L1', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 12);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 6, `premise: enough L1s (${l1s.length})`);
    strategy.setThreshold(3);
    strategy.queueMerge(2, l1s.slice(0, 3));
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [l1s.slice(0, 3)], 'premise: the queued merge is quarantined');
    await ticks(manager, 1);
    const after = strategy.all.filter((s) => s.level === 2);
    assert.ok(after.some((l2) => l2.sourceIds[0] === l1s[3]), 'the run after the hole merges without another L1 or merge to start it');
    manager.close();
  });

  for (const speculativeProduction of [false, true]) {
    it(`merges a run that ends before a held group at the live end, as an interior run${speculativeProduction ? ', under speculativeProduction' : ''}`, async () => {
      const { membrane } = provider([1]);
      const strategy = lane({ mergeThreshold: 99, speculativeProduction });
      const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
      await arrive(manager, 6);
      const l1s = inOrder(strategy, manager);
      assert.ok(l1s.length >= 5, `premise: enough L1s (${l1s.length})`);
      // The run before the held group is short of this threshold, so only the interior rule merges it.
      strategy.setThreshold(l1s.length - 2);
      const trailing = l1s.slice(-3);
      strategy.queueMerge(2, trailing);
      await ticks(manager, 2);
      assert.deepEqual(strategy.quarantinedGroups(), [trailing], 'premise: the trailing group is quarantined');
      const before = l1s.slice(0, -3);
      const l2 = strategy.all.find((s) => s.level === 2);
      assert.deepEqual(l2?.sourceIds, before, 'the run before the hole merges, since it can no longer grow');
      manager.close();
    });
  }

  it('lets a newest run short of the threshold wait when no held summary follows it', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 6);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 5, `premise: enough L1s (${l1s.length})`);
    strategy.setThreshold(l1s.length - 2);
    const leading = l1s.slice(0, 3);
    strategy.queueMerge(2, leading);
    await ticks(manager, 2);
    assert.deepEqual(strategy.quarantinedGroups(), [leading], 'premise: the leading group is quarantined');
    assert.equal(strategy.all.filter((s) => s.level === 2).length, 0, 'the run after the hole, the newest, waits for the threshold');
    manager.close();
  });

  it('holds out the sources of two records at once, and clearing one by its key retries its group alone', async () => {
    const { membrane } = provider([1, 2]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 14);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 11, `premise: enough L1s (${l1s.length})`);
    strategy.setThreshold(3);
    const first = [l1s[2]!, l1s[3]!];
    const second = [l1s[6]!, l1s[7]!];
    strategy.queueMerge(2, first);
    strategy.queueMerge(2, second);
    await ticks(manager, 12);
    assert.equal(strategy.quarantinedGroups().length, 2, 'premise: both groups are quarantined');
    const parentOf = (id: string) => strategy.all.find((s) => s.id === id);
    for (const id of [...first, ...second]) assert.equal(parented(parentOf(id)), false, `${id} stays unmerged`);
    for (const id of [l1s[4]!, l1s[5]!, l1s[8]!, l1s[9]!, l1s[10]!]) assert.equal(parented(parentOf(id)), true, `${id}, between or after the holes, merges`);

    // Clearing one record by its key retries its group alone.
    const key = strategy.recordKey(first);
    assert.ok(key, 'premise: the first group has a record');
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(key); } finally { console.warn = warn; }
    assert.deepEqual(strategy.quarantinedGroups(), [second], 'the other record stays');
    assert.deepEqual(strategy.queue.map((m) => m.sourceIds), [first], 'only the cleared group is queued');
    manager.close();
  });

  it('releases a hole once a source of its record is gone, without the sweep', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 12);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 6, `premise: enough L1s (${l1s.length})`);
    strategy.setThreshold(3);
    strategy.queueMerge(2, l1s.slice(0, 3));
    await ticks(manager, 8);
    assert.equal(strategy.quarantinedGroups().length, 1, 'premise: the group is quarantined, and the sweep is off');
    assert.equal(parented(strategy.all.find((s) => s.id === l1s[0])), false, 'premise: held while the record stands');
    strategy.drop(l1s[2]!);
    assert.equal(strategy.heldIds().size, 0, 'the record, a source of which is gone, holds nothing');
    strategy.queueMerge(2, l1s.slice(0, 3));
    assert.equal(strategy.queue.length, 0, 'its own group is still refused');
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.equal(strategy.queue.length, 0, 'the clear does not queue the group');
    // No merge forms at a level with fewer unmerged summaries than the
    // threshold; new L1s bring it there, as in a live store.
    const unmergedL1s = strategy.all.filter((s) => s.level === 1 && !parented(s)).length;
    assert.ok(unmergedL1s < 3, `premise: fewer unmerged L1s than the threshold (${unmergedL1s})`);
    await arrive(manager, 3, 1000);
    assert.equal(parented(strategy.all.find((s) => s.id === l1s[0])), true, 'its remaining sources merge again');
    manager.close();
  });

  it('releases a hole once a source of its record gains a parent, without the sweep', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    strategy.queueMerge(2, l1s.slice(0, 3));
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [l1s.slice(0, 3)], 'premise: the group is quarantined, and the sweep is off');
    assert.equal(strategy.heldIds().size, 3, 'premise: the record holds its sources');
    strategy.reparent(l1s[1]!, 'a-repair');
    assert.equal(strategy.heldIds().size, 0, 'the record, a source of which has a parent, holds nothing');
    strategy.queueMerge(2, l1s.slice(0, 3));
    assert.equal(strategy.queue.length, 0, 'its own group is still refused, though no record holds it');
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.equal(strategy.queue.some((m) => m.sourceIds.join() === l1s.slice(0, 3).join()), false, 'the clear does not queue the group');
    manager.close();
  });

  it('releases a hole once its group is no longer a valid merge, and the clear does not retry it', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    const group = l1s.slice(0, 3);
    strategy.queueMerge(2, group);
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [group], 'premise: the group is quarantined');
    assert.equal(strategy.heldIds().size, 3, 'premise: the record holds its sources');
    // Deleting the first message a source covers leaves it with no position.
    const middle = strategy.all.find((s) => s.id === group[1])!;
    manager.removeMessage(middle.sourceRange.first);
    await compile(manager);
    const after = strategy.all.find((s) => s.id === group[1]);
    assert.ok(after && !parented(after), 'premise: the source is still present and unparented');
    assert.equal(strategy.heldIds().size, 0, 'the record, whose group is no longer a valid merge, holds nothing');
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.equal(strategy.queue.some((m) => m.sourceIds.join() === group.join()), false, 'the clear does not queue the group');
    manager.close();
  });

  it('queues a cleared group as it stands before the merge check offers anything else', async () => {
    const { membrane, state } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 10);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 7, `premise: enough L1s (${l1s.length})`);
    const group = l1s.slice(1, 4);
    strategy.queueMerge(2, group);
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [group], 'premise: the group is quarantined');
    strategy.setThreshold(3);
    state.refusing = false;
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    // Offered first, the merge check would group the oldest three L1s, the first and two of the held ones.
    assert.deepEqual(strategy.queue[0]?.sourceIds, group, 'the held group is queued first, as it stands');
    manager.close();
  });

  it('queues no cleared group overlapping one already queued, so the merge check offers its other sources', async () => {
    // Two records over overlapping groups, as a store an older version's exact-set gate let write them can hold.
    const { membrane, state } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 10);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 7, `premise: enough L1s (${l1s.length})`);
    const first = l1s.slice(0, 3);
    strategy.queueMerge(2, first);
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [first], 'premise: the first group is quarantined');
    const second = l1s.slice(1, 4);
    const [record] = strategy.records();
    strategy.persistQuarantine([record!, { ...record!, key: keyOf(second), sourceIds: second }]);
    manager.close();

    const reopened = lane({ mergeThreshold: 99 });
    const again = await ContextManager.open({ path: PATH, strategy: reopened, membrane: membrane as never });
    assert.deepEqual(reopened.quarantinedGroups(), [first, second], 'premise: both records load');
    assert.equal(reopened.heldIds().size, 4, 'premise: both hold their sources');
    reopened.setThreshold(3);
    state.refusing = false;
    const warn = console.warn;
    console.warn = () => {};
    try { reopened.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.deepEqual(
      reopened.queue.map((m) => m.sourceIds),
      [first, l1s.slice(3, 6)],
      'the first group is queued as it stands; the second, overlapping it, is not, and the merge check groups its last source with the L1s after it',
    );
    await ticks(again, 6);
    assert.equal(parented(reopened.all.find((s) => s.id === l1s[3])), true, `${l1s[3]}, in the second group alone, merges`);
    again.close();
  });

  it('queues a cleared group in store order when its record lists the group in another order', async () => {
    // A record that lists its group out of store order, as one an older version wrote can.
    const { membrane, state } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 10);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 7, `premise: enough L1s (${l1s.length})`);
    const group = l1s.slice(1, 4);
    strategy.queueMerge(2, group);
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [group], 'premise: the group is quarantined');
    const reversed = [...group].reverse();
    const [record] = strategy.records();
    strategy.persistQuarantine([{ ...record!, key: keyOf(reversed), sourceIds: reversed }]);
    manager.close();

    const reopened = lane({ mergeThreshold: 99 });
    const again = await ContextManager.open({ path: PATH, strategy: reopened, membrane: membrane as never });
    assert.deepEqual(reopened.quarantinedGroups(), [reversed], 'premise: the record loads as written');
    assert.equal(reopened.heldIds().size, 3, 'premise: it holds its sources');
    state.refusing = false;
    const warn = console.warn;
    console.warn = () => {};
    try { reopened.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.deepEqual(reopened.queue.map((m) => m.sourceIds), [group], 'the group is queued in store order');
    await ticks(again, 2);
    const byId = new Map(reopened.all.map((s) => [s.id, s] as const));
    const merged = byId.get(byId.get(group[0]!)!.mergedInto ?? '');
    assert.ok(merged, 'the group merges');
    assert.deepEqual(merged.sourceIds, group);
    assert.deepEqual(merged.sourceRange, {
      first: byId.get(group[0]!)!.sourceRange.first,
      last: byId.get(group[2]!)!.sourceRange.last,
    }, "its range runs from the first L1's first message to the last L1's last");
    again.close();
  });

  it('lifts a record whose group holds an operator hold without queuing its group, and the sources after the hold merge', async () => {
    const { membrane, state } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 10);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 7, `premise: enough L1s (${l1s.length})`);
    const group = l1s.slice(1, 4);
    strategy.queueMerge(2, group);
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [group], 'premise: the group is quarantined');
    strategy.holdForReview([group[1]!]);
    strategy.setThreshold(3);
    state.refusing = false;
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.deepEqual(strategy.quarantinedGroups(), [], 'the record is lifted');
    assert.ok(!strategy.queue.some((m) => m.sourceIds.join() === group.join()), 'its group is not queued: a source of it is held');
    await ticks(manager, 6);
    const parentOf = (id: string) => strategy.all.find((s) => s.id === id);
    assert.equal(parented(parentOf(group[1]!)), false, 'the held source stays unmerged');
    assert.equal(parented(parentOf(group[2]!)), true, 'the source after the hold merges with the L1s after it');
    manager.close();
  });

  it('leaves a summary at its level once its operator hold lifts, unless an unmerged summary of its level sits beside it', async () => {
    // The same arrivals, holding the fourth L1 or the fifth: the merges that
    // form around the fourth leave both its neighbours merged, and around the
    // fifth they leave the one before it unmerged.
    const outcomes: Array<{ held: number; besideUnmerged: boolean; mergesOnceLifted: boolean }> = [];
    for (const held of [3, 4]) {
      cleanup();
      const { membrane } = provider([]);
      const strategy = lane({ mergeThreshold: 99 });
      const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
      await arrive(manager, 12);
      const x = inOrder(strategy, manager)[held]!;
      strategy.holdForReview([x]);
      strategy.setThreshold(3);
      await arrive(manager, 12, 1000);
      const byId = (id: string | undefined) => strategy.all.find((s) => s.id === id);
      assert.equal(parented(byId(x)), false, `premise: L1 ${held} is held out while the L1s around it merge`);
      const l1s = inOrder(strategy, manager);
      const at = l1s.indexOf(x);
      const besideUnmerged = [l1s[at - 1], l1s[at + 1]].some((id) => id !== undefined && !parented(byId(id)));
      strategy.holdForReview([]);
      await arrive(manager, 40, 2000);
      outcomes.push({ held, besideUnmerged, mergesOnceLifted: parented(byId(x)) });
      manager.close();
    }
    assert.deepEqual(outcomes, [
      { held: 3, besideUnmerged: false, mergesOnceLifted: false },
      { held: 4, besideUnmerged: true, mergesOnceLifted: true },
    ]);
  });

  it("merges a group cleared after merges formed around it into one summary, which stays below its neighbours' level", async () => {
    const { membrane, state } = provider([1]);
    const strategy = lane();
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 24);
    const groups = strategy.quarantinedGroups();
    assert.equal(groups.length, 1, 'premise: the oldest group is quarantined');
    const group = groups[0]!;
    assert.ok(strategy.all.some((s) => s.level === 3), 'premise: the history after it merged up to L3');
    state.refusing = false;
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    await arrive(manager, 40, 2000);
    const byId = new Map(strategy.all.map((s) => [s.id, s] as const));
    const parentOf = (id: string) => byId.get(id)!.mergedInto ?? (byId.get(id) as { parentId?: string }).parentId;
    const parents = new Set(group.map(parentOf));
    assert.equal(parents.size, 1, 'the cleared group merges into one summary');
    const merged = byId.get([...parents][0]!)!;
    assert.deepEqual([merged.level, merged.sourceIds], [2, group], 'an L2 over the group as it stands');
    assert.equal(parented(merged), false, 'which no summary above takes');
    const pos = new Map(manager.getAllMessages().map((m, i) => [m.id, i] as const));
    const l2s = strategy.all
      .filter((s) => s.level === 2)
      .sort((a, b) => pos.get(a.sourceRange.first)! - pos.get(b.sourceRange.first)!);
    const next = l2s[l2s.indexOf(merged) + 1];
    assert.ok(next, 'premise: an L2 follows it');
    assert.equal(byId.get(parentOf(next.id) ?? '')?.level, 3, 'while the L2 after it is under an L3');
    manager.close();
  });

  it('keeps the hole across a reopen of the store', async () => {
    const { membrane, state } = provider([1]);
    const strategy = lane();
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 6);
    const groups = strategy.quarantinedGroups();
    assert.equal(groups.length, 1, 'premise: the refused merge is quarantined');
    manager.close();
    state.refusing = false;

    const reopened = lane();
    const again = await ContextManager.open({ path: PATH, strategy: reopened, membrane: membrane as never });
    assert.deepEqual(reopened.quarantinedGroups(), groups, 'the record survives the reopen');
    await arrive(again, 12, 1000);
    const held = new Set(groups[0]);
    const l2s = reopened.all.filter((s) => s.level === 2);
    assert.ok(l2s.length >= 2, `L1s merge around the hole after the reopen (${l2s.length} L2s)`);
    for (const l2 of l2s) assert.ok(!l2.sourceIds.some((id) => held.has(id)), `${l2.id} takes no held L1`);
    again.close();
  });

  it('skips a queued entry holding a held source when it reaches the head, as a persisted queue from an older version can hold it', async () => {
    const { membrane, state } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    strategy.queueMerge(2, l1s.slice(0, 3));
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [l1s.slice(0, 3)], 'premise: the group is quarantined');
    strategy.persistQueue([{ level: 2, sourceIds: [l1s[2]!, l1s[3]!] }, { level: 2, sourceIds: [l1s[4]!, l1s[5]!] }]);
    manager.close();

    const reopened = lane({ mergeThreshold: 99 });
    const again = await ContextManager.open({ path: PATH, strategy: reopened, membrane: membrane as never });
    assert.equal(reopened.queue.length, 2, 'premise: both persisted entries are loaded');
    const mergesBefore = state.merges;
    let landings = 0;
    const hook = reopened as unknown as { noteCompressionLanded(membrane: object, model: string | undefined): void };
    const landed = hook.noteCompressionLanded.bind(reopened);
    hook.noteCompressionLanded = (m, model) => { landings++; landed(m, model); };
    await ticks(again, 3);
    const parentOf = (id: string) => reopened.all.find((s) => s.id === id);
    assert.equal(parented(parentOf(l1s[2]!)), false, 'the held source stays unmerged');
    assert.equal(reopened.quarantinedGroups().length, 1, 'the skip writes no record');
    assert.equal(parented(parentOf(l1s[4]!)), true, 'the entry clear of the hole merges');
    assert.equal(state.merges - mergesBefore, 1, 'only that entry reaches the provider');
    assert.equal(landings, 1, 'the skip is no landing: only the merge that ran is');
    assert.equal(reopened.queue.length, 0, 'the held entry leaves the queue');
    again.close();
  });

  it('offers the other sources of a skipped entry at once, with no new L1', async () => {
    const { membrane, state } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 6, `premise: enough L1s (${l1s.length})`);
    strategy.queueMerge(2, l1s.slice(0, 3));
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [l1s.slice(0, 3)], 'premise: the group is quarantined');
    strategy.persistQueue([{ level: 2, sourceIds: [l1s[2]!, l1s[3]!, l1s[4]!] }]);
    manager.close();

    state.refusing = false;
    // One more than the L1s after the entry: the merge check at open, which leaves the entry's sources out, forms nothing.
    const reopened = lane({ mergeThreshold: l1s.length - 4 });
    const again = await ContextManager.open({ path: PATH, strategy: reopened, membrane: membrane as never });
    assert.deepEqual(reopened.queue.map((m) => m.sourceIds), [[l1s[2]!, l1s[3]!, l1s[4]!]], 'premise: only the held entry is queued');
    await ticks(again, 3);
    const parentOf = (id: string) => reopened.all.find((s) => s.id === id);
    assert.equal(parented(parentOf(l1s[3]!)), true, 'the skipped entry\'s other sources merge without another L1');
    assert.equal(parented(parentOf(l1s[2]!)), false, 'the held source stays unmerged');
    again.close();
  });

  it('counts in the klaxon line the records that hold their sources', async () => {
    const { membrane } = provider([1, 2]);
    const strategy = lane({ mergeThreshold: 99, quarantineAlarmIntervalMs: 1 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 10);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 8, `premise: enough L1s (${l1s.length})`);
    strategy.queueMerge(2, l1s.slice(0, 3)); // refused at the provider: a record that holds
    await ticks(manager, 1);
    strategy.queueMerge(2, [l1s[3]!, l1s[5]!]); // not adjacent: a topology refusal, which holds nothing
    await ticks(manager, 1);
    strategy.queueMerge(2, [l1s[6]!, l1s[7]!]); // refused at the provider too, then no longer adjacent
    await ticks(manager, 1);
    assert.equal(strategy.quarantinedGroups().length, 3, 'premise: three records');
    const last = strategy.all.find((s) => s.id === l1s[7])!;
    assert.notEqual(last.sourceRange.first, last.sourceRange.last, 'premise: the last source covers more than one message');
    const covered = manager.getAllMessages().map((m) => m.id);
    strategy.retarget(l1s[7]!, covered[covered.indexOf(last.sourceRange.first) + 1]!);
    assert.equal(strategy.heldIds().size, 3, 'premise: only the first record holds');
    const lines: string[] = [];
    const error = console.error, warn = console.warn;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    console.warn = () => {};
    await new Promise((resolve) => setTimeout(resolve, 5));
    try { await manager.tick(); } catch { /* a merge may throw */ } finally { console.error = error; console.warn = warn; }
    const klaxon = lines.find((line) => line.includes('[merge-quarantine]') && line.includes('quarantined'));
    assert.ok(klaxon, `the klaxon sounds (${lines.length} error lines)`);
    assert.match(klaxon!, /3 merge\(s\) quarantined; 1 of them hold their sources out of merges/);
    manager.close();
  });

  it('releases a hole once its group is no longer adjacent in store order', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    const group = l1s.slice(0, 3);
    strategy.queueMerge(2, group);
    await ticks(manager, 1);
    assert.equal(strategy.heldIds().size, 3, 'premise: the record holds its sources');
    // The middle source now starts one message later, so a message lies between it and the first.
    const middle = strategy.all.find((s) => s.id === group[1])!;
    assert.notEqual(middle.sourceRange.first, middle.sourceRange.last, 'premise: the middle source covers more than one message');
    const covered = manager.getAllMessages().map((m) => m.id);
    const next = covered[covered.indexOf(middle.sourceRange.first) + 1]!;
    strategy.retarget(group[1]!, next);
    assert.equal(strategy.heldIds().size, 0, 'the record, whose group is no longer adjacent, holds nothing');
    manager.close();
  });

  it('holds nothing for a topology refusal, whose sources merge in a valid group', async () => {
    const { membrane } = provider([]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 4, `premise: enough L1s (${l1s.length})`);
    strategy.setThreshold(3);
    strategy.queueMerge(2, [l1s[0]!, l1s[2]!]); // not adjacent: the merge step refuses its topology
    await ticks(manager, 1);
    assert.equal(strategy.quarantinedGroups().length, 1, 'premise: the refusal is recorded');
    assert.equal(strategy.heldIds().size, 0, 'a topology refusal holds nothing');
    await ticks(manager, 2);
    assert.equal(parented(strategy.all.find((s) => s.id === l1s[0])), true, 'its sources merge in a valid group, with no new L1 to start it');
    manager.close();
  });

  it('clears a topology refusal without queuing its group', async () => {
    const { membrane } = provider([]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    strategy.queueMerge(2, [l1s[0]!, l1s[2]!]); // not adjacent: the merge step refuses its topology
    await ticks(manager, 1);
    assert.equal(strategy.quarantinedGroups().length, 1, 'premise: the refusal is recorded');
    const warn = console.warn;
    console.warn = () => {};
    try { strategy.clearMergeQuarantine(); } finally { console.warn = warn; }
    assert.equal(strategy.quarantinedGroups().length, 0, 'the clear removes the record');
    assert.equal(strategy.queue.length, 0, 'and queues nothing for a group that is still no valid merge');
    manager.close();
  });

  it("queues a topology refusal's own group once it is a valid merge again, and drops its record", async () => {
    const { membrane } = provider([]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    const group = [l1s[0]!, l1s[2]!];
    strategy.queueMerge(2, group); // not adjacent: the merge step refuses its topology
    await ticks(manager, 1);
    assert.equal(strategy.quarantinedGroups().length, 1, 'premise: the refusal is recorded');
    strategy.queueMerge(2, group);
    assert.equal(strategy.queue.length, 0, 'while the group is no valid merge, its record refuses it');
    // Deleting every message the summary between them covers makes the two adjacent.
    const between = strategy.all.find((s) => s.id === l1s[1])!;
    manager.removeMessages(between.sourceRange.first, between.sourceRange.last);
    await compile(manager);
    strategy.queueMerge(2, group);
    assert.deepEqual(strategy.queue.map((m) => m.sourceIds), [group], 'the group queues once it is a valid merge');
    assert.equal(strategy.quarantinedGroups().length, 0, 'and its record goes');
    manager.close();

    const reopened = lane({ mergeThreshold: 99 });
    const again = await ContextManager.open({ path: PATH, strategy: reopened, membrane: membrane as never });
    assert.equal(reopened.quarantinedGroups().length, 0, 'the record stays gone after a reopen');
    again.close();
  });

  it("refuses a topology refusal's own group while a source of it is parented or gone", async () => {
    const { membrane } = provider([]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    const group = [l1s[0]!, l1s[2]!];
    strategy.queueMerge(2, group); // not adjacent: the merge step refuses its topology
    await ticks(manager, 1);
    assert.equal(strategy.quarantinedGroups().length, 1, 'premise: the refusal is recorded');
    const between = strategy.all.find((s) => s.id === l1s[1])!;
    manager.removeMessages(between.sourceRange.first, between.sourceRange.last);
    await compile(manager);
    strategy.reparent(l1s[2]!, 'a-repair');
    strategy.queueMerge(2, group);
    assert.equal(strategy.queue.length, 0, 'a group with a parented source is refused');
    assert.equal(strategy.quarantinedGroups().length, 1, 'and its record stays');
    strategy.reparent(l1s[2]!, undefined);
    strategy.drop(l1s[0]!);
    strategy.queueMerge(2, group);
    assert.equal(strategy.queue.length, 0, 'a group with a gone source is refused, without throwing');
    assert.equal(strategy.quarantinedGroups().length, 1, 'and its record stays');
    manager.close();
  });

  it('refuses to queue any group that holds a held source', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 });
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 8);
    const l1s = inOrder(strategy, manager);
    strategy.queueMerge(2, l1s.slice(0, 3));
    await ticks(manager, 1);
    assert.deepEqual(strategy.quarantinedGroups(), [l1s.slice(0, 3)], 'premise: the group is quarantined');
    strategy.queueMerge(2, [l1s[2]!, l1s[3]!]);
    assert.equal(strategy.queue.length, 0, 'a group sharing a held source is refused');
    manager.close();
  });

  it('keeps the levels above from merging across the hole', async () => {
    const { membrane } = provider([2]);
    const strategy = lane();
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    await arrive(manager, 24);
    const groups = strategy.quarantinedGroups();
    assert.equal(groups.length, 1, 'premise: the second merge is quarantined');
    const held = new Set(groups[0]);
    const pos = new Map(manager.getAllMessages().map((m, i) => [m.id, i]));
    const holeFirst = Math.min(...[...held].map((id) => pos.get(strategy.all.find((s) => s.id === id)!.sourceRange.first)!));
    const l2s = strategy.all.filter((s) => s.level === 2);
    const before = l2s.filter((s) => pos.get(s.sourceRange.last)! < holeFirst);
    assert.equal(before.length, 1, 'premise: one L2 formed before the hole');
    const l3s = strategy.all.filter((s) => s.level === 3);
    assert.ok(l3s.length >= 1, `the L2s after the hole merge (${l3s.length} L3s)`);
    for (const l3 of l3s) {
      assert.ok(!l3.sourceIds.includes(before[0]!.id), `${l3.id} doesn't reach across the hole`);
    }
    assert.equal(parented(before[0]), false, 'the L2 before the hole stays a lone interior summary');
    manager.close();
  });

  it('takes no group across an operator-held L1 whose first message was removed, in a merge the picker asks for', async () => {
    const { membrane } = provider([]);
    const strategy = lane({ mergeThreshold: 99 }); // no merge forms by itself
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    const ids = await arrive(manager, 12);
    const l1s = inOrder(strategy, manager);
    assert.ok(l1s.length >= 9, `premise: enough L1s (${l1s.length})`);
    const held = strategy.all.find((s) => s.id === l1s[4])!;
    strategy.holdForReview([held.id]);
    manager.removeMessage(held.sourceRange.first);
    await compile(manager);
    assert.equal(manager.getMessage(held.sourceRange.first), null, 'premise: its first message is gone');
    assert.notEqual(manager.getMessage(held.sourceRange.last), null, 'premise: its last remains');
    assert.ok(strategy.heldIds().has(held.id), 'premise: the hold holds it');

    strategy.produceMerge(2, ids[0]!, ids[ids.length - 1]!);
    const queued = strategy.queue.filter((m) => m.level === 2);
    assert.equal(queued.length, 1, 'the produce op queues one merge');
    const at = l1s.indexOf(held.id);
    const places = queued[0]!.sourceIds.map((id) => l1s.indexOf(id));
    assert.ok(places.every((p) => p > at) || places.every((p) => p >= 0 && p < at), 'over a run on one side of the held L1, not across it');
    manager.close();
  });

  it('leaves quarantined L1s out of a merge the picker asks for over their range', async () => {
    const { membrane } = provider([1]);
    const strategy = lane({ mergeThreshold: 99 }); // no merge forms by itself
    const manager = await ContextManager.open({ path: PATH, strategy, membrane: membrane as never });
    const ids = await arrive(manager, 12);
    const l1s = strategy.all.filter((s) => s.level === 1);
    assert.ok(l1s.length >= 9, `premise: enough L1s (${l1s.length})`);
    const pos = new Map(manager.getAllMessages().map((m, i) => [m.id, i]));
    l1s.sort((a, b) => pos.get(a.sourceRange.first)! - pos.get(b.sourceRange.first)!);
    const middle = l1s.slice(3, 6).map((s) => s.id);
    strategy.queueMerge(2, middle);
    const warn = console.warn, error = console.error;
    console.warn = () => {};
    console.error = () => {};
    try { await manager.tick(); } catch { /* refused */ } finally { console.warn = warn; console.error = error; }
    assert.deepEqual(strategy.quarantinedGroups(), [middle], 'premise: the middle group is quarantined');

    strategy.produceMerge(2, ids[0]!, ids[ids.length - 1]!);
    const queued = strategy.queue.filter((m) => m.level === 2);
    assert.equal(queued.length, 1, 'the produce op queues one merge');
    assert.ok(queued[0]!.sourceIds.length >= 2, 'over a run on one side of the hole');
    assert.ok(!queued[0]!.sourceIds.some((id) => middle.includes(id)), 'that takes no quarantined L1');
    manager.close();
  });
});
