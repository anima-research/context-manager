/**
 * `carryStrandedSummaries`: a summary no merge can take is carried up a
 * level, unchanged and with no model call, until it stands beside summaries
 * it can merge with.
 *
 * A fixture's frontier is a row of towers laid end to end: each a summary of
 * its level over its own messages, whole down to its L1s, so every summary
 * is the one form of every message in its span, as in a store that passes
 * the topology audit. The rule reads that (a carry is refused to a summary
 * with another's messages inside its span), so a fixture with dangling
 * sources would show nothing.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextManager } from '../src/index.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/strategy.js';
import { planTopologyRepair, strandedInStore, type RepairRecord, type RepairSummary } from '../src/repair/topology.js';
import type { LadderStep } from '../src/strategies/merge-runs.js';
import { main as inspectStore } from '../scripts/inspect-store-main.js';

type Slot = [id: string, level: number, width: number];

/** A summary of `level` over messages first..last, with every summary under it: each level halves its span. */
function tower(id: string, level: number, first: number, last: number, at: (i: number) => string, parent?: string): SummaryEntry[] {
  const own = {
    id, level, content: `memory ${id}`, tokens: 100, created: 1,
    sourceRange: { first: at(first), last: at(last) }, ...(parent ? { mergedInto: parent } : {}),
  };
  if (level === 1) {
    return [{ ...own, sourceLevel: 0, sourceIds: Array.from({ length: last - first + 1 }, (_, i) => at(first + i)) } as SummaryEntry];
  }
  const cut = first + Math.ceil((last - first + 1) / 2);
  return [
    ...tower(`${id}/0`, level - 1, first, cut - 1, at, id),
    ...tower(`${id}/1`, level - 1, cut, last, at, id),
    { ...own, sourceLevel: level - 1, sourceIds: [`${id}/0`, `${id}/1`] } as SummaryEntry,
  ];
}

/** Towers end to end from the first message, and where each stands. A slot of level 0 is a gap no summary covers. */
function frontier(slots: readonly Slot[], at: (i: number) => string = (i) => `m-${i}`) {
  const summaries: SummaryEntry[] = [];
  const span = new Map<string, [number, number]>();
  let next = 0;
  for (const [id, level, width] of slots) {
    span.set(id, [next, next + width - 1]);
    if (level > 0) summaries.push(...tower(id, level, next, next + width - 1, at));
    next += width;
  }
  return { summaries, span, messages: next };
}

/**
 * The frontier most tests read: an L3 between two L5s, with a later run at
 * each level it climbs through, so none of its runs is its level's last (the
 * newest, which waits to grow). X parts the L5 run from the later one.
 */
const RAGGED: Slot[] = [['P', 6, 32], ['A', 5, 16], ['s', 3, 4], ['B', 5, 16], ['X', 6, 32], ['n5', 5, 16], ['n4', 4, 8], ['n3', 3, 4]];
/** The same before two messages no summary covers yet, which a compile sends raw as the newest turn. */
const RAGGED_LIVE: Slot[] = [...RAGGED, ['tail', 0, 2]];

class Probe extends AutobiographicalStrategy {
  constructor(config: Record<string, unknown> = {}) {
    super({ adaptiveResolution: true, hierarchical: true, speculativeProduction: true, autoTickOnNewMessage: false, ...config } as never);
    (this as unknown as { requireBranchMutation: () => void }).requireBranchMutation = () => {};
    (this as unknown as { requireLoadedBranch: () => void }).requireLoadedBranch = () => {};
    (this as unknown as { store: unknown }).store = {
      getStateJson: () => null, setStateJson: () => {}, appendToStateJson: () => {}, editStateItem: () => {}, currentBranch: () => ({ name: 'main' }),
    };
  }
  /** One compressed chunk over every message, or the chunks given. */
  lay(slots: readonly Slot[], chunks?: Array<{ from: number; to: number; compressed: boolean }>): this {
    const laid = frontier(slots);
    (this as unknown as { chunks: unknown[] }).chunks = (chunks ?? [{ from: 0, to: laid.messages - 1, compressed: true }]).map(({ from, to, compressed }) => ({
      messages: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `m-${from + i}` })), compressed,
    }));
    (this as unknown as { summaries: SummaryEntry[] }).summaries = laid.summaries;
    return this;
  }
  check(): void { this.checkMergeThreshold(); }
  get all(): SummaryEntry[] { return (this as unknown as { summaries: SummaryEntry[] }).summaries; }
  get(id: string): SummaryEntry { return this.all.find((s) => s.id === id)!; }
  queued(): Array<{ level: number; sourceIds: string[] }> {
    return (this as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[] }> }).mergeQueue.map(({ level, sourceIds }) => ({ level, sourceIds }));
  }
  /** The entries carried from `id`, lowest first. */
  carriedFrom(id: string): SummaryEntry[] {
    const chain: SummaryEntry[] = [];
    for (let from = id, next = this.all.find((s) => s.carriedFrom === from); next; next = this.all.find((s) => s.carriedFrom === from)) {
      chain.push(next);
      from = next.id;
    }
    return chain;
  }
  quarantineChunk(from: number, to: number): void {
    const hash = createHash('sha256').update(JSON.stringify(Array.from({ length: to - from + 1 }, (_, i) => `m-${from + i}`)), 'utf8').digest('hex');
    (this as unknown as { readCompressionQuarantineProjection(): unknown }).readCompressionQuarantineProjection =
      () => new Map([['k-hole', { record: { chunkSourceHash: hash } }]]);
  }
  holdGroup(sourceIds: string[], level: number): void {
    (this as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine
      .set('qq', { key: 'qq', level, sourceIds, attempts: 3, lastOutcome: 'refusal', quarantinedAt: 1 });
  }
}

/** Quiet: the merge check warns once for each summary it leaves out as too wide. */
function quietly<T>(act: () => T): T {
  const { warn } = console;
  console.warn = () => {};
  try { return act(); } finally { console.warn = warn; }
}

