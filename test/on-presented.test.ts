/**
 * The strategy hears rows as they enter the agent's window
 * (ContextStrategy.onPresented, agent-framework #291).
 *
 * In legacy mode the window is the record, so a row enters it when the
 * manager stores it, and the strategy hears it from inside the add, as
 * onNewMessage did (#288; strategy-new-message-throw.test.ts pins that
 * order). Once a host presents rows, a stored row isn't in the window until
 * it is presented, so the strategy hears it from presentRows instead: while
 * the strategy is initialized, once per call, with the rows that entered,
 * after they are in the window and before presentRows returns, fire and
 * forget; while it isn't, the calls wait, and once it is, one call carries
 * the rows still in the window, in window order. A hold is still placed at the
 * add. These are the presented-mode siblings of the #288 suite, and the
 * autobiographical strategy's chunk rebuild and background compression,
 * which follow the window: a stored row nobody presented is never folded.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  ContextManager,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
  windowIndexStateId,
} from '../src/index.js';
import type { MessageId, MessageStoreView, StoredMessage, StrategyContext } from '../src/index.js';
import { perItemIndexWrites } from './_harness/index-writes.js';

const BASE = './test-on-presented';
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

/** One macrotask turn: by then a rejection's handler has run, and an unhandled one would have been reported. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** console.error's calls while `fn` runs. */
async function errorsDuring(fn: () => Promise<void>): Promise<unknown[][]> {
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return errors;
}

function watchUnhandled() {
  const seen: string[] = [];
  const onError = (err: unknown) => { seen.push(String(err)); };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { seen, restore: () => { process.off('uncaughtException', onError); process.off('unhandledRejection', onError); } };
}

/** What one onPresented call saw. */
interface Heard {
  rows: MessageId[];
  held: Array<boolean | undefined>;
  window: MessageId[];
}

/** A strategy that keeps what each onPresented call was given, every onNewMessage call, and each onRetracted call's rows and `undone`. */
class Records extends PassthroughStrategy {
  heard: Heard[] = [];
  newMessages: MessageId[] = [];
  retracted: Array<{ rows: MessageId[]; undone: boolean }> = [];
  async onRetracted(rows: readonly StoredMessage[], _ctx: StrategyContext, info: { undone: boolean; removed: boolean }): Promise<void> {
    this.retracted.push({ rows: rows.map((m) => m.id), undone: info.undone });
  }
  async onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
    this.heard.push({
      rows: rows.map((m) => m.id),
      held: rows.map((m) => ctx.messageStore.isCompressionHeld?.(m.id)),
      window: ctx.messageStore.getAll().map((m) => m.id),
    });
    await settle();
  }
  async onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    this.newMessages.push(message.id);
  }
}

/** Records, storing a message of two or more blocks as one shard per block. */
class ShardingRecords extends Records {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: 'zz-doc', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

/** Records whose initialize waits for `gate`, once one is set. */
class GatedRecords extends Records {
  gate: Promise<void> | undefined;
  async initialize(_ctx: StrategyContext): Promise<void> {
    await this.gate;
  }
}

/** A strategy with neither onPresented nor onNewMessage, whose initialize waits for `gate`, once one is set. */
class Unhooked extends PassthroughStrategy {
  gate: Promise<void> | undefined;
  constructor() {
    super();
    (this as { onNewMessage?: unknown }).onNewMessage = undefined;
  }
  async initialize(_ctx: StrategyContext): Promise<void> {
    await this.gate;
  }
}

/** A host strategy that knows only onNewMessage. */
class HearsNewMessages extends PassthroughStrategy {
  heard: Array<{ id: MessageId; window: MessageId[] }> = [];
  async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
    this.heard.push({ id: message.id, window: ctx.messageStore.getAll().map((m) => m.id) });
  }
}

