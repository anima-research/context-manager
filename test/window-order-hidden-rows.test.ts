/**
 * The autobiographical strategy's reads of the window's order, where a
 * record holds a row the view filter hides, where a merge's sources
 * cross (CM #350 bot review, wave 4, findings 6 and 24), and where a row no
 * chunk owns stands between an L1's leaves (wave 5, finding 14).
 *
 * The check an L1 or a merge makes for a row another instance took out and
 * presented again (rowsMovedInWindow) named a row at any inversion of the
 * span's window order. A record that kept a returned row held its rows in
 * record order where one of them was hidden, so its chunk stood out of
 * window order with nothing moving: every L1 over it was discarded and its
 * record unfolded the same way again, a model call per tick and nothing
 * written. And under 'report' a merge's entry check named a row of a
 * crossed merge, which no row had left, and unfolded its summary before the
 * merge's topology check refused the group. Now a row is named where its
 * ordinal differs from the one read as the work began, or, with or without
 * that reading, where the window holds it past every later row of the
 * span, where a presentation puts a row presented again (the snapshot
 * alone finds the span's last row moved, and, since wave 5's finding 54, a
 * row before one the window doesn't hold). A record that keeps a returned
 * row holds its rows in window order, a hidden row at its own ordinal.
 *
 * The open's demote trimmed a record to its longest run of rows the window
 * holds together and released the rest, a hidden row among them, which the
 * view never lists, so no chunk took it again. A hidden row now stays in
 * the record.
 *
 * The demote judged runs and order by the ownership index, which places
 * only owned rows: a row presented again after a row no chunk owns (in the
 * recent window, or kept raw by a pin) stood next to the rest of its L1
 * there, and the L1 was kept. The runs are now parted at such a row where
 * the window holds it between two owned rows and the record doesn't; an
 * L1 minted across it, which both hold between its leaves, stays.
 *
 * The demote's order check read L1s and records only, so a summary above
 * L1 whose L1s a stop left out of order, each L1 in order and the leaves
 * together, was kept (wave 6, finding 2). It is now dropped alone, and its
 * L1s and their records stay.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import type { MessageId, StrategyContext, SummaryEntry } from '../src/index.js';

const BASE = './test-window-order-hidden-rows';
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
const TAGS = 24;

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

/** Summarizer mock: each answer names the tags its request carried; `calls` counts them. */
function mockMembrane() {
  const mock = {
    calls: 0,
    membrane: {
      complete: async (request: { messages: Array<{ content: ContentBlock[] }> }) => {
        mock.calls++;
        const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
        const tags = [...new Set(input.match(/TAG\d+/g) ?? [])].join(',');
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `[summary ${mock.calls} of ${tags}] ` + 'mem '.repeat(20) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    } as never,
  };
  return mock;
}

const FOLDING = {
  compressionModel: 'mock',
  targetChunkTokens: 200,
  recentWindowTokens: 300,
  headWindowTokens: 0,
  mergeThreshold: 4,
} as const;

interface Internals {
  summaries: SummaryEntry[];
  chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
}
const internals = (strategy: AutobiographicalStrategy) => strategy as unknown as Internals;

async function drain(cm: ContextManager, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'the drain finished');
}

/**
 * A presented manager holding TAG0..TAG23, each presented as it was
 * stored, behind a view filter that hides the ids in `hidden`, its queue
 * drained; then the rows after a compressed record of three rows or more
 * are taken out (the strategy hears them go), so that record's rows end
 * the window.
 */
async function foldedRecordAtTheEnd(config: Record<string, unknown> = {}) {
  const hidden = new Set<MessageId>();
  const mock = mockMembrane();
  const strategy = new AutobiographicalStrategy({ ...FOLDING, ...config });
  const cm = await ContextManager.open({
    path: freshPath(),
    namespace: 'agent',
    strategy,
    membrane: mock.membrane,
    viewFilter: (m) => !hidden.has(m.id),
  });
  cm.presentRows([]);
  const ids: MessageId[] = [];
  for (let i = 0; i < TAGS; i++) {
    const id = cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
    cm.presentRows([id]);
    ids.push(id);
  }
  await linesDuring(async () => drain(cm));
  const record = internals(strategy).chunkRecords.find((r) => r.compressed && r.sourceIds.length >= 3);
  assert.ok(record, `premise: a compressed record over three rows or more: ${JSON.stringify(internals(strategy).chunkRecords)}`);
  const rows = [...record.sourceIds];
  const after = ids.slice(ids.indexOf(rows[rows.length - 1]!) + 1);
  await linesDuring(async () => { cm.retractRows(after, { undone: true }); });
  assert.deepEqual(cm.getPresentedMessages().slice(-rows.length).map((m) => m.id), rows, "premise: the record's rows end the window");
  return { cm, mock, hidden, record, rows };
}

