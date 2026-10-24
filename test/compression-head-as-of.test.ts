/**
 * The head a compression or merge request gives as context is the head in force when the history it summarizes
 * happened: before the live head's start, the head starting at the latest topic transition at or before the
 * request's first message, or the opening; from the live head's start on, the live head; cut at that message
 * (#317). After resetHeadWindow, a request for history from before the reset gave the new topic's opening ahead of
 * it, where the code places the chronicle's opening and keeps later events out.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/index.js';
import type { StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

const ROOT = './test-compression-head-as-of';
let counter = 0;
const freshPath = (): string => `${ROOT}-${counter++}`;

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }
  runCompress(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    return this.compressChunkHierarchical(chunk, ctx);
  }
  runMerge(targetLevel: number, sourceIds: string[], ctx: StrategyContext): Promise<boolean> {
    return this.executeMerge(targetLevel as never, sourceIds, ctx);
  }
  /** One reader of heads for many positions, as the count of queued work holds one. */
  heads(ctx: StrategyContext): (pos: number) => { start: number; end: number } {
    return (this as unknown as { headsAsOf(store: unknown): (pos: number) => { start: number; end: number } })
      .headsAsOf(ctx.messageStore);
  }
  /** The head rule worked out for one position alone, scanning back from it, as headAsOf computed it per call
   *  before heads were read once per count: the oracle the shared reader is checked against. */
  headAlone(ctx: StrategyContext, pos: number): { start: number; end: number } {
    const store = ctx.messageStore;
    const liveStart = this.getHeadWindowStartIndex(store);
    const hold = this.holdBoundary(store);
    if (pos < 0) return { start: liveStart, end: liveStart };
    if (pos >= liveStart) return { start: liveStart, end: Math.min(this.getHeadWindowEnd(store), hold, pos) };
    const messages = store.getAll();
    let start = 0;
    for (let i = pos; i > 0; i--) {
      if (this.isTopicTransitionMessage(messages[i]!)) {
        start = i;
        break;
      }
    }
    return { start, end: Math.min(this.headWindowEndFrom(store, messages, start), hold, pos) };
  }
  /** Timeline scans of holdBoundary so far. */
  holdScans(): number {
    return this.holdBoundaryScans;
  }
  /** The head a request gives for history from `pos` on. */
  asOf(ctx: StrategyContext, pos: number): { start: number; end: number } {
    return (this as unknown as { headAsOf(store: unknown, pos: number): { start: number; end: number } })
      .headAsOf(ctx.messageStore, pos);
  }
  /** Whether the count of queued work reads tick's request for `chunk` as carrying a tool block. */
  carriesToolBlocks(ctx: StrategyContext, chunk: Chunk): boolean {
    return this.toolBlockReader(ctx)(chunk);
  }
  /** One reader of the count's, as one count holds it across the queue (its answers memoized). */
  toolBlockReader(ctx: StrategyContext): (chunk: Chunk) => boolean {
    return (this as unknown as { requestCarriesToolBlocks(store: unknown): (c: Chunk) => boolean })
      .requestCarriesToolBlocks(ctx.messageStore);
  }
  /** Sets the head window to `count` of this store's equal-sized messages, with half a message to spare. */
  headOfMessages(ctx: StrategyContext, count: number): void {
    const messages = ctx.messageStore.getAll();
    let sum = 0;
    for (let i = 0; i < count; i++) sum += ctx.messageStore.estimateTokens(messages[i]!);
    this.config.headWindowTokens = sum + Math.floor(ctx.messageStore.estimateTokens(messages[count]!) / 2);
  }
  headWindowTokens(): number {
    return this.config.headWindowTokens;
  }
}

/** Lets every merge through the topology check, so a merge whose source messages a host removed reaches its
 *  request and executeMerge's own start rule is what these tests pin. The real check may refuse such a merge (a
 *  merge whose first source message was removed returned false in a review's probe): these tests don't show that
 *  production reaches it. */
class PlacingTopologyStrategy extends ProbeStrategy {
  protected override mergeTopologyProblem(): string | null {
    return null;
  }
}

const context = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
/** Equal-sized messages, so a head of `count` messages is the same count whichever message it starts at. */
const body = (marker: string): string => `${marker} ${'word '.repeat(18)}`.slice(0, 110);

function countIn(req: unknown, needle: string): number {
  const blob = JSON.stringify(req);
  let n = 0;
  for (let at = blob.indexOf(needle); at >= 0; at = blob.indexOf(needle, at + needle.length)) n++;
  return n;
}

function summary(id: string, sourceIds: string[]): SummaryEntry {
  return {
    id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0, sourceIds,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! },
    created: Number(id.replace(/\D/g, '')) || 1,
  };
}

const chunkOf = (ctx: StrategyContext, from: number, to: number): Chunk => ({
  index: 900 + from, startIndex: from, endIndex: to, messages: ctx.messageStore.getAll().slice(from, to), tokens: 100, compressed: false,
});

/**
 * A store with the opening OPEN0..OPEN9, a topic transition T1 and ONE0..ONE9, and a second transition T2 and
 * TWO0..TWO5, every message the same size, the head window three messages. `resets` says how many of the two
 * transitions the strategy has been reset to.
 */
