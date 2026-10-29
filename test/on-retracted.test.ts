/**
 * The strategy hears rows as they leave the agent's window
 * (ContextStrategy.onRetracted, agent-framework #291).
 *
 * retractRows takes rows out of the window, as an undone turn's rows are
 * taken out, and once a host presents rows a removal through the manager
 * takes a removed row out too. Until this hook the strategy heard neither,
 * so the autobiographical strategy kept an undone row inside its summaries:
 * the compile went on showing it folded, and a redo, which presents the
 * rows again at the end of the window, rendered them twice, raw there and
 * inside the summary at their old place (the cm-integration TAG2..TAG5
 * probe on #291). The manager calls the hook once per call, after the rows
 * are out and before the call returns, fire and forget as onPresented; while
 * the strategy initializes the calls wait, and are made before the rows
 * presented meanwhile are heard. In legacy mode a removal takes the row out
 * of the record and the window at once, and nothing is called: a strategy
 * that folded the row keeps it, as it always has (#291 question 14).
 *
 * A row the store no longer holds, removed through another manager, comes
 * by its id alone (`info.ids`, with `removed`), so every reader of a removed
 * row lets go of it (FW-CM-1). A row that left and was presented again
 * before the folding strategy heard it go is let go of at its old place when
 * the strategy hears it, and the open demotes the summary such a row leaves
 * non-contiguous instead of refusing the store.
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
import type { CompileResult, MessageId, StoredMessage, StrategyContext, SummaryEntry } from '../src/index.js';

const BASE = './test-on-retracted';
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
const textOf = (m: StoredMessage) => m.content.map((b) => (b as { text?: string }).text ?? '').join('');
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** One macrotask turn: by then a rejection's handler has run, and an unhandled one would have been reported. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** console.error's and console.warn's calls while `fn` runs. */
async function linesDuring(fn: () => Promise<void>): Promise<string[]> {
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

function watchUnhandled() {
  const seen: string[] = [];
  const onError = (err: unknown) => { seen.push(String(err)); };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { seen, restore: () => { process.off('uncaughtException', onError); process.off('unhandledRejection', onError); } };
}

type Info = { undone: boolean; removed: boolean; ids: readonly MessageId[] };

/** What one onRetracted call saw. */
interface Left {
  rows: MessageId[];
  texts: string[];
  info: Info;
  window: MessageId[];
}

/** A strategy that keeps what each onRetracted and onPresented call was given, in one log. */
class Records extends PassthroughStrategy {
  retracted: Left[] = [];
  presented: MessageId[][] = [];
  log: string[] = [];
  async onRetracted(rows: readonly StoredMessage[], ctx: StrategyContext, info: Info): Promise<void> {
    this.retracted.push({
      rows: rows.map((m) => m.id),
      texts: rows.map(textOf),
      info,
      window: ctx.messageStore.getAll().map((m) => m.id),
    });
    this.log.push(`retracted ${rows.map((m) => textOf(m)).join(',')}`);
    await settle();
  }
  async onPresented(rows: readonly StoredMessage[], _ctx: StrategyContext): Promise<void> {
    this.presented.push(rows.map((m) => m.id));
    this.log.push(`presented ${rows.map((m) => textOf(m)).join(',')}`);
  }
}

/** Records, storing a message of two or more blocks as one shard per block. */
class ShardingRecords extends Records {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.length < 2) return null;
    return { bodyGroupId: 'zz-doc', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
}

/** A gate for an initialize, and the function that opens it. */
function gated(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

/** Records whose initialize waits for `gate`, once one is set. */
class Gated extends Records {
  gate: Promise<void> | undefined;
  async initialize(_ctx: StrategyContext): Promise<void> {
    await this.gate;
  }
}

/** A strategy with no row hook (neither onPresented, onNewMessage nor onRetracted), whose initialize waits for `gate`, once one is set. */
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

describe('onRetracted', () => {
  it('retractRows calls it once, after the rows are out and before it returns, in window order, undone as given', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    cm.retractRows([c, a], { undone: true });
    // Checked before anything settles: the hook's synchronous part ran
    // inside retractRows.
    assert.deepEqual(strategy.retracted, [
      { rows: [a, c], texts: ['a', 'c'], info: { undone: true, removed: false, ids: [a, c] }, window: [b] },
    ]);
    cm.retractRows([b]);
    assert.deepEqual(strategy.retracted.slice(1), [
      { rows: [b], texts: ['b'], info: { undone: false, removed: false, ids: [b] }, window: [] },
    ]);
    cm.retractRows([]);
    assert.equal(strategy.retracted.length, 2, 'retractRows([]) takes nothing out and calls nothing');
    await settle();
    cm.close();
  });

  it('a body goes whole: the hook is given every shard, in order', async () => {
    const strategy = new ShardingRecords();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const doc = cm.addMessage('alice', [text('part 0 '), text('part 1 '), text('part 2 ')]);
    const shards = cm.getAllMessages().map((m) => m.id);
    cm.presentRows([doc]);
    cm.retractRows([doc], { undone: true });
    assert.deepEqual(strategy.retracted.map((l) => l.rows), [shards]);
    await settle();
    cm.close();
  });

  it('in legacy mode a removal calls nothing, and retractRows writes the window down, then calls it', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.removeMessage(a);
    assert.equal(cm.windowMode(), 'legacy');
    assert.deepEqual(strategy.retracted, [], 'the window is the record: the row left both at once, and nothing is told');
    cm.retractRows([c]);
    assert.equal(cm.windowMode(), 'presented');
    assert.deepEqual(strategy.retracted, [
      { rows: [c], texts: ['c'], info: { undone: false, removed: false, ids: [c] }, window: [b] },
    ]);
    await settle();
    cm.close();
  });

  it('once a host presents, a removal through the manager calls it with the rows as they were, removed', async () => {
    const strategy = new Records();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
    cm.presentRows([]);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    cm.removeMessage(b);
    assert.deepEqual(strategy.retracted, [
      { rows: [b], texts: ['b'], info: { undone: false, removed: true, ids: [b] }, window: [a, c] },
    ]);
    cm.removeMessage(d);
    assert.equal(strategy.retracted.length, 1, 'a row the window never held left nothing');
    cm.removeMessages(a, c);
    assert.deepEqual(strategy.retracted.slice(1), [
      { rows: [a, c], texts: ['a', 'c'], info: { undone: false, removed: true, ids: [a, c] }, window: [] },
    ]);
    await settle();
    cm.close();
  });

  // This test said a row taken out by its id gives the strategy nothing,
  // since the store no longer holds it. That left every reader but the
  // remover folding a removed row (FW-CM-1, J-CM1): such a row is now told
  // by its id, as removed, in a call of its own after the held rows'.
  it("a removal through another manager isn't heard, and taking that row out by its id tells the strategy by its id, removed", async () => {
    const main = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const strategy = new Records();
    const side = await ContextManager.open({
      store: main.getStore(),
      namespace: 'subconscious/zz',
      isolate: true,
      strategy,
      auxiliaryMessageViews: [{}],
    });
    side.presentRows([]);
    const m1 = main.addMessage('alice', [text('m1')]);
    const m2 = main.addMessage('alice', [text('m2')]);
    side.presentRows([m1, m2]);
    main.removeMessage(m1);
    assert.equal(strategy.retracted.length, 0, "the side manager doesn't hear the main manager's removal");
    side.retractRows([m1, m2]);
    assert.deepEqual(
      strategy.retracted.map((l) => [l.rows, l.info]),
      [
        [[m2], { undone: false, removed: false, ids: [m2] }],
        [[], { undone: false, removed: true, ids: [m1] }],
      ],
      'm1, which the store no longer holds, left by its id: no row of it to give, its id in a call of its own',
    );
    side.retractRows([]);
    await settle();
    side.close();
    main.close();
  });

  it('a synchronous throw or a rejection is logged, naming the rows, and the rows stay out', async () => {
    class Throws extends PassthroughStrategy {
      calls = 0;
      onRetracted(_rows: readonly StoredMessage[], _ctx: StrategyContext, _info: Info): Promise<void> {
        this.calls++;
        if (this.calls === 1) throw new Error('zz onRetracted threw synchronously');
        return Promise.reject(new Error('zz onRetracted rejected'));
      }
    }
    const strategy = new Throws();
    const unhandled = watchUnhandled();
    try {
      let ids: MessageId[] = [];
      let c: MessageId | undefined;
      let window: MessageId[] = ['unread'];
      const lines = await linesDuring(async () => {
        const cm = await ContextManager.open({ path: freshPath(), namespace: 'agents/zz-throws', strategy });
        try {
          cm.presentRows([]);
          ids = [cm.addMessage('alice', [text('a')]), cm.addMessage('bob', [text('b')])];
          c = cm.addMessage('alice', [text('c')]);
          cm.presentRows([...ids, c]);
          cm.retractRows(ids, { undone: true });
          cm.removeMessage(c);
          window = cm.getPresentedMessages().map((m) => m.id);
          await settle();
        } finally {
          cm.close();
        }
      });
      assert.deepEqual(window, [], 'the rows are out of the window');
      const logged = lines.filter((line) => line.startsWith('Strategy onRetracted failed for '));
      assert.equal(logged.length, 2);
      assert.ok(logged[0]!.startsWith(`Strategy onRetracted failed for 2 messages taken out, ${ids[0]} to ${ids[1]}: ns=agents/zz-throws`), logged[0]);
      assert.match(logged[0]!, /zz onRetracted threw synchronously/);
      assert.ok(logged[1]!.startsWith(`Strategy onRetracted failed for message ${c}: ns=agents/zz-throws`), logged[1]);
      assert.match(logged[1]!, /zz onRetracted rejected/);
      assert.deepEqual(unhandled.seen, [], 'nothing escapes as an uncaught error');
    } finally {
      unhandled.restore();
    }
  });

  it('calls made while the strategy initializes are made once it has, in order, before the rows presented meanwhile', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
    cm.presentRows([a, b, c]);
    const { gate, open } = gated();
    const strategy = new Gated();
    strategy.gate = gate;
    const initialized = cm.setStrategy(strategy);
    cm.retractRows([a], { undone: true });
    cm.retractRows([b]);
    cm.presentRows([a]);
    assert.deepEqual(strategy.log, [], 'nothing reaches a strategy that is initializing');
    open();
    await initialized;
    assert.deepEqual(strategy.log, ['retracted a', 'retracted b', 'presented a'], 'the rows that left first, then the row presented again');
    assert.deepEqual(strategy.retracted.map((l) => [l.rows, l.info]), [
      [[a], { undone: true, removed: false, ids: [a] }],
      [[b], { undone: false, removed: false, ids: [b] }],
    ], 'a, presented again since, is still given: what was kept of it is at its old place');
    await settle();
    cm.close();
  });

  it('a row removed elsewhere, taken out while the strategy initializes, is told on a branch whose window holds it still, since its record lacks it too', async () => {
    const writer = await ContextManager.open({ path: freshPath(), namespace: 'zz-writer', strategy: new PassthroughStrategy() });
    const cm = await ContextManager.open({ store: writer.getStore(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => writer.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    cm.presentRows([a, b]);
    writer.removeMessage(a);
    // A branch made after the removal and before this window heard it: its
    // record lacks a, and its window holds a where it was.
    const store = cm.getStore();
    const later = store.createBranchAt('zz-later', cm.currentBranch().name, store.currentSequence()).name;
    const { gate, open } = gated();
    const strategy = new Gated();
    strategy.gate = gate;
    const initialized = cm.setStrategy(strategy);
    assert.deepEqual(cm.retractRemoved([a]), [a]);
    const switched = cm.switchBranch(later);
    open();
    await assert.rejects(initialized, /supersed/i);
    await switched;
    assert.equal(cm.currentBranch().name, later);
    assert.notEqual(cm.ordinalOf(a), undefined, 'setup: the branch\'s window holds a at the ordinal it left');
    assert.deepEqual(strategy.retracted.map((l) => [l.rows, l.info]), [
      [[], { undone: false, removed: true, ids: [a] }],
    ], 'the branch\'s record lacks a: it left there too');
    await settle();
    cm.close();
    writer.close();
  });

  it('a call waiting on an initialization of a branch made before the row left is not made there', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
    cm.presentRows([]);
    const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
    cm.presentRows([a, b]);
    const before = cm.branchAt(b, 'zz-before');
    const { gate, open } = gated();
    const strategy = new Gated();
    strategy.gate = gate;
    const initialized = cm.setStrategy(strategy);
    cm.retractRows([a], { undone: true });
    const switched = cm.switchBranch(before);
    open();
    await assert.rejects(initialized, /supersed/i);
    await switched;
    assert.equal(cm.currentBranch().name, before);
    assert.notEqual(cm.ordinalOf(a), undefined, 'the branch holds a where it was');
    assert.deepEqual(strategy.retracted, [], 'a never left the window of this branch');
    await settle();
    cm.close();
  });

  // House review of #350, code finding 1 (retracted half): the calls wait for
  // the manager's strategy, not for the instance initializing, so they wait
  // while a strategy without onRetracted initializes too.
  it('a call made while a strategy without the hook initializes reaches the strategy set in its place, after its own initialize', async () => {
    for (const hooked of [false, true]) {
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy: new PassthroughStrategy() });
      cm.presentRows([]);
      const [a, b] = ['a', 'b'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId];
      cm.presentRows([a, b]);
      const { gate, open } = gated();
      const initializing = hooked ? new Gated() : new Unhooked();
      initializing.gate = gate;
      const first = cm.setStrategy(initializing);
      cm.retractRows([a], { undone: true });
      const replacement = new Records();
      await cm.setStrategy(replacement);
      open();
      await assert.rejects(first, /supersed/i);
      assert.deepEqual(
        replacement.retracted.map((l) => [l.rows, l.info]),
        [[[a], { undone: true, removed: false, ids: [a] }]],
        `${hooked ? 'control' : 'probe'}: the replacement is told the row left, after its initialize`,
      );
      await settle();
      cm.close();
    }
  });

  for (const [name, make] of [
    ['passthrough', () => new PassthroughStrategy()],
    ['windowed passthrough', () => new WindowedPassthroughStrategy()],
  ] as const) {
    it(`${name} defines no onRetracted, and compiles the window without the rows taken out`, async () => {
      const strategy = make();
      assert.equal((strategy as { onRetracted?: unknown }).onRetracted, undefined);
      const lines = await linesDuring(async () => {
        const cm = await ContextManager.open({ path: freshPath(), namespace: 'zz-agent', strategy });
        try {
          cm.presentRows([]);
          const [a, b, c] = ['a', 'b', 'c'].map((t) => cm.addMessage('alice', [text(t)])) as [MessageId, MessageId, MessageId];
          cm.presentRows([a, b, c]);
          cm.retractRows([b], { undone: true });
          cm.removeMessage(c);
          const result = await cm.compile(BIG);
          assert.deepEqual(result.messages.map((m) => (m.content[0] as { text: string }).text), ['a']);
        } finally {
          cm.close();
        }
      });
      assert.deepEqual(lines, []);
    });
  }
});