describe('the carry rule, in the merge check', () => {
  it('carries an L3 between two L5s to L4 and then L5, where it joins their run and the run is queued as any run is', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(RAGGED);
    const before = p.all.length;
    p.check();
    const [c4, c5, ...more] = p.carriedFrom('s');
    assert.deepEqual(more, [], 'it stops at the level of the summaries beside it');
    assert.deepEqual([c4!.level, c4!.sourceLevel, c4!.sourceIds, c4!.carriedFrom], [4, 3, ['s'], 's']);
    assert.deepEqual([c5!.level, c5!.sourceLevel, c5!.sourceIds, c5!.carriedFrom], [5, 4, [c4!.id], c4!.id]);
    assert.deepEqual([p.get('s').mergedInto, c4!.mergedInto, c5!.mergedInto], [c4!.id, c5!.id, undefined], 'each source is marked merged into what carries it');
    assert.equal(p.all.length, before + 2, 'two entries, and nothing else');
    assert.deepEqual(p.queued(), [{ level: 6, sourceIds: ['A', c5!.id, 'B'] }], 'the L5 run is queued, the carried entry in its place');

    p.check();
    assert.equal(p.all.length, before + 2, 'a second check carries nothing again');
    assert.deepEqual(p.queued(), [{ level: 6, sourceIds: ['A', c5!.id, 'B'] }]);
  });

  it('writes the carried entry as the same memory: text, response blocks, tokens, range, date and authoring request', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(RAGGED);
    const responseContent = [
      { type: 'thinking', thinking: 'what I weighed', signature: 'sig-1' },
      { type: 'text', text: 'memory s' },
    ];
    Object.assign(p.get('s'), {
      tokens: 77, created: 123, witnessed: true, responseContent,
      provenance: { stopReason: 'end_turn', requestHash: 'h-s', model: 'mock' },
    });
    p.check();
    assert.deepEqual(p.carriedFrom('s').map((c) => c.level), [4, 5], 'premise: it is carried, so the loop below reads two entries');
    for (const carried of p.carriedFrom('s')) {
      assert.equal(carried.content, 'memory s');
      assert.deepEqual(carried.responseContent, responseContent);
      assert.deepEqual([carried.tokens, carried.created, carried.witnessed], [77, 123, true]);
      assert.deepEqual(carried.sourceRange, p.get('s').sourceRange);
      assert.deepEqual(carried.provenance, { stopReason: 'end_turn', requestHash: 'h-s', model: 'mock' });
      assert.equal(carried.parentId, undefined);
    }
    assert.equal(p.getCompressionDebt().lastMintAt, 123, 'a carry is no mint: the last mint is the source\'s own');
  });

  it('leaves the store as it is with the option off, and the summary stays listed as stranded', () => {
    const p = new Probe().lay(RAGGED);
    const before = structuredClone(p.all);
    p.check();
    assert.deepEqual(p.all, before);
    assert.deepEqual(p.queued(), []);
    assert.deepEqual(p.getStrandedSummaries().summaries, [
      { id: 's', level: 3, tokens: 100, beside: [] },
      { id: 'A', level: 5, tokens: 100, beside: [] },
      { id: 'B', level: 5, tokens: 100, beside: [] },
      { id: 'P', level: 6, tokens: 100, beside: [] },
    ]);
  });

  it('no longer lists a summary the next check carries, with the option on, and still lists one it won\'t', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(RAGGED);
    assert.deepEqual(p.getStrandedSummaries().summaries?.map((x) => x.id), ['P'], 's is carried, and A and B merge with what it becomes; P has no higher summary beside it');
    p.check();
    assert.deepEqual(p.getStrandedSummaries().summaries?.map((x) => x.id), ['P'], 'A and B are queued with what s became; P has no partner yet');
  });

  it('doesn\'t carry a summary in its level\'s newest run, at the live edge or with nothing of its level after it', () => {
    const edge = new Probe({ carryStrandedSummaries: true }).lay([['A', 5, 16], ['s', 3, 4]]);
    edge.check();
    assert.deepEqual(edge.carriedFrom('s'), []);

    const last = new Probe({ carryStrandedSummaries: true }).lay([['A', 5, 16], ['s', 3, 4], ['B', 5, 16]]);
    last.check();
    assert.deepEqual(last.carriedFrom('s'), [], 'the last run of its level reads as the newest, which waits to grow');

    const later = new Probe({ carryStrandedSummaries: true }).lay([['A', 5, 16], ['s', 3, 4], ['B', 5, 16], ['n4', 4, 8], ['n3', 3, 4]]);
    later.check();
    assert.deepEqual(later.carriedFrom('s').map((c) => c.level), [4, 5], 'control: with a later run at L3 and at L4, it is carried');
  });

  it('carries the same summary under a drain, which reads a run with a higher summary after it as one that can\'t grow', () => {
    class DrainProbe extends Probe { protected override landsAsPlanned(): boolean { return true; } }
    const p = new DrainProbe({ carryStrandedSummaries: true }).lay([['A', 5, 16], ['s', 3, 4], ['B', 5, 16]]);
    p.check();
    assert.deepEqual(p.carriedFrom('s').map((c) => c.level), [4, 5]);
  });

  it('doesn\'t carry a summary beside a quarantined chunk, whose L1 could still land there', () => {
    const slots: Slot[] = [['A', 5, 16], ['s', 3, 4], ['hole', 0, 4], ['B', 5, 16], ['n4', 4, 8], ['n3', 3, 4]];
    const chunks = [{ from: 0, to: 19, compressed: true }, { from: 20, to: 23, compressed: false }, { from: 24, to: 51, compressed: true }];
    const p = new Probe({ carryStrandedSummaries: true }).lay(slots, chunks);
    p.quarantineChunk(20, 23);
    p.check();
    assert.deepEqual(p.carriedFrom('s'), []);
    assert.deepEqual(p.getStrandedSummaries().summaries?.find((x) => x.id === 's')?.beside, [{ kind: 'compression-quarantine', id: 'k-hole', side: 'after', level: 0 }]);

    const open = new Probe({ carryStrandedSummaries: true }).lay(slots, chunks);
    open.check();
    assert.deepEqual(open.carriedFrom('s').map((c) => c.level), [4, 5], 'control: a chunk that only waits its turn is no hole, as for the merges beside it');
  });

  it('doesn\'t carry a summary beside an operator hold or a quarantined merge\'s sources', () => {
    const slots: Slot[] = [['A', 5, 16], ['s', 3, 4], ['h', 3, 4], ['B', 5, 16], ['n4', 4, 8], ['n3', 3, 4]];
    const held = new Probe({ carryStrandedSummaries: true, mergeHoldSummaryIds: ['h'] }).lay(slots);
    held.check();
    assert.deepEqual(held.carriedFrom('s'), []);
    assert.deepEqual(held.carriedFrom('h'), [], 'nor is the held summary itself');
    assert.deepEqual(held.getStrandedSummaries().summaries?.find((x) => x.id === 's')?.beside, [{ kind: 'hold', id: 'h', side: 'after', level: 3 }]);

    const pair: Slot[] = [['A', 5, 16], ['s', 3, 4], ['q0', 3, 4], ['q1', 3, 4], ['B', 5, 16], ['n4', 4, 8], ['n3', 3, 4]];
    const quarantined = new Probe({ carryStrandedSummaries: true }).lay(pair);
    quarantined.holdGroup(['q0', 'q1'], 4);
    quarantined.check();
    assert.deepEqual(quarantined.carriedFrom('s'), []);
    assert.deepEqual(quarantined.getStrandedSummaries().summaries?.find((x) => x.id === 's')?.beside, [{ kind: 'merge-quarantine', id: 'qq', side: 'after', level: 3 }]);
  });

  it('doesn\'t carry a summary whose neighbours are all of a lower level', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(
      [['a0', 2, 2], ['a1', 2, 2], ['s', 3, 4], ['b0', 2, 2], ['b1', 2, 2], ['n3', 3, 4], ['n2', 2, 2]],
    );
    assert.equal(p.getStrandedSummaries().summaries?.some((x) => x.id === 's'), true, 'premise: it is stranded');
    p.check();
    assert.deepEqual(p.all.filter((x) => x.carriedFrom !== undefined), []);
    assert.deepEqual(p.queued()[0], { level: 3, sourceIds: ['a0', 'a1'] }, 'the pair below it merges as it would have');
  });

  it('carries the lowest level first, so a lower summary carried beside it gives it a partner and a model writes their merge', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(
      [['A', 5, 16], ['s', 3, 4], ['t', 2, 2], ['B', 5, 16], ['n4', 4, 8], ['n3', 3, 4], ['n2', 2, 2]],
    );
    p.check();
    const [t3, ...more] = p.carriedFrom('t');
    assert.deepEqual([t3!.level, more], [3, []], 't is carried once, to the level of s');
    assert.deepEqual(p.carriedFrom('s'), [], 's is not carried: it has a partner now');
    assert.deepEqual(p.queued(), [{ level: 4, sourceIds: ['s', t3!.id] }]);
  });

  it('never carries a summary with another\'s messages inside its span, or a superseded L1 generation', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(RAGGED);
    // s's range reaches over B's first messages, which B's own L1s hold.
    p.get('s').sourceRange = { first: 'm-48', last: 'm-53' };
    p.check();
    assert.deepEqual(p.carriedFrom('s'), []);

    // s2 is a later L1 over s's two messages, and `owner` the L1 their chunk record names.
    const generations = (owner: 's' | 's2'): Probe => {
      const laid = new Probe({ carryStrandedSummaries: true }).lay([['A', 2, 4], ['s', 1, 2], ['B', 2, 4], ['n2', 2, 4], ['n1', 1, 2]]);
      // Beside s in the list: with no store listing, the chunk records' order is the messages' order.
      laid.all.splice(laid.all.indexOf(laid.get('s')) + 1, 0, { ...structuredClone(laid.get('s')), id: 's2', content: 'memory s2' });
      (laid as unknown as { chunks: unknown[] }).chunks = laid.all.filter((x) => x.level === 1 && x.id !== (owner === 's' ? 's2' : 's'))
        .map((l1) => ({ messages: l1.sourceIds.map((id) => ({ id })), compressed: true, summaryId: l1.id }));
      laid.check();
      return laid;
    };
    const stale = generations('s2');
    assert.deepEqual(stale.carriedFrom('s2').map((c) => c.level), [2], 'premise: the span is placed, and the L1 its chunk record names is carried');
    assert.deepEqual(stale.carriedFrom('s'), [], 'the generation that L1 replaced stands for no message, and is not');
    assert.deepEqual(generations('s').carriedFrom('s').map((c) => c.level), [2], 'control: s is carried where the record names it');
  });

  it('carries nothing the store holds differently: a summary another instance sharing it has parented or dropped', () => {
    const stored = (edit: (summaries: SummaryEntry[]) => SummaryEntry[]) => {
      const p = new Probe({ carryStrandedSummaries: true }).lay(RAGGED);
      // The store's own list of summaries, which this instance's writes reach as a store's would.
      const list = edit(structuredClone(p.all));
      Object.assign((p as unknown as { store: object }).store, {
        getStateJson: (id: string) => (id.endsWith('autobio:summaries') ? list : null),
        appendToStateJson: (_id: string, entry: SummaryEntry) => { list.push(structuredClone(entry)); },
        editStateItem: (_id: string, at: number, entry: SummaryEntry) => { list[at] = structuredClone(entry); },
      });
      p.check();
      return p.carriedFrom('s').length;
    };
    assert.equal(stored((list) => list.map((x) => (x.id === 's' ? { ...x, mergedInto: 'theirs' } : x))), 0, 'parented in the store');
    assert.equal(stored((list) => list.filter((x) => x.id !== 's')), 0, 'gone from the store');
    assert.equal(stored((list) => list), 2, 'control: held there as here, it is carried');
  });

  it('carries nothing while the compression quarantine can\'t be read, and the check goes on', () => {
    const p = new Probe({ carryStrandedSummaries: true }).lay(RAGGED);
    (p as unknown as { readCompressionQuarantineProjection(): never }).readCompressionQuarantineProjection = () => { throw new Error('ledger unreadable (test)'); };
    p.check();
    assert.deepEqual(p.carriedFrom('s'), []);
    const preview = p.previewCarries();
    assert.equal(preview.steps, null);
    assert.match(String('error' in preview && preview.error), /^The carry preview could not be made\.\nCause: ledger unreadable \(test\)/);
  });

  it('carries nothing below a merge threshold of 2, where no merge lands', () => {
    const p = new Probe({ carryStrandedSummaries: true, mergeThreshold: 1 }).lay(RAGGED);
    p.check();
    assert.deepEqual(p.carriedFrom('s'), []);
  });

  it('without speculative production, carries an L1 to L2, the one level that check merges from, and no L2', () => {
    const p = new Probe({ carryStrandedSummaries: true, speculativeProduction: false }).lay(
      [['A', 3, 8], ['u', 2, 4], ['B', 3, 8], ['C', 2, 4], ['s', 1, 2], ['D', 2, 4], ['n2', 2, 4], ['n1', 1, 2]],
    );
    p.check();
    assert.deepEqual(p.carriedFrom('s').map((c) => c.level), [2]);
    assert.deepEqual(p.carriedFrom('u'), [], 'an L3 it made would never merge');
  });
});