describe('onPresented in presented mode', () => {
  it('fires inside presentRows with the rows that entered, in window order, over a view that holds them, after the hold placed at the add', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const a = cm.addMessage('alice', [text('a')]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[a]], 'in legacy mode the add is heard');
    cm.presentRows([]);
    assert.equal(strategy.heard.length, 1, 'writing the legacy window down enters no new row');

    const held = cm.addMessage('alice', [text('held')], undefined, undefined, { holdCompression: true });
    const b = cm.addMessage('bob', [text('b')]);
    assert.equal(strategy.heard.length, 1, 'a row stored in presented mode is not heard at its add');
    assert.ok(cm.getCompressionHolds().has(held), 'the hold is placed at the add all the same');

    const ordinals = cm.presentRows([b, held]);
    // Checked before anything settles: the hook's synchronous part ran
    // inside presentRows.
    assert.deepEqual(strategy.heard.slice(1), [{ rows: [b, held], held: [false, true], window: [a, b, held] }]);
    assert.deepEqual(ordinals, [cm.ordinalOf(b), cm.ordinalOf(held)]);
    assert.deepEqual(strategy.newMessages, [], 'a strategy with onPresented is not called through onNewMessage');
    await settle();
    cm.close();
  });

  it('a sharded body enters whole: the hook is given every shard, in order', async () => {
    const strategy = new ShardingRecords();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('part 0 '), text('part 1 '), text('part 2 ')]);
    const shards = cm.getAllMessages().map((m) => m.id);
    assert.equal(shards[0], doc);
    assert.equal(strategy.heard.length, 0);
    cm.presentRows([doc]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [shards]);
    await settle();
    cm.close();
  });

  it('the first presentRows, which writes the legacy window down, calls nothing, even for the rows it names', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const a = cm.addMessage('alice', [text('a')]);
    const b = cm.addMessage('bob', [text('b')]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[a], [b]], 'each row was heard at its add');
    cm.presentRows([a, b]);
    assert.equal(cm.windowMode(), 'presented');
    assert.equal(strategy.heard.length, 2, 'nothing entered the window, so nothing is heard again');
    const c = cm.addMessage('alice', [text('c')]);
    assert.equal(strategy.heard.length, 2);
    cm.presentRows([c]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[a], [b], [c]]);
    await settle();
    cm.close();
  });

  // retractRows called nothing on the strategy before onRetracted (#291
  // CM-6): an undone row stayed inside what the strategy had folded of it.
  // It now calls onRetracted once, and still nothing of onPresented's;
  // on-retracted.test.ts holds that hook's own suite.
  it('retractRows calls onRetracted once with undone, not onPresented, and a row presented again is heard again', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    cm.presentRows([a]);
    cm.retractRows([a], { undone: true });
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[a]]);
    assert.deepEqual(strategy.retracted, [{ rows: [a], undone: true }]);
    cm.presentRows([a]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[a], [a]]);
    assert.deepEqual(strategy.heard[1]!.window, [a]);
    await settle();
    cm.close();
  });

  it('a synchronous throw or a rejection is logged, naming the rows, and the rows stay presented', async () => {
    class Throws extends PassthroughStrategy {
      calls = 0;
      onPresented(_rows: readonly StoredMessage[], _ctx: StrategyContext): Promise<void> {
        this.calls++;
        if (this.calls === 1) throw new Error('zz onPresented threw synchronously');
        return Promise.reject(new Error('zz onPresented rejected'));
      }
    }
    const strategy = new Throws();
    const unhandled = watchUnhandled();
    try {
      let ids: MessageId[] = [];
      let ordinals: number[] = [];
      let c: MessageId | undefined;
      let window: MessageId[] = [];
      const errors = await errorsDuring(async () => {
        const cm = await ContextManager.open({ path: freshPath(), namespace: 'agents/zz-throws', strategy });
        try {
          cm.presentRows([]);
          ids = [cm.addMessage('alice', [text('a')]), cm.addMessage('bob', [text('b')])];
          ordinals = cm.presentRows(ids);
          c = cm.addMessage('alice', [text('c')]);
          cm.presentRows([c]);
          window = cm.getPresentedMessages().map((m) => m.id);
          await settle();
        } finally {
          cm.close();
        }
      });
      assert.equal(ordinals.length, 2, 'presentRows returned the ordinals');
      assert.deepEqual(window, [...ids, c], 'the rows are in the window');
      const logged = errors.filter((args) => String(args[0]).startsWith('Strategy onPresented failed for '));
      assert.deepEqual(logged.map((args) => String(args[0])), [
        `Strategy onPresented failed for 2 messages presented, ${ids[0]} to ${ids[1]}: ns=agents/zz-throws`,
        `Strategy onPresented failed for message ${c}: ns=agents/zz-throws`,
      ]);
      assert.match(String(logged[0]![1]), /zz onPresented threw synchronously/);
      assert.match(String(logged[1]![1]), /zz onPresented rejected/);
      assert.deepEqual(unhandled.seen, [], 'nothing escapes as an uncaught error');
    } finally {
      unhandled.restore();
    }
  });

  it('a strategy with only onNewMessage hears each presented row through it, in window order, and nothing at the add', async () => {
    const strategy = new HearsNewMessages();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const a = cm.addMessage('alice', [text('a')]);
    assert.deepEqual(strategy.heard, [{ id: a, window: [a] }], 'legacy mode: heard inside the add');
    cm.presentRows([]);
    const b = cm.addMessage('bob', [text('b')]);
    const c = cm.addMessage('alice', [text('c')]);
    assert.equal(strategy.heard.length, 1, 'presented mode: not heard at the add');
    cm.presentRows([c, b]);
    assert.deepEqual(strategy.heard.slice(1), [
      { id: c, window: [a, c, b] },
      { id: b, window: [a, c, b] },
    ]);
    cm.close();
  });

  it('a row from an auxiliary slot is heard when it is presented', async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const strategy = new Records();
    const side = await ContextManager.open({
      store: main.getStore(),
      namespace: 'subconscious/zz',
      isolate: true,
      strategy,
      auxiliaryMessageViews: [{}],
    });
    main.addMessage('alice', [text('m1')]);
    assert.equal(strategy.heard.length, 0, 'in legacy mode an auxiliary row enters the window unheard, as it always has');
    side.presentRows([]);
    const m2 = main.addMessage('alice', [text('m2')]);
    assert.equal(strategy.heard.length, 0);
    side.presentRows([m2]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[m2]]);
    await settle();
    side.close();
    main.close();
  });

  // CM #350 bot review, wave 2, finding 35: the write has landed by then, so
  // presentRows doesn't throw, which a retry would meet as "in the window
  // already"; the rows wait to be heard.
  it("the manager's own work around the call failing is logged, the rows stay presented, and the strategy hears them at its next notification", async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    const b = cm.addMessage('bob', [text('b')]);
    // The context the manager builds for the hook is the manager's own work.
    const own = cm as unknown as { createStrategyContext?: () => never };
    own.createStrategyContext = () => {
      throw new Error('zz the manager failed');
    };
    let ordinals: number[] = [];
    let errors: unknown[][];
    try {
      errors = await errorsDuring(async () => {
        ordinals = cm.presentRows([a]);
      });
    } finally {
      delete own.createStrategyContext;
    }
    assert.equal(ordinals.length, 1, 'presentRows returned its ordinal');
    assert.ok(errors.some((args) => args.map(String).join(' ').includes('zz the manager failed')), 'the failure is logged');
    assert.equal(strategy.heard.length, 0, 'the strategy was never called');
    assert.notEqual(cm.ordinalOf(a), undefined, 'the presentation stands');
    cm.presentRows([b]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[a], [b]], 'a is heard at the next notification, first');
    await settle();
    cm.close();
  });

  it('rows presented while the strategy initializes are heard once it has, those still in the window', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    class Gated extends Records {
      async initialize(_ctx: StrategyContext): Promise<void> {
        await gate;
      }
    }
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    const b = cm.addMessage('bob', [text('b')]);
    const c = cm.addMessage('carol', [text('c')]);
    const strategy = new Gated();
    const initialized = cm.setStrategy(strategy);
    cm.presentRows([c]);
    cm.presentRows([b]);
    cm.retractRows([b]);
    cm.retractRows([c]);
    cm.presentRows([a]);
    cm.presentRows([c]);
    assert.equal(strategy.heard.length, 0, 'nothing reaches a strategy that is initializing');
    open();
    await initialized;
    assert.deepEqual(
      strategy.heard.map((h) => h.rows),
      [[a, c]],
      'once it initialized, one call: b left the window meanwhile, and c, presented twice, is heard once, where the window holds it',
    );
    await settle();
    cm.close();
  });

  // House review of #350, code finding 1 (presented half): the rows wait for
  // the manager's strategy, not for the instance initializing, so they wait
  // while a strategy with no row hook initializes too.
  it('rows presented while a strategy with no row hook initializes reach the strategy set in its place, after its own initialize', async () => {
    for (const hooked of [false, true]) {
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      cm.presentRows([]);
      const a = cm.addMessage('alice', [text('a')]);
      const { gate, open } = gated();
      // The control's initializing strategy has the hook; the probe's has neither row hook.
      const initializing = hooked ? new GatedRecords() : new Unhooked();
      initializing.gate = gate;
      const first = cm.setStrategy(initializing);
      cm.presentRows([a]);
      // CM #350 bot review (wave 2), finding 47: the replacement's own
      // initialize waits too, so the test tells after it from before it.
      const replacement = new GatedRecords();
      const own = gated();
      replacement.gate = own.gate;
      const second = cm.setStrategy(replacement);
      const superseded = assert.rejects(first, /supersed/i);
      open();
      await settle();
      assert.equal(replacement.heard.length, 0, `${hooked ? 'control' : 'probe'}: nothing reaches the replacement while it initializes`);
      own.open();
      await second;
      await superseded;
      assert.deepEqual(replacement.heard.map((h) => h.rows), [[a]], `${hooked ? 'control' : 'probe'}: the replacement hears the row once, after its initialize`);
      await settle();
      cm.close();
    }
  });

  // CM #350 bot review finding 22: a delivery whose read fails keeps the rows
  // waiting, and the strategy's next notification tries it again.
  it("rows presented while the strategy initializes, whose delivery can't read the window, are heard at its next notification, before that one's rows", async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const x = cm.addMessage('alice', [text('x')]);
    const y = cm.addMessage('bob', [text('y')]);
    const { gate, open } = gated();
    const strategy = new GatedRecords();
    strategy.gate = gate;
    const initialized = cm.setStrategy(strategy);
    cm.presentRows([x]);
    // The next read of the window throws: the delivery's, once the initialize returns.
    const reads = cm as unknown as { presentedMessageView: () => unknown };
    const read = reads.presentedMessageView;
    let fail = true;
    reads.presentedMessageView = function (this: unknown) {
      if (fail) {
        fail = false;
        throw new Error('zz-window-read-failed');
      }
      return read.call(this);
    };
    let errors: unknown[][];
    try {
      errors = await errorsDuring(async () => {
        open();
        await initialized;
      });
    } finally {
      delete (reads as { presentedMessageView?: unknown }).presentedMessageView;
    }
    assert.equal(fail, false, 'setup: the read failed');
    assert.ok(errors.some((args) => args.map(String).join(' ').includes('zz-window-read-failed')), 'and was logged');
    assert.equal(strategy.heard.length, 0, 'nothing was heard');
    cm.presentRows([y]);
    assert.deepEqual(strategy.heard.map((h) => h.rows), [[x], [y]], 'x is heard at the next notification, first');
    await settle();
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 4: a retried call's hook can start
  // an initialization, which the notification that retried it waits for.
  it("a notification whose retried call's hook sets a strategy waits for that strategy's initialize", async () => {
    for (const next of ['presentRows', 'retractRows'] as const) {
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      cm.presentRows([]);
      const x = cm.addMessage('alice', [text('x')]);
      const y = cm.addMessage('bob', [text('y')]);
      cm.presentRows(next === 'presentRows' ? [x] : [x, y]);
      const replacement = new GatedRecords();
      const later = gated();
      replacement.gate = later.gate;
      let replaced: Promise<void> | undefined;
      class Replaces extends GatedRecords {
        async onRetracted(rows: readonly StoredMessage[], ctx: StrategyContext, info: { undone: boolean; removed: boolean }): Promise<void> {
          replaced ??= cm.setStrategy(replacement);
          return super.onRetracted(rows, ctx, info);
        }
      }
      const first = new Replaces();
      const { gate, open } = gated();
      first.gate = gate;
      const initialized = cm.setStrategy(first);
      cm.retractRows([x]);
      // The delivery's read of the record throws, once: the call waits.
      const reads = cm as unknown as { mergedMessageView: () => unknown };
      const read = reads.mergedMessageView;
      let fail = true;
      reads.mergedMessageView = function (this: unknown) {
        if (fail) {
          fail = false;
          throw new Error('zz-record-read-failed');
        }
        return read.call(this);
      };
      try {
        await errorsDuring(async () => {
          open();
          await initialized;
        });
      } finally {
        delete (reads as { mergedMessageView?: unknown }).mergedMessageView;
      }
      assert.equal(fail, false, `${next}, setup: the read failed`);
      assert.equal(first.retracted.length, 0, `${next}, setup: the call waits`);
      if (next === 'presentRows') cm.presentRows([y]);
      else cm.retractRows([y]);
      assert.deepEqual(first.retracted.map((r) => r.rows), [[x]], `${next}: the call that waited reached the strategy it waited for`);
      assert.deepEqual([replacement.heard.length, replacement.retracted.length], [0, 0], `${next}: nothing reaches the replacement while it initializes`);
      later.open();
      await replaced;
      if (next === 'presentRows') assert.deepEqual(replacement.heard.map((h) => h.rows), [[y]], 'the presentation reaches it once it has');
      else assert.deepEqual(replacement.retracted.map((r) => r.rows), [[y]], 'the retraction reaches it once it has');
      await settle();
      cm.close();
    }
  });

  // House review of #350, untested contract 3: a row the view filter leaves
  // out is given to onPresented all the same, and the context neither lists
  // it nor gives it a position.
  it('a row the view filter leaves out is given all the same, and the view neither lists it nor gives it a position', async () => {
    const seen: Array<{ rows: MessageId[]; window: MessageId[]; got: Array<MessageId | undefined>; positions: Array<number | undefined>; ordinals: Array<number | undefined> }> = [];
    class Positions extends PassthroughStrategy {
      async onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
        const listing = ctx.messageStore.getAll();
        const ordinals = ctx.window?.ordinals();
        seen.push({
          rows: rows.map((m) => m.id),
          window: listing.map((m) => m.id),
          got: rows.map((m) => ctx.messageStore.get(m.id)?.id),
          // A position in the listing the strategy reads: positionOf where the view answers it.
          positions: rows.map((m) => (ctx.messageStore.positionOf ? ctx.messageStore.positionOf(m.id) : undefined) ?? (listing.findIndex((l) => l.id === m.id) >= 0 ? listing.findIndex((l) => l.id === m.id) : undefined)),
          ordinals: rows.map((m) => ordinals?.get(m.id)),
        });
      }
    }
    const hidden = (m: StoredMessage) => (m.content[0] as { text?: string }).text === 'hidden';
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new Positions(), viewFilter: (m) => !hidden(m) });
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    const h = cm.addMessage('bob', [text('hidden')]);
    cm.presentRows([a, h]);
    assert.deepEqual(seen, [{
      rows: [a, h], window: [a], got: [a, undefined], positions: [0, undefined], ordinals: [cm.ordinalOf(a), cm.ordinalOf(h)],
    }], 'the filtered row is given; the view neither lists it, gets it nor positions it; its ordinal counts the window before the filter');
    assert.notEqual(cm.ordinalOf(h), undefined);
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a, h], 'the window before the filter holds both');
    await settle();
    cm.close();
  });

  for (const [name, make] of [
    ['passthrough', () => new PassthroughStrategy()],
    ['windowed passthrough', () => new WindowedPassthroughStrategy()],
  ] as const) {
    it(`${name} does nothing when rows are presented, and compiles the window`, async () => {
      const strategy = make();
      assert.equal((strategy as { onPresented?: unknown }).onPresented, undefined, 'no onPresented: a subclass overriding onNewMessage still hears');
      const errors = await errorsDuring(async () => {
        const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
        try {
          cm.presentRows([]);
          const a = cm.addMessage('alice', [text('a')]);
          const b = cm.addMessage('bob', [text('b')]);
          cm.presentRows([b, a]);
          await settle();
          const result = await cm.compile(BIG);
          assert.deepEqual(result.messages.map((m) => (m.content[0] as { text: string }).text), ['b', 'a']);
        } finally {
          cm.close();
        }
      });
      assert.deepEqual(errors, []);
    });
  }
});

