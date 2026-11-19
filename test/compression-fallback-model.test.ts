import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

// Fallback-model rung (compressionFallbackModel): when the compression model
// refuses on every rung that keeps it writing the memory in full, the canonical
// request goes once more with only its model changed, before the split rung and
// before quarantine. The scripted membrane below answers by the model a request
// names, so a test says what each model does and reads which was asked.

const BASE = './test-compression-fallback-model';
const OWN = 'same-model';
const OTHER = 'other-model';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
after(() => { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); });

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const modelOf = (request: NormalizedRequest): string => String((request.config as { model?: unknown }).model);
function texts(req: NormalizedRequest): string[] {
  return req.messages.flatMap((m) => m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text));
}
const targets = (req: NormalizedRequest): number => texts(req).filter((t) => /^raw-\d+ /.test(t)).length;

const REFUSAL = { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'bio' } } } };
const TRUNCATED = { content: [text('a partial mem')], stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 20 } };
const THINKING = { type: 'thinking', thinking: 'how it went', signature: 'sig-other' } as unknown as ContentBlock;
const ok = (t: string, blocks: ContentBlock[] = []) => ({ content: [...blocks, text(t)], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 37 } });
type Answer = typeof REFUSAL | typeof TRUNCATED | ReturnType<typeof ok> | { throw: unknown };

/** Answers by model: each model's answers in order, the last one repeating. */
function byModel(script: Record<string, Answer[] | ((request: NormalizedRequest) => Answer)>) {
  const calls: NormalizedRequest[] = [];
  const asked: Record<string, number> = {};
  return {
    calls,
    models: () => calls.map(modelOf),
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        const model = modelOf(request);
        const plan = script[model];
        assert.ok(plan, `no script for model ${model}`);
        const n = asked[model] = (asked[model] ?? 0) + 1;
        const answer = typeof plan === 'function' ? plan(request) : plan[Math.min(n, plan.length) - 1]!;
        if ('throw' in answer) throw answer.throw;
        return answer;
      },
    } as never,
  };
}

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  qMerge(level: number, sourceIds: string[]): void { this.enqueueMerge({ level, sourceIds }); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  entries(): SummaryEntry[] { return [...this.summaries]; }
  queue() { return this.mergeQueue.map((item) => ({ ...item })); }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

interface L1Opts { fallbackModel?: string; split?: boolean; path?: string }
function l1Config(opts: L1Opts) {
  return {
    compressionModel: OWN, targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, quarantineAlarmIntervalMs: 0,
    compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
    ...(opts.split ? { compressionSplitFallback: true } : {}),
    ...(opts.fallbackModel ? { compressionFallbackModel: opts.fallbackModel } : {}),
  } as never;
}
function chunkOf(manager: ContextManager, ids: string[]): Chunk {
  const want = new Set(ids);
  return { index: 7, startIndex: 2, endIndex: 2 + ids.length, messages: managerContext(manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
}
async function buildL1(membrane: unknown, opts: L1Opts = {}) {
  const strategy = new ProbeStrategy(l1Config(opts));
  const manager = await ContextManager.open({ path: opts.path ?? freshPath(), strategy, membrane: membrane as never });
  // An earlier span with its L1, so the canonical request carries a recall
  // pair that source-only-final's doesn't.
  const earlier = [0, 1].map((i) => manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`earlier-${i} ` + 'substantive '.repeat(12))]));
  if (!strategy.entries().some((entry) => entry.id === 'L1-100')) {
    strategy.seed({ id: 'L1-100', level: 1, content: 'authored L1-100', tokens: 20, sourceLevel: 0, sourceIds: earlier, sourceRange: { first: earlier[0]!, last: earlier[1]! }, created: 100 });
  }
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
  return { manager, strategy, ids, target: chunkOf(manager, ids) };
}
/** The request with its model taken out, to compare two requests that should differ in nothing else. */
const withoutModel = (request: NormalizedRequest) => ({ ...request, config: { ...request.config, model: undefined } });

