/**
 * A compression or merge in flight writes nothing when another instance
 * sharing the store lets go of what it covers (CM #350 bot review,
 * finding 4).
 *
 * A retraction through one manager reaches its own strategy (onRetracted),
 * which drops the summaries over the row and gives the row up from its
 * chunk record, in the store. Another strategy instance on the same store
 * doesn't hear it, so its own mirrors still hold what was dropped. Before
 * this fix, a merge it had in flight over a dropped L1 wrote its parent
 * over it, logging only that the source wasn't in the persisted log, and an
 * L1 it had in flight over the record wrote a summary over the row the
 * window no longer holds. Each now reads the store before it writes: a
 * merge source the stored summaries lack, or an L1's chunk record changed
 * in the store since the compression began, writes nothing, and the
 * instance takes up the store's state.
 *
 * Wave 2 (findings 5, 7 and 39): those reads judged by the store's chunk
 * records and summaries alone. A KnowledgeStrategy keeps no chunk records,
 * and the other instance writes its own after the window's tombstone, so a
 * write of theirs that failed left them unchanged: either way the L1, or
 * the merge, was written over the row. An exhaustion asked only its own
 * instance's mark, and quarantined the obsolete span. Each now also asks
 * the window, which the other instance's tombstone changed: a row of the
 * span out of it writes nothing, and the instance lets go of it, as its
 * onRetracted would have.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, KnowledgeStrategy, PassthroughStrategy } from '../src/index.js';
import type { MessageId, SummaryEntry } from '../src/index.js';

const BASE = './test-retraction-across-instances';
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

const SUMMARIES = 'default/autobio:summaries';
const CHUNKS = 'default/autobio:chunks';
const QUEUE = 'default/autobio:mergeQueue';

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

/**
 * A membrane that holds each call until the test releases it (or fails it),
 * noting whether it asks for a merge and whether its request carries
 * reasoning blocks. With `thinking`, each answer leads with a signed
 * thinking block, which the L1 keeps (responseContent) and a merge's
 * request carries.
 */
function heldMembrane(options: { thinking?: boolean } = {}) {
  const calls: Array<{ merge: boolean; carriesReasoning: boolean; release: () => void; fail: (error: Error) => void }> = [];
  const membrane = {
    complete: (request: { messages: Array<{ content: Array<{ type?: string; text?: string }> }> }) => new Promise((resolve, reject) => {
      const n = calls.length + 1;
      const blocks = request.messages.flatMap((m) => m.content);
      const input = blocks.map((b) => b.text ?? '').join('\n');
      const text = { type: 'text', text: `Summary #${n}` };
      calls.push({
        merge: input.includes('consolidate into a single L'),
        carriesReasoning: blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
        release: () => resolve({
          stopReason: 'end_turn',
          content: options.thinking ? [{ type: 'thinking', thinking: `zz thought ${n}`, signature: `zz-sig-${n}` }, text] : [text],
        }),
        fail: reject,
      });
    }),
  } as never;
  return { calls, membrane };
}

/**
 * Await `work`, releasing every call the membrane holds as it comes, until
 * `work` settles (CM #350 bot review, wave 3, finding 33): a call that
 * reaches the membrane late is released too, where a release after a fixed
 * delay left it held and the test waiting for good. It gives up after
 * `ms` (wave 4, finding 35), throwing 'timed out' with the count of calls
 * it released, so work pending for another reason fails the test instead
 * of hanging the file.
 */
async function releasingUntil<T>(calls: ReadonlyArray<{ release: () => void }>, work: Promise<T>, ms = 10_000): Promise<T> {
  let settled = false;
  const done = work.finally(() => { settled = true; });
  done.catch(() => {}); // the caller hears a rejection through the return
  const start = Date.now();
  while (!settled) {
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms, with ${calls.length} membrane call(s) released and the work still pending`);
    for (const call of calls) call.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return done;
}

/**
 * `work`, or a 'timed out' rejection after `ms` (wave 6, finding 33). A raw
 * await of a tick or a merge whose model call a regression left held (a
 * retry after a failure, a second call after an answer) would wait for
 * good, and the test's finally, which releases the held calls and closes
 * the managers, would never run: node:test sets no timeout of its own.
 */
async function deadline<T>(work: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms, the work still pending`)), ms);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const strategyFor = (extra: Record<string, unknown> = {}) => new AutobiographicalStrategy({
  compressionModel: 'm',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false,
  minChunkCharsForLLM: 0,
  l1HoldbackChunks: 0,
  mergeThreshold: 2,
  maxSpeculativeL1s: 1,
  ...extra,
});

/** A KnowledgeStrategy, which keeps no chunk records, set as strategyFor is. */
const knowledgeFor = () => new KnowledgeStrategy({
  compressionModel: 'm',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false,
  minChunkCharsForLLM: 0,
  mergeThreshold: 2,
  maxSpeculativeL1s: 1,
});

interface Internals {
  summaries: SummaryEntry[];
  chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
  pendingCompressionWork: { chunk: { messages: Array<{ id: MessageId }>; recordId?: string } } | { sourceIds: readonly string[] } | null;
  chunks: Array<{ messages: Array<{ id: MessageId }>; recordId?: string; compressed?: boolean; summaryId?: string }>;
  compressionQueue: number[];
  pushSummary(entry: SummaryEntry): void;
}
const internals = (strategy: AutobiographicalStrategy) => strategy as unknown as Internals;

/** A membrane that holds its first call until the test releases it, then answers every call with empty text. */
function emptyMembrane() {
  let calls = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const membrane = {
    complete: async () => {
      calls++;
      await released;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: '' }], usage: { input_tokens: 10, output_tokens: 1 } };
    },
  } as never;
  return { calls: () => calls, release, membrane };
}

/**
 * Run `fn` with the store refusing every write of `ids` (setStateJson), as a
 * write that fails after the window's tombstone landed does.
 */
function refusingWrites<T>(store: JsStore, ids: readonly string[], fn: () => T): T {
  const real = store.setStateJson.bind(store);
  (store as unknown as { setStateJson: typeof real }).setStateJson = (id: string, value: unknown) => {
    if (ids.includes(id)) throw new Error(`zz the store refused the write of ${id}`);
    return real(id, value);
  };
  try {
    return fn();
  } finally {
    (store as unknown as { setStateJson: typeof real }).setStateJson = real;
  }
}

