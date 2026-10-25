/**
 * ContextManagerConfig.observer: what a host is told as it happens. Each
 * compile, refused and failed ones included; each refusal context-manager
 * itself makes of compression, and none of a provider's; each calibration
 * sample. Nothing an observer throws or rejects reaches the work it observes
 * (but for a returned promise no JavaScript can give a handler), so a
 * compile's result is the same with one, with none, and with one that throws
 * or rejects, under each strategy.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';
import {
  ContextManager,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
  AutobiographicalStrategy,
  KnowledgeStrategy,
  OverBudgetError,
  UncoveredDropError,
  OVER_BUDGET_STAGES,
  COMPILE_REFUSALS,
  COMPRESSION_REFUSALS,
  CALIBRATION_SAMPLE_OUTCOMES,
  type ContextObserver,
  type CompileRecord,
  type CompressionRefusalRecord,
  type CalibrationSampleRecord,
  type ContextStrategy,
} from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'context-observer-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let stores = 0;
const freshPath = (): string => join(dir, `store-${stores++}`);
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

function recorder() {
  const compiles: CompileRecord[] = [];
  const compressions: CompressionRefusalRecord[] = [];
  const samples: CalibrationSampleRecord[] = [];
  const observer: ContextObserver = {
    compile: (record) => { compiles.push(record); },
    compression: (record) => { compressions.push(record); },
    calibration: (record) => { samples.push(record); },
  };
  return { observer, compiles, compressions, samples };
}

/** An observer each of whose callbacks throws, or returns a promise that rejects. */
function hostile(kind: 'throws' | 'rejects', calls: string[] = []): ContextObserver {
  const act = (name: string) => () => {
    calls.push(name);
    if (kind === 'throws') throw new Error(`observer ${name} threw`);
    return Promise.reject(new Error(`observer ${name} rejected`)) as unknown as void;
  };
  return { compile: act('compile'), compression: act('compression'), calibration: act('calibration') };
}

function strategyContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

