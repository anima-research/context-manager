/**
 * The window index (agent-framework #291, src/window-index.ts): which stored
 * rows a manager's agent has been shown, in what order, and how every
 * strategy read and compile follows it.
 *
 * - Legacy mode: until a host presents a row, the window is the merged
 *   record itself, read live, and nothing is written, so compiles are what
 *   they were. A reader that merges another slot keeps seeing it grow.
 * - The write-down: the first presentRows, or a retractRows that names a
 *   row, writes the window down, its header last, so one cut short leaves
 *   legacy mode and the next call finishes it. An index in another format
 *   is read as the record and never written to.
 * - Presented mode: the window is the index. A row stored and not presented
 *   stays out of it; rows presented out of record order are compiled in
 *   the window's order, and compile provenance still finds each body.
 * - A body partly in the window (a presentRows cut short, or a derive cut
 *   between its shards' presentations): its missing shards are listed as
 *   unpresented, and naming the body again presents only those, at the end,
 *   so the shards in the window keep their ordinals.
 * - The presented listing keeps the strategies' memo contract: the same
 *   array while the window is unchanged, a new one when it changes, never
 *   one changed in place, and the store's own message objects.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import {
  ContextManager,
  MessageStore,
  PassthroughStrategy,
  windowIndexStateId,
} from '../src/index.js';
import type {
  CompileResult,
  ContextEntry,
  ContextLogView,
  MessageId,
  MessageStoreView,
  RequestIdentity,
  StoredMessage,
  ThinkingBinding,
  TokenBudget,
} from '../src/index.js';
import type { SelectOptions } from '../src/types/index.js';

const BASE = './test-window-index';
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
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** The first text of each compiled message, in order. */
function texts(result: CompileResult): string[] {
  return result.messages.map((m) => {
    const first = m.content.find((b) => b.type === 'text') as { text: string } | undefined;
    return first?.text ?? m.content.map((b) => b.type).join('+');
  });
}

/** The head id of each raw entry's body, in order, with whether it was complete. */
function rawHeads(result: CompileResult): Array<[MessageId, boolean] | null> {
  return result.provenance!.messages.map((m) => (m.kind === 'raw' && m.bodies.length === 1 ? [m.bodies[0]!.messageId, m.bodies[0]!.complete] : null));
}

/** Passthrough that keeps what each select read through its view. */
class Capturing extends PassthroughStrategy {
  seen: Array<{ listing: StoredMessage[]; length: number; tail: StoredMessage[]; from: StoredMessage[] }> = [];
  select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget, opts?: SelectOptions): ContextEntry[] {
    this.seen.push({ listing: store.getAll(), length: store.length(), tail: store.getTail(2), from: store.getFrom(1) });
    return super.select(store, log, budget, opts);
  }
  last() {
    return this.seen[this.seen.length - 1]!;
  }
}

