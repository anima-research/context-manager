/**
 * Context derivation — shared reads, separate writes.
 *
 * A derived manager starts from its parent's state at a checkpoint and
 * diverges: the inherited past is shared (no copy, same objects in memory),
 * every write lands on the writer's own branch, and the parent keeps
 * running. These tests hold the properties the fork primitive is accepted
 * on: neither side can alter what the other reads, the child reproduces the
 * parent's rendering when it reuses the solve, and creating a child does
 * not re-read the store.
 *
 * Needs branch-bound store handles (`JsStore.view`) and branches forked with
 * selected states (`createBranchWithStates`, `createBranchAtWithStates`). On
 * a Chronicle build without them every test that derives is skipped, by
 * name, with the reason; the refusal on such a build runs everywhere.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';

import {
  AutobiographicalStrategy,
  ContextDerivationUnsupportedError,
  ContextManager,
  MessageStore,
  PassthroughStrategy,
} from '../src/index.js';

type ViewStore = JsStore & { view(branch: string): JsStore };

const derivable = JsStore.prototype as unknown as Record<'view' | 'createBranchWithStates' | 'createBranchAtWithStates', unknown>;
const supported = typeof derivable.view === 'function'
  && typeof derivable.createBranchWithStates === 'function'
  && typeof derivable.createBranchAtWithStates === 'function';
const skip = supported ? false : 'installed @animalabs/chronicle has no JsStore.view or no selective forks (branch-bound handles)';

/** Enough turns that the budget below cannot hold them raw: the parent must fold. */
const HISTORY = 60;
const BUDGET = { maxTokens: 3000, reserveForResponse: 200 };

function mockMembrane() {
  let calls = 0;
  return {
    complete: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: `[mock summary #${++calls}]` }],
    }),
    get calls() { return calls; },
  };
}

function folding() {
  return new AutobiographicalStrategy({
    compressionModel: 'mock',
    adaptiveResolution: true,
    targetChunkTokens: 100,
    recentWindowTokens: 200,
  });
}

const turn = (i: number, tag = 'Turn') => [{ type: 'text' as const, text: `${tag} ${i}. ` + 'word '.repeat(40) }];

async function settle(manager: ContextManager): Promise<void> {
  while (!manager.isReady()) await manager.tick();
}

/** Every state's value as the given handle's branch sees it. */
function statesOf(store: JsStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const state of store.listStates()) {
    let value: unknown;
    try {
      value = store.getStateJson(state.id);
    } catch {
      continue; // tree states have no JSON value; nothing here writes them
    }
    out[state.id] = JSON.stringify(value);
  }
  return out;
}

