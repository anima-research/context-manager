/**
 * Tests for MessageStore's query-by-time/channel methods
 * (queryByTime/queryByChannel/queryByTimeAndChannel/getChannelCounts/
 * getChannelTokenStats), backed by chronicle's native `/timestamp` field
 * index and TWO channel-id field indexes (registerStateFieldIndex/
 * queryStateIndexRange/queryStateIndexEq/getStateIndexValueCounts, 2026-09).
 *
 * The channel indexing is dual-schema (2026-09, downstream agent-framework
 * review): real agent-framework MCPL ingestion (`handleMcplChannelIncoming`,
 * `agent-framework/src/framework.ts`) writes `metadata.channelId` directly
 * with no `external` nesting, while this codebase's own `MessageQuery` type
 * documents an older `metadata.external.channelId` convention some other
 * consumer may still rely on — both are indexed and every channel-query
 * method merges results across them, since real Mythos/Sol-scale history
 * carries months of data under whichever shape was actually in effect at
 * ingestion time.
 *
 * Covers:
 *  - queryByTime inclusive gte/lte boundaries, open-ended bounds, reverse
 *  - queryByChannel exact match + no-match, under EACH channel-id schema
 *    individually and merged across both in one call
 *  - queryByTimeAndChannel intersection correctness (a message matching
 *    only one of the two filters must never appear), including a query
 *    spanning both channel-id schemas at once
 *  - getChannelCounts against a small multi-channel fixture, including
 *    counts merged/summed across both schemas
 *  - getChannelTokenStats totals matching a manual sum, and bucketing
 *    correctly regardless of which channel-id schema a message used
 *  - a message with no channelId in metadata: doesn't crash indexing or
 *    querying, and is excluded from channel-keyed results
 *  - graceful, specific-error degradation when the native capability is
 *    absent (mirrors message-store-window.test.ts's legacy-chronicle
 *    Proxy pattern for getStateSlice)
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, MessageStore } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-message-store-history-index';
const TEST_MANAGER_STORE_PATH = './test-context-manager-history-index';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function openStore(): { store: JsStore; messages: MessageStore } {
  const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
  try {
    MessageStore.register(store);
  } catch {}
  return { store, messages: new MessageStore(store) };
}

function textOf(msg: { content: ContentBlock[] }): string {
  const b = msg.content[0];
  return b && b.type === 'text' ? b.text : '';
}

/**
 * Directly rewrite a stored message's timestamp via chronicle's raw
 * editStateItem — MessageStore.append() always stamps `Date.now()` and
 * exposes no public way to override it, but boundary tests need
 * deterministically spaced timestamps rather than whatever a tight test
 * loop's wall clock happens to produce. Goes through the same
 * update_state_with_builder path as every other mutation, so chronicle's
 * native field-index incremental maintenance (on_edit) sees it exactly
 * like any other edit.
 */
function setTimestamp(store: JsStore, stateId: string, index: number, ms: number): void {
  const item = store.getStateItemJson(stateId, index) as Record<string, unknown>;
  store.editStateItem(stateId, index, Buffer.from(JSON.stringify({ ...item, timestamp: ms })));
}

/**
 * Wraps `store` so that the first `nullCount` calls to the named native
 * query method return `null` (chronicle's "no such index currently
 * registered/poisoned" signal — see queryStateIndexRange's doc in
 * node_modules/@animalabs/chronicle/index.d.ts), then delegates to the real
 * implementation thereafter. `registerStateFieldIndex` (and everything
 * else) passes through untouched, so a self-heal re-register + retry still
 * reaches the real, correctly-maintained index underneath.
 */
