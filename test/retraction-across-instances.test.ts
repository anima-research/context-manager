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
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
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

/** A membrane that holds each call until the test releases it, noting whether it asks for a merge. */
function heldMembrane() {
  const calls: Array<{ merge: boolean; release: () => void }> = [];
  const membrane = {
    complete: (request: { messages: Array<{ content: Array<{ text?: string }> }> }) => new Promise((resolve) => {
      const n = calls.length + 1;
      const input = request.messages.flatMap((m) => m.content).map((b) => b.text ?? '').join('\n');
      calls.push({
        merge: input.includes('consolidate into a single L'),
        release: () => resolve({ stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${n}` }] }),
      });
    }),
  } as never;
  return { calls, membrane };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const strategyFor = () => new AutobiographicalStrategy({
  compressionModel: 'm',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false,
  minChunkCharsForLLM: 0,
  l1HoldbackChunks: 0,
  mergeThreshold: 2,
  maxSpeculativeL1s: 1,
});

interface Internals {
  summaries: SummaryEntry[];
  chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
  pendingCompressionWork: { chunk: { messages: Array<{ id: MessageId }>; recordId?: string } } | { sourceIds: readonly string[] } | null;
}
const internals = (strategy: AutobiographicalStrategy) => strategy as unknown as Internals;

/** Instance A on a fresh store, its window holding 24 presented rows. */
async function instanceA() {
  const path = freshPath();
  const store = JsStore.openOrCreate({ path });
  const held = heldMembrane();
  const strategy = strategyFor();
  const cm = await ContextManager.open({ store, strategy, membrane: held.membrane });
  cm.presentRows([]);
  for (let i = 0; i < 24; i++) {
    cm.presentRows([cm.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${'word '.repeat(30)}` }])]);
  }
  await cm.compile();
  return { store, strategy, cm, ...held };
}

/** The list a state of the store holds (none written yet is an empty one). */
const stored = (store: JsStore, id: string) =>
  ((store.getStateJson(id) as Array<{ id: string; level?: number; sourceIds: string[]; compressed?: boolean }> | null) ?? []);

describe('a retraction through another instance sharing the store', () => {
  it('a merge in flight over an L1 the other instance dropped writes nothing, and takes up the store', async () => {
    const { store, strategy: A, cm: a, calls, membrane } = await instanceA();
    let b: ContextManager | undefined;
    try {
      for (let n = 1; n <= 2; n++) {
        const ticking = a.tick();
        await waitFor(() => calls.length === n);
        calls[n - 1]!.release();
        await ticking;
      }
      const merging = a.tick();
      await waitFor(() => calls.length === 3);
      const work = internals(A).pendingCompressionWork;
      assert.ok(work && 'sourceIds' in work && calls[2]!.merge, 'premise: a merge is in flight');
      const source = work.sourceIds[0]!;
      const row = internals(A).summaries.find((s) => s.id === source)!.sourceIds[0]!;

      const B = strategyFor();
      b = await ContextManager.open({ store, strategy: B, membrane });
      const lines = await linesDuring(async () => {
        b!.retractRows([row], { undone: true });
        assert.ok(!stored(store, SUMMARIES).some((s) => s.id === source), 'premise: the other instance dropped the source in the store');
        calls[2]!.release();
        await merging;
      });
      assert.ok(lines.some((line) => /source\(s\) dropped while the L2 merge's call was out/.test(line)), lines.join('\n'));
      assert.ok(!lines.some((line) => line.includes('setMergedInto')), lines.join('\n'));
      const after = stored(store, SUMMARIES);
      assert.ok(after.every((s) => !s.sourceIds.includes(source)), `no summary was written over ${source}: ${JSON.stringify(after.map((s) => s.id))}`);
      assert.ok(!internals(A).summaries.some((s) => s.id === source), 'the instance took up the store: it no longer holds the dropped source');
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
        await ticking;
      }
      const l1 = internals(A).summaries.find((s) => s.level === 1)!;
      const B = strategyFor();
      b = await ContextManager.open({ store, strategy: B, membrane });
      await linesDuring(async () => { b!.retractRows([l1.sourceIds[0]!], { undone: true }); });
      assert.ok(internals(A).summaries.some((s) => s.id === l1.id), 'premise: the instance still holds the dropped L1');
      const before = calls.length;
      const lines = await linesDuring(async () => {
        const ticking = a.tick();
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const call of calls) call.release();
        await ticking;
      });
      assert.ok(!calls.slice(before).some((call) => call.merge), `no merge call was made: ${lines.join('\n')}`);
      assert.ok(lines.some((line) => line.includes('dropped from the store by another instance')), lines.join('\n'));
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
        await ticking;
      });
      assert.ok(lines.some((line) => line.includes('discarding L1') && line.includes(recordId)), lines.join('\n'));
      const summaries = stored(store, SUMMARIES);
      assert.ok(summaries.every((s) => !s.sourceIds.includes(row)), `no summary covers the row: ${JSON.stringify(summaries)}`);
      const mirror = internals(A).chunkRecords.find((r) => r.id === recordId);
      assert.deepEqual(mirror?.sourceIds, stored(store, CHUNKS).find((r) => r.id === recordId)?.sourceIds, "the instance took up the store's records");

      // Compressed again over the rows the record keeps, never over the row.
      const drain = (async () => {
        for (let i = 0; i < 20; i++) {
          const next = a.tick();
          await new Promise((resolve) => setTimeout(resolve, 10));
          for (const call of calls) call.release();
          await next;
        }
      })();
      await linesDuring(() => drain);
      assert.ok(stored(store, SUMMARIES).every((s) => !s.sourceIds.includes(row)), 'nothing folded since covers the row');
    } finally {
      for (const call of calls) call.release();
      b?.close();
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
        await ticking;
      });
      assert.ok(stored(store, SUMMARIES).some((s) => s.level === 1 && s.sourceIds.join() === span.join()), lines.join('\n'));
    } finally {
      for (const call of calls) call.release();
      b?.close();
      a.close();
      store.close();
    }
  });
});