/** Rejections no handler took while `run` ran and for a few turns after it. */
async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    await run();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('compile records', () => {
  it('a compile is recorded once, timed whole, on the wall clock, with its dry flag, and reads the manager clock no more', async () => {
    const rec = recorder();
    const reads = { observed: 0, bare: 0 };
    const manager = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: rec.observer, now: () => { reads.observed++; return 1234; } });
    manager.addMessage('User', [text('hello')]);
    manager.addMessage('Claude', [text('hi')]);
    const bare = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), now: () => { reads.bare++; return 1234; } });
    bare.addMessage('User', [text('hello')]);
    bare.addMessage('Claude', [text('hi')]);
    reads.observed = reads.bare = 0;
    await bare.compile();
    const before = Date.now();
    const result = await manager.compile();
    const after = Date.now();
    assert.equal(reads.observed, reads.bare, 'a compile with an observer reads the manager clock as often as one without');
    bare.close();
    assert.equal(rec.compiles.length, 1);
    const [record] = rec.compiles;
    assert.equal(record!.strategy, 'passthrough');
    assert.equal(record!.dryRun, false);
    assert.ok(record!.startedAt >= before && record!.startedAt <= after, `${before} <= ${record!.startedAt} <= ${after}`);
    assert.equal(record!.outcome, 'compiled');
    assert.ok(Number.isFinite(record!.durationMs) && record!.durationMs >= 0, String(record!.durationMs));
    assert.equal('error' in record!, false);
    // Passthrough records no render stats, so none are given.
    assert.equal(result.renderStats, undefined);
    assert.equal('renderStats' in record!, false);

    await manager.compile(undefined, undefined, { dryRun: true });
    assert.equal(rec.compiles.length, 2);
    assert.equal(rec.compiles[1]!.dryRun, true);
    manager.close();
  });

  it('an observer without a compile callback is told nothing of compiles, and the compile goes on', async () => {
    const manager = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: { compression: () => {} } });
    manager.addMessage('User', [text('hello')]);
    const result = await manager.compile();
    assert.equal(result.messages.length, 1);
    manager.close();
  });

  it('the duration covers the whole compile, the strategy\'s select included', async () => {
    class Slow extends PassthroughStrategy {
      override select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
        const until = performance.now() + 40;
        while (performance.now() < until) { /* a select that takes 40 ms */ }
        return super.select(...args);
      }
    }
    const rec = recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new Slow(), observer: rec.observer });
    manager.addMessage('User', [text('hello')]);
    await manager.compile();
    assert.ok(rec.compiles[0]!.durationMs >= 40, String(rec.compiles[0]!.durationMs));
    manager.close();
  });

  it('the duration covers work the compile does after the strategy\'s select', async () => {
    class SlowAfter extends PassthroughStrategy {
      takeSelectionCause(): undefined {
        const until = performance.now() + 40;
        while (performance.now() < until) { /* 40 ms the compile spends after select */ }
        return undefined;
      }
    }
    const rec = recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new SlowAfter(), observer: rec.observer });
    manager.addMessage('User', [text('hello')]);
    await manager.compile();
    assert.ok(rec.compiles[0]!.durationMs >= 40, String(rec.compiles[0]!.durationMs));
    manager.close();
  });

  it('a compiled record holds the render stats its result holds, the same object', async () => {
    const rec = recorder();
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, adaptiveResolution: true, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({ path: freshPath(), strategy, observer: rec.observer });
    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`message ${i} ` + 'words '.repeat(40))]);
    const result = await manager.compile({ maxTokens: 100_000, reserveForResponse: 2_000 });
    assert.ok(result.renderStats, 'the adaptive select records render stats');
    assert.equal(rec.compiles[0]!.strategy, 'autobiographical');
    assert.equal(rec.compiles[0]!.renderStats, result.renderStats);
    manager.close();
  });

  it('a refused compile is recorded with the error the caller gets, its stage readable', async () => {
    const rec = recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new WindowedPassthroughStrategy(), observer: rec.observer });
    manager.addMessage('User', [text('words '.repeat(2_000))]);
    const before = Date.now();
    const thrown = await manager.compile({ maxTokens: 200, reserveForResponse: 20 }).then(
      () => assert.fail('the newest message alone is over the budget'),
      (error: unknown) => error,
    );
    const after = Date.now();
    assert.ok(thrown instanceof OverBudgetError);
    assert.equal(thrown.stageId, 'windowed-newest-message');
    assert.equal(rec.compiles.length, 1);
    assert.equal(rec.compiles[0]!.outcome, 'refused');
    assert.equal(rec.compiles[0]!.strategy, 'windowed-passthrough');
    assert.equal(rec.compiles[0]!.error, thrown);
    assert.equal('renderStats' in rec.compiles[0]!, false);
    assert.equal(rec.compiles[0]!.dryRun, false);
    assert.ok(rec.compiles[0]!.startedAt >= before && rec.compiles[0]!.startedAt <= after, `${before} <= ${rec.compiles[0]!.startedAt} <= ${after}`);
    assert.ok(Number.isFinite(rec.compiles[0]!.durationMs) && rec.compiles[0]!.durationMs >= 0, String(rec.compiles[0]!.durationMs));
    manager.close();
  });

  it('an override of the protected overBudgetError hook is still given the stage\'s words, as 0.21.0 gave them', async () => {
    const given: Array<{ stage?: string; stageId?: string }> = [];
    class Decorating extends AutobiographicalStrategy {
      protected override overBudgetError(...args: Parameters<AutobiographicalStrategy['overBudgetError']>): OverBudgetError {
        given.push({ stage: args[1].stage, stageId: args[1].stageId });
        return super.overBudgetError(args[0], { ...args[1], stage: `[custom] ${args[1].stage ?? 'Adaptive picker exhausted'}` });
      }
    }
    const strategy = new Decorating({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, adaptiveResolution: true, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({ path: freshPath(), strategy });
    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`message ${i} ` + 'words '.repeat(40))]);
    const thrown = await manager.compile({ maxTokens: 501, reserveForResponse: 500 }).then(
      () => assert.fail('one token of room fits nothing'),
      (error: unknown) => error,
    );
    assert.deepEqual(given, [{ stage: 'Head/tail reservation exceeded budget', stageId: 'head-tail-reservation' }]);
    assert.ok(thrown instanceof OverBudgetError);
    assert.match(thrown.message, /^\[custom\] Head\/tail reservation exceeded budget but /);
    assert.equal(thrown.stageId, 'head-tail-reservation');
    manager.close();
  });

  it('an autobiographical refusal names its stage, and its message opens as before', async () => {
    const rec = recorder();
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, adaptiveResolution: true, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({ path: freshPath(), strategy, observer: rec.observer });
    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`message ${i} ` + 'words '.repeat(40))]);
    const thrown = await manager.compile({ maxTokens: 501, reserveForResponse: 500 }).then(
      () => assert.fail('one token of room fits nothing'),
      (error: unknown) => error,
    );
    assert.ok(thrown instanceof OverBudgetError);
    assert.equal(thrown.stageId, 'head-tail-reservation');
    assert.match(thrown.message, /^Head\/tail reservation exceeded budget but \d+ tokens still exceed hard budget 1 /);
    assert.equal(rec.compiles[0]!.outcome, 'refused');
    assert.equal(rec.compiles[0]!.error, thrown);
    manager.close();
  });

  it('a thrown value whose name can\'t be read is a failed compile, and the caller still gets it', async () => {
    const { proxy: thrown, revoke } = Proxy.revocable({}, {});
    revoke();
    class Throwing extends PassthroughStrategy {
      override select(): never { throw thrown; }
    }
    const rec = recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new Throwing(), observer: rec.observer });
    manager.addMessage('User', [text('hello')]);
    // Caught by hand: assert.rejects reads what it gets, which a revoked proxy refuses.
    let caught: unknown = 'nothing thrown';
    try { await manager.compile(); } catch (error) { caught = error; }
    assert.ok(caught === thrown, 'the caller gets the value thrown');
    assert.equal(rec.compiles.length, 1);
    assert.equal(rec.compiles[0]!.outcome, 'failed');
    assert.ok(rec.compiles[0]!.error === thrown);
    manager.close();
  });

  it('a compile that throws is timed whole too, and every record is taken before the caller awaits', async () => {
    class SlowThenThrow extends PassthroughStrategy {
      override select(): never {
        const until = performance.now() + 40;
        while (performance.now() < until) { /* 40 ms of work before the refusal */ }
        throw new Error('a defect after some work');
      }
    }
    const rec = recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new SlowThenThrow(), observer: rec.observer });
    manager.addMessage('User', [text('hello')]);
    const pending = manager.compile();
    assert.equal(rec.compiles.length, 1, 'told before the caller awaits');
    await pending.catch(() => {});
    assert.equal(rec.compiles[0]!.outcome, 'failed');
    assert.ok(rec.compiles[0]!.durationMs >= 40, String(rec.compiles[0]!.durationMs));
    manager.close();

    const ok = recorder();
    const fine = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: ok.observer });
    fine.addMessage('User', [text('hello')]);
    const compiled = fine.compile();
    assert.equal(ok.compiles.length, 1, 'told before the caller awaits');
    await compiled;
    fine.close();
  });

  it('anything else thrown is a failed compile, null and strings included; a refusal from another copy of the package is still a refusal', async () => {
    const defect = new Error('a defect in select');
    const foreignRefusal = Object.assign(new Error('refused by another copy'), { name: 'UncoveredDropError' });
    for (const [thrown, outcome] of [[defect, 'failed'], [foreignRefusal, 'refused'], [null, 'failed'], ['a thrown string', 'failed']] as const) {
      class Throwing extends PassthroughStrategy {
        override select(): never { throw thrown; }
      }
      const rec = recorder();
      const manager = await ContextManager.open({ path: freshPath(), strategy: new Throwing(), observer: rec.observer });
      manager.addMessage('User', [text('hello')]);
      for (const dryRun of [false, true]) {
        let caught: unknown = 'nothing thrown';
        try { await manager.compile(undefined, undefined, { dryRun }); } catch (error) { caught = error; }
        assert.ok(caught === thrown, `the caller gets ${String(thrown)}`);
      }
      assert.equal(rec.compiles.length, 2);
      assert.deepEqual(rec.compiles.map((r) => [r.outcome, r.dryRun]), [[outcome, false], [outcome, true]]);
      assert.ok(rec.compiles.every((r) => r.error === thrown && 'error' in r));
      manager.close();
    }
  });

  it('an observer\'s methods are called on the observer itself', async () => {
    class Recorder implements ContextObserver {
      readonly records: CompileRecord[] = [];
      compile(record: CompileRecord): void { this.records.push(record); }
    }
    const observer = new Recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer });
    manager.addMessage('User', [text('hello')]);
    await manager.compile();
    assert.equal(observer.records.length, 1);
    manager.close();
  });

  it('a callback that throws or rejects is logged once through the manager\'s diagnostics, and one that can\'t be read is treated as absent', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const throwing = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: hostile('throws') });
      throwing.addMessage('User', [text('hello')]);
      await throwing.compile();
      await throwing.compile();
      throwing.close();
      const rejecting = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: hostile('rejects') });
      rejecting.addMessage('User', [text('hello')]);
      await rejecting.compile();
      await rejecting.compile();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      rejecting.close();
      const compressions: CompressionRefusalRecord[] = [];
      const unreadable = {
        get compile(): never { throw new Error('a getter that throws'); },
        compression: (r: CompressionRefusalRecord) => { compressions.push(r); },
      };
      let handed: StrategyContext['observer'];
      class Capturing extends PassthroughStrategy {
        async initialize(ctx: StrategyContext): Promise<void> { handed = ctx.observer; }
      }
      const opened = await ContextManager.open({ path: freshPath(), strategy: new Capturing(), observer: unreadable as never });
      opened.addMessage('User', [text('hello')]);
      const result = await opened.compile();
      assert.equal(result.messages.length, 1, 'the manager opened and compiled');
      assert.equal(handed!.compile, undefined);
      handed!.compression!({ reason: 'empty' });
      assert.deepEqual(compressions, [{ reason: 'empty' }]);
      opened.close();
    } finally {
      console.error = original;
    }
    const logged = lines.filter((line) => line.includes("the observer's compile callback threw or rejected"));
    assert.equal(logged.length, 3, `once each for the throwing, the rejecting and the unreadable observer: ${logged.join(' | ')}`);
    // Each line carries what failed and the manager's namespace.
    assert.ok(logged[0]!.includes(' ns=') && logged[0]!.includes('observer compile threw'), logged[0]);
    assert.ok(logged[1]!.includes(' ns=') && logged[1]!.includes('observer compile rejected'), logged[1]);
    assert.ok(logged[2]!.includes(' ns=') && logged[2]!.includes('a getter that throws'), logged[2]);
  });

  it('a failure is logged once per callback and once per manager, under that manager\'s namespace', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const observer = hostile('throws');
      for (const namespace of ['first-probe', 'second-probe']) {
        let handed: StrategyContext['observer'];
        class Capturing extends PassthroughStrategy {
          async initialize(ctx: StrategyContext): Promise<void> { handed = ctx.observer; }
        }
        const manager = await ContextManager.open({ path: freshPath(), strategy: new Capturing(), observer, namespace });
        manager.addMessage('User', [text('hello')]);
        await manager.compile();
        await manager.compile();
        handed!.compression!({ reason: 'empty' });
        handed!.compression!({ reason: 'empty' });
        manager.close();
      }
    } finally {
      console.error = original;
    }
    const count = (callback: string, namespace: string) => lines.filter((line) => line.includes(`the observer's ${callback} callback threw or rejected`) && line.includes(` ns=${namespace} `)).length;
    for (const namespace of ['first-probe', 'second-probe']) {
      assert.equal(count('compile', namespace), 1, `once in ${namespace}`);
      assert.equal(count('compression', namespace), 1, `once in ${namespace}, apart from compile`);
    }
    assert.equal(lines.length, 4, lines.join(' | '));
  });

  it('a proxy around a promise, which no JavaScript can give a handler, is told, and the compile goes on', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      let inner: Promise<never> | undefined;
      const manager = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: {
        compile: () => { inner = Promise.reject(new Error('the proxied promise rejected')); return new Proxy(inner, {}) as never; },
      } });
      manager.addMessage('User', [text('hello')]);
      const pending = manager.compile();
      // The limit the docs name: nothing reaches the proxied promise, so the
      // test handles it, as only the observer could.
      inner!.catch(() => {});
      assert.equal((await pending).messages.length, 1, 'the compile is unchanged');
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      manager.close();
    } finally {
      console.error = original;
    }
    assert.equal(lines.filter((line) => line.includes("the observer's compile callback threw or rejected")).length, 1, lines.join(' | '));
  });

  it('a log that throws as it tells of a failure changes nothing either', async () => {
    const original = console.error;
    let entered = 0;
    console.error = () => { entered++; throw new Error('the log broke'); };
    try {
      const throwing = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: hostile('throws') });
      throwing.addMessage('User', [text('hello')]);
      assert.equal((await throwing.compile()).messages.length, 1);
      assert.ok(entered > 0, 'the log was asked to tell of the throw');
      throwing.close();
      entered = 0;
      const unreadable = { get compile(): never { throw new Error('a getter that throws'); } };
      const opened = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: unreadable as never });
      assert.ok(entered > 0, 'the log was asked to tell of the unreadable callback');
      opened.addMessage('User', [text('hello')]);
      assert.equal((await opened.compile()).messages.length, 1);
      opened.close();
    } finally {
      console.error = original;
    }
  });

  it('a returned thenable or promise that rejects, or whose then fails before it settles, is handled and told; a callback is read once', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const fulfilling = { then(resolve: (value: unknown) => void) { setImmediate(() => resolve('fine')); } };
    const shapes: Record<string, () => unknown> = {
      'a then that throws': () => ({ then() { throw new Error('then threw'); } }),
      'a then getter that throws': () => ({ get then(): never { throw new Error('then getter threw'); } }),
      'a callable thenable that rejects': () => Object.assign(() => {}, { then(_: unknown, reject: (error: unknown) => void) { reject(new Error('callable rejected')); } }),
      'a native promise with a no-op then of its own': () => Object.assign(Promise.reject(new Error('own-then promise rejected')), { then() {} }),
      'a native promise with a then of its own that isn\'t callable': () => Object.assign(Promise.reject(new Error('uncallable-then promise rejected')), { then: 42 }),
      'a resolved native promise whose constructor getter throws': () => Object.defineProperty(Promise.resolve(), 'constructor', { get(): never { throw new Error('constructor getter threw'); } }),
      'a rejecting subclass promise with a then of its own': () => { class Sub extends Promise<unknown> {} return Object.assign(Sub.reject(new Error('subclass promise rejected')), { then: undefined }); },
      'a thenable that fulfils': () => fulfilling,
      'an object whose then getter throws only when read again': () => { let reads = 0; return { get then() { if (reads++ > 0) throw new Error('read again'); return undefined; } }; },
    };
    let stray: unknown[] = [];
    try {
      stray = await unhandledRejections(async () => {
        for (const [shape, returned] of Object.entries(shapes)) {
          const manager = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: { compile: () => returned() as void } });
          manager.addMessage('User', [text('hello')]);
          assert.equal((await manager.compile()).messages.length, 1, shape);
          for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
          manager.close();
        }
      });
    } finally {
      console.error = original;
    }
    assert.deepEqual(stray, []);
    const told = lines.filter((line) => line.includes("the observer's compile callback threw or rejected"));
    const expected = ['then threw', 'then getter threw', 'callable rejected', 'own-then promise rejected', 'uncallable-then promise rejected', 'constructor getter threw', 'subclass promise rejected'];
    assert.equal(told.length, expected.length, `each failing shape told once, the others not: ${told.join(' | ')}`);
    expected.forEach((words, i) => assert.ok(told[i]!.includes(words), `${words}: ${told[i]}`));

    // The callback is the function read at open, read once: replacing or removing it later changes nothing.
    const records: CompileRecord[] = [];
    let reads = 0;
    const record = (r: CompileRecord) => { records.push(r); };
    const observer = { get compile() { reads++; return record; } } as ContextObserver;
    const manager = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer });
    manager.addMessage('User', [text('hello')]);
    await manager.compile();
    Object.defineProperty(observer, 'compile', { value: undefined });
    await manager.compile();
    assert.equal(records.length, 2);
    assert.equal(reads, 1, 'read once, when the observer was isolated');
    manager.close();

    // A callback that isn't a function is absent: nothing called, nothing told.
    const lines2: string[] = [];
    console.error = (...args: unknown[]) => { lines2.push(args.map(String).join(' ')); };
    try {
      const odd = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy(), observer: { compile: 'yes' } as never });
      odd.addMessage('User', [text('hello')]);
      assert.equal((await odd.compile()).messages.length, 1);
      odd.close();
    } finally {
      console.error = original;
    }
    assert.deepEqual(lines2, []);
  });
});

