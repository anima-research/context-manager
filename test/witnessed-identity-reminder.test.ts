/**
 * Witnessed vs live identity reminders, pinned on the wire.
 *
 * A resident whose Chronicle begins with reviewed inherited history
 * (witnessedBeforeSequence) can set two reminders: one for wholly inherited
 * material, and one for everything else. The rule:
 *   - an L1 chunk whose every message is before the pin, or a merge whose
 *     every source is stamped witnessed            -> witnessedIdentityReminder
 *   - every other target, including a mixed one: a chunk that spans the pin
 *     (and each piece the split rung folds it into), or a merge of inherited
 *     and lived sources                            -> identityReminder
 * A mixed target's request shows inherited and lived material together under
 * the live instruction and reminder, with no label saying which is which.
 *
 * These tests read the compression requests the model would receive. What
 * each request should carry is decided by where the pin sits among the
 * stored messages its target covers, never by its instruction.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const STORE = './test-zz-witnessed-identity';
const PROBE_STORE = './test-zz-witnessed-identity-probe';
const WITNESSED = 'WITNESSED-REMINDER: inherited record; attribute it to its participants.';
const LIVE = 'LIVE-REMINDER: first person only for your own actions and experience.';
const L1_WITNESSED_MARK = 'predates your own first turn';
const MERGE_WITNESSED_MARK = 'witnessed through the record you carry';
const READING_MARK = 'You have just been reading a substantial body of text';
const READING_MERGE_MARK = 'You have just re-experienced the portions of text you read above';
const PIN = 30;

const t = (text: string): ContentBlock => ({ type: 'text', text });
const cleanup = () => {
  for (const path of [STORE, PROBE_STORE]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
};

function texts(req: NormalizedRequest): string[] {
  return req.messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
}
function instruction(req: NormalizedRequest): string {
  const last = req.messages[req.messages.length - 1]!;
  return last.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
}
function assertCarries(req: NormalizedRequest, inherited: boolean, what: string): void {
  const text = instruction(req);
  const [own, other] = inherited ? [WITNESSED, LIVE] : [LIVE, WITNESSED];
  assert.ok(text.endsWith(`\n\n${own}`), `${what}: ends with the ${inherited ? 'witnessed' : 'live'} reminder`);
  assert.ok(!text.includes(other), `${what}: never carries the ${inherited ? 'live' : 'witnessed'} one`);
}

interface Run {
  calls: NormalizedRequest[];
  summaries: SummaryEntry[];
  sequenceOf: Map<string, number>;
}

/**
 * Eighty messages through the real tick path. Each response names the call
 * that produced it, so every summary leads back to its request, and the
 * request's target to the stored messages it compresses.
 */
async function run(strategyOptions: Record<string, unknown>): Promise<Run> {
  cleanup();
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      const call = calls.length;
      calls.push(request);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `A memory of this stretch (call ${call}): ` + 'detail '.repeat(40) }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      };
    },
  };
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'zz-model',
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 2,
    ...strategyOptions,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
  for (let i = 0; i < 80; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(`turn ${i} of steady substantive traffic about the work `.repeat(3))]);
    for (let k = 0; k < 500 && !manager.isReady(); k++) await manager.tick();
  }
  const summaries = [...(strategy as unknown as { summaries: SummaryEntry[] }).summaries];
  const stored = (manager as unknown as { messageStore: { getAll(): Array<{ id: string; sequence: number }> } }).messageStore.getAll();
  const sequenceOf = new Map(stored.map((m) => [m.id, m.sequence]));
  await manager.close();
  cleanup();
  return { calls, summaries, sequenceOf };
}

