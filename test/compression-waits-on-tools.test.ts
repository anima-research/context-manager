import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, KnowledgeStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { AutobiographicalProgressSnapshot } from '../src/strategies/autobiographical.js';
import type { AutobiographicalOptions } from '../src/index.js';

const STORE = './test-compression-waits-on-tools';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
const t = (s: string): ContentBlock => ({ type: 'text', text: s });
const words = (n: number) => 'substantive words about real happenings '.repeat(n);
const TOOLS = [{ name: 'fetch', description: 'fetch a thing', inputSchema: { type: 'object' as const } }];
const FABLE = 'claude-fable-5-1';

function mockMembrane(refuse = false) {
  const calls: Array<{ tools: unknown }> = [];
  const membrane = {
    complete: async (request: { tools?: unknown }) => {
      calls.push({ tools: request.tools });
      if (refuse) return { stopReason: 'refusal', content: [t('I can\'t help with that.')], usage: { input_tokens: 100, output_tokens: 10 } };
      return { stopReason: 'end_turn', content: [t(`[summary ${calls.length}] what happened, briefly`)], usage: { input_tokens: 100, output_tokens: 10 } };
    },
  };
  return { membrane, calls };
}

class QueueingStrategy extends AutobiographicalStrategy {
  queueMergeOf(sourceIds: string[]): void {
    this.enqueueMerge({ level: 2, sourceIds });
  }
}

interface Opened {
  manager: ContextManager;
  strategy: AutobiographicalStrategy;
  calls: Array<{ tools: unknown }>;
  snapshot: () => AutobiographicalProgressSnapshot;
}

async function open(opts: { model?: string; autoTick?: boolean; keep?: boolean; refuse?: boolean; config?: AutobiographicalOptions; strategy?: (config: AutobiographicalOptions) => AutobiographicalStrategy } = {}): Promise<Opened> {
  if (!opts.keep) cleanup();
  const { membrane, calls } = mockMembrane(opts.refuse);
  const config: AutobiographicalOptions = {
    compressionModel: opts.model ?? 'test-compression-model', targetChunkTokens: 80, headWindowTokens: 0, recentWindowTokens: 0,
    hierarchical: true, mergeThreshold: 100, autoTickOnNewMessage: opts.autoTick ?? false, ...opts.config,
  };
  const strategy = opts.strategy ? opts.strategy(config) : new AutobiographicalStrategy(config);
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
  return { manager, strategy, calls, snapshot: () => strategy.getProgressSnapshot() };
}

function addToolBearing(manager: ContextManager): void {
  for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(`event ${i} ${words(8)}`)]);
  manager.addMessage('agent', [t(words(2)), { type: 'tool_use', id: 'call-1', name: 'fetch', input: { q: 'y' } } as ContentBlock]);
  manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-1', content: 'x'.repeat(400) } as ContentBlock]);
  for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'user' : 'agent', [t(`later ${i} ${words(8)}`)]);
}

function addPlain(manager: ContextManager, n = 30): void {
  for (let i = 0; i < n; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(`event ${i} ${words(8)}`)]);
}

function idOf(manager: ContextManager, type: 'tool_use' | 'tool_result'): string {
  const message = manager.getAllMessages().find((m) => m.content.some((b) => b.type === type));
  assert.ok(message, `premise: a message holds a ${type}`);
  return message.id;
}

function coveredByL1(manager: ContextManager): Set<string> {
  return new Set(manager.getSummariesInRange({ level: 1 }).flatMap((s) => s.sourceIds));
}

async function tickUntilReady(manager: ContextManager, bound = 200): Promise<number> {
  for (let i = 0; i < bound; i++) {
    if (manager.isReady()) return i;
    await manager.tick();
  }
  throw new Error(`still not ready after ${bound} ticks`);
}