describe('what an observer throws or rejects never reaches the work', () => {
  const STRATEGIES: Record<string, () => ContextStrategy> = {
    passthrough: () => new PassthroughStrategy(),
    windowed: () => new WindowedPassthroughStrategy(),
    autobiographical: () => new AutobiographicalStrategy({
      targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 400, hierarchical: true, adaptiveResolution: true,
      l1HoldbackChunks: 0, minChunkCharsForLLM: 0, autoTickOnNewMessage: false, compressionModel: 'test-model',
    }),
    knowledge: () => new KnowledgeStrategy({
      targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 400, hierarchical: true,
      l1HoldbackChunks: 0, minChunkCharsForLLM: 0, autoTickOnNewMessage: false, compressionModel: 'test-model',
    } as never),
  };

  /** `value` as JSON without the fields that differ between any two compiles: timings and ids minted per compile. */
  function withoutVolatile(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value ?? null, (key, v) => (['compileMs', 'solveMs', 'compileId'].includes(key) ? undefined : v)));
  }

  /** One store's compiled request, and what the compile left, after compression has had its turn. */
  async function compiled(strategy: ContextStrategy, observer?: ContextObserver) {
    let summaries = 0;
    const membrane = {
      complete: async () => ({ stopReason: 'end_turn', content: [text(`Summary ${summaries++} of the chunk`)], usage: { inputTokens: 100, outputTokens: 20 } }),
    };
    const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never, ...(observer ? { observer } : {}) });
    for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`message ${i} ` + 'substantive words '.repeat(20))]);
    const tick = (strategy as { tick?: (ctx: StrategyContext) => Promise<unknown> }).tick;
    for (let i = 0; i < 12 && tick; i++) await tick.call(strategy, strategyContext(manager));
    const budget = { maxTokens: 3_000, reserveForResponse: 200 };
    const injections = [
      { namespace: 'probe', position: 'afterUser' as const, content: [text('injected')] },
      { namespace: 'probe', position: 'system' as const, content: [text('a system note')] },
    ];
    const calibration = strategy as unknown as { _calibration?: number; _calibrationArmed?: boolean; _lastCompileEstimate?: number };
    const outcome = await manager.compile(budget, injections).then(
      (result) => ({
        messages: result.messages,
        systemInjections: result.systemInjections,
        renderStats: withoutVolatile(result.renderStats),
        provenance: withoutVolatile({ messages: result.provenance?.messages, layout: result.provenance?.layout, strategy: result.provenance?.strategy }),
        calibration: [calibration._calibration, calibration._calibrationArmed, calibration._lastCompileEstimate],
      }),
      (error: unknown) => ({ error: String(error) }),
    );
    manager.close();
    return { outcome, summaries };
  }

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`under ${name}, a compile's result is the same with an observer, without one, and with one that throws or rejects`, async () => {
      const bare = await compiled(make());
      const rec = recorder();
      const observed = await compiled(make(), rec.observer);
      const calls: string[] = [];
      let thrown: Awaited<ReturnType<typeof compiled>> | undefined;
      let rejected: Awaited<ReturnType<typeof compiled>> | undefined;
      const stray = await unhandledRejections(async () => {
        thrown = await compiled(make(), hostile('throws', calls));
        rejected = await compiled(make(), hostile('rejects', calls));
      });
      assert.ok(!('error' in bare.outcome), `the fixture compiles under ${name}: ${JSON.stringify(bare.outcome)}`);
      assert.ok(bare.outcome.systemInjections.length > 0, 'a system injection to compare');
      assert.deepEqual(observed.outcome, bare.outcome);
      assert.deepEqual(thrown!.outcome, bare.outcome);
      assert.deepEqual(rejected!.outcome, bare.outcome);
      assert.deepEqual(stray, [], 'an observer\'s rejection is no unhandled rejection');
      // The observers were told, so the comparison is with observed compiles.
      assert.equal(rec.compiles.length, 1);
      assert.ok(calls.filter((call) => call === 'compile').length === 2, calls.join(','));
      if (name === 'autobiographical' || name === 'knowledge') {
        assert.ok(bare.summaries > 0, 'compression ran, so the compile folds summaries');
      }
    });
  }

  it('a fork initializes the strategy again with the same observer', async () => {
    const handed: Array<StrategyContext['observer']> = [];
    class Capturing extends PassthroughStrategy {
      async initialize(ctx: StrategyContext): Promise<void> { handed.push(ctx.observer); }
    }
    const rec = recorder();
    const manager = await ContextManager.open({ path: freshPath(), strategy: new Capturing(), observer: rec.observer });
    manager.addMessage('User', [text('hello')]);
    await manager.fork('probe-branch');
    assert.ok(handed.length >= 2, `initialized ${handed.length} time(s)`);
    assert.ok(handed.every((observer) => observer !== undefined && observer === handed[0]), 'every initialization gets the one isolated observer');
    manager.close();
  });

  it('a strategy is handed the isolated observer: what the host\'s throws never reaches the strategy', async () => {
    let handed: StrategyContext['observer'];
    class Capturing extends PassthroughStrategy {
      async initialize(ctx: StrategyContext): Promise<void> { handed = ctx.observer; }
    }
    const calls: string[] = [];
    const manager = await ContextManager.open({ path: freshPath(), strategy: new Capturing(), observer: hostile('throws', calls) });
    assert.ok(handed?.compression, 'the strategy has the observer');
    handed!.compression!({ reason: 'empty' });
    handed!.calibration!({ outcome: 'held', ratio: 1, multiplier: 1 });
    assert.deepEqual(calls, ['compression', 'calibration'], 'the host\'s callbacks ran');
    manager.close();

    let none: StrategyContext['observer'] | 'unset' = 'unset';
    class Bare extends PassthroughStrategy {
      async initialize(ctx: StrategyContext): Promise<void> { none = ctx.observer; }
    }
    const without = await ContextManager.open({ path: freshPath(), strategy: new Bare() });
    assert.equal(none, undefined, 'no observer, none handed');
    without.close();

    let partial: StrategyContext['observer'];
    class Partial extends PassthroughStrategy {
      async initialize(ctx: StrategyContext): Promise<void> { partial = ctx.observer; }
    }
    const onlyCompression = await ContextManager.open({ path: freshPath(), strategy: new Partial(), observer: { compression: () => {} } });
    assert.deepEqual(Object.keys(partial!), ['compression'], 'only the callbacks the host gave');
    onlyCompression.close();
  });
});

