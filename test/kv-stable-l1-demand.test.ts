/**
 * kv-stable L1-holdback deadlock — end-to-end regression (issue #56).
 *
 * At tight operating points the budget wall can land while the only
 * uncompressed material is the unclosed trailing span plus the held-back
 * newest closed chunk(s). Three facts used to compose into a permanent wedge:
 *
 *  1. `KvStableStrategy` returned `produced: []` unconditionally;
 *  2. the demand path (`handleProducedOps` → `enqueueL1ForRange` →
 *     `_demandedL1Chunks`) is reachable only via picker produce ops;
 *  3. the L1 holdback filter keeps the newest closed chunk(s) out of the
 *     speculative queue unless demanded.
 *
 * So the speculative queue was empty, demand could never be raised, no L1
 * could ever be produced for the span the solve needed, and every compile
 * escalated infeasible forever — recovery required config surgery.
 *
 * Under test: an escalated kv-stable compile still hard-fails (a produce op
 * does not make the current plan feasible), but it now RAISES DEMAND on the
 * way down — the uncovered chunks, including held-back ones, enter the
 * compression queue marked demanded, so the drain can produce the L1s and a
 * later compile can fold. Waiting recovers the agent; config surgery doesn't.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { Chunk } from '../src/strategies/autobiographical.js';
import { OverBudgetError } from '../src/adaptive/picker.js';

const TEST_STORE_PATH = './test-kv-stable-l1-demand';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class InspectableStrategy extends AutobiographicalStrategy {
  queuedChunkIndices(): number[] {
    return [...(this as any).compressionQueue] as number[];
  }
  closedChunks(): Chunk[] {
    return (this as any).chunks as Chunk[];
  }
  demandedL1Count(): number {
    return (this as any)._demandedL1Chunks.size as number;
  }
}

function makeStrategy(overrides: Record<string, unknown> = {}): InspectableStrategy {
  return new InspectableStrategy({
    compressionModel: 'mock',
    headWindowTokens: 0,
    targetChunkTokens: 100,
    recentWindowTokens: 200,
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    autoTickOnNewMessage: false, // inspect queues without draining them
    ...overrides,
  });
}

describe('kv-stable — escalated compile raises L1 demand (issue #56)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('an infeasible compile throws OverBudgetError but demands the held-back chunks', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    // Enough conversation to close several chunks; nothing is compressed
    // (autoTick off), so the whole middle is L1-uncovered raw mass.
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', textBlock(`Turn ${i}. ` + 'word '.repeat(40)));
    }
    const closed = strategy.closedChunks();
    assert.ok(closed.length >= 2, `test premise: several closed chunks (got ${closed.length})`);
    const newest = closed[closed.length - 1];
    assert.ok(
      !strategy.queuedChunkIndices().includes(newest.index),
      'test premise: the newest closed chunk is held back from the speculative queue',
    );
    assert.strictEqual(strategy.demandedL1Count(), 0, 'test premise: no demand raised yet');

    // A wall far below the raw middle with zero summaries available: the
    // solve must escalate, and the compile must hard-fail — a produce op
    // schedules work, it never authorizes an inference.
    await assert.rejects(
      manager.compile({ maxTokens: 600, reserveForResponse: 100 }),
      (err: unknown) => err instanceof OverBudgetError,
      'escalated plan still refuses the compile',
    );

    // ...but the failure raised demand: every closed chunk is queued for L1
    // production, including the held-back newest one, and the demand marks
    // will keep them queued across rebuilds. This is the path that was
    // unreachable pre-#56 (produced was always empty under kv-stable).
    assert.ok(strategy.demandedL1Count() > 0, 'demand was raised by the failing compile');
    const queued = strategy.queuedChunkIndices();
    for (const ch of strategy.closedChunks()) {
      assert.ok(
        queued.includes(ch.index),
        `closed chunk ${ch.index} queued for L1 production (newest = ${newest.index})`,
      );
    }
    manager.close();
  });

  it('a feasible kv-stable compile raises no demand', async () => {
    const strategy = makeStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', textBlock(`Turn ${i}. ` + 'word '.repeat(40)));
    }
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    assert.ok(compiled.messages.length > 0, 'live compile must produce output');
    assert.strictEqual(
      strategy.demandedL1Count(),
      0,
      'no escalation → no demand; speculative production stays the pre-producer\'s job',
    );
    manager.close();
  });
});
