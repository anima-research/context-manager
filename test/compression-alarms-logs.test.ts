import { describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

type Config = ConstructorParameters<typeof AutobiographicalStrategy>[0];
type Answer = { content: unknown[]; stopReason: string; usage: { inputTokens: number; outputTokens: number }; raw?: unknown };

const MODEL = 'test-compression-model';
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const say = (i: number) => `message ${i}: ` + 'a considered sentence about the work at hand. '.repeat(3);
const OK: Answer = { content: [text('A summary of what happened.')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
const REFUSAL: Answer = {
  content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
  raw: { response: { stop_details: { category: 'reasoning_extraction' } } },
};
const failure = (type: string) => Object.assign(new Error(`zz ${type} failure`), { type, retryable: type !== 'invalid_request' });
const isMerge = (request: NormalizedRequest) =>
  request.messages.some((m) => m.content.some((b) => b.type === 'text' && /into a single L\d+ memory/.test(b.text)));

function membraneOf(handler: (request: NormalizedRequest) => Answer) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        return handler(request);
      },
    } as never,
  };
}

function config(extra: Partial<Config> = {}): Config {
  return {
    compressionModel: MODEL,
    targetChunkTokens: 100,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    l1HoldbackChunks: 0,
    minChunkCharsForLLM: 0,
    ...extra,
  } as Config;
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-alarms-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function logged(method: 'warn' | 'error', t: TestContext): (pattern: RegExp) => number {
  const spy = mock.method(console, method, () => {});
  t.after(() => spy.mock.restore());
  return (pattern) => spy.mock.calls.filter((call) => pattern.test(String(call.arguments[0]))).length;
}

function pendingChunks(manager: ContextManager): number {
  const match = manager.getPendingWork()?.description.match(/(\d+) chunks/);
  return match ? Number(match[1]) : 0;
}

let said = 0;
function closeChunks(manager: ContextManager, n: number): void {
  const target = pendingChunks(manager) + n;
  for (let added = 0; pendingChunks(manager) < target; added++) {
    assert.ok(added < 50 * n, `premise: ${n} more chunk(s) close (${manager.getPendingWork()?.description})`);
    manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said))]);
    said++;
  }
}

describe('compression lifecycle: alarms and logs', () => {
  it('quarantineAlarmIntervalMs: 0 sounds no repeating alarm for a quarantined chunk', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const errors = logged('error', t);
    const strategy = new AutobiographicalStrategy(config({ quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0 }));
    const manager = await ContextManager.open({ path: join(tempDir(t), 'store'), strategy, membrane: membraneOf(() => REFUSAL).membrane });
    closeChunks(manager, 1);
    await manager.tick();
    assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'premise: the chunk is quarantined');
    for (let i = 0; i < 3; i++) await manager.tick();
    mock.timers.setTime(Date.now() + 16 * 60_000);
    for (let i = 0; i < 3; i++) await manager.tick();
    assert.equal(errors(/span\(s\) in compression quarantine/), 0, 'none at once, nor past the default 15-minute interval');
    manager.close();
  });

  it('quarantineAlarmIntervalMs: 0 sounds no repeating alarm for a quarantined merge', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const errors = logged('error', t);
    const strategy = new AutobiographicalStrategy(config({
      quarantineAlarmIntervalMs: 0, hierarchical: true, mergeThreshold: 2, mergeAttemptLimit: 1,
    }));
    const membrane = membraneOf((request) => {
      if (isMerge(request)) throw failure('invalid_request');
      return OK;
    });
    const manager = await ContextManager.open({ path: join(tempDir(t), 'store'), strategy, membrane: membrane.membrane });
    for (let i = 0; i < 10 && strategy.getCompressionDebt().mergeQuarantineCount === 0; i++) {
      closeChunks(manager, 1);
      for (let j = 0; j < 20 && !manager.isReady(); j++) await manager.tick().catch(() => {});
    }
    assert.equal(strategy.getCompressionDebt().mergeQuarantineCount, 1, 'premise: a merge is quarantined');
    for (let i = 0; i < 3; i++) await manager.tick();
    mock.timers.setTime(Date.now() + 16 * 60_000);
    for (let i = 0; i < 3; i++) await manager.tick();
    assert.equal(errors(/\[merge-quarantine\] ⚠️ \d+ merge\(s\) quarantined/), 0, 'none at once, nor past the default 15-minute interval');
    manager.close();
  });

  it('a pause writes a compression:lane-paused event to the compression log', async (t) => {
    const dir = tempDir(t);
    const log = join(dir, 'compression.jsonl');
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    t.after(() => {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
    });
    logged('warn', t);
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: new AutobiographicalStrategy(config()),
      membrane: membraneOf(() => { throw Object.assign(failure('server'), { httpStatus: 529 }); }).membrane,
    });
    closeChunks(manager, 1);
    await assert.rejects(manager.tick(), /zz server failure/);
    manager.close();
    assert.ok(existsSync(log), 'premise: the log was written');
    const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);
    assert.ok(events.includes('compression:lane-paused'), `events: ${events.join(', ')}`);
  });
});