async function build(resets: 0 | 1 | 2, opts: { path?: string; openingTool?: boolean; placing?: boolean } = {}) {
  const captured: unknown[] = [];
  const membrane = {
    complete: async (req: unknown) => {
      captured.push(structuredClone(req));
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'a summary' }] };
    },
  };
  const strategy = new (opts.placing ? PlacingTopologyStrategy : ProbeStrategy)({
    compressionModel: 'test-compression-model', headWindowTokens: 1, recentWindowTokens: 0,
    targetChunkTokens: 1_000_000, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
  });
  const path = opts.path ?? freshPath();
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const at: Record<string, number> = {};
  let n = 0;
  const add = (name: string, participant: string, content: ContentBlock[]): string => {
    at[name] = n++;
    return manager.addMessage(participant, content);
  };
  for (let i = 0; i < 10; i++) {
    if (opts.openingTool && i === 1) {
      add('OPEN1', 'assistant', [{ type: 'text', text: body('OPEN1').slice(0, 60) }, { type: 'tool_use', id: 'call_1', name: 'fs:read', input: { p: 'a' } } as ContentBlock]);
    } else if (opts.openingTool && i === 2) {
      add('OPEN2', 'user', [{ type: 'tool_result', toolUseId: 'call_1', content: body('OPEN2').slice(0, 60) } as ContentBlock]);
    } else {
      add(`OPEN${i}`, i % 2 ? 'assistant' : 'user', text(body(`OPEN${i}`)));
    }
  }
  const t1 = add('T1', 'Context Manager', text(`[Topic Transition]\n\n${body('TOPIC_ONE')}`.slice(0, 110)));
  for (let i = 0; i < 10; i++) add(`ONE${i}`, i % 2 ? 'assistant' : 'user', text(body(`ONE${i}`)));
  const t2 = add('T2', 'Context Manager', text(`[Topic Transition]\n\n${body('TOPIC_TWO')}`.slice(0, 110)));
  for (let i = 0; i < 6; i++) add(`TWO${i}`, i % 2 ? 'assistant' : 'user', text(body(`TWO${i}`)));
  if (resets >= 1) strategy.resetHeadWindow(t1);
  if (resets >= 2) strategy.resetHeadWindow(t2);
  const ctx = context(manager);
  strategy.headOfMessages(ctx, 3);
  return { manager, strategy, ctx, captured, at, path };
}

