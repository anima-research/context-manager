import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import {
  ContextManager,
  AutobiographicalStrategy,
  PassthroughStrategy,
  MessageStore,
  filterMessageStoreView,
  mergeMessageStoreViews,
  type StoredMessage,
} from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const BASE = './test-removal-guard';
let storeSeq = 0;
const freshPath = (): string => `${BASE}-${storeSeq++}`;
function cleanup() {
  for (let i = 0; i <= storeSeq; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

const SUMS = 'default/autobio:summaries';
const CHUNKS = 'default/autobio:chunks';

const membrane = {
  complete: async () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: `a recollection, ${'of what happened '.repeat(2)}` }],
    usage: { input_tokens: 100, output_tokens: 20 },
  }),
} as any;

const strategy = () =>
  new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 100,
    summaryTargetTokens: 20,
    headWindowTokens: 0,
    recentWindowTokens: 300,
    l1HoldbackChunks: 0,
    autoTickOnNewMessage: false,
  });

const t = (s: string): ContentBlock => ({ type: 'text', text: s });
let n = 0;
const add = (cm: ContextManager, count: number): string[] => {
  const ids: string[] = [];
  for (let i = 0; i < count; i++, n++) {
    ids.push(cm.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(`message ${n}: ${'substantive words about real happenings '.repeat(3)}`)]));
  }
  return ids;
};

async function drain(cm: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cm.isReady()) return;
    await cm.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

const records = (cm: ContextManager): Array<{ sourceIds: string[] }> => {
  const stored = cm.getStore().getStateJson(CHUNKS);
  return Array.isArray(stored) ? stored : [];
};
const l1Sources = (cm: ContextManager): Set<string> => {
  const stored = cm.getStore().getStateJson(SUMS);
  const out = new Set<string>();
  for (const s of Array.isArray(stored) ? stored : []) if (s && s.level === 1) for (const id of s.sourceIds ?? []) out.add(id);
  return out;
};

async function growTo(cm: ContextManager, count: number): Promise<void> {
  for (let i = 0; i < 400 && records(cm).length < count; i++) {
    add(cm, 1);
    await cm.tick();
  }
  assert.strictEqual(records(cm).length, count, `grew to ${count} chunk records`);
  await drain(cm);
}

async function laterMessagesCompress(cm: ContextManager, s: AutobiographicalStrategy, label: string): Promise<void> {
  const later = add(cm, 40);
  await drain(cm);
  const covered = l1Sources(cm);
  assert.ok(later.some((id) => covered.has(id)), `${label}: an L1 covers messages added after it`);
  assert.notStrictEqual(s.getCompressionDebt().state, 'critical', `${label}: the debt report isn't critical`);
}

const messageStoreOf = (cm: ContextManager): MessageStore => (cm as unknown as { messageStore: MessageStore }).messageStore;
const assertGone = (cm: ContextManager, ids: string[]): void => {
  const live = new Set(cm.getAllMessages().map((m) => m.id));
  assert.ok(ids.length > 0 && ids.every((id) => !live.has(id)), 'the removed messages are gone');
};

describe('removal and the chain-break guard', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('removing the messages of 3 of 5 chunk records one by one leaves later messages compressing', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const removed = records(cm).slice(0, 3).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    assertGone(cm, removed);
    await laterMessagesCompress(cm, s, 'removeMessage');
    await cm.close();
  });

  it('removing the messages of both of 2 chunk records as a range leaves later messages compressing', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 2);
    const ids = records(cm).flatMap((r) => r.sourceIds);
    cm.removeMessages(ids[0]!, ids[ids.length - 1]!);
    assertGone(cm, ids);
    await laterMessagesCompress(cm, s, 'removeMessages');
    await cm.close();
  });

  it('a store reopened under a view filter hiding the messages of 5 of 8 chunk records compresses later messages', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    await growTo(cm, 8);
    const hidden = new Set(records(cm).slice(0, 5).flatMap((r) => r.sourceIds));
    await cm.close();
    const s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane, viewFilter: (m: StoredMessage) => !hidden.has(m.id) });
    await laterMessagesCompress(cm, s, 'viewFilter');
    await cm.close();
  });

  it('a store whose chunk records a removal emptied before it closed compresses later messages after it reopens', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    await growTo(cm, 8);
    const removed = records(cm).slice(0, 5).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    await cm.close();
    const s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane });
    assertGone(cm, removed);
    await laterMessagesCompress(cm, s, 'reopened');
    await cm.close();
  });

  it('chunk records each naming a removed message beside ids the store never held leave later messages compressing', async () => {
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
      const removed = add(cm, 4);
      for (const id of removed) cm.removeMessage(id);
      const store = cm.getStore();
      for (let c = 0; c < 4; c++) {
        store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds: [removed[c]!, `ghost-${c}`], compressed: true, summaryId: `L1-${c}` });
      }
      cm.sync();
      await cm.close();
    }
    const s = strategy();
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    await laterMessagesCompress(cm, s, 'mixed');
    await cm.close();
  });

  it('chunk records naming record numbers the store gives messages later in the same load stop halting compression once it has', async () => {
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
      const store = cm.getStore();
      const from = store.currentSequence() + 40;
      for (let c = 0; c < 4; c++) {
        const ids = Array.from({ length: 60 }, (_, i) => String(from + 60 * c + i));
        store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds: ids, compressed: true, summaryId: `L1-${c}` });
      }
      cm.sync();
      await cm.close();
    }
    const s = strategy();
    const cm = await ContextManager.open({ path, strategy: s, membrane, viewFilter: (m: StoredMessage) => m.metadata?.hidden !== true });
    assert.strictEqual(s.getCompressionDebt().state, 'critical', 'the guard holds at open');
    const hidden: string[] = [];
    for (let i = 0; i < 300; i++) hidden.push(cm.addMessage('user', [t(`hidden ${i}`)], { hidden: true }));
    cm.removeMessages(hidden[0]!, hidden[hidden.length - 1]!);
    await laterMessagesCompress(cm, s, 'numbers given later');
    await cm.close();
  });

  for (const [label, ids] of [
    ['ids of another form', (c: number) => [`ghost-${c}-a`, `ghost-${c}-b`]],
    ['record numbers it never assigned', (c: number) => [String(900000 + 2 * c), String(900001 + 2 * c)]],
  ] as const) {
    it(`chunk records naming ${label} still halt compression, and the debt report reads critical`, async () => {
      const path = freshPath();
      {
        const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
        const store = cm.getStore();
        for (let c = 0; c < 4; c++) {
          store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds: ids(c), compressed: true, summaryId: `L1-${c}` });
        }
        cm.sync();
        await cm.close();
      }
      const s = strategy();
      const cm = await ContextManager.open({ path, strategy: s, membrane });
      const later = add(cm, 40);
      for (let i = 0; i < 50; i++) await cm.tick();
      const covered = l1Sources(cm);
      assert.ok(!later.some((id) => covered.has(id)), 'no L1 forms');
      const debt = s.getCompressionDebt();
      assert.strictEqual(debt.state, 'critical');
      assert.strictEqual(debt.failure, 'chunk-records');
      assert.match(debt.error ?? '', /Cause:[\s\S]*Effect:[\s\S]*Fix:/);
      await cm.close();
    });
  }
});