/** Passthrough that stores a message of two or more blocks as one shard per block. */
class Sharding extends Capturing {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: 'zz-doc', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

describe('the window in legacy mode', () => {
  it('is the record itself, read live, and nothing is written until a host presents', async () => {
    const strategy = new Capturing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.addMessage('alice', [text('a')]);
    cm.addMessage('bob', [text('b')]);
    await cm.compile(BIG);
    // The strategy reads the store's own listing, the array getAllMessages
    // gives, as it did before there was a window.
    assert.equal(strategy.last().listing, cm.getAllMessages());
    assert.equal(cm.getPresentedMessages(), cm.getAllMessages());
    assert.equal(cm.windowMode(), 'legacy');
    assert.equal(cm.getStore().getStateJson(windowIndexStateId('zz-agent')), null, 'no index state is written');
    assert.equal(cm.indexLength(), 0);
    assert.equal(cm.ordinalOf(cm.getAllMessages()[0]!.id), undefined);
    assert.deepEqual(cm.getUnpresentedMessages(), []);

    cm.addMessage('alice', [text('c')]);
    const grown = await cm.compile(BIG);
    assert.deepEqual(texts(grown), ['a', 'b', 'c'], 'a write reaches the window at once');
    assert.equal(strategy.last().length, 3);
    assert.equal(cm.presentedLength(), 3);
    assert.equal(cm.getStore().getStateJson(windowIndexStateId('zz-agent')), null);
    cm.close();
  });

  it('a reader merging another slot keeps the live two-slot merge, and takes an index at its first presentation', async () => {
    // The persistent subconscious's shape: its own isolated slot, the
    // shared slot merged in, no filter.
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(),
      namespace: 'subconscious/zz',
      isolate: true,
      strategy: new PassthroughStrategy(),
      auxiliaryMessageViews: [{}],
    });
    main.addMessage('alice', [text('m1')]);
    side.addMessage('Subconscious', [text('s1')]);
    main.addMessage('alice', [text('m2')]);
    assert.deepEqual(texts(await side.compile(BIG)), ['m1', 's1', 'm2']);
    main.addMessage('alice', [text('m3')]);
    const legacy = await side.compile(BIG);
    assert.deepEqual(texts(legacy), ['m1', 's1', 'm2', 'm3'], 'the merge keeps growing while nothing is presented');
    assert.equal(side.windowMode(), 'legacy');
    assert.equal(main.getStore().getStateJson(windowIndexStateId('subconscious/zz')), null);
    const before = side.getPresentedMessages();

    // The first presentation writes the window down as it stands: the same
    // rows, in the same order, the same array, so the compile is the same.
    assert.deepEqual(side.presentRows([]), []);
    assert.equal(side.windowMode(), 'presented');
    assert.equal(side.getPresentedMessages(), before, 'the bootstrap keeps the listing the strategy last read');
    const bootstrapped = await side.compile(BIG);
    assert.deepEqual(bootstrapped.messages, legacy.messages, 'byte-identical across the bootstrap');
    assert.equal(side.indexLength(), 5, 'a header and one item per row');
    assert.equal(main.windowMode(), 'legacy', "another namespace's window is its own");

    // From here the window grows only by presentation.
    const m4 = main.addMessage('alice', [text('m4')]);
    assert.deepEqual(texts(await side.compile(BIG)), ['m1', 's1', 'm2', 'm3'], 'a row stored and not presented stays out');
    assert.deepEqual(side.getUnpresentedMessages().map((m) => m.id), [m4]);
    assert.deepEqual(texts(await main.compile(BIG)), ['m1', 'm2', 'm3', 'm4'], "the writer's own window, still legacy, has it");
    const s2 = side.addMessage('Subconscious', [text('s2')]);
    side.presentRows([s2]);
    const [m4Ordinal] = side.presentRows([m4]);
    const presented = await side.compile(BIG);
    // Positive control: the record, which a legacy compile follows, holds
    // m4 before s2; this compile follows the window instead.
    const record = [...side.getAllMessages(), ...main.getAllMessages()].sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(record.map((m) => (m.content[0] as { text: string }).text), ['m1', 's1', 'm2', 'm3', 'm4', 's2']);
    assert.deepEqual(texts(presented), ['m1', 's1', 'm2', 'm3', 's2', 'm4']);
    assert.equal(m4Ordinal, side.ordinalOf(m4));
    assert.ok(m4Ordinal! > side.ordinalOf(s2)!, 'ordinals follow the window');
    assert.deepEqual(side.getUnpresentedMessages(), []);
    assert.equal(side.newestWindowSequence(), side.getMessage(s2)!.sequence);
    side.close();
    main.close();
  });
});

const INDEX = windowIndexStateId('zz-agent');

/** The index's items as stored, without the `at` and `by` each record adds. */
function indexItems(cm: ContextManager): Array<Record<string, unknown>> {
  const items = (cm.getStore().getStateJson(INDEX) as Array<Record<string, unknown>> | null) ?? [];
  return items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'at' && key !== 'by')));
}

/** Makes the `failing`-th append to the window index from now on throw, as a full disk would; returns the undo. */
function failIndexAppend(cm: ContextManager, failing: number): () => void {
  const store = cm.getStore() as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
  const append = store.appendToStateJsonWithIdentity;
  let appends = 0;
  store.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
    if (id === INDEX && ++appends === failing) throw new Error('zz-index-append-failed');
    return append.call(this, id, ...rest);
  };
  return () => {
    store.appendToStateJsonWithIdentity = append;
  };
}

/** Runs `presentRows([])` with the `failing`-th index append throwing. */
function cutShortWriteDown(cm: ContextManager, failing: number): void {
  const restore = failIndexAppend(cm, failing);
  try {
    assert.throws(() => cm.presentRows([]), /zz-index-append-failed/);
  } finally {
    restore();
  }
}

