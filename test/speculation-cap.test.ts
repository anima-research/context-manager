/**
 * Tests for speculation cap + preflight hook (audit gap #8).
 *
 * Pre-fix: every new message triggered an auto-tick that compressed any
 * pending chunk, regardless of how many speculative L1s the strategy was
 * already holding. Lena's archive on Hermes ended up with dozens of
 * speculatively-built L1s before there was any real budget pressure.
 *
 * Post-fix:
 *  - `maxSpeculativeL1s` caps the count of (unmerged L1s + queued chunks).
 *    When at cap, `onNewMessage` defers auto-tick — chunks still queue,
 *    but compression doesn't fire until an explicit tick() / compile().
 *  - `shouldCompressPreflight()` is overridable so subclasses can add
 *    custom predictive scheduling.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry, StrategyContext } from '../src/types/index.js';

const TEST_STORE_PATH = './test-speculation-cap';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class TickCountingStrategy extends AutobiographicalStrategy {
  public tickCalls = 0;

  override async tick(ctx: StrategyContext): Promise<void> {
    this.tickCalls++;
    // Do NOT call super.tick — we don't have a real membrane in tests
    // and we just want to count whether onNewMessage decided to fire.
  }

  seedL1(content: string): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L1-${this.nextSummaryIdCounter()}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds: ['x'],
      sourceRange: { first: 'x', last: 'x' },
      created: Date.now(),
    };
    this.pushSummary(entry);
    return entry;
  }

  /** True if there's an unprocessed chunk eligible for compression. */
  hasQueuedChunk(): boolean {
    return (this as any).compressionQueue.length > 0;
  }
}

/**
 * Add enough small messages to force ≥1 chunk to form in the
 * compressible region. With targetChunkTokens=20 and chunkOnMessageBoundary,
 * 5 messages of ~6 tokens each will close one chunk after 4 msgs.
 */
async function setupWithQueuedChunk(strategy: TickCountingStrategy): Promise<ContextManager> {
  const manager = await ContextManager.open({
    path: TEST_STORE_PATH,
    strategy,
  });
  // recentWindowTokens=5 (small) means only the latest message stays in recent;
  // the rest are compressible and will form chunks once we hit targetChunkTokens.
  // 5 padding messages of ~6 tokens, plus one trailing recent message.
  for (let i = 0; i < 5; i++) {
    manager.addMessage('user', textBlock(`m-${i} hello world`));
  }
  manager.addMessage('user', textBlock('latest one ' + 'X'.repeat(20)));
  // Wait for any onNewMessage handlers to settle
  await new Promise(r => setTimeout(r, 30));
  return manager;
}

describe('AutobiographicalStrategy — speculation cap (gap #8)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('default: auto-tick fires whenever a chunk is queued', async () => {
    const strategy = new TickCountingStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 5,
      targetChunkTokens: 20,
      autoTickOnNewMessage: true,
    });
    const manager = await setupWithQueuedChunk(strategy);

    assert.ok(strategy.hasQueuedChunk(), 'sanity: chunk should have formed in compressible region');
    assert.ok(strategy.tickCalls >= 1, `default behavior must auto-tick (got ${strategy.tickCalls})`);
    manager.close();
  });

  it('with maxSpeculativeL1s, auto-tick is deferred when at cap', async () => {
    const strategy = new TickCountingStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 5,
      targetChunkTokens: 20,
      autoTickOnNewMessage: true,
      maxSpeculativeL1s: 2,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    // Seed AFTER open so initialize() doesn't wipe the seeds.
    strategy.seedL1('summary 1');
    strategy.seedL1('summary 2');
    strategy.seedL1('summary 3');

    const ticksBefore = strategy.tickCalls;
    for (let i = 0; i < 5; i++) {
      manager.addMessage('user', textBlock(`m-${i} hello world`));
    }
    manager.addMessage('user', textBlock('latest one ' + 'X'.repeat(20)));
    await new Promise(r => setTimeout(r, 30));

    assert.ok(strategy.hasQueuedChunk(), 'sanity: chunk formed');
    assert.equal(
      strategy.tickCalls,
      ticksBefore,
      'auto-tick must NOT fire when unmerged L1s already exceed maxSpeculativeL1s',
    );
    manager.close();
  });

  it('cap allows auto-tick when count is under the limit', async () => {
    const strategy = new TickCountingStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 5,
      targetChunkTokens: 20,
      autoTickOnNewMessage: true,
      maxSpeculativeL1s: 5,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    strategy.seedL1('summary 1');

    const ticksBefore = strategy.tickCalls;
    for (let i = 0; i < 5; i++) {
      manager.addMessage('user', textBlock(`m-${i} hello world`));
    }
    manager.addMessage('user', textBlock('latest one ' + 'X'.repeat(20)));
    await new Promise(r => setTimeout(r, 30));

    assert.ok(strategy.hasQueuedChunk(), 'sanity: chunk formed');
    assert.ok(strategy.tickCalls > ticksBefore, 'auto-tick should fire when under cap');
    manager.close();
  });

  it('shouldCompressPreflight=false defers auto-tick', async () => {
    class DeferAlways extends TickCountingStrategy {
      protected override shouldCompressPreflight(): boolean { return false; }
    }
    const strategy = new DeferAlways({
      headWindowTokens: 0,
      recentWindowTokens: 5,
      targetChunkTokens: 20,
      autoTickOnNewMessage: true,
    });
    const manager = await setupWithQueuedChunk(strategy);

    assert.ok(strategy.hasQueuedChunk(), 'sanity: chunk formed');
    assert.equal(strategy.tickCalls, 0, 'preflight=false must block auto-tick');
    manager.close();
  });
});