describe('the debt report while the guard holds and the quarantine ledger cannot be read', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('says both in its error', async () => {
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
      const store = cm.getStore();
      for (let c = 0; c < 4; c++) store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds: [`ghost-${c}`], compressed: true, summaryId: `L1-${c}` });
      cm.sync();
      await cm.close();
    }
    const s = strategy();
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    const internals = s as unknown as {
      store: { getStateJson(id: string): unknown };
      compressionRefusalQuarantineLedgerStateId: string;
      compressionRefusalQuarantineStateId: string;
    };
    const ledger = new Set([internals.compressionRefusalQuarantineLedgerStateId, internals.compressionRefusalQuarantineStateId]);
    const read = internals.store.getStateJson.bind(internals.store);
    internals.store.getStateJson = (id: string) => {
      if (ledger.has(id)) throw new Error('EACCES: permission denied (test)');
      return read(id);
    };
    try {
      const debt = s.getCompressionDebt();
      assert.strictEqual(debt.state, 'critical');
      assert.strictEqual(debt.failure, 'chunk-records');
      assert.match(debt.error ?? '', /chunk records name message ids its store can't show it ever held/);
      assert.match(debt.error ?? '', /couldn't read this agent's compression quarantine ledger \(EACCES: permission denied \(test\)\)/);
      assert.strictEqual(debt.compressionQuarantineCount, null);
    } finally {
      internals.store.getStateJson = read;
      await cm.close();
    }
  });
});

describe('MessageStore.held', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('answers true for every id it appended, removed or not, and false for any other', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    const ids = add(cm, 8);
    cm.removeMessage(ids[1]!);
    cm.removeMessages(ids[2]!, ids[3]!);
    messageStoreOf(cm).removeBodyGroup(ids[4]!);
    const other = cm.getStore().appendToStateJson(CHUNKS, { id: 'c-x', sourceIds: [], compressed: false });
    let store = messageStoreOf(cm);
    for (const id of ids.slice(1, 5)) assert.strictEqual(store.get(id), null, `${id} is removed`);
    for (const id of ids) assert.strictEqual(store.held(id), true, `held ${id}`);
    assert.strictEqual(store.held(other.id), false, "another state's record");
    assert.strictEqual(store.held('900000'), false, 'a number it never assigned');
    assert.strictEqual(store.held('ghost-0-a'), false, 'an id of another form');

    cm.getStore().compactState(MessageStore.registrationFor().id);
    assert.strictEqual(store.held(ids[1]!), true, 'removed, after the messages state is compacted');
    await cm.close();

    cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    store = messageStoreOf(cm);
    assert.strictEqual(store.held(ids[1]!), true, 'removed, after a reopen');
    await cm.fork('held-fork');
    cm.removeMessage(ids[6]!);
    assert.strictEqual(messageStoreOf(cm).held(ids[6]!), true, 'removed on a fork');
    await cm.close();
  });

  it('a filtered view answers for messages it hides, and a merged view for every source', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    const [shown, hidden] = add(cm, 2);
    const filtered = filterMessageStoreView(messageStoreOf(cm).createView(), (m) => m.id !== hidden);
    assert.strictEqual(filtered.get(hidden!), null);
    assert.strictEqual(filtered.held?.(hidden!), true, 'hidden but held');
    assert.strictEqual(filtered.held?.(shown!), true);

    const aux = await ContextManager.open({ store: cm.getStore(), namespace: 'aux', strategy: new PassthroughStrategy(), isolate: true });
    const [auxId] = add(aux, 1);
    const merged = mergeMessageStoreViews(messageStoreOf(cm).createView(), [messageStoreOf(aux).createView()]);
    assert.strictEqual(merged.held?.(auxId!), true, "an auxiliary source's message");
    assert.strictEqual(merged.held?.(shown!), true, "the primary's");
    assert.strictEqual(merged.held?.('900000'), false);
    const { held: _, ...auxWithoutHeld } = messageStoreOf(aux).createView();
    assert.strictEqual(mergeMessageStoreViews(messageStoreOf(cm).createView(), [auxWithoutHeld]).held, undefined, 'a source that can\'t answer leaves the merged view without held');
    await aux.close();
    await cm.close();
  });
});
