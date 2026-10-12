/**
 * Fold receipts (fold-journal.ts): what an accepted round records when the
 * rendered context changed resolution.
 *
 * A scripted strategy renders each message raw, through a named summary, or
 * not at all, so every case controls the exact layout a compile produces.
 * Acceptance goes through the public ContextManager API, as a host would.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy } from '../src/index.js';
import { FoldJournal, applyLayoutChain, applyLayoutDelta, decodeSequences, encodeSequences, layoutDelta } from '../src/fold-journal.js';
import type { StoredLayout } from '../src/fold-journal.js';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  RenderedSummaryInfo,
  StoredMessage,
  TokenBudget,
  CompileProvenance,
  FoldReceipt,
  LayoutUnit,
  RenderedLayout,
} from '../src/index.js';

const STORE = './test-fold-journal';
const BUDGET: TokenBudget = { maxTokens: 1_000_000, reserveForResponse: 0 };

type Form = 'raw' | 'omit' | { summary: string; level: number };

/** Renders each message as the current plan says (default raw). */
class ScriptedStrategy implements ContextStrategy {
  readonly name = 'scripted';
  readonly renderedForms = ['raw', 'summary', 'omitted'] as const;
  plan = new Map<string, Form>();
  /** Message ids whose raw copy is truncated in the render. */
  truncate = new Set<string>();
  /** Message ids rendered raw although their plan names a summary that
   *  still covers them (a pin keeps a covered message raw). */
  pinned = new Set<string>();
  /** Summary ids describeRenderedSummaries leaves out (it can't describe them). */
  undescribed = new Set<string>();
  cause: string | undefined;

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  select(store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] {
    const entries: ContextEntry[] = [];
    const emitted = new Set<string>();
    for (const msg of store.getAll()) {
      const form = this.pinned.has(msg.id) ? 'raw' : this.plan.get(msg.id) ?? 'raw';
      if (form === 'omit') continue;
      if (form === 'raw') {
        const content: ContentBlock[] = this.truncate.has(msg.id)
          ? [{ type: 'text', text: `${textOf(msg).slice(0, 3)}…[truncated]` }]
          : msg.content;
        entries.push({ index: entries.length, sourceMessageId: msg.id, sourceRelation: 'copy', participant: msg.participant, content });
        continue;
      }
      if (emitted.has(form.summary)) continue;
      emitted.add(form.summary);
      const refs = [{ id: form.summary, level: form.level }];
      entries.push({ index: entries.length, participant: 'Context Manager', content: [{ type: 'text', text: 'What do you remember?' }], sourceRelation: 'derived', summaries: refs });
      entries.push({ index: entries.length, participant: 'Claude', content: [{ type: 'text', text: `summary ${form.summary}` }], sourceRelation: 'derived', summaries: refs });
    }
    return entries;
  }

  describeRenderedSummaries(ids: readonly string[]): ReadonlyMap<string, RenderedSummaryInfo> {
    const out = new Map<string, RenderedSummaryInfo>();
    for (const id of ids) {
      if (this.undescribed.has(id)) continue;
      const leaves: string[] = [];
      let level = 0;
      for (const [mid, form] of this.plan) {
        if (typeof form === 'object' && form.summary === id) {
          leaves.push(mid);
          level = form.level;
        }
      }
      out.set(id, { level, leaves, method: 'unknown' });
    }
    return out;
  }

  takeSelectionCause(): string | undefined {
    const c = this.cause;
    this.cause = undefined;
    return c;
  }
}

/** The store with some of its methods replaced, the rest bound to it. */
function wrapStore(real: JsStore, overrides: Partial<Record<keyof JsStore, unknown>>): JsStore {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof JsStore];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as JsStore;
}