describe('a summary too wide for its level', () => {
  // Base 3: an L1 to L3 may span 3 messages past its first, an L4 18, an L5 108.
  const config = { carryStrandedSummaries: true, mergeMaxSourceSpanMessages: 3 };

  it('is carried between higher summaries, to the level where its span fits, and merges there', () => {
    const slots: Slot[] = [['P', 6, 32], ['A', 5, 16], ['w', 3, 6], ['B', 5, 16], ['X', 6, 32], ['n5', 5, 16], ['n4', 4, 8], ['n3', 3, 4]];
    const off = new Probe({ ...config, carryStrandedSummaries: false }).lay(slots);
    quietly(() => off.check());
    assert.deepEqual([off.queued(), off.all.filter((x) => x.carriedFrom !== undefined)], [[], []], 'premise: left out of its level as too wide, it merges with nothing');

    const p = new Probe(config).lay(slots);
    quietly(() => p.check());
    const [w4, w5] = p.carriedFrom('w');
    assert.deepEqual(p.carriedFrom('w').map((c) => c.level), [4, 5]);
    assert.deepEqual(p.queued(), [{ level: 6, sourceIds: ['A', w5!.id, 'B'] }]);
    assert.equal(w4!.mergedInto, w5!.id);
  });

  it('is held to the span limit of each level it reaches: still too wide there, it joins no run', () => {
    const p = new Probe(config).lay([['A', 4, 8], ['w', 3, 20], ['B', 4, 8], ['n4', 4, 8], ['n3', 3, 4]]);
    quietly(() => p.check());
    assert.deepEqual(p.carriedFrom('w').map((c) => c.level), [4], 'carried to the level of its neighbours, and no further');
    assert.deepEqual(p.queued(), [], 'at L4 it spans 19 past its first, over the 18 an L4 may: A and B stay apart');
  });
});

// ---------------------------------------------------------------------------
// On a store: what is written, what a compile sends, what a merge is asked.
// ---------------------------------------------------------------------------

const STORE = './test-carry-stranded-store';
const wipe = (path = STORE): void => { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); };
after(() => { wipe(); wipe(`${STORE}-control`); });

const BASE = {
  adaptiveResolution: true, hierarchical: true, speculativeProduction: true, autoTickOnNewMessage: false, compressionModel: 'mock',
  headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0, minChunkCharsForLLM: 0, targetChunkTokens: 20,
};

interface Seeded { m: string[]; laid: ReturnType<typeof frontier> }

/**
 * A store holding `slots` as its summaries, each L1 with its chunk record,
 * every message folded to the level of the summary over it, and the summary
 * counter at 500. `edit` changes the summaries before they are written.
 */
