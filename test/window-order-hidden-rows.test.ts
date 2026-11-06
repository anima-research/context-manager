/**
 * The autobiographical strategy's reads of the window's order, where a
 * record holds a row the view filter hides, and where a merge's sources
 * cross (CM #350 bot review, wave 4, finding 6).
 *
 * The check an L1 or a merge makes for a row another instance took out and
 * presented again (rowsMovedInWindow) named a row at any inversion of the
 * span's window order. A record that kept a returned row held its rows in
 * record order where one of them was hidden, so its chunk stood out of
 * window order with nothing moving: every L1 over it was discarded and its
 * record unfolded the same way again, a model call per tick and nothing
 * written. And under 'report' a merge's entry check named a row of a
 * crossed merge, which no row had left, and unfolded its summary before the
 * merge's topology check refused the group. Now a row is named only where
 * the window holds it past every later row of the span, where a
 * presentation puts a row presented again, and a record that keeps a
 * returned row holds its rows in window order, a hidden row at its own
 * ordinal.
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
});