async function withCompressionLog<T>(run: (events: () => Array<{ event?: string; metadata?: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const logPath = `${freshPath()}-trace.jsonl`;
  paths.push(logPath);
  const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
  try {
    return await run(() => readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
  }
}

describe('fallback-model rung: L1', () => {
  it('own model refuses every rung, the fallback answers: the memory is stored with its model recorded, nothing is quarantined and the split rung does not run', async () => {
    await withCompressionLog(async (events) => {
      const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [ok('memory by the other model', [THINKING])] });
      const fx = await buildL1(mock.membrane, { fallbackModel: OTHER, split: true });
      await fx.strategy.run(fx.target, managerContext(fx.manager));

      assert.deepEqual(mock.models(), [OWN, OWN, OTHER], 'canonical, source-only-final, then the fallback model once');
      assert.ok(mock.calls.every((call) => targets(call) === 4), 'no split sub-request was sent');
      assert.deepEqual(withoutModel(mock.calls[2]!), withoutModel(mock.calls[0]!), 'the canonical request, only its model changed');
      assert.notDeepEqual(withoutModel(mock.calls[2]!), withoutModel(mock.calls[1]!), 'and not source-only-final\'s');

      assert.ok(mock.calls[1]!.messages.length < mock.calls[0]!.messages.length, 'the second call was source-only-final');
      const entries = fx.strategy.entries().filter((e) => e.id !== 'L1-100');
      assert.equal(entries.length, 1);
      const entry = entries[0]!;
      assert.equal(entry.level, 1);
      assert.equal(entry.sourceLevel, 0);
      assert.deepEqual(entry.sourceIds, fx.ids, 'the same lineage as a normal L1 over the chunk');
      assert.deepEqual(entry.sourceRange, { first: fx.ids[0], last: fx.ids[3] });
      assert.equal(entry.content, 'memory by the other model');
      assert.equal(entry.tokens, 37, "stamped with the response's own output tokens");
      assert.equal(entry.responseContent, undefined, "text alone: the other model's signed reasoning is not kept for replay");
      assert.equal(entry.stitched, undefined);
      assert.equal(entry.provenance?.model, OTHER, 'the producing model is recorded');
      assert.equal(entry.provenance?.stopReason, 'end_turn');
      assert.equal(fx.target.compressed, true);
      assert.equal(fx.target.summaryId, entry.id);
      assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);

      const rung = events().filter((e) => e.event === 'compression:fallback-model');
      assert.equal(rung.length, 1, 'one compression-log event for the rung');
      assert.equal(rung[0]!.metadata?.model, OWN);
      assert.equal(rung[0]!.metadata?.fallback_model, OTHER);
      assert.equal(rung[0]!.metadata?.outcome, 'success');
      const receipt = events().find((e) => e.event === undefined && e.metadata?.summary_id === entry.id);
      assert.equal(receipt?.metadata?.model, OTHER, "the call's receipt names the model that wrote the summary, as the entry does");
      await fx.manager.close();
    });
  });

  it('a memory the compression model writes itself names that model, with the option set', async () => {
    const mock = byModel({ [OWN]: [ok('own memory')] });
    const fx = await buildL1(mock.membrane, { fallbackModel: OTHER });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.deepEqual(mock.models(), [OWN]);
    assert.equal(fx.strategy.entries().at(-1)!.provenance?.model, OWN);
    await fx.manager.close();
  });

  it('the fallback refuses too: quarantine as without the option, after one extra call', async () => {
    const without = byModel({ [OWN]: [REFUSAL] });
    const a = await buildL1(without.membrane);
    await a.strategy.run(a.target, managerContext(a.manager));

    const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [REFUSAL] });
    const b = await buildL1(mock.membrane, { fallbackModel: OTHER });
    await b.strategy.run(b.target, managerContext(b.manager));

    assert.deepEqual(without.models(), [OWN, OWN]);
    assert.deepEqual(mock.models(), [OWN, OWN, OTHER]);
    assert.equal(b.strategy.entries().length, 1, 'only the seeded L1');
    assert.equal(b.strategy.getCompressionQuarantineStatus().count, a.strategy.getCompressionQuarantineStatus().count);
    assert.equal(b.strategy.getCompressionQuarantineStatus().count, 1);
    assert.equal(b.target.compressed, false);
    // Quarantined: no further call.
    await b.strategy.run(b.target, managerContext(b.manager));
    assert.equal(mock.calls.length, 3);
    await a.manager.close();
    await b.manager.close();
  });

  it('the fallback refuses too, split rung on: the split rung follows and its stitched memory names the compression model', async () => {
    // The compression model refuses two or more target messages and folds one.
    const own = (request: NormalizedRequest): Answer => (targets(request) >= 2 ? REFUSAL : ok(`piece:${texts(request).find((t) => /^raw-\d+ /.test(t))!.split(' ')[0]}`));
    const mock = byModel({ [OWN]: own, [OTHER]: [REFUSAL] });
    const fx = await buildL1(mock.membrane, { fallbackModel: OTHER, split: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.deepEqual(mock.models().slice(0, 3), [OWN, OWN, OTHER]);
    assert.ok(mock.calls.slice(0, 3).every((call) => targets(call) === 4), 'whole-chunk requests come first');
    assert.ok(mock.calls.slice(3).length > 0 && mock.calls.slice(3).every((call) => modelOf(call) === OWN && targets(call) < 4), 'then the split rung, on the compression model');
    const entry = fx.strategy.entries().at(-1)!;
    assert.ok(entry.stitched, 'the split rung wrote the memory');
    assert.equal(entry.provenance?.model, OWN);
    await fx.manager.close();
  });

  it('option unset: no extra call', async () => {
    const mock = byModel({ [OWN]: [REFUSAL] });
    const fx = await buildL1(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.deepEqual(mock.models(), [OWN, OWN], 'canonical and source-only-final');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1);
    await fx.manager.close();
  });

  it('a failure that is not a refusal does not lead to the rung', async () => {
    const cases: Array<{ name: string; own: Answer[]; calls: number }> = [
      { name: 'canonical truncated', own: [TRUNCATED, REFUSAL], calls: 2 },
      { name: 'source-only-final truncated after a canonical refusal', own: [REFUSAL, TRUNCATED], calls: 2 },
      { name: 'canonical rejected by the provider', own: [{ throw: Object.assign(new Error('zz rejected'), { type: 'invalid_request', httpStatus: 400, retryable: false }) }, REFUSAL], calls: 2 },
      { name: 'source-only-final rejected by the provider', own: [REFUSAL, { throw: Object.assign(new Error('zz rejected'), { type: 'invalid_request', httpStatus: 400, retryable: false }) }], calls: 2 },
    ];
    for (const c of cases) {
      const mock = byModel({ [OWN]: c.own, [OTHER]: [ok('must not be asked')] });
      const fx = await buildL1(mock.membrane, { fallbackModel: OTHER });
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.deepEqual(mock.models(), Array(c.calls).fill(OWN), `${c.name}: the fallback model is not asked`);
      assert.equal(fx.strategy.entries().length, 1, `${c.name}: only the seeded L1`);
      assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, `${c.name}: quarantined as before`);
      await fx.manager.close();
    }
    // An overload on the compression model interrupts the ladder as before.
    const overloaded = byModel({ [OWN]: [REFUSAL, { throw: { type: 'server_error' } }], [OTHER]: [ok('must not be asked')] });
    const fx = await buildL1(overloaded.membrane, { fallbackModel: OTHER });
    await assert.rejects(fx.strategy.run(fx.target, managerContext(fx.manager)), (error: unknown) => (error as { type?: unknown }).type === 'server_error');
    assert.deepEqual(overloaded.models(), [OWN, OWN]);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    await fx.manager.close();
  });

  it('setting the option gives an already-quarantined chunk a fresh attempt without a manual clear', async () => {
    const path = freshPath();
    const first = byModel({ [OWN]: [REFUSAL] });
    const a = await buildL1(first.membrane, { path });
    await a.strategy.run(a.target, managerContext(a.manager));
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 1);
    // Same regime: sticky, no new call.
    await a.strategy.run(a.target, managerContext(a.manager));
    assert.equal(first.calls.length, 2);
    await a.manager.close();

    const second = byModel({ [OWN]: [REFUSAL], [OTHER]: [ok('fresh family')] });
    const strategy = new ProbeStrategy(l1Config({ fallbackModel: OTHER }));
    const manager = await ContextManager.open({ path, strategy, membrane: second.membrane });
    const target = chunkOf(manager, a.ids);
    await strategy.run(target, managerContext(manager));
    assert.deepEqual(second.models(), [OWN, OWN, OTHER], 'the whole ladder again, then the fallback model');
    const entry = strategy.entries().at(-1)!;
    assert.equal(entry.content, 'fresh family');
    assert.equal(entry.provenance?.model, OTHER);
    assert.equal(strategy.getCompressionQuarantineStatus().count, 0, 'the debt is paid');
    await manager.close();
  });
});

