/**
 * Two ingestions of one text are two bodies.
 *
 * The chunker names a shard group by a hash of its text, so a document
 * posted twice stores two runs of shards under one bodyGroupId. Readers that
 * took the group id for the body ran the copies together: the render sorted
 * both runs by shard index and interleaved them, removeBodyGroup took both,
 * removeRange refused the boundary between them, a window aligned across
 * them, and reading mode counted the document twice. A body is one
 * ingestion, delimited by store order and rising shard indices (body-runs.ts).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import {
  ContextManager,
  AutobiographicalStrategy,
  concatBodyGroups,
  bodyStart,
  bodyEnd,
  bodyBoundsIn,
  type Chunk,
} from '../src/index.js';
import type { StoredMessage, StrategyContext, SummaryEntry } from '../src/types/index.js';

const STORE = './test-body-instances';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** Sixteen paragraphs, each named, long enough to be sharded. */
const DOCUMENT = Array.from({ length: 16 }, (_, i) =>
  `P${String(i).padStart(2, '0')} ${'the quick brown fox jumps over the lazy dog '.repeat(4)}\n\n`).join('');

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const textOf = (blocks: readonly ContentBlock[]) => blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
/** The paragraph names in the order they appear. */
const paragraphs = (s: string) => s.match(/P\d\d/g) ?? [];
const inOrder = Array.from({ length: 16 }, (_, i) => `P${String(i).padStart(2, '0')}`);

/**
 * Each copy renders whole and in order. Where a copy renders as one message
 * (the render joins a body's shards), it is never the same message as the
 * other copy: two messages begin at P00.
 */
function assertTwoWholeCopies(messages: ReadonlyArray<{ content: ContentBlock[] }>): void {
  const texts = messages.map((m) => textOf(m.content));
  assert.deepEqual(paragraphs(texts.join('\n')), [...inOrder, ...inOrder]);
  const starts = texts.filter((t) => paragraphs(t)[0] === 'P00');
  assert.equal(starts.length, 2, 'each copy starts its own message');
  for (const t of starts) assert.ok(paragraphs(t).filter((p) => p === 'P00').length === 1, 'no message holds both copies');
}

class Exposed extends AutobiographicalStrategy {
  /** Message ids whose entries are dropped after the merge (the guard test). */
  drop = new Set<string>();
  docContext(chunk: Chunk, ctx: unknown) {
    return this.detectDocContext(chunk, ctx as never);
  }
  boundary(store: unknown) {
    return this.holdBoundary(store as never);
  }
  recentStart(store: unknown) {
    return this.getRecentWindowStart(store as never);
  }
  headEnd(store: unknown) {
    return this.getHeadWindowEnd(store as never);
  }
  protected override applyImageStripping(...args: Parameters<AutobiographicalStrategy['applyImageStripping']>): void {
    super.applyImageStripping(...args);
    const [entries] = args;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.sourceMessageId && this.drop.has(entries[i]!.sourceMessageId!)) entries.splice(i, 1);
    }
  }
}

/** Set one window's token budget so its boundary lands at `target`, by search. */
function landBoundary(config: Record<string, number>, key: string, read: () => number, target: number): void {
  for (let t = 10; t < 50_000; t += 5) {
    config[key] = t;
    if (read() === target) return;
  }
  throw new Error(`no ${key} puts the boundary at ${target}`);
}

async function twoCopies(options: Record<string, unknown> = {}) {
  const strategy = new Exposed({ adaptiveResolution: true, targetChunkTokens: 60, headWindowTokens: 0, ...options });
  const cm = await ContextManager.open({ path: STORE, strategy });
  cm.addMessage('user', text('before'));
  cm.addMessage('user', text(DOCUMENT));
  cm.addMessage('user', text(DOCUMENT));
  cm.addMessage('user', text('after'));
  const all = cm.getAllMessages();
  const shards = all.filter((m) => m.bodyGroupId);
  const group = shards[0]!.bodyGroupId!;
  const n = shards.filter((m) => m.shardIndex === 0).length;
  assert.equal(n, 2, 'two ingestions');
  assert.ok(shards.every((m) => m.bodyGroupId === group), 'under one group id');
  const perCopy = shards.length / 2;
  assert.ok(perCopy >= 3, `sharded (${perCopy} shards a copy)`);
  const first = all.slice(1, 1 + perCopy);
  const second = all.slice(1 + perCopy, 1 + 2 * perCopy);
  return { cm, strategy, all, first, second };
}