/** Each request, with its target's level and the sequences of the stored messages it compresses. */
function targets(r: Run): Array<{ request: NormalizedRequest; level: number; sequences: number[] }> {
  const byId = new Map(r.summaries.map((s) => [s.id, s]));
  const leaves = (s: SummaryEntry): string[] =>
    s.sourceLevel === 0 ? s.sourceIds : s.sourceIds.flatMap((id) => leaves(byId.get(id)!));
  const out: Array<{ request: NormalizedRequest; level: number; sequences: number[] }> = [];
  const traced = new Set<number>();
  for (const s of r.summaries) {
    const calls = [...s.content.matchAll(/\(call (\d+)\)/g)].map((m) => Number(m[1]));
    assert.equal(calls.length, 1, `summary ${s.id} names the one request that produced it`);
    assert.ok(!traced.has(calls[0]!), `request ${calls[0]} produced one summary`);
    traced.add(calls[0]!);
    out.push({ request: r.calls[calls[0]!]!, level: s.level, sequences: leaves(s).map((id) => r.sequenceOf.get(id)!) });
  }
  assert.equal(traced.size, r.calls.length, 'every request leads back to the summary it produced');
  return out;
}

/** Drives one compression directly, with the pin set once the store's sequences are known. */
class Probe extends AutobiographicalStrategy {
  pinBefore(sequence: number): void { this.config.witnessedBeforeSequence = sequence; }
  compress(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  queueMerge(level: number, sourceIds: string[]): void { this.enqueueMerge({ level, sourceIds }); }
  merge(level: number, sourceIds: string[], ctx: StrategyContext): Promise<boolean> { return this.executeMerge(level as never, sourceIds, ctx); }
  entries(): SummaryEntry[] { return this.summaries; }
}
const contextOf = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
const PROBE_OPTIONS = {
  compressionModel: 'zz-model', recentWindowTokens: 0, headWindowTokens: 0, autoTickOnNewMessage: false,
  quarantineAlarmIntervalMs: 0, identityReminder: LIVE, witnessedIdentityReminder: WITNESSED,
};

/**
 * Four messages compressed as one chunk through the split rung
 * (compressionSplitFallback): the membrane refuses any request carrying two
 * or more of them, so the chunk is folded one message at a time. The pin sits
 * before message `pinIndex` (4: after all of them).
 */
async function splitRun(pinIndex: number) {
  cleanup();
  const calls: NormalizedRequest[] = [];
  const targetsOf = (r: NormalizedRequest) => texts(r).filter((x) => /^raw-\d /.test(x)).map((x) => x.split(' ')[0]!);
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      const shown = targetsOf(request);
      if (shown.length >= 2) return { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } };
      return { content: [t(`piece ${shown.join('+')}`)], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  const strategy = new Probe({
    ...PROBE_OPTIONS, targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true, compressionSplitFallback: true,
  } as never);
  const manager = await ContextManager.open({ path: PROBE_STORE, strategy, membrane: membrane as never });
  const ids = [0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`raw-${i} ` + 'substantive '.repeat(12))]));
  const ctx = contextOf(manager);
  const messages = ctx.messageStore.getAll().filter((m) => ids.includes(m.id));
  strategy.pinBefore(pinIndex < messages.length ? messages[pinIndex]!.sequence : messages[messages.length - 1]!.sequence + 1);
  await strategy.compress({ index: 0, startIndex: 0, endIndex: 4, messages, tokens: 100, compressed: false }, ctx);
  const installed = strategy.entries().length;
  await manager.close();
  cleanup();
  return { calls, pieces: calls.filter((c) => targetsOf(c).length === 1), installed, targetsOf };
}

/**
 * An L2 merge of two seeded L1s, over raw-0..1 and raw-2..3, stamped as an L1
 * mint stamps them against the pin. The first attempt is refused, so the retry
 * shows the sources themselves (the refusal-fallback payload). The pin sits
 * before message `pinIndex`.
 */
