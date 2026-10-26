/**
 * The window reads agent-framework builds its presentation on (#291,
 * CM-7): where a row stands with a manager's window, where a branch at a
 * row is cut, the arrived rows stored after a sequence, and the topic
 * transition with a host's metadata.
 *
 * - windowStatusOf(id): `absent` for a row no merged slot holds (one
 *   removed through another manager too, while that manager's ordinal for
 *   it stands), `in` for every held row in legacy mode and for a row the
 *   window holds, `undone` for an undone turn's row, `out` otherwise: the
 *   rows getUnpresentedMessages lists, so an undone shard of a body a redo
 *   left partly in the window is `out`. It writes nothing.
 * - branchSequenceOf(id): the sequence branchAt cuts at, for a legacy row,
 *   a row the write-down presented and a row presented later, a body
 *   stored as shards and a row of an auxiliary slot; it writes nothing and
 *   throws as branchAt does for an id no slot holds.
 * - getUnpresentedMessages({ afterSequence }): the whole listing's rows
 *   stored after the sequence, at every cut, a cut inside a body among them.
 * - resetHeadWindow(text, { metadata }): the transition carries the
 *   metadata, and once a host presents it is presented before the head
 *   window is reset to start at it.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy, windowIndexStateId } from '../src/index.js';
import type { CompileResult, MessageId, StoredMessage, WindowStatus } from '../src/index.js';
import { perItemIndexWrites } from './_harness/index-writes.js';

const BASE = './test-window-status';
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
const INDEX = windowIndexStateId('zz-agent');

const ids = (messages: Array<{ id: MessageId }>) => messages.map((m) => m.id);

/** The first text of each compiled message, in order. */
function texts(result: CompileResult): string[] {
  return result.messages.map((m) => {
    const first = m.content.find((b) => b.type === 'text') as { text: string } | undefined;
    return first?.text ?? m.content.map((b) => b.type).join('+');
  });
}

