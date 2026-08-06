/**
 * Strategy-facing view composition (issue agent-framework#77 groundwork):
 *
 *   - viewFilter: strategy-facing exclusion at the single view choke point.
 *     Excluded messages compile to nothing but remain in the store, and the
 *     autobiographical coverage invariants see the same excluded-free world
 *     (no UncoveredDropError / assertFullCoverage throw).
 *   - auxiliaryMessageViews: a second slot merged read-only into the
 *     strategy view, interleaved by branch-global chronicle sequence.
 *   - WindowedPassthroughStrategy: sequence-anchored window, coarse
 *     re-anchor on overflow, anchor persisted across reopen.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import {
  ContextManager,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
  filterMessageStoreView,
  mergeMessageStoreViews,
} from '../src/index.js';
import type { MessageStoreView, StoredMessage } from '../src/types/index.js';

const BASE = './test-view-composition';
let storeSeq = 0;
function freshPath(): string {
  return `${BASE}-${storeSeq++}`;
}
after(() => {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

function fakeView(messages: Array<Partial<StoredMessage> & { id: string; sequence: number }>): MessageStoreView {
  const all = messages.map((m) => ({
    participant: 'user',
    content: text(m.id),
    ...m,
  })) as StoredMessage[];
  return {
    getAll: () => [...all],
    get: (id) => all.find((m) => m.id === id) ?? null,
    getFrom: (index) => all.slice(index),
    getTail: (count) => all.slice(Math.max(0, all.length - count)),
    length: () => all.length,
    estimateTokens: () => 10,
  };
}

describe('filterMessageStoreView', () => {
  it('filters every read surface consistently', () => {
    const view = fakeView([
      { id: 'a', sequence: 1 },
      { id: 'b', sequence: 2, metadata: { tuneOut: { epochId: 'e1' } } },
      { id: 'c', sequence: 3 },
    ]);
    const filtered = filterMessageStoreView(view, (m) => !m.metadata?.tuneOut);

    assert.deepEqual(filtered.getAll().map((m) => m.id), ['a', 'c']);
    assert.equal(filtered.length(), 2);
    assert.equal(filtered.get('b'), null);
    assert.equal(filtered.get('a')?.id, 'a');
    assert.deepEqual(filtered.getTail(1).map((m) => m.id), ['c']);
    assert.deepEqual(filtered.getFrom(1).map((m) => m.id), ['c']);
  });
});

describe('mergeMessageStoreViews', () => {
  it('interleaves by sequence and reads ids across views', () => {
    const primary = fakeView([
      { id: 'p1', sequence: 1 },
      { id: 'p2', sequence: 4 },
    ]);
    const aux = fakeView([
      { id: 'x1', sequence: 2 },
      { id: 'x2', sequence: 3 },
    ]);
    const merged = mergeMessageStoreViews(primary, [aux]);

    assert.deepEqual(merged.getAll().map((m) => m.id), ['p1', 'x1', 'x2', 'p2']);
    assert.equal(merged.length(), 4);
    assert.equal(merged.get('x2')?.id, 'x2');
    assert.deepEqual(merged.getTail(2).map((m) => m.id), ['x2', 'p2']);
  });

  it('returns the primary view untouched when there is nothing to merge', () => {
    const primary = fakeView([{ id: 'p1', sequence: 1 }]);
    assert.equal(mergeMessageStoreViews(primary, []), primary);
  });
});

describe('ContextManager viewFilter', () => {
  it('excludes from compile but not from the store', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({
      path,
      strategy: new PassthroughStrategy(),
      viewFilter: (m) => !m.metadata?.tuneOut,
    });

    manager.addMessage('alice', text('visible one'));
    manager.addMessage('bob', text('diverted'), { tuneOut: { epochId: 'e1' } });
    manager.addMessage('alice', text('visible two'));

    const result = await manager.compile();
    const rendered = result.messages.map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(rendered, ['visible one', 'visible two']);

    // The store itself keeps everything (backlog stays dumpable/auditable).
    assert.equal(manager.getAllMessages().length, 3);

    await manager.close();
  });
});

describe('ContextManager auxiliaryMessageViews', () => {
  it('merges another slot into the strategy view, ordered by sequence', async () => {
    const path = freshPath();
    // Main writes the shared un-namespaced slot.
    const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    // Side agent: isolated own slot + read-only merge of the shared slot.
    const side = await ContextManager.open({
      store: main.getStore(),
      namespace: 'subconscious/mythos',
      isolate: true,
      strategy: new PassthroughStrategy(),
      auxiliaryMessageViews: [{}],
    });

    main.addMessage('alice', text('m1'));
    side.addMessage('Subconscious', text('s1'));
    main.addMessage('alice', text('m2'));

    const sideResult = await side.compile();
    const sideRendered = sideResult.messages.map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(sideRendered, ['m1', 's1', 'm2'], 'merged view interleaves by sequence');

    // Main's compile is untouched by the side slot.
    const mainResult = await main.compile();
    const mainRendered = mainResult.messages.map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(mainRendered, ['m1', 'm2']);

    // Writes from the side manager landed in its own slot only.
    assert.equal(side.getAllMessages().length, 1);
    assert.equal(main.getAllMessages().length, 2);

    await side.close();
    await main.close();
  });

  it('sees the aux slot live across instances (no stale cache)', async () => {
    const path = freshPath();
    const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(),
      namespace: 'subconscious/mythos',
      isolate: true,
      strategy: new PassthroughStrategy(),
      auxiliaryMessageViews: [{}],
    });

    await side.compile(); // prime any caches
    main.addMessage('alice', text('after-prime'));
    const result = await side.compile();
    const rendered = result.messages.map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(rendered, ['after-prime']);

    await side.close();
    await main.close();
  });
});

describe('WindowedPassthroughStrategy', () => {
  it('honors the anchor and stays byte-stable between compiles', async () => {
    const path = freshPath();
    const strategy = new WindowedPassthroughStrategy();
    const manager = await ContextManager.open({ path, strategy });

    manager.addMessage('u', text('old-1'));
    manager.addMessage('u', text('old-2'));
    const pivotId = manager.addMessage('u', text('window-start'));
    manager.addMessage('u', text('window-2'));

    strategy.setAnchor(manager.getMessage(pivotId)!.sequence);

    const first = await manager.compile();
    assert.deepEqual(
      first.messages.map((m) => (m.content[0] as { text: string }).text),
      ['window-start', 'window-2'],
    );

    // Appends extend; the prefix is unchanged (pure append between compiles).
    manager.addMessage('u', text('window-3'));
    const second = await manager.compile();
    const texts = second.messages.map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['window-start', 'window-2', 'window-3']);

    await manager.close();
  });

  it('re-anchors coarsely on overflow instead of sliding', async () => {
    const path = freshPath();
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const manager = await ContextManager.open({ path, strategy });

    // ~50 tokens per message; 12 messages ≈ 600 tokens against a usable
    // budget of 200 — solidly over, forcing the coarse re-anchor path.
    for (let i = 0; i < 12; i++) {
      manager.addMessage('u', text(`msg-${String(i).padStart(2, '0')}-${'x'.repeat(200)}`));
    }
    const budget = { maxTokens: 250, reserveForResponse: 50 };

    const first = await manager.compile(budget);
    assert.ok(first.messages.length < 12, 'overflow trimmed the window');
    const anchorAfterFirst = strategy.getAnchor();
    assert.ok(anchorAfterFirst > 0, 'anchor jumped forward');

    // A follow-up compile with no growth must not move the anchor again.
    const second = await manager.compile(budget);
    assert.equal(strategy.getAnchor(), anchorAfterFirst, 'anchor is stable between overflows');
    assert.equal(second.messages.length, first.messages.length);

    // Modest growth appends without moving the anchor (coarse, not sliding).
    manager.addMessage('u', text('one-more'));
    await manager.compile(budget);
    assert.equal(strategy.getAnchor(), anchorAfterFirst, 'small growth does not re-anchor');

    await manager.close();
  });

  it('persists the anchor across reopen', async () => {
    const path = freshPath();
    const strategy = new WindowedPassthroughStrategy();
    const manager = await ContextManager.open({ path, strategy });
    manager.addMessage('u', text('a'));
    const pivotId = manager.addMessage('u', text('b'));
    const pivotSeq = manager.getMessage(pivotId)!.sequence;
    strategy.setAnchor(pivotSeq);
    await manager.close();

    const strategy2 = new WindowedPassthroughStrategy();
    const manager2 = await ContextManager.open({ path, strategy: strategy2 });
    assert.equal(strategy2.getAnchor(), pivotSeq, 'anchor survived reopen');
    const result = await manager2.compile();
    assert.deepEqual(
      result.messages.map((m) => (m.content[0] as { text: string }).text),
      ['b'],
    );
    await manager2.close();
  });
});
