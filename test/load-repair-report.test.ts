/**
 * A load's repair of the summary state that drops summaries holding text
 * makes a report for whoever keeps the agent (context-manager#175):
 * setLoadRepairHandler hands it on, holding reports made before a handler is
 * set, and getLatestLoadRepairReport keeps the newest. The report holds no
 * summary text, and names where the old state can be read back.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { LoadRepairReport, SummaryEntry } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-load-repair-report';
const NAMESPACE = 'agents/keeper-test';
const CONFIG = { targetChunkTokens: 300, auditOnly: true };

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/** A summary entry of any shape, for the persistence boundary. */
function raw(id: unknown, level: unknown, content: string, sourceIds: unknown, sourceRange: unknown, tokens: unknown = 7) {
  return { id, level, content, tokens, sourceLevel: typeof level === 'number' ? level - 1 : 0, sourceIds, sourceRange, created: 1 };
}

type Store = { currentSequence(): number };

class TestableStrategy extends AutobiographicalStrategy {
  seedL1(content: string, sourceIds: string[]): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L1-${this.nextSummaryIdCounter()}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds,
      sourceRange: { first: sourceIds[0] ?? '', last: sourceIds[sourceIds.length - 1] ?? '' },
      created: Date.now(),
    };
    this.pushSummary(entry);
    return entry;
  }

  persistRawSummaries(entries: unknown[]): void {
    this.store?.setStateJson(this.summariesStateId, entries);
  }

  readPersistedSummaries(): SummaryEntry[] {
    return (this.store?.getStateJson(this.summariesStateId) as SummaryEntry[] | null) ?? [];
  }

  /** The state as the store held it at `sequence`, on its current branch. */
  stateAt(stateId: string, sequence: number): unknown {
    return this.store?.getStateJsonAt(stateId, sequence);
  }

  /** A take-up of what the store holds now, as another instance's write sends this one to. */
  takeUp(): void {
    (this as unknown as { takeUpStoreState(): void }).takeUpStoreState();
  }

  /** The message view the strategy reads stored times from. */
  messageView(): { get(id: string): unknown } {
    return (this as unknown as { hostContext: { messageStore: { get(id: string): unknown } } }).hostContext.messageStore;
  }

  storeForTest(): Store {
    return this.store as unknown as Store;
  }
}

async function open(strategy: TestableStrategy): Promise<ContextManager> {
  return ContextManager.open({ path: TEST_STORE_PATH, namespace: NAMESPACE, strategy });
}

/** Writes a store holding one message and these summaries, and closes it: the next open repairs them. */
async function seed(summaries: (m1: string, strategy: TestableStrategy) => unknown[]): Promise<string> {
  const strategy = new TestableStrategy(CONFIG);
  const manager = await open(strategy);
  const m1 = manager.addMessage('User', textBlock('a message'));
  strategy.persistRawSummaries(summaries(m1, strategy));
  manager.sync();
  manager.close();
  return m1;
}

type Mock = { mock: { method(o: object, m: string, f: (...a: unknown[]) => unknown): unknown } };

/** Warnings the strategy's diagnostics write, from here on, and a wait for one to arrive. */
function captureWarnings(t: Mock): { warnings: string[]; arrives(text: string): Promise<void> } {
  const warnings: string[] = [];
  const waiting: Array<{ text: string; resolve(): void }> = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    warnings.push(line);
    for (const w of waiting.filter((w) => line.includes(w.text))) w.resolve();
  });
  const arrives = (text: string) => warnings.some((w) => w.includes(text))
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiting.push({ text, resolve }); });
  return { warnings, arrives };
}

