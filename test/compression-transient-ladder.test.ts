import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { boundFailureLogText } from '../src/strategies/autobiographical.js';
import { createHash } from 'node:crypto';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

// Transient failures never spend the ladder (room-225 L3, brosefo incident).
//
// A provider failure that is not evidence about the request (capacity,
// transport, credentials, anything unclassified) used to be recorded as a
// rung's `provider_error` and the ladder carried on, so an outage could
// exhaust a viable family into quarantine. And between ticks nothing paced
// the lane: a 429 asking for 30 s was retried on every maintenance pass.
// Now: a deterministic rejection is a rung's outcome; a transient failure
// stops the ladder, keeps its durable progress, pauses the lane and
// resumes at the interrupted rung on a later tick.

const BASE = './test-compression-transient-ladder';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
after(() => { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); });

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name, input } as ContentBlock);
const result = (id: string, content: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content } as ContentBlock);
const DIARY = 'I weighed the thread and decided to stay quiet. '.repeat(12);

const REFUSAL = { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
const OK = (t: string) => ({ content: [text(t)], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } });
const failure = (type: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`zz ${type} failure`), { type, retryable: type !== 'context_length' && type !== 'invalid_request', ...extra });

type Step = typeof REFUSAL | ReturnType<typeof OK> | { throw: unknown } | { gate: Promise<void>; then: Step };
function scripted(steps: Step[]) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        let step = steps[Math.min(calls.length, steps.length - 1)]!;
        calls.push(structuredClone(request));
        while ('gate' in step) { await step.gate; step = step.then; }
        if ('throw' in step) throw step.throw;
        return step;
      },
    } as never,
  };
}

interface RawPause { backoffUntil: number; statedUntil: number | null; statedBy: 'provider' | 'admission' | null; failures: number; model: string | undefined; reason: string }

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  summariesView(): SummaryEntry[] { return [...this.summaries]; }
  chunksView(): Chunk[] { return [...this.chunks]; }
  compressionQueueView(): number[] { return [...this.compressionQueue]; }
  setCompressionModel(model: string): void { this.config.compressionModel = model; }
  private lanePause(): RawPause | null {
    return (this as unknown as { compressionPause: RawPause | null }).compressionPause;
  }
  /** The lane's pause as it binds: the later of its backoff and the provider's stated wait. */
  pause(): (RawPause & { until: number; source: 'retry-after' | 'backoff' }) | null {
    const pause = this.lanePause();
    if (!pause) return null;
    const until = Math.max(pause.backoffUntil, pause.statedUntil ?? 0);
    const source = pause.statedUntil !== null && pause.statedUntil > pause.backoffUntil ? 'retry-after' : 'backoff';
    return { ...pause, until, source };
  }
  /** Whether the lane is paused now (a pause whose constraints have all passed binds nothing). */
  paused(): boolean {
    const pause = this.pause();
    return pause !== null && pause.until > Date.now();
  }
  /** Stand for time passing: every finite constraint has elapsed. */
  expirePause(): void {
    const pause = this.lanePause();
    if (!pause) return;
    pause.backoffUntil = 0;
    if (pause.statedUntil !== null && Number.isFinite(pause.statedUntil)) pause.statedUntil = 0;
  }
  /** Note a transient failure as the lane does (white-box: a concurrent operation's error). */
  notePause(error: unknown, ctx: StrategyContext): void {
    const self = this as unknown as {
      captureCompressionBranch(): unknown;
      pauseCompressionLane(source: unknown, ctx: StrategyContext, error: unknown, lane: 'l1' | 'merge'): void;
    };
    self.pauseCompressionLane(self.captureCompressionBranch(), ctx, error, 'l1');
  }
  /** Set the pause's constraints relative to now (white-box clock for the release seam). */
  shiftPause(backoffFromNow: number, statedFromNow: number | null): void {
    const pause = this.lanePause()!;
    pause.backoffUntil = Date.now() + backoffFromNow;
    pause.statedUntil = statedFromNow === null ? null : Date.now() + statedFromNow;
  }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}
/** The strategy's request identity (sha256 of the request's JSON). */
const sha256 = (request: NormalizedRequest): string => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const tool = (name: string): ToolDefinition => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} } } as never);
const progressSlot = (manager: ContextManager): unknown[] => {
  const value = manager.getStore().getStateJson('default/autobio:compression-family-progress');
  return Array.isArray(value) ? value : [];
};

