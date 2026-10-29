/**
 * The strategy hears rows as they enter the agent's window
 * (ContextStrategy.onPresented, agent-framework #291).
 *
 * In legacy mode the window is the record, so a row enters it when the
 * manager stores it, and the strategy hears it from inside the add, as
 * onNewMessage did (#288; strategy-new-message-throw.test.ts pins that
 * order). Once a host presents rows, a stored row isn't in the window until
 * it is presented, so the strategy hears it from presentRows instead: once
 * per call, with the rows that entered, after they are in the window and
 * before presentRows returns, fire and forget. A hold is still placed at the
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
} from '../src/index.js';
import type { MessageId, MessageStoreView, StoredMessage, StrategyContext } from '../src/index.js';

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

  it("the manager's own work around the call still fails presentRows, and the rows stay presented", async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const a = cm.addMessage('alice', [text('a')]);
    // The context the manager builds for the hook is the manager's own work.
    (cm as unknown as { createStrategyContext: () => never }).createStrategyContext = () => {
      throw new Error('zz the manager failed');
    };
    assert.throws(() => cm.presentRows([a]), /zz the manager failed/);
    assert.equal(strategy.heard.length, 0, 'the strategy was never called');
    assert.notEqual(cm.ordinalOf(a), undefined, 'the presentation stands');
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
      const replacement = new Records();
      await cm.setStrategy(replacement);
      open();
      await assert.rejects(first, /supersed/i);
      assert.deepEqual(replacement.heard.map((h) => h.rows), [[a]], `${hooked ? 'control' : 'probe'}: the replacement hears the row once, after its initialize`);
      await settle();
      cm.close();
    }
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