/**
 * Take `back` out and present it again while a new strategy initializes, so
 * that strategy reads it at its new place, after the record's last row,
 * before it hears it go.
 */
async function backWhileInitializing(cm: ContextManager, next: AutobiographicalStrategy, back: MessageId): Promise<string[]> {
  return linesDuring(async () => {
    const initialized = cm.setStrategy(next);
    cm.retractRows([back], { undone: true });
    cm.presentRows([back]);
    await initialized;
  });
}

/** More rows, so the recent window no longer holds the record back from folding. */
function presentMore(cm: ContextManager, count = 8): void {
  for (let i = TAGS; i < TAGS + count; i++) {
    cm.presentRows([cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))])]);
  }
}

/**
 * Under 'report', where the open doesn't demote: a strategy hears the
 * record's first row go with that row back in the window, after the
 * record's last row, while the view filter hides the record's second.
 */
async function returnedBesideHidden() {
  const { cm, mock, hidden, record, rows } = await foldedRecordAtTheEnd({ topologyPolicy: 'report' });
  const [back, h] = rows as [MessageId, MessageId, ...MessageId[]];
  hidden.add(h);
  const next = new AutobiographicalStrategy({ ...FOLDING, topologyPolicy: 'report' });
  await backWhileInitializing(cm, next, back);
  const kept = internals(next).chunkRecords.find((r) => r.id === record.id);
  assert.ok(kept && kept.sourceIds.includes(back) && kept.sourceIds.includes(h), `premise: the record keeps both rows: ${JSON.stringify(kept)}`);
  // The rows of the record the view lists, in window order.
  const shown = [...rows.filter((id) => id !== back && id !== h), back];
  assert.deepEqual(cm.getPresentedMessages().map((m) => m.id).slice(-shown.length), shown, 'premise: the view holds the row after the rest');
  presentMore(cm);
  return { cm, mock, next, record, rows, back, h, shown };
}

describe('a record that holds a row the view filter hides', () => {
  // The regression (5cc8027): the L1's check named the returned row at the
  // record's inversion, though no row moved, and the let-go kept the record
  // as it was, so each tick made a call and wrote nothing.
  it('and keeps a returned row: the L1 over it is written, with no discard and no call per tick', async () => {
    const { cm, mock, next, back } = await returnedBesideHidden();
    const callsBefore = mock.calls;
    const lines = await linesDuring(async () => {
      for (let i = 0; i < 60 && !cm.isReady(); i++) await cm.tick();
    });
    assert.deepEqual(lines.filter((line) => line.includes('discarding L1')), [], 'no L1 is discarded');
    assert.ok(cm.isReady(), 'the drain finished');
    assert.ok(mock.calls - callsBefore < 10, `a call per chunk, not one per tick: ${mock.calls - callsBefore}`);
    assert.equal(internals(next).summaries.filter((s) => s.level === 1 && s.sourceIds.includes(back)).length, 1, 'one L1 covers the row');
    cm.close();
  });

  it('and keeps a returned row: the record holds its rows in window order, the hidden one at its own ordinal, and so does the L1 over it', async () => {
    const { cm, next, record, rows, back, shown } = await returnedBesideHidden();
    assert.deepEqual(
      internals(next).chunkRecords.find((r) => r.id === record.id)?.sourceIds,
      [...rows.filter((id) => id !== back), back],
      'the record holds its rows in window order',
    );
    await linesDuring(async () => drain(cm, 60));
    const l1 = internals(next).summaries.find((s) => s.level === 1 && s.sourceIds.includes(back));
    assert.ok(l1, 'the record was folded again');
    assert.deepEqual(l1.sourceIds, shown, 'over the rows the view lists, in window order');
    cm.close();
  });

  it("the open's demote keeps the hidden row in the record it trims", async () => {
    const { cm, hidden, record, rows } = await foldedRecordAtTheEnd();
    const [back, h] = rows as [MessageId, MessageId, ...MessageId[]];
    hidden.add(h);
    // Under 'reject' the open finds the L1 over the record out of window
    // order and demotes it before the strategy hears the row go.
    const next = new AutobiographicalStrategy(FOLDING);
    const lines = await backWhileInitializing(cm, next, back);
    assert.ok(lines.some((line) => line.includes('the window holds the leaves of')), `premise: the open demoted the L1: ${lines.join('\n')}`);
    const kept = internals(next).chunkRecords.find((r) => r.id === record.id);
    assert.ok(kept, `the record stays: ${JSON.stringify(internals(next).chunkRecords)}`);
    assert.ok(kept.sourceIds.includes(h), `the hidden row keeps its chunk ownership: ${JSON.stringify(kept)}`);
    assert.ok(internals(next).chunkRecords.filter((r) => r.sourceIds.includes(h)).length === 1, 'in one record');
    assert.deepEqual(kept.sourceIds, [...rows.filter((id) => id !== back), back], 'in window order');
    cm.close();
  });
});

