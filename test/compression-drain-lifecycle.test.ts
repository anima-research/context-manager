import { describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

type Config = ConstructorParameters<typeof AutobiographicalStrategy>[0];

const MODEL = 'test-compression-model';
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const say = (i: number) => `message ${i}: ` + 'a considered sentence about the work at hand. '.repeat(3);
const OK = { content: [text('A summary of what happened.')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
const transient = () => Object.assign(new Error('zz server failure'), { type: 'server', httpStatus: 529, retryable: true });
const admissionDeferral = (retryAfterMs = 0) => Object.assign(new Error('zz held by provider admission'), {
  type: 'rate_limit', retryable: true, providerAdmission: 'deferred', retryAfterMs,
});

type Step = typeof OK | { throw: unknown };
function scripted(steps: Step[] = [OK]) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const step = steps[Math.min(calls.length, steps.length - 1)]!;
        calls.push(structuredClone(request));
        if ('throw' in step) throw step.throw;
        return step;
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
    ...extra,
  } as Config;
}

function storePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-drain-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store');
}

function pendingChunks(manager: ContextManager): number {
  const match = manager.getPendingWork()?.description.match(/(\d+) chunks/);
  return match ? Number(match[1]) : 0;
}

function addUntilQueued(manager: ContextManager, chunks: number, add: () => void): void {
  for (let added = 0; pendingChunks(manager) < chunks; added++) {
    assert.ok(added < 50, `premise: ${chunks} chunk(s) queued (${manager.getPendingWork()?.description})`);
    add();
  }
}

async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** With `setTimeout` mocked: moves the clock on in `step` ms steps, letting each step's callbacks and what they
 *  start run (setImmediate isn't mocked), until `cond` holds or `ms` has passed. */
async function advance(ms: number, cond: () => boolean = () => false, step = 1): Promise<boolean> {
  for (let passed = 0; !cond(); passed += step) {
    if (passed >= ms) return false;
    mock.timers.tick(step);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 200 && !manager.isReady(); i++) await manager.tick();
  assert.ok(manager.isReady(), `drained: ${manager.getPendingWork()?.description}`);
}

function l1Sources(manager: ContextManager): string[][] {
  const stored = manager.getStore().getStateJson('default/autobio:summaries');
  return (Array.isArray(stored) ? stored : [])
    .filter((s: { level?: number }) => s?.level === 1)
    .map((s: { sourceIds: string[] }) => s.sourceIds);
}

async function closedChunksStore(t: TestContext): Promise<string> {
  const path = storePath(t);
  const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config()) });
  for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(i))]);
  assert.ok(pendingChunks(manager) >= 2, `premise: chunks closed (${manager.getPendingWork()?.description})`);
  manager.close();
  return path;
}