function nullNTimesProxy<M extends 'queryStateIndexRange' | 'queryStateIndexEq' | 'getStateIndexValueCounts'>(
  store: JsStore,
  method: M,
  nullCount: number,
): JsStore {
  let calls = 0;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === method) {
        const real = (Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          calls++;
          return calls <= nullCount ? null : real(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as JsStore;
}

describe('MessageStore — native history index (time/channel queries)', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('queryByTime: inclusive gte/lte boundaries', () => {
    const { store, messages } = openStore();
    const stamps = [100, 200, 300, 400, 500];
    stamps.forEach((_, i) => messages.append('user', textBlock(`m${i}`)));
    stamps.forEach((ms, i) => setTimestamp(store, 'messages', i, ms));

    // Both bounds given, matching the middle three exactly (inclusive).
    const mid = messages.queryByTime({ fromMs: 200, toMs: 400 });
    assert.equal(mid.matchedCount, 3);
    assert.deepEqual(mid.messages.map(textOf), ['m1', 'm2', 'm3']);

    // Exact-boundary values are included, not excluded.
    const exact = messages.queryByTime({ fromMs: 100, toMs: 100 });
    assert.deepEqual(exact.messages.map(textOf), ['m0']);

    // Open-ended lower bound.
    const fromOnly = messages.queryByTime({ fromMs: 300 });
    assert.deepEqual(fromOnly.messages.map(textOf), ['m2', 'm3', 'm4']);

    // Open-ended upper bound.
    const toOnly = messages.queryByTime({ toMs: 300 });
    assert.deepEqual(toOnly.messages.map(textOf), ['m0', 'm1', 'm2']);

    // No bound at all: everything.
    const all = messages.queryByTime({});
    assert.equal(all.matchedCount, 5);

    // reverse: newest-first.
    const rev = messages.queryByTime({ reverse: true });
    assert.deepEqual(rev.messages.map(textOf), ['m4', 'm3', 'm2', 'm1', 'm0']);

    // Range with no matches.
    const none = messages.queryByTime({ fromMs: 1000, toMs: 2000 });
    assert.deepEqual(none.messages, []);
    assert.equal(none.matchedCount, 0);

    store.close();
  });

  it('queryByTime: limit/offset page the native call directly', () => {
    const { store, messages } = openStore();
    for (let i = 0; i < 5; i++) messages.append('user', textBlock(`m${i}`));
    for (let i = 0; i < 5; i++) setTimestamp(store, 'messages', i, (i + 1) * 100);

    const page = messages.queryByTime({ limit: 2, offset: 1 });
    assert.deepEqual(page.messages.map(textOf), ['m1', 'm2']);
    // matchedCount is the returned page's size for a single-filter query
    // (documented on queryByTime — no store-wide total without a second
    // unbounded call), not the full 5-message match.
    assert.equal(page.matchedCount, 2);

    store.close();
  });

  it('queryByChannel: exact match and no-match', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('a1'), { external: { channelId: 'c1' } });
    messages.append('user', textBlock('a2'), { external: { channelId: 'c2' } });
    messages.append('user', textBlock('a3'), { external: { channelId: 'c1' } });

    const c1 = messages.queryByChannel('c1');
    assert.deepEqual(c1.messages.map(textOf), ['a1', 'a3']);
    assert.equal(c1.matchedCount, 2);

    const c2 = messages.queryByChannel('c2');
    assert.deepEqual(c2.messages.map(textOf), ['a2']);

    const missing = messages.queryByChannel('does-not-exist');
    assert.deepEqual(missing.messages, []);
    assert.equal(missing.matchedCount, 0);

    store.close();
  });

  it('queryByChannel finds a message under the direct metadata.channelId schema (real agent-framework ingestion shape)', () => {
    const { store, messages } = openStore();
    // agent-framework's real handleMcplChannelIncoming (framework.ts)
    // writes channelId directly on metadata, with serverId/messageId
    // alongside it — NO `external` nesting at all. This is the schema the
    // dual-index fix exists for.
    messages.append('user', textBlock('direct-schema'), {
      channelId: 'c1',
      serverId: 's1',
      messageId: 'm1',
    });

    const result = messages.queryByChannel('c1');
    assert.deepEqual(result.messages.map(textOf), ['direct-schema']);
    assert.equal(result.matchedCount, 1);

    store.close();
  });

  it('queryByChannel still finds a message under the older metadata.external.channelId schema (no regression)', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('external-schema'), { external: { channelId: 'c1' } });

    const result = messages.queryByChannel('c1');
    assert.deepEqual(result.messages.map(textOf), ['external-schema']);
    assert.equal(result.matchedCount, 1);

    store.close();
  });

  it('queryByChannel/getChannelCounts/getChannelTokenStats merge messages across BOTH channel-id schemas', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('direct'), { channelId: 'shared', serverId: 's1', messageId: 'm1' });
    messages.append('user', textBlock('nested'), { external: { channelId: 'shared' } });
    messages.append('user', textBlock('other-channel-direct'), { channelId: 'other' });

    // queryByChannel: both 'shared' messages found regardless of schema.
    const shared = messages.queryByChannel('shared');
    assert.deepEqual(shared.messages.map(textOf).sort(), ['direct', 'nested']);
    assert.equal(shared.matchedCount, 2);

    // getChannelCounts: counts summed across both native indexes.
    const counts = messages.getChannelCounts();
    const sortedCounts = [...counts].sort((a, b) => a.channelId.localeCompare(b.channelId));
    assert.deepEqual(sortedCounts, [
      { channelId: 'other', messages: 1 },
      { channelId: 'shared', messages: 2 },
    ]);

    // getChannelTokenStats: bucketed correctly regardless of which schema
    // each message used.
    const stats = messages.getChannelTokenStats();
    assert.equal(stats.totalMessages, 3);
    const byChannel = new Map(stats.byChannel.map((c) => [c.channelId, c]));
    assert.equal(byChannel.get('shared')?.messages, 2);
    assert.equal(byChannel.get('other')?.messages, 1);

    store.close();
  });

  it('a message with no channelId does not crash indexing/querying and is excluded from channel results', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('has-channel'), { external: { channelId: 'c1' } });
    // No metadata at all (e.g. a system message).
    messages.append('user', textBlock('no-metadata'));
    // metadata.external present but no channelId (e.g. a different external shape).
    messages.append('user', textBlock('no-channel-id'), { external: { source: 'discord' } });

    // None of this should throw.
    assert.doesNotThrow(() => messages.queryByChannel('c1'));
    assert.doesNotThrow(() => messages.getChannelCounts());

    const c1 = messages.queryByChannel('c1');
    assert.deepEqual(c1.messages.map(textOf), ['has-channel']);

    const counts = messages.getChannelCounts();
    assert.deepEqual(counts, [{ channelId: 'c1', messages: 1 }]);
    // The two channelId-less messages never show up as e.g. a channelId of
    // "undefined" — they're simply unindexed for this field.
    assert.ok(!counts.some((c) => c.channelId === 'undefined'));

    store.close();
  });

  it('queryByTimeAndChannel: intersection excludes time-only and channel-only matches', () => {
    const { store, messages } = openStore();
    // m0: time IN range, channel MATCHES  -> should appear
    // m1: time IN range, channel DIFFERENT -> must NOT appear
    // m2: time OUT of range, channel MATCHES -> must NOT appear
    // m3: time IN range, channel MATCHES -> should appear
    messages.append('user', textBlock('m0'), { external: { channelId: 'target' } });
    messages.append('user', textBlock('m1'), { external: { channelId: 'other' } });
    messages.append('user', textBlock('m2'), { external: { channelId: 'target' } });
    messages.append('user', textBlock('m3'), { external: { channelId: 'target' } });
    setTimestamp(store, 'messages', 0, 100);
    setTimestamp(store, 'messages', 1, 100);
    setTimestamp(store, 'messages', 2, 9999);
    setTimestamp(store, 'messages', 3, 200);

    const result = messages.queryByTimeAndChannel({ fromMs: 50, toMs: 500, channelId: 'target' });
    assert.deepEqual(result.messages.map(textOf), ['m0', 'm3']);
    assert.equal(result.matchedCount, 2);

    // Only channel given: delegates to queryByChannel (all 3 'target' messages).
    const channelOnly = messages.queryByTimeAndChannel({ channelId: 'target' });
    assert.deepEqual(channelOnly.messages.map(textOf).sort(), ['m0', 'm2', 'm3']);

    // Only time given: delegates to queryByTime.
    const timeOnly = messages.queryByTimeAndChannel({ fromMs: 50, toMs: 500 });
    assert.deepEqual(timeOnly.messages.map(textOf), ['m0', 'm1', 'm3']);

    // Neither given: everything.
    const neither = messages.queryByTimeAndChannel({});
    assert.equal(neither.matchedCount, 4);

    // limit/offset applied to the true intersection (not a native page).
    const paged = messages.queryByTimeAndChannel({
      fromMs: 0,
      toMs: 10000,
      channelId: 'target',
      limit: 1,
      offset: 1,
    });
    // True intersection (channel 'target', time in [0,10000]), ascending by
    // ordinal: [m0 (t=100), m2 (t=9999 — inside this wider range, unlike the
    // [50,500] query above), m3 (t=200)]. offset:1 skips m0, limit:1 takes m2.
    assert.deepEqual(paged.messages.map(textOf), ['m2']);
    assert.equal(paged.matchedCount, 3); // true total, not page size

    store.close();
  });

  it('queryByTimeAndChannel finds matches from BOTH channel-id schemas in one query', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('direct-in-range'), { channelId: 'c1' });
    messages.append('user', textBlock('nested-in-range'), { external: { channelId: 'c1' } });
    messages.append('user', textBlock('direct-out-of-range'), { channelId: 'c1' });
    setTimestamp(store, 'messages', 0, 100);
    setTimestamp(store, 'messages', 1, 200);
    setTimestamp(store, 'messages', 2, 9999);

    const result = messages.queryByTimeAndChannel({ fromMs: 0, toMs: 500, channelId: 'c1' });
    assert.deepEqual(result.messages.map(textOf).sort(), ['direct-in-range', 'nested-in-range']);
    assert.equal(result.matchedCount, 2);

    store.close();
  });

  it('getChannelCounts: small multi-channel fixture', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('1'), { external: { channelId: 'alpha' } });
    messages.append('user', textBlock('2'), { external: { channelId: 'beta' } });
    messages.append('user', textBlock('3'), { external: { channelId: 'alpha' } });
    messages.append('user', textBlock('4'), { external: { channelId: 'alpha' } });
    messages.append('user', textBlock('5')); // no channel

    const counts = messages.getChannelCounts();
    const sorted = [...counts].sort((a, b) => a.channelId.localeCompare(b.channelId));
    assert.deepEqual(sorted, [
      { channelId: 'alpha', messages: 3 },
      { channelId: 'beta', messages: 1 },
    ]);

    store.close();
  });

  it('getChannelTokenStats: totals match a manual sum', () => {
    const { store, messages } = openStore();
    const a1 = messages.append('user', textBlock('hello world'), { external: { channelId: 'alpha' } });
    const a2 = messages.append('user', textBlock('a longer message with more words in it'), {
      external: { channelId: 'alpha' },
    });
    const b1 = messages.append('user', textBlock('beta channel message'), {
      external: { channelId: 'beta' },
    });
    const noChannel = messages.append('user', textBlock('unchanneled'));

    const expectedAlpha = messages.estimateTokens(a1) + messages.estimateTokens(a2);
    const expectedBeta = messages.estimateTokens(b1);
    const expectedTotal = expectedAlpha + expectedBeta + messages.estimateTokens(noChannel);

    const stats = messages.getChannelTokenStats();
    assert.equal(stats.totalMessages, 4);
    assert.equal(stats.totalTokensEstimate, expectedTotal);

    const byChannel = new Map(stats.byChannel.map((c) => [c.channelId, c]));
    assert.equal(byChannel.get('alpha')?.messages, 2);
    assert.equal(byChannel.get('alpha')?.tokensEstimate, expectedAlpha);
    assert.equal(byChannel.get('beta')?.messages, 1);
    assert.equal(byChannel.get('beta')?.tokensEstimate, expectedBeta);
    // The unchanneled message contributes to totals but has no byChannel bucket.
    assert.ok(!byChannel.has('undefined'));
    const byChannelMessageSum = stats.byChannel.reduce((sum, c) => sum + c.messages, 0);
    assert.equal(byChannelMessageSum, 3); // 4 total minus the 1 unchanneled

    store.close();
  });

  it('getChannelTokenStats: restricted to a timestamp range', () => {
    const { store, messages } = openStore();
    const early = messages.append('user', textBlock('early'), { external: { channelId: 'alpha' } });
    const late = messages.append('user', textBlock('late message here'), {
      external: { channelId: 'alpha' },
    });
    setTimestamp(store, 'messages', 0, 100);
    setTimestamp(store, 'messages', 1, 9999);

    const stats = messages.getChannelTokenStats({ fromMs: 0, toMs: 500 });
    assert.equal(stats.totalMessages, 1);
    assert.equal(stats.totalTokensEstimate, messages.estimateTokens(early));
    assert.notEqual(stats.totalTokensEstimate, messages.estimateTokens(late));

    store.close();
  });

  it('getChannelTokenStats does not leak a cached ordinal→message mapping across a branch switch (P2 regression)', () => {
    const { store, messages } = openStore();

    // Shared base message on the common ancestor.
    messages.append('user', textBlock('base'), { external: { channelId: 'shared' } });

    // Branch off HERE (createBranch does not switch the active branch) —
    // 'side' starts with only 'base' in its messages slot, same as main.
    store.createBranch('side');

    // main diverges: append a main-only message at ordinal 1.
    messages.append('user', textBlock('main-only'), { external: { channelId: 'main-chan' } });

    // Warm the token-stats cache on main — this caches ordinal 1 as
    // 'main-only' / 'main-chan'.
    const onMain = messages.getChannelTokenStats();
    assert.equal(onMain.totalMessages, 2);

    store.switchBranch('side');
    // side diverges too: append a DIFFERENT message that lands at the SAME
    // ordinal (1) main-only occupied — the exact ordinal-reuse hazard the
    // cache must not be fooled by.
    messages.append('user', textBlock('side-only'), { external: { channelId: 'side-chan' } });

    // Native, always-fresh ground truth for the branch we're on now.
    const counts = messages.getChannelCounts();
    assert.deepEqual(
      counts.map((c) => c.channelId).sort(),
      ['shared', 'side-chan'],
    );

    // The cache warmed on main must be invalidated by the switch, not
    // silently serve ordinal 1 as 'main-only'/'main-chan' here.
    const onSide = messages.getChannelTokenStats();
    assert.equal(onSide.totalMessages, 2);
    const byChannel = new Map(onSide.byChannel.map((c) => [c.channelId, c]));
    assert.ok(!byChannel.has('main-chan'), 'stale main-branch channel leaked into side-branch stats');
    assert.ok(byChannel.has('side-chan'), 'current side-branch channel missing from stats');

    store.close();
  });

  it('getChannelTokenStats does not leak cached data across a branch DELETE + RECREATE under the same name (P2 regression)', () => {
    const { store, messages } = openStore();
    const mainName = store.currentBranch().name;

    // Shared base message on main.
    messages.append('user', textBlock('base'), { external: { channelId: 'shared' } });

    // Create + switch to 'side' (branch id 2, say) and diverge it.
    store.createBranch('side');
    store.switchBranch('side');
    messages.append('user', textBlock('deleted-branch-msg'), { external: { channelId: 'deleted-branch' } });

    // Warm the cache on THIS 'side' — it's about to be deleted.
    const warmed = messages.getChannelTokenStats();
    assert.equal(warmed.totalMessages, 2);

    // Back to main, diverge differently, then delete 'side' and create a
    // DIFFERENT branch under the exact same name (a new branch id, forked
    // from main's now-2-message state) — the name is reused, the id isn't.
    store.switchBranch(mainName);
    messages.append('user', textBlock('replacement-branch-msg'), { external: { channelId: 'replacement-branch' } });
    store.deleteBranch('side');
    store.createBranch('side');
    store.switchBranch('side');

    // Native, always-fresh ground truth for the CURRENT (new) 'side'.
    const counts = messages.getChannelCounts();
    assert.deepEqual(
      counts.map((c) => c.channelId).sort(),
      ['replacement-branch', 'shared'],
    );

    // A name-only branch check would see 'side' === 'side' and never
    // invalidate — the cache must key off branch ID instead, so the OLD
    // (deleted) branch's cached data must not leak here just because the
    // new branch happens to share its name.
    const stats = messages.getChannelTokenStats();
    const byChannel = new Map(stats.byChannel.map((c) => [c.channelId, c]));
    assert.ok(!byChannel.has('deleted-branch'), 'stale deleted-branch data leaked via branch-name reuse');
    assert.ok(byChannel.has('replacement-branch'), 'current branch data missing');

    store.close();
  });

  it('getChannelTokenStats reflects a calibration change on the very next call, no invalidation needed (P2 regression)', () => {
    const { store, messages } = openStore();
    const msg = messages.append('user', textBlock('0123456789'), { external: { channelId: 'c1' } });
    const rawEstimate = messages.estimateTokens(msg); // calibration defaults to 1

    // Warm the cache at calibration = 1.
    const before = messages.getChannelTokenStats();
    assert.equal(before.totalTokensEstimate, rawEstimate);
    assert.equal(before.byChannel[0]?.tokensEstimate, rawEstimate);

    messages.setTokenCalibration(2);
    const after = messages.getChannelTokenStats();
    assert.equal(after.totalTokensEstimate, rawEstimate * 2);
    assert.equal(after.byChannel[0]?.tokensEstimate, rawEstimate * 2);

    store.close();
  });

  it('getChannelTokenStats replays per-block round-then-sum, not sum-then-round-once, at a fractional calibration (P3 regression)', () => {
    const { store, messages } = openStore();
    // Two single-character text blocks: each estimates to raw ~1 token
    // under the default estimator, so a 0.6 calibration exercises the
    // exact round(1*0.6)+round(1*0.6)=2 vs round(2*0.6)=1 discrepancy the
    // reviewer's repro relies on.
    const msg = messages.append(
      'user',
      [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      { external: { channelId: 'c1' } },
    );

    // Warm the cache at the default calibration (1).
    messages.getChannelTokenStats();

    messages.setTokenCalibration(0.6);
    const live = messages.estimateTokens(msg);
    const stats = messages.getChannelTokenStats();

    assert.equal(stats.totalTokensEstimate, live);
    assert.equal(stats.byChannel[0]?.tokensEstimate, live);

    store.close();
  });

  it('getChannelTokenStats normalizes a non-string channelId to unchanneled, matching getChannelCounts (P3)', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('has-string-channel'), { external: { channelId: 'a' } });
    // A channelId that's present but not a string (e.g. `null`) — the
    // native String-kind index excludes it; getChannelTokenStats must too.
    messages.append('user', textBlock('has-null-channel'), { external: { channelId: null } });

    const counts = messages.getChannelCounts();
    assert.deepEqual(counts, [{ channelId: 'a', messages: 1 }]);

    const stats = messages.getChannelTokenStats();
    assert.equal(stats.totalMessages, 2); // both still contribute to the overall total
    assert.equal(stats.byChannel.length, 1);
    assert.equal(stats.byChannel[0].channelId, 'a');
    assert.ok(stats.byChannel.every((c) => typeof c.channelId === 'string'));

    store.close();
  });

  it('registerHistoryIndexes at construction is a silent no-op on a chronicle build without the capability', () => {
    const { store, messages } = openStore();
    for (let i = 0; i < 3; i++) messages.append('user', textBlock(`m${i}`));
    store.close();

    // Re-open with registerStateFieldIndex hidden, simulating an older
    // chronicle install — mirrors message-store-window.test.ts's
    // getStateSlice-hiding Proxy for the same purpose.
    const store2 = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const legacyStore = new Proxy(store2, {
      get(target, prop, receiver) {
        if (prop === 'registerStateFieldIndex') return undefined;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as JsStore;

    // Construction must not throw even though registration is skipped.
    assert.doesNotThrow(() => new MessageStore(legacyStore));
    store2.close();
  });

  it('query/count methods throw a clear error when the native index-query capability is absent', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'), { external: { channelId: 'c1' } });

    const legacyStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (
          prop === 'queryStateIndexRange' ||
          prop === 'queryStateIndexEq' ||
          prop === 'getStateIndexValueCounts'
        ) {
          return undefined;
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as JsStore;
    const legacyMessages = new MessageStore(legacyStore);

    assert.throws(() => legacyMessages.queryByTime({}), /Chronicle history index unsupported/);
    assert.throws(() => legacyMessages.queryByChannel('c1'), /Chronicle history index unsupported/);
    assert.throws(() => legacyMessages.queryByTimeAndChannel({ fromMs: 0, toMs: 1, channelId: 'c1' }), /Chronicle history index unsupported/);
    assert.throws(() => legacyMessages.getChannelCounts(), /Chronicle history index unsupported/);
    assert.throws(() => legacyMessages.getChannelTokenStats(), /Chronicle history index unsupported/);

    store.close();
  });

  it('queryByTime self-heals a single null (poisoned/unregistered index) via re-register + retry', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'));
    setTimestamp(store, 'messages', 0, 100);
    messages.getWindow(0, 0); // no-op read, just to make sure the store is warm

    const flaky = nullNTimesProxy(store, 'queryStateIndexRange', 1);
    const flakyMessages = new MessageStore(flaky);
    const result = flakyMessages.queryByTime({});
    assert.deepEqual(result.messages.map(textOf), ['m0']);

    store.close();
  });

  it('queryByTime throws HISTORY_INDEX_UNAVAILABLE after a null persists through the retry', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'));
    setTimestamp(store, 'messages', 0, 100);

    const alwaysNull = nullNTimesProxy(store, 'queryStateIndexRange', Infinity);
    const brokenMessages = new MessageStore(alwaysNull);
    assert.throws(
      () => brokenMessages.queryByTime({}),
      /Chronicle history index unavailable \(registered but not queryable/,
    );

    store.close();
  });

  it('queryByChannel self-heals a single null via re-register + retry', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'), { external: { channelId: 'c1' } });

    const flaky = nullNTimesProxy(store, 'queryStateIndexEq', 1);
    const flakyMessages = new MessageStore(flaky);
    const result = flakyMessages.queryByChannel('c1');
    assert.deepEqual(result.messages.map(textOf), ['m0']);

    store.close();
  });

  it('queryByChannel throws HISTORY_INDEX_UNAVAILABLE after a null persists through the retry', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'), { external: { channelId: 'c1' } });

    const alwaysNull = nullNTimesProxy(store, 'queryStateIndexEq', Infinity);
    const brokenMessages = new MessageStore(alwaysNull);
    assert.throws(
      () => brokenMessages.queryByChannel('c1'),
      /Chronicle history index unavailable \(registered but not queryable/,
    );

    store.close();
  });

  it('getChannelCounts self-heals a single null via re-register + retry', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'), { external: { channelId: 'c1' } });
    messages.append('user', textBlock('m1'), { external: { channelId: 'c1' } });

    const flaky = nullNTimesProxy(store, 'getStateIndexValueCounts', 1);
    const flakyMessages = new MessageStore(flaky);
    const result = flakyMessages.getChannelCounts();
    assert.deepEqual(result, [{ channelId: 'c1', messages: 2 }]);

    store.close();
  });

  it('getChannelCounts throws HISTORY_INDEX_UNAVAILABLE after a null persists through the retry', () => {
    const { store, messages } = openStore();
    messages.append('user', textBlock('m0'), { external: { channelId: 'c1' } });

    const alwaysNull = nullNTimesProxy(store, 'getStateIndexValueCounts', Infinity);
    const brokenMessages = new MessageStore(alwaysNull);
    assert.throws(
      () => brokenMessages.getChannelCounts(),
      /Chronicle history index unavailable \(registered but not queryable/,
    );

    store.close();
  });
});

