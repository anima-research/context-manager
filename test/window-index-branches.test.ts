/**
 * The window index across branches and removals (agent-framework #291,
 * src/window-index.ts).
 *
 * - derive() carries the window among the states the manager owns, whatever
 *   the strategy's derivation manifest names: at the head the child starts
 *   with the parent's window and its arrivals, from the parent's reading of
 *   it; from an earlier checkpoint it starts with the window as it stood
 *   then. reopenDerived() finds it on the branch.
 *   derive() cuts at the sequence it is given, so a cut at a presented
 *   row's own sequence leaves that row out of the child's window.
 * - branchAt() cuts at the write that presented a row, the last of its
 *   body's shards, once a host presents, so the new branch's window holds
 *   the row; it finds a row of an auxiliary slot too. A row the write-down
 *   presented is cut at its own sequence, as in legacy mode.
 * - A row removed from the manager's slot leaves the window as a
 *   tombstone, so no other row's ordinal moves, also when the context log
 *   throws on the removal. A window that can't be read before a range is
 *   removed doesn't stop the removal.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, WindowedPassthroughStrategy, windowIndexStateId } from '../src/index.js';
import type { CompileResult, DerivationManifest, MessageId } from '../src/index.js';

const BASE = './test-window-index-branches';
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

const supported = typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function';
const skip = supported ? false : 'installed @animalabs/chronicle has no JsStore.view (branch-bound handles)';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const INDEX = windowIndexStateId('zz-agent');

/** The first text of each compiled message, in order. */
function texts(result: CompileResult): string[] {
  return result.messages.map((m) => {
    const first = m.content.find((b) => b.type === 'text') as { text: string } | undefined;
    return first?.text ?? m.content.map((b) => b.type).join('+');
  });
}

const ids = (messages: Array<{ id: MessageId }>) => messages.map((m) => m.id);

/** Passthrough whose derivation manifest names none of its states, as both shipped manifests leave out the window. */
class Manifested extends PassthroughStrategy {
  derivationManifest(): DerivationManifest {
    return { stateIds: [], statePrefixes: [] };
  }
}

/** Passthrough that stores a message of two or more blocks as one shard per block. */
class Sharding extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: 'zz-doc', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

/** What a manager's window says, as a host reads it. */
function windowOf(cm: ContextManager, rows: MessageId[]) {
  return {
    mode: cm.windowMode(),
    window: ids(cm.getPresentedMessages()),
    unpresented: ids(cm.getUnpresentedMessages()),
    ordinals: rows.map((id) => cm.ordinalOf(id)),
    length: cm.indexLength(),
    newest: cm.newestWindowSequence(),
  };
}

function indexItems(cm: ContextManager): Array<Record<string, unknown>> {
  return (cm.getStore().getStateJson(INDEX) as Array<Record<string, unknown>> | null) ?? [];
}

/** The sequence `branchAt` cut `branch` at. */
function branchPoint(cm: ContextManager, branch: string): number | undefined {
  return cm.listBranches().find((b) => b.name === branch)?.branchPoint;
}

/** Runs `presentRows([])` with the `failing`-th append to the window index throwing, as a full disk would. */
function cutShortWriteDown(cm: ContextManager, failing: number): void {
  const store = cm.getStore() as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
  const append = store.appendToStateJsonWithIdentity;
  let appends = 0;
  store.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
    if (id === INDEX && ++appends === failing) throw new Error('zz-index-append-failed');
    return append.call(this, id, ...rest);
  };
  try {
    assert.throws(() => cm.presentRows([]), /zz-index-append-failed/);
  } finally {
    store.appendToStateJsonWithIdentity = append;
  }
}