describe('writing the window down', () => {
  it('cut short at any item, it leaves legacy mode and the whole record, and the next presentRows([]) finishes it once', async () => {
    // Four rows and the header are five items, one record each. The header
    // is the last, so wherever the write-down stops, the index has none and
    // the window is still the record.
    for (let failing = 1; failing <= 5; failing++) {
      const cut = `cut short at item ${failing}`;
      const path = freshPath();
      let cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      const rows = ['a', 'b', 'c', 'd'].map((t) => cm.addMessage('alice', [text(t)]));
      cutShortWriteDown(cm, failing);
      assert.deepEqual(indexItems(cm), rows.slice(0, failing - 1).map((id) => ({ id })), `the rows before the failure are written, and no header, ${cut}`);
      assert.equal(cm.windowMode(), 'legacy', cut);
      assert.equal(cm.indexLength(), 0, cut);
      assert.equal(cm.ordinalOf(rows[0]!), undefined, cut);
      assert.deepEqual(cm.getUnpresentedMessages(), [], cut);
      assert.equal(cm.getPresentedMessages(), cm.getAllMessages(), `the window is the record itself, ${cut}`);
      assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'd'], cut);

      // A restart reads it the same way; a crash that loses the records the
      // store hadn't synced leaves such a prefix too.
      cm.close();
      cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      assert.equal(cm.windowMode(), 'legacy', `after a reopen, ${cut}`);
      const e = cm.addMessage('alice', [text('e')]);
      assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'd', 'e'], `a row stored meanwhile reaches the window at once, ${cut}`);

      // The boot call finishes it: the rows not written yet, each once, in
      // record order after the ones that were, then the header.
      assert.deepEqual(cm.presentRows([]), []);
      assert.equal(cm.windowMode(), 'presented', cut);
      assert.deepEqual(indexItems(cm), [...[...rows, e].map((id) => ({ id })), { v: 1 }], cut);
      assert.deepEqual([...rows, e].map((id) => cm.ordinalOf(id)), [0, 1, 2, 3, 4], cut);
      assert.equal(cm.indexLength(), 6, cut);
      assert.deepEqual(cm.getUnpresentedMessages(), [], cut);
      assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'd', 'e'], cut);

      // From here the window grows only by presentation, and the boot call
      // writes nothing more.
      cm.addMessage('bob', [text('f, not presented')]);
      assert.deepEqual(cm.presentRows([]), []);
      assert.equal(indexItems(cm).length, 6, cut);
      assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'd', 'e'], cut);
      cm.close();
      cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      assert.equal(cm.windowMode(), 'presented', `after a reopen, ${cut}`);
      assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'd', 'e'], `after a reopen, ${cut}`);
      cm.close();
    }
  });

  it('finishing it takes out a row it wrote that the record no longer holds', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
    cutShortWriteDown(cm, 3);
    assert.deepEqual(indexItems(cm), [{ id: a }, { id: b }]);
    // In legacy mode a removal writes nothing: the window is the record.
    cm.removeMessage(b!);
    assert.equal(indexItems(cm).length, 2);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c']);
    // Nor is it in the window, whatever the write-down wrote for it.
    assert.throws(() => cm.retractRows([b!]), new RegExp(`no stored message has id ${b}, and the window holds none`));
    assert.equal(indexItems(cm).length, 2);

    // A call that names a row finishes it as the boot call does.
    assert.deepEqual(cm.presentRows([c!]), [3]);
    assert.deepEqual(indexItems(cm), [{ id: a }, { id: b }, { retract: b }, { id: c }, { v: 1 }]);
    assert.equal(cm.ordinalOf(b!), undefined, 'the removed row is not in the window');
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c']);
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    cm.close();
  });

  it('retractRows([]) writes nothing in either mode; any other retract in legacy mode writes the window down first', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.retractRows([]);
    cm.retractRows([], { undone: true });
    assert.equal(cm.getStore().getStateJson(INDEX), null, 'nothing is written');
    assert.equal(cm.windowMode(), 'legacy');
    const c = cm.addMessage('alice', [text('c')]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c'], 'a later write still reaches the window at once');
    assert.throws(() => cm.retractRows(['zz-no-such-row']), /no stored message has id zz-no-such-row, and the window holds none/);
    assert.equal(cm.getStore().getStateJson(INDEX), null);

    // Any other retract switches the mode: the window is written down as
    // it stands, then the rows named leave it.
    cm.retractRows([b!]);
    assert.equal(cm.windowMode(), 'presented');
    assert.deepEqual(indexItems(cm), [{ id: a }, { id: b }, { id: c }, { v: 1 }, { retract: b }]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c']);
    const d = cm.addMessage('alice', [text('d')]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c'], 'a row stored now enters the window only when presented');
    assert.deepEqual(cm.getUnpresentedMessages().map((m) => m.id), [b, d]);

    cm.retractRows([]);
    assert.equal(indexItems(cm).length, 5, 'nor in presented mode');
    cm.close();
  });

  it('a retract finishes a write-down cut short before it takes its rows out', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
    cutShortWriteDown(cm, 2);
    assert.deepEqual(indexItems(cm), [{ id: a }]);
    cm.retractRows([c!], { undone: true });
    assert.deepEqual(indexItems(cm), [{ id: a }, { id: b }, { id: c }, { v: 1 }, { retract: c, undone: true }]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b']);
    assert.deepEqual(cm.getUnpresentedMessages(), [], "an undone turn's row isn't offered");
    cm.close();
  });

  it('an index in another format reads as the record, with one warning, and is never written to', async () => {
    const cases: Array<[label: string, items: unknown[], says: RegExp]> = [
      ['a header naming format 2', [{ v: 2 }, { ids: ['zz-x'] }], /is in format 2, which this version \(format 1\) doesn't read/],
      // Another format's write-down cut short before its header.
      ['an item it can\'t read and no header', [{ ids: ['zz-x'] }], /holds 1 item\(s\) this version can't read and no header naming their format/],
    ];
    for (const [label, items, says] of cases) {
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
      const store = cm.getStore();
      store.registerState({ id: INDEX, strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
      for (const item of items) store.appendToStateJsonWithIdentity(INDEX, item, 'by', 'at');
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        assert.equal(cm.windowMode(), 'legacy', label);
        assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b'], label);
        assert.equal(cm.getPresentedMessages(), cm.getAllMessages(), label);
        assert.equal(cm.ordinalOf(a!), undefined, label);
        assert.equal(cm.indexLength(), 0, label);
        assert.deepEqual(cm.getUnpresentedMessages(), [], label);
        assert.throws(() => cm.presentRows([]), says, label);
        assert.throws(() => cm.presentRows([b!]), says, label);
        assert.throws(() => cm.retractRows([a!]), says, label);
        cm.retractRows([]);
      } finally {
        console.warn = warn;
      }
      const lines = warned.filter((line) => line.includes('window index'));
      assert.equal(lines.length, 1, `${label}: ${warned.join('\n')}`);
      assert.match(lines[0]!, says, label);
      assert.equal(store.getStateLen(INDEX), items.length, `nothing is written, ${label}`);
      cm.close();
    }
  });
});

describe('the window in presented mode', () => {
  it('compiles rows in the order they were presented, and provenance still finds each body', async () => {
    const strategy = new Sharding();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const a1 = cm.addMessage('alice', [text('a1')]);
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('part 0 '), text('part 1 ')]);
    const b = cm.addMessage('bob', [text('b')]);
    const [doc0, doc1] = cm.getAllMessages().filter((m) => m.bodyGroupId === 'zz-doc');
    assert.equal(doc0!.id, doc);

    // b arrived after the document but is presented before it; the
    // document goes whole, by the id addMessage returned.
    const ordinals = cm.presentRows([b, doc]);
    assert.deepEqual(ordinals, [cm.ordinalOf(b), cm.ordinalOf(doc)]);
    assert.deepEqual(cm.getAllMessages().map((m) => m.id), [a1, doc0!.id, doc1!.id, b], 'the record keeps arrival order');
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a1, b, doc0!.id, doc1!.id]);

    const result = await cm.compile(BIG);
    assert.deepEqual(texts(result), ['a1', 'b', 'part 0 ', 'part 1 ']);
    assert.deepEqual(rawHeads(result), [[a1, true], [b, true], [doc, true], [doc, true]], 'each entry names its own complete body');
    assert.deepEqual(result.rawBodies!.get(doc)!.map((m) => m.id), [doc0!.id, doc1!.id]);
    assert.ok(result.rawBodies!.get(doc)!.every((m, i) => m === cm.getAllMessages()[1 + i]), "the store's own objects");
    const stored = new Map(cm.getAllMessages().map((m) => [m.id, m]));
    assert.ok(cm.getPresentedMessages().every((m) => m === stored.get(m.id)), "the window lists the store's own objects");
    cm.close();
  });

  it('under a view filter, after a write, attribution places the reordered runs without reading a stored message (#273)', async () => {
    const proto = MessageStore.prototype as unknown as { getInternal(index: number): unknown };
    const getInternal = proto.getInternal;
    let reads = 0;
    try {
      const cm = await ContextManager.open({
        path: freshPath(),
        namespace: 'zz-agent',
        strategy: new PassthroughStrategy(),
        viewFilter: (m) => !m.metadata?.tuneOut,
      });
      cm.presentRows([]);
      const shown: MessageId[] = [];
      const hidden: MessageId[] = [];
      for (let i = 0; i < 10; i++) {
        hidden.push(cm.addMessage('bob', [text(`hidden ${i}`)], { tuneOut: { epochId: `e${i}` } }));
        shown.push(cm.addMessage('alice', [text(`shown ${i}`)]));
      }
      // Presented newest first: nothing is in record order any more.
      const order = shown.flatMap((id, i) => [id, hidden[i]!]).reverse();
      cm.presentRows(order);
      await cm.compile(BIG);
      const late = cm.addMessage('alice', [text('late')]);
      cm.presentRows([late]);
      proto.getInternal = function (this: unknown, index: number) {
        reads++;
        return getInternal.call(this, index);
      };
      const result = await cm.compile(BIG);
      proto.getInternal = getInternal;
      const expected = [...[...shown].reverse(), late];
      assert.deepEqual(texts(result), [...Array.from({ length: 10 }, (_, i) => `shown ${9 - i}`), 'late']);
      assert.deepEqual(rawHeads(result), expected.map((id) => [id, true]));
      assert.equal(reads, 0, `compile read ${reads} stored messages one at a time`);
      cm.close();
    } finally {
      proto.getInternal = getInternal;
    }
  });

  it('refuses an unknown id, a row in the window, a row named twice and part of a body, presenting nothing', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    const a = cm.addMessage('alice', [text('a')]);
    // In legacy mode too, an unknown id is refused before anything is written.
    assert.throws(() => cm.presentRows(['zz-no-such-row']), /no stored message has id zz-no-such-row/);
    assert.equal(cm.getStore().getStateJson(windowIndexStateId('zz-agent')), null);
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('part 0 '), text('part 1 ')]);
    const doc1 = cm.getAllMessages().find((m) => m.bodyGroupId === 'zz-doc' && m.shardIndex === 1)!.id;
    const b = cm.addMessage('bob', [text('b')]);
    const length = cm.indexLength();
    const stateLength = cm.getStore().getStateLen(windowIndexStateId('zz-agent'));

    assert.throws(() => cm.presentRows([b, 'zz-no-such-row']), /no stored message has id zz-no-such-row/);
    assert.throws(() => cm.presentRows([b, a]), new RegExp(`${a} is in the window already`));
    assert.throws(() => cm.presentRows([b, b]), new RegExp(`${b} is named twice`));
    assert.throws(() => cm.presentRows([doc1]), /shard 1 of a body stored as shards/);
    assert.throws(() => cm.presentRows([doc1, doc]), /shard 1 of a body stored as shards/);
    assert.throws(() => cm.presentRows([doc, b, doc1]), /shard 1 of a body stored as shards/);
    assert.throws(() => cm.presentRows([doc, doc]), new RegExp(`${doc} is named twice`));
    assert.throws(() => cm.presentRows('zz' as unknown as MessageId[]), TypeError);
    assert.throws(() => cm.presentRows([b, 7 as unknown as MessageId]), TypeError);
    assert.equal(cm.indexLength(), length, 'nothing was presented');
    assert.equal(cm.getStore().getStateLen(windowIndexStateId('zz-agent')), stateLength, 'nothing was written');
    assert.deepEqual(cm.getUnpresentedMessages().map((m) => m.id), [doc, doc1, b]);

    // A body named shard by shard, in order, is the same body.
    cm.presentRows([doc, doc1, b]);
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    cm.close();
    assert.throws(() => cm.presentRows([]), /after close/);
  });

  it('serves the same array while the window is unchanged, and a new one of the same objects when it changes', async () => {
    const strategy = new Capturing();
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const cm = await ContextManager.open({ store: main.getStore(), namespace: 'zz-reader', isolate: true, strategy, auxiliaryMessageViews: [{}] });
    const r1 = main.addMessage('alice', [text('r1')]);
    const own = cm.addMessage('Reader', [text('own')]);
    cm.presentRows([]);
    const first = cm.getPresentedMessages();
    assert.equal(cm.getPresentedMessages(), first, 'asked again');
    await cm.compile(BIG);
    assert.equal(strategy.last().listing, first, 'the strategy reads the same array');

    // A row stored and not presented changes the record, not the window.
    const r2 = main.addMessage('alice', [text('r2')]);
    assert.equal(cm.getPresentedMessages(), first, 'the window did not change');
    assert.deepEqual(first.map((m) => m.id), [r1, own], 'and the array was not changed in place');

    cm.presentRows([r2]);
    const second = cm.getPresentedMessages();
    assert.notEqual(second, first);
    assert.deepEqual(second.map((m) => m.id), [r1, own, r2]);
    assert.ok(second.slice(0, 2).every((m, i) => m === first[i]), 'the rows already there are the same objects');

    cm.editMessage(own, [text('own edited')]);
    const third = cm.getPresentedMessages();
    assert.notEqual(third, second);
    assert.notEqual(third[1], second[1], 'the edited row is a new object');
    assert.equal((third[1]!.content[0] as { text: string }).text, 'own edited');
    assert.equal(third[0], second[0]);
    assert.equal(third[2], second[2]);
    cm.close();
    main.close();
  });

  it('length(), getTail and getFrom read the window, not the record', async () => {
    const strategy = new Capturing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const a = cm.addMessage('alice', [text('a')]);
    cm.presentRows([]);
    const b = cm.addMessage('bob', [text('b')]);
    const c = cm.addMessage('alice', [text('c')]);
    cm.addMessage('bob', [text('d, not presented')]);
    cm.presentRows([c, b]);
    await cm.compile(BIG);
    const seen = strategy.last();
    assert.equal(cm.getMessageCount(), 4, 'the record');
    assert.equal(seen.length, 3, "the strategy's view counts the window");
    assert.equal(cm.presentedLength(), 3);
    assert.deepEqual(seen.listing.map((m) => m.id), [a, c, b]);
    assert.deepEqual(seen.tail.map((m) => m.id), [c, b]);
    assert.deepEqual(seen.from.map((m) => m.id), [c, b]);
    cm.close();
  });

  it('ordinals never move: a row taken out leaves a hole, and comes back at the end', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.presentRows([a!, b!, c!]);
    const [oa, ob, oc] = [a, b, c].map((id) => cm.ordinalOf(id!)!);
    assert.ok(oa! < ob! && ob! < oc!);

    cm.retractRows([b!]);
    assert.equal(cm.ordinalOf(b!), undefined);
    assert.equal(cm.ordinalOf(c!), oc, "a later row's ordinal stays");
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c'], 'and its listing position moves up');
    assert.deepEqual(cm.getUnpresentedMessages().map((m) => m.id), [b], 'arrived, not presented again');
    assert.throws(() => cm.retractRows([b!]), new RegExp(`${b} is not in the window`));

    const [again] = cm.presentRows([b!]);
    assert.ok(again! > oc!, 'presented again at the end');
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c', 'b']);

    // An undone turn's row stays out of what is offered until a redo presents it.
    cm.retractRows([c!], { undone: true });
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b']);
    cm.presentRows([c!]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c']);
    cm.close();
  });

  it('survives a reopen and follows the branch the store is on', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    const y = cm.addMessage('bob', [text('y')]);
    cm.presentRows([y, x]);
    const ordinals = [cm.ordinalOf(x), cm.ordinalOf(y)];
    cm.close();

    cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    assert.equal(cm.windowMode(), 'presented');
    assert.deepEqual(texts(await cm.compile(BIG)), ['y', 'x']);
    assert.deepEqual([cm.ordinalOf(x), cm.ordinalOf(y)], ordinals);

    const main = cm.currentBranch().name;
    await cm.fork('zz-fork');
    const z = cm.addMessage('alice', [text('z')]);
    cm.presentRows([z]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['y', 'x', 'z'], 'the fork took the index as of the branch point');
    await cm.switchBranch(main);
    assert.deepEqual(texts(await cm.compile(BIG)), ['y', 'x']);
    assert.equal(cm.ordinalOf(z), undefined);
    await cm.switchBranch('zz-fork');
    assert.equal(cm.ordinalOf(z), Math.max(...ordinals.map((o) => o!)) + 1);
    cm.close();
  });
});