describe('ContextManager.derive', () => {
  const dirs: string[] = [];
  const managers: ContextManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      try { manager.close(); } catch { /* derived managers do not own the store */ }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cm-derive-'));
    dirs.push(dir);
    return join(dir, 'store');
  }

  /** A folding parent with enough history to have a memory tree and a carried frontier. */
  async function foldedParent(config: Record<string, unknown> = {}) {
    const membrane = mockMembrane();
    const strategy = folding();
    const parent = await ContextManager.open({
      path: storePath(),
      strategy,
      membrane: membrane as never,
      ...config,
    });
    managers.push(parent);
    const ids: string[] = [];
    for (let i = 0; i < HISTORY; i++) ids.push(parent.addMessage(i % 2 ? 'Claude' : 'User', turn(i)));
    await settle(parent);
    await parent.compile(BUDGET);
    return { parent, strategy, membrane, ids };
  }

  it('the derived context starts as the parent\'s, then neither sees the other\'s writes', { skip }, async () => {
    const { parent, ids } = await foldedParent();
    const root = parent.getStore();
    const cursor = root.currentBranch().name;

    const child = await parent.derive({ branch: 'dendrite/child', strategy: folding() });
    assert.deepEqual(child.getAllMessages().map((m) => m.id), ids);
    assert.equal(root.currentBranch().name, cursor, 'deriving leaves the store cursor where it was');
    assert.equal(child.currentBranch().name, 'dendrite/child');
    const derivation = child.getDerivation()!;
    assert.deepEqual(
      { ...derivation, inherited: undefined },
      {
        parentBranch: cursor,
        branch: 'dendrite/child',
        atSequence: derivation.atSequence,
        solve: 'reuse',
        inherited: undefined,
        slots: { messageNamespace: null, contextNamespace: null, auxiliaryNamespaces: [] },
      },
    );
    // The strategy names what the child inherits: its memory and how it is
    // presented, not its work queue or its own refusal ledger.
    assert.deepEqual(derivation.inherited.statePrefixes, []);
    for (const id of ['messages', 'context', 'mint-preimage-envelopes', 'default/autobio:summaries', 'default/autobio:resolutions', 'default/autobio:merge-quarantine']) {
      assert.ok(derivation.inherited.stateIds.includes(id), `inherits ${id}`);
    }
    for (const id of ['default/autobio:mergeQueue', 'default/autobio:compression-refusal-quarantine-events']) {
      assert.equal(derivation.inherited.stateIds.includes(id), false, `does not inherit ${id}`);
    }
    assert.equal(parent.getDerivation(), null);

    // Appends.
    const parentOnly = parent.addMessage('User', turn(100, 'Parent-only'));
    const childOnly = child.addMessage('User', turn(200, 'Child-only'));
    assert.deepEqual(parent.getAllMessages().map((m) => m.id), [...ids, parentOnly]);
    assert.deepEqual(child.getAllMessages().map((m) => m.id), [...ids, childOnly]);

    // Edits of the inherited past, in both directions.
    const original = JSON.stringify(parent.getMessage(ids[3]!)!.content);
    child.editMessage(ids[3]!, [{ type: 'text', text: 'rewritten by the child' }]);
    assert.equal(JSON.stringify(parent.getMessage(ids[3]!)!.content), original, 'a child edit never reaches the parent');
    parent.editMessage(ids[5]!, [{ type: 'text', text: 'rewritten by the parent' }]);
    assert.notEqual(
      JSON.stringify(child.getMessage(ids[5]!)!.content),
      JSON.stringify(parent.getMessage(ids[5]!)!.content),
      'a parent edit after the checkpoint never changes the child\'s pinned past',
    );

    // Removal.
    parent.removeMessage(ids[7]!);
    assert.equal(parent.getMessage(ids[7]!), null);
    assert.ok(child.getMessage(ids[7]!), 'the child still holds what the parent removed after the checkpoint');
    child.removeMessage(ids[9]!);
    assert.ok(parent.getMessage(ids[9]!));

    // The full views agree with the point reads.
    assert.equal(child.getAllMessages().find((m) => m.id === ids[3])!.content[0]!.type, 'text');
    assert.equal(
      (child.getAllMessages().find((m) => m.id === ids[3])!.content[0] as { text: string }).text,
      'rewritten by the child',
    );
    assert.equal(parent.getAllMessages().some((m) => m.id === childOnly), false);
    assert.equal(child.getAllMessages().some((m) => m.id === parentOnly), false);
  });

  it('takes a view of its own, or keeps the parent\'s', { skip }, async () => {
    // A host whose forks see what their parent sees and their own rows besides
    // (agent-framework's shared forks, #291) hands derive the composed view;
    // without one, the child reads through the parent's filter, as before.
    const secret = (m: { metadata?: unknown }) => (m.metadata as { secret?: boolean } | undefined)?.secret === true;
    const { parent } = await foldedParent({ viewFilter: (m: { metadata?: unknown }) => !secret(m) });
    parent.addMessage('User', [{ type: 'text', text: 'SECRET ROW' }], { secret: true });
    await settle(parent);
    const texts = async (manager: ContextManager) =>
      (await manager.compile(BUDGET)).messages.map((m) => JSON.stringify(m.content));
    assert.ok(!(await texts(parent)).some((t) => t.includes('SECRET ROW')), 'the premise: the parent\'s view leaves the row out');

    const inherits = await parent.derive({ branch: 'dendrite/inherits', strategy: folding() });
    managers.push(inherits);
    assert.ok(!(await texts(inherits)).some((t) => t.includes('SECRET ROW')), 'no view given: the child reads through the parent\'s');

    const own = await parent.derive({ branch: 'dendrite/own', strategy: folding(), viewFilter: () => true });
    managers.push(own);
    assert.ok((await texts(own)).some((t) => t.includes('SECRET ROW')), 'its own view: the child sees what the parent\'s filter hid');
    assert.ok(!(await texts(parent)).some((t) => t.includes('SECRET ROW')), 'and the parent\'s view is untouched');

    const plain = (m: { metadata?: unknown }) => (m.metadata as { plain?: boolean } | undefined)?.plain === true;
    parent.addMessage('User', [{ type: 'text', text: 'PLAIN ROW' }], { plain: true });
    const selective = await parent.derive({ branch: 'dendrite/selective', strategy: folding(), viewFilter: (m) => !plain(m) });
    managers.push(selective);
    const seen = await texts(selective);
    assert.ok(seen.some((t) => t.includes('SECRET ROW')) && !seen.some((t) => t.includes('PLAIN ROW')), 'its own view in place of the parent\'s: what it admits and what it leaves out are its own');
    assert.ok((await texts(parent)).some((t) => t.includes('PLAIN ROW')), 'the parent still shows the row the child leaves out');

    const reopened = await ContextManager.reopenDerived({
      store: parent.getStore(),
      derivation: selective.getDerivation()!,
      strategy: folding(),
      membrane: mockMembrane() as never,
      viewFilter: (m) => !plain(m),
    });
    managers.push(reopened);
    const seenAgain = await texts(reopened);
    assert.ok(seenAgain.some((t) => t.includes('SECRET ROW')) && !seenAgain.some((t) => t.includes('PLAIN ROW')), 'reopened with the view it read through, the child sees what it saw');
  });

  it('shares the inherited messages in memory instead of copying them', { skip }, async () => {
    const { parent, ids } = await foldedParent();
    const before = parent.getAllMessages();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: folding() });

    parent.addMessage('User', turn(100, 'Parent-only'));
    child.addMessage('User', turn(200, 'Child-only'));
    const parentNow = parent.getAllMessages();
    const childNow = child.getAllMessages();

    for (let i = 0; i < ids.length; i++) {
      assert.equal(childNow[i], parentNow[i], `message ${i} is one object, shared by both managers`);
      assert.equal(parentNow[i], before[i], `message ${i} was not re-created by the append`);
    }
    // Ten more children add ten arrays of references, not ten histories.
    for (let n = 0; n < 10; n++) {
      const sibling = await parent.derive({ branch: `dendrite/sibling-${n}`, strategy: folding() });
      assert.equal(sibling.getAllMessages()[0], before[0]);
    }
  });

  it('does not re-read the message slot from the store to create or use a child', { skip }, async () => {
    const { parent } = await foldedParent();
    parent.getAllMessages(); // the parent is warm, as a running agent is

    const proto = JsStore.prototype as unknown as { getStateJson(id: string): unknown };
    const original = proto.getStateJson;
    const fullReads: string[] = [];
    proto.getStateJson = function (this: JsStore, id: string) {
      if (id === 'messages') fullReads.push(this.currentBranch().name);
      return original.call(this, id);
    };
    try {
      const child = await parent.derive({ branch: 'dendrite/child', strategy: folding() });
      child.getAllMessages();
      await child.compile(BUDGET);
      child.addMessage('User', turn(200, 'Child-only'));
      await child.compile(BUDGET);
      assert.equal(child.getMessage(child.getAllMessages()[0]!.id)?.participant, 'User');
    } finally {
      proto.getStateJson = original;
    }
    assert.deepEqual(fullReads, [], 'no full materialization of the message slot on either branch');
  });

  it('reusing the solve reproduces the parent\'s rendering, cache markers included', { skip }, async () => {
    const { parent, strategy } = await foldedParent();
    const childStrategy = folding();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: childStrategy });

    assert.deepEqual(
      [...(childStrategy as unknown as { resolutions: Map<string, number> }).resolutions],
      [...(strategy as unknown as { resolutions: Map<string, number> }).resolutions],
      'the carried fold frontier is inherited',
    );
    assert.ok((strategy as unknown as { resolutions: Map<string, number> }).resolutions.size > 0, 'there is a frontier to inherit');

    const fromChild = await child.compile(BUDGET);
    const fromParent = await parent.compile(BUDGET);
    assert.equal(
      JSON.stringify(fromChild.messages),
      JSON.stringify(fromParent.messages),
      'the child\'s first compile is the compile the parent would have made next',
    );
    assert.ok(
      fromChild.messages.some((m) => (m as { cacheBreakpoint?: boolean }).cacheBreakpoint),
      'and it carries cache markers',
    );

    // The hand-over matters: the same branch opened cold (as after a restart)
    // has no previous compile to measure a stable prefix against.
    const cold = await ContextManager.open({
      store: (parent.getStore() as ViewStore).view('dendrite/child'),
      strategy: folding(),
      membrane: mockMembrane() as never,
    });
    const fromCold = await cold.compile(BUDGET);
    assert.equal(
      JSON.stringify(fromCold.messages.map((m) => m.content)),
      JSON.stringify(fromChild.messages.map((m) => m.content)),
      'a cold open renders the same content',
    );
  });

  it('hands a reusing child the markers the parent placed, with the cache keys they were placed for', { skip }, async () => {
    const { parent, strategy } = await foldedParent();
    const childStrategy = folding();
    await parent.derive({ branch: 'dendrite/marks', strategy: childStrategy });
    type Marks = { _prevCacheKeys?: string[]; placedMarks: WeakMap<readonly string[], unknown> };
    const p = strategy as unknown as Marks;
    const c = childStrategy as unknown as Marks;
    assert.ok(p._prevCacheKeys && p.placedMarks.get(p._prevCacheKeys), 'the premise: the parent placed markers on its last compile');
    assert.notEqual(c._prevCacheKeys, p._prevCacheKeys, 'the child holds its own copy of the keys');
    assert.deepEqual(c.placedMarks.get(c._prevCacheKeys!), p.placedMarks.get(p._prevCacheKeys!), 'and the markers placed for them');
  });

  it('carries the manager\'s thinking-binding record, so a reusing child keeps the thinking the parent keeps', { skip }, async () => {
    const parent = await ContextManager.open({ path: storePath(), strategy: folding(), membrane: mockMembrane() as never });
    managers.push(parent);
    const big = { maxTokens: 1_000_000, reserveForResponse: 0 };
    const identity = { system: 'system-1', tools: 'tools-1', model: 'model-1', request: 'request-1' };
    const bind = { thinkingBinding: { binds: true, dropBlock: false, participant: 'Claude' }, identity } as never;
    parent.addMessage('User', [{ type: 'text', text: 'Hello.' }]);
    await parent.compile(big, undefined, bind);
    const reply = parent.addMessage('Claude', [
      { type: 'thinking', thinking: 'reasoning '.repeat(20), signature: 'sig-0123456789abcdef' } as never,
      { type: 'text', text: 'Hi.' },
    ]);
    const { compileId } = parent.getStore().getStateJson('default/thinking-binding') as { compileId: string };
    assert.ok(parent.noteRequestSent([reply], identity as never, compileId), 'the parent notes its reply');
    parent.addMessage('User', [{ type: 'text', text: 'Again.' }]);
    const child = await parent.derive({ branch: 'dendrite/thinking', strategy: folding() });
    const fromChild = await child.compile(big, undefined, bind);
    const fromParent = await parent.compile(big, undefined, bind);
    assert.ok(JSON.stringify(fromParent.messages).includes('"thinking"'), 'the parent keeps the reply\'s thinking');
    assert.equal(JSON.stringify(fromChild.messages), JSON.stringify(fromParent.messages), 'and so does the child');
    assert.ok(child.getDerivation()!.inherited.stateIds.includes('default/thinking-binding'), 'the record says it inherited the binding record');
  });

  it('carries a tail and pace moved by hot settings, so the child chunks and compiles as the parent would', { skip }, async () => {
    const { parent } = await foldedParent();
    parent.updateHotContextSettings({ tailTokens: 600, transitionPaceTokens: 300 });
    for (let i = 0; i < 6; i++) parent.addMessage(i % 2 ? 'Claude' : 'User', turn(HISTORY + i));
    await settle(parent);
    await parent.compile(BUDGET);
    const child = await parent.derive({ branch: 'dendrite/hot', strategy: folding() });
    const chunks = 'default/autobio:chunks';
    assert.equal(
      JSON.stringify(child.getStore().getStateJson(chunks)),
      JSON.stringify(parent.getStore().getStateJson(chunks)),
      'the child chunks nothing the parent keeps in its tail',
    );
    assert.deepEqual(child.getHotContextSettings(), parent.getHotContextSettings());
    const fromChild = await child.compile(BUDGET);
    const fromParent = await parent.compile(BUDGET);
    assert.equal(JSON.stringify(fromChild.messages), JSON.stringify(fromParent.messages));
  });

  it('gives a child no runtime pace where its parent had none, as the parent recorded it', { skip }, async () => {
    const { parent, strategy } = await foldedParent();
    parent.updateHotContextSettings({ tailTokens: 600 });
    await parent.compile(BUDGET);
    const childStrategy = folding();
    childStrategy.updateHotContextSettings({ transitionPaceTokens: 450 });
    const child = await parent.derive({ branch: 'dendrite/no-pace', strategy: childStrategy });
    const pace = (s: unknown) => (s as { runtimeTransitionPaceTokens?: number }).runtimeTransitionPaceTokens;
    assert.equal(pace(strategy), undefined, 'the premise: the parent runs at its implicit pace');
    assert.equal(pace(childStrategy), undefined);
    assert.deepEqual(child.getHotContextSettings(), parent.getHotContextSettings());
  });

  it('hands an accepted kv-unified receipt to a reusing child, and a fresh child clears only its own', { skip }, async () => {
    const kv = () => new AutobiographicalStrategy({
      adaptiveResolution: true,
      foldingStrategy: 'kv-unified',
      headWindowTokens: 0,
      recentWindowTokens: 100,
      kvUnified: {
        policy: {
          alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
          cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25, continuityLambda: 1,
          continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
          continuityStableHalfLife: 10, continuityStableFloor: 0.25,
        },
        tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000,
        adoptEpsilon: 0, treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
      },
    } as never);
    type Kv = {
      kvUnifiedReceipts: { head: unknown };
      kvUnifiedPendingMarkerUnitIndices: number[];
      beginKvUnifiedSubmission(s: { submissionId: string; requestHash: string; layoutHash: string }): void;
      reportKvUnifiedAccepted(r: unknown): void;
    };
    const big = { maxTokens: 10_000, reserveForResponse: 0 };
    const prefix = { kvUnifiedImmutablePrefixHash: 'immutable-v1' };
    const parentStrategy = kv();
    const parent = await ContextManager.open({ path: storePath(), strategy: parentStrategy, membrane: mockMembrane() as never });
    managers.push(parent);
    for (let i = 0; i < 6; i++) parent.addMessage(i % 2 ? 'Claude' : 'User', turn(i));
    await parent.compile(big, undefined, prefix);
    const p = parentStrategy as unknown as Kv;
    p.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
    p.reportKvUnifiedAccepted({
      submissionId: 's1',
      acceptedAt: 1,
      wireReceipt: {
        requestHash: 'wire1',
        markers: p.kvUnifiedPendingMarkerUnitIndices.map((_, ordinal) => ({ ordinal, prefixHash: `prefix-${ordinal}`, estimatedOffset: ordinal + 1 })),
      },
    });
    const receipt = 'default/kvunified:presentation-receipt';
    const accepted = JSON.stringify(parent.getStore().getStateJson(receipt));
    assert.ok(p.kvUnifiedReceipts.head !== null && accepted !== 'null', 'the parent holds an accepted receipt');

    const reuse = kv();
    const child = await parent.derive({ branch: 'dendrite/kv', strategy: reuse });
    assert.equal(JSON.stringify(child.getStore().getStateJson(receipt)), accepted, 'the receipt arrives through the store');
    assert.deepEqual((reuse as unknown as Kv).kvUnifiedReceipts.head, p.kvUnifiedReceipts.head);
    const fromChild = await child.compile(big, undefined, prefix);
    const fromParent = await parent.compile(big, undefined, prefix);
    assert.equal(JSON.stringify(fromChild.messages), JSON.stringify(fromParent.messages), 'messages and cache markers alike');

    const fresh = await parent.derive({ branch: 'dendrite/kv-fresh', strategy: kv(), solve: 'fresh' });
    assert.equal(fresh.getStore().getStateJson(receipt), null, 'a fresh child clears its own receipt');
    assert.equal(JSON.stringify(parent.getStore().getStateJson(receipt)), accepted, 'and the parent keeps its');
    assert.equal(JSON.stringify(child.getStore().getStateJson(receipt)), accepted, 'and so does the reusing child');
  });

  it('nothing the child does — folding included — alters any parent state', { skip }, async () => {
    const { parent, strategy } = await foldedParent();
    const root = parent.getStore();
    const before = statesOf(root);
    const summariesBefore = (strategy as unknown as { summaries: unknown[] }).summaries.length;

    const childMembrane = mockMembrane();
    const childStrategy = folding();
    const child = await parent.derive({
      branch: 'dendrite/child',
      strategy: childStrategy,
      membrane: childMembrane as never,
    });
    for (let i = 0; i < 40; i++) child.addMessage(i % 2 ? 'Claude' : 'User', turn(i, 'Child-only'));
    await settle(child);
    await child.compile({ maxTokens: 2000, reserveForResponse: 200 });

    assert.ok(childMembrane.calls > 0, 'the child really did compress');
    assert.ok(
      (childStrategy as unknown as { summaries: unknown[] }).summaries.length > summariesBefore,
      'and wrote new memories of its own',
    );
    assert.deepEqual(statesOf(root), before, 'every parent state is byte-identical to before the child ran');
    assert.equal((strategy as unknown as { summaries: unknown[] }).summaries.length, summariesBefore);
    await parent.compile(BUDGET); // and the parent still works
  });

  it('nothing the parent does after the checkpoint alters the child\'s inheritance', { skip }, async () => {
    const { parent } = await foldedParent();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: folding() });
    const view = child.getStore();
    const before = statesOf(view);

    for (let i = 0; i < 40; i++) parent.addMessage(i % 2 ? 'Claude' : 'User', turn(i, 'Parent-only'));
    await settle(parent);
    await parent.compile({ maxTokens: 2000, reserveForResponse: 200 });

    assert.deepEqual(statesOf(view), before, 'the child\'s branch is untouched by the parent\'s later folding');
    assert.equal(child.getAllMessages().length, HISTORY);
  });

  it('leaves the parent\'s merge queue and refusal ledger behind, by the strategy\'s manifest', { skip }, async () => {
    const { parent, strategy } = await foldedParent();
    const root = parent.getStore();
    const ledger = 'default/autobio:compression-refusal-quarantine-events';
    const progress = 'default/autobio:compression-family-progress';
    const queue = 'default/autobio:mergeQueue';
    // Give the parent a ledger entry, a family's progress toward one, and a
    // queued merge to NOT inherit.
    root.appendToStateJson(ledger, { kind: 'checkpoint', at: 1, note: 'parent-only' });
    const onTheWay = [{ familyKey: 'parent-only-family', chunkSourceHash: 'h', outcomes: [] }];
    root.setStateJson(progress, onTheWay);
    const sentinel = [{ level: 2, sourceIds: ['parent-only-a', 'parent-only-b'] }];
    root.setStateJson(queue, sentinel);

    const childStrategy = folding();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: childStrategy });
    const view = child.getStore();
    assert.equal(view.getStateLen(ledger) ?? 0, 0, 'the refusal ledger is the parent\'s own history');
    assert.deepEqual((view.getStateJson(progress) as unknown[] | null) ?? [], [], 'and so is its families\' progress toward it');
    assert.notDeepEqual(view.getStateJson(queue), sentinel, 'the merge queue is rebuilt from inherited memory, not carried');
    assert.equal(
      (childStrategy as unknown as { summaries: unknown[] }).summaries.length,
      (strategy as unknown as { summaries: unknown[] }).summaries.length,
      'the memory tree itself is inherited',
    );
    // And the parent still has both.
    assert.equal(root.getStateLen(ledger), 1);
    assert.deepEqual(root.getStateJson(queue), sentinel);

    // Asked for, the refusals come along — the parent's entries, read on
    // the child's branch; the child's own refusals would append after them.
    const withRefusals = await parent.derive({ branch: 'dendrite/reader', strategy: folding(), inherit: { refusals: true } });
    assert.equal(withRefusals.getStore().getStateLen(ledger), 1, 'the parent\'s refusal is known to the child');
    assert.ok(withRefusals.getDerivation()!.inherited.stateIds.includes(ledger));
    assert.deepEqual(withRefusals.getStore().getStateJson(progress), onTheWay, 'with the families\' progress toward it, half of the same record');
    assert.ok(withRefusals.getDerivation()!.inherited.stateIds.includes(progress));
    assert.notDeepEqual(withRefusals.getStore().getStateJson(queue), sentinel, 'the queue is still rebuilt, not carried');
  });

  it('a fresh solve discards the inherited frontier on the child only', { skip }, async () => {
    const { parent, strategy } = await foldedParent();
    const parentResolutions = [...(strategy as unknown as { resolutions: Map<string, number> }).resolutions];
    assert.ok(parentResolutions.length > 0);

    const childStrategy = folding();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: childStrategy, solve: 'fresh' });
    assert.equal(child.getDerivation()!.solve, 'fresh');
    assert.equal((childStrategy as unknown as { resolutions: Map<string, number> }).resolutions.size, 0);
    assert.deepEqual(child.getStore().getStateJson('default/autobio:resolutions'), {});

    assert.deepEqual([...(strategy as unknown as { resolutions: Map<string, number> }).resolutions], parentResolutions);
    assert.deepEqual(
      Object.keys(parent.getStore().getStateJson('default/autobio:resolutions') as object).sort(),
      parentResolutions.map(([id]) => id).sort(),
      'the parent\'s persisted frontier is intact',
    );
    // A different budget is a supported operating choice, not a failure.
    const small = await child.compile({ maxTokens: 2000, reserveForResponse: 200 });
    assert.ok(small.messages.length > 0);
    // The memory tree itself is still inherited: only the solve is new.
    assert.equal(
      (childStrategy as unknown as { summaries: unknown[] }).summaries.length,
      (strategy as unknown as { summaries: unknown[] }).summaries.length,
    );
  });

  it('inherits a resident-style namespaced manager\'s strategy state and nothing else', { skip }, async () => {
    const { parent, strategy } = await foldedParent({ namespace: 'agents/mira' });
    const root = parent.getStore();
    root.registerState({ id: 'framework/state', strategy: 'snapshot' });
    root.setStateJson('framework/state', { host: 'only' });
    const other = await ContextManager.open({ store: root, namespace: 'agents/oren', strategy: new PassthroughStrategy() });

    const childStrategy = folding();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: childStrategy });
    assert.deepEqual(child.getDerivation()!.inherited.statePrefixes, []);
    assert.ok(child.getDerivation()!.inherited.stateIds.includes('agents/mira/autobio:summaries'));
    assert.ok(child.getDerivation()!.inherited.stateIds.includes('agents/mira/context'));
    assert.equal(child.getDerivation()!.inherited.stateIds.includes('agents/mira/autobio:mergeQueue'), false);
    assert.deepEqual(child.getDerivation()!.inherited.stateIds.filter((id) => id.startsWith('agents/oren/')), []);
    assert.deepEqual(child.getDerivation()!.slots, {
      messageNamespace: null, // a resident's messages are in the shared slot
      contextNamespace: 'agents/mira',
      auxiliaryNamespaces: [],
    });
    const reopenedChild = await ContextManager.reopenDerived({
      store: root,
      derivation: child.getDerivation()!,
      strategy: folding(),
      membrane: mockMembrane() as never,
    });
    assert.equal(reopenedChild.getAllMessages().length, HISTORY);
    assert.equal(
      (reopenedChild.getStrategy() as unknown as { summaries: unknown[] }).summaries.length,
      (strategy as unknown as { summaries: unknown[] }).summaries.length,
      'reopened under the same namespace: the inherited memory tree is found',
    );
    assert.equal(
      (childStrategy as unknown as { summaries: unknown[] }).summaries.length,
      (strategy as unknown as { summaries: unknown[] }).summaries.length,
    );
    assert.ok((strategy as unknown as { summaries: unknown[] }).summaries.length > 0);
    assert.equal(child.getAllMessages().length, HISTORY);
    // States the parent manager does not own were not carried onto the branch.
    assert.equal(child.getStore().getStateJson('framework/state') ?? null, null);
    assert.deepEqual(root.getStateJson('framework/state'), { host: 'only' });
    other.close();
  });

  it('survives a restart: the branch is the child\'s durable state', { skip }, async () => {
    const path = storePath();
    const parent = await ContextManager.open({ path, strategy: folding(), membrane: mockMembrane() as never });
    for (let i = 0; i < HISTORY; i++) parent.addMessage(i % 2 ? 'Claude' : 'User', turn(i));
    await settle(parent);
    await parent.compile(BUDGET);
    const child = await parent.derive({ branch: 'dendrite/child', strategy: folding() });
    const derivation = child.getDerivation()!;
    const childOnly = child.addMessage('User', turn(200, 'Child-only'));
    parent.addMessage('User', turn(100, 'Parent-only'));
    parent.close();

    const reopened = await ContextManager.open({ path, strategy: folding(), membrane: mockMembrane() as never });
    managers.push(reopened);
    assert.equal(reopened.getAllMessages().length, HISTORY + 1);
    // The derivation record is plain data: it survives being persisted.
    const resumed = await ContextManager.reopenDerived({
      store: reopened.getStore(),
      derivation: JSON.parse(JSON.stringify(derivation)),
      strategy: folding(),
      membrane: mockMembrane() as never,
    });
    assert.deepEqual(resumed.getDerivation(), derivation);
    assert.equal(resumed.currentBranch().name, 'dendrite/child');
    const messages = resumed.getAllMessages();
    assert.equal(messages.length, HISTORY + 1);
    assert.equal(messages[HISTORY]!.id, childOnly);
    assert.equal(reopened.getAllMessages().some((m) => m.id === childOnly), false);
    await resumed.compile(BUDGET);
  });

  it('a derived context can itself be derived from', { skip }, async () => {
    const { parent, ids } = await foldedParent();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: folding() });
    const childOnly = child.addMessage('User', turn(200, 'Child-only'));
    const grandchild = await child.derive({ branch: 'dendrite/grandchild', strategy: folding() });
    assert.equal(grandchild.getDerivation()!.parentBranch, 'dendrite/child');
    const grandchildOnly = grandchild.addMessage('User', turn(300, 'Grandchild-only'));

    assert.deepEqual(grandchild.getAllMessages().map((m) => m.id), [...ids, childOnly, grandchildOnly]);
    assert.deepEqual(child.getAllMessages().map((m) => m.id), [...ids, childOnly]);
    assert.deepEqual(parent.getAllMessages().map((m) => m.id), ids);
  });

  it('derives from an earlier checkpoint without disturbing the present', { skip }, async () => {
    const { parent, ids } = await foldedParent();
    const cut = parent.getMessage(ids[9]!)!.sequence;
    const past = await parent.derive({
      branch: 'dendrite/past',
      strategy: new PassthroughStrategy(),
      atSequence: cut,
    });
    managers.push(past);
    assert.deepEqual(past.getAllMessages().map((m) => m.id), ids.slice(0, 10));
    assert.equal(past.getDerivation()!.atSequence, cut);
    assert.equal(past.getDerivation()!.solve, 'reuse');
    const pastFolding = folding();
    managers.push(await parent.derive({ branch: 'dendrite/past-folding', strategy: pastFolding, atSequence: cut }));
    assert.equal((pastFolding as unknown as { _prevCacheKeys?: string[] })._prevCacheKeys, undefined, 'nothing the parent holds in memory describes that point, so nothing is handed over');
    past.addMessage('User', turn(400, 'Alternate'));
    assert.equal(parent.getAllMessages().length, HISTORY, 'the original stays inspectable and unchanged');
  });

  it('says so plainly, and makes no branch, when the store cannot bind a handle to a branch or fork one with selected states', async () => {
    for (const missing of ['view', 'createBranchWithStates', 'createBranchAtWithStates']) {
      const parent = await ContextManager.open({ path: storePath(), strategy: new PassthroughStrategy() });
      managers.push(parent);
      Object.defineProperty(parent.getStore(), missing, { value: undefined, configurable: true });
      assert.equal(ContextManager.supportsDerivation(parent.getStore()), false, missing);
      await assert.rejects(
        parent.derive({ branch: 'x', strategy: new PassthroughStrategy() }),
        ContextDerivationUnsupportedError,
        missing,
      );
      assert.deepEqual(parent.listBranches().map((b) => b.name), ['main'], missing);
    }
  });

  it('removes its branch and lets the child go when the child fails to start, so the name derives again', { skip }, async () => {
    const parent = await ContextManager.open({ path: storePath(), strategy: new PassthroughStrategy() });
    managers.push(parent);
    const ids = [parent.addMessage('User', turn(0)), parent.addMessage('Claude', turn(1))];
    class FailingToStart extends PassthroughStrategy {
      detached = 0;
      async initialize(): Promise<void> { throw new Error('child initialize failed'); }
      detach(): void { this.detached++; }
    }
    const failing = new FailingToStart();
    await assert.rejects(parent.derive({ branch: 'dendrite/again', strategy: failing }), /child initialize failed/);
    assert.deepEqual(parent.listBranches().map((b) => b.name), ['main']);
    assert.equal(failing.detached, 1, 'the failed child\'s strategy is let go');
    const child = await parent.derive({ branch: 'dendrite/again', strategy: new PassthroughStrategy() });
    managers.push(child);
    assert.deepEqual(child.getAllMessages().map((m) => m.id), ids);

    await assert.rejects(parent.derive({ branch: 'dendrite/again', strategy: new PassthroughStrategy() }));
    assert.deepEqual(parent.listBranches().map((b) => b.name).sort(), ['dendrite/again', 'main'], 'a name already taken: the branch that has it stays');
    assert.deepEqual(child.getAllMessages().map((m) => m.id), ids);
  });

  it('leaves alone a branch made under its name while the child was starting', { skip }, async () => {
    const parent = await ContextManager.open({ path: storePath(), strategy: new PassthroughStrategy() });
    managers.push(parent);
    parent.addMessage('User', turn(0));
    const root = parent.getStore();
    class Replaced extends PassthroughStrategy {
      async initialize(): Promise<void> {
        root.deleteBranch('dendrite/replaced');
        root.createBranch('dendrite/replaced');
        throw new Error('child initialize failed');
      }
    }
    await assert.rejects(parent.derive({ branch: 'dendrite/replaced', strategy: new Replaced() }), /child initialize failed/);
    assert.ok(parent.listBranches().some((b) => b.name === 'dendrite/replaced'), 'the branch made meanwhile stays');
  });

  it('removes its branch when the child fails after it starts, as when taking over the frontier throws', { skip }, async () => {
    const { parent } = await foldedParent();
    const failing = folding();
    failing.adoptRenderingFrontier = () => { throw new Error('adoption failed'); };
    await assert.rejects(parent.derive({ branch: 'dendrite/adopt', strategy: failing }), /adoption failed/);
    assert.deepEqual(parent.listBranches().map((b) => b.name), ['main']);
    const child = await parent.derive({ branch: 'dendrite/adopt', strategy: folding() });
    managers.push(child);
  });
});