/**
 * A strategy that knows only onNewMessage, keeping the rows it hears, whose
 * first row's hook runs `onFirst`; its initialize waits for `gate`.
 */
class Reacts extends PassthroughStrategy {
  heard: MessageId[] = [];
  detached = 0;
  gate: Promise<void> | undefined;
  constructor(public onFirst?: () => void) {
    super();
  }
  async initialize(_ctx: StrategyContext): Promise<void> {
    await this.gate;
  }
  detach(): void {
    this.detached++;
  }
  async onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    this.heard.push(message.id);
    if (this.heard.length === 1) this.onFirst?.();
  }
}

/** Reacts, storing a message of two or more blocks as one shard per block. */
class ShardingReacts extends Reacts {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: 'zz-doc', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

/** A strategy that knows only onNewMessage, with no initialize, whose first row's hook runs `onFirst`. */
class SwitchesOnFirst extends PassthroughStrategy {
  heard: Array<{ id: MessageId; window: MessageId[] }> = [];
  onFirst: (() => void) | undefined;
  async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
    this.heard.push({ id: message.id, window: ctx.messageStore.getAll().map((m) => m.id) });
    if (this.heard.length === 1) this.onFirst?.();
  }
}

/** SwitchesOnFirst with an initialize that awaits nothing but returns a promise all the same. */
class SwitchesOnFirstAfterAwait extends SwitchesOnFirst {
  async initialize(_ctx: StrategyContext): Promise<void> {}
}