describe('the head a compression or merge request gives is the head as of the history it summarizes (#317)', () => {
  after(() => {
    for (let i = 0; i < counter; i++) if (existsSync(`${ROOT}-${i}`)) rmSync(`${ROOT}-${i}`, { recursive: true, force: true });
  });

  it("a chunk from before a reset is compressed with the opening, not the new topic's head", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    await strategy.runCompress(chunkOf(ctx, at.OPEN6!, at.OPEN8!), ctx);
    assert.equal(captured.length, 1);
    const req = captured[0]!;
    for (const m of ['OPEN0', 'OPEN1', 'OPEN2']) assert.equal(countIn(req, `${m} `), 1, `${m} is the head, raw once`);
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head's transition isn't sent");
    assert.equal(countIn(req, 'TWO0'), 0, "nor the live head's messages");
    assert.equal(countIn(req, 'TOPIC_ONE'), 0, 'nor a later topic');
    assert.ok(JSON.stringify(req).indexOf('OPEN0 ') < JSON.stringify(req).indexOf('OPEN6 '), 'the head comes before the chunk');
    await manager.close();
  });

  it('a chunk between two resets is compressed with the head of the topic it was in, cut at the chunk', async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    assert.deepEqual(strategy.asOf(ctx, at.ONE5!), { start: at.T1!, end: at.T1! + 3 });
    await strategy.runCompress(chunkOf(ctx, at.ONE5!, at.ONE7!), ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, 'TOPIC_ONE'), 1, "its topic's transition is the head");
    for (const m of ['ONE0', 'ONE1']) assert.equal(countIn(req, `${m} `), 1, `${m}, in that head, raw once`);
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, 'not the later topic');
    assert.equal(countIn(req, 'TWO0'), 0);
    assert.equal(countIn(req, 'OPEN0 '), 0, 'nor the opening, which comes before that head');
    await manager.close();
  });

  it('a chunk that starts at a transition is compressed with no head: nothing came before it in that topic', async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    await strategy.runCompress(chunkOf(ctx, at.T1!, at.ONE1!), ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, 'TOPIC_ONE'), 1, 'the transition is sent once, in the chunk');
    assert.equal(countIn(req, 'TOPIC_TWO'), 0);
    assert.equal(countIn(req, 'OPEN0 '), 0);
    assert.deepEqual(strategy.asOf(ctx, at.T1!), { start: at.T1!, end: at.T1! });
    await manager.close();
  });

  it('a merge across a reset gives the head as of its first message', async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const a = summary('L1-501', [ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    const b = summary('L1-502', [ids[at.T1!]!, ids[at.ONE0!]!]);
    strategy.seed(a);
    strategy.seed(b);
    await strategy.runMerge(2, [a.id, b.id], ctx);
    assert.equal(captured.length, 1);
    const req = captured[0]!;
    for (const m of ['OPEN0', 'OPEN1', 'OPEN2']) assert.equal(countIn(req, `${m} `), 1, `${m} is the head, raw once`);
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head's transition isn't sent");
    assert.equal(countIn(req, 'TWO0'), 0);
    await manager.close();
  });

  it("a chunk after the live head's start keeps the live head, as before", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    assert.deepEqual(strategy.asOf(ctx, at.TWO4!), { start: at.T2!, end: at.T2! + 3 });
    await strategy.runCompress(chunkOf(ctx, at.TWO4!, at.TWO6!), ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, 'TOPIC_TWO'), 1, "the live head's transition is the head");
    for (const m of ['TWO0', 'TWO1']) assert.equal(countIn(req, `${m} `), 1);
    assert.equal(countIn(req, 'TOPIC_ONE'), 0);
    await manager.close();
  });

  it("a strategy reset to a message that isn't a transition isn't in the store: history before it gets the latest transition or the opening, as a restart reads it", async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    strategy.resetHeadWindow(ids[at.OPEN6!]!);
    assert.deepEqual(strategy.asOf(ctx, at.OPEN3!), { start: 0, end: 3 }, 'the opening, before the reset message');
    assert.deepEqual(strategy.asOf(ctx, at.OPEN7!), { start: at.OPEN6!, end: at.OPEN7! }, 'from the live start on, the live head, cut at the chunk');
    await strategy.runCompress(chunkOf(ctx, at.OPEN3!, at.OPEN5!), ctx);
    for (const m of ['OPEN0', 'OPEN1', 'OPEN2']) assert.equal(countIn(captured[0], `${m} `), 1, `${m} is the head, raw once`);
    await manager.close();
  });

  it("a past head is priced with today's head window, as the live head is", async () => {
    const { manager, strategy, ctx, at } = await build(2);
    assert.deepEqual(strategy.asOf(ctx, at.OPEN6!), { start: 0, end: 3 });
    strategy.headOfMessages(ctx, 1);
    assert.deepEqual(strategy.asOf(ctx, at.OPEN6!), { start: 0, end: 1 }, "today's window decides, not the one in force then");
    strategy.headOfMessages(ctx, 5);
    assert.deepEqual(strategy.asOf(ctx, at.ONE7!), { start: at.T1!, end: at.T1! + 5 });
    await manager.close();
  });

  it('before the live head\'s start, a Context Manager message whose text starts with "[Topic Transition]" starts a past head, as the restart reads one; a user\'s doesn\'t', async () => {
    const { manager, strategy, ctx, at } = await build(0);
    const quoted = ctx.messageStore.getAll().length;
    manager.addMessage('Context Manager', text('[Topic Transition] noted by the host'));
    manager.addMessage('user', text(body('LATE0')));
    const userQuoted = quoted + 2;
    manager.addMessage('user', text('[Topic Transition] quoted by someone'));
    for (let i = 1; i < 4; i++) manager.addMessage('user', text(body(`LATE${i}`)));
    const t3 = manager.addMessage('Context Manager', text('[Topic Transition]\n\nA third topic.'));
    strategy.resetHeadWindow(t3);
    assert.ok(at.T2! < quoted);
    assert.equal(strategy.asOf(ctx, userQuoted + 2).start, quoted, "the host's message starts a head; the user's quoting doesn't");
    await manager.close();
  });

  it("a restart reads the same heads while the live head starts at the last transition: where a past head starts comes from the store alone", async () => {
    const path = freshPath();
    const first = await build(2, { path });
    const positions = [first.at.OPEN6!, first.at.ONE5!, first.at.T1!, first.at.TWO4!];
    const before = positions.map((p) => first.strategy.asOf(first.ctx, p));
    await first.manager.close();
    const strategy = new ProbeStrategy({
      compressionModel: 'test-compression-model', headWindowTokens: first.strategy.headWindowTokens(), recentWindowTokens: 0,
      targetChunkTokens: 1_000_000, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    });
    const manager = await ContextManager.open({ path, strategy, membrane: { complete: async () => ({ stopReason: 'end_turn', content: [] }) } as never });
    const ctx = context(manager);
    assert.deepEqual(positions.map((p) => strategy.asOf(ctx, p)), before);
    await manager.close();
  });

  it("a chunk whose first message has left the store starts at its first message still there, and gets that message's head", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    const kept = ctx.messageStore.getAll()[at.OPEN7!]!;
    const gone = { ...kept, id: 'not-in-the-store', content: text(body('GONE')) };
    await strategy.runCompress({ index: 950, startIndex: at.OPEN6!, endIndex: at.OPEN8!, messages: [gone, kept], tokens: 100, compressed: false }, ctx);
    const req = captured[0]!;
    for (const m of ['OPEN0', 'OPEN1', 'OPEN2']) assert.equal(countIn(req, `${m} `), 1, `${m}: the opening is the head as of OPEN7`);
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head isn't sent");
    assert.equal(countIn(req, 'TWO0'), 0);
    await manager.close();
  });

  it('a chunk with no message left in the store gets no head and recalls nothing: nothing in the store says when its history happened', async () => {
    const { manager, strategy, ctx, captured, at } = await build(2);
    assert.deepEqual(strategy.asOf(ctx, -1), { start: at.T2!, end: at.T2! });
    const kept = ctx.messageStore.getAll()[at.OPEN7!]!;
    const gone = { ...kept, id: 'not-in-the-store', content: text(body('GONE')) };
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const earlier = summary('L1-841', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    strategy.seed(earlier);
    await strategy.runCompress({ index: 950, startIndex: at.OPEN6!, endIndex: at.OPEN7!, messages: [gone], tokens: 100, compressed: false }, ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head isn't sent");
    assert.equal(countIn(req, 'TWO0'), 0);
    assert.equal(countIn(req, 'OPEN0 '), 0, 'nor any other head');
    assert.equal(countIn(req, `authored ${earlier.id}`), 0, 'and nothing is recalled: its place is unknown');
    await manager.close();
  });

  it('a chunk whose first message a host removes while it waits in the queue still recalls the summaries before it', async () => {
    // Twelve equal messages in chunks of four; the first message of the second chunk is removed during the first
    // chunk's compression, as a delete arriving then would (agent-framework's Discord module removes stored rows).
    let manager!: ContextManager;
    const strategy = new ProbeStrategy({
      compressionModel: 'test-compression-model', headWindowTokens: 1, recentWindowTokens: 0, l1HoldbackChunks: 0,
      targetChunkTokens: 60, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    } as never);
    const captured: unknown[] = [];
    const ids: string[] = [];
    const membrane = {
      complete: async (req: unknown) => {
        captured.push(structuredClone(req));
        if (captured.length === 1) manager.removeMessage(ids[4]! as never);
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `MEMORY_${captured.length}` }] };
      },
    };
    manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
    for (let i = 0; i < 12; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
    for (let i = 0; i < 20 && captured.length < 2; i++) await manager.tick();
    assert.ok(captured.length >= 2, 'premise: the second chunk was compressed');
    const req = captured[1]!;
    assert.equal(countIn(req, 'M4 '), 1, 'premise: the queued chunk still holds the removed message');
    assert.equal(countIn(req, 'MEMORY_1'), 1, "the first chunk's summary, before it, is recalled");
    await manager.close();
  });

  it("a summary whose first message a host removed starts at its first message still there: it's recalled, so its other messages keep a form", async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const chunk = chunkOf(ctx, at.OPEN6!, at.OPEN8!);
    const s = summary('L1-801', [ids[at.OPEN3!]!, ids[at.OPEN4!]!, ids[at.OPEN5!]!]);
    strategy.seed(s);
    manager.removeMessage(ids[at.OPEN3!]! as never);
    await strategy.runCompress(chunk, ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, `authored ${s.id}`), 1, 'the summary is recalled');
    assert.equal(countIn(req, 'OPEN4 '), 0, 'its messages are represented by it, not raw');
    await manager.close();
  });

  it('a summary whose first message a host removed is recalled in its place, before a later one, so older history never follows a later memory', async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const chunk = chunkOf(ctx, at.OPEN7!, at.OPEN9!);
    const older = summary('L1-851', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    const newer = summary('L1-852', [ids[at.OPEN5!]!, ids[at.OPEN6!]!]);
    strategy.seed(older);
    strategy.seed(newer);
    manager.removeMessage(ids[at.OPEN3!]! as never);
    await strategy.runCompress(chunk, ctx);
    const blob = JSON.stringify(captured[0]!);
    const o = blob.indexOf(`authored ${older.id}`);
    const n = blob.indexOf(`authored ${newer.id}`);
    assert.ok(o >= 0 && n >= 0, 'premise: both are recalled');
    assert.ok(o < n, 'the older summary comes first');
    await manager.close();
  });

  it("a summary with no message left in the store isn't recalled: its place is unknown", async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const chunk = chunkOf(ctx, at.OPEN6!, at.OPEN8!);
    const s = summary('L1-802', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    strategy.seed(s);
    manager.removeMessage(ids[at.OPEN3!]! as never);
    manager.removeMessage(ids[at.OPEN4!]! as never);
    await strategy.runCompress(chunk, ctx);
    assert.equal(countIn(captured[0]!, `authored ${s.id}`), 0);
    await manager.close();
  });

  it("a merge recalls a summary before it whose first message a host removed, so that summary's other messages keep a form", async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const a = summary('L1-811', [ids[at.OPEN3!]!, ids[at.OPEN4!]!, ids[at.OPEN5!]!]);
    const b = summary('L1-812', [ids[at.OPEN6!]!, ids[at.OPEN7!]!]);
    const c = summary('L1-813', [ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    for (const x of [a, b, c]) strategy.seed(x);
    manager.removeMessage(ids[at.OPEN3!]! as never);
    assert.equal(await strategy.runMerge(2, [b.id, c.id], ctx), true, 'premise: the merge runs');
    const req = captured[0]!;
    assert.equal(countIn(req, `authored ${a.id}`), 1, 'the summary before the merge is recalled');
    assert.equal(countIn(req, 'OPEN4 '), 0, 'its messages are represented by it, not raw');
    await manager.close();
  });

  it("a merge whose first source message a host removed starts at its first message still there: that message's head, and recall only of what starts before it", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2, { placing: true });
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const before = summary('L1-821', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    const b = summary('L1-822', [ids[at.OPEN6!]!, ids[at.OPEN7!]!]);
    const c = summary('L1-823', [ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    const after = summary('L1-824', [ids[at.ONE3!]!, ids[at.ONE4!]!]);
    for (const x of [before, b, c, after]) strategy.seed(x);
    manager.removeMessage(ids[at.OPEN6!]! as never);
    assert.equal(await strategy.runMerge(2, [b.id, c.id], ctx), true, 'premise: the merge runs');
    const req = captured[0]!;
    for (const m of ['OPEN0', 'OPEN1', 'OPEN2']) assert.equal(countIn(req, `${m} `), 1, `${m}: the opening is the head as of OPEN7`);
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head isn't sent");
    assert.equal(countIn(req, `authored ${before.id}`), 1, 'the summary before it is recalled');
    assert.equal(countIn(req, `authored ${after.id}`), 0, 'the summary after it is not');
    await manager.close();
  });

  it('a merge whose sources have no message left in the store gets no head and recalls nothing, as a chunk in that state', async () => {
    const { manager, strategy, ctx, captured, at } = await build(2, { placing: true });
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const before = summary('L1-831', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    const b = summary('L1-832', [ids[at.OPEN6!]!]);
    const c = summary('L1-833', [ids[at.OPEN7!]!]);
    const after = summary('L1-834', [ids[at.ONE3!]!, ids[at.ONE4!]!]);
    for (const x of [before, b, c, after]) strategy.seed(x);
    manager.removeMessage(ids[at.OPEN6!]! as never);
    manager.removeMessage(ids[at.OPEN7!]! as never);
    assert.equal(await strategy.runMerge(2, [b.id, c.id], ctx), true, 'premise: the merge runs');
    const req = captured[0]!;
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head isn't sent");
    assert.equal(countIn(req, 'OPEN0 '), 0, 'nor any other head');
    assert.equal(countIn(req, `authored ${before.id}`), 0);
    assert.equal(countIn(req, `authored ${after.id}`), 0, 'nothing is recalled: its place is unknown');
    await manager.close();
  });

  it("a merge whose first source has no message left starts at its next source's first message still there", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2, { placing: true });
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const before = summary('L1-861', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    const b = summary('L1-862', [ids[at.OPEN6!]!]);
    const c = summary('L1-863', [ids[at.OPEN7!]!, ids[at.OPEN8!]!]);
    const after = summary('L1-864', [ids[at.ONE3!]!, ids[at.ONE4!]!]);
    for (const x of [before, b, c, after]) strategy.seed(x);
    manager.removeMessage(ids[at.OPEN6!]! as never);
    assert.equal(await strategy.runMerge(2, [b.id, c.id], ctx), true, 'premise: the merge runs');
    const req = captured[0]!;
    for (const m of ['OPEN0', 'OPEN1', 'OPEN2']) assert.equal(countIn(req, `${m} `), 1, `${m}: the opening is the head as of OPEN7`);
    assert.equal(countIn(req, 'TOPIC_TWO'), 0, "the live head isn't sent");
    assert.equal(countIn(req, `authored ${before.id}`), 1, 'the summary before it is recalled');
    assert.equal(countIn(req, `authored ${after.id}`), 0, 'the summary after it is not');
    await manager.close();
  });

  it('a merge recalls the summaries before it in the order they start in the store, and none with no message left', async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const older = summary('L1-871', [ids[at.OPEN3!]!]);
    const newer = summary('L1-872', [ids[at.OPEN4!]!, ids[at.OPEN5!]!]);
    const gone = summary('L1-873', [ids[at.OPEN6!]!]);
    const b = summary('L1-874', [ids[at.OPEN7!]!]);
    const c = summary('L1-875', [ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    // Seeded newest first, so the order the request gives comes from the sort by start, not from the seeding.
    for (const x of [c, b, gone, newer, older]) strategy.seed(x);
    // The newer summary's first message is removed: it starts at OPEN5, its first leaf still in the store, after
    // the older one's OPEN3. (Before this change the merge's prior recall set, section 1a of executeMerge, placed a
    // summary by sourceRange.first, which has no place here: it left this one out. Ordering by sourceRange.first
    // would put it first, at -1.)
    manager.removeMessage(ids[at.OPEN4!]! as never);
    manager.removeMessage(ids[at.OPEN6!]! as never);
    assert.equal(await strategy.runMerge(2, [b.id, c.id], ctx), true, 'premise: the merge runs');
    const blob = JSON.stringify(captured[0]!);
    const o = blob.indexOf(`authored ${older.id}`);
    const n = blob.indexOf(`authored ${newer.id}`);
    assert.ok(o >= 0 && n >= 0, 'premise: both are recalled');
    assert.ok(o < n, 'the older comes first');
    assert.equal(blob.indexOf(`authored ${gone.id}`), -1, 'a summary with no message left is not recalled');
    await manager.close();
  });

  it('a merge recalls a higher-level summary before it whose first leaf a host removed, its start found through its L1s', async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const x = { ...summary('L1-901', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]), mergedInto: 'L2-903' };
    const y = { ...summary('L1-902', [ids[at.OPEN5!]!]), mergedInto: 'L2-903' };
    const z: SummaryEntry = {
      id: 'L2-903', level: 2, content: 'authored L2-903', tokens: 20, sourceLevel: 1, sourceIds: [x.id, y.id],
      sourceRange: { first: ids[at.OPEN3!]!, last: ids[at.OPEN5!]! }, created: 903,
    };
    const b = summary('L1-904', [ids[at.OPEN7!]!]);
    const c = summary('L1-905', [ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    for (const e of [x, y, z, b, c]) strategy.seed(e);
    manager.removeMessage(ids[at.OPEN3!]! as never);
    assert.equal(await strategy.runMerge(2, [b.id, c.id], ctx), true, 'premise: the merge runs');
    assert.equal(countIn(captured[0]!, 'authored L2-903'), 1, 'the L2 is recalled');
    await manager.close();
  });

  it("a merge starts at the first of all its sources' leaves still in the store, whatever order its sources are listed in", async () => {
    const { manager, strategy, ctx, captured, at } = await build(0, { placing: true });
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const between = summary('L1-911', [ids[at.OPEN7!]!]);
    const b = summary('L1-912', [ids[at.OPEN6!]!]);
    const c = summary('L1-913', [ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    for (const e of [between, b, c]) strategy.seed(e);
    // Listed later source first: by its first source alone the merge would start at OPEN8, after the summary between.
    assert.equal(await strategy.runMerge(2, [c.id, b.id], ctx), true, 'premise: the merge runs');
    assert.equal(countIn(captured[0]!, `authored ${between.id}`), 0, 'the summary after its first leaf, OPEN6, is not recalled');
    await manager.close();
  });

  it('a higher-level summary whose first leaf a host removed starts at its first leaf still there', async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const x = { ...summary('L1-881', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]), mergedInto: 'L2-883' };
    const y = { ...summary('L1-882', [ids[at.OPEN5!]!]), mergedInto: 'L2-883' };
    const z: SummaryEntry = {
      id: 'L2-883', level: 2, content: 'authored L2-883', tokens: 20, sourceLevel: 1, sourceIds: [x.id, y.id],
      sourceRange: { first: ids[at.OPEN3!]!, last: ids[at.OPEN5!]! }, created: 883,
    };
    for (const e of [x, y, z]) strategy.seed(e);
    manager.removeMessage(ids[at.OPEN3!]! as never);
    await strategy.runCompress(chunkOf(ctx, at.OPEN7!, at.OPEN9!), ctx);
    assert.equal(countIn(captured[0]!, 'authored L2-883'), 1, 'the L2 is recalled, its start found through its L1s');
    await manager.close();
  });

  it("a summary starts at its first leaf in the store, whatever its sourceRange.first says", async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    // An L2 whose sources came in the order [later, earlier], so its sourceRange.first names a leaf after the
    // chunk while two of its leaves come before it. (An L1's range is its sourceIds' ends: pushSummary sets it.)
    const earlier = { ...summary('L1-891', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]), mergedInto: 'L2-893' };
    const later = { ...summary('L1-892', [ids[at.OPEN9!]!]), mergedInto: 'L2-893' };
    const z: SummaryEntry = {
      id: 'L2-893', level: 2, content: 'authored L2-893', tokens: 20, sourceLevel: 1, sourceIds: [later.id, earlier.id],
      sourceRange: { first: ids[at.OPEN9!]!, last: ids[at.OPEN4!]! }, created: 893,
    };
    for (const e of [earlier, later, z]) strategy.seed(e);
    await strategy.runCompress(chunkOf(ctx, at.OPEN6!, at.OPEN8!), ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, 'authored L2-893'), 1, 'it is recalled, so OPEN3 and OPEN4, which it covers, keep a form');
    assert.equal(countIn(req, 'OPEN3 '), 0);
    await manager.close();
  });

  it('a compression hold inside a past head cuts it at the hold', async () => {
    const { manager, strategy, ctx, at } = await build(2);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    manager.holdCompression([ids[at.OPEN1!]!]);
    assert.deepEqual(strategy.asOf(ctx, at.OPEN6!), { start: 0, end: at.OPEN1! });
    await manager.close();
  });

  it('a chunk compressed after the history behind it was summarized recalls only the summaries before it: the old head after a reset', async () => {
    const { manager, strategy, ctx, captured, at } = await build(1);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    // The history after the opening's head was summarized while that head was the head; the reset released the
    // head, so its chunk is compressed last.
    const later = [summary('L1-601', [ids[at.OPEN3!]!, ids[at.OPEN4!]!, ids[at.OPEN5!]!]), summary('L1-602', [ids[at.OPEN6!]!, ids[at.OPEN7!]!, ids[at.OPEN8!]!, ids[at.OPEN9!]!])];
    for (const s of later) strategy.seed(s);
    await strategy.runCompress(chunkOf(ctx, at.OPEN0!, at.OPEN3!), ctx);
    const req = captured[0]!;
    for (const s of later) {
      assert.equal(countIn(req, `Recall memory ${s.id}.`), 0, `${s.id}, after the chunk, isn't recalled`);
      assert.equal(countIn(req, `authored ${s.id}`), 0);
    }
    for (const m of ['OPEN3', 'OPEN6', 'OPEN9']) assert.equal(countIn(req, `${m} `), 0, `${m} stays covered: not raw either`);
    assert.equal(countIn(req, 'TOPIC_ONE'), 0, "and the live head isn't the head");
    await manager.close();
  });

  it('a chunk compressed after the history behind it was summarized recalls only the summaries before it: a chunk let go late', async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const before = summary('L1-701', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    const after = summary('L1-702', [ids[at.OPEN7!]!, ids[at.OPEN8!]!, ids[at.OPEN9!]!]);
    strategy.seed(before);
    strategy.seed(after);
    await strategy.runCompress(chunkOf(ctx, at.OPEN5!, at.OPEN7!), ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, `Recall memory ${before.id}.`), 1, 'the summary before the chunk is recalled');
    assert.equal(countIn(req, `Recall memory ${after.id}.`), 0, 'the one after it is not');
    assert.equal(countIn(req, `authored ${after.id}`), 0);
    assert.equal(countIn(req, 'OPEN8 '), 0, 'and its messages stay covered');
    await manager.close();
  });

  it("one count's reader gives each chunk its own head's answer, asked in either order, and leaves out a tool cycle before that head", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2, { openingTool: true });
    const opening = chunkOf(ctx, at.OPEN6!, at.OPEN8!);
    const topicOne = chunkOf(ctx, at.ONE5!, at.ONE7!);
    // The opening's head carries the cycle; topic one's head starts after it, so the cycle is left out.
    const forward = strategy.toolBlockReader(ctx);
    assert.deepEqual([forward(opening), forward(topicOne)], [true, false]);
    const backward = strategy.toolBlockReader(ctx);
    assert.deepEqual([backward(topicOne), backward(opening)], [false, true]);
    // Tick agrees for the chunk whose head leaves the cycle out: it asks the model.
    await strategy.runCompress(topicOne, ctx);
    assert.equal(captured.length, 1, 'tick asked the model, the cycle being before its head');
    await manager.close();
  });

  it("the count reads a chunk whose first message has left the store from its first message still there, as tick does", async () => {
    const { manager, strategy, ctx, at } = await build(2, { openingTool: true });
    const kept = ctx.messageStore.getAll()[at.OPEN7!]!;
    const gone = { ...kept, id: 'not-in-the-store', content: text(body('GONE')) };
    const chunk: Chunk = { index: 960, startIndex: at.OPEN6!, endIndex: at.OPEN8!, messages: [gone, kept], tokens: 100, compressed: false };
    // As of OPEN7 the head is the opening, which carries the cycle raw, so tick defers this chunk before the tools.
    assert.equal(strategy.carriesToolBlocks(ctx, chunk), true);
    await manager.close();
  });

  it('with merges on, through two resets, no compression request carries anything from at or after its chunk', async () => {
    // From a review: the two-reset flow with merges on, run through ContextManager as a host does.
    const MARKER = 'You will soon form a new memory';
    const NAME = /\b(OPEN\d|ONE\d|TWO\d|TOPIC_ONE|TOPIC_TWO)\b/g;
    const namesIn = (t: string): string[] => [...new Set([...t.replace(/\\n/g, ' ').matchAll(NAME)].map((m) => m[1]!))];
    const captured: string[] = [];
    const membrane = {
      complete: async (req: unknown) => {
        const blob = JSON.stringify(req);
        captured.push(blob);
        const at = blob.indexOf(MARKER);
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `${at >= 0 ? 'MEM' : 'MERGE'}[${namesIn(at >= 0 ? blob.slice(at) : blob).join(',')}]` }] };
      },
    };
    const probe = await ContextManager.open({ path: freshPath(), strategy: new ProbeStrategy({ compressionModel: 'm' } as never), membrane: membrane as never });
    probe.addMessage('user', text(body('OPEN0')));
    const per = context(probe).messageStore.estimateTokens(context(probe).messageStore.getAll()[0]!);
    await probe.close();
    const strategy = new ProbeStrategy({
      compressionModel: 'test-compression-model', headWindowTokens: 3 * per + Math.floor(per / 2), recentWindowTokens: 0, l1HoldbackChunks: 0,
      targetChunkTokens: 60, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 2,
    } as never);
    const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
    const order: string[] = [];
    const add = (name: string, participant: string): void => { manager.addMessage(participant, text(body(name))); order.push(name); };
    const drain = async (): Promise<void> => { for (let i = 0; i < 60; i++) await manager.tick(); };
    for (let i = 0; i < 10; i++) add(`OPEN${i}`, i % 2 ? 'assistant' : 'user');
    await drain();
    await manager.resetHeadWindow(body('TOPIC_ONE')); order.push('TOPIC_ONE');
    for (let i = 0; i < 10; i++) add(`ONE${i}`, i % 2 ? 'assistant' : 'user');
    await drain();
    await manager.resetHeadWindow(body('TOPIC_TWO')); order.push('TOPIC_TWO');
    for (let i = 0; i < 6; i++) add(`TWO${i}`, i % 2 ? 'assistant' : 'user');
    await drain();
    const pos = new Map(order.map((n, i) => [n, i]));
    let compressions = 0;
    let merges = 0;
    for (const blob of captured) {
      const at = blob.indexOf(MARKER);
      if (at < 0) { if (blob.includes('You have just reviewed')) merges++; continue; }
      compressions++;
      const first = Math.min(...namesIn(blob.slice(at)).map((n) => pos.get(n)!));
      const later = namesIn(blob.slice(0, at)).filter((n) => pos.get(n)! >= first);
      assert.deepEqual(later, [], `a request for history from ${order[first]} carries, before its chunk: ${later.join(',')}`);
    }
    assert.ok(compressions >= 5 && merges >= 1, `premise: the flow compresses and merges (${compressions} compressions, ${merges} merges)`);
    await manager.close();
  });

  it("one reader of heads gives every position the head the rule gives it alone, asked in any order, with three topics before the live head, a hold in the live head, and the live head's end overridden", async () => {
    const { manager, strategy, ctx, at } = await build(2);
    // Two resets more, so three transitions lie before the live head's start.
    for (const topic of ['THREE', 'FOUR']) {
      await manager.resetHeadWindow(`${topic} begins.`);
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`${topic}${i}`)));
    }
    const messages = ctx.messageStore.getAll();
    const liveStart = strategy.asOf(ctx, messages.length - 1).start;
    const transitions = messages.flatMap((m, i) =>
      i > 0 && i < liveStart && m.content.some((c) => c.type === 'text' && c.text.startsWith('[Topic Transition]')) ? [i] : []);
    assert.equal(transitions.length, 3, 'premise: three transitions before the live head');
    const positions = Array.from({ length: messages.length + 1 }, (_, i) => i - 1);
    const orders = {
      ascending: positions,
      descending: [...positions].reverse(),
      'evens, then odds': [...positions.filter((p) => p % 2 === 0), ...positions.filter((p) => p % 2 !== 0)],
    };
    const check = (state: string): void => {
      for (const [name, order] of Object.entries(orders)) {
        const reader = strategy.heads(ctx);
        for (const p of order) assert.deepEqual(reader(p), strategy.headAlone(ctx, p), `${state}, ${name}: position ${p}`);
      }
    };
    check('as built');
    assert.deepEqual(strategy.heads(ctx)(at.ONE5!), { start: at.T1!, end: at.T1! + 3 }, "topic one's head");
    const live = strategy as unknown as { getHeadWindowEnd(store: unknown): number };
    live.getHeadWindowEnd = () => liveStart + 1;
    assert.deepEqual(strategy.heads(ctx)(liveStart + 2), { start: liveStart, end: liveStart + 1 }, "premise: the override shortens the live head");
    check("with the live head's end overridden");
    delete (live as { getHeadWindowEnd?: unknown }).getHeadWindowEnd;
    manager.holdCompression([messages[liveStart + 2]!.id]);
    assert.deepEqual(strategy.heads(ctx)(liveStart + 3), { start: liveStart, end: liveStart + 2 }, 'premise: the hold cuts the live head');
    check('with a hold in the live head');
    await manager.close();
  });

  it('one count reads the holds once and walks a head once for the chunks that share it, however many it reads', async () => {
    const { manager, strategy, ctx, at } = await build(2, { openingTool: true });
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    manager.holdCompression([ids[at.TWO5!]!]);
    const walker = strategy as unknown as { headWindowEndFrom(...args: unknown[]): number };
    const walk = walker.headWindowEndFrom.bind(strategy);
    let walks = 0;
    walker.headWindowEndFrom = (...args: unknown[]): number => {
      walks++;
      return walk(...args);
    };
    const scans = strategy.holdScans();
    const reader = strategy.toolBlockReader(ctx);
    const chunks = [chunkOf(ctx, at.OPEN4!, at.OPEN5!), chunkOf(ctx, at.OPEN6!, at.OPEN7!), chunkOf(ctx, at.OPEN8!, at.OPEN9!)];
    assert.deepEqual(chunks.map((c) => reader(c)), [true, true, true], "premise: the opening's head carries its tool cycle into each chunk's request");
    assert.equal(strategy.holdScans() - scans, 1, 'one scan of the holds');
    assert.equal(walks, 1, "one walk of the opening's head");
    const before = strategy.holdScans();
    const own = strategy.toolBlockReader(ctx);
    assert.equal(own(chunkOf(ctx, at.OPEN1!, at.OPEN3!)), true, 'premise: a chunk holding a tool block answers from its own messages');
    assert.equal(strategy.holdScans(), before, 'so its count reads no head and scans no holds');
    await manager.close();
  });

  it("one count's reader keys its memo by the pins before a chunk too: a pin that opens a summary over a tool cycle changes the answer at the same head start", async () => {
    const { manager, strategy, ctx, at } = await build(0, { openingTool: true });
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    // The opening's tool cycle (OPEN1, OPEN2) is covered by an L1, and a pin on OPEN3 opens that L1's messages.
    strategy.seed(summary('L1-921', [ids[at.OPEN1!]!, ids[at.OPEN2!]!, ids[at.OPEN3!]!]));
    manager.pinRange(ids[at.OPEN3!]! as never, ids[at.OPEN3!]! as never);
    const before = chunkOf(ctx, at.OPEN0!, at.OPEN1!);
    const after = chunkOf(ctx, at.OPEN6!, at.OPEN8!);
    assert.equal(strategy.asOf(ctx, at.OPEN0!).start, strategy.asOf(ctx, at.OPEN6!).start, 'premise: both chunks have the same head start');
    const reader = strategy.toolBlockReader(ctx);
    assert.equal(reader(before), false, 'before the pin, the L1 covers the cycle');
    assert.equal(reader(after), true, 'after it, the pin opens the L1 and its cycle is carried raw');
    await manager.close();
  });

  it('under a recall budget for one pair, a compression request keeps the newer summary when the older one has its first message removed', async () => {
    const { manager, strategy, ctx, captured, at } = await build(0);
    const ids = ctx.messageStore.getAll().map((m) => m.id);
    const older = summary('L1-931', [ids[at.OPEN3!]!, ids[at.OPEN4!]!]);
    const newer = summary('L1-932', [ids[at.OPEN5!]!, ids[at.OPEN6!]!]);
    strategy.seed(older);
    strategy.seed(newer);
    (strategy as unknown as { config: { compressionRecallBudgetTokens: number } }).config.compressionRecallBudgetTokens = 100;
    manager.removeMessage(ids[at.OPEN3!]! as never);
    await strategy.runCompress(chunkOf(ctx, at.OPEN7!, at.OPEN9!), ctx);
    const req = captured[0]!;
    assert.equal(countIn(req, `authored ${older.id}`) + countIn(req, `authored ${newer.id}`), 1, 'premise: the budget holds one pair');
    assert.equal(countIn(req, `authored ${newer.id}`), 1, 'the newer summary, which starts later, is kept');
    await manager.close();
  });

  it("tick's tool deferral and the count of queued work agree for a chunk before a reset whose head holds a tool block", async () => {
    const { manager, strategy, ctx, captured, at } = await build(2, { openingTool: true });
    const chunk = chunkOf(ctx, at.OPEN6!, at.OPEN8!);
    await strategy.runCompress(chunk, ctx);
    assert.equal(captured.length, 0, 'tick defers it: its request would carry the opening, whose tool blocks need the host\'s tools');
    assert.equal(strategy.carriesToolBlocks(ctx, chunk), true, 'and the count reads the same request');
    await manager.close();
  });
});