/**
 * A store holding the rows `stored` (TAG names, stored in that order) in a
 * presented window, with `back` taken out and presented again, and an L1
 * over `over` whose chunk record is compressed: seeded through a
 * PassthroughStrategy, so no strategy heard the row go.
 */
async function seededL1(stored: string[], back: string | undefined, over: string[]) {
  const path = freshPath();
  const seed = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
  seed.presentRows([]);
  const id = new Map<string, MessageId>();
  for (const tag of stored) {
    const row = seed.addMessage('User', [text(`${tag} ` + 'word '.repeat(60))]);
    seed.presentRows([row]);
    id.set(tag, row);
  }
  if (back) {
    seed.retractRows([id.get(back)!], { undone: true });
    seed.presentRows([id.get(back)!]);
  }
  const sourceIds = over.map((tag) => id.get(tag)!);
  const l1 = {
    id: 'L1-zz', level: 1, content: 's', tokens: 50, sourceLevel: 0, sourceIds,
    sourceRange: { first: sourceIds[0]!, last: sourceIds.at(-1)! }, created: 1,
  } as SummaryEntry;
  const store = seed.getStore();
  store.registerState({ id: 'agent/autobio:summaries', strategy: 'snapshot' });
  store.registerState({ id: 'agent/autobio:chunks', strategy: 'snapshot' });
  store.setStateJson('agent/autobio:summaries', [l1]);
  store.setStateJson('agent/autobio:chunks', [{ id: 'c-zz', sourceIds, compressed: true, summaryId: l1.id }]);
  const window = seed.getPresentedMessages().map((m) => m.id);
  seed.close();
  return { path, id, window };
}

describe("the open's demote, where a row no chunk owns stands between an L1's leaves", () => {
  // Wave 5, finding 14: the demote judged order by the ownership index,
  // which places only owned rows, so a row no chunk owns (recent, or kept
  // raw by a pin) that a leaf was presented again after stood nowhere, and
  // the L1 read as whole and in order.
  it('demotes the L1 where a leaf was presented again after that row, which stood after it in the record', async () => {
    const { path, id, window } = await seededL1(['TAG0', 'TAG1', 'TAG2'], 'TAG1', ['TAG0', 'TAG1']);
    const [a, b, c] = ['TAG0', 'TAG1', 'TAG2'].map((tag) => id.get(tag)!);
    assert.deepEqual(window, [a, c, b], 'premise: the window holds the unowned row between the leaves');
    const strategy = new AutobiographicalStrategy(FOLDING);
    let cm!: ContextManager;
    const lines = await linesDuring(async () => {
      cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane().membrane });
    });
    assert.ok(lines.some((line) => line.includes('the window holds the leaves of 1 summary apart or out of order [L1-zz]')), lines.join('\n'));
    assert.ok(!internals(strategy).summaries.some((s) => s.id === 'L1-zz'), 'the L1 is dropped');
    const record = internals(strategy).chunkRecords.find((r) => r.id === 'c-zz');
    assert.deepEqual(record?.sourceIds, [a], `its record keeps its longest run, and the leaf presented again is released: ${JSON.stringify(record)}`);
    cm.close();
  });

  it('keeps an L1 minted across that row, which the window and the record both hold between its leaves', async () => {
    const { path, id, window } = await seededL1(['TAG0', 'TAG1', 'TAG2'], undefined, ['TAG0', 'TAG2']);
    const [a, b, c] = ['TAG0', 'TAG1', 'TAG2'].map((tag) => id.get(tag)!);
    assert.deepEqual(window, [a, b, c], 'premise: the window holds the rows as the record does');
    const strategy = new AutobiographicalStrategy(FOLDING);
    let cm!: ContextManager;
    const lines = await linesDuring(async () => {
      cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane().membrane });
    });
    assert.ok(!lines.some((line) => line.includes('the window holds the')), lines.join('\n'));
    assert.ok(internals(strategy).summaries.some((s) => s.id === 'L1-zz'), 'the L1 stays');
    assert.deepEqual(internals(strategy).chunkRecords.find((r) => r.id === 'c-zz')?.sourceIds, [a, c], 'and its record');
    cm.close();
  });
});