// ----------------------------------------------------------------------------
// The autobiographical strategy lets go of what left the window
// ----------------------------------------------------------------------------

const TAGS = 24;

/** Summarizer mock: each answer names the tags its request carried. A gate, when set, holds the calls it matches. */
function mockMembrane() {
  let calls = 0;
  const mock = {
    hold: null as null | { matches: (input: string) => boolean; gate: Promise<void>; started: () => void },
    membrane: {
      complete: async (request: { messages: Array<{ content: ContentBlock[] }> }) => {
        calls++;
        const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
        const hold = mock.hold;
        if (hold && hold.matches(input)) {
          mock.hold = null;
          hold.started();
          await hold.gate;
        }
        const tags = [...new Set(input.match(/TAG\d+/g) ?? [])].join(',');
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `[summary ${calls} of ${tags}] ` + 'mem '.repeat(20) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    } as never,
  };
  return mock;
}

const isMerge = (input: string) => input.includes('consolidate into a single L');

const FOLDING = {
  compressionModel: 'mock',
  targetChunkTokens: 200,
  recentWindowTokens: 300,
  headWindowTokens: 0,
  mergeThreshold: 4,
} as const;

function autobiographical() {
  return new AutobiographicalStrategy(FOLDING);
}

interface Internals {
  summaries: SummaryEntry[];
  chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
  pendingCompressionWork: { chunk: { messages: StoredMessage[] } } | { sourceIds: readonly string[] } | null;
}
const internals = (strategy: AutobiographicalStrategy) => strategy as unknown as Internals;

/** The message ids a summary covers. */
function leavesOf(cm: ContextManager, id: string): MessageId[] {
  const summary = cm.getSummary(id);
  if (!summary) return [];
  return summary.level === 1 ? summary.sourceIds : summary.sourceIds.flatMap((source) => leavesOf(cm, source));
}

/** Each message id a compile renders, raw or inside a summary, as often as it renders it. */
function renderedRows(cm: ContextManager, result: CompileResult): MessageId[] {
  const raw: MessageId[] = [];
  const summaries = new Set<string>();
  for (const part of result.provenance?.messages ?? []) {
    if (part.kind === 'raw') raw.push(...part.bodies.map((b) => b.messageId));
    if (part.kind === 'summary') for (const s of part.summaries) summaries.add(s.id);
  }
  return [...raw, ...[...summaries].flatMap((id) => leavesOf(cm, id))];
}

/** The message ids some summary the strategy keeps covers. */
function coveredRows(cm: ContextManager, strategy: AutobiographicalStrategy): Set<MessageId> {
  return new Set(internals(strategy).summaries.flatMap((s) => leavesOf(cm, s.id)));
}

async function drain(cm: ContextManager): Promise<void> {
  for (let i = 0; i < 500 && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'the drain finished');
}

/** A presented manager holding TAG0..TAG23, each presented as it was stored, the strategy's queue not yet run. */
async function folding(path = freshPath()) {
  const mock = mockMembrane();
  const strategy = autobiographical();
  const cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mock.membrane });
  cm.presentRows([]);
  const ids: MessageId[] = [];
  for (let i = 0; i < TAGS; i++) {
    const id = cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
    cm.presentRows([id]);
    ids.push(id);
  }
  return { cm, strategy, mock, ids };
}

