/**
 * Windowed passthrough's anchor over the agent's window (agent-framework
 * #291, src/strategies/windowed-passthrough.ts).
 *
 * While the window is the record (legacy mode) the anchor is a sequence, as
 * it always was, and the slot holds `{ anchor }`. Once a host presents rows
 * the anchor is an index ordinal: the window is the row at it and every row
 * presented after it. A sequence anchor is converted where a branch is
 * first read in presented mode, to the ordinal of the first row in the
 * window stored at that sequence or after, so the window at the conversion
 * is the one the sequence gave; it is written as `{ anchor, ordinal, v: 2 }`
 * when it is made, keeping the sequence for a release that reads it alone,
 * so a reload reads the ordinal back rather than converting again. From
 * then on a row stored before the anchor's sequence and presented later is
 * in the window, which a sequence anchor leaves out.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, WindowedPassthroughStrategy } from '../src/index.js';
import type { CompileResult } from '../src/index.js';

const BASE = './test-windowed-anchor';
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

const ANCHOR = 'zz/windowed:anchor';
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
/** About 51 tokens a message, so a budget of 250 holds four. */
const long = (t: string): ContentBlock[] => text(`${t}-${'x'.repeat(200)}`);
const OVERFLOW = { maxTokens: 300, reserveForResponse: 50 };

function texts(result: CompileResult): string[] {
  return result.messages.map((m) => (m.content[0] as { text: string }).text.split('-')[0]!);
}

async function open(path: string, options: { viewFilter?: (m: { metadata?: Record<string, unknown> }) => boolean } = {}) {
  const strategy = new WindowedPassthroughStrategy({ anchorStateId: ANCHOR });
  const cm = await ContextManager.open({ path, namespace: 'zz', strategy, ...(options as object) });
  return { cm, strategy };
}

function slot(cm: ContextManager): unknown {
  return cm.getStore().getStateJson(ANCHOR);
}

function sequenceOf(cm: ContextManager, id: string): number {
  return cm.getMessage(id)!.sequence;
}

describe('windowed passthrough: the anchor while the window is the record', () => {
  it('stays a sequence, and the slot holds { anchor } as it always has', async () => {
    const { cm, strategy } = await open(freshPath());
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => cm.addMessage('u', long(t)));
    strategy.setAnchor(sequenceOf(cm, ids[1]!));
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, ids[1]!) });
    assert.equal(strategy.getAnchorOrdinal(), undefined, 'no ordinal in legacy mode');

    // A re-anchor writes the same shape.
    const result = await cm.compile(OVERFLOW);
    assert.ok(result.messages.length < 5, 'the overflow re-anchored');
    assert.deepEqual(slot(cm), { anchor: strategy.getAnchor() });
    assert.equal(cm.windowMode(), 'legacy');
    cm.close();
  });
});

