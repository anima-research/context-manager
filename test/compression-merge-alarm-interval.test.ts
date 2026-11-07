import { describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

type Config = ConstructorParameters<typeof AutobiographicalStrategy>[0];
type Answer = { content: unknown[]; stopReason: string; usage: { inputTokens: number; outputTokens: number } };

const MODEL = 'test-compression-model';
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const say = (i: number) => `message ${i}: ` + 'a considered sentence about the work at hand. '.repeat(3);
const OK: Answer = { content: [text('A summary of what happened.')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
const failure = (type: string) => Object.assign(new Error(`zz ${type} failure`), { type, retryable: type !== 'invalid_request' });
const isMerge = (request: NormalizedRequest) =>
  request.messages.some((m) => m.content.some((b) => b.type === 'text' && /into a single L\d+ memory/.test(b.text)));

function membraneOf(handler: (request: NormalizedRequest) => Answer) {
  return { complete: async (request: NormalizedRequest) => handler(request) } as never;
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
  const dir = mkdtempSync(join(tmpdir(), 'cm-merge-alarm-'));
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

describe('compression lifecycle: the merge quarantine alarm interval', () => {
  it('a quarantined merge sounds its repeating alarm every 15 minutes by default, as a quarantined chunk does', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const errors = logged('error', t);
    const strategy = new AutobiographicalStrategy(config({ hierarchical: true, mergeThreshold: 2, mergeAttemptLimit: 1 }));
    const membrane = membraneOf((request) => {
      if (isMerge(request)) throw failure('invalid_request');
      return OK;
    });
    const manager = await ContextManager.open({ path: join(tempDir(t), 'store'), strategy, membrane });
    for (let i = 0; i < 10 && strategy.getCompressionDebt().mergeQuarantineCount === 0; i++) {
      closeChunks(manager, 1);
      for (let j = 0; j < 20 && !manager.isReady(); j++) await manager.tick().catch(() => {});
    }
    assert.equal(strategy.getCompressionDebt().mergeQuarantineCount, 1, 'premise: a merge is quarantined');

    const alarm = /\[merge-quarantine\] ⚠️ \d+ merge\(s\) quarantined/;
    const start = Date.now();
    await manager.tick();
    assert.equal(errors(alarm), 1, 'the alarm sounds once the merge is quarantined');

    mock.timers.setTime(start + 15 * 60_000 - 1);
    await manager.tick();
    assert.equal(errors(alarm), 1, 'not again before 15 minutes');
    mock.timers.setTime(start + 15 * 60_000);
    await manager.tick();
    assert.equal(errors(alarm), 2, 'again at 15 minutes');

    mock.timers.setTime(start + 35 * 60_000);
    await manager.tick();
    assert.equal(errors(alarm), 3, 'again at a tick that comes late, at 35 minutes');
    mock.timers.setTime(start + 50 * 60_000 - 1);
    await manager.tick();
    assert.equal(errors(alarm), 3, 'not again before 15 minutes after that late repeat');
    mock.timers.setTime(start + 50 * 60_000);
    await manager.tick();
    assert.equal(errors(alarm), 4, 'again 15 minutes after it');
    assert.equal(strategy.getCompressionDebt().mergeQuarantineCount, 1, 'the merge stays quarantined throughout');
    manager.close();
  });
});
