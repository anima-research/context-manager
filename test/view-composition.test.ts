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
  AutobiographicalStrategy,
  ContextManager,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
  filterMessageStoreView,
  mergeMessageStoreViews,
  OverBudgetError,
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

// ---------------------------------------------------------------------------
// Review round on #54 (Anarchid, 2026-09-04): branch-scoped anchor, aux-slot
// guard rails, hard budget, live-image policy, cache markers.
// ---------------------------------------------------------------------------

const texts = (r: { messages: Array<{ content: ContentBlock[] }> }): string[] =>
  r.messages.map((m) => (m.content[0] as { text: string }).text);

describe('WindowedPassthroughStrategy: branch-scoped anchor', () => {
  it('re-derives the anchor when the store is switched to a branch without it (host undo/redo path)', async () => {
    const path = freshPath();
    const strategy = new WindowedPassthroughStrategy();
    const manager = await ContextManager.open({ path, strategy });
    const m1 = manager.addMessage('u', text('m1'));
    manager.addMessage('u', text('m2'));
    // A branch whose head is m1, taken BEFORE any anchor is persisted.
    const alt = manager.branchAt(m1, 'alt');
    manager.addMessage('u', text('m3'));
    const m4 = manager.addMessage('u', text('m4'));
    strategy.setAnchor(manager.getMessage(m4)!.sequence); // persisted on main only
    assert.deepEqual(texts(await manager.compile()), ['m4']);

    // Host-style raw switch: the chronicle moves, no manager re-initialization
    // (agent-framework's undo/redo do exactly this).
    manager.getStore().switchBranch(alt);
    assert.equal(strategy.getAnchor(), 0, 'the stale in-memory anchor is not carried over');
    assert.deepEqual(texts(await manager.compile()), ['m1'], 'the window is the branch\'s own, not empty');
    await manager.close();
  });

  it('a persisted anchor past the branch head resets to 0 on load', async () => {
    const path = freshPath();
    const anchorStateId = 'test/windowed:anchor';
    const manager = await ContextManager.open({
      path,
      strategy: new WindowedPassthroughStrategy({ anchorStateId }),
    });
    manager.addMessage('u', text('a'));
    manager.addMessage('u', text('b'));
    manager.getStore().setStateJson(anchorStateId, { anchor: 1_000_000 });
    await manager.close();

    const strategy2 = new WindowedPassthroughStrategy({ anchorStateId });
    const manager2 = await ContextManager.open({ path, strategy: strategy2 });
    assert.equal(strategy2.getAnchor(), 0);
    assert.deepEqual(texts(await manager2.compile()), ['a', 'b']);
    await manager2.close();
  });
});

describe('auxiliaryMessageViews guard rails', () => {
  it('refuses an auxiliary entry that resolves to the manager\'s own slot', async () => {
    const path = freshPath();
    const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    await assert.rejects(
      ContextManager.open({
        store: main.getStore(),
        strategy: new PassthroughStrategy(),
        auxiliaryMessageViews: [{}], // non-isolated manager: {} IS its own slot
      }),
      /own message slot/,
    );
    await main.close();
  });

  it('merges a slot listed twice exactly once', async () => {
    const path = freshPath();
    const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({
      store: main.getStore(),
      namespace: 'subconscious/dup',
      isolate: true,
      strategy: new PassthroughStrategy(),
      auxiliaryMessageViews: [{}, {}],
    });
    main.addMessage('alice', text('once'));
    assert.deepEqual(texts(await side.compile()), ['once']);
    await side.close();
    await main.close();
  });
});