describe('the exported lists', () => {
  const diagnostics = { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 1, deepestLevel: 1 };

  it('words given as stage build the message 0.21.0 built from them, byte for byte, and read as strategy-defined', () => {
    // 0.21.0 opened the message with `${opts.stage ?? 'Adaptive picker exhausted'}`
    // and left the rest as it is; the rest is pinned by the message tests.
    const rest = new OverBudgetError({ budget: 1, actual: 2, diagnostics }).message.slice('Adaptive picker exhausted'.length);
    const released = (stage: unknown) => `${stage ?? 'Adaptive picker exhausted'}${rest}`;
    const words = [
      // The library's own ids and words, given as a strategy's words.
      ...OVER_BUDGET_STAGES,
      'Head/tail reservation exceeded budget',
      'Adaptive picker exhausted',
      'My strategy: the newest turn alone',
      // Words that name a property every object has, and none.
      'constructor', 'toString', '__proto__', 'hasOwnProperty', '',
    ];
    for (const stage of words) {
      const error = new OverBudgetError({ budget: 1, actual: 2, diagnostics, stage });
      assert.equal(error.message, released(stage), stage);
      assert.equal(error.stageId, 'strategy-defined', stage);
    }
    // Values a caller past the type passes build what 0.21.0 built from them.
    for (const stage of [null, undefined, 42]) {
      const error = new OverBudgetError({ budget: 1, actual: 2, diagnostics, stage } as never);
      assert.equal(error.message, released(stage), String(stage));
      assert.equal(error.stageId, stage == null ? 'picker-exhausted' : 'strategy-defined', String(stage));
    }
  });

  it('a stageId names the library\'s stage, and words given beside it still open the message', () => {
    const both = new OverBudgetError({ budget: 1, actual: 2, diagnostics, stageId: 'head-tail-reservation', stage: 'My words' });
    assert.equal(both.stageId, 'head-tail-reservation');
    assert.match(both.message, /^My words but 2 tokens still exceed hard budget 1 /);
    // An id past the type that isn't one of the library's own keys, as a string, is no id.
    for (const stageId of ['strategy-defined', 'constructor', '__proto__', 'no-such-stage', { toString: () => 'head-tail-reservation' }, ['head-tail-reservation']]) {
      const error = new OverBudgetError({ budget: 1, actual: 2, diagnostics, stageId } as never);
      assert.equal(error.stageId, 'picker-exhausted', String(stageId));
      assert.match(error.message, /^Adaptive picker exhausted but /, String(stageId));
    }
  });

  it('each of the library\'s stages opens its message with the words `main` gave it', () => {
    const released: Record<string, string> = {
      'picker-exhausted': 'Adaptive picker exhausted',
      'head-tail-reservation': 'Head/tail reservation exceeded budget',
      'emission-overran-plan': 'Emission overran the plan (planner/emitter estimator drift)',
      'tail-emission-dropped': 'Tail emission dropped reserved recent-window messages',
      'repair-lost-newest-turn': 'Structural repair did not retain the newest turn',
      'hierarchical-emission-overran': 'Hierarchical emission overran the budget',
      'hierarchical-system-changes': 'Hierarchical: its system changes alone exceed the budget',
      'passthrough-system-changes': 'Passthrough kept only its system changes',
      'passthrough-changes-and-newest-message': 'Passthrough: its system changes and the newest conversation message',
      'windowed-newest-message': 'Windowed passthrough: the newest message alone',
      'windowed-changes-and-newest-message': 'Windowed passthrough: its system changes and the newest conversation message',
      'windowed-system-changes': 'Windowed passthrough: its system changes alone',
    };
    assert.deepEqual(OVER_BUDGET_STAGES.filter((s) => s !== 'strategy-defined').sort(), Object.keys(released).sort());
    for (const [stageId, words] of Object.entries(released)) {
      const error = new OverBudgetError({ budget: 1, actual: 2, diagnostics, stageId: stageId as never });
      assert.ok(error.message.startsWith(`${words} but 2 tokens still exceed hard budget 1 (`), error.message);
    }
  });

  it('each stage opens its refusal\'s message with words of its own, and a refusal that names none is the picker\'s', () => {
    const openings = new Set<string>();
    const library = OVER_BUDGET_STAGES.filter((s) => s !== 'strategy-defined');
    for (const stageId of library) {
      const error = new OverBudgetError({ budget: 1, actual: 2, diagnostics, stageId: stageId as never });
      assert.equal(error.stageId, stageId);
      const opening = error.message.slice(0, error.message.indexOf(' but 2 tokens still exceed hard budget 1'));
      assert.ok(opening.length > 0, error.message);
      openings.add(opening);
    }
    assert.equal(openings.size, library.length, [...openings].join(' | '));
    const unnamed = new OverBudgetError({ budget: 1, actual: 2, diagnostics });
    assert.equal(unnamed.stageId, 'picker-exhausted');
    assert.match(unnamed.message, /^Adaptive picker exhausted but 2 tokens still exceed hard budget 1 /);
  });

  it('the compile refusals are the two refusal errors by name, and nothing else', () => {
    const names = [
      new OverBudgetError({ budget: 1, actual: 2, diagnostics }).name,
      new UncoveredDropError({ droppedIds: [], site: 'test', diagnostics: { budget: 1, totalTokens: 2 } }).name,
    ];
    assert.deepEqual([...COMPILE_REFUSALS].sort(), names.sort());
  });

  it('the compression reasons and sample outcomes are as documented', () => {
    assert.deepEqual([...COMPRESSION_REFUSALS], ['admission-rejected', 'topology-violation', 'empty', 'incomplete', 'malformed', 'chunk-call-cap', 'window-call-cap', 'overlap-guard']);
    assert.deepEqual([...CALIBRATION_SAMPLE_OUTCOMES], ['out-of-band', 'held', 'confirmed', 'replaced', 'stepped']);
  });
});