/** A gate for an initialize, and the function that opens it. */
function gated(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

// presentRows calls a strategy with only onNewMessage once per row. Each
// call is checked as a call of its own, as each add's was in legacy mode:
// a row's hook that closes the manager or lets the strategy go stops the
// calls for the rows after it, and those rows go where a call made then
// sends them.
describe("a row's onNewMessage hook that closes the manager or sets a strategy", () => {
  it('a hook that closes the manager: the rows after it are not heard, and the presentation stands', async () => {
    let cm!: ContextManager;
    const strategy = new Reacts(() => cm.close());
    let ids: MessageId[] = [];
    let ordinals: number[] = [];
    const errors = await errorsDuring(async () => {
      cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      ids = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)]));
      ordinals = cm.presentRows(ids);
      await settle();
    });
    assert.deepEqual(strategy.heard, [ids[0]], "after close() nothing reaches the strategy: b and c aren't heard");
    assert.equal(strategy.detached, 1, 'close() let the strategy go');
    assert.equal(ordinals.length, 3, 'presentRows finished the write and returned every ordinal');
    assert.deepEqual(errors, []);
    assert.ok(cm.isClosed());
  });

  it('a hook that sets a strategy: the one it replaced hears no more, and the rest reach the new one after its initialize', async () => {
    let cm!: ContextManager;
    const { gate, open } = gated();
    const next = new Reacts();
    next.gate = gate;
    let replaced!: Promise<void>;
    const first = new Reacts(() => { replaced = cm.setStrategy(next); });
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: first });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    assert.deepEqual(first.heard, [a], 'the replaced strategy heard only the row whose hook replaced it');
    assert.equal(first.detached, 1);
    assert.deepEqual(next.heard, [], 'nothing reaches the new strategy while it initializes');
    open();
    await replaced;
    assert.deepEqual(next.heard, [b, c], 'once it initialized, the rows after the hook, in window order');
    await settle();
    assert.deepEqual(first.heard, [a]);
    cm.close();
  });

  it('a hook that sets a strategy with no initialize: the rest reach it before presentRows returns', async () => {
    let cm!: ContextManager;
    const next = new HearsNewMessages();
    const first = new Reacts(() => { void cm.setStrategy(next); });
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: first });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    assert.deepEqual(first.heard, [a]);
    assert.deepEqual(next.heard, [{ id: b, window: [a, b, c] }, { id: c, window: [a, b, c] }]);
    await settle();
    assert.deepEqual(first.heard, [a]);
    cm.close();
  });

  // House review of #350, code finding 8: an initialization that finishes
  // before the hook returns (a strategy with no initialize) still stops the
  // calls for the rows after it, which are heard as rows that waited for it
  // are: those in the window of the branch it initialized on.
  it("a hook whose switchBranch() initializes before it returns: the rest are heard only where the branch's window holds them", async () => {
    for (const synchronous of [true, false]) {
      const label = synchronous ? 'probe' : 'control';
      let cm!: ContextManager;
      let switched: Promise<void> | undefined;
      let earlier = '';
      const strategy = synchronous ? new SwitchesOnFirst() : new SwitchesOnFirstAfterAwait();
      strategy.onFirst = () => { switched = cm.switchBranch(earlier); };
      cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      const store = cm.getStore();
      // A branch made before the rows: its window lacks them.
      earlier = store.createBranchAt('zz-earlier', cm.currentBranch().name, store.currentSequence()).name;
      const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
      cm.presentRows([a, b, c]);
      await switched;
      assert.equal(cm.currentBranch().name, earlier, 'setup: the hook switched to the earlier branch');
      assert.deepEqual(cm.getPresentedMessages(), [], "setup: the earlier branch's window lacks the rows");
      assert.deepEqual(
        strategy.heard,
        [{ id: a, window: [a, b, c] }],
        `${label}: no call is made for a row on a branch whose window lacks it`,
      );
      await settle();
      cm.close();
    }
  });

  it('a hook that starts its own strategy initializing again: the rest wait for it and reach it once it has', async () => {
    let cm!: ContextManager;
    const { gate, open } = gated();
    let reinitialized!: Promise<void>;
    const strategy = new Reacts(() => {
      strategy.gate = gate;
      reinitialized = cm.setStrategy(strategy);
    });
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    assert.deepEqual(strategy.heard, [a], 'nothing reaches a strategy that is initializing');
    assert.equal(strategy.detached, 0, 'the same instance is kept');
    open();
    await reinitialized;
    assert.deepEqual(strategy.heard, [a, b, c], 'once it initialized again, the rows after the hook, each once');
    await settle();
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 32: a presentation made while the
  // rows that waited are delivered waits behind those not yet heard.
  it("a hook that presents a row while the rows that waited are delivered: it is heard after them, in window order", async () => {
    let cm!: ContextManager;
    let c = '';
    const strategy = new Reacts(() => { cm.presentRows([c]); });
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const ids = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    c = ids[2];
    const { gate, open } = gated();
    strategy.gate = gate;
    const initialized = cm.setStrategy(strategy);
    cm.presentRows([ids[0], ids[1]]);
    assert.deepEqual(strategy.heard, [], 'setup: the rows wait for the initialize');
    open();
    await initialized;
    assert.deepEqual(strategy.heard, ids, "a's hook presented c, which is heard after b");
    await settle();
    cm.close();
  });

  // CM #350 bot review, wave 2, finding 3: the loop checks the store's
  // branch, and whether the next row is still in the window, between calls.
  it("a hook that switches the store's branch itself: the rest are heard only where that branch's window holds them", async () => {
    let cm!: ContextManager;
    let earlier = '';
    const strategy = new SwitchesOnFirst();
    strategy.onFirst = () => { cm.getStore().switchBranch(earlier); };
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const store = cm.getStore();
    // A branch made before the rows: its window lacks them.
    earlier = store.createBranchAt('zz-earlier', cm.currentBranch().name, store.currentSequence()).name;
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    assert.equal(store.currentBranch().name, earlier, 'setup: the hook switched the store');
    assert.deepEqual(strategy.heard, [{ id: a, window: [a, b, c] }], 'no call is made for a row on a branch whose window lacks it');
    await settle();
    cm.close();
  });

  it('a hook that takes a later row out of the window: that row is not heard entering, and the rest are', async () => {
    let cm!: ContextManager;
    let b = '';
    const strategy = new SwitchesOnFirst();
    strategy.onFirst = () => { cm.retractRows([b]); };
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const ids = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    const [a, , c] = ids;
    b = ids[1];
    cm.presentRows(ids);
    assert.equal(cm.ordinalOf(b), undefined, 'setup: the hook took b out');
    assert.deepEqual(
      strategy.heard.map((h) => h.id),
      [a, c],
      'b, out of the window before its call, is not heard entering',
    );
    await settle();
    cm.close();
  });
});

