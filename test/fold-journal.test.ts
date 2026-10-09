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
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy } from '../src/index.js';
import { FoldJournal, applyLayoutDelta, decodeSequences, encodeSequences, layoutDelta } from '../src/fold-journal.js';
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
    assert.equal(cm.acceptRound({ provenance: second.provenance! }), null, 'a later round of the same compile adds nothing');
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

  it('reconstructs a long delta chain exactly across a restart', async () => {
    let { cm, strategy } = await open();
    add(cm, 2);
    await acceptCompile(cm);
    for (let i = 0; i < 70; i++) {
      add(cm, 1, `t${i}-`);
      await acceptCompile(cm);
    }
    cm.close();
    ({ cm, strategy } = await open());
    const all = cm.getAllMessages();
    strategy.plan.set(all[40]!.id, 'omit');
    const r = await acceptCompile(cm);
    assert.deepEqual(r?.changes?.map((c) => [c.first.messageId, c.before.form, c.after.form]), [[all[40]!.id, 'raw', 'omitted']]);
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
    assert.equal(journal.accept(first, Date.now(), undefined)?.kind, 'baseline', 'the retry writes the baseline once');
    assert.equal(journal.accept(first, Date.now(), undefined), null);

    strategy.plan.set(ids[0]!, 'omit');
    const second = (await cm.compile(BUDGET)).provenance!;
    const announced: string[] = [];
    journal.onReceipt((r) => announced.push(r.id));
    mode = 'landed';
    assert.throws(() => journal.accept(second, Date.now(), undefined), /after landing/);
    assert.deepEqual(announced, [], 'nothing announced while the write is uncertain');
    mode = 'ok';
    const retry = new FoldJournal(flaky, 'agents/tester');
    assert.equal(journal.accept(second, Date.now(), undefined), null, 'the landed record is found on reread');
    assert.equal(announced.length, 1, 'and its receipt is announced once, so a projection converges');
    assert.equal(journal.accept(second, Date.now(), undefined), null);
    assert.equal(announced.length, 1, 'never twice');
    assert.equal(retry.accept(second, Date.now(), undefined), null, 'a fresh journal finds it too');

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
    assert.equal(cm.acceptRound({ provenance: first }), null, 'an older compile that wrote a receipt');
    assert.equal(cm.acceptRound({ provenance: unchanged }), null, 'an older compile whose layout was unchanged');
    assert.equal(cm.acceptRound({ provenance: folded }), null, 'the newest');
    assert.deepEqual(cm.listFoldReceipts({ limit: 100 }).receipts.map((r) => r.kind), ['change', 'baseline'], 'no false unfold');
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
    assert.equal(fresh.accept(raw, Date.now(), undefined), null, 'no false omitted-to-raw receipt');
    assert.equal(fresh.accept(omitted, Date.now(), undefined), null);
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
function layoutRecords(store: JsStore): Array<{ kind: string; bytes: number; chain: number; members: number }> {
  return store.getRecordIdsByType('context-manager/accepted-layout').map((id) => {
    const record = JSON.parse(store.getRecord(id)!.payload.toString('utf8'));
    const { receipt: _receipt, ns: _ns, branch: _branch, compileId: _compileId, ...layout } = record;
    return { kind: record.kind, bytes: JSON.stringify(layout).length, chain: record.chain, members: record.m ? decodeSequences(record.m).length : 0 };
  });
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
    for (const snap of snapshots) {
      // Members at about a byte and a third each, plus the rendered units.
      assert.ok(snap.bytes <= snap.members * 2 + 2000, `snapshot of ${snap.members} members: ${snap.bytes} bytes`);
    }
    const total = records.reduce((sum, r) => sum + r.bytes, 0);
    const deltaTotal = deltas.reduce((sum, r) => sum + r.bytes, 0);
    assert.ok(total <= 3 * deltaTotal + 4 * 2000, `snapshots cost about what the deltas since them do: ${total} bytes in all, ${deltaTotal} in deltas`);
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

  it('writes a snapshot once the deltas since the last one would outweigh it', async () => {
    // A small window: each unchanged round writes a small delta, so the deltas
    // soon outweigh the snapshot, and a rebuild never reads more than about
    // two snapshots' worth.
    const cm = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy(), namespace: 'agents/tester' });
    for (let i = 0; i < 10; i++) cm.addMessage('user', [{ type: 'text', text: `message ${i}` }]);
    const { journal, records } = fastJournal(cm);
    for (let round = 0; round < 60; round++) {
      journal.accept((await cm.compile({ maxTokens: 100_000, reserveForResponse: 0 })).provenance!, Date.now(), undefined);
    }
    const all = records();
    assert.ok(all.filter((r) => r.kind === 'snapshot').length >= 2, 'a later snapshot follows the first');
    for (const r of all.filter((x) => x.kind === 'delta')) {
      assert.ok(r.db <= r.sb, `the deltas since a snapshot never outweigh it: ${r.db} > ${r.sb}`);
    }
    cm.close();
  });

  it('writes a snapshot after 256 deltas, however small they are', async () => {
    // A window large enough that unchanged rounds would take hundreds more
    // deltas to outweigh its snapshot: the chain cap bounds a rebuild instead.
    const cm = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy(), namespace: 'agents/tester' });
    for (let i = 0; i < 200; i++) cm.addMessage('user', [{ type: 'text', text: `message ${i}` }]);
    const { journal, records } = fastJournal(cm);
    for (let round = 0; round < 258; round++) {
      journal.accept((await cm.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).provenance!, Date.now(), undefined);
    }
    const all = records();
    assert.equal(all[256]!.chain, 256, 'the 256th delta');
    assert.ok(all[256]!.db * 1.25 < all[256]!.sb, `far from outweighing the snapshot: ${all[256]!.db} of ${all[256]!.sb}`);
    assert.equal(all[257]!.kind, 'snapshot', 'then a snapshot all the same');
    assert.equal(all.filter((r) => r.kind === 'snapshot').length, 2);
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
    for (let round = 0; round < 2000; round++) {
      const prevUnits = Array.from({ length: rand(8) + 1 }, unit);
      const nextUnits = rand(2) === 0 ? [...prevUnits.slice(0, rand(prevUnits.length + 1)), ...Array.from({ length: rand(4) }, unit), ...prevUnits.slice(rand(prevUnits.length))] : Array.from({ length: rand(8) + 1 }, unit);
      const pool = Array.from({ length: 60 }, () => rand(200));
      const unique = [...new Set(pool)];
      const prev = layout(prevUnits, unique.filter(() => rand(4) > 0));
      const next = layout(nextUnits, unique.filter(() => rand(4) > 0));
      const delta = layoutDelta(prev, next);
      if (!delta) continue;
      assert.deepEqual(applyLayoutDelta(prev, delta), next, `round ${round}`);
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
});
