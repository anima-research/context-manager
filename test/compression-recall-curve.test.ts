import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StoredMessage, StrategyContext, SummaryEntry } from '../src/types/index.js';

const BASE = './test-compression-recall-curve';
const MODEL = 'same-model';
let sequence = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${BASE}-${sequence++}`;
  paths.push(path);
  return path;
}

function cleanup(): void {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

interface RecordedCall {
  request: NormalizedRequest;
}

function response(stopReason: 'refusal' | 'end_turn', text = '') {
  return {
    content: text ? [{ type: 'text', text }] : [],
    stopReason,
    usage: { inputTokens: 100, outputTokens: text ? 20 : 0 },
    raw: {
      response: {
        stop_details: stopReason === 'refusal'
          ? { category: 'reasoning_extraction' }
          : null,
      },
    },
  };
}

function scriptedMembrane(stops: Array<'refusal' | 'end_turn'>) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const index = calls.length;
        calls.push({
          request: structuredClone(request),
        });
        const stop = stops[index] ?? stops[stops.length - 1] ?? 'refusal';
        return response(stop, stop === 'end_turn' ? `successful memory from attempt ${index}` : '');
      },
    } as never,
  };
}

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }

  linkChild(child: SummaryEntry, parentId: string): void {
    this.setMergedInto(child, parentId);
  }

  summariesView(): SummaryEntry[] {
    return [...this.summaries];
  }

  flushSummaries(): void {
    this.store?.setStateJson(this.summariesStateId, this.summaries);
  }

  setCompressionModel(model: string): void {
    this.config.compressionModel = model;
  }

  chunksView(): Chunk[] {
    return [...this.chunks];
  }

  queueOnly(chunkIndex: number): void {
    for (const chunk of this.chunks) chunk.compressed = chunk.index !== chunkIndex;
    this.compressionQueue = [chunkIndex];
    this.mergeQueue = [];
  }

  run(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    return this.compressChunkHierarchical(chunk, ctx);
  }
}

function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

function text(text: string): ContentBlock {
  return { type: 'text', text };
}

function summary(
  id: string,
  level: number,
  sourceIds: string[],
  first: string,
  last: string,
  tokens = 20,
  content = `authored ${id}`,
): SummaryEntry {
  return {
    id,
    level,
    content,
    tokens,
    sourceLevel: level - 1,
    sourceIds,
    sourceRange: { first, last },
    created: Number(id.replace(/\D/g, '')) || 1,
  };
}

interface Fixture {
  manager: ContextManager;
  strategy: ProbeStrategy;
  ids: string[];
  target: Chunk;
  parents: [SummaryEntry, SummaryEntry];
  children: SummaryEntry[];
}

async function fixture(
  membrane: unknown,
  options: ConstructorParameters<typeof ProbeStrategy>[0] = {},
  path = freshPath(),
): Promise<Fixture> {
  const strategy = new ProbeStrategy({
    compressionModel: MODEL,
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 3,
    ...options,
  });
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 14; i++) {
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [
      text(`raw-${i} ` + 'substantive '.repeat(18)),
    ]));
  }

  const children = [
    summary('L1-100', 1, [ids[0]!, ids[1]!], ids[0]!, ids[1]!),
    summary('L1-101', 1, [ids[2]!, ids[3]!], ids[2]!, ids[3]!),
    summary('L1-102', 1, [ids[4]!, ids[5]!], ids[4]!, ids[5]!),
    summary('L1-103', 1, [ids[6]!, ids[7]!], ids[6]!, ids[7]!),
  ];
  for (const child of children) strategy.seed(child);

  // Deliberately reverse direct sourceIds. Expansion must still render the
  // authored children by raw source range while proving the same leaf set.
  const older = summary(
    'L2-200',
    2,
    [children[1]!.id, children[0]!.id],
    ids[0]!,
    ids[3]!,
  );
  const newer = summary(
    'L2-201',
    2,
    [children[3]!.id, children[2]!.id],
    ids[4]!,
    ids[7]!,
  );
  strategy.seed(older);
  strategy.seed(newer);
  for (const child of children.slice(0, 2)) strategy.linkChild(child, older.id);
  for (const child of children.slice(2)) strategy.linkChild(child, newer.id);

  const messages = managerContext(manager).messageStore.getAll();
  const targetMessages = messages.filter((message) => ids.slice(10, 12).includes(message.id));
  const target: Chunk = {
    index: 999,
    startIndex: 10,
    endIndex: 12,
    messages: targetMessages,
    tokens: 100,
    compressed: false,
  };
  return { manager, strategy, ids, target, parents: [older, newer], children };
}

function recallIds(request: NormalizedRequest): string[] {
  return request.messages.flatMap((message) => message.content.flatMap((block) => {
    if (block.type !== 'text') return [];
    const match = /^\[CM\] Recall memory (.+)\.$/.exec(block.text);
    return match ? [match[1]!] : [];
  }));
}

function removeRecallPairs(request: NormalizedRequest, ids: Set<string>): NormalizedRequest['messages'] {
  const messages = request.messages;
  const kept: NormalizedRequest['messages'] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const block = message.content.length === 1 ? message.content[0] : undefined;
    const match = block?.type === 'text'
      ? /^\[CM\] Recall memory (.+)\.$/.exec(block.text)
      : null;
    if (match && ids.has(match[1]!)) {
      i++;
      continue;
    }
    kept.push(message);
  }
  return kept;
}

describe('compression refusal recall curves', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('canonical success stores once and makes no fallback call', async () => {
    const mock = scriptedMembrane(['end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.equal(mock.calls.length, 1);
    assert.deepEqual(recallIds(mock.calls[0]!.request), ['L2-200', 'L2-201']);
    assert.equal(fx.strategy.summariesView().filter((entry) => entry.level === 1).length, 5);
    assert.equal(fx.target.compressed, true);
    fx.manager.close();
  });

  it('canonical refusal expands newest parent first and stores first successful output', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.equal(mock.calls.length, 2);
    assert.deepEqual(recallIds(mock.calls[0]!.request), ['L2-200', 'L2-201']);
    assert.deepEqual(
      recallIds(mock.calls[1]!.request),
      ['L2-200', 'L1-102', 'L1-103'],
      'newer L2 is expanded first and children follow source chronology',
    );
    const produced = fx.strategy.summariesView().filter(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === fx.target.messages.map((m) => m.id).join(':'),
    );
    assert.equal(produced.length, 1);
    assert.equal(produced[0]!.content, 'successful memory from attempt 1');
    fx.manager.close();
  });

  it('first curve refusal then second success stores only the second output', async () => {
    const mock = scriptedMembrane(['refusal', 'refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.deepEqual(recallIds(mock.calls[1]!.request), ['L2-200', 'L1-102', 'L1-103']);
    assert.deepEqual(recallIds(mock.calls[2]!.request), ['L1-100', 'L1-101', 'L2-201']);
    const produced = fx.strategy.summariesView().filter(
      (entry) => entry.level === 1 && entry.sourceIds[0] === fx.target.messages[0]!.id,
    );
    assert.equal(produced.length, 1);
    assert.equal(produced[0]!.content, 'successful memory from attempt 2');
    fx.manager.close();
  });

  it('proves exact leaf coverage and leaves every non-replaced message/config/tool deep-equal', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    const tools: ToolDefinition[] = [{
      name: 'private_tool',
      description: 'synthetic',
      inputSchema: { type: 'object', properties: { secret: { type: 'string' } } },
    }];
    fx.manager.setToolDefinitions(tools);
    fx.target.messages = [
      {
        ...fx.target.messages[0]!,
        participant: 'Claude',
        content: [
          text('<think>private control state</think> skip_reply'),
          { type: 'tool_use', id: 'tool-1', name: 'private_tool', input: { secret: 'unchanged' } },
        ],
      },
      {
        ...fx.target.messages[1]!,
        participant: 'User',
        content: [{
          type: 'tool_result',
          toolUseId: 'tool-1',
          content: [
            text('private tool output unchanged'),
            { type: 'thinking', thinking: 'nested private state', signature: 'synthetic-signature' },
          ],
        }],
      },
    ];

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const canonical = mock.calls[0]!.request;
    const variant = mock.calls[1]!.request;
    assert.deepEqual(variant.config, canonical.config);
    assert.deepEqual(variant.tools, canonical.tools);
    assert.deepEqual(
      removeRecallPairs(variant, new Set(['L1-102', 'L1-103'])),
      removeRecallPairs(canonical, new Set(['L2-201'])),
      'fallback changes only the selected authored recall pair',
    );
    const serialized = JSON.stringify(variant);
    assert.match(serialized, /private control state/);
    assert.match(serialized, /skip_reply/);
    assert.match(serialized, /private tool output unchanged/);
    assert.match(serialized, /nested private state/);
    assert.match(serialized, /synthetic-signature/);
    assert.deepEqual(recallIds(variant), ['L2-200', 'L1-102', 'L1-103']);
    fx.manager.close();
  });

  it('rejects missing/empty child, duplicate-leaf, and over-budget candidates without provider calls', async () => {
    {
      const mock = scriptedMembrane(['refusal']);
      const fx = await fixture(mock.membrane);
      fx.parents[0].sourceIds = ['missing-child'];
      fx.children[2]!.content = '';
      fx.strategy.flushSummaries();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 1, 'missing/empty children yield canonical call only');
      fx.manager.close();
    }
    {
      const mock = scriptedMembrane(['refusal']);
      const fx = await fixture(mock.membrane);
      fx.parents[0].sourceIds = ['missing-child'];
      fx.children[2]!.sourceIds = [fx.ids[4]!, fx.ids[4]!];
      fx.strategy.flushSummaries();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 1, 'duplicate recursive leaves fail exact coverage proof');
      fx.manager.close();
    }
    {
      const mock = scriptedMembrane(['refusal']);
      const fx = await fixture(mock.membrane, { compressionRecallBudgetTokens: 200 });
      for (const parent of fx.parents) parent.tokens = 20;
      for (const child of fx.children) child.tokens = 100;
      fx.strategy.flushSummaries();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 1, 'over-budget expansions are skipped');
      fx.manager.close();
    }
  });

  it('all-refused persists quarantine, stores nothing, and restart skips every provider call', async () => {
    const path = freshPath();
    const firstMock = scriptedMembrane(['refusal']);
    const first = await fixture(firstMock.membrane, { compressionRefusalCurveFallbacks: 2 }, path);
    const targetIds = first.target.messages.map((message) => message.id);
    await first.strategy.run(first.target, managerContext(first.manager));
    assert.equal(firstMock.calls.length, 3);
    assert.equal(first.target.compressed, false);
    assert.equal(
      first.strategy.summariesView().filter((entry) => entry.sourceIds.join(':') === targetIds.join(':')).length,
      0,
    );
    const quarantine = first.manager.getStore().getStateJson(
      'default/autobio:compression-refusal-quarantine',
    );
    assert.equal(Array.isArray(quarantine) ? quarantine.length : 0, 1);
    const record = (quarantine as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.model, MODEL);
    assert.match(String(record.key), /^[a-f0-9]{64}$/);
    assert.match(String(record.chunkSourceHash), /^[a-f0-9]{64}$/);
    assert.match(String(record.frontierHash), /^[a-f0-9]{64}$/);
    assert.match(String(record.canonicalRequestHash), /^[a-f0-9]{64}$/);
    assert.equal((record.variants as unknown[]).length, 2);
    first.manager.close();

    const restartMock = scriptedMembrane(['refusal']);
    const restarted = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 2,
    });
    const manager = await ContextManager.open({ path, strategy: restarted, membrane: restartMock.membrane });
    const ctx = managerContext(manager);
    const messages = targetIds.map((id) => ctx.messageStore.get(id)).filter(Boolean) as StoredMessage[];
    await restarted.run({
      index: 999,
      startIndex: 10,
      endIndex: 12,
      messages,
      tokens: 100,
      compressed: false,
    }, ctx);
    assert.equal(restartMock.calls.length, 0, 'durable quarantine survives process restart');
    manager.close();
  });

  it('frontier, chunk, and model changes each invalidate the quarantine key', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1);

    const frontier = summary('L1-new-frontier', 1, [fx.ids[8]!], fx.ids[8]!, fx.ids[8]!);
    fx.strategy.seed(frontier);
    await fx.strategy.run({ ...fx.target, compressed: false }, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'changed frontier permits canonical retry');

    const ctx = managerContext(fx.manager);
    const changedChunkMessages = fx.ids.slice(11, 13)
      .map((id) => ctx.messageStore.get(id)).filter(Boolean) as StoredMessage[];
    await fx.strategy.run({
      ...fx.target,
      messages: changedChunkMessages,
      compressed: false,
    }, ctx);
    assert.equal(mock.calls.length, 3, 'changed chunk permits canonical retry');
    fx.strategy.setCompressionModel('changed-model');
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    assert.equal(mock.calls.length, 4, 'changed model invalidates prior quarantine');
    assert.equal(mock.calls[3]!.request.config.model, 'changed-model');
    fx.manager.close();
  });

  it('operator clear explicitly permits a canonical-first retry', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    const ctx = managerContext(fx.manager);
    await fx.strategy.run(fx.target, ctx);
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    assert.equal(mock.calls.length, 1, 'unchanged exhausted key is suppressed');

    fx.strategy.clearCompressionRefusalQuarantine();
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    assert.equal(mock.calls.length, 2, 'clear permits exactly a new canonical attempt');
    assert.deepEqual(recallIds(mock.calls[1]!.request), ['L2-200', 'L2-201']);
    fx.manager.close();
  });

  it('queue-driven canonical refusal then curve success converges and stores one L1', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    const actual = fx.strategy.chunksView().find(
      (chunk) => chunk.messages.every((message) => !fx.children.some((child) => child.sourceIds.includes(message.id))),
    );
    assert.ok(actual, 'fixture has an uncovered persisted chunk');
    fx.strategy.queueOnly(actual.index);

    await fx.manager.tick();
    assert.equal(mock.calls.length, 2);
    assert.equal(actual.compressed, true);
    assert.equal(fx.strategy.summariesView().filter(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === actual.messages.map((m) => m.id).join(':'),
    ).length, 1);
    assert.equal(fx.manager.isReady(), true, 'compression queue converges');
    fx.manager.close();
  });

  it('emits metadata traces for refusal, curve attempt, success, and persistence', async () => {
    const logPath = `${freshPath()}-trace.jsonl`;
    paths.push(logPath);
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    try {
      const mock = scriptedMembrane(['refusal', 'end_turn']);
      const fx = await fixture(mock.membrane);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      fx.manager.close();

      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(
        (line) => JSON.parse(line) as { event?: string; metadata?: Record<string, unknown> },
      );
      const events = entries.map((entry) => entry.event).filter(Boolean);
      assert.ok(events.includes('compression:canonical-refused'));
      assert.ok(events.includes('compression:curve-attempt'));
      assert.ok(events.includes('compression:curve-succeeded'));
      const attempts = entries.filter((entry) => entry.event === 'compression:attempt');
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]!.metadata?.persisted, false);
      assert.equal(attempts[0]!.metadata?.refusalCategory, 'reasoning_extraction');
      assert.equal(attempts[1]!.metadata?.persisted, true);
      assert.match(String(attempts[1]!.metadata?.requestHash), /^[a-f0-9]{64}$/);
      assert.match(String(attempts[1]!.metadata?.leafCoverageHash), /^[a-f0-9]{64}$/);
      assert.equal(attempts[1]!.metadata?.refusalCategory, undefined);
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
    }
  });

  it('concurrent producers consult durable summaries and persist only one L1', async () => {
    const mock = scriptedMembrane(['end_turn', 'end_turn']);
    // Delay both calls until they are simultaneously in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const concurrent = {
      complete: async (request: NormalizedRequest) => {
        mock.calls.push({ request: structuredClone(request) });
        entered++;
        if (entered === 2) release();
        await gate;
        return response('end_turn', 'one durable result');
      },
    } as never;
    const path = freshPath();
    const first = await fixture(concurrent, { compressionRefusalCurveFallbacks: 0 }, path);
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(),
      strategy: second,
      membrane: concurrent,
    });
    const secondCtx = managerContext(secondManager);
    const secondMessages = first.target.messages.map(
      (message) => secondCtx.messageStore.get(message.id),
    ).filter(Boolean) as StoredMessage[];
    const secondChunk = { ...first.target, messages: secondMessages, compressed: false };

    await Promise.all([
      first.strategy.run(first.target, managerContext(first.manager)),
      second.run(secondChunk, secondCtx),
    ]);
    const persisted = first.manager.getStore().getStateJson('default/autobio:summaries');
    const targetKey = first.target.messages.map((message) => message.id).join(':');
    const matching = (Array.isArray(persisted) ? persisted : []).filter(
      (entry: SummaryEntry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
    );
    assert.equal(matching.length, 1);
    secondManager.close();
    first.manager.close();
  });
});