// CM #350 bot review finding 24: a presentRows that puts a body back whole
// makes two hook calls, and the first can move the store's branch.
describe("a body put back whole, whose onRetracted hook moves the store's branch", () => {
  for (const initializes of [false, true]) {
    it(`${initializes ? 'a strategy with an initialize' : 'a strategy with no initialize'}: presentRows returns, and the body is heard entering only where the window of the branch it initialized on holds it`, async () => {
      let cm!: ContextManager;
      let elsewhere = '';
      class Switches extends ShardingRecords {
        switchOnRetract = false;
        switched: Promise<void> | undefined;
        async onRetracted(rows: readonly StoredMessage[], ctx: StrategyContext, info: { undone: boolean; removed: boolean }): Promise<void> {
          if (this.switchOnRetract) {
            this.switchOnRetract = false;
            this.switched = cm.switchBranch(elsewhere);
          }
          return super.onRetracted(rows, ctx, info);
        }
      }
      class SwitchesAfterInitialize extends Switches {
        async initialize(_ctx: StrategyContext): Promise<void> {}
      }
      const strategy = initializes ? new SwitchesAfterInitialize() : new Switches();
      cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      const store = cm.getStore();
      cm.presentRows([]);
      // A branch made before the body: neither its record nor its window holds it.
      elsewhere = store.createBranchAt('zz-elsewhere', cm.currentBranch().name, store.currentSequence()).name;
      const doc = cm.addMessage('alice', [text('p0 '), text('p1 '), text('p2 ')]);
      const shards = cm.getAllMessages().map((m) => m.id);
      const a = cm.addMessage('alice', [text('a')]);
      cm.presentRows([doc, a]);
      // A retract cut short after the first shard's tombstone, in an index
      // written one record per item: the first shard out, the later ones in.
      const handle = store as unknown as { appendToStateJsonWithIdentity: (id: string, ...rest: unknown[]) => unknown };
      const append = handle.appendToStateJsonWithIdentity;
      const batched = perItemIndexWrites(store);
      let appends = 0;
      handle.appendToStateJsonWithIdentity = function (id: string, ...rest: unknown[]) {
        if (id === windowIndexStateId('zz-agent') && ++appends === 2) throw new Error('zz-index-append-failed');
        return append.call(this, id, ...rest);
      };
      try {
        assert.throws(() => cm.retractRows([doc]), /zz-index-append-failed/);
      } finally {
        handle.appendToStateJsonWithIdentity = append;
        batched();
      }
      assert.deepEqual(shards.map((id) => cm.windowStatusOf(id)), ['out', 'in', 'in'], 'setup: the first shard out, the later ones in');
      strategy.heard = [];
      strategy.retracted = [];
      strategy.switchOnRetract = true;
      const errors = await errorsDuring(async () => {
        cm.presentRows([shards[0]!]);
        await strategy.switched;
        await settle();
      });
      assert.equal(cm.currentBranch().name, elsewhere, 'setup: the hook moved the store to the branch made before the body');
      assert.deepEqual(strategy.retracted, [{ rows: [shards[1], shards[2]], undone: false }], 'the later shards were heard leaving, on the branch they left');
      assert.deepEqual(strategy.heard, [], 'the branch it initialized on holds no shard of the body, so none is heard entering');
      assert.deepEqual(errors, [], 'nothing failed');
      cm.close();
    });
  }
});