describe('body runs', () => {
  const s = (bodyGroupId: string | undefined, shardIndex?: number) => ({ bodyGroupId, shardIndex });
  const bounds = (seq: ReturnType<typeof s>[]) => seq.map((_, i) => bodyBoundsIn(seq, i)).map(({ from, to }) => `${from}-${to}`);

  it('a body ends where its group id stops or its shard index stops rising', () => {
    const seq = [s(undefined), s('g', 0), s('g', 1), s('g', 2), s('g', 0), s('g', 1), s('h', 0), s('g', 0), s('g', 1), s('g', 0), s(undefined), s(undefined)];
    assert.deepEqual(bounds(seq), ['0-0', '1-3', '1-3', '1-3', '4-5', '4-5', '6-6', '7-8', '7-8', '9-9', '10-10', '11-11']);
    assert.equal(bodyEnd(seq.length, (i) => seq[i], 4), 5);
    assert.equal(bodyEnd(3, (i) => seq[i], 1), 2, 'read no further than the length given');
    assert.equal(bodyStart((i) => seq[i], 5), 4);
    assert.equal(bodyStart((i) => seq[i], 3), 1);
  });

  it('an interrupted write and its retry are two bodies', () => {
    // 0 and 1 of three, then the retry's 0, 1, 2.
    assert.deepEqual(bounds([s('g', 0), s('g', 1), s('g', 0), s('g', 1), s('g', 2)]), ['0-1', '0-1', '2-4', '2-4', '2-4']);
  });

  it('a sequence cut inside a body keeps its remainder apart from the next copy', () => {
    // A render region that starts at shard 13 of a 16-shard copy.
    assert.deepEqual(bounds([s('g', 13), s('g', 14), s('g', 15), s('g', 0), s('g', 1)]), ['0-2', '0-2', '0-2', '3-4', '3-4']);
    // A view that hides a body's first shards: what remains is still one body.
    assert.deepEqual(bounds([s('g', 2), s('g', 5), s('g', 9)]), ['0-2', '0-2', '0-2']);
  });
});