async function buildMerge(membrane: unknown, options: Record<string, unknown> = {}) {
  const strategy = new ProbeStrategy({
    compressionModel: OWN, hierarchical: true, targetChunkTokens: 100_000, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, mergeThreshold: 99, quarantineAlarmIntervalMs: 0, mergeAttemptLimit: 3,
    ...options,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substance '.repeat(10))]));
  const l1 = (id: string, a: number, b: number): SummaryEntry => ({
    id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
    sourceIds: [ids[a]!, ids[b]!], sourceRange: { first: ids[a]!, last: ids[b]! }, created: 1,
  });
  const sourceIds = ['L1-100', 'L1-101'];
  strategy.seed(l1('L1-100', 0, 1));
  strategy.seed(l1('L1-101', 2, 3));
  strategy.qMerge(2, sourceIds);
  const tick = async (times: number) => { for (let i = 0; i < times; i++) await strategy.tick(managerContext(manager)); };
  return { manager, strategy, ids, sourceIds, tick };
}

describe('fallback-model rung: merges', () => {
  it('own model refuses every attempt, the fallback answers: the merge is written as text alone, with its model recorded', async () => {
    await withCompressionLog(async (events) => {
      const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [ok('merged by the other model', [THINKING])] });
      const fx = await buildMerge(mock.membrane, { compressionFallbackModel: OTHER });
      await fx.tick(3);
      assert.deepEqual(mock.models(), [OWN, OWN, OWN]);
      assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0, 'not quarantined at the limit');
      assert.equal(fx.strategy.queue().length, 1, 'the entry stays queued for the rung');

      await fx.tick(1);
      assert.deepEqual(mock.models(), [OWN, OWN, OWN, OTHER]);
      assert.deepEqual(withoutModel(mock.calls[3]!), withoutModel(mock.calls[0]!), "the first attempt's request, only its model changed");
      assert.notDeepEqual(withoutModel(mock.calls[1]!), withoutModel(mock.calls[0]!), 'the retries between them sent other requests');

      const parent = fx.strategy.entries().find((s) => s.level === 2)!;
      assert.ok(parent, 'the merge is written');
      assert.equal(parent.content, 'merged by the other model');
      assert.equal(parent.sourceLevel, 1);
      assert.deepEqual(parent.sourceIds, fx.sourceIds);
      assert.deepEqual(parent.sourceRange, { first: fx.ids[0], last: fx.ids[3] });
      assert.equal(parent.tokens, 37);
      assert.equal(parent.responseContent, undefined, "text alone: the other model's signed reasoning is not kept for replay");
      assert.equal(parent.provenance?.model, OTHER);
      for (const id of fx.sourceIds) assert.equal(fx.strategy.entries().find((s) => s.id === id)!.mergedInto, parent.id);
      assert.equal(fx.strategy.queue().length, 0);
      assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0);

      const rung = events().filter((e) => e.event === 'merge:fallback-model');
      assert.equal(rung.length, 1, 'one compression-log event for the rung');
      assert.equal(rung[0]!.metadata?.fallback_model, OTHER);
      await fx.manager.close();
    });
  });

  it('the fallback refuses too: quarantined as without the option, after one extra call', async () => {
    const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [REFUSAL] });
    const fx = await buildMerge(mock.membrane, { compressionFallbackModel: OTHER });
    await fx.tick(4);
    assert.deepEqual(mock.models(), [OWN, OWN, OWN, OTHER]);
    assert.equal(fx.strategy.entries().filter((s) => s.level === 2).length, 0);
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 1);
    assert.equal(fx.strategy.getMergeQuarantineStatus().records[0]!.lastOutcome, 'refusal');
    assert.equal(fx.strategy.queue().length, 0);
    await fx.tick(2);
    assert.equal(mock.calls.length, 4, 'no further call');
    await fx.manager.close();
  });

  it("the fallback model's call fails with an overload: the lane pauses on that model, and no tick calls it again inside the pause", async () => {
    const overload = Object.assign(new Error('zz overloaded'), { type: 'server_error' });
    const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [{ throw: overload }] });
    const fx = await buildMerge(mock.membrane, { compressionFallbackModel: OTHER });
    await fx.tick(3);
    await assert.rejects(fx.tick(1), /zz overloaded/);
    assert.deepEqual(mock.models(), [OWN, OWN, OWN, OTHER]);
    await fx.tick(3);
    assert.equal(mock.calls.length, 4, 'the backoff holds the lane: nothing is sent');
    assert.match(fx.strategy.checkReadiness().description ?? '', /compression paused/, 'and readiness names the pause');
    assert.equal(fx.strategy.queue().length, 1, 'the merge stays queued for the rung');
    await fx.manager.close();
  });

  it('option unset: quarantined at the limit with no extra call', async () => {
    const mock = byModel({ [OWN]: [REFUSAL] });
    const fx = await buildMerge(mock.membrane);
    await fx.tick(5);
    assert.deepEqual(mock.models(), [OWN, OWN, OWN]);
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 1);
    await fx.manager.close();
  });

  it('an attempt that ended otherwise than in a refusal does not lead to the rung', async () => {
    for (const own of [[REFUSAL, TRUNCATED, REFUSAL], [REFUSAL, REFUSAL, TRUNCATED]] as Answer[][]) {
      const mock = byModel({ [OWN]: own, [OTHER]: [ok('must not be asked')] });
      const fx = await buildMerge(mock.membrane, { compressionFallbackModel: OTHER });
      await fx.tick(5);
      assert.deepEqual(mock.models(), [OWN, OWN, OWN]);
      assert.equal(fx.strategy.entries().filter((s) => s.level === 2).length, 0);
      assert.equal(fx.strategy.getMergeQuarantineStatus().count, 1);
      await fx.manager.close();
    }
  });
});
