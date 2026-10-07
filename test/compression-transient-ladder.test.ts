import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
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

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  summariesView(): SummaryEntry[] { return [...this.summaries]; }
  chunksView(): Chunk[] { return [...this.chunks]; }
  compressionQueueView(): number[] { return [...this.compressionQueue]; }
  setCompressionModel(model: string): void { this.config.compressionModel = model; }
  pause(): { until: number; failures: number; source: string } | null {
    return (this as unknown as { compressionPause: { until: number; failures: number; source: string } | null }).compressionPause;
  }
  expirePause(): void {
    const pause = (this as unknown as { compressionPause: { until: number } | null }).compressionPause;
    if (pause) pause.until = 0;
  }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}
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
