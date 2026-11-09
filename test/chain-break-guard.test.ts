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

const config = {
  compressionModel: 'test-compression-model',
  targetChunkTokens: 100,
  summaryTargetTokens: 20,
  headWindowTokens: 0,
  recentWindowTokens: 300,
  l1HoldbackChunks: 0,
  autoTickOnNewMessage: false,
};
const strategy = () => new AutobiographicalStrategy(config);

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
  assert.match(debt.error ?? '', /\nEffect: no chunk is sent to be summarized; queued merges still run and can queue the next level\.\n/, `${label}: what waits`);
  assert.match(debt.error ?? '', /\nFix: change nothing until the emptied records' messages, read by id, are compared with this chain; the FAIL-CLOSED log line gives each next step\.$/, `${label}: the fix's first step`);
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
  // branch's messages chain doesn't hold the records' messages.
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
      // records formed on the new chain, then a removal
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

// The guard holds chunks, not merges: a merge combines summaries that already exist.
class MergeQueueing extends AutobiographicalStrategy {
  queueMergeOf(sourceIds: string[]): void {
    this.enqueueMerge({ level: 2, sourceIds });
  }
  queuedLevels(): number[] {
    return this.mergeQueue.map((merge) => merge.level);
  }
}

describe('merges while the chain-break guard holds', () => {
  before(() => cleanup());
  after(() => cleanup());
  const queueing = (mergeThreshold: number, extra: Record<string, unknown> = {}) => new MergeQueueing({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 100,
    summaryTargetTokens: 20,
    headWindowTokens: 0,
    recentWindowTokens: 300,
    l1HoldbackChunks: 0,
    autoTickOnNewMessage: false,
    mergeThreshold,
    ...extra,
  });

  it('merges queued before the guard tripped, and persisted, run at tick, and the one that lands last queues the next level', async () => {
    const path = freshPath();
    {
      // No merge queues by itself here: the two are queued by hand.
      const s = queueing(99);
      const cm = await ContextManager.open({ path, strategy: s, membrane });
      await growTo(cm, 4);
      const l1s = cm.getSummariesInRange({ level: 1 }).map((summary) => summary.id);
      assert.strictEqual(l1s.length, 4, 'setup: four L1s to merge');
      s.queueMergeOf(l1s.slice(0, 2));
      s.queueMergeOf(l1s.slice(2, 4));
      assert.deepStrictEqual(s.queuedLevels(), [2, 2], 'setup: two merges are queued');
      const store = cm.getStore();
      for (let c = 0; c < 6; c++) {
        store.appendToStateJson(CHUNKS, { id: `ghost-c-${c}`, sourceIds: [`ghost-${c}`], compressed: true, summaryId: `L1-ghost-${c}` });
      }
      cm.sync();
      await cm.close();
    }
    // Two L2s reach this threshold, so the merge that lands second queues an L3.
    const s = queueing(2);
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'setup: the guard holds');
    assert.deepStrictEqual(s.queuedLevels(), [2, 2], 'setup: the persisted merges are queued, and the open queued none');
    await cm.tick();
    assert.strictEqual(cm.getSummariesInRange({ level: 2 }).length, 1, 'the first queued merge ran');
    await cm.tick();
    assert.strictEqual(cm.getSummariesInRange({ level: 2 }).length, 2, 'the second queued merge ran');
    assert.deepStrictEqual(s.queuedLevels(), [3], 'the merge that landed queued the next level');
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'the guard still holds');
    await cm.close();
  });

  // A store whose guard held at open, its chain read failing, with the merge
  // check the open skipped owed: six L1s, the two whose messages remain a run
  // at this threshold. `added` messages arrive once the read succeeds.
  const clearedAfterOpen = async (t: { after(fn: () => void): void }, added: number, extra: Record<string, unknown> = {}) => {
    const path = freshPath();
    {
      const s = queueing(99);
      const cm = await ContextManager.open({ path, strategy: s, membrane });
      await growTo(cm, 6);
      assert.strictEqual(cm.getSummariesInRange({ level: 1 }).length, 6, 'setup: six L1s');
      for (const id of records(cm).slice(0, 4).flatMap((r) => r.sourceIds)) cm.removeMessage(id);
      await cm.close();
    }
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const onBranch = MessageStore.prototype.onBranch;
    let fail = true;
    const failing = mock.method(MessageStore.prototype, 'onBranch', function (this: MessageStore, id: string) {
      if (fail) throw new Error('a read of the messages state failed (test)');
      return onBranch.call(this, id);
    });
    t.after(() => failing.mock.restore());
    const s = queueing(2, extra);
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'setup: the guard holds at open, its read failing');
    assert.deepStrictEqual(s.queuedLevels(), [], 'setup: the open queued no merge');
    fail = false;
    add(cm, added);
    assert.notStrictEqual(s.getCompressionDebt().failure, 'chunk-records', 'setup: the guard cleared');
    return { cm, s };
  };

  it('the open\'s merge check, which waited while the guard held, runs at the first tick after it clears', async (t) => {
    const { cm, s } = await clearedAfterOpen(t, 1);
    assert.strictEqual(records(cm).length, 6, 'setup: no chunk closed');
    await cm.tick();
    assert.ok(
      s.queuedLevels().includes(2) || cm.getSummariesInRange({ level: 2 }).length > 0,
      `a level-2 merge is queued or ran (queued ${JSON.stringify(s.queuedLevels())})`,
    );
    await cm.close();
  });

  const owedOf = (s: AutobiographicalStrategy) => () => (s as unknown as { _mergeCheckOwed: boolean })._mergeCheckOwed;
  const merging = (cm: ContextManager, s: MergeQueueing) => s.queuedLevels().includes(2) || cm.getSummariesInRange({ level: 2 }).length > 0;
  type Hooked = Record<string, (...args: unknown[]) => unknown>;
  const proto = AutobiographicalStrategy.prototype as unknown as Hooked;

  it('a tick that sends a chunk runs the owed merge checks before it', async (t) => {
    // The quarantine alarm off, so only the owed checks sweep in this tick.
    const { cm, s } = await clearedAfterOpen(t, 30, { quarantineAlarmIntervalMs: 0 });
    assert.ok(records(cm).length > 6, 'setup: chunks closed, so the tick sends one');
    const owed = owedOf(s);
    assert.strictEqual(owed(), true, 'setup: the checks are owed');
    const order: string[] = [];
    const sweep = proto.sweepPaidOffMergeQuarantine!;
    const check = proto.checkMergeThreshold!;
    const complete = membrane.complete;
    const sweeping = mock.method(s as unknown as Hooked, 'sweepPaidOffMergeQuarantine', function (this: unknown, ...args: unknown[]) {
      order.push('sweep');
      return sweep.apply(this, args);
    });
    const checking = mock.method(s as unknown as Hooked, 'checkMergeThreshold', function (this: unknown, ...args: unknown[]) {
      order.push('check');
      return check.apply(this, args);
    });
    const sending = mock.method(membrane as Hooked, 'complete', async (...args: unknown[]) => {
      order.push('send');
      return complete(...args);
    });
    t.after(() => { sweeping.mock.restore(); checking.mock.restore(); sending.mock.restore(); });
    await cm.tick();
    assert.strictEqual(owed(), false, 'the first tick ran them');
    const sent = order.indexOf('send');
    assert.ok(sent >= 0, `the tick sent a chunk (${order.join(' ')})`);
    assert.ok(order.indexOf('sweep') >= 0 && order.indexOf('sweep') < sent, `the sweep ran before the chunk went (${order.join(' ')})`);
    assert.ok(order.indexOf('check') >= 0 && order.indexOf('check') < sent, `the merge check ran before the chunk went (${order.join(' ')})`);
    await cm.close();
  });

  it('owed merge checks that throw stay owed, and the next tick runs them', async (t) => {
    const { cm, s } = await clearedAfterOpen(t, 1, { quarantineAlarmIntervalMs: 0 });
    const owed = owedOf(s);
    assert.strictEqual(owed(), true, 'setup: the checks are owed');
    const sweep = proto.sweepPaidOffMergeQuarantine!;
    let fail = true;
    const sweeping = mock.method(s as unknown as Hooked, 'sweepPaidOffMergeQuarantine', function (this: unknown, ...args: unknown[]) {
      if (fail) { fail = false; throw new Error('a write of the merge quarantine failed (test)'); }
      return sweep.apply(this, args);
    });
    t.after(() => sweeping.mock.restore());
    await assert.rejects(cm.tick(), /a write of the merge quarantine failed \(test\)/);
    assert.strictEqual(owed(), true, 'the checks are still owed after the tick that threw');
    await cm.tick();
    assert.strictEqual(owed(), false, 'the next tick ran them');
    assert.ok(merging(cm, s), `a level-2 merge is queued or ran (queued ${JSON.stringify(s.queuedLevels())})`);
    await cm.close();
  });

  it('with autoTickOnNewMessage, the background drain runs the owed merge checks with no chunk queued', async (t) => {
    // The message that clears the guard stays in the recent window, so no chunk is queued.
    const { cm, s } = await clearedAfterOpen(t, 1, { autoTickOnNewMessage: true });
    for (let i = 0; i < 200 && !merging(cm, s); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(merging(cm, s), `a level-2 merge is queued or ran with no tick called (queued ${JSON.stringify(s.queuedLevels())})`);
    assert.strictEqual(owedOf(s)(), false, 'the checks ran');
    const pending = () => (s as unknown as { pendingCompression: unknown }).pendingCompression;
    for (let i = 0; i < 200 && pending(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await cm.close();
  });

  it('with chunks queued when the guard clears and a preflight that forbids compression, the background drain sends nothing and the checks stay owed', async (t) => {
    class NoPreflight extends MergeQueueing {
      protected override shouldCompressPreflight(): boolean { return false; }
    }
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: queueing(99), membrane });
      await growTo(cm, 6);
      for (const id of records(cm).slice(0, 4).flatMap((r) => r.sourceIds)) cm.removeMessage(id);
      await cm.close();
    }
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const onBranch = MessageStore.prototype.onBranch;
    let fail = true;
    const failing = mock.method(MessageStore.prototype, 'onBranch', function (this: MessageStore, id: string) {
      if (fail) throw new Error('a read of the messages state failed (test)');
      return onBranch.call(this, id);
    });
    t.after(() => failing.mock.restore());
    const s = new NoPreflight({
      compressionModel: 'test-compression-model', targetChunkTokens: 100, summaryTargetTokens: 20,
      headWindowTokens: 0, recentWindowTokens: 300, l1HoldbackChunks: 0,
      autoTickOnNewMessage: true, mergeThreshold: 2, quarantineAlarmIntervalMs: 0,
    });
    const cm = await ContextManager.open({ path, strategy: s, membrane });
    const flush = async () => { for (let i = 0; i < 300; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
    const queue = () => (s as unknown as { compressionQueue: unknown[] }).compressionQueue.length;
    add(cm, 30);
    await flush();
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'setup: the guard holds while the read fails');
    let sends = 0;
    const complete = membrane.complete;
    const sending = mock.method(membrane as Record<string, (...a: unknown[]) => unknown>, 'complete', async (...args: unknown[]) => { sends++; return complete(...args); });
    t.after(() => sending.mock.restore());
    fail = false;
    add(cm, 1);
    const queued = queue();
    assert.strictEqual(s.getCompressionDebt().failure, undefined, 'setup: the guard cleared');
    assert.ok(queued > 0, 'setup: chunks are queued');
    assert.strictEqual(owedOf(s)(), true, 'setup: the checks are owed');
    assert.deepStrictEqual(s.queuedLevels(), [], 'setup: no merge is queued');
    await flush();
    assert.strictEqual(sends, 0, 'the drain sends nothing against the preflight');
    assert.strictEqual(queue(), queued, 'the queued chunks stay queued');
    assert.strictEqual(owedOf(s)(), true, 'the checks stay owed for the next tick that can send a chunk');
    await cm.close();
  });
});

class Demanding extends AutobiographicalStrategy {
  demand(first: string, last: string): void {
    this.enqueueL1ForRange(first, last);
  }
  /** A chunk whose L1 hasn't landed, by its first and last message. */
  waitingChunk(): { first: string; last: string } | undefined {
    const chunk = this.chunks.find((c) => !c.compressed && c.messages.length > 0);
    return chunk && { first: chunk.messages[0]!.id, last: chunk.messages.at(-1)!.id };
  }
  queued(): number {
    return this.compressionQueue.length;
  }
}

describe('chunks while the chain-break guard holds', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('a chunk demanded while the guard holds isn\'t queued or sent, and the manager stays ready', async (t) => {
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
      await growTo(cm, 4);
      add(cm, 30);
      assert.ok(records(cm).some((r) => !(r as { compressed?: boolean }).compressed), 'setup: chunk records whose L1 hasn\'t landed');
      // Records naming no message in the store, after the real ones: off the chain, so the guard holds at the next open.
      const store = cm.getStore();
      for (let c = 0; c < 20; c++) {
        store.appendToStateJson(CHUNKS, { id: `ghost-w-${c}`, sourceIds: [`ghost-w-${c}`], compressed: true, summaryId: `L1-ghost-w-${c}` });
      }
      cm.sync();
      await cm.close();
    }
    let sent = 0;
    const counting = { complete: async (...args: unknown[]) => { sent++; return membrane.complete(...args); } };
    const s = new Demanding(config);
    const cm = await ContextManager.open({ path, strategy: s, membrane: counting as never });
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'setup: the guard holds');
    const waiting = s.waitingChunk();
    assert.ok(waiting, 'setup: a chunk whose L1 hasn\'t landed, its messages in view');
    assert.strictEqual(s.queued(), 0, 'setup: the open queued no chunk');
    s.demand(waiting.first, waiting.last);
    assert.strictEqual(s.queued(), 0, 'the demand queues no chunk');
    assert.strictEqual(cm.isReady(), true, 'the manager stays ready');
    for (let i = 0; i < 5; i++) await cm.tick();
    assert.strictEqual(sent, 0, 'no chunk is sent');
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'the guard still holds');
    await cm.close();
  });

  it('a chunk already sent when the guard trips isn\'t called back: its attempt runs to its end, a later rung of its ladder included', async (t) => {
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const path = freshPath();
    {
      const cm = await ContextManager.open({ path, strategy: strategy(), membrane });
      // Five L1s, below the merge threshold, so no summary above them.
      await growTo(cm, 5);
      add(cm, 12);
      assert.ok(records(cm).some((r) => !(r as { compressed?: boolean }).compressed), 'setup: a chunk record whose L1 hasn\'t landed');
      await cm.close();
    }
    // The first call waits, then is rejected as too long, which the ladder
    // answers with its source-only rung; every later call answers.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const tooLong = Object.assign(new Error('the request is too long (test)'), { type: 'context_length', retryable: false });
    const ladder = {
      complete: async (...args: unknown[]) => {
        calls++;
        if (calls === 1) { await gate; throw tooLong; }
        return membrane.complete(...args);
      },
    };
    const s = new AutobiographicalStrategy({ ...config, compressionSourceOnlyFallback: true });
    const cm = await ContextManager.open({ path, strategy: s, membrane: ladder as never });
    assert.notStrictEqual(s.getCompressionDebt().failure, 'chunk-records', 'setup: the guard doesn\'t hold at open');
    const ticking = cm.tick();
    for (let i = 0; i < 200 && calls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls, 1, 'setup: the first call is out');
    const work = (s as unknown as { pendingCompressionWork: { chunk?: { messages: Array<{ id: string }> } } | null }).pendingCompressionWork;
    const inFlight = work?.chunk?.messages.map((m) => m.id) ?? [];
    assert.ok(inFlight.length > 0, 'setup: a chunk is in flight');
    // Trip the guard while the call waits: removals empty most records, and the chain says their messages are off it.
    const offChain = mock.method(MessageStore.prototype, 'onBranch', () => false);
    t.after(() => offChain.mock.restore());
    const compressed = records(cm).filter((r) => (r as { compressed?: boolean }).compressed);
    for (const id of compressed.flatMap((r) => r.sourceIds)) cm.removeMessage(id);
    // A removal tells the strategy nothing until a host presents; the next message's rebuild asks.
    add(cm, 1);
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', `setup: the guard holds while the call waits (${compressed.length} of ${records(cm).length} records emptied)`);
    release();
    await ticking;
    assert.strictEqual(calls, 2, 'the attempt sent its ladder\'s next rung');
    const covered = l1Sources(cm);
    assert.ok(inFlight.every((id) => covered.has(id)), 'the chunk in flight landed as an L1');
    assert.strictEqual(s.getCompressionDebt().failure, 'chunk-records', 'the guard still holds');
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
    assert.match(line, /Before resuming, check the store was opened with every message slot it was written with \(auxiliaryMessageViews\), then read the emptied records' messages by id/);
    assert.match(line, /branch the chronicle before any removal or re-key/);
    assert.match(line, /If that history isn't on this chain again, remove only the emptied chunk records and keep their summaries\./);
    assert.match(line, /If it is, under new ids, restore the chain the records were written against, or re-key/);
    assert.match(line, /If it's unclear, or the messages can't be read, change nothing: the store stays halted, which discards nothing\. ns=default$/);
    assert.ok(line.indexOf('compare') < line.indexOf('remove only'), 'the comparison comes before any removal');
    assert.ok(line.indexOf('every message slot') < line.indexOf('compare'), 'the slots are checked before anything is compared');
    await cm.close();
  });

  it('a read of the chain that fails puts its whole error in the FAIL-CLOSED line, while the report cuts it to stay under 500 characters', async (t) => {
    const spy = mock.method(console, 'error', () => {});
    t.after(() => spy.mock.restore());
    const s = strategy();
    const cm = await ContextManager.open({ path: freshPath(), strategy: s, membrane });
    await growTo(cm, 5);
    for (const id of records(cm).slice(0, 3).flatMap((r) => r.sourceIds)) cm.removeMessage(id);
    const store = messageStoreOf(cm);
    const wrapped = `${'while reading the messages state under a long path, '.repeat(5)}EACCES: permission denied (test)`;
    store.onBranch = () => { throw new Error(wrapped); };
    add(cm, 40);
    for (let i = 0; i < 5; i++) await cm.tick();
    const failClosed = spy.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('FAIL-CLOSED'));
    assert.strictEqual(failClosed.length, 1, failClosed.join('\n'));
    assert.ok(failClosed[0]!.includes(`(${wrapped})`), failClosed[0]);
    const debt = s.getCompressionDebt();
    assert.strictEqual(debt.failure, 'chunk-records');
    assert.ok((debt.error ?? '').length < 500, `${(debt.error ?? '').length} characters`);
    assert.ok(!(debt.error ?? '').includes('EACCES'), 'the report cuts the cause');
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
