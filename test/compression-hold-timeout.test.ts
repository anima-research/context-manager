/**
 * Optional compression-hold timeouts. A hold with `timeoutMs` is released
 * automatically (through the releaseCompression path) once it expires;
 * expiry is checked lazily on tick(), compile() and hold queries. A hold
 * without a timeout is never released automatically.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy } from '../src/index.js';
import type { ContextStrategy, StrategyContext } from '../src/types/index.js';

const PATH = './test-compression-hold-timeout';
const cleanup = () => { if (existsSync(PATH)) rmSync(PATH, { recursive: true, force: true }); };

async function open(clock: { t: number }, strategy?: ContextStrategy) {
  return ContextManager.open({ path: PATH, now: () => clock.t, ...(strategy ? { strategy } : {}) });
}

describe('compression hold timeouts', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it('a hold with timeoutMs expires lazily on hold queries', async () => {
    const clock = { t: 1_000 };
    const m = await open(clock);
    const id = m.addMessage('User', [{ type: 'text', text: 'x' }]);
    m.holdCompression([id], { timeoutMs: 500 });
    assert.deepStrictEqual(m.getCompressionHoldDetails().get(id), { heldAt: 1_000, expiresAt: 1_500 });
    clock.t = 1_499;
    assert.ok(m.getCompressionHolds().has(id));
    clock.t = 1_500;
    assert.strictEqual(m.getCompressionHolds().size, 0);
    m.close();
  });

  it('expiry is checked on tick() and compile(), notifies the strategy, and warns', async () => {
    const clock = { t: 0 };
    let notified = 0;
    const strategy = new (class extends PassthroughStrategy {
      onCompressionHoldsReleased(_ctx: StrategyContext): void { notified++; }
    })();
    const m = await open(clock, strategy);
    const a = m.addMessage('User', [{ type: 'text', text: 'a' }], undefined, undefined, { holdCompression: { timeoutMs: 100 } });
    const b = m.addMessage('User', [{ type: 'text', text: 'b' }], undefined, undefined, { holdCompression: { timeoutMs: 200 } });
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      clock.t = 150;
      await m.tick();
      assert.strictEqual(notified, 1);
      assert.ok(warnings.some((w) => w.includes(a) && w.includes('150ms')), warnings.join('\n'));
      clock.t = 250;
      await m.compile();
      assert.strictEqual(notified, 2);
      assert.ok(warnings.some((w) => w.includes(b) && w.includes('250ms')), warnings.join('\n'));
    } finally {
      console.warn = orig;
    }
    m.close();
  });

  it('holds without a timeout are never released automatically', async () => {
    const clock = { t: 0 };
    const m = await open(clock);
    const id = m.addMessage('User', [{ type: 'text', text: 'x' }], undefined, undefined, { holdCompression: true });
    clock.t = 10 ** 12;
    await m.tick();
    await m.compile();
    assert.ok(m.getCompressionHolds().has(id));
    assert.deepStrictEqual(m.getCompressionHoldDetails().get(id), { heldAt: 0 });
    m.close();
  });

  it('re-holding replaces the timeout (refresh, extend, or make indefinite)', async () => {
    const clock = { t: 0 };
    const m = await open(clock);
    const id = m.addMessage('User', [{ type: 'text', text: 'x' }]);
    m.holdCompression([id], { timeoutMs: 100 });
    clock.t = 90;
    m.holdCompression([id], { timeoutMs: 100 }); // refresh → expires at 190
    clock.t = 150;
    assert.ok(m.getCompressionHolds().has(id));
    m.holdCompression([id]); // no timeout → indefinite
    clock.t = 10_000;
    assert.ok(m.getCompressionHolds().has(id));
    m.holdCompression([id], { timeoutMs: 1 }); // timed again
    clock.t = 10_001;
    assert.ok(!m.getCompressionHolds().has(id));
    m.close();
  });

  it('a timed hold on a sharded add expires all shards together', async () => {
    const clock = { t: 0 };
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'm', targetChunkTokens: 50, adaptiveResolution: true, autoTickOnNewMessage: false,
    });
    const m = await open(clock, strategy);
    const before = m.getAllMessages().length;
    m.addMessage('Claude', [{ type: 'text', text: 'long sentence. '.repeat(200) }], undefined, undefined,
      { holdCompression: { timeoutMs: 10 } });
    const shards = m.getAllMessages().length - before;
    assert.ok(shards > 1);
    assert.strictEqual(m.getCompressionHolds().size, shards);
    clock.t = 10;
    assert.strictEqual(m.getCompressionHolds().size, 0);
    m.close();
  });

  it('timeoutMs must be a positive finite number', async () => {
    const m = await open({ t: 0 });
    const id = m.addMessage('User', [{ type: 'text', text: 'x' }]);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => m.holdCompression([id], { timeoutMs: bad }), /timeoutMs/);
    }
    m.close();
  });
});
