/**
 * Two MessageStore instances over one store: a local append must not
 * re-certify an id index or a materialized cache that a sibling's write had
 * already made stale.
 *
 * Reproducer by Astra (2026-10-07): A stores [A, B, C] and warms its caches;
 * a sibling removes A; A appends D; A.get(id-of-B) returned C under B's id,
 * while the raw slot was correctly [B, C, D]. The append stamped A's index
 * as current although the sibling's removal had shifted every ordinal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/index.js';

/** Count whole-slot materializations of the message slot while `run` executes. */
function countingSlotReads(run: () => void): number {
  const proto = JsStore.prototype as unknown as { getStateJson(id: string): unknown };
  const original = proto.getStateJson;
  let reads = 0;
  proto.getStateJson = function (this: JsStore, id: string) {
    if (id === 'messages') reads++;
    return original.call(this, id);
  };
  try {
    run();
  } finally {
    proto.getStateJson = original;
  }
  return reads;
}

const text = (message: { content: Array<{ type: string }> } | null) =>
  (message?.content[0] as { text?: string } | undefined)?.text;

describe('MessageStore siblings on one store', () => {
  it('a local append does not certify an id index a sibling removal made stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-sibling-append-'));
    const root = JsStore.create({ path: join(dir, 'store') });
    try {
      MessageStore.register(root);
      const a = new MessageStore(root);
      const first = a.append('user', [{ type: 'text', text: 'A' }]);
      const second = a.append('user', [{ type: 'text', text: 'B' }]);
      a.append('user', [{ type: 'text', text: 'C' }]);
      a.getAll(); // warm

      const sibling = new MessageStore(root);
      sibling.remove(first.id);
      a.append('user', [{ type: 'text', text: 'D' }]);

      assert.equal(text(a.get(second.id)), 'B', 'B under B\'s id, not C');
      assert.deepEqual(a.getAll().map((m) => text(m)), ['B', 'C', 'D']);
      assert.deepEqual(
        (root.getStateJson('messages') as Array<{ content: Array<{ text: string }> }>).map((m) => m.content[0]!.text),
        ['B', 'C', 'D'],
        'the slot was always right; the index was the liar',
      );
    } finally {
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a local append does not certify a materialized cache a sibling edit made stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-sibling-append-edit-'));
    const root = JsStore.create({ path: join(dir, 'store') });
    try {
      MessageStore.register(root);
      const a = new MessageStore(root);
      const first = a.append('user', [{ type: 'text', text: 'A' }]);
      a.append('user', [{ type: 'text', text: 'B' }]);
      a.getAll(); // warm

      const sibling = new MessageStore(root);
      sibling.edit(first.id, [{ type: 'text', text: 'A-edited' }]); // count preserved
      a.append('user', [{ type: 'text', text: 'C' }]);

      assert.deepEqual(a.getAll().map((m) => text(m)), ['A-edited', 'B', 'C']);
      assert.equal(text(a.get(first.id)), 'A-edited');
    } finally {
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a local edit or removal followed by an append keeps a warm cache warm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-local-edit-append-'));
    const root = JsStore.create({ path: join(dir, 'store') });
    try {
      MessageStore.register(root);
      const a = new MessageStore(root);
      const first = a.append('user', [{ type: 'text', text: 'A' }]);
      const second = a.append('user', [{ type: 'text', text: 'B' }]);
      a.append('user', [{ type: 'text', text: 'C' }]);
      a.getAll(); // warm

      // One instance, its own writes: no whole-slot reload at any point.
      const reads = countingSlotReads(() => {
        a.edit(first.id, [{ type: 'text', text: 'A-edited' }]);
        a.append('user', [{ type: 'text', text: 'D' }]);
        assert.deepEqual(a.getAll().map((m) => text(m)), ['A-edited', 'B', 'C', 'D']);
        a.remove(second.id);
        a.append('user', [{ type: 'text', text: 'E' }]);
        assert.deepEqual(a.getAll().map((m) => text(m)), ['A-edited', 'C', 'D', 'E']);
        assert.equal(text(a.get(first.id)), 'A-edited');
      });
      assert.equal(reads, 0, 'the cache stayed hot through local edit, remove and append');

      // A sibling's write still costs exactly the reload it is owed.
      const sibling = new MessageStore(root);
      const siblingReads = countingSlotReads(() => {
        sibling.edit(first.id, [{ type: 'text', text: 'A-sibling' }]);
        a.append('user', [{ type: 'text', text: 'F' }]);
        assert.equal(text(a.getAll()[0]), 'A-sibling');
      });
      assert.ok(siblingReads >= 1, 'a sibling write forces a rebuild here');
    } finally {
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A store with two MessageStores on its message slot: `reader`, warmed on [A, B], and `sibling`. */
function siblings(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-sibling-tail-'));
  const root = JsStore.create({ path: join(dir, 'store') });
  t.after(() => {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  });
  MessageStore.register(root);
  const reader = new MessageStore(root);
  const first = reader.append('user', [{ type: 'text', text: 'A' }]);
  reader.append('user', [{ type: 'text', text: 'B' }]);
  reader.getAll(); // warm
  return { root, reader, first, sibling: new MessageStore(root) };
}

const texts = (store: MessageStore) => store.getAll().map((m) => text(m));

/** The indices the message slot's point lookups read while `run` executes, in order. */
function pointLookupsDuring(run: () => void): number[] {
  const proto = JsStore.prototype as unknown as { getStateItemJson(id: string, index: number): unknown };
  const original = proto.getStateItemJson;
  const indices: number[] = [];
  proto.getStateItemJson = function (this: JsStore, id: string, index: number) {
    if (id === 'messages') indices.push(index);
    return original.call(this, id, index);
  };
  try {
    run();
  } finally {
    proto.getStateItemJson = original;
  }
  return indices;
}

describe("a sibling's appends reach a warm cache without a whole-slot reload (#251)", () => {
  it("reads a sibling's appends by point lookup, in order", (t) => {
    const { reader, sibling } = siblings(t);
    const appended = sibling.append('user', [{ type: 'text', text: 'X' }]);
    sibling.append('user', [{ type: 'text', text: 'Y' }]);
    let lookups: number[] = [];
    const reads = countingSlotReads(() => {
      lookups = pointLookupsDuring(() => assert.deepEqual(texts(reader), ['A', 'B', 'X', 'Y']));
    });
    assert.equal(reads, 0, "the sibling's appends cost no reload");
    // A lookup of a cached record would cost chronicle's per-item rebuild at every read after a write.
    assert.deepEqual(lookups, [2, 3], 'only the appended records are looked up, none of the cached ones');
    let lookupsAfter: number[] = [];
    const readsAfter = countingSlotReads(() => {
      lookupsAfter = pointLookupsDuring(() => reader.getAll());
    });
    assert.deepEqual([readsAfter, lookupsAfter], [0, []], 'and the extended cache is current: the next read neither reloads nor looks anything up');
    assert.equal(countingSlotReads(() => assert.equal(text(reader.get(appended.id)), 'X')), 0, 'and finds the appended record by id');
  });

  it("keeps its cache through its own append after a sibling's, and through its own edit or removal before one", (t) => {
    const { reader, sibling, first } = siblings(t);
    const reads = countingSlotReads(() => {
      sibling.append('user', [{ type: 'text', text: 'X' }]);
      const own = reader.append('assistant', [{ type: 'text', text: 'C' }]);
      assert.deepEqual(texts(reader), ['A', 'B', 'X', 'C']);
      reader.edit(first.id, [{ type: 'text', text: 'A-edited' }]);
      sibling.append('user', [{ type: 'text', text: 'Y' }]);
      assert.deepEqual(texts(reader), ['A-edited', 'B', 'X', 'C', 'Y']);
      reader.remove(own.id);
      sibling.append('user', [{ type: 'text', text: 'Z' }]);
      assert.deepEqual(texts(reader), ['A-edited', 'B', 'X', 'Y', 'Z']);
    });
    assert.equal(reads, 0, "appends, its own and a sibling's, and its own edit and removal cost no reload");
  });

  for (const write of ['edit', 'remove'] as const) {
    it(`still reloads after a sibling's ${write} and then an append`, (t) => {
      const { reader, sibling, first } = siblings(t);
      if (write === 'edit') sibling.edit(first.id, [{ type: 'text', text: 'A-sibling' }]);
      else sibling.remove(first.id);
      sibling.append('user', [{ type: 'text', text: 'X' }]);
      const reads = countingSlotReads(() => {
        assert.deepEqual(texts(reader), write === 'edit' ? ['A-sibling', 'B', 'X'] : ['B', 'X']);
      });
      assert.equal(reads, 1, `a sibling's ${write} costs the reload it is owed`);
    });
  }

  it("reloads a slot whose length a write outside MessageStore changed, with a sibling's append", (t) => {
    // The append moved the write version by one and the direct write took a
    // record out, so the slot's length is the cache's, not the cache's plus one.
    const { root, reader, sibling } = siblings(t);
    sibling.append('user', [{ type: 'text', text: 'X' }]);
    const raw = root.getStateJson('messages') as unknown[];
    root.setStateJson('messages', raw.slice(1));
    const reads = countingSlotReads(() => {
      assert.deepEqual(texts(reader), ['B', 'X']);
    });
    assert.equal(reads, 1);
  });

  it("reloads when an appended record doesn't read by point lookup", (t) => {
    const { reader, sibling } = siblings(t);
    sibling.append('user', [{ type: 'text', text: 'X' }]);
    const proto = JsStore.prototype as unknown as { getStateItemJson(id: string, index: number): unknown };
    const original = proto.getStateItemJson;
    proto.getStateItemJson = function (this: JsStore, id: string, index: number) {
      return id === 'messages' && index === 2 ? null : original.call(this, id, index);
    };
    let reads: number;
    try {
      reads = countingSlotReads(() => {
        assert.deepEqual(texts(reader), ['A', 'B', 'X']);
      });
    } finally {
      proto.getStateItemJson = original;
    }
    assert.equal(reads, 1, 'the slot is reloaded, not the cache left short');
  });

  it("reloads without recursing on a chronicle that has no point lookup", (t) => {
    const { reader, sibling } = siblings(t);
    sibling.append('user', [{ type: 'text', text: 'X' }]);
    const proto = JsStore.prototype as unknown as { getStateItemJson?: unknown };
    const original = proto.getStateItemJson;
    delete proto.getStateItemJson;
    let reads: number;
    try {
      reads = countingSlotReads(() => {
        assert.deepEqual(texts(reader), ['A', 'B', 'X']);
      });
    } finally {
      proto.getStateItemJson = original;
    }
    assert.ok(reads >= 1, 'the slot is reloaded');
  });

  it('reloads where no version moved but the last record isn\'t the cached one, as the revalidation by count and last record does', (t) => {
    // A write outside MessageStore replaced the last record: the length is the cache's and no version
    // moved, so nothing was appended, and the cache isn't current either.
    const { root, reader } = siblings(t);
    const raw = root.getStateJson('messages') as Array<Record<string, unknown>>;
    root.setStateJson('messages', [raw[0], { ...raw[1], id: 'replaced', content: [{ type: 'text', text: 'Z' }] }]);
    const reads = countingSlotReads(() => {
      assert.deepEqual(texts(reader), ['A', 'Z']);
    });
    assert.equal(reads, 1);
  });

  it('reloads on another branch, where the cached records may not be the slot\'s', (t) => {
    // On the side branch a record is replaced outside MessageStore, and a
    // sibling appends one: the slot grew by the one append, as it would have
    // on the cache's own branch, so only the branch tells the cache is wrong.
    const { root, reader, sibling } = siblings(t);
    root.createBranch('side');
    root.switchBranch('side');
    const raw = root.getStateJson('messages') as Array<Record<string, unknown>>;
    root.setStateJson('messages', [raw[0], { ...raw[1], content: [{ type: 'text', text: 'Z' }] }]);
    sibling.append('user', [{ type: 'text', text: 'C' }]);
    const reads = countingSlotReads(() => {
      assert.deepEqual(texts(reader), ['A', 'Z', 'C']);
    });
    assert.equal(reads, 1);
  });
});