// ---- Compression: an L1 chunk's ladder ----

class LadderProbe extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
}

const DIARY = 'I weighed the thread and decided to stay quiet. '.repeat(12);
const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input } as ContentBlock);
const toolResult = (id: string, content: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content } as ContentBlock);
const tool = (name: string): ToolDefinition => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} } } as never);

type Answer = Record<string, unknown> | { error: Error };
const REFUSAL = (inputTokens = 100): Answer => ({ content: [], stopReason: 'refusal', usage: { inputTokens, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } });
const ANSWER = (t: string, stopReason = 'end_turn'): Answer => ({ content: t ? [text(t)] : [], stopReason, usage: { inputTokens: 80, outputTokens: 20 } });

function scripted(answers: Answer[]) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)]!;
        calls.push(structuredClone(request));
        if ('error' in answer && answer.error instanceof Error) throw answer.error;
        return answer;
      },
    } as never,
  };
}

/** A chunk whose last turn holds a long private-reasoning tool argument, after one seeded L1. */
async function ladder(membrane: unknown, options: Record<string, unknown>, path = freshPath(), from = 10) {
  const rec = recorder();
  const strategy = new LadderProbe({
    compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0,
    ...options,
  } as never);
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never, observer: rec.observer });
  manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
  ids.push(manager.addMessage('User', [text('raw-10 ambient chatter ' + 'substantive '.repeat(12))]));
  ids.push(manager.addMessage('Claude', [toolUse('skip1', 'skip_reply', { reason: DIARY, wake_in_seconds: 1500 })]));
  ids.push(manager.addMessage('User', [toolResult('skip1', '{"skipped":true}')]));
  strategy.seed({ id: 'L1-100', level: 1, content: 'authored L1-100', tokens: 20, sourceLevel: 0, sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! }, created: 100 });
  const want = new Set(ids.slice(from));
  const target = (): Chunk => ({ index: 999, startIndex: from, endIndex: 13, messages: strategyContext(manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false });
  return { manager, strategy, target, rec };
}

const HOIST = { compressionToolProseFallback: { intoTool: 'journal', fromTools: ['skip_reply'] } };

