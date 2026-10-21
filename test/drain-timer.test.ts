/**
 * The speculative drain schedules each next tick on a timer, and no caller
 * awaits that tick, so whatever it throws reaches the process as an uncaught
 * exception, which ends a host's process under Bun and Node alike. A tick
 * that comes due on a store closed while it waited, as a host's stop() closes
 * one, doesn't run, and the drain ends quietly, as on a withdrawal: the host
 * is done with it. Whatever a tick throws is logged, as the drain's other
 * errors are.
 *
 * Each test holds the drain's timer callback instead of letting it run, so
 * what happens between the scheduling and the tick is set by the test, not by
 * a race.
 */

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext } from '../src/types/index.js';

/** Answers at once, with no timer of its own, so the drain's is the only one. */
const membrane = {
  complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'A summary of the chunk.' }] }),
};

/**
 * A manager on an app-owned store, as a host's framework opens one, with
 * chunks queued for compression and the drain's first tick done. Returns the
 * timer callback the drain scheduled for its next tick, held, and what was
 * logged.
 */
async function drainWithNextTickHeld(t: TestContext, strategy: AutobiographicalStrategy) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-drain-timer-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  t.after(() => {
    if (!store.isClosed()) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
  for (let i = 0; i < 16; i++) {
    manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `message ${i}: ${'word '.repeat(30)}` }]);
  }
  await manager.compile();
  const queue = (strategy as unknown as { compressionQueue: number[] }).compressionQueue;
  assert.ok(queue.length >= 2, `premise: at least two chunks queued (${queue.length})`);

  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  t.mock.method(console, 'warn', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const held: Array<() => void> = [];
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => {
    held.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);

  // One trigger, as an incoming message's would be.
  const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
  (strategy as unknown as { driveSpeculativeDrain(c: StrategyContext): void }).driveSpeculativeDrain(ctx);
  for (let i = 0; i < 1000 && held.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held.length, 1, 'premise: the first tick compressed a chunk and scheduled the next tick');
  assert.equal(strategy.getStats().chunksCompressed, 1, 'premise: one chunk compressed');
  // Only what the next tick logs counts.
  logged.length = 0;
  return { store, held, logged };
}

const options = {
  compressionModel: 'test-compression-model',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false, // the test triggers the drain itself
  minChunkCharsForLLM: 0,
};

describe('the speculative drain\'s timer lets no error out', () => {
  it('a store closed while the next tick waits ends the drain quietly', async (t) => {
    const strategy = new AutobiographicalStrategy(options);
    const { store, held, logged } = await drainWithNextTickHeld(t, strategy);
    store.close();
    assert.doesNotThrow(() => held[0]!());
    assert.deepEqual(logged, []);
    assert.equal(held.length, 1, 'the drain scheduled nothing more');
  });

  it('a throw from the next tick is logged as a drain error', async (t) => {
    // A preflight that breaks on the drain's second tick, as a subclass's
    // hook might.
    class BreakingPreflight extends AutobiographicalStrategy {
      private preflights = 0;
      protected override shouldCompressPreflight(): boolean {
        this.preflights++;
        if (this.preflights > 1) throw new Error('preflight broke');
        return true;
      }
    }
    const strategy = new BreakingPreflight(options);
    const { held, logged } = await drainWithNextTickHeld(t, strategy);
    assert.doesNotThrow(() => held[0]!());
    assert.deepEqual(logged, ['AutobiographicalStrategy: speculative-drain error: Error: preflight broke ns=default']);
    assert.equal(held.length, 1, 'the drain scheduled nothing more');
  });

  it('a throw with line breaks is logged on one line', async (t) => {
    class BreakingPreflight extends AutobiographicalStrategy {
      private preflights = 0;
      protected override shouldCompressPreflight(): boolean {
        this.preflights++;
        if (this.preflights > 1) throw new Error('preflight broke\n  on its second line');
        return true;
      }
    }
    const strategy = new BreakingPreflight(options);
    const { held, logged } = await drainWithNextTickHeld(t, strategy);
    assert.doesNotThrow(() => held[0]!());
    assert.deepEqual(logged, ['AutobiographicalStrategy: speculative-drain error: Error: preflight broke on its second line ns=default']);
  });
});