/** Passthrough that stores a message of two or more blocks as one shard per block. */
class Sharding extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: `zz-doc-${content.length}-${(content[0] as { text: string }).text}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

/**
 * Makes the `failing`-th append to `stateId` from now on throw, as a full disk
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

/** Each row's status, by id. */
function statuses(cm: ContextManager, rows: readonly MessageId[]): WindowStatus[] {
  return rows.map((id) => cm.windowStatusOf(id));
}

/** The sequence `branchAt` cut `branch` at. */
function branchPoint(cm: ContextManager, branch: string): number | undefined {
  return cm.listBranches().find((b) => b.name === branch)?.branchPoint;
}

describe('windowStatusOf', () => {
  it('in legacy mode every row a merged slot holds is in, an auxiliary slot\'s too, a removed one absent, and nothing is written', async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    const m1 = main.addMessage('alice', [text('m1')]);
    const m2 = main.addMessage('alice', [text('m2')]);
    const s1 = side.addMessage('Subconscious', [text('s1')]);
    const head = main.getStore().currentSequence();

    assert.deepEqual(statuses(side, [m1, m2, s1]), ['in', 'in', 'in'], 'the reader merges the shared slot: its rows are in its window');
    assert.deepEqual(statuses(main, [m1, m2]), ['in', 'in']);
    assert.equal(main.windowStatusOf(s1), 'absent', 'the shared slot\'s manager merges no other slot');
    assert.equal(side.windowStatusOf('999999'), 'absent', 'an id no slot holds');

    main.removeMessage(m2);
    assert.equal(main.windowStatusOf(m2), 'absent');
    assert.equal(side.windowStatusOf(m2), 'absent');
    const afterRemoval = main.getStore().currentSequence();
    statuses(side, [m1, m2, s1]);
    assert.equal(main.getStore().currentSequence(), afterRemoval, 'a status read writes nothing');
    assert.ok(afterRemoval > head);
    assert.equal(side.windowMode(), 'legacy');
    assert.equal(main.windowMode(), 'legacy');
    assert.equal(main.getStore().getStateJson(windowIndexStateId('zz-side')), null, 'no window is written down');
    side.close();
    main.close();
  });

  it('in presented mode: a presented row is in, a stored one not presented out, an undone one undone, a plain retract out', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a]);
    assert.deepEqual(statuses(cm, [a, b, c]), ['in', 'out', 'out']);

    cm.presentRows([b, c]);
    cm.retractRows([b], { undone: true });
    cm.retractRows([c]);
    const head = cm.getStore().currentSequence();
    assert.deepEqual(statuses(cm, [a, b, c]), ['in', 'undone', 'out']);
    assert.equal(cm.getStore().currentSequence(), head, 'a status read writes nothing');
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [c], 'the out rows are the ones listed as arrived; the undone one isn\'t');

    // A redo presents it again.
    cm.presentRows([b]);
    assert.equal(cm.windowStatusOf(b), 'in');
    cm.retractRows([b], { undone: true });
    cm.close();

    // The statuses are the index's, read again from the store.
    const reopened = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    assert.deepEqual(statuses(reopened, [a, b, c]), ['in', 'undone', 'out']);
    reopened.close();
  });

  it('a row removed through another manager on the slot is absent while that manager\'s ordinal for it stands', async () => {
    const writer = await ContextManager.open({ path: freshPath(), namespace: 'zz-writer', strategy: new PassthroughStrategy() });
    const cm = await ContextManager.open({ store: writer.getStore(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    cm.presentRows([a, b]);
    const alt = cm.branchAt(b, 'zz-alt'); // a branch made before the removal

    writer.removeMessage(a);
    assert.notEqual(cm.ordinalOf(a), undefined, 'setup: a removal through another manager isn\'t heard');
    assert.equal(cm.windowStatusOf(a), 'absent', 'the record no longer holds it');
    assert.equal(cm.windowStatusOf(b), 'in');
    cm.retractRows([a]);
    assert.equal(cm.ordinalOf(a), undefined);
    assert.equal(cm.windowStatusOf(a), 'absent');

    // The branch made before the removal still holds the row in its record
    // and its window.
    await cm.switchBranch(alt);
    assert.equal(cm.windowStatusOf(a), 'in');
    cm.close();
    writer.close();
  });

  it('an undone body\'s shards are out once a redo cut short leaves it partly in the window, as getUnpresentedMessages lists them', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]);
    const shards = ids(cm.getAllMessages());
    assert.equal(shards.length, 3, 'setup: the body is stored as three shards');
    cm.presentRows([doc]);
    cm.retractRows([doc], { undone: true });
    assert.deepEqual(statuses(cm, shards), ['undone', 'undone', 'undone']);

    const restore = failAppend(cm, 2);
    try {
      assert.throws(() => cm.presentRows([doc]), /zz-index-append-failed/);
    } finally {
      restore();
    }
    assert.deepEqual(statuses(cm, shards), ['in', 'out', 'out']);
    assert.deepEqual(ids(cm.getUnpresentedMessages()), shards.slice(1));
    cm.close();
  });
});

describe('branchSequenceOf', () => {
  it('is where branchAt cuts: a legacy row\'s own sequence, a written-down row\'s own, and the write that presented a later row', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [u1, a1] = ['u1', 'a1'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    const sequenceOf = (id: MessageId) => cm.getMessage(id)!.sequence;
    const cutsAsBranchAt = (id: MessageId, name: string) => {
      const before = { head: cm.getStore().currentSequence(), branches: cm.listBranches().length };
      const sequence = cm.branchSequenceOf(id);
      assert.deepEqual({ head: cm.getStore().currentSequence(), branches: cm.listBranches().length }, before, 'it writes nothing');
      assert.equal(branchPoint(cm, cm.branchAt(id, name)), sequence, `${name}: branchAt cuts where branchSequenceOf says`);
      return sequence;
    };

    assert.equal(cutsAsBranchAt(a1, 'zz-legacy-a1'), sequenceOf(a1));

    cm.presentRows([]);
    assert.equal(cutsAsBranchAt(a1, 'zz-written-down-a1'), sequenceOf(a1), 'the write-down presented it');
    assert.equal(cutsAsBranchAt(u1, 'zz-written-down-u1'), sequenceOf(u1));

    const x = cm.addMessage('bob', [text('x')]);
    const y = cm.addMessage('alice', [text('y')]);
    const z = cm.addMessage('bob', [text('z')]);
    cm.presentRows([y]);
    const presentedY = cm.getStore().currentSequence();
    cm.presentRows([x]);
    assert.equal(cutsAsBranchAt(y, 'zz-at-y'), presentedY, 'the write that presented it');
    assert.ok(cm.branchSequenceOf(x) > presentedY, 'x was presented after y');
    assert.equal(cutsAsBranchAt(x, 'zz-at-x'), cm.branchSequenceOf(x));
    assert.equal(cutsAsBranchAt(z, 'zz-at-z'), sequenceOf(z), 'a row the window doesn\'t hold: its own sequence');

    assert.throws(() => cm.branchSequenceOf('999999'), { message: 'Message not found: 999999' });
    assert.throws(() => cm.branchAt('999999'), { message: 'Message not found: 999999' });
    cm.close();
  });

  it('a body stored as shards: its first shard\'s own sequence in legacy mode, its last shard\'s once written down, its last presenting write once presented', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    const doc = cm.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]);
    const shards = cm.getAllMessages();
    assert.equal(shards.length, 3, 'setup: the body is stored as three shards');
    assert.equal(cm.branchSequenceOf(doc), shards[0]!.sequence);
    assert.equal(branchPoint(cm, cm.branchAt(doc, 'zz-legacy')), shards[0]!.sequence);

    cm.presentRows([]);
    assert.equal(cm.branchSequenceOf(doc), shards[2]!.sequence);
    assert.equal(branchPoint(cm, cm.branchAt(doc, 'zz-written-down')), shards[2]!.sequence);

    const doc2 = cm.addMessage('alice', [text('q0 '), text('q1 ')]);
    cm.presentRows([doc2]);
    const presented = cm.getStore().currentSequence();
    assert.equal(cm.branchSequenceOf(doc2), presented, 'the write that presented its last shard');
    assert.equal(branchPoint(cm, cm.branchAt(doc2, 'zz-presented')), presented);
    cm.close();
  });

  it('finds a row of an auxiliary slot', async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    const m1 = main.addMessage('alice', [text('m1')]);
    assert.equal(side.branchSequenceOf(m1), main.getMessage(m1)!.sequence);
    side.presentRows([]);
    const m2 = main.addMessage('alice', [text('m2')]);
    side.presentRows([m2]);
    const presented = side.getStore().currentSequence();
    assert.equal(side.branchSequenceOf(m2), presented);
    assert.equal(branchPoint(side, side.branchAt(m2, 'zz-at-m2')), presented);
    assert.throws(() => main.branchSequenceOf(side.addMessage('Subconscious', [text('s1')])), { message: /^Message not found: / });
    side.close();
    main.close();
  });
});

describe('getUnpresentedMessages({ afterSequence })', () => {
  it('gives the whole listing\'s rows stored after the sequence, at every cut', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    const doc = cm.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]); // undone, then a redo cut short
    const b = cm.addMessage('bob', [text('b')]); // undone
    const doc2 = cm.addMessage('bob', [text('q0 '), text('q1 '), text('q2 ')]); // presented cut short
    cm.addMessage('bob', [text('c')]); // arrived
    cm.addMessage('bob', [text('r0 '), text('r1 ')]); // arrived
    cm.presentRows([a, doc, b]);
    cm.retractRows([doc, b], { undone: true });
    let restore = failAppend(cm, 2);
    try {
      assert.throws(() => cm.presentRows([doc]), /zz-index-append-failed/);
    } finally {
      restore();
    }
    restore = failAppend(cm, 2);
    try {
      assert.throws(() => cm.presentRows([doc2]), /zz-index-append-failed/);
    } finally {
      restore();
    }

    const record = cm.getAllMessages();
    const whole = cm.getUnpresentedMessages();
    assert.ok(whole.length >= 6, 'setup: arrived rows, a body\'s missing shards and an arrived body');
    const cuts = new Set<number>([-1, 0, Number.POSITIVE_INFINITY, cm.getStore().currentSequence() + 100]);
    for (const m of record) {
      cuts.add(m.sequence - 1);
      cuts.add(m.sequence);
    }
    for (const cut of cuts) {
      assert.deepEqual(
        ids(cm.getUnpresentedMessages({ afterSequence: cut })),
        ids(whole.filter((m: StoredMessage) => m.sequence > cut)),
        `after ${cut}`,
      );
    }
    assert.deepEqual(ids(cm.getUnpresentedMessages({})), ids(whole));
    cm.close();
  });

  it('is empty in legacy mode, and refuses an afterSequence that isn\'t a number', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.addMessage('alice', [text('a')]);
    assert.deepEqual(cm.getUnpresentedMessages({ afterSequence: -1 }), []);
    for (const bad of [Number.NaN, '3', null]) {
      assert.throws(() => cm.getUnpresentedMessages({ afterSequence: bad as unknown as number }), TypeError);
    }
    cm.close();
  });
});

describe('resetHeadWindow with metadata', () => {
  /** A resettable passthrough that records where its head window was reset to, and what it heard. */
  class Resetting extends PassthroughStrategy {
    manager: ContextManager | null = null;
    resets: Array<{ id: string | null; ordinal: number | undefined }> = [];
    heard: MessageId[] = [];
    async onNewMessage(message: StoredMessage): Promise<void> {
      this.heard.push(message.id);
    }
    resetHeadWindow(id: string | null): void {
      this.resets.push({ id, ordinal: id === null ? undefined : this.manager?.ordinalOf(id) });
    }
    async generateTransitionSummary(): Promise<string> {
      return 'generated';
    }
  }

  async function open(strategy: Resetting) {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    strategy.manager = cm;
    return cm;
  }

  it('in presented mode the transition carries the metadata and is presented before the head window is reset to it', async () => {
    const strategy = new Resetting();
    const cm = await open(strategy);
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    cm.presentRows([a]);
    strategy.heard = [];

    assert.equal(await cm.resetHeadWindow('new topic', { metadata: { audience: ['zz-mira'], zz: 1 } }), 'new topic');
    const transition = cm.getAllMessages().at(-1)!;
    assert.equal((transition.content[0] as { text: string }).text, '[Topic Transition]\n\nnew topic');
    assert.deepEqual(transition.metadata, { audience: ['zz-mira'], zz: 1 });
    assert.equal(cm.windowStatusOf(transition.id), 'in');
    assert.deepEqual(ids(cm.getPresentedMessages()), [a, transition.id]);
    assert.deepEqual(strategy.resets, [{ id: transition.id, ordinal: cm.ordinalOf(transition.id) }], 'the reset came after the presentation');
    assert.notEqual(strategy.resets[0]!.ordinal, undefined);
    assert.deepEqual(strategy.heard, [transition.id], 'the strategy heard it at its presentation');
    cm.close();
  });

  it('in legacy mode the transition carries the metadata, and nothing is written to the window', async () => {
    const strategy = new Resetting();
    const cm = await open(strategy);
    cm.addMessage('alice', [text('a')]);
    await cm.resetHeadWindow(undefined, { metadata: { zz: 'legacy' } });
    const transition = cm.getAllMessages().at(-1)!;
    assert.equal((transition.content[0] as { text: string }).text, '[Topic Transition]\n\ngenerated');
    assert.deepEqual(transition.metadata, { zz: 'legacy' });
    assert.equal(cm.windowMode(), 'legacy');
    assert.equal(cm.getStore().getStateJson(INDEX), null);
    assert.deepEqual(strategy.resets, [{ id: transition.id, ordinal: undefined }]);
    assert.deepEqual(strategy.heard.at(-1), transition.id, 'heard at its add, as before');
    cm.close();
  });

  it('a presentation that fails rejects naming the stored transition, and the head window isn\'t reset', async () => {
    const strategy = new Resetting();
    const cm = await open(strategy);
    cm.presentRows([]);
    const restore = failAppend(cm, 1);
    let transition: MessageId | undefined;
    try {
      await assert.rejects(cm.resetHeadWindow('topic'), (error: Error) => {
        transition = cm.getAllMessages().at(-1)?.id;
        return /^ContextManager\.resetHeadWindow couldn't present its transition: zz-index-append-failed\. Its transition add finished: message \S+ is stored, and the head window wasn't reset\./.test(error.message)
          && error.message.includes(`message ${transition} is stored`);
      });
    } finally {
      restore();
    }
    assert.deepEqual(strategy.resets, []);
    assert.equal(cm.windowStatusOf(transition!), 'out', 'stored and not presented');
    cm.close();
  });

  it('the autobiographical head window starts at the transition once rows are presented', async () => {
    const cm = await ContextManager.open({
      path: freshPath(), namespace: 'zz-agent', strategy: new AutobiographicalStrategy({ headWindowTokens: 300, recentWindowTokens: 100 }),
    });
    cm.presentRows([]);
    const old = [cm.addMessage('user', [text('Old context')]), cm.addMessage('assistant', [text('Old response')])];
    cm.presentRows(old);
    await cm.resetHeadWindow('User switched topics.', { metadata: { zz: 'topic' } });
    const next = cm.addMessage('user', [text('New context')]);
    cm.presentRows([next]);
    const compiled = texts(await cm.compile(BIG));
    assert.ok(compiled.some((t) => t.startsWith('[Topic Transition]')), compiled.join(' | '));
    assert.ok(compiled.includes('New context'), compiled.join(' | '));
    cm.close();
  });
});