describe('compression refusals: an L1 ladder', () => {
  it('a provider\'s refusal is the provider\'s decision, not one of these', async () => {
    const { calls, membrane } = scripted([REFUSAL()]);
    const fx = await ladder(membrane, {});
    await fx.strategy.run(fx.target(), strategyContext(fx.manager));
    assert.equal(calls.length, 1);
    assert.deepEqual(fx.rec.compressions, []);
    fx.manager.close();
  });

  it('a provider\'s rejection of the request is the provider\'s decision too', async () => {
    const rejected = Object.assign(new Error('invalid request'), { type: 'invalid_request', httpStatus: 400, retryable: false });
    const { calls, membrane } = scripted([{ error: rejected }]);
    const fx = await ladder(membrane, {});
    await fx.strategy.run(fx.target(), strategyContext(fx.manager));
    assert.equal(calls.length, 1);
    assert.deepEqual(fx.rec.compressions, []);
    fx.manager.close();
  });

  it('a canonical answer cut short is incomplete', async () => {
    const { calls, membrane } = scripted([ANSWER('a summary cut', 'max_tokens')]);
    const fx = await ladder(membrane, {});
    await fx.strategy.run(fx.target(), strategyContext(fx.manager));
    assert.equal(calls.length, 1);
    assert.deepEqual(fx.rec.compressions, [{ reason: 'incomplete' }]);
    fx.manager.close();
  });

  it('a canonical answer with no text is empty', async () => {
    const { membrane } = scripted([ANSWER('')]);
    const fx = await ladder(membrane, {});
    await fx.strategy.run(fx.target(), strategyContext(fx.manager));
    // The canonical answer, then the plain-prose retry's, each empty.
    assert.deepEqual(fx.rec.compressions, [{ reason: 'empty' }, { reason: 'empty' }]);
    fx.manager.close();
  });

  it('a later rung\'s answer that isn\'t a response\'s shape is malformed', async () => {
    const { calls, membrane } = scripted([REFUSAL(), { stopReason: 'end_turn', content: 'not a list of blocks', usage: { inputTokens: 80, outputTokens: 20 } }]);
    const fx = await ladder(membrane, HOIST);
    await fx.strategy.run(fx.target(), strategyContext(fx.manager));
    assert.equal(calls.length, 2, 'canonical, then the hoisted retry');
    assert.deepEqual(fx.rec.compressions, [{ reason: 'malformed' }]);
    fx.manager.close();
  });

  it('a hoisted retry over the compression budget is refused before any call', async () => {
    const { calls, membrane } = scripted([REFUSAL(90_000), ANSWER('must never be called')]);
    const fx = await ladder(membrane, { ...HOIST, compressionContextBudgetTokens: 50_000 });
    await fx.strategy.run(fx.target(), strategyContext(fx.manager));
    assert.equal(calls.length, 1, 'the hoisted retry is never sent');
    assert.deepEqual(fx.rec.compressions, [{ reason: 'admission-rejected' }]);
    fx.manager.close();
  });

  describe('the split rung, by what ended it', () => {
    const SPLIT = { compressionSourceOnlyFallback: true, compressionSplitFallback: true };
    // The canonical request and source-only refuse, so the split rung runs: its
    // first piece is the chunk's first message, its second the tool round,
    // which it can't split further.
    const cases: Array<[string, Record<string, unknown>, Answer[], CompressionRefusalRecord[]]> = [
      ['its cap on calls in one attempt', { compressionSplitMaxCallsPerChunk: 1 }, [ANSWER('the first piece summarized ' + 'detail '.repeat(20))], [{ reason: 'chunk-call-cap' }]],
      ['its window\'s calls used by the attempt alone', { compressionSplitMaxCallsPer10Min: 1 }, [ANSWER('the first piece summarized ' + 'detail '.repeat(20))], [{ reason: 'window-call-cap' }]],
      ['a piece it can\'t split that answers with no text', {}, [ANSWER('')], [{ reason: 'empty' }]],
      ['a piece it can\'t split that answers cut short', {}, [ANSWER('a piece summary cut', 'max_tokens')], [{ reason: 'incomplete' }]],
      ['a piece it can\'t split that the provider refuses', {}, [REFUSAL()], []],
      ['a piece whose answer is malformed', {}, [{ stopReason: 'end_turn', content: 'not a list', usage: { inputTokens: 80, outputTokens: 20 } }], [{ reason: 'malformed' }]],
    ];
    it('a piece that answers empty and is split further is reported once, and its halves fold', async () => {
      // Five messages: raw-8, raw-9, raw-10, then the tool round. The root splits
      // after raw-10, so the first piece is the three plain messages, which
      // answer empty and split into raw-8..9 and raw-10.
      const pieces = ['raw-8 and raw-9', 'raw-10', 'the tool round'].map((p) => ANSWER(`${p} summarized ` + 'detail '.repeat(20)));
      const { calls, membrane } = scripted([REFUSAL(), REFUSAL(), ANSWER(''), ...pieces]);
      const fx = await ladder(membrane, SPLIT, freshPath(), 8);
      const chunk = fx.target();
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 6, 'canonical, source-only, the empty piece, its two halves, and the tool round');
      assert.equal(chunk.compressed, true, 'the stitch landed');
      assert.deepEqual(fx.rec.compressions, [{ reason: 'empty' }]);
      fx.manager.close();
    });

    it('a split interrupted and run again reports its piece once per call', async () => {
      const transient = new Error('a socket hang up the split resumes after');
      const tool = ANSWER('the tool round summarized ' + 'detail '.repeat(20));
      const { calls, membrane } = scripted([REFUSAL(), REFUSAL(), ANSWER(''), { error: transient }, ANSWER(''), tool]);
      const fx = await ladder(membrane, { ...SPLIT, compressionSplitPlaceholder: true });
      const chunk = fx.target();
      await assert.rejects(fx.strategy.run(chunk, strategyContext(fx.manager)), (error: unknown) => error === transient);
      assert.equal(calls.length, 4);
      assert.deepEqual(fx.rec.compressions, [{ reason: 'empty' }]);
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 6, 'only the split rung runs again, asking both pieces');
      assert.equal(chunk.compressed, true);
      assert.deepEqual(fx.rec.compressions, [{ reason: 'empty' }, { reason: 'empty' }], 'the first piece answered empty on each call');
      fx.manager.close();
    });

    it('a split its cap ended isn\'t reported again on a later run, which makes no call', async () => {
      const path = freshPath();
      const { calls, membrane } = scripted([REFUSAL(), REFUSAL(), ANSWER('the first piece summarized ' + 'detail '.repeat(20))]);
      const fx = await ladder(membrane, { ...SPLIT, compressionSplitMaxCallsPerChunk: 1 }, path);
      const chunk = fx.target();
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 3);
      assert.deepEqual(fx.rec.compressions, [{ reason: 'chunk-call-cap' }]);
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 3, 'the chunk is quarantined, so nothing is asked again');
      assert.deepEqual(fx.rec.compressions, [{ reason: 'chunk-call-cap' }]);
      fx.manager.close();
    });

    it('a chunk an existing L1 partly covers is refused by the overlap guard, reported once until the strategy loads its state again', async () => {
      // The chunk has no record, so the guard keys it by its messages.
      const { calls, membrane } = scripted([ANSWER('never asked')]);
      const fx = await ladder(membrane, SPLIT);
      const chunk = fx.target();
      assert.equal(chunk.recordId, undefined);
      const first = chunk.messages[0]!.id;
      fx.strategy.seed({ id: 'L1-200', level: 1, content: 'covers raw-10 alone', tokens: 20, sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 200 });
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 0, 'nothing is asked');
      assert.equal(chunk.compressed, false);
      assert.deepEqual(fx.rec.compressions, [{ reason: 'overlap-guard' }], 'refused twice, reported once');
      (fx.strategy as unknown as { loadPersistedState(): void }).loadPersistedState();
      fx.strategy.seed({ id: 'L1-201', level: 1, content: 'covers raw-10 alone', tokens: 20, sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 201 });
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 0);
      assert.deepEqual(fx.rec.compressions, [{ reason: 'overlap-guard' }, { reason: 'overlap-guard' }], 'reported again after the load');
      fx.manager.close();
    });

    it('a chunk an existing L1 covers whole is dropped, with no report', async () => {
      const { calls, membrane } = scripted([ANSWER('never asked')]);
      const fx = await ladder(membrane, SPLIT);
      const chunk = fx.target();
      const ids = chunk.messages.map((m) => m.id);
      fx.strategy.seed({ id: 'L1-200', level: 1, content: 'covers the whole chunk', tokens: 20, sourceLevel: 0, sourceIds: ids, sourceRange: { first: ids[0]!, last: ids.at(-1)! }, created: 200 });
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 0);
      assert.equal(chunk.compressed, true, 'dropped as covered');
      assert.deepEqual(fx.rec.compressions, []);
      fx.manager.close();
    });

    it('an empty piece is reported even when the stitch succeeds', async () => {
      const { calls, membrane } = scripted([REFUSAL(), REFUSAL(), ANSWER(''), ANSWER('the tool round summarized ' + 'detail '.repeat(20))]);
      const fx = await ladder(membrane, { ...SPLIT, compressionSplitPlaceholder: true });
      const chunk = fx.target();
      await fx.strategy.run(chunk, strategyContext(fx.manager));
      assert.equal(calls.length, 4, 'canonical, source-only, and both pieces');
      assert.equal(chunk.compressed, true, 'the stitch landed');
      assert.deepEqual(fx.rec.compressions, [{ reason: 'empty' }]);
      fx.manager.close();
    });
    for (const [name, options, pieces, expected] of cases) {
      it(`${name}: ${expected.length ? expected[0]!.reason : 'nothing reported'}`, async () => {
        const { calls, membrane } = scripted([REFUSAL(), REFUSAL(), ...pieces]);
        const fx = await ladder(membrane, { ...SPLIT, ...options });
        await fx.strategy.run(fx.target(), strategyContext(fx.manager));
        assert.equal(calls.length, 3, 'canonical, source-only, and one piece');
        assert.deepEqual(fx.rec.compressions, expected);
        fx.manager.close();
      });
    }
  });

  it('a verdict is reported once: a resumed ladder reuses it without a second report', async () => {
    const transient = new Error('a socket hang up the ladder resumes after');
    const path = freshPath();
    const first = scripted([ANSWER('a summary cut', 'max_tokens'), { error: transient }, ANSWER('the source-only summary ' + 'detail '.repeat(20))]);
    const fx = await ladder(first.membrane, { compressionSourceOnlyFallback: true }, path);
    const chunk = fx.target();
    await assert.rejects(fx.strategy.run(chunk, strategyContext(fx.manager)), (error: unknown) => error === transient);
    assert.equal(first.calls.length, 2, 'canonical, then source-only, which fails');
    assert.deepEqual(fx.rec.compressions, [{ reason: 'incomplete' }]);
    await fx.strategy.run(chunk, strategyContext(fx.manager));
    assert.equal(first.calls.length, 3, 'the resumed ladder sends only source-only again, so it reached the reused canonical verdict');
    assert.equal(chunk.compressed, true, 'and the resumed ladder compressed the chunk');
    assert.deepEqual(fx.rec.compressions, [{ reason: 'incomplete' }], 'the canonical verdict is reused, not reported again');
    fx.manager.close();
  });

  it('an admission rejection is decided again by a resumed ladder, and reported again', async () => {
    const transient = new Error('a socket hang up the ladder resumes after');
    const { calls, membrane } = scripted([REFUSAL(90_000), { error: transient }, ANSWER('the source-only summary ' + 'detail '.repeat(20))]);
    const fx = await ladder(membrane, { ...HOIST, compressionContextBudgetTokens: 50_000, compressionSourceOnlyFallback: true });
    const chunk = fx.target();
    await assert.rejects(fx.strategy.run(chunk, strategyContext(fx.manager)), (error: unknown) => error === transient);
    assert.deepEqual(fx.rec.compressions, [{ reason: 'admission-rejected' }]);
    await fx.strategy.run(chunk, strategyContext(fx.manager));
    assert.equal(calls.length, 3, 'canonical and source-only, then source-only again; the hoisted retry is never sent');
    assert.deepEqual(fx.rec.compressions, [{ reason: 'admission-rejected' }, { reason: 'admission-rejected' }]);
    fx.manager.close();
  });
});

