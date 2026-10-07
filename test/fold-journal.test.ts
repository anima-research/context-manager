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
import { ContextManager, FOLD_RECEIPT_RECORD } from '../src/index.js';
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
  cause: string | undefined;

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  select(store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] {
    const entries: ContextEntry[] = [];
    const emitted = new Set<string>();
    for (const msg of store.getAll()) {
      const form = this.plan.get(msg.id) ?? 'raw';
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
    assert.equal(r?.changes?.[0]?.messages, undefined, 'summary-to-summary runs carry no exact count');

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
    assert.equal(cm.foldReceiptsFor(main).length, 1);

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

  it('filters by since (id or ISO time) and limit, newest first, and validates limit', async () => {
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
    const since = cm.listFoldReceipts({ since: all.receipts[2]!.id });
    assert.deepEqual(since.receipts.map((r) => r.id), all.receipts.slice(0, 2).map((r) => r.id));
    assert.equal(cm.listFoldReceipts({ since: '2000-01-01T00:00:00Z' }).receipts.length, 5);
    assert.equal(cm.listFoldReceipts({ since: '2999-01-01T00:00:00Z' }).receipts.length, 0);
    assert.equal(cm.listFoldReceipts({ limit: 500 }).receipts.length, 5, 'capped, not refused');
    assert.throws(() => cm.listFoldReceipts({ limit: 0 }), /positive integer/);
    assert.throws(() => cm.listFoldReceipts({ since: 'yesterday' }), /receipt id or an ISO time/);
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

  it('never puts receipt text into the compiled context', async () => {
    const { cm, strategy } = await open();
    const ids = add(cm, 3);
    await acceptCompile(cm);
    strategy.plan.set(ids[0]!, 'omit');
    await acceptCompile(cm);
    const { messages } = await cm.compile(BUDGET);
    const text = JSON.stringify(messages);
    assert.doesNotMatch(text, /"kind":"(baseline|change)"|historyBefore|renderedTokens/);
    assert.equal(cm.getStore().getRecordIdsByType(FOLD_RECEIPT_RECORD).length, 2);
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
});