/** Instance A on a fresh store, its window holding 24 presented rows. */
async function instanceA(make: () => AutobiographicalStrategy = strategyFor, held = heldMembrane()) {
  const path = freshPath();
  const store = JsStore.openOrCreate({ path });
  const strategy = make();
  const cm = await ContextManager.open({ store, strategy, membrane: held.membrane });
  cm.presentRows([]);
  for (let i = 0; i < 24; i++) {
    cm.presentRows([cm.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${'word '.repeat(30)}` }])]);
  }
  await cm.compile();
  return { store, strategy, cm, ...held };
}

/**
 * The states among `ids` the store reads (getStateJson) while `fn` runs,
 * one entry a read, in order.
 */
function readsDuring(store: JsStore, ids: readonly string[], fn: () => void): string[] {
  const reads: string[] = [];
  const real = store.getStateJson.bind(store);
  (store as unknown as { getStateJson: typeof real }).getStateJson = (id: string) => {
    if (ids.includes(id)) reads.push(id);
    return real(id);
  };
  try {
    fn();
  } finally {
    (store as unknown as { getStateJson: typeof real }).getStateJson = real;
  }
  return reads;
}

/** The list a state of the store holds (none written yet is an empty one). */
const stored = (store: JsStore, id: string) =>
  ((store.getStateJson(id) as Array<{ id: string; level?: number; sourceIds: string[]; compressed?: boolean; summaryId?: string }> | null) ?? []);

describe('a retraction through another instance sharing the store', () => {
  it('a merge in flight over an L1 the other instance dropped writes nothing, and takes up the store', async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const merging = a.tick();
      await waitFor(() => calls.length === 3);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'sourceIds' in work && calls[2]!.merge, 'premise: a merge is in flight');
      const source = work.sourceIds[0]!;
      const row = internals(A).summaries.find((s) => s.id === source)!.sourceIds[0]!;
      const sourceRecord = internals(A).chunkRecords.find((r) => r.summaryId === source)!.id;

      const B = strategyFor();
      b = await ContextManager.open({ store, strategy: B, membrane });
      const lines = await linesDuring(async () => {
        b!.retractRows([row], { undone: true });
        assert.ok(!stored(store, SUMMARIES).some((s) => s.id === source), 'premise: the other instance dropped the source in the store');
        calls[2]!.release();
        await deadline(merging);
      });
      assert.ok(lines.some((line) => /source\(s\) dropped while the L2 merge's call was out/.test(line)), lines.join('\n'));
      assert.ok(!lines.some((line) => line.includes('setMergedInto')), lines.join('\n'));
      const after = stored(store, SUMMARIES);
      assert.ok(after.every((s) => !s.sourceIds.includes(source)), `no summary was written over ${source}: ${JSON.stringify(after.map((s) => s.id))}`);
      assert.ok(!internals(A).summaries.some((s) => s.id === source), 'the instance took up the store: it no longer holds the dropped source');
      // The verifier's plant E5: the take-up rebuilds the chunks from the
      // records it took up, so no chunk is still marked with the dropped
      // source, and the record the other instance refolded is queued again
      // over the rows it keeps, before any select rebuilds them.
      const refolded = stored(store, CHUNKS).find((r) => r.id === sourceRecord && !r.compressed && !r.sourceIds.includes(row));
      assert.ok(!internals(A).chunks.some((chunk) => chunk.summaryId === source), `no chunk is marked with the dropped source: ${JSON.stringify(internals(A).chunks.map((c) => [c.recordId, c.compressed, c.summaryId]))}`);
      assert.ok(!internals(A).chunks.some((chunk) => chunk.messages.some((m) => m.id === row)), 'nor holds the row');
      assert.ok(refolded, 'premise: the other instance refolded the record of the dropped source');
      const chunk = internals(A).chunks.find((c) => c.recordId === refolded.id);
      assert.ok(chunk && !chunk.compressed && internals(A).compressionQueue.includes(internals(A).chunks.indexOf(chunk)), `the refolded record is queued again: ${JSON.stringify(chunk)}`);
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it('a merge whose source the other instance dropped before it began makes no call', async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      const B = strategyFor();
      b = await ContextManager.open({ store, strategy: B, membrane });
      await linesDuring(async () => { b!.retractRows([l1.sourceIds[0]!], { undone: true }); });
      assert.ok(internals(A).summaries.some((s) => s.id === l1.id), 'premise: the instance still holds the dropped L1');
      const before = calls.length;
      const lines = await linesDuring(async () => {
        await releasingUntil(calls, a.tick());
      });
      assert.ok(!calls.slice(before).some((call) => call.merge), `no merge call was made: ${lines.join('\n')}`);
      assert.ok(lines.some((line) => line.includes('missing from the store (dropped by another instance sharing it')), lines.join('\n'));
      assert.ok(
        stored(store, SUMMARIES).every((s) => !s.sourceIds.includes(l1.id)),
        `no summary was written over ${l1.id}: ${lines.join('\n')}`,
      );
      assert.ok(!internals(A).summaries.some((s) => s.id === l1.id), 'the instance took up the store');
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it("an L1 in flight over a chunk record the other instance changed writes nothing, and takes up the store's records", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const span = work.chunk.messages.map((m) => m.id);
      const recordId = work.chunk.recordId!;
      const row = span[1]!;

      const B = strategyFor();
      b = await ContextManager.open({ store, strategy: B, membrane });
      const lines = await linesDuring(async () => {
        b!.retractRows([row], { undone: true });
        const record = stored(store, CHUNKS).find((r) => r.id === recordId);
        assert.ok(!record || !record.sourceIds.includes(row), 'premise: the other instance gave the row up from the record');
        calls[0]!.release();
        await deadline(ticking);
      });
      assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(recordId)), lines.join('\n'));
      const summaries = stored(store, SUMMARIES);
      assert.ok(summaries.every((s) => !s.sourceIds.includes(row)), `no summary covers the row: ${JSON.stringify(summaries)}`);
      const mirror = internals(A).chunkRecords.find((r) => r.id === recordId);
      assert.deepEqual(mirror?.sourceIds, stored(store, CHUNKS).find((r) => r.id === recordId)?.sourceIds, "the instance took up the store's records");

      // Compressed again over the rows the record keeps, never over the row.
      const kept = stored(store, CHUNKS).find((r) => r.id === recordId)?.sourceIds ?? [];
      assert.ok(kept.length > 0, 'premise: the record keeps rows');
      const asked = calls.length;
      const drain = (async () => {
        for (let i = 0; i < 20; i++) await releasingUntil(calls, a.tick());
      })();
      await linesDuring(() => drain);
      assert.ok(stored(store, SUMMARIES).every((s) => !s.sourceIds.includes(row)), 'nothing folded since covers the row');
      // CM #350 bot review (wave 2), finding 51: the drain did compress again.
      assert.ok(calls.length > asked, 'the drain asked the model again');
      assert.ok(
        stored(store, SUMMARIES).some((s) => s.level === 1 && JSON.stringify(s.sourceIds) === JSON.stringify(kept)),
        `an L1 covers the rows the record keeps (${kept.join(', ')}): ${JSON.stringify(stored(store, SUMMARIES).map((s) => [s.level, s.sourceIds]))}`,
      );
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it('an L1 in flight in a KnowledgeStrategy over a row the other instance took out writes nothing', async () => {
    // A KnowledgeStrategy keeps no chunk records, so the store's record
    // can't say that the row left: the window does.
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA(knowledgeFor);
    let b: ContextManager | undefined;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const span = work.chunk.messages.map((m) => m.id);
      assert.ok(span.length >= 2, `premise: the span holds rows to take out: ${span.join()}`);
      const row = span[1]!;

      b = await ContextManager.open({ store, strategy: knowledgeFor(), membrane });
      const lines = await linesDuring(async () => {
        b!.retractRows([row], { undone: true });
        assert.equal(a.windowStatusOf(row), 'undone', 'premise: the row is out of the window the instances share');
        calls[0]!.release();
        await deadline(ticking);
      });
      assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(row)), lines.join('\n'));
      const summaries = stored(store, SUMMARIES);
      assert.ok(summaries.every((s) => !s.sourceIds.includes(row)), `no summary covers the row: ${JSON.stringify(summaries)}`);
      assert.ok(internals(A).summaries.every((s) => !s.sourceIds.includes(row)), 'nor does one the instance holds');
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // Wave 3 (finding 2): a row the other instance took out and presented
  // again is in the window, so left() no longer names it, and a
  // KnowledgeStrategy keeps no chunk record to say so. Its new ordinal does.
  for (const [where, at] of [['first', 0], ['last', -1]] as const) {
    it(`an L1 in flight in a KnowledgeStrategy over a row the other instance took out and presented again (the span's ${where}) writes nothing`, async () => {
      const { store, strategy: A, cm: a, calls, membrane } = await instanceA(knowledgeFor);
      let b: ContextManager | undefined;
      try {
        const ticking = a.tick();
        await waitFor(() => calls.length === 1);
        const work = internals(A).pendingCompressionWork;
        assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
        const span = work.chunk.messages.map((m) => m.id);
        assert.ok(span.length >= 2, `premise: the span holds rows to move: ${span.join()}`);
        const row = span.at(at)!;
        const order = () => a.getPresentedMessages().map((m) => m.id);
        assert.ok(order().indexOf(span.at(-1)!) < order().length - 1, 'premise: rows the span lacks follow it in the window');

        b = await ContextManager.open({ store, strategy: knowledgeFor(), membrane });
        const lines = await linesDuring(async () => {
          b!.retractRows([row], { undone: true });
          b!.presentRows([row]);
          assert.equal(a.windowStatusOf(row), 'in', 'premise: the row is in the window again');
          assert.equal(order().at(-1), row, 'premise: at its end');
          calls[0]!.release();
          await deadline(ticking);
        });
        assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(row)), lines.join('\n'));
        const summaries = stored(store, SUMMARIES);
        assert.ok(summaries.every((s) => !s.sourceIds.includes(row)), `no summary covers the row: ${JSON.stringify(summaries)}`);
        assert.ok(internals(A).summaries.every((s) => !s.sourceIds.includes(row)), 'nor does one the instance holds');
      } finally {
        for (const call of calls) call.release();
        b?.close();
        a.close();
        store.close();
      }
    });
  }

  it("a merge in flight over a row the other instance took out and presented again, whose own writes then failed, writes nothing", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const merging = a.tick();
      await waitFor(() => calls.length === 3);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'sourceIds' in work && calls[2]!.merge, 'premise: a merge is in flight');
      const source = work.sourceIds[0]!;
      const row = internals(A).summaries.find((s) => s.id === source)!.sourceIds[0]!;

      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      const lines = await linesDuring(async () => {
        refusingWrites(store, [SUMMARIES, CHUNKS], () => {
          b!.retractRows([row], { undone: true });
          b!.presentRows([row]);
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(a.windowStatusOf(row), 'in', 'premise: the row is in the window again');
        assert.ok(stored(store, SUMMARIES).some((s) => s.id === source), "premise: the other instance's summaries write failed");
        calls[2]!.release();
        await deadline(merging);
      });
      assert.ok(lines.some((line) => line.includes('zz the store refused')), `premise: the other instance's write threw: ${lines.join('\n')}`);
      const after = stored(store, SUMMARIES);
      assert.ok(after.every((s) => !s.sourceIds.includes(source)), `no summary was written over ${source}: ${lines.join('\n')}`);
      assert.ok(after.every((s) => !s.sourceIds.includes(row)), `the instance let go of the row: ${JSON.stringify(after.map((s) => s.id))}`);
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it("an L1 in flight over a row the other instance took out, whose own writes then failed, writes nothing and lets go of the row", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const span = work.chunk.messages.map((m) => m.id);
      const recordId = work.chunk.recordId!;
      const row = span[1]!;

      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      const lines = await linesDuring(async () => {
        refusingWrites(store, [SUMMARIES, CHUNKS], () => { b!.retractRows([row], { undone: true }); });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(a.windowStatusOf(row), 'undone', 'premise: the tombstone landed');
        assert.ok(stored(store, CHUNKS).find((r) => r.id === recordId)?.sourceIds.includes(row), "premise: the other instance's record write failed");
        calls[0]!.release();
        await deadline(ticking);
      });
      assert.ok(lines.some((line) => line.includes('zz the store refused')), `premise: the other instance's write threw: ${lines.join('\n')}`);
      assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(row)), lines.join('\n'));
      const summaries = stored(store, SUMMARIES);
      assert.ok(summaries.every((s) => !s.sourceIds.includes(row)), `no summary covers the row: ${JSON.stringify(summaries)}`);
      assert.ok(
        stored(store, CHUNKS).every((r) => !r.sourceIds.includes(row)),
        `the instance let go of the row, as its onRetracted would have: ${JSON.stringify(stored(store, CHUNKS))}`,
      );
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it("a merge in flight over a row the other instance took out, whose own writes then failed, writes nothing", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const merging = a.tick();
      await waitFor(() => calls.length === 3);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'sourceIds' in work && calls[2]!.merge, 'premise: a merge is in flight');
      const source = work.sourceIds[0]!;
      const row = internals(A).summaries.find((s) => s.id === source)!.sourceIds[0]!;

      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      const lines = await linesDuring(async () => {
        refusingWrites(store, [SUMMARIES, CHUNKS], () => { b!.retractRows([row], { undone: true }); });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(a.windowStatusOf(row), 'undone', 'premise: the tombstone landed');
        assert.ok(stored(store, SUMMARIES).some((s) => s.id === source), "premise: the other instance's summaries write failed");
        calls[2]!.release();
        await deadline(merging);
      });
      assert.ok(lines.some((line) => line.includes('zz the store refused')), `premise: the other instance's write threw: ${lines.join('\n')}`);
      const after = stored(store, SUMMARIES);
      assert.ok(after.every((s) => !s.sourceIds.includes(source)), `no summary was written over ${source}: ${lines.join('\n')}`);
      assert.ok(after.every((s) => !s.sourceIds.includes(row)), `the instance let go of the row: ${JSON.stringify(after.map((s) => s.id))}`);
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // Wave 3 (finding 2, the verifier's pin): a merge's entry check finds a
  // row under its sources that left and was presented again before it
  // began, by the order the window now holds them in, and makes no call
  // (here the first row under them; the last, or one before a row the
  // window doesn't hold, isn't found at entry: see the merge-entry comment).
  it("a merge over a row the other instance took out and presented again before it began, whose own writes then failed, makes no call", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      const row = l1.sourceIds[0]!;
      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      await linesDuring(async () => {
        refusingWrites(store, [SUMMARIES, CHUNKS], () => {
          b!.retractRows([row], { undone: true });
          b!.presentRows([row]);
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.equal(a.windowStatusOf(row), 'in', 'premise: the row is in the window again');
      assert.ok(stored(store, SUMMARIES).some((s) => s.id === l1.id), "premise: the other instance's summaries write failed");
      const before = calls.length;
      const lines = await linesDuring(async () => {
        await releasingUntil(calls, a.tick());
      });
      assert.ok(!calls.slice(before).some((call) => call.merge), `no merge call was made: ${lines.join('\n')}`);
      assert.ok(lines.some((line) => line.includes('were presented again elsewhere in it') && line.includes('skipping stale queue entry') && line.includes(row)), lines.join('\n'));
      const after = stored(store, SUMMARIES);
      assert.ok(after.every((s) => !s.sourceIds.includes(l1.id) && !s.sourceIds.includes(row)), `the instance let go of the row: ${lines.join('\n')}`);
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it("a merge over a row the other instance took out before it began, whose own writes then failed, makes no call", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      const row = l1.sourceIds[0]!;
      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      await linesDuring(async () => {
        refusingWrites(store, [SUMMARIES, CHUNKS], () => { b!.retractRows([row], { undone: true }); });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.ok(stored(store, SUMMARIES).some((s) => s.id === l1.id), "premise: the other instance's summaries write failed");
      const before = calls.length;
      const lines = await linesDuring(async () => {
        await releasingUntil(calls, a.tick());
      });
      assert.ok(!calls.slice(before).some((call) => call.merge), `no merge call was made: ${lines.join('\n')}`);
      assert.ok(lines.some((line) => line.includes('left the window through another instance') && line.includes(row)), lines.join('\n'));
      const after = stored(store, SUMMARIES);
      assert.ok(after.every((s) => !s.sourceIds.includes(l1.id) && !s.sourceIds.includes(row)), `the instance let go of the row: ${lines.join('\n')}`);
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // Wave 3 (finding 2, the verifier's pin): the exhaustion's check under the
  // ledger lock asks rowsMovedInWindow too. A KnowledgeStrategy keeps no
  // chunk record, and the row is in the window again, so only its moved
  // place says the span is obsolete.
  it('a ladder ending with no summary in a KnowledgeStrategy over a row the other instance took out and presented again quarantines nothing', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const gate = emptyMembrane();
    const A = knowledgeFor();
    const a = await ContextManager.open({ store, strategy: A, membrane: gate.membrane });
    let b: ContextManager | undefined;
    try {
      a.presentRows([]);
      for (let i = 0; i < 24; i++) {
        a.presentRows([a.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${'word '.repeat(30)}` }])]);
      }
      await a.compile();
      const ticking = a.tick();
      await waitFor(() => gate.calls() === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const row = work.chunk.messages[0]!.id;

      b = await ContextManager.open({ store, strategy: knowledgeFor(), membrane: gate.membrane });
      const lines = await linesDuring(async () => {
        b!.retractRows([row], { undone: true });
        b!.presentRows([row]);
        assert.equal(a.windowStatusOf(row), 'in', 'premise: the row is in the window again');
        gate.release();
        await deadline(ticking);
      });
      assert.equal(A.getCompressionQuarantineStatus().count, 0, `no quarantine record was written for the obsolete span: ${lines.join('\n')}`);
      assert.deepEqual(lines.filter((line) => line.includes('"compression:quarantine-alert"')), [], 'no alert was sent');
      assert.ok(lines.some((line) => line.includes('quarantines nothing') && line.includes(row)), lines.join('\n'));
    } finally {
      gate.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  it('a ladder ending with no summary over a record the other instance changed quarantines nothing', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const gate = emptyMembrane();
    const A = strategyFor();
    const a = await ContextManager.open({ store, strategy: A, membrane: gate.membrane });
    let b: ContextManager | undefined;
    try {
      a.presentRows([]);
      for (let i = 0; i < 24; i++) {
        a.presentRows([a.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${'word '.repeat(30)}` }])]);
      }
      await a.compile();
      const ticking = a.tick();
      await waitFor(() => gate.calls() === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const row = work.chunk.messages[1]!.id;
      const recordId = work.chunk.recordId!;

      b = await ContextManager.open({ store, strategy: strategyFor(), membrane: gate.membrane });
      const lines = await linesDuring(async () => {
        b!.retractRows([row], { undone: true });
        assert.ok(!stored(store, CHUNKS).find((r) => r.id === recordId)?.sourceIds.includes(row), 'premise: the other instance gave the row up from the record');
        gate.release();
        await deadline(ticking);
      });
      const alerts = lines.filter((line) => line.includes('"compression:quarantine-alert"'));
      assert.equal(A.getCompressionQuarantineStatus().count, 0, `no quarantine record was written for the obsolete span: ${lines.join('\n')}`);
      assert.deepEqual(alerts, [], 'no alert was sent');
      assert.ok(lines.some((line) => line.includes('quarantines nothing') && line.includes(recordId)), lines.join('\n'));
    } finally {
      gate.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // Wave 5, finding 3: a strategy's own let-go (onRetracted) wrote the
  // summaries and chunk records whole from its memory, which another
  // instance's let-go had changed in the store unheard: it wrote back the L1
  // and the record that instance had dropped and given the row up from.
  it("a retraction through this instance, after the other instance let go of a row of its own, writes back nothing the other dropped", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const [first, second] = internals(A).summaries.filter((s) => s.level === 1);
      assert.ok(first && second, 'premise: two L1s');
      const rowA = first.sourceIds[0]!;
      const rowB = second.sourceIds[0]!;
      const recordB = internals(A).chunkRecords.find((r) => r.summaryId === second.id)!.id;

      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      await linesDuring(async () => { b!.retractRows([rowB], { undone: true }); });
      assert.ok(!stored(store, SUMMARIES).some((s) => s.id === second.id), 'premise: the other instance dropped its L1 in the store');
      assert.ok(internals(A).summaries.some((s) => s.id === second.id), 'premise: this instance, which did not hear it, still holds it');

      const lines = await linesDuring(async () => { a.retractRows([rowA], { undone: true }); });
      const summaries = stored(store, SUMMARIES);
      assert.ok(
        summaries.every((s) => s.id !== first.id && s.id !== second.id && !s.sourceIds.includes(rowA) && !s.sourceIds.includes(rowB)),
        `no summary covers either row: ${JSON.stringify(summaries.map((s) => [s.id, s.sourceIds]))}\n${lines.join('\n')}`,
      );
      const records = stored(store, CHUNKS);
      assert.ok(records.every((r) => !r.sourceIds.includes(rowA) && !r.sourceIds.includes(rowB)), `no record holds either row: ${JSON.stringify(records)}`);
      const refolded = records.find((r) => r.id === recordB);
      assert.ok(refolded && !refolded.compressed, `the other instance's record stays refolded: ${JSON.stringify(refolded)}`);
      assert.deepEqual(internals(A).summaries.map((s) => s.id), summaries.map((s) => s.id), "this instance's summaries are the store's");
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // Wave 5, finding 4: the paths that write without a model call (adopting
  // an L1 the instance holds over the chunk's rows, dropping a chunk L1s
  // already cover, a thin chunk's stub) asked nothing of the store or the
  // window, so a chunk another instance let go of a row of was still
  // adopted, dropped as covered, or stubbed over the row.
  for (const path of ['a thin stub', 'an adoption', 'a covered drop'] as const) {
    it(`${path} of a chunk the other instance let go of a row of writes nothing, and takes up the store`, async () => {
      const thin = path === 'a thin stub';
      const make = () => new AutobiographicalStrategy({
        compressionModel: 'm',
        targetChunkTokens: 50,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        autoTickOnNewMessage: false,
        minChunkCharsForLLM: thin ? 1_000_000 : 0,
        l1HoldbackChunks: 0,
        mergeThreshold: 2,
        maxSpeculativeL1s: 1,
      });
      const { store, strategy: A, cm: a, calls, membrane } = await instanceA(make);
      let b: ContextManager | undefined;
      try {
        const chunk = internals(A).chunks[internals(A).compressionQueue[0]!]!;
        const span = chunk.messages.map((m) => m.id);
        const recordId = chunk.recordId!;
        assert.ok(span.length >= 4, `premise: a queued chunk over rows to split: ${span.join()}`);
        const row = span[1]!;
        // An L1 the instance holds, written to the store, with the record
        // not marked: one over the chunk's rows (adopted as it stands), or
        // two that cover them between them (dropped as covered).
        const l1 = (id: string, sourceIds: MessageId[]): SummaryEntry => ({
          id, level: 1, content: `zz ${id}`, tokens: 5, sourceLevel: 0, sourceIds,
          sourceRange: { first: sourceIds[0]!, last: sourceIds.at(-1)! }, created: 1,
        } as SummaryEntry);
        const seeded = path === 'an adoption'
          ? [l1('L1-zz0', span)]
          : path === 'a covered drop' ? [l1('L1-zz0', span.slice(0, 2)), l1('L1-zz1', span.slice(2))] : [];
        for (const summary of seeded) internals(A).pushSummary(summary);

        b = await ContextManager.open({ store, strategy: make(), membrane });
        await linesDuring(async () => { b!.retractRows([row], { undone: true }); });
        assert.ok(!stored(store, CHUNKS).find((r) => r.id === recordId)?.sourceIds.includes(row), 'premise: the other instance gave the row up from the record');

        const before = calls.length;
        const lines = await linesDuring(async () => { await releasingUntil(calls, a.tick()); });
        const summaries = stored(store, SUMMARIES);
        assert.ok(summaries.every((s) => !s.sourceIds.includes(row)), `no summary covers the row: ${JSON.stringify(summaries.map((s) => [s.id, s.sourceIds]))}`);
        const records = stored(store, CHUNKS);
        assert.ok(records.every((r) => !r.sourceIds.includes(row)), `no record holds the row: ${JSON.stringify(records)}`);
        assert.ok(records.every((r) => !r.compressed || summaries.some((s) => s.id === r.summaryId)), `no record is marked with a summary the store lacks: ${JSON.stringify(records)}`);
        assert.ok(!lines.some((line) => line.includes('dedup guard')), `nothing is dropped as covered: ${lines.join('\n')}`);
        assert.ok(internals(A).summaries.every((s) => !s.sourceIds.includes(row)), 'the instance took up the store');
        assert.equal(calls.length, before, `no call is made: ${lines.join('\n')}`);
        assert.ok(lines.some((line) => line.includes(`not compressing chunk ${recordId}`)), `the log says why: ${lines.join('\n')}`);
      } finally {
        for (const call of calls) call.release();
        b?.close();
        a.close();
        store.close();
      }
    });
  }

  // Wave 5, finding 6: a provider's rejection of the merge's call left
  // through the catch, which asked only whether the branch was current, and
  // tick counted it against the entry (recordMergeRejection), whose check
  // is only that this instance's queue still holds it: it wrote this
  // instance's queue whole, putting back the entry the other instance
  // removed, or quarantined the obsolete group at the limit.
  for (const limit of [5, 1] as const) {
    it(`a merge whose call the provider rejects, after the other instance dropped a source, counts nothing and writes nothing (attempt limit ${limit})`, async () => {
      const make = () => new AutobiographicalStrategy({
        compressionModel: 'm',
        targetChunkTokens: 50,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        autoTickOnNewMessage: false,
        minChunkCharsForLLM: 0,
        l1HoldbackChunks: 0,
        mergeThreshold: 2,
        maxSpeculativeL1s: 1,
        mergeAttemptLimit: limit,
      });
      const { store, strategy: A, cm: a, calls, membrane } = await instanceA(make);
      let b: ContextManager | undefined;
      try {
        for (let n = 1; n <= 2; n++) {
          const ticking = a.tick();
          await waitFor(() => calls.length === n);
          calls[n - 1]!.release();
          await deadline(ticking);
        }
        const merging = a.tick();
        await waitFor(() => calls.length === 3);
        const work = internals(A).pendingCompressionWork;
        assert.ok(work && 'sourceIds' in work && calls[2]!.merge, 'premise: a merge is in flight');
        const source = work.sourceIds[0]!;
        const row = internals(A).summaries.find((s) => s.id === source)!.sourceIds[0]!;
        const naming = () => stored(store, QUEUE).filter((entry) => entry.sourceIds.includes(source));

        b = await ContextManager.open({ store, strategy: make(), membrane });
        const lines = await linesDuring(async () => {
          b!.retractRows([row], { undone: true });
          assert.deepEqual(naming(), [], "premise: the other instance's let-go removed the queued merge from the store");
          calls[2]!.fail(Object.assign(new Error('zz invalid_request failure'), { type: 'invalid_request', retryable: false, httpStatus: 400 }));
          await deadline(merging.catch(() => {}));
        });
        assert.deepEqual(naming(), [], `the store's queue doesn't hold the merge again: ${lines.join('\n')}`);
        assert.equal(A.getMergeQuarantineStatus().count, 0, `nothing is quarantined: ${lines.join('\n')}`);
        assert.ok(lines.some((line) => line.includes("merge's call was out") && line.includes('its rejection is not counted')), lines.join('\n'));
      } finally {
        for (const call of calls) call.release();
        b?.close();
        a.close();
        store.close();
      }
    });
  }

  // Wave 5, finding 47: the cases above change the record by retracting a
  // row, which also takes it out of the window, so the window's read alone
  // found the span let go of, and nothing pinned the record's own check.
  // Here the other instance changes the stored record and every row keeps
  // its ordinal.
  it('a ladder ending with no summary over a record the other instance compressed, its rows all in the window, quarantines nothing', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const gate = emptyMembrane();
    const A = strategyFor();
    const a = await ContextManager.open({ store, strategy: A, membrane: gate.membrane });
    try {
      a.presentRows([]);
      for (let i = 0; i < 24; i++) {
        a.presentRows([a.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${'word '.repeat(30)}` }])]);
      }
      await a.compile();
      const ticking = a.tick();
      await waitFor(() => gate.calls() === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const recordId = work.chunk.recordId!;
      const span = work.chunk.messages.map((m) => m.id);
      const lines = await linesDuring(async () => {
        // As the other instance's own L1 over the record lands: its summary and the record marked.
        const l1 = { id: 'L1-zz', level: 1, content: 'zz', tokens: 5, sourceLevel: 0, sourceIds: span, sourceRange: { first: span[0], last: span.at(-1) }, created: 1 };
        store.setStateJson(SUMMARIES, [...stored(store, SUMMARIES), l1]);
        store.setStateJson(CHUNKS, stored(store, CHUNKS).map((r) => (r.id === recordId ? { ...r, compressed: true, summaryId: 'L1-zz' } : r)));
        assert.ok(span.every((id) => a.windowStatusOf(id) === 'in'), 'premise: every row of the span is in the window');
        gate.release();
        await deadline(ticking);
      });
      assert.equal(A.getCompressionQuarantineStatus().count, 0, `no quarantine record was written for the obsolete span: ${lines.join('\n')}`);
      assert.deepEqual(lines.filter((line) => line.includes('"compression:quarantine-alert"')), [], 'no alert was sent');
      assert.ok(lines.some((line) => line.includes('quarantines nothing') && line.includes(`chunk record ${recordId} changed in the store mid-request`)), lines.join('\n'));
    } finally {
      gate.release();
      a.close();
      store.close();
    }
  });

  it('an L1 in flight over a record the other instance wrote again, its rows all in the window at their ordinals, writes nothing', async () => {
    const { store, strategy: A, cm: a, calls } = await instanceA();
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const recordId = work.chunk.recordId!;
      const span = work.chunk.messages.map((m) => m.id);
      const lines = await linesDuring(async () => {
        // The other instance's let-go of a returned row writes a record in window order: here, its rows in another order.
        store.setStateJson(CHUNKS, stored(store, CHUNKS).map((r) => (r.id === recordId ? { ...r, sourceIds: [...r.sourceIds].reverse() } : r)));
        assert.ok(span.every((id) => a.windowStatusOf(id) === 'in'), 'premise: every row of the span is in the window');
        calls[0]!.release();
        await deadline(ticking);
      });
      assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(`chunk record ${recordId} changed in the store mid-request`)), lines.join('\n'));
      assert.ok(!stored(store, SUMMARIES).some((s) => s.level === 1 && s.sourceIds.join() === span.join()), 'no L1 over the span was written');
    } finally {
      for (const call of calls) call.release();
      a.close();
      store.close();
    }
  });

  it('an L1 in flight over a record no other instance changed is written (control)', async () => {
    const { store, cm: a, calls, membrane, strategy: A } = await instanceA();
    let b: ContextManager | undefined;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const span = work.chunk.messages.map((m) => m.id);
      const B = strategyFor();
      b = await ContextManager.open({ store, strategy: B, membrane });
      const lines = await linesDuring(async () => {
        calls[0]!.release();
        await deadline(ticking);
      });
      assert.ok(stored(store, SUMMARIES).some((s) => s.level === 1 && s.sourceIds.join() === span.join()), lines.join('\n'));
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // Wave 6, finding 29 (a regression of wave 5's 4eb1aa6): the check above
  // read both states whole and serialized each side twice at every
  // retraction, a row nothing folds included, and a chunk record the load
  // leaves out (no id, or no rows), which stays in the store, made it find
  // the store apart at every retraction.
  it("a retraction reads neither the summaries nor the chunk records while nothing else has written them, its own let-go's writes included", async () => {
    const { store, strategy: A, cm: a, calls } = await instanceA();
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      // Rows past the last closed chunk, which no record holds yet.
      for (let i = 24; i < 26; i++) a.presentRows([a.addMessage('User', [{ type: 'text', text: `${i} zz` }])]);
      const folded = new Set([
        ...internals(A).summaries.flatMap((s) => s.sourceIds),
        ...internals(A).chunkRecords.flatMap((r) => r.sourceIds),
      ]);
      const window = a.getPresentedMessages().map((m) => m.id);
      const loose = window.filter((id) => !folded.has(id));
      assert.ok(loose.length >= 2, `premise: rows nothing folds: ${JSON.stringify(internals(A).chunkRecords)}`);
      const reads: string[][] = [];
      const lines = await linesDuring(async () => {
        reads.push(readsDuring(store, [SUMMARIES, CHUNKS], () => a.retractRows([loose.at(-1)!], { undone: true })));
        // A let-go of a row an L1 folds writes both states whole.
        reads.push(readsDuring(store, [SUMMARIES, CHUNKS], () => a.retractRows([l1.sourceIds[0]!], { undone: true })));
        reads.push(readsDuring(store, [SUMMARIES, CHUNKS], () => a.retractRows([loose.at(-2)!], { undone: true })));
      });
      assert.ok(!stored(store, SUMMARIES).some((s) => s.id === l1.id), 'premise: the let-go dropped the L1 in the store');
      assert.deepEqual(reads, [[], [], []], `no retraction read either state: ${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes("aren't as this instance holds them")), lines.join('\n'));
    } finally {
      for (const call of calls) call.release();
      a.close();
      store.close();
    }
  });

  it("a chunk record the load leaves out, written to the store, is read once and doesn't read as another instance's write", async () => {
    const { store, cm: a, calls } = await instanceA();
    try {
      const window = a.getPresentedMessages().map((m) => m.id);
      // A record with no rows, which loadedChunkRecords leaves out and no write of the strategy's puts back.
      store.appendToStateJson(CHUNKS, { id: 'c-zz', sourceIds: [] });
      const reads: string[][] = [];
      const lines = await linesDuring(async () => {
        reads.push(readsDuring(store, [SUMMARIES, CHUNKS], () => a.retractRows([window.at(-1)!], { undone: true })));
        reads.push(readsDuring(store, [SUMMARIES, CHUNKS], () => a.retractRows([window.at(-2)!], { undone: true })));
      });
      assert.ok(!lines.some((line) => line.includes("aren't as this instance holds them")), `nothing was taken up: ${lines.join('\n')}`);
      assert.deepEqual(reads, [[CHUNKS], []], 'the chunk records, which another write moved, were read once, and the summaries not at all');
    } finally {
      for (const call of calls) call.release();
      a.close();
      store.close();
    }
  });

  // The verifier's plant at 4233830 (post-#350 follow-up): writeHeldState
  // drops the revision it held the state at before the write, so a write
  // that throws without landing, which leaves the revision where it was,
  // doesn't read as one nothing moved. Where the read back throws too,
  // memory has taken the let-go's side (writeUnfolded) and the store still
  // holds the L1: only the next retraction's compare finds that, and lets
  // go of the row the store still folds.
  it("a retraction after this instance's own write of the summaries threw without landing, its read back throwing too, reads the store and lets go of the row the store still folds", async () => {
    const { store, strategy: A, cm: a, calls } = await instanceA();
    const handle = store as unknown as Record<string, unknown>;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      calls[0]!.release();
      await deadline(ticking);
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      const row = l1.sourceIds[0]!;
      // A row past the last closed chunk, which nothing folds, so its let-go writes no summaries.
      for (let i = 24; i < 26; i++) a.presentRows([a.addMessage('User', [{ type: 'text', text: `${i} zz` }])]);
      const folded = new Set([
        ...internals(A).summaries.flatMap((s) => s.sourceIds),
        ...internals(A).chunkRecords.flatMap((r) => r.sourceIds),
      ]);
      const loose = a.getPresentedMessages().map((m) => m.id).filter((id) => !folded.has(id));
      assert.ok(loose.length >= 1, `premise: a row nothing folds: ${JSON.stringify(internals(A).chunkRecords)}`);

      const realWrite = store.setStateJson.bind(store);
      const realRead = store.getStateJson.bind(store);
      let readFails = false;
      handle.setStateJson = (id: string, value: unknown) => {
        if (id !== SUMMARIES) return realWrite(id, value);
        readFails = true;
        throw new Error('zz the store refused the write of the summaries');
      };
      handle.getStateJson = (id: string) => {
        if (readFails && id === SUMMARIES) {
          readFails = false;
          throw new Error('zz the read back of the summaries threw');
        }
        return realRead(id);
      };
      let first: string[];
      try {
        first = await linesDuring(async () => { a.retractRows([row], { undone: true }); });
      } finally {
        delete handle.setStateJson;
        delete handle.getStateJson;
      }
      assert.ok(first.some((line) => line.includes('zz the store refused')), `premise: the let-go's write threw: ${first.join('\n')}`);
      assert.ok(stored(store, SUMMARIES).some((s) => s.id === l1.id), "premise: the store's summaries still hold the L1");
      assert.ok(internals(A).summaries.every((s) => s.id !== l1.id), "premise: memory took the let-go's side");

      let reads: string[] = [];
      const lines = await linesDuring(async () => {
        reads = readsDuring(store, [SUMMARIES], () => a.retractRows([loose.at(-1)!], { undone: true }));
      });
      assert.ok(reads.length > 0, `the next retraction reads the summaries, whose revision the failed write left unmoved: ${lines.join('\n')}`);
      assert.ok(
        lines.some((line) => line.includes("aren't as this instance holds them") && line.includes(row)),
        `it takes up the store, and lets go of the row the store still folds: ${lines.join('\n')}`,
      );
      assert.ok(
        stored(store, SUMMARIES).every((s) => s.id !== l1.id && !s.sourceIds.includes(row)),
        `the store no longer holds the L1 over the row: ${stored(store, SUMMARIES).map((s) => s.id).join(', ')}`,
      );
    } finally {
      delete handle.setStateJson;
      delete handle.getStateJson;
      for (const call of calls) call.release();
      a.close();
      store.close();
    }
  });

  // Wave 6, finding 1: another manager's retraction tells only its own
  // strategy, so this instance went on rendering the L1 over the row, from
  // its own summaries and chunk records, until its own next let-go, work
  // over the span, or open.
  for (const next of ['compile', 'presentation'] as const) {
    it(`this instance's next ${next} after the other instance took out a row it folds lets go of what covers the row`, async () => {
      const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
      let b: ContextManager | undefined;
      try {
        const ticking = a.tick();
        await waitFor(() => calls.length === 1);
        calls[0]!.release();
        await deadline(ticking);
        const l1 = internals(A).summaries.find((s) => s.level === 1)!;
        const row = l1.sourceIds[0]!;
        const rowText = (a.getMessage(row)!.content[0] as { text: string }).text;
        b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
        await linesDuring(async () => { b!.retractRows([row], { undone: true }); });
        assert.ok(!stored(store, SUMMARIES).some((s) => s.id === l1.id), 'premise: the other instance dropped the L1 in the store');
        assert.ok(internals(A).summaries.some((s) => s.id === l1.id), 'premise: this instance, which did not hear it, still holds it');

        let sent = '';
        const lines = await linesDuring(async () => {
          if (next === 'compile') sent = JSON.stringify((await a.compile()).messages);
          else a.presentRows([a.addMessage('User', [{ type: 'text', text: 'zz after' }])]);
        });
        if (next === 'compile') {
          assert.ok(!sent.includes(l1.content), `the compile doesn't send the L1 over the row: ${sent.slice(0, 400)}`);
          assert.ok(!sent.includes(JSON.stringify(rowText)), "nor the row's text");
        }
        assert.ok(!internals(A).summaries.some((s) => s.sourceIds.includes(row)), `no summary this instance holds covers the row: ${lines.join('\n')}`);
        assert.ok(!internals(A).chunkRecords.some((r) => r.sourceIds.includes(row)), 'nor does a record');
        assert.ok(lines.some((line) => line.includes('still folded by this instance') && line.includes(row)), lines.join('\n'));
        assert.ok(stored(store, SUMMARIES).every((s) => !s.sourceIds.includes(row)), 'nothing is written back over the row');
      } finally {
        for (const call of calls) call.release();
        b?.close();
        a.close();
        store.close();
      }
    });
  }

  // The verifier's plants at 4233830 (post-#350 follow-up): the look before
  // a live select is made once per change of the window's length
  // (windowLengthLooked): every tombstone and presentation takes an
  // ordinal, so while the length stands no row has left the window since.
  it("a live select looks for rows out of the window this instance still folds only where the window's length moved since it last looked", async () => {
    const { store, strategy: A, cm: a, calls } = await instanceA();
    let c: ContextManager | undefined;
    // Rows past the last closed chunk, which nothing folds, so a look that
    // finds one out of the window lets go of nothing. Each presentation
    // looks at the length it leaves (windowGrew).
    for (let i = 24; i < 26; i++) a.presentRows([a.addMessage('User', [{ type: 'text', text: `${i} zz` }])]);
    const folded = new Set([
      ...internals(A).summaries.flatMap((s) => s.sourceIds),
      ...internals(A).chunkRecords.flatMap((r) => r.sourceIds),
    ]);
    const loose = a.getPresentedMessages().map((m) => m.id).filter((id) => !folded.has(id));
    assert.ok(loose.length >= 1, `premise: a row nothing folds: ${JSON.stringify(internals(A).chunkRecords)}`);
    // The select's look reads the window through the context initialize was given.
    const view = (A as unknown as { hostContext: { window: { left: () => ReadonlySet<MessageId> | null } } }).hostContext.window;
    const left = view.left;
    let looks = 0;
    view.left = () => {
      looks++;
      return left();
    };
    try {
      await a.compile();
      await a.compile();
      assert.equal(looks, 0, 'no look at a length it looked at already');
      c = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      c.retractRows([loose.at(-1)!], { undone: true });
      await linesDuring(async () => { await a.compile(); });
      assert.equal(looks, 1, "one look once another manager's tombstone moved the length");
      await a.compile();
      assert.equal(looks, 1, 'and none again while the length stands');
    } finally {
      view.left = left;
      for (const call of calls) call.release();
      c?.close();
      a.close();
      store.close();
    }
  });

  // The verifier's plant at 4233830 (post-#350 follow-up): an audit-only
  // instance's open leaves a row out of the window under what folds it, for
  // inspection (releaseRowsThatLeft), and its select doesn't undo that.
  it("an audit-only instance's compile leaves a row another manager took out under the L1 that folds it, and writes no let-go", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let c: ContextManager | undefined;
    let audit: ContextManager | undefined;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      calls[0]!.release();
      await deadline(ticking);
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      const row = l1.sourceIds[0]!;
      // A manager whose strategy folds nothing takes the row out, so the
      // store still holds the L1 over it.
      c = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      c.retractRows([row], { undone: true });
      assert.ok(stored(store, SUMMARIES).some((s) => s.id === l1.id), 'premise: the store still holds the L1 over the row');

      const inspecting = strategyFor({ auditOnly: true });
      const lines = await linesDuring(async () => {
        audit = await ContextManager.open({ store, strategy: inspecting, membrane });
        await audit.compile();
      });
      assert.ok(internals(inspecting).summaries.some((s) => s.id === l1.id), `the audit-only instance still holds the L1 over the row: ${lines.join('\n')}`);
      assert.ok(stored(store, SUMMARIES).some((s) => s.id === l1.id), 'and so does the store: no let-go was written');
      assert.ok(!lines.some((line) => line.includes('still folded by this instance')), lines.join('\n'));
    } finally {
      for (const call of calls) call.release();
      audit?.close();
      c?.close();
      a.close();
      store.close();
    }
  });

  // Wave 6, finding 8: the check above ran before the call's exact
  // adoption only at entry. After the call, an exact L1 found in the store
  // was adopted before the check, and a compression that waited on another
  // instance's call over the chunk adopted its L1 with no check.
  it('an L1 whose call returns after a row of its span was taken out, with an L1 over the span written meanwhile and not let go of, adopts nothing', async () => {
    const { store, strategy: A, cm: a, calls } = await instanceA();
    let c: ContextManager | undefined;
    try {
      const ticking = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const span = work.chunk.messages.map((m) => m.id);
      const row = span[1]!;
      // Another instance's L1 over the span lands, as its own compression's
      // would, and a manager whose strategy folds nothing takes the row out,
      // so nothing lets go of that L1.
      store.appendToStateJson(SUMMARIES, {
        id: 'L1-zz', level: 1, content: 'zz', tokens: 5, sourceLevel: 0, sourceIds: span,
        sourceRange: { first: span[0], last: span.at(-1) }, created: 1,
      });
      c = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      c.retractRows([row], { undone: true });
      const lines = await linesDuring(async () => {
        calls[0]!.release();
        await deadline(ticking);
      });
      assert.ok(internals(A).summaries.every((s) => !s.sourceIds.includes(row)), `the instance adopted nothing over the row: ${lines.join('\n')}`);
      assert.ok(stored(store, SUMMARIES).every((s) => !s.sourceIds.includes(row)), 'and let go of the L1 over it in the store');
      assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(row)), lines.join('\n'));
    } finally {
      for (const call of calls) call.release();
      c?.close();
      a.close();
      store.close();
    }
  });

  it("a compression that waited on another instance's call over the same chunk adopts nothing over a row taken out before it resumed", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    const B = strategyFor();
    const b = await ContextManager.open({ store, strategy: B, membrane });
    let c: ContextManager | undefined;
    const realEdit = store.editStateItem.bind(store);
    try {
      const producing = a.tick();
      await waitFor(() => calls.length === 1);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'chunk' in work, 'premise: an L1 is in flight');
      const row = work.chunk.messages[1]!.id;
      const waiting = b.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(calls.length, 1, 'premise: the other instance waits on this call');
      c = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      // As the producer marks its record, past its own checks, a manager
      // whose strategy folds nothing takes the row out: the producer's L1
      // is written, and nothing lets go of it.
      let taken = false;
      (store as unknown as { editStateItem: typeof realEdit }).editStateItem = (id: string, index: number, payload: Buffer) => {
        const out = realEdit(id, index, payload);
        if (id === CHUNKS && !taken) {
          taken = true;
          c!.retractRows([row], { undone: true });
        }
        return out;
      };
      const lines = await linesDuring(async () => {
        calls[0]!.release();
        await deadline(producing);
        await deadline(waiting);
      });
      assert.ok(taken, `premise: the producer marked its record: ${lines.join('\n')}`);
      assert.ok(internals(B).summaries.every((s) => !s.sourceIds.includes(row)), `the waiter adopted nothing over the row: ${lines.join('\n')}`);
      assert.ok(lines.some((line) => line.includes(row) && line.includes('left the window')), lines.join('\n'));
    } finally {
      (store as unknown as { editStateItem: typeof realEdit }).editStateItem = realEdit;
      for (const call of calls) call.release();
      c?.close();
      b.close();
      a.close();
      store.close();
    }
  });

  // The verifier's plants at cfba31f that the suite left green (E2, E4, E7;
  // E5 is pinned in the first case above).
  const unmerging = (extra: Record<string, unknown> = {}) => () => new AutobiographicalStrategy({
    compressionModel: 'm',
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    l1HoldbackChunks: 0,
    mergeThreshold: 10,
    maxSpeculativeL1s: 1,
    ...extra,
  });

  // E2: letGoOfRowsOutOfWindow takes up the store before it lets go, so the
  // whole-state writes of its let-go carry the other instance's.
  it("a let-go of a row found out of the window before a compression takes up the store first, writing back nothing another instance let go of", async () => {
    const make = unmerging();
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA(make);
    let b: ContextManager | undefined;
    let c: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await deadline(ticking);
      }
      const first = internals(A).summaries.find((s) => s.level === 1)!;
      const z = first.sourceIds[0]!;
      const queued = internals(A).chunks[internals(A).compressionQueue[0]!]!;
      const y = queued.messages[1]!.id;
      b = await ContextManager.open({ store, strategy: make(), membrane });
      await linesDuring(async () => { b!.retractRows([z], { undone: true }); });
      assert.ok(!stored(store, SUMMARIES).some((s) => s.id === first.id), "premise: the other instance's let-go dropped the L1");
      assert.ok(internals(A).chunkRecords.some((r) => r.sourceIds.includes(z)), 'premise: this instance, which did not hear it, still holds the row in a record');
      // Nothing lets go of y: a manager whose strategy folds nothing takes it out.
      c = await ContextManager.open({ store, strategy: new PassthroughStrategy() });
      c.retractRows([y], { undone: true });

      const before = calls.length;
      const lines = await linesDuring(async () => { await releasingUntil(calls, a.tick()); });
      assert.ok(lines.some((line) => line.includes(`not compressing chunk ${queued.recordId}`) && line.includes(y)), lines.join('\n'));
      assert.equal(calls.length, before, 'no call is made');
      const records = stored(store, CHUNKS);
      assert.ok(records.every((r) => !r.sourceIds.includes(z)), `no record holds the row the other instance let go of: ${JSON.stringify(records)}`);
      assert.ok(records.every((r) => !r.sourceIds.includes(y)), 'nor the row found out of the window');
      assert.ok(!stored(store, SUMMARIES).some((s) => s.id === first.id), 'nor is the dropped L1 written back');
    } finally {
      for (const call of calls) call.release();
      c?.close();
      b?.close();
      a.close();
      store.close();
    }
  });

  // E4: storeWrittenElsewhere compares the chunk records too, so a let-go
  // that changed only them (a row no L1 folds) is taken up.
  it("a retraction through this instance, after the other instance gave a row up from a record no L1 folds, writes back nothing it gave up", async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      const [r1, r2] = internals(A).chunkRecords.filter((r) => !r.compressed);
      assert.ok(r1 && r2 && internals(A).summaries.length === 0, 'premise: two records, and no summary');
      const y = r1.sourceIds[1]!;
      const x = r2.sourceIds[1]!;
      const summariesBefore = JSON.stringify(stored(store, SUMMARIES));
      b = await ContextManager.open({ store, strategy: strategyFor(), membrane });
      await linesDuring(async () => { b!.retractRows([y], { undone: true }); });
      assert.equal(JSON.stringify(stored(store, SUMMARIES)), summariesBefore, "premise: the other instance's let-go left the summaries as they were");
      assert.ok(!stored(store, CHUNKS).find((r) => r.id === r1.id)?.sourceIds.includes(y), 'premise: it gave the row up from its record');
      assert.ok(internals(A).chunkRecords.find((r) => r.id === r1.id)?.sourceIds.includes(y), 'premise: this instance still holds it there');

      const lines = await linesDuring(async () => { a.retractRows([x], { undone: true }); });
      const records = stored(store, CHUNKS);
      assert.ok(records.every((r) => !r.sourceIds.includes(y) && !r.sourceIds.includes(x)), `no record holds either row: ${JSON.stringify(records)}`);
      assert.ok(lines.some((line) => line.includes("aren't as this instance holds them")), lines.join('\n'));
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });

  // E7: the rejection of the carrier fallback's retry is checked as the
  // first call's is, before it is counted.
  for (const limit of [5, 1] as const) {
    it(`a merge whose carrier retry the provider rejects, after the other instance dropped a source during the retry, counts nothing and writes nothing (attempt limit ${limit})`, async () => {
      const make = () => new AutobiographicalStrategy({
        compressionModel: 'm',
        targetChunkTokens: 50,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        autoTickOnNewMessage: false,
        minChunkCharsForLLM: 0,
        l1HoldbackChunks: 0,
        mergeThreshold: 2,
        maxSpeculativeL1s: 1,
        mergeAttemptLimit: limit,
      });
      const { store, strategy: A, cm: a, calls, membrane } = await instanceA(make, heldMembrane({ thinking: true }));
      let b: ContextManager | undefined;
      try {
        // Two L1s and their merge, then two more L1s: the second merge's
        // request carries the reasoning of what precedes its sources.
        for (let n = 1; n <= 5; n++) {
          const ticking = a.tick();
          await waitFor(() => calls.length === n);
          calls[n - 1]!.release();
          await deadline(ticking);
        }
        const merging = a.tick();
        await waitFor(() => calls.length === 6);
        const work = internals(A).pendingCompressionWork;
        assert.ok(work && 'sourceIds' in work && calls[5]!.merge, 'premise: a merge is in flight');
        assert.ok(calls[5]!.carriesReasoning, 'premise: its request carries reasoning blocks');
        const source = work.sourceIds[0]!;
        const row = internals(A).summaries.find((s) => s.id === source)!.sourceIds[0]!;
        const naming = () => stored(store, QUEUE).filter((entry) => entry.sourceIds.includes(source));
        const lines = await linesDuring(async () => {
          // The transport refuses the carriers: the merge retries once, text-only.
          calls[5]!.fail(Object.assign(new Error('zz invalid_request: thinking blocks cannot be modified'), { type: 'invalid_request', retryable: false, httpStatus: 400 }));
          await waitFor(() => calls.length === 7);
          assert.ok(calls[6]!.merge && !calls[6]!.carriesReasoning, 'premise: the retry is the merge, text-only');
          b = await ContextManager.open({ store, strategy: make(), membrane });
          b.retractRows([row], { undone: true });
          assert.deepEqual(naming(), [], "premise: the other instance's let-go removed the queued merge from the store");
          calls[6]!.fail(Object.assign(new Error('zz invalid_request failure'), { type: 'invalid_request', retryable: false, httpStatus: 400 }));
          await deadline(merging.catch(() => {}));
        });
        assert.ok(lines.some((line) => line.includes('transport rejected reasoning carriers')), `premise: the carrier fallback ran: ${lines.join('\n')}`);
        assert.deepEqual(naming(), [], `the store's queue doesn't hold the merge again: ${lines.join('\n')}`);
        assert.equal(A.getMergeQuarantineStatus().count, 0, `nothing is quarantined: ${lines.join('\n')}`);
        assert.ok(lines.some((line) => line.includes("merge's call was out") && line.includes('its rejection is not counted')), lines.join('\n'));
      } finally {
        for (const call of calls) call.release();
        b?.close();
        a.close();
        store.close();
      }
    });
  }
});
