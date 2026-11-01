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
const MINUTE = 60_000;
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const say = (i: number) => `message ${i}: ` + 'a considered sentence about the work at hand. '.repeat(3);
const OK: Answer = { content: [text('A summary of what happened.')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
const REFUSAL: Answer = { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } };
const transient = () => Object.assign(new Error('zz overloaded failure'), { type: 'overloaded', retryable: true });

function membraneOf(handler: (call: number) => Answer) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        return handler(calls.length);
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

function storePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-retry-order-alarm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store');
}

function pendingChunks(manager: ContextManager): number {
  const match = manager.getPendingWork()?.description.match(/(\d+) chunks/);
  return match ? Number(match[1]) : 0;
}

function requestText(request: NormalizedRequest): string {
  return request.messages.flatMap((m) => m.content.map((b) => (b.type === 'text' ? b.text : ''))).join('\n');
}

const messagesIn = (request: NormalizedRequest) => requestText(request).match(/message \d+:/g) ?? [];

describe('compression lifecycle: retry order and the alarm interval', () => {
  it('chunks that failed are retried least recently failed first', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const { membrane, calls } = membraneOf((call) => {
      if (call <= 3) throw transient();
      return OK;
    });
    const manager = await ContextManager.open({ path: storePath(t), strategy: new AutobiographicalStrategy(config()), membrane });
    let said = 0;
    const addUntilQueued = (chunks: number): number => {
      const first = said;
      for (let added = 0; pendingChunks(manager) < chunks; added++) {
        assert.ok(added < 50, `premise: ${chunks} chunk(s) queued (${manager.getPendingWork()?.description})`);
        manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said++))]);
      }
      return first;
    };
    const first = addUntilQueued(1);
    await assert.rejects(manager.tick(), /zz overloaded failure/);
    const second = addUntilQueued(2);
    mock.timers.setTime(Date.now() + 60 * MINUTE);
    await assert.rejects(manager.tick(), /zz overloaded failure/);
    assert.ok(requestText(calls[1]!).includes(`message ${second}:`), "premise: the chunk that hadn't failed went first, and failed");
    mock.timers.setTime(Date.now() + 60 * MINUTE);
    await assert.rejects(manager.tick(), /zz overloaded failure/);
    const firstChunk = Array.from({ length: second - first }, (_, i) => `message ${first + i}:`);
    assert.deepEqual(messagesIn(calls[2]!), firstChunk, 'the chunk that failed first is asked first');
    manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said++))]);
    assert.equal(pendingChunks(manager), 2, 'premise: the message closes no chunk, and both failed chunks are queued');
    mock.timers.setTime(Date.now() + 60 * MINUTE);
    await manager.tick();
    assert.equal(calls.length, 4);
    assert.ok(
      requestText(calls[3]!).includes(`message ${second}:`),
      'once the first chunk has failed again, the second is asked first, though the message rebuilt the queue in chunk order',
    );
    manager.close();
  });

  it('the repeating quarantine alarm sounds every 15 minutes by default', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const errors = mock.method(console, 'error', () => {});
    t.after(() => errors.mock.restore());
    const strategy = new AutobiographicalStrategy(config({ compressionRefusalCurveFallbacks: 0 }));
    const alarms: number[] = [];
    strategy.setQuarantineAlarmHandler((status) => alarms.push(status.count));
    const manager = await ContextManager.open({ path: storePath(t), strategy, membrane: membraneOf(() => REFUSAL).membrane });
    for (let i = 0; pendingChunks(manager) < 1; i++) {
      assert.ok(i < 50, 'premise: a chunk closes');
      manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(i))]);
    }
    await manager.tick();
    assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'premise: the chunk is quarantined');
    await manager.tick();
    assert.deepEqual(alarms, [1], 'premise: the alarm sounds');
    const sounded = Date.now();
    mock.timers.setTime(sounded + 15 * MINUTE - 1);
    await manager.tick();
    assert.equal(alarms.length, 1, 'not again before 15 minutes');
    mock.timers.setTime(sounded + 15 * MINUTE);
    await manager.tick();
    assert.equal(alarms.length, 2, 'again at 15 minutes');
    mock.timers.setTime(sounded + 35 * MINUTE);
    await manager.tick();
    assert.equal(alarms.length, 3, 'again at a tick that comes late, at 35 minutes');
    mock.timers.setTime(sounded + 50 * MINUTE - 1);
    await manager.tick();
    assert.equal(alarms.length, 3, 'not again before 15 minutes after that late repeat');
    mock.timers.setTime(sounded + 50 * MINUTE);
    await manager.tick();
    assert.equal(alarms.length, 4, 'again 15 minutes after it');
    assert.ok(alarms.every((count) => count === 1), 'each alarm reports the one quarantined record');
    manager.close();
  });
});