describe('WindowedPassthroughStrategy: hard budget', () => {
  const budget = { maxTokens: 300, reserveForResponse: 50 }; // usable 250

  it('refuses with OverBudgetError when the newest message alone exceeds the usable budget', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({ path, strategy: new WindowedPassthroughStrategy() });
    manager.addMessage('u', text('x'.repeat(2000))); // ~500 tokens
    await assert.rejects(manager.compile(budget), (err: Error) => {
      assert.ok(err instanceof OverBudgetError);
      // No compression here: only a newer message that fits, or a larger budget, clears it.
      assert.deepStrictEqual(err.clearedBy, ['newer-message']);
      return true;
    });
    await manager.close();
  });

  it('under maxMessageTokens the same message is truncated with the marker and fits', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({
      path,
      strategy: new WindowedPassthroughStrategy({ maxMessageTokens: 100 }),
    });
    manager.addMessage('u', text('x'.repeat(2000)));
    const t = texts(await manager.compile(budget))[0];
    assert.match(t, /\[truncated — original was 500 tokens\]$/);
    assert.ok(t.length < 500, `cut to the cap (400 chars) plus marker, got ${t.length}`);
    await manager.close();
  });

  it('a tool result past the message\'s cap keeps its pairing and says the cap ran out', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({
      path,
      strategy: new WindowedPassthroughStrategy({ maxMessageTokens: 100 }),
    });
    manager.addMessage('a', [{ type: 'tool_use', id: 't1', name: 'read', input: {} }]);
    manager.addMessage('u', [
      { type: 'text', text: 'x'.repeat(2000) },
      { type: 'tool_result', toolUseId: 't1', content: 'the file' },
    ]);
    const compiled = await manager.compile(budget);
    const blocks = compiled.messages.flatMap((m) => m.content);
    const result = blocks.find((b) => b.type === 'tool_result') as { toolUseId?: string; content: unknown } | undefined;
    assert.equal(result?.toolUseId, 't1', 'the result still answers its call');
    assert.ok(blocks.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 't1'), 'and the call is still there');
    assert.equal(result?.content, '[content omitted: this message reached its token limit before this result]');
    await manager.close();
  });

  it('autobiographical\'s message cap writes the same marker on a tool result past it', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 100_000, maxMessageTokens: 100 }),
    });
    manager.addMessage('a', [{ type: 'tool_use', id: 't1', name: 'read', input: {} }]);
    manager.addMessage('u', [
      { type: 'text', text: 'x'.repeat(2000) },
      { type: 'tool_result', toolUseId: 't1', content: 'the file' },
    ]);
    const compiled = await manager.compile(budget);
    const result = compiled.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { toolUseId?: string; content: unknown } | undefined;
    assert.equal(result?.toolUseId, 't1');
    assert.equal(result?.content, '[content omitted: this message reached its token limit before this result]');
    await manager.close();
  });

  it('text past the cap is dropped with one marker where it began', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({
      path,
      strategy: new WindowedPassthroughStrategy({ maxMessageTokens: 100 }),
    });
    manager.addMessage('u', [
      { type: 'text', text: 'x'.repeat(2000) },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'third' },
    ]);
    const compiled = await manager.compile(budget);
    const blocks = compiled.messages[0].content.map((b) => (b as { text: string }).text);
    assert.equal(blocks.length, 2, 'the cut block and one marker for the two dropped ones');
    assert.match(blocks[0], /\[truncated — original was 500 tokens\]$/);
    assert.equal(blocks[1], '[content omitted: this message reached its token limit]');
    await manager.close();
  });
});

describe('the message cap\'s omission marker, in both strategies', () => {
  const budget = { maxTokens: 300, reserveForResponse: 50 }; // usable 250, as the cap tests above
  const strategies = [
    ['windowed passthrough', () => new WindowedPassthroughStrategy({ maxMessageTokens: 100 })],
    ['autobiographical', () => new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 100_000, maxMessageTokens: 100 })],
  ] as const;
  for (const [name, make] of strategies) {
    it(`${name}: goes where the first dropped text was, after a tool result and an image the cap keeps`, async () => {
      const path = freshPath();
      const manager = await ContextManager.open({ path, strategy: make() });
      manager.addMessage('a', [{ type: 'tool_use', id: 't1', name: 'read', input: {} }]);
      manager.addMessage('u', [
        { type: 'text', text: 'x'.repeat(2000) },
        { type: 'tool_result', toolUseId: 't1', content: 'the file' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock,
        { type: 'text', text: 'dropped' },
      ]);
      const compiled = await manager.compile(budget);
      // The compile sends the result in a turn of its own, so read the
      // message's blocks in order across the turns after the call.
      const call = compiled.messages.findIndex((m) => m.content.some((b) => b.type === 'tool_use'));
      const blocks = compiled.messages.slice(call + 1).flatMap((m) => m.content);
      assert.deepEqual(blocks.map((b) => b.type), ['text', 'tool_result', 'image', 'text']);
      assert.match((blocks[0] as { text: string }).text, /\[truncated — original was 500 tokens\]$/);
      assert.equal((blocks[1] as { content: unknown }).content, '[content omitted: this message reached its token limit before this result]');
      assert.equal((blocks[3] as { text: string }).text, '[content omitted: this message reached its token limit]');
      await manager.close();
    });

    it(`${name}: isn't written for text blocks past the cap that hold nothing, which are left out, since nothing was lost`, async () => {
      const path = freshPath();
      const manager = await ContextManager.open({ path, strategy: make() });
      manager.addMessage('u', [
        { type: 'text', text: 'x'.repeat(2000) },
        { type: 'text', text: '' },
        { type: 'text', text: '  ' },
      ]);
      const compiled = await manager.compile(budget);
      const blocks = compiled.messages.flatMap((m) => m.content);
      assert.equal(blocks.length, 1, `only the cut block is sent: ${JSON.stringify(blocks)}`);
      assert.match(String((blocks[0] as { text?: string }).text), /\[truncated — original was 500 tokens\]$/);
      await manager.close();
    });
  }
});

