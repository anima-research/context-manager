import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { AutobiographicalOptions, StoredMessage, SummaryEntry } from '../src/types/index.js';

class SeedableStrategy extends AutobiographicalStrategy {
  seed(entry: Omit<SummaryEntry, 'id' | 'created'> & { id: string }): SummaryEntry {
    const seeded: SummaryEntry = { ...entry, created: 0 };
    this.pushSummary(seeded);
    return seeded;
  }
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const call = (id: string, name: string): ContentBlock => ({ type: 'tool_use', id, name, input: {} } as ContentBlock);
const result = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'ok' } as ContentBlock);

async function withStore<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-recall-tools-'));
  try {
    return await run(join(dir, 'store'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each Context Manager turn followed by an answer: the recall pairs' questions, in order. */
function questions(messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>): string[] {
  const out: string[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i]!.participant !== 'Context Manager') continue;
    out.push(messages[i]!.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  }
  return out;
}

/** A store of rounds, each an agent turn calling the named tools and a turn of their results. */
function addRounds(manager: ContextManager, rounds: string[][]): string[][] {
  return rounds.map((names, r) => {
    const calls = names.map((name, k) => call(`tu-${r}-${k}`, name));
    const asked = manager.addMessage('Claude', [{ type: 'text', text: `zz-round-${r}` }, ...calls]);
    const answered = manager.addMessage('User', calls.length > 0
      ? names.map((_, k) => result(`tu-${r}-${k}`))
      : text(`zz-reply-${r}`));
    return [asked, answered];
  });
}

/** Opens a positioned-pair store (the non-adaptive path) with its rounds and a raw message after them. */
async function positioned(
  path: string,
  options: AutobiographicalOptions,
  rounds: string[][],
): Promise<{ manager: ContextManager; strategy: SeedableStrategy; ids: string[][] }> {
  const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8, ...options });
  const manager = await ContextManager.open({ path, strategy });
  const ids = addRounds(manager, rounds);
  manager.addMessage('User', text('zz-latest ' + 'Z'.repeat(60)));
  return { manager, strategy, ids };
}

const l1 = (id: string, leaves: string[], extra: Partial<SummaryEntry> = {}) => ({
  id, level: 1 as const, content: `zz-memory-${id}`, tokens: 6, sourceLevel: 0,
  sourceIds: leaves, sourceRange: { first: leaves[0]!, last: leaves[leaves.length - 1]! }, ...extra,
});

