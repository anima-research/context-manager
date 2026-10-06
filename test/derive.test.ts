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
 * Needs branch-bound store handles (`JsStore.view`). On a Chronicle build
 * without them every derivation test is skipped, by name, with the reason.
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
  PassthroughStrategy,
} from '../src/index.js';

type ViewStore = JsStore & { view(branch: string): JsStore };

const supported = typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function';
const skip = supported ? false : 'installed @animalabs/chronicle has no JsStore.view (branch-bound handles)';

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
    const queue = 'default/autobio:mergeQueue';
    // Give the parent a ledger entry and a queued merge to NOT inherit.
    root.appendToStateJson(ledger, { kind: 'checkpoint', at: 1, note: 'parent-only' });
    const sentinel = [{ level: 2, sourceIds: ['parent-only-a', 'parent-only-b'] }];
    root.setStateJson(queue, sentinel);

    const childStrategy = folding();
    const child = await parent.derive({ branch: 'dendrite/child', strategy: childStrategy });
    const view = child.getStore();
    assert.equal(view.getStateLen(ledger) ?? 0, 0, 'the refusal ledger is the parent\'s own history');
    assert.notDeepEqual(view.getStateJson(queue), sentinel, 'the merge queue is rebuilt from inherited memory, not carried');
    assert.equal(
      (childStrategy as unknown as { summaries: unknown[] }).summaries.length,
      (strategy as unknown as { summaries: unknown[] }).summaries.length,
      'the memory tree itself is inherited',
    );
    // And the parent still has both.
    assert.equal(root.getStateLen(ledger), 1);
    assert.deepEqual(root.getStateJson(queue), sentinel);
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
    assert.deepEqual(past.getAllMessages().map((m) => m.id), ids.slice(0, 10));
    assert.equal(past.getDerivation()!.atSequence, cut);
    past.addMessage('User', turn(400, 'Alternate'));
    assert.equal(parent.getAllMessages().length, HISTORY, 'the original stays inspectable and unchanged');
  });

  it('says so plainly when the store cannot bind a handle to a branch', async () => {
    const parent = await ContextManager.open({ path: storePath(), strategy: new PassthroughStrategy() });
    managers.push(parent);
    Object.defineProperty(parent.getStore(), 'view', { value: undefined, configurable: true });
    assert.equal(ContextManager.supportsDerivation(parent.getStore()), false);
    await assert.rejects(
      parent.derive({ branch: 'x', strategy: new PassthroughStrategy() }),
      ContextDerivationUnsupportedError,
    );
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