describe('a body partly in the window', () => {
  // Each row presented is one record, so a presentRows cut short partway
  // through a sharded body, or a branch cut between its shards'
  // presentations, leaves the body's first shards in the window and the
  // rest out. Naming the body again completes it (FW-CM-3).

  /** Sharding that keeps the ids each onPresented call was given. */
  class Hearing extends Sharding {
    heard: MessageId[][] = [];
    async onPresented(rows: readonly StoredMessage[]): Promise<void> {
      this.heard.push(rows.map((m) => m.id));
    }
  }

  /** A row `a`, then a three-shard body whose presentRows was cut short after its first shard. */
  async function cutShortBody() {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const a = cm.addMessage('alice', [text('a')]);
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]);
    const shards = cm.getAllMessages().filter((m) => m.bodyGroupId === 'zz-doc').map((m) => m.id);
    assert.equal(shards[0], doc);
    strategy.heard = [];
    const restore = failIndexAppend(cm, 2);
    try {
      assert.throws(() => cm.presentRows([doc]), /zz-index-append-failed/);
    } finally {
      restore();
    }
    return { cm, strategy, a, doc, p1: shards[1]!, p2: shards[2]! };
  }

  it('presenting the unpresented rows completes it: only the shards it lacks enter, at the end, and the first keeps its ordinal', async () => {
    const { cm, strategy, a, doc, p1, p2 } = await cutShortBody();
    // The call cut short got the first shard in, and the strategy heard it:
    // no later call presents it again.
    assert.deepEqual(strategy.heard, [[doc]]);
    assert.deepEqual(indexItems(cm).slice(-1), [{ id: doc }]);
    const ordinal = cm.ordinalOf(doc)!;
    assert.equal(ordinal, cm.indexLength() - 1);
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a, doc]);
    const partial = await cm.compile(BIG);
    assert.deepEqual(texts(partial), ['a', 'p0 ']);
    assert.deepEqual(rawHeads(partial), [[a, true], [doc, false]]);

    // The shards it lacks are listed, and presenting them, as a host's turn
    // start presents every arrived row, is accepted. Before, the first of
    // them was refused as a later shard named without its first, and every
    // other row of the call with it.
    const unpresented = cm.getUnpresentedMessages().map((m) => m.id);
    assert.deepEqual(unpresented, [p1, p2]);
    strategy.heard = [];
    assert.deepEqual(cm.presentRows(unpresented), [ordinal + 1, ordinal + 2]);
    assert.equal(cm.ordinalOf(doc), ordinal, 'the first shard keeps its ordinal');
    assert.deepEqual(strategy.heard, [[p1, p2]], 'the strategy hears only the shards that entered');
    assert.deepEqual(indexItems(cm).slice(-3), [{ id: doc }, { id: p1 }, { id: p2 }], 'each shard is presented once');
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    const whole = await cm.compile(BIG);
    assert.deepEqual(texts(whole), ['a', 'p0 ', 'p1 ', 'p2 ']);
    assert.deepEqual(rawHeads(whole), [[a, true], [doc, true], [doc, true], [doc, true]], 'compile provenance reports the body complete');

    // Whole again, the body is refused by either name, as any row in the
    // window is, and nothing is written.
    const length = cm.getStore().getStateLen(INDEX);
    assert.throws(() => cm.presentRows([doc]), new RegExp(`${doc} is in the window already`));
    assert.throws(() => cm.presentRows([p1]), new RegExp(`${p1} is in the window already`));
    assert.equal(cm.getStore().getStateLen(INDEX), length);
    cm.close();
  });

  it('naming its first shard completes it too; a later shard is taken only after every shard before it', async () => {
    const { cm, strategy, a, doc, p1, p2 } = await cutShortBody();
    const b = cm.addMessage('bob', [text('b')]);
    const q0 = cm.addMessage('bob', [text('q0 '), text('q1 ')]);
    const q1 = cm.getAllMessages().at(-1)!.id;
    const length = cm.getStore().getStateLen(INDEX);
    assert.throws(
      () => cm.presentRows([p2]),
      new RegExp(`${p2} is shard 2 of a body stored as shards; a body goes whole, named by its first shard's id \\(${doc}\\), or the rest of one partly in the window by the first shard the window lacks`),
      'a shard after one the window lacks',
    );
    assert.throws(() => cm.presentRows([q1, q0]), /shard 1 of a body stored as shards/, 'a later shard of a body the window holds none of');
    assert.throws(() => cm.presentRows([doc, b, p1]), new RegExp(`${p1} is named twice`), 'the first shard and the first one missing name the same rows');
    assert.throws(() => cm.presentRows([doc, doc]), new RegExp(`${doc} is named twice`));
    assert.throws(() => cm.presentRows([b, a]), new RegExp(`${a} is in the window already`));
    assert.equal(cm.getStore().getStateLen(INDEX), length, 'nothing was written');

    // A row presented before the body is completed stays between its runs,
    // and each run reads as a body of its own, neither complete.
    cm.presentRows([b]);
    strategy.heard = [];
    const ordinal = cm.ordinalOf(doc);
    assert.deepEqual(cm.presentRows([doc]), [ordinal]);
    assert.deepEqual(strategy.heard, [[p1, p2]]);
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a, doc, b, p1, p2]);
    assert.deepEqual(cm.getUnpresentedMessages().map((m) => m.id), [q0, q1]);
    const result = await cm.compile(BIG);
    assert.deepEqual(texts(result), ['a', 'p0 ', 'b', 'p1 ', 'p2 ']);
    assert.deepEqual(rawHeads(result), [[a, true], [doc, false], [b, true], [p1, false], [p1, false]]);
    cm.close();
  });

  it("an undone turn's body presented again in part lists the shards it lacks, and its first shard with them completes it", async () => {
    const strategy = new Hearing();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]);
    const [, p1, p2] = cm.getAllMessages().map((m) => m.id);
    cm.presentRows([doc]);
    cm.retractRows([doc], { undone: true });
    assert.deepEqual(cm.getUnpresentedMessages(), [], "an undone turn's body is left out");

    // The redo is cut short after the first shard. The body is partly in
    // the window now, so the rest is due, undone or not.
    strategy.heard = [];
    const restore = failIndexAppend(cm, 2);
    try {
      assert.throws(() => cm.presentRows([doc]), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(strategy.heard, [[doc]]);
    assert.deepEqual(cm.getUnpresentedMessages().map((m) => m.id), [p1!, p2!]);

    // The first shard with the rest in order names the same body.
    const ordinal = cm.ordinalOf(doc)!;
    assert.deepEqual(cm.presentRows([doc, p1!, p2!]), [ordinal, ordinal + 1, ordinal + 2]);
    assert.deepEqual(strategy.heard, [[doc], [p1, p2]]);
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    const result = await cm.compile(BIG);
    assert.deepEqual(texts(result), ['p0 ', 'p1 ', 'p2 ']);
    assert.deepEqual(rawHeads(result), [[doc, true], [doc, true], [doc, true]]);
    cm.close();
  });

  it("a child derived between a body's shard presentations completes it with presentRows of its first shard", async () => {
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    parent.presentRows([]);
    const u = parent.addMessage('User', [text('u')]);
    parent.presentRows([u]);
    const doc = parent.addMessage('User', [text('p0 '), text('p1 '), text('p2 ')]);
    const [, p1, p2] = parent.getAllMessages().filter((m) => m.bodyGroupId === 'zz-doc').map((m) => m.id);
    const before = parent.getStore().currentSequence();
    parent.presentRows([doc]);
    // One record per shard: two records on, the first two shards are in the
    // window and the third isn't.
    const child = await parent.derive({ branch: 'zz/mid-body', strategy: new Sharding(), atSequence: before + 2 });
    assert.deepEqual(child.getPresentedMessages().map((m) => m.id), [u, doc, p1]);
    assert.deepEqual(child.getUnpresentedMessages().map((m) => m.id), [p2]);
    assert.deepEqual(rawHeads(await child.compile(BIG)), [[u, true], [doc, false], [doc, false]]);
    const ordinals = [child.ordinalOf(doc), child.ordinalOf(p1!)];

    assert.deepEqual(child.presentRows([doc]), [ordinals[0]]);
    assert.deepEqual([child.ordinalOf(doc), child.ordinalOf(p1!)], ordinals, 'the shards in the window keep their ordinals');
    assert.deepEqual(child.getUnpresentedMessages(), []);
    const whole = await child.compile(BIG);
    assert.deepEqual(texts(whole), ['u', 'p0 ', 'p1 ', 'p2 ']);
    assert.deepEqual(rawHeads(whole), [[u, true], [doc, true], [doc, true], [doc, true]]);
    assert.deepEqual(parent.getPresentedMessages().map((m) => m.id), [u, doc, p1, p2], "the parent's window is its own");
    child.close();
    parent.close();
  });
});

