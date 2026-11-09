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

const BASE = './test-chain-break-guard';
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


const halts = async (cm: ContextManager, s: AutobiographicalStrategy, label: string): Promise<void> => {
  const later = add(cm, 40);
  for (let i = 0; i < 50; i++) await cm.tick();
  const covered = l1Sources(cm);
  assert.ok(!later.some((id) => covered.has(id)), `${label}: no L1 forms`);
  const debt = s.getCompressionDebt();
  assert.strictEqual(debt.state, 'critical', `${label}: the debt report is critical`);
  assert.strictEqual(debt.failure, 'chunk-records', label);
  assert.match(debt.error ?? '', /^Compression of new conversation has stopped\.\nCause: most chunk records name no message in view, and the oldest or newest names one off this branch's messages chain/, `${label}: the off-chain cause`);
  assert.match(debt.error ?? '', /\nEffect: no chunk, waiting or new, is summarized; queued merges still run and can queue the next level\.\n/, `${label}: what waits`);
  assert.match(debt.error ?? '', /\nFix: change nothing until the emptied records' first messages, read by id, are compared with this chain; the FAIL-CLOSED log line gives each next step\.$/, `${label}: the fix's first step`);
};
const offBranch = (cm: ContextManager, ids: string[], label: string): void => {
  const store = messageStoreOf(cm);
  assert.ok(ids.length > 0, `${label}: setup has ids`);
  for (const id of ids) assert.strictEqual(store.onBranch(id), false, `${label}: ${id} is off this branch's chain`);
};

describe('a removal or a view filter no longer halts compression (#421)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('removing the messages of 5 of 8 chunk records, then adding 40, forms records and calls the summarizer, and a reopen does too', async () => {
    const path = freshPath();
    let s = strategy();
    let cm = await ContextManager.open({ path, strategy: s, membrane });
    await growTo(cm, 8);
    const removed = records(cm).slice(0, 5).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    assertGone(cm, removed);
    const before = records(cm).length;
    await laterMessagesCompress(cm, s, 'after the removal');
    assert.ok(records(cm).length > before, 'new chunk records form');
    await cm.close();
    s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane });
    const reopened = records(cm).length;
    await laterMessagesCompress(cm, s, 'reopened');
    assert.ok(records(cm).length > reopened, 'new chunk records form after a reopen');
    await cm.close();
  });

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

  it('removing the messages of 2 of 3 chunk records as a range leaves later messages compressing', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 3);
    const ids = records(cm).slice(0, 2).flatMap((r) => r.sourceIds);
    cm.removeMessages(ids[0]!, ids[ids.length - 1]!);
    assertGone(cm, ids);
    await laterMessagesCompress(cm, s, 'removeMessages');
    await cm.close();
  });

  it('a store reopened under a view filter hiding the messages of 5 of 8 chunk records compresses later messages, and showing them again leaves no message in two records or two L1s', async () => {
    const path = freshPath();
    let cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    await growTo(cm, 8);
    const hidden = new Set(records(cm).slice(0, 5).flatMap((r) => r.sourceIds));
    await cm.close();
    let s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane, viewFilter: (m: StoredMessage) => !hidden.has(m.id) });
    await laterMessagesCompress(cm, s, 'viewFilter');
    await cm.close();
    s = strategy();
    cm = await ContextManager.open({ path, strategy: s, membrane });
    await laterMessagesCompress(cm, s, 'shown again');
    const inRecords = records(cm).flatMap((r) => r.sourceIds);
    assert.strictEqual(new Set(inRecords).size, inRecords.length, 'no message is in two chunk records');
    const stored = cm.getStore().getStateJson(SUMS);
    const inL1s = (Array.isArray(stored) ? stored : []).filter((x) => x && x.level === 1).flatMap((x) => x.sourceIds ?? []);
    assert.strictEqual(new Set(inL1s).size, inL1s.length, 'no message is in two L1s');
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
});