describe('{tools}: the tools a summary\'s rounds called', () => {
  it('a header names the tools its summary\'s rounds called, each once, in order of first call', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: '[Recall {id}] {tools}' },
        [['read_file'], ['bash', 'read_file'], ['grep']]);
      strategy.seed(l1('L1-1', ids.flat()));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['[Recall L1-1] read_file, bash, grep']);
      manager.close();
    });
  });

  it('a merged summary names its sources\' tools in their order, each once', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: '{tools}' },
        [['alpha', 'beta'], ['beta', 'gamma']]);
      strategy.seed(l1('L1-1', ids[0]!, { parentId: 'L2-3', mergedInto: 'L2-3' }));
      strategy.seed(l1('L1-2', ids[1]!, { parentId: 'L2-3', mergedInto: 'L2-3' }));
      strategy.seed({
        id: 'L2-3', level: 2, content: 'zz-merged', tokens: 6, sourceLevel: 1,
        sourceIds: ['L1-1', 'L1-2'], sourceRange: { first: ids[0]![0]!, last: ids[1]![1]! },
      });
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['alpha, beta, gamma']);
      manager.close();
    });
  });

  for (const [rounds, want] of [
    [[['t1', 't2', 't3'], ['t4', 't5']], 't1, t2, t3, t4, t5'],
    [[['t1', 't2', 't3'], ['t4', 't5', 't6']], 't1, t2, t3, t4, t5 and 1 more'],
    [[['t1', 't2', 't3'], ['t4', 't5', 't6'], ['t7', 't1']], 't1, t2, t3, t4, t5 and 2 more'],
  ] as const) {
    it(`five names are listed, and the rest counted: ${want}`, async () => {
      await withStore(async (path) => {
        const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: 'Its rounds called {tools}.' },
          rounds.map((r) => [...r]));
        strategy.seed(l1('L1-1', ids.flat()));
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        assert.deepStrictEqual(questions(compiled.messages), [`Its rounds called ${want}.`]);
        manager.close();
      });
    });
  }

  it('a summary two levels up names the tools of every round under it, in order', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: '{tools}' },
        [['alpha'], ['beta'], ['gamma'], ['delta']]);
      ids.forEach((round, r) => strategy.seed(l1(`L1-${r + 1}`, round, { parentId: r < 2 ? 'L2-5' : 'L2-6', mergedInto: r < 2 ? 'L2-5' : 'L2-6' })));
      const l2 = (id: string, sources: string[], first: string, last: string) => ({
        id, level: 2 as const, content: `zz-${id}`, tokens: 6, sourceLevel: 1, sourceIds: sources,
        sourceRange: { first, last }, parentId: 'L3-7', mergedInto: 'L3-7',
      });
      strategy.seed(l2('L2-5', ['L1-1', 'L1-2'], ids[0]![0]!, ids[1]![1]!));
      strategy.seed(l2('L2-6', ['L1-3', 'L1-4'], ids[2]![0]!, ids[3]![1]!));
      strategy.seed({
        id: 'L3-7', level: 3, content: 'zz-L3', tokens: 6, sourceLevel: 2,
        sourceIds: ['L2-5', 'L2-6'], sourceRange: { first: ids[0]![0]!, last: ids[3]![1]! },
      });
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['alpha, beta, gamma, delta']);
      manager.close();
    });
  });

  it('rounds that called no tools render "no tools"', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: 'Its rounds called {tools}.' }, [[], []]);
      strategy.seed(l1('L1-1', ids.flat()));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['Its rounds called no tools.']);
      manager.close();
    });
  });

  it('once read, a source removed keeps its name until the strategy loads its branch again', async () => {
    await withStore(async (path) => {
      const options = { headWindowTokens: 0, recentWindowTokens: 8, recallHeaderTemplate: '{tools}' };
      const first = await positioned(path, options, [['alpha'], ['beta'], ['gamma']]);
      first.strategy.seed(l1('L1-1', first.ids.flat()));
      const before = await first.manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(before.messages), ['alpha, beta, gamma']);
      first.manager.removeMessage(first.ids[1]![0]!);
      const afterRemoval = await first.manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(afterRemoval.messages), ['alpha, beta, gamma'], 'the same load');
      first.manager.close();

      const reopened = await ContextManager.open({ path, strategy: new SeedableStrategy(options) });
      const afterLoad = await reopened.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(afterLoad.messages), ['alpha, gamma'], 'the next load');
      reopened.close();
    });
  });

  it('after a branch switch, the names follow the sources that branch holds', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: '{tools}' }, [['alpha'], ['beta']]);
      strategy.seed(l1('L1-1', ids.flat()));
      const trunk = manager.currentBranch().name;
      assert.deepStrictEqual(questions((await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages), ['alpha, beta']);
      await manager.fork('zz-fork');
      manager.removeMessage(ids[1]![0]!);
      assert.deepStrictEqual(questions((await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages), ['alpha'], 'on the fork');
      await manager.switchBranch(trunk);
      assert.deepStrictEqual(questions((await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages), ['alpha, beta'], 'back on the trunk');
      manager.close();
    });
  });

  it('a source the view filter hides names nothing', async () => {
    await withStore(async (path) => {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8, recallHeaderTemplate: '{tools}' });
      const manager = await ContextManager.open({
        path, strategy,
        viewFilter: (m: StoredMessage) => !(m.metadata as { zzHidden?: boolean } | undefined)?.zzHidden,
      });
      const shown = manager.addMessage('Claude', [{ type: 'text', text: 'zz-shown' }, call('a', 'visible_tool')]);
      const hidden = manager.addMessage('Claude', [{ type: 'text', text: 'zz-hidden' }, call('b', 'hidden_tool')], { zzHidden: true });
      manager.addMessage('User', text('zz-latest ' + 'Z'.repeat(60)));
      strategy.seed(l1('L1-1', [shown, hidden]));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['visible_tool']);
      manager.close();
    });
  });

  it('a label or template without {tools} renders as written', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path, { recallHeaderTemplate: '[Recall {id}] tools' }, [['read_file']]);
      strategy.seed(l1('L1-1', ids.flat()));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['[Recall L1-1] tools']);
      manager.close();
    });
  });

  it('the combined pair names the tools of every summary it holds, each once', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path,
        { positionedRecallPairs: false, summaryContextLabel: 'Earlier rounds called {tools}.' },
        [['alpha'], ['beta', 'alpha'], ['gamma']]);
      strategy.seed(l1('L1-1', ids[0]!));
      strategy.seed(l1('L1-2', ids[1]!));
      strategy.seed(l1('L1-3', ids[2]!));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['Earlier rounds called alpha, beta, gamma.']);
      manager.close();
    });
  });

  it('the combined pair lists its summaries\' tools in the order they were called, whatever their levels', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path,
        { positionedRecallPairs: false, summaryContextLabel: '{tools}' },
        [['alpha'], ['beta'], ['gamma']]);
      strategy.seed(l1('L1-1', ids[0]!));
      strategy.seed(l1('L1-2', ids[1]!, { parentId: 'L2-4', mergedInto: 'L2-4' }));
      strategy.seed(l1('L1-3', ids[2]!, { parentId: 'L2-4', mergedInto: 'L2-4' }));
      strategy.seed({
        id: 'L2-4', level: 2, content: 'zz-merged', tokens: 6, sourceLevel: 1,
        sourceIds: ['L1-2', 'L1-3'], sourceRange: { first: ids[1]![0]!, last: ids[2]![1]! },
      });
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(compiled.messages), ['alpha, beta, gamma']);
      manager.close();
    });
  });

  it('the combined pair names only the summaries its cap leaves in the answer', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path,
        { positionedRecallPairs: false, summaryContextLabel: '{tools}', maxMessageTokens: 40 },
        [['alpha'], ['beta'], ['gamma']]);
      strategy.seed(l1('L1-1', ids[0]!, { content: 'zz-short' }));
      strategy.seed(l1('L1-2', ids[1]!, { content: 'zz-long ' + 'word '.repeat(200), tokens: 200 }));
      strategy.seed(l1('L1-3', ids[2]!, { content: 'zz-after' }));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      const answer = compiled.messages[compiled.messages.findIndex((m) => m.participant === 'Context Manager') + 1]!;
      const answerText = answer.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      assert.ok(answerText.includes('zz-short') && !answerText.includes('zz-after'), `premise: the cap ends inside the second summary: ${answerText.slice(0, 120)}`);
      assert.deepStrictEqual(questions(compiled.messages), ['alpha, beta']);
      manager.close();
    });
  });

  it('a positioned pair is priced at the header it sends', async () => {
    await withStore(async (path) => {
      const { manager, strategy, ids } = await positioned(path,
        { recallHeaderTemplate: '[Recall {id}] ' + 'zz-long-header '.repeat(40) + '{tools}' },
        [['read_file']]);
      strategy.seed(l1('L1-1', ids.flat()));
      const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      const store = (manager as unknown as { messageStore: { estimateTokens(message: StoredMessage): number } }).messageStore;
      const sent = compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as StoredMessage), 0);
      assert.equal(manager.getRenderStats()!.total.tokens, sent);
      manager.close();
    });
  });
});