describe('ContextManager — history-index thin wrappers', () => {
  beforeEach(() => {
    if (existsSync(TEST_MANAGER_STORE_PATH)) rmSync(TEST_MANAGER_STORE_PATH, { recursive: true, force: true });
  });
  after(() => {
    if (existsSync(TEST_MANAGER_STORE_PATH)) rmSync(TEST_MANAGER_STORE_PATH, { recursive: true, force: true });
  });

  it('delegates each new method to the matching MessageStore method', async () => {
    const manager = await ContextManager.open({ path: TEST_MANAGER_STORE_PATH });
    manager.addMessage('user', textBlock('a'), { external: { channelId: 'c1' } });
    manager.addMessage('user', textBlock('b'), { external: { channelId: 'c2' } });
    manager.addMessage('user', textBlock('c'), { external: { channelId: 'c1' } });

    const store = manager.getStore();
    setTimestamp(store, 'messages', 0, 100);
    setTimestamp(store, 'messages', 1, 200);
    setTimestamp(store, 'messages', 2, 300);

    const byTime = manager.queryMessagesByTime({ fromMs: 100, toMs: 200 });
    assert.deepEqual(byTime.messages.map(textOf), ['a', 'b']);

    const byChannel = manager.queryMessagesByChannel('c1');
    assert.deepEqual(byChannel.messages.map(textOf), ['a', 'c']);

    const byBoth = manager.queryMessagesByTimeAndChannel({ fromMs: 0, toMs: 250, channelId: 'c1' });
    assert.deepEqual(byBoth.messages.map(textOf), ['a']);

    const counts = manager.getChannelMessageCounts();
    assert.deepEqual(
      [...counts].sort((x, y) => x.channelId.localeCompare(y.channelId)),
      [
        { channelId: 'c1', messages: 2 },
        { channelId: 'c2', messages: 1 },
      ],
    );

    const stats = manager.getChannelTokenStats();
    assert.equal(stats.totalMessages, 3);

    store.close();
  });
});