function textOf(msg: StoredMessage): string {
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function cleanup(): void {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
}

async function open(strategy = new ScriptedStrategy()): Promise<{ cm: ContextManager; strategy: ScriptedStrategy }> {
  const cm = await ContextManager.open({ path: STORE, strategy, namespace: 'agents/tester' });
  return { cm, strategy };
}

function add(cm: ContextManager, n: number, prefix = 'm'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(cm.addMessage('user', [{ type: 'text', text: `${prefix}${i} hello there` }]));
  return ids;
}

async function acceptCompile(cm: ContextManager, usage?: { inputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }): Promise<FoldReceipt | null> {
  const result = await cm.compile(BUDGET);
  assert.ok(result.provenance, 'compile reports provenance');
  return cm.acceptRound({ provenance: result.provenance!, usage });
}

describe('fold journal', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('writes a baseline on the first accepted round, saying history before it is unknown', async () => {
    const { cm } = await open();
    const ids = add(cm, 3);
    const receipt = await acceptCompile(cm, { inputTokens: 120, cacheReadTokens: 0 });
    assert.ok(receipt);
    assert.equal(receipt.kind, 'baseline');
    assert.equal(receipt.historyBefore, 'unknown');
    assert.equal(receipt.layout?.length, 1);
    assert.deepEqual(receipt.layout?.[0]?.form, { form: 'raw' });
    assert.equal(receipt.layout?.[0]?.first.messageId, ids[0]);
    assert.equal(receipt.layout?.[0]?.last.messageId, ids[2]);
    assert.equal(receipt.layout?.[0]?.messages, 3);
    assert.equal(receipt.renderedTokens.before, 'unknown');
    // Reported usage passes through; unreported fields are unknown, never 0.
    assert.deepEqual(receipt.usage, { input: 120, cacheRead: 0, cacheWrite: 'unknown', scope: 'round' });
    assert.equal(receipt.source.namespace, 'agents/tester');
    assert.equal(receipt.source.runtime, 'unknown');
    assert.equal(receipt.cause, 'unknown');
    cm.close();
  });

  it('records nothing for plain appends: arrivals are not folds', async () => {
    const { cm } = await open();
    add(cm, 3);
    await acceptCompile(cm);
    add(cm, 2, 'n');
    assert.equal(await acceptCompile(cm), null);
    add(cm, 1, 'o');
    assert.equal(await acceptCompile(cm), null);
    assert.equal(cm.listFoldReceipts().receipts.length, 1);
    cm.close();
  });

  it('reports a fold with its run boundaries, forms, method and tokens', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 6);
    await acceptCompile(cm);
    for (const id of ids.slice(1, 4)) strategy.plan.set(id, { summary: 'L1-0', level: 1 });
    strategy.cause = 'budget-fit';
    const receipt = await acceptCompile(cm, { inputTokens: 50 });
    assert.ok(receipt);
    assert.equal(receipt.kind, 'change');
    assert.equal(receipt.changes?.length, 1);
    const change = receipt.changes![0]!;
    assert.equal(change.first.messageId, ids[1]);
    assert.equal(change.last.messageId, ids[3]);
    assert.equal(change.messages, 3);
    assert.deepEqual(change.before, { form: 'raw' });
    assert.deepEqual(change.after, { form: 'summary', level: 1, summaries: [{ id: 'L1-0', level: 1, method: 'unknown' }] });
    assert.ok(change.estimatedTokensBefore > 0);
    assert.ok(change.estimatedTokensAfter > 0);
    assert.equal(receipt.cause, 'budget-fit');
    assert.notEqual(receipt.renderedTokens.before, 'unknown');
    cm.close();
  });

  it('reports a deeper fold, an immediate fold-down from raw, an unfold and window omission', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 8);
    await acceptCompile(cm);

    // Immediate fold-down: raw straight to a level-2 summary.
    for (const id of ids.slice(0, 2)) strategy.plan.set(id, { summary: 'L2-0', level: 2 });
    let r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.before.form, c.after.form]), [['raw', 'summary']]);
    assert.equal((r?.changes?.[0]?.after as { level: number }).level, 2);

    // Deeper fold of an existing summary span: L1 -> L2 for ids 2..3.
    for (const id of ids.slice(2, 4)) strategy.plan.set(id, { summary: 'L1-1', level: 1 });
    await acceptCompile(cm);
    for (const id of ids.slice(2, 4)) strategy.plan.set(id, { summary: 'L2-1', level: 2 });
    r = await acceptCompile(cm);
    assert.equal(r?.changes?.length, 1);
    assert.equal((r?.changes?.[0]?.before as { summaries: Array<{ id: string }> }).summaries[0]!.id, 'L1-1');
    assert.equal((r?.changes?.[0]?.after as { summaries: Array<{ id: string }> }).summaries[0]!.id, 'L2-1');
    assert.equal(r?.changes?.[0]?.messages, 2, 'counts are exact from membership');

    // Unfold after a budget increase: summary back to raw.
    strategy.plan.delete(ids[0]!);
    strategy.plan.delete(ids[1]!);
    r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.before.form, c.after.form, c.messages]), [['summary', 'raw', 2]]);

    // Window omission: raw to omitted, reported as omission.
    strategy.plan.set(ids[4]!, 'omit');
    strategy.plan.set(ids[5]!, 'omit');
    r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.before.form, c.after.form]), [['raw', 'omitted']]);
    assert.equal(r?.changes?.[0]?.first.messageId, ids[4]);
    assert.equal(r?.changes?.[0]?.last.messageId, ids[5]);
    assert.equal(r?.changes?.[0]?.estimatedTokensAfter, 0);
    cm.close();
  });

  it('compares only messages present in both layouts, even inside a range', async () => {
    const { cm, strategy } = await open();
    const [m1, m2, m3] = add(cm, 3);
    const baseline = await acceptCompile(cm);
    const threeRaw = baseline!.layout![0]!.estimatedTokens;
    // m2 leaves the view; a summary covers the remaining two.
    cm.removeMessage(m2!);
    strategy.plan.set(m1!, { summary: 's13', level: 1 });
    strategy.plan.set(m3!, { summary: 's13', level: 1 });
    const r = await acceptCompile(cm);
    assert.equal(r?.changes?.length, 1);
    const change = r!.changes![0]!;
    assert.equal(change.messages, 2, 'm2 was in neither the summary nor the new view');
    assert.equal(change.first.messageId, m1);
    assert.equal(change.last.messageId, m3);
    // m2's raw tokens are not charged: the three bodies are the same size, so
    // the run's "before" is two thirds of the baseline's three raw messages.
    assert.ok(Math.abs(change.estimatedTokensBefore * 3 - threeRaw * 2) <= 3, `${change.estimatedTokensBefore} vs ${threeRaw}`);
    const layout = (await cm.compile(BUDGET)).provenance!.layout!;
    assert.deepEqual(layout.memberIds, [m1, m3], 'm2 is in no unit: it is not a member');
    assert.deepEqual(layout.units.map((u) => [u.k, u.k === 'r' ? 1 : u.n]), [['s', 2]], 'one summary unit covering the two');
    cm.close();
  });

  it('reports a raw copy becoming partial', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    await acceptCompile(cm);
    strategy.truncate.add(ids[1]!);
    const r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.before, c.after]), [[{ form: 'raw' }, { form: 'raw', partial: true }]]);
    cm.close();
  });

  it('does not report a message that arrives already folded (an arrival, not a fold)', async () => {
    const { cm, strategy } = await open();
    add(cm, 2);
    await acceptCompile(cm);
    const late = add(cm, 2, 'late');
    for (const id of late) strategy.plan.set(id, { summary: 'L1-9', level: 1 });
    assert.equal(await acceptCompile(cm), null);
    cm.close();
  });

  it('records a fold once, at the successful round, when an earlier compile was never accepted', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 4);
    await acceptCompile(cm);
    strategy.plan.set(ids[0]!, { summary: 'L1-0', level: 1 });
    await cm.compile(BUDGET); // the round carrying this compile failed: never accepted
    const second = await cm.compile(BUDGET);
    const r = cm.acceptRound({ provenance: second.provenance! });
    assert.equal(r?.changes?.length, 1);
    assert.equal(cm.acceptRound({ provenance: second.provenance! })?.id, r!.id, 'a later round of the same compile adds nothing: the same receipt');
    assert.equal(cm.listFoldReceipts().receipts.length, 2);
    cm.close();
  });

  it('keeps its baseline and last layout across a restart', async () => {
    let { cm, strategy } = await open();
    const ids = add(cm, 4);
    await acceptCompile(cm);
    add(cm, 2, 'n');
    await acceptCompile(cm); // arrival-only delta
    const storeId = cm.getStoreId();
    cm.close();

    ({ cm, strategy } = await open());
    assert.equal(await acceptCompile(cm), null, 'no spurious receipt after restart');
    assert.equal(cm.getStoreId(), storeId, 'the store id is stable');
    strategy.plan.set(ids[3]!, 'omit');
    const r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.before.form, c.after.form, c.first.messageId]), [['raw', 'omitted', ids[3]]]);
    cm.close();
  });

  it('keeps every branch in the journal, binds acceptance to the captured branch, and answers for deleted branches', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 4);
    await acceptCompile(cm);
    const main = cm.currentBranchRef();

    const forked = await cm.fork('side');
    assert.equal(forked, 'side');
    const sideBaseline = await acceptCompile(cm);
    assert.equal(sideBaseline?.kind, 'baseline', 'a branch new to the journal gets a baseline');

    // Compile on 'side', then the selected branch moves before the round stands.
    strategy.plan.set(ids[0]!, 'omit');
    const onSide = await cm.compile(BUDGET);
    await cm.switchBranch(main.name);
    const late = cm.acceptRound({ provenance: onSide.provenance! });
    assert.equal(late?.source.branch.name, 'side', 'the receipt lands on the captured branch');

    assert.equal(cm.listFoldReceipts().receipts.length, 1, 'main still has only its baseline');
    assert.equal(cm.listFoldReceipts({ branch: 'side' }).receipts.length, 2);

    cm.getStore().deleteBranch('side');
    const deleted = cm.listFoldReceipts({ branch: 'side' });
    assert.equal(deleted.receipts.length, 2, 'a deleted branch stays queryable');
    assert.match(cm.listFoldReceipts({ branch: 'nope' }).note ?? '', /No branch named/);

    // A new 'side' reuses the name: the name finds it, and the deleted one is
    // reached by its id, as its receipts name it.
    const oldSide = late!.source.branch;
    await cm.switchBranch(main.name);
    await cm.fork('side');
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    assert.equal(cm.listFoldReceipts({ branch: 'side' }).receipts.length, 1, 'the live branch of that name');
    const byId = cm.listFoldReceipts({ branch: { id: oldSide.id, created: oldSide.created } });
    assert.deepEqual(byId.receipts.map((r) => r.id), deleted.receipts.map((r) => r.id), 'the deleted one, by id');
    assert.equal(byId.branch?.name, 'side');
    assert.match(cm.listFoldReceipts({ branch: { id: 'no-such-branch', created: 1 } }).note ?? '', /No branch with id/);
    cm.close();
  });

  it('keeps a receipt as rendered then after the message it names is removed', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 4);
    await acceptCompile(cm);
    strategy.plan.set(ids[1]!, { summary: 'L1-0', level: 1 });
    const r = await acceptCompile(cm);
    cm.removeMessage(ids[1]!);
    const reread = cm.listFoldReceipts().receipts.find((x) => x.id === r!.id)!;
    assert.deepEqual(reread.changes, r!.changes);
    // The next diff reads persisted units only, so the removal is no fold.
    assert.equal(await acceptCompile(cm), null);
    cm.close();
  });

  it('filters by afterId and by since (an ISO time only) and limit, newest first, and validates them', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 6);
    await acceptCompile(cm);
    for (let i = 0; i < 4; i++) {
      strategy.plan.set(ids[i]!, 'omit');
      await acceptCompile(cm);
    }
    const all = cm.listFoldReceipts({ limit: 100 });
    assert.equal(all.receipts.length, 5);
    assert.ok(Number(all.receipts[0]!.id) > Number(all.receipts[1]!.id), 'newest first');
    assert.equal(all.latestId, all.receipts[0]!.id);
    assert.equal(cm.listFoldReceipts().receipts.length, 5, 'default limit 10');
    assert.equal(cm.listFoldReceipts({ limit: 2 }).receipts.length, 2);
    assert.equal(all.more, false);
    // afterId continues: oldest first from just after the cursor.
    const after = cm.listFoldReceipts({ afterId: all.receipts[2]!.id });
    assert.deepEqual(after.receipts.map((r) => r.id), [all.receipts[1]!.id, all.receipts[0]!.id]);
    assert.equal(after.more, false);
    const step = cm.listFoldReceipts({ afterId: all.receipts[2]!.id, limit: 1 });
    assert.deepEqual(step.receipts.map((r) => r.id), [all.receipts[1]!.id], 'the next one, not the newest');
    assert.equal(step.more, true);
    assert.equal(cm.listFoldReceipts({ limit: 2 }).more, true, 'newest first, three older ones left out');
    assert.deepEqual(cm.listFoldReceipts({ afterId: all.latestId! }).receipts, [], 'nothing after the newest');
    assert.equal(cm.listFoldReceipts({ since: '2000-01-01T00:00:00Z' }).receipts.length, 5);
    assert.equal(cm.listFoldReceipts({ since: '2000-01-01' }).receipts.length, 5, 'a date alone is a time');
    assert.equal(cm.listFoldReceipts({ since: '2999-01-01T00:00:00Z' }).receipts.length, 0);
    assert.equal(cm.listFoldReceipts({ limit: 500 }).receipts.length, 5, 'capped, not refused');
    assert.throws(() => cm.listFoldReceipts({ limit: 0 }), /positive integer/);
    assert.throws(() => cm.listFoldReceipts({ since: 'yesterday' }), /ISO 8601 time/);
    // Epoch milliseconds are not a time and not an id: refused, not misread.
    assert.throws(() => cm.listFoldReceipts({ since: String(Date.now()) }), /pass its id as afterId/);
    assert.throws(() => cm.listFoldReceipts({ since: all.receipts[2]!.id }), /pass its id as afterId/);
    assert.throws(() => cm.listFoldReceipts({ afterId: '2026-10-09' }), /decimal integer/);
    cm.close();
  });

  it('pages forward through a whole record with afterId, without skipping or repeating any receipt', async () => {
    const { cm, strategy } = await open();
    // Enough records first that the receipts' ids cross a digit boundary:
    // ids compare as numbers, and as strings "100" sorts before "99".
    const ids = add(cm, 80);
    await acceptCompile(cm);
    for (let i = 0; i < 24; i++) {
      strategy.plan.set(ids[i]!, 'omit');
      await acceptCompile(cm);
    }
    const everything = cm.listFoldReceipts({ limit: 100 }).receipts.map((r) => r.id).reverse();
    assert.equal(everything.length, 25);
    assert.ok(new Set(everything.map((id) => id.length)).size > 1, `ids cross a digit boundary: ${everything[0]}..${everything.at(-1)}`);
    const seen: string[] = [];
    let cursor = '0';
    for (let page = 0; page < 10; page++) {
      const result = cm.listFoldReceipts({ afterId: cursor, limit: 10 });
      seen.push(...result.receipts.map((r) => r.id));
      if (!result.more) break;
      cursor = result.receipts.at(-1)!.id;
    }
    assert.deepEqual(seen, everything, 'oldest to newest, each once');
    cm.close();
  });

  it('records how the confirming round carried the compile, as its producer reported', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const verbatim = cm.acceptRound({ provenance: (await cm.compile(BUDGET)).provenance!, presentation: 'verbatim' });
    assert.equal(verbatim?.presentation, 'verbatim');
    strategy.plan.set(ids[0]!, 'omit');
    const altered = cm.acceptRound({ provenance: (await cm.compile(BUDGET)).provenance!, presentation: 'altered' });
    assert.equal(altered?.presentation, 'altered');
    strategy.plan.set(ids[1]!, 'omit');
    assert.equal((await acceptCompile(cm))?.presentation, 'unknown', 'unknown when not reported');
    assert.deepEqual(cm.listFoldReceipts({ limit: 10 }).receipts.map((r) => r.presentation), ['unknown', 'altered', 'verbatim'], 'and as listed');
    cm.close();
  });

  it('records the source the host supplies, and names its store', async () => {
    const { cm } = await open();
    cm.setReceiptSource({ runtime: 'connectome-host', dataDirectory: '/data/linn', agent: 'Linn' });
    add(cm, 1);
    const r = await acceptCompile(cm);
    assert.equal(r?.source.runtime, 'connectome-host');
    assert.equal(r?.source.dataDirectory, '/data/linn');
    assert.equal(r?.source.agent, 'Linn');
    assert.match(r?.source.storeId ?? '', /^[0-9a-f-]{36}$/);
    cm.close();
  });

  it('writes nothing for a strategy that does not report its layout', async () => {
    const strategy = new ScriptedStrategy();
    (strategy as { renderedForms?: unknown }).renderedForms = undefined;
    const { cm } = await open(strategy);
    add(cm, 2);
    const result = await cm.compile(BUDGET);
    assert.equal(result.provenance?.layout, null);
    assert.equal(cm.acceptRound({ provenance: result.provenance! }), null);
    assert.deepEqual(cm.describeRenderedForms(), { strategy: 'scripted', forms: null });
    cm.close();
  });

  it('reconstructs its records exactly across a restart', async () => {
    let { cm, strategy } = await open();
    add(cm, 2);
    await acceptCompile(cm);
    for (let i = 0; i < 70; i++) {
      add(cm, 1, `t${i}-`);
      await acceptCompile(cm);
    }
    const kinds = layoutRecords(cm.getStore()).map((r) => r.kind);
    assert.ok(kinds.filter((k) => k === 'snapshot').length >= 2 && kinds.at(-1) === 'delta', `snapshots and deltas both: ${kinds.join(',')}`);
    cm.close();
    ({ cm, strategy } = await open());
    const all = cm.getAllMessages();
    strategy.plan.set(all[40]!.id, 'omit');
    const r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.first.messageId, c.before.form, c.after.form]), [[all[40]!.id, 'raw', 'omitted']]);
    // Every message omitted: one run from the first to the newest, which only
    // a rebuild holding every arrival, in its form, reports whole.
    for (const m of all) strategy.plan.set(m.id, 'omit');
    const whole = await acceptCompile(cm);
    assert.deepEqual(whole?.changes?.map((c) => [c.first.messageId, c.last.messageId, c.messages, c.before.form, c.after.form]),
      [[all[0]!.id, all[39]!.id, 40, 'raw', 'omitted'], [all[41]!.id, all.at(-1)!.id, all.length - 41, 'raw', 'omitted']]);
    cm.close();
  });

  it('commits receipt and layout together: a failed or uncertain append never duplicates a receipt', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const real = cm.getStore();
    // 'fail': the append throws before writing. 'landed': it writes, then throws.
    let mode: 'ok' | 'fail' | 'landed' = 'fail';
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appendJson') {
          return (type: string, payload: unknown) => {
            if (mode === 'fail') throw new Error('disk full');
            const written = target.appendJson(type, payload);
            if (mode === 'landed') throw new Error('write reported failure after landing');
            return written;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const journal = new FoldJournal(flaky, 'agents/tester');

    const first = (await cm.compile(BUDGET)).provenance!;
    assert.throws(() => journal.accept(first, Date.now(), undefined), /disk full/);
    mode = 'ok';
    const baseline = journal.accept(first, Date.now(), undefined);
    assert.equal(baseline?.kind, 'baseline', 'the retry writes the baseline once');
    assert.equal(journal.accept(first, Date.now(), undefined)?.id, baseline!.id, 'and a later retry gets it back');

    strategy.plan.set(ids[0]!, 'omit');
    const second = (await cm.compile(BUDGET)).provenance!;
    const announced: string[] = [];
    journal.onReceipt((r) => announced.push(r.id));
    mode = 'landed';
    assert.throws(() => journal.accept(second, Date.now(), undefined), /after landing/);
    assert.deepEqual(announced, [], 'nothing announced while the write is uncertain');
    mode = 'ok';
    const retry = new FoldJournal(flaky, 'agents/tester');
    const landedReceipt = journal.accept(second, Date.now(), undefined);
    assert.equal(landedReceipt?.kind, 'change', 'the landed record is found on reread, and its receipt returned');
    assert.deepEqual(announced, [landedReceipt!.id], 'and announced once, so a projection converges');
    assert.equal(journal.accept(second, Date.now(), undefined)?.id, landedReceipt!.id);
    assert.equal(announced.length, 1, 'never twice');
    // Only each branch's newest announced receipt is kept, so an older one a
    // retry finds is heard again (listeners key on ids), and the newest stays once.
    assert.equal(journal.accept(first, Date.now(), undefined)?.id, baseline!.id);
    assert.deepEqual(announced, [landedReceipt!.id, baseline!.id], 'an older receipt a retry finds is heard again');
    assert.equal(journal.accept(second, Date.now(), undefined)?.id, landedReceipt!.id);
    assert.deepEqual(announced, [landedReceipt!.id, baseline!.id], 'and the newest still once');
    assert.equal(retry.accept(second, Date.now(), undefined)?.id, landedReceipt!.id, 'a fresh journal finds it too');

    // The ordinary next-activation path: the uncertain write was on the
    // stream's last round, and the next accepted compile is a new compile
    // with an identical layout.
    const third = (await cm.compile(BUDGET)).provenance!;
    strategy.plan.set(ids[1]!, 'omit');
    const fourth = (await cm.compile(BUDGET)).provenance!;
    const nextActivation = new FoldJournal(flaky, 'agents/tester');
    const heard: string[] = [];
    nextActivation.onReceipt((r) => heard.push(r.id));
    mode = 'landed';
    assert.throws(() => nextActivation.accept(fourth, Date.now(), undefined), /after landing/);
    mode = 'ok';
    // Journals on one store object share its index; a reader on the same
    // (wrapped) store sees what they wrote.
    const reader = new FoldJournal(flaky, 'agents/tester');
    const landed = reader.query({ limit: 1 }).receipts[0]!;
    assert.ok(!heard.includes(landed.id), 'the uncertain receipt is not announced yet');
    const sameLayout = (await cm.compile(BUDGET)).provenance!;
    assert.notEqual(sameLayout.compileId, fourth.compileId);
    assert.equal(nextActivation.accept(sameLayout, Date.now(), undefined), null, 'identical layout: no new receipt');
    assert.equal(heard.filter((id) => id === landed.id).length, 1, 'the recovered receipt is announced, once');
    void third;
    const kinds = reader.query({ limit: 100 }).receipts.map((r) => r.kind);
    assert.deepEqual(kinds, ['change', 'change', 'baseline'], 'one receipt per committed change, none duplicated');
    cm.close();
  });

  it('announces the branch\'s newest receipt to a journal that missed it, across later records without a receipt', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const real = cm.getStore();
    let landThenThrow = false;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appendJson') {
          return (type: string, payload: unknown) => {
            const written = target.appendJson(type, payload);
            if (landThenThrow) {
              landThenThrow = false;
              throw new Error('write reported failure after landing');
            }
            return written;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const a = new FoldJournal(flaky, 'agents/tester');
    const heard: string[] = [];
    a.onReceipt((r) => heard.push(r.id));
    const baseline = a.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    assert.equal(baseline?.kind, 'baseline');

    // A's change lands, but its append reports failure: A announces nothing.
    strategy.plan.set(ids[0]!, 'omit');
    const folded = (await cm.compile(BUDGET)).provenance!;
    landThenThrow = true;
    assert.throws(() => a.accept(folded, Date.now(), undefined), /after landing/);
    // Every journal here is on the one (wrapped) store object, as journals
    // on a store always are: Chronicle opens a store once.
    const change = new FoldJournal(flaky, 'agents/tester').query({ limit: 1 }).receipts[0]!;
    assert.equal(change.kind, 'change');

    // Another journal, with no listener, then records an unchanged layout
    // and an arrival: two newer records, neither with a receipt.
    const b = new FoldJournal(flaky, 'agents/tester');
    assert.equal(b.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined), null);
    add(cm, 1, 'late');
    assert.equal(b.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined), null);

    assert.equal(a.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined), null);
    assert.deepEqual(heard, [baseline!.id, change.id], 'A hears the change its own write left unannounced, once');
    assert.equal(a.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined), null);
    assert.deepEqual(heard, [baseline!.id, change.id]);

    // A journal opened later hears the branch's newest receipt too.
    const later = new FoldJournal(flaky, 'agents/tester');
    const laterHeard: string[] = [];
    later.onReceipt((r) => laterHeard.push(r.id));
    assert.equal(later.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined), null);
    assert.deepEqual(laterHeard, [change.id]);
    cm.close();
  });

  it('compares with the branch\'s newest record, whichever manager on the store wrote it', async () => {
    const { cm: a } = await open();
    const ids = add(a, 4);
    const narrowing = new ScriptedStrategy();
    const b = await ContextManager.open({ store: a.getStore(), strategy: narrowing, namespace: 'agents/tester' });
    assert.equal((await acceptCompile(a))?.kind, 'baseline');
    narrowing.plan.set(ids[0]!, 'omit');
    narrowing.plan.set(ids[1]!, 'omit');
    const narrowed = await acceptCompile(b);
    assert.deepEqual(narrowed?.changes?.map((c) => [c.before.form, c.after.form, c.messages]), [['raw', 'omitted', 2]]);
    const widened = await acceptCompile(a);
    assert.deepEqual(widened?.changes?.map((c) => [c.before.form, c.after.form, c.messages]), [['omitted', 'raw', 2]], "A compares with B's layout, not its own last one");
    const again = await acceptCompile(b);
    assert.deepEqual(again?.changes?.map((c) => [c.before.form, c.after.form]), [['raw', 'omitted']], "and B with A's");
    assert.equal(a.listFoldReceipts({ limit: 100 }).receipts.length, 4);
    b.close();
    a.close();
  });

  it('accepts a compile once: retries after a reopen write nothing, whether its acceptance changed the layout or not', async () => {
    let { cm, strategy } = await open();
    const ids = add(cm, 4);
    const first = (await cm.compile(BUDGET)).provenance!;
    assert.equal(cm.acceptRound({ provenance: first })?.kind, 'baseline');
    const unchanged = (await cm.compile(BUDGET)).provenance!;
    assert.equal(cm.acceptRound({ provenance: unchanged }), null, 'an identical layout makes no receipt');
    strategy.plan.set(ids[0]!, 'omit');
    const folded = (await cm.compile(BUDGET)).provenance!;
    assert.equal(cm.acceptRound({ provenance: folded })?.changes?.length, 1);
    cm.close();

    ({ cm, strategy } = await open());
    const receipts = cm.listFoldReceipts({ limit: 100 }).receipts;
    assert.deepEqual(receipts.map((r) => r.kind), ['change', 'baseline']);
    assert.equal(cm.acceptRound({ provenance: first })?.id, receipts[1]!.id, 'an older compile that wrote a receipt gets it back');
    assert.equal(cm.acceptRound({ provenance: unchanged }), null, 'an older compile whose layout was unchanged');
    assert.equal(cm.acceptRound({ provenance: folded })?.id, receipts[0]!.id, 'the newest');
    assert.deepEqual(cm.listFoldReceipts({ limit: 100 }).receipts.map((r) => r.id), receipts.map((r) => r.id), 'no false unfold, nothing written');
    strategy.plan.set(ids[0]!, 'omit');
    assert.equal(await acceptCompile(cm), null, "the branch's last accepted layout is still the folded one");
    cm.close();
  });

  it('finds a retried compile whatever ids its layout names, even ids newer than its acceptance', async () => {
    // A compile can name messages a crash then lost; after Chronicle truncates
    // the torn tail it reissues their ids to later records, so the compile's
    // acceptance can be older than ids its layout names.
    const { cm } = await open();
    const store = cm.getStore();
    const branch = cm.currentBranchRef();
    const records = () => store.getRecordIdsByType('context-manager/accepted-layout').length;
    const lost = '999999';
    const handMade = (compileId: string, units: LayoutUnit[]): CompileProvenance => ({
      compileId, namespace: 'agents/tester', branch, messages: [], strategy: 'hand',
      layout: { v: 2, members: [1], memberIds: [lost], units, totalTokens: 0, calibration: 1 },
    });
    const raw = handMade('before-crash', [{ k: 'r', t: 3 }]);
    const omitted = handMade('after-crash', [{ k: 'o', n: 1 }]);
    const journal = new FoldJournal(store, 'agents/tester');
    assert.equal(journal.accept(raw, Date.now(), undefined)?.kind, 'baseline');
    assert.deepEqual(journal.accept(omitted, Date.now(), undefined)?.changes?.map((c) => [c.before.form, c.after.form]), [['raw', 'omitted']]);
    assert.equal(records(), 2);
    const fresh = new FoldJournal(store, 'agents/tester');
    assert.equal(fresh.accept(raw, Date.now(), undefined)?.kind, 'baseline', 'no false omitted-to-raw receipt: its own baseline, back');
    assert.deepEqual(fresh.accept(omitted, Date.now(), undefined)?.changes?.map((c) => [c.before.form, c.after.form]), [['raw', 'omitted']]);
    assert.equal(records(), 2, 'both retries found their acceptance and wrote nothing');
    cm.close();
  });

  it('counts each first confirmation in acceptance order, including compiles made before an earlier one was accepted', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 4);
    await acceptCompile(cm);
    strategy.plan.set(ids[0]!, 'omit');
    const narrow = (await cm.compile(BUDGET)).provenance!;
    strategy.plan.delete(ids[0]!);
    const wide = (await cm.compile(BUDGET)).provenance!;
    assert.deepEqual(cm.acceptRound({ provenance: narrow })?.changes?.map((c) => [c.before.form, c.after.form]), [['raw', 'omitted']]);
    assert.deepEqual(cm.acceptRound({ provenance: wide })?.changes?.map((c) => [c.before.form, c.after.form]), [['omitted', 'raw']]);
    cm.close();
  });

  it('charges a summary to the first changed run that names it, even when an unchanged unit already renders it', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 5);
    // One summary covers all five; every message after the first is pinned raw.
    for (const id of ids) strategy.plan.set(id, { summary: 'S', level: 1 });
    for (const id of ids.slice(1)) strategy.pinned.add(id);
    const baseline = await acceptCompile(cm);
    assert.deepEqual(baseline?.layout?.map((r) => r.form.form), ['summary', 'raw']);
    const summaryTokens = baseline!.layout![0]!.estimatedTokens;
    assert.ok(summaryTokens > 0);

    // Unpin the third and the fifth: two changed runs, separated by a raw
    // message, both rendered through the summary the first unit renders.
    strategy.pinned.delete(ids[2]!);
    strategy.pinned.delete(ids[4]!);
    const r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.first.messageId, c.before.form, c.after.form]), [[ids[2], 'raw', 'summary'], [ids[4], 'raw', 'summary']]);
    assert.deepEqual(r?.changes?.map((c) => c.estimatedTokensAfter), [summaryTokens, 0], 'the summary counts once, in the first changed run');
    assert.ok(r!.changes!.every((c) => c.estimatedTokensBefore > 0));
    cm.close();
  });

  it('never puts receipt text into the compiled context', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    await acceptCompile(cm);
    strategy.plan.set(ids[0]!, 'omit');
    await acceptCompile(cm);
    const { messages } = await cm.compile(BUDGET);
    const text = JSON.stringify(messages);
    assert.doesNotMatch(text, /"kind":"(baseline|change)"|historyBefore|renderedTokens/);
    assert.equal(cm.listFoldReceipts().receipts.length, 2);
    cm.close();
  });
});