describe('thinking binding over the window', () => {
  const thought = (n: number): ContentBlock =>
    ({ type: 'thinking', thinking: `zz-reasoning-${n} `.repeat(20), signature: `zz-sig-${n}-0123456789abcdef` }) as ContentBlock;
  const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'zz_search', input: { q: id } }) as ContentBlock;
  const toolResult = (id: string, content: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content }) as ContentBlock;
  const identity: RequestIdentity = { system: 'zz-system-1', tools: 'zz-tools-1', model: 'zz-model-1', request: 'zz-request-1' };
  const binding: ThinkingBinding = { binds: true, dropBlock: true, participant: 'Claude' };
  const BIND_DROP: SelectOptions = { thinkingBinding: binding, identity };
  const keeps = (result: CompileResult) => result.messages.map((m) => m.content.some((b) => b.type === 'thinking'));

  async function reader() {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    side.presentRows([]);
    const u1 = side.addMessage('User', [text('U1')]);
    side.presentRows([u1]);
    const first = await side.compile(BIG, undefined, BIND_DROP);
    return { main, side, compileId: first.provenance!.compileId };
  }

  it('a write in an auxiliary slot during a stream, presented after its rounds, leaves every reply its thinking', async () => {
    // The presented-mode sibling of thinking-binding.test.ts's auxiliary
    // interleave: there the record puts the other slot's row between the
    // stream's rounds and the reply after it loses its thinking.
    const { main, side, compileId } = await reader();
    const a1 = side.addMessage('Claude', [thought(1), text('A1'), toolUse('t1')]);
    side.presentRows([a1]);
    const other = main.addMessage('Other', [text('zz-auxiliary')]);
    const r1 = side.addMessage('User', [toolResult('t1', 'zz-result')]);
    side.presentRows([r1]);
    assert.equal(side.noteRequestSent([a1, r1], identity, compileId), true);
    const a2 = side.addMessage('Claude', [thought(2), text('A2')]);
    side.presentRows([a2]);
    assert.equal(side.noteRequestSent([a1, r1, a2], identity, compileId), true);
    side.presentRows([other]);
    const next = await side.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(texts(next), ['U1', 'A1', 'tool_result', 'A2', 'zz-auxiliary']);
    assert.deepEqual(keeps(next), [false, true, false, true, false]);
    assert.equal(next.thinkingStrip, undefined);
    side.close();
    main.close();
  });

  it('a noted row the window does not hold vouches for nothing', async () => {
    // A host presents a request's rows before it notes them. Noted first,
    // they are rows the next compile wouldn't send, so from the first of
    // them on no reply keeps its thinking; the test above, noting presented
    // rows, keeps A2's.
    const { main, side, compileId } = await reader();
    const b1 = side.addMessage('Claude', [thought(1), text('B1'), toolUse('t2')]);
    side.presentRows([b1]);
    const s1 = side.addMessage('User', [toolResult('t2', 'zz-result')]);
    const b2 = side.addMessage('Claude', [thought(2), text('B2')]);
    assert.equal(side.noteRequestSent([b1, s1, b2], identity, compileId), true);
    side.presentRows([s1, b2]);
    const after = await side.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(texts(after), ['U1', 'B1', 'tool_result', 'B2']);
    assert.deepEqual(keeps(after), [false, true, false, false]);
    side.close();
    main.close();
  });
});
