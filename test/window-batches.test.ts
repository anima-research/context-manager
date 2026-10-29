/**
 * Batched window writes (agent-framework #291, src/window-index.ts,
 * WindowIndex.write).
 *
 * - Through chronicle's identity-stamped batched append, which
 *   context-manager requires (chronicle ^0.6.0), a write-down, the rows of
 *   one presentRows call and the tombstones of one call are one record
 *   each, at one sequence. A single row is one record through the
 *   single form, as before, and a store whose window writes are all single
 *   keeps its MANIFEST at version 1; the first batch moves it to version 2.
 * - The window is the same as one an index written one record per item
 *   gives (pre-release builds wrote one so, before batched writes): the
 *   index's items (apart from the record each names), its ordinals, the
 *   presented and unpresented listings, each row's status and the compile,
 *   over a write-down of many rows and a workload of presentations,
 *   retracts, removals and a redo, before and after a reopen.
 * - A batch is one presentation point: branchAt of any row a call presented
 *   cuts after the whole call, and a derive at a sequence takes the call
 *   whole or not at all, so a body presented in one call is never split.
 * - A batch that throws writes nothing: a write-down leaves legacy mode as
 *   it was, a presentation enters no row and tells the strategy nothing, a
 *   retract takes nothing out, and the next call writes the whole of it.
 * - A write-down an index written one record per item left cut short is
 *   finished in one record.
 * - A store handle without the batched append is refused at open, before
 *   any record changes; a handle that loses it after open is refused at a
 *   write of several items, which writes nothing, and a single row is
 *   written as before.
 * - A write the store kept and then threw on, or one an index written one
 *   record per item cut short, tells the strategy what it did before the
 *   error is thrown on; a refused repair batch tells it nothing.
 *
 * test/_harness/index-writes.ts stands in for the batched append on a
 * store handle, one record per item, to write such an index.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, windowIndexStateId } from '../src/index.js';
import type { CompileResult, MessageId, StoredMessage } from '../src/index.js';
import { batchesIndexWrites, perItemIndexWrites } from './_harness/index-writes.js';

const BASE = './test-window-batches';
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

const skipWithoutViews =
  typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function'
    ? false
    : 'installed @animalabs/chronicle has no JsStore.view (branch-bound handles)';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const INDEX = windowIndexStateId('zz-agent');

/** Passthrough that stores a message of two or more blocks as one shard per block. */
class Sharding extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    const first = (content[0] as { text: string }).text;
    return { bodyGroupId: `zz-doc-${first}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

/** Sharding that keeps the ids each onPresented and onRetracted call was given. */
class Hearing extends Sharding {
  presented: MessageId[][] = [];
  retracted: MessageId[][] = [];
  async onPresented(rows: readonly StoredMessage[]): Promise<void> {
    this.presented.push(rows.map((m) => m.id));
  }
  async onRetracted(rows: readonly StoredMessage[]): Promise<void> {
    this.retracted.push(rows.map((m) => m.id));
  }
}

/** The first text of each compiled message, in order. */
function texts(result: CompileResult): string[] {
  return result.messages.map((m) => {
    const first = m.content.find((b) => b.type === 'text') as { text: string } | undefined;
    return first?.text ?? m.content.map((b) => b.type).join('+');
  });
}

const ids = (messages: ReadonlyArray<{ id: MessageId }>) => messages.map((m) => m.id);

/** The index's items as stored, with the `at` and `by` of the record that wrote each. */
function indexItems(cm: ContextManager): Array<{ id?: MessageId; retract?: MessageId; undone?: true; v?: number; at: number; by: string }> {
  return (cm.getStore().getStateJson(INDEX) as Array<{ id?: MessageId; at: number; by: string }> | null) ?? [];
}

/** How many records wrote the index's items from ordinal `from` on. */
function recordsFrom(cm: ContextManager, from = 0): number {
  return new Set(indexItems(cm).slice(from).map((item) => item.by)).size;
}

/** The format version a store's MANIFEST names. */
function manifestVersion(path: string): number {
  return readFileSync(join(path, 'MANIFEST'))[4]!;
}

/** Makes the next batched append to the window index throw, as a full disk would; returns the undo. */
function failNextBatch(cm: ContextManager): () => void {
  const store = cm.getStore() as unknown as Record<string, unknown>;
  const own = Object.prototype.hasOwnProperty.call(store, 'appendManyToStateJsonWithIdentity');
  const batched = store.appendManyToStateJsonWithIdentity as (this: unknown, id: string, ...rest: unknown[]) => unknown;
  let failed = false;
  store.appendManyToStateJsonWithIdentity = function (this: unknown, id: string, ...rest: unknown[]) {
    if (id === INDEX && !failed) {
      failed = true;
      throw new Error('zz-index-batch-failed');
    }
    return batched.call(this, id, ...rest);
  };
  return () => {
    if (own) store.appendManyToStateJsonWithIdentity = batched;
    else delete store.appendManyToStateJsonWithIdentity;
  };
}

/**
 * Makes the next batched append to the window index write its record and
 * then throw, as a failure after the store kept the write would; returns
 * the undo.
 */
function keepThenThrowNextBatch(cm: ContextManager): () => void {
  const store = cm.getStore() as unknown as Record<string, unknown>;
  const own = Object.prototype.hasOwnProperty.call(store, 'appendManyToStateJsonWithIdentity');
  const batched = store.appendManyToStateJsonWithIdentity as (this: unknown, id: string, ...rest: unknown[]) => unknown;
  let failed = false;
  store.appendManyToStateJsonWithIdentity = function (this: unknown, id: string, ...rest: unknown[]) {
    const written = batched.call(this, id, ...rest);
    if (id === INDEX && !failed) {
      failed = true;
      throw new Error('zz-index-batch-kept-then-failed');
    }
    return written;
  };
  return () => {
    if (own) store.appendManyToStateJsonWithIdentity = batched;
    else delete store.appendManyToStateJsonWithIdentity;
  };
}

/**
 * Makes the window index write one record per item (perItemIndexWrites),
 * the `failing`-th of its appends from now on throwing, as a full disk
 * would; returns the undo.
 */
function failItemAppend(cm: ContextManager, failing: number): () => void {
  const store = cm.getStore() as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
  const append = store.appendToStateJsonWithIdentity;
  const perItem = perItemIndexWrites(cm.getStore());
  let appends = 0;
  store.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
    if (id === INDEX && ++appends === failing) throw new Error('zz-index-append-failed');
    return append.call(this, id, ...rest);
  };
  return () => {
    store.appendToStateJsonWithIdentity = append;
    perItem();
  };
}

/** Hearing that keeps each onRetracted call's ids too, and each hook's calls in one log. */
class HearingIds extends Hearing {
  retractedIds: MessageId[][] = [];
  log: string[] = [];
  async onPresented(rows: readonly StoredMessage[]): Promise<void> {
    this.log.push(`presented ${rows.map((m) => m.id).join(',')}`);
    await super.onPresented(rows);
  }
  async onRetracted(rows: readonly StoredMessage[], _ctx?: unknown, info?: { ids: readonly MessageId[] }): Promise<void> {
    this.retractedIds.push([...(info?.ids ?? [])]);
    this.log.push(`retracted ${(info?.ids ?? []).join(',')}`);
    await super.onRetracted(rows);
  }
}

describe('one record per write', () => {
  it('a write-down, one presentRows call and one retract call are one record each; a single row is one record, as before', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new Sharding() });
    assert.ok(batchesIndexWrites(cm.getStore()), 'setup: the store appends a batch as one record');
    const rows = ['u1', 'a1', 'u2', 'a2'].map((t, i) => cm.addMessage(i % 2 ? 'Claude' : 'User', [text(t)]));
    const doc = cm.addMessage('User', [text('p0'), text('p1'), text('p2')]);
    const shards = ids(cm.getAllMessages()).slice(4);
    assert.equal(shards.length, 3, 'setup: the body is stored as three shards');
    const head = cm.getStore().currentSequence();

    cm.presentRows([]);
    const writtenDown = indexItems(cm);
    assert.deepEqual(writtenDown.map((item) => item.id ?? item.v), [...rows, ...shards, 1], 'every row in record order, then the header');
    assert.equal(recordsFrom(cm), 1, 'the write-down is one record');
    assert.equal(cm.getStore().currentSequence(), head + 1);
    assert.ok(writtenDown.every((item) => item.at === head + 1), 'every item carries the one record\'s sequence');
    assert.equal(cm.windowMode(), 'presented');

    const x = cm.addMessage('Other', [text('x')]);
    const y = cm.addMessage('Claude', [text('y')]);
    const z = cm.addMessage('Claude', [text('z')]);
    let from = cm.indexLength();
    assert.deepEqual(cm.presentRows([y, x]), [from, from + 1]);
    assert.equal(recordsFrom(cm, from), 1, 'one call\'s rows are one record');
    from = cm.indexLength();
    cm.presentRows([z]);
    assert.equal(recordsFrom(cm, from), 1);
    assert.equal(indexItems(cm).at(-1)!.at, cm.getStore().currentSequence(), 'a single row is its own record');

    from = cm.indexLength();
    cm.retractRows([x, y, doc], { undone: true });
    assert.deepEqual(
      indexItems(cm).slice(from).map((item) => item.retract),
      [x, y, ...shards],
      'a tombstone for each row named, every shard of the body',
    );
    assert.equal(recordsFrom(cm, from), 1, 'one call\'s tombstones are one record');

    from = cm.indexLength();
    cm.removeMessages(rows[1]!, rows[2]!);
    assert.deepEqual(indexItems(cm).slice(from).map((item) => item.retract), [rows[1], rows[2]]);
    assert.equal(recordsFrom(cm, from), 1, 'a removal\'s tombstones are one record');

    assert.deepEqual(texts(await cm.compile(BIG)), ['u1', 'a2', 'z']);
    cm.close();
    assert.equal(manifestVersion(path), 2, 'the first batch moved the MANIFEST to version 2');
  });

  it('a store whose window writes are all single rows keeps its MANIFEST at version 1', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]); // an empty record's write-down is its header alone
    const [a, b] = ['a', 'b'].map((t) => {
      const id = cm.addMessage('User', [text(t)]);
      cm.presentRows([id]);
      return id;
    }) as [MessageId, MessageId];
    cm.retractRows([a]);
    cm.removeMessage(b);
    assert.equal(cm.indexLength(), 5);
    assert.equal(recordsFrom(cm), 5, 'one record per item');
    assert.equal(manifestVersion(path), 1);

    const [c, d] = ['c', 'd'].map((t) => cm.addMessage('User', [text(t)]));
    cm.presentRows([c!, d!]);
    assert.equal(manifestVersion(path), 2, 'until a call writes two items');
    cm.close();
  });
});

/** A row's label: the text of its first block, which names it across two stores whose record ids differ. */
function labelOf(message: StoredMessage): string {
  const first = message.content[0] as { text?: string } | undefined;
  return first?.text ?? '?';
}

/**
 * The same workload on a fresh store: many rows (some bodies stored as
 * shards) written down, then rows presented out of record order, an undone
 * turn's rows and others taken out, a range removed, a row removed through
 * another manager and repaired, and a redo. With `perItem`, the index is
 * written one record per item, as pre-release builds wrote it
 * (perItemIndexWrites).
 * Returns what the window says, by label, and how many records wrote it.
 */
async function workload(rows: number, perItem: boolean) {
  const path = freshPath();
  const cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new Sharding() });
  const store = cm.getStore();
  const restore = perItem ? perItemIndexWrites(store) : () => {};
  const labels = new Map<MessageId, string>();
  const named = new Map<string, MessageId>();
  const label = () => {
    for (const m of cm.getAllMessages()) if (!labels.has(m.id)) {
      labels.set(m.id, labelOf(m));
      named.set(labelOf(m), m.id);
    }
  };
  const add = (who: string, ...parts: string[]) => cm.addMessage(who, parts.map(text));
  const id = (l: string) => named.get(l)!;
  try {
    // Snapshots are off while the rows are stored, to keep the setup
    // short; every write to the window runs with them on.
    store.setAutoSnapshot(false);
    for (let i = 0; i < rows; i++) {
      if (i % 50 === 7) add('User', `r${i}.0`, `r${i}.1`, `r${i}.2`);
      else add(i % 2 ? 'Claude' : 'User', `r${i}`);
    }
    store.setAutoSnapshot(true);
    label();
    cm.presentRows([]);
    for (let i = 0; i < 6; i++) add(i % 3 ? 'Other' : 'Claude', `n${i}`);
    add('Other', 'd0', 'd1');
    label();
    cm.presentRows([id('n1'), id('n0'), id('d0'), id('n3')]);
    cm.presentRows([id('n2')]);
    cm.retractRows([id('n0'), id('d0'), id('r3')], { undone: true });
    cm.retractRows([id('r5'), id(`r${rows - 1}`)]);
    cm.removeMessages(id('r10'), id('r12'));
    const other = await ContextManager.open({ store, namespace: 'zz-other', strategy: new PassthroughStrategy() });
    other.removeMessage(id('r20'));
    other.close();
    const repaired = cm.retractAbsentRows();
    cm.presentRows([id('d0'), id('n0'), id('r3')]);
    const state = async (manager: ContextManager) => {
      const of = (rowId: MessageId) => labels.get(rowId) ?? `?${rowId}`;
      return {
        mode: manager.windowMode(),
        length: manager.indexLength(),
        presentedLength: manager.presentedLength(),
        items: indexItems(manager).map(({ at: _at, by: _by, ...item }) => ({
          ...item,
          ...(item.id === undefined ? {} : { id: of(item.id) }),
          ...(item.retract === undefined ? {} : { retract: of(item.retract) }),
        })),
        window: manager.getPresentedMessages().map((m) => of(m.id)),
        unpresented: manager.getUnpresentedMessages().map((m) => of(m.id)),
        ordinals: [...labels].map(([rowId, l]) => [l, manager.ordinalOf(rowId) ?? null]),
        statuses: [...labels].map(([rowId, l]) => [l, manager.windowStatusOf(rowId)]),
        compiled: texts(await manager.compile(BIG)),
      };
    };
    const before = await state(cm);
    const records = recordsFrom(cm);
    const repairedLabels = repaired.map((rowId) => labels.get(rowId));
    cm.close();
    const reopened = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new Sharding() });
    const afterReopen = await state(reopened);
    reopened.close();
    return { before, afterReopen, records, repaired: repairedLabels };
  } finally {
    restore();
  }
}

describe('the window is the same, batched or one record per item', () => {
  it('a write-down of many rows and a workload over it give the same items, ordinals, listings, statuses and compile, before and after a reopen', { timeout: 600_000 }, async () => {
    const ROWS = 600;
    const batched = await workload(ROWS, false);
    const perItem = await workload(ROWS, true);
    assert.deepEqual(batched.before, perItem.before);
    assert.deepEqual(batched.afterReopen, perItem.afterReopen);
    assert.deepEqual(batched.afterReopen, batched.before, 'a reopen reads the window as it was');
    assert.deepEqual(batched.repaired, ['r20'], 'the row removed through another manager is taken out');
    assert.deepEqual(perItem.repaired, ['r20']);

    // What differs is the records: one per write against one per item.
    const items = batched.before.items.length;
    assert.ok(items > ROWS, `setup: the write-down wrote every row (${items} items)`);
    assert.equal(perItem.records, items, 'one record per item');
    assert.equal(batched.records, 8, 'one record per write: the write-down, three presentRows, two retractRows, the range removal and the repair');
    assert.equal(batched.before.window.at(-1), 'r3');
  });
});

describe('a batch is one presentation point', () => {
  it('branchAt of any row one call presented cuts after the whole call; a row presented in a call of its own is cut there', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    const u = cm.addMessage('User', [text('u')]);
    cm.presentRows([]);
    const p = cm.addMessage('Claude', [text('p')]);
    const doc = cm.addMessage('Other', [text('q0'), text('q1')]);
    const r = cm.addMessage('Claude', [text('r')]);
    const s = cm.addMessage('Claude', [text('s')]);
    const [q0, q1] = ids(cm.getAllMessages()).slice(2, 4) as [MessageId, MessageId];
    cm.presentRows([r, doc, p]); // one boundary's rows
    const call = cm.getStore().currentSequence();
    cm.presentRows([s]);
    const main = cm.currentBranch().name;

    assert.deepEqual([p, doc, q1, r].map((id) => cm.branchSequenceOf(id)), [call, call, call, call], 'every row of the call, a body\'s later shard too, is cut at the call\'s one record');
    assert.ok(cm.branchSequenceOf(s) > call);

    const atP = cm.branchAt(p, 'zz-at-p');
    await cm.switchBranch(atP);
    assert.deepEqual(ids(cm.getPresentedMessages()), [u, r, q0, q1, p], 'the whole call is in the new branch\'s window, the rows presented after p in it too');
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [s]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['u', 'r', 'q0', 'q1', 'p']);

    // p is the call's last row, so a cut per row would give that window
    // too. r is its first: a cut at r keeps the rows the call presented
    // after it, where one record per row would keep [u, r] alone.
    await cm.switchBranch(main);
    const atR = cm.branchAt(r, 'zz-at-r');
    await cm.switchBranch(atR);
    assert.deepEqual(ids(cm.getPresentedMessages()), [u, r, q0, q1, p], 'a cut at the first row of the call keeps the rows it presented after that row');
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [s]);

    await cm.switchBranch(main);
    const atS = cm.branchAt(s, 'zz-at-s');
    await cm.switchBranch(atS);
    assert.deepEqual(ids(cm.getPresentedMessages()), [u, r, q0, q1, p, s]);
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    cm.close();
  });

  it('a derive at a sequence takes a call whole or not at all, so a body presented in one call is never split', { skip: skipWithoutViews }, async () => {
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    parent.presentRows([]);
    const u = parent.addMessage('User', [text('u')]);
    const doc = parent.addMessage('User', [text('p0 '), text('p1 '), text('p2 ')]);
    const body = ids(parent.getAllMessages()).slice(1);
    assert.equal(body.length, 3, 'setup: the body is stored as three shards');
    const before = parent.getStore().currentSequence();
    parent.presentRows([u, doc]);
    assert.equal(parent.getStore().currentSequence(), before + 1, 'setup: the call is one record');
    // A later write, so both cuts below are in history, not at the head,
    // which derive takes as a derive at the head (house #350, untested 8).
    const v = parent.addMessage('User', [text('v')]);
    parent.presentRows([v]);
    assert.ok(parent.getStore().currentSequence() > before + 1, 'setup: the head is past the call');

    const without = await parent.derive({ branch: 'zz/before-call', strategy: new Sharding(), atSequence: before });
    assert.deepEqual(ids(without.getPresentedMessages()), []);
    assert.deepEqual(ids(without.getUnpresentedMessages()), [u, ...body]);
    const withCall = await parent.derive({ branch: 'zz/at-call', strategy: new Sharding(), atSequence: before + 1 });
    assert.deepEqual(ids(withCall.getPresentedMessages()), [u, ...body]);
    assert.deepEqual(withCall.getUnpresentedMessages(), []);
    assert.deepEqual(texts(await withCall.compile(BIG)), ['u', 'p0 ', 'p1 ', 'p2 ']);
    without.close();
    withCall.close();
    parent.close();
  });
});

describe('a batch that throws writes nothing', () => {
  it('a write-down leaves legacy mode as it was, and the next call writes it whole in one record', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const rows = ['a', 'b', 'c'].map((t) => cm.addMessage('User', [text(t)]));
    const restore = failNextBatch(cm);
    try {
      assert.throws(() => cm.presentRows([]), /zz-index-batch-failed/);
      assert.deepEqual(indexItems(cm), [], 'nothing is written');
      assert.equal(cm.windowMode(), 'legacy');
      assert.deepEqual(ids(cm.getPresentedMessages()), rows, 'the window is still the record');

      cm.presentRows([]);
    } finally {
      restore();
    }
    assert.deepEqual(indexItems(cm).map((item) => item.id ?? item.v), [...rows, 1]);
    assert.equal(recordsFrom(cm), 1);
    assert.equal(cm.windowMode(), 'presented');
    cm.close();
  });

  it('a presentation enters no row and tells the strategy nothing; a retract takes nothing out; the next call writes it whole', async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const a = cm.addMessage('User', [text('a')]);
    const doc = cm.addMessage('Other', [text('d0'), text('d1')]);
    const body = ids(cm.getAllMessages()).slice(1);
    const length = cm.indexLength();

    let restore = failNextBatch(cm);
    try {
      assert.throws(() => cm.presentRows([a, doc]), /zz-index-batch-failed/);
    } finally {
      restore();
    }
    assert.equal(cm.indexLength(), length, 'nothing is written');
    assert.deepEqual(strategy.presented, [], 'the strategy hears nothing');
    assert.deepEqual([a, ...body].map((id) => cm.windowStatusOf(id)), ['out', 'out', 'out'], 'no shard of the body is in the window');
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [a, ...body]);

    assert.deepEqual(cm.presentRows([a, doc]), [length, length + 1]);
    assert.deepEqual(strategy.presented, [[a, ...body]]);

    restore = failNextBatch(cm);
    try {
      assert.throws(() => cm.retractRows([a, doc], { undone: true }), /zz-index-batch-failed/);
    } finally {
      restore();
    }
    assert.equal(cm.indexLength(), length + 3, 'nothing is written');
    assert.deepEqual(strategy.retracted, [], 'the strategy hears nothing');
    assert.deepEqual([a, ...body].map((id) => cm.windowStatusOf(id)), ['in', 'in', 'in']);
    cm.retractRows([a, doc], { undone: true });
    assert.deepEqual(strategy.retracted, [[a, ...body]]);
    assert.deepEqual([a, ...body].map((id) => cm.windowStatusOf(id)), ['undone', 'undone', 'undone']);
    cm.close();
  });

  it('a repair takes nothing out, and the next call takes every row out', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const rows = ['a', 'b', 'c'].map((t) => cm.addMessage('User', [text(t)]));
    cm.presentRows(rows);
    const other = await ContextManager.open({ store: cm.getStore(), namespace: 'zz-other', strategy: new PassthroughStrategy() });
    other.removeMessages(rows[0]!, rows[1]!);
    other.close();
    const ordinals = rows.map((id) => cm.ordinalOf(id));

    const restore = failNextBatch(cm);
    try {
      assert.throws(() => cm.retractAbsentRows(), /zz-index-batch-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(rows.map((id) => cm.ordinalOf(id)), ordinals, 'every ordinal stays issued');
    assert.deepEqual(cm.retractAbsentRows(), [rows[0], rows[1]]);
    assert.deepEqual(rows.map((id) => cm.ordinalOf(id)), [undefined, undefined, ordinals[2]]);
    cm.close();
  });
});

// House review of #350, untested contract 6: a refused batch of a repair
// tells the strategy nothing, for retractAbsentRows and retractRemoved alike.
describe('a refused repair batch', () => {
  for (const repair of ['retractAbsentRows', 'retractRemoved'] as const) {
    it(`${repair}: takes nothing out and tells the strategy nothing; the next call takes every row out and tells it`, async () => {
      const strategy = new HearingIds();
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      const rows = ['a', 'b', 'c'].map((t) => cm.addMessage('User', [text(t)]));
      cm.presentRows(rows);
      const other = await ContextManager.open({ store: cm.getStore(), namespace: 'zz-other', strategy: new PassthroughStrategy() });
      other.removeMessages(rows[0]!, rows[1]!);
      other.close();
      const ordinals = rows.map((id) => cm.ordinalOf(id));
      const run = () => (repair === 'retractAbsentRows' ? cm.retractAbsentRows() : cm.retractRemoved(rows));
      const restore = failNextBatch(cm);
      try {
        assert.throws(run, /zz-index-batch-failed/);
      } finally {
        restore();
      }
      assert.deepEqual(rows.map((id) => cm.ordinalOf(id)), ordinals, 'every ordinal stays issued');
      assert.deepEqual(strategy.retractedIds, [], 'the strategy is told nothing');
      assert.deepEqual(run(), [rows[0], rows[1]]);
      assert.deepEqual(strategy.retractedIds, [[rows[0], rows[1]]], 'the next call tells it, by the rows\' ids');
      cm.close();
    });
  }
});

// House review of #350, untested contract 2: a write that throws after the
// store kept some or all of it tells the strategy what it did before the
// error is thrown on.
describe('a write cut short tells the strategy what it did', () => {
  it('a batched presentRows the store kept and then threw on: the strategy hears every row, then the call throws', async () => {
    const strategy = new HearingIds();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const rows = ['a', 'b'].map((t) => cm.addMessage('User', [text(t)]));
    const restore = keepThenThrowNextBatch(cm);
    try {
      assert.throws(() => cm.presentRows(rows), /zz-index-batch-kept-then-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(rows.map((id) => cm.windowStatusOf(id)), ['in', 'in'], 'setup: the store kept the write');
    assert.deepEqual(strategy.log, [`presented ${rows.join(',')}`], 'the strategy heard the rows that entered');
    assert.throws(() => cm.presentRows(rows), /in the window already/, 'no later call presents them again');
    cm.close();
  });

  it('a batched retractRows the store kept and then threw on: the strategy is told every row, then the call throws', async () => {
    const strategy = new HearingIds();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const rows = ['a', 'b'].map((t) => cm.addMessage('User', [text(t)]));
    cm.presentRows(rows);
    strategy.log.length = 0;
    const restore = keepThenThrowNextBatch(cm);
    try {
      assert.throws(() => cm.retractRows(rows, { undone: true }), /zz-index-batch-kept-then-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(rows.map((id) => cm.windowStatusOf(id)), ['undone', 'undone'], 'setup: the store kept the write');
    assert.deepEqual(strategy.log, [`retracted ${rows.join(',')}`], 'the strategy was told the rows that left');
    cm.close();
  });

  it('in an index written one record per item, a presentRows cut short: the strategy hears the rows that entered before it', async () => {
    const strategy = new HearingIds();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const rows = ['a', 'b', 'c'].map((t) => cm.addMessage('User', [text(t)]));
    const restore = failItemAppend(cm, 3);
    try {
      assert.throws(() => cm.presentRows(rows), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(rows.map((id) => cm.windowStatusOf(id)), ['in', 'in', 'out'], 'setup: the write stopped at c');
    assert.deepEqual(strategy.log, [`presented ${rows.slice(0, 2).join(',')}`]);
    cm.presentRows([rows[2]!]);
    assert.deepEqual(strategy.log.slice(1), [`presented ${rows[2]}`], 'the next call presents the rest, and only it is heard');
    cm.close();
  });

  it('in an index written one record per item, a retractRows cut short: the strategy is told the rows that left before it', async () => {
    const strategy = new HearingIds();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const rows = ['a', 'b', 'c'].map((t) => cm.addMessage('User', [text(t)]));
    cm.presentRows(rows);
    strategy.log.length = 0;
    const restore = failItemAppend(cm, 2);
    try {
      assert.throws(() => cm.retractRows(rows), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(rows.map((id) => cm.windowStatusOf(id)), ['out', 'in', 'in'], 'setup: the write stopped at b');
    assert.deepEqual(strategy.log, [`retracted ${rows[0]}`]);
    cm.close();
  });
});

describe('an index written one record per item', () => {
  it('a write-down it cut short is finished in one record, and the rows it wrote keep their ordinals', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const rows = ['a', 'b', 'c', 'd', 'e'].map((t) => cm.addMessage('User', [text(t)]));
    const store = cm.getStore() as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
    const append = store.appendToStateJsonWithIdentity;
    const batched = perItemIndexWrites(cm.getStore());
    let appends = 0;
    store.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
      if (id === INDEX && ++appends === 3) throw new Error('zz-index-append-failed');
      return append.call(this, id, ...rest);
    };
    try {
      assert.throws(() => cm.presentRows([]), /zz-index-append-failed/);
    } finally {
      store.appendToStateJsonWithIdentity = append;
      batched();
    }
    assert.deepEqual(indexItems(cm).map((item) => item.id), rows.slice(0, 2), 'setup: two rows written, one record each, and no header');
    assert.equal(cm.windowMode(), 'legacy');

    cm.presentRows([]);
    assert.deepEqual(indexItems(cm).map((item) => item.id ?? item.v), [...rows, 1]);
    assert.equal(recordsFrom(cm, 2), 1, 'the rest of the write-down, and its header, are one record');
    assert.deepEqual(rows.map((id) => cm.ordinalOf(id)), [0, 1, 2, 3, 4]);
    assert.equal(cm.windowMode(), 'presented');
    cm.close();
  });
});

describe('a store handle without the batched append', () => {
  it('is refused at open, before any record changes', async () => {
    // An app-owned store (the README allows passing one) from a chronicle
    // before 0.6.0: the manager refuses it when it is opened, not later at a
    // removal whose tombstones it could not write.
    const store = JsStore.openOrCreate({ path: freshPath() });
    try {
      const handle = store as unknown as Record<string, unknown>;
      handle.appendManyToStateJsonWithIdentity = undefined;
      await assert.rejects(
        ContextManager.open({ store, namespace: 'zz-agent', strategy: new Hearing() }),
        /ContextManager: the store handle has no appendManyToStateJsonWithIdentity, .*install @animalabs\/chronicle \^0\.6\.0/,
      );
    } finally {
      delete (store as unknown as Record<string, unknown>).appendManyToStateJsonWithIdentity;
      store.close();
    }
  });

  it('is refused at a write of several items, which writes nothing; a single row is written as before', async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('User', [text(t)])) as [MessageId, MessageId];
    const handle = cm.getStore() as unknown as Record<string, unknown>;
    // A handle as a chronicle before 0.6.0 gives one.
    const older = () => {
      handle.appendManyToStateJsonWithIdentity = undefined;
      return () => {
        delete handle.appendManyToStateJsonWithIdentity;
      };
    };
    const refused = /ContextManager: the store handle has no appendManyToStateJsonWithIdentity, .*install @animalabs\/chronicle \^0\.6\.0/;

    let restore = older();
    const head = cm.getStore().currentSequence();
    try {
      assert.throws(() => cm.presentRows([]), refused, 'the write-down is several items');
      assert.throws(() => cm.retractRows([a]), refused, 'and so is the one before a retract in legacy mode');
    } finally {
      restore();
    }
    assert.equal(cm.getStore().currentSequence(), head, 'nothing is written, not even the index state\'s registration');
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(indexItems(cm), []);
    assert.equal(cm.getPresentedMessages(), cm.getAllMessages(), 'the window is still the record');

    cm.presentRows([]);
    assert.deepEqual(indexItems(cm).map((item) => item.id ?? item.v), [a, b, 1], 'with the batched append back, the write-down is whole');
    const [c, d, e] = ['c', 'd', 'e'].map((t) => cm.addMessage('Other', [text(t)])) as [MessageId, MessageId, MessageId];
    strategy.presented.length = 0;
    restore = older();
    try {
      const next = cm.indexLength();
      assert.deepEqual(cm.presentRows([c]), [next], 'a single row goes through the single form');
      assert.throws(() => cm.presentRows([d, e]), refused);
      assert.deepEqual([cm.windowStatusOf(d), cm.windowStatusOf(e)], ['out', 'out'], 'neither row entered');
      assert.equal(cm.indexLength(), next + 1);
      assert.throws(() => cm.retractRows([a, b]), refused);
      assert.deepEqual([cm.windowStatusOf(a), cm.windowStatusOf(b)], ['in', 'in'], 'nothing taken out');
    } finally {
      restore();
    }
    assert.deepEqual(strategy.presented, [[c]], 'the strategy heard only the row that entered');
    assert.deepEqual(strategy.retracted, []);
    cm.close();
  });
});