describe('compile provenance', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('names the raw bodies and summaries behind each compiled message, and spliced injections', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 4);
    strategy.plan.set(ids[0]!, { summary: 'L1-0', level: 1 });
    strategy.truncate.add(ids[2]!);
    const result = await cm.compile(BUDGET, [{ namespace: 'memory', position: 'afterUser', content: [{ type: 'text', text: 'note' }] }]);
    const p = result.provenance as CompileProvenance;
    assert.equal(p.messages.length, result.messages.length);
    const kinds = p.messages.map((m) => m.kind);
    assert.deepEqual(kinds, ['summary', 'summary', 'raw', 'raw', 'raw', 'injection']);
    const raw = p.messages.filter((m) => m.kind === 'raw') as Array<{ kind: 'raw'; bodies: Array<{ messageId: string; complete: boolean; missing?: string[] }> }>;
    assert.deepEqual(raw.map((m) => [m.bodies[0]!.messageId, m.bodies[0]!.complete]), [[ids[1], true], [ids[2], false], [ids[3], true]]);
    assert.deepEqual(raw[1]!.bodies[0]!.missing, ['content']);
    assert.equal(p.namespace, 'agents/tester');
    assert.equal(p.branch.name, cm.currentBranch().name);
    cm.close();
  });

  it('estimates layout tokens before calibration, so identical content costs the same at any calibration', async () => {
    const { cm } = await open();
    // Five blocks of two base tokens each: a calibrated estimate rounds each
    // block on its own (two becomes one at 0.7, two at 0.8).
    cm.addMessage('user', ['abcde', 'fghij', 'klmno', 'pqrst', 'uvwxy'].map((t): ContentBlock => ({ type: 'text', text: t })));
    const store = (cm as unknown as { messageStore: { setTokenCalibration(f: number): void } }).messageStore;
    const costs: Array<[number, number]> = [];
    for (const factor of [0.7, 0.8, 1]) {
      store.setTokenCalibration(factor);
      const layout = (await cm.compile(BUDGET)).provenance!.layout!;
      assert.equal(layout.calibration, factor);
      const unit = layout.units[0]!;
      assert.ok(unit.k === 'r');
      costs.push([unit.t, layout.totalTokens]);
    }
    assert.deepEqual(costs, [[10, 10], [10, 10], [10, 10]]);
    cm.close();
  });
});