/** Asserts the compile renders each row of the window once, and only those. */
function rendersWindowOnce(cm: ContextManager, result: CompileResult, label: string): void {
  const rendered = renderedRows(cm, result);
  assert.equal(new Set(rendered).size, rendered.length, `${label}: no row renders twice (raw and folded, or in two summaries)`);
  assert.deepEqual(new Set(rendered), new Set(cm.getPresentedMessages().map((m) => m.id)), `${label}: every row of the window renders, and nothing else`);
}

describe('the autobiographical strategy lets go of rows that leave the window', () => {
  it('an undone turn folded into summaries: none covers it, the compile omits it, and redone it renders once', async () => {
    const path = freshPath();
    const { cm, strategy, ids } = await folding(path);
    await drain(cm);
    const undone = ids.slice(2, 6);
    const before = await cm.compile(BIG);
    rendersWindowOnce(cm, before, 'before');
    for (const id of undone) assert.ok(coveredRows(cm, strategy).has(id), `premise: TAG${ids.indexOf(id)} is folded`);

    let lines: string[] = [];
    let afterRetract!: CompileResult;
    lines = await linesDuring(async () => {
      cm.retractRows(undone, { undone: true });
      // Before anything settles: the strategy let go inside retractRows.
      for (const id of undone) assert.ok(!coveredRows(cm, strategy).has(id), 'no summary covers a row that left');
      afterRetract = await cm.compile(BIG);
    });
    assert.ok(lines.some((line) => line.includes('4 row(s) left the window: dropped the summaries covering them')), lines.join('\n'));
    rendersWindowOnce(cm, afterRetract, 'after the undo');
    for (const id of undone) assert.ok(!renderedRows(cm, afterRetract).includes(id), 'the compile omits a row that left');

    await drain(cm);
    const drained = await cm.compile(BIG);
    rendersWindowOnce(cm, drained, 'after the undo, drained');
    for (const id of undone) assert.ok(!coveredRows(cm, strategy).has(id), 'nothing folded since covers a row that left');
    const records = internals(strategy).chunkRecords;
    assert.ok(records.every((r) => !r.sourceIds.some((id) => undone.includes(id))), 'no chunk record holds a row that left');

    cm.presentRows(undone);
    await drain(cm);
    const redone = await cm.compile(BIG);
    rendersWindowOnce(cm, redone, 'after the redo');
    const tight = await cm.compile({ maxTokens: 3000, reserveForResponse: 100 });
    const rendered = renderedRows(cm, tight);
    assert.equal(new Set(rendered).size, rendered.length, 'after the redo, at a tight budget: no row renders twice');
    cm.close();

    // What the strategy let go of is written: a strategy opened on the store
    // afterwards reads no summary of a row at its old place. Before the hook
    // this open threw StoreTopologyError: the summary over the redone rows
    // owned leaves the window no longer holds together.
    const reopened = await ContextManager.open({ path, namespace: 'agent', strategy: autobiographical(), membrane: mockMembrane().membrane });
    rendersWindowOnce(reopened, await reopened.compile(BIG), 'reopened');
    reopened.close();
  });

  it('once a host presents, a removed row leaves what folded it; in legacy mode it stays', async () => {
    const { cm, strategy, ids } = await folding();
    await drain(cm);
    const gone = ids[8]!;
    assert.ok(coveredRows(cm, strategy).has(gone), 'premise: the row is folded');
    await linesDuring(async () => cm.removeMessage(gone));
    assert.ok(!coveredRows(cm, strategy).has(gone), 'no summary covers the removed row');
    await drain(cm);
    rendersWindowOnce(cm, await cm.compile(BIG), 'after the removal');
    cm.close();

    // Legacy mode: the window is the record, and nothing is told.
    const mock = mockMembrane();
    const legacy = autobiographical();
    const lm = await ContextManager.open({ path: freshPath(), namespace: 'agent', strategy: legacy, membrane: mock.membrane });
    const lids: MessageId[] = [];
    for (let i = 0; i < TAGS; i++) lids.push(lm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]));
    await drain(lm);
    const folded = lids[8]!;
    assert.ok(coveredRows(lm, legacy).has(folded), 'premise: the row is folded');
    const summariesBefore = internals(legacy).summaries.map((s) => s.id);
    lm.removeMessage(folded);
    assert.equal(lm.windowMode(), 'legacy');
    assert.deepEqual(internals(legacy).summaries.map((s) => s.id), summariesBefore, 'a removal in legacy mode keeps what folded the row');
    lm.close();
  });

  it('an L1 in flight over a row that leaves the window is discarded, and its chunk folds again over the rows it keeps', async () => {
    const { cm, strategy, mock } = await folding();
    const { gate, open } = gated();
    let started!: () => void;
    const out = new Promise<void>((resolve) => { started = resolve; });
    mock.hold = { matches: (input) => !isMerge(input), gate, started };
    const ticking = cm.tick();
    await out;
    const work = internals(strategy).pendingCompressionWork;
    assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
    const span = work.chunk.messages.map((m) => m.id);
    const leaving = span[1]!;
    const lines = await linesDuring(async () => {
      cm.retractRows([leaving], { undone: true });
      open();
      await ticking;
    });
    assert.ok(lines.some((line) => line.includes('discarding L1: a row of its span left the window mid-request')), lines.join('\n'));
    assert.ok(!coveredRows(cm, strategy).has(leaving), 'the L1 in flight was not written');
    await drain(cm);
    assert.ok(!coveredRows(cm, strategy).has(leaving), 'nothing folded since covers the row');
    const kept = span.filter((id) => id !== leaving);
    assert.ok(
      internals(strategy).summaries.some((s) => s.level === 1 && s.sourceIds.join() === kept.join()),
      'the chunk was folded again over the rows it keeps',
    );
    rendersWindowOnce(cm, await cm.compile(BIG), 'drained');
    cm.close();
  });

  it('a merge in flight over a summary a retraction drops writes nothing', async () => {
    const { cm, strategy, mock } = await folding();
    const { gate, open } = gated();
    let started!: () => void;
    const out = new Promise<void>((resolve) => { started = resolve; });
    mock.hold = { matches: isMerge, gate, started };
    let ticking: Promise<void> = Promise.resolve();
    let merging = false;
    void out.then(() => { merging = true; });
    for (let i = 0; i < 100 && !merging; i++) {
      ticking = cm.tick();
      await Promise.race([ticking, out]);
    }
    const work = internals(strategy).pendingCompressionWork;
    assert.ok(work && 'sourceIds' in work, 'premise: a merge is in flight');
    const source = work.sourceIds[0]!;
    const leaving = leavesOf(cm, source)[0]!;
    const lines = await linesDuring(async () => {
      cm.retractRows([leaving], { undone: true });
      assert.equal(cm.getSummary(source), null, 'the source the row was under is dropped');
      open();
      await ticking;
    });
    assert.ok(lines.some((line) => /source\(s\) dropped while the L2 merge's call was out/.test(line)), lines.join('\n'));
    assert.ok(
      internals(strategy).summaries.every((s) => !s.sourceIds.includes(source)),
      'no summary was written over the dropped source',
    );
    await drain(cm);
    assert.ok(!coveredRows(cm, strategy).has(leaving), 'nothing folded since covers the row');
    rendersWindowOnce(cm, await cm.compile(BIG), 'drained');
    cm.close();
  });

  it('a row taken out and presented again while a strategy initializes: the open demotes what covered it, and the row renders once', async () => {
    const path = freshPath();
    const { cm, strategy, ids } = await folding(path);
    await drain(cm);
    const row = ids[3]!;
    assert.ok(coveredRows(cm, strategy).has(row), 'premise: the row is folded');
    const next = autobiographical();
    // Both steps fall inside the initialization, which awaits before it
    // reads the window: the strategy reads the row at its new place before
    // it hears it left its old one. Before the load repair the open threw
    // StoreTopologyError here, and the manager was left uninitialized.
    const lines = await linesDuring(async () => {
      const initialized = cm.setStrategy(next);
      cm.retractRows([row], { undone: true });
      cm.presentRows([row]);
      await initialized;
    });
    assert.ok(lines.some((line) => line.includes('the window holds the leaves of') && line.includes('apart')), lines.join('\n'));
    assert.ok(!coveredRows(cm, next).has(row), 'nothing covers the row at its old place');
    assert.ok(next.getTopologyViolations().length === 0);
    await drain(cm);
    rendersWindowOnce(cm, await cm.compile(BIG), 'drained');
    const tight = renderedRows(cm, await cm.compile({ maxTokens: 3000, reserveForResponse: 100 }));
    assert.equal(new Set(tight).size, tight.length, 'at a tight budget: no row renders twice');
    cm.close();
    const reopened = await ContextManager.open({ path, namespace: 'agent', strategy: autobiographical(), membrane: mockMembrane().membrane });
    rendersWindowOnce(reopened, await reopened.compile(BIG), 'reopened');
    reopened.close();
  });

  it('a row taken out and presented again that no folding strategy heard go: the open demotes the summary over it instead of refusing the store', async () => {
    const path = freshPath();
    const { cm, strategy, ids } = await folding(path);
    await drain(cm);
    const row = ids[3]!;
    const covering = internals(strategy).summaries.filter((s) => leavesOf(cm, s.id).includes(row)).map((s) => s.id);
    assert.ok(covering.length > 0, 'premise: the row is folded');
    cm.close();
    // Through a strategy without the hook, as a crash between the window's
    // tombstone and the folding strategy's own writes leaves the store.
    const plain = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
    plain.retractRows([row], { undone: true });
    plain.presentRows([row]);
    plain.close();

    // 'report' opens the store for inspection: it names the summaries and changes nothing.
    const inspected = new AutobiographicalStrategy({ ...FOLDING, topologyPolicy: 'report' });
    const inspector = await linesDuring(async () => {
      const open = await ContextManager.open({ path, namespace: 'agent', strategy: inspected, membrane: mockMembrane().membrane });
      open.close();
    });
    assert.deepEqual(inspected.getTopologyViolations().map((v) => v.id).sort(), [...covering].sort(), inspector.join('\n'));
    assert.ok(!inspector.some((line) => line.includes('the window holds the leaves of')), 'nothing is demoted under report');

    const next = autobiographical();
    let reopened!: ContextManager;
    const lines = await linesDuring(async () => {
      reopened = await ContextManager.open({ path, namespace: 'agent', strategy: next, membrane: mockMembrane().membrane });
    });
    assert.ok(lines.some((line) => line.includes('the window holds the leaves of') && line.includes(`releasing [${row}]`)), lines.join('\n'));
    for (const id of covering) assert.equal(reopened.getSummary(id), null, `${id}, over the row at its old place, is dropped`);
    assert.ok(!coveredRows(reopened, next).has(row));
    assert.ok(internals(next).chunkRecords.every((r) => !r.sourceIds.includes(row)), 'the record gives the row up where it was');
    await drain(reopened);
    rendersWindowOnce(reopened, await reopened.compile(BIG), 'drained');
    reopened.close();
    // The repair was written: the next open finds nothing to demote.
    const again = await linesDuring(async () => {
      const open = await ContextManager.open({ path, namespace: 'agent', strategy: autobiographical(), membrane: mockMembrane().membrane });
      open.close();
    });
    assert.ok(!again.some((line) => line.includes('the window holds the leaves of')), again.join('\n'));
  });

  it('a folded row taken out while a strategy with no row hook initializes: the folding strategy set in its place lets go of it', async () => {
    for (const hooked of [false, true]) {
      const { cm, strategy, ids } = await folding();
      await drain(cm);
      const row = ids[3]!;
      assert.ok(coveredRows(cm, strategy).has(row), 'premise: the row is folded');
      const { gate, open } = gated();
      const initializing = hooked ? new Gated() : new Unhooked();
      initializing.gate = gate;
      const next = autobiographical();
      await linesDuring(async () => {
        const first = cm.setStrategy(initializing);
        cm.retractRows([row], { undone: true });
        const replaced = cm.setStrategy(next);
        open();
        await assert.rejects(first, /supersed/i);
        await replaced;
      });
      const label = hooked ? 'control' : 'probe';
      assert.ok(!coveredRows(cm, next).has(row), `${label}: no summary covers the row that left`);
      const result = await cm.compile(BIG);
      assert.ok(!renderedRows(cm, result).includes(row), `${label}: the compile omits the row that left`);
      rendersWindowOnce(cm, result, label);
      cm.close();
    }
  });

  it('a row presented again that the open chunked at its new place keeps that place when its retraction is heard', async () => {
    const { cm, strategy, ids } = await folding();
    await drain(cm);
    const row = ids[22]!;
    assert.ok(internals(strategy).chunkRecords.every((r) => !r.sourceIds.includes(row)), 'premise: the row is in the recent window, in no chunk');
    const later: MessageId[] = [];
    for (let i = TAGS; i < TAGS + 16; i++) later.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]));
    const next = autobiographical();
    await linesDuring(async () => {
      const initialized = cm.setStrategy(next);
      cm.presentRows(later.slice(0, 2));
      cm.retractRows([row], { undone: true });
      cm.presentRows([row]);
      cm.presentRows(later.slice(2));
      await initialized;
    });
    // The open chunked the row with the rows around it at its new place;
    // the retraction heard after leaves it there, so that record has no
    // hole where the row stands.
    const window = cm.getPresentedMessages().map((m) => m.id);
    const position = new Map(window.map((id, i) => [id, i] as const));
    const holding = internals(next).chunkRecords.filter((r) => r.sourceIds.includes(row));
    assert.equal(holding.length, 1, 'the record made over the row at its new place keeps it');
    for (const record of internals(next).chunkRecords) {
      const at = record.sourceIds.filter((id) => position.has(id)).map((id) => position.get(id)!).sort((x, y) => x - y);
      assert.ok(at.every((p, i) => i === 0 || p === at[i - 1]! + 1), `${record.id} holds rows the window holds together`);
    }
    await drain(cm);
    rendersWindowOnce(cm, await cm.compile(BIG), 'drained');
    assert.deepEqual(next.getTopologyViolations(), []);
    cm.close();
  });
});
