/**
 * Tests for speculation cap + preflight hook (audit gap #8).
 *
 * Pre-fix: every new message triggered an auto-tick that compressed any
 * pending chunk, regardless of how many speculative L1s the strategy was
 * already holding. Lena's archive on Hermes ended up with dozens of
 * speculatively-built L1s before there was any real budget pressure.
 *
 * Post-fix:
 *  - `maxSpeculativeL1s` caps the count of *produced, unmerged* L1 summaries.
 *    When at cap, `onNewMessage` defers auto-tick L1 production — chunks still
 *    queue, but compression doesn't fire until merges bring the unmerged count
 *    back under the cap (or an explicit tick() / compile()).
 *  - The cap does NOT count the pending compression backlog and does NOT gate
 *    merges: merges consolidate L1s into L_{k+1} and REDUCE the unmerged count,
 *    so gating them would deadlock (too many unmerged L1s blocks the merges that
 *    would relieve the cap, and a large backlog blocks the compression that
 *    would drain it). See the "does not deadlock" regression suite below.
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
      l1HoldbackChunks: 0, // this suite tests cap/preflight gating at chunk close
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
      l1HoldbackChunks: 0, // this suite tests cap/preflight gating at chunk close
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
      l1HoldbackChunks: 0, // this suite tests cap/preflight gating at chunk close
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
      l1HoldbackChunks: 0, // this suite tests cap/preflight gating at chunk close
    });
    const manager = await setupWithQueuedChunk(strategy);

    assert.ok(strategy.hasQueuedChunk(), 'sanity: chunk formed');
    assert.equal(strategy.tickCalls, 0, 'preflight=false must block auto-tick');
    manager.close();
  });
});

/**
 * Regression: the speculation cap must throttle L1 *production* without
 * deadlocking. Before this fix, `isAtSpeculativeCap()` counted
 * `unmergedL1s + compressionQueue.length` and gated the *entire* drain. A store
 * that accumulated more unmerged L1s than the cap (e.g. a manual backfill) could
 * never recover: the cap blocked the merges that would reduce the count, and the
 * backlog blocked the compression that would drain it. (Observed live: an agent
 * with 79 unmerged L1s, cap 36, and 13 queued merges sat frozen indefinitely.)
 */
describe('AutobiographicalStrategy — speculation cap does not deadlock (regression)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  class DrainStrategy extends AutobiographicalStrategy {
    public mergeRuns = 0;

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
    queueMerge(ids: string[]): void {
      (this as any).enqueueMerge({ level: 2, sourceIds: ids });
    }
    atCap(): boolean { return (this as any).isAtSpeculativeCap(); }
    unmergedL1(): number {
      return (this as any).summaries.filter((s: SummaryEntry) => s.level === 1 && !s.mergedInto).length;
    }
    get mergeQ(): unknown[] { return (this as any).mergeQueue; }
    get compQ(): number[] { return (this as any).compressionQueue; }

    // Isolate the drain/cap gating from executeMerge's message-store coupling:
    // simulate a successful merge by marking the sources merged.
    protected override async executeMerge(_level: any, sourceIds: string[]): Promise<void> {
      this.mergeRuns++;
      for (const id of sourceIds) {
        const s = (this as any).summaries.find((x: SummaryEntry) => x.id === id);
        if (s) (s as any).mergedInto = 'L2-test';
      }
    }
  }

  it('cap counts produced unmerged L1s only — a compression backlog must not trip it', async () => {
    const strategy = new DrainStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 5,
      maxSpeculativeL1s: 5,
      hierarchical: true,
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    strategy.seedL1('only one'); // 1 produced unmerged L1
    for (let i = 0; i < 100; i++) strategy.compQ.push(i); // huge pending backlog

    assert.equal(
      strategy.atCap(),
      false,
      'a 100-deep compression backlog with 1 produced L1 must NOT trip a cap of 5 (pre-fix deadlock)',
    );

    for (let i = 0; i < 5; i++) strategy.seedL1(`x${i}`); // now 6 produced unmerged > 5
    assert.equal(strategy.atCap(), true, 'six produced unmerged L1s exceed the cap of 5');

    manager.close();
  });

  it('over-cap with queued merges still drains merges, then the cap clears', async () => {
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: '[mock]' }] }) };
    const strategy = new DrainStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 5,
      maxSpeculativeL1s: 3,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(strategy.seedL1(`s${i}`).id); // 8 unmerged > cap 3
    strategy.queueMerge(ids.slice(0, 6)); // one L2 merge over 6 of them

    assert.equal(strategy.atCap(), true, 'precondition: over the cap');
    assert.equal(strategy.mergeQ.length, 1, 'precondition: a merge is queued');

    await manager.tick(); // pre-fix: bailed at the cap → permanent deadlock

    assert.equal(strategy.mergeRuns, 1, 'merge must run even while over the speculative cap');
    assert.equal(strategy.mergeQ.length, 0, 'merge dequeued after success');
    assert.equal(strategy.unmergedL1(), 2, '6 of 8 L1s consolidated');
    assert.equal(strategy.atCap(), false, 'cap cleared → L1 compression can resume');

    manager.close();
  });
});

