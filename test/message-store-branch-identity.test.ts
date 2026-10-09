import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/message-store.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredContentBlock, StoredMessageInternal } from '../src/types/index.js';

const opened: Array<{ store: JsStore; path: string }> = [];
afterEach(() => {
  for (const { store, path } of opened.splice(0)) {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});

const content = (text: string): ContentBlock[] => [{ type: 'text', text }];
const textOf = (blocks: Array<ContentBlock | StoredContentBlock>): string => blocks.map((b) => b.type === 'text' ? b.text : '').join('');

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'cm-message-branch-identity-'));
  const store = JsStore.openOrCreate({ path: join(path, 'store') });
  opened.push({ store, path });
  MessageStore.register(store);
  const messages = new MessageStore(store);
  const ids = ['a', 'b', 'c'].map((s) => messages.append('user', content(s)).id);
  const main = store.currentBranch().name;
  store.createBranch('side');
  store.switchBranch('side');
  const previousId = store.currentBranch().id;
  return {
    store, messages, ids,
    recreate() {
      // No MessageStore call observes the intervening main branch, and no
      // message write bumps the shared write version. Only identity changes.
      store.switchBranch(main);
      store.deleteBranch('side');
      store.createBranch('side');
      store.switchBranch('side');
      assert.notEqual(store.currentBranch().id, previousId);
    },
    rawTexts() {
      return (store.getStateJson('messages') as StoredMessageInternal[]).map((m) => textOf(m.content));
    },
  };
}

describe('MessageStore branch identity (issue #92)', () => {
  it('point reads rebuild a shifted id index after same-name branch recreation', () => {
    const f = fixture();
    f.messages.remove(f.ids[0]);
    assert.equal(textOf(f.messages.get(f.ids[1])!.content), 'b');
    f.recreate();
    assert.equal(textOf(f.messages.get(f.ids[1])!.content), 'b');
    assert.equal(textOf(f.messages.get(f.ids[0])!.content), 'a');
  });

  for (const operation of ['edit', 'remove', 'removeRange'] as const) {
    it(`${operation} targets the requested id in the recreated branch`, () => {
      const f = fixture();
      f.messages.remove(f.ids[0]);
      f.recreate();
      if (operation === 'edit') {
        f.messages.edit(f.ids[1], content('edited b'));
        assert.deepEqual(f.rawTexts(), ['a', 'edited b', 'c']);
      } else if (operation === 'remove') {
        f.messages.remove(f.ids[1]);
        assert.deepEqual(f.rawTexts(), ['a', 'c']);
      } else {
        f.messages.removeRange(f.ids[1], f.ids[1]);
        assert.deepEqual(f.rawTexts(), ['a', 'c']);
      }
    });
  }

  it('getAll drops old content even when count and tail identity still match', () => {
    const f = fixture();
    f.messages.edit(f.ids[0], content('old side a'));
    const old = f.messages.getAll();
    assert.deepEqual(old.map((m) => textOf(m.content)), ['old side a', 'b', 'c']);
    f.recreate();
    const current = f.messages.getAll();
    assert.deepEqual(current.map((m) => textOf(m.content)), ['a', 'b', 'c']);
    assert.strictEqual(f.messages.getAll(), current, 'same-branch reads keep the mapped cache hot');
  });

  it('an append cannot write through a materialized cache from a deleted branch', () => {
    const f = fixture();
    f.messages.edit(f.ids[0], content('old side a'));
    f.messages.getAll();
    f.recreate();
    f.messages.append('user', content('d'));
    assert.deepEqual(f.messages.getAll().map((m) => textOf(m.content)), ['a', 'b', 'c', 'd']);
    assert.deepEqual(f.rawTexts(), ['a', 'b', 'c', 'd']);
  });
});