async function refusedMergeRun(pinIndex: number) {
  cleanup();
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      return calls.length === 1
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } }
        : { content: [t('the merged memory body, written as prose')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  const strategy = new Probe({
    ...PROBE_OPTIONS, hierarchical: true, targetChunkTokens: 100_000, mergeThreshold: 99,
  } as never);
  const manager = await ContextManager.open({ path: PROBE_STORE, strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`raw-${i} ` + 'substance '.repeat(10))]));
  const ctx = contextOf(manager);
  const sequence = new Map(ctx.messageStore.getAll().map((m) => [m.id, m.sequence]));
  const pin = sequence.get(ids[pinIndex]!)!;
  strategy.pinBefore(pin);
  const l1 = (id: string, a: number, b: number): SummaryEntry => ({
    id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
    sourceIds: [ids[a]!, ids[b]!], sourceRange: { first: ids[a]!, last: ids[b]! }, created: 1,
    ...(sequence.get(ids[b]!)! < pin ? { witnessed: true } : {}),
  });
  strategy.seed(l1('L1-100', 0, 1));
  strategy.seed(l1('L1-101', 2, 3));
  strategy.queueMerge(2, ['L1-100', 'L1-101']);
  await strategy.tick(ctx);
  await strategy.tick(ctx);
  const merged = strategy.entries().filter((s) => s.level === 2).length;
  await manager.close();
  cleanup();
  return { calls, merged };
}

/**
 * One shard of a sharded message (adaptiveResolution), compressed alone: the
 * shard is a portion of a much larger body, so it takes the reading-mode
 * instruction. `inherited` puts the pin after every shard, or at the first.
 */
