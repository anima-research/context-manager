/**
 * A half-written unfold is repaired by the next open (CM #350 bot review,
 * finding 2).
 *
 * The autobiographical strategy writes what it lets go of (unfold) as three
 * states, one after another: the summaries, then the chunk records, then
 * the merge queue. A process that stops after the summaries' write leaves a
 * chunk record that still names the L1 it dropped. The open makes such a
 * record compressible again (releaseUnsummarizedRecords), over every row it
 * held. When the unfold was the open's demote of a summary whose leaves the
 * window holds apart, the record's rows stand apart in the window too, and
 * before this repair nothing stopped the record from being compressed
 * across them, into an L1 that the next open demoted again.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import type { CompileResult, MessageId, SummaryEntry } from '../src/index.js';

const BASE = './test-unfold-half-write';
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

/** Summarizer mock: each answer names the tags its request carried. */
function mockMembrane() {
  let calls = 0;
  return {
    complete: async (request: { messages: Array<{ content: ContentBlock[] }> }) => {
      calls++;
      const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
      const tags = [...new Set(input.match(/TAG\d+/g) ?? [])].join(',');
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `[summary ${calls} of ${tags}] ` + 'mem '.repeat(20) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  } as never;
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
  chunks: Array<{ messages: Array<{ id: MessageId }> }>;
  summariesStateId: string;
  chunksStateId: string;
}
const internals = (strategy: AutobiographicalStrategy) => strategy as unknown as Internals;

type Unfold = (seeds: ReadonlySet<string>, sourcesOf: (record: unknown) => MessageId[] | undefined) => unknown;
type StateWrite = (id: string, ...rest: unknown[]) => unknown;

/**
 * An autobiographical strategy whose process "stops" just after an unfold
 * writes its summaries: from then on, no write to the strategy's summaries,
 * chunk records or merge queue reaches the store.
 */
function stoppingAfterSummaries(): { strategy: AutobiographicalStrategy; stopped: () => boolean } {
  const strategy = new AutobiographicalStrategy(FOLDING);
  const self = strategy as unknown as {
    store: Record<string, StateWrite>;
    summariesStateId: string;
    chunksStateId: string;
    mergeQueueStateId: string;
    unfold: Unfold;
  };
  const unfold = self.unfold;
  let stopped = false;
  let unfolding = false;
  let patched = false;
  self.unfold = function (this: typeof self, seeds, sourcesOf) {
    if (!patched) {
      patched = true;
      const store = this.store;
      const states = new Set([this.summariesStateId, this.chunksStateId, this.mergeQueueStateId]);
      for (const name of ['setStateJson', 'appendToStateJson', 'editStateItem']) {
        const write = store[name]!;
        Object.defineProperty(store, name, {
          configurable: true,
          writable: true,
          value: function (id: string, ...rest: unknown[]) {
            if (stopped && states.has(id)) return undefined;
            const result = write.call(store, id, ...rest);
            if (unfolding && name === 'setStateJson' && id === self.summariesStateId) stopped = true;
            return result;
          },
        });
      }
    }
    unfolding = true;
    try {
      return unfold.call(this, seeds, sourcesOf);
    } finally {
      unfolding = false;
    }
  };
  return { strategy, stopped: () => stopped };
}

/** The message ids a summary covers. */
function leavesOf(cm: ContextManager, id: string): MessageId[] {
  const summary = cm.getSummary(id);
  if (!summary) return [];
  return summary.level === 1 ? summary.sourceIds : summary.sourceIds.flatMap((source) => leavesOf(cm, source));
}

/** Each message id a compile renders, raw or inside a summary, as often as it renders it. */
function renderedRows(cm: ContextManager, result: CompileResult): MessageId[] {
  const rendered: MessageId[] = [];
  let previous = new Set<string>();
  for (const part of result.provenance?.messages ?? []) {
    const named = new Set<string>(part.kind === 'summary' ? part.summaries.map((s) => s.id) : []);
    if (part.kind === 'raw') rendered.push(...part.bodies.map((b) => b.messageId));
    for (const id of named) if (!previous.has(id)) rendered.push(...leavesOf(cm, id));
    previous = named;
  }
  return rendered;
}

async function drain(cm: ContextManager): Promise<void> {
  for (let i = 0; i < 500 && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'the drain finished');
}

/** The chunk records whose rows the window doesn't hold as one run. */
function splitRecords(cm: ContextManager, strategy: AutobiographicalStrategy): string[] {
  const position = new Map(cm.getPresentedMessages().map((m, i) => [m.id, i] as const));
  return internals(strategy).chunkRecords.filter((record) => {
    const at = record.sourceIds.map((id) => position.get(id)).filter((p): p is number => p !== undefined).sort((a, b) => a - b);
    return at.some((p, i) => i > 0 && p !== at[i - 1]! + 1);
  }).map((record) => `${record.id}[${record.sourceIds.join(',')}]`);
}

describe('a half-written unfold', () => {
  it("the open's demote stopped after its summaries' write: the next open trims the record the window holds apart, and nothing is compressed across it", async () => {
    const path = freshPath();
    const strategy = new AutobiographicalStrategy(FOLDING);
    const cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane() });
    cm.presentRows([]);
    const ids: MessageId[] = [];
    for (let i = 0; i < 24; i++) {
      const id = cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
      cm.presentRows([id]);
      ids.push(id);
    }
    await drain(cm);
    const row = ids[3]!;
    assert.ok(internals(strategy).summaries.some((s) => s.level === 1 && s.sourceIds.includes(row)), 'premise: the row is folded');
    cm.close();

    // Taken out and presented again through a strategy without the hook: the
    // next folding open finds the L1 over the row's old place non-contiguous.
    const plain = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
    plain.retractRows([row], { undone: true });
    plain.presentRows([row]);
    plain.close();

    // That open demotes the L1 and stops just after writing the summaries.
    const stopping = stoppingAfterSummaries();
    await linesDuring(async () => {
      const open = await ContextManager.open({ path, namespace: 'agent', strategy: stopping.strategy, membrane: mockMembrane() });
      open.close();
    });
    assert.ok(stopping.stopped(), 'premise: the demote wrote its summaries and nothing after');

    const next = new AutobiographicalStrategy(FOLDING);
    let reopened!: ContextManager;
    const lines = await linesDuring(async () => {
      reopened = await ContextManager.open({ path, namespace: 'agent', strategy: next, membrane: mockMembrane() });
    });
    assert.ok(
      lines.some((line) => line.includes('uncompressed chunk record') && line.includes(`releasing [${row}]`)),
      lines.join('\n'),
    );
    assert.deepEqual(splitRecords(reopened, next), [], 'every chunk record holds rows the window holds together');
    assert.ok(
      internals(next).chunkRecords.every((r) => !r.sourceIds.includes(row) || r.sourceIds.length === 1 || !r.compressed),
      'no record holds the row beside its old neighbours',
    );

    // Compression runs on, past the row's new place.
    await drain(reopened);
    for (let i = 24; i < 40; i++) {
      reopened.presentRows([reopened.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))])]);
    }
    await drain(reopened);
    assert.deepEqual(next.auditStoreTopology(reopened.getPresentedMessages()).map((v) => v.id), [], 'no summary was compressed across the window');
    assert.deepEqual(splitRecords(reopened, next), []);
    const rendered = renderedRows(reopened, await reopened.compile(BIG));
    assert.equal(new Set(rendered).size, rendered.length, 'no row renders twice');
    reopened.close();

    // The repair was written: the next open finds nothing to demote or trim.
    const again = await linesDuring(async () => {
      const open = await ContextManager.open({ path, namespace: 'agent', strategy: new AutobiographicalStrategy(FOLDING), membrane: mockMembrane() });
      open.close();
    });
    assert.ok(!again.some((line) => line.includes('the window holds the')), again.join('\n'));
  });

  // CM #350 bot review, wave 3, finding 14: unfold set each mirror before
  // its write, so a write that threw in a live process left the strategy's
  // memory apart from the store (the L1 gone from memory and kept in the
  // store, or the records changed in memory and not in the store), and
  // windowLost stopped before its rebuild, so the chunks still held the row.
  it('a retraction whose state write throws leaves memory as the store holds it, and the chunks rebuilt over the window', async () => {
    for (const [label, failing] of [['the summaries', 0], ['the chunk records', 1]] as const) {
      const path = freshPath();
      const strategy = new AutobiographicalStrategy(FOLDING);
      const cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane() });
      cm.presentRows([]);
      const ids: MessageId[] = [];
      for (let i = 0; i < 24; i++) {
        const id = cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
        cm.presentRows([id]);
        ids.push(id);
      }
      await drain(cm);
      const row = ids[3]!;
      const state = internals(strategy);
      assert.ok(state.summaries.some((s) => s.level === 1 && s.sourceIds.includes(row)), `${label}: premise: the row is folded`);

      const store = cm.getStore() as unknown as { setStateJson: StateWrite; getStateJson: (id: string) => unknown };
      const real = store.setStateJson;
      const states = [state.summariesStateId, state.chunksStateId];
      let writes = 0;
      store.setStateJson = function (this: unknown, id: string, ...rest: unknown[]) {
        if (states.includes(id) && writes++ === failing) throw new Error(`zz the store refused the write of ${id}`);
        return real.call(this, id, ...rest);
      };
      let lines: string[];
      try {
        lines = await linesDuring(async () => { cm.retractRows([row], { undone: true }); });
      } finally {
        delete (store as { setStateJson?: unknown }).setStateJson;
      }
      assert.ok(lines.some((line) => line.includes('Strategy onRetracted failed') && line.includes('zz the store refused')), `${label}: premise: ${lines.join('\n')}`);
      const ofStore = (id: string) => ((store.getStateJson(id) as Array<{ id: string }> | null) ?? []);
      assert.deepEqual(state.summaries.map((s) => s.id), ofStore(state.summariesStateId).map((s) => s.id), `${label}: the summaries in memory are the store's`);
      assert.deepEqual(state.chunkRecords, ofStore(state.chunksStateId), `${label}: the chunk records in memory are the store's`);
      assert.ok(state.chunks.every((chunk) => !chunk.messages.some((m) => m.id === row)), `${label}: the chunks were rebuilt over the window, which lacks the row`);
      cm.close();

      // The next open lets go of what still covers the row out of the window.
      const next = new AutobiographicalStrategy(FOLDING);
      let reopened!: ContextManager;
      await linesDuring(async () => {
        reopened = await ContextManager.open({ path, namespace: 'agent', strategy: next, membrane: mockMembrane() });
      });
      assert.ok(internals(next).summaries.every((s) => !s.sourceIds.includes(row)), `${label}: no summary covers the row after the next open`);
      assert.ok(internals(next).chunkRecords.every((r) => !r.sourceIds.includes(row)), `${label}: no record holds it`);
      reopened.close();
    }
  });

  it("under 'report' and in an audit-only open, the record is left as it was found", async () => {
    for (const config of [{ topologyPolicy: 'report' as const }, { topologyPolicy: 'report' as const, auditOnly: true }]) {
      const path = freshPath();
      const strategy = new AutobiographicalStrategy(FOLDING);
      const cm = await ContextManager.open({ path, namespace: 'agent', strategy, membrane: mockMembrane() });
      cm.presentRows([]);
      const ids: MessageId[] = [];
      for (let i = 0; i < 24; i++) {
        const id = cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))]);
        cm.presentRows([id]);
        ids.push(id);
      }
      await drain(cm);
      cm.close();
      const plain = await ContextManager.open({ path, namespace: 'agent', strategy: new PassthroughStrategy() });
      plain.retractRows([ids[3]!], { undone: true });
      plain.presentRows([ids[3]!]);
      plain.close();
      const stopping = stoppingAfterSummaries();
      await linesDuring(async () => {
        const open = await ContextManager.open({ path, namespace: 'agent', strategy: stopping.strategy, membrane: mockMembrane() });
        open.close();
      });
      assert.ok(stopping.stopped(), 'premise: the demote wrote its summaries and nothing after');

      const inspected = new AutobiographicalStrategy({ ...FOLDING, ...config });
      let open!: ContextManager;
      const lines = await linesDuring(async () => {
        open = await ContextManager.open({ path, namespace: 'agent', strategy: inspected, membrane: mockMembrane() });
      });
      assert.ok(!lines.some((line) => line.includes('uncompressed chunk record')), `${JSON.stringify(config)}: ${lines.join('\n')}`);
      assert.equal(splitRecords(open, inspected).length, 1, `${JSON.stringify(config)}: the record is left as it was found`);
      open.close();
    }
  });
});