describe('derive and the window', () => {
  it('a manager derived at the head starts with the parent\'s window and its arrivals, whatever the manifest names', { skip }, async () => {
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Manifested() });
    parent.presentRows([]);
    const a = parent.addMessage('alice', [text('a')]);
    const b = parent.addMessage('bob', [text('b')]);
    const c = parent.addMessage('alice', [text('c')]);
    parent.presentRows([c, a]); // b arrived and wasn't presented
    const expected = windowOf(parent, [a, b, c]);
    assert.deepEqual(expected.window, [c, a]);
    assert.deepEqual(expected.unpresented, [b]);

    const child = await parent.derive({ branch: 'zz/child', strategy: new Manifested() });
    assert.ok(child.getDerivation()!.inherited.stateIds.includes(INDEX), 'the manager lists its window among its own states');
    assert.deepEqual(windowOf(child, [a, b, c]), expected, 'the parent\'s window, ordinals and arrivals');
    assert.deepEqual(texts(await child.compile(BIG)), ['c', 'a']);

    // From here the two windows diverge.
    parent.presentRows([b]);
    assert.deepEqual(ids(child.getPresentedMessages()), [c, a], 'the parent\'s later presentation stays the parent\'s');
    const d = child.addMessage('alice', [text('d')]);
    child.presentRows([d]);
    child.removeMessage(a);
    assert.deepEqual(ids(child.getPresentedMessages()), [c, d]);
    assert.deepEqual(ids(parent.getPresentedMessages()), [c, a, b], 'the child\'s presentation and removal stay the child\'s');
    assert.equal(parent.ordinalOf(a), expected.ordinals[0]);
    assert.equal(parent.ordinalOf(d), undefined);
    child.close();
    parent.close();
  });

  it('does not read the window from the store to create a child at the head, or to use it', { skip }, async () => {
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    parent.presentRows([]);
    const rows = ['a', 'b', 'c'].map((t) => parent.addMessage('alice', [text(t)]));
    parent.presentRows([rows[2]!, rows[0]!, rows[1]!]);
    parent.getPresentedMessages(); // the parent is warm, as a running agent is

    const proto = JsStore.prototype as unknown as { getStateJson(id: string): unknown };
    const original = proto.getStateJson;
    const reads: string[] = [];
    proto.getStateJson = function (this: JsStore, id: string) {
      if (id === INDEX) reads.push(this.currentBranch().name);
      return original.call(this, id);
    };
    let child: ContextManager | undefined;
    try {
      child = await parent.derive({ branch: 'zz/child', strategy: new PassthroughStrategy() });
      assert.deepEqual(texts(await child.compile(BIG)), ['c', 'a', 'b']);
      const d = child.addMessage('alice', [text('d')]);
      child.presentRows([d]);
      assert.deepEqual(texts(await child.compile(BIG)), ['c', 'a', 'b', 'd']);
    } finally {
      proto.getStateJson = original;
    }
    assert.deepEqual(reads, [], 'the child took the parent\'s reading of the window');
    // The reading was copied: the child's presentation never reached the parent's.
    assert.deepEqual(texts(await parent.compile(BIG)), ['c', 'a', 'b']);
    child.close();
    parent.close();
  });

  it('a manager derived from an earlier checkpoint starts with the window as it stood then', { skip }, async () => {
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Manifested() });
    parent.presentRows([]);
    const a = parent.addMessage('alice', [text('a')]);
    const b = parent.addMessage('bob', [text('b')]);
    const stored = parent.getStore().currentSequence(); // a and b stored, neither presented
    parent.presentRows([b]);
    const presented = parent.getStore().currentSequence(); // b presented
    const c = parent.addMessage('alice', [text('c')]);
    parent.presentRows([a, c]);

    const atStored = await parent.derive({ branch: 'zz/at-stored', strategy: new Manifested(), atSequence: stored });
    assert.deepEqual(windowOf(atStored, [a, b, c]), {
      mode: 'presented', window: [], unpresented: [a, b], ordinals: [undefined, undefined, undefined], length: 1, newest: undefined,
    }, 'rows stored by then and not yet presented are arrivals there');

    const atPresented = await parent.derive({ branch: 'zz/at-presented', strategy: new Manifested(), atSequence: presented });
    assert.deepEqual(windowOf(atPresented, [a, b, c]), {
      mode: 'presented', window: [b], unpresented: [a], ordinals: [undefined, parent.ordinalOf(b), undefined],
      length: 2, newest: parent.getMessage(b)!.sequence,
    }, 'the window names only rows stored by then');
    assert.deepEqual(texts(await atPresented.compile(BIG)), ['b']);
    atPresented.presentRows([a]);
    assert.deepEqual(texts(await atPresented.compile(BIG)), ['b', 'a']);
    assert.deepEqual(texts(await parent.compile(BIG)), ['b', 'a', 'c']);
    atStored.close();
    atPresented.close();
    parent.close();
  });

  it('cuts at the sequence given: at a presented row\'s own, the row is an arrival there; at the boundary after its presentation, it is in the window', { skip }, async () => {
    // The contract derive documents: atSequence is a presentation boundary.
    // A host that inspects "the context as of a row" by the row's own
    // sequence gets the window without that row.
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    parent.presentRows([]);
    const rows: MessageId[] = [];
    const boundaries: number[] = [];
    for (const t of ['u1', 'a1', 'u2', 'a2']) {
      const id = parent.addMessage(t.startsWith('u') ? 'User' : 'Claude', [text(t)]);
      parent.presentRows([id]);
      rows.push(id);
      boundaries.push(parent.getStore().currentSequence());
    }
    const [u1, a1, u2] = rows as [MessageId, MessageId, MessageId];
    const own = parent.getMessage(u2)!.sequence;
    assert.ok(own < boundaries[2]!, 'setup: u2 was presented at a write after its own');

    const atRow = await parent.derive({ branch: 'zz/at-u2', strategy: new PassthroughStrategy(), atSequence: own });
    assert.deepEqual(ids(atRow.getAllMessages()), [u1, a1, u2], 'the row is in the child\'s record');
    assert.deepEqual(ids(atRow.getPresentedMessages()), [u1, a1], 'and not in its window');
    assert.deepEqual(ids(atRow.getUnpresentedMessages()), [u2]);
    assert.deepEqual(texts(await atRow.compile(BIG)), ['u1', 'a1']);

    const atBoundary = await parent.derive({ branch: 'zz/after-u2', strategy: new PassthroughStrategy(), atSequence: boundaries[2]! });
    assert.deepEqual(ids(atBoundary.getAllMessages()), [u1, a1, u2]);
    assert.deepEqual(ids(atBoundary.getPresentedMessages()), [u1, a1, u2]);
    assert.deepEqual(atBoundary.getUnpresentedMessages(), []);
    assert.deepEqual(texts(await atBoundary.compile(BIG)), ['u1', 'a1', 'u2']);
    atRow.close();
    atBoundary.close();
    parent.close();
  });

  it('a parent in legacy mode derives a child in legacy mode, which the parent\'s first presentation doesn\'t reach', { skip }, async () => {
    const parent = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Manifested() });
    const a = parent.addMessage('alice', [text('a')]);
    const child = await parent.derive({ branch: 'zz/child', strategy: new Manifested() });
    assert.equal(child.windowMode(), 'legacy');
    parent.presentRows([]);
    const b = parent.addMessage('bob', [text('b')]);
    assert.equal(parent.windowMode(), 'presented');
    assert.deepEqual(ids(parent.getPresentedMessages()), [a]);
    assert.equal(child.windowMode(), 'legacy', 'nothing was written on the child\'s branch');
    const c = child.addMessage('carol', [text('c')]);
    assert.deepEqual(ids(child.getPresentedMessages()), [a, c], 'the child\'s window is its record, live');
    assert.equal(child.getMessage(b), null);
    child.close();
    parent.close();
  });

  it('reopenDerived finds the derived window on its branch, after a restart', { skip }, async () => {
    const path = freshPath();
    const parent = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new Manifested() });
    parent.presentRows([]);
    const a = parent.addMessage('alice', [text('a')]);
    const b = parent.addMessage('bob', [text('b')]);
    parent.presentRows([b, a]);
    const child = await parent.derive({ branch: 'zz/child', strategy: new Manifested() });
    const derivation = child.getDerivation()!;
    const c = child.addMessage('alice', [text('c')]);
    const d = child.addMessage('bob', [text('d')]);
    child.presentRows([d]);
    const expected = windowOf(child, [a, b, c, d]);
    const sent = texts(await child.compile(BIG));
    child.close();
    parent.close();

    const root = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new Manifested() });
    const reopened = await ContextManager.reopenDerived({
      store: root.getStore(),
      derivation: JSON.parse(JSON.stringify(derivation)),
      strategy: new Manifested(),
    });
    assert.deepEqual(windowOf(reopened, [a, b, c, d]), expected);
    assert.deepEqual(texts(await reopened.compile(BIG)), sent);
    assert.deepEqual(sent, ['b', 'a', 'd']);
    assert.deepEqual(ids(root.getPresentedMessages()), [b, a], 'the parent\'s branch kept its own window');
    reopened.close();
    root.close();
  });
});

