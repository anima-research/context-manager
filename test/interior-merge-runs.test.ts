import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { ContextManager } from '../src/index.js';
import { AutobiographicalStrategy, type Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext } from '../src/types/index.js';
import type { SummaryEntry } from '../src/types/strategy.js';
import { strandedInStore } from '../src/repair/topology.js';
import { mergeRunsByLevel, queuedMergeRuns, runGroups, runsAtLevel, strandedIn } from '../src/strategies/merge-runs.js';

class Probe extends AutobiographicalStrategy {
  constructor(config: ConstructorParameters<typeof AutobiographicalStrategy>[0]) {
    super(config);
    (this as unknown as { requireBranchMutation: () => void }).requireBranchMutation = () => {};
    (this as unknown as { requireLoadedBranch: () => void }).requireLoadedBranch = () => {};
    (this as unknown as { store: unknown }).store = { getStateJson: () => null, setStateJson: () => {}, currentBranch: () => ({ name: 'main' }) };
  }
  quarantineGroup(key: string, sourceIds: string[], lastOutcome = 'refusal'): void {
    (this as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine.set(key, { key, level: 2, sourceIds, attempts: 3, lastOutcome, quarantinedAt: 1 });
  }
  setChunks(messageIds: string[]): void {
    (this as unknown as { chunks: unknown[] }).chunks = [{ messages: messageIds.map((id) => ({ id })), compressed: true }];
  }
  setChunkList(chunks: Array<{ from: number; to: number; compressed: boolean }>): void {
    (this as unknown as { chunks: unknown[] }).chunks = chunks.map(({ from, to, compressed }) => ({
      messages: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `m-${from + i}` })), compressed,
    }));
  }
  setQueue(queue: Array<{ level: number; sourceIds: string[] }>): void {
    (this as unknown as { mergeQueue: unknown[] }).mergeQueue = queue;
  }
  queued(): string[][] {
    return (this as unknown as { mergeQueue: Array<{ sourceIds: string[] }> }).mergeQueue.map((m) => m.sourceIds);
  }
  produce(level: number, first: string, last: string): void {
    this.handleProducedOps([{ level, range: { firstChunkId: first, lastChunkId: last } }] as never);
  }
  setSummaries(summaries: SummaryEntry[]): void {
    (this as unknown as { summaries: SummaryEntry[] }).summaries = summaries;
  }
  pick(unmerged: SummaryEntry[], threshold: number): SummaryEntry[] | null {
    return this.contiguousMergeCandidates(unmerged, threshold);
  }
}


function probe(extra: Record<string, unknown> = {}): Probe {
  const p = new Probe({ adaptiveResolution: true, autoTickOnNewMessage: false, ...extra });
  p.setChunks(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
  return p;
}

function summary(id: string, first: number, last: number, level = 1, parent?: string): SummaryEntry {
  return {
    id, level, content: `s ${id}`, tokens: 100, sourceLevel: level - 1,
    sourceIds: level === 1 ? Array.from({ length: last - first + 1 }, (_, i) => `m-${first + i}`) : [`x-${id}`],
    sourceRange: { first: `m-${first}`, last: `m-${last}` }, created: 1,
    ...(parent ? { mergedInto: parent } : {}),
  } as SummaryEntry;
}

function run(prefix: string, n: number, from: number): SummaryEntry[] {
  return Array.from({ length: n }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9));
}

const ids = (picked: SummaryEntry[] | null): string[] | null => picked?.map((s) => s.id) ?? null;

