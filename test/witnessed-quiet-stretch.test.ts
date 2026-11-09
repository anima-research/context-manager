/**
 * A quiet stretch of inherited record is stamped as an L1 of its chunk is.
 *
 * A chunk of text only, with too little text to summarize, gets a mechanical
 * stub instead of an L1 call. Before the witness pin
 * (`witnessedBeforeSequence`), an L1 of a chunk whose messages all come
 * before the pin is stamped `witnessed`, and a merge whose sources are all
 * witnessed takes the witnessed merge instruction and passes the stamp up.
 * The stub takes the same stamp, so a merge of inherited summaries that
 * includes a quiet stretch does too.
 *
 * The capturing membrane tags each summary it writes with the instruction
 * it was asked to write from, so each stored merge says which one it took.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { AutobiographicalConfig, SummaryEntry } from '../src/types/strategy.js';

const TEST_STORE_PATH = './test-witnessed-quiet-stretch';

const INSTRUCTIONS = [
  ['witnessed-merge', "others' lived experience, witnessed through the record you carry"],
  ['live-merge', 'Speak in the first person. Target'],
  ['witnessed-l1', "others' lived experience, witnessed through the log, not your own"],
  ['live-l1', 'Speak in the first person from your own perspective'],
] as const;
type Instruction = (typeof INSTRUCTIONS)[number][0] | 'unknown';

function instructionIn(text: string): Instruction {
  return INSTRUCTIONS.find(([, words]) => text.includes(words))?.[0] ?? 'unknown';
}

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

interface ApiMessage { participant: string; content: ContentBlock[] }

interface Call { instruction: Instruction; text: string; refused: boolean }

/** With refuseFirstMerge, the first merge request is refused, as a classifier would. */
function capturingMembrane(options: { refuseFirstMerge?: boolean } = {}) {
  const calls: Call[] = [];
  let refusalsLeft = options.refuseFirstMerge ? 1 : 0;
  const membrane = {
    complete: async (request: { messages: ApiMessage[] }) => {
      const text = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join(' ');
      const instruction = instructionIn(text);
      const refused = refusalsLeft > 0 && instruction.endsWith('-merge');
      if (refused) refusalsLeft--;
      calls.push({ instruction, text, refused });
      if (refused) {
        return { stopReason: 'refusal', content: [{ type: 'text', text: '' }], usage: { input_tokens: 100, output_tokens: 1 } };
      }
      const summary = `[${instruction}] ` + 'x '.repeat(40);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
        usage: { input_tokens: 100, output_tokens: Math.ceil(summary.length / 4) },
      };
    },
  };
  return { membrane, calls };
}

const QUIET = (i: number) => (i % 3 === 0 ? 'hb' : ' ');
const SUBSTANTIVE = (i: number) => `Ash and Tavy talked through the plan at message ${i}. ` + 'detail '.repeat(40);

/** Quiet traffic only: heartbeats and empty turns. */
function quietTraffic(n: number): string[] {
  return Array.from({ length: n }, (_, i) => QUIET(i));
}

/** Blocks of forty quiet messages, each followed by one worth summarizing. */
function blockTraffic(blocks: number): string[] {
  return Array.from({ length: blocks * 41 }, (_, i) => (i % 41 === 40 ? SUBSTANTIVE(i) : QUIET(i)));
}

interface Run {
  calls: Call[];
  summaries: SummaryEntry[];
  byId: Map<string, SummaryEntry>;
  seqOf: Map<string, number>;
}

async function run(
  traffic: string[],
  config: Partial<AutobiographicalConfig>,
  options: { refuseFirstMerge?: boolean } = {},
): Promise<Run> {
  cleanup();
  const { membrane, calls } = capturingMembrane(options);
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 40,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 1000,
    ...config,
  });
  const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
  const seqOf = new Map<string, number>();
  traffic.forEach((text, i) => {
    const id = manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [{ type: 'text', text }]);
    seqOf.set(id, Number(manager.getMessage(id)!.sequence));
  });
  for (let i = 0; i < 500 && !manager.isReady(); i++) await manager.tick();
  assert.ok(manager.isReady(), 'the queue drained within 500 ticks');
  const summaries = [...(strategy as unknown as { summaries: SummaryEntry[] }).summaries];
  await manager.close();
  return { calls, summaries, byId: new Map(summaries.map((s) => [s.id, s])), seqOf };
}

const isStub = (s: SummaryEntry) => s.content.startsWith('(A quiet stretch');
const leafSequences = (r: Run, s: SummaryEntry) => s.sourceIds.map((id) => r.seqOf.get(id)!);
const sourcesOf = (r: Run, s: SummaryEntry) => s.sourceIds.map((id) => r.byId.get(id)!);
const writtenFrom = (s: SummaryEntry): Instruction => (s.content.match(/^\[([a-z0-9-]+)\]/)?.[1] as Instruction) ?? 'unknown';
const merges = (r: Run) => r.summaries.filter((s) => s.level >= 2);
/** The L1 summaries and quiet stubs under a summary. */
const leavesOf = (r: Run, s: SummaryEntry): SummaryEntry[] => (s.level === 1 ? [s] : sourcesOf(r, s).flatMap((x) => leavesOf(r, x)));