describe('two copies of one document', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('render each copy whole and in order, in the middle of the context', async () => {
    const { cm } = await twoCopies({ recentWindowTokens: 1 });
    assertTwoWholeCopies((await cm.compile(BUDGET)).messages);
    cm.close();
  });

  it('render each copy whole and in order when the recent window starts inside the first copy', async () => {
    const { cm, strategy, first } = await twoCopies({ recentWindowTokens: 1 });
    const store = (cm as unknown as { messageStore: unknown }).messageStore;
    const config = (strategy as unknown as { config: Record<string, number> }).config;
    landBoundary(config, 'recentWindowTokens', () => strategy.recentStart(store), first.length - 2);
    assertTwoWholeCopies((await cm.compile(BUDGET)).messages);
    cm.close();
  });

  it('render each copy whole and in order when the head window ends inside the first copy', async () => {
    const { cm, strategy } = await twoCopies({ recentWindowTokens: 1 });
    const store = (cm as unknown as { messageStore: unknown }).messageStore;
    const config = (strategy as unknown as { config: Record<string, number> }).config;
    landBoundary(config, 'headWindowTokens', () => strategy.headEnd(store), 4);
    assertTwoWholeCopies((await cm.compile(BUDGET)).messages);
    cm.close();
  });

  it('refuse a render that lost the newest copy, though an earlier copy of the same text survived', async () => {
    const { cm, strategy, second } = await twoCopies({ recentWindowTokens: 1_000_000 });
    cm.removeMessages(cm.getAllMessages().at(-1)!.id, cm.getAllMessages().at(-1)!.id);
    await cm.compile(BUDGET);
    for (const m of second) strategy.drop.add(m.id);
    await assert.rejects(cm.compile(BUDGET), /did not retain the newest turn/);
    cm.close();
  });

  it('render each copy whole and in order, in the recent window', async () => {
    const { cm } = await twoCopies({ recentWindowTokens: 1_000_000 });
    assertTwoWholeCopies((await cm.compile(BUDGET)).messages);
    cm.close();
  });

  it('join into one composite each', async () => {
    const { cm, first, second } = await twoCopies();
    const composites = concatBodyGroups([...first, ...second], () => '');
    assert.equal(composites.length, 2);
    assert.equal(textOf(composites[0]!.content), DOCUMENT);
    assert.equal(textOf(composites[1]!.content), DOCUMENT);
    cm.close();
  });

  it('remove one copy at a time', async () => {
    const { cm, first, second } = await twoCopies();
    const store = (cm as unknown as { messageStore: { removeBodyGroup(id: string): void } }).messageStore;
    store.removeBodyGroup(second[1]!.id);
    const left = cm.getAllMessages().map((m) => m.id);
    assert.deepEqual(left.filter((id) => second.some((m) => m.id === id)), [], 'the second copy is gone');
    assert.deepEqual(left.filter((id) => first.some((m) => m.id === id)), first.map((m) => m.id), 'the first is whole');
    cm.close();
  });

  it('remove a range ending between the copies', async () => {
    const { cm, all, first, second } = await twoCopies();
    cm.removeMessages(all[0]!.id, first.at(-1)!.id);
    assert.deepEqual(cm.getAllMessages().map((m) => m.id).slice(0, second.length), second.map((m) => m.id));
    // A range that does cut a body is still refused, at either edge.
    assert.throws(() => cm.removeMessages(second[0]!.id, second[1]!.id), /bisect bodyGroup .* at end/);
    assert.throws(() => cm.removeMessages(second[1]!.id, second.at(-1)!.id), /bisect bodyGroup .* at start/);
    cm.close();
  });

  it('align a window to the copy it starts in', async () => {
    const { cm, first, second } = await twoCopies();
    const start = 1 + first.length;
    const window = cm.getMessageWindow(start + 1, 1, { alignToBodyGroups: true });
    assert.equal(window.startIndex, start, 'back to the second copy\'s first shard, not the first copy\'s');
    assert.deepEqual(window.messages.map((m) => m.id), second.map((m) => m.id));
    // A window inside the first copy ends with it, not with the second.
    const inFirst = cm.getMessageWindow(2, 1, { alignToBodyGroups: true });
    assert.deepEqual(inFirst.messages.map((m) => m.id), first.map((m) => m.id));
    cm.close();
  });

  it('hold back to the start of the copy a held tool result answers, not the copy before it', () => {
    // Ingress puts a sharded message's tool_use on its first shard; a held
    // tool_result after the second copy steps back over that copy alone.
    const shard = (id: string, shardIndex: number): StoredMessage =>
      ({ id, sequence: 0, participant: 'user', content: text(`shard ${id}`), bodyGroupId: 'g', shardIndex, timestamp: new Date(0) }) as unknown as StoredMessage;
    const messages = [
      { id: 'm0', sequence: 0, participant: 'user', content: text('before'), timestamp: new Date(0) } as unknown as StoredMessage,
      shard('a0', 0), shard('a1', 1), shard('a2', 2),
      shard('b0', 0), shard('b1', 1), shard('b2', 2),
      { id: 'r', sequence: 0, participant: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'ok' }], timestamp: new Date(0) } as unknown as StoredMessage,
    ];
    const view = {
      isCompressionHeld: (id: string) => id === 'r',
      hasCompressionHolds: () => true,
      getAll: () => messages,
      length: () => messages.length,
    };
    const strategy = new Exposed({ adaptiveResolution: true });
    assert.equal(strategy.boundary(view), 4, 'the second copy\'s first shard');
  });

  it('count one copy as the document a chunk of it is part of', async () => {
    const { cm, strategy, second } = await twoCopies();
    const ctx = { messageStore: (cm as unknown as { messageStore: unknown }).messageStore };
    const estimate = (m: StoredMessage) => (ctx.messageStore as { estimateTokens(m: StoredMessage): number }).estimateTokens(m);
    const copyTokens = second.reduce((n, m) => n + estimate(m), 0);
    const doc = strategy.docContext({ messages: second.slice(0, 1) } as unknown as Chunk, ctx);
    assert.equal(doc?.totalTokens, copyTokens, 'one copy, not both');
    // A chunk spanning the two copies is not part of one document.
    const across = [cm.getAllMessages()[second.length], second[0]!] as StoredMessage[];
    assert.equal(strategy.docContext({ messages: across } as unknown as Chunk, ctx), null);
    cm.close();
  });
});