describe('compression lifecycle: the tick, the drain and holds', () => {
  it('without a membrane, tick() warns, makes no call and leaves the closed chunks queued', async (t) => {
    const path = await closedChunksStore(t);
    const warn = mock.method(console, 'warn', () => {});
    try {
      const bare = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(config()) });
      const before = bare.getPendingWork()?.description;
      await bare.tick();
      assert.ok(
        warn.mock.calls.some((call) => String(call.arguments[0]).includes('No membrane instance for compression')),
        'the tick says compression has no membrane',
      );
      assert.equal(bare.getPendingWork()?.description, before, 'the queued work is as it was');
      bare.close();
    } finally {
      warn.mock.restore();
    }
  });

  it('a queued chunk with a held message ends the scan: an earlier chunk queued behind it after a failure waits too, until the release', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const { membrane, calls } = scripted([{ throw: transient() }, OK]);
    const manager = await ContextManager.open({ path: storePath(t), strategy: new AutobiographicalStrategy(config()), membrane });
    const ids: string[] = [];
    const add = () => ids.push(manager.addMessage(ids.length % 2 ? 'Claude' : 'User', [text(say(ids.length))]));
    addUntilQueued(manager, 1, add);
    await assert.rejects(manager.tick(), /zz server failure/);
    const firstLater = ids.length;
    addUntilQueued(manager, 2, add);
    mock.timers.setTime(Date.now() + 60_000);
    manager.holdCompression([ids[firstLater]!]);
    await manager.tick();
    assert.equal(calls.length, 1, 'no call while the head of the queue is held');
    manager.releaseCompression([ids[firstLater]!]);
    await drain(manager);
    const covered = l1Sources(manager).flat();
    assert.ok(covered.includes(ids[0]!) && covered.includes(ids[firstLater]!), 'both chunks are summarised after the release');
    manager.close();
  });

  it('releasing a hold resumes the auto-tick drain with no further message', async (t) => {
    const { membrane, calls } = scripted();
    const manager = await ContextManager.open({
      path: storePath(t),
      strategy: new AutobiographicalStrategy(config({ autoTickOnNewMessage: true })),
      membrane,
    });
    const held = manager.addMessage('User', [text(say(0))], undefined, undefined, { holdCompression: true });
    for (let i = 1; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(i))]);
    await turns(20);
    assert.equal(calls.length, 0, 'premise: the hold keeps every chunk back');
    manager.releaseCompression([held]);
    await until(() => calls.length > 0 && manager.isReady(), 'the drain the release starts');
    assert.ok(l1Sources(manager).flat().includes(held));
    manager.close();
  });

  it('readiness names a pause only while it stands', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const { membrane } = scripted([{ throw: transient() }, OK]);
    const manager = await ContextManager.open({ path: storePath(t), strategy: new AutobiographicalStrategy(config()), membrane });
    let said = 0;
    addUntilQueued(manager, 1, () => manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said++))]));
    await assert.rejects(manager.tick(), /zz server failure/);
    assert.match(manager.getPendingWork()?.description ?? '', /chunks pending; compression paused/);
    mock.timers.setTime(Date.now() + 60_000);
    const after = manager.getPendingWork()?.description ?? '';
    assert.match(after, /chunks pending/, 'the work is still queued');
    assert.doesNotMatch(after, /paused/, 'the pause has ended');
    manager.close();
  });

  it('the drain starts nothing after a tick that threw, until the next message', async (t) => {
    const path = await closedChunksStore(t);
    // The deferral asks for a recheck after 100 ms, so a drain that re-armed at its retry would come due inside
    // the hour this test lets pass.
    const { membrane, calls } = scripted([{ throw: admissionDeferral(100) }, OK]);
    const errors = mock.method(console, 'error', () => {});
    t.after(() => errors.mock.restore());
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy(config({ autoTickOnNewMessage: true })),
      membrane,
    });
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    manager.addMessage('User', [text(say(100))]);
    assert.ok(
      await advance(5_000, () => errors.mock.calls.some((call) => /speculative-drain error: .*zz held by provider admission/.test(String(call.arguments[0])))),
      'the drain logs what the tick threw',
    );
    await advance(60 * 60_000, () => calls.length > 1, 1_000);
    assert.equal(calls.length, 1, 'nothing resumed the drain in the hour after');
    manager.addMessage('Claude', [text(say(101))]);
    assert.ok(await advance(5_000, () => calls.length > 1), 'the next message resumes the drain');
    manager.close();
  });

  it("a false preflight hook doesn't stop a drain while a merge is queued", async (t) => {
    class NoPreflight extends AutobiographicalStrategy {
      protected override shouldCompressPreflight(): boolean {
        return false;
      }
    }
    const { membrane, calls } = scripted();
    const manager = await ContextManager.open({
      path: storePath(t),
      strategy: new NoPreflight(config({ autoTickOnNewMessage: true, hierarchical: true, mergeThreshold: 2 })),
      membrane,
    });
    for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(i))]);
    await turns(20);
    assert.equal(calls.length, 0, 'premise: no drain runs for L1 work alone');
    for (let i = 0; i < 50 && !/merges/.test(manager.getPendingWork()?.description ?? ''); i++) await manager.tick();
    assert.match(manager.getPendingWork()?.description ?? '', /merges pending/, 'premise: a merge is queued');
    const before = calls.length;
    manager.addMessage('User', [text(say(100))]);
    await until(() => manager.getMaxSummaryLevel() >= 2, 'the drain to run the merge');
    assert.ok(calls.length > before);
    manager.close();
  });

  it("releasing a sharded add's id releases every shard", async (t) => {
    const manager = await ContextManager.open({
      path: storePath(t),
      strategy: new AutobiographicalStrategy(config({ adaptiveResolution: true, targetChunkTokens: 50 })),
      membrane: scripted().membrane,
    });
    const id = manager.addMessage('User', [text('a long passage of reasoning. '.repeat(80))], undefined, undefined, { holdCompression: true });
    assert.ok(manager.getCompressionHolds().size > 1, `premise: the add was sharded (${manager.getCompressionHolds().size} held)`);
    manager.releaseCompression([id]);
    assert.deepEqual([...manager.getCompressionHolds()], []);
    manager.close();
  });

  it("a mechanical stub is no provider answer: the lane's failure count carries to its next failure", async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    const { membrane, calls } = scripted([{ throw: transient() }, { throw: transient() }, OK]);
    const manager = await ContextManager.open({
      path: storePath(t),
      strategy: new AutobiographicalStrategy(config({ minChunkCharsForLLM: 200, targetChunkTokens: 40 })),
      membrane,
    });
    for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(say(i))]);
    assert.equal(pendingChunks(manager), 1, `premise: one substantive chunk (${manager.getPendingWork()?.description})`);
    await assert.rejects(manager.tick(), /zz server failure/);
    assert.match(manager.getPendingWork()?.description ?? '', /failure 1\b/);
    for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text('.' + ' '.repeat(120))]);
    assert.equal(pendingChunks(manager), 2, `premise: a thin chunk queued too (${manager.getPendingWork()?.description})`);
    mock.timers.setTime(Date.now() + 60_000);
    await manager.tick();
    assert.equal(calls.length, 1, 'premise: the thin chunk landed as a stub, with no call');
    assert.equal(l1Sources(manager).length, 1);
    await assert.rejects(manager.tick(), /zz server failure/);
    assert.match(manager.getPendingWork()?.description ?? '', /failure 2\b/, 'the stub ended no run of failures');
    manager.close();
  });
});