// House review of #350, code finding 9: once rows are presented,
// resetHeadWindow presents its transition, unless a host's listener of the
// add has presented it already.
describe('resetHeadWindow once a host presents', () => {
  it("goes ahead when a listener of the transition's add presented it already", async () => {
    for (const listens of [true, false]) {
      const label = listens ? 'probe' : 'control';
      const strategy = new AutobiographicalStrategy({ headWindowTokens: 200, recentWindowTokens: 100 });
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      // A host that presents each row it stores, as it is stored.
      if (listens) cm.onMessage((event) => { if (event.type === 'add') cm.presentRows([event.message.id]); });
      const a = cm.addMessage('alice', [text('a')]);
      if (!listens) cm.presentRows([a]);
      const summary = await cm.resetHeadWindow('zz-transition');
      assert.equal(summary, 'zz-transition', `${label}: resetHeadWindow resolved`);
      const window = cm.getPresentedMessages();
      assert.equal(window.length, 2, `${label}: the window holds the transition once, after a`);
      assert.ok((window[1]!.content[0] as { text: string }).text.includes('zz-transition'), label);
      assert.equal(cm.getAllMessages().length, 2, `${label}: one transition message was stored`);
      cm.close();
    }
  });

  // CM #350 bot review finding 25: the strategy's hook for the transition's
  // presentation can take it out again, without moving anything else.
  it("refuses when the hook of the transition's presentation takes it out of the window, and doesn't reset the head window", async () => {
    let cm!: ContextManager;
    class TakesItOut extends Records {
      resets: MessageId[] = [];
      resetHeadWindow(fromMessageId: MessageId): void {
        this.resets.push(fromMessageId);
      }
      async generateTransitionSummary(): Promise<string> {
        return 'summary';
      }
      onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
        if (rows.some((m) => m.participant === 'Context Manager')) cm.retractRows([rows[0]!.id]);
        return super.onPresented(rows, ctx);
      }
    }
    const strategy = new TakesItOut();
    cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const err = await cm.resetHeadWindow('zz-transition').then(() => assert.fail('expected a rejection'), (e: unknown) => e as Error);
    const transition = cm.getAllMessages().at(-1)!;
    assert.equal(cm.windowStatusOf(transition.id), 'out', 'setup: the hook took the transition out');
    assert.deepEqual(strategy.resets, [], "the head window wasn't reset to start at a row the window lacks");
    assert.match(err.message, /took the transition out of the window/);
    assert.ok(err.message.includes(`message ${transition.id} is stored and out of the window, and the head window wasn't reset`), err.message);
    await settle();
    cm.close();
  });

  // CM #350 bot review finding 26: the presentation can land and then throw.
  it('a presentation of the transition that fails says whether the window holds it', async () => {
    for (const readable of [true, false]) {
      class Resettable extends Records {
        resets: MessageId[] = [];
        resetHeadWindow(fromMessageId: MessageId): void {
          this.resets.push(fromMessageId);
        }
        async generateTransitionSummary(): Promise<string> {
          return 'summary';
        }
      }
      const strategy = new Resettable();
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      // The window's append lands and then throws; after it, the index reads
      // (control) or can't be read (probe).
      const index = windowIndexStateId('zz-agent');
      const store = cm.getStore() as unknown as Record<string, (id: string, ...rest: unknown[]) => unknown>;
      const saved: Record<string, (id: string, ...rest: unknown[]) => unknown> = {};
      let landed = false;
      for (const name of ['appendManyToStateJsonWithIdentity', 'appendToStateJsonWithIdentity', 'stateHeadOffset', 'getStateLen']) {
        const real = store[name];
        if (typeof real !== 'function') continue;
        saved[name] = real;
        store[name] = function (this: unknown, id: string, ...rest: unknown[]) {
          if (id !== index) return real.call(this, id, ...rest);
          if (name.startsWith('append')) {
            real.call(this, id, ...rest);
            landed = true;
            throw new Error('zz-landed-then-threw');
          }
          if (landed && !readable) throw new Error('zz-index-read-failed');
          return real.call(this, id, ...rest);
        };
      }
      let err: Error;
      try {
        err = await cm.resetHeadWindow('zz-transition').then(() => assert.fail('expected a rejection'), (e: unknown) => e as Error);
      } finally {
        for (const [name, real] of Object.entries(saved)) store[name] = real;
      }
      const transition = cm.getAllMessages().at(-1)!;
      const label = readable ? 'control' : 'probe';
      assert.equal(cm.windowStatusOf(transition.id), 'in', `${label}, setup: the presentation landed`);
      assert.deepEqual(strategy.resets, [], `${label}: the head window wasn't reset`);
      // The control's cause is the write's own error; the probe's is the
      // outcome-unknown error the index throws when it can't be read again,
      // which ends with the write's own.
      assert.match(err.message, readable
        ? /^ContextManager\.resetHeadWindow's presentation of its transition failed: zz-landed-then-threw\./
        : /^ContextManager\.resetHeadWindow's presentation of its transition failed: ContextManager\.presentRows: the window index's write threw, and the index can't be read again to tell whether the write landed \(zz-index-read-failed\)/, `${label}: ${err.message}`);
      if (!readable) assert.ok(err.message.includes('zz-landed-then-threw'), `${label}: the write's own error is named: ${err.message}`);
      const where = readable ? 'stored and presented' : 'stored, and may be presented';
      assert.ok(err.message.includes(`message ${transition.id} is ${where}, and the head window wasn't reset`), `${label}: ${err.message}`);
      await settle();
      cm.close();
    }
  });

  // CM #350 bot review, wave 2, finding 26: the window reads around the
  // presentation reject as its failure does, naming the stored transition.
  it("a read of the window that fails, before or after the transition's presentation, rejects naming the stored transition, and doesn't reset the head window", async () => {
    for (const failing of ['before', 'after'] as const) {
      let cm!: ContextManager;
      let unreadable = false;
      class Resettable extends Records {
        resets: MessageId[] = [];
        resetHeadWindow(fromMessageId: MessageId): void {
          this.resets.push(fromMessageId);
        }
        async generateTransitionSummary(): Promise<string> {
          return 'summary';
        }
        onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
          if (failing === 'after' && rows.some((m) => m.participant === 'Context Manager')) unreadable = true;
          return super.onPresented(rows, ctx);
        }
      }
      const strategy = new Resettable();
      cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
      cm.presentRows([]);
      // The window's reads throw once the transition is stored (a host's
      // listener of its add runs after the manager's own), or once its
      // presentation's hook has run.
      if (failing === 'before') cm.onMessage((event) => { if (event.type === 'add') unreadable = true; });
      const index = (cm as unknown as { windowIndex: Record<'mode' | 'ordinalOf', (...args: unknown[]) => unknown> }).windowIndex;
      const saved = { mode: index.mode, ordinalOf: index.ordinalOf };
      for (const name of ['mode', 'ordinalOf'] as const) {
        const real = saved[name];
        index[name] = function (this: unknown, ...args: unknown[]) {
          if (unreadable) throw new Error('zz-index-read-failed');
          return real.apply(this, args);
        };
      }
      let err: Error;
      try {
        err = await cm.resetHeadWindow('zz-transition').then(() => assert.fail('expected a rejection'), (e: unknown) => e as Error);
      } finally {
        index.mode = saved.mode;
        index.ordinalOf = saved.ordinalOf;
      }
      const transition = cm.getAllMessages().at(-1)!;
      assert.equal(transition.participant, 'Context Manager', `${failing}, setup: the transition is stored`);
      assert.deepEqual(strategy.resets, [], `${failing}: the head window wasn't reset`);
      assert.match(err.message, /^ContextManager\.resetHeadWindow couldn't read the window .*zz-index-read-failed\./, `${failing}: ${err.message}`);
      assert.ok(
        err.message.includes(`message ${transition.id} is stored, and may be presented, and the head window wasn't reset`),
        `${failing}: ${err.message}`,
      );
      await settle();
      cm.close();
    }
  });
});