describe('the chain-break guard still halts for a broken chain or a store rebuilt under new ids', () => {
  before(() => cleanup());
  after(() => cleanup());

  for (const [label, ids] of [
    ['ids of another form', (c: number) => [`ghost-${c}-a`, `ghost-${c}-b`]],
    ['record numbers it never assigned', (c: number) => [String(900000 + 2 * c), String(900001 + 2 * c)]],
  ] as const) {
    it(`chunk records naming ${label} halt chunk compression, and the debt report reads critical with the off-chain cause`, async () => {
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
      await halts(cm, s, label);
      await cm.close();
    });
  }

  // A model of a messages chain that restarted, as chronicle before 0.5.0 restarted one when its
  // state index was lost: the branch carries the strategy's states and not the messages, so the
  // branch's messages chain doesn't hold the records' messages. Stores broken that way under
  // chronicle 0.2.7 and 0.4.0, read under 0.6.0, gave those facts too; old releases don't run here.
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
    offBranch(cm, records(cm).flatMap((r) => r.sourceIds), 'restarted chain');
    for (const m of lived) cm.addMessage(m.participant, m.content);
    await halts(cm, s, 'restarted chain');
    await cm.close();
  });

  it('switching back from a branch whose chain restarted, to the chain its records were written against, compresses again in the same process', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 6);
    const main = cm.currentBranch().name;
    const store = cm.getStore();
    const messagesState = MessageStore.registrationFor().id;
    const carried = store.listStates().map((st) => st.id).filter((id) => id !== messagesState);
    store.createBranchWithStates('restarted-then-back', main, { stateIds: carried });
    await cm.switchBranch('restarted-then-back');
    await halts(cm, s, 'restarted');
    await cm.switchBranch(main);
    await laterMessagesCompress(cm, s, 'back on the chain the records were written against');
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
    offBranch(cm, records(cm).slice(0, 6).flatMap((r) => r.sourceIds), 'restarted, then removed');
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
});