describe('WindowedPassthroughStrategy: the price of a message the cap leaves whole', () => {
  it('is its full estimate, as it renders, though its estimate passed the cap', async () => {
    // Eleven one-character blocks estimate at 11 tokens, rounded up per block, past the 10-token cap,
    // but their 11 characters fit its 40, so nothing is cut. A tool call, which the cap doesn't read,
    // makes the message far larger than the budget.
    const priced = async (maxMessageTokens: number | undefined): Promise<number> => {
      const manager = await ContextManager.open({ path: freshPath(), strategy: new WindowedPassthroughStrategy(maxMessageTokens === undefined ? {} : { maxMessageTokens }) });
      manager.addMessage('a', [
        ...Array.from({ length: 11 }, (): ContentBlock => ({ type: 'text', text: 'x' })),
        { type: 'tool_use', id: 't1', name: 'zz_note', input: { note: 'y'.repeat(4000) } } as ContentBlock,
      ]);
      try {
        await manager.compile({ maxTokens: 500, reserveForResponse: 0 });
        assert.fail('premise: the message is over the budget');
      } catch (error) {
        assert.ok(error instanceof OverBudgetError, `premise: refused for its size: ${String(error)}`);
        return (error as OverBudgetError & { actual: number }).actual;
      } finally {
        await manager.close();
      }
    };
    const uncapped = await priced(undefined);
    assert.ok(uncapped > 60, `premise: the full estimate passes cap + 50: ${uncapped}`);
    assert.equal(await priced(10), uncapped, 'priced at its full estimate, as with no cap, not at min(estimate, cap + 50)');
  });
});

describe('WindowedPassthroughStrategy: live-image policy', () => {
  it('keeps the newest images and replaces older ones with the placeholder', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({
      path,
      strategy: new WindowedPassthroughStrategy({ maxLiveImages: 1, imageStripDepthTokens: 0 }),
    });
    const withImage = (tag: string): ContentBlock[] => [
      { type: 'text', text: tag },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock,
    ];
    manager.addMessage('u', withImage('i1'));
    manager.addMessage('u', withImage('i2'));
    manager.addMessage('u', withImage('i3'));
    const result = await manager.compile();
    const shape = result.messages.map((m) =>
      m.content.map((b) => (b.type === 'image' ? 'image' : (b as { text: string }).text)),
    );
    assert.deepEqual(shape, [
      ['i1', "[image not shown: this context keeps only some images]"],
      ['i2', "[image not shown: this context keeps only some images]"],
      ['i3', 'image'],
    ]);
    await manager.close();
  });
});

describe('WindowedPassthroughStrategy: cache markers', () => {
  const breakpoints = (r: { messages: Array<{ cacheBreakpoint?: boolean }> }): number[] =>
    r.messages.map((m, i) => (m.cacheBreakpoint ? i : -1)).filter((i) => i >= 0);

  it('marks the end on the first compile, then the previous endpoint plus the new end on append', async () => {
    const path = freshPath();
    const manager = await ContextManager.open({ path, strategy: new WindowedPassthroughStrategy() });
    manager.addMessage('u', text('a'));
    manager.addMessage('u', text('b'));
    assert.deepEqual(breakpoints(await manager.compile()), [1]);
    manager.addMessage('u', text('c'));
    manager.addMessage('u', text('d'));
    assert.deepEqual(breakpoints(await manager.compile()), [1, 3], 'previous request endpoint named explicitly + new end');
    // No growth: the whole window is the surviving prefix; end-only.
    assert.deepEqual(breakpoints(await manager.compile()), [3]);
    await manager.close();
  });

  it('after a re-anchor only the end is marked (no surviving prefix)', async () => {
    const path = freshPath();
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const manager = await ContextManager.open({ path, strategy });
    const budget = { maxTokens: 1000, reserveForResponse: 50 };
    for (let i = 0; i < 4; i++) manager.addMessage('u', text(`m${i}-${'x'.repeat(200)}`));
    await manager.compile(budget); // ~4 × 51 tokens: fits
    for (let i = 4; i < 24; i++) manager.addMessage('u', text(`m${i}-${'x'.repeat(200)}`));
    const r = await manager.compile(budget); // overflow → coarse re-anchor
    assert.ok(strategy.getAnchor() > 0, 'anchor moved');
    assert.deepEqual(breakpoints(r), [r.messages.length - 1]);
    await manager.close();
  });
});