describe('a quiet stretch of inherited record', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('is stamped exactly when an L1 of the same chunk is: before the pin, ending on it and after it', async () => {
    const PIN = 82; // the last message of the second quiet chunk
    const traffic = quietTraffic(200);
    const stubbed = await run(traffic, { witnessedBeforeSequence: PIN });
    const summarized = await run(traffic, { witnessedBeforeSequence: PIN, minChunkCharsForLLM: 0 });

    const stubs = stubbed.summaries.filter((s) => s.level === 1);
    assert.ok(stubs.length >= 3 && stubs.every(isStub), 'every quiet chunk was stubbed');
    assert.equal(stubbed.calls.length, 0, 'a quiet chunk takes no model call');
    const spans = stubs.map((s) => leafSequences(stubbed, s));
    assert.ok(spans.some((seqs) => seqs.every((q) => q < PIN)), 'a chunk lies wholly before the pin');
    assert.ok(spans.some((seqs) => seqs[0] < PIN && seqs.at(-1) === PIN), 'a chunk ends on the pin itself');
    assert.ok(spans.some((seqs) => seqs.every((q) => q > PIN)), 'a chunk lies wholly after the pin');

    for (const [i, stub] of stubs.entries()) {
      assert.equal(stub.witnessed === true, spans[i].every((q) => q < PIN), `${stub.id}: witnessed only if every message is before the pin`);
    }

    const l1s = summarized.summaries.filter((s) => s.level === 1);
    assert.ok(l1s.every((s) => !isStub(s)), 'with the thin-chunk guard off, every chunk is summarized');
    assert.deepEqual(l1s.map((s) => leafSequences(summarized, s)), spans, 'the same chunks either way');
    for (const [i, stub] of stubs.entries()) {
      assert.equal(stub.witnessed === true, l1s[i].witnessed === true, `${stub.id} is stamped as the L1 of its chunk is`);
    }
  });

  it('keeps the stamp and the witnessed merge instruction through merges of merges that include one', async () => {
    const r = await run(blockTraffic(6), { witnessedBeforeSequence: Number.MAX_SAFE_INTEGER, mergeThreshold: 2 });
    assert.ok(merges(r).some((m) => m.level >= 3 && leavesOf(r, m).some(isStub)), 'a merge of merges was made over a quiet stretch');
    assert.ok(
      merges(r).some((m) => m.level === 2 && sourcesOf(r, m).some(isStub) && sourcesOf(r, m).some((s) => !isStub(s))),
      'a merge took a quiet stretch beside a summarized chunk',
    );
    for (const m of merges(r)) {
      assert.equal(m.witnessed, true, `${m.id} is stamped`);
      assert.equal(writtenFrom(m), 'witnessed-merge', `${m.id} took the witnessed merge instruction`);
    }
  });

  it('leaves a merge with a source after the pin to the live merge instruction, unstamped', async () => {
    // Between the last quiet stretch and the summarized chunk merged with it.
    const PIN = 215;
    const r = await run(blockTraffic(6), { witnessedBeforeSequence: PIN, mergeThreshold: 2 });
    let witnessedMerges = 0;
    let mixedOverStub = 0;
    for (const m of merges(r)) {
      const sources = sourcesOf(r, m);
      const allWitnessed = sources.every((s) => s.witnessed === true);
      assert.equal(m.witnessed === true, allWitnessed, `${m.id}: stamped only if every source is`);
      assert.equal(writtenFrom(m), allWitnessed ? 'witnessed-merge' : 'live-merge', `${m.id}: its instruction follows its sources`);
      if (allWitnessed) witnessedMerges++;
      else if (sources.some((s) => isStub(s) && s.witnessed === true)) mixedOverStub++;
    }
    assert.ok(witnessedMerges > 0, 'some merge lay wholly before the pin');
    assert.ok(mixedOverStub > 0, 'some merge took a witnessed quiet stretch beside a source after the pin');
  });

  it('is never stamped without a pin, and its merges take the live instruction', async () => {
    const r = await run(blockTraffic(4), { mergeThreshold: 2 });
    assert.ok(r.summaries.some(isStub), 'a quiet chunk was stubbed');
    assert.ok(merges(r).length > 0, 'merges were made');
    for (const s of r.summaries) assert.equal(s.witnessed, undefined, `${s.id} carries no stamp`);
    for (const m of merges(r)) assert.equal(writtenFrom(m), 'live-merge', `${m.id} took the live merge instruction`);
  });

  it("keeps the witnessed instruction on a merge's refusal fallback over a quiet stretch", async () => {
    const r = await run(blockTraffic(3), { witnessedBeforeSequence: Number.MAX_SAFE_INTEGER, mergeThreshold: 2 }, { refuseFirstMerge: true });
    const refusedAt = r.calls.findIndex((c) => c.refused);
    assert.ok(refusedAt >= 0, 'a merge was refused');
    const first = merges(r).find((m) => m.level === 2)!;
    assert.ok(sourcesOf(r, first).some(isStub), 'the refused merge was over a quiet stretch');
    // The retry after a refusal shows the merge its sources themselves as
    // recall pairs (the fallback payload), not the messages under them.
    const fallback = r.calls.slice(refusedAt + 1).find((c) => c.instruction.endsWith('-merge'))!;
    assert.ok(fallback.text.includes(`[CM] Recall memory ${first.sourceIds[0]}.`), 'the retry took the fallback payload');
    assert.equal(fallback.instruction, 'witnessed-merge', 'the fallback took the witnessed merge instruction');
    assert.equal(writtenFrom(first), 'witnessed-merge');
    assert.equal(first.witnessed, true);
  });
});