async function readingRun(inherited: boolean) {
  cleanup();
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      return { content: [t('a reflection on the reading')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  const strategy = new Probe({
    ...PROBE_OPTIONS, targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99, adaptiveResolution: true,
  } as never);
  const manager = await ContextManager.open({ path: PROBE_STORE, strategy, membrane: membrane as never });
  manager.addMessage('User', [t('a shared document of many substantive paragraphs. '.repeat(100))]);
  const ctx = contextOf(manager);
  const shards = ctx.messageStore.getAll();
  strategy.pinBefore(inherited ? shards[shards.length - 1]!.sequence + 1 : shards[0]!.sequence);
  await strategy.compress({ index: 0, startIndex: 0, endIndex: 1, messages: [shards[0]!], tokens: 100, compressed: false }, ctx);
  await manager.close();
  cleanup();
  return { calls, shards: shards.length, grouped: shards.every((s) => s.bodyGroupId !== undefined && s.bodyGroupId === shards[0]!.bodyGroupId) };
}

/**
 * An L2 merge of two seeded L1s over shards 0..1 and 2..3 of one sharded
 * message, so the merge takes the reading-mode merge instruction. The L1s are
 * stamped as an L1 mint stamps them against the pin, which `inherited` puts
 * after every shard, or at the first.
 */
async function readingMergeRun(inherited: boolean) {
  cleanup();
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      return { content: [t('a reflection across the reading')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  const strategy = new Probe({
    ...PROBE_OPTIONS, hierarchical: true, targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99, adaptiveResolution: true,
  } as never);
  const manager = await ContextManager.open({ path: PROBE_STORE, strategy, membrane: membrane as never });
  manager.addMessage('User', [t('a shared document of many substantive paragraphs. '.repeat(100))]);
  const ctx = contextOf(manager);
  const shards = ctx.messageStore.getAll();
  strategy.pinBefore(inherited ? shards[shards.length - 1]!.sequence + 1 : shards[0]!.sequence);
  const l1 = (id: string, a: number, b: number): SummaryEntry => ({
    id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
    sourceIds: [shards[a]!.id, shards[b]!.id], sourceRange: { first: shards[a]!.id, last: shards[b]!.id }, created: 1,
    ...(inherited ? { witnessed: true } : {}),
  });
  strategy.seed(l1('L1-100', 0, 1));
  strategy.seed(l1('L1-101', 2, 3));
  await strategy.merge(2, ['L1-100', 'L1-101'], ctx);
  const merged = strategy.entries().filter((s) => s.level === 2).length;
  await manager.close();
  cleanup();
  return { calls, merged, shards: shards.length };
}

describe('witnessedIdentityReminder', () => {
  before(cleanup);
  after(cleanup);

  it('a target wholly before the pin gets the witnessed reminder, and every other target, mixed ones included, gets the live one', async () => {
    const r = await run({ witnessedBeforeSequence: PIN, identityReminder: LIVE, witnessedIdentityReminder: WITNESSED });
    assert.ok(r.calls.length > 0, 'the run sent compression requests');
    const all = targets(r);
    const seen = { inheritedL1: 0, livedL1: 0, inheritedMerge: 0, livedMerge: 0, mixedMerge: 0 };
    for (const { request, level, sequences } of all) {
      const inherited = sequences.every((q) => q < PIN);
      const lived = sequences.every((q) => q >= PIN);
      assertCarries(request, inherited, `L${level} over sequences ${sequences[0]}..${sequences[sequences.length - 1]}`);
      const text = instruction(request);
      assert.equal(text.includes(level === 1 ? L1_WITNESSED_MARK : MERGE_WITNESSED_MARK), inherited, 'the instruction follows the pin too');
      if (level === 1) {
        if (inherited) seen.inheritedL1++;
        else if (lived) seen.livedL1++;
      } else if (inherited) seen.inheritedMerge++;
      else if (lived) seen.livedMerge++;
      else seen.mixedMerge++;
    }
    for (const [kind, count] of Object.entries(seen)) assert.ok(count > 0, `the run reached a ${kind} target (${JSON.stringify(seen)})`);
  });

  it('unset or blank: every request is the no-reminder run\'s request with the live reminder appended', async () => {
    const bare = await run({ witnessedBeforeSequence: PIN });
    const live = await run({ witnessedBeforeSequence: PIN, identityReminder: LIVE });
    const blank = await run({ witnessedBeforeSequence: PIN, identityReminder: LIVE, witnessedIdentityReminder: ' \n\t ' });
    assert.ok(bare.calls.length > 0, 'the run sent compression requests');
    assert.deepStrictEqual(blank.calls, live.calls, 'a blank witnessedIdentityReminder counts as unset');
    assert.equal(live.calls.length, bare.calls.length, 'the same requests, in the same order');
    for (let i = 0; i < bare.calls.length; i++) {
      assert.ok(!instruction(bare.calls[i]!).includes('REMINDER'), 'no reminder configured, none sent');
      const expected = structuredClone(bare.calls[i]!);
      const last = expected.messages[expected.messages.length - 1]!.content.filter((b) => b.type === 'text').at(-1) as { text: string };
      last.text += `\n\n${LIVE}`;
      assert.deepStrictEqual(live.calls[i], expected, `request ${i} differs only by the live reminder at its end`);
    }
  });

  it('witnessedIdentityReminder alone: wholly inherited targets carry it, and every other request carries none', async () => {
    const r = await run({ witnessedBeforeSequence: PIN, witnessedIdentityReminder: WITNESSED });
    assert.ok(r.calls.length > 0, 'the run sent compression requests');
    let inherited = 0;
    for (const { request, sequences } of targets(r)) {
      if (sequences.every((q) => q < PIN)) {
        inherited++;
        assert.ok(instruction(request).endsWith(`\n\n${WITNESSED}`), 'an inherited target carries the witnessed reminder');
      } else {
        assert.ok(!instruction(request).includes('REMINDER'), 'every other target carries none');
      }
    }
    assert.ok(inherited > 0, 'the run reached a wholly inherited target');
  });

  it('the split L1 rung gives every piece the whole chunk\'s reminder and compression instruction', async () => {
    const inherited = await splitRun(4);
    assert.equal(inherited.targetsOf(inherited.calls[0]!).length, 4, 'the first request is the whole chunk, from the L1 site');
    assert.equal(inherited.pieces.length, 4, 'the chunk was folded one message at a time');
    assert.equal(inherited.installed, 1, 'and installed as one L1');
    for (const r of inherited.calls) {
      assertCarries(r, true, `inherited chunk, request over ${inherited.targetsOf(r).join('+')}`);
      assert.ok(instruction(r).includes(L1_WITNESSED_MARK), 'with the witnessed instruction');
    }

    // A chunk that spans the pin is a mixed target: every piece, including
    // the two wholly before the pin, carries the live instruction and reminder.
    const spanning = await splitRun(2);
    assert.equal(spanning.targetsOf(spanning.calls[0]!).length, 4, 'the first request is the whole chunk, from the L1 site');
    assert.equal(spanning.pieces.length, 4, 'the chunk was folded one message at a time');
    assert.equal(spanning.installed, 1, 'and installed as one L1');
    for (const r of spanning.calls) {
      assertCarries(r, false, `spanning chunk, request over ${spanning.targetsOf(r).join('+')}`);
      assert.ok(!instruction(r).includes(L1_WITNESSED_MARK), 'with the live instruction');
    }
  });

  it('a merge retried after a refusal keeps its reminder on the source-level fallback payload', async () => {
    const inherited = await refusedMergeRun(4);
    assert.equal(inherited.calls.length, 2, 'one refused attempt, one retry');
    assert.equal(inherited.merged, 1, 'the retry merged');
    assert.ok(texts(inherited.calls[0]!).some((x) => x.startsWith('raw-0 ')), 'the first attempt replays the raw span');
    assert.ok(texts(inherited.calls[1]!).includes('authored L1-100'), 'the retry shows the sources themselves');
    assert.ok(!texts(inherited.calls[1]!).some((x) => x.startsWith('raw-0 ')), 'and not the raw span');
    for (const r of inherited.calls) {
      assertCarries(r, true, 'merge of witnessed sources');
      assert.ok(instruction(r).includes(MERGE_WITNESSED_MARK), 'with the witnessed merge instruction');
    }

    const mixed = await refusedMergeRun(2);
    assert.equal(mixed.calls.length, 2, 'one refused attempt, one retry');
    assert.equal(mixed.merged, 1, 'the retry merged');
    assert.ok(texts(mixed.calls[1]!).includes('authored L1-100'), 'the retry shows the sources themselves');
    for (const r of mixed.calls) {
      assertCarries(r, false, 'merge of a witnessed and a lived source');
      assert.ok(!instruction(r).includes(MERGE_WITNESSED_MARK), 'with the live merge instruction');
    }
  });

  it('a wholly inherited reading-mode target gets the witnessed reminder after the reading instruction', async () => {
    const inherited = await readingRun(true);
    assert.ok(inherited.shards >= 4 && inherited.grouped, `the message was sharded into one body (${inherited.shards} shards)`);
    assert.equal(inherited.calls.length, 1);
    assert.ok(instruction(inherited.calls[0]!).startsWith(READING_MARK), 'the reading instruction, which has no witnessed variant');
    assertCarries(inherited.calls[0]!, true, 'inherited shard');

    const lived = await readingRun(false);
    assert.equal(lived.calls.length, 1);
    assert.ok(instruction(lived.calls[0]!).startsWith(READING_MARK));
    assertCarries(lived.calls[0]!, false, 'lived shard');
  });

  it('a reading-mode merge of wholly inherited sources gets the witnessed reminder after the reading merge instruction', async () => {
    const inherited = await readingMergeRun(true);
    assert.ok(inherited.shards >= 4, `the message was sharded (${inherited.shards} shards)`);
    assert.equal(inherited.calls.length, 1, 'one merge request');
    assert.equal(inherited.merged, 1, 'the merge installed an L2');
    assert.ok(instruction(inherited.calls[0]!).startsWith(READING_MERGE_MARK), 'the reading merge instruction, which has no witnessed variant');
    assertCarries(inherited.calls[0]!, true, 'merge of inherited shards');

    const lived = await readingMergeRun(false);
    assert.equal(lived.calls.length, 1, 'one merge request');
    assert.equal(lived.merged, 1, 'the merge installed an L2');
    assert.ok(instruction(lived.calls[0]!).startsWith(READING_MERGE_MARK));
    assertCarries(lived.calls[0]!, false, 'merge of lived shards');
  });
});