describe('fork and the window', () => {
  it('a row removed on a fork leaves the window of the branch it was forked from', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.presentRows([b!, a!]);
    const main = cm.currentBranch().name;
    const ordinals = [cm.ordinalOf(a!), cm.ordinalOf(b!)];
    await cm.fork('zz-fork');
    assert.deepEqual([cm.ordinalOf(a!), cm.ordinalOf(b!)], ordinals, 'the fork carries the window');
    cm.removeMessage(b!);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a']);
    assert.equal(cm.ordinalOf(b!), undefined);
    await cm.switchBranch(main);
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'a']);
    assert.deepEqual([cm.ordinalOf(a!), cm.ordinalOf(b!)], ordinals);
    cm.close();
  });
});

describe('branchAt and the window', () => {
  it('cuts at the write that presented a row, so the new branch\'s window holds it', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const a = cm.addMessage('Claude', [text('a')]);
    const b = cm.addMessage('Other', [text('b')]); // stored mid-turn by another writer
    const c = cm.addMessage('Claude', [text('c')]);
    cm.presentRows([a, c]);
    cm.presentRows([b]); // at the next boundary
    const main = cm.currentBranch().name;

    // At b's own sequence the window held nothing: a and c were presented
    // after it. The branch is cut where b entered the window.
    const atB = cm.branchAt(b, 'zz-at-b');
    await cm.switchBranch(atB);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'c', 'b']);
    assert.deepEqual(cm.getUnpresentedMessages(), []);

    // a entered the window before c and b had: those are in the branch's
    // record, arrived and not presented.
    await cm.switchBranch(main);
    const atA = cm.branchAt(a, 'zz-at-a');
    await cm.switchBranch(atA);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a']);
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [b, c]);
    assert.deepEqual(ids(cm.getAllMessages()), [a, b, c]);
    cm.close();
  });

  it('cuts after the write that presented a body\'s last shard', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    cm.presentRows([]);
    const u = cm.addMessage('User', [text('u')]);
    const doc = cm.addMessage('User', [text('p1'), text('p2'), text('p3')]);
    assert.equal(cm.getAllMessages().length, 4, 'setup: the body is stored as three shards');
    cm.presentRows([u, doc]);
    const shards = ids(cm.getPresentedMessages()).slice(1);
    cm.branchAt(doc, 'zz-at-doc');
    await cm.switchBranch('zz-at-doc');
    assert.deepEqual(ids(cm.getPresentedMessages()), [u, ...shards], 'the body is in the branch\'s window whole');
    assert.deepEqual(texts(await cm.compile(BIG)), ['u', 'p1', 'p2', 'p3']);
    cm.close();
  });

  it('cuts a row the window doesn\'t hold at its own sequence, as in legacy mode', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const a = cm.addMessage('alice', [text('a')]);
    const b = cm.addMessage('bob', [text('b')]);
    cm.presentRows([]);
    const c = cm.addMessage('alice', [text('c')]);
    cm.addMessage('bob', [text('d')]);
    cm.presentRows([cm.getAllMessages()[3]!.id]);
    const sequence = cm.getMessage(c)!.sequence;
    const branch = cm.branchAt(c, 'zz-at-c');
    assert.equal(cm.listBranches().find((x) => x.name === branch)!.branchPoint, sequence);
    await cm.switchBranch(branch);
    assert.deepEqual(ids(cm.getAllMessages()), [a, b, c]);
    assert.deepEqual(ids(cm.getPresentedMessages()), [a, b]);
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [c]);
    cm.close();
  });

  it('cuts a row the write-down presented at its own sequence: the new branch is in legacy mode, its window the record up to the row', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const rows = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'].map((t, i) => cm.addMessage(i % 2 ? 'Claude' : 'User', [text(t)]));
    const [u1, a1] = rows as [MessageId, MessageId];
    const legacy = cm.branchAt(a1, 'zz-legacy-at-a1'); // what a branch made before the write-down gives
    cm.presentRows([]); // a host's boot call writes the window down
    assert.equal(cm.windowMode(), 'presented');
    const main = cm.currentBranch().name;

    // The write-down presented a1 after every row was stored. A cut at that
    // write would keep u2..a3 in the new branch's record, as arrivals.
    const atA1 = cm.branchAt(a1, 'zz-at-a1');
    assert.equal(branchPoint(cm, atA1), cm.getMessage(a1)!.sequence);
    assert.equal(branchPoint(cm, atA1), branchPoint(cm, legacy));
    await cm.switchBranch(atA1);
    assert.equal(cm.windowMode(), 'legacy');
    assert.equal(cm.indexLength(), 0);
    assert.deepEqual(ids(cm.getAllMessages()), [u1, a1]);
    assert.deepEqual(ids(cm.getPresentedMessages()), [u1, a1]);
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    assert.deepEqual(texts(await cm.compile(BIG)), ['u1', 'a1']);
    // Its own boot call writes its window down as it stands there.
    cm.presentRows([]);
    assert.deepEqual([cm.ordinalOf(u1), cm.ordinalOf(a1)], [0, 1]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['u1', 'a1']);

    // A row presented after the write-down is cut at the write that
    // presented it, as before.
    await cm.switchBranch(main);
    const x = cm.addMessage('Other', [text('x')]);
    const y = cm.addMessage('Claude', [text('y')]);
    cm.presentRows([y]);
    cm.presentRows([x]);
    const atY = cm.branchAt(y, 'zz-at-y');
    assert.ok(branchPoint(cm, atY)! > cm.getMessage(x)!.sequence);
    await cm.switchBranch(atY);
    assert.equal(cm.windowMode(), 'presented');
    assert.deepEqual(ids(cm.getPresentedMessages()), [...rows, y]);
    assert.deepEqual(ids(cm.getUnpresentedMessages()), [x]);
    cm.close();
  });

  it('a row the write-down presented, taken out and presented again, is cut at the write that presented it again', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([]);
    cm.retractRows([a]);
    cm.presentRows([a]);
    assert.deepEqual(ids(cm.getPresentedMessages()), [b, c, a], 'setup: a holds an ordinal after the header');
    const atA = cm.branchAt(a, 'zz-at-a');
    assert.ok(branchPoint(cm, atA)! > cm.getMessage(c)!.sequence);
    await cm.switchBranch(atA);
    assert.equal(cm.windowMode(), 'presented');
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'c', 'a']);
    cm.close();
  });

  it('cuts a body the write-down presented after its last shard\'s own write', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    const u = cm.addMessage('User', [text('u')]);
    const doc = cm.addMessage('User', [text('p1'), text('p2'), text('p3')]);
    cm.addMessage('User', [text('v')]);
    assert.equal(cm.getAllMessages().length, 5, 'setup: the body is stored as three shards');
    const body = ids(cm.getAllMessages()).slice(1, 4);
    cm.presentRows([]);
    const atDoc = cm.branchAt(doc, 'zz-at-doc');
    assert.equal(branchPoint(cm, atDoc), cm.getMessage(body[2]!)!.sequence);
    await cm.switchBranch(atDoc);
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(ids(cm.getAllMessages()), [u, ...body], 'the body is whole, and nothing stored after it is there');
    assert.deepEqual(texts(await cm.compile(BIG)), ['u', 'p1', 'p2', 'p3']);
    cm.close();
  });

  it('cuts each row of a write-down cut short and finished later at its own sequence', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cutShortWriteDown(cm, 3); // a and b written, then the failure
    const e = cm.addMessage('alice', [text('e')]); // stored while still in legacy mode
    cm.presentRows([]); // finishes it: c, e, then the header
    assert.deepEqual(indexItems(cm).map((item) => item.id ?? item.v), [a, b, c, e, 1]);
    const main = cm.currentBranch().name;

    const atA = cm.branchAt(a, 'zz-at-a'); // written by the first try
    assert.equal(branchPoint(cm, atA), cm.getMessage(a)!.sequence);
    await cm.switchBranch(atA);
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(texts(await cm.compile(BIG)), ['a']);

    await cm.switchBranch(main);
    const atE = cm.branchAt(e, 'zz-at-e'); // written by the second
    assert.equal(branchPoint(cm, atE), cm.getMessage(e)!.sequence);
    await cm.switchBranch(atE);
    // The first try's rows are there without their header: legacy mode,
    // the window the record, and the boot call finishes it.
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(ids(cm.getPresentedMessages()), [a, b, c, e]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'e']);
    cm.presentRows([]);
    assert.deepEqual(indexItems(cm).map((item) => item.id ?? item.v), [a, b, c, e, 1]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b', 'c', 'e']);
    cm.close();
  });

  it('windowed passthrough: a branch at a row the write-down presented doesn\'t take the anchor set after it', async () => {
    const strategy = new WindowedPassthroughStrategy({ anchorStateId: 'zz-agent/windowed:anchor' });
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const rows = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'].map((t, i) => cm.addMessage(i % 2 ? 'Claude' : 'User', [text(t)]));
    // A tune-out anchors the window at u3 while the window is the record.
    strategy.setAnchor(cm.getMessage(rows[4]!)!.sequence);
    assert.deepEqual(texts(await cm.compile(BIG)), ['u3', 'a3']);
    cm.presentRows([]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['u3', 'a3'], 'setup: the write-down keeps the anchor\'s window');

    // Cut at the write-down's item for a1, the branch would hold the
    // anchor, past every row its window holds, and compile nothing.
    const atA1 = cm.branchAt(rows[1]!, 'zz-at-a1');
    await cm.switchBranch(atA1);
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(texts(await cm.compile(BIG)), ['u1', 'a1']);
    cm.close();
  });

  it('finds a row of an auxiliary slot, and cuts at the write that presented it', async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    const m1 = main.addMessage('alice', [text('m1')]);
    const s1 = side.addMessage('Subconscious', [text('s1')]);
    // Legacy mode: the row's own sequence. This threw before: the row isn't
    // in the side manager's own slot.
    const legacy = side.branchAt(m1, 'zz-at-m1');
    assert.equal(side.listBranches().find((x) => x.name === legacy)!.branchPoint, main.getMessage(m1)!.sequence);

    side.presentRows([]);
    const m2 = main.addMessage('alice', [text('m2')]);
    const s2 = side.addMessage('Subconscious', [text('s2')]);
    side.presentRows([s2]);
    side.presentRows([m2]); // the other slot's row, presented at the reader's next boundary
    side.branchAt(m2, 'zz-at-m2');
    await side.switchBranch('zz-at-m2');
    assert.deepEqual(texts(await side.compile(BIG)), ['m1', 's1', 's2', 'm2']);
    assert.deepEqual(ids(side.getPresentedMessages()), [m1, s1, s2, m2]);
    side.close();
    main.close();
  });
});