async function seed(slots: readonly Slot[], edit: (summaries: SummaryEntry[]) => SummaryEntry[] = (x) => x, path = STORE, counter = 500): Promise<Seeded> {
  wipe(path);
  const strategy = new AutobiographicalStrategy(BASE as never);
  const manager = await ContextManager.open({ path, strategy, namespace: 'probe', membrane: { complete: async () => { throw new Error('no call while seeding'); } } as never });
  const width = slots.reduce((n, [, , w]) => n + w, 0);
  const m: string[] = [];
  for (let i = 0; i < width; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(60) }]));
  const laid = frontier(slots, (i) => m[i]!);
  const summaries = edit(laid.summaries);
  const resolutions: Record<string, number> = {};
  for (const [id, level] of slots) if (level > 0) for (let i = laid.span.get(id)![0]; i <= laid.span.get(id)![1]; i++) resolutions[m[i]!] = level;
  const state = strategy as unknown as {
    store: { setStateJson(id: string, value: unknown): void };
    summariesStateId: string; chunksStateId: string; counterStateId: string; resolutionsStateId: string;
  };
  state.store.setStateJson(state.summariesStateId, summaries);
  state.store.setStateJson(state.chunksStateId, summaries.filter((s) => s.level === 1)
    .map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id })));
  state.store.setStateJson(state.counterStateId, counter);
  state.store.setStateJson(state.resolutionsStateId, resolutions);
  manager.close();
  return { m, laid };
}

/** A membrane that answers every call and keeps each request. */
function answering() {
  const requests: unknown[] = [];
  return {
    requests,
    membrane: { complete: async (request: unknown) => {
      requests.push(structuredClone(request));
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `what happened here (${requests.length})` }] };
    } },
  };
}

async function opened(config: Record<string, unknown>, membrane: unknown, path = STORE) {
  const strategy = new AutobiographicalStrategy({ ...BASE, ...config } as never);
  const manager = await ContextManager.open({ path, strategy, namespace: 'probe', membrane: membrane as never });
  const lane = strategy as unknown as {
    summaries: SummaryEntry[]; mergeQueue: Array<{ level: number; sourceIds: string[] }>; compressionQueue: unknown[];
    resolutions: Map<string, number>; checkMergeThreshold(): void; mergePicksWaiting: boolean;
  };
  const settle = async (): Promise<void> => {
    for (let guard = 0; guard < 50 && (lane.mergeQueue.length > 0 || lane.compressionQueue.length > 0 || lane.mergePicksWaiting); guard++) await manager.tick();
    assert.deepEqual([lane.mergeQueue.length, lane.compressionQueue.length, lane.mergePicksWaiting], [0, 0, false], 'premise: the queues ran dry, and no pick waits');
  };
  return { strategy, manager, lane, settle };
}

const wire = (compiled: { messages: Array<{ participant: string; content: unknown }> }) =>
  compiled.messages.map(({ participant, content }) => ({ participant, content }));