describe('onPresented in legacy mode', () => {
  it('a strategy with onPresented hears each row from inside the add, after its hold is placed, and not through onNewMessage', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    const id = cm.addMessage('User', [text('hello')], undefined, undefined, { holdCompression: true });
    assert.deepEqual(strategy.heard, [{ rows: [id], held: [true], window: [id] }], 'the hook ran inside addMessage, with the message already held');
    assert.deepEqual(strategy.newMessages, []);
    await settle();
    cm.close();
  });

  // House review of #350, untested contract 1: a hook that closes the
  // manager stops what the write it interrupted would tell the strategy.
  // CM #350 bot review finding 28: a sharded add's shards are heard in one
  // call, once every shard is stored, so no hook runs between them.
  it("a sharded add is heard once every shard is stored, in one call, and a close() from that call or a listener of the first shard's add tells nothing more", async () => {
    for (const closes of ['hook', 'listener'] as const) {
      let cm!: ContextManager;
      class Closes extends ShardingRecords {
        async onPresented(rows: readonly StoredMessage[], ctx: StrategyContext): Promise<void> {
          this.heard.push({ rows: rows.map((m) => m.id), held: [], window: ctx.messageStore.getAll().map((m) => m.id) });
          if (closes === 'hook' && this.heard.length === 1) cm.close();
        }
      }
      const strategy = new Closes();
      // An app-owned store, which stays open after close(), so the record can be read.
      const owner = await ContextManager.open({ path: freshPath(), namespace: 'zz-owner', strategy: new PassthroughStrategy() });
      const errors = await errorsDuring(async () => {
        cm = await ContextManager.open({ store: owner.getStore(), namespace: 'zz-agent', strategy });
        if (closes === 'listener') cm.onMessage((event) => { if (event.type === 'add') cm.close(); });
        cm.addMessage('alice', [text('x'), text('y'), text('z')]);
        await settle();
      });
      assert.ok(cm.isClosed(), closes);
      const shards = cm.getAllMessages().map((m) => m.id);
      assert.equal(shards.length, 3, `${closes}: the add finished, and every shard is stored`);
      assert.deepEqual(
        strategy.heard.map((h) => [h.rows, h.window]),
        closes === 'hook' ? [[shards, shards]] : [],
        closes === 'hook' ? 'one call, with every shard, over a view that holds them all' : 'after close() nothing reaches the strategy',
      );
      assert.deepEqual(errors.filter((args) => /fail|threw/i.test(args.map(String).join(' '))), [], `${closes}: nothing failed`);
      owner.close();
    }
  });

  // House review of #350, code finding 2: in legacy mode there is no index,
  // so the rows waiting on an initialization have no ordinal; they wait all
  // the same, and reach the replacement once it has initialized.
  it("a sharded add whose first shard's hook sets a strategy that initializes: the later shards reach it after its initialize", async () => {
    for (const waits of [true, false]) {
      let cm!: ContextManager;
      const { gate, open } = gated();
      // The probe's replacement waits in its initialize; the control's has none.
      const next = waits ? new Reacts() : new HearsNewMessages();
      if (next instanceof Reacts) next.gate = gate;
      let replaced!: Promise<void>;
      const first = new ShardingReacts(() => { replaced = cm.setStrategy(next); });
      cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: first });
      cm.addMessage('alice', [text('x'), text('y'), text('z')]);
      const shards = cm.getPresentedMessages().map((m) => m.id);
      assert.equal(shards.length, 3, 'setup: the add stored three shards');
      assert.equal(cm.windowMode(), 'legacy');
      assert.deepEqual(first.heard, [shards[0]], 'the strategy the hook replaced heard only the first shard');
      // CM #350 bot review, wave 3, finding 30: nothing reaches the
      // replacement while its initialize is held.
      if (next instanceof Reacts) assert.deepEqual(next.heard, [], 'probe: the replacement hears nothing before its initialize');
      open();
      await replaced;
      const heard = next instanceof Reacts ? next.heard : next.heard.map((h) => h.id);
      assert.deepEqual(heard, shards.slice(1), `${waits ? 'probe' : 'control'}: the replacement hears the later shards, in order`);
      await settle();
      cm.close();
    }
  });
});

