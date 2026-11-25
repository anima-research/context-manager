import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { Membrane, MockAdapter, OpenAIResponsesFormatter, type ContentBlock } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy, HistoryMutationError, KnowledgeStrategy, MessageStore, PassthroughStrategy } from '../src/index.js';
import type { HistoryMutationManifest, HistoryMutationOp, HistoryMutationPlan, SummaryEntry } from '../src/index.js';
import { markStoreBranchSwitch } from '../src/branch-generation.js';
import { residentStrategyOptions } from '../scripts/resident-settings.js';

const dir = mkdtempSync(join(tmpdir(), 'history-mutation-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const NS = 'agents/Ada';
const RESIDENT = {
  ...residentStrategyOptions({ mergeThreshold: 3, headWindowTokens: 0, recentWindowTokens: 0, compressionRefusalCurveFallbacks: 0, l1HoldbackChunks: 0 }, 'same-model', 'Ada'),
  targetChunkTokens: 100, quarantineAlarmIntervalMs: 0, mergeAttemptLimit: 1, recallEnvelope: 'xml',
};
type ViewStore = JsStore & { view(branch: string): JsStore };

class AnswerOf extends AutobiographicalStrategy {
  answer(id: string): ContentBlock[] {
    return this.summaryAnswerContent(this.summaries.find((s) => s.id === id)!);
  }

  price(id: string): { estimate: number; cost: number } {
    return this.recallAnswerCost(this.summaries.find((s) => s.id === id)!);
  }

  freshPrice(id: string): number {
    return this.estimateTokens(this.liveWindowAnswerContent(this.summaries.find((s) => s.id === id)!));
  }

  takeUpEditor(id: string, by: string): void {
    const summary = this.summaries.find((s) => s.id === id)!;
    summary.external = { by, at: 0 };
  }
}

let minted = 0;
const membrane = {
  complete: async () => ({
    stopReason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'thinking it over', signature: 'sig' }, { type: 'text', text: `native memory ${minted++}` }],
    usage: { inputTokens: 100, outputTokens: 30 },
  }),
} as never;

let stores = 0;
async function residentStore(): Promise<string> {
  const path = join(dir, `store-${stores++}`);
  const first = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, mergeThreshold: 99 } as never), membrane });
  for (let i = 0; i < 40; i++) first.addMessage(i % 2 ? 'Ada' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
  await first.compile();
  for (let i = 0; i < 12; i++) await first.tick();
  first.close();
  const second = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy(RESIDENT as never), membrane });
  await second.tick();
  second.close();
  return path;
}

const NS_B = 'agents/Bea';

async function twoResidentStore(): Promise<string> {
  const path = join(dir, `store-${stores++}`);
  const strategy = () => new AutobiographicalStrategy({ ...RESIDENT, mergeThreshold: 99 } as never);
  const a = await ContextManager.open({ path, namespace: NS, strategy: strategy(), membrane });
  for (let i = 0; i < 40; i++) a.addMessage(i % 2 ? 'Ada' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
  const b = await ContextManager.open({ store: a.getStore(), namespace: NS_B, strategy: strategy(), membrane });
  for (const manager of [a, b]) {
    await manager.compile();
    for (let i = 0; i < 12; i++) await manager.tick();
  }
  b.close();
  a.close();
  return path;
}

async function residents<T>(
  path: string,
  body: (a: ContextManager, b: ContextManager) => Promise<T>,
  strategyOfB: () => AutobiographicalStrategy = () => new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never),
): Promise<T> {
  const a = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
  const b = await ContextManager.open({ store: a.getStore(), namespace: NS_B, strategy: strategyOfB(), membrane });
  try {
    return await body(a, b);
  } finally {
    b.close();
    a.close();
  }
}

function foldedByBoth(a: ContextManager, b: ContextManager): string {
  const id = a.getAllMessages().map((row) => row.id).find((rowId) => [a, b].every((manager) => {
    const described = manager.describeMutationTarget({ messageId: rowId });
    return described?.kind === 'message' && described.coveringSummaries.length > 0;
  }));
  assert.ok(id, 'setup: a row both residents fold');
  return id;
}

function coveringOf(manager: ContextManager, id: string): string[] {
  const described = manager.describeMutationTarget({ messageId: id });
  assert.ok(described?.kind === 'message', `setup: message ${id} is described`);
  return described.coveringSummaries;
}

const summariesIn = (manager: ContextManager, namespace: string, branch: string): SummaryEntry[] =>
  ((manager.getStore() as ViewStore).view(branch).getStateJson(`${namespace}/autobio:summaries`) ?? []) as SummaryEntry[];

async function resident<T>(path: string, body: (manager: ContextManager) => Promise<T>): Promise<T> {
  const manager = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
  try {
    return await body(manager);
  } finally {
    manager.close();
  }
}

const summariesOn = (manager: ContextManager, branch: string): SummaryEntry[] =>
  ((manager.getStore() as ViewStore).view(branch).getStateJson(`${NS}/autobio:summaries`) ?? []) as SummaryEntry[];
const branchNames = (manager: ContextManager) => manager.listBranches().map((b) => b.name).sort();
const branchHead = (manager: ContextManager, name: string) => manager.listBranches().find((b) => b.name === name)?.head;
const sourceState = (manager: ContextManager) => ({ messages: manager.getAllMessages(), summaries: summariesOn(manager, 'main') });
const refusedWith = (code: string) => (error: unknown) => error instanceof HistoryMutationError && error.violations.some((v) => v.code === code);
const rendered = (messages: ReadonlyArray<{ content: ContentBlock[] }>): string =>
  messages.flatMap((m) => m.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n');

type SummaryOp = Extract<HistoryMutationOp, { kind: 'edit_summary' }>;

function messageSha(manager: ContextManager, id: string): string {
  const described = manager.describeMutationTarget({ messageId: id });
  assert.ok(described?.kind === 'message', `setup: message ${id} is described`);
  return described.sha256;
}

function l1Edit(manager: ContextManager, newText = 'The first stretch, by hand.'): { target: SummaryEntry; op: SummaryOp; manifest: HistoryMutationManifest } {
  const all = summariesOn(manager, manager.currentBranch().name);
  const parent = all.find((s) => s.level === 2)!;
  const target = all.find((s) => s.id === parent.sourceIds[0])!;
  const described = manager.describeMutationTarget({ summaryId: target.id });
  assert.ok(described?.kind === 'summary', 'setup: the summary is described');
  const op: SummaryOp = { kind: 'edit_summary', summaryId: target.id, expectedSha256: described.sha256, newText, dropResponseContent: true, parentPolicy: 'leave_parents' };
  return { target, op, manifest: { ops: [op] } };
}

async function apply(manager: ContextManager, manifest: HistoryMutationManifest, targetBranch: string, plan: HistoryMutationPlan = manager.planHistoryMutation(manifest)) {
  return manager.applyHistoryMutation(manifest, {
    targetBranch, expectedSourceBranch: plan.sourceBranch, expectedPlanSha256: plan.planSha256, by: { by: 'operator', note: 'by hand' },
  });
}

function heldGate(): { pass(): Promise<void>; held(): Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let waiting = false;
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    pass: async () => {
      waiting = true;
      await opened;
    },
    held: async () => {
      for (let i = 0; i < 200 && !waiting; i++) await turn();
      assert.ok(waiting, 'setup: the hook was called');
      for (let i = 0; i < 50; i++) await turn();
    },
    open: () => open(),
  };
}