/** Each accepted-layout record: its kind, and the bytes of its layout part. */
/**
 * Each accepted-layout record: `bytes` is its layout part (without the
 * receipt, namespace, branch and compile id), `stored` its whole payload,
 * and `json` the whole record as JSON, the size the byte rule counts.
 */
function layoutRecords(store: JsStore): Array<{ kind: string; bytes: number; stored: number; json: number; chain: number; sb: number; db: number; members: number }> {
  return store.getRecordIdsByType('context-manager/accepted-layout').map((id) => {
    const payload = store.getRecord(id)!.payload;
    const record = JSON.parse(payload.toString('utf8'));
    const { receipt: _receipt, ns: _ns, branch: _branch, compileId: _compileId, ...layout } = record;
    return {
      kind: record.kind, bytes: JSON.stringify(layout).length, stored: payload.length, json: Buffer.byteLength(JSON.stringify(record)),
      chain: record.chain, sb: record.sb, db: record.db, members: record.m ? decodeSequences(record.m).length : 0,
    };
  });
}

/**
 * The byte rule, chain by chain: the delta records after a snapshot never
 * outweigh it, and the next snapshot comes only once one more record would
 * have (so no snapshot is written early, by a count or otherwise). Sizes are
 * the records' JSON as context-manager measures it (the stored payload may
 * be serialized a few bytes differently).
 */
