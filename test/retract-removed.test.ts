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
 * - The strategy isn't told: the store holds no row to give it.
 * - A row of an auxiliary slot the manager no longer merges reads as
 *   removed (the caveat their doc comments state).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, PassthroughStrategy, windowIndexStateId } from '../src/index.js';
import type { MessageId, StoredMessage, StrategyContext } from '../src/index.js';
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

/** Passthrough that keeps the rows each onRetracted call was given. */
class Records extends PassthroughStrategy {
  retracted: MessageId[][] = [];
  async onRetracted(rows: readonly StoredMessage[], _ctx: StrategyContext): Promise<void> {
    this.retracted.push(rows.map((m) => m.id));
  }
}

/**
 * Makes the `failing`-th append to the index from now on throw, as a full disk
 * would; returns the undo. A write is cut short partway only where each
 * item is one record, on a chronicle without the batched identity append,
 * so the window index writes so while this is installed
 * (perItemIndexWrites); window-batches.test.ts has the batched form.
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

  it('tell the strategy nothing, since the store holds no row to give it', async () => {
    const strategy = new Records();
    const { writer, cm } = await writerAndReader(strategy);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    writer.removeMessage(a);
    writer.removeMessage(b);
    assert.deepEqual(cm.retractRemoved([a]), [a]);
    assert.deepEqual(cm.retractAbsentRows(), [b]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(strategy.retracted, []);
    // retractRows of a held row still tells it.
    cm.retractRows([c]);
    assert.deepEqual(strategy.retracted, [[c]]);
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
