/**
 * Taking rows removed from the record out of a window that didn't hear them
 * go (agent-framework #291, CM-8).
 *
 * A removal through a manager takes the row out of that manager's window,
 * but another manager whose window holds the row, on the same slot or
 * merging it as an auxiliary one, never hears it: the row leaves the
 * record and so its listing, while its ordinal stays issued (CM-T). A host
 * repairs that window with retractRemoved(ids), naming the rows a removal
 * took, or at boot with retractAbsentRows(), which finds every such row,
 * the removals no live manager heard among them.
 *
 * - Each takes a row out only where the window holds it and no merged slot
 *   does any more, a tombstone at its ordinal, so no other ordinal moves;
 *   it returns the ids taken out, in window order, and passes over the
 *   rest, a row a branch made before the removal still holds among them.
 * - In legacy mode, on a write-down cut short and on an index in another
 *   version's format, neither writes anything: a removed row has left a
 *   window that is the record already.
 * - The strategy is told the rows left (onRetracted), by their ids alone
 *   with `removed`, since the store holds no row of them to give: a folding
 *   reader lets go of what it folded of them, as the manager that removed
 *   them did, and doesn't halt its compression over records whose rows are
 *   gone (FW-CM-1, J-CM1).
 * - A row of an auxiliary slot the manager no longer merges reads as
 *   removed (the caveat their doc comments state).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, KnowledgeStrategy, PassthroughStrategy, windowIndexStateId } from '../src/index.js';
import type { CompileResult, MessageId, StoredMessage, StrategyContext, SummaryEntry } from '../src/index.js';
import { perItemIndexWrites } from './_harness/index-writes.js';

const BASE = './test-retract-removed';
let storeSeq = 0;
function freshPath(): string {
  const path = `${BASE}-${storeSeq++}`;
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  return path;
}
after(() => {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const INDEX = windowIndexStateId('zz-agent');
const ids = (messages: Array<{ id: MessageId }>) => messages.map((m) => m.id);

/** Passthrough that stores a message of two or more blocks as one shard per block. */
class Sharding extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: `zz-doc-${(content[0] as { text: string }).text}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

type Info = { undone: boolean; removed: boolean; ids: readonly MessageId[] };

/** Passthrough that keeps the rows and the info each onRetracted call was given. */
class Records extends PassthroughStrategy {
  retracted: Array<{ rows: MessageId[]; info: Info }> = [];
  async onRetracted(rows: readonly StoredMessage[], _ctx: StrategyContext, info: Info): Promise<void> {
    this.retracted.push({ rows: rows.map((m) => m.id), info });
  }
}

/**
 * Makes the `failing`-th append to the index from now on throw, as a full disk
 * would; returns the undo. A write is cut short partway only in an index
 * written one record per item, as pre-release builds wrote it before
 * batched writes, so the window index is written so while this is
 * installed (perItemIndexWrites); window-batches.test.ts has the batched
 * form, which the store keeps or loses whole.
 */
function failAppend(cm: ContextManager, failing: number, stateId = INDEX): () => void {
  const store = cm.getStore() as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
  const append = store.appendToStateJsonWithIdentity;
  const batched = perItemIndexWrites(cm.getStore());
  let appends = 0;
  store.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
    if (id === stateId && ++appends === failing) throw new Error('zz-index-append-failed');
    return append.call(this, id, ...rest);
  };
  return () => {
    store.appendToStateJsonWithIdentity = append;
    batched();
  };
}

/** Each row's ordinal in `cm`'s window, by id. */
function ordinals(cm: ContextManager, rows: readonly MessageId[]): Array<number | undefined> {
  return rows.map((id) => cm.ordinalOf(id));
}

/** A writer and a reader on one store, sharing its message slot; the reader's window is written down. */
async function writerAndReader(strategy: PassthroughStrategy = new PassthroughStrategy()) {
  const writer = await ContextManager.open({ path: freshPath(), namespace: 'zz-writer', strategy: new Sharding() });
  const cm = await ContextManager.open({ store: writer.getStore(), namespace: 'zz-agent', strategy });
  cm.presentRows([]);
  return { writer, cm, store: writer.getStore() };
}

describe('retractAbsentRows', () => {
  it('takes out the rows removed through another manager, in window order, and moves no other ordinal', async () => {
    const { writer, cm, store } = await writerAndReader();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId, MessageId];
    const doc = writer.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]);
    const shards = ids(writer.getAllMessages()).slice(4);
    assert.equal(shards.length, 3, 'setup: the body is stored as three shards');
    // Presented out of record order: the window's order is d, b, the body, a, c.
    cm.presentRows([d, b, doc, a, c]);
    const before = ordinals(cm, [a, b, c, d, ...shards]);

    writer.removeMessage(b);
    writer.removeMessages(shards[0]!, shards[2]!);
    writer.removeMessage(d);
    assert.notEqual(cm.ordinalOf(b), undefined, 'setup: the removals through the writer aren\'t heard');
    assert.equal(cm.windowStatusOf(b), 'absent', 'setup');
    const length = cm.indexLength();

    assert.deepEqual(cm.retractAbsentRows(), [d, b, ...shards], 'every removed row the window held, in window order');
    assert.deepEqual(ordinals(cm, [a, b, c, d, ...shards]), [before[0], undefined, before[2], undefined, undefined, undefined, undefined]);
    assert.equal(cm.indexLength(), length + 5, 'one tombstone each, after the ordinals issued');
    assert.deepEqual(ids(cm.getPresentedMessages()), [a, c]);
    assert.equal(cm.windowStatusOf(b), 'absent');
    assert.deepEqual(cm.getUnpresentedMessages(), [], 'a removed row isn\'t offered');

    const written = store.getStateLen(INDEX);
    assert.deepEqual(cm.retractAbsentRows(), [], 'nothing left to take out');
    assert.equal(store.getStateLen(INDEX), written, 'and nothing is written');

    // The next presentation takes the next ordinal: the holes stay holes.
    const e = writer.addMessage('alice', [text('e')]);
    assert.deepEqual(cm.presentRows([e]), [length + 5]);
    cm.close();
    writer.close();
  });

  it('repairs the manager\'s own removal whose tombstone couldn\'t be written', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    cm.presentRows([a, b]);
    const restore = failAppend(cm, 1);
    const error = console.error;
    console.error = () => {};
    try {
      cm.removeMessage(a);
    } finally {
      console.error = error;
      restore();
    }
    assert.notEqual(cm.ordinalOf(a), undefined, 'setup: the removal stands, and the row keeps its ordinal');
    assert.deepEqual(cm.retractAbsentRows(), [a]);
    assert.equal(cm.ordinalOf(a), undefined);
    assert.notEqual(cm.ordinalOf(b), undefined);
    cm.close();
  });

  it('a write that fails partway throws; the rows taken out before stay out, and the next call takes the rest', async () => {
    const { writer, cm } = await writerAndReader();
    const rows = ['a', 'b', 'c', 'd'].map((t) => writer.addMessage('alice', [text(t)])) as MessageId[];
    cm.presentRows(rows);
    writer.removeMessages(rows[0]!, rows[2]!);
    const restore = failAppend(cm, 2);
    try {
      assert.throws(() => cm.retractAbsentRows(), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(ordinals(cm, rows).map((o) => o !== undefined), [false, true, true, true], 'the first tombstone was written');
    assert.deepEqual(cm.retractAbsentRows(), rows.slice(1, 3));
    assert.deepEqual(ids(cm.getPresentedMessages()), [rows[3]]);
    cm.close();
    writer.close();
  });

  it('reads a row of an auxiliary slot the manager no longer merges as removed', async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    side.presentRows([]);
    const m1 = main.addMessage('alice', [text('m1')]);
    const s1 = side.addMessage('Subconscious', [text('s1')]);
    side.presentRows([m1, s1]);
    side.close();

    // Opened again without the shared slot: its rows read as removed here.
    const narrowed = await ContextManager.open({ store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy() });
    assert.equal(narrowed.windowStatusOf(m1), 'absent');
    assert.notEqual(narrowed.ordinalOf(m1), undefined, 'setup: the index still holds it');
    assert.deepEqual(narrowed.retractAbsentRows(), [m1], 'the caveat: the row leaves the window');
    narrowed.close();

    // With the slot merged again, the row is stored and out of the window.
    const widened = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    assert.equal(widened.windowStatusOf(m1), 'out');
    assert.deepEqual(ids(widened.getUnpresentedMessages()), [m1], 'a host presents it again');
    widened.close();
    main.close();
  });
});

describe('retractRemoved', () => {
  it('takes out only the named rows the window holds and the record no longer does, in window order', async () => {
    const { writer, cm, store } = await writerAndReader();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId, MessageId];
    cm.presentRows([b, a, c]);
    const before = ordinals(cm, [a, b, c]);
    writer.removeMessage(a);
    writer.removeMessage(b);
    writer.removeMessage(d); // never presented

    assert.deepEqual(cm.retractRemoved([a, 'zz-never-stored', c, d, b]), [b, a], 'c is still stored, d and the unknown id never were in the window');
    assert.deepEqual(ordinals(cm, [a, b, c]), [undefined, undefined, before[2]]);
    assert.equal(cm.windowStatusOf(c), 'in');

    const written = store.getStateLen(INDEX);
    assert.deepEqual(cm.retractRemoved([a, b, d, 'zz-never-stored']), [], 'none of them is in the window');
    assert.deepEqual(cm.retractRemoved([]), []);
    assert.equal(store.getStateLen(INDEX), written, 'an id not in the window writes nothing');
    cm.close();
    writer.close();
  });

  it('passes over a row a branch made before the removal still holds, and takes it out on the branch that removed it', async () => {
    const { writer, cm } = await writerAndReader();
    const [a, b] = ['a', 'b'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    cm.presentRows([a, b]);
    const home = cm.currentBranch().name;
    const alt = cm.branchAt(b, 'zz-alt');
    writer.removeMessage(a);

    await cm.switchBranch(alt);
    assert.equal(cm.windowStatusOf(a), 'in', 'setup: the branch\'s record holds the row');
    const length = cm.indexLength();
    assert.deepEqual(cm.retractRemoved([a]), [], 'the row isn\'t removed here');
    assert.deepEqual(cm.retractAbsentRows(), []);
    assert.equal(cm.indexLength(), length, 'nothing is written');
    assert.notEqual(cm.ordinalOf(a), undefined);

    await cm.switchBranch(home);
    assert.deepEqual(cm.retractRemoved([a]), [a]);
    assert.equal(cm.ordinalOf(a), undefined);
    cm.close();
    writer.close();
  });

  it('refuses ids that aren\'t an array of message ids, in either mode', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    assert.throws(() => cm.retractRemoved('zz-a' as never), { name: 'TypeError', message: /ContextManager.retractRemoved: `ids` must be an array of message ids, got string/ });
    assert.throws(() => cm.retractRemoved([7] as never), { name: 'TypeError', message: /ContextManager.retractRemoved: id 0 must be a message id, got 7/ });
    cm.presentRows([]);
    assert.throws(() => cm.retractRemoved([null] as never), TypeError);
    cm.close();
  });
});

describe('retractRemoved and retractAbsentRows', () => {
  it('in legacy mode write nothing, never write the window down, and take nothing out', async () => {
    const { writer, cm, store } = await (async () => {
      const writer = await ContextManager.open({ path: freshPath(), namespace: 'zz-writer', strategy: new PassthroughStrategy() });
      const cm = await ContextManager.open({ store: writer.getStore(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      return { writer, cm, store: writer.getStore() };
    })();
    const [a, b, c] = ['a', 'b', 'c'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    writer.removeMessage(a);
    assert.deepEqual(cm.retractRemoved([a, b]), []);
    assert.deepEqual(cm.retractAbsentRows(), []);
    assert.equal(store.getStateLen(INDEX), null, 'no window is written down');
    assert.equal(store.getStateJson(INDEX), null);
    assert.equal(cm.windowMode(), 'legacy');

    // A write-down cut short is legacy mode too, and isn't finished.
    const restore = failAppend(cm, 2);
    try {
      assert.throws(() => cm.presentRows([]), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.equal(store.getStateLen(INDEX), 1, 'setup: one row written, and no header');
    writer.removeMessage(b);
    assert.deepEqual(cm.retractRemoved([b]), []);
    assert.deepEqual(cm.retractAbsentRows(), []);
    assert.equal(store.getStateLen(INDEX), 1, 'the write-down isn\'t finished');
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(ids(cm.getPresentedMessages()), [c], 'the window is the record');
    cm.close();
    writer.close();
  });

  it('write nothing to an index in another version\'s format', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    const store = cm.getStore();
    store.registerState({ id: INDEX, strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
    // Another version's index that holds the row a.
    for (const item of [{ id: a }, { v: 2 }]) store.appendToStateJsonWithIdentity(INDEX, item, 'by', 'at');
    const warn = console.warn;
    console.warn = () => {};
    try {
      cm.removeMessage(a);
      assert.deepEqual(cm.retractRemoved([a]), []);
      assert.deepEqual(cm.retractAbsentRows(), []);
    } finally {
      console.warn = warn;
    }
    assert.equal(store.getStateLen(INDEX), 2, 'nothing is written');
    cm.close();
  });

  // This test said the strategy is told nothing, since the store holds no
  // row to give it. A folding reader then kept summaries of the removed
  // rows for good, and a large removal halted its compression (J-CM1): the
  // rows are now told by their ids, as removed.
  it('tell the strategy the rows that left, by their ids, removed', async () => {
    const strategy = new Records();
    const { writer, cm } = await writerAndReader(strategy);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    writer.removeMessage(a);
    writer.removeMessage(b);
    assert.deepEqual(cm.retractRemoved([a]), [a]);
    // Before anything settles: the call is made inside retractRemoved.
    assert.deepEqual(strategy.retracted, [{ rows: [], info: { undone: false, removed: true, ids: [a] } }]);
    assert.deepEqual(cm.retractAbsentRows(), [b]);
    assert.deepEqual(strategy.retracted.slice(1), [{ rows: [], info: { undone: false, removed: true, ids: [b] } }]);
    assert.deepEqual(cm.retractRemoved([a]), [], 'nothing left to take out');
    assert.deepEqual(cm.retractAbsentRows(), []);
    assert.equal(strategy.retracted.length, 2, 'a call that takes nothing out tells nothing');
    // retractRows of a held row gives the row.
    cm.retractRows([c]);
    assert.deepEqual(strategy.retracted.slice(2), [{ rows: [c], info: { undone: false, removed: false, ids: [c] } }]);
    await new Promise((resolve) => setImmediate(resolve));
    cm.close();
    writer.close();
  });

  it('a write cut short tells the strategy the rows it took out before it', async () => {
    const strategy = new Records();
    const { writer, cm } = await writerAndReader(strategy);
    const rows = ['a', 'b', 'c'].map((t) => writer.addMessage('alice', [text(t)])) as MessageId[];
    cm.presentRows(rows);
    writer.removeMessages(rows[0]!, rows[2]!);
    const restore = failAppend(cm, 2);
    try {
      assert.throws(() => cm.retractAbsentRows(), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(strategy.retracted, [{ rows: [], info: { undone: false, removed: true, ids: [rows[0]] } }]);
    assert.deepEqual(cm.retractAbsentRows(), rows.slice(1));
    assert.deepEqual(strategy.retracted.slice(1), [{ rows: [], info: { undone: false, removed: true, ids: rows.slice(1) } }]);
    cm.close();
    writer.close();
  });

  it('a closed manager refuses both', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    cm.close();
    assert.throws(() => cm.retractRemoved([]), { message: 'ContextManager.retractRemoved after close()' });
    assert.throws(() => cm.retractAbsentRows(), { message: 'ContextManager.retractAbsentRows after close()' });
  });
});

// ----------------------------------------------------------------------------
// A folding reader lets go of a row removed through another manager
// ----------------------------------------------------------------------------

/** Summarizer mock: each answer names the tags its request carried. */
function mockMembrane() {
  let calls = 0;
  return {
    complete: async (request: { messages: Array<{ content: ContentBlock[] }> }) => {
      calls++;
      const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
      const tags = [...new Set(input.match(/TAG\d+/g) ?? [])].join(',');
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `[summary ${calls} of ${tags}] ` + 'mem '.repeat(20) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  } as never;
}

const FOLDING = { compressionModel: 'mock', targetChunkTokens: 200, recentWindowTokens: 300, headWindowTokens: 0, mergeThreshold: 4 } as const;
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

interface Folding {
  summaries: SummaryEntry[];
  chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
  chunkRecordsOrphaned: boolean;
}
const folding = (strategy: AutobiographicalStrategy) => strategy as unknown as Folding;

/** The message ids a summary covers. */
function leavesOf(cm: ContextManager, id: string): MessageId[] {
  const summary = cm.getSummary(id);
  if (!summary) return [];
  return summary.level === 1 ? summary.sourceIds : summary.sourceIds.flatMap((source) => leavesOf(cm, source));
}

/** The message ids some summary the strategy keeps covers. */
function coveredRows(cm: ContextManager, strategy: AutobiographicalStrategy): Set<MessageId> {
  return new Set(folding(strategy).summaries.flatMap((s) => leavesOf(cm, s.id)));
}

/** Each message id a compile renders, raw or inside a summary, as often as it renders it. */
function renderedRows(cm: ContextManager, result: CompileResult): MessageId[] {
  return renderedIds(result, (id) => leavesOf(cm, id));
}

/**
 * Each message id `result` renders, raw or inside a summary, as often as it
 * renders it, a summary's leaves given by `leaves`. A summary counts once
 * per rendering: a run of consecutive compiled messages naming it is one
 * rendering (a summary can render as more than one message), and the same
 * summary named again after a message that doesn't name it is another.
 */
function renderedIds(result: Pick<CompileResult, 'provenance'>, leaves: (summaryId: string) => MessageId[]): MessageId[] {
  const rendered: MessageId[] = [];
  let previous = new Set<string>();
  for (const part of result.provenance?.messages ?? []) {
    const named = new Set<string>(part.kind === 'summary' ? part.summaries.map((s) => s.id) : []);
    if (part.kind === 'raw') rendered.push(...part.bodies.map((b) => b.messageId));
    for (const id of named) if (!previous.has(id)) rendered.push(...leaves(id));
    previous = named;
  }
  return rendered;
}

/** Asserts the compile renders each row of the window once, and only those. */
async function rendersWindowOnce(cm: ContextManager, label: string): Promise<void> {
  const rendered = renderedRows(cm, await cm.compile(BIG));
  assert.equal(new Set(rendered).size, rendered.length, `${label}: no row renders twice`);
  assert.deepEqual(new Set(rendered), new Set(ids(cm.getPresentedMessages())), `${label}: every row of the window renders, and nothing else`);
}

async function drain(cm: ContextManager): Promise<void> {
  for (let i = 0; i < 1000 && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'the drain finished');
}

/** console.error's and console.warn's lines while `fn` runs. */
async function linesDuring(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return lines;
}

/**
 * Two residents on the shared slot, as agent-framework opens them (agents/<name>, not isolated), both folding and presented,
 * each shown TAG0..TAG<rows-1> as it was stored, drained.
 */
async function residents(make: () => AutobiographicalStrategy = () => new AutobiographicalStrategy(FOLDING), rows = 40) {
  const membrane = mockMembrane();
  const sa = make();
  const sb = make();
  const a = await ContextManager.open({ path: freshPath(), namespace: 'agents/alice', strategy: sa, membrane });
  const b = await ContextManager.open({ store: a.getStore(), namespace: 'agents/bob', strategy: sb, membrane });
  a.presentRows([]);
  b.presentRows([]);
  const rowIds: MessageId[] = [];
  for (let i = 0; i < rows; i++) {
    const id = a.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
    a.presentRows([id]);
    b.presentRows([id]);
    rowIds.push(id);
  }
  await drain(a);
  await drain(b);
  return { a, b, sa, sb, rowIds };
}

describe('a folding reader of a removal through another manager unfolds the removed rows', () => {
  for (const repair of ['retractRemoved', 'retractAbsentRows'] as const) {
    it(`a single row and a 30-row range removed through A, B repaired with ${repair}: no B summary covers them, and B doesn't halt`, async () => {
      // Rows enough after the range that the recent window stays where it
      // was: a removal that pulls a folded chunk into it renders that
      // chunk's last row twice, raw and folded, in legacy mode as well
      // (pre-existing, not the window's).
      const { a, b, sa, sb, rowIds } = await residents(undefined, 60);
      const take = (gone: MessageId[]) => (repair === 'retractRemoved' ? b.retractRemoved(gone) : b.retractAbsentRows());

      const single = rowIds[8]!;
      assert.ok(coveredRows(b, sb).has(single), 'premise: B folded the row');
      const singleLines = await linesDuring(() => {
        a.removeMessage(single);
        assert.ok(coveredRows(b, sb).has(single), 'premise: B hasn\'t heard the removal');
        assert.deepEqual(take([single]), [single]);
        // Before anything settles: B let go inside the repair.
        assert.ok(!coveredRows(b, sb).has(single), 'no summary of B covers the removed row');
        assert.ok(!coveredRows(a, sa).has(single), 'as none of A does');
      });
      assert.ok(singleLines.some((line) => line.includes('1 row(s) left the window') && line.includes('agents/bob')), singleLines.join('\n'));
      assert.ok(folding(sb).chunkRecords.every((r) => !r.sourceIds.includes(single)), 'no chunk record of B holds it');
      await drain(b);
      await rendersWindowOnce(b, 'B after the single row');

      const range = rowIds.slice(9, 39);
      assert.equal(range.length, 30);
      assert.ok(range.some((id) => coveredRows(b, sb).has(id)), 'premise: B folded rows of the range');
      const rangeLines = await linesDuring(async () => {
        a.removeMessages(range[0]!, range[range.length - 1]!);
        assert.deepEqual(take(range), range, 'every row of the range, in window order');
        assert.equal(folding(sb).chunkRecordsOrphaned, false, 'B\'s compression is not halted');
        const window = new Set(ids(b.getPresentedMessages()));
        assert.ok(folding(sb).chunkRecords.every((r) => r.sourceIds.some((id) => window.has(id))), 'no chunk record of B is left without a window row');
        await drain(b);
        await drain(a);
      });
      assert.ok(!rangeLines.some((line) => line.includes('FAIL-CLOSED')), rangeLines.join('\n'));
      for (const id of range) assert.ok(!coveredRows(b, sb).has(id), 'no summary of B covers a removed row');
      assert.equal(folding(sb).chunkRecordsOrphaned, false);
      await rendersWindowOnce(b, 'B after the range');
      await rendersWindowOnce(a, 'A after the range');
      const rendered = renderedRows(b, await b.compile(BIG));
      for (const id of [single, ...range]) assert.ok(!rendered.includes(id), 'B\'s compile omits the removed rows');
      a.close();
      b.close();
    });
  }

  it('a manager\'s own removal whose window write fails still unfolds the row, and retractAbsentRows later takes its ordinal out', async () => {
    const { a, b, sb, rowIds } = await residents();
    const gone = rowIds[8]!;
    assert.ok(coveredRows(b, sb).has(gone), 'premise: the row is folded');
    const store = b.getStore() as unknown as Record<string, (id: string, ...rest: unknown[]) => unknown>;
    const index = windowIndexStateId('agents/bob');
    const saved: Record<string, (id: string, ...rest: unknown[]) => unknown> = {};
    for (const name of ['appendManyToStateJsonWithIdentity', 'appendToStateJsonWithIdentity']) {
      const write = store[name];
      if (typeof write !== 'function') continue;
      saved[name] = write;
      store[name] = function (this: unknown, id: string, ...rest: unknown[]) {
        if (id === index) throw new Error('zz-index-append-failed');
        return write.call(this, id, ...rest);
      };
    }
    let lines: string[] = [];
    try {
      lines = await linesDuring(() => b.removeMessage(gone));
    } finally {
      for (const [name, write] of Object.entries(saved)) store[name] = write;
    }
    assert.ok(lines.some((line) => line.includes(`taking removed message ${gone} out of the window failed`)), lines.join('\n'));
    assert.notEqual(b.ordinalOf(gone), undefined, 'the tombstone wasn\'t written');
    assert.ok(!coveredRows(b, sb).has(gone), 'the removal stands, and the strategy let go of the row all the same');
    assert.deepEqual(b.retractAbsentRows(), [gone]);
    assert.equal(b.ordinalOf(gone), undefined);
    assert.ok(!coveredRows(b, sb).has(gone));
    await drain(b);
    await rendersWindowOnce(b, 'after the repair');
    a.close();
    b.close();
  });

  it('KnowledgeStrategy, which inherits the hook, lets go of the row too', async () => {
    const make = () => new KnowledgeStrategy({ ...FOLDING, mergeThreshold: 3 }) as unknown as AutobiographicalStrategy;
    const { a, b, sb, rowIds } = await residents(make);
    const gone = rowIds.find((id) => coveredRows(b, sb).has(id));
    assert.ok(gone, 'premise: B folded a row');
    a.removeMessage(gone);
    assert.ok(coveredRows(b, sb).has(gone), 'premise: B hasn\'t heard the removal');
    await linesDuring(() => {
      assert.deepEqual(b.retractRemoved([gone]), [gone]);
    });
    assert.ok(!coveredRows(b, sb).has(gone), 'no summary of B covers the removed row');
    await drain(b);
    assert.ok(!coveredRows(b, sb).has(gone));
    await rendersWindowOnce(b, 'B drained');
    a.close();
    b.close();
  });
});