describe('a carry on a store', () => {
  it('carries with no model call, then merges the run with one call, asked exactly as for three ordinary L5s of the same texts', async () => {
    const thinking = [{ type: 'thinking', thinking: 'what I weighed', signature: 'sig-1' }, { type: 'text', text: 'memory s' }];
    const withCarrier = (summaries: SummaryEntry[]) => {
      Object.assign(summaries.find((x) => x.id === 's')!, { responseContent: thinking, tokens: 77 });
      return summaries;
    };
    await seed(RAGGED, withCarrier);
    const carried = answering();
    const run = await opened({ carryStrandedSummaries: true }, carried.membrane);
    try {
      const c4 = run.lane.summaries.find((x) => x.carriedFrom === 's')!;
      const c5 = run.lane.summaries.find((x) => x.carriedFrom === c4.id)!;
      assert.deepEqual([c4.id, c4.level, c5.id, c5.level], ['L4-500', 4, 'L5-501', 5], 'the open\'s merge check carried it');
      assert.deepEqual(carried.requests, [], 'with no model call');
      assert.deepEqual(run.lane.mergeQueue.map(({ level, sourceIds }) => ({ level, sourceIds })), [{ level: 6, sourceIds: ['A', 'L5-501', 'B'] }]);
      const debt = run.strategy.getCompressionDebt();
      assert.deepEqual([debt.state, debt.lastMintAt, debt.mergeQuarantineCount, debt.compressionQuarantineCount], ['healthy', 1, 0, 0], 'no debt, and no mint');

      await run.settle();
      assert.equal(carried.requests.length, 1, 'exactly one model call');
      const merged = run.lane.summaries.find((x) => x.level === 6 && x.sourceIds.includes('L5-501'))!;
      assert.deepEqual([merged.id, merged.sourceIds, merged.carriedFrom], ['L6-502', ['A', 'L5-501', 'B'], undefined]);
      assert.equal(merged.content, 'what happened here (1)');
    } finally { run.manager.close(); }

    // The control: the same store with ordinary L4 and L5 entries where the
    // carries stood, of the same ids and texts, and the option off.
    const ordinary = (summaries: SummaryEntry[]) => {
      const s = withCarrier(summaries).find((x) => x.id === 's')!;
      const { mergedInto: _none, ...memory } = s;
      s.mergedInto = 'L4-500';
      return [
        ...summaries,
        { ...memory, id: 'L4-500', level: 4, sourceLevel: 3, sourceIds: ['s'], mergedInto: 'L5-501' } as SummaryEntry,
        { ...memory, id: 'L5-501', level: 5, sourceLevel: 4, sourceIds: ['L4-500'] } as SummaryEntry,
      ];
    };
    await seed(RAGGED, ordinary, `${STORE}-control`, 502);
    const control = answering();
    const plain = await opened({}, control.membrane, `${STORE}-control`);
    try {
      assert.deepEqual(plain.lane.mergeQueue.map(({ level, sourceIds }) => ({ level, sourceIds })), [{ level: 6, sourceIds: ['A', 'L5-501', 'B'] }], 'premise: the same merge');
      await plain.settle();
      assert.equal(control.requests.length, 1);
    } finally { plain.manager.close(); }
    assert.deepEqual(carried.requests[0], control.requests[0]);
    const asked = JSON.stringify(carried.requests[0]);
    assert.ok(asked.includes('[CM] Recall memory L4-500.') && asked.includes('what I weighed'), 'premise: the request shows the carried entry\'s source, carrier and all');
    assert.ok(asked.includes('[CM] Recall memory P.'), 'premise: and the summaries before the run');
  });

  it('asks a merge over a carried entry with the text of the summary it carries as that stands now, not the copy the carry wrote', async () => {
    // As a store whose s was carried twice, and its text then repaired in place: the two entries keep the text they copied.
    await seed(RAGGED, (summaries) => {
      const s = summaries.find((x) => x.id === 's')!;
      const { mergedInto: _none, ...memory } = s;
      Object.assign(s, { content: 'what a repair wrote', mergedInto: 'L4-500' });
      return [
        ...summaries,
        { ...memory, id: 'L4-500', level: 4, sourceLevel: 3, sourceIds: ['s'], carriedFrom: 's', mergedInto: 'L5-501' } as SummaryEntry,
        { ...memory, id: 'L5-501', level: 5, sourceLevel: 4, sourceIds: ['L4-500'], carriedFrom: 'L4-500' } as SummaryEntry,
      ];
    }, STORE, 502);
    const live = answering();
    const run = await opened({ carryStrandedSummaries: true }, live.membrane);
    try {
      assert.deepEqual(run.lane.summaries.filter((x) => x.carriedFrom !== undefined).map((x) => x.content), ['memory s', 'memory s'], 'premise: the entries hold the text as it was carried');
      assert.deepEqual(run.lane.mergeQueue.map((x) => x.sourceIds), [['A', 'L5-501', 'B']], 'premise: the run with the carried entry is queued');
      await run.settle();
      assert.equal(live.requests.length, 1);
      const asked = JSON.stringify(live.requests[0]);
      assert.ok(asked.includes('[CM] Recall memory L4-500.'), 'premise: the request names the entry under the one the merge takes');
      assert.ok(asked.includes('"what a repair wrote"'), 'answered with the text s holds now');
      assert.ok(!asked.includes('"memory s"'), 'and not with the copy');
    } finally { run.manager.close(); }
  });

  it('compiles the same bytes before and after a carry, and never folds the span to a carried level', async () => {
    for (const foldingStrategy of ['flat-profile', 'oldest-first'] as const) {
      // An envelope that names each summary's id, level and span: the bytes a carried entry of its own id would change.
      const config = { foldingStrategy, recallEnvelope: 'xml' };
      const { m, laid } = await seed(RAGGED_LIVE);
      const budget = { maxTokens: 200_000, reserveForResponse: 0 };
      const none = { complete: async () => { throw new Error('no call here'); } };

      const plain = await opened(config, none);
      let before: ReturnType<typeof wire>;
      try { before = wire(await plain.manager.compile(budget)); } finally { plain.manager.close(); }
      const [first, last] = laid.span.get('s')!;
      assert.ok(JSON.stringify(before).includes(JSON.stringify(`<cm-recall id="s" level="3" span="${m[first]}..${m[last]}">\nmemory s\n</cm-recall>`).slice(1, -1)), `${foldingStrategy}: premise: s is rendered, under its id`);

      const run = await opened({ ...config, carryStrandedSummaries: true }, none);
      try {
        assert.equal(run.lane.summaries.filter((x) => x.carriedFrom !== undefined).length, 2, `${foldingStrategy}: premise: carried at the open`);
        assert.deepEqual(wire(await run.manager.compile(budget)), before, `${foldingStrategy}: after the carry`);
        // A greedy solver keeps a span at the level it was last folded to: were a carried level one it reads, this would hold.
        for (const level of [4, 5]) {
          for (let i = first; i <= last; i++) run.lane.resolutions.set(m[i]!, level);
          assert.deepEqual(wire(await run.manager.compile(budget)), before, `${foldingStrategy}: asked for the carried L${level}`);
          assert.equal(run.lane.resolutions.get(m[first]!), 3, `${foldingStrategy}: the span stays at the level of the summary that holds its text`);
        }
      } finally { run.manager.close(); }
    }
  });

  const KV_UNIFIED = {
    policy: {
      alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10, cacheLambda: 1, cacheScale: 1000,
      cacheReadPrice: 0.1, cacheWritePrice: 1.25, continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000,
      continuityRecencyFloor: 0.2, continuityStableHalfLife: 10, continuityStableFloor: 0.25,
    },
    tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
    treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
  };

  for (const solver of [{ foldingStrategy: 'kv-stable' }, { foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED }]) {
    it(`compiles the same bytes under ${solver.foldingStrategy}, which takes the one-source parents and picks its own levels`, async () => {
    const config = { ...solver, recallEnvelope: 'xml' };
    const none = { complete: async () => { throw new Error('no call here'); } };
    // From a budget the summaries' tops fill to one that takes most of the
    // history raw: the solve picks its own levels, so the span is read at
    // whichever it picks under each.
    // Each side is the first compile of a process that opens the same store,
    // one a compile has already settled, with the option off and on: what a
    // restart alone changes is the same on both.
    const afterRestart = async (maxTokens: number, carryStrandedSummaries: boolean): Promise<ReturnType<typeof wire>> => {
      const budget = { maxTokens, reserveForResponse: 0 };
      await seed(RAGGED_LIVE);
      const settled = await opened(config, none);
      try { await settled.manager.compile(budget); } finally { settled.manager.close(); }
      const run = await opened({ ...config, carryStrandedSummaries }, none);
      try {
        assert.equal(run.lane.summaries.filter((x) => x.carriedFrom !== undefined).length, carryStrandedSummaries ? 2 : 0, 'premise: carried at the open, or not');
        return wire(await run.manager.compile(budget));
      } finally { run.manager.close(); }
    };
    let underItsId = 0;
    for (const maxTokens of [700, 1_000, 1_500, 2_500, 4_000]) {
      const before = await afterRestart(maxTokens, false);
      if (JSON.stringify(before).includes('<cm-recall id=\\"s\\" level=\\"3\\"')) underItsId++;
      assert.deepEqual(await afterRestart(maxTokens, true), before, `${maxTokens}: with the carry`);
    }
    assert.ok(underItsId > 0, 'premise: under one budget at least, s is rendered as a summary, under its id');
    });
  }

  it('folds the span to the merge that took the carried entry, once it lands, past the levels it was carried through', async () => {
    for (const solver of [{ foldingStrategy: 'flat-profile' }, { foldingStrategy: 'oldest-first' }, { foldingStrategy: 'kv-stable' }, { foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED }]) {
      const config = { ...solver, recallEnvelope: 'xml', carryStrandedSummaries: true };
      await seed(RAGGED_LIVE);
      const live = answering();
      const run = await opened(config, live.membrane);
      try {
        // The merge of A, what s became, and B; the tail's chunks compress too.
        await run.settle();
        const merged = run.lane.summaries.find((x) => x.level === 6 && x.sourceIds.includes('A'))!;
        assert.deepEqual(merged.sourceIds, ['A', 'L5-501', 'B'], `${solver.foldingStrategy}: premise: the merge landed`);
        // The tightest budget a compile still fits: there the span is folded as deep as its summaries go.
        let compiled = '';
        for (let maxTokens = 600; maxTokens > 0; maxTokens -= 10) {
          try {
            compiled = JSON.stringify(wire(await run.manager.compile({ maxTokens, reserveForResponse: 0 })));
          } catch (error) {
            assert.equal((error as Error).name, 'OverBudgetError', String(error));
            break;
          }
        }
        assert.ok(compiled.includes(`<cm-recall id=\\"${merged.id}\\" level=\\"6\\"`), `${solver.foldingStrategy}: the merge's summary is rendered`);
        for (const id of ['A', 's', 'B', 'L4-500', 'L5-501']) {
          assert.ok(!compiled.includes(`<cm-recall id=\\"${id}\\"`), `${solver.foldingStrategy}: and ${id}, which it covers, is not`);
        }
      } finally { run.manager.close(); }
    }
  });

  it('lists each memory once to a search and to the history listing, the carried entries left out', async () => {
    await seed(RAGGED_LIVE);
    const run = await opened({ carryStrandedSummaries: true }, { complete: async () => { throw new Error('no call here'); } });
    try {
      assert.equal(run.lane.summaries.filter((x) => x.content === 'memory s').length, 3, 'premise: s and the two entries that carry it');
      const found = (includeMerged: boolean) => run.manager.searchSummaries({ regex: /^memory s$/, includeMerged }).map((x) => [x.summary.id, x.summary.level]);
      assert.deepEqual(found(false), [['s', 3]], 'as before the carry: s, still the top of its span');
      assert.deepEqual(found(true), [['s', 3]]);
      const listed = run.manager.getSummariesInRange({});
      assert.deepEqual(listed.filter((x) => x.content === 'memory s').map((x) => [x.id, x.level, x.parentId]), [['s', 3, undefined]]);
      assert.equal(listed.length, run.lane.summaries.length - 2);
    } finally { run.manager.close(); }
  });

  it('asks for a transition summary as it did before the carry: the carried entries repeat no text in it', async () => {
    const asked: unknown[] = [];
    for (const carryStrandedSummaries of [false, true]) {
      await seed(RAGGED_LIVE);
      const live = answering();
      const run = await opened({ carryStrandedSummaries }, live.membrane);
      try {
        assert.equal(run.lane.summaries.filter((x) => x.carriedFrom !== undefined).length, carryStrandedSummaries ? 2 : 0, 'premise');
        await run.manager.generateTransitionSummary();
        asked.push(live.requests[0]);
      } finally { run.manager.close(); }
    }
    assert.ok(JSON.stringify(asked[0]).includes('Higher-level summaries:'), 'premise: the request lists summaries');
    assert.deepEqual(asked[1], asked[0]);
  });

  it('compiles the same bytes without adaptive resolution, where a carried L1 keeps its header and its level\'s budget', async () => {
    const slots: Slot[] = [['A', 2, 4], ['s', 1, 2], ['B', 2, 4], ['n2', 2, 4], ['n1', 1, 2], ['tail', 0, 2]];
    const config = { adaptiveResolution: false, speculativeProduction: false, recallHeaderTemplate: '[Recall {id} L{level}]' };
    await seed(slots);
    const none = { complete: async () => { throw new Error('no call here'); } };
    const budget = { maxTokens: 200_000, reserveForResponse: 0 };
    const plain = await opened(config, none);
    let before: ReturnType<typeof wire>;
    try { before = wire(await plain.manager.compile(budget)); } finally { plain.manager.close(); }
    assert.ok(JSON.stringify(before).includes('[Recall s L1]'), 'premise: s is rendered, under its id and level');
    const run = await opened({ ...config, carryStrandedSummaries: true }, none);
    try {
      assert.deepEqual(run.lane.summaries.filter((x) => x.carriedFrom !== undefined).map((x) => [x.level, x.carriedFrom]), [[2, 's']], 'premise: carried at the open');
      assert.deepEqual(wire(await run.manager.compile(budget)), before);
    } finally { run.manager.close(); }
  });

  it('holds across a restart: nothing is carried twice, the audit is clean, and the option off reads the store the same', async () => {
    await seed(RAGGED);
    const none = { complete: async () => { throw new Error('no call here'); } };
    const first = await opened({ carryStrandedSummaries: true }, none);
    let written: SummaryEntry[];
    try { written = structuredClone(first.lane.summaries); } finally { first.manager.close(); }
    assert.equal(written.filter((x) => x.carriedFrom !== undefined).length, 2);

    // inspect-store reads the stored state as it is, and says which entries carry which.
    const out = mkdtempSync(join(tmpdir(), 'carry-inspect-'));
    const { log } = console;
    console.log = () => {};
    try {
      assert.equal(await inspectStore([STORE, '--namespace', 'probe', '--output', out]), 0);
    } finally { console.log = log; }
    const listed = readFileSync(join(out, 'summary-tree.md'), 'utf8');
    rmSync(out, { recursive: true, force: true });
    assert.ok(listed.includes('## L4-500 (L4, 100 tokens) parent=L5-501 carries=s\nsourceLevel=3 sources=1 '), listed.slice(0, 400));
    assert.ok(listed.includes('## L5-501 (L5, 100 tokens) carries=L4-500\n'));

    for (const carryStrandedSummaries of [true, false]) {
      // topologyPolicy 'reject' is the default: the open throws on a summary the audit names.
      const again = await opened({ carryStrandedSummaries }, none);
      try {
        assert.deepEqual(again.lane.summaries, written, `option ${carryStrandedSummaries}: the store's summaries, as written`);
        again.lane.checkMergeThreshold();
        assert.deepEqual(again.lane.summaries, written, `option ${carryStrandedSummaries}: and after another check`);
        assert.deepEqual(again.strategy.getTopologyViolations(), []);
        assert.equal(again.strategy.getLatestLoadRepairReport(), null, 'the loader repaired nothing');
        assert.deepEqual(again.lane.mergeQueue.map((x) => x.sourceIds), [['A', 'L5-501', 'B']]);
      } finally { again.manager.close(); }
    }
  });

  it('is made the parent of its source by the loader where the process stopped between the two writes', async () => {
    // As a carry interrupted after its entry landed: the entry lists s, and s names no parent yet.
    await seed(RAGGED, (summaries) => {
      const s = summaries.find((x) => x.id === 's')!;
      return [...summaries, { ...s, id: 'L4-500', level: 4, sourceLevel: 3, sourceIds: ['s'], carriedFrom: 's' } as SummaryEntry];
    }, STORE, 501);
    const { warn } = console;
    console.warn = () => {};
    const run = await opened({ carryStrandedSummaries: true }, { complete: async () => { throw new Error('no call here'); } });
    console.warn = warn;
    try {
      assert.equal(run.lane.summaries.find((x) => x.id === 's')!.mergedInto, 'L4-500');
      assert.deepEqual(run.lane.summaries.filter((x) => x.carriedFrom !== undefined).map((x) => [x.id, x.carriedFrom]), [['L4-500', 's'], ['L5-501', 'L4-500']], 'carried on from there, once');
    } finally { run.manager.close(); }
  });
});

