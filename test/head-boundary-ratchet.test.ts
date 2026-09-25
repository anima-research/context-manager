/**
 * Head-boundary ratchet (issue #122): a calibration rise must not peel the head into
 * out-of-order L1s.
 *
 * The head window is "the first headWindowTokens tokens", priced with the live
 * calibration multiplier. When calibration rose, the boundary moved down, and
 * the messages that fell out were not covered by any chunk. They became
 * compressible, got their own late-created chunks + L1s, and were owned from
 * then on, so the head never grew back. Production (a ~22k-message store):
 * 15 head messages peeled off one or two at a time into 13 L1s over three
 * days. Created late, they sat next to the open frontier in chunk-record order
 * and merged into L2/L3s that mixed the chronicle's opening day with material
 * two months later.
 *
 * Invariant under test: once coverage exists after the head, a calibration
 * rise leaves the head boundary where coverage begins, and no chunk ever
 * takes a message from before it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-head-boundary-ratchet';

function cleanup() {
  for (const p of [TEST_STORE_PATH, `${TEST_STORE_PATH}-b`]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

const t = (s: string): ContentBlock[] => [{ type: 'text', text: s }];

function createMembrane() {
  let calls = 0;
  const membrane = {
    complete: async () => {
      calls++;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `[mock summary ${calls}] ` + 'recalled happenings '.repeat(20) }],
        usage: { input_tokens: 100, output_tokens: 60 },
      };
    },
  };
  return { membrane, calls: () => calls };
}

class ProbeStrategy extends AutobiographicalStrategy {
  headEnd(ctx: StrategyContext): number {
    return this.getHeadWindowEnd(ctx.messageStore);
  }
  /** Store index of the earliest message any chunk record owns. */
  firstChunked(ctx: StrategyContext): number {
    const index = new Map(ctx.messageStore.getAll().map((m, i) => [m.id, i]));
    let min = Infinity;
    for (const ch of this.chunks) for (const m of ch.messages) min = Math.min(min, index.get(m.id)!);
    return min;
  }
  chunkCount(): number {
    return this.chunks.length;
  }
}

function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

const HEAD_MESSAGES = 8;
const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);

async function openSeeded(path: string, fillerCount: number) {
  const { membrane, calls } = createMembrane();
  const strategy = new ProbeStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 80,
    headWindowTokens: 1e9, // nothing chunks while the head is seeded; re-derived below
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 1000, // pure L1 behavior
  });
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  for (let i = 0; i < HEAD_MESSAGES; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', t(`HEAD_${i} ` + 'opening words of the chronicle '.repeat(3)));
  }
  const ctx = managerContext(manager);
  // Head = exactly the first HEAD_MESSAGES at calibration 1: the budget is their
  // cumulative estimate (the boundary lands on the first message exceeding it).
  const all = ctx.messageStore.getAll();
  let sum = 0;
  for (let i = 0; i < HEAD_MESSAGES; i++) sum += ctx.messageStore.estimateTokens(all[i]!);
  (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens = sum;
  for (let i = 0; i < fillerCount; i++) manager.addMessage(i % 2 === 0 ? 'user' : 'agent', t(filler(i)));
  return { manager, strategy, ctx, calls };
}

describe('Head boundary vs calibration drift (ratchet regression)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('a calibration rise keeps the head where coverage begins; no late chunks before it', async () => {
    const { manager, strategy, ctx } = await openSeeded(TEST_STORE_PATH, 40);
    await drain(manager);
    assert.strictEqual(strategy.headEnd(ctx), HEAD_MESSAGES, 'fixture: head ends where calibrated');
    assert.strictEqual(strategy.firstChunked(ctx), HEAD_MESSAGES, 'fixture: coverage starts right after the head');
    const chunksBefore = strategy.chunkCount();

    // Calibration rises (the closed loop does this whenever real usage beats the
    // estimate). At 1.6 the stock boundary must fall well inside the old head,
    // or this test would not exercise the ratchet at all.
    ctx.messageStore.setTokenCalibration!(1.6);
    const all = ctx.messageStore.getAll();
    let sum = 0, stock = 0;
    const budget = (strategy as unknown as { config: { headWindowTokens: number } }).config.headWindowTokens;
    for (; stock < all.length; stock++) { sum += ctx.messageStore.estimateTokens(all[stock]!); if (sum > budget) break; }
    assert.ok(stock <= HEAD_MESSAGES - 2, `fixture: the stock boundary must shrink the head (got ${stock})`);

    assert.strictEqual(strategy.headEnd(ctx), HEAD_MESSAGES, 'head must stay anchored to coverage, not shrink');

    // Live traffic keeps arriving and ticking — the moment the ratchet fired.
    for (let i = 40; i < 60; i++) manager.addMessage(i % 2 === 0 ? 'user' : 'agent', t(filler(i)));
    await drain(manager);
    assert.ok(strategy.chunkCount() > chunksBefore, 'fixture: new traffic must have been chunked');
    assert.strictEqual(
      strategy.firstChunked(ctx),
      HEAD_MESSAGES,
      'no chunk may take a head message that the calibration rise pushed past the token boundary',
    );
    await manager.close();
  });

  it('without coverage after the boundary the stock token boundary stands', async () => {
    const { manager, strategy, ctx } = await openSeeded(`${TEST_STORE_PATH}-b`, 0);
    // Only the head exists: nothing is chunked, so there is no coverage to anchor to.
    assert.strictEqual(strategy.chunkCount(), 0, 'fixture: no chunks yet');
    ctx.messageStore.setTokenCalibration!(1.6);
    const end = strategy.headEnd(ctx);
    assert.ok(end < HEAD_MESSAGES, `fresh session: the calibrated token boundary applies (got ${end})`);
    await manager.close();
  });
});