describe('compression that waits on the host\'s tool definitions', () => {
  after(cleanup);

  it('waits queued while no tools are declared, and once they are, compresses in order with no new message', async () => {
    const { manager, strategy, calls, snapshot } = await open();
    addToolBearing(manager);
    await tickUntilReady(manager);
    const before = snapshot();
    assert.ok(before.chunksCompressed >= 1, 'premise: the chunks before the call compress with no tools');
    assert.ok(before.l1WaitingOnTools >= 2, 'premise: the chunk holding the call and a later one wait');
    assert.strictEqual(before.l1QueueLength, 0);
    assert.strictEqual(calls.length, before.chunksCompressed);
    const call = idOf(manager, 'tool_use');
    assert.ok(!coveredByL1(manager).has(call), 'premise: the call\'s chunk waits');

    manager.setToolDefinitions(TOOLS);
    assert.strictEqual(manager.isReady(), false);
    assert.strictEqual(manager.getWaitingWork(), null);
    const position = new Map(manager.getAllMessages().map((m, i) => [m.id, i]));
    const firstOfEach: number[] = [];
    for (let i = 0; i < 200 && !manager.isReady(); i++) {
      const covered = coveredByL1(manager);
      await manager.tick();
      const fresh = [...coveredByL1(manager)].filter((id) => !covered.has(id)).map((id) => position.get(id)!);
      if (fresh.length > 0) firstOfEach.push(Math.min(...fresh));
    }
    assert.strictEqual(firstOfEach[0], position.get(call), 'the earliest waiting chunk, the call\'s, compresses first');
    assert.strictEqual(firstOfEach.length, before.l1WaitingOnTools);
    assert.deepStrictEqual(firstOfEach, [...firstOfEach].sort((a, b) => a - b), 'the waiting chunks compress in their order');
    const after = snapshot();
    assert.strictEqual(after.chunksCompressed, before.chunksCompressed + before.l1WaitingOnTools);
    assert.strictEqual(after.l1WaitingOnTools, 0);
    assert.strictEqual(strategy.getCompressionDebt().pendingChunks, 0, 'no chunk was left behind');
    assert.ok(calls.slice(before.chunksCompressed).every((c) => Array.isArray(c.tools) && (c.tools as unknown[]).length === TOOLS.length));
    await manager.close();
  });

  it('"nothing to do" and "waiting on tools" both read ready with no pending work, only getWaitingWork tells them apart, and it names a wait beside pending work too', async () => {
    const plain = await open();
    addPlain(plain.manager);
    await tickUntilReady(plain.manager);
    assert.strictEqual(plain.manager.isReady(), true);
    assert.strictEqual(plain.manager.getPendingWork(), null);
    assert.strictEqual(plain.manager.getWaitingWork(), null);
    await plain.manager.close();

    const waiting = await open();
    addToolBearing(waiting.manager);
    for (let i = 0; i < 200 && waiting.manager.getWaitingWork() === null; i++) await waiting.manager.tick();
    assert.ok(waiting.snapshot().l1QueueLength > 0, 'premise: chunks not yet judged are left beside the one that waits');
    assert.strictEqual(waiting.manager.isReady(), false);
    assert.strictEqual(waiting.manager.getWaitingWork()?.waitingOn, 'tools');

    await tickUntilReady(waiting.manager);
    const n = waiting.snapshot().l1WaitingOnTools;
    assert.ok(n >= 1, 'premise: chunks wait');
    assert.strictEqual(waiting.manager.isReady(), true);
    assert.strictEqual(waiting.manager.getPendingWork(), null);
    const named = { waitingOn: 'tools', description: `${n} chunks wait on the host's tool definitions` };
    assert.deepStrictEqual(waiting.manager.getWaitingWork(), named);
    await waiting.manager.compile({ maxTokens: 200_000, reserveForResponse: 1_000 }, undefined, { dryRun: true });
    assert.strictEqual(waiting.manager.isReady(), true, 'a dry compile leaves the wait as it found it');
    assert.deepStrictEqual(waiting.manager.getWaitingWork(), named);
    await waiting.manager.close();
  });

  it('a loop that ticks while the snapshot\'s queue lengths are above 0 ends, and the waiting chunks are counted apart', async () => {
    const { manager, snapshot } = await open();
    addToolBearing(manager);
    let ticks = 0;
    for (let s = snapshot(); s.l1QueueLength > 0 || s.mergeQueueLength > 0; s = snapshot()) {
      if (++ticks > 200) assert.fail('the warmup-shaped loop did not end');
      await manager.tick();
    }
    assert.ok(snapshot().l1WaitingOnTools >= 2);
    await manager.close();
  });

  it('a Fable-family summarizer\'s merges wait with no call while no tools are declared, and land once they are', async () => {
    const first = await open({ model: FABLE, config: { mergeThreshold: 2 } });
    first.manager.setToolDefinitions(TOOLS);
    addPlain(first.manager);
    for (let i = 0; i < 200 && first.snapshot().l1QueueLength > 0; i++) await first.manager.tick();
    assert.strictEqual(first.snapshot().l1QueueLength, 0, 'premise: the chunks compressed');
    assert.ok(first.snapshot().mergeQueueLength > 0, 'premise: a merge is queued');
    await first.manager.close();

    const second = await open({ model: FABLE, config: { mergeThreshold: 2 }, keep: true });
    second.manager.addMessage('user', [t(`one more ${words(8)}`)]);
    assert.strictEqual(second.manager.isReady(), false, 'a merge no tick has asked about reads as pending');
    await tickUntilReady(second.manager);
    const waiting = second.snapshot();
    assert.ok(waiting.mergesWaitingOnTools > 0, 'premise: the merge survived the reopen');
    assert.strictEqual(waiting.mergeQueueLength, 0);
    assert.strictEqual(second.calls.length, 0, 'no summarizer call before the host declares tools');
    assert.strictEqual(second.manager.getWaitingWork()?.waitingOn, 'tools');

    second.manager.setToolDefinitions(TOOLS);
    assert.strictEqual(second.manager.isReady(), false);
    assert.strictEqual(second.manager.getWaitingWork(), null);
    await tickUntilReady(second.manager);
    assert.ok(second.snapshot().summaryCounts.l2 > waiting.summaryCounts.l2, 'a merge landed');
    assert.ok(second.calls.length > 0 && second.calls.every((c) => Array.isArray(c.tools) && (c.tools as unknown[]).length === TOOLS.length));
    assert.strictEqual(second.snapshot().mergesWaitingOnTools, 0);
    await second.manager.close();
  });

  it('on a Fable-family summarizer with no tools declared, a merge that makes no call is still dropped', async () => {
    const { manager, strategy, calls, snapshot } = await open({ model: FABLE, strategy: (config) => new QueueingStrategy(config) });
    (strategy as QueueingStrategy).queueMergeOf(['L1-gone-a', 'L1-gone-b']);
    assert.strictEqual(snapshot().mergeQueueLength, 1, 'a merge no tick has asked about counts as queued');
    assert.strictEqual(manager.isReady(), false);
    await tickUntilReady(manager);
    assert.strictEqual(snapshot().mergesWaitingOnTools + snapshot().mergeQueueLength, 0, 'the merge with missing sources was dropped');
    assert.strictEqual(manager.getWaitingWork(), null);
    assert.strictEqual(calls.length, 0);
    await manager.close();
  });

  it('while the speculative cap holds chunks behind a merge that waits on tools, they wait too', async () => {
    const config = { mergeThreshold: 2, maxSpeculativeL1s: 1 };
    const first = await open({ model: FABLE, config });
    first.manager.setToolDefinitions(TOOLS);
    addPlain(first.manager);
    for (let i = 0; i < 200 && first.snapshot().mergeQueueLength === 0; i++) await first.manager.tick();
    assert.ok(first.snapshot().mergeQueueLength > 0 && first.snapshot().summaryCounts.l1 >= 2, 'premise: two L1s and their merge queued');
    addPlain(first.manager, 12);
    await first.manager.close();

    const second = await open({ model: FABLE, config, keep: true });
    assert.strictEqual(await tickUntilReady(second.manager), 1, 'one tick, which the cap leaves to the merge');
    const s = second.snapshot();
    assert.ok(s.mergesWaitingOnTools > 0, 'premise: the merge waits');
    assert.ok(s.l1WaitingOnTools > 0, 'the chunks the cap holds wait behind it');
    assert.strictEqual(s.l1QueueLength, 0);
    assert.strictEqual(second.calls.length, 0);
    await second.manager.close();
  });

  it('a chunk whose request carries no tool block, its call\'s partner being in another chunk, compresses with no tools', async () => {
    const { manager, strategy } = await open();
    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(`event ${i} ${words(8)}`)]);
    manager.addMessage('agent', [t(words(20)), { type: 'tool_use', id: 'call-2', name: 'fetch', input: { q: 'z' } } as ContentBlock]);
    manager.addMessage('user', [t(`meanwhile ${words(20)}`)]);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-2', content: 'short result' } as ContentBlock]);
    for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'user' : 'agent', [t(`later ${i} ${words(8)}`)]);
    const chunks = (strategy as unknown as { chunks: Array<{ messages: Array<{ content: ContentBlock[] }> }> }).chunks;
    const holds = (type: string) => chunks.findIndex((c) => c.messages.some((m) => m.content.some((b) => b.type === type)));
    assert.ok(holds('tool_use') >= 0 && holds('tool_result') === holds('tool_use') + 1, `premise: the call ends one chunk and its result starts the next (${holds('tool_use')}, ${holds('tool_result')})`);
    await tickUntilReady(manager);
    const covered = coveredByL1(manager);
    assert.ok(covered.has(idOf(manager, 'tool_use')), 'the call\'s chunk compressed with no tools declared');
    assert.ok(covered.has(idOf(manager, 'tool_result')), 'the result\'s chunk compressed with no tools declared');
    await manager.close();
  });

  async function settles(strategy: AutobiographicalStrategy, drive: () => void): Promise<void> {
    let ticks = 0;
    let inFlight = 0;
    const tick = strategy.tick.bind(strategy);
    strategy.tick = (ctx) => {
      ticks++;
      inFlight++;
      return tick(ctx).finally(() => { inFlight--; });
    };
    drive();
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
    let seen = -1;
    let still = 0;
    for (let i = 0; i < 5000 && still < 20; i++) {
      await turn();
      if (inFlight === 0 && ticks === seen) still++;
      else { seen = ticks; still = 0; }
    }
    assert.strictEqual(still, 20, 'the drain settled');
    for (let i = 0; i < 50; i++) await turn();
    assert.strictEqual(ticks, seen, 'no tick after the drain settled');
  }

  it('an auto-tick drain stops when only waiting chunks are left', async () => {
    const { manager, strategy } = await open({ autoTick: true });
    try {
      await settles(strategy, () => addToolBearing(manager));
      assert.strictEqual(manager.getWaitingWork()?.waitingOn, 'tools', 'premise: the work left waits on tools');
    } finally {
      await manager.close();
    }
  });

  it('an auto-tick drain stops when only a waiting merge is left, on a Fable-family summarizer', async () => {
    const first = await open({ model: FABLE, config: { mergeThreshold: 2 } });
    first.manager.setToolDefinitions(TOOLS);
    addPlain(first.manager);
    for (let i = 0; i < 200 && first.snapshot().l1QueueLength > 0; i++) await first.manager.tick();
    assert.ok(first.snapshot().mergeQueueLength > 0, 'premise: a merge is queued');
    await first.manager.close();

    const second = await open({ model: FABLE, config: { mergeThreshold: 2 }, autoTick: true, keep: true });
    try {
      await settles(second.strategy, () => second.manager.addMessage('user', [t(`one more ${words(8)}`)]));
      assert.ok(second.snapshot().mergesWaitingOnTools > 0, 'premise: the merge waits');
    } finally {
      await second.manager.close();
    }
  });

  it('an auto-tick drain goes on past a refused merge, retrying it until its attempts run out', async () => {
    const first = await open({ config: { mergeThreshold: 2 } });
    first.manager.setToolDefinitions(TOOLS);
    addPlain(first.manager);
    for (let i = 0; i < 200 && first.snapshot().l1QueueLength > 0; i++) await first.manager.tick();
    assert.ok(first.snapshot().mergeQueueLength > 0, 'premise: a merge is queued');
    await first.manager.close();

    const second = await open({ config: { mergeThreshold: 2, mergeAttemptLimit: 3 }, autoTick: true, keep: true, refuse: true });
    try {
      second.manager.setToolDefinitions(TOOLS);
      await settles(second.strategy, () => second.manager.addMessage('user', [t('ok')]));
      assert.ok(second.strategy.getMergeQuarantineStatus().count >= 1, 'in one drain, a refused merge was asked again until its attempts ran out');
      assert.ok(second.calls.length >= 3);
    } finally {
      await second.manager.close();
    }
  });

  it('a rebuild judges waiting chunks again: once a pin no longer keeps a call raw, they compress with no tools', async () => {
    const first = await open();
    first.manager.setToolDefinitions(TOOLS);
    addToolBearing(first.manager);
    await tickUntilReady(first.manager);
    const ids = first.manager.getAllMessages().map((m) => m.id);
    const call = first.manager.getAllMessages().findIndex((m) => m.content.some((b) => b.type === 'tool_use'));
    const pin = first.manager.pinRange(ids[call]!, ids[call + 1]!);
    for (let i = 0; i < 12; i++) first.manager.addMessage(i % 2 ? 'user' : 'agent', [t(`after the pin ${i} ${words(8)}`)]);
    await first.manager.close();

    const second = await open({ keep: true });
    await tickUntilReady(second.manager);
    const before = second.snapshot();
    assert.ok(before.l1WaitingOnTools >= 1, 'premise: a chunk after the pin waits on tools');
    second.manager.unpin(pin);
    second.manager.addMessage('user', [t(`a new message ${words(8)}`)]);
    await tickUntilReady(second.manager);
    const after = second.snapshot();
    assert.strictEqual(after.l1WaitingOnTools, 0);
    assert.ok(after.chunksCompressed >= before.chunksCompressed + before.l1WaitingOnTools, 'the chunks that waited compressed');
    await second.manager.close();
  });

  it('KnowledgeStrategy\'s rebuild judges its waiting chunks again', async () => {
    const { manager, snapshot } = await open({ strategy: (config) => new KnowledgeStrategy(config) });
    addToolBearing(manager);
    await tickUntilReady(manager);
    assert.strictEqual(manager.getWaitingWork()?.waitingOn, 'tools', 'premise: chunks wait');
    manager.addMessage('user', [t(`a new message ${words(8)}`)]);
    assert.strictEqual(snapshot().l1WaitingOnTools, 0, 'after the rebuild no chunk is known to wait until a tick judges it');
    await manager.close();
  });
});
