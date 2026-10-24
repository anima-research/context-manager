/**
 * A lone UTF-16 surrogate half in what a state write stores.
 *
 * JSON.stringify writes a lone half as the escape `\udXXX`, which the native
 * store keeps and can't parse back, so one such write left the whole state
 * unreadable and the store unopenable. The JSON-bytes writes in src go
 * through storedJson, which stores U+FFFD for a lone half, as an append of
 * the same string stores it. storedJson's own tests check its bytes, and the
 * rest write through a real store and read back.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextLog, ContextManager } from '../src/index.js';
import type { SummaryEntry } from '../src/index.js';
import { storedJson } from '../src/stored-json.js';

const HIGH = '\uD800';
const LOW = '\uDC00';
const FFFD = '\uFFFD';
/** Six characters: a backslash, then `ud800`, as text, which isn't a half. */
const SPELLED = '\\ud800';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'cm-stored-json-'));
  roots.push(root);
  return join(root, 'store');
}
const strategy = () => new AutobiographicalStrategy({ autoTickOnNewMessage: false, speculativeProduction: false });
const parsed = (value: unknown): unknown => JSON.parse(storedJson(value).toString('utf8'));

describe('storedJson', () => {
  it('stores U+FFFD for a lone half, high or low, in a string or a key, and keeps a pair beside one', () => {
    assert.deepEqual(parsed({ text: `a${HIGH}b`, more: [`c${LOW}`] }), { text: `a${FFFD}b`, more: [`c${FFFD}`] });
    assert.deepEqual(parsed({ [`k${HIGH}`]: 1 }), { [`k${FFFD}`]: 1 });
    assert.deepEqual(parsed({ text: `\uD83D\uDE00${HIGH}` }), { text: `\uD83D\uDE00${FFFD}` }, 'the pair is kept beside the half');
    assert.deepEqual(parsed({ text: `${LOW}${HIGH}` }), { text: `${FFFD}${FFFD}` }, 'a low half before a high one is two halves, not a pair');
    // eslint-disable-next-line no-new-wrappers
    assert.deepEqual(parsed({ boxed: new String(`a${HIGH}`) }), { boxed: `a${FFFD}` }, 'a String object, which JSON.stringify unboxes');
  });

  it('tells an escaped backslash from an escape', () => {
    assert.deepEqual(parsed({ text: `a${SPELLED}b` }), { text: `a${SPELLED}b` }, 'a backslash, then ud800, as text');
    assert.deepEqual(parsed({ text: `\\\\ud800` }), { text: `\\\\ud800` }, 'two backslashes, then ud800');
    assert.deepEqual(parsed({ text: `\\${HIGH}` }), { text: `\\${FFFD}` }, 'a backslash, then a lone half');
    assert.deepEqual(parsed({ text: `\\\\${HIGH}` }), { text: `\\\\${FFFD}` }, 'two backslashes, then a lone half');
  });

  it('writes what JSON.stringify writes where nothing is a lone half', () => {
    const shapes: unknown[] = [
      { text: 'plain' }, { text: SPELLED }, { text: 'a\uD83D\uDE00b' }, [1, null, 'x', [[]]],
      { at: new Date(0), bytes: Buffer.from('zz'), gone: undefined, nested: [{ deep: ['y'] }] },
    ];
    for (const value of shapes) assert.equal(storedJson(value).toString('utf8'), JSON.stringify(value));
  });

  it('reads each getter once, as one stringify does', () => {
    let reads = 0;
    const value = { get revision() { reads++; return reads; }, text: `a${HIGH}` };
    assert.deepEqual(JSON.parse(storedJson(value).toString('utf8')), { revision: 1, text: `a${FFFD}` });
    assert.equal(reads, 1);
  });
});

