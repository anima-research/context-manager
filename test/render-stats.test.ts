/**
 * getRenderStats must INSPECT what select() actually rendered, not RECONSTRUCT
 * a hierarchical view. Regression for the adaptive-resolution case where the
 * reconstructed pyramid (head/tail windows + every live summary) bore no
 * relation to the folded output — and had no bucket at all for raw messages the
 * picker kept verbatim in the middle.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, OverBudgetError, PassthroughStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { RenderStats } from '../src/types/index.js';

const TEST_STORE_PATH = './test-render-stats';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}
function text(t: string): ContentBlock[] {
  return [{ type: 'text', text: t }];
}

/** The store's estimate of the compiled messages as they go out. */
function sentTokens(manager: ContextManager, messages: ReadonlyArray<{ content: ContentBlock[] }>): number {
  const store = (manager as unknown as { messageStore: { estimateTokens(m: { content: ContentBlock[] }): number } }).messageStore;
  return messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content }), 0);
}

const summarizer = {
  complete: async () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'A memory of this stretch, kept brief: ' + 'detail '.repeat(12) }],
    usage: { input_tokens: 1000, output_tokens: 40 },
  }),
};
const kvStable = () => new AutobiographicalStrategy({
  compressionModel: 'zz-model',
  targetChunkTokens: 120,
  headWindowTokens: 0,
  recentWindowTokens: 400,
  hierarchical: true,
  mergeThreshold: 3,
  adaptiveResolution: true,
  foldingStrategy: 'kv-stable',
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);

/** A compressed history with L1s and merges, as budget-expands-detail builds
 *  it, closed so the caller reopens it as a host restart does. */
async function buildKvStableStore(): Promise<void> {
  const builder = await ContextManager.open({ path: TEST_STORE_PATH, strategy: kvStable(), membrane: summarizer as any });
  for (let i = 0; i < 160; i++) {
    builder.addMessage(i % 2 === 0 ? 'user' : 'agent',
      text(`turn ${i}: steady substantive traffic about the ongoing work, with specifics `.repeat(4)));
    for (let k = 0; k < 200 && !builder.isReady(); k++) await builder.tick();
  }
  await builder.compile({ maxTokens: 4_000, reserveForResponse: 0 });
  for (let k = 0; k < 500 && !builder.isReady(); k++) await builder.tick();
  await builder.close();
}

function assertConsistent(rs: RenderStats): void {
  const s = rs.summaries;
  const sumTokens =
    rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens +
    s.l1.tokens + s.l2.tokens + s.l3.tokens;
  assert.strictEqual(rs.total.tokens, sumTokens, 'total.tokens === sum of bucket tokens');
  const sumMsgs =
    rs.head.messages + rs.tail.messages + rs.middleRaw.messages +
    (s.l1.count + s.l2.count + s.l3.count) * 2;
  assert.strictEqual(rs.total.messages, sumMsgs, 'total.messages === sum of bucket messages');
}

describe('getRenderStats — inspect, not reconstruct', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('reflects the actually-rendered raw conversation (every message accounted for once)', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ adaptiveResolution: true }),
    });
    const N = 8;
    for (let i = 0; i < N; i++) {
      manager.addMessage(i % 2 ? 'lena' : 'user', text(`message ${i} ${'x'.repeat(20)}`));
    }
    await manager.compile();

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present after compile');
    assertConsistent(rs!);
    // Small conversation, no membrane => no compression => no summaries.
    assert.strictEqual(
      rs!.summaries.l1.count + rs!.summaries.l2.count + rs!.summaries.l3.count,
      0,
      'no summaries for a small raw conversation',
    );
    const rawMsgs = rs!.head.messages + rs!.tail.messages + rs!.middleRaw.messages;
    assert.strictEqual(rawMsgs, N, 'every raw message accounted for exactly once');
    assert.ok(rs!.total.tokens > 0, 'non-zero rendered tokens');
    manager.close();
  });

  it('populates middleRaw for mid-conversation messages the picker keeps verbatim', async () => {
    // Small head/recent windows push most messages into the MIDDLE region; with
    // no summaries to fold into, the picker keeps them raw — which the old
    // reconstruction would have reported as 0 middle / all-pyramid.
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true,
        headWindowTokens: 100,
        recentWindowTokens: 100,
      }),
    });
    const N = 20;
    for (let i = 0; i < N; i++) {
      manager.addMessage(i % 2 ? 'lena' : 'user', text(`msg ${i} ${'y'.repeat(40)}`));
    }
    // Generous budget so nothing is evicted (and the picker doesn't go over-budget).
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 1_000 });

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present');
    assertConsistent(rs!);
    assert.ok(
      rs!.middleRaw.messages > 0,
      'middle messages kept raw by the picker must show up in middleRaw (inspect, not reconstruct)',
    );
    const rawMsgs = rs!.head.messages + rs!.tail.messages + rs!.middleRaw.messages;
    assert.strictEqual(rawMsgs, N, 'all raw, all accounted for');
    manager.close();
  });

  // Before a live compile there are no stats to report: they depend on the
  // budget a compile is given. The pyramid of live summaries that stood in
  // for them was neither cut (#304; connectome-host#425, where a kv-stable
  // resident's health readout showed 192 messages against a 377-message
  // request).
  it("is null before a live compile, and a dry run doesn't fill it (#304, the hierarchical path)", async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ headWindowTokens: 60, recentWindowTokens: 120, autoTickOnNewMessage: false }),
    });
    for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', text(`M-${i} ${'word '.repeat(10)}`));
    assert.strictEqual(manager.getRenderStats(), null, 'no live compile yet');
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    const dry = await manager.compile(budget, undefined, { dryRun: true });
    assert.strictEqual(manager.getRenderStats(), null, 'a dry run records no stats');
    assert.strictEqual(dry.renderStats?.total.messages, dry.messages.length, 'the dry result carries its own on this path too');
    // Injections are merged in after the select, so its stats leave them out.
    const injected = await manager.compile(budget, [{ namespace: 'probe', position: 'afterUser', content: text('an injected note') }], { dryRun: true });
    assert.ok(injected.messages.length > dry.messages.length, 'the request holds the injection');
    assert.strictEqual(injected.renderStats?.total.messages, dry.messages.length, 'a compile with injections carries stats that leave it out');
    const compiled = await manager.compile(budget);
    const rs = manager.getRenderStats();
    assert.ok(rs, 'a live compile records its stats');
    assertConsistent(rs!);
    assert.strictEqual(rs!.total.messages, compiled.messages.length, 'the stats count every message the compile sent');
    assert.strictEqual(rs!.total.tokens, sentTokens(manager, compiled.messages), 'and price them as it sent them');
    assert.ok(rs!.middleRaw.messages > 0, "the middle's raw messages are counted");
    manager.close();
  });

  it('is null again after a branch switch on the same strategy, until a live compile there', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ headWindowTokens: 60, recentWindowTokens: 120, autoTickOnNewMessage: false }),
    });
    for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', text(`M-${i} ${'word '.repeat(10)}`));
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    await manager.compile(budget);
    assert.ok(manager.getRenderStats(), 'the live compile recorded its stats');
    const strategy = manager.getStrategy() as AutobiographicalStrategy;
    await manager.fork('other');
    assert.strictEqual(manager.getRenderStats(), null, "the other branch hasn't compiled");
    assert.strictEqual(strategy.getLastSelectStats(), null, 'nor selected');
    const compiled = await manager.compile(budget);
    assert.strictEqual(manager.getRenderStats()?.total.messages, compiled.messages.length, "its first live compile records the branch's own stats");
    // Handing back the same instance, which has compiled, loads its branch again.
    await manager.setStrategy(strategy);
    assert.strictEqual(manager.getRenderStats(), null, 'setStrategy() loads the branch again, so no live compile has run since');
    assert.strictEqual(strategy.getLastSelectStats(), null, 'and no select');
    manager.close();
  });

  it('is null after a reopen until a live compile under kv-stable, then describes that compile', async () => {
    const budget = { maxTokens: 4_000, reserveForResponse: 0 };
    await buildKvStableStore();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: kvStable(), membrane: summarizer as any });
    assert.strictEqual(manager.getRenderStats(), null, 'no live compile since the store opened');
    await manager.compile(budget, undefined, { dryRun: true });
    assert.strictEqual(manager.getRenderStats(), null, 'a dry run records no stats');
    // A preview is the route to figures before a first compile: its own stats
    // come back with it, and it records none for the getter either.
    const preview = manager.previewContext(budget, undefined, { render: true });
    assert.ok(preview?.stats && preview.stats.total.messages > 0, 'the preview returns its own stats');
    assert.strictEqual(manager.getRenderStats(), null, 'a preview records no stats');
    assert.strictEqual((manager.getStrategy() as AutobiographicalStrategy).getLastSelectStats(), preview.stats,
      "they're the stats of the strategy's most recent select");
    const compiled = await manager.compile(budget);
    const rs = manager.getRenderStats();
    assert.ok(rs, 'a live compile records its stats');
    assertConsistent(rs!);
    const s = rs!.summaries;
    assert.ok(s.l1.count + s.l2.count + s.l3.count > 0, 'the cut holds recall pairs');
    assert.strictEqual(rs!.total.messages, compiled.messages.length, 'the stats count every message the compile sent');
    assert.strictEqual(rs!.total.tokens, sentTokens(manager, compiled.messages), 'and price them as it sent them, recall pairs included');
    await manager.close();
  });
});