function assertSnapshotsAmortized(records: ReturnType<typeof layoutRecords>): void {
  const largest = Math.max(...records.filter((r) => r.kind === 'delta').map((r) => r.json));
  let snapshot = records[0]!;
  let since = 0;
  assert.equal(snapshot.json, snapshot.sb, 'a snapshot counts its own bytes exactly');
  for (const r of records.slice(1)) {
    if (r.kind === 'delta') {
      since += r.json;
      assert.equal(r.db, since, 'the deltas count their own bytes exactly');
      assert.ok(r.db <= r.sb, `the records since a snapshot never outweigh it: ${r.db} > ${r.sb}`);
      continue;
    }
    assert.equal(r.json, r.sb, 'a snapshot counts its own bytes exactly');
    // The record that tipped it went into the new snapshot, not a delta, so
    // allow it as up to twice the largest delta written.
    assert.ok(since + 2 * largest + 16 >= snapshot.json, `a snapshot comes only once the records since the last would outweigh it: ${since} + 2 x ${largest} < ${snapshot.json}`);
    snapshot = r;
    since = 0;
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('fold journal size', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('a window advancing over a growing omitted prefix costs the same each round, however long the history', async () => {
    // Anarchid's passthrough probe: one message and one accepted round per
    // turn, a 6k budget, other records between the messages (gapped
    // sequences, the journal's own records among them).
    const cm = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy(), namespace: 'agents/tester' });
    const store = cm.getStore();
    const budget: TokenBudget = { maxTokens: 6000, reserveForResponse: 0 };
    let filled = -1;
    for (let turn = 0; turn < 600; turn++) {
      cm.addMessage('user', [{ type: 'text', text: `turn ${turn} ${'word '.repeat(40)}` }]);
      if (turn % 3 === 0) store.appendJson('test/other-record', { turn });
      const result = await cm.compile(budget);
      if (filled < 0 && result.provenance!.layout!.units[0]!.k === 'o') filled = turn;
      cm.acceptRound({ provenance: result.provenance! });
    }
    assert.ok(filled > 50 && filled < 300, `the window filled (at turn ${filled})`);
    const records = layoutRecords(store);
    assert.equal(records.length, 600, 'one record per accepted round');
    const deltas = records.map((r, turn) => ({ ...r, turn })).filter((r) => r.kind === 'delta');
    const early = deltas.filter((r) => r.turn > filled + 20 && r.turn <= filled + 120).map((r) => r.bytes);
    const late = deltas.filter((r) => r.turn >= 500).map((r) => r.bytes);
    assert.ok(early.length > 50 && late.length > 50);
    assert.ok(Math.max(...late) <= 200, `a delta stays small: ${Math.max(...late)} bytes`);
    assert.ok(mean(late) <= mean(early) * 1.2 + 4, `deltas do not grow with the history: ${mean(early).toFixed(1)} then ${mean(late).toFixed(1)}`);
    const snapshots = records.filter((r) => r.kind === 'snapshot');
    assert.ok(snapshots.length >= 3, `several snapshot rollovers: ${snapshots.length}`);
    for (const snap of snapshots) {
      // Members at about a byte and a third each, plus the rendered units.
      assert.ok(snap.bytes <= snap.members * 2 + 2000, `snapshot of ${snap.members} members: ${snap.bytes} bytes`);
    }
    assertSnapshotsAmortized(records);
    // What each acceptance costs in all, snapshots included, stays flat as the
    // history grows: a late stretch costs no more per round than an early one.
    const perRound = (from: number, to: number) => records.slice(from, to).reduce((sum, r) => sum + r.stored, 0) / (to - from);
    const earlyPerRound = perRound(filled + 20, filled + 220);
    const latePerRound = perRound(400, 600);
    assert.ok(latePerRound <= earlyPerRound * 1.25, `stored bytes per acceptance don't grow with the history: ${earlyPerRound.toFixed(0)} then ${latePerRound.toFixed(0)}`);
    cm.close();
  });

  /**
   * A journal over this store whose syncs cost nothing: these tests are about
   * which records are written, and the sync order has its own test.
   */
  function fastJournal(cm: ContextManager): { journal: FoldJournal; records: () => Array<{ kind: string; chain: number; sb: number; db: number }> } {
    const real = cm.getStore();
    const fast = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'sync') return () => {};
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    return {
      journal: new FoldJournal(fast, 'agents/tester'),
      records: () => real.getRecordIdsByType('context-manager/accepted-layout')
        .map((id) => JSON.parse(real.getRecord(id)!.payload.toString('utf8')) as { kind: string; chain: number; sb: number; db: number }),
    };
  }

  it('writes a snapshot once the records since the last one would outweigh it', async () => {
    // A small window: each unchanged round writes a small delta record, so the
    // records soon outweigh the snapshot, and a rebuild never reads more than
    // about two snapshots' worth.
    const cm = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy(), namespace: 'agents/tester' });
    for (let i = 0; i < 10; i++) cm.addMessage('user', [{ type: 'text', text: `message ${i}` }]);
    const { journal } = fastJournal(cm);
    for (let round = 0; round < 60; round++) {
      journal.accept((await cm.compile({ maxTokens: 100_000, reserveForResponse: 0 })).provenance!, Date.now(), undefined);
    }
    const all = layoutRecords(cm.getStore());
    assert.ok(all.filter((r) => r.kind === 'snapshot').length >= 2, 'a later snapshot follows the first');
    assert.ok(all.filter((r) => r.kind === 'delta').length >= 20, 'and deltas between them');
    // Each delta counts its whole record, receipt and envelope included (the
    // counters' own digits aside: a record is measured before they're set).
    let since = 0;
    for (const r of all) {
      since = r.kind === 'snapshot' ? 0 : since + r.json;
      if (r.kind === 'delta') assert.ok(Math.abs(r.db - since) <= 8 * r.chain, `db counts the records since the snapshot: ${r.db} against ${since}`);
    }
    assertSnapshotsAmortized(all);
    cm.close();
  });

  it('a long chain of small deltas behind a large snapshot stays a chain, and rebuilds exactly after a reopen', async () => {
    // A history of 100,000 messages behind a raw window, sequences two apart,
    // and arrivals only (no fold, so no receipt). Its snapshot outweighs 300
    // small deltas, so no snapshot follows, however many deltas there are.
    let cm = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy(), namespace: 'agents/tester' });
    const branch = cm.currentBranchRef();
    const omitted = 99_950;
    let members = Array.from({ length: 100_000 }, (_, i) => 2 * (i + 1));
    let ids = members.map((m) => `m${m}`);
    const layoutOf = (tail?: LayoutUnit): RenderedLayout => ({
      v: 2, members, memberIds: ids, totalTokens: (members.length - omitted) * 10, calibration: 1,
      units: [
        { k: 'o', n: omitted },
        ...Array.from({ length: members.length - omitted - (tail ? 1 : 0) }, (): LayoutUnit => ({ k: 'r', t: 10 })),
        ...(tail ? [tail] : []),
      ],
    });
    const provenance = (layout: RenderedLayout): CompileProvenance => ({
      compileId: randomUUID(), namespace: 'agents/tester', branch, messages: [], layout, strategy: 'synthetic',
    });
    const { journal } = fastJournal(cm);
    journal.accept(provenance(layoutOf()), Date.now(), undefined);
    for (let round = 0; round < 300; round++) {
      const next = members.at(-1)! + 2;
      members = [...members, next];
      ids = [...ids, `m${next}`];
      journal.accept(provenance(layoutOf()), Date.now(), undefined);
    }
    const all = layoutRecords(cm.getStore());
    assert.deepEqual(all.map((r) => r.kind), ['snapshot', ...Array<string>(300).fill('delta')], 'no count of deltas forces a snapshot');
    assert.equal(all.at(-1)!.chain, 300);
    assert.ok(all.at(-1)!.db <= all.at(-1)!.sb, `${all.at(-1)!.db} of ${all.at(-1)!.sb}`);

    // The records rebuild the last layout exactly, members and units.
    const store = cm.getStore();
    const payloads = store.getRecordIdsByType('context-manager/accepted-layout').map((id) => JSON.parse(store.getRecord(id)!.payload.toString('utf8')));
    const rebuilt = applyLayoutChain({ members: decodeSequences(payloads[0].m), units: payloads[0].units }, payloads.slice(1));
    const written = layoutOf();
    assert.deepEqual(rebuilt, { members: written.members, units: written.units });

    // And a fresh store object's journal rebuilds it the same way: the newest
    // message turning omitted is one change, which it reports only when the
    // rebuild holds every arrival, and every unit in place.
    cm.close();
    cm = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy(), namespace: 'agents/tester' });
    const receipt = fastJournal(cm).journal.accept(provenance(layoutOf({ k: 'o', n: 1 })), Date.now(), undefined);
    assert.deepEqual(receipt?.changes?.map((c) => [c.first.sequence, c.last.sequence, c.before.form, c.after.form]),
      [[members.at(-1), members.at(-1), 'raw', 'omitted']]);
    cm.close();
  });

  it('a fold deep in a long history costs the units it changes, not the history', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 1200);
    // History in sixty summaries of twenty messages each, the newest 20 raw.
    const plan = (rename: number | null) => {
      for (let s = 0; s < 59; s++) {
        const id = s === rename ? `s${s}-renamed` : `s${s}`;
        for (let k = 0; k < 20; k++) strategy.plan.set(ids[s * 20 + k]!, { summary: id, level: 1 });
      }
    };
    plan(null);
    await acceptCompile(cm);
    plan(30);
    const receipt = await acceptCompile(cm);
    assert.equal(receipt?.changes?.length, 1, 'one summary replaced');
    assert.equal(receipt!.changes![0]!.messages, 20);
    const last = layoutRecords(cm.getStore()).at(-1)!;
    assert.equal(last.kind, 'delta');
    assert.ok(last.bytes <= 250, `one changed unit: ${last.bytes} bytes for a 1,200-message history`);
    cm.close();
  });

  it('a removed message costs one member in the delta, wherever it is', async () => {
    const { cm } = await open();
    const ids = add(cm, 400);
    await acceptCompile(cm);
    cm.removeMessage(ids[10]!);
    assert.equal(await acceptCompile(cm), null, 'a removal is not a fold');
    const last = layoutRecords(cm.getStore()).at(-1)!;
    assert.equal(last.kind, 'delta');
    // The record's fixed fields (format, kind, previous record, tokens,
    // chain and sizes) and one removed member: the history adds nothing.
    assert.ok(last.bytes <= 160, `${last.bytes} bytes`);
    cm.close();
  });

  it('encodes ascending sequences exactly, and refuses anything else', () => {
    const cases = [[], [0], [7], [1, 2, 3], [5, 130, 131, 20_000, 2 ** 40, 2 ** 52]];
    for (const seqs of cases) assert.deepEqual(decodeSequences(encodeSequences(seqs)), seqs);
    let x = 0;
    const gapped = Array.from({ length: 5000 }, (_, i) => (x += 1 + ((i * 7919) % 5)));
    const text = encodeSequences(gapped);
    assert.deepEqual(decodeSequences(text), gapped);
    assert.ok(text.length <= gapped.length * 1.4, `${text.length} chars for ${gapped.length} small gaps`);
    assert.throws(() => encodeSequences([3, 3]), /ascending/);
    assert.throws(() => encodeSequences([5, 4]), /ascending/);
    assert.throws(() => decodeSequences(Buffer.from([0x81]).toString('base64url')), /truncated/);
  });

  it('a delta rebuilds the next layout exactly, for random edits of members and units', () => {
    let seed = 12345;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const unit = (): LayoutUnit => {
      const k = rand(3);
      if (k === 0) return { k: 'r', t: rand(4) };
      if (k === 1) return { k: 's', n: 1 + rand(4), sm: [[`s${rand(3)}`, 1, 'm', 0, rand(5)]] };
      return { k: 'o', n: 1 + rand(4) };
    };
    const layout = (units: LayoutUnit[], pool: number[]): StoredLayout => {
      const count = units.reduce((n, u) => n + (u.k === 'r' ? 1 : u.n), 0);
      const members = [...pool].sort((a, b) => a - b).slice(0, count);
      while (members.length < count) members.push((members.at(-1) ?? 0) + 1 + rand(3));
      return { members, units };
    };
    let asserted = 0;
    for (let round = 0; round < 2000; round++) {
      const prevUnits = Array.from({ length: rand(8) + 1 }, unit);
      const nextUnits = rand(2) === 0 ? [...prevUnits.slice(0, rand(prevUnits.length + 1)), ...Array.from({ length: rand(4) }, unit), ...prevUnits.slice(rand(prevUnits.length))] : Array.from({ length: rand(8) + 1 }, unit);
      const pool = Array.from({ length: 60 }, () => rand(200));
      const unique = [...new Set(pool)];
      const prev = layout(prevUnits, unique.filter(() => rand(4) > 0));
      const next = layout(nextUnits, unique.filter(() => rand(4) > 0));
      assert.deepEqual(applyLayoutDelta(prev, layoutDelta(prev, next)), next, `round ${round}`);
      asserted++;
    }
    assert.equal(asserted, 2000, 'every pair of layouts has a delta');

    // A chain rebuilt in one pass equals the same deltas applied one at a time,
    // across chains that remove and re-add the same sequences.
    for (let chain = 0; chain < 200; chain++) {
      const pool = [...new Set(Array.from({ length: 40 }, () => rand(120)))];
      const layouts = Array.from({ length: 2 + rand(12) }, () => layout(Array.from({ length: rand(8) + 1 }, unit), pool.filter(() => rand(3) > 0)));
      const deltas = layouts.slice(1).map((l, i) => layoutDelta(layouts[i]!, l));
      let stepwise = layouts[0]!;
      for (const d of deltas) stepwise = applyLayoutDelta(stepwise, d);
      assert.deepEqual(stepwise, layouts.at(-1), `chain ${chain}, one at a time`);
      assert.deepEqual(applyLayoutChain(layouts[0]!, deltas), layouts.at(-1), `chain ${chain}, in one pass`);
    }
  });
});

