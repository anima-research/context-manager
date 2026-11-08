import { describe, it, before, after, mock } from 'node:test';
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

  it('a store whose rows are presented, reopened under a view filter hiding the messages of 5 of 8 chunk records, compresses later messages', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    cm.presentRows([]);
    const presented = (count: number): string[] => {
      const ids = add(cm, count);
      for (const id of ids) cm.presentRows([id]);
      return ids;
    };
    for (let i = 0; i < 400 && records(cm).length < 8; i++) {
      presented(1);
      await cm.tick();
    }
    assert.strictEqual(records(cm).length, 8, 'grew to 8 chunk records');
    await drain(cm);
    const hidden = new Set(records(cm).slice(0, 5).flatMap((r) => r.sourceIds));
    await cm.close();
    const s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane, viewFilter: (m: StoredMessage) => !hidden.has(m.id) });
    assert.strictEqual(cm.windowMode(), 'presented', 'premise: the reopened window is presented');
    const later = presented(40);
    await drain(cm);
    const covered = l1Sources(cm);
    assert.ok(later.some((id) => covered.has(id)), 'an L1 covers messages added after it');
    assert.notStrictEqual(s.getCompressionDebt().state, 'critical', "the debt report isn't critical");
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
    it(`chunk records naming ${label} still halt chunk compression, and the debt report reads critical`, async () => {
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

describe('the chain-break guard when held messages empty most chunk records', () => {
  before(() => cleanup());
  after(() => cleanup());

  const halts = async (cm: ContextManager, s: AutobiographicalStrategy, label: string): Promise<void> => {
    const later = add(cm, 40);
    for (let i = 0; i < 50; i++) await cm.tick();
    const covered = l1Sources(cm);
    assert.ok(!later.some((id) => covered.has(id)), `${label}: no L1 forms`);
    const debt = s.getCompressionDebt();
    assert.strictEqual(debt.state, 'critical', `${label}: the debt report is critical`);
    assert.strictEqual(debt.failure, 'chunk-records', label);
    assert.match(debt.error ?? '', /chunk records name no message in its view, and the oldest or newest of those a removal or a filter emptied names messages its messages chain doesn't hold/, `${label}: the off-chain cause`);
  };
  const heldOffBranch = (cm: ContextManager, ids: string[], label: string): void => {
    const store = messageStoreOf(cm);
    assert.ok(ids.length > 0, `${label}: setup has ids`);
    for (const id of ids) {
      assert.strictEqual(store.held(id), true, `${label}: ${id} is held`);
      assert.strictEqual(store.onBranch(id), false, `${label}: ${id} is off this branch's chain`);
    }
  };

  // A model of a messages chain that restarted, as chronicle before 0.5.0 restarted one when its
  // state index was lost: the branch carries the strategy's states and not the messages, so the
  // records' ids read held and the branch's messages chain doesn't hold them. Stores broken that way
  // under chronicle 0.2.7 and 0.4.0, read under 0.6.0, gave those facts too; old releases don't run here.
  it('a branch whose messages chain restarted, with its chunk records carried and the same content appended again, halts chunk compression', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 6);
    const lived = cm.getAllMessages().map((m) => ({ participant: m.participant, content: m.content }));
    const store = cm.getStore();
    const messagesState = MessageStore.registrationFor().id;
    const carried = store.listStates().map((st) => st.id).filter((id) => id !== messagesState);
    store.createBranchWithStates('restarted', cm.currentBranch().name, { stateIds: carried });
    await cm.switchBranch('restarted');
    assert.strictEqual(cm.getAllMessages().length, 0, 'setup: the branch holds no messages');
    assert.strictEqual(records(cm).length, 6, 'setup: the branch carries the chunk records');
    heldOffBranch(cm, records(cm).flatMap((r) => r.sourceIds), 'restarted chain');
    for (const m of lived) cm.addMessage(m.participant, m.content);
    await halts(cm, s, 'restarted chain');
    await cm.close();
  });

  it('a branch whose messages chain restarted halts chunk compression though a removal emptied its newest record', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    await growTo(cm, 6);
    const store = cm.getStore();
    const messagesState = MessageStore.registrationFor().id;
    const carried = store.listStates().map((st) => st.id).filter((id) => id !== messagesState);
    store.createBranchWithStates('restarted-then-removed', cm.currentBranch().name, { stateIds: carried });
    await cm.close();
    {
      // as a release before the guard would have: records formed on the new chain, then a removal
      const writer = await ContextManager.open({ path, strategy: new PassthroughStrategy(), membrane });
      await writer.switchBranch('restarted-then-removed');
      const fresh = add(writer, 6);
      const chunks = writer.getStore();
      chunks.appendToStateJson(CHUNKS, { id: 'new-0', sourceIds: fresh.slice(0, 3), compressed: true, summaryId: 'L1-new-0' });
      chunks.appendToStateJson(CHUNKS, { id: 'new-1', sourceIds: fresh.slice(3), compressed: true, summaryId: 'L1-new-1' });
      for (const id of fresh.slice(3)) writer.removeMessage(id);
      writer.sync();
      await writer.close();
    }
    const s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane });
    await cm.switchBranch('restarted-then-removed');
    assert.strictEqual(records(cm).length, 8, 'setup: 6 carried records and 2 on the new chain');
    assert.strictEqual(cm.getAllMessages().length, 3, "setup: the new chain holds only new-0's messages");
    heldOffBranch(cm, records(cm).slice(0, 6).flatMap((r) => r.sourceIds), 'restarted, then removed');
    await halts(cm, s, 'restarted, then removed');
    await cm.close();
  });

  it('the newest emptied records naming messages a sibling branch wrote halt chunk compression, though removals emptied the oldest', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    await growTo(cm, 4);
    const main = cm.currentBranch().name;
    await cm.fork('sibling-writes');
    const sibling = add(cm, 9);
    await cm.switchBranch(main);
    const removed = records(cm).slice(0, 2).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    await cm.close();
    {
      // written with no autobiographical strategy open, so nothing holds the records in memory
      const writer = await ContextManager.open({ path, strategy: new PassthroughStrategy(), membrane });
      const store = writer.getStore();
      for (let c = 0; c < 3; c++) {
        store.appendToStateJson(CHUNKS, { id: `sib-${c}`, sourceIds: sibling.slice(3 * c, 3 * c + 3), compressed: true, summaryId: `L1-sib-${c}` });
      }
      writer.sync();
      await writer.close();
    }
    const s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane });
    assert.strictEqual(cm.currentBranch().name, main);
    assertGone(cm, removed);
    await halts(cm, s, 'newest end');
    await cm.close();
  });

  it('a fork whose removals empty 3 of 5 chunk records keeps compressing', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    await cm.fork('trimmed');
    const removed = records(cm).slice(0, 3).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    assertGone(cm, removed);
    await laterMessagesCompress(cm, s, 'fork');
    await cm.close();
  });

  it('chunk records a sibling branch made stay on the sibling: switching back, the branch names none of its messages and keeps compressing', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 3);
    const main = cm.currentBranch().name;
    await cm.fork('sibling-chunks');
    await growTo(cm, 6);
    const siblingIds = new Set(records(cm).slice(3).flatMap((r) => r.sourceIds));
    await cm.switchBranch(main);
    assert.strictEqual(records(cm).length, 3);
    assert.ok(records(cm).every((r) => r.sourceIds.every((id) => !siblingIds.has(id))), "the branch's records name no message the sibling wrote");
    await laterMessagesCompress(cm, s, 'switched back');
    await cm.close();
  });

  it('asks onBranch only past the threshold, of the two end records alone, and once each across later rebuilds', async () => {
    const counted = (cm: ContextManager): { calls: number } => {
      const store = messageStoreOf(cm);
      const onBranch = store.onBranch.bind(store);
      const count = { calls: 0 };
      store.onBranch = (id) => { count.calls++; return onBranch(id); };
      return count;
    };

    const belowStrategy = strategy();
    const below = await ContextManager.open({ path: freshPath(), strategy: belowStrategy, membrane });
    await growTo(below, 4);
    const belowCount = counted(below);
    for (const id of records(below).slice(0, 2).flatMap((r) => r.sourceIds)) below.removeMessage(id);
    await laterMessagesCompress(below, belowStrategy, 'exactly half');
    assert.strictEqual(belowCount.calls, 0, '2 of 4 records emptied, exactly half: no call');
    await below.close();

    const s = strategy();
    const past = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(past, 5);
    const pastCount = counted(past);
    for (const id of records(past).slice(0, 3).flatMap((r) => r.sourceIds)) past.removeMessage(id);
    await laterMessagesCompress(past, s, 'counted');
    assert.strictEqual(pastCount.calls, 2, '3 of 5 records emptied, on the branch: the oldest and newest, once each');
    await past.close();
  });

  it('a view with held and without onBranch halts chunk compression once removals empty most records', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const removed = records(cm).slice(0, 3).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    const { onBranch: _, ...withoutOnBranch } = messageStoreOf(cm).createView();
    assert.strictEqual(typeof withoutOnBranch.held, 'function', 'setup: the view has held');
    (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(withoutOnBranch);
    assert.strictEqual(s.getCompressionDebt().state, 'critical');
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records');
    assert.match(s.getCompressionDebt().error ?? '', /\nFix: [^\n]*give the strategy a view with `onBranch`/, 'its fix names the view');
    await cm.close();
  });

  it('a read of the chain that fails halts the rebuild with its error as the cause, keeps no answer, and a later rebuild asks again', async (t) => {
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const store = (messageStoreOf(cm) as unknown as { store: { getStateJsonAt(id: string, at: number): unknown; getRecord(id: string): unknown; getStateUpdateJson(id: string): string | null } }).store;
    const messagesState = MessageStore.registrationFor().id;
    const read = store.getStateJsonAt.bind(store);
    let failing = true;
    store.getStateJsonAt = (id, at) => {
      if (failing && id === messagesState) throw new Error('a read of the messages state failed (test)');
      return read(id, at);
    };
    const removed = records(cm).slice(0, 3).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    assert.throws(() => messageStoreOf(cm).onBranch(removed[0]!), /a read of the messages state failed \(test\)/, 'onBranch throws when its read fails');
    const getRecord = store.getRecord.bind(store);
    store.getRecord = () => { throw new Error('a read of the record failed (test)'); };
    assert.throws(() => messageStoreOf(cm).onBranch(removed[0]!), /a read of the record failed \(test\)/, 'onBranch throws when its read of the record fails');
    store.getRecord = getRecord;

    const later = add(cm, 40);
    for (let i = 0; i < 50; i++) await cm.tick();
    assert.ok(!later.some((id) => l1Sources(cm).has(id)), 'while the read fails: no L1 forms');
    const debt = s.getCompressionDebt();
    assert.strictEqual(debt.state, 'critical', 'while the read fails: the debt report is critical');
    assert.strictEqual(debt.failure, 'chunk-records');
    assert.match(debt.error ?? '', /\nCause: the store couldn't read its messages chain to check the chunk records that name no message in its view \(a read of the messages state failed \(test\)\)\./, 'the cause is the read and its error');
    assert.match(debt.error ?? '', /\nFix: fix what the cause names; the next rebuild asks again\.$/, 'its fix');
    assert.doesNotMatch(debt.error ?? '', /chronicle before 0\.5\.0|onBranch|remove the records|reconcile/, 'it names no broken chain, view or removal');
    const failClosed = spy.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('FAIL-CLOSED'));
    assert.strictEqual(failClosed.length, 1, failClosed.join('\n'));
    assert.match(failClosed[0]!, /couldn't read its messages chain[^\n]*\(a read of the messages state failed \(test\)\)[^\n]*the next rebuild asks again/);
    assert.doesNotMatch(failClosed[0]!, /chronicle before 0\.5\.0|onBranch|into line/);

    const { onBranch: _, ...withoutOnBranch } = messageStoreOf(cm).createView();
    (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(withoutOnBranch);
    const trips = spy.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('FAIL-CLOSED'));
    assert.strictEqual(trips.length, 2, 'a trip on the off-chain cause after the failed read still logs');
    assert.match(trips[1]!, /a view with held and without onBranch/);

    // the records' held answers are kept and their ends' aren't, so held is asked again of the ends alone
    const readAppend = store.getStateUpdateJson.bind(store);
    store.getStateUpdateJson = () => { throw new Error('a read of the append record failed (test)'); };
    assert.doesNotThrow(() => (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(messageStoreOf(cm).createView()), 'a failed held read of an end leaves the rebuild going');
    assert.match(s.getCompressionDebt().error ?? '', /\(a read of the append record failed \(test\)\)/, 'its cause is that read');
    store.getStateUpdateJson = readAppend;

    failing = false;
    await laterMessagesCompress(cm, s, 'once the read succeeds');
    await cm.close();
  });

  it('a read of a removed message\'s append record that fails halts the rebuild with its error as the cause, keeps no answer, and a later rebuild asks again', async (t) => {
    mock.method(console, 'error', () => {});
    t.after(() => mock.restoreAll());
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const removed = records(cm).slice(0, 3).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    const store = (messageStoreOf(cm) as unknown as { store: { getStateUpdateJson(id: string): string | null } }).store;
    const read = store.getStateUpdateJson.bind(store);
    let failing = true;
    store.getStateUpdateJson = (id) => {
      if (failing) throw new Error('a read of the append record failed (test)');
      return read(id);
    };
    assert.throws(() => messageStoreOf(cm).held(removed[0]!), /a read of the append record failed \(test\)/, 'held throws when its read fails');
    assert.strictEqual(messageStoreOf(cm).held('ghost-0-a'), false, "an id that isn't a record id answers no without a read");

    const later = add(cm, 40);
    for (let i = 0; i < 50; i++) await cm.tick();
    assert.ok(!later.some((id) => l1Sources(cm).has(id)), 'while the read fails: no L1 forms');
    const debt = s.getCompressionDebt();
    assert.strictEqual(debt.state, 'critical', 'while the read fails: the debt report is critical');
    assert.strictEqual(debt.failure, 'chunk-records');
    assert.match(debt.error ?? '', /\nCause: the store couldn't read its messages chain to check the chunk records that name no message in its view \(a read of the append record failed \(test\)\)\./, 'the cause is the read and its error');
    assert.doesNotMatch(debt.error ?? '', /can't show it ever held|reconcile|chronicle before 0\.5\.0/, 'it names no renumbered store or broken chain');

    failing = false;
    await laterMessagesCompress(cm, s, 'once the read succeeds');
    await cm.close();
  });

  it('a read that fails for the one emptied record of 5 leaves later messages compressing', async (t) => {
    mock.method(console, 'error', () => {});
    t.after(() => mock.restoreAll());
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    for (const id of records(cm)[0]!.sourceIds) cm.removeMessage(id);
    const store = (messageStoreOf(cm) as unknown as { store: { getStateUpdateJson(id: string): string | null } }).store;
    store.getStateUpdateJson = () => { throw new Error('a read of the append record failed (test)'); };
    await laterMessagesCompress(cm, s, 'one unread record of 5');
    await cm.close();
  });

  const failReadsOf = (cm: ContextManager, ids: readonly string[]): void => {
    const store = (messageStoreOf(cm) as unknown as { store: { getStateUpdateJson(id: string): string | null } }).store;
    const read = store.getStateUpdateJson.bind(store);
    const failing = new Set(ids);
    store.getStateUpdateJson = (id) => {
      if (failing.has(id)) throw new Error('a read of the append record failed (test)');
      return read(id);
    };
  };

  it('a record whose read fails between readable ends of the emptied records leaves later messages compressing', async (t) => {
    mock.method(console, 'error', () => {});
    t.after(() => mock.restoreAll());
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const emptied = records(cm).slice(0, 4);
    for (const id of emptied.flatMap((r) => r.sourceIds)) cm.removeMessage(id);
    failReadsOf(cm, emptied[1]!.sourceIds);
    await laterMessagesCompress(cm, s, 'unread between the ends');
    await cm.close();
  });

  for (const [end, at] of [['newest', 3], ['oldest', 0]] as const) {
    it(`a record whose read fails at the ${end} end of the emptied records halts the rebuild with its error as the cause, and a later rebuild asks again`, async (t) => {
      mock.method(console, 'error', () => {});
      t.after(() => mock.restoreAll());
      const s = strategy();
      const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
      await growTo(cm, 5);
      const emptied = records(cm).slice(0, 4);
      for (const id of emptied.flatMap((r) => r.sourceIds)) cm.removeMessage(id);
      const store = (messageStoreOf(cm) as unknown as { store: { getStateUpdateJson(id: string): string | null } }).store;
      const read = store.getStateUpdateJson.bind(store);
      failReadsOf(cm, emptied[at]!.sourceIds);
      const later = add(cm, 40);
      for (let i = 0; i < 50; i++) await cm.tick();
      assert.ok(!later.some((id) => l1Sources(cm).has(id)), `while the ${end} end's read fails: no L1 forms`);
      assert.match(s.getCompressionDebt().error ?? '', /\nCause: the store couldn't read its messages chain to check the chunk records that name no message in its view \(a read of the append record failed \(test\)\)\./, 'the cause is the read and its error');
      store.getStateUpdateJson = read;
      await laterMessagesCompress(cm, s, `once the ${end} end's read succeeds`);
      await cm.close();
    });
  }

  it('a record whose read fails, where it could make a never-held majority, halts the rebuild with its error as the cause', async (t) => {
    mock.method(console, 'error', () => {});
    t.after(() => mock.restoreAll());
    const path = freshPath();
    {
      const writer = await ContextManager.open({ path, strategy: new PassthroughStrategy(), membrane });
      const ids = add(writer, 2);
      for (const id of ids) writer.removeMessage(id);
      const store = writer.getStore();
      // emptied, unread (a record number never assigned), never held, never held, emptied
      const sources = [[ids[0]!], ['900000'], ['ghost-2'], ['ghost-3'], [ids[1]!]];
      sources.forEach((sourceIds, c) => store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds, compressed: true, summaryId: `L1-${c}` }));
      writer.sync();
      await writer.close();
    }
    const s = strategy();
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    assert.match(s.getCompressionDebt().error ?? '', /can't show it ever held/, 'setup: read, 3 of 5 records are never held');
    const store = cm.getStore() as unknown as { getRecord(id: string): unknown };
    const getRecord = store.getRecord.bind(store);
    store.getRecord = (id: string) => {
      if (id === '900000') throw new Error('a read of the record failed (test)');
      return getRecord(id);
    };
    (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(messageStoreOf(cm).createView());
    assert.match(s.getCompressionDebt().error ?? '', /\nCause: the store couldn't read its messages chain to check the chunk records that name no message in its view \(a read of the record failed \(test\)\)\./, 'unread, it could be the third never-held record of 5');
    await cm.close();
  });

  it('a read that fails for a record number chunk records name halts the rebuild with its error as the cause, not as never held', async (t) => {
    mock.method(console, 'error', () => {});
    t.after(() => mock.restoreAll());
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
      const store = cm.getStore();
      for (let c = 0; c < 4; c++) {
        store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds: [String(900000 + 2 * c), String(900001 + 2 * c)], compressed: true, summaryId: `L1-${c}` });
      }
      cm.sync();
      await cm.close();
    }
    const s = strategy();
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    assert.match(s.getCompressionDebt().error ?? '', /can't show it ever held/, 'setup: the guard holds on numbers never assigned');
    const store = cm.getStore() as unknown as { getRecord(id: string): unknown };
    const getRecord = store.getRecord.bind(store);
    store.getRecord = () => { throw new Error('a read of the record failed (test)'); };
    (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(messageStoreOf(cm).createView());
    assert.match(s.getCompressionDebt().error ?? '', /\nCause: the store couldn't read its messages chain to check the chunk records that name no message in its view \(a read of the record failed \(test\)\)\./, 'the cause is the read and its error');
    store.getRecord = getRecord;
    (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(messageStoreOf(cm).createView());
    assert.match(s.getCompressionDebt().error ?? '', /can't show it ever held/, 'once the read succeeds, the numbers read never held again');
    await cm.close();
  });
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

  it('answers true for an id appended only on another branch', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    add(cm, 2);
    const main = cm.currentBranch().name;
    await cm.fork('held-other');
    const [onFork] = add(cm, 1);
    await cm.switchBranch(main);
    const store = messageStoreOf(cm);
    assert.strictEqual(store.get(onFork!), null, 'setup: the message isn\'t on this branch');
    assert.strictEqual(store.held(onFork!), true);
    await cm.close();
  });

  it('onBranch answers true for an id on this branch, removed or inherited through a fork, and false for one another branch wrote after the fork or one it never held', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    const ids = add(cm, 4);
    cm.removeMessage(ids[1]!);
    const main = cm.currentBranch().name;
    await cm.fork('on-branch-fork');
    cm.removeMessage(ids[2]!);
    const [onFork] = add(cm, 1);
    let store = messageStoreOf(cm);
    for (const id of [...ids, onFork!]) assert.strictEqual(store.onBranch(id), true, `on the fork: ${id}`);
    await cm.switchBranch(main);
    store = messageStoreOf(cm);
    for (const id of ids) assert.strictEqual(store.onBranch(id), true, `on main: ${id}`);
    assert.strictEqual(store.held(onFork!), true, 'setup: the fork\'s message is held');
    assert.strictEqual(store.onBranch(onFork!), false, "the fork's message, from main");
    assert.strictEqual(store.onBranch('900000'), false, 'a number it never assigned');
    assert.strictEqual(store.onBranch('ghost-0-a'), false, 'an id of another form');
    await cm.close();
  });

  it('a filtered view answers held and onBranch for messages it hides, and a merged view for every source', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    const [shown, hidden] = add(cm, 2);
    const filtered = filterMessageStoreView(messageStoreOf(cm).createView(), (m) => m.id !== hidden);
    assert.strictEqual(filtered.get(hidden!), null);
    assert.strictEqual(filtered.held?.(hidden!), true, 'hidden but held');
    assert.strictEqual(filtered.held?.(shown!), true);
    assert.strictEqual(filtered.onBranch?.(hidden!), true, 'hidden but on the branch');

    const aux = await ContextManager.open({ store: cm.getStore(), namespace: 'aux', strategy: new PassthroughStrategy(), isolate: true });
    const [auxId] = add(aux, 1);
    const merged = mergeMessageStoreViews(messageStoreOf(cm).createView(), [messageStoreOf(aux).createView()]);
    assert.strictEqual(merged.held?.(auxId!), true, "an auxiliary source's message");
    assert.strictEqual(merged.held?.(shown!), true, "the primary's");
    assert.strictEqual(merged.held?.('900000'), false);
    assert.strictEqual(merged.onBranch?.(auxId!), true, "an auxiliary source's message, on its branch");
    assert.strictEqual(merged.onBranch?.(shown!), true, "the primary's, on its branch");
    assert.strictEqual(merged.onBranch?.('900000'), false);
    const { held: _, ...auxWithoutHeld } = messageStoreOf(aux).createView();
    assert.strictEqual(mergeMessageStoreViews(messageStoreOf(cm).createView(), [auxWithoutHeld]).held, undefined, 'a source that can\'t answer leaves the merged view without held');
    const { onBranch: __, ...auxWithoutOnBranch } = messageStoreOf(aux).createView();
    assert.strictEqual(mergeMessageStoreViews(messageStoreOf(cm).createView(), [auxWithoutOnBranch]).onBranch, undefined, 'a source that can\'t answer leaves the merged view without onBranch');
    await aux.close();
    await cm.close();
  });
});
