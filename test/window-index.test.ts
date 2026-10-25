/**
 * The window index (agent-framework #291, src/window-index.ts): which stored
 * rows a manager's agent has been shown, in what order, and how every
 * strategy read and compile follows it.
 *
 * - Legacy mode: until a host presents a row, the window is the merged
 *   record itself, read live, and nothing is written, so compiles are what
 *   they were. A reader that merges another slot keeps seeing it grow.
 * - Presented mode: the window is the index. A row stored and not presented
 *   stays out of it; rows presented out of record order are compiled in
 *   the window's order, and compile provenance still finds each body.
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
    assert.equal(cm.presentationMode(), 'legacy');
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
    assert.equal(side.presentationMode(), 'legacy');
    assert.equal(main.getStore().getStateJson(windowIndexStateId('subconscious/zz')), null);
    const before = side.getPresentedMessages();

    // The first presentation writes the window down as it stands: the same
    // rows, in the same order, the same array, so the compile is the same.
    assert.deepEqual(side.presentRows([]), []);
    assert.equal(side.presentationMode(), 'presented');
    assert.equal(side.getPresentedMessages(), before, 'the bootstrap keeps the listing the strategy last read');
    const bootstrapped = await side.compile(BIG);
    assert.deepEqual(bootstrapped.messages, legacy.messages, 'byte-identical across the bootstrap');
    assert.equal(side.indexLength(), 5, 'a header and one item per row');
    assert.equal(main.presentationMode(), 'legacy', "another namespace's window is its own");

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
    assert.equal(side.lastPresentedSequence(), side.getMessage(s2)!.sequence);
    side.close();
    main.close();
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
    assert.equal(cm.presentationMode(), 'presented');
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