describe('removal and the window', () => {
  it('a removed row leaves a tombstone: no other ordinal moves, the window leaves it out, and a reopen reads it so', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.presentRows([c!, a!, b!]);
    const [oa, oc] = [cm.ordinalOf(a!), cm.ordinalOf(c!)];
    const length = cm.indexLength();

    cm.removeMessage(a!);
    assert.equal(cm.ordinalOf(a!), undefined, 'the removed row has left the window');
    assert.equal(cm.ordinalOf(c!), oc);
    assert.equal(cm.indexLength(), length + 1, 'its tombstone takes the next ordinal');
    const tombstone = indexItems(cm).at(-1)!;
    assert.equal(tombstone.retract, a);
    assert.equal(tombstone.undone, undefined, 'a removed row is no undone turn\'s');
    assert.deepEqual(texts(await cm.compile(BIG)), ['c', 'b']);
    assert.throws(() => cm.retractRows([a!]), new RegExp(`no stored message has id ${a}, and the window holds none`), 'it is out already');
    assert.ok(oa !== undefined);
    cm.close();

    cm = await ContextManager.open({ path, namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    assert.equal(cm.ordinalOf(a!), undefined);
    assert.equal(cm.ordinalOf(c!), oc);
    assert.deepEqual(texts(await cm.compile(BIG)), ['c', 'b']);
    cm.close();
  });

  it('removeMessages takes every row of the range the window holds out of it, and nothing else', async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-agent', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    side.presentRows([]);
    const s1 = side.addMessage('Subconscious', [text('s1')]);
    const m1 = main.addMessage('alice', [text('m1')]); // another slot's row, stored inside the range
    const s2 = side.addMessage('Subconscious', [text('s2')]); // never presented
    const s3 = side.addMessage('Subconscious', [text('s3')]);
    const s4 = side.addMessage('Subconscious', [text('s4')]);
    side.presentRows([s3, m1, s1, s4]);
    const [om1, os4] = [side.ordinalOf(m1), side.ordinalOf(s4)];
    const before = indexItems(side).length;

    side.removeMessages(s1, s3);
    const tombstones = indexItems(side).slice(before).map((item) => item.retract);
    assert.deepEqual(new Set(tombstones), new Set([s1, s3]), 'one tombstone per row of the range in the window');
    assert.equal(tombstones.length, 2);
    assert.deepEqual([side.ordinalOf(s1), side.ordinalOf(s2), side.ordinalOf(s3)], [undefined, undefined, undefined]);
    assert.deepEqual([side.ordinalOf(m1), side.ordinalOf(s4)], [om1, os4]);
    assert.deepEqual(texts(await side.compile(BIG)), ['m1', 's4']);
    assert.deepEqual(side.getUnpresentedMessages(), []);
    side.close();
    main.close();
  });

  it('removeMessages over a presented body takes every shard out, and no other row', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Sharding() });
    cm.presentRows([]);
    const u = cm.addMessage('User', [text('u')]);
    const doc = cm.addMessage('User', [text('p1'), text('p2'), text('p3')]);
    const v = cm.addMessage('User', [text('v')]);
    cm.presentRows([u, doc, v]);
    const all = ids(cm.getAllMessages());
    assert.equal(all.length, 5, 'setup: the body is stored as three shards');
    const before = all.map((id) => cm.ordinalOf(id));
    const items = indexItems(cm).length;

    cm.removeMessages(all[1]!, all[3]!);
    assert.deepEqual(all.map((id) => cm.ordinalOf(id)), [before[0], undefined, undefined, undefined, before[4]]);
    assert.deepEqual(indexItems(cm).slice(items).map((item) => item.retract), all.slice(1, 4), 'one tombstone a shard');
    assert.deepEqual(texts(await cm.compile(BIG)), ['u', 'v']);
    assert.deepEqual(cm.getUnpresentedMessages(), []);
    cm.close();
  });

  it('a removal the context log throws on still takes the row out of the window', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    cm.presentRows([a, b]);
    const ob = cm.ordinalOf(b);
    const internals = cm as unknown as { handleMessageRemove: (id: MessageId) => void };
    internals.handleMessageRemove = () => {
      throw new Error('zz-context-log-failed');
    };
    assert.throws(() => cm.removeMessage(a), /zz-context-log-failed/, 'the failure reaches the caller');
    assert.equal(cm.getMessage(a), null, 'the removal stands');
    assert.equal(cm.ordinalOf(a), undefined, 'and the row has left the window');
    assert.equal(indexItems(cm).at(-1)!.retract, a);
    assert.equal(cm.ordinalOf(b), ob);
    assert.deepEqual(texts(await cm.compile(BIG)), ['b']);
    cm.close();
  });

  it('a window that can\'t be read before a range is removed is logged once, and the removal stands', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    const oc = cm.ordinalOf(c);
    // Every reading of the index asks the store for its revision first.
    const store = cm.getStore() as unknown as Record<'stateHeadOffset' | 'getStateLen', (id: string) => unknown>;
    const originals = { stateHeadOffset: store.stateHeadOffset, getStateLen: store.getStateLen };
    for (const name of ['stateHeadOffset', 'getStateLen'] as const) {
      const original = originals[name];
      if (typeof original !== 'function') continue;
      store[name] = function (this: unknown, id: string) {
        if (id === INDEX) throw new Error('zz-index-read-failed');
        return original.call(this, id);
      };
    }
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      cm.removeMessages(a, b);
    } finally {
      console.error = error;
      store.stateHeadOffset = originals.stateHeadOffset;
      store.getStateLen = originals.getStateLen;
    }
    assert.deepEqual([cm.getMessage(a), cm.getMessage(b)], [null, null], 'the removal stands');
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.ok(logged[0]!.includes(`removing messages ${a} to ${b}`) && logged[0]!.includes('zz-index-read-failed'), logged[0]);
    // Their ordinals stay issued until a host takes them out; the window
    // lists only what the record holds.
    assert.notEqual(cm.ordinalOf(a), undefined);
    assert.equal(cm.ordinalOf(c), oc);
    assert.deepEqual(texts(await cm.compile(BIG)), ['c']);
    cm.retractRows([a, b]);
    assert.equal(cm.ordinalOf(a), undefined);
    cm.close();
  });

  it('in legacy mode a removal writes nothing', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.removeMessage(a!);
    cm.removeMessages(b!, c!);
    assert.equal(cm.getStore().getStateJson(INDEX), null);
    assert.equal(cm.windowMode(), 'legacy');
    cm.close();
  });

  it('a removal through another manager on the slot isn\'t heard; retractRows takes the row out by its id', async () => {
    const writer = await ContextManager.open({ path: freshPath(), namespace: 'zz-writer', strategy: new PassthroughStrategy() });
    const cm = await ContextManager.open({ store: writer.getStore(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => writer.addMessage('alice', [text(t)]));
    cm.presentRows([a!, b!]);
    writer.removeMessage(a!);
    assert.deepEqual(texts(await cm.compile(BIG)), ['b'], 'the window lists only what the record holds');
    assert.notEqual(cm.ordinalOf(a!), undefined, 'but its ordinal stands until a host takes it out');
    cm.retractRows([a!]);
    assert.equal(cm.ordinalOf(a!), undefined);
    cm.close();
    writer.close();
  });

  it('a tombstone that can\'t be written is logged, and the removal stands', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)]));
    cm.presentRows([a!, b!]);
    const store = cm.getStore() as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
    const append = store.appendToStateJsonWithIdentity;
    store.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
      if (id === INDEX) throw new Error('zz-index-write-failed');
      return append.call(this, id, ...rest);
    };
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      cm.removeMessage(a!);
    } finally {
      console.error = error;
      store.appendToStateJsonWithIdentity = append;
    }
    assert.equal(cm.getMessage(a!), null, 'the removal stands');
    assert.ok(logged.some((line) => line.includes(`removed message ${a}`) && line.includes('zz-index-write-failed')), logged.join('\n'));
    assert.deepEqual(texts(await cm.compile(BIG)), ['b']);
    cm.close();
  });
});