describe('windowed passthrough: a sequence anchor once rows are presented', () => {
  it('converts to the same window at the first presentation, and writes the conversion when it makes it', async () => {
    const { cm, strategy } = await open(freshPath());
    const ids = ['a', 'b', 'c', 'd', 'e'].map((t) => cm.addMessage('u', text(t)));
    const anchor = sequenceOf(cm, ids[2]!);
    strategy.setAnchor(anchor);
    const legacy = await cm.compile(BIG);
    assert.deepEqual(texts(legacy), ['c', 'd', 'e']);

    cm.presentRows([]);
    // A preview converts for itself and writes nothing.
    const head = cm.getStore().currentSequence();
    assert.deepEqual(texts(await cm.compile(BIG, undefined, { dryRun: true })), ['c', 'd', 'e']);
    assert.deepEqual(slot(cm), { anchor });
    assert.equal(cm.getStore().currentSequence(), head, 'a preview writes nothing');
    const converted = await cm.compile(BIG);
    assert.deepEqual(converted.messages, legacy.messages, 'byte-identical across the first presentation');
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(ids[2]!), 'the first row in the window stored at the anchor or after');
    // The work item's measure of the same place: the rows before it in the
    // window are the presented rows stored before the anchor.
    const window = cm.getPresentedMessages();
    const listed = window.findIndex((m) => cm.ordinalOf(m.id)! >= strategy.getAnchorOrdinal()!);
    assert.equal(listed, window.filter((m) => m.sequence < anchor).length);
    assert.equal(strategy.getAnchor(), anchor);
    // The compile that converted the anchor wrote it (review CM-L). Before,
    // only the next move wrote it, which left a reload to convert the
    // sequence again against a window that may have changed since.
    assert.deepEqual(slot(cm), { anchor, ordinal: cm.ordinalOf(ids[2]!), v: 2 }, 'the compile that converted it wrote it');

    strategy.setAnchor(sequenceOf(cm, ids[3]!));
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, ids[3]!), ordinal: cm.ordinalOf(ids[3]!), v: 2 });
    assert.deepEqual(texts(await cm.compile(BIG)), ['d', 'e']);
    cm.close();
  });

  it('converts an earlier release\'s slot on each branch where it is read, and writes it there', async () => {
    const path = freshPath();
    let { cm } = await open(path);
    const ids = ['a', 'b', 'c', 'd'].map((t) => cm.addMessage('u', text(t)));
    cm.presentRows([]);
    // What a release before this one leaves: a bare sequence, here on main
    // and, by the fork, on a branch made from it.
    cm.getStore().setStateJson(ANCHOR, { anchor: sequenceOf(cm, ids[1]!) });
    const main = cm.currentBranch().name;
    await cm.fork('zz-older');
    await cm.switchBranch(main);
    cm.close();

    let strategy: WindowedPassthroughStrategy;
    ({ cm, strategy } = await open(path));
    // The load is read-only; the read that converts writes the conversion
    // (review CM-L: before, nothing was written until the next move).
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, ids[1]!) }, 'read-only on load');
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(ids[1]!));
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, ids[1]!), ordinal: cm.ordinalOf(ids[1]!), v: 2 });
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'c', 'd']);

    // Main moves on and writes its anchor as an ordinal.
    const e = cm.addMessage('u', text('e'));
    cm.presentRows([e]);
    strategy.setAnchor(sequenceOf(cm, e));
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, e), ordinal: cm.ordinalOf(e), v: 2 });

    // The older branch, switched to underneath as a host's undo does,
    // converts its own slot when it is read, and writes it there; main's is
    // untouched.
    cm.getStore().switchBranch('zz-older');
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, ids[1]!) });
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(ids[1]!));
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'c', 'd']);
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, ids[1]!), ordinal: cm.ordinalOf(ids[1]!), v: 2 });
    cm.getStore().switchBranch(main);
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, e), ordinal: cm.ordinalOf(e), v: 2 });
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(e));
    assert.deepEqual(texts(await cm.compile(BIG)), ['e']);
    cm.close();
  });

  // Review CM-L: the conversion was kept in memory only, so a reload
  // converted the sequence again against the window as it stood then. Once
  // a row stored before the sequence was presented again after the first
  // conversion, the reload started the window after it, a change of window
  // with no move. Each fails on the build before the conversion was written.
  it('a converted anchor survives a reload after an older row is presented again', async () => {
    const path = freshPath();
    let { cm, strategy } = await open(path);
    const [, b] = ['a', 'b'].map((t) => cm.addMessage('u', text(t)));
    // A tune-out starts at the head in legacy mode: the slot is a sequence
    // past every row.
    const start = cm.getStore().currentSequence() + 1;
    strategy.setAnchor(start);
    assert.deepEqual(slot(cm), { anchor: start });
    cm.presentRows([]);
    assert.deepEqual(texts(await cm.compile(BIG)), [], 'the first compile converts it: no row is stored at the start or after');
    const ordinal = strategy.getAnchorOrdinal();
    assert.equal(ordinal, cm.indexLength());
    assert.deepEqual(slot(cm), { anchor: start, ordinal, v: 2 });

    // b, stored before the start, is taken out and presented again, as an
    // undo and its redo do; c arrives and is presented.
    cm.retractRows([b!]);
    cm.presentRows([b!]);
    const c = cm.addMessage('u', text('c'));
    cm.presentRows([c]);
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'c']);
    cm.close();

    ({ cm, strategy } = await open(path));
    assert.equal(strategy.getAnchorOrdinal(), ordinal, 'the ordinal the window was sent from');
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'c'], 'the same window: converting the start again would leave b out');
    cm.close();
  });

  it('a conversion a read makes is written by that read', async () => {
    // The reviewer's probe: the anchor is read, not compiled, before the
    // older row is presented again.
    const path = freshPath();
    let { cm, strategy } = await open(path);
    const [, b] = ['a', 'b'].map((t) => cm.addMessage('u', text(t)));
    const start = cm.getStore().currentSequence() + 1;
    strategy.setAnchor(start);
    cm.presentRows([]);
    const ordinal = strategy.getAnchorOrdinal();
    assert.deepEqual(slot(cm), { anchor: start, ordinal, v: 2 });
    cm.retractRows([b!]);
    cm.presentRows([b!]);
    const c = cm.addMessage('u', text('c'));
    cm.presentRows([c]);
    assert.deepEqual(cm.renderAsNewest([b!, c]), [text('b'), text('c')]);
    cm.close();

    ({ cm, strategy } = await open(path));
    assert.deepEqual(cm.renderAsNewest([b!, c]), [text('b'), text('c')], 'renderAsNewest reads the same window');
    assert.deepEqual(texts(await cm.compile(BIG)), ['b', 'c']);
    cm.close();
  });
});

