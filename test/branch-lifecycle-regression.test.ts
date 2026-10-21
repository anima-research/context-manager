import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const stores: string[] = [];

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'context-manager-branch-lifecycle-'));
  stores.push(root);
  return join(root, 'store');
}

function content(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function texts(manager: ContextManager): string[] {
  return manager.getAllMessages().map((message) => {
    const block = message.content[0];
    return block?.type === 'text' ? block.text : '<non-text>';
  });
}

afterEach(() => {
  for (const path of stores.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('ContextManager branch lifecycle regressions', () => {
  it('clearing branch mirrors releases the listing-derived caches', async () => {
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({ path: storePath(), strategy });
    for (const text of ['a', 'b', 'c']) manager.addMessage('user', content(text));
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 100 });
    const internals = strategy as unknown as {
      _storeOrderSource: readonly unknown[];
      _chunkByPosition: unknown;
      clearBranchMirrors(): void;
    };
    assert.equal(internals._storeOrderSource.length, 3);
    internals.clearBranchMirrors();
    assert.equal(internals._storeOrderSource.length, 0);
    assert.equal(internals._chunkByPosition, null);
  });

  it('branchAt keeps every message through the selected message after a sibling mutation', async () => {
    const manager = await ContextManager.open({
      path: storePath(),
      strategy: new PassthroughStrategy(),
    });

    const ids = ['a', 'b', 'c', 'd'].map((text, index) =>
      manager.addMessage(index % 2 === 0 ? 'user' : 'assistant', content(text)),
    );
    const main = manager.currentBranch().name;

    await manager.fork('preview-1');
    manager.addMessage('assistant', content('replacement'));
    manager.removeMessages(ids[1]!, ids[2]!);
    await manager.switchBranch(main);

    const historical = manager.branchAt(ids[3]!, 'historical-through-d');
    await manager.switchBranch(historical);
    assert.deepEqual(
      texts(manager),
      ['a', 'b', 'c', 'd'],
      'branchAt(message d) must retain all four messages through d',
    );

    manager.close();
  });

  it('rebuilds the message-id index after switching away from a mutated sibling', async () => {
    const manager = await ContextManager.open({
      path: storePath(),
      strategy: new PassthroughStrategy(),
    });

    const ids = ['a', 'b', 'c', 'd'].map((text, index) =>
      manager.addMessage(index % 2 === 0 ? 'user' : 'assistant', content(text)),
    );
    const main = manager.currentBranch().name;

    await manager.fork('preview-1');
    manager.addMessage('assistant', content('replacement'));
    manager.removeMessages(ids[1]!, ids[2]!);
    assert.deepEqual(texts(manager), ['a', 'd', 'replacement']);

    await manager.switchBranch(main);
    assert.deepEqual(texts(manager), ['a', 'b', 'c', 'd']);

    // The ids are present on the selected branch, so this must not throw
    // "Message not found" because the previous branch deleted them.
    manager.removeMessages(ids[1]!, ids[2]!);
    assert.deepEqual(texts(manager), ['a', 'd']);

    manager.close();
  });

  it('writes no merge quarantine onto a branch the store switched to while tick awaited its chunk klaxon', async () => {
    // A host can switch the chronicle directly, without ContextManager. If it
    // does so before a tick it didn't await resumes from the chunk klaxon (in
    // the same synchronous run, or a promise continuation of the same turn),
    // the merge klaxon's sweep would run on the old branch's mirrors and
    // persist that branch's merge quarantine onto the new one; tick checks its
    // branch after that await.
    const strategy = new AutobiographicalStrategy({
      targetChunkTokens: 2000,
      autoTickOnNewMessage: false,
      mergeThreshold: 99,
      hierarchical: true,
      quarantineAlarmIntervalMs: 1,
    });
    const manager = await ContextManager.open({ path: storePath(), strategy });
    const ids = ['a', 'b', 'c', 'd'].map((text) => manager.addMessage('user', content(`${text} hello world`)));
    const internals = strategy as unknown as {
      store: { switchBranch(name: string): unknown; getStateJson(id: string): unknown };
      mergeQuarantineStateId: string;
      mergeQuarantine: Map<string, unknown>;
      pushSummary(entry: unknown): void;
      persistMergeQuarantine(): void;
    };
    const l1 = (id: string, first: number, last: number) => ({
      id, level: 1, content: id, tokens: 10, sourceLevel: 0, created: 1,
      sourceIds: [ids[first]!, ids[last]!], sourceRange: { first: ids[first]!, last: ids[last]! },
    });
    internals.pushSummary(l1('L1-x', 0, 1));
    internals.pushSummary(l1('L1-y', 2, 3));
    const quarantine = (key: string, sourceIds: string[]): void => {
      internals.mergeQuarantine = new Map([[key, { key, level: 2, sourceIds, attempts: 3, lastOutcome: 'refusal', quarantinedAt: 1 }]]);
      internals.persistMergeQuarantine();
    };
    const stored = (): string[] =>
      ((internals.store.getStateJson(internals.mergeQuarantineStateId) ?? []) as Array<{ key: string }>).map((r) => r.key);
    const quietly = async (work: () => Promise<unknown>): Promise<unknown> => {
      const warn = console.warn, error = console.error;
      console.warn = () => {};
      console.error = () => {};
      try { await work(); return undefined; } catch (thrown) { return thrown; } finally {
        console.warn = warn;
        console.error = error;
      }
    };

    const main = manager.currentBranch().name;
    // On the fork, a record over two live L1s: the sweep keeps it.
    const fork = await manager.fork('fork');
    const live = (internals as unknown as { summaries: Array<{ id: string; mergedInto?: string }> }).summaries
      .filter((s) => (s.id === 'L1-x' || s.id === 'L1-y') && !s.mergedInto);
    assert.equal(live.length, 2, "premise: the fork's reload keeps both L1s, unmerged");
    quarantine('live', ['L1-x', 'L1-y']);
    await manager.switchBranch(main);
    // On main, a record whose sources are gone, written after the load, as a
    // record can go stale while the store is open (the open's own sweep clears
    // one stale at load): the merge sweep clears it and persists.
    quarantine('gone', ['ghost-1', 'ghost-2']);
    assert.deepEqual([...internals.mergeQuarantine.keys()], ['gone'], 'premise: on main');
    // No tick has run, so neither klaxon has sounded yet: both are due.

    const tick = manager.tick();
    internals.store.switchBranch(fork);
    const thrown = await quietly(() => tick);
    assert.deepEqual(stored(), ['live'], "the fork keeps its own merge quarantine, not main's");
    assert.equal(thrown, undefined, 'the tick returns at its branch check, with no error');

    // The switch landed before the merge klaxon: main's record is still there.
    internals.store.switchBranch(main);
    assert.deepEqual(stored(), ['gone'], 'premise: the tick swept nothing on main before the switch');
    // The control: on its own branch, the same sweep clears such a record and persists.
    await manager.switchBranch(main);
    quarantine('gone', ['ghost-1', 'ghost-2']);
    await quietly(() => manager.tick());
    assert.deepEqual(stored(), [], 'premise: the sweep runs and persists when its branch is current');

    manager.close();
  });
});