describe("the open's demote, where a summary above L1 holds its L1s out of order", () => {
  // Wave 6, finding 2: the reorder check read L1s and records only, and the
  // audit asks only for holes, so an L2 over two one-row L1s whose rows a
  // stop left out of order (the first L1's row presented again after the
  // second's, before any strategy heard it go) was kept, and rendered the
  // first row's text before the second's over a window that holds the
  // second first.
  it('drops that summary alone, and keeps the L1s and their records', async () => {
    const path = freshPath();
    const seed = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
    seed.presentRows([]);
    const [a, b] = ['TAG0', 'TAG1'].map((tag) => {
      const row = seed.addMessage('User', [text(`${tag} ` + 'word '.repeat(60))]);
      seed.presentRows([row]);
      return row;
    }) as [MessageId, MessageId];
    seed.retractRows([a], { undone: true });
    seed.presentRows([a]);
    assert.deepEqual(seed.getPresentedMessages().map((m) => m.id), [b, a], 'premise: the window holds B, then A');
    const l1 = (id: string, row: MessageId): SummaryEntry => ({
      id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds: [row],
      sourceRange: { first: row, last: row }, created: 1, mergedInto: 'L2-zz',
    } as SummaryEntry);
    const l2 = {
      id: 'L2-zz', level: 2, content: 's L2-zz', tokens: 50, sourceLevel: 1, sourceIds: ['L1-a', 'L1-b'],
      sourceRange: { first: a, last: b }, created: 2,
    } as SummaryEntry;
    const store = seed.getStore();
    store.registerState({ id: 'agent/autobio:summaries', strategy: 'snapshot' });
    store.registerState({ id: 'agent/autobio:chunks', strategy: 'snapshot' });
    store.setStateJson('agent/autobio:summaries', [l1('L1-a', a), l1('L1-b', b), l2]);
    store.setStateJson('agent/autobio:chunks', [
      { id: 'c-a', sourceIds: [a], compressed: true, summaryId: 'L1-a' },
      { id: 'c-b', sourceIds: [b], compressed: true, summaryId: 'L1-b' },
    ]);
    seed.close();

    const strategy = new AutobiographicalStrategy(FOLDING);
    let cm!: ContextManager;
    const lines = await linesDuring(async () => {
      cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane().membrane });
    });
    assert.ok(lines.some((line) => line.includes('the window holds the leaves of 1 summary apart or out of order [L2-zz]')), lines.join('\n'));
    assert.deepEqual(internals(strategy).summaries.map((s) => s.id).sort(), ['L1-a', 'L1-b'], 'the L2 is dropped, and the L1s stay');
    assert.ok(internals(strategy).summaries.every((s) => (s as { mergedInto?: string }).mergedInto === undefined), 'with no parent');
    assert.deepEqual(
      internals(strategy).chunkRecords.map((r) => [r.id, r.sourceIds, r.compressed, r.summaryId]).sort(),
      [['c-a', [a], true, 'L1-a'], ['c-b', [b], true, 'L1-b']],
      'their records stay as they were',
    );
    const kept = cm.getStore().getStateJson('agent/autobio:summaries') as Array<{ id: string }>;
    assert.deepEqual(kept.map((s) => s.id).sort(), ['L1-a', 'L1-b'], 'as the store holds them');
    cm.close();
  });

  // The verifier's plant at 4233830 (post-#350 follow-up): a summary above
  // L1 whose leaves are out of order because a summary under it is (goesWith)
  // goes with that one (unfold drops what is above), and isn't named
  // separately, so the warning counts the lowest causes.
  it('names only the lowest such summary: one above it, whose leaves are out of order through it, goes with it unnamed', async () => {
    const path = freshPath();
    const seed = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
    seed.presentRows([]);
    const [a, b, c, d] = ['TAG0', 'TAG1', 'TAG2', 'TAG3'].map((tag) => {
      const row = seed.addMessage('User', [text(`${tag} ` + 'word '.repeat(60))]);
      seed.presentRows([row]);
      return row;
    }) as [MessageId, MessageId, MessageId, MessageId];
    seed.retractRows([a], { undone: true });
    seed.presentRows([a]);
    seed.retractRows([c, d], { undone: true });
    seed.presentRows([c, d]);
    assert.deepEqual(seed.getPresentedMessages().map((m) => m.id), [b, a, c, d], 'premise: the window holds B, A, C, D');
    const summary = (id: string, level: number, sourceIds: string[], first: MessageId, last: MessageId, mergedInto?: string): SummaryEntry => ({
      id, level, content: `s ${id}`, tokens: 50, sourceLevel: level - 1, sourceIds,
      sourceRange: { first, last }, created: level, ...(mergedInto ? { mergedInto } : {}),
    } as SummaryEntry);
    // L2-zz holds its L1s out of order; L2-yy holds its in order; the L3 over
    // both reads its leaves A, B, C, D, out of order only through L2-zz.
    const store = seed.getStore();
    store.registerState({ id: 'agent/autobio:summaries', strategy: 'snapshot' });
    store.registerState({ id: 'agent/autobio:chunks', strategy: 'snapshot' });
    store.setStateJson('agent/autobio:summaries', [
      summary('L1-a', 1, [a], a, a, 'L2-zz'),
      summary('L1-b', 1, [b], b, b, 'L2-zz'),
      summary('L1-c', 1, [c], c, c, 'L2-yy'),
      summary('L1-d', 1, [d], d, d, 'L2-yy'),
      summary('L2-zz', 2, ['L1-a', 'L1-b'], a, b, 'L3-zz'),
      summary('L2-yy', 2, ['L1-c', 'L1-d'], c, d, 'L3-zz'),
      summary('L3-zz', 3, ['L2-zz', 'L2-yy'], a, d),
    ]);
    store.setStateJson('agent/autobio:chunks', [a, b, c, d].map((row, i) => (
      { id: `c-${i}`, sourceIds: [row], compressed: true, summaryId: `L1-${'abcd'[i]}` }
    )));
    seed.close();

    const strategy = new AutobiographicalStrategy(FOLDING);
    let cm!: ContextManager;
    const lines = await linesDuring(async () => {
      cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane().membrane });
    });
    assert.ok(lines.some((line) => line.includes('the window holds the leaves of 1 summary apart or out of order [L2-zz]')), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('dropped [') && line.includes('L3-zz')), `the L3 goes with it: ${lines.join('\n')}`);
    assert.deepEqual(internals(strategy).summaries.map((s) => s.id).sort(), ['L1-a', 'L1-b', 'L1-c', 'L1-d', 'L2-yy'], 'L2-zz and the L3 are dropped, and the rest stay');
    cm.close();
  });
});