describe('windowed passthrough: the anchor as an ordinal', () => {
  it('setAnchor(currentSequence()) past the last row maps to the index length, and keeps every row presented after', async () => {
    const { cm, strategy } = await open(freshPath());
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('u', text(t)));
    cm.presentRows([a!, b!]);
    // c and d arrive during a turn and aren't presented yet; then a
    // tune-out starts, at the store's head.
    const c = cm.addMessage('u', text('c'));
    const d = cm.addMessage('u', text('d'));
    const start = cm.getStore().currentSequence();
    strategy.setAnchor(start);
    assert.equal(strategy.getAnchorOrdinal(), cm.indexLength(), 'no row in the window is stored at the head or after');
    assert.deepEqual(slot(cm), { anchor: start, ordinal: cm.indexLength(), v: 2 });
    assert.deepEqual(texts(await cm.compile(BIG)), []);

    // Presented after the tune-out started, they are in its window, though
    // the record has c, at least, before it.
    cm.presentRows([c, d]);
    assert.ok(sequenceOf(cm, c) < strategy.getAnchor(), 'c was stored before the anchor\'s sequence');
    assert.deepEqual(texts(await cm.compile(BIG)), ['c', 'd']);
    // A sequence anchor would have left c out: the inclusion rule changes
    // by design.
    const bySequence = cm.getPresentedMessages().filter((m) => m.sequence >= start).map((m) => m.id);
    assert.ok(!bySequence.includes(c));

    // The same sequence again, as a host sets a tune-out's start at a
    // restart, keeps the window.
    const e = cm.addMessage('u', text('e'));
    cm.presentRows([e]);
    const ordinal = strategy.getAnchorOrdinal();
    strategy.setAnchor(start);
    assert.equal(strategy.getAnchorOrdinal(), ordinal);
    assert.deepEqual(texts(await cm.compile(BIG)), ['c', 'd', 'e']);
    cm.close();
  });

  it('a row stored before the anchor\'s row but presented after it is inside the window', async () => {
    const path = freshPath();
    const { cm, strategy } = await open(path);
    cm.presentRows([]);
    const x = cm.addMessage('u', text('x'));
    const y = cm.addMessage('u', text('y'));
    cm.presentRows([y]);
    cm.presentRows([x]);
    strategy.setAnchor(sequenceOf(cm, y));
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(y));
    assert.deepEqual(texts(await cm.compile(BIG)), ['y', 'x']);

    // renderAsNewest renders by the same rule as the compile sends.
    const [renderedX] = cm.renderAsNewest([x])!;
    assert.deepEqual(renderedX, text('x'));
    strategy.setAnchor(sequenceOf(cm, x) + 1);
    // y is the first row in the window stored at x's sequence + 1 or after.
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(y));
    const z = cm.addMessage('u', text('z'));
    cm.presentRows([z]);
    strategy.setAnchorOrdinal(cm.ordinalOf(x)!);
    assert.deepEqual(cm.renderAsNewest([y, x]), [null, text('x')], 'y is before the anchor now');
    assert.deepEqual(texts(await cm.compile(BIG)), ['x', 'z']);
    // The slot's sequence is x's, which converted would start the window at
    // y, the first row in it stored there or after: a reopen reads the
    // ordinal, not the sequence.
    const ordinal = cm.ordinalOf(x);
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, x), ordinal, v: 2 });
    cm.close();
    const reopened = await open(path);
    assert.equal(reopened.strategy.getAnchorOrdinal(), ordinal);
    assert.deepEqual(texts(await reopened.cm.compile(BIG)), ['x', 'z']);
    reopened.cm.close();
  });

  it('re-anchors by ordinal on overflow, persists it beside the row\'s sequence, and stays byte-stable', async () => {
    const path = freshPath();
    const { cm, strategy } = await open(path);
    cm.presentRows([]);
    const ids = Array.from({ length: 10 }, (_, i) => cm.addMessage('u', long(`m${i}`)));
    // Presented out of record order: the odd rows, then the even ones.
    cm.presentRows(ids.filter((_, i) => i % 2 === 1));
    cm.presentRows(ids.filter((_, i) => i % 2 === 0));

    const first = await cm.compile(OVERFLOW);
    assert.ok(first.messages.length < 10, 'the overflow re-anchored');
    const startId = cm.getPresentedMessages().find((m) => texts(first)[0] === (m.content[0] as { text: string }).text.split('-')[0])!.id;
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(startId));
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, startId), ordinal: cm.ordinalOf(startId), v: 2 });

    const second = await cm.compile(OVERFLOW);
    assert.deepEqual(second.messages.map((m) => m.content), first.messages.map((m) => m.content), 'no growth, no move');

    // A row taken out before the anchor moves no other row's ordinal, so
    // the window keeps its start.
    const before = cm.getPresentedMessages()[0]!.id;
    cm.retractRows([before]);
    const third = await cm.compile(OVERFLOW);
    assert.deepEqual(third.messages.map((m) => m.content), first.messages.map((m) => m.content));
    const ordinal = cm.ordinalOf(startId);
    assert.equal(strategy.getAnchorOrdinal(), ordinal);
    cm.close();

    // A reopen reads the ordinal back.
    const reopened = await open(path);
    assert.equal(reopened.strategy.getAnchorOrdinal(), ordinal);
    assert.deepEqual(texts(await reopened.cm.compile(OVERFLOW)), texts(first));
    reopened.cm.close();
  });

  it('counts the window before the view filter, so a host\'s filter doesn\'t move it', async () => {
    const path = freshPath();
    const filtered = await open(path, { viewFilter: (m) => !m.metadata?.hidden });
    let cm = filtered.cm;
    cm.presentRows([]);
    const a = cm.addMessage('u', text('a'));
    const h = cm.addMessage('u', text('h'), { hidden: true });
    const b = cm.addMessage('u', text('b'));
    cm.presentRows([a, h, b]);
    filtered.strategy.setAnchorOrdinal(cm.ordinalOf(h)!);
    assert.deepEqual(texts(await cm.compile(BIG)), ['b']);
    cm.close();

    const unfiltered = await open(path);
    cm = unfiltered.cm;
    assert.equal(unfiltered.strategy.getAnchorOrdinal(), cm.ordinalOf(h));
    assert.deepEqual(texts(await cm.compile(BIG)), ['h', 'b']);
    cm.close();
  });

  it('setAnchorOrdinal refuses in legacy mode and outside the index', async () => {
    const { cm, strategy } = await open(freshPath());
    const a = cm.addMessage('u', text('a'));
    assert.throws(() => strategy.setAnchorOrdinal(0), /no row has been presented on this branch/);
    cm.presentRows([]);
    for (const bad of [-1, 0.5, cm.indexLength() + 1, Number.NaN]) {
      assert.throws(() => strategy.setAnchorOrdinal(bad), RangeError);
    }
    // No row is at the index length: the sequence beside it is the head's
    // as the call found it (the slot's write comes after).
    const head = cm.getStore().currentSequence();
    strategy.setAnchorOrdinal(cm.indexLength());
    assert.deepEqual(slot(cm), { anchor: head, ordinal: cm.indexLength(), v: 2 });
    strategy.setAnchorOrdinal(cm.ordinalOf(a)!);
    assert.deepEqual(slot(cm), { anchor: sequenceOf(cm, a), ordinal: cm.ordinalOf(a), v: 2 });
    cm.close();
  });
});