describe('the preview, previewCarries()', () => {
  /** What the store holds beyond `before`: each carry and each merge, in the order written. */
  const happened = (before: readonly SummaryEntry[], after: readonly SummaryEntry[]) =>
    after.slice(before.length).map((x) => (x.carriedFrom !== undefined
      ? { kind: 'carry', id: x.carriedFrom, fromLevel: x.level - 1, toLevel: x.level, as: x.id }
      : { kind: 'merge', level: x.level, sourceIds: x.sourceIds, as: x.id }));

  /** The preview's steps with each name it gave (`as`) replaced by the id the store then wrote. */
  function named(steps: readonly LadderStep[], actual: ReturnType<typeof happened>) {
    const real = new Map(steps.map((step, i) => [step.as, actual[i]?.as] as const));
    const id = (x: string) => real.get(x) ?? x;
    return steps.map((step) => (step.kind === 'carry'
      ? { kind: 'carry', id: id(step.id), fromLevel: step.fromLevel, toLevel: step.toLevel, as: id(step.as) }
      : { kind: 'merge', level: step.level, sourceIds: step.sourceIds.map(id), as: id(step.as) }));
  }

  // Two singles, so the ladder runs on past the first merge: s is carried to
  // the L5s beside it, whose run merges into an L6 between P and X, and that
  // run merges in turn; u, an L4 between an L6 and an L5, is carried to pair
  // with n5.
  const slots: Slot[] = [
    ['P', 6, 32], ['A', 5, 16], ['s', 3, 4], ['B', 5, 16], ['X', 6, 32], ['u', 4, 8], ['n5', 5, 16], ['Y', 6, 32],
    ['m5', 5, 16], ['n4', 4, 8], ['n3', 3, 4],
  ];

  it('lists exactly the carries and merges that then happen, in order, and writes nothing', async () => {
    await seed(slots);
    const audit = await opened({ auditOnly: true, topologyPolicy: 'report' }, { complete: async () => { throw new Error('no call here'); } });
    let steps: LadderStep[];
    let before: SummaryEntry[];
    try {
      before = structuredClone(audit.lane.summaries);
      const preview = audit.strategy.previewCarries();
      assert.ok(preview.steps, 'premise: the preview was made');
      steps = preview.steps;
      assert.deepEqual(audit.lane.summaries, before, 'the preview changed nothing it read');
      assert.deepEqual(audit.lane.mergeQueue, []);
    } finally { audit.manager.close(); }
    assert.deepEqual(steps, [
      { kind: 'carry', id: 's', fromLevel: 3, toLevel: 4, as: 's^4' },
      { kind: 'carry', id: 's^4', fromLevel: 4, toLevel: 5, as: 's^5' },
      { kind: 'carry', id: 'u', fromLevel: 4, toLevel: 5, as: 'u^5' },
      { kind: 'merge', level: 6, sourceIds: ['A', 's^5', 'B'], sourceTokens: 300, as: 'merge#1' },
      { kind: 'merge', level: 6, sourceIds: ['u^5', 'n5'], sourceTokens: 200, as: 'merge#2' },
      { kind: 'merge', level: 7, sourceIds: ['P', 'merge#1', 'X'], sourceTokens: 200, unwritten: 1, as: 'merge#3' },
    ]);

    const live = answering();
    const run = await opened({ carryStrandedSummaries: true }, live.membrane);
    try {
      await run.settle();
      const actual = happened(before, run.lane.summaries);
      assert.deepEqual(named(steps, actual), actual);
      assert.equal(live.requests.length, steps.filter((step) => step.kind === 'merge').length, 'a model call for each merge listed, and none for a carry');
    } finally { run.manager.close(); }
  });

  it('reads the store as a drain does when asked, and lists what a drain then does', async () => {
    // Nothing of its level follows s, so a resident's own check reads it as its level's newest run.
    const last: Slot[] = [['A', 5, 16], ['s', 3, 4], ['B', 5, 16]];
    await seed(last);
    const config = { mergeThreshold: 3 };
    const audit = await opened({ ...config, auditOnly: true }, { complete: async () => { throw new Error('no call here'); } });
    let steps: LadderStep[];
    let before: SummaryEntry[];
    try {
      before = structuredClone(audit.lane.summaries);
      assert.deepEqual(audit.strategy.previewCarries().steps, [], 'as the resident reads it, nothing is carried');
      steps = audit.strategy.previewCarries({ asDrain: true }).steps!;
    } finally { audit.manager.close(); }
    assert.deepEqual(steps.map((step) => step.kind), ['carry', 'carry', 'merge']);

    class Drain extends AutobiographicalStrategy { protected override landsAsPlanned(): boolean { return true; } }
    const live = answering();
    const strategy = new Drain({ ...BASE, ...config, carryStrandedSummaries: true } as never);
    const manager = await ContextManager.open({ path: STORE, strategy, namespace: 'probe', membrane: live.membrane as never });
    const lane = strategy as unknown as { summaries: SummaryEntry[]; mergeQueue: unknown[]; mergePicksWaiting: boolean };
    try {
      for (let guard = 0; guard < 50 && (lane.mergeQueue.length > 0 || lane.mergePicksWaiting); guard++) await manager.tick();
      assert.deepEqual([lane.mergeQueue.length, lane.mergePicksWaiting], [0, false], 'premise: the drain ran dry');
      const actual = happened(before, lane.summaries);
      assert.deepEqual(named(steps, actual), actual);
      assert.equal(live.requests.length, 1);
    } finally { manager.close(); }
  });

  it('is printed by audit-topology --carry-preview, which leaves the summaries as they were', async () => {
    await seed(slots);
    const audit = (...flags: string[]) => spawnSync(process.execPath, [join(process.cwd(), 'dist/scripts/audit-topology.js'), STORE, '--namespace', 'probe', ...flags], { encoding: 'utf8' });
    const text = audit('--carry-preview');
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes([
      '  carry preview (as the resident\'s own merge check reads the store): 3 carries, 3 merge(s), in order',
      '    carry s: L3 to L4, no model call (as s^4)',
      '    carry s^4: L4 to L5, no model call (as s^5)',
      '    carry u: L4 to L5, no model call (as u^5)',
      '    merge to L6: A, s^5, B (300 source tokens; as merge#1)',
      '    merge to L6: u^5, n5 (200 source tokens; as merge#2)',
      '    merge to L7: P, merge#1, X (200 source tokens, not counting 1 source(s) a merge above writes; as merge#3)',
    ].join('\n')), text.stdout);
    assert.match(text.stdout, /\n {2}stranded L3 s: /, 'with the resident\'s option off, s is listed as stranded');

    const json = audit('--carry-preview', '--carry-stranded-summaries', '--json');
    assert.equal(json.status, 0, json.stderr);
    const out = JSON.parse(json.stdout) as { runs: { carryStrandedSummaries: boolean }; carryPreview: { steps: LadderStep[] }; stranded: { summaries: Array<{ id: string }> } };
    assert.equal(out.runs.carryStrandedSummaries, true);
    assert.equal(out.carryPreview.steps.length, 6);
    assert.deepEqual(out.stranded.summaries.map((x) => x.id).filter((id) => id === 's' || id === 'u'), [], 'with it on, what the rule carries is not stranded');

    const none = audit();
    assert.ok(!none.stdout.includes('carry preview'), 'not printed unless asked for');
    assert.equal(audit('--carry-preview=soon').status, 1);

    const after = await opened({ auditOnly: true }, { complete: async () => { throw new Error('no call here'); } });
    try {
      assert.deepEqual(after.lane.summaries.filter((x) => x.carriedFrom !== undefined), [], 'no audit carried anything');
    } finally { after.manager.close(); }
  });
});