interface Opts { hoist?: boolean; sourceOnlyFallback?: boolean; path?: string }
function config(opts: Opts) {
  return {
    compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, quarantineAlarmIntervalMs: 0,
    compressionRefusalCurveFallbacks: 0,
    compressionSourceOnlyFallback: opts.sourceOnlyFallback,
    ...(opts.hoist ? { compressionToolProseFallback: { intoTool: 'journal', fromTools: ['skip_reply'] } } : {}),
  } as never;
}
/** The tool-prose-hoist fixture's shape: a head, one seeded L1, and a target chunk with a long skip_reply. */
async function build(membrane: unknown, opts: Opts = {}) {
  const path = opts.path ?? freshPath();
  const strategy = new ProbeStrategy(config(opts));
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
  let ids: string[] = manager.queryMessages({}).messages.map((m) => m.id);
  if (ids.length === 0) {
    for (let i = 0; i < 10; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
    ids.push(manager.addMessage('User', [text('raw-10 ambient chatter ' + 'substantive '.repeat(12))]));
    ids.push(manager.addMessage('Claude', [use('skip1', 'skip_reply', { reason: DIARY, wake_in_seconds: 1500 })]));
    ids.push(manager.addMessage('User', [result('skip1', '{"skipped":true}')]));
    strategy.seed({ id: 'L1-100', level: 1, content: 'authored L1-100', tokens: 20, sourceLevel: 0, sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! }, created: 100 });
  }
  const target = (): Chunk => {
    const want = new Set(ids.slice(10));
    return { index: 999, startIndex: 10, endIndex: 13, messages: managerContext(manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
  };
  return { manager, strategy, ids, target, path };
}
/** The canonical carries the head (raw-2 onward; raw-0/1 render as their L1's recall pair); source-only-final carries only the chunk. */
const isCanonical = (request: NormalizedRequest): boolean =>
  request.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('raw-2 ')));
const toolNames = (request: NormalizedRequest): string =>
  [...new Set(request.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name)))].join('+');

describe('compression ladder: transient failures never spend it', () => {
  it('canonical rejection → source-only-final once; a 503 there interrupts; a restart resumes at source-only and mints, the canonical paid once', async () => {
    const path = freshPath();
    const first = scripted([{ throw: failure('context_length') }, { throw: failure('server', { httpStatus: 503 }) }]);
    const a = await build(first.membrane, { sourceOnlyFallback: true, path });
    await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    assert.equal(first.calls.length, 2);
    assert.ok(isCanonical(first.calls[0]!), 'the canonical first');
    assert.ok(!isCanonical(first.calls[1]!), 'then source-only-final, skipping variants and the canonical hoist');
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'a 503 does not exhaust the family');
    assert.equal(progressSlot(a.manager).length, 1, 'the canonical rejection is kept durably');
    a.manager.close();

    const second = scripted([OK('memory after the outage')]);
    const b = await build(second.membrane, { sourceOnlyFallback: true, path });
    await b.strategy.run(b.target(), managerContext(b.manager));
    assert.equal(second.calls.length, 1, 'only source-only-final: the canonical is not paid again');
    assert.ok(!isCanonical(second.calls[0]!));
    assert.ok(b.strategy.summariesView().some((s) => s.level === 1 && s.content === 'memory after the outage'));
    assert.equal(progressSlot(b.manager).length, 0, 'the mint drops the progress');
    b.manager.close();
  });

  it('a canonical rejection with no source-only rung exhausts after one call: no variants, no hoist', async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane, { hoist: true });
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 1);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'the family is exhausted');
    assert.equal(progressSlot(fx.manager).length, 0, 'the quarantine ledger holds it now, not progress');
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'and stays exhausted');
    fx.manager.close();
  });

  it('a refusal ladder interrupted at its second rung resumes there, without paying the canonical again', async () => {
    const mock = scripted([REFUSAL, { throw: failure('network') }, OK('hoisted memory')]);
    const fx = await build(mock.membrane, { hoist: true });
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.deepEqual(mock.calls.map(toolNames), ['skip_reply', 'journal+skip_reply']);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.deepEqual(mock.calls.map(toolNames), ['skip_reply', 'journal+skip_reply', 'journal+skip_reply'],
      'the canonical refusal is reused; the hoist runs again');
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'hoisted memory'));
    fx.manager.close();
  });

  it('server errors: the 12th consecutive one on the same request ends it deterministically, counted across a restart', async () => {
    const path = freshPath();
    const always503 = () => scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const first = always503();
    const a = await build(first.membrane, { path });
    for (let i = 0; i < 11; i++) {
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'eleven is below the bound');
    a.manager.close();

    const second = always503();
    const b = await build(second.membrane, { path });
    await b.strategy.run(b.target(), managerContext(b.manager));
    assert.equal(second.calls.length, 1, 'one more attempt after the restart');
    assert.equal(b.strategy.getCompressionQuarantineStatus().count, 1, 'the twelfth ends the family');
    b.manager.close();
  });

  it('progress is never written from stale-branch work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }]);
    const fx = await build(mock.membrane);
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt('zz-fork', main, fx.manager.getStore().currentSequence()).name;
    const run = fx.strategy.run(fx.target(), managerContext(fx.manager));
    while (mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await fx.manager.switchBranch(fork);
    release();
    await run;
    assert.equal(fx.strategy.pause(), null, 'a discarded failure installs no pause');
    assert.equal(progressSlot(fx.manager).length, 0);
    await fx.manager.switchBranch(main);
    assert.equal(progressSlot(fx.manager).length, 0);
    fx.manager.close();
  });
});

