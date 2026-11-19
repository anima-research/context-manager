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

/** The lane's own backoff ceiling: the longest hold of its model the fallback-model rung waits out. */
const CEILING = AutobiographicalStrategy.COMPRESSION_PAUSE_MAX_BACKOFF_MS;
const WEEK = 7 * 24 * 3_600_000;
/** A provider's rate limit, stating its wait. */
const rateLimited = (retryAfterMs: number) =>
  Object.assign(new Error('zz rate limited'), { type: 'rate_limit', httpStatus: 429, retryable: true, retryAfterMs });
/** The caller's provider admission refusing a call to a held model: no call was made. */
const deferred = (retryAfterMs?: number) => Object.assign(
  new Error('zz the model is held; no call was made'),
  { type: 'rate_limit', retryable: true, providerAdmission: 'deferred', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
);

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
  private lanePause(): { model: string | undefined; backoffUntil: number; statedUntil: number | null } | null {
    return (this as unknown as { compressionPause: { model: string | undefined; backoffUntil: number; statedUntil: number | null } | null }).compressionPause;
  }
  /** The lane's pause (white-box): the model it is on, or null when there is none. */
  pause(): { model: string | undefined } | null {
    const pause = this.lanePause();
    return pause ? { model: pause.model } : null;
  }
  /** Stand for time passing: the pause has ended. */
  expirePause(): void {
    const pause = this.lanePause();
    if (!pause) return;
    pause.backoffUntil = 0;
    if (pause.statedUntil !== null) pause.statedUntil = 0;
  }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

interface L1Opts { fallbackModel?: string; split?: boolean; path?: string; contextBudget?: number }
function l1Config(opts: L1Opts) {
  return {
    compressionModel: OWN, targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, quarantineAlarmIntervalMs: 0,
    compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
    ...(opts.split ? { compressionSplitFallback: true } : {}),
    ...(opts.fallbackModel ? { compressionFallbackModel: opts.fallbackModel } : {}),
    ...(opts.contextBudget ? { compressionContextBudgetTokens: opts.contextBudget } : {}),
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

  it('setting the option gives an already-quarantined chunk a fresh attempt without a manual clear, though its old regime has filled the shape cap', async () => {
    const path = freshPath();
    const first = byModel({ [OWN]: [REFUSAL] });
    const a = await buildL1(first.membrane, { path });
    await a.strategy.run(a.target, managerContext(a.manager));
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 1);
    // Same regime: sticky, no new call.
    await a.strategy.run(a.target, managerContext(a.manager));
    assert.equal(first.calls.length, 2);
    await a.manager.close();

    const reopened = async (opts: L1Opts, script: Parameters<typeof byModel>[0]) => {
      const mock = byModel(script);
      const strategy = new ProbeStrategy(l1Config(opts));
      const manager = await ContextManager.open({ path, strategy, membrane: mock.membrane });
      await strategy.run(chunkOf(manager, a.ids), managerContext(manager));
      return { mock, strategy, manager };
    };
    // Each context budget is another request shape of the same chunk: with
    // the first, three fill the regime's cap, which then holds a fourth.
    for (const contextBudget of [101_000, 102_000]) {
      const shape = await reopened({ contextBudget }, { [OWN]: [REFUSAL] });
      assert.equal(shape.mock.calls.length, 2, `premise: the shape at ${contextBudget} is attempted`);
      await shape.manager.close();
    }
    const held = await reopened({ contextBudget: 103_000 }, { [OWN]: [REFUSAL] });
    assert.equal(held.mock.calls.length, 0, 'premise: a fourth shape without the option is held by the cap');
    await held.manager.close();

    const fresh = await reopened({ contextBudget: 103_000, fallbackModel: OTHER }, { [OWN]: [REFUSAL], [OTHER]: [ok('fresh family')] });
    assert.deepEqual(fresh.mock.models(), [OWN, OWN, OTHER], 'the whole ladder again, then the fallback model');
    const entry = fresh.strategy.entries().at(-1)!;
    assert.equal(entry.content, 'fresh family');
    assert.equal(entry.provenance?.model, OTHER);
    assert.equal(fresh.strategy.getCompressionQuarantineStatus().count, 0, 'the debt is paid');
    await fresh.manager.close();
  });

  it('the fallback model is held for a week: its rung is given up with no lane pause, the chunk is quarantined, and the chunk queued behind it is compressed next', async () => {
    await withCompressionLog(async (events) => {
      // Two chunks queued, taken by tick. The compression model refuses the
      // first and writes the second, whose request alone reaches raw-7.
      const own = (request: NormalizedRequest): Answer =>
        (texts(request).some((t) => t.startsWith('raw-7 ')) ? ok('memory of the chunk behind') : REFUSAL);
      const mock = byModel({ [OWN]: own, [OTHER]: [{ throw: rateLimited(WEEK) }] });
      const strategy = new ProbeStrategy({
        compressionModel: OWN, compressionFallbackModel: OTHER, targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0,
        autoTickOnNewMessage: false, l1HoldbackChunks: 0, minChunkCharsForLLM: 0, mergeThreshold: 99, quarantineAlarmIntervalMs: 0,
        compressionRefusalCurveFallbacks: 0,
      } as never);
      const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: mock.membrane });
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'word '.repeat(30))]));

      await strategy.tick(managerContext(manager));
      assert.deepEqual(mock.models(), [OWN, OTHER], 'the first chunk: the canonical, then the fallback model once');
      assert.equal(strategy.pause(), null, 'the hold pauses nothing');
      const status = strategy.getCompressionQuarantineStatus();
      assert.equal(status.count, 1, 'the chunk is quarantined, as after the fallback model\'s refusal');
      assert.equal(status.spans[0]!.latestOutcome, 'provider_error:persistent-rate_limit:429', 'the rung is decided, and not as a refusal');
      const rung = events().filter((e) => e.event === 'compression:fallback-model');
      assert.equal(rung.length, 1);
      assert.equal(rung[0]!.metadata?.outcome, 'provider_error');
      assert.match(String(rung[0]!.metadata?.held_until), /^\d{4}-\d\d-\d\dT/, 'the event says until when the model is held');

      await strategy.tick(managerContext(manager));
      assert.deepEqual(mock.models(), [OWN, OTHER, OWN], 'the next tick takes the chunk behind, on the compression model');
      const behind = strategy.entries().find((entry) => entry.content === 'memory of the chunk behind');
      assert.ok(behind, 'the chunk behind is compressed');
      assert.equal(behind!.sourceIds.at(-1), ids[7]);
      assert.equal(behind!.provenance?.model, OWN);

      await strategy.tick(managerContext(manager));
      await strategy.tick(managerContext(manager));
      assert.equal(mock.calls.length, 3, 'the rung is decided for the request: no later tick asks the fallback model again');
      await manager.close();
    });
  });

  it("a hold with no end, and the caller's admission deferring the call for long or with no deadline, give the rung up the same way, and it stays decided across a restart", async () => {
    const holds: Array<[string, unknown]> = [
      ["a stated wait that can't be held as an instant", rateLimited(Number.POSITIVE_INFINITY)],
      ['an admission deferral whose deadline is a week away', deferred(WEEK)],
      ['an admission deferral that gives no deadline', deferred()],
    ];
    for (const [name, hold] of holds) {
      const path = freshPath();
      const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [{ throw: hold }] });
      const fx = await buildL1(mock.membrane, { fallbackModel: OTHER, path });
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.deepEqual(mock.models(), [OWN, OWN, OTHER], `${name}: canonical, source-only-final, then the fallback model once`);
      assert.equal(fx.strategy.pause(), null, `${name}: no pause`);
      assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, `${name}: quarantined`);
      assert.equal(fx.target.compressed, false);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 3, `${name}: decided, so nothing is sent again`);
      await fx.manager.close();

      const restarted = byModel({ [OWN]: [REFUSAL], [OTHER]: [ok('must not be asked')] });
      const strategy = new ProbeStrategy(l1Config({ fallbackModel: OTHER }));
      const manager = await ContextManager.open({ path, strategy, membrane: restarted.membrane });
      await strategy.run(chunkOf(manager, fx.ids), managerContext(manager));
      assert.equal(restarted.calls.length, 0, `${name}: nor after a restart`);
      await manager.close();
    }
  });

  it('held for a week with the split rung on: the split rung follows, as after a refusal, and its stitched memory names the compression model', async () => {
    const own = (request: NormalizedRequest): Answer => (targets(request) >= 2 ? REFUSAL : ok(`piece:${texts(request).find((t) => /^raw-\d+ /.test(t))!.split(' ')[0]}`));
    const mock = byModel({ [OWN]: own, [OTHER]: [{ throw: rateLimited(WEEK) }] });
    const fx = await buildL1(mock.membrane, { fallbackModel: OTHER, split: true });
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.deepEqual(mock.models().slice(0, 3), [OWN, OWN, OTHER]);
    assert.ok(mock.calls.slice(3).length > 0 && mock.calls.slice(3).every((call) => modelOf(call) === OWN && targets(call) < 4), 'then the split rung, on the compression model');
    const entry = fx.strategy.entries().at(-1)!;
    assert.ok(entry.stitched, 'the split rung wrote the memory');
    assert.equal(entry.provenance?.model, OWN);
    assert.equal(fx.strategy.pause(), null);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    await fx.manager.close();
  });

  it("the line is the lane's backoff ceiling: a wait that ends within it pauses the lane and the ladder resumes at the rung, and one past it gives the rung up", async () => {
    const within: Array<[string, unknown]> = [
      ['a stated wait at the ceiling', rateLimited(CEILING)],
      ['an admission deferral with a deadline a minute away', deferred(60_000)],
    ];
    for (const [name, wait] of within) {
      const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [{ throw: wait }, ok('written after the wait')] });
      const fx = await buildL1(mock.membrane, { fallbackModel: OTHER });
      await assert.rejects(fx.strategy.run(fx.target, managerContext(fx.manager)), /^Error: zz /, `${name}: the failure interrupts the ladder`);
      assert.equal(fx.strategy.pause()?.model, OTHER, `${name}: the lane is paused on the fallback model`);
      assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, `${name}: nothing is decided`);
      fx.strategy.expirePause();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.deepEqual(mock.models(), [OWN, OWN, OTHER, OTHER], `${name}: resumed at the rung, the compression model's rungs not paid again`);
      const entry = fx.strategy.entries().at(-1)!;
      assert.equal(entry.content, 'written after the wait');
      assert.equal(entry.provenance?.model, OTHER);
      await fx.manager.close();
    }

    const mock = byModel({ [OWN]: [REFUSAL], [OTHER]: [{ throw: rateLimited(CEILING + 1) }] });
    const fx = await buildL1(mock.membrane, { fallbackModel: OTHER });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.deepEqual(mock.models(), [OWN, OWN, OTHER]);
    assert.equal(fx.strategy.pause(), null, 'a millisecond past the ceiling: no pause');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'and the rung is given up');
    await fx.manager.close();
  });
});