/**
 * Regression: `driveSpeculativeDrain` must keep recursing as long as ticks do
 * real work — using a monotonic work counter, NOT a queue-length delta. A
 * productive tick can ALSO enqueue a follow-on item (e.g. a merge that schedules
 * the next-level merge), leaving the queue length unchanged. The old
 * length-delta check read that as "no progress" and halted the drain with the
 * backlog only partly cleared — observed live: a single trigger drained ~4 of
 * Lena's 13 queued merges, then stalled until the next message.
 */
describe('AutobiographicalStrategy — drain progresses past flat-length ticks (regression)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  class FlatQueueStrategy extends AutobiographicalStrategy {
    public mergeRuns = 0;
    private refills = 4;
    private used = new Set<string>();

    seedL1(content: string): SummaryEntry {
      const entry: SummaryEntry = {
        id: `L1-${this.nextSummaryIdCounter()}`,
        level: 1, content, tokens: Math.ceil(content.length / 4),
        sourceLevel: 0, sourceIds: ['x'], sourceRange: { first: 'x', last: 'x' },
        created: Date.now(),
      };
      this.pushSummary(entry);
      return entry;
    }
    qMerge(ids: string[]): void { (this as any).enqueueMerge({ level: 2, sourceIds: ids }); }
    get mergeQ(): unknown[] { return (this as any).mergeQueue; }

    // Each merge consolidates its sources AND (for the first few) enqueues a
    // follow-on merge — so the queue length nets out unchanged that tick.
    protected override async executeMerge(_level: any, sourceIds: string[]): Promise<void> {
      this.mergeRuns++;
      for (const id of sourceIds) {
        const s = (this as any).summaries.find((x: SummaryEntry) => x.id === id);
        if (s) (s as any).mergedInto = 'L2-x';
        this.used.add(id);
      }
      if (this.refills-- > 0) {
        const fresh = (this as any).summaries
          .filter((s: SummaryEntry) => s.level === 1 && !s.mergedInto && !this.used.has(s.id))
          .slice(0, 6).map((s: SummaryEntry) => s.id);
        if (fresh.length >= 2) this.qMerge(fresh);
      }
    }
  }

  it('a single trigger drains all merges even when each enqueues a follow-on (flat length)', async () => {
    const strategy = new FlatQueueStrategy({
      headWindowTokens: 0, recentWindowTokens: 5, hierarchical: true, // no cap → merges always allowed
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) } as any,
    });
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(strategy.seedL1(`s${i}`).id);
    strategy.qMerge(ids.slice(0, 6)); // 1 queued; 4 refills → 5 merges total expected

    // One trigger, as a single onNewMessage would do.
    (strategy as any).driveSpeculativeDrain((manager as any).createStrategyContext());

    // Let the microtask recursion + async ticks settle.
    for (let i = 0; i < 100 && strategy.mergeQ.length > 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 50));

    assert.ok(
      strategy.mergeRuns >= 5,
      `drain must process all merges incl. follow-ons (ran ${strategy.mergeRuns}); pre-fix it halts at 1`,
    );
    assert.equal(strategy.mergeQ.length, 0, 'merge queue fully drained from a single trigger');
    manager.close();
  });
});