/** Real persisted raw chunks, queued by the strategy itself, so tick() does the work. */
async function queued(membrane: unknown) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model', targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, l1HoldbackChunks: 0, minChunkCharsForLLM: 0, mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'word '.repeat(30))]);
  return { strategy, manager };
}

describe('compression lane pacing', () => {
  it("a 429 pauses the lane for the provider's whole stated wait: no call and no queue item consumed until it ends", async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 120_000 }) }, OK('after the wait')]);
    const fx = await queued(mock.membrane);
    const before = Date.now();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz rate_limit failure/);
    assert.equal(mock.calls.length, 1);
    const pause = fx.strategy.pause()!;
    assert.ok(pause.until >= before + 120_000, 'the stated wait outlasts the 30 s backoff and is honoured whole');
    assert.equal(pause.source, 'retry-after');

    const queue = fx.strategy.compressionQueueView();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'no call while paused');
    assert.deepEqual(fx.strategy.compressionQueueView(), queue, 'no queue item consumed while paused');
    const readiness = fx.strategy.checkReadiness();
    assert.match(readiness.description ?? '', /compression paused until .+ \(the provider's stated wait, failure 1\)/);

    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'the next tick after the wait calls again');
    assert.equal(fx.strategy.pause(), null, 'an answer ends the pause');
    fx.manager.close();
  });

  it('the backoff doubles per failure from 30 s and caps at 10 minutes', async () => {
    const mock = scripted([{ throw: failure('network') }]);
    const fx = await queued(mock.membrane);
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      // Each failure consumes the chunk it tried; requeue to keep the lane busy.
      await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
      const start = Date.now();
      await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
      const pause = fx.strategy.pause()!;
      seen.push(Math.round((pause.until - start) / 1_000));
      assert.equal(pause.source, 'backoff');
      fx.strategy.expirePause();
    }
    assert.deepEqual(seen, [30, 60, 120, 240, 480, 600, 600]);
    fx.manager.close();
  });

  it('a different compression model ignores and clears an old pause', async () => {
    const mock = scripted([{ throw: failure('network') }, OK('other model memory')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    assert.ok(fx.strategy.pause());
    fx.strategy.setCompressionModel('other-model');
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'the other model is called');
    fx.manager.close();
  });

  it('the chunk failure log is a bounded string, never the error object with its request', async () => {
    const huge = Object.assign(new Error('zz short network failure'), {
      type: 'network', retryable: true, rawRequest: { system: 'x'.repeat(1_000_000) },
    });
    const mock = scripted([{ throw: huge }]);
    const fx = await build(mock.membrane);
    const calls: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { calls.push(args); };
    try {
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)));
    } finally { console.error = orig; }
    const line = calls.find((args) => typeof args[0] === 'string' && (args[0] as string).startsWith('Failed to compress chunk'));
    assert.ok(line, 'the failure is logged');
    for (const arg of line!) assert.equal(typeof arg, 'string', 'no object for the runtime to inspect');
    assert.ok((line![0] as string).length < 2_500);
    assert.match(line![0] as string, /Error \(network, retryable=true\): zz short network failure/);
    fx.manager.close();
  });
});