describe('fold journal durability and index', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('syncs the state a record names before appending it, and the record before anyone hears of it', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const real = cm.getStore();
    const calls: string[] = [];
    const watched = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'sync') return () => { calls.push('sync'); target.sync(); };
        if (prop === 'appendJson') return (type: string, payload: unknown) => { calls.push(`append ${type}`); return target.appendJson(type, payload); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const journal = new FoldJournal(watched, 'agents/tester');
    journal.storeId();
    journal.onReceipt(() => calls.push('announce'));
    calls.length = 0;
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    assert.deepEqual(calls, ['sync', 'append context-manager/accepted-layout', 'sync', 'announce']);
    calls.length = 0;
    strategy.plan.set(ids[0]!, 'omit');
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    assert.deepEqual(calls, ['sync', 'append context-manager/accepted-layout', 'sync', 'announce']);
    cm.close();
  });

  it('a receipt whose sync failed after it landed is synced before it is announced', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const real = cm.getStore();
    const calls: string[] = [];
    let failNextSyncAfterAppend = false;
    let appended = false;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appendJson') return (type: string, payload: unknown) => { appended = true; calls.push('append'); return target.appendJson(type, payload); };
        if (prop === 'sync') {
          return () => {
            if (failNextSyncAfterAppend && appended) {
              failNextSyncAfterAppend = false;
              calls.push('sync failed');
              throw new Error('fsync failed');
            }
            calls.push('sync');
            target.sync();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const journal = new FoldJournal(flaky, 'agents/tester');
    journal.storeId();
    journal.onReceipt((r) => calls.push(`announce ${r.kind}`));
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    strategy.plan.set(ids[0]!, 'omit');
    calls.length = 0;
    const folded = (await cm.compile(BUDGET)).provenance!;
    appended = false;
    failNextSyncAfterAppend = true;
    assert.throws(() => journal.accept(folded, Date.now(), undefined), /fsync failed/);
    assert.deepEqual(calls, ['sync', 'append', 'sync failed'], 'the receipt landed, unannounced');
    calls.length = 0;
    assert.equal(journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined), null, 'the same layout: no new receipt');
    assert.deepEqual(calls.slice(0, 2), ['sync', 'announce change'], 'synced, then heard of');
    cm.close();
  });

  it('lists the store\'s records once, and reads only the receipts a query returns', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 40);
    const real = cm.getStore();
    let listings = 0;
    let reads = 0;
    const counted = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'getRecordIdsByType') return (type: string) => { if (type === 'context-manager/accepted-layout') listings++; return target.getRecordIdsByType(type); };
        if (prop === 'getRecord') return (id: string) => { reads++; return target.getRecord(id); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const journal = new FoldJournal(counted, 'agents/tester');
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    for (let i = 0; i < 30; i++) {
      strategy.plan.set(ids[i]!, 'omit');
      journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    }
    assert.equal(listings, 1, 'one listing, at first use; later records are added as they are written');
    reads = 0;
    const page = journal.query({ limit: 3 });
    assert.equal(page.receipts.length, 3);
    assert.equal(reads, 3, 'a query reads the receipts it returns, no others');
    assert.equal(journal.query({ limit: 100 }).receipts.length, 31);
    // A fresh journal on the same store object shares the index.
    const other = new FoldJournal(counted, 'agents/tester');
    assert.equal(other.query({ limit: 100 }).receipts.length, 31);
    assert.equal(listings, 1);
    cm.close();
  });

  it('after a reopen, an acceptance reads the records it needs, not the history', async () => {
    let { cm } = await open();
    add(cm, 4);
    const quiet = new FoldJournal(wrapStore(cm.getStore(), { sync: () => {} }), 'agents/tester');
    for (let i = 0; i < 200; i++) {
      add(cm, 1, `r${i}-`);
      quiet.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    }
    const before = layoutRecords(cm.getStore());
    assert.equal(before.length, 200);
    cm.close();

    ({ cm } = await open());
    const real = cm.getStore();
    let reads = 0;
    let listings = 0;
    let syncs = 0;
    const counted = wrapStore(real, {
      getRecord: (id: string) => { reads++; return real.getRecord(id); },
      getRecordIdsByType: (type: string) => { if (type === 'context-manager/accepted-layout') listings++; return real.getRecordIdsByType(type); },
      sync: () => { syncs++; real.sync(); },
    });
    const journal = new FoldJournal(counted, 'agents/tester');
    add(cm, 1, 'after-');
    const provenance = (await cm.compile(BUDGET)).provenance!;
    assert.equal(provenance.journalMark?.recordId, real.getRecordIdsByType('context-manager/accepted-layout').at(-1), 'the compile carries the newest durable record');
    reads = 0;
    assert.equal(journal.accept(provenance, Date.now(), undefined), null, 'an arrival');
    assert.equal(syncs, 3, 'one at first use, making the records present at open durable, then the two of the commit');
    // The newest record (for its branch, and its mark), the receipt to
    // announce, and the chain back to its snapshot: none of the history.
    const chain = before.at(-1)!.chain;
    assert.ok(reads <= chain + 6, `${reads} records read, with ${before.length} in the journal and a chain of ${chain}`);
    assert.equal(listings, 1);
    reads = 0;
    add(cm, 1, 'next-');
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    assert.ok(reads <= 2, `the next acceptance reads almost nothing: ${reads}`);
    cm.close();
  });

  it('looks for an earlier acceptance only after the compile\'s mark, unless the mark proves nothing', async () => {
    const { cm } = await open();
    add(cm, 3);
    for (let i = 0; i < 30; i++) {
      add(cm, 1, `r${i}-`);
      await acceptCompile(cm);
    }
    const real = cm.getStore();
    let reads = 0;
    const counted = wrapStore(real, { getRecord: (id: string) => { reads++; return real.getRecord(id); } });
    const fresh = new FoldJournal(counted, 'agents/tester');
    add(cm, 1, 'first-');
    fresh.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);

    // A compile not accepted before: only its mark and the records after it are read.
    add(cm, 1, 'marked-');
    const marked = (await cm.compile(BUDGET)).provenance!;
    assert.ok(marked.journalMark, 'a compile carries its mark');
    reads = 0;
    fresh.accept(marked, Date.now(), undefined);
    assert.ok(reads <= 2, `the mark and the record after it: ${reads} reads`);
    // With no mark, or one whose id now names another compile's record,
    // every record is read.
    add(cm, 1, 'unmarked-');
    const unmarked = (await cm.compile(BUDGET)).provenance!;
    reads = 0;
    fresh.accept({ ...unmarked, journalMark: null }, Date.now(), undefined);
    assert.ok(reads >= 32, `every record: ${reads} reads`);
    add(cm, 1, 'forged-');
    const forged = (await cm.compile(BUDGET)).provenance!;
    reads = 0;
    fresh.accept({ ...forged, journalMark: { recordId: forged.journalMark!.recordId, compileId: 'another-compile' } }, Date.now(), undefined);
    assert.ok(reads >= 33, `every record: ${reads} reads`);
    // And a retry under a mark that proves nothing, or is gone, still finds
    // its acceptance and writes nothing.
    const count = layoutRecords(real).length;
    assert.equal(fresh.accept({ ...marked, journalMark: { recordId: marked.journalMark!.recordId, compileId: 'another-compile' } }, Date.now(), undefined), null);
    assert.equal(fresh.accept({ ...marked, journalMark: { recordId: '999999999', compileId: 'x' } }, Date.now(), undefined), null);
    assert.equal(layoutRecords(real).length, count);
    cm.close();
  });

  it('acknowledges a retried acceptance only once its record is durable', async () => {
    const { cm } = await open();
    add(cm, 3);
    const real = cm.getStore();
    const calls: string[] = [];
    let failNextSyncAfterAppend = false;
    let appended = false;
    const flaky = wrapStore(real, {
      appendJson: (type: string, payload: unknown) => { appended = true; calls.push('append'); return real.appendJson(type, payload); },
      sync: () => {
        if (failNextSyncAfterAppend && appended) {
          failNextSyncAfterAppend = false;
          throw new Error('fsync failed');
        }
        calls.push('sync');
        real.sync();
      },
    });
    const journal = new FoldJournal(flaky, 'agents/tester');
    journal.storeId();
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);

    // An unchanged layout writes a record without a receipt; its sync fails
    // after the append, so the record is in the log, durable or not.
    const unchanged = (await cm.compile(BUDGET)).provenance!;
    appended = false;
    failNextSyncAfterAppend = true;
    assert.throws(() => journal.accept(unchanged, Date.now(), undefined), /fsync failed/);
    calls.length = 0;
    assert.equal(journal.accept(unchanged, Date.now(), undefined), null, 'found: its acceptance wrote no receipt');
    assert.deepEqual(calls, ['sync'], 'and synced before it is acknowledged');
    calls.length = 0;
    assert.equal(journal.accept(unchanged, Date.now(), undefined), null);
    assert.deepEqual(calls, [], 'known durable now, so no sync');

    // The same through another journal on the store object.
    const again = (await cm.compile(BUDGET)).provenance!;
    appended = false;
    failNextSyncAfterAppend = true;
    assert.throws(() => journal.accept(again, Date.now(), undefined), /fsync failed/);
    calls.length = 0;
    assert.equal(new FoldJournal(flaky, 'agents/tester').accept(again, Date.now(), undefined), null);
    assert.deepEqual(calls, ['sync']);
    cm.close();
  });

  it('refuses a compile of another namespace, and writes nothing', async () => {
    const { cm } = await open();
    add(cm, 2);
    const provenance = (await cm.compile(BUDGET)).provenance!;
    assert.throws(() => new FoldJournal(cm.getStore(), 'agents/other').accept(provenance, Date.now(), undefined),
      /namespace "agents\/tester" can't be accepted by the manager of "agents\/other"/);
    const other = await ContextManager.open({ store: cm.getStore(), strategy: new ScriptedStrategy(), namespace: 'agents/other' });
    assert.throws(() => other.acceptRound({ provenance }), /accept it on the manager that compiled it/);
    assert.equal(layoutRecords(cm.getStore()).length, 0);
    other.close();
    cm.close();
  });

  it('a branch whose newest record cannot be read gets a baseline, never a diff against an older layout', async () => {
    let { cm, strategy } = await open();
    const ids = add(cm, 3);
    const branch = cm.currentBranchRef();
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      assert.equal((await acceptCompile(cm))?.kind, 'baseline');
      strategy.plan.set(ids[0]!, 'omit');
      // A newer format's record (as after a rollback past it), then a broken
      // chain, then a chain that rebuilds into members its units don't cover.
      const cases: Array<[string, Record<string, unknown>]> = [
        ['another format', { v: 99, ns: 'agents/tester', branch, compileId: 'newer-format', kind: 'snapshot' }],
        ['a broken chain', { v: 3, ns: 'agents/tester', branch, compileId: 'broken-chain', kind: 'delta', prev: '987654321', p: 0, totalTokens: 0, chain: 1, sb: 10_000, db: 10 }],
        ['members its units do not cover', { v: 3, ns: 'agents/tester', branch, compileId: 'ill-formed', kind: 'snapshot', m: encodeSequences([1, 2, 3]), units: [{ k: 'r', t: 1 }], totalTokens: 0, chain: 0, sb: 100, db: 0 }],
      ];
      for (const [what, record] of cases) {
        // Written outside this journal, as a record a past process left.
        cm.getStore().appendJson('context-manager/accepted-layout', record);
        cm.close();
        ({ cm } = await open(strategy));
        const receipt = await acceptCompile(cm);
        assert.equal(receipt?.kind, 'baseline', `${what}: a baseline`);
        assert.ok(errors.some((e) => e.includes('is unreadable')), `${what}: and it is reported`);
        errors.length = 0;
      }
    } finally {
      console.error = error;
    }
    cm.close();
  });

  it('a compile never fails because the journal cannot be read: it carries no mark, and a later compile tries again', async () => {
    let { cm } = await open();
    add(cm, 3);
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    cm.close();

    const real = JsStore.openOrCreate({ path: STORE });
    let failSync = false;
    const flaky = wrapStore(real, { sync: () => { if (failSync) throw new Error('EIO (injected)'); real.sync(); } });
    cm = await ContextManager.open({ store: flaky, strategy: new ScriptedStrategy(), namespace: 'agents/tester' });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      failSync = true;
      const first = await cm.compile(BUDGET);
      assert.equal(first.provenance?.journalMark, null, 'the compile stands, without a mark');
      await cm.compile(BUDGET);
      assert.equal(errors.filter((e) => e.includes("can't tell where the journal stands")).length, 1, 'reported once');
      failSync = false;
      const later = await cm.compile(BUDGET);
      assert.equal(later.provenance?.journalMark?.recordId, real.getRecordIdsByType('context-manager/accepted-layout').at(-1), 'the index was not kept half-built: the next compile has its mark');
    } finally {
      console.error = error;
      cm.close();
    }
  });

  it('reads the records present at open at most once, however many branches and namespaces look', async () => {
    let { cm } = await open();
    add(cm, 3);
    const quiet = new FoldJournal(wrapStore(cm.getStore(), { sync: () => {} }), 'agents/tester');
    for (let i = 0; i < 60; i++) {
      add(cm, 1, `r${i}-`);
      quiet.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    }
    cm.close();
    ({ cm } = await open());
    const real = cm.getStore();
    let reads = 0;
    const counted = wrapStore(real, { getRecord: (id: string) => { reads++; return real.getRecord(id); } });
    // Two namespaces new to the store: the first reads the history, the second nothing more of it.
    const first = await ContextManager.open({ store: counted, strategy: new ScriptedStrategy(), namespace: 'agents/first' });
    const second = await ContextManager.open({ store: counted, strategy: new ScriptedStrategy(), namespace: 'agents/second' });
    for (const m of [first, second]) m.addMessage('user', [{ type: 'text', text: 'hello' }]);
    reads = 0;
    assert.equal((await acceptCompile(first))?.kind, 'baseline');
    const firstReads = reads;
    assert.ok(firstReads >= 60, `the first new namespace reads the history: ${firstReads}`);
    reads = 0;
    assert.equal((await acceptCompile(second))?.kind, 'baseline');
    assert.ok(reads <= 3, `the second reads none of it again: ${reads}`);
    // The branch the history holds was noted on the way: it still compares
    // with its newest record, not as unrecorded.
    const original = await ContextManager.open({ store: counted, strategy: new ScriptedStrategy(), namespace: 'agents/tester' });
    original.addMessage('user', [{ type: 'text', text: 'and more' }]);
    assert.equal(await acceptCompile(original), null, 'an arrival, compared with the branch\'s newest record');
    original.close();
    // A deleted branch looked up by name, twice: answered from what was noted.
    reads = 0;
    assert.match(first.listFoldReceipts({ branch: 'no-such-branch' }).note ?? '', /No branch named/);
    assert.match(first.listFoldReceipts({ branch: 'no-such-branch' }).note ?? '', /No branch named/);
    assert.equal(reads, 0, 'no record read for a name');
    first.close();
    second.close();
    cm.close();
  });

  it('a receipt is durable before a query hands it out', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const real = cm.getStore();
    const calls: string[] = [];
    let failNextSyncAfterAppend = false;
    let appended = false;
    const flaky = wrapStore(real, {
      appendJson: (type: string, payload: unknown) => { appended = true; return real.appendJson(type, payload); },
      sync: () => {
        if (failNextSyncAfterAppend && appended) { failNextSyncAfterAppend = false; throw new Error('fsync failed'); }
        calls.push('sync');
        real.sync();
      },
    });
    const journal = new FoldJournal(flaky, 'agents/tester');
    journal.storeId();
    journal.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    strategy.plan.set(ids[0]!, 'omit');
    const folded = (await cm.compile(BUDGET)).provenance!;
    appended = false;
    failNextSyncAfterAppend = true;
    assert.throws(() => journal.accept(folded, Date.now(), undefined), /fsync failed/);
    calls.length = 0;
    const listed = journal.query({ limit: 10 });
    assert.equal(listed.receipts[0]?.kind, 'change', 'the landed receipt is listed');
    assert.deepEqual(calls, ['sync'], 'after a sync');
    calls.length = 0;
    journal.query({ limit: 10 });
    assert.deepEqual(calls, [], 'and only once');
    cm.close();
  });

  it('a newest record that cannot be read at all, or is a well-formed record of another format, gives a baseline', async () => {
    let { cm, strategy } = await open();
    const ids = add(cm, 3);
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    strategy.plan.set(ids[0]!, 'omit');
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      // A record with no envelope at all, then a format-2 copy of a real record.
      const real = layoutRecords(cm.getStore());
      const newest = JSON.parse(cm.getStore().getRecord(cm.getStore().getRecordIdsByType('context-manager/accepted-layout').at(-1)!)!.payload.toString('utf8'));
      const cases: Array<[string, unknown]> = [
        ['no envelope', { hello: 'world' }],
        ['format 2', { ...newest, v: 2, compileId: 'older-format' }],
      ];
      assert.ok(real.length > 0);
      for (const [what, record] of cases) {
        cm.getStore().appendJson('context-manager/accepted-layout', record);
        cm.close();
        ({ cm } = await open(strategy));
        assert.equal((await acceptCompile(cm))?.kind, 'baseline', `${what}: a baseline`);
        assert.ok(errors.some((e) => /unreadable|treating the branch as unrecorded/.test(e)), `${what}: reported`);
        errors.length = 0;
        // Another round compares with the baseline just written, and the
        // record that couldn't be read lends the branch no receipts.
        strategy.plan.set(ids[1]!, strategy.plan.get(ids[1]!) === 'omit' ? 'raw' : 'omit');
        assert.equal((await acceptCompile(cm))?.kind, 'change', `${what}: then changes again`);
        assert.equal(cm.listFoldReceipts({ limit: 10 }).note, undefined, `${what}: every listed receipt reads`);
      }
    } finally {
      console.error = error;
    }
    cm.close();
  });

  it('reports a record the store no longer has as missing, not as damaged', async () => {
    const { cm } = await open();
    add(cm, 2);
    await acceptCompile(cm);
    add(cm, 1, 'n');
    await acceptCompile(cm);
    const real = cm.getStore();
    const gone = real.getRecordIdsByType('context-manager/accepted-layout').at(-1)!;
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      // As after a rot: the id is listed, but the store has no record for it.
      const journal = new FoldJournal(wrapStore(real, { getRecord: (id: string) => (id === gone ? null : real.getRecord(id)) }), 'agents/tester');
      journal.query({ limit: 10 });
      assert.ok(errors.some((e) => e.includes(`accepted-layout record ${gone} is missing`)), errors.join('\n'));
      assert.ok(!errors.some((e) => e.includes(`record ${gone} is unreadable`)), 'not reported as damaged');
    } finally {
      console.error = error;
    }
    cm.close();
  });

  it('a store whose identity record cannot be read mints a new id, says so, and keeps it', async () => {
    let { cm } = await open();
    cm.getStore().appendJson('context-manager/store-identity', { v: 1 });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let minted: string;
    try {
      minted = cm.getStoreId();
      assert.ok(errors.some((e) => e.includes("identity record") && e.includes("can't be read") && e.includes(minted)), errors.join('\n'));
    } finally {
      console.error = error;
    }
    cm.close();
    ({ cm } = await open());
    assert.equal(cm.getStoreId(), minted!, 'the new id is the store\'s from then on');
    cm.close();
  });

  it('listing says when the newest record, unreadable or of another format, may hide receipts', async () => {
    let { cm, strategy } = await open();
    add(cm, 3);
    const baseline = await acceptCompile(cm);
    assert.equal(baseline?.kind, 'baseline');
    const layoutIds = () => cm.getStore().getRecordIdsByType('context-manager/accepted-layout');
    const error = console.error;
    console.error = () => {};
    try {
      // An unreadable record above the branch's newest readable one: the
      // readable history is listed, and the note says what may be missing.
      const newest = JSON.parse(cm.getStore().getRecord(layoutIds().at(-1)!)!.payload.toString('utf8'));
      cm.getStore().appendJson('context-manager/accepted-layout', { hello: 'world' });
      const unreadable = layoutIds().at(-1)!;
      cm.close();
      ({ cm } = await open(strategy));
      let listed = cm.listFoldReceipts({ limit: 10 });
      assert.deepEqual(listed.receipts.map((r) => r.id), [baseline!.id], 'the readable receipts are listed');
      assert.match(listed.note ?? '', new RegExp(`Record ${unreadable}, newer than this branch's newest readable record, can't be read`));
      // A newest record of another format: its links aren't read, so nothing
      // is listed, and the note says why.
      cm.getStore().appendJson('context-manager/accepted-layout', { ...newest, v: 2, compileId: 'older-format' });
      const other = layoutIds().at(-1)!;
      cm.close();
      ({ cm } = await open(strategy));
      listed = cm.listFoldReceipts({ limit: 10 });
      assert.deepEqual(listed.receipts, []);
      assert.match(listed.note ?? '', new RegExp(`newest record, ${other}, is of another format`));
    } finally {
      console.error = error;
    }
    cm.close();
  });

  it('a compile that renders a summary its strategy cannot describe has no layout, records nothing, and is reported once per summary', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    strategy.plan.set(ids[0]!, { summary: 's1', level: 1 });
    strategy.undescribed.add('s1');
    const layoutCount = () => cm.getStore().getRecordIdsByType('context-manager/accepted-layout').length;
    const before = layoutCount();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      for (let i = 0; i < 2; i++) {
        const { provenance } = await cm.compile(BUDGET);
        assert.equal(provenance?.layout, null, 'no layout is reported');
        assert.equal(provenance?.journalMark, undefined, 'so no mark is asked for');
        assert.equal(cm.acceptRound({ provenance: provenance! }), null, 'and nothing is recorded');
      }
      assert.equal(layoutCount(), before, 'nothing written');
      assert.equal(warnings.filter((w) => w.includes('cannot describe') && w.includes('s1')).length, 1, 'reported once for that summary');
      // Described again, the next compile records its layout, and its receipt
      // carries the change since the last layout recorded.
      strategy.undescribed.delete('s1');
      const receipt = await acceptCompile(cm);
      assert.equal(receipt?.kind, 'change');
      assert.ok(receipt?.changes?.some((c) => c.after.form === 'summary'), 'the summary the dropped compiles rendered');
    } finally {
      console.warn = warn;
    }
    cm.close();
  });

  it('a chain that leaves its branch gives a baseline', async () => {
    let { cm, strategy } = await open();
    add(cm, 3);
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    const main = cm.currentBranchRef();
    await cm.fork('side');
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    const sideId = cm.getStore().getRecordIdsByType('context-manager/accepted-layout').at(-1)!;
    await cm.switchBranch(main.name);
    add(cm, 1, 'arrival-');
    assert.equal(await acceptCompile(cm), null, 'an arrival, written as a delta');
    // Main's newest delta, copied with its link moved onto the side branch's record.
    const store = cm.getStore();
    const newest = JSON.parse(store.getRecord(store.getRecordIdsByType('context-manager/accepted-layout').at(-1)!)!.payload.toString('utf8'));
    assert.equal(newest.kind, 'delta');
    store.appendJson('context-manager/accepted-layout', { ...newest, compileId: 'foreign-link', prev: sideId });
    const error = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      cm.close();
      ({ cm } = await open(strategy));
      assert.equal((await acceptCompile(cm))?.kind, 'baseline');
      assert.ok(errors.some((e) => e.includes('another namespace or branch')));
    } finally {
      console.error = error;
    }
    cm.close();
  });

  it('a query whose history is cut short by an unreadable link says so', async () => {
    let { cm, strategy } = await open();
    const ids = add(cm, 4);
    assert.equal((await acceptCompile(cm))?.kind, 'baseline');
    strategy.plan.set(ids[0]!, 'omit');
    assert.equal((await acceptCompile(cm))?.kind, 'change');
    strategy.plan.set(ids[1]!, 'omit');
    const newest = await acceptCompile(cm);
    const record = JSON.parse(cm.getStore().getRecord(newest!.id)!.payload.toString('utf8'));
    // A newest receipt whose link names no record, and then one whose link
    // points forward, past itself.
    for (const [what, pr] of [['a link to no record', '0'], ['a link forward', '999999999']] as const) {
      cm.getStore().appendJson('context-manager/accepted-layout', { ...record, compileId: `cut-${pr}`, pr });
      const cutAt = cm.getStore().getRecordIdsByType('context-manager/accepted-layout').at(-1)!;
      cm.close();
      ({ cm } = await open(strategy));
      const result = cm.listFoldReceipts({ limit: 10 });
      assert.equal(result.receipts.length, 1, what);
      assert.match(
        result.note ?? '',
        pr === '0'
          ? /aren't listed: record 0, which links to them, can't be read as a receipt/
          : new RegExp(`aren't listed: record ${cutAt} links to ${pr}, which isn't before it`),
        what,
      );
    }
    // A newest record with no receipt whose link names no record: nothing is
    // listed, and the note doesn't read as if the newest were.
    const { receipt: _receipt, ...noReceipt } = record;
    cm.getStore().appendJson('context-manager/accepted-layout', { ...noReceipt, compileId: 'cut-empty', pr: '0' });
    cm.close();
    ({ cm } = await open(strategy));
    const empty = cm.listFoldReceipts({ limit: 10 });
    assert.deepEqual(empty.receipts, []);
    assert.match(empty.note ?? '', /^No receipts are listed: record 0, where the branch's receipts start, can't be read as a receipt\./);
    cm.close();
  });

  it('caps a query at 100 receipts, with more to come', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 2);
    const quiet = new FoldJournal(wrapStore(cm.getStore(), { sync: () => {} }), 'agents/tester');
    for (let i = 0; i < 102; i++) {
      strategy.plan.set(ids[0]!, i % 2 === 0 ? 'omit' : 'raw');
      quiet.accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    }
    const listed = quiet.query({ limit: 500 });
    assert.equal(listed.receipts.length, 100);
    assert.equal(listed.more, true);
    cm.close();
  });

  it('refuses a since time without its offset, which would be read in the host zone', async () => {
    const { cm } = await open();
    add(cm, 2);
    await acceptCompile(cm);
    assert.throws(() => cm.listFoldReceipts({ since: '2026-10-09T14:00:00' }), /Give its offset/);
    assert.equal(cm.listFoldReceipts({ since: '2026-10-09' }).receipts.length, 1, 'a date is midnight UTC');
    assert.equal(cm.listFoldReceipts({ since: '2026-10-09T14:00:00+02:00' }).receipts.length, 1);
    cm.close();
  });

  it('a listener that accepts another round inside an acceptance leaves the journal whole', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    const real = cm.getStore();
    let failNextSyncAfterAppend = false;
    let appended = false;
    const flaky = wrapStore(real, {
      appendJson: (type: string, payload: unknown) => { appended = true; return real.appendJson(type, payload); },
      sync: () => {
        if (failNextSyncAfterAppend && appended) { failNextSyncAfterAppend = false; throw new Error('fsync failed'); }
        real.sync();
      },
    });
    // Another journal's receipt, which this journal will announce at its next acceptance.
    new FoldJournal(flaky, 'agents/tester').accept((await cm.compile(BUDGET)).provenance!, Date.now(), undefined);
    const journal = new FoldJournal(flaky, 'agents/tester');
    strategy.plan.set(ids[0]!, 'omit');
    const inner = (await cm.compile(BUDGET)).provenance!;
    strategy.plan.set(ids[1]!, 'omit');
    const outer = (await cm.compile(BUDGET)).provenance!;
    let entered = false;
    journal.onReceipt(() => {
      if (entered) return;
      entered = true;
      appended = false;
      failNextSyncAfterAppend = true;
      journal.accept(inner, Date.now(), undefined); // its write lands, then its sync fails
    });
    const error = console.error;
    console.error = () => {};
    let outerReceipt: FoldReceipt | null;
    try {
      outerReceipt = journal.accept(outer, Date.now(), undefined);
    } finally {
      console.error = error;
    }
    assert.ok(entered);
    const before = layoutRecords(real).length;
    const innerAgain = journal.accept(inner, Date.now(), undefined);
    assert.equal(layoutRecords(real).length, before, 'the inner acceptance is found, not written again');
    assert.equal(innerAgain?.kind, 'change');
    assert.deepEqual(outerReceipt?.changes?.map((c) => c.first.messageId), [ids[1]], 'the outer round compares with the inner one');
    cm.close();
  });

  it('a store id found rather than minted is made durable before it is handed out', async () => {
    const { cm } = await open();
    const minted = cm.getStoreId();
    const real = cm.getStore();
    const calls: string[] = [];
    const watched = wrapStore(real, { sync: () => { calls.push('sync'); real.sync(); } });
    const journal = new FoldJournal(watched, 'agents/tester');
    assert.equal(journal.storeId(), minted);
    assert.deepEqual(calls, ['sync']);
    assert.equal(journal.storeId(), minted);
    assert.deepEqual(calls, ['sync'], 'once per store object');
    cm.close();
  });
});