// ---- Compression: the recall variants' plan ----

class RecallProbe extends LadderProbe {
  linkChild(child: SummaryEntry, parentId: string): void { this.setMergedInto(child, parentId); }
}

const summaryOf = (id: string, level: number, sourceIds: string[], first: string, last: string): SummaryEntry => ({
  id, level, content: `authored ${id}`, tokens: 20, sourceLevel: level - 1, sourceIds, sourceRange: { first, last },
  created: Number(id.replace(/\D/g, '')) || 1,
});

describe('compression refusals: the recall variants', () => {
  it('each variant over the compression budget is refused before any call', async () => {
    const rec = recorder();
    const { calls, membrane } = scripted([REFUSAL(90_000), ANSWER('must never be called')]);
    const strategy = new RecallProbe({
      compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
      autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 3, compressionContextBudgetTokens: 50_000,
    } as never);
    const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never, observer: rec.observer });
    const ids: string[] = [];
    for (let i = 0; i < 14; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(18))]));
    const children = [0, 2, 4, 6].map((a, k) => summaryOf(`L1-10${k}`, 1, [ids[a]!, ids[a + 1]!], ids[a]!, ids[a + 1]!));
    for (const child of children) strategy.seed(child);
    const older = summaryOf('L2-200', 2, [children[1]!.id, children[0]!.id], ids[0]!, ids[3]!);
    const newer = summaryOf('L2-201', 2, [children[3]!.id, children[2]!.id], ids[4]!, ids[7]!);
    strategy.seed(older);
    strategy.seed(newer);
    for (const child of children.slice(0, 2)) strategy.linkChild(child, older.id);
    for (const child of children.slice(2)) strategy.linkChild(child, newer.id);
    const want = new Set(ids.slice(10, 12));
    const target: Chunk = { index: 999, startIndex: 10, endIndex: 12, messages: strategyContext(manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
    await strategy.run(target, strategyContext(manager));
    assert.equal(calls.length, 1, 'no variant is sent');
    // One for each variant the plan holds: each of the two parents expanded.
    assert.deepEqual(rec.compressions, [{ reason: 'admission-rejected' }, { reason: 'admission-rejected' }]);
    manager.close();
  });
});

// ---- Compression: merges ----

class MergeProbe extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  qMerge(level: number, sourceIds: string[]): void { this.enqueueMerge({ level, sourceIds }); }
  summariesView(): SummaryEntry[] { return [...this.summaries]; }
}

/** Two seeded L1s over real messages, and a merge of them queued at `level`. */
async function merge(membrane: unknown, level = 2, observe: ContextObserver | 'none' | 'record' = 'record') {
  const rec = recorder();
  const observer = observe === 'record' ? rec.observer : observe === 'none' ? undefined : observe;
  const strategy = new MergeProbe({
    compressionModel: 'same-model', hierarchical: true, targetChunkTokens: 100_000, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, mergeThreshold: 99, quarantineAlarmIntervalMs: 0, mergeAttemptLimit: 5,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never, observer });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substance '.repeat(10))]));
  strategy.seed(summaryOf('L1-100', 1, [ids[0]!, ids[1]!], ids[0]!, ids[1]!));
  strategy.seed(summaryOf('L1-101', 1, [ids[2]!, ids[3]!], ids[2]!, ids[3]!));
  strategy.qMerge(level, ['L1-100', 'L1-101']);
  return { manager, strategy, rec };
}

describe('compression refusals: merges', () => {
  const cases: Array<[string, Answer, CompressionRefusalRecord[]]> = [
    ['a refusal, membrane\'s', REFUSAL(), []],
    ['a provider error, membrane\'s', { error: Object.assign(new Error('bad request'), { type: 'invalid_request', httpStatus: 400, retryable: false }) }, []],
    ['an answer cut short', ANSWER('a partial consolidation', 'max_tokens'), [{ reason: 'incomplete' }]],
    ['an answer with no text', ANSWER(''), [{ reason: 'empty' }]],
    ['an answer of no response\'s shape', { stopReason: 'end_turn', content: 'not a list', usage: { inputTokens: 80, outputTokens: 20 } }, [{ reason: 'malformed' }]],
  ];
  for (const [name, answer, expected] of cases) {
    it(`${name}: ${expected.length ? expected[0]!.reason : 'nothing reported'}`, async () => {
      const { calls, membrane } = scripted([answer]);
      const fx = await merge(membrane);
      await fx.strategy.tick(strategyContext(fx.manager)).catch(() => {});
      assert.equal(calls.length, 1, 'the merge was asked once');
      assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 0, 'nothing minted');
      assert.deepEqual(fx.rec.compressions, expected);
      fx.manager.close();
    });
  }

  it('a merge answer that is a thinking preamble alone is empty', async () => {
    const { calls, membrane } = scripted([ANSWER('<thinking>only my own scratch, nothing to keep</thinking>')]);
    const fx = await merge(membrane);
    await fx.strategy.tick(strategyContext(fx.manager)).catch(() => {});
    assert.equal(calls.length, 1);
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 0, 'nothing minted');
    assert.deepEqual(fx.rec.compressions, [{ reason: 'empty' }]);
    fx.manager.close();
  });

  it('an observer that throws or rejects at the merge gate changes nothing the merge does', async () => {
    const outcomes: unknown[] = [];
    const told: string[][] = [[], []];
    const stray = await unhandledRejections(async () => {
      for (const observe of ['none', hostile('throws', told[0]), hostile('rejects', told[1])] as const) {
        const { calls, membrane } = scripted([ANSWER('a partial consolidation', 'max_tokens')]);
        const fx = await merge(membrane, 2, observe);
        await fx.strategy.tick(strategyContext(fx.manager));
        outcomes.push([calls.length, fx.strategy.summariesView().filter((s) => s.level === 2).length, fx.manager.getStore().getStateJson('default/autobio:mergeQueue')]);
        fx.manager.close();
      }
    });
    assert.equal((outcomes[0] as unknown[])[0], 1, 'the merge made its call');
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.deepEqual(outcomes[2], outcomes[0]);
    for (const calls of told) assert.ok(calls.includes('compression'), `the gate's refusal reached the hostile observer: ${calls.join(', ')}`);
    assert.deepEqual(stray, []);
  });

  it('an accepted merge reports nothing', async () => {
    const { membrane } = scripted([ANSWER('A real consolidation.')]);
    const fx = await merge(membrane);
    await fx.strategy.tick(strategyContext(fx.manager));
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 1);
    assert.deepEqual(fx.rec.compressions, []);
    fx.manager.close();
  });

  it('a merge over sources of the wrong level is refused before any call', async () => {
    const { calls, membrane } = scripted([ANSWER('must never be called')]);
    const fx = await merge(membrane, 3);
    await fx.strategy.tick(strategyContext(fx.manager));
    assert.equal(calls.length, 0);
    assert.deepEqual(fx.rec.compressions, [{ reason: 'topology-violation' }]);
    fx.manager.close();
  });
});