// ---------------------------------------------------------------------------
// Corrective round (Wren-1021's review of 3398926, room-225 #46214, #46271,
// #46345, #46385; Ruth-1049's surrogate-cut gap).
// ---------------------------------------------------------------------------

describe('progress is a shared record, not an instance snapshot (#46214 #1)', () => {
  /** A second strategy and manager on the same JsStore and namespace. */
  async function sibling(store: ReturnType<ContextManager['getStore']>, membrane: unknown, opts: Opts = {}) {
    const strategy = new ProbeStrategy(config(opts));
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
    return { strategy, manager };
  }

  it("a sibling strategy resumes at the rung another one was interrupted at, without paying the canonical again", async () => {
    const first = scripted([{ throw: failure('context_length') }, { throw: failure('server', { httpStatus: 503 }) }]);
    const a = await build(first.membrane, { sourceOnlyFallback: true });
    // B is initialized BEFORE A records anything: an instance snapshot taken
    // at initialize would be stale by the time B runs.
    const second = scripted([OK('memory from the sibling')]);
    const b = await sibling(a.manager.getStore(), second.membrane, { sourceOnlyFallback: true });
    await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    assert.equal(first.calls.length, 2);

    const bChunk = { ...a.target(), messages: a.target().messages.map((m) => managerContext(b.manager).messageStore.get(m.id)!) };
    await b.strategy.run(bChunk, managerContext(b.manager));
    assert.equal(second.calls.length, 1, 'the sibling read the durable canonical rejection');
    assert.ok(!isCanonical(second.calls[0]!), 'and went straight to source-only-final');
    a.manager.close();
  });

  it("each strategy's write keeps the other's families, and one's cleanup leaves the other's", async () => {
    const first = scripted([{ throw: failure('network') }]);
    const a = await build(first.membrane);
    // Both siblings are initialized before either records anything.
    const second = scripted([REFUSAL, { throw: failure('network') }]);
    const b = await sibling(a.manager.getStore(), second.membrane, { hoist: true });
    const third = scripted([OK('A minted')]);
    const a2 = await sibling(a.manager.getStore(), third.membrane);
    await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz network failure/);
    assert.equal(progressSlot(a.manager).length, 1);

    const want = new Set(a.ids.slice(6, 9));
    const other: Chunk = { index: 998, startIndex: 6, endIndex: 9, messages: managerContext(b.manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
    await assert.rejects(b.strategy.run(other, managerContext(b.manager)), /zz network failure/);
    assert.equal(progressSlot(a.manager).length, 2, "B's write kept A's family");

    // A's family mints (through a third sibling): its cleanup removes only its own entry.
    const aChunk = { ...a.target(), messages: a.target().messages.map((m) => managerContext(a2.manager).messageStore.get(m.id)!) };
    await a2.strategy.run(aChunk, managerContext(a2.manager));
    const left = progressSlot(a.manager) as Array<{ chunkSourceHash: string; outcomes: Array<{ curveLabel: string }> }>;
    assert.equal(left.length, 1, "A's cleanup left B's family");
    assert.deepEqual(left[0]!.outcomes.map((o) => o.curveLabel), ['canonical'], "B's canonical refusal is still known");
    a.manager.close();
  });
});

describe('the pause holds an unusable deadline explicitly (#46214 #2)', () => {
  it('a finite retry-after past the last Date instant is an indefinite hold: the provider error is what throws, and readiness says so', async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 1e20 }) }, OK('after the release')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz rate_limit failure/);
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, Number.POSITIVE_INFINITY);
    assert.equal(pause.source, 'retry-after');
    assert.match(fx.strategy.checkReadiness().description ?? '', /cannot be held as an instant/);
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'time passing does not end it');
    assert.equal(fx.strategy.releaseCompressionPause(), true, 'an explicit release does');
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });
});

describe('the pause belongs to the call that failed (#46271 #3)', () => {
  it('a failure dispatched to model A, landing after the model changed to B, pauses A, not B', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }, OK('B memory')]);
    const fx = await queued(mock.membrane);
    const tick = fx.strategy.tick(managerContext(fx.manager));
    while (mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(mock.calls[0]!.config.model, 'same-model');
    fx.strategy.setCompressionModel('zz-model-b');
    release();
    await assert.rejects(tick, /zz network failure/);
    assert.equal(fx.strategy.pause()?.model, 'same-model', 'the pause names the dispatched model');
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'model B is not held by A\'s failure');
    assert.equal(mock.calls[1]!.config.model, 'zz-model-b');
    fx.manager.close();
  });
});