describe('a lone half in what an edit stores', () => {
  const shapes: Array<[string, (s: string) => ContentBlock[]]> = [
    ['a text block', (s) => [{ type: 'text', text: `a${s}b` }]],
    ["a tool_result's string content", (s) => [{ type: 'tool_result', toolUseId: 'toolu_zz', content: `a${s}b` } as ContentBlock]],
    ["a tool_result's block content", (s) => [{ type: 'tool_result', toolUseId: 'toolu_zz', content: [{ type: 'text', text: `a${s}b` }] } as ContentBlock]],
  ];
  for (const [halfName, half] of [['high', HIGH], ['low', LOW]] as const) {
    for (const [shapeName, shape] of shapes) {
      it(`an edit to ${shapeName} with a lone ${halfName} half stores U+FFFD, as the append of the same content does, and the store reopens`, async () => {
        const path = storePath();
        let manager = await ContextManager.open({ path, strategy: strategy() });
        const appended = manager.addMessage('user', shape(half));
        const edited = manager.addMessage('user', [{ type: 'text', text: 'plain' }]);
        manager.editMessage(edited, shape(half));
        const expected = shape(FFFD);
        assert.deepEqual(manager.getMessage(appended)?.content, expected, 'the premise: an append stores U+FFFD');
        assert.deepEqual(manager.getMessage(edited)?.content, expected);
        assert.deepEqual(manager.getAllMessages().map((m) => m.content), [expected, expected]);
        manager.close();
        manager = await ContextManager.open({ path, strategy: strategy() });
        assert.deepEqual(manager.getMessage(edited)?.content, expected, 'after reopening');
        manager.close();
      });
    }
  }

  it("an edit to a tool_use whose input has a key with a lone half stores the key with U+FFFD, where an append of it drops the key", async () => {
    const path = storePath();
    let manager = await ContextManager.open({ path, strategy: strategy() });
    const keyed = (s: string) => [{ type: 'tool_use', id: 'toolu_zz', name: 'zz', input: { [`k${s}`]: 'v', kept: 1 } } as ContentBlock];
    const appended = manager.addMessage('assistant', keyed(HIGH));
    const edited = manager.addMessage('assistant', [{ type: 'text', text: 'plain' }]);
    manager.editMessage(edited, keyed(HIGH));
    assert.deepEqual(manager.getMessage(appended)?.content, [{ type: 'tool_use', id: 'toolu_zz', name: 'zz', input: { kept: 1 } }], "the premise: the append's conversion drops the key");
    assert.deepEqual(manager.getMessage(edited)?.content, keyed(FFFD));
    manager.close();
    manager = await ContextManager.open({ path, strategy: strategy() });
    assert.deepEqual(manager.getMessage(edited)?.content, keyed(FFFD), 'after reopening');
    manager.close();
  });

  it('an edit to a text that spells out an escape stores it as it is', async () => {
    const path = storePath();
    let manager = await ContextManager.open({ path, strategy: strategy() });
    const id = manager.addMessage('user', [{ type: 'text', text: 'plain' }]);
    manager.editMessage(id, [{ type: 'text', text: `a${SPELLED}b` }]);
    assert.deepEqual(manager.getMessage(id)?.content, [{ type: 'text', text: `a${SPELLED}b` }]);
    manager.close();
    manager = await ContextManager.open({ path, strategy: strategy() });
    assert.deepEqual(manager.getMessage(id)?.content, [{ type: 'text', text: `a${SPELLED}b` }]);
    manager.close();
  });

  it("a context log entry's edit stores U+FFFD, and the log reads after reopening", () => {
    const path = storePath();
    let store = JsStore.openOrCreate({ path });
    ContextLog.register(store);
    let log = new ContextLog(store);
    log.append('user', [{ type: 'text', text: 'plain' }], 'm-zz', 'copy');
    log.edit(0, [{ type: 'text', text: `a${HIGH}b` }]);
    assert.deepEqual(log.getAll().map((entry) => entry.content), [[{ type: 'text', text: `a${FFFD}b` }]]);
    store.close();
    store = JsStore.openOrCreate({ path });
    log = new ContextLog(store);
    assert.deepEqual(log.getAll().map((entry) => entry.content), [[{ type: 'text', text: `a${FFFD}b` }]], 'after reopening');
    store.close();
  });
});