// ----------------------------------------------------------------------------
// The autobiographical strategy follows the window
// ----------------------------------------------------------------------------

const SECRET = 'UNPRESENTED-SECRET';

interface ApiMessage { participant: string; content: ContentBlock[] }

/** Summarizer mock: its summary text records whether the payload carried the secret. */
function mockMembrane() {
  const calls: Array<{ messages: ApiMessage[] }> = [];
  return {
    calls,
    membrane: {
      complete: async (request: { messages: ApiMessage[] }) => {
        calls.push({ messages: request.messages });
        const inputText = request.messages
          .flatMap((m) => m.content)
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n');
        const echo = inputText.includes(SECRET) ? ` (sources contained ${SECRET})` : '';
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `[mock memory inChars=${inputText.length}]${echo} ` + 'x '.repeat(40) }],
          usage: { input_tokens: Math.ceil(inputText.length / 4), output_tokens: 25 },
        };
      },
    } as never,
  };
}

/** The autobiographical strategy, counting its chunk rebuilds. */
class CountsRebuilds extends AutobiographicalStrategy {
  rebuilds = 0;
  protected rebuildChunks(store: MessageStoreView): void {
    this.rebuilds++;
    super.rebuildChunks(store);
  }
}

function autobiographical() {
  return new CountsRebuilds({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 300,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: false,
    autoTickOnNewMessage: true,
  });
}

const payloadText = (calls: Array<{ messages: ApiMessage[] }>): string =>
  calls.flatMap((c) => c.messages).flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');

/** Waits, without ticking, until `done` holds; false if it never does. */
async function until(done: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await sleep(10);
  }
  return done();
}

/** 120 messages, every third carrying the secret. */
function addMessages(manager: ContextManager): { shown: MessageId[]; unshown: MessageId[] } {
  const filler = (i: number) => `message ${i} ` + 'word '.repeat(8);
  const shown: MessageId[] = [];
  const unshown: MessageId[] = [];
  for (let i = 0; i < 120; i++) {
    if (i % 3 === 0) unshown.push(manager.addMessage('bob', [text(`${SECRET} ${filler(i)}`)]));
    else shown.push(manager.addMessage(i % 2 ? 'agent' : 'user', [text(filler(i))]));
  }
  return { shown, unshown };
}

describe('the autobiographical strategy follows the window', () => {
  it('legacy mode, the positive control: background compression starts from the adds', async () => {
    const { membrane, calls } = mockMembrane();
    const manager = await ContextManager.open({ path: freshPath(), strategy: autobiographical(), membrane });
    addMessages(manager);
    assert.ok(await until(() => calls.length > 0), 'compression started without a tick');
    assert.ok(await until(() => manager.isReady()), 'and drained');
    assert.ok(payloadText(calls).includes(SECRET), 'every stored row is in the window, so it is folded');
    manager.close();
  });

  it('presented mode: a stored row is not chunked or folded until it is presented, and presenting starts the drain', async () => {
    const { membrane, calls } = mockMembrane();
    const strategy = autobiographical();
    const manager = await ContextManager.open({ path: freshPath(), strategy, membrane });
    manager.presentRows([]);
    const rebuilds = strategy.rebuilds;
    const { shown, unshown } = addMessages(manager);
    await sleep(200);
    assert.equal(strategy.rebuilds, rebuilds, 'no add rebuilt the chunks');
    assert.equal(calls.length, 0, 'no row is in the window, so nothing is chunked and no compression starts');

    manager.presentRows(shown);
    assert.equal(strategy.rebuilds, rebuilds + 1, 'presentRows rebuilt the chunks over the window, once, before it returned');
    assert.ok(await until(() => calls.length > 0), 'compression started from the presentation, without a tick');
    assert.ok(await until(() => manager.isReady()), 'and drained');
    assert.ok(!payloadText(calls).includes(SECRET), 'no summarizer payload carried a row nobody presented');

    const result = await manager.compile();
    const compiled = result.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
    assert.ok(!compiled.includes(SECRET), 'the compiled context carries no row nobody presented');
    assert.equal(manager.getAllMessages().length, 120, 'the store keeps everything');
    assert.deepEqual(manager.getUnpresentedMessages().map((m) => m.id), unshown);
    manager.close();
  });
});