describe("releasing the provider's wait keeps the lane's own backoff (#46385)", () => {
  async function pausedByStatedWait() {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 120_000 }) }, OK('after')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz rate_limit failure/);
    return { mock, fx };
  }
  const requeue = (fx: Awaited<ReturnType<typeof queued>>) =>
    fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));

  it('wait 120 s, backoff 30 s, release at 10 s: the remaining 20 s of backoff still pace the lane', async () => {
    const { mock, fx } = await pausedByStatedWait();
    fx.strategy.shiftPause(20_000, 110_000); // 10 s have passed
    assert.equal(fx.strategy.releaseCompressionPause('zz-other-model'), false, 'a release for another model leaves it');
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, null, 'only the provider-derived constraint is gone');
    assert.ok(pause.until > Date.now() + 19_000 && pause.until <= Date.now() + 20_000);
    await requeue(fx);
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'still paced by the backoff');
    assert.equal(fx.strategy.releaseCompressionPause(), false, 'nothing provider-derived left to release');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'and calls once the backoff has passed');
    fx.manager.close();
  });

  it('release after the backoff has elapsed: the lane resumes at once', async () => {
    const { mock, fx } = await pausedByStatedWait();
    fx.strategy.shiftPause(-1, 60_000); // the backoff passed; the stated wait still binds
    await requeue(fx);
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'held by the stated wait');
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    assert.equal(fx.strategy.paused(), false, 'nothing left to pace it');
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });
});

describe('the plain-prose retry is a rung of the durable ladder (#46345 #6)', () => {
  const THINKING = { content: [text('<thinking>all of it went here</thinking>')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
  const isProse = (request: NormalizedRequest): boolean => JSON.stringify(request).includes('plain prose');

  it('a transient failure of the retry interrupts there; the next run pays only for the retry', async () => {
    const mock = scripted([THINKING as never, { throw: failure('network') }, OK('prose memory')]);
    const fx = await build(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 2);
    const recorded = progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string }> }>;
    assert.deepEqual(recorded[0]!.outcomes.map((o) => [o.curveLabel, o.outcome]), [['canonical', 'unusable_empty']],
      "the canonical's empty answer is kept");
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'only the retry is called again');
    assert.ok(isProse(mock.calls[2]!), 'and it is the plain-prose request');
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && s.content === 'prose memory'));
    fx.manager.close();
  });

  it('a typed rejection of the retry is its outcome: the family exhausts and is never paid again', async () => {
    const mock = scripted([THINKING as never, { throw: failure('context_length') }]);
    const fx = await build(mock.membrane);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'no call after exhaustion');
    fx.manager.close();
  });
});

describe('the log bound never splits a surrogate pair at either cut', () => {
  it('a pair straddling the head cut or the tail cut, at every nearby position', () => {
    const n = 100_002;
    const max = 2_000;
    const marker = ` …[${n} of ${n} characters omitted]… `.length;
    const budget = max - marker;
    const tail = Math.floor(budget / 4);
    const headEnd = budget - tail;
    const tailStart = n - tail;
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const at of [-3, -2, -1, 0, 1].flatMap((d) => [headEnd + d, tailStart + d])) {
      const input = `${'x'.repeat(at)}😀${'x'.repeat(n - 2 - at)}`;
      const out = boundFailureLogText(input, max);
      assert.ok(out.length <= max, `length at ${at}`);
      assert.equal(lone.test(out), false, `no lone surrogate with the pair at ${at}`);
      const omitted = Number(/…\[(\d+) of \d+ characters omitted\]…/.exec(out)![1]);
      assert.equal(out.length - ` …[${omitted} of ${n} characters omitted]… `.length + omitted, n, `the omission count is exact at ${at}`);
    }
  });
});