describe('windowed passthrough: a persisted anchor that names no place', () => {
  async function reopenWarned(path: string) {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      return { ...(await open(path)), warned };
    } finally {
      console.warn = warn;
    }
  }

  it('an ordinal past the index length resets to 0, as a sequence past the head does', async () => {
    const path = freshPath();
    let { cm } = await open(path);
    cm.addMessage('u', text('a'));
    const b = cm.addMessage('u', text('b'));
    cm.presentRows([]);
    // The sequence beside the bad ordinal is b's, not 0 (review CM-P): with
    // 0 there, a load that kept the sequence, or converted it, would pass
    // as a reset. Kept, it would start the window at b.
    cm.getStore().setStateJson(ANCHOR, { anchor: sequenceOf(cm, b), ordinal: 1_000, v: 2 });
    cm.close();

    const reopened = await reopenWarned(path);
    cm = reopened.cm;
    assert.ok(
      reopened.warned.some((w) => w.startsWith('[windowed-passthrough] persisted anchor ordinal 1000 is past the window index\'s length 3') && w.endsWith(' ns=zz')),
      reopened.warned.join('\n'),
    );
    assert.equal(reopened.strategy.getAnchor(), 0);
    assert.equal(reopened.strategy.getAnchorOrdinal(), cm.ordinalOf(cm.getAllMessages()[0]!.id));
    assert.deepEqual(texts(await cm.compile(BIG)), ['a', 'b'], 'the window from its start, not from b');
    cm.close();
  });

  it('a sequence past the head resets to 0 in presented mode too', async () => {
    const path = freshPath();
    let { cm } = await open(path);
    cm.addMessage('u', text('a'));
    cm.presentRows([]);
    cm.getStore().setStateJson(ANCHOR, { anchor: 1_000_000, ordinal: 1, v: 2 });
    cm.close();

    const reopened = await reopenWarned(path);
    cm = reopened.cm;
    assert.ok(reopened.warned.some((w) => w.startsWith('[windowed-passthrough] persisted anchor 1000000 is past the branch head')), reopened.warned.join('\n'));
    assert.equal(reopened.strategy.getAnchor(), 0);
    assert.deepEqual(texts(await cm.compile(BIG)), ['a']);
    cm.close();
  });

  it('a branch switched to underneath without the anchor takes its own, from its start', async () => {
    const { cm, strategy } = await open(freshPath());
    cm.presentRows([]);
    const ids = ['m1', 'm2'].map((t) => cm.addMessage('u', text(t)));
    cm.presentRows(ids);
    const main = cm.currentBranch().name;
    await cm.fork('zz-alt');
    await cm.switchBranch(main);
    const m3 = cm.addMessage('u', text('m3'));
    cm.presentRows([m3]);
    strategy.setAnchor(sequenceOf(cm, m3));
    assert.deepEqual(texts(await cm.compile(BIG)), ['m3']);

    cm.getStore().switchBranch('zz-alt');
    assert.equal(strategy.getAnchor(), 0, 'the in-memory anchor is not carried over');
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(ids[0]!));
    assert.deepEqual(texts(await cm.compile(BIG)), ['m1', 'm2']);
    assert.equal(slot(cm), null, 'an anchor at the start is converted in memory only: it is the whole window whenever it is converted');
    cm.getStore().switchBranch(main);
    assert.equal(strategy.getAnchorOrdinal(), cm.ordinalOf(m3));
    cm.close();
  });
});