describe('how the chain-break guard asks', () => {
  before(() => cleanup());
  after(() => cleanup());

  const counted = (cm: ContextManager): { calls: number } => {
    const store = messageStoreOf(cm);
    const onBranch = store.onBranch.bind(store);
    const count = { calls: 0 };
    store.onBranch = (id) => { count.calls++; return onBranch(id); };
    return count;
  };

  it('asks onBranch only past the threshold, of the two end records alone, and once each across later rebuilds', async () => {
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

  it('asks of each emptied record its first message', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const emptied = records(cm).slice(0, 3);
    for (const id of emptied.flatMap((r) => r.sourceIds)) cm.removeMessage(id);
    const store = messageStoreOf(cm);
    const onBranch = store.onBranch.bind(store);
    const asked: string[] = [];
    store.onBranch = (id) => { asked.push(id); return onBranch(id); };
    await laterMessagesCompress(cm, s, 'asked');
    assert.deepEqual(asked, [emptied[0]!.sourceIds[0], emptied[2]!.sourceIds[0]]);
    await cm.close();
  });

  it('a view without onBranch halts chunk compression once removals empty most records, and says the view is why', async (t) => {
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    const removed = records(cm).slice(0, 3).flatMap((r) => r.sourceIds);
    for (const id of removed) cm.removeMessage(id);
    const { onBranch: _, ...withoutOnBranch } = messageStoreOf(cm).createView();
    (s as unknown as { rebuildChunks(view: unknown): void }).rebuildChunks(withoutOnBranch);
    const debt = s.getCompressionDebt();
    assert.strictEqual(debt.state, 'critical');
    assert.strictEqual(debt.failure, 'chunk-records');
    assert.match(debt.error ?? '', /\nCause: most chunk records name no message in view, and the strategy reads the store through a view without `onBranch`/);
    assert.match(debt.error ?? '', /\nFix: give the strategy a view with `onBranch`, as MessageStore and the views built on it have; each rebuild checks again\.$/);
    const failClosed = spy.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('FAIL-CLOSED'));
    assert.strictEqual(failClosed.length, 1, failClosed.join('\n'));
    assert.match(failClosed[0]!, /3\/5 chunk records name no message in the view, and the strategy reads the store through a view without onBranch/);
    await cm.close();
  });

  for (const [end, at] of [['oldest', 0], ['newest', 2]] as const) {
    it(`a read that fails at the ${end} end halts this rebuild with its error as the cause, keeps no answer, and a later rebuild asks again`, async (t) => {
      const spy = mock.method(console, 'error', () => {});
      t.after(() => spy.mock.restore());
      const s = strategy();
      const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
      await growTo(cm, 5);
      const emptied = records(cm).slice(0, 3);
      for (const id of emptied.flatMap((r) => r.sourceIds)) cm.removeMessage(id);
      const store = messageStoreOf(cm);
      const onBranch = store.onBranch.bind(store);
      const failing = emptied[at]!.sourceIds[0]!;
      let fail = true;
      store.onBranch = (id) => {
        if (fail && id === failing) throw new Error('a read of the messages state failed (test)');
        return onBranch(id);
      };
      const later = add(cm, 40);
      for (let i = 0; i < 50; i++) await cm.tick();
      assert.ok(!later.some((id) => l1Sources(cm).has(id)), `while the ${end} end's read fails: no L1 forms`);
      const debt = s.getCompressionDebt();
      assert.strictEqual(debt.state, 'critical');
      assert.strictEqual(debt.failure, 'chunk-records');
      assert.match(debt.error ?? '', /\nCause: the store couldn't read its messages chain to check the chunk records that name no message in view \(a read of the messages state failed \(test\)\)\./);
      assert.match(debt.error ?? '', /\nFix: fix what the cause names; the next rebuild asks again\.$/);
      assert.doesNotMatch(debt.error ?? '', /chronicle before 0\.5\.0|onBranch|change nothing/, 'it names no broken chain or view');
      const failClosed = spy.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('FAIL-CLOSED'));
      assert.strictEqual(failClosed.length, 1, failClosed.join('\n'));
      assert.match(failClosed[0]!, /couldn't read its messages chain[^\n]*\(a read of the messages state failed \(test\)\)[^\n]*the next rebuild asks again/);
      fail = false;
      await laterMessagesCompress(cm, s, `once the ${end} end's read succeeds`);
      await cm.close();
    });
  }

  it('MessageStore.onBranch throws where its read of the record or of the chain fails', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: strategy(), membrane });
    const [kept, removed] = add(cm, 2);
    cm.removeMessage(removed!);
    const store = (messageStoreOf(cm) as unknown as { store: { getStateJsonAt(id: string, at: number): unknown; getRecord(id: string): unknown } }).store;
    const read = store.getStateJsonAt.bind(store);
    store.getStateJsonAt = () => { throw new Error('a read of the messages state failed (test)'); };
    assert.throws(() => messageStoreOf(cm).onBranch(removed!), /a read of the messages state failed \(test\)/);
    assert.strictEqual(messageStoreOf(cm).onBranch(kept!), true, 'a message in the listing needs no read');
    store.getStateJsonAt = read;
    const getRecord = store.getRecord.bind(store);
    store.getRecord = () => { throw new Error('a read of the record failed (test)'); };
    assert.throws(() => messageStoreOf(cm).onBranch(removed!), /a read of the record failed \(test\)/);
    store.getRecord = getRecord;
    await cm.close();
  });
});