describe('every rung keeps its own identity across a resume (#47653)', () => {
  const THINKING = { content: [text('<thinking>all of it went here</thinking>')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
  const TOOL_USE = { content: [use('t9', 'skip_reply', { reason: 'later' })], stopReason: 'tool_use', usage: { inputTokens: 80, outputTokens: 5 } };
  it('an empty no-tools answer is recorded as no-tools: a resume pays only for the prose retry', async () => {
    const mock = scripted([TOOL_USE as never, THINKING as never, { throw: failure('network') }, OK('prose memory')]);
    const fx = await build(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 3);
    const outcomes = (progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => [o.curveLabel, o.outcome]), [['canonical', 'incomplete'], ['canonical-no-tools', 'unusable_empty']]);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 4, 'neither the canonical nor the no-tools request is paid again');
    assert.ok(JSON.stringify(mock.calls[3]).includes('plain prose'));
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'prose memory'));
    fx.manager.close();
  });

  it('the same for an empty tools-less answer', async () => {
    const mock = scripted([TOOL_USE as never, TOOL_USE as never, THINKING as never, { throw: failure('network') }, OK('prose memory')]);
    const fx = await build(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 4);
    const outcomes = (progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => o.curveLabel), ['canonical', 'canonical-no-tools', 'canonical-toolless']);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 5, 'only the prose retry');
    assert.ok(JSON.stringify(mock.calls[4]).includes('plain prose'));
    fx.manager.close();
  });

  /** The fixture, with L1-100 carrying signed reasoning, so its recall pair carries it. */
  async function withCarriers(membrane: unknown) {
    const fx = await build(membrane);
    const internals = fx.strategy as unknown as { summaries: SummaryEntry[] };
    const l1 = internals.summaries.find((s) => s.id === 'L1-100')!;
    l1.responseContent = [
      { type: 'thinking', thinking: 'zz carried reasoning', signature: 'zz-signature' } as never,
      text('authored L1-100'),
    ];
    return fx;
  }
  const carriesThinking = (request: NormalizedRequest): boolean =>
    request.messages.some((m) => m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));

  it('a genuine carrier rejection is recorded under its own identity: a resume goes straight to the stripped request', async () => {
    const rejected = Object.assign(new Error('zz 400: thinking blocks cannot be modified'), { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const mock = scripted([{ throw: rejected }, { throw: failure('network') }, OK('stripped memory')]);
    const fx = await withCarriers(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 2);
    assert.ok(carriesThinking(mock.calls[0]!), 'the canonical carried reasoning');
    assert.ok(!carriesThinking(mock.calls[1]!), 'the degraded retry did not');
    const outcomes = (progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => o.curveLabel), ['canonical:carrier-rejected']);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'the known-rejected carrier request is not sent again');
    assert.ok(!carriesThinking(mock.calls[2]!));
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'stripped memory'));
    fx.manager.close();
  });

  it("the stripped request's server errors are its own: eleven, a restart, then the twelfth ends it, the carrier request paid once (#48315)", async () => {
    const path = freshPath();
    const rejected = Object.assign(new Error('zz 400: thinking blocks cannot be modified'), { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const first = scripted([{ throw: rejected }, { throw: failure('server', { httpStatus: 503 }) }]);
    const a = await build(first.membrane, { path });
    const internals = a.strategy as unknown as { summaries: SummaryEntry[] };
    internals.summaries.find((s) => s.id === 'L1-100')!.responseContent = [
      { type: 'thinking', thinking: 'zz carried reasoning', signature: 'zz-signature' } as never,
      text('authored L1-100'),
    ];
    for (let i = 0; i < 11; i++) {
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(first.calls.filter(carriesThinking).length, 1, 'the carrier request was sent once');
    assert.equal(first.calls.length, 12);
    const stripped = sha256(first.calls[1]!);
    const progress = progressSlot(a.manager) as Array<{ serverErrorStreak?: { requestHash: string; count: number } }>;
    assert.deepEqual(progress[0]!.serverErrorStreak, { requestHash: stripped, count: 11 }, 'counted against the stripped request');
    a.manager.close();

    const second = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const b = await build(second.membrane, { path });
    (b.strategy as unknown as { summaries: SummaryEntry[] }).summaries.find((s) => s.id === 'L1-100')!.responseContent = [
      { type: 'thinking', thinking: 'zz carried reasoning', signature: 'zz-signature' } as never,
      text('authored L1-100'),
    ];
    await b.strategy.run(b.target(), managerContext(b.manager));
    assert.equal(second.calls.length, 1, 'only the stripped request after the restart');
    assert.ok(!carriesThinking(second.calls[0]!));
    assert.equal(sha256(second.calls[0]!), stripped, 'the same stripped request');
    assert.equal(b.strategy.getCompressionQuarantineStatus().count, 1, 'the twelfth ends the family');
    b.manager.close();
  });

  it('a transient failure that merely mentions thinking interrupts the ladder; no degraded retry', async () => {
    const network = Object.assign(new Error('zz upstream: invalid_request while reading thinking blocks'), { type: 'network', retryable: true });
    const mock = scripted([{ throw: network }]);
    const fx = await withCarriers(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz upstream/);
    assert.equal(mock.calls.length, 1, 'no stripped retry');
    assert.equal(progressSlot(fx.manager).length, 1);
    assert.deepEqual((progressSlot(fx.manager) as Array<{ outcomes: unknown[] }>)[0]!.outcomes, [], 'nothing recorded for it');
    fx.manager.close();
  });
});

describe("a caller's admission deferral is an external wait, not a failed call (#47927)", () => {
  /** agent-framework's refusal of a held model: no provider call was made. */
  const deferred = (retryAfterMs?: number) => Object.assign(
    new Error('Provider wait: same-model is held for resident (recorded earlier: zz 429); no call was made'),
    { type: 'rate_limit', retryable: true, providerAdmission: 'deferred', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
  const requeue = (fx: Awaited<ReturnType<typeof queued>>) =>
    fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));

  it('on a fresh lane: no failure is counted, no backoff is invented, the admission is asked again within 30 s; a release resumes at once', async () => {
    const mock = scripted([{ throw: deferred(120_000) }, OK('after the release')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /no call was made/);
    const pause = fx.strategy.pause()!;
    assert.equal(pause.failures, 0, 'nothing failed here');
    assert.ok(pause.backoffUntil <= Date.now(), 'no local backoff');
    assert.ok(pause.statedUntil! <= Date.now() + 30_000 && pause.statedUntil! > Date.now() + 29_000,
      'the cached answer lasts 30 s, not the admission\'s 120 s deadline');
    assert.match(fx.strategy.checkReadiness().description ?? '', /then the caller's provider admission is asked again, failure 0/);
    assert.equal(progressSlot(fx.manager).length, 1);
    assert.deepEqual((progressSlot(fx.manager) as Array<{ outcomes: unknown[]; serverErrorStreak?: unknown }>)[0]!.outcomes, [], 'no rung spent');

    // The operator releases the wait through agent-framework 10 s later: no
    // invented 20 s of failure pacing remain.
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    assert.equal(fx.strategy.paused(), false);
    await requeue(fx);
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });

  it('after a genuine failure: the deferral leaves its count and backoff as they were, and the next failure doubles from it', async () => {
    const mock = scripted([{ throw: failure('network') }, { throw: deferred(120_000) }, { throw: failure('network') }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz network failure/);
    assert.equal(fx.strategy.pause()!.failures, 1);
    fx.strategy.expirePause();
    const backoffBefore = fx.strategy.pause()!.backoffUntil;
    await requeue(fx);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /no call was made/);
    const held = fx.strategy.pause()!;
    assert.equal(held.failures, 1, 'not incremented');
    assert.equal(held.backoffUntil, backoffBefore, 'the backoff deadline is untouched');
    assert.equal(fx.strategy.releaseCompressionPause(), true);
    await requeue(fx);
    const start = Date.now();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz network failure/);
    assert.equal(fx.strategy.pause()!.failures, 2);
    assert.equal(Math.round((fx.strategy.pause()!.backoffUntil - start) / 1_000), 60, 'doubling continues from the genuine count');
    fx.manager.close();
  });

  it('a deferral with no deadline is rechecked, not cached: refusals count nothing, and recovery runs the pending chunk with no release (#49105)', async () => {
    // An unreadable wait journal: the admission defers with no deadline, and
    // keeps deferring after the first recheck. Then the journal reads again
    // and reveals a later real wait (10 min), then that wait passes.
    const mock = scripted([{ throw: deferred() }, { throw: deferred() }, { throw: deferred(600_000) }, OK('recovered memory')]);
    const fx = await queued(mock.membrane);
    const ctx = managerContext(fx.manager);
    await assert.rejects(fx.strategy.tick(ctx), /no call was made/);
    let pause = fx.strategy.pause()!;
    assert.ok(Number.isFinite(pause.statedUntil!) && pause.statedUntil! <= Date.now() + 30_000, 'a recheck time, not an indefinite hold');
    assert.equal(pause.statedBy, 'admission');
    await fx.strategy.tick(ctx);
    assert.equal(mock.calls.length, 1, 'no check before the recheck time');

    for (const step of [2, 3]) {
      fx.strategy.expirePause(); // 30 s pass
      await assert.rejects(fx.strategy.tick(ctx), /no call was made/);
      assert.equal(mock.calls.length, step, 'each recheck asks the admission once');
      pause = fx.strategy.pause()!;
      assert.equal(pause.failures, 0, 'a refusal is not a failure');
      assert.ok(pause.backoffUntil <= Date.now(), 'and adds no backoff');
      assert.ok(pause.statedUntil! <= Date.now() + 30_000, 'still at most 30 s, even against a 10 min deadline');
    }
    assert.match(fx.strategy.checkReadiness().description ?? '', /then the caller's provider admission is asked again, failure 0/);

    // The admission clears: the already-pending chunk runs on the next check,
    // with no release, new message, rebuild or restart.
    fx.strategy.expirePause();
    await fx.strategy.tick(ctx);
    assert.equal(mock.calls.length, 4);
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && s.content === 'recovered memory'));
    fx.manager.close();
  });

  it("a deferral never shortens a wait the provider stated after a real call", async () => {
    const mock = scripted([{ throw: failure('rate_limit', { retryAfterMs: 600_000 }) }]);
    const fx = await queued(mock.membrane);
    const ctx = managerContext(fx.manager);
    await assert.rejects(fx.strategy.tick(ctx), /zz rate_limit failure/);
    const before = fx.strategy.pause()!;
    assert.equal(before.statedBy, 'provider');
    // A deferral arriving from a concurrent operation while that wait stands.
    fx.strategy.notePause(deferred(), ctx);
    const after = fx.strategy.pause()!;
    assert.equal(after.statedBy, 'provider');
    assert.equal(after.statedUntil, before.statedUntil, 'the 10 min provider wait stands');
    fx.manager.close();
  });
});

describe('pending work stays discoverable after a transient failure or a deferral (#48424, #48444)', () => {
  const deferred = (retryAfterMs?: number) => Object.assign(
    new Error('Provider wait: same-model is held for resident; no call was made'),
    { type: 'rate_limit', retryable: true, providerAdmission: 'deferred', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );

  it('with no new message, no restart and no manual rebuild, maintenance finds the chunk again once the wait ends', async () => {
    const mock = scripted([{ throw: failure('network') }, { throw: deferred(120_000) }, OK('resumed memory')]);
    const fx = await queued(mock.membrane);
    const queuedAtStart = fx.strategy.compressionQueueView();
    assert.ok(queuedAtStart.length >= 1);

    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz network failure/);
    assert.deepEqual(fx.strategy.compressionQueueView(), queuedAtStart, 'the failed chunk is back at the head');
    assert.equal(fx.strategy.checkReadiness().ready, false, 'pending work is visible to maintenance');

    fx.strategy.expirePause();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /no call was made/);
    assert.deepEqual(fx.strategy.compressionQueueView(), queuedAtStart, 'and again after the deferral');

    // The operator releases the wait; the backoff has passed. The next
    // maintenance tick, with nothing else happening, compresses the chunk.
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'retried without any rebuild');
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && s.content === 'resumed memory'));
    fx.manager.close();
  });

  it('a chunk a newer queue decision withdrew while its call was in flight stays withdrawn (#48739)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }, OK('should not be called')]);
    const fx = await queued(mock.membrane);
    const tick = fx.strategy.tick(managerContext(fx.manager));
    while (mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // While the call is in flight, a rebuild under a larger holdback withdraws
    // every still-raw chunk from the queue (they still exist, uncompressed).
    (fx.strategy as unknown as { config: { l1HoldbackChunks: number } }).config.l1HoldbackChunks = 100;
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    assert.deepEqual(fx.strategy.compressionQueueView(), [], 'the newer decision withdrew them');
    release();
    await assert.rejects(tick, /zz network failure/);
    assert.deepEqual(fx.strategy.compressionQueueView(), [], 'the failed attempt does not resurrect withdrawn work');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'no second call to the withdrawn chunk');
    fx.manager.close();
  });

  it('a chunk compressed meanwhile (or gone) is not resurrected', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }]);
    const fx = await queued(mock.membrane);
    const head = fx.strategy.compressionQueueView()[0]!;
    const tick = fx.strategy.tick(managerContext(fx.manager));
    while (mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // While the call is in flight, the chunk becomes compressed (another producer).
    (fx.strategy as unknown as { chunks: Array<{ compressed: boolean }> }).chunks[head]!.compressed = true;
    release();
    await assert.rejects(tick, /zz network failure/);
    assert.equal(fx.strategy.compressionQueueView().includes(head), false);
    fx.manager.close();
  });
});