describe('windowed passthrough: a derived context', () => {
  const supported = typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function';
  const skip = supported ? false : 'installed @animalabs/chronicle has no JsStore.view (branch-bound handles)';

  it('inherits an anchor written as an ordinal and sends the parent\'s window', { skip }, async () => {
    const { cm: parent, strategy } = await open(freshPath());
    parent.presentRows([]);
    const ids = Array.from({ length: 8 }, (_, i) => parent.addMessage('u', long(`m${i}`)));
    parent.presentRows(ids);
    const sent = await parent.compile(OVERFLOW);
    assert.ok(sent.messages.length < 8, 'the parent re-anchored');
    assert.equal((slot(parent) as { v?: number }).v, 2);

    const childStrategy = new WindowedPassthroughStrategy({ anchorStateId: ANCHOR });
    const child = await parent.derive({ branch: 'zz/child', strategy: childStrategy });
    // The child has the parent's window index (derive lists it among the
    // manager's own states), so it reads the slot by ordinal. A branch
    // without that index would read it by the sequence beside it.
    assert.equal(childStrategy.getAnchor(), strategy.getAnchor());
    assert.equal(child.windowMode(), 'presented');
    assert.equal(childStrategy.getAnchorOrdinal(), strategy.getAnchorOrdinal());
    assert.deepEqual((await child.compile(OVERFLOW)).messages.map((m) => m.content), sent.messages.map((m) => m.content));
    child.close();
    parent.close();
  });

  it('a child reopened before it moves its anchor reads the ordinal against the window it inherited', { skip }, async () => {
    // A row stored before the anchor's sequence and presented after its row
    // is in the window by ordinal and out of it by sequence, so the two
    // readings send different windows. Before derive carried the index, the
    // child read this slot by sequence, in legacy mode; and once it had
    // written its own index, a reopen read the parent's ordinal against it.
    const path = freshPath();
    const { cm: parent, strategy } = await open(path);
    parent.presentRows([]);
    const early = parent.addMessage('u', long('early'));
    const ids = Array.from({ length: 3 }, (_, i) => parent.addMessage('u', long(`m${i}`)));
    parent.presentRows(ids);
    strategy.setAnchorOrdinal(parent.ordinalOf(ids[1]!)!);
    parent.presentRows([early]);
    const sent = await parent.compile(BIG);
    assert.deepEqual(texts(sent), ['m1', 'm2', 'early']);
    const ordinal = strategy.getAnchorOrdinal();

    const child = await parent.derive({ branch: 'zz/child', strategy: new WindowedPassthroughStrategy({ anchorStateId: ANCHOR }) });
    assert.deepEqual(texts(await child.compile(BIG)), ['m1', 'm2', 'early']);
    const derivation = child.getDerivation()!;
    child.close();
    parent.close();

    const root = await ContextManager.open({ path, namespace: 'zz', strategy: new WindowedPassthroughStrategy({ anchorStateId: ANCHOR }) });
    const reopenedStrategy = new WindowedPassthroughStrategy({ anchorStateId: ANCHOR });
    const reopened = await ContextManager.reopenDerived({ store: root.getStore(), derivation, strategy: reopenedStrategy });
    assert.equal(reopenedStrategy.getAnchorOrdinal(), ordinal);
    assert.deepEqual(texts(await reopened.compile(BIG)), ['m1', 'm2', 'early']);
    reopened.close();
    root.close();
  });
});