describe('the debt report and the FAIL-CLOSED line while the guard holds', () => {
  before(() => cleanup());
  after(() => cleanup());

  const ghostStore = async (): Promise<string> => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    const store = cm.getStore();
    for (let c = 0; c < 4; c++) store.appendToStateJson(CHUNKS, { id: `c-${c}`, sourceIds: [`ghost-${c}`], compressed: true, summaryId: `L1-${c}` });
    cm.sync();
    await cm.close();
    return path;
  };

  it('each cause\'s report stays under 500 characters, where status notices and alert webhooks cut a message', () => {
    // The texts are module-private; read them through the debt report of a strategy whose latch is set.
    const s = strategy() as unknown as { chunkRecordsOrphaned: boolean; _orphanCause: unknown; getCompressionDebt(): { error?: string } };
    for (const cause of ['off-branch', 'no-on-branch', { chainUnread: new Error('x'.repeat(400)) }]) {
      s.chunkRecordsOrphaned = true;
      s._orphanCause = cause;
      const error = s.getCompressionDebt().error ?? '';
      assert.ok(error.length > 0 && error.length < 500, `${JSON.stringify(cause).slice(0, 40)}: ${error.length} characters`);
    }
  });

  it('the off-chain FAIL-CLOSED line gives every step, the default first changing nothing', async (t) => {
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const s = strategy();
    const cm = await ContextManager.open({ path: await ghostStore(), strategy: s, membrane });
    const failClosed = spy.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('FAIL-CLOSED'));
    assert.strictEqual(failClosed.length, 1, failClosed.join('\n'));
    const line = failClosed[0]!;
    assert.match(line, /4\/4 chunk records name no message in the view, and the oldest or newest of them names a message that isn't on this branch's messages chain/);
    assert.match(line, /branch the chronicle before any removal or re-key/);
    assert.match(line, /If that history isn't on this chain again, remove only the emptied chunk records and keep their summaries\./);
    assert.match(line, /If it is, under new ids, restore the chain the records were written against, or re-key/);
    assert.match(line, /If it's unclear, or the messages can't be read, change nothing: the store stays halted, which discards nothing\. ns=default$/);
    assert.ok(line.indexOf('compare') < line.indexOf('remove only'), 'the comparison comes before any removal');
    await cm.close();
  });

  it('with the quarantine ledger unreadable too, the report says both, the guard\'s first', async () => {
    const s = strategy();
    const cm = await ContextManager.open({ path: await ghostStore(), strategy: s, membrane });
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
      const [guard, ledgerError, ...rest] = (debt.error ?? '').split('\n\n');
      assert.match(guard!, /^Compression of new conversation has stopped\.\nCause: most chunk records name no message in view/);
      assert.match(ledgerError!, /couldn't read this agent's compression quarantine ledger \(EACCES: permission denied \(test\)\)/);
      assert.deepEqual(rest, []);
      assert.strictEqual(debt.compressionQuarantineCount, null);
    } finally {
      internals.store.getStateJson = read;
      await cm.close();
    }
  });
});

describe('MessageStore.onBranch and the views', () => {
  before(() => cleanup());
  after(() => cleanup());

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
    assert.strictEqual(store.onBranch(onFork!), false, "the fork's message, from main");
    assert.strictEqual(store.onBranch('900000'), false, 'a number it never assigned');
    assert.strictEqual(store.onBranch('ghost-0-a'), false, 'an id of another form');
    await cm.close();
  });

  it('a filtered view answers onBranch for messages it hides, a merged view for every source, and the window a manager presents as the view under it', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
    const [shown, hidden] = add(cm, 2);
    const filtered = filterMessageStoreView(messageStoreOf(cm).createView(), (m) => m.id !== hidden);
    assert.strictEqual(filtered.get(hidden!), null);
    assert.strictEqual(filtered.onBranch?.(hidden!), true, 'hidden but on the branch');
    assert.strictEqual(filtered.onBranch?.(shown!), true);

    const aux = await ContextManager.open({ store: cm.getStore(), namespace: 'aux', strategy: new PassthroughStrategy(), isolate: true });
    const [auxId] = add(aux, 1);
    const merged = mergeMessageStoreViews(messageStoreOf(cm).createView(), [messageStoreOf(aux).createView()]);
    assert.strictEqual(merged.onBranch?.(auxId!), true, "an auxiliary source's message, on its branch");
    assert.strictEqual(merged.onBranch?.(shown!), true, "the primary's, on its branch");
    assert.strictEqual(merged.onBranch?.('900000'), false);
    const { onBranch: _, ...auxWithoutOnBranch } = messageStoreOf(aux).createView();
    assert.strictEqual(mergeMessageStoreViews(messageStoreOf(cm).createView(), [auxWithoutOnBranch]).onBranch, undefined, 'a source that can\'t answer leaves the merged view without onBranch');
    await aux.close();

    cm.presentRows([]);
    cm.retractRows([hidden!]);
    const presented = (cm as unknown as { presentedMessageView(): { getAll(): StoredMessage[]; onBranch?(id: string): boolean } }).presentedMessageView();
    assert.deepEqual(presented.getAll().map((m) => m.id), [shown], 'setup: the window presents one row');
    assert.strictEqual(presented.onBranch?.(hidden!), true, 'the presented window passes it on for a row it doesn\'t hold');
    await cm.close();
  });
});