describe('the rebuild plan and a drain, with the option on', () => {
  const messages = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m-${i}` }));
  const recordsOf = (summaries: readonly SummaryEntry[]): RepairRecord[] =>
    summaries.filter((s) => s.level === 1).map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id }));

  it('the plan reads a summary the rule carries as no stray, where without it a neighbour\'s tower is dissolved to partner it', () => {
    const laid = frontier([['A', 5, 16], ['s', 3, 4], ['B', 5, 16]]);
    const inputs = { summaries: laid.summaries as unknown as RepairSummary[], records: recordsOf(laid.summaries), messages: messages(laid.messages) };
    const without = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 3 } });
    assert.deepEqual(without.partnered.map((x) => x.id), ['s']);
    assert.ok(without.dissolvedForRebuild.length > 0, 'premise: partnering s costs a tower, and the summarizer calls to fold it again');

    const carrying = planTopologyRepair(inputs, { mode: 'rebuild', runs: { mergeThreshold: 3, carryStrandedSummaries: true } });
    assert.deepEqual([carrying.partnered, carrying.strandedLeft, carrying.dissolvedForRebuild], [[], [], []]);
    assert.deepEqual(carrying.result.summaries, inputs.summaries, 'the plan changes nothing: the drain carries s and merges the run');
  });

  it('the planner\'s stray list matches the strategy\'s, with the option on and off', () => {
    const laid = frontier(RAGGED);
    const inputs = { summaries: laid.summaries as unknown as RepairSummary[], records: recordsOf(laid.summaries), messages: messages(laid.messages) };
    for (const carryStrandedSummaries of [true, false]) {
      const p = new Probe({ carryStrandedSummaries }).lay(RAGGED);
      const runtime = p.getStrandedSummaries().summaries!.map((x) => ({ id: x.id, level: x.level }));
      assert.deepEqual(strandedInStore(inputs, { carryStrandedSummaries }), runtime, `option ${carryStrandedSummaries}`);
      assert.equal(runtime.some((x) => x.id === 's'), !carryStrandedSummaries);
    }
  });

  it('a drain lands the store as that plan projected: s carried, the run merged, nothing stranded', async () => {
    const last: Slot[] = [['A', 5, 16], ['s', 3, 4], ['B', 5, 16]];
    const { m, laid } = await seed(last);
    const config = { mergeThreshold: 3, carryStrandedSummaries: true };
    const plan = planTopologyRepair(
      { summaries: laid.summaries as unknown as RepairSummary[], records: recordsOf(laid.summaries), messages: m.map((id) => ({ id })) },
      { mode: 'rebuild', runs: config },
    );
    assert.deepEqual([plan.partnered, plan.strandedLeft, plan.dissolvedForRebuild], [[], [], []], 'premise: the plan leaves the store to the drain');

    class Drain extends AutobiographicalStrategy { protected override landsAsPlanned(): boolean { return true; } }
    const live = answering();
    const strategy = new Drain({ ...BASE, ...config } as never);
    const manager = await ContextManager.open({ path: STORE, strategy, namespace: 'probe', membrane: live.membrane as never });
    const lane = strategy as unknown as { summaries: SummaryEntry[]; mergeQueue: unknown[]; mergePicksWaiting: boolean };
    try {
      for (let guard = 0; guard < 50 && (lane.mergeQueue.length > 0 || lane.mergePicksWaiting); guard++) await manager.tick();
      assert.deepEqual([lane.mergeQueue.length, lane.mergePicksWaiting], [0, false], 'premise: the drain ran dry');
      const top = lane.summaries.filter((x) => !x.mergedInto && !x.parentId);
      assert.deepEqual(top.map((x) => [x.level, x.sourceIds.length]), [[6, 3]], 'one L6 over A, what s became, and B');
      assert.equal(live.requests.length, 1);
      assert.deepEqual(strategy.getStrandedSummaries().summaries, []);
    } finally { manager.close(); }

    // A resident's own check reads s as its level's newest run, and leaves the store as it is.
    await seed(last);
    const resident = await opened(config, { complete: async () => { throw new Error('no call here'); } });
    try {
      assert.deepEqual(resident.lane.summaries.filter((x) => x.carriedFrom !== undefined), []);
    } finally { resident.manager.close(); }
  });

  it('a repair keeps a parent that carries its one source, where it dissolves a merge left with one', () => {
    // A crossed L2 beside a carried chain: z's two L1s stand apart, around y.
    const at = (i: number) => `m-${i}`;
    const l1 = (id: string, first: number, last: number, parent?: string): SummaryEntry => tower(id, 1, first, last, at, parent)[0]!;
    const summaries: SummaryEntry[] = [
      l1('z0', 0, 1, 'z'), l1('y', 2, 3), l1('z1', 4, 5, 'z'),
      { ...l1('z', 0, 5), level: 2, sourceLevel: 1, sourceIds: ['z0', 'z1'] } as SummaryEntry,
      l1('s', 6, 7, 'c2'),
      { ...l1('c2', 6, 7), level: 2, sourceLevel: 1, sourceIds: ['s'], carriedFrom: 's' } as SummaryEntry,
      // An ordinary merge with one source, as a repair leaves one: dissolved, as before.
      l1('t', 8, 9, 'lone2'),
      { ...l1('lone2', 8, 9), level: 2, sourceLevel: 1, sourceIds: ['t'] } as SummaryEntry,
    ];
    const plan = planTopologyRepair({ summaries: summaries as unknown as RepairSummary[], records: recordsOf(summaries), messages: messages(10) });
    assert.deepEqual(plan.before.map((c) => c.id), ['z'], 'premise: z is crossed, so the repair runs');
    assert.deepEqual(plan.dissolved.map((d) => d.id).sort(), ['lone2', 'z']);
    const kept = plan.result.summaries.find((x) => x.id === 'c2');
    assert.deepEqual([kept?.sourceIds, plan.result.summaries.find((x) => x.id === 's')?.mergedInto], [['s'], 'c2']);
    assert.deepEqual(plan.remaining, []);
  });

  it('a carried entry a repair gave a second source is read as a summary of its level, over both', () => {
    // A crossed L2 whose detached half a compact repair re-homes under the carried entry beside it.
    const at = (i: number) => `m-${i}`;
    const l1 = (id: string, first: number, last: number, parent?: string): SummaryEntry => tower(id, 1, first, last, at, parent)[0]!;
    const summaries: SummaryEntry[] = [
      l1('z0', 0, 1, 'z'), l1('y', 2, 5), l1('z1', 6, 7, 'z'),
      { ...l1('z', 0, 7), level: 2, sourceLevel: 1, sourceIds: ['z0', 'z1'] } as SummaryEntry,
      l1('s', 8, 9, 'c2'),
      { ...l1('c2', 8, 9), level: 2, sourceLevel: 1, sourceIds: ['s'], carriedFrom: 's' } as SummaryEntry,
    ];
    const plan = planTopologyRepair({ summaries: summaries as unknown as RepairSummary[], records: recordsOf(summaries), messages: messages(10) }, { mode: 'compact' });
    assert.deepEqual(plan.rehomed.map((r) => [r.id, r.into]), [['z1', 'c2']], 'premise: the repair gives the carried entry a second source');
    const written = plan.result.summaries.find((x) => x.id === 'c2')!;
    assert.deepEqual([written.sourceIds, written.carriedFrom], [['z1', 's'], 's'], 'premise: which keeps the mark it was written with');

    // As the selects and the lists read the repaired store, once a merge has taken the entry.
    const p = new Probe();
    (p as unknown as { summaries: SummaryEntry[] }).summaries = [
      ...(structuredClone(plan.result.summaries) as unknown as SummaryEntry[]).map((x) => (x.id === 'c2' ? { ...x, mergedInto: 'M' } : x)),
      { ...l1('M', 6, 9), level: 3, sourceLevel: 2, sourceIds: ['c2'] } as SummaryEntry,
    ];
    const read = new Map(p.searchSummaries({ includeMerged: true }).map(({ summary }) => [summary.id, summary] as const));
    assert.deepEqual(read.get('c2')?.sourceIds, ['z1', 's'], 'it stands in the view, over both sources');
    assert.deepEqual([read.get('z1')?.mergedInto, read.get('s')?.mergedInto, read.get('M')?.sourceIds], ['c2', 'c2', ['c2']], 'so neither source drops out of the merge above it');
  });
});