describe('history mutation', () => {
  it('edits a summary on a new branch, moves the store there, and leaves the source branch as it was', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { target, manifest } = l1Edit(manager);
      const before = summariesOn(manager, 'main');
      const receipt = await apply(manager, manifest, 'surgery/one');
      assert.equal(manager.currentBranch().name, 'surgery/one');
      assert.equal(receipt.sourceBranch, 'main');
      assert.deepEqual(receipt.droppedSummaries, []);
      const edited = manager.getSummary(target.id)!;
      assert.equal(edited.content, 'The first stretch, by hand.');
      assert.equal(edited.tokens, Math.ceil(edited.content.length / 3), 'stamped from its length, as a text no provider measured');
      assert.equal(edited.responseContent, undefined);
      assert.equal(edited.external?.by, 'operator');
      assert.equal(edited.mergedInto ?? edited.parentId, target.mergedInto ?? target.parentId, 'its parent is left as it is');
      assert.deepEqual(summariesOn(manager, 'main'), before, 'the source branch holds what it held');
    });
    await resident(path, async (manager) => {
      assert.equal(manager.currentBranch().name, 'surgery/one', 'a reopen finds the store on the branch the apply moved it to');
    });
  });

  it('refuses a plan with violations, a source branch or plan other than the caller agreed, and a target branch that exists, writing nothing', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { op, manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const sequence = manager.getStore().currentSequence();
      const branches = branchNames(manager);
      const refusal = async (run: () => Promise<unknown>, code: string) => {
        await assert.rejects(run, (error: unknown) => error instanceof HistoryMutationError && error.violations.some((v) => v.code === code));
      };
      await refusal(() => apply(manager, { ops: [{ ...op, expectedSha256: '0'.repeat(64) }] }, 'x'), 'CAS_MISMATCH');
      for (const asked of [apply(manager, { ops: [{ ...op, expectedSha256: '0'.repeat(64) }] }, 'x'), manager.compileMutationPreview({ ops: [{ ...op, expectedSha256: '0'.repeat(64) }] }, { by: { by: 'operator' } })]) {
        await assert.rejects(asked, (error: unknown) => error instanceof Error && /^the plan has 1 violation\(s\): CAS_MISMATCH \(op 0\): summary [^ ]+'s text has sha256 [0-9a-f]{64}, not 0{64}/.test(error.message));
      }
      await refusal(() => manager.applyHistoryMutation(manifest, { targetBranch: 'x', expectedSourceBranch: 'other', expectedPlanSha256: plan.planSha256, by: { by: 'operator' } }), 'BRANCH_MISMATCH');
      for (const by of ['', '  ']) {
        await assert.rejects(manager.applyHistoryMutation(manifest, { targetBranch: 'x', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by } }), /give a `by` that isn't blank/);
        await assert.rejects(manager.compileMutationPreview(manifest, { by: { by } }), /give a `by` that isn't blank/);
      }
      await assert.rejects(
        () => manager.applyHistoryMutation(manifest, { targetBranch: 'x', expectedSourceBranch: 'main', expectedPlanSha256: '0'.repeat(64), by: { by: 'operator' } }),
        (error: unknown) => error instanceof HistoryMutationError && error.violations[0]?.code === 'PLAN_DRIFT' && error.plan?.planSha256 === plan.planSha256,
      );
      manager.getStore().createBranch('taken', 'main');
      const taken = branchHead(manager, 'taken');
      await refusal(() => apply(manager, manifest, 'taken', plan), 'TARGET_BRANCH_EXISTS');
      assert.equal(branchHead(manager, 'taken'), taken, 'the existing branch takes no record');
      manager.getStore().deleteBranch('taken');
      assert.equal(manager.getStore().currentSequence(), sequence);
      assert.deepEqual(branchNames(manager), branches);
    });
  });

  it('previews the compile the apply gives, without moving the store or keeping a branch', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager, 'A memory rewritten before it was applied.');
      const rows = manager.getAllMessages();
      const last = rows[rows.length - 1]!;
      const full: HistoryMutationManifest = { ops: [
        ...manifest.ops,
        { kind: 'edit_message', messageId: last.id, expectedSha256: messageSha(manager, last.id), content: [{ type: 'text', text: 'the newest row, redacted' }], label: '[redacted by operator]', foldedPolicy: 'drop_covering_summaries' },
      ] };
      const sequence = manager.getStore().currentSequence();
      const branches = branchNames(manager);
      const summaries = summariesOn(manager, 'main');
      let budget = { maxTokens: 2_000, reserveForResponse: 50 };
      let preview = await manager.compileMutationPreview(full, { budget, by: { by: 'operator', note: 'by hand' } });
      while (!rendered(preview.compiled.messages).includes('A memory rewritten before it was applied.') && budget.maxTokens > 400) {
        budget = { ...budget, maxTokens: budget.maxTokens - 100 };
        preview = await manager.compileMutationPreview(full, { budget, by: { by: 'operator', note: 'by hand' } });
      }
      assert.match(rendered(preview.compiled.messages), /editedBy="operator">\nA memory rewritten before it was applied\./, 'setup: a budget at which the edited summary renders');
      assert.equal(manager.currentBranch().name, 'main');
      assert.equal(manager.getStore().currentSequence(), sequence, 'the source branch takes no record');
      assert.deepEqual(branchNames(manager), branches, 'the scratch branch is gone');
      assert.deepEqual(summariesOn(manager, 'main'), summaries);
      assert.match(rendered(preview.compiled.messages), /\[redacted by operator\]\nthe newest row, redacted/);

      await apply(manager, full, 'surgery/preview');
      const compiled = await manager.compile(budget, undefined, { dryRun: true });
      assert.deepEqual(compiled.messages, preview.compiled.messages);
    });
  });

  it('drops what folds an edited message where the plan says so, and the compile shows the row as edited', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const folded = summariesOn(manager, 'main').find((s) => s.level === 1)!;
      const id = folded.sourceIds[0]!;
      const described = manager.describeMutationTarget({ messageId: id });
      assert.ok(described?.kind === 'message' && described.coveringSummaries.includes(folded.id), 'setup: the row is folded');
      const op = { kind: 'edit_message' as const, messageId: id, expectedSha256: described.sha256, content: [{ type: 'text' as const, text: 'a row rewritten' }], label: '[edited by operator]' };
      const refused = manager.planHistoryMutation({ ops: [op] });
      assert.deepEqual(refused.violations.map((v) => v.code), ['FOLDED_ROW_REQUIRES_POLICY']);
      const manifest: HistoryMutationManifest = { ops: [{ ...op, foldedPolicy: 'drop_covering_summaries' }] };
      const plan = manager.planHistoryMutation(manifest);
      assert.ok(plan.droppedSummaries.includes(folded.id), 'the plan drops the summary that folds the row');
      const receipt = await apply(manager, manifest, 'surgery/folded', plan);
      assert.deepEqual([...receipt.droppedSummaries].sort(), [...plan.droppedSummaries].sort());
      for (const dropped of plan.droppedSummaries) assert.equal(manager.getSummary(dropped), null, `${dropped} is dropped`);
      const row = manager.getMessage(id)!;
      assert.deepEqual(row.content, [{ type: 'text', text: '[edited by operator]' }, { type: 'text', text: 'a row rewritten' }]);
      const { at, ...stamp } = row.metadata?.historyMutation as Record<string, unknown>;
      assert.equal(typeof at, 'number');
      assert.deepEqual(stamp, { by: 'operator', label: '[edited by operator]', note: 'by hand', sourceBranch: 'main' });
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 50 }, undefined, { dryRun: true });
      assert.match(rendered(compiled.messages), /\[edited by operator\]\na row rewritten/);
    });
  });

  it('refuses removing a folded row in legacy mode unless what folds it goes, and then lets go of it', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const folded = summariesOn(manager, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const expectedSha256ById = Object.fromEntries(ids.map((id) => [id, messageSha(manager, id)]));
      const op = { kind: 'remove_messages' as const, messageIds: ids, expectedSha256ById };
      assert.deepEqual(manager.planHistoryMutation({ ops: [op] }).violations.map((v) => v.code), ['FOLDED_ROW_REQUIRES_POLICY']);
      const manifest: HistoryMutationManifest = { ops: [{ ...op, foldedPolicy: 'drop_covering_summaries' }] };
      const receipt = await apply(manager, manifest, 'surgery/removed');
      assert.ok(receipt.droppedSummaries.includes(folded.id));
      for (const id of ids) assert.equal(manager.getMessage(id), null);
      assert.ok(!summariesOn(manager, 'surgery/removed').some((s) => s.sourceIds.some((source) => ids.includes(source))), 'no summary folds a removed row');
    });
  });

  it('drops the merged parents of an edited summary where the plan says so', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { target, op } = l1Edit(manager);
      const parentId = target.mergedInto ?? target.parentId!;
      assert.deepEqual(manager.planHistoryMutation({ ops: [{ ...op, parentPolicy: undefined }] }).violations.map((v) => v.code), ['MERGED_PARENT_REQUIRES_POLICY']);
      await apply(manager, { ops: [{ ...op, parentPolicy: 'drop_parents' }] }, 'surgery/parents');
      assert.equal(manager.getSummary(parentId), null);
      assert.equal(manager.getSummary(target.id)?.mergedInto ?? manager.getSummary(target.id)?.parentId, undefined, 'the edited summary renders and merges again');
    });
  });

  it('names who wrote an edited summary in its recall envelope', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      await apply(manager, manifest, 'surgery/envelope');
      let text = '';
      for (let maxTokens = 2_000; maxTokens >= 400 && !text.includes('editedBy='); maxTokens -= 100) {
        text = rendered((await manager.compile({ maxTokens, reserveForResponse: 50 }, undefined, { dryRun: true })).messages);
      }
      assert.match(text, /<cm-recall [^>]*editedBy="operator">\nThe first stretch, by hand\./);
    });
  });

  async function carriedStore(): Promise<{ path: string; under: SummaryEntry; carrier: SummaryEntry }> {
    const path = join(dir, `store-${stores++}`);
    const first = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, mergeThreshold: 99 } as never), membrane });
    for (let i = 0; i < 40; i++) first.addMessage(i % 2 ? 'Ada' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
    await first.compile();
    for (let i = 0; i < 12; i++) await first.tick();
    const all = summariesOn(first, 'main');
    const under = all[0]!;
    const carrier: SummaryEntry = {
      id: 'L2-carry', level: 2, sourceLevel: 1, sourceIds: [under.id], carriedFrom: under.id, sourceRange: under.sourceRange,
      content: under.content, tokens: under.tokens, created: under.created,
      ...(under.responseContent ? { responseContent: under.responseContent } : {}),
    };
    assert.ok(carrier.responseContent?.length, 'setup: the carrier holds a copy of the response blocks');
    first.getStore().setStateJson(`${NS}/autobio:summaries`, [...all.map((s) => (s.id === under.id ? { ...s, mergedInto: carrier.id } : s)), carrier]);
    first.close();
    return { path, under, carrier };
  }

  it('names the editor in the envelope of an entry that carries the edited summary up a level', async () => {
    const { path, under, carrier } = await carriedStore();
    const strategy = new AnswerOf({ ...RESIDENT, autoTickOnNewMessage: false } as never);
    const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane });
    try {
      assert.equal(manager.getSummary(carrier.id)?.carriedFrom, under.id, 'setup: the resident keeps the carried entry');
      const described = manager.describeMutationTarget({ summaryId: under.id });
      assert.ok(described?.kind === 'summary');
      assert.deepEqual(described.carriedBy, [carrier.id]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_summary', summaryId: under.id, expectedSha256: described.sha256, newText: 'Carried, by hand.', dropResponseContent: true }] };
      await assert.rejects(apply(manager, manifest, 'surgery/carried'), /a subclass of AutobiographicalStrategy gives its own cloneForScratch: give a strategy/);
      const plan = manager.planHistoryMutation(manifest);
      await assert.rejects(manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/carried', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        strategy: () => new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never),
        beforeSwitch: async ({ view }) => {
          const summaries = view.getStateJson(`${NS}/autobio:summaries`) as SummaryEntry[];
          view.setStateJson(`${NS}/autobio:summaries`, summaries.map((s) => (s.id === carrier.id ? { ...s, content: 'the old copy' } : s)));
        },
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && /summary L2-carry's content other than the edit writes/.test(String(error)));
      await manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/carried', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        strategy: () => new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never),
      });
      assert.match(rendered([{ content: strategy.answer(carrier.id) }]), /^<cm-recall id="L2-carry" level="2" span="[^"]+" editedBy="operator">\nCarried, by hand\.\n<\/cm-recall>$/);
      const edited = manager.getSummary(under.id)!;
      const carried = manager.getSummary(carrier.id)!;
      assert.deepEqual(
        [carried.content, carried.tokens, carried.external, carried.responseContent],
        [edited.content, edited.tokens, edited.external, undefined],
        'the carrier is the edited summary\'s copy again',
      );
    } finally {
      manager.close();
    }
  });

  it('writes a summary and its carriers in one write, so an edit whose write fails before it lands leaves them as they were and can be asked for again', async () => {
    const { path, under, carrier } = await carriedStore();
    await resident(path, async (manager) => {
      const described = manager.describeMutationTarget({ summaryId: under.id });
      assert.ok(described?.kind === 'summary');
      const store = manager.getStore();
      const set = store.setStateJson.bind(store);
      const summariesId = `${NS}/autobio:summaries`;
      store.setStateJson = (id: string, value: unknown) => {
        if (id === summariesId) throw new Error('the disk is full');
        return set(id, value);
      };
      const ask = () => manager.editSummaryText(under.id, 'Carried, by hand.', { by: 'operator' }, { apply: true, dropResponseContent: true, expectedPriorSha256: described.sha256 });
      try {
        assert.throws(ask, /threw, and it may have landed: read the summary before asking for the edit again \(the disk is full\)/);
      } finally {
        store.setStateJson = set;
      }
      let writes = 0;
      store.setStateJson = (id: string, value: unknown) => {
        if (id === summariesId) writes++;
        return set(id, value);
      };
      assert.deepEqual([manager.getSummary(under.id)?.content, manager.getSummary(carrier.id)?.content], [under.content, carrier.content], 'neither changed in memory');
      assert.deepEqual(summariesOn(manager, 'main').filter((s) => s.id === under.id || s.id === carrier.id).map((s) => s.content), [under.content, carrier.content], 'nor in the store');
      const compiled = rendered((await manager.compile(undefined, undefined, { dryRun: true })).messages);
      assert.ok(!compiled.includes('Carried, by hand.'), 'a compile renders neither as edited');
      try {
        ask();
      } finally {
        store.setStateJson = set;
      }
      assert.equal(writes, 1, 'asked again, the summary and its carrier go in one write');
      assert.equal(manager.getSummary(under.id)?.content, 'Carried, by hand.');
      assert.equal(manager.getSummary(carrier.id)?.content, 'Carried, by hand.');
      assert.deepEqual(summariesOn(manager, 'main').filter((s) => s.id === under.id || s.id === carrier.id).map((s) => s.content), ['Carried, by hand.', 'Carried, by hand.']);
    });
  });

  it('refuses a summary edit where the stored summaries aren\'t as the strategy holds them', async () => {
    const { path, under, carrier } = await carriedStore();
    await resident(path, async (manager) => {
      const described = manager.describeMutationTarget({ summaryId: under.id });
      assert.ok(described?.kind === 'summary');
      const summariesId = `${NS}/autobio:summaries`;
      const store = manager.getStore();
      const held = store.getStateJson(summariesId) as SummaryEntry[];
      const ask = () => manager.editSummaryText(under.id, 'Edited by hand.', { by: 'operator' }, { apply: true, dropResponseContent: true, expectedPriorSha256: described.sha256 });
      for (const [what, stored] of [
        ['the summary is gone', held.filter((s) => s.id !== under.id)],
        ['a carrier is gone', held.filter((s) => s.id !== carrier.id)],
        ['another handle wrote a newer text', held.map((s) => (s.id === under.id ? { ...s, content: 'a newer text' } : s))],
      ] as const) {
        store.setStateJson(summariesId, stored);
        assert.throws(ask, /the stored summaries can't be shown to be as this strategy holds them/, what);
        assert.deepEqual(store.getStateJson(summariesId), stored, `${what}: nothing written`);
        assert.equal(manager.getSummary(under.id)?.content, under.content, `${what}: nothing changed in memory`);
      }
    });
  });

  it('leaves the store on the source branch, and deletes the branch it built, when the apply fails before the switch', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const before = sourceState(manager);
      const branches = branchNames(manager);
      const options = { targetBranch: 'surgery/failed', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' } };
      await assert.rejects(
        manager.applyHistoryMutation(manifest, { ...options, beforeSwitch: async () => { throw new Error('the host could not reconcile its other residents'); } }),
        /could not reconcile/,
      );
      const store = manager.getStore();
      const sync = store.sync.bind(store);
      await assert.rejects(
        manager.applyHistoryMutation(manifest, { ...options, beforeSwitch: async () => { store.sync = () => { throw new Error('the disk is full'); }; } }),
        /the disk is full/,
      );
      store.sync = sync;
      assert.equal(manager.currentBranch().name, 'main');
      assert.deepEqual(branchNames(manager), branches);
      assert.deepEqual(sourceState(manager), before);
      await apply(manager, manifest, 'surgery/failed', plan);
      assert.equal(manager.currentBranch().name, 'surgery/failed', 'the same apply goes through once nothing fails');
    });
  });

  it('names a branch it built and couldn\'t delete, beside what failed', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const store = manager.getStore();
      const deleteBranch = store.deleteBranch.bind(store);
      store.deleteBranch = () => { throw new Error('the checkpoint failed'); };
      try {
        await assert.rejects(
          manager.compileMutationPreview(manifest, { by: { by: 'operator' } }),
          (error: unknown) => error instanceof HistoryMutationError && error.violations.some((v) => v.code === 'BRANCH_LEFT' && /^preview-mutation\//.test(v.targetId ?? '')),
        );
        await assert.rejects(
          manager.applyHistoryMutation(manifest, {
            targetBranch: 'surgery/left', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
            beforeSwitch: async () => { throw new Error('the host could not reconcile its other residents'); },
          }),
          (error: unknown) => error instanceof HistoryMutationError
            && error.violations.some((v) => v.code === 'BRANCH_LEFT' && v.targetId === 'surgery/left')
            && error.cause instanceof Error && /could not reconcile/.test(error.cause.message)
            && /could not reconcile/.test(error.message),
        );
        await assert.rejects(
          manager.applyHistoryMutation(manifest, {
            targetBranch: 'surgery/left-moved', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
            beforeSwitch: async () => { manager.addMessage('User', [{ type: 'text', text: 'a write to the source meanwhile' }]); },
          }),
          (error: unknown) => {
            assert.ok(error instanceof HistoryMutationError);
            assert.deepEqual(error.violations.map((v) => v.code), ['SOURCE_MOVED', 'BRANCH_LEFT']);
            assert.doesNotMatch(error.violations[1]!.message, /moved while/, 'the failure listed beside it isn\'t repeated');
            assert.match(error.message, /moved while.*deleting branch surgery\/left-moved/s);
            return true;
          },
        );
        await assert.rejects(
          manager.applyHistoryMutation(manifest, {
            targetBranch: 'surgery/left-selected', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
            beforeSwitch: async () => { store.switchBranch('surgery/left-selected'); },
          }),
          (error: unknown) => refusedWith('BRANCH_LEFT')(error) && /the store is on it: switch the store to another branch, then delete it/.test(String(error)),
        );
        store.switchBranch('main');
      } finally {
        store.deleteBranch = deleteBranch;
      }
      assert.equal(manager.currentBranch().name, 'main');
      assert.ok(branchNames(manager).includes('surgery/left'));
    });
  });

  it('refuses to switch when the source moved while the branch was built, leaving what moved it in place', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const applyWith = (targetBranch: string, beforeSwitch: () => Promise<void>) => manager.applyHistoryMutation(manifest, {
        targetBranch, expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, beforeSwitch,
      });
      let appended = '';
      await assert.rejects(applyWith('surgery/appended', async () => {
        appended = manager.addMessage('User', [{ type: 'text', text: 'a message that came in meanwhile' }]);
      }), refusedWith('SOURCE_MOVED'));
      assert.equal(manager.currentBranch().name, 'main');
      assert.ok(manager.getMessage(appended), 'the message stays on the source');
      assert.ok(!branchNames(manager).includes('surgery/appended'), 'the branch built is deleted');

      const replanned = manager.planHistoryMutation(manifest);
      await assert.rejects(manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/replaced', expectedSourceBranch: 'main', expectedPlanSha256: replanned.planSha256, by: { by: 'operator' },
        beforeSwitch: async () => {
          const store = manager.getStore();
          store.createBranch('copy', 'surgery/replaced');
          store.deleteBranch('surgery/replaced');
          store.createBranch('surgery/replaced', 'copy');
        },
      }), refusedWith('SOURCE_MOVED'));
      assert.ok(branchNames(manager).includes('surgery/replaced'), 'a branch the apply didn\'t build is not deleted');

      manager.getStore().createBranch('elsewhere', 'main');
      await assert.rejects(manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/moved', expectedSourceBranch: 'main', expectedPlanSha256: replanned.planSha256, by: { by: 'operator' },
        beforeSwitch: async () => { await manager.switchBranch('elsewhere'); },
      }), refusedWith('SOURCE_MOVED'));
      assert.equal(manager.currentBranch().name, 'elsewhere');
    });
  });

  it('carries the receipt when the switch lands and the strategy then fails to initialize', async () => {
    const path = await residentStore();
    class FailsOnce extends AutobiographicalStrategy {
      fail = false;
      override async initialize(ctx: Parameters<AutobiographicalStrategy['initialize']>[0]): Promise<void> {
        if (this.fail) {
          this.fail = false;
          throw new Error('the strategy could not load');
        }
        return super.initialize(ctx);
      }
    }
    const strategy = new FailsOnce({ ...RESIDENT, autoTickOnNewMessage: false } as never);
    const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane });
    try {
      const { target, manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      let caught: unknown;
      try {
        await manager.applyHistoryMutation(manifest, {
          targetBranch: 'surgery/applied', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
          strategy: () => new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never),
          beforeSwitch: async () => { strategy.fail = true; },
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof HistoryMutationError && caught.violations[0]?.code === 'APPLIED_INIT_FAILED', String(caught));
      assert.equal(caught.receipt?.targetBranch, 'surgery/applied');
      assert.equal(caught.receipt?.planSha256, plan.planSha256);
      assert.equal(manager.getStore().currentBranch().name, 'surgery/applied');
      await manager.setStrategy(manager.getStrategy());
      assert.equal(manager.getSummary(target.id)?.content, 'The first stretch, by hand.');
    } finally {
      manager.close();
    }
  });

  it('keeps the branch it built when another selection supersedes the switch, and says the mutation is applied', async () => {
    for (const back of ['elsewhere', 'main']) await supersededTo(back);
  });

  async function supersededTo(back: string): Promise<void> {
    const path = await residentStore();
    let moved: Promise<void> | undefined;
    let move: (() => Promise<void>) | undefined;
    class MovesAway extends AutobiographicalStrategy {
      override async initialize(ctx: Parameters<AutobiographicalStrategy['initialize']>[0]): Promise<void> {
        const now = move;
        move = undefined;
        if (now) moved = now();
        return super.initialize(ctx);
      }
    }
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new MovesAway({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
    try {
      manager.getStore().createBranch('elsewhere', 'main');
      const { target, manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      let caught: unknown;
      try {
        await manager.applyHistoryMutation(manifest, {
          targetBranch: 'surgery/superseded', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
          strategy: () => new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never),
          beforeSwitch: async () => { move = () => manager.switchBranch(back); },
        });
      } catch (error) {
        caught = error;
      }
      await moved;
      assert.ok(caught instanceof HistoryMutationError && caught.violations[0]?.code === 'APPLIED_INIT_FAILED', `${back}: ${String(caught)}`);
      assert.deepEqual(
        [caught.receipt?.sourceBranch, caught.receipt?.targetBranch, caught.receipt?.planSha256, caught.receipt?.targets],
        ['main', 'surgery/superseded', plan.planSha256, plan.targets],
        `${back}: the error carries the receipt of the mutation it applied`,
      );
      assert.equal(manager.getStore().currentBranch().name, back);
      assert.ok(branchNames(manager).includes('surgery/superseded'), `${back}: the branch that holds the mutation stays`);
      assert.equal(summariesOn(manager, 'surgery/superseded').find((s) => s.id === target.id)?.content, 'The first stretch, by hand.');
    } finally {
      manager.close();
    }
  }

  it('refuses to switch to a branch that reads back other than planned, or breaks a rule its source keeps', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { op, manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const before = sourceState(manager);
      const branches = branchNames(manager);
      const applyWith = (targetBranch: string, beforeSwitch: (ctx: { view: JsStore }) => Promise<void>) => manager.applyHistoryMutation(manifest, {
        targetBranch, expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, beforeSwitch,
      });
      const summariesId = `${NS}/autobio:summaries`;
      await assert.rejects(applyWith('surgery/overwritten', async ({ view }) => {
        const summaries = view.getStateJson(summariesId) as SummaryEntry[];
        view.setStateJson(summariesId, summaries.map((s) => (s.id === op.summaryId ? { ...s, content: 'something else' } : s)));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`summary ${op.summaryId}'s content other than the edit writes`).test(String(error)));
      const other = before.summaries.find((s) => s.level === 1 && s.id !== op.summaryId && !s.mergedInto)!;
      await assert.rejects(applyWith('surgery/dropped', async ({ view }) => {
        view.setStateJson(summariesId, (view.getStateJson(summariesId) as SummaryEntry[]).filter((s) => s.id !== other.id));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`summary ${other.id} is gone`).test(String(error)));
      const last = before.messages.length - 1;
      const slot = ['messages', `${NS}/messages`].find((id) => manager.getStore().listStates().some((state) => state.id === id))!;
      await assert.rejects(applyWith('surgery/rewritten', async ({ view }) => {
        const stored = view.getStateItemJson(slot, last) as Record<string, unknown>;
        view.editStateItem(slot, last, Buffer.from(JSON.stringify({ ...stored, content: [{ type: 'text', text: 'rewritten' }] })));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`message ${before.messages[last]!.id}'s content`).test(String(error)));
      await assert.rejects(applyWith('surgery/broken', async ({ view }) => {
        new MessageStore(view).append('User', [{ type: 'tool_result', toolUseId: 'no-such-call', content: 'an answer to nothing' }]);
      }), refusedWith('INVARIANT_BROKEN'));
      await assert.rejects(applyWith('surgery/other-text', async ({ view }) => {
        view.setStateJson(summariesId, (view.getStateJson(summariesId) as SummaryEntry[]).map((s) => (s.id === other.id ? { ...s, content: 'rewritten aside' } : s)));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`summary ${other.id}'s content changed`).test(String(error)));
      const spoken = before.summaries.find((s) => s.id !== op.summaryId && (s.responseContent?.length ?? 0) > 0)!;
      await assert.rejects(applyWith('surgery/respoken', async ({ view }) => {
        view.setStateJson(summariesId, (view.getStateJson(summariesId) as SummaryEntry[]).map((s) => (s.id === spoken.id ? { ...s, responseContent: [{ type: 'text', text: 'said otherwise' }] } : s)));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`summary ${spoken.id}'s responseContent changed`).test(String(error)));
      await assert.rejects(applyWith('surgery/attributed', async ({ view }) => {
        view.setStateJson(summariesId, (view.getStateJson(summariesId) as SummaryEntry[]).map((s) => (s.id === op.summaryId ? { ...s, external: { by: 'someone else', at: 0 } } : s)));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`summary ${op.summaryId} doesn't record the edit as made \\(external\\)`).test(String(error)));
      await assert.rejects(applyWith('surgery/restamped', async ({ view }) => {
        const stored = view.getStateItemJson(slot, 0) as Record<string, unknown>;
        view.editStateItem(slot, 0, Buffer.from(JSON.stringify({ ...stored, metadata: { tags: ['moved'] } })));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`message ${before.messages[0]!.id}'s metadata changed`).test(String(error)));
      assert.equal(manager.currentBranch().name, 'main');
      assert.deepEqual(branchNames(manager), branches);
      assert.deepEqual(sourceState(manager), before);
    });
  });

  it('keeps rows that beforeSwitch appends after the source\'s, and every other state of the store', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const store = manager.getStore();
      store.registerState({ id: 'agents/Bob/notes', strategy: 'snapshot' });
      store.setStateJson('agents/Bob/notes', { said: 'hello' });
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      await manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/noticed', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        beforeSwitch: async ({ view }) => { new MessageStore(view).append('system', [{ type: 'text', text: 'Your history was edited.' }]); },
      });
      const rows = manager.getAllMessages();
      assert.equal(rendered([rows[rows.length - 1]!]), 'Your history was edited.');
      assert.deepEqual(store.getStateJson('agents/Bob/notes'), { said: 'hello' }, 'another resident\'s state comes along');
    });
  });

  it('keeps the metadata an edited message had beside the record of the edit, and refuses a branch whose record differs', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
    try {
      manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
      const id = manager.addMessage('Ada', [{ type: 'text', text: 'a reply to redact' }], { sourceId: 'discord-123', tags: ['dm'] });
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), content: [], label: '[redacted by operator]' }] };
      const plan = manager.planHistoryMutation(manifest);
      await assert.rejects(manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/restamped', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        beforeSwitch: async ({ view }) => {
          const stored = view.getStateItemJson('messages', 1) as { metadata: { historyMutation: Record<string, unknown> } };
          view.editStateItem('messages', 1, Buffer.from(JSON.stringify({ ...stored, metadata: { ...stored.metadata, historyMutation: { ...stored.metadata.historyMutation, by: 'someone else' } } })));
        },
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && /doesn't record the edit as made/.test(String(error)));
      await apply(manager, manifest, 'surgery/metadata');
      const { historyMutation, ...rest } = manager.getMessage(id)!.metadata ?? {};
      assert.deepEqual(rest, { sourceId: 'discord-123', tags: ['dm'] });
      assert.equal((historyMutation as { label?: string }).label, '[redacted by operator]');
    } finally {
      manager.close();
    }
  });

  it('previews and applies through the scratch copy of a Knowledge or a Passthrough strategy', async () => {
    for (const strategy of [new KnowledgeStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), new PassthroughStrategy()]) {
      const path = join(dir, `store-${stores++}`);
      const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane });
      try {
        for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Ada' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
        const id = manager.getAllMessages()[11]!.id;
        const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), content: [{ type: 'text', text: 'redacted' }], label: '[redacted by operator]' }] };
        const budget = { maxTokens: 100_000, reserveForResponse: 50 };
        const preview = await manager.compileMutationPreview(manifest, { budget, by: { by: 'operator' } });
        assert.match(rendered(preview.compiled.messages), /\[redacted by operator\]\nredacted/, strategy.name);
        await apply(manager, manifest, 'surgery/scratch');
        assert.deepEqual((await manager.compile(budget, undefined, { dryRun: true })).messages, preview.compiled.messages, strategy.name);
      } finally {
        manager.close();
      }
    }
  });

  it('edits a summary of a Knowledge strategy as of an autobiographical one', async () => {
    const path = join(dir, `store-${stores++}`);
    const knowledge = (extra = {}) => new KnowledgeStrategy({ ...RESIDENT, mergeThreshold: 99, ...extra } as never);
    const first = await ContextManager.open({ path, namespace: NS, strategy: knowledge(), membrane });
    for (let i = 0; i < 40; i++) first.addMessage(i % 2 ? 'Ada' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
    await first.compile();
    for (let i = 0; i < 12; i++) await first.tick();
    first.close();
    const manager = await ContextManager.open({ path, namespace: NS, strategy: knowledge({ autoTickOnNewMessage: false }), membrane });
    try {
      const target = summariesOn(manager, 'main').find((s) => s.level === 1);
      assert.ok(target, 'setup: the Knowledge strategy wrote an L1');
      const described = manager.describeMutationTarget({ summaryId: target.id });
      assert.ok(described?.kind === 'summary');
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_summary', summaryId: target.id, expectedSha256: described.sha256, newText: 'A phase, by hand.',
        dropResponseContent: true, ...(described.mergedParents.length > 0 ? { parentPolicy: 'leave_parents' as const } : {}),
      }] };
      await apply(manager, manifest, 'surgery/knowledge');
      const edited = manager.getSummary(target.id)!;
      assert.equal(edited.content, 'A phase, by hand.');
      assert.equal(edited.external?.by, 'operator');
      assert.equal((edited as { phaseType?: unknown }).phaseType, (target as { phaseType?: unknown }).phaseType, 'its phase stays');
    } finally {
      manager.close();
    }
  });

  it('gives the scratch strategy the live one\'s hot settings', async () => {
    const knowledge = new KnowledgeStrategy({ ...RESIDENT } as never);
    knowledge.updateHotContextSettings({ tailTokens: 321 });
    const clone = knowledge.cloneForScratch();
    assert.ok(clone instanceof KnowledgeStrategy);
    assert.equal(clone.getHotContextSettings().tailTokens, 321, 'a Knowledge clone');

    class Watching extends AutobiographicalStrategy {
      seen: ReturnType<AutobiographicalStrategy['getHotContextSettings']> | undefined;
      override select(...args: Parameters<AutobiographicalStrategy['select']>): ReturnType<AutobiographicalStrategy['select']> {
        this.seen = this.getHotContextSettings();
        return super.select(...args);
      }
    }
    const path = await residentStore();
    await resident(path, async (manager) => {
      const live = manager.getStrategy() as AutobiographicalStrategy;
      live.updateHotContextSettings({ tailTokens: 300, transitionPaceTokens: 1234 });
      const watching = new Watching({ ...RESIDENT, autoTickOnNewMessage: false } as never);
      await manager.compileMutationPreview(l1Edit(manager).manifest, { by: { by: 'operator' }, strategy: () => watching });
      assert.equal(watching.seen?.tailTokens, 300);
      assert.equal(watching.seen?.transitionPaceTokens, 1234);
    });
  });

  it('reads tool pairs across the slots a manager merges, and refuses splitting one', async () => {
    const path = join(dir, `store-${stores++}`);
    const main = await ContextManager.open({ path, namespace: 'agents/Main', strategy: new PassthroughStrategy() });
    main.addMessage('Ada', [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
    main.close();
    const side = await ContextManager.open({ path, namespace: 'agents/Side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}] });
    try {
      const result = side.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'file a' }]);
      side.addMessage('Ada', [{ type: 'text', text: 'it says a' }]);
      assert.deepEqual(side.checkHistoryInvariants(), [], 'the call in the merged slot answers the result in this one');
      const plan = side.planHistoryMutation({ ops: [{ kind: 'remove_messages', messageIds: [result], expectedSha256ById: { [result]: messageSha(side, result) } }] });
      assert.deepEqual(plan.violations.map((v) => v.code), ['TOOL_PAIR_SPLIT']);
      assert.match(plan.violations[0]!.message, /in a slot this manager merges, which its mutation can't change/, 'it doesn\'t advise changing a message it can\'t target');
    } finally {
      side.close();
    }
  });

  it('plans what a change does to each reader of its rows, and refuses a reader\'s summaries over a row without a policy', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const op = { kind: 'edit_message' as const, messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text' as const, text: 'a row rewritten' }], label: '[edited by operator]' };
      const refused = a.planHistoryMutation({ ops: [op] }, { readers: [b] });
      assert.deepEqual(
        refused.violations.map((v) => [v.code, v.remediation?.readerNamespace]),
        [['FOLDED_ROW_REQUIRES_POLICY', undefined], ['FOLDED_ROW_REQUIRES_POLICY', NS_B]],
      );
      const leftByA = a.planHistoryMutation({ ops: [{ ...op, foldedPolicy: 'leave_summaries' }] }, { readers: [b] });
      assert.deepEqual(leftByA.violations, [], 'the op\'s policy is the readers\' too');
      assert.deepEqual(leftByA.readers[0]?.droppedSummaries, []);

      const manifest: HistoryMutationManifest = { ops: [{ ...op, foldedPolicy: 'drop_covering_summaries' }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      assert.deepEqual(plan.violations, []);
      assert.deepEqual(plan.readers.map((r) => r.namespace), [NS_B]);
      assert.deepEqual([...plan.readers[0]!.droppedSummaries].sort(), [...coveringOf(b, id)].sort());
      assert.deepEqual(plan.readers[0]!.heldIds, [id]);
      assert.equal(plan.readers[0]!.invalidatesKvPrefixFrom?.messageId !== undefined, true, 'its window changes from a row');
      assert.ok(!plan.droppedSummaries.some((s) => plan.readers[0]!.droppedSummaries.includes(s) && !coveringOf(a, id).includes(s)), 'each manager drops its own');

      const without = a.planHistoryMutation(manifest);
      assert.deepEqual(without.readers, []);
      assert.notEqual(without.planSha256, plan.planSha256, 'the plan\'s sha256 covers what it does to each reader');
      await assert.rejects(a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/drift', expectedSourceBranch: 'main', expectedPlanSha256: without.planSha256, by: { by: 'operator' }, readers: [b],
      }), refusedWith('PLAN_DRIFT'));
    });
  });

  it('reconciles each reader on the branch before the switch: its summaries over an edited row go, and its compile shows the row as edited', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text', text: 'a row rewritten' }],
        label: '[edited by operator]', foldedPolicy: 'drop_covering_summaries',
      }] };
      const bSource = summariesIn(b, NS_B, 'main');
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      const preview = await a.compileMutationPreview(manifest, { by: { by: 'operator' }, readers: [b] });
      assert.equal(preview.plan.planSha256, plan.planSha256, 'the preview plans as the apply does');
      await a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/both', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
      });
      await b.setStrategy(b.getStrategy());
      assert.ok(plan.readers[0]!.droppedSummaries.length > 0, 'setup: the reader drops summaries');
      for (const dropped of plan.readers[0]!.droppedSummaries) assert.equal(b.getSummary(dropped), null, `${dropped} is dropped from the reader`);
      assert.deepEqual(summariesIn(b, NS_B, 'main'), bSource, 'the reader\'s summaries on the source are as they were');
      const compiled = await b.compile({ maxTokens: 100_000, reserveForResponse: 50 }, undefined, { dryRun: true });
      assert.match(rendered(compiled.messages), /\[edited by operator\]\na row rewritten/);
    });
  });

  it('takes removed rows out of each presented reader\'s window, with what folds them, before the switch', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      a.presentRows([]);
      b.presentRows([]);
      const folded = summariesIn(b, NS_B, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, messageSha(a, id)])) }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      assert.deepEqual(plan.violations, []);
      assert.ok(plan.readers[0]!.droppedSummaries.includes(folded.id));
      await a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/removed-both', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
      });
      await b.setStrategy(b.getStrategy());
      const window = new Set(b.getPresentedMessages().map((row) => row.id));
      for (const id of ids) {
        assert.ok(!window.has(id), `${id} left the reader's window`);
        assert.equal(b.ordinalOf(id), undefined);
      }
      for (const dropped of plan.readers[0]!.droppedSummaries) assert.equal(b.getSummary(dropped), null, `${dropped} is dropped from the reader`);
      assert.deepEqual(b.retractAbsentRows(), [], 'nothing is left for a boot to take out');
    });
  });

  it('leaves each reader as it was when the apply fails before the switch', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text', text: 'a row rewritten' }],
        label: '[edited by operator]', foldedPolicy: 'drop_covering_summaries',
      }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      const bSource = summariesIn(b, NS_B, 'main');
      const branches = branchNames(a);
      await assert.rejects(a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/failed', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
        beforeSwitch: async ({ view }) => {
          const onBranch = new Set(((view.getStateJson(`${NS_B}/autobio:summaries`) ?? []) as SummaryEntry[]).map((s) => s.id));
          assert.ok(plan.readers[0]!.droppedSummaries.length > 0 && plan.readers[0]!.droppedSummaries.every((dropped) => !onBranch.has(dropped)), 'setup: the reader is reconciled on the branch');
          throw new Error('the host failed');
        },
      }), /the host failed/);
      assert.equal(a.currentBranch().name, 'main');
      assert.deepEqual(branchNames(a), branches);
      assert.deepEqual(summariesIn(b, NS_B, 'main'), bSource);
      for (const id of plan.readers[0]!.droppedSummaries) assert.ok(b.getSummary(id), `${id} is still the reader's`);
    });
  });

  it('refuses to switch to a branch where a reader reads back other than planned', async () => {
    let asked = 0;
    class Keeping extends AutobiographicalStrategy {
      constructor(private readonly settings: ConstructorParameters<typeof AutobiographicalStrategy>[0]) {
        super(settings);
      }
      override dropSummaries(): string[] {
        asked++;
        return [];
      }
      override cloneForScratch(): Keeping {
        return new Keeping({ ...this.settings, autoTickOnNewMessage: false });
      }
    }
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text', text: 'a row rewritten' }],
        label: '[edited by operator]', foldedPolicy: 'drop_covering_summaries',
      }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      await assert.rejects(a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/kept', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`${NS_B}.*is still there`).test(String(error)));
      assert.ok(asked > 0, 'the reader was asked to drop them before the readback');
      assert.equal(a.currentBranch().name, 'main');
    }, () => new Keeping({ ...RESIDENT, autoTickOnNewMessage: false } as never));
  });

  it('refuses a change that splits a tool pair in a reader\'s record', async () => {
    const path = join(dir, `store-${stores++}`);
    const main = await ContextManager.open({ path, namespace: 'agents/Main', strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({ store: main.getStore(), namespace: 'agents/Side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}] });
    try {
      main.addMessage('User', [{ type: 'text', text: 'read file a' }]);
      const call = main.addMessage('Ada', [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
      side.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'file a' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: [call], expectedSha256ById: { [call]: messageSha(main, call) } }] };
      assert.deepEqual(main.planHistoryMutation(manifest).violations, [], 'setup: the call is unanswered in the manager\'s own record');
      assert.deepEqual(main.planHistoryMutation(manifest, { readers: [side] }).violations.map((v) => v.code), ['TOOL_PAIR_SPLIT']);
    } finally {
      side.close();
      main.close();
    }
  });

  it('refuses a preview or an apply while a sharded addMessage stores its shards, and makes no branch', async () => {
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
      }
    }
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new Sharding() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'an earlier row' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), content: [{ type: 'text', text: 'redacted' }], label: '[redacted by operator]' }] };
      const plan = manager.planHistoryMutation(manifest);
      const asked: Array<[string, Promise<unknown>]> = [];
      let first = true;
      manager.onMessage((event) => {
        if (event.type !== 'add' || !first) return;
        first = false;
        asked.push(['compileMutationPreview', manager.compileMutationPreview(manifest, { by: { by: 'operator' } })]);
        asked.push(['applyHistoryMutation', manager.applyHistoryMutation(manifest, {
          targetBranch: 'surgery/mid-add', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        })]);
      });
      manager.addMessage('Ada', [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two ' }, { type: 'text', text: 'three' }]);
      assert.equal(asked.length, 2, 'setup: both were asked for');
      for (const [operation, refusal] of asked) {
        await assert.rejects(refusal, (error: Error) => new RegExp(`^ContextManager\\.${operation} refused: a sharded addMessage is storing its shards`).test(error.message), operation);
      }
      assert.deepEqual(branchNames(manager), ['main']);
    } finally {
      manager.close();
    }
  });

  it('refuses a reader that is the manager itself, is named twice, shares a strategy namespace, reads another store, or keeps summaries with no strategy for the branch', async () => {
    const path = await twoResidentStore();
    const elsewhere = await ContextManager.open({ path: await residentStore(), namespace: NS_B, strategy: new PassthroughStrategy() });
    try {
      await residents(path, async (a, b) => {
        const id = a.getAllMessages()[0]!.id;
        const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text', text: 'x' }], label: '[x]', foldedPolicy: 'leave_summaries' }] };
        assert.throws(() => a.planHistoryMutation(manifest, { readers: [a] }), /the manager itself/);
        assert.throws(() => a.planHistoryMutation(manifest, { readers: [b, b] }), /named twice/);
        assert.throws(() => a.planHistoryMutation(manifest, { readers: [elsewhere] }), /another store/);
        const twin = await ContextManager.open({ store: a.getStore(), namespace: NS_B, strategy: new PassthroughStrategy() });
        const mine = await ContextManager.open({ store: a.getStore(), namespace: NS, strategy: new PassthroughStrategy() });
        const subclassed = await ContextManager.open({ store: a.getStore(), namespace: 'agents/Cy', strategy: new AnswerOf({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
        try {
          assert.throws(() => a.planHistoryMutation(manifest, { readers: [b, twin] }), new RegExp(`two managers have strategy namespace ${NS_B}`));
          assert.throws(() => a.planHistoryMutation(manifest, { readers: [mine] }), new RegExp(`two managers have strategy namespace ${NS}`));
          assert.throws(() => a.planHistoryMutation(manifest, { readers: [subclassed] }), /agents\/Cy runs the autobiographical strategy, which keeps summaries or hears rows leave its window/);
          await assert.rejects(a.compileMutationPreview(manifest, { by: { by: 'operator' }, readers: [a] }), /^Error: ContextManager\.compileMutationPreview: a reader is the manager itself/);
          const branches = branchNames(a);
          await assert.rejects(a.applyHistoryMutation(manifest, {
            targetBranch: 'surgery/no-clone', expectedSourceBranch: 'main', expectedPlanSha256: a.planHistoryMutation(manifest).planSha256, by: { by: 'operator' }, readers: [subclassed],
          }), /^Error: ContextManager\.applyHistoryMutation: the reader with strategy namespace agents\/Cy/);
          assert.deepEqual(branchNames(a), branches, 'refused before a branch is made');
        } finally {
          subclassed.close();
          mine.close();
          twin.close();
        }
      });
    } finally {
      elsewhere.close();
    }
  });

  it('reconciles a reader whose strategy keeps nothing of what it folds through a stand-in, and reads back every reader it names', async () => {
    class Plain extends PassthroughStrategy {}
    const path = join(dir, `store-${stores++}`);
    const main = await ContextManager.open({ path, namespace: 'agents/Main', strategy: new PassthroughStrategy() });
    const side = await ContextManager.open({ store: main.getStore(), namespace: 'agents/Side', isolate: true, strategy: new Plain(), auxiliaryMessageViews: [{}] });
    try {
      side.addMessage('Ada', [{ type: 'text', text: 'a row of the side\'s own' }]);
      side.presentRows([]);
      const id = main.addMessage('User', [{ type: 'text', text: 'a row the side was never shown' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(main, id), content: [{ type: 'text', text: 'redacted' }], label: '[redacted by operator]' }] };
      const plan = main.planHistoryMutation(manifest, { readers: [side] });
      assert.deepEqual(plan.violations, []);
      assert.deepEqual(plan.readers[0]!.heldIds, [], 'setup: the mutation changes nothing the side holds');
      const sideSlot = main.getStore().listStates().map((state) => state.id).find((stateId) => stateId === 'agents/Side/messages')!;
      assert.ok(sideSlot, 'setup: the side keeps a slot of its own');
      const applyWith = (targetBranch: string, beforeSwitch?: (ctx: { view: JsStore }) => Promise<void>) => main.applyHistoryMutation(manifest, {
        targetBranch, expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [side], ...(beforeSwitch ? { beforeSwitch } : {}),
      });
      await assert.rejects(applyWith('surgery/aside', async ({ view }) => {
        const stored = view.getStateItemJson(sideSlot, 0) as Record<string, unknown>;
        view.editStateItem(sideSlot, 0, Buffer.from(JSON.stringify({ ...stored, content: [{ type: 'text', text: 'rewritten aside' }] })));
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && /reader agents\/Side: message [^ ]+'s content/.test(String(error)));
      await assert.rejects(applyWith('surgery/unanswered', async ({ view }) => {
        new MessageStore(view, { namespace: 'agents/Side' }).append('User', [{ type: 'tool_result', toolUseId: 'no-such-call', content: 'an answer to nothing' }]);
      }), (error: unknown) => refusedWith('INVARIANT_BROKEN')(error) && /reader agents\/Side: /.test(String(error)));
      await applyWith('surgery/redacted');
      await side.setStrategy(side.getStrategy());
      assert.equal(side.currentBranch().name, 'surgery/redacted');
      assert.match(rendered((await side.compile(undefined, undefined, { dryRun: true })).messages), /a row of the side's own/);
    } finally {
      side.close();
      main.close();
    }
  });

  it('takes a presented row the reader\'s view filter hides out of its window too', async () => {
    const path = await twoResidentStore();
    let last = '';
    const a = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
    const b = await ContextManager.open({ store: a.getStore(), namespace: NS_B, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane, viewFilter: (row) => row.id !== last });
    try {
      a.presentRows([]);
      b.presentRows([]);
      last = a.addMessage('User', [{ type: 'text', text: 'a late row' }]);
      a.presentRows([last]);
      b.presentRows([last]);
      assert.notEqual(b.ordinalOf(last), undefined, 'setup: the reader\'s window holds the row');
      assert.deepEqual(coveringOf(b, last), [], 'setup: and nothing of the reader\'s folds it');
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: [last], expectedSha256ById: { [last]: messageSha(a, last) } }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      assert.deepEqual(plan.violations, []);
      assert.deepEqual(plan.readers[0]!.heldIds, [last]);
      await a.applyHistoryMutation(manifest, { targetBranch: 'surgery/hidden', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b] });
      await b.setStrategy(b.getStrategy());
      assert.equal(b.ordinalOf(last), undefined);
      assert.deepEqual(b.retractAbsentRows(), []);
    } finally {
      b.close();
      a.close();
    }
  });

  it('refuses removing a row a legacy reader folds unless its policy drops what folds it, and then has the reader let go of it', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const folded = summariesIn(b, NS_B, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const removal = { kind: 'remove_messages' as const, messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, messageSha(a, id)])) };
      const refused = a.planHistoryMutation({ ops: [removal] }, { readers: [b] });
      assert.ok(refused.violations.some((v) => v.code === 'FOLDED_ROW_REQUIRES_POLICY' && v.remediation?.readerNamespace === NS_B), JSON.stringify(refused.violations));
      const manifest: HistoryMutationManifest = { ops: [{ ...removal, foldedPolicy: 'drop_covering_summaries' }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      assert.deepEqual(plan.violations, []);
      assert.ok(plan.readers[0]!.droppedSummaries.includes(folded.id));
      await a.applyHistoryMutation(manifest, { targetBranch: 'surgery/legacy-removed', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b] });
      await b.setStrategy(b.getStrategy());
      for (const dropped of plan.readers[0]!.droppedSummaries) assert.equal(b.getSummary(dropped), null, `${dropped} is dropped from the reader`);
    });
  });

  it('waits for a reader\'s strategy to let go of the rows it was told left before going on', async () => {
    const events: string[] = [];
    const gate = heldGate();
    class SlowLetGo extends AutobiographicalStrategy {
      constructor(private readonly settings: ConstructorParameters<typeof AutobiographicalStrategy>[0]) {
        super(settings);
      }
      override async onRetracted(...args: Parameters<AutobiographicalStrategy['onRetracted']>): Promise<void> {
        await gate.pass();
        await super.onRetracted(...args);
        events.push('let go');
      }
      override cloneForScratch(): SlowLetGo {
        return new SlowLetGo({ ...this.settings, autoTickOnNewMessage: false });
      }
    }
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      a.presentRows([]);
      b.presentRows([]);
      const folded = summariesIn(b, NS_B, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, messageSha(a, id)])) }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      const applied = a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/slow', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
        beforeSwitch: async () => { events.push('beforeSwitch'); },
      });
      await gate.held();
      assert.deepEqual(events, [], 'nothing goes on while the let-go is held');
      gate.open();
      await applied;
      assert.deepEqual(events.slice(0, 2), ['let go', 'beforeSwitch']);
      assert.ok(summariesIn(b, NS_B, 'surgery/slow').every((s) => !plan.readers[0]!.droppedSummaries.includes(s.id)));
    }, () => new SlowLetGo({ ...RESIDENT, autoTickOnNewMessage: false } as never));
  });

  it('refuses a preview or an apply while a reader stores the shards of a sharded addMessage', async () => {
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
      }
    }
    for (const operation of ['compileMutationPreview', 'applyHistoryMutation'] as const) {
      const path = join(dir, `store-${stores++}`);
      const main = await ContextManager.open({ path, namespace: 'agents/Main', strategy: new PassthroughStrategy() });
      const side = await ContextManager.open({ store: main.getStore(), namespace: 'agents/Side', isolate: true, strategy: new Sharding() });
      try {
        const id = main.addMessage('User', [{ type: 'text', text: 'an earlier row' }]);
        const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(main, id), content: [{ type: 'text', text: 'redacted' }], label: '[redacted by operator]' }] };
        const plan = main.planHistoryMutation(manifest, { readers: [side] });
        let asked: Promise<unknown> | undefined;
        side.onMessage((event) => {
          if (event.type !== 'add' || asked) return;
          asked = operation === 'compileMutationPreview'
            ? main.compileMutationPreview(manifest, { by: { by: 'operator' }, readers: [side] })
            : main.applyHistoryMutation(manifest, { targetBranch: 'surgery/reader-mid-add', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [side] });
        });
        side.addMessage('Ada', [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two ' }, { type: 'text', text: 'three' }]);
        assert.ok(asked, `setup: the ${operation} was asked for`);
        await assert.rejects(asked, new RegExp(`^Error: ContextManager\\.${operation} refused: a sharded addMessage is storing its shards`));
        assert.deepEqual(branchNames(main), ['main'], operation);
      } finally {
        side.close();
        main.close();
      }
    }
  });

  it('says that a plan drifts where the history, the manifest or the readers changed', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'as it was' }]);
      const op = { kind: 'edit_message' as const, messageId: id, expectedSha256: messageSha(manager, id), label: '[edited by operator]', content: [{ type: 'text' as const, text: 'as edited' }] };
      const plan = manager.planHistoryMutation({ ops: [op] });
      await assert.rejects(
        manager.applyHistoryMutation({ ops: [{ ...op, content: [{ type: 'text', text: 'edited otherwise' }] }] }, { targetBranch: 'surgery/drift', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' } }),
        (error: unknown) => refusedWith('PLAN_DRIFT')(error) && /the history, the manifest or the readers changed since that plan was made/.test(String(error)),
      );
    } finally {
      manager.close();
    }
  });

  it('reports a plan that drifted as PLAN_DRIFT before what the plan made now refuses', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const op = { kind: 'edit_message' as const, messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text' as const, text: 'a row rewritten' }], label: '[edited by operator]' };
      const agreed = a.planHistoryMutation({ ops: [{ ...op, foldedPolicy: 'leave_summaries' }] });
      await assert.rejects(a.applyHistoryMutation({ ops: [op] }, {
        targetBranch: 'surgery/drifted', expectedSourceBranch: 'main', expectedPlanSha256: agreed.planSha256, by: { by: 'operator' }, readers: [b],
      }), (error: unknown) => error instanceof HistoryMutationError && error.violations.map((v) => v.code).join() === 'PLAN_DRIFT' && error.plan?.valid === false);
    });
  });

  it('refuses a plan whose dropped summary changed since it was made', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text', text: 'a row rewritten' }],
        label: '[edited by operator]', foldedPolicy: 'drop_covering_summaries',
      }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      const dropped = plan.droppedSummaries.find((summaryId) => a.describeMutationTarget({ summaryId })?.kind === 'summary' && !a.getSummary(summaryId)?.carriedFrom)!;
      const described = a.describeMutationTarget({ summaryId: dropped });
      assert.ok(described?.kind === 'summary');
      a.editSummaryText(dropped, 'Edited since the plan.', { by: 'someone' }, { apply: true, dropResponseContent: true, expectedPriorSha256: described.sha256 });
      await assert.rejects(a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/edited-since', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
      }), refusedWith('PLAN_DRIFT'));
    });
  });

  it('refuses a native switch that didn\'t happen as not applied, even where another selection moved the store meanwhile', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const store = manager.getStore();
      store.createBranch('elsewhere', 'main');
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const branches = branchNames(manager);
      const native = store.switchBranch.bind(store);
      store.switchBranch = (name: string) => {
        if (name !== 'surgery/refused') return native(name);
        native('elsewhere');
        markStoreBranchSwitch(store);
        native('main');
        markStoreBranchSwitch(store);
        throw new Error('the native switch refused');
      };
      try {
        await assert.rejects(manager.applyHistoryMutation(manifest, {
          targetBranch: 'surgery/refused', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        }), (error: unknown) => /the native switch refused/.test(String(error)) && !refusedWith('APPLIED_INIT_FAILED')(error));
      } finally {
        store.switchBranch = native;
      }
      assert.equal(store.currentBranch().name, 'main');
      assert.deepEqual(branchNames(manager), branches, 'the branch it built is deleted');
    });
  });

  it('refuses a preview or an apply that names no one who makes it', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      for (const by of [undefined, null, { by: '  ' }, { by: 7 }]) {
        await assert.rejects(manager.compileMutationPreview(manifest, { by: by as never }), /compileMutationPreview: a mutation names who makes it/, String(by));
        await assert.rejects(manager.applyHistoryMutation(manifest, {
          targetBranch: 'surgery/nobody', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: by as never,
        }), /applyHistoryMutation: a mutation names who makes it/, String(by));
      }
    });
  });

  it('sends an edited message as edited where a replay form stood in for its text', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      manager.addMessage('User', [{ type: 'text', text: 'Which day is the meeting?' }]);
      const monday = 'The meeting is on Monday.';
      const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: monday }] };
      const id = manager.addMessage('Ada', [{ type: 'text', text: monday, rawItem: item } as ContentBlock]);
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), label: '[corrected by operator]',
        content: manager.getMessage(id)!.content.map((block) => ({ ...block, text: 'The meeting is on Tuesday.' }) as ContentBlock),
      }] };
      const sent = async (messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>) => {
        const adapter = new MockAdapter({ defaultResponse: 'ok' });
        await new Membrane(adapter, { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Ada' }).complete({
          messages: messages.map(({ participant, content }) => ({ participant, content })),
          config: { model: 'test-model', maxTokens: 16 },
        });
        return JSON.stringify(adapter.getLastRequest()?.messages);
      };
      const op = manifest.ops[0]!;
      assert.ok(op.kind === 'edit_message');
      const stale = await sent([{ participant: 'Ada', content: op.content }]);
      assert.match(stale, /Monday/, 'setup: sent as the edit gives it, the kept replay form sends the old text');
      assert.doesNotMatch(stale, /Tuesday/, 'setup: and not the new');
      const preview = await manager.compileMutationPreview(manifest, { by: { by: 'operator' } });
      await apply(manager, manifest, 'surgery/replayed');
      const compiled = await manager.compile(undefined, undefined, { dryRun: true });
      for (const [what, messages] of [['preview', preview.compiled.messages], ['apply', compiled.messages]] as const) {
        const wire = await sent(messages);
        assert.match(wire, /Tuesday/, what);
        assert.doesNotMatch(wire, /Monday/, what);
      }
    } finally {
      manager.close();
    }
  });

  it('says what a failed checkpoint left of a branch it built', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      const plan = manager.planHistoryMutation(manifest);
      const store = manager.getStore();
      const { createBranch, deleteBranch } = { createBranch: store.createBranch.bind(store), deleteBranch: store.deleteBranch.bind(store) };
      store.createBranch = (name: string, from?: string | null) => (name === 'surgery/created' ? withBranchFileBlocked(path, () => createBranch(name, from)) : createBranch(name, from));
      try {
        await assert.rejects(apply(manager, manifest, 'surgery/created', plan));
      } finally {
        store.createBranch = createBranch;
      }
      assert.ok(!branchNames(manager).includes('surgery/created'), 'a branch created in memory before its checkpoint failed is deleted');
      store.deleteBranch = (name: string) => (name === 'surgery/unsaved' ? withBranchFileBlocked(path, () => deleteBranch(name)) : deleteBranch(name));
      try {
        await assert.rejects(
          manager.applyHistoryMutation(manifest, {
            targetBranch: 'surgery/unsaved', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
            beforeSwitch: async () => { throw new Error('the host could not reconcile its other residents'); },
          }),
          (error: unknown) => refusedWith('BRANCH_LEFT')(error) && /its deletion is not saved yet: getStore\(\)\.sync\(\) saves it/.test(String(error)),
        );
      } finally {
        store.deleteBranch = deleteBranch;
      }
      assert.equal(manager.currentBranch().name, 'main');
      assert.ok(!branchNames(manager).includes('surgery/unsaved'), 'the deletion holds in memory');
      store.sync();
    });
    await resident(path, async (manager) => {
      assert.equal(manager.currentBranch().name, 'main');
      assert.ok(!branchNames(manager).some((name) => name === 'surgery/created' || name === 'surgery/unsaved'), 'saved, neither branch is there on a reopen');
    });
  });

  it('reports the anomalies of a history as it stands', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
    try {
      const id = manager.addMessage('Ada', [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
      assert.deepEqual(manager.checkHistoryInvariants().map((a) => [a.code, a.targetId]), [['TOOL_PAIR_SPLIT', id]]);
    } finally {
      manager.close();
    }
  });

  it('plans no summary edit for a strategy that keeps no history memory', async () => {
    class NoMemory extends PassthroughStrategy {
      importExternalMemory(): never { throw new Error('not here'); }
      dropSummaries(): string[] { return []; }
    }
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new NoMemory(), membrane });
    try {
      manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
      const plan = manager.planHistoryMutation({ ops: [{ kind: 'edit_summary', summaryId: 'L1-0', expectedSha256: '0'.repeat(64), newText: 'by hand' }] });
      assert.deepEqual(plan.violations.map((v) => v.code), ['STRATEGY_UNSUPPORTED']);
    } finally {
      manager.close();
    }
  });

  it('refuses an apply through a manager bound to a branch, before it writes anything', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const derived = await manager.derive({ branch: 'derived', strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never) });
      try {
        const { manifest } = l1Edit(derived);
        const branches = branchNames(manager);
        const head = branchHead(manager, 'derived');
        await assert.rejects(apply(derived, manifest, 'surgery/derived'), /bound to a branch and can't move the store/);
        assert.deepEqual(branchNames(manager), branches);
        assert.equal(branchHead(manager, 'derived'), head);
      } finally {
        derived.close();
      }
    });
  });

  it('prices an edited summary\'s recall answer by its new text', async () => {
    const path = await residentStore();
    const strategy = new AnswerOf({ ...RESIDENT, autoTickOnNewMessage: false } as never);
    const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane });
    try {
      const { target } = l1Edit(manager);
      manager.editSummaryText(target.id, 'Edited once, by hand.', { by: 'a' }, { apply: true, dropResponseContent: true });
      strategy.price(target.id);
      manager.editSummaryText(target.id, 'Edited twice, by hand', { by: 'an editor with a much longer name' }, { apply: true });
      assert.equal(strategy.price(target.id).estimate, strategy.freshPrice(target.id));
      strategy.takeUpEditor(target.id, 'another instance\'s editor, whose name is longer still');
      assert.equal(strategy.price(target.id).estimate, strategy.freshPrice(target.id), 'the memo is keyed by who edited the text');
    } finally {
      manager.close();
    }
  });

  it('prices a summary edited again by the same editor by its new text', async () => {
    const path = await residentStore();
    const strategy = new AnswerOf({ ...RESIDENT, autoTickOnNewMessage: false } as never);
    const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane });
    try {
      const { target } = l1Edit(manager);
      const plain = 'plain words in a quiet row, said slowly';
      const dense = '{}[],:"'.repeat(10).slice(0, plain.length);
      manager.editSummaryText(target.id, plain, { by: 'a' }, { apply: true, dropResponseContent: true });
      const before = strategy.price(target.id).estimate;
      manager.editSummaryText(target.id, dense, { by: 'a' }, { apply: true });
      assert.notEqual(strategy.freshPrice(target.id), before, 'setup: the same length and editor, and another price');
      assert.equal(strategy.price(target.id).estimate, strategy.freshPrice(target.id));
    } finally {
      manager.close();
    }
  });

  it('leaves the store on the source branch when the process dies before the switch', async () => {
    const path = await residentStore();
    let args = '';
    let before: ReturnType<typeof sourceState> | undefined;
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager);
      before = sourceState(manager);
      args = JSON.stringify({ path, namespace: NS, strategy: { ...RESIDENT, autoTickOnNewMessage: false }, manifest, targetBranch: 'surgery/killed' });
    });
    const child = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '_harness', 'apply-then-die.js'), args], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.match(child.stdout, /^built: The first stretch, by hand\.$/m, 'the target branch held the edit when the process died');
    await resident(path, async (manager) => {
      assert.equal(manager.currentBranch().name, 'main');
      assert.deepEqual(sourceState(manager), before);
      assert.deepEqual(manager.checkHistoryInvariants(), []);
    });
  });
  function withBranchFileBlocked<T>(path: string, body: () => T): T {
    const file = join(path, 'branches.bin');
    renameSync(file, `${file}.held`);
    mkdirSync(file);
    try {
      return body();
    } finally {
      rmdirSync(file);
      renameSync(`${file}.held`, file);
    }
  }

  it('says a switch that landed and failed its checkpoint is applied, with its receipt and how to save it', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'as it was' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), label: '[edited by operator]', content: [{ type: 'text', text: 'as edited' }] }] };
      const plan = manager.planHistoryMutation(manifest);
      const store = manager.getStore();
      const native = store.switchBranch.bind(store);
      store.switchBranch = (name: string) => (name === 'surgery/unsaved' ? withBranchFileBlocked(path, () => native(name)) : native(name));
      let caught: unknown;
      try {
        await manager.applyHistoryMutation(manifest, { targetBranch: 'surgery/unsaved', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' } });
      } catch (error) {
        caught = error;
      } finally {
        store.switchBranch = native;
      }
      assert.ok(caught instanceof HistoryMutationError && caught.violations.map((v) => v.code).join() === 'APPLIED_INIT_FAILED', String(caught));
      assert.equal(caught.receipt?.targetBranch, 'surgery/unsaved');
      assert.match(caught.message, /getStore\(\)\.sync\(\) saves a switch whose checkpoint failed/);
      assert.equal(store.currentBranch().name, 'surgery/unsaved', 'the store is on the branch it built');
      assert.ok(manager.listBranches().some((b) => b.name === 'surgery/unsaved'), 'and the branch is kept');
      assert.throws(() => manager.describeMutationTarget({ messageId: id }), /requires successful strategy initialization/, 'the manager refuses work until it is initialized there');
      store.sync();
      await manager.setStrategy(manager.getStrategy());
      assert.equal(rendered([manager.getMessage(id)!]), '[edited by operator]\nas edited');
    } finally {
      manager.close();
    }
    const reopened = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      assert.equal(reopened.currentBranch().name, 'surgery/unsaved', 'sync() saved the switch');
    } finally {
      reopened.close();
    }
  });

  it('leaves the store on a branch whose switch failed its checkpoint, with the manager refusing work until it is initialized there', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      manager.addMessage('User', [{ type: 'text', text: 'a row' }]);
      const store = manager.getStore();
      store.createBranch('elsewhere', 'main');
      const native = store.switchBranch.bind(store);
      store.switchBranch = (name: string) => withBranchFileBlocked(path, () => native(name));
      try {
        await assert.rejects(manager.switchBranch('elsewhere'), /Branch selection elsewhere took effect, and saving it failed/);
      } finally {
        store.switchBranch = native;
      }
      assert.equal(store.currentBranch().name, 'elsewhere');
      assert.throws(() => manager.describeMutationTarget({ summaryId: 'none' }), /requires successful strategy initialization/);
      store.sync();
      await manager.setStrategy(manager.getStrategy());
      assert.equal(manager.currentBranch().name, 'elsewhere');
    } finally {
      manager.close();
    }
  });

  it('refuses a plan whose dropped summary another handle changed since, the manager\'s or a reader\'s', async () => {
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      const id = foldedByBoth(a, b);
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), content: [{ type: 'text', text: 'a row rewritten' }],
        label: '[edited by operator]', foldedPolicy: 'drop_covering_summaries',
      }] };
      const editElsewhere = async (namespace: string, ids: readonly string[], text: string) => {
        const other = await ContextManager.open({ store: a.getStore(), namespace, strategy: new AutobiographicalStrategy({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
        try {
          const summaryId = ids.find((s) => other.getSummary(s)?.level === 1 && !other.getSummary(s)?.carriedFrom)!;
          const described = other.describeMutationTarget({ summaryId });
          assert.ok(described?.kind === 'summary', `setup: ${namespace} has summary ${summaryId}`);
          other.editSummaryText(summaryId, text, { by: 'someone' }, { apply: true, dropResponseContent: true, expectedPriorSha256: described.sha256 });
        } finally {
          other.close();
        }
      };
      for (const [whose, namespace, dropped] of [
        ['a reader\'s', NS_B, (plan: HistoryMutationPlan) => plan.readers[0]!.droppedSummaries],
        ['the manager\'s', NS, (plan: HistoryMutationPlan) => plan.droppedSummaries],
      ] as const) {
        const plan = a.planHistoryMutation(manifest, { readers: [b] });
        await editElsewhere(namespace, dropped(plan), `Edited through another handle (${whose}).`);
        await assert.rejects(a.applyHistoryMutation(manifest, {
          targetBranch: `surgery/elsewhere-${namespace}`, expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
        }), refusedWith('PLAN_DRIFT'), whose);
        assert.equal(a.currentBranch().name, 'main', `${whose}: the store stays on the source`);
      }
    });
  });

  it('refuses a summary edit where reading the stored summaries to compare them fails, and writes nothing', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { op, target } = l1Edit(manager);
      const store = manager.getStore();
      const summariesId = `${NS}/autobio:summaries`;
      const held = store.getStateJson(summariesId) as SummaryEntry[];
      const other = held.find((s) => s.id !== target.id)!;
      const newer = held.map((s) => (s.id === other.id ? { ...s, content: 'a newer text of another summary' } : s));
      store.setStateJson(summariesId, newer);
      const get = store.getStateJson.bind(store);
      let failures = 0;
      store.getStateJson = (id: string) => {
        if (id === summariesId && failures++ === 0) throw new Error('the read failed');
        return get(id);
      };
      try {
        assert.throws(
          () => manager.editSummaryText(target.id, 'Edited by hand.', { by: 'operator' }, { apply: true, dropResponseContent: true, expectedPriorSha256: op.expectedSha256 }),
          /the stored summaries can't be shown to be as this strategy holds them/,
        );
      } finally {
        store.getStateJson = get;
      }
      assert.equal(failures, 1, 'setup: the compare read failed');
      assert.deepEqual(store.getStateJson(summariesId), newer, 'nothing written');
      assert.equal(manager.getSummary(target.id)?.content, target.content, 'nothing changed in memory');
    });
  });

  it('holds an edit a summary write made before it threw, so asking again finds the new text', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { op, target } = l1Edit(manager);
      const store = manager.getStore();
      const summariesId = `${NS}/autobio:summaries`;
      const set = store.setStateJson.bind(store);
      store.setStateJson = (id: string, value: unknown) => {
        const written = set(id, value);
        if (id === summariesId) throw new Error('the write landed, and then failed');
        return written;
      };
      const ask = () => manager.editSummaryText(target.id, 'Edited by hand.', { by: 'operator' }, { apply: true, dropResponseContent: true, expectedPriorSha256: op.expectedSha256 });
      try {
        assert.throws(ask, /threw, and it landed: read the summary before asking for the edit again \(the write landed, and then failed\)/);
      } finally {
        store.setStateJson = set;
      }
      assert.equal(manager.getSummary(target.id)?.content, 'Edited by hand.', 'memory holds what the store holds');
      assert.equal((store.getStateJson(summariesId) as SummaryEntry[]).find((s) => s.id === target.id)?.content, 'Edited by hand.');
      assert.throws(ask, /not the [0-9a-f]{64} given: read it again/, 'asking again finds the new text');
    });
  });

  it('reports a plan that has become invalid since as PLAN_DRIFT, though its targets are the same', async () => {
    const path = join(dir, `store-${stores++}`);
    const a = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    const b = await ContextManager.open({ store: a.getStore(), namespace: NS_B, isolate: true, auxiliaryMessageViews: [{}], strategy: new PassthroughStrategy() });
    try {
      a.addMessage('User', [{ type: 'text', text: 'look it up' }]);
      const id = a.addMessage('Ada', [{ type: 'tool_use', id: 't1', name: 'read', input: {} }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: [id], expectedSha256ById: { [id]: messageSha(a, id) } }] };
      const agreed = a.planHistoryMutation(manifest, { readers: [b] });
      assert.equal(agreed.valid, true, 'setup: the call has no result yet');
      b.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'found it' }]);
      const now = a.planHistoryMutation(manifest, { readers: [b] });
      assert.equal(now.valid, false, 'setup: the removal now splits the pair in the reader\'s record');
      assert.notEqual(now.planSha256, agreed.planSha256);
      await assert.rejects(a.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/now-invalid', expectedSourceBranch: 'main', expectedPlanSha256: agreed.planSha256, by: { by: 'operator' }, readers: [b],
      }), (error: unknown) => error instanceof HistoryMutationError && error.violations.map((v) => v.code).join() === 'PLAN_DRIFT' && error.plan?.valid === false);
    } finally {
      b.close();
      a.close();
    }
  });

  it('places the KV boundary at an edited row that the edit brings into a view', async () => {
    const path = join(dir, `store-${stores++}`);
    const hides = (row: { content: ContentBlock[] }) => !row.content.some((block) => block.type === 'text' && block.text === 'hidden');
    const a = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy(), viewFilter: hides });
    const b = await ContextManager.open({ store: a.getStore(), namespace: NS_B, strategy: new PassthroughStrategy(), viewFilter: hides });
    try {
      a.addMessage('User', [{ type: 'text', text: 'first' }]);
      const id = a.addMessage('User', [{ type: 'text', text: 'hidden' }]);
      a.addMessage('Ada', [{ type: 'text', text: 'later' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), label: '[edited by operator]', content: [{ type: 'text', text: 'now shown' }] }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      assert.equal(plan.invalidatesKvPrefixFrom?.messageId, id, 'the manager\'s own view');
      assert.equal(plan.readers[0]!.invalidatesKvPrefixFrom?.messageId, id, 'the reader\'s view');
      const later = a.getAllMessages().at(-1)!.id;
      const both = a.planHistoryMutation({ ops: [
        manifest.ops[0]!,
        { kind: 'edit_message', messageId: later, expectedSha256: messageSha(a, later), label: '[edited by operator]', content: [{ type: 'text', text: 'later, edited' }] },
      ] }, { readers: [b] });
      assert.deepEqual([both.invalidatesKvPrefixFrom?.messageId, both.readers[0]!.invalidatesKvPrefixFrom?.messageId], [id, id], 'it comes into the view before a later edited row');
      const stillHidden = a.planHistoryMutation({ ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(a, id), label: '[edited by operator]', content: [{ type: 'text', text: 'hidden' }] }] }, { readers: [b] });
      assert.deepEqual([stillHidden.invalidatesKvPrefixFrom, stillHidden.readers[0]!.invalidatesKvPrefixFrom], [undefined, undefined], 'an edit that the view still leaves out changes nothing it sends');
      const before = rendered((await b.compile(undefined, undefined, { dryRun: true })).messages);
      await a.applyHistoryMutation(manifest, { targetBranch: 'surgery/shown', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b] });
      await b.setStrategy(b.getStrategy());
      const after = rendered((await b.compile(undefined, undefined, { dryRun: true })).messages);
      assert.ok(!before.includes('now shown') && after.includes('now shown'), 'setup: the edit brings the row into the reader\'s compile');
    } finally {
      b.close();
      a.close();
    }
  });

  it('refuses to switch to a branch where a window differs from its source\'s other than the plan says, the manager\'s or a reader\'s', async () => {
    const changes: Array<[string, (staged: ContextManager, rows: { kept: string; later: string }) => void, (rows: { kept: string; later: string }) => RegExp]> = [
      ['a kept row leaves it', (staged, { kept }) => staged.retractRows([kept]), ({ kept }) => new RegExp(`message ${kept} left its window`)],
      ['a kept row moves in it', (staged, { kept }) => { staged.retractRows([kept]); staged.presentRows([kept]); }, ({ kept }) => new RegExp(`message ${kept} moved in its window`)],
      ['a row it didn\'t hold comes into it', (staged, { later }) => staged.presentRows([later]), ({ later }) => new RegExp(`message ${later} is in its window, and the source's window didn't hold it`)],
    ];
    for (const whose of [NS, NS_B]) {
      for (const [what, change, says] of changes) {
        const path = join(dir, `store-${stores++}`);
        const a = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
        const b = await ContextManager.open({ store: a.getStore(), namespace: NS_B, strategy: new PassthroughStrategy() });
        try {
          const edited = a.addMessage('User', [{ type: 'text', text: 'edit me' }]);
          const kept = a.addMessage('Ada', [{ type: 'text', text: 'keep me' }]);
          a.presentRows([edited, kept]);
          b.presentRows([edited, kept]);
          const later = a.addMessage('User', [{ type: 'text', text: 'not presented yet' }]);
          const ordinals = [a, b].map((m) => [m.ordinalOf(kept), m.ordinalOf(later)]);
          const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: edited, expectedSha256: messageSha(a, edited), label: '[edited by operator]', content: [{ type: 'text', text: 'edited' }] }] };
          const plan = a.planHistoryMutation(manifest, { readers: [b] });
          await assert.rejects(a.applyHistoryMutation(manifest, {
            targetBranch: 'surgery/window', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b],
            beforeSwitch: async ({ view }) => {
              const staged = await ContextManager.open({ store: view, namespace: whose, strategy: new PassthroughStrategy() });
              try {
                change(staged, { kept, later });
              } finally {
                staged.close();
              }
            },
          }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && says({ kept, later }).test(String(error)), `${whose}: ${what}`);
          assert.equal(a.currentBranch().name, 'main', `${whose}: ${what}`);
          assert.deepEqual([a, b].map((m) => [m.ordinalOf(kept), m.ordinalOf(later)]), ordinals, `${whose}: ${what}: each window stays as it was`);
        } finally {
          b.close();
          a.close();
        }
      }
    }
  });
  it('waits for its own strategy on the branch to let go of the rows it removes before going on', async () => {
    const events: string[] = [];
    const gate = heldGate();
    class HeldLetGo extends AutobiographicalStrategy {
      constructor(private readonly settings: ConstructorParameters<typeof AutobiographicalStrategy>[0], private readonly staged = false) {
        super(settings);
      }
      override async onRetracted(...args: Parameters<AutobiographicalStrategy['onRetracted']>): Promise<void> {
        if (this.staged) await gate.pass();
        await super.onRetracted(...args);
        if (this.staged) events.push('let go');
      }
      override cloneForScratch(): HeldLetGo {
        return new HeldLetGo({ ...this.settings, autoTickOnNewMessage: false }, true);
      }
    }
    const path = await residentStore();
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new HeldLetGo({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
    try {
      manager.presentRows([]);
      const folded = summariesOn(manager, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, messageSha(manager, id)])) }] };
      const plan = manager.planHistoryMutation(manifest);
      assert.deepEqual(plan.violations, []);
      const applied = manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/held', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        beforeSwitch: async () => { events.push('beforeSwitch'); },
      });
      await gate.held();
      assert.deepEqual(events, [], 'nothing goes on while the let-go is held');
      gate.open();
      await applied;
      assert.deepEqual(events.slice(0, 2), ['let go', 'beforeSwitch']);
    } finally {
      manager.close();
    }
  });

  it('refuses to switch where a strategy on the branch fails to let go of the rows it removes', async () => {
    class FailingLetGo extends AutobiographicalStrategy {
      constructor(private readonly settings: ConstructorParameters<typeof AutobiographicalStrategy>[0], private readonly staged = false) {
        super(settings);
      }
      override async onRetracted(...args: Parameters<AutobiographicalStrategy['onRetracted']>): Promise<void> {
        await super.onRetracted(...args);
        if (this.staged) throw new Error('its own record of the let-go failed to write');
      }
      override cloneForScratch(): FailingLetGo {
        return new FailingLetGo({ ...this.settings, autoTickOnNewMessage: false }, true);
      }
    }
    const path = await twoResidentStore();
    await residents(path, async (a, b) => {
      a.presentRows([]);
      b.presentRows([]);
      const folded = summariesIn(b, NS_B, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, messageSha(a, id)])) }] };
      const plan = a.planHistoryMutation(manifest, { readers: [b] });
      assert.deepEqual(plan.violations, []);
      const branches = branchNames(a);
      await assert.rejects(
        a.applyHistoryMutation(manifest, { targetBranch: 'surgery/unheard', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, readers: [b] }),
        /the autobiographical strategy's onRetracted failed on the branch: its own record of the let-go failed to write/,
      );
      assert.equal(a.currentBranch().name, 'main');
      assert.deepEqual(branchNames(a), branches, 'the branch it built is deleted');
    }, () => new FailingLetGo({ ...RESIDENT, autoTickOnNewMessage: false } as never));
  });

  it('drops each summary its plan drops where the strategy doesn\'t hear rows leave', async () => {
    class Unhearing extends AutobiographicalStrategy {
      constructor(private readonly settings: ConstructorParameters<typeof AutobiographicalStrategy>[0]) {
        super(settings);
        Object.defineProperty(this, 'onRetracted', { value: undefined });
      }
      override cloneForScratch(): Unhearing {
        return new Unhearing({ ...this.settings, autoTickOnNewMessage: false });
      }
    }
    const path = await residentStore();
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new Unhearing({ ...RESIDENT, autoTickOnNewMessage: false } as never), membrane });
    try {
      assert.equal(manager.getStrategy().onRetracted, undefined, 'setup: the strategy has no onRetracted');
      const folded = summariesOn(manager, 'main').find((s) => s.level === 1)!;
      const ids = [...folded.sourceIds];
      const manifest: HistoryMutationManifest = { ops: [{
        kind: 'remove_messages', messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, messageSha(manager, id)])), foldedPolicy: 'drop_covering_summaries',
      }] };
      const plan = manager.planHistoryMutation(manifest);
      assert.deepEqual(plan.violations, []);
      assert.ok(plan.droppedSummaries.includes(folded.id), 'setup: the plan drops the summary that folds the rows');
      await manager.applyHistoryMutation(manifest, { targetBranch: 'surgery/unheard', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' } });
      assert.equal(manager.currentBranch().name, 'surgery/unheard');
      const left = new Set(summariesOn(manager, 'surgery/unheard').map((s) => s.id));
      assert.deepEqual(plan.droppedSummaries.filter((id) => left.has(id)), []);
    } finally {
      manager.close();
    }
  });

  it('names the editor it was asked with, though the caller changes it while it runs', async () => {
    const path = await residentStore();
    await resident(path, async (manager) => {
      const { manifest } = l1Edit(manager, 'A memory named by its editor.');
      let text = '';
      for (let maxTokens = 2_000; maxTokens >= 400 && !text.includes('editedBy='); maxTokens -= 100) {
        const by = { by: 'operator' };
        const asked = manager.compileMutationPreview(manifest, { by, budget: { maxTokens, reserveForResponse: 50 } });
        by.by = 'someone else';
        text = rendered((await asked).compiled.messages);
      }
      assert.match(text, /editedBy="operator">\nA memory named by its editor\./);
    });
  });

  it('reports the head of the branch at the switch, before the manager initializes there', async () => {
    let store: JsStore | undefined;
    class WritesOnInit extends PassthroughStrategy {
      async initialize(): Promise<void> {
        if (store) new MessageStore(store, { namespace: 'agents/Log' }).append('User', [{ type: 'text', text: 'initialized here' }]);
      }
    }
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new WritesOnInit() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'as it was' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), label: '[edited by operator]', content: [{ type: 'text', text: 'as edited' }] }] };
      const plan = manager.planHistoryMutation(manifest);
      const native = manager.getStore();
      const switchBranch = native.switchBranch.bind(native);
      let atSwitch: number | undefined;
      native.switchBranch = (name: string) => {
        const switched = switchBranch(name);
        if (name === 'surgery/headed') atSwitch = native.currentSequence();
        return switched;
      };
      store = native;
      let receipt: Awaited<ReturnType<ContextManager['applyHistoryMutation']>>;
      try {
        receipt = await manager.applyHistoryMutation(manifest, {
          targetBranch: 'surgery/headed', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' }, strategy: () => new PassthroughStrategy(),
        });
      } finally {
        native.switchBranch = switchBranch;
        store = undefined;
      }
      assert.ok(atSwitch !== undefined && native.currentSequence() > atSwitch, 'setup: the manager wrote on the branch as it initialized there');
      assert.equal(receipt.toSequence, atSwitch);
    } finally {
      manager.close();
    }
  });

  it('deletes the branch it made where reading the source\'s head then fails', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('User', [{ type: 'text', text: 'as it was' }]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'edit_message', messageId: id, expectedSha256: messageSha(manager, id), label: '[edited by operator]', content: [{ type: 'text', text: 'as edited' }] }] };
      const plan = manager.planHistoryMutation(manifest);
      const store = manager.getStore();
      const currentSequence = store.currentSequence.bind(store);
      store.currentSequence = () => {
        if (store.listBranches().some((b) => b.name === 'surgery/unread')) throw new Error('the head could not be read');
        return currentSequence();
      };
      try {
        await assert.rejects(
          manager.applyHistoryMutation(manifest, { targetBranch: 'surgery/unread', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' } }),
          /the head could not be read/,
        );
      } finally {
        store.currentSequence = currentSequence;
      }
      assert.deepEqual(branchNames(manager), ['main']);
    } finally {
      manager.close();
    }
  });

  it('refuses to switch to a branch where a removed row keeps a place in the manager\'s window', async () => {
    const path = join(dir, `store-${stores++}`);
    const manager = await ContextManager.open({ path, namespace: NS, strategy: new PassthroughStrategy() });
    try {
      const kept = manager.addMessage('User', [{ type: 'text', text: 'keep me' }]);
      const gone = manager.addMessage('Ada', [{ type: 'text', text: 'remove me' }]);
      manager.presentRows([kept, gone]);
      const manifest: HistoryMutationManifest = { ops: [{ kind: 'remove_messages', messageIds: [gone], expectedSha256ById: { [gone]: messageSha(manager, gone) } }] };
      const plan = manager.planHistoryMutation(manifest);
      assert.deepEqual(plan.violations, []);
      await assert.rejects(manager.applyHistoryMutation(manifest, {
        targetBranch: 'surgery/tombstone', expectedSourceBranch: 'main', expectedPlanSha256: plan.planSha256, by: { by: 'operator' },
        beforeSwitch: async ({ view }) => {
          view.appendToStateJson(`${NS}/window`, { id: gone });
        },
      }), (error: unknown) => refusedWith('READBACK_MISMATCH')(error) && new RegExp(`message ${gone} is still in its window`).test(String(error)));
      assert.equal(manager.currentBranch().name, 'main');
    } finally {
      manager.close();
    }
  });

  it('prices a summary by its text again once it takes up the summaries another handle wrote', async () => {
    const path = await residentStore();
    const strategy = new AnswerOf({ ...RESIDENT, autoTickOnNewMessage: false } as never);
    const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane });
    try {
      const { target } = l1Edit(manager);
      const prose = 'a plain memory in words '.repeat(4);
      const dense = '.,;:!?'.repeat(prose.length / 6);
      manager.editSummaryText(target.id, prose, { by: 'operator' }, { apply: true, dropResponseContent: true });
      const proseCost = strategy.price(target.id).estimate;
      manager.presentRows([]);
      const late = manager.addMessage('User', [{ type: 'text', text: 'a row to let go of' }]);
      manager.presentRows([late]);
      const store = manager.getStore();
      const summariesId = `${NS}/autobio:summaries`;
      store.setStateJson(summariesId, (store.getStateJson(summariesId) as SummaryEntry[]).map((s) => (s.id === target.id ? { ...s, content: dense } : s)));
      manager.retractRows([late]);
      for (let i = 0; i < 50 && manager.getSummary(target.id)?.content !== dense; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.getSummary(target.id)?.content, dense, 'setup: the let-go took up the stored summaries');
      assert.notEqual(strategy.freshPrice(target.id), proseCost, 'setup: the two texts price apart');
      assert.equal(strategy.price(target.id).estimate, strategy.freshPrice(target.id));
    } finally {
      manager.close();
    }
  });
});