describe('interior merge runs', () => {
  it('merges an interior run of seven at a threshold of six as four and three, leaving no summary alone', () => {
    const p = probe();
    const interior = run('i', 7, 0);
    const newest = run('n', 3, 1000);
    assert.deepEqual(ids(p.pick([...interior, ...newest], 6)), ['i0', 'i1', 'i2', 'i3']);
    assert.deepEqual(ids(p.pick([...interior.slice(4), ...newest], 6)), ['i4', 'i5', 'i6']);
    assert.equal(p.pick(newest, 6), null, 'the newest run still waits for six');
  });

  it('merges the newest run\'s first threshold when it holds more, and leaves the rest to grow', () => {
    const p = probe();
    assert.deepEqual(ids(p.pick(run('n', 8, 0), 6)), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
  });

  it('takes one fewer from the newest run where its first threshold would leave a single summary behind', () => {
    const p = probe();
    assert.deepEqual(ids(p.pick(run('n', 7, 0), 6)), ['n0', 'n1', 'n2', 'n3', 'n4'], 'seven at six: five, leaving two to grow');
    assert.deepEqual(ids(p.pick(run('n', 3, 0), 2)), ['n0', 'n1', 'n2'], 'three at two: one fewer would be a group of one, so the run merges whole');
    assert.equal(p.pick(run('n', 5, 0), 6), null, 'below the threshold the newest run waits to grow');
  });

  it('leaves none or two or more of the newest run behind, at thresholds 2 to 6', () => {
    for (let threshold = 2; threshold <= 6; threshold++) {
      for (let n = threshold; n <= 3 * threshold + 1; n++) {
        const p = probe();
        let newest = run('n', n, 0);
        const sizes: number[] = [];
        for (let picked = ids(p.pick(newest, threshold)); picked; picked = ids(p.pick(newest, threshold))) {
          assert.deepEqual(picked, newest.slice(0, picked.length).map((s) => s.id), 'the oldest summaries of the run');
          sizes.push(picked.length);
          newest = newest.slice(picked.length);
        }
        const label = `threshold ${threshold}, newest run of ${n}: groups ${sizes.join(' + ')}, ${newest.length} left`;
        assert.notEqual(newest.length, 1, label);
        assert.ok(newest.length < threshold, `${label}: what is left is short of a group`);
        assert.ok(sizes.every((size) => size >= 2 && size <= Math.max(threshold, 3)), label);
      }
    }
  });

  it('queues an empty group at a threshold of 0 and a single summary at 1, as before (#285)', () => {
    const p = probe();
    const unmerged = [...run('i', 3, 0), ...run('n', 2, 1000)];
    assert.deepEqual(ids(p.pick(unmerged, 0)), []);
    assert.deepEqual(ids(p.pick(unmerged, 1)), ['i0']);
    const held = probe({ mergeHoldSummaryIds: ['i0', 'i1', 'i2', 'n0', 'n1'] });
    assert.equal(held.pick(unmerged, 0), null, 'with every summary held there is no run, so no group');
  });

  it('merges an interior pair when fewer than the threshold are unmerged at its level', () => {
    const p = probe();
    const unmerged = [...run('a', 2, 0), ...run('b', 2, 1000)];
    assert.deepEqual(ids(p.pick(unmerged, 6)), ['a0', 'a1'], 'four unmerged in all, and the interior pair merges');
  });

  it('takes from any interior run, at thresholds 2 to 6, only groups that leave no run of one', () => {
    for (let threshold = 2; threshold <= 6; threshold++) {
      for (let n = threshold; n <= 2 * threshold + 1; n++) {
        const p = probe();
        let interior = run('i', n, 0);
        const newest = run('n', 1, 1000);
        const sizes: number[] = [];
        for (let step = 0; interior.length > 0; step++) {
          assert.ok(step < n, `threshold ${threshold}, run of ${n}: the run is used up`);
          const picked = ids(p.pick([...interior, ...newest], threshold));
          assert.ok(picked, `threshold ${threshold}, run of ${n}: ${interior.length} left unmerged`);
          assert.deepEqual(picked, interior.slice(0, picked.length).map((s) => s.id), 'the oldest summaries of the run');
          sizes.push(picked.length);
          interior = interior.slice(picked.length);
          assert.notEqual(interior.length, 1, `threshold ${threshold}, run of ${n}: groups ${sizes.join(' + ')} leave one alone`);
        }
        const label = `threshold ${threshold}, run of ${n}: groups ${sizes.join(' + ')}`;
        assert.ok(sizes.every((size) => size >= 2), label);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${label} are as even as they can be`);
        assert.ok(sizes.every((size) => size <= Math.max(threshold, 3)), `${label} stay within the threshold, or three at a threshold of two`);
        assert.equal(sizes.length, threshold === 2 ? Math.floor(n / 2) : Math.ceil(n / threshold), `${label}: as few groups as leave none alone`);
      }
    }
  });
});

describe('which run is the newest', () => {
  it('is not a run before a held summary of its level: it can\'t grow past the hold, so it splits evenly', () => {
    const p = probe({ mergeHoldSummaryIds: ['H'] });
    const before = run('i', 7, 0);
    assert.deepEqual(ids(p.pick([...before, summary('H', 70, 79)], 6)), ['i0', 'i1', 'i2', 'i3'], 'seven before the hold: four and three');
    assert.deepEqual(ids(probe().pick(before, 6)), ['i0', 'i1', 'i2', 'i3', 'i4'], 'control: with nothing held, the newest run takes five, leaving two to grow');
  });
});

describe('queued merges', () => {
  it('reads one with a source stored without a level as one that can\'t run, since the merge refuses it', () => {
    const position = new Map(Array.from({ length: 20 }, (_, i) => [`m-${i}`, i] as const));
    const byId = new Map<string, SummaryEntry>([['a', { ...summary('a', 0, 9), level: undefined } as unknown as SummaryEntry], ['b', summary('b', 10, 19)]]);
    const unparented = () => undefined;
    assert.equal(queuedMergeRuns({ level: 2, sourceIds: ['a', 'b'] }, byId, unparented, position), false);
    const both = new Map<string, SummaryEntry>([['a', summary('a', 0, 9)], ['b', summary('b', 10, 19)]]);
    assert.equal(queuedMergeRuns({ level: 2, sourceIds: ['a', 'b'] }, both, unparented, position), true, 'control: with its level stored, it runs');
  });

  it('splits a merge group by a subclass\'s contiguousSourceRuns, which mergeTopologyProblem reads', () => {
    class Apart extends Probe { protected override contiguousSourceRuns(sources: readonly SummaryEntry[]): SummaryEntry[][] { return sources.map((s) => [s]); } }
    const position = new Map(Array.from({ length: 20 }, (_, i) => [`m-${i}`, i] as const));
    const sources = [summary('a', 0, 9), summary('b', 10, 19)];
    const problem = (p: Probe) => (p as unknown as { mergeTopologyProblem(level: number, s: SummaryEntry[], at: Map<string, number>): string | null }).mergeTopologyProblem(2, sources, position);
    assert.equal(problem(new Probe({ autoTickOnNewMessage: false })), null, 'premise: adjacent, so they may merge');
    assert.match(String(problem(new Apart({ autoTickOnNewMessage: false }))), /not adjacent/);
  });

  it('reads a run before a retry\'s hole as waiting: it groups as the newest does, and a lone one is no stray', () => {
    const position = new Map(Array.from({ length: 120 }, (_, i) => [`m-${i}`, i] as const));
    const seven = Array.from({ length: 7 }, (_, i) => summary(`a${i}`, i * 10, i * 10 + 9));
    const after = Array.from({ length: 3 }, (_, i) => summary(`b${i}`, 80 + i * 10, 89 + i * 10));
    const input = (summaries: SummaryEntry[], pending: Array<{ first: number; last: number; level: number }>) =>
      ({ summaries, parentOf: () => undefined, queued: new Set<string>(), position, held: new Set<string>(), pending, spanBase: 1500, mergeK: 6 });
    const hole = [{ first: 70, last: 79, level: 1 }];
    const [waiting] = runsAtLevel(input([...seven, ...after], hole), 1).runs;
    assert.equal(waiting!.waiting, true);
    assert.deepEqual(runGroups(waiting!, 6).map((g) => g.length), [5], 'five, leaving two to wait for what lands, never one');
    const [interior] = runsAtLevel(input([...seven, ...after], []), 1).runs;
    assert.deepEqual([interior!.waiting, runGroups(interior!, 6).map((g) => g.length)], [false, [4, 3]], 'control: with no retry, it is interior');
    const lone = runsAtLevel(input([seven[0]!, ...after].map((x, i) => (i === 0 ? summary('a0', 60, 69) : x)), hole), 1).runs;
    assert.deepEqual(strandedIn(lone), [], 'a lone L1 before the retry\'s hole is no stray');
    assert.equal(strandedIn(runsAtLevel(input([summary('a0', 60, 69), ...after], []), 1).runs).length, 1, 'control: with no retry, it is');
  });

  it('leaves a summary with no level out of every run, at every level', () => {
    const position = new Map(Array.from({ length: 30 }, (_, i) => [`m-${i}`, i] as const));
    const nolevel = { ...summary('n', 10, 19), level: undefined } as unknown as SummaryEntry;
    const summaries = [summary('a', 0, 9), nolevel, summary('b', 20, 29)];
    const input = { summaries, parentOf: () => undefined, queued: new Set<string>(), position, held: new Set<string>(), pending: [], spanBase: 1500, mergeK: 6 };
    const members = (runs: Array<{ members: Array<{ s: SummaryEntry }> }>) => runs.map((r) => r.members.map((m) => m.s.id));
    assert.deepEqual(members(runsAtLevel(input, 1).runs), [['a'], ['b']], 'n parts a from b, in no run');
    for (const [level, { runs }] of mergeRunsByLevel(input, 3)) {
      assert.ok(!members(runs).flat().includes('n'), `no run at L${level} holds n`);
    }
  });

});

describe('a drain after a rebuild', () => {
  const STORE = './test-interior-merge-runs-drain-store';
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  after(wipe);

  class Drain extends AutobiographicalStrategy {
    protected override landsAsPlanned(): boolean { return true; }
  }
  const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'what happened here, in a few words' }] }) };
  const config = (holdback: number) => ({
    adaptiveResolution: true, hierarchical: true, speculativeProduction: true, autoTickOnNewMessage: false, compressionModel: 'mock',
    headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: holdback, minChunkCharsForLLM: 0, targetChunkTokens: 20,
    mergeHoldSummaryIds: ['h'],
  });

  async function rebuilt(opts: { twoAtTheEdge?: boolean } = {}): Promise<string[]> {
    wipe();
    const seed = new AutobiographicalStrategy(config(0) as never);
    const manager = await ContextManager.open({ path: STORE, strategy: seed, namespace: 'probe', membrane: membrane as never });
    const m: string[] = [];
    for (let i = 0; i < 10; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
    const one = (id: string, at: number): SummaryEntry => ({
      id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds: [m[at]!], sourceRange: { first: m[at]!, last: m[at]! }, created: 1,
    } as SummaryEntry);
    const l1s = [one('a0', 0), one('a1', 1), one('a2', 2), one('a3', 3), one('h', 5), one('n0', 6), ...(opts.twoAtTheEdge ? [] : [one('n1', 7)])];
    const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void }; summariesStateId: string; chunksStateId: string };
    internals.store.setStateJson(internals.summariesStateId, l1s);
    internals.store.setStateJson(internals.chunksStateId, [
      ...l1s.map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id })),
      ...(opts.twoAtTheEdge ? [{ id: 'c-live-0', sourceIds: [m[7]!], compressed: false }] : []),
      { id: 'c-live', sourceIds: [m[8]!], compressed: false },
    ]);
    manager.close();
    return m;
  }

  async function drain(strategy: AutobiographicalStrategy, holdback = 0): Promise<{ summaries: SummaryEntry[]; stranded: string[]; pendingChunks: number | null; close(): void }> {
    const manager = await ContextManager.open({ path: STORE, strategy, namespace: 'probe', membrane: membrane as never });
    const lane = strategy as unknown as { summaries: SummaryEntry[] };
    const { warn } = console;
    console.warn = () => {};
    let pendingChunks: number | null = null;
    try {
      for (let guard = 0; guard < 50 && !drainedHere(strategy); guard++) await manager.tick();
      assert.ok(drainedHere(strategy), 'premise: drained, by the drain script\'s rule');
      pendingChunks = strategy.getCompressionDebt().pendingChunks;
    } finally { console.warn = warn; manager.close(); }
    const resident = new AutobiographicalStrategy(config(holdback) as never);
    const reopened = await ContextManager.open({ path: STORE, strategy: resident, namespace: 'probe', membrane: membrane as never });
    try {
      const listed = resident.getStrandedSummaries().summaries;
      assert.ok(listed, 'premise: the stray list was read');
      return { summaries: lane.summaries, stranded: listed.map((s) => s.id), pendingChunks, close: () => {} };
    } finally { reopened.close(); }
  }

  function drainedHere(strategy: AutobiographicalStrategy): boolean {
    const progress = strategy.getProgressSnapshot();
    const debt = strategy.getCompressionDebt();
    return !progress.pending && progress.l1QueueLength === 0 && progress.mergeQueueLength === 0 && debt.pendingChunks === 0 &&
      debt.error === undefined && !(strategy as unknown as { mergePicksWaiting: boolean }).mergePicksWaiting;
  }

  const l1Over = (summaries: readonly SummaryEntry[], m: readonly string[], at: number) =>
    summaries.find((s) => s.level === 1 && s.sourceIds.includes(m[at]!));

  it("picks the group beside a released chunk once the chunk has landed, so the chunk's summary isn't left alone", async () => {
    let m = await rebuilt();
    const drained = await drain(new Drain(config(0) as never));
    try {
      const released = l1Over(drained.summaries, m, 4);
      assert.ok(released, 'premise: the released message compressed');
      assert.ok(released.mergedInto, 'it merged with a0-a3, five before the held h');
      assert.equal(drained.summaries.find((s) => s.id === 'a0')?.mergedInto, released.mergedInto);
      assert.deepEqual(drained.stranded, []);
    } finally { drained.close(); }

    m = await rebuilt();
    const eager = await drain(new AutobiographicalStrategy(config(0) as never));
    try {
      const released = l1Over(eager.summaries, m, 4);
      assert.ok(released && !released.mergedInto, 'premise: the released message compressed, and nothing took it');
      assert.deepEqual(eager.stranded, [released.id]);
    } finally { eager.close(); }
  });

  async function twoLevels(path: string, cfg: object, queue: Array<{ level: number; sourceIds: string[] }> = []): Promise<void> {
    const seed = new AutobiographicalStrategy(cfg as never);
    const manager = await ContextManager.open({ path, strategy: seed, namespace: 'probe', membrane: membrane as never });
    const m: string[] = [];
    for (let i = 0; i < 6; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
    const one = (id: string, at: number, mergedInto?: string): SummaryEntry => ({
      id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds: [m[at]!], sourceRange: { first: m[at]!, last: m[at]! }, created: 1, ...(mergedInto ? { mergedInto } : {}),
    } as SummaryEntry);
    const two = (id: string, from: number, src: string[]): SummaryEntry => ({
      id, level: 2, content: `s ${id}`, tokens: 50, sourceLevel: 1, sourceIds: src, sourceRange: { first: m[from]!, last: m[from + 1]! }, created: 1,
    } as SummaryEntry);
    const l1s = [one('c0', 0, 'u0'), one('c1', 1, 'u0'), one('c2', 2, 'u1'), one('c3', 3, 'u1'), one('l0', 4), one('l1', 5)];
    const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void }; summariesStateId: string; chunksStateId: string; mergeQueueStateId: string };
    internals.store.setStateJson(internals.summariesStateId, [...l1s, two('u0', 0, ['c0', 'c1']), two('u1', 2, ['c2', 'c3'])]);
    internals.store.setStateJson(internals.chunksStateId, l1s.map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id })));
    internals.store.setStateJson(internals.mergeQueueStateId, queue);
    manager.close();
  }

  it('lands a stored lower merge before it picks above, then picks the level above with that merge\'s summary in it', async () => {
    const PATH = `${STORE}-stored`;
    if (existsSync(PATH)) rmSync(PATH, { recursive: true, force: true });
    const cfg = { ...config(0), mergeThreshold: 2, mergeHoldSummaryIds: [] };
    await twoLevels(PATH, cfg, [{ level: 2, sourceIds: ['l0', 'l1'] }]);
    const strategy = new Drain(cfg as never);
    const manager = await ContextManager.open({ path: PATH, strategy, namespace: 'probe', membrane: membrane as never });
    const lane = strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }>; compressionQueue: unknown[]; mergePicksWaiting: boolean; summaries: SummaryEntry[] };
    const { warn } = console;
    console.warn = () => {};
    try {
      assert.deepEqual(lane.mergeQueue.map((x) => x.sourceIds), [['l0', 'l1']], 'at open, nothing above the stored merge is picked');
      assert.equal(lane.mergePicksWaiting, true);
      for (let guard = 0; guard < 50 && (lane.mergeQueue.length > 0 || lane.compressionQueue.length > 0 || lane.mergePicksWaiting); guard++) await manager.tick();
      const l2 = lane.summaries.find((s) => s.level === 2 && s.sourceIds.includes('l0'))!;
      assert.ok(l2, 'the stored merge landed');
      const parent = lane.summaries.find((s) => s.id === l2.mergedInto);
      assert.deepEqual(parent?.sourceIds, ['u0', 'u1', l2.id]);
    } finally {
      console.warn = warn;
      manager.close();
      rmSync(PATH, { recursive: true, force: true });
    }
  });

  it('runs its picks again once a merge leaves the queue, landed or not, and forgets a put-off pick when its branch is cleared', async () => {
    const PATH = `${STORE}-left`;
    if (existsSync(PATH)) rmSync(PATH, { recursive: true, force: true });
    const cfg = { ...config(0), mergeThreshold: 2, mergeHoldSummaryIds: [] };
    await twoLevels(PATH, cfg);
    const strategy = new Drain(cfg as never);
    const manager = await ContextManager.open({ path: PATH, strategy, namespace: 'probe', membrane: membrane as never });
    const lane = strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }>; mergePicksWaiting: boolean; mergePicksDeferred: boolean; dequeueMerge(): unknown; clearBranchMirrors(): void };
    try {
      assert.deepEqual(lane.mergeQueue.map((x) => x.sourceIds), [['l0', 'l1']], 'premise: the open picked the lowest level\'s group, with the queues empty');
      lane.dequeueMerge();
      assert.equal(lane.mergePicksWaiting, true);
      const config = (strategy as unknown as { config: { mergeHoldSummaryIds: string[] } }).config;
      config.mergeHoldSummaryIds = ['l0', 'u0'];
      (strategy as unknown as { checkMergeThreshold(): void }).checkMergeThreshold();
      assert.deepEqual([lane.mergeQueue.length, lane.mergePicksWaiting], [0, false], 'nothing queued, and nothing put off');
      config.mergeHoldSummaryIds = [];
      lane.dequeueMerge();
      lane.mergePicksDeferred = true;
      await manager.tick();
      const l0 = (strategy as unknown as { summaries: SummaryEntry[] }).summaries.find((x) => x.id === 'l0');
      assert.ok(l0?.mergedInto, 'tick picked again, and l0 and l1 merged');
      (lane as unknown as { mergePicksDeferred: boolean }).mergePicksDeferred = true;
      lane.clearBranchMirrors();
      assert.equal(lane.mergePicksDeferred, false, 'a cleared branch holds no put-off pick');
    } finally {
      manager.close();
      rmSync(PATH, { recursive: true, force: true });
    }
  });

  it('picks nothing above a merge that keeps failing, and says its picks wait', async () => {
    const PATH = `${STORE}-failing`;
    const refusing = { complete: async () => ({ stopReason: 'refusal', content: [] }) };
    const cfg = { ...config(0), mergeThreshold: 2, mergeHoldSummaryIds: [] };
    const open = async (strategy: AutobiographicalStrategy) => {
      if (existsSync(PATH)) rmSync(PATH, { recursive: true, force: true });
      await twoLevels(PATH, cfg);
      const opened = await ContextManager.open({ path: PATH, strategy, namespace: 'probe', membrane: refusing as never });
      return { manager: opened, lane: strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }>; mergePicksWaiting: boolean } };
    };
    for (const speculativeProduction of [true, false]) {
      const plain = await open(new AutobiographicalStrategy({ ...cfg, speculativeProduction } as never));
      try {
        assert.deepEqual(plain.lane.mergeQueue.map((x) => x.sourceIds), [['l0', 'l1'], ['u0', 'u1']], `speculativeProduction ${speculativeProduction}`);
      } finally { plain.manager.close(); }
      const bottomUp = await open(new Drain({ ...cfg, speculativeProduction } as never));
      try {
        assert.deepEqual(bottomUp.lane.mergeQueue.map((x) => x.sourceIds), [['l0', 'l1']], `speculativeProduction ${speculativeProduction}`);
      } finally { bottomUp.manager.close(); }
    }

    const drained = await open(new Drain(cfg as never));
    const { warn } = console;
    console.warn = () => {};
    try {
      assert.deepEqual(drained.lane.mergeQueue.map((x) => x.sourceIds), [['l0', 'l1']], 'bottom up: the lowest level\'s group alone');
      for (let i = 0; i < 4; i++) await drained.manager.tick();
      assert.deepEqual(drained.lane.mergeQueue.map((x) => x.sourceIds), [['l0', 'l1']], 'nothing above it is picked while it fails');
      assert.equal(drained.lane.mergePicksWaiting, true, 'and its picks say they wait, as a drain ending here reports');
      await drained.manager.tick();
      await drained.manager.tick();
      assert.deepEqual(drained.lane.mergeQueue.map((x) => x.sourceIds), [['u0', 'u1']]);
    } finally {
      console.warn = warn;
      drained.manager.close();
      rmSync(PATH, { recursive: true, force: true });
    }
  });

  it('lets a speculative demand queue a chunk cut over released messages, holding back only the live edge', async () => {
    const m = await rebuilt();
    const strategy = new AutobiographicalStrategy(config(1) as never);
    const manager = await ContextManager.open({ path: STORE, strategy, namespace: 'probe', membrane: membrane as never });
    try {
      const lane = strategy as unknown as {
        chunks: Array<{ index: number; compressed: boolean; messages: Array<{ id: string }> }>;
        compressionQueue: number[];
        enqueueL1ForRange(first: string, last: string, opts?: { speculative?: boolean }): void;
      };
      const over = (at: number) => lane.chunks.find((c) => !c.compressed && c.messages.some((x) => x.id === m[at]))!;
      assert.ok(over(4).index > over(8).index, 'premise: the released chunk is the later record');
      lane.compressionQueue = [];
      lane.enqueueL1ForRange(m[4]!, m[4]!, { speculative: true });
      lane.enqueueL1ForRange(m[8]!, m[8]!, { speculative: true });
      assert.deepEqual(lane.compressionQueue, [over(4).index], 'the live edge is held back, the released chunk is not');
    } finally { manager.close(); }
  });

  it('compresses a chunk cut over released messages under the holdback, which keeps back only the live edge', async () => {
    const m = await rebuilt();
    const drained = await drain(new Drain(config(1) as never), 1);
    try {
      assert.ok(l1Over(drained.summaries, m, 4)?.mergedInto, 'the released chunk compressed and merged, though it is the last record');
      assert.equal(l1Over(drained.summaries, m, 8), undefined, 'the chunk at the live edge is the one kept back');
      assert.equal(drained.pendingChunks, 0);
      assert.deepEqual(drained.stranded, []);
    } finally { drained.close(); }
  });

  it('finishes a drain at a holdback of 2, the debt report leaving out both chunks it keeps back', async () => {
    const m = await rebuilt({ twoAtTheEdge: true });
    const drained = await drain(new Drain(config(2) as never), 2);
    try {
      assert.ok(l1Over(drained.summaries, m, 4), 'the released chunk compressed');
      assert.equal(l1Over(drained.summaries, m, 7), undefined, 'kept back');
      assert.equal(l1Over(drained.summaries, m, 8), undefined, 'kept back');
      assert.equal(drained.pendingChunks, 0);
    } finally { drained.close(); }
  });
});

describe('the runtime and the rebuild planner', () => {
  it('find the same strays in the same state, with a hold, a quarantined pair, a wide summary and a queued merge', () => {
    const ten = (id: string, at: number, parent?: string) => summary(id, at, at + 9, 1, parent);
    const summaries = [
      ...Array.from({ length: 6 }, (_, i) => ten(`a${i}`, i * 10, 'P1')), { ...summary('P1', 0, 59, 2), sourceIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'] },
      ten('lone', 60), ten('held', 70), ten('q0', 80), ten('q1', 90), ten('mid', 100),
      ...Array.from({ length: 6 }, (_, i) => ten(`b${i}`, 110 + i * 10, 'P2')), { ...summary('P2', 110, 169, 2), sourceIds: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'] },
      summary('wide', 170, 189), ten('x', 190), ten('c0', 200), ten('c1', 210),
    ];
    const record = { key: 'qq', level: 2, sourceIds: ['q0', 'q1'], attempts: 3, lastOutcome: 'refusal', quarantinedAt: 1 };
    const queue = [{ level: 2, sourceIds: ['c0', 'c1'] }];
    const config = { mergeHoldSummaryIds: ['held'], mergeMaxSourceSpanMessages: 15 };

    const p = new Probe({ adaptiveResolution: true, autoTickOnNewMessage: false, speculativeProduction: true, ...config });
    p.setChunks(Array.from({ length: 220 }, (_, i) => `m-${i}`));
    p.setSummaries(summaries);
    (p as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine.set('qq', record);
    p.setQueue(queue);
    const runtime = p.getStrandedSummaries().summaries!.map((s) => ({ id: s.id, level: s.level }));

    const planner = strandedInStore({
      summaries: summaries as never, records: [{ id: 'c', sourceIds: Array.from({ length: 220 }, (_, i) => `m-${i}`), compressed: true }],
      messages: Array.from({ length: 220 }, (_, i) => ({ id: `m-${i}` })), mergeQueue: queue, mergeQuarantine: [record],
    }, config);

    assert.deepEqual(runtime, [{ id: 'lone', level: 1 }, { id: 'mid', level: 1 }]);
    assert.deepEqual(planner, runtime);
  });
});

describe('parent pointers, read alike by the runtime and the planner', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ id: `m-${i}` }));
  const records = [{ id: 'c', sourceIds: messages.map((m) => m.id), compressed: true }];

  it('read a stored null parent pointer, in either field, as none', () => {
    for (const field of ['parentId', 'mergedInto'] as const) {
      const summaries = [
        { ...summary('lone', 0, 9), [field]: null } as unknown as SummaryEntry,
        summary('b0', 10, 19, 1, 'P'), summary('b1', 20, 29, 1, 'P'), { ...summary('P', 10, 29, 2), sourceIds: ['b0', 'b1'] },
        summary('n', 30, 39),
      ];
      const p = probe();
      p.setSummaries(summaries);
      const runtime = p.getStrandedSummaries().summaries!.map((s) => s.id);
      const planner = strandedInStore({ summaries: summaries as never, records, messages }).map((s) => s.id);
      assert.deepEqual(runtime, ['lone'], `${field}: null`);
      assert.deepEqual(planner, runtime, `${field}: null`);
    }
  });

  it('the planner reads a summary its parent lists as parented, as the strategy\'s loader settles it, though its own pointer is missing', () => {
    const settled = (lists: string[]) => strandedInStore({
      summaries: [summary('b0', 0, 9), summary('b1', 10, 19, 1, 'P'), { ...summary('P', 0, 19, 2), sourceIds: lists }, summary('n', 20, 29)] as never,
      records, messages,
    }).map((s) => s.id);
    assert.deepEqual(settled(['b0', 'b1']), [], 'P lists b0, so it is its parent');
    assert.deepEqual(settled(['b1']), ['b0'], 'control: listed by nothing and pointing nowhere, b0 stands alone');
  });
});

describe('which summaries a merge-quarantine record holds out of merges', () => {
  it("holds its group only where the strategy's own merge test, a subclass's override included, would take it", () => {
    class Refusing extends Probe {
      protected override mergeTopologyProblem(): string | null { return 'refused (test)'; }
    }
    const held = (p: Probe): string[] => {
      p.setSummaries([summary('a', 0, 9, 1, 'P'), summary('q0', 10, 19), summary('q1', 20, 29), summary('n', 40, 49)]);
      p.quarantineGroup('qq', ['q0', 'q1']);
      return [...(p as unknown as { mergeHeldSourceIds(): Set<string> }).mergeHeldSourceIds()].sort();
    };
    assert.deepEqual(held(probe()), ['q0', 'q1']);
    const refusing = new Refusing({ adaptiveResolution: true, autoTickOnNewMessage: false });
    refusing.setChunks(Array.from({ length: 100 }, (_, i) => `m-${i}`));
    assert.deepEqual(held(refusing), [], 'a group the override refuses could not be retried as it stands, so it holds nothing');
  });
});

describe('demands (a picker\'s produce requests)', () => {
  function warnings(act: () => void): string[] {
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
    try { act(); } finally { console.warn = warn; }
    return said.filter((line) => line.includes('demand L'));
  }

  it('queue nothing for a request over a summary that stands alone, as a greedy solver asks when nothing can rise, and say nothing', () => {
    const p = probe();
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([...under('a', 0, 'P'), summary('lone', 60, 69), ...under('b', 70, 'Q'), summary('n', 130, 139)]);
    assert.deepEqual(warnings(() => p.produce(2, 'm-60', 'm-69')), []);
    assert.deepEqual(p.queued(), []);
  });

  it('warn, queuing nothing, when two or more sources reach into the range and no two are adjacent', () => {
    const p = probe();
    p.setSummaries([summary('l0', 60, 69), summary('l1', 71, 80), summary('z', 81, 90, 1, 'P'), summary('n', 200, 209)]);
    const said = warnings(() => p.produce(2, 'm-60', 'm-80'));
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0]!, /demand L2 merge over 2 source\(s\) in m-60\.\.m-80 has no contiguous pair; nothing enqueued/);
    assert.deepEqual(p.queued(), []);
  });

  it('queue the group holding a source in the range: four of an interior seven, never six', () => {
    const p = probe();
    p.setSummaries([...run('i', 7, 0), ...run('n', 3, 1000)]);
    p.produce(2, 'm-0', 'm-59');
    assert.deepEqual(p.queued(), [['i0', 'i1', 'i2', 'i3']]);
  });

  it("queue the group holding the one summary a request names by its own range (#338)", () => {
    const p = probe();
    p.setSummaries([...run('i', 7, 0), ...run('n', 3, 1000)]);
    p.produce(2, 'm-50', 'm-59');
    assert.deepEqual(p.queued(), [['i4', 'i5', 'i6']], "i5's group, past the range on both sides");
  });

  it('take the largest group that holds a source in the range', () => {
    const p = probe({ mergeHoldSummaryIds: ['h2'] });
    p.setSummaries(run('h', 9, 0));
    p.produce(2, 'm-0', 'm-89');
    assert.deepEqual(p.queued(), [['h3', 'h4', 'h5', 'h6', 'h7', 'h8']], 'the newest run past the hold, over the interior pair before it');
  });

  it("take the newest run's groups of the threshold from its oldest end, and its shorter rest as a last group", () => {
    const p = probe();
    p.setSummaries(run('n', 8, 0));
    p.produce(2, 'm-70', 'm-79');
    assert.deepEqual(p.queued(), [['n6', 'n7']]);
    p.setQueue([]);
    p.produce(2, 'm-0', 'm-9');
    assert.deepEqual(p.queued(), [['n0', 'n1', 'n2', 'n3', 'n4', 'n5']]);
  });

  it('queue a newest run shorter than the threshold whole, as a growing run\'s rest', () => {
    const p = probe();
    p.setSummaries(run('n', 3, 0));
    p.produce(2, 'm-0', 'm-9');
    assert.deepEqual(p.queued(), [['n0', 'n1', 'n2']]);
  });

});

describe('the stray list, getStrandedSummaries()', () => {
  function strays(extra: Record<string, unknown> = {}) {
    const p = probe({ speculativeProduction: true, ...extra });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2),
      summary('lone', 60, 69),
      ...under('b', 70, 'P2'), summary('P2', 70, 129, 2),
      summary('newest', 130, 139),
    ]);
    return p;
  }

  it('lists each summary that is alone in a run that is neither the newest nor waiting, with nothing beside it', () => {
    const debt = strays().getStrandedSummaries();
    assert.deepEqual(debt.summaries, [
      { id: 'lone', level: 1, tokens: 100, beside: [] },
      { id: 'P1', level: 2, tokens: 100, beside: [] },
    ]);
    assert.equal(debt.tokens, 200);
  });

  it('lists the sources of a stored queued merge that can no longer run, as an audit-only open leaves the queue as stored', () => {
    const p = strays();
    p.setQueue([{ level: 2, sourceIds: ['lone', 'newest'] }]);
    assert.deepEqual(p.getStrandedSummaries().summaries?.map((x) => x.id), ['lone', 'P1']);
  });

  it('lists the sources of a stored queued merge with a held source, which is dropped at its turn', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['q'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2), summary('lone', 60, 69), summary('q', 70, 79),
      ...under('b', 80, 'P2'), summary('P2', 80, 139, 2), summary('newest', 140, 149),
    ]);
    p.setQueue([{ level: 2, sourceIds: ['lone', 'q'] }]);
    assert.deepEqual(p.getStrandedSummaries().summaries?.map((x) => x.id), ['lone', 'P1']);
  });

  it('names an operator hold beside a stray', () => {
    const debt = strays({ mergeHoldSummaryIds: ['lone'] }).getStrandedSummaries();
    assert.deepEqual(debt.summaries, [{ id: 'P1', level: 2, tokens: 100, beside: [{ kind: 'hold', id: 'lone', side: 'after', level: 1 }] }]);
  });

  it('names a hole past the lower-level summaries between it and the stray', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['held'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2),
      summary('lone', 60, 69), summary('held', 70, 79),
      ...under('b', 80, 'P2'), summary('P2', 80, 139, 2),
      summary('newest', 140, 149),
    ]);
    assert.deepEqual(p.getStrandedSummaries().summaries, [
      { id: 'lone', level: 1, tokens: 100, beside: [{ kind: 'hold', id: 'held', side: 'after', level: 1 }] },
      { id: 'P1', level: 2, tokens: 100, beside: [{ kind: 'hold', id: 'held', side: 'after', level: 1 }] },
    ]);
  });

  it('names no hole for a held summary with no level, which no run takes and the walk stops at', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['nolevel'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    const nolevel = { ...summary('nolevel', 60, 69) } as Partial<SummaryEntry>;
    delete nolevel.level;
    p.setSummaries([
      summary('lone', 50, 59), nolevel as SummaryEntry,
      ...under('b', 70, 'P2'), summary('P2', 70, 129, 2), summary('newest', 130, 139),
    ]);
    assert.deepEqual(p.getStrandedSummaries().summaries?.find((x) => x.id === 'lone')?.beside, []);
  });

  it('lists strays by the runtime\'s reading of the newest run in a strategy that lands as planned too', () => {
    class DrainProbe extends Probe { protected override landsAsPlanned(): boolean { return true; } }
    const p = new DrainProbe({ adaptiveResolution: true, autoTickOnNewMessage: false, speculativeProduction: true });
    p.setChunks(Array.from({ length: 200 }, (_, i) => `m-${i}`));
    p.setSummaries([summary('x', 0, 9), summary('a0', 10, 19, 1, 'P'), summary('a1', 20, 29, 1, 'P'), summary('P', 10, 29, 2), summary('Q', 30, 39, 2)]);
    assert.deepEqual(p.getStrandedSummaries().summaries?.map((s) => s.id).filter((id) => id === 'x'), []);
    const input = (p as unknown as { mergeRunsInput(): Parameters<typeof runsAtLevel>[0] }).mergeRunsInput();
    assert.ok(strandedIn(runsAtLevel(input, 1).runs).some((x) => (x.s as SummaryEntry).id === 'x'), 'control');
  });

  it('clears a put-off pick when a load finds no store', () => {
    const p = new Probe({ adaptiveResolution: true, autoTickOnNewMessage: false });
    const internals = p as unknown as { mergePicksDeferred: boolean; store: unknown; loadPersistedState(): void };
    internals.mergePicksDeferred = true;
    internals.store = undefined;
    internals.loadPersistedState();
    assert.equal(internals.mergePicksDeferred, false);
  });

  it('ends the walk to a hole at a summary with no level, which no merge takes', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['held'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    const nolevel = { ...summary('nolevel', 60, 69) } as Partial<SummaryEntry>;
    delete nolevel.level;
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2),
      nolevel as SummaryEntry, summary('held', 70, 79),
      ...under('b', 80, 'P2'), summary('P2', 80, 139, 2),
      ...under('c', 141, 'P3'), summary('P3', 141, 200, 2),
      summary('newest', 201, 210),
    ]);
    const strays = p.getStrandedSummaries().summaries!;
    assert.deepEqual(strays.find((x) => x.id === 'P1')?.beside, []);
    assert.deepEqual(strays.find((x) => x.id === 'P2')?.beside, [{ kind: 'hold', id: 'held', side: 'before', level: 1 }], 'premise: the hold is named beside what stands next to it');
  });

  it('names a hole past the lower-level summaries before a stray, walking back', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['held'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2),
      summary('held', 60, 69), summary('lone', 70, 79),
      ...under('b', 80, 'P2'), summary('P2', 80, 139, 2),
      ...under('c', 141, 'P3'), summary('P3', 141, 200, 2),
      summary('newest', 201, 210),
    ]);
    const strays = p.getStrandedSummaries().summaries!;
    assert.deepEqual(strays.find((x) => x.id === 'P2')?.beside, [{ kind: 'hold', id: 'held', side: 'before', level: 1 }]);
    assert.deepEqual(strays.find((x) => x.id === 'lone')?.beside, [{ kind: 'hold', id: 'held', side: 'before', level: 1 }]);
  });

  it('reads the quarantine ledger afresh on each read', () => {
    const p = besideChunk();
    assert.equal(p.getStrandedSummaries().summaries!.find((x) => x.id === 'lone')?.beside.length, 1, 'premise: the quarantined chunk is named');
    (p as unknown as { readCompressionQuarantineProjection(): unknown }).readCompressionQuarantineProjection = () => new Map();
    assert.deepEqual(p.getStrandedSummaries().summaries!.find((x) => x.id === 'lone')?.beside, [], 'cleared since, it is named no more');
  });

  function besideChunk(quarantined = true) {
    const p = probe({ speculativeProduction: true });
    p.setChunkList([{ from: 0, to: 69, compressed: true }, { from: 70, to: 79, compressed: false }, { from: 80, to: 149, compressed: true }]);
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2), summary('lone', 60, 69),
      ...under('b', 80, 'P2'), summary('P2', 80, 139, 2), summary('newest', 140, 149),
    ]);
    const hole = createHash('sha256').update(JSON.stringify(Array.from({ length: 10 }, (_, i) => `m-${70 + i}`)), 'utf8').digest('hex');
    const self = p as unknown as { store: unknown; readCompressionQuarantineProjection(): unknown };
    self.store ??= {};
    self.readCompressionQuarantineProjection = () => new Map(quarantined ? [['k-hole', { record: { chunkSourceHash: hole } }]] : []);
    return p;
  }

  it('names a quarantined chunk beside a stray from the live chunks, with no chunk records', () => {
    assert.deepEqual(besideChunk().getStrandedSummaries().summaries, [
      { id: 'lone', level: 1, tokens: 100, beside: [{ kind: 'compression-quarantine', id: 'k-hole', side: 'after', level: 0 }] },
      { id: 'P1', level: 2, tokens: 100, beside: [{ kind: 'compression-quarantine', id: 'k-hole', side: 'after', level: 0 }] },
    ]);
  });

  it('names the merge-quarantine record that holds a source, and no hold on a summary that has a parent', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['b0'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2), summary('lone', 60, 69), summary('q0', 70, 79), summary('q1', 80, 89),
      summary('mid', 90, 99), ...under('b', 100, 'P2'), summary('P2', 100, 159, 2), summary('newest', 160, 169),
    ]);
    const quarantine = (p as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
    quarantine.set('stale', { key: 'stale', level: 2, sourceIds: ['q0', 'q1'], attempts: 1, lastOutcome: 'topology_violation', quarantinedAt: 1 });
    quarantine.set('live', { key: 'live', level: 2, sourceIds: ['q0', 'q1'], attempts: 3, lastOutcome: 'refusal', quarantinedAt: 2 });
    const debt = p.getStrandedSummaries();
    assert.deepEqual(debt.summaries?.find((x) => x.id === 'lone'), { id: 'lone', level: 1, tokens: 100, beside: [{ kind: 'merge-quarantine', id: 'live', side: 'after', level: 1 }] },
      'the record that holds q0, not the first that names it');
    assert.deepEqual(debt.summaries?.find((x) => x.id === 'mid')?.beside, [{ kind: 'merge-quarantine', id: 'live', side: 'before', level: 1 }],
      'b0, on its right, is held but has a parent, so it parts nothing at its level');
  });

  it('names every merge-quarantine record that holds the summary beside a stray, as overlapping records an older version wrote do', () => {
    const p = probe({ speculativeProduction: true });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2), summary('h1', 60, 69), summary('h2', 70, 79), summary('h3', 80, 89),
      ...under('b', 90, 'P2'), summary('P2', 90, 149, 2), summary('newest', 150, 159),
    ]);
    p.quarantineGroup('pair', ['h1', 'h2']);
    p.quarantineGroup('three', ['h1', 'h2', 'h3']);
    assert.deepEqual(p.getStrandedSummaries().summaries?.find((x) => x.id === 'P1')?.beside, [
      { kind: 'merge-quarantine', id: 'pair', side: 'after', level: 1 }, { kind: 'merge-quarantine', id: 'three', side: 'after', level: 1 },
    ], 'clearing one leaves the other holding h1');
  });

  it('names a hold beside a stray only at the stray\'s level or below', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['H'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2), summary('lone', 60, 69),
      ...under('b', 70, 'H'), summary('H', 70, 129, 2), summary('newest', 130, 139),
    ]);
    assert.deepEqual(p.getStrandedSummaries().summaries, [
      { id: 'lone', level: 1, tokens: 100, beside: [] },
      { id: 'P1', level: 2, tokens: 100, beside: [{ kind: 'hold', id: 'H', side: 'after', level: 2 }] },
    ], 'beside lone stand H\'s L1s, which have a parent; lifting the hold on H wouldn\'t let lone merge');
  });

  it('reads a held summary with no source range as no hole, and still lists the strays', () => {
    const p = strays({ mergeHoldSummaryIds: ['broken'] });
    const self = p as unknown as { summaries: SummaryEntry[] };
    self.summaries = [...self.summaries, { id: 'broken', level: 1, content: 'x', tokens: 1, sourceLevel: 0, sourceIds: [], created: 1 } as unknown as SummaryEntry];
    const debt = p.getStrandedSummaries();
    assert.equal('error' in debt, false, 'the read succeeds');
    assert.deepEqual(debt.summaries?.map((x) => x.id), ['lone', 'P1']);
  });

  it('returns no list and says why when the read fails, and never throws', () => {
    const p = strays();
    (p as unknown as { mergePositionIndex(): never }).mergePositionIndex = () => { throw new Error('index broke (test)'); };
    const stranded = p.getStrandedSummaries();
    assert.equal(stranded.summaries, null);
    assert.equal(stranded.tokens, null);
    const error = 'error' in stranded ? stranded.error : '';
    assert.match(error, /^The stranded-summaries read failed\./);
    assert.match(error, /index broke \(test\)/);
  });

  it('returns no list when the quarantine ledger can\'t be read, or no store is open, since it can\'t name what stands beside a stray', () => {
    const p = strays();
    (p as unknown as { readCompressionQuarantineProjection(): never }).readCompressionQuarantineProjection = () => { throw new Error('ledger unreadable (test)'); };
    const unread = p.getStrandedSummaries();
    assert.equal(unread.summaries, null);
    assert.match('error' in unread ? unread.error : '', /couldn't read this agent's compression quarantine ledger \(ledger unreadable \(test\)\)/);
    const q = strays();
    (q as unknown as { readCompressionQuarantineProjection(): unknown }).readCompressionQuarantineProjection = () => new Map();
    (q as unknown as { store: unknown }).store = undefined;
    const closed = q.getStrandedSummaries();
    assert.equal(closed.summaries, null);
    assert.match('error' in closed ? closed.error : '', /no store is open/);
  });

  it('names both what holds a summary beside a stray when the operator holds it and a quarantined merge holds it too', () => {
    const p = probe({ speculativeProduction: true, mergeHoldSummaryIds: ['h1'] });
    const under = (prefix: string, from: number, parent: string) =>
      Array.from({ length: 6 }, (_, i) => summary(`${prefix}${i}`, from + i * 10, from + i * 10 + 9, 1, parent));
    p.setSummaries([
      ...under('a', 0, 'P1'), summary('P1', 0, 59, 2), summary('h1', 60, 69), summary('h2', 70, 79),
      ...under('b', 80, 'P2'), summary('P2', 80, 139, 2), summary('newest', 140, 149),
    ]);
    p.quarantineGroup('rec', ['h1', 'h2']);
    assert.deepEqual(p.getStrandedSummaries().summaries, [
      { id: 'P1', level: 2, tokens: 100, beside: [{ kind: 'hold', id: 'h1', side: 'after', level: 1 }, { kind: 'merge-quarantine', id: 'rec', side: 'after', level: 1 }] },
    ], 'each must lift before P1 could merge there');
  });

  it('lists nothing in a store whose runs can all merge', () => {
    const p = probe({ speculativeProduction: true });
    p.setSummaries([...run('i', 3, 0), ...run('n', 2, 1000)]);
    const debt = p.getStrandedSummaries();
    assert.deepEqual(debt.summaries, []);
    assert.equal(debt.tokens, 0);
  });

  it('reads only the levels the merge check reads, L1 and L2 without speculative production', () => {
    const layout = [summary('L3a', 0, 59, 3), summary('L2a', 60, 69, 2), summary('L3b', 70, 129, 3), summary('L2b', 130, 139, 2)];
    const without = probe({ speculativeProduction: false });
    without.setSummaries(layout);
    assert.deepEqual(without.getStrandedSummaries().summaries?.map((s) => s.id), ['L2a'], 'L3s never merge there, so none is stranded');
    const speculative = probe({ speculativeProduction: true });
    speculative.setSummaries(layout);
    assert.deepEqual(speculative.getStrandedSummaries().summaries?.map((s) => s.id), ['L2a', 'L3a'], 'L3s merge under speculative production');
  });
});

describe('a stray beside a refused chunk, in a live store', () => {
  const STORE = './test-interior-merge-runs-store';
  const wipe = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
  after(wipe);

  let calls = 0;
  const accepting = {
    complete: async () => {
      calls++;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `summary ${calls}: ` + Array.from({ length: 6 + (calls % 9) }, (_, i) => `w${calls}x${i}`).join(' ') }] };
    },
  };
  const refusing = {
    complete: async () => ({ content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }),
  };
  class Lane extends AutobiographicalStrategy {
    get all(): readonly SummaryEntry[] { return this.summaries; }
    closedChunks(): Chunk[] { return this.chunks; }
    refuse(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, { ...ctx, membrane: refusing as never }); }
  }
  async function quietly<T>(body: () => Promise<T>): Promise<T> {
    const { warn, error } = console;
    console.warn = () => {};
    console.error = () => {};
    try { return await body(); } finally { console.warn = warn; console.error = error; }
  }

  it('names the quarantine record beside it, and lists it no more once the chunk compresses and it merges', async () => {
    wipe();
    calls = 0;
    const strategy = new Lane({
      adaptiveResolution: true, speculativeProduction: true, mergeThreshold: 3, headWindowTokens: 0, recentWindowTokens: 200,
      targetChunkTokens: 60, l1HoldbackChunks: 0, autoTickOnNewMessage: false, compressionModel: 'mock', minChunkCharsForLLM: 0,
      compressionRefusalCurveFallbacks: 0,
    } as never);
    const manager = await ContextManager.open({ path: STORE, strategy, membrane: accepting as never });
    try {
      let next = 0;
      const add = (n: number) => { for (let i = 0; i < n; i++, next++) manager.addMessage(next % 2 ? 'Claude' : 'User', [{ type: 'text', text: `m-${next} hello world, and a few more words to give it weight` }]); };
      const grow = async (batches: number) => quietly(async () => { for (let b = 0; b < batches; b++) { add(5); for (let t = 0; t < 6; t++) await manager.tick(); } });
      const unparentedL1 = () => strategy.all.filter((s) => s.level === 1 && !s.mergedInto);
      for (let guard = 0; guard < 100 && !(strategy.all.filter((s) => s.level === 1).length >= 4 && unparentedL1().length === 1); guard++) await grow(1);
      const stray = unparentedL1()[0]!;
      assert.equal(unparentedL1().length, 1, 'premise: one L1 after the last merge');
      let hole: Chunk | undefined;
      for (let guard = 0; guard < 20 && !hole; guard++) {
        add(1);
        await quietly(() => manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }));
        hole = strategy.closedChunks().find((c) => !c.compressed);
      }
      assert.ok(hole, 'premise: a closed chunk to refuse');
      const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
      await quietly(() => strategy.refuse(hole!, ctx));
      const [key] = strategy.getCompressionQuarantineStatus().keys;
      assert.ok(key, 'premise: the chunk is quarantined');
      await grow(20);
      for (let guard = 0; guard < 20 && unparentedL1().length < 2; guard++) await grow(1);
      assert.ok(unparentedL1().length >= 2, 'premise: a newer L1 stands unmerged, so the stray\'s run is no longer the newest');
      assert.equal(stray.mergedInto, undefined, 'premise: the L1 before the hole stays unparented');
      const before = strategy.getStrandedSummaries().summaries!;
      assert.deepEqual(before.find((s) => s.id === stray.id)?.beside, [{ kind: 'compression-quarantine', id: key, side: 'after', level: 0 }]);
      await quietly(() => strategy.clearCompressionRefusalQuarantine(key));
      for (let guard = 0; guard < 10 && !stray.mergedInto; guard++) await grow(1);
      assert.ok(stray.mergedInto, 'the stray merges once the chunk beside it compresses');
      const after = strategy.getStrandedSummaries().summaries!;
      assert.ok(!after.some((s) => s.id === stray.id), 'it is listed no more');
      assert.ok(!after.some((s) => s.beside.some((b) => b.id === key)), 'nothing is listed beside the cleared record');
    } finally {
      manager.close();
    }
  });
});