describe("a lone half in what the strategy's own records store", () => {
  type Internals = {
    summaries: SummaryEntry[];
    summariesStateId: string;
    pushSummary(entry: SummaryEntry): void;
    setMergedInto(entry: SummaryEntry, mergedIntoId: string): void;
  };

  it("a merge recorded on a summary minted with a lone half stores U+FFFD, and the summaries load after reopening", async () => {
    const path = storePath();
    let s = strategy();
    let manager = await ContextManager.open({ path, strategy: s });
    const ids = [0, 1].map((i) => manager.addMessage('user', [{ type: 'text', text: `message ${i}` }]));
    const internals = s as unknown as Internals;
    internals.pushSummary({ id: 'L1-zz', level: 1, sourceLevel: 0, sourceIds: ids, sourceRange: { first: ids[0]!, last: ids[1]! }, content: `memory a${HIGH}b`, tokens: 5, created: 0 } as SummaryEntry);
    assert.equal(internals.summaries.find((e) => e.id === 'L1-zz')?.content, `memory a${HIGH}b`, 'the premise: memory keeps the half the model wrote');
    internals.setMergedInto(internals.summaries.find((e) => e.id === 'L1-zz')!, 'L2-zz');
    const stored = manager.getStore().getStateJson(internals.summariesStateId) as SummaryEntry[];
    assert.deepEqual(stored.map((e) => [e.content, e.mergedInto]), [[`memory a${FFFD}b`, 'L2-zz']]);
    manager.close();
    s = strategy();
    manager = await ContextManager.open({ path, strategy: s });
    // The open drops a mergedInto naming no summary, as L2-zz names none here.
    assert.deepEqual((s as unknown as Internals).summaries.map((e) => e.content), [`memory a${FFFD}b`]);
    manager.close();
  });

  it("a chunk record and a state written whole store U+FFFD for a lone half, though what they hold today is ids, and read after reopening", async () => {
    const path = storePath();
    const s = strategy();
    let manager = await ContextManager.open({ path, strategy: s });
    const internals = s as unknown as {
      chunkRecords: Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
      chunksStateId: string;
      markChunkRecordCompressed(recordId: string, summaryId: string): void;
      writeStateJson(stateId: string, value: unknown): void;
    };
    const record = { id: 'c-zz', sourceIds: ['m1'], compressed: false };
    internals.chunkRecords.push({ ...record });
    manager.getStore().appendToStateJson(internals.chunksStateId, record);
    internals.markChunkRecordCompressed('c-zz', `L1-${HIGH}`);
    assert.deepEqual((manager.getStore().getStateJson(internals.chunksStateId) as Array<{ id: string; summaryId?: string }>).find((r) => r.id === 'c-zz')?.summaryId, `L1-${FFFD}`);
    manager.getStore().registerState({ id: 'zz-whole', strategy: 'snapshot' });
    internals.writeStateJson('zz-whole', { note: `a${LOW}b` });
    assert.deepEqual(manager.getStore().getStateJson('zz-whole'), { note: `a${FFFD}b` });
    manager.close();
    manager = await ContextManager.open({ path, strategy: strategy() });
    // The open doesn't keep c-zz as written (its sources aren't messages), so what reopening shows here is that the slot reads.
    assert.ok(Array.isArray(manager.getStore().getStateJson(internals.chunksStateId)), 'the chunk records read after reopening');
    assert.deepEqual(manager.getStore().getStateJson('zz-whole'), { note: `a${FFFD}b` }, 'after reopening');
    manager.close();
  });

  it('two keys of one object that differ only in a lone half come out as one, and the store keeps the last', () => {
    const path = storePath();
    const store = JsStore.openOrCreate({ path });
    store.registerState({ id: 'zz-keys', strategy: 'snapshot' });
    store.setState('zz-keys', storedJson({ [`k${HIGH}`]: 1, [`k${FFFD}`]: 2 }));
    assert.deepEqual(store.getStateJson('zz-keys'), { [`k${FFFD}`]: 2 });
    store.close();
    const reopened = JsStore.openOrCreate({ path });
    assert.deepEqual(reopened.getStateJson('zz-keys'), { [`k${FFFD}`]: 2 }, 'after reopening');
    reopened.close();
  });
});