/**
 * Reading mode in a merge: when every leaf of a merge is a shard of one body,
 * the merge asks what reading that stretch was like and gives the document's
 * size as that body's tokens. Another ingestion of the same text shares the
 * group id but is not part of the document.
 */
class MergeProbe extends AutobiographicalStrategy {
  /** The document sizes given to reading-mode merge instructions. */
  reading: number[] = [];
  /** Plain merge instructions built. */
  plain = 0;
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }
  merge(level: 2, sourceIds: string[], ctx: StrategyContext): Promise<void> {
    return this.executeMerge(level, sourceIds, ctx);
  }
  protected override getReadingMergeInstruction(...args: Parameters<AutobiographicalStrategy['getReadingMergeInstruction']>): string {
    this.reading.push(args[2]);
    return super.getReadingMergeInstruction(...args);
  }
  protected override getMergeInstruction(...args: Parameters<AutobiographicalStrategy['getMergeInstruction']>): string {
    this.plain++;
    return super.getMergeInstruction(...args);
  }
}

describe('reading mode in a merge over two copies of one document', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  /** Two copies, two L1s over the stretches `pick` chooses, and the real executeMerge over them. */
  async function mergeOver(pick: (first: StoredMessage[], second: StoredMessage[]) => [StoredMessage[], StoredMessage[]]) {
    const strategy = new MergeProbe({
      adaptiveResolution: true,
      targetChunkTokens: 60,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      compressionModel: 'test-model',
      hierarchical: true,
      autoTickOnNewMessage: false,
      mergeThreshold: 99,
    });
    const membrane = {
      complete: async () => ({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'What reading it was like.' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };
    const cm = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
    cm.addMessage('user', text('before'));
    cm.addMessage('user', text(DOCUMENT));
    cm.addMessage('user', text(DOCUMENT));
    const all = cm.getAllMessages();
    const perCopy = all.filter((m) => m.bodyGroupId).length / 2;
    const first = all.slice(1, 1 + perCopy);
    const second = all.slice(1 + perCopy, 1 + 2 * perCopy);
    const l1 = (id: string, messages: StoredMessage[]): SummaryEntry => ({
      id,
      level: 1,
      content: `authored ${id}`,
      tokens: 20,
      sourceLevel: 0,
      sourceIds: messages.map((m) => m.id),
      sourceRange: { first: messages[0]!.id, last: messages.at(-1)!.id },
      created: 1,
    });
    const [a, b] = pick(first, second);
    strategy.seed(l1('L1-a', a));
    strategy.seed(l1('L1-b', b));
    await strategy.merge(2, ['L1-a', 'L1-b'], (cm as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext());
    return { cm, strategy, second };
  }

  it('reads a merge over one copy as that copy alone', async () => {
    const half = (copy: StoredMessage[]) => Math.floor(copy.length / 2);
    const { cm, strategy, second } = await mergeOver((_first, second) => [second.slice(0, half(second)), second.slice(half(second))]);
    const store = (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore;
    const copyTokens = second.reduce((n, m) => n + store.estimateTokens(m), 0);
    assert.deepEqual(strategy.reading, [copyTokens], 'the document is one copy, not both');
    assert.equal(strategy.plain, 0);
    cm.close();
  });

  it('gives a merge across both copies the plain merge instruction', async () => {
    const { cm, strategy } = await mergeOver((first, second) => [first.slice(-4), second.slice(0, 4)]);
    assert.deepEqual(strategy.reading, [], 'its leaves are not one document');
    assert.equal(strategy.plain, 1);
    cm.close();
  });
});