describe('{tools} on the adaptive path', () => {
  const NAMES = ['read_file', 'bash', 'grep', 'write_file', 'discord--send_message', 'search', 'fetch'];
  const TOOLS = NAMES.map((name) => ({ name, description: 'zz', inputSchema: { type: 'object' as const } }));
  const options: AutobiographicalOptions = {
    compressionModel: 'zz-mock-model',
    targetChunkTokens: 100,
    recentWindowTokens: 200,
    headWindowTokens: 0,
    mergeThreshold: 3,
    compressionSlackRatio: 0.1,
    adaptiveResolution: true,
    summaryContextLabel: 'Its rounds called {tools}.',
  };
  const membrane = {
    complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'zz-adaptive-memory of an earlier stretch' }] }),
  };

  async function open(path: string): Promise<{ manager: ContextManager; strategy: AutobiographicalStrategy }> {
    const strategy = new AutobiographicalStrategy(options);
    const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
    manager.setToolDefinitions(TOOLS);
    return { manager, strategy };
  }

  /** For each recall question, the summary it asks about, and what the question should say: the
   *  tools called by the messages in the summary's range, each once, in order, five and a count. */
  function expected(manager: ContextManager, strategy: AutobiographicalStrategy, compiled: Awaited<ReturnType<ContextManager['compile']>>) {
    const held = (strategy as unknown as { summaries: SummaryEntry[] }).summaries;
    const all = manager.getAllMessages();
    const at = new Map(all.map((m, i) => [m.id, i] as const));
    const pairs: Array<{ id: string; level: number; question: string; want: string }> = [];
    compiled.messages.forEach((m, i) => {
      const source = compiled.provenance!.messages[i]!;
      if (m.participant !== 'Context Manager' || source.kind !== 'summary') return;
      const summary = held.find((s) => s.id === source.summaries[0]!.id)!;
      const names: string[] = [];
      for (const message of all.slice(at.get(summary.sourceRange.first)!, at.get(summary.sourceRange.last)! + 1)) {
        for (const b of message.content) if (b.type === 'tool_use' && !names.includes(b.name)) names.push(b.name);
      }
      const listed = names.length === 0 ? 'no tools'
        : names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
      pairs.push({ id: summary.id, level: summary.level, question: m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), want: `Its rounds called ${listed}.` });
    });
    return pairs;
  }

  it('each recall pair names its own summary\'s tools, is priced as sent, and renders the same on every compile and after a reopen', async () => {
    await withStore(async (path) => {
      const first = await open(path);
      for (let r = 0; r < 30; r++) {
        const name = NAMES[r % NAMES.length]!;
        first.manager.addMessage('Claude', [{ type: 'text', text: `zz-step-${r} ` + 'zzzz '.repeat(40) }, call(`tu-${r}`, name)]);
        first.manager.addMessage('User', [result(`tu-${r}`)]);
      }
      for (let tick = 0; tick < 300 && !first.manager.isReady(); tick++) await first.manager.tick();
      assert.ok(first.manager.isReady(), 'premise: compression and merging drained');
      const compiled = await first.manager.compile({ maxTokens: 900, reserveForResponse: 0 });
      const pairs = expected(first.manager, first.strategy, compiled);
      assert.ok(pairs.length >= 2, `premise: the compile folds into recall pairs (${pairs.length})`);
      assert.ok(pairs.some((p) => p.level >= 2), 'premise: a merged summary renders');
      for (const p of pairs) assert.equal(p.question, p.want, `the question for ${p.id}`);

      const stats = first.manager.getRenderStats()!;
      const store = (first.manager as unknown as { messageStore: { estimateTokens(message: StoredMessage): number } }).messageStore;
      const sent = compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as StoredMessage), 0);
      assert.equal(stats.total.tokens, sent, 'the render stats count what is sent');
      assert.ok(stats.planVsActual, 'premise: an adaptive compile reports its plan');
      assert.equal(stats.planVsActual.planned, stats.planVsActual.actual);

      const again = await first.manager.compile({ maxTokens: 900, reserveForResponse: 0 });
      assert.deepStrictEqual(questions(again.messages), questions(compiled.messages), 'a second compile of the unchanged store');
      first.manager.close();

      const reopened = await open(path);
      const afterReopen = await reopened.manager.compile({ maxTokens: 900, reserveForResponse: 0 });
      const byId = new Map(pairs.map((p) => [p.id, p.question] as const));
      const reopenedPairs = expected(reopened.manager, reopened.strategy, afterReopen);
      assert.ok(reopenedPairs.some((p) => byId.has(p.id)), 'premise: the reopened compile renders a summary the first did');
      for (const p of reopenedPairs) if (byId.has(p.id)) assert.equal(p.question, byId.get(p.id), `${p.id} after a reopen`);
      reopened.manager.close();
    });
  });
});