describe("a merge's entry check over sources that cross", () => {
  it("under 'report' leaves the crossed sources to the merge's topology check, which refuses the group, and unfolds nothing", async () => {
    const path = freshPath();
    const seed = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
    seed.presentRows([]);
    const rows: MessageId[] = [];
    for (let i = 0; i < 4; i++) {
      const id = seed.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
      seed.presentRows([id]);
      rows.push(id);
    }
    const [a, b, c, d] = rows as [MessageId, MessageId, MessageId, MessageId];
    const summary = (id: string, sourceIds: MessageId[]): SummaryEntry => ({
      id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0]!, last: sourceIds.at(-1)! }, created: 1,
    } as SummaryEntry);
    // Two L1s whose rows the window holds interleaved: A, B, C, D.
    const l1s = [summary('L1-ac', [a, c]), summary('L1-bd', [b, d])];
    const store = seed.getStore();
    store.registerState({ id: 'agent/autobio:summaries', strategy: 'snapshot' });
    store.registerState({ id: 'agent/autobio:chunks', strategy: 'snapshot' });
    store.setStateJson('agent/autobio:summaries', l1s);
    store.setStateJson('agent/autobio:chunks', l1s.map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id })));
    seed.close();

    const mock = mockMembrane();
    const strategy = new AutobiographicalStrategy({ ...FOLDING, topologyPolicy: 'report' });
    let cm!: ContextManager;
    await linesDuring(async () => {
      cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mock.membrane });
    });
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), rows, 'premise: the window holds the rows in order');
    assert.equal(strategy.getTopologyViolations().length, 2, "premise: 'report' recorded both L1s");

    // As a queue an older grammar persisted, or an operator, would ask.
    const ctx = (cm as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const merging = strategy as unknown as { executeMerge(level: number, sourceIds: string[], c: StrategyContext): Promise<boolean> };
    let merged!: boolean;
    const lines = await linesDuring(async () => {
      merged = await merging.executeMerge(2, ['L1-ac', 'L1-bd'], ctx);
    });
    assert.equal(merged, false, 'nothing is merged');
    assert.equal(mock.calls, 0, 'no call is made');
    assert.ok(!lines.some((line) => line.includes('presented again elsewhere')), `no row reads as moved: ${lines.join('\n')}`);
    assert.ok(lines.some((line) => line.includes('[merge-topology]') && line.includes('refused L2 merge')), `the topology check refuses the group: ${lines.join('\n')}`);
    const kept = cm.getStore().getStateJson('agent/autobio:summaries') as Array<{ id: string }>;
    assert.deepEqual(kept.map((s) => s.id).sort(), ['L1-ac', 'L1-bd'], "the store's summaries are as found");
    assert.deepEqual(internals(strategy).summaries.map((s) => s.id).sort(), ['L1-ac', 'L1-bd'], "and the strategy's");
    cm.close();
  });
  // Wave 5, finding 54: the check skipped a leaf with no ordinal, so where
  // a leaf of one source was removed before the window was written down,
  // the crossed pair read as a row past every later row, and the entry
  // check let go of it.
  it("under 'report' leaves crossed sources to the topology check where a leaf of one was removed before the window was written down", async () => {
    const path = freshPath();
    const seed = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
    const rows: MessageId[] = [];
    for (let i = 0; i < 4; i++) rows.push(seed.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]));
    const [a, b, c, d] = rows as [MessageId, MessageId, MessageId, MessageId];
    seed.removeMessage(d);
    seed.presentRows([]);
    const summary = (id: string, sourceIds: MessageId[]): SummaryEntry => ({
      id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0]!, last: sourceIds.at(-1)! }, created: 1,
    } as SummaryEntry);
    // Crossed in the record: A, C under one, B, D under the other.
    const l1s = [summary('L1-ac', [a, c]), summary('L1-bd', [b, d])];
    const store = seed.getStore();
    store.registerState({ id: 'agent/autobio:summaries', strategy: 'snapshot' });
    store.registerState({ id: 'agent/autobio:chunks', strategy: 'snapshot' });
    store.setStateJson('agent/autobio:summaries', l1s);
    store.setStateJson('agent/autobio:chunks', l1s.map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id })));
    seed.close();

    const mock = mockMembrane();
    const strategy = new AutobiographicalStrategy({ ...FOLDING, topologyPolicy: 'report' });
    let cm!: ContextManager;
    await linesDuring(async () => {
      cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mock.membrane });
    });
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [a, b, c], 'premise: the window holds A, B, C, and never held D');
    assert.equal(cm.ordinalOf(d), undefined, 'premise: D has no ordinal');

    const ctx = (cm as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const merging = strategy as unknown as { executeMerge(level: number, sourceIds: string[], c: StrategyContext): Promise<boolean> };
    let merged!: boolean;
    const lines = await linesDuring(async () => {
      merged = await merging.executeMerge(2, ['L1-ac', 'L1-bd'], ctx);
    });
    assert.ok(!lines.some((line) => line.includes('presented again elsewhere')), `no row reads as moved: ${lines.join('\n')}`);
    assert.equal(merged, false, 'nothing is merged');
    assert.equal(mock.calls, 0, 'no call is made');
    assert.ok(lines.some((line) => line.includes('[merge-topology]') && line.includes('refused L2 merge')), `the topology check refuses the group: ${lines.join('\n')}`);
    assert.deepEqual(internals(strategy).summaries.map((s) => s.id).sort(), ['L1-ac', 'L1-bd'], "the strategy's summaries are as found");
    cm.close();
  });
});
