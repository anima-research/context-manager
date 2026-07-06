/**
 * Tests for MessageStore.getWindow — the O(window) read path added for the
 * webui interiority viewer (windowed welcome + history paging).
 *
 * Covers:
 *  - window bounds & clamping (empty store, offset past end, limit <= 0)
 *  - getTail/getFrom equivalence with their old getAll().slice() semantics
 *  - bodyGroup edge alignment (windows never split a shard run when asked)
 *  - the no-getStateSlice fallback path (chronicle <= 0.2.1 boxes)
 *  - resolveBlobs: false passes blob_ref placeholders through un-inflated
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-message-store-window';

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

describe('MessageStore.getWindow', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('returns the requested window with correct startIndex/totalCount', () => {
    const { store, messages } = openStore();
    for (let i = 0; i < 10; i++) messages.append('user', textBlock(`m${i}`));

    const win = messages.getWindow(3, 4);
    assert.equal(win.totalCount, 10);
    assert.equal(win.startIndex, 3);
    assert.deepEqual(win.messages.map(textOf), ['m3', 'm4', 'm5', 'm6']);

    // Window contents must match the equivalent getAll() slice exactly (ids too).
    const all = messages.getAll();
    assert.deepEqual(
      win.messages.map((m) => m.id),
      all.slice(3, 7).map((m) => m.id),
    );
    store.close();
  });

  it('clamps: empty store, offset past end, limit <= 0, window past end', () => {
    const { store, messages } = openStore();

    // Empty store
    let win = messages.getWindow(0, 10);
    assert.deepEqual(win, { messages: [], startIndex: 0, totalCount: 0 });

    for (let i = 0; i < 5; i++) messages.append('user', textBlock(`m${i}`));

    // Offset past end
    win = messages.getWindow(99, 10);
    assert.equal(win.messages.length, 0);
    assert.equal(win.totalCount, 5);

    // limit <= 0
    win = messages.getWindow(2, 0);
    assert.equal(win.messages.length, 0);
    win = messages.getWindow(2, -3);
    assert.equal(win.messages.length, 0);

    // Window running past the end is truncated, not an error
    win = messages.getWindow(3, 100);
    assert.deepEqual(win.messages.map(textOf), ['m3', 'm4']);
    assert.equal(win.startIndex, 3);
    store.close();
  });

  it('getTail/getFrom preserve their old getAll().slice() semantics', () => {
    const { store, messages } = openStore();
    for (let i = 0; i < 8; i++) messages.append('user', textBlock(`m${i}`));
    const all = messages.getAll();

    // getTail
    for (const n of [0, 1, 3, 8, 99]) {
      assert.deepEqual(
        messages.getTail(n).map((m) => m.id),
        all.slice(Math.max(0, all.length - n)).map((m) => m.id),
        `getTail(${n})`,
      );
    }
    // getFrom, including the negative-index slice behavior
    for (const idx of [0, 2, 7, 8, 99, -3]) {
      assert.deepEqual(
        messages.getFrom(idx).map((m) => m.id),
        all.slice(idx).map((m) => m.id),
        `getFrom(${idx})`,
      );
    }
    store.close();
  });

  it('alignToBodyGroups extends window edges to whole shard runs', () => {
    const { store, messages } = openStore();
    // Layout: m0 m1 [g1s0 g1s1 g1s2] m5 [g2s0 g2s1] m8
    messages.append('user', textBlock('m0'));
    messages.append('user', textBlock('m1'));
    for (let s = 0; s < 3; s++) {
      messages.append('user', textBlock(`g1s${s}`), undefined, undefined, {
        bodyGroupId: 'g1',
        shardIndex: s,
      });
    }
    messages.append('user', textBlock('m5'));
    for (let s = 0; s < 2; s++) {
      messages.append('user', textBlock(`g2s${s}`), undefined, undefined, {
        bodyGroupId: 'g2',
        shardIndex: s,
      });
    }
    messages.append('user', textBlock('m8'));

    // Unaligned: bisects both groups.
    let win = messages.getWindow(3, 4);
    assert.deepEqual(win.messages.map(textOf), ['g1s1', 'g1s2', 'm5', 'g2s0']);

    // Aligned: start walks back to g1s0 (index 2), end walks forward to g2s1 (index 7).
    win = messages.getWindow(3, 4, { alignToBodyGroups: true });
    assert.equal(win.startIndex, 2);
    assert.deepEqual(win.messages.map(textOf), ['g1s0', 'g1s1', 'g1s2', 'm5', 'g2s0', 'g2s1']);

    // Alignment can walk all the way to index 0.
    const { store: s2, messages: m2 } = (() => {
      store.close();
      cleanup();
      return openStore();
    })();
    for (let s = 0; s < 3; s++) {
      m2.append('user', textBlock(`h s${s}`), undefined, undefined, {
        bodyGroupId: 'h',
        shardIndex: s,
      });
    }
    const w2 = m2.getWindow(2, 1, { alignToBodyGroups: true });
    assert.equal(w2.startIndex, 0);
    assert.equal(w2.messages.length, 3);

    // Edges without bodyGroupId are untouched.
    const w3 = m2.getWindow(0, 3, { alignToBodyGroups: true });
    assert.equal(w3.startIndex, 0);
    assert.equal(w3.messages.length, 3);
    s2.close();
  });

  it('falls back to full materialization when getStateSlice is unavailable (chronicle <= 0.2.1)', () => {
    const { store, messages } = openStore();
    for (let i = 0; i < 6; i++) messages.append('user', textBlock(`m${i}`));

    // Same store, but with getStateSlice hidden — simulates an old chronicle.
    const legacyStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getStateSlice') return undefined;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as JsStore;
    const legacyMessages = new MessageStore(legacyStore);

    const modern = messages.getWindow(2, 3);
    const legacy = legacyMessages.getWindow(2, 3);
    assert.deepEqual(
      legacy.messages.map((m) => m.id),
      modern.messages.map((m) => m.id),
    );
    assert.equal(legacy.startIndex, modern.startIndex);
    assert.equal(legacy.totalCount, modern.totalCount);
    store.close();
  });

  it('resolveBlobs: false passes blob_ref placeholders through un-inflated', () => {
    const { store, messages } = openStore();
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452',
      'hex',
    ).toString('base64');
    messages.append('user', [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } } as ContentBlock,
    ]);

    // Default: blob is re-inlined as an image block.
    const resolved = messages.getWindow(0, 1);
    assert.ok(resolved.messages[0].content.some((b) => b.type === 'image'));

    // resolveBlobs: false — the stored blob_ref placeholder survives.
    const raw = messages.getWindow(0, 1, { resolveBlobs: false });
    const kinds = raw.messages[0].content.map((b) => (b as { type: string }).type);
    assert.ok(kinds.includes('blob_ref'), `expected blob_ref in ${JSON.stringify(kinds)}`);
    assert.ok(!kinds.includes('image'));
    store.close();
  });
});