// A compile's result carries the stats its own select recorded, so a host can
// show the next request's composition from a dry compile (a preview) beside
// the last live one's, without sending anything (connectome-host#425's
// "did my setting take effect?").
describe("CompileResult.renderStats — the compile's own", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("a dry compile carries its own, a live one the getter's, and neither disturbs the other", async () => {
    await buildKvStableStore();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: kvStable(), membrane: summarizer as any });
    const wide = { maxTokens: 8_000, reserveForResponse: 0 };
    const narrow = { maxTokens: 4_000, reserveForResponse: 0 };

    const dry = await manager.compile(wide, undefined, { dryRun: true });
    assert.ok(dry.renderStats, 'a dry compile carries stats');
    assertConsistent(dry.renderStats!);
    const s = dry.renderStats!.summaries;
    assert.ok(s.l1.count + s.l2.count + s.l3.count > 0, 'its cut holds recall pairs');
    assert.strictEqual(dry.renderStats!.total.messages, dry.messages.length, 'they count every message the dry compile would send');
    assert.strictEqual(dry.renderStats!.total.tokens, sentTokens(manager, dry.messages), 'and price them as it would send them');
    assert.strictEqual(manager.getRenderStats(), null, "they aren't the getter's");
    const dryBefore = structuredClone(dry.renderStats);

    const live = await manager.compile(narrow);
    assert.ok(live.renderStats, 'a live compile carries stats');
    assert.strictEqual(live.renderStats, manager.getRenderStats(), "a live compile's are the getter's");
    assert.strictEqual(live.renderStats!.total.messages, live.messages.length);
    assert.deepStrictEqual(dry.renderStats, dryBefore, "the live compile leaves the dry result's stats alone");
    const liveBefore = structuredClone(live.renderStats);

    const again = await manager.compile(wide, undefined, { dryRun: true });
    assert.strictEqual(again.renderStats!.total.messages, again.messages.length, 'a later dry compile carries its own');
    assert.notStrictEqual(again.renderStats!.total.messages, live.renderStats!.total.messages, 'which differ from the live cut at this budget');
    assert.strictEqual(manager.getRenderStats(), live.renderStats, 'the getter keeps the live compile');
    assert.deepStrictEqual(live.renderStats, liveBefore, "the live result's stats are unchanged");
    assert.deepStrictEqual(dry.renderStats, dryBefore, "and so are the first dry result's");
    // A refused select records nothing, so an earlier select's stats can't
    // pose as its own.
    const strategy = manager.getStrategy() as AutobiographicalStrategy;
    const tiny = { maxTokens: 50, reserveForResponse: 0 };
    assert.ok(strategy.getLastSelectStats(), 'the last dry select left stats');
    await assert.rejects(manager.compile(tiny, undefined, { dryRun: true }), OverBudgetError);
    assert.strictEqual(strategy.getLastSelectStats(), null, 'a refused dry select has none');
    await manager.compile(narrow);
    assert.ok(strategy.getLastSelectStats(), 'the live select left stats');
    await assert.rejects(manager.compile(tiny), OverBudgetError);
    assert.strictEqual(strategy.getLastSelectStats(), null, 'nor does a refused live one');
    await manager.close();
  });

  it('is absent for a strategy that records none', async () => {
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new PassthroughStrategy() });
    manager.addMessage('User', text('hello'));
    const compiled = await manager.compile();
    assert.strictEqual(compiled.messages.length, 1);
    assert.strictEqual(compiled.renderStats, undefined);
    manager.close();
  });

  it('is absent for a strategy that reports render stats without getLastSelectStats', async () => {
    // Written against the interface before getLastSelectStats existed.
    class OlderStatsStrategy extends PassthroughStrategy {
      getRenderStats(): RenderStats | null { return null; }
    }
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new OlderStatsStrategy() });
    manager.addMessage('User', text('hello'));
    const compiled = await manager.compile();
    assert.strictEqual(compiled.messages.length, 1, 'it still compiles');
    assert.strictEqual(compiled.renderStats, undefined);
    manager.close();
  });
});