describe('a load repair that drops summaries holding text', () => {
  after(cleanup);
  beforeEach(cleanup);

  it('reports each one, without its text, with where the old state reads back, held until a handler is set', async (t) => {
    const { warnings } = captureWarnings(t);
    const ids: Record<string, string> = {};
    {
      const strategy = new TestableStrategy(CONFIG);
      const manager = await open(strategy);
      ids.m1 = manager.addMessage('User', textBlock('first message'));
      ids.m2 = manager.addMessage('Claude', textBlock('second message'));
      const l1 = strategy.seedL1('the L1 text', [ids.m1, ids.m2]);
      strategy.persistRawSummaries([
        l1,
        // Names a summary the state doesn't hold, so it goes, and it covers m1 to m2.
        raw('L2-90', 2, 'THE L2 TEXT', [l1.id, 'L1-gone'], { first: ids.m1, last: ids.m2 }, 12),
        // Its range starts at a message the store doesn't hold.
        raw('L2-91', 2, 'ANOTHER L2', ['L1-gone'], { first: 'msg-gone', last: ids.m2 }, 5),
        // Empty: it holds no text, so it's counted, not listed.
        raw('L1-92', 1, '', [ids.m1], { first: ids.m1, last: ids.m1 }, 0),
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      assert.ok(warnings.some((w) => w.includes('repaired summary state')), 'the repair still writes its line: ' + warnings.join('\n'));
      const latest = strategy.getLatestLoadRepairReport();
      assert.ok(latest, 'the open made a report');
      const handed: LoadRepairReport[] = [];
      strategy.setLoadRepairHandler((report) => { handed.push(report); });
      assert.equal(handed.length, 1, 'the report made at the open is held, and handed over when a handler is set');
      const report = handed[0]!;
      assert.strictEqual(report, latest);
      const at = (id: string) => manager.getMessage(id)!.timestamp.toISOString();
      assert.deepStrictEqual(report.dropped, [
        { id: 'L2-90', level: 2, tokens: 12, reason: 'names-missing', sourceRange: { first: ids.m1, last: ids.m2, firstAt: at(ids.m1!), lastAt: at(ids.m2!) } },
        { id: 'L2-91', level: 2, tokens: 5, reason: 'names-missing', sourceRange: { first: 'msg-gone', last: ids.m2, firstAt: null, lastAt: at(ids.m2!) } },
      ]);
      assert.equal(report.droppedTokens, 17);
      assert.equal(report.emptyDropped, 1);
      assert.equal(report.namespace, NAMESPACE);
      assert.equal(report.branch, manager.currentBranch().name);
      assert.ok(!JSON.stringify(report).includes('THE L2 TEXT'), 'the report holds no summary text');
      const before = strategy.stateAt(report.stateId, report.sequenceBefore) as Array<{ id: string; content: string }>;
      assert.equal(before.find((s) => s.id === 'L2-90')?.content, 'THE L2 TEXT', 'the old state reads back at the recorded sequence');
      assert.ok(!strategy.readPersistedSummaries().some((s) => s.id === 'L2-90'), 'and the state now has it repaired away');
      // A handler set again gets nothing it was already handed.
      const second: LoadRepairReport[] = [];
      strategy.setLoadRepairHandler((report) => { second.push(report); });
      assert.deepStrictEqual(second, []);
    } finally { manager.close(); }

    // The repair was written, so the next open has nothing to report.
    const again = new TestableStrategy(CONFIG);
    const reopened = await open(again);
    try {
      const handed: LoadRepairReport[] = [];
      again.setLoadRepairHandler((report) => { handed.push(report); });
      assert.deepStrictEqual(handed, []);
      assert.equal(again.getLatestLoadRepairReport(), null);
    } finally { reopened.close(); }
  });

  it('names summaries whose sources could not be read, with a range only where it reads', { timeout: 20_000 }, async () => {
    const m1 = await seed((m1) => [
      raw('L1-40', 1, 'NO SOURCES, NO RANGE', null, null, 9),
      raw('L1-41', 1, 'NO SOURCES, A RANGE', null, { first: m1, last: m1 }, 2),
      raw('L1-42', 1, 'NO SOURCES, A BROKEN RANGE', null, { first: 5, last: m1 }, 3),
      raw('L2-43', 2, 'AN L2 WITH NO SOURCES', null, { first: m1, last: m1 }, 4),
    ]);
    const strategy = new TestableStrategy(CONFIG);
    const handed: LoadRepairReport[] = [];
    let delivered!: () => void;
    const arrived = new Promise<void>((resolve) => { delivered = resolve; });
    strategy.setLoadRepairHandler((report) => { handed.push(report); delivered(); });
    const manager = await open(strategy);
    try {
      await arrived;
      assert.equal(handed.length, 1, 'a handler set before the open gets the report just after the load');
      const at = manager.getMessage(m1)!.timestamp.toISOString();
      assert.deepStrictEqual(handed[0]!.dropped, [
        { id: 'L1-40', level: 1, tokens: 9, reason: 'unreadable', sourceRange: null },
        { id: 'L1-41', level: 1, tokens: 2, reason: 'unreadable', sourceRange: { first: m1, last: m1, firstAt: at, lastAt: at } },
        { id: 'L1-42', level: 1, tokens: 3, reason: 'unreadable', sourceRange: null },
        { id: 'L2-43', level: 2, tokens: 4, reason: 'unreadable', sourceRange: { first: m1, last: m1, firstAt: at, lastAt: at } },
      ]);
    } finally { manager.close(); }
  });

  it("names summaries listing one at their own level, and ones listing a summary that isn't theirs", async () => {
    const ids: Record<string, string> = {};
    {
      const strategy = new TestableStrategy(CONFIG);
      const manager = await open(strategy);
      ids.m1 = manager.addMessage('User', textBlock('one'));
      ids.m2 = manager.addMessage('Claude', textBlock('two'));
      const shared = strategy.seedL1('SHARED', [ids.m1]);
      const other = strategy.seedL1('OTHER', [ids.m2]);
      const range = { first: ids.m1, last: ids.m2 };
      strategy.persistRawSummaries([
        shared,
        other,
        // Two L2s list the same L1, whose pointers name neither: neither is its parent.
        raw('L2-50', 2, 'LISTS SHARED A', [shared.id], { first: ids.m1, last: ids.m1 }, 4),
        raw('L2-51', 2, 'LISTS SHARED B', [shared.id], { first: ids.m1, last: ids.m1 }, 4),
        // Two L2s that list each other: each names one at its own level.
        raw('L2-60', 2, 'LISTS L2-61', [other.id, 'L2-61'], range, 3),
        raw('L2-61', 2, 'LISTS L2-60', ['L2-60'], range, 3),
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      assert.deepStrictEqual(strategy.getLatestLoadRepairReport()?.dropped.map((d) => [d.id, d.reason]), [
        ['L2-50', 'names-non-child'],
        ['L2-51', 'names-non-child'],
        ['L2-60', 'names-not-below'],
        ['L2-61', 'names-not-below'],
      ]);
    } finally { manager.close(); }
  });

  it('makes no report for a repair that drops only empty summaries', async (t) => {
    const { warnings } = captureWarnings(t);
    await seed((m1, strategy) => [strategy.seedL1('KEPT', [m1]), raw('L1-70', 1, '   ', [m1], { first: m1, last: m1 }, 0)]);
    const strategy = new TestableStrategy(CONFIG);
    const handed: LoadRepairReport[] = [];
    strategy.setLoadRepairHandler((report) => { handed.push(report); });
    const manager = await open(strategy);
    try {
      assert.match(warnings.find((w) => w.includes('repaired summary state')) ?? '', /dropped empty \[L1-70\]/, warnings.join('\n'));
      assert.deepStrictEqual(handed, []);
      assert.equal(strategy.getLatestLoadRepairReport(), null);
    } finally { manager.close(); }
  });

  it("hands a report over only once its load has ended and its repair is written, after the ones held, and a failing handler stops nothing", { timeout: 20_000 }, async (t) => {
    const { warnings } = captureWarnings(t);
    const m1 = await seed((m1) => [raw('L2-80', 2, 'FIRST DAMAGE', ['L1-gone'], { first: m1, last: m1 }, 2)]);
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      // A take-up of damage written since, with no handler set: held too.
      strategy.persistRawSummaries([raw('L2-81', 2, 'SECOND DAMAGE', ['L1-gone'], { first: m1, last: m1 }, 3)]);
      strategy.takeUp();
      const second = strategy.getLatestLoadRepairReport()!;
      assert.equal(second.dropped[0]?.id, 'L2-81', 'the newest report');
      const before = strategy.stateAt(second.stateId, second.sequenceBefore) as Array<{ id: string; content: string }>;
      assert.equal(before.find((s) => s.id === 'L2-81')?.content, 'SECOND DAMAGE', "a take-up's old state reads back at its sequence");

      const handed: string[] = [];
      let inLoad = false;
      const seen: Array<{ inLoad: boolean; written: boolean }> = [];
      let third!: () => void;
      const thirdArrived = new Promise<void>((resolve) => { third = resolve; });
      strategy.setLoadRepairHandler((report) => {
        const id = report.dropped[0]!.id;
        handed.push(id);
        seen.push({ inLoad, written: !strategy.readPersistedSummaries().some((s) => s.id === id) });
        if (id === 'L2-82') third();
        throw new Error('the host failed');
      });
      assert.deepStrictEqual(handed, ['L2-80', 'L2-81'], 'oldest first, the throw from the first stopping nothing');
      assert.ok(warnings.some((w) => w.includes('load-repair handler failed') && w.includes('the host failed')), warnings.join('\n'));

      strategy.persistRawSummaries([raw('L2-82', 2, 'THIRD DAMAGE', ['L1-gone'], { first: m1, last: m1 }, 4)]);
      inLoad = true;
      assert.doesNotThrow(() => strategy.takeUp(), 'the load goes on with a handler that throws');
      inLoad = false;
      assert.deepStrictEqual(handed, ['L2-80', 'L2-81'], 'not handed over while the load runs');
      await thirdArrived;
      assert.deepStrictEqual(handed, ['L2-80', 'L2-81', 'L2-82'], 'the next report still reaches it');
      assert.deepStrictEqual(seen[2], { inLoad: false, written: true }, 'after the load ended, with its repair written');
      assert.equal(strategy.getLatestLoadRepairReport()?.dropped[0]?.id, 'L2-82', 'and the getter keeps it');
    } finally { manager.close(); }
  });

  it('hands a report from a load the handler starts after the ones already held', async () => {
    const m1 = await seed((m1) => [raw('L2-83', 2, 'A', ['L1-gone'], { first: m1, last: m1 }, 1)]);
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      strategy.persistRawSummaries([raw('L2-84', 2, 'B', ['L1-gone'], { first: m1, last: m1 }, 1)]);
      strategy.takeUp();
      const handed: string[] = [];
      strategy.setLoadRepairHandler((report) => {
        const id = report.dropped[0]!.id;
        handed.push(id);
        if (id === 'L2-83') {
          strategy.persistRawSummaries([raw('L2-85', 2, 'C', ['L1-gone'], { first: m1, last: m1 }, 1)]);
          strategy.takeUp();
        }
      });
      assert.deepStrictEqual(handed, ['L2-83', 'L2-84', 'L2-85']);
    } finally { manager.close(); }
  });

  it('hands each report to the handler set when it is taken, one a handler sets mid-hand-over included', async () => {
    const m1 = await seed((m1) => [raw('L2-93', 2, 'A', ['L1-gone'], { first: m1, last: m1 }, 1)]);
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      strategy.persistRawSummaries([raw('L2-94', 2, 'B', ['L1-gone'], { first: m1, last: m1 }, 1)]);
      strategy.takeUp();
      const first: string[] = [];
      const second: string[] = [];
      strategy.setLoadRepairHandler((report) => {
        first.push(report.dropped[0]!.id);
        // At its first report, the first handler hands over to a second,
        // then runs a load whose report follows. (Only at its first: a
        // handler that ran the load on every report would loop forever if
        // it kept getting them.)
        if (first.length > 1) return;
        strategy.setLoadRepairHandler((later) => { second.push(later.dropped[0]!.id); });
        strategy.persistRawSummaries([raw('L2-95', 2, 'C', ['L1-gone'], { first: m1, last: m1 }, 1)]);
        strategy.takeUp();
      });
      assert.deepStrictEqual([first, second], [['L2-93'], ['L2-94', 'L2-95']]);
    } finally { manager.close(); }
  });

  it("logs a rejection of what a handler returns, an async function's promise or a library's thenable", { timeout: 20_000 }, async (t) => {
    const { arrives } = captureWarnings(t);
    const m1 = await seed((m1) => [raw('L2-86', 2, 'DAMAGE', ['L1-gone'], { first: m1, last: m1 }, 1)]);
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      strategy.setLoadRepairHandler(async () => { throw new Error('the alert failed to send'); });
      await arrives('the alert failed to send');
      // A thenable that isn't this realm's Promise, as another realm's or a library's is.
      strategy.setLoadRepairHandler(() => ({ then: (_: unknown, reject: (e: unknown) => void) => reject(new Error('the thenable rejected')) }));
      strategy.persistRawSummaries([raw('L2-87', 2, 'MORE DAMAGE', ['L1-gone'], { first: m1, last: m1 }, 1)]);
      strategy.takeUp();
      await arrives('the thenable rejected');
    } finally { manager.close(); }
  });

  it('gives null for a stored number field that is not a number, and an id as text', async () => {
    await seed((m1) => [
      raw('L2-20', 2, 'COUNTED', ['L1-gone'], { first: m1, last: m1 }, 6),
      raw('L2-21', 2, 'TOKENS AS TEXT', ['L1-gone'], { first: m1, last: m1 }, '6'),
      raw('L2-22', '2', 'LEVEL AS TEXT', ['L1-gone'], { first: m1, last: m1 }, 1),
      raw(23, 2, 'ID AS A NUMBER', ['L1-gone'], { first: m1, last: m1 }, 2),
    ]);
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      const report = strategy.getLatestLoadRepairReport()!;
      assert.deepStrictEqual(report.dropped.map((d) => [d.id, d.level, d.tokens]), [
        ['L2-20', 2, 6],
        ['L2-21', 2, null],
        ['L2-22', null, 1],
        ['23', 2, 2],
      ]);
      assert.equal(report.droppedTokens, 9);
    } finally { manager.close(); }
  });

  it('names the branch the repair ran on, where the old state reads back only while it is current', async () => {
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      const m1 = manager.addMessage('User', textBlock('before the fork'));
      const main = manager.currentBranch().name;
      await manager.fork('experimental');
      strategy.persistRawSummaries([raw('L2-30', 2, 'ON THE FORK', ['L1-gone'], { first: m1, last: m1 }, 8)]);
      manager.sync();
      await manager.switchBranch(main);
      await manager.switchBranch('experimental');
      const report = strategy.getLatestLoadRepairReport()!;
      assert.ok(report, 'the switch back to the fork loaded and repaired it');
      assert.equal(report.branch, 'experimental');
      const onFork = strategy.stateAt(report.stateId, report.sequenceBefore) as Array<{ id: string; content: string }>;
      assert.equal(onFork.find((s) => s.id === 'L2-30')?.content, 'ON THE FORK');
      await manager.switchBranch(main);
      const onMain = strategy.stateAt(report.stateId, report.sequenceBefore);
      assert.ok(!JSON.stringify(onMain ?? null).includes('ON THE FORK'), 'with another branch current, the same read gives that branch: ' + JSON.stringify(onMain ?? null));
    } finally { manager.close(); }
  });

  it("gives a null time for a range end whose time can't be read, and keeps the report", async (t) => {
    const ids: Record<string, string> = {};
    {
      const strategy = new TestableStrategy(CONFIG);
      const manager = await open(strategy);
      ids.m1 = manager.addMessage('User', textBlock('one'));
      ids.m2 = manager.addMessage('Claude', textBlock('two'));
      ids.m3 = manager.addMessage('User', textBlock('three'));
      manager.close();
    }
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      const view = strategy.messageView();
      const get = view.get.bind(view);
      t.mock.method(view, 'get', (id: string) => {
        if (id === ids.m1) throw new Error('the view failed');
        if (id === ids.m2) return { timestamp: new Date(Number.NaN) };
        return get(id);
      });
      // Each range pairs an end whose time can't be read with one whose time can.
      strategy.persistRawSummaries([
        raw('L2-11', 2, 'DAMAGE', ['L1-gone'], { first: ids.m1, last: ids.m3 }, 1),
        raw('L2-12', 2, 'MORE', ['L1-gone'], { first: ids.m3, last: ids.m2 }, 1),
      ]);
      strategy.takeUp();
      const at = manager.getMessage(ids.m3!)!.timestamp.toISOString();
      assert.deepStrictEqual(strategy.getLatestLoadRepairReport()?.dropped.map((d) => d.sourceRange), [
        { first: ids.m1, last: ids.m3, firstAt: null, lastAt: at },
        { first: ids.m3, last: ids.m2, firstAt: at, lastAt: null },
      ]);
    } finally { manager.close(); }
  });

  it("goes ahead with the repair, and logs, when the store's sequence can't be read for the report", async (t) => {
    const { warnings } = captureWarnings(t);
    const strategy = new TestableStrategy(CONFIG);
    const manager = await open(strategy);
    try {
      const m1 = manager.addMessage('User', textBlock('m'));
      strategy.persistRawSummaries([raw('L2-10', 2, 'DAMAGE', ['L1-gone'], { first: m1, last: m1 }, 1)]);
      t.mock.method(strategy.storeForTest(), 'currentSequence', () => { throw new Error('the store failed'); });
      assert.doesNotThrow(() => strategy.takeUp());
      t.mock.restoreAll();
      assert.ok(!strategy.readPersistedSummaries().some((s) => s.id === 'L2-10'), 'the repair is written');
      assert.ok(warnings.some((w) => w.includes("its report couldn't be read") && w.includes('the store failed')), warnings.join('\n'));
      assert.equal(strategy.getLatestLoadRepairReport(), null);
    } finally { manager.close(); }
  });
});
