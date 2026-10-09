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