// ---- Calibration samples ----

type CalibrationInternals = {
  _calibration: number;
  _calibrationArmed: boolean;
  _lastCompileEstimate: number;
  _calibrationProvisional: { fromEpoch: number | null } | null;
};

async function calibrated(observe: ContextObserver | 'none' | 'record' = 'record') {
  const rec = recorder();
  const observer = observe === 'record' ? rec.observer : observe === 'none' ? undefined : observe;
  const strategy = new AutobiographicalStrategy({ targetChunkTokens: 5_000, recentWindowTokens: 50_000, adaptiveResolution: true, autoTickOnNewMessage: false });
  const manager = await ContextManager.open({ path: freshPath(), strategy, observer });
  for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`message ${i} ` + 'words '.repeat(40))]);
  const internals = strategy as unknown as CalibrationInternals;
  /** Compile, then report `ratio` times the compile's estimate as the provider's total, with a provisional multiplier if asked. */
  const sample = async (ratio: number, provisional = false) => {
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 2_000 });
    if (provisional) internals._calibrationProvisional = { fromEpoch: null };
    const estimate = internals._lastCompileEstimate;
    assert.ok(estimate > 0);
    strategy.reportRealInputTokens(estimate * ratio);
  };
  return { manager, strategy, internals, rec, sample };
}

describe('calibration samples', () => {
  it('one record per sample, with its outcome, ratio and the multiplier after', async () => {
    const fx = await calibrated();
    await fx.sample(3);
    await fx.sample(1.01);
    await fx.sample(1.5);
    // A second report after one compile is no sample.
    fx.strategy.reportRealInputTokens(fx.internals._lastCompileEstimate * 1.5);
    const outcomes = fx.rec.samples.map((s) => s.outcome);
    assert.deepEqual(outcomes, ['out-of-band', 'held', 'stepped']);
    for (const [record, ratio] of fx.rec.samples.map((r, i) => [r, [3, 1.01, 1.5][i]!] as const)) {
      assert.ok(Math.abs(record.ratio - ratio) < 1e-9, `${record.outcome}: ratio ${record.ratio}, given ${ratio}`);
    }
    assert.equal(fx.rec.samples[0]!.multiplier, 1);
    assert.equal(fx.rec.samples[1]!.multiplier, 1);
    // The held sample moved the average to 1.002, and the step goes a fifth of the way from there to 1.5.
    assert.ok(Math.abs(fx.rec.samples[2]!.multiplier - (1.002 + 0.2 * (1.5 - 1.002))) < 1e-9, String(fx.rec.samples[2]!.multiplier));
    assert.equal(fx.rec.samples[2]!.multiplier, fx.internals._calibration);
    fx.manager.close();
  });

  it('a provisional multiplier is confirmed in the dead band, and replaced outside it', async () => {
    const confirm = await calibrated();
    await confirm.sample(1.01, true);
    assert.deepEqual(confirm.rec.samples.map((s) => [s.outcome, s.multiplier]), [['confirmed', 1]]);
    assert.ok(Math.abs(confirm.rec.samples[0]!.ratio - 1.01) < 1e-9);
    confirm.manager.close();

    const replace = await calibrated();
    await replace.sample(1.3, true);
    assert.equal(replace.rec.samples.length, 1);
    assert.equal(replace.rec.samples[0]!.outcome, 'replaced');
    assert.ok(Math.abs(replace.rec.samples[0]!.multiplier - 1.3) < 1e-9, String(replace.rec.samples[0]!.multiplier));
    assert.ok(Math.abs(replace.rec.samples[0]!.ratio - 1.3) < 1e-9);
    replace.manager.close();
  });

  it('a ratio out of band whose implied multiplier is in band is learned, not out-of-band', async () => {
    // At the 1.8 clamp, an honest sample reads about 0.56 of the estimate: out of band as a ratio, but it implies 1.008.
    const fx = await calibrated();
    await fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 2_000 });
    fx.internals._calibration = 1.8;
    fx.strategy.reportRealInputTokens(fx.internals._lastCompileEstimate * 0.56);
    assert.equal(fx.rec.samples.length, 1);
    assert.equal(fx.rec.samples[0]!.outcome, 'stepped');
    assert.ok(Math.abs(fx.rec.samples[0]!.ratio - 0.56) < 1e-9);
    assert.ok(Math.abs(fx.rec.samples[0]!.multiplier - (1.8 + 0.2 * (0.56 * 1.8 - 1.8))) < 1e-9, String(fx.rec.samples[0]!.multiplier));
    fx.manager.close();
  });

  it('an observed preview leaves the strategy as an unobserved one does: its options reach the work', async () => {
    for (const observe of ['none', 'record'] as const) {
      const fx = await calibrated(observe);
      await fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 2_000 }, undefined, { dryRun: true });
      assert.equal(fx.internals._calibrationArmed, false, `${observe}: a preview arms no sample`);
      fx.strategy.reportRealInputTokens(5_000);
      assert.deepEqual(fx.rec.samples, [], `${observe}: so a report after it is no sample`);
      if (observe === 'record') assert.equal(fx.rec.compiles.at(-1)!.dryRun, true);
      await fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 2_000 });
      assert.equal(fx.internals._calibrationArmed, true, `${observe}: a live compile arms one`);
      fx.manager.close();
    }
  });

  it('a report that is no sample makes no record and leaves the sample armed', async () => {
    const fresh = await calibrated();
    fresh.strategy.reportRealInputTokens(5_000);
    assert.deepEqual(fresh.rec.samples, [], 'no compile, so no estimate to compare');
    fresh.manager.close();

    const fx = await calibrated();
    await fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 2_000 });
    for (const total of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) fx.strategy.reportRealInputTokens(total);
    assert.equal(fx.rec.samples.length, 0);
    assert.equal(fx.internals._calibrationArmed, true, 'the compile\'s sample is still to come');
    fx.strategy.reportRealInputTokens(fx.internals._lastCompileEstimate * 1.01);
    assert.deepEqual(fx.rec.samples.map((r) => r.outcome), ['held']);
    fx.manager.close();
  });

  it('an observer that throws or rejects changes nothing a sample does', async () => {
    const multipliers: number[] = [];
    const told: string[][] = [[], []];
    const stray = await unhandledRejections(async () => {
      for (const observe of ['none', hostile('throws', told[0]), hostile('rejects', told[1])] as const) {
        const fx = await calibrated(observe);
        await fx.sample(3);
        await fx.sample(1.5);
        multipliers.push(fx.internals._calibration);
        fx.manager.close();
      }
    });
    assert.equal(multipliers[1], multipliers[0]);
    assert.equal(multipliers[2], multipliers[0]);
    assert.notEqual(multipliers[0], 1, 'the stepped sample moved it');
    for (const calls of told) assert.equal(calls.filter((c) => c === 'calibration').length, 2, `both samples reached the hostile observer: ${calls.join(', ')}`);
    assert.deepEqual(stray, []);
  });
});