async function buildMerge(membrane: unknown, options: Record<string, unknown> = {}, behind = false) {
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
  if (behind) {
    // A second merge, queued behind the first.
    strategy.seed(l1('L1-102', 4, 5));
    strategy.seed(l1('L1-103', 6, 7));
    strategy.qMerge(2, ['L1-102', 'L1-103']);
  }
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

  it("the fallback model is held for long on a merge's rung: the group is quarantined as after its refusal, with no lane pause, and the merge queued behind it runs next", async () => {
    const holds: Array<[string, unknown]> = [
      ["a week's stated wait", rateLimited(WEEK)],
      ['an admission deferral that gives no deadline', deferred()],
    ];
    for (const [name, hold] of holds) {
      // The compression model refuses the first merge's three attempts, then writes the second merge.
      const mock = byModel({ [OWN]: [REFUSAL, REFUSAL, REFUSAL, ok('the merge behind')], [OTHER]: [{ throw: hold }] });
      const fx = await buildMerge(mock.membrane, { compressionFallbackModel: OTHER }, true);
      await fx.tick(4);
      assert.deepEqual(mock.models(), [OWN, OWN, OWN, OTHER], `${name}: three attempts, then the fallback model once`);
      assert.equal(fx.strategy.pause(), null, `${name}: no pause`);
      const status = fx.strategy.getMergeQuarantineStatus();
      assert.equal(status.count, 1, `${name}: the group is quarantined`);
      assert.deepEqual(status.records[0]!.sourceIds, fx.sourceIds);
      assert.equal(status.records[0]!.lastOutcome, 'provider_error', `${name}: decided, and not as a refusal`);
      assert.deepEqual(fx.strategy.queue().map((merge) => merge.sourceIds), [['L1-102', 'L1-103']], `${name}: it has left the head of the queue`);

      await fx.tick(1);
      assert.deepEqual(mock.models(), [OWN, OWN, OWN, OTHER, OWN], `${name}: the merge behind runs on the compression model`);
      const parent = fx.strategy.entries().find((s) => s.level === 2)!;
      assert.ok(parent, `${name}: and is written`);
      assert.deepEqual(parent.sourceIds, ['L1-102', 'L1-103']);
      assert.equal(parent.provenance?.model, OWN);
      await fx.tick(2);
      assert.equal(mock.calls.length, 5, `${name}: decided, so the fallback model is not asked again`);
      await fx.manager.close();
    }
  });

  it("a merge's rung draws the same line: a stated wait within the lane's backoff ceiling pauses the lane and the rung is asked again, and one past it quarantines the group", async () => {
    const within = byModel({ [OWN]: [REFUSAL], [OTHER]: [{ throw: rateLimited(CEILING) }, ok('merged after the wait')] });
    const a = await buildMerge(within.membrane, { compressionFallbackModel: OTHER });
    await a.tick(3);
    await assert.rejects(a.tick(1), /zz rate limited/);
    assert.equal(a.strategy.pause()?.model, OTHER, 'the lane is paused on the fallback model');
    assert.equal(a.strategy.queue().length, 1, 'and the entry stays queued for the rung');
    assert.equal(a.strategy.queue()[0]!.attempts, 3, 'with no attempt counted');
    await a.tick(2);
    assert.equal(within.calls.length, 4, 'nothing is sent inside the wait');
    a.strategy.expirePause();
    await a.tick(1);
    assert.deepEqual(within.models(), [OWN, OWN, OWN, OTHER, OTHER], 'the rung is asked again once the wait ends');
    const parent = a.strategy.entries().find((s) => s.level === 2)!;
    assert.equal(parent.content, 'merged after the wait');
    assert.equal(parent.provenance?.model, OTHER);
    await a.manager.close();

    const past = byModel({ [OWN]: [REFUSAL], [OTHER]: [{ throw: rateLimited(CEILING + 1) }] });
    const b = await buildMerge(past.membrane, { compressionFallbackModel: OTHER });
    await b.tick(4);
    assert.deepEqual(past.models(), [OWN, OWN, OWN, OTHER]);
    assert.equal(b.strategy.pause(), null, 'a millisecond past the ceiling: no pause');
    assert.equal(b.strategy.getMergeQuarantineStatus().count, 1, 'and the group is quarantined');
    assert.equal(b.strategy.queue().length, 0);
    await b.manager.close();
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