describe('MessageStore coherence across handles on one branch', () => {
  // Astra's reproducer (2026-10-07): a second handle to the SAME branch —
  // a hospital tool holding root.view('main') while the resident runs on
  // the root — edits an earlier message in place. The resident's own store
  // must serve the edit, although the item count did not change.
  it("an uncounted write beside a counted one, between a reader's reads, is served (nissa-seru's three cases on #238)", { skip }, async () => {
    const texts = (store: MessageStore) => store.getAll().map((m) => (m.content[0] as { text: string }).text);
    const scenario = (run: (root: JsStore, resident: MessageStore, sibling: MessageStore, surgeon: MessageStore, r0: { id: string }, r1: { id: string }) => void): string[][] => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-gap-'));
      const root = JsStore.create({ path: join(dir, 'store') });
      try {
        MessageStore.register(root);
        const resident = new MessageStore(root);
        const r0 = resident.append('user', [{ type: 'text', text: 'r0' }]);
        const r1 = resident.append('user', [{ type: 'text', text: 'r1' }]);
        resident.getAll(); // warm
        const sibling = new MessageStore(root); // counted on the root
        const surgeon = new MessageStore((root as ViewStore).view('main')); // not counted on the root
        run(root, resident, sibling, surgeon, r0, r1);
        return [texts(resident), texts(new MessageStore(root))];
      } finally {
        root.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // 1. a counted append, then an uncounted edit, then the read
    let [served, cold] = scenario((_root, _resident, sibling, surgeon, r0) => {
      sibling.append('user', [{ type: 'text', text: 'sib' }]);
      surgeon.edit(r0.id, [{ type: 'text', text: 'edited' }]);
    });
    assert.deepEqual(cold, ['edited', 'r1', 'sib']);
    assert.deepEqual(served, cold, 'case 1: the resident serves the edit, not the extension');
    // 2. the same, with the resident's own append before it reads
    [served, cold] = scenario((_root, resident, sibling, surgeon, r0) => {
      sibling.append('user', [{ type: 'text', text: 'sib' }]);
      surgeon.edit(r0.id, [{ type: 'text', text: 'edited' }]);
      resident.append('user', [{ type: 'text', text: 'mine' }]);
    });
    assert.deepEqual(cold, ['edited', 'r1', 'sib', 'mine']);
    assert.deepEqual(served, cold, "case 2: the resident's own append doesn't extend past the edit");
    // 3. a counted edit, then an uncounted append, then the read
    [served, cold] = scenario((_root, _resident, sibling, surgeon, _r0, r1) => {
      sibling.edit(r1.id, [{ type: 'text', text: 'sib-edited' }]);
      surgeon.append('user', [{ type: 'text', text: 'outside' }]);
    });
    assert.deepEqual(cold, ['r0', 'sib-edited', 'outside']);
    assert.deepEqual(served, cold, "case 3: a counted edit's length is not explained by an uncounted append");
    // Control: counted writes alone still take the cheap path (no gap is seen).
    [served, cold] = scenario((_root, _resident, sibling) => {
      sibling.append('user', [{ type: 'text', text: 'sib' }]);
      sibling.append('user', [{ type: 'text', text: 'sib2' }]);
    });
    assert.deepEqual(served, cold);
    assert.deepEqual(served, ['r0', 'r1', 'sib', 'sib2']);
  });

  it("a handle's first counted write sees an uncounted write before it (nissa-seru's fourth case on #238)", { skip }, async () => {
    const texts = (s: MessageStore) => s.getAll().map((m) => (m.content[0] as { text: string }).text);
    const dir = mkdtempSync(join(tmpdir(), 'cm-gap-baseline-'));
    const path = join(dir, 'store');
    const first = JsStore.create({ path });
    MessageStore.register(first);
    const writer = new MessageStore(first);
    const r0 = writer.append('user', [{ type: 'text', text: 'r0' }]);
    writer.append('user', [{ type: 'text', text: 'r1' }]);
    first.close();
    const root = JsStore.open({ path });
    try {
      const resident = new MessageStore(root);
      resident.getAll(); // warm; no counted write yet on this handle
      new MessageStore((root as ViewStore).view('main')).edit(r0.id, [{ type: 'text', text: 'edited' }]); // not counted on the root
      new MessageStore(root).append('user', [{ type: 'text', text: 'sib' }]); // the handle's first counted write
      const cold = texts(new MessageStore(root));
      assert.deepEqual(cold, ['edited', 'r1', 'sib']);
      assert.deepEqual(texts(resident), cold, 'the first counted write compared with the baseline the construction recorded');
      // The variant: the resident's own append before it reads.
      const resident2 = new MessageStore(root);
      resident2.getAll();
      new MessageStore((root as ViewStore).view('main')).edit(r0.id, [{ type: 'text', text: 'edited-again' }]);
      resident2.append('user', [{ type: 'text', text: 'mine' }]);
      assert.deepEqual(texts(resident2), texts(new MessageStore(root)));
      assert.deepEqual(texts(resident2), ['edited-again', 'r1', 'sib', 'mine']);
    } finally {
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a count-preserving edit through another handle is served by a warm cache', { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-coherence-'));
    const root = JsStore.create({ path: join(dir, 'store') });
    try {
      MessageStore.register(root);
      const resident = new MessageStore(root);
      const first = resident.append('user', [{ type: 'text', text: 'old' }]);
      resident.append('user', [{ type: 'text', text: 'tail' }]);
      resident.getAll(); // warm

      const surgeon = new MessageStore((root as ViewStore).view('main'));
      surgeon.getAll();
      surgeon.edit(first.id, [{ type: 'text', text: 'new' }]);

      const text = (store: MessageStore) => (store.getAll()[0]!.content[0] as { text: string }).text;
      assert.equal(text(surgeon), 'new');
      assert.equal(text(resident), 'new', 'the resident serves the edit made through the other handle');
      assert.equal((root.getStateItemJson('messages', 0) as { content: Array<{ text: string }> }).content[0]!.text, 'new');
      assert.equal(resident.get(first.id)!.content[0]!.type, 'text');
      assert.equal((resident.get(first.id)!.content[0] as { text: string }).text, 'new', 'point reads too');

      // And the other way round: an append through the root is seen by the view's store.
      resident.append('user', [{ type: 'text', text: 'after' }]);
      assert.equal(surgeon.getAll().length, 3);

      // Same-handle control, as before.
      const sibling = new MessageStore(root);
      sibling.edit(first.id, [{ type: 'text', text: 'same-handle' }]);
      assert.equal(text(resident), 'same-handle');

      // A local append must not re-certify caches that were stale going in
      // (Astra's second reproducer): the surgeon removes an earlier message,
      // the resident appends, and then looks up by id.
      const all = resident.getAll();
      surgeon.remove(all[0]!.id);
      resident.append('user', [{ type: 'text', text: 'after-removal' }]);
      const stillThere = all[1]!;
      assert.equal(
        (resident.get(stillThere.id)!.content[0] as { text: string }).text,
        (stillThere.content[0] as { text: string }).text,
        'the id index was not certified by the local append',
      );
      assert.deepEqual(
        resident.getAll().map((m) => (m.content[0] as { text: string }).text),
        root.getStateJson('messages').map((m: { content: Array<{ text: string }> }) => m.content[0]!.text),
        'the materialized view matches the slot',
      );
      // Same for a count-preserving edit followed by a local append.
      const target = resident.getAll()[0]!;
      surgeon.edit(target.id, [{ type: 'text', text: 'edited-by-surgeon' }]);
      resident.append('user', [{ type: 'text', text: 'after-edit' }]);
      assert.equal((resident.getAll()[0]!.content[0] as { text: string }).text, 'edited-by-surgeon');
      assert.equal((resident.get(target.id)!.content[0] as { text: string }).text, 'edited-by-surgeon');
    } finally {
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MessageStore message views', () => {
  it('an append converts only the new message; an edit replaces only the edited one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-views-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy() });
    try {
      const ids = [0, 1, 2].map((i) => manager.addMessage('User', turn(i)));
      const first = manager.getAllMessages();

      manager.addMessage('User', turn(3));
      const afterAppend = manager.getAllMessages();
      assert.notEqual(afterAppend, first, 'a new array for the new length');
      for (let i = 0; i < 3; i++) assert.equal(afterAppend[i], first[i], `message ${i} was not rebuilt`);

      manager.editMessage(ids[1]!, [{ type: 'text', text: 'edited' }]);
      const afterEdit = manager.getAllMessages();
      assert.equal(afterEdit[0], first[0]);
      assert.notEqual(afterEdit[1], first[1], 'the edited message has a new view');
      assert.equal((afterEdit[1]!.content[0] as { text: string }).text, 'edited');
      assert.equal((first[1]!.content[0] as { text: string }).text.startsWith('Turn 1.'), true, 'the old view is not mutated');
      assert.equal(afterEdit[2], first[2]);
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
